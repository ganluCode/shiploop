/**
 * P07-3 / F-012 保留评估服务与受控数据根只读观测测试。
 *
 * 服务面（注入窄端口，验证评估语义）：
 * - 未配置：全局保留段缺失/为空时 policy not_configured、阈值 not_configured、
 *   可清理/被引用保留 not_configured，不注入任何默认天数/容量；
 * - 阈值边界：字节/百分比阈值等于观测值不触发、低于配置值触发；观测未知时
 *   阈值整体 unknown（不折算 not_triggered，不把未知可用空间当无限容量）；
 * - 备份轮换估计：份数超限与期限到期取并集、最新一包始终保留、清单不可读
 *   显式 unknown；证据保留维度显式 unknown（引用闭合分析 F-013 接线）；
 * - 授权：local-owner 可评估；缺 settings.global.read 能力的受限主体 forbidden。
 *
 * 适配器面（真实临时数据根）：
 * - statfs 观测真实目录得到正的可用/总容量；不存在目录显式 unknown；
 * - 受管区域扫描统计真实文件字节、跳过符号链接、缺区域按空观测、预算耗尽
 *   标记 partial/budgetExhausted；
 * - 备份清单读取真实 manifest 登记字段；坏 manifest 记 unreadable/partial，
 *   staging 目录与 .incomplete.json 不是完整包被跳过；备份根缺失为空清单。
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBackupCatalogReader,
  createDiskUsageObserver,
  createManagedAreaScanner,
} from '../../../packages/core/src/adapters/fs/disk-observation.ts';
import { createRetentionEvaluationService } from '../../../packages/core/src/application/retention-evaluation.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type {
  BackupCatalogRead,
  DiskUsageObservation,
  ManagedUsageScan,
} from '../../../packages/core/src/ports/retention-evaluation.ts';
import type { GlobalSettingsRecord } from '../../../packages/core/src/ports/state-store.ts';
import type { SettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const OWNER = createLocalOwnerPrincipal();
const NOW = 1_900_000_000_000;
const GIB = 1024 ** 3;

function restrictedWithoutGlobalRead(): TrustedPrincipal {
  return {
    principalId: '0a1b2c3d-4e5f-4678-9abc-def012345678',
    capabilities: new Set(['project.read' as const]),
    projectScope: { kind: 'all' },
  } as unknown as TrustedPrincipal;
}

function globalRecord(policies?: SettingsPayload['policies'], revision = 3): GlobalSettingsRecord {
  return {
    id: 'global',
    schemaVersion: 2,
    payload: { schemaVersion: 2, ...(policies === undefined ? {} : { policies }) },
    revision,
    createdAtUtcMs: 1,
    updatedAtUtcMs: 2,
  };
}

function notFound(): never {
  throw new StorageError('not_found', 'test', '全局配置未创建');
}

function observerOf(observation: DiskUsageObservation) {
  return { observe: async () => observation };
}

function scannerOf(scan: ManagedUsageScan) {
  return { scan: async () => scan };
}

function catalogOf(read: BackupCatalogRead) {
  return { list: async () => read };
}

function serviceOf(options: {
  readonly policies?: SettingsPayload['policies'];
  readonly missing?: boolean;
  readonly disk?: DiskUsageObservation;
  readonly scan?: ManagedUsageScan;
  readonly catalog?: BackupCatalogRead;
}) {
  return createRetentionEvaluationService({
    configurationService: {
      getCurrentSettings: async () => (options.missing === true ? notFound() : globalRecord(options.policies)),
    },
    disk: observerOf(options.disk ?? { status: 'observed', availableBytes: 50 * GIB, totalBytes: 100 * GIB }),
    managedScan: scannerOf(options.scan ?? { areas: [], entriesExamined: 0, budgetExhausted: false }),
    backups: catalogOf(options.catalog ?? { status: 'listed', entries: [], unreadable: 0 }),
    nowUtcMs: () => NOW,
  });
}

describe('P07-3 / F-012 保留评估服务', () => {
  it('未配置：无全局配置/空保留段均 not_configured，无默认值注入', async () => {
    for (const policies of [undefined, {}, { retentionPolicy: {} }, { verification: {} }]) {
      const report = await serviceOf({ policies, missing: policies === undefined }).evaluate(OWNER);
      expect(report.policy.status).toBe('not_configured');
      expect(report.policy.retention).toBeUndefined();
      expect(report.thresholds.status).toBe('not_configured');
      expect(report.thresholds.triggers).toEqual([]);
      expect(report.cleanable.status).toBe('not_configured');
      expect(report.cleanable.bytes).toBeUndefined();
      expect(report.referencedRetained.status).toBe('not_configured');
      expect(report.schemaVersion).toBe(1);
      expect(report.operation).toBe('retention.evaluation.get');
    }
  });

  it('字节与百分比阈值边界：等于观测值不触发，低于配置值触发', async () => {
    const policies = { retentionPolicy: { diskMinFreeBytes: 40 * GIB, diskMinFreePercent: 40 } };
    // 可用 40%：字节与百分比阈值均等于观测值 → 不触发。
    const boundary = await serviceOf({
      policies,
      disk: { status: 'observed', availableBytes: 40 * GIB, totalBytes: 100 * GIB },
    }).evaluate(OWNER);
    expect(boundary.policy.status).toBe('configured');
    expect(boundary.policy.source).toEqual({
      kind: 'global_default', scopeRevision: 3, sourceKey: 'policies.retentionPolicy',
    });
    expect(boundary.thresholds.status).toBe('evaluated');
    expect(boundary.thresholds.triggers).toEqual([
      { kind: 'disk_min_free_bytes', configuredValue: 40 * GIB, observedValue: 40 * GIB, assessment: 'not_triggered' },
      { kind: 'disk_min_free_percent', configuredValue: 40, observedValue: 40, assessment: 'not_triggered' },
    ]);

    // 字节低于 1 → 字节阈值触发；百分比四舍五入仍等于 40 → 不触发。
    const triggered = await serviceOf({
      policies,
      disk: { status: 'observed', availableBytes: 40 * GIB - 1, totalBytes: 100 * GIB },
    }).evaluate(OWNER);
    expect(triggered.thresholds.triggers[0]?.assessment).toBe('triggered');
    expect(triggered.thresholds.triggers[1]?.assessment).toBe('not_triggered');

    // 可用 39%：百分比低于阈值触发（字节阈值同样低于，同时触发）。
    const percentTriggered = await serviceOf({
      policies,
      disk: { status: 'observed', availableBytes: 39 * GIB, totalBytes: 100 * GIB },
    }).evaluate(OWNER);
    expect(percentTriggered.thresholds.triggers[1]?.observedValue).toBe(39);
    expect(percentTriggered.thresholds.triggers[1]?.assessment).toBe('triggered');
    expect(percentTriggered.thresholds.triggers[0]?.assessment).toBe('triggered');
  });

  it('磁盘观测未知：阈值整体 unknown（不是 not_triggered），观测值不出现', async () => {
    const report = await serviceOf({
      policies: { retentionPolicy: { diskMinFreeBytes: 10 * GIB } },
      disk: { status: 'unknown', reason: 'EACCES' },
    }).evaluate(OWNER);
    expect(report.disk.status).toBe('unknown');
    expect(report.thresholds.status).toBe('unknown');
    expect(report.thresholds.reason).toBe('EACCES');
    expect(report.thresholds.triggers).toEqual([
      { kind: 'disk_min_free_bytes', configuredValue: 10 * GIB, assessment: 'unknown' },
    ]);
  });

  it('备份轮换估计：份数超限与期限到期取并集，最新一包始终保留', async () => {
    const DAY = 86_400_000;
    const catalog: BackupCatalogRead = {
      status: 'listed',
      unreadable: 0,
      entries: [
        { backupId: 'b-newest', createdAtUtcMs: NOW - DAY, bytes: 100 },
        { backupId: 'b-second', createdAtUtcMs: NOW - 3 * DAY, bytes: 200 },
        { backupId: 'b-third', createdAtUtcMs: NOW - 10 * DAY, bytes: 400 },
        { backupId: 'b-oldest', createdAtUtcMs: NOW - 40 * DAY, bytes: 800 },
      ],
    };
    // maxBackupCount=2：rank>=2 为候选（third+oldest=1200 字节 2 包）。
    const byCount = await serviceOf({
      policies: { retentionPolicy: { maxBackupCount: 2, evidenceRetentionDays: 30 } },
      catalog,
    }).evaluate(OWNER);
    expect(byCount.cleanable.components.find(c => c.kind === 'backup_rotation')).toEqual({
      kind: 'backup_rotation', status: 'assessed', bytes: 1200, items: 2,
    });
    // 证据保留维度显式 unknown（引用闭合分析未接线），整体 partial。
    expect(byCount.cleanable.status).toBe('partial');
    expect(byCount.cleanable.bytes).toBe(1200);
    expect(byCount.cleanable.components.find(c => c.kind === 'evidence_retention')?.status).toBe('unknown');
    // 被引用保留：备份保留量 assessed（newest+second=300），证据引用 unknown → partial。
    expect(byCount.referencedRetained.components.find(c => c.kind === 'backup_retained')).toEqual({
      kind: 'backup_retained', status: 'assessed', bytes: 300, items: 2,
    });
    expect(byCount.referencedRetained.status).toBe('partial');
    expect(byCount.referencedRetained.bytes).toBe(300);

    // backupRetentionDays=30：oldest（40 天）到期；即使全部到期，最新一包保留。
    const byAge = await serviceOf({
      policies: { retentionPolicy: { backupRetentionDays: 30 } },
      catalog,
    }).evaluate(OWNER);
    expect(byAge.cleanable.components.find(c => c.kind === 'backup_rotation')).toEqual({
      kind: 'backup_rotation', status: 'assessed', bytes: 800, items: 1,
    });
    const allExpired = await serviceOf({
      policies: { retentionPolicy: { backupRetentionDays: 1 } },
      catalog,
    }).evaluate(OWNER);
    const rotation = allExpired.cleanable.components.find(c => c.kind === 'backup_rotation');
    expect(rotation?.items).toBe(3);
    expect(rotation?.bytes).toBe(1400);
    expect(allExpired.referencedRetained.components.find(c => c.kind === 'backup_retained')).toEqual({
      kind: 'backup_retained', status: 'assessed', bytes: 100, items: 1,
    });
  });

  it('备份清单不可读：轮换维度 unknown；清单个别坏包按 partial 估计', async () => {
    const unknown = await serviceOf({
      policies: { retentionPolicy: { maxBackupCount: 2 } },
      catalog: { status: 'unknown', reason: 'EACCES', entries: [], unreadable: 0 },
    }).evaluate(OWNER);
    expect(unknown.cleanable.components.find(c => c.kind === 'backup_rotation')).toEqual({
      kind: 'backup_rotation', status: 'unknown', reason: 'EACCES',
    });
    expect(unknown.cleanable.status).toBe('unknown');
    expect(unknown.referencedRetained.status).toBe('unknown');

    const partial = await serviceOf({
      policies: { retentionPolicy: { maxBackupCount: 1 } },
      catalog: {
        status: 'partial', reason: 'manifest_unreadable', unreadable: 1,
        entries: [{ backupId: 'b-ok', createdAtUtcMs: NOW, bytes: 50 }],
      },
    }).evaluate(OWNER);
    const rotation = partial.cleanable.components.find(c => c.kind === 'backup_rotation');
    expect(rotation?.status).toBe('assessed');
    expect(rotation?.reason).toBe('backup_catalog_partial');
  });

  it('受管扫描结果透传；扫描抛错时各区域 unknown，不冒充观测', async () => {
    const scan: ManagedUsageScan = {
      areas: [{ area: 'backups', status: 'observed', bytes: 42, files: 1 }],
      entriesExamined: 2,
      budgetExhausted: false,
    };
    const report = await serviceOf({ policies: { retentionPolicy: { maxBackupCount: 1 } }, scan }).evaluate(OWNER);
    expect(report.managedUsage).toEqual(scan);

    const failing = createRetentionEvaluationService({
      configurationService: { getCurrentSettings: async () => globalRecord({ retentionPolicy: { maxBackupCount: 1 } }) },
      disk: observerOf({ status: 'observed', availableBytes: 1, totalBytes: 2 }),
      managedScan: {
        scan: async () => {
          throw Object.assign(new Error('scan down'), { code: 'EIO' });
        },
      },
      backups: catalogOf({ status: 'listed', entries: [], unreadable: 0 }),
      nowUtcMs: () => NOW,
    });
    const failed = await failing.evaluate(OWNER);
    expect(failed.managedUsage.areas.every(area => area.status === 'unknown')).toBe(true);
    expect(failed.managedUsage.areas.map(area => area.reason)).toEqual(['EIO', 'EIO', 'EIO', 'EIO']);
  });

  it('授权：local-owner 可评估；缺 settings.global.read 的受限主体 forbidden', async () => {
    const service = serviceOf({});
    await expect(service.evaluate(OWNER)).resolves.toBeDefined();
    await expect(service.evaluate(restrictedWithoutGlobalRead())).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'capability_denied' },
    });
  });
});

describe('P07-3 / F-012 受控数据根只读观测适配器（真实文件系统）', () => {
  it('statfs：真实目录观测正容量；不存在目录显式 unknown', async () => {
    const sandbox = createTempSandbox('shiploop-p73-f012-disk-');
    try {
      const observer = createDiskUsageObserver({ dataRoot: sandbox.path });
      const observed = await observer.observe();
      expect(observed.status).toBe('observed');
      expect(observed.availableBytes).toBeGreaterThan(0);
      expect(observed.totalBytes).toBeGreaterThan(0);
      expect(observed.totalBytes).toBeGreaterThanOrEqual(observed.availableBytes ?? 0);

      const missing = await createDiskUsageObserver({ dataRoot: join(sandbox.path, 'missing') }).observe();
      expect(missing.status).toBe('unknown');
      expect(missing.reason).toBe('ENOENT');
    } finally {
      sandbox.cleanup();
    }
  });

  it('受管区域扫描：真实字节合计、跳过符号链接、缺区域为空、预算耗尽 partial', async () => {
    const sandbox = createTempSandbox('shiploop-p73-f012-scan-');
    try {
      const root = sandbox.path;
      mkdirSync(join(root, 'projects', 'p1', 'artifacts', 'a1'), { recursive: true });
      writeFileSync(join(root, 'projects', 'p1', 'artifacts', 'a1', 'content'), 'x'.repeat(100));
      writeFileSync(join(root, 'projects', 'p1', 'artifacts', 'a1', 'extra'), 'y'.repeat(50));
      mkdirSync(join(root, 'staging'), { recursive: true });
      writeFileSync(join(root, 'staging', 'p1.part'), 'z'.repeat(30));
      mkdirSync(join(root, 'backups', 'bk1'), { recursive: true });
      writeFileSync(join(root, 'backups', 'bk1', 'manifest.json'), '{}');
      writeFileSync(join(root, 'core.sqlite'), 'd'.repeat(200));
      // 符号链接：计入预算但不计字节、不跟随目标。
      symlinkSync(join(root, 'staging'), join(root, 'projects', 'p1', 'link-to-staging'));

      const scanner = createManagedAreaScanner({ dataRoot: root });
      const full = await scanner.scan(1000);
      const byArea = new Map(full.areas.map(area => [area.area, area]));
      expect(full.budgetExhausted).toBe(false);
      expect(byArea.get('projects')).toMatchObject({ status: 'observed', bytes: 150, files: 2 });
      expect(byArea.get('staging')).toMatchObject({ status: 'observed', bytes: 30, files: 1 });
      expect(byArea.get('backups')).toMatchObject({ status: 'observed', bytes: 2, files: 1 });
      expect(byArea.get('database')).toMatchObject({ status: 'observed', bytes: 200, files: 1 });

      // 预算耗尽：projects 目录项数超过预算 → partial + budgetExhausted。
      const exhausted = await scanner.scan(3);
      expect(exhausted.budgetExhausted).toBe(true);
      expect(exhausted.areas.find(area => area.area === 'projects')).toMatchObject({
        status: 'partial',
        reason: 'budget_exhausted',
      });

      // 缺失区域按空观测（不是错误）。
      const empty = createTempSandbox('shiploop-p73-f012-empty-');
      try {
        const emptyScan = await createManagedAreaScanner({ dataRoot: empty.path }).scan(100);
        expect(emptyScan.areas.find(area => area.area === 'staging')).toMatchObject({
          status: 'observed', bytes: 0, files: 0,
        });
      } finally {
        empty.cleanup();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('备份清单：读取真实 manifest 登记字段；坏包 partial；staging/报告文件跳过', async () => {
    const sandbox = createTempSandbox('shiploop-p73-f012-catalog-');
    try {
      const backupRoot = join(sandbox.path, 'backups');
      const writeManifest = (id: string, createdAt: string, sizes: number[]) => {
        mkdirSync(join(backupRoot, id), { recursive: true });
        writeFileSync(
          join(backupRoot, id, 'manifest.json'),
          JSON.stringify({
            backupId: id,
            createdAtUtc: createdAt,
            files: sizes.map((sizeBytes, index) => ({ logicalPath: `f${index}`, sizeBytes })),
          }),
        );
      };
      writeManifest('bk-2026', '2026-10-01T00:00:00.000Z', [100, 50]);
      writeManifest('bk-2025', '2025-10-01T00:00:00.000Z', [10]);
      mkdirSync(join(backupRoot, '.bk-staging.staging'), { recursive: true });
      writeFileSync(join(backupRoot, 'bk-failed.incomplete.json'), '{}');
      mkdirSync(join(backupRoot, 'bk-corrupt'), { recursive: true });
      writeFileSync(join(backupRoot, 'bk-corrupt', 'manifest.json'), '{not json');

      const listed = await createBackupCatalogReader({ backupRoot }).list();
      expect(listed.unreadable).toBe(1);
      expect(listed.status).toBe('partial');
      // 清单按目录序返回（排序由评估服务负责）；内容来自真实 manifest 字段。
      expect([...listed.entries].sort((a, b) => (a.backupId < b.backupId ? 1 : -1))).toEqual([
        { backupId: 'bk-2026', createdAtUtcMs: Date.parse('2026-10-01T00:00:00.000Z'), bytes: 150 },
        { backupId: 'bk-2025', createdAtUtcMs: Date.parse('2025-10-01T00:00:00.000Z'), bytes: 10 },
      ]);

      const missing = await createBackupCatalogReader({ backupRoot: join(sandbox.path, 'none') }).list();
      expect(missing).toEqual({ status: 'listed', entries: [], unreadable: 0 });
    } finally {
      sandbox.cleanup();
    }
  });
});
