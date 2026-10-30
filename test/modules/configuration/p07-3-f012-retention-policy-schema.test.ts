/**
 * P07-3 / F-012 保留政策段 Schema 测试（纯函数无 I/O）。
 *
 * 覆盖：
 * - 保留政策段按既有 Settings v2 可选政策段扩展模式接入：合法段（全部字段、
 *   边界值、子集、空段）在 global scope 通过并规范化返回；旧 v2 payload
 *   （无该段）保持原语义有效（兼容）；
 * - 未知键（段内未知字段、伪造政策段名）与非法数值（0/负数/小数/字符串/
 *   越界）带字段定位拒绝，不静默取整或忽略；
 * - 作用域与冲突值：diskMinFreeBytes/diskMinFreePercent 仅允许 global scope；
 *   project scope（写入与持久读取两条路径）携带即以 reason=
 *   'global_only_field' 拒绝，项目配置不能借共享数据根磁盘阈值扩大跨项目治理；
 * - maxBackupCount 下界 1（0 不能授权清空全部备份）；磁盘百分比 (0,100)
 *   开区间；无任何默认保留天数/容量被注入。
 */
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  DISK_MIN_FREE_BYTES_MAX,
  DISK_MIN_FREE_BYTES_MIN,
  MAX_BACKUP_COUNT_MAX,
  RETENTION_DAYS_MAX,
  SETTINGS_SCHEMA_VERSION,
  parseStoredSettingsPayload,
  validateSettingsPayload,
} from '../../../packages/core/src/ports/settings-schema.ts';
import type { ValidationContext } from '../../../packages/core/src/ports/validation.ts';

const GLOBAL_CONTEXT: ValidationContext = {
  operation: 'Test.retention',
  entity: { type: 'global_settings', id: 'global' },
};

const PROJECT_CONTEXT: ValidationContext = {
  operation: 'Test.retention',
  entity: { type: 'project_settings', projectId: '0a1b2c3d-4e5f-4678-9abc-def012345678' },
};

function payloadWithPolicies(policies: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, policies };
}

/** 断言带字段定位/原因的 validation 拒绝。 */
function expectRejection(fn: () => unknown, field?: string, reason?: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error, '应当以 validation 错误拒绝').toBeDefined();
  expect(isStorageError(error, 'validation')).toBe(true);
  const storageError = error as { details?: { field?: string; reason?: string } };
  if (field !== undefined) {
    expect(storageError.details?.field).toBe(field);
  }
  if (reason !== undefined) {
    expect(storageError.details?.reason).toBe(reason);
  }
}

const FULL_RETENTION = {
  evidenceRetentionDays: 30,
  backupRetentionDays: 90,
  maxBackupCount: 5,
  diskMinFreeBytes: DISK_MIN_FREE_BYTES_MIN,
  diskMinFreePercent: 10,
};

describe('P07-3 / F-012 保留政策段 Schema', () => {
  it('global scope 合法保留段（全部字段 + 边界值）通过并规范化', () => {
    const validated = validateSettingsPayload(
      payloadWithPolicies({ retentionPolicy: FULL_RETENTION }),
      GLOBAL_CONTEXT,
    );
    expect(validated.policies?.retentionPolicy).toEqual(FULL_RETENTION);

    const bounds = validateSettingsPayload(
      payloadWithPolicies({
        retentionPolicy: {
          evidenceRetentionDays: RETENTION_DAYS_MAX,
          backupRetentionDays: 1,
          maxBackupCount: MAX_BACKUP_COUNT_MAX,
          diskMinFreeBytes: DISK_MIN_FREE_BYTES_MAX,
          diskMinFreePercent: 1,
        },
      }),
      GLOBAL_CONTEXT,
    );
    expect(bounds.policies?.retentionPolicy?.evidenceRetentionDays).toBe(RETENTION_DAYS_MAX);
    expect(bounds.policies?.retentionPolicy?.diskMinFreeBytes).toBe(DISK_MIN_FREE_BYTES_MAX);
  });

  it('旧 v2 payload（无保留段）保持原语义；空段与子集合法且无默认值注入', () => {
    const legacy = validateSettingsPayload(
      payloadWithPolicies({ verification: { requireChecksBeforeDone: true } }),
      GLOBAL_CONTEXT,
    );
    expect(legacy.policies?.retentionPolicy).toBeUndefined();

    const empty = validateSettingsPayload(
      payloadWithPolicies({ retentionPolicy: {} }),
      GLOBAL_CONTEXT,
    );
    expect(empty.policies?.retentionPolicy).toEqual({});

    const subset = validateSettingsPayload(
      payloadWithPolicies({ retentionPolicy: { evidenceRetentionDays: 7 } }),
      PROJECT_CONTEXT,
    );
    expect(subset.policies?.retentionPolicy).toEqual({ evidenceRetentionDays: 7 });
  });

  it('段内未知键与伪造政策段名拒绝', () => {
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({ retentionPolicy: { evidenceRetentionDays: 7, autoPurge: true } }),
        GLOBAL_CONTEXT,
      ),
      'payload.policies.retentionPolicy',
    );
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({ retentionPolicy: { deletePath: '/var/tmp' } }),
        GLOBAL_CONTEXT,
      ),
      'payload.policies.retentionPolicy',
    );
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({ cleanupPolicy: { retentionDays: 1 } }),
        GLOBAL_CONTEXT,
      ),
      'payload.policies',
    );
  });

  it('非法数值（0/负数/小数/字符串/越界）带字段定位拒绝', () => {
    const cases: readonly [unknown, string][] = [
      [0, 'evidenceRetentionDays'],
      [-3, 'backupRetentionDays'],
      [1.5, 'evidenceRetentionDays'],
      ['7', 'maxBackupCount'],
      [RETENTION_DAYS_MAX + 1, 'evidenceRetentionDays'],
      [MAX_BACKUP_COUNT_MAX + 1, 'maxBackupCount'],
      [DISK_MIN_FREE_BYTES_MIN - 1, 'diskMinFreeBytes'],
      [DISK_MIN_FREE_BYTES_MAX + 1, 'diskMinFreeBytes'],
      [0, 'diskMinFreePercent'],
      [100, 'diskMinFreePercent'],
    ];
    for (const [value, key] of cases) {
      expectRejection(
        () => validateSettingsPayload(
          payloadWithPolicies({ retentionPolicy: { [key]: value } }),
          key === 'diskMinFreeBytes' || key === 'diskMinFreePercent' ? GLOBAL_CONTEXT : GLOBAL_CONTEXT,
        ),
        `payload.policies.retentionPolicy.${key}`,
      );
    }
    // maxBackupCount=0 不能授权清空全部备份（下界 1）。
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({ retentionPolicy: { maxBackupCount: 0 } }),
        GLOBAL_CONTEXT,
      ),
      'payload.policies.retentionPolicy.maxBackupCount',
    );
  });

  it('磁盘阈值字段仅允许 global scope：项目 scope 写入拒绝（global_only_field）', () => {
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({ retentionPolicy: { diskMinFreeBytes: DISK_MIN_FREE_BYTES_MIN } }),
        PROJECT_CONTEXT,
      ),
      'payload.policies.retentionPolicy.diskMinFreeBytes',
      'global_only_field',
    );
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({ retentionPolicy: { diskMinFreePercent: 5 } }),
        PROJECT_CONTEXT,
      ),
      'payload.policies.retentionPolicy.diskMinFreePercent',
      'global_only_field',
    );
    // 混入其他合法字段不改变结论：携带任一磁盘阈值字段即整段拒绝。
    expectRejection(
      () => validateSettingsPayload(
        payloadWithPolicies({
          retentionPolicy: { evidenceRetentionDays: 7, diskMinFreePercent: 5 },
        }),
        PROJECT_CONTEXT,
      ),
      'payload.policies.retentionPolicy.diskMinFreePercent',
      'global_only_field',
    );
  });

  it('持久化读取路径：项目配置携带磁盘阈值字段按 corrupt 拒绝，不被静默误读', () => {
    let error: unknown;
    try {
      parseStoredSettingsPayload(
        JSON.stringify(payloadWithPolicies({ retentionPolicy: { diskMinFreeBytes: DISK_MIN_FREE_BYTES_MIN } })),
        PROJECT_CONTEXT,
      );
    } catch (caught) {
      error = caught;
    }
    // 持久层取出 structs 非法一律 corrupt（fail-closed，不作为可执行配置返回）。
    expect(isStorageError(error, 'corrupt')).toBe(true);
    // 同一持久化文本在 global scope 是合法配置。
    const globalParsed = parseStoredSettingsPayload(
      JSON.stringify(payloadWithPolicies({ retentionPolicy: { maxBackupCount: 3 } })),
      GLOBAL_CONTEXT,
    );
    expect(globalParsed.policies?.retentionPolicy).toEqual({ maxBackupCount: 3 });
  });
});
