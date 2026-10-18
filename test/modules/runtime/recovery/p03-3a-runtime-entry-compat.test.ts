/**
 * F-005 恢复协议公共入口兼容测试。
 *
 * 覆盖 F-005 验收的工程面冻结断言：
 * - 干净 Node 子进程（只继承 PATH、沙箱 HOME/cwd）无需任何厂商 SDK 即可加载
 *   Core 公共入口并暴露恢复契约导出；加载守卫同时禁止 SDK/ORM/网络模块，
 *   且以已知拉入 better-sqlite3 的装配入口证明守卫非空转；
 * - 未知/重复 Runtime 经公共入口导出被明确拒绝，配置能力目录不被顺带修改；
 * - 既有配置评估（配置合法 ≠ 可执行/可恢复）、设置/线协议/预算快照 Schema
 *   版本与恢复契约显式版本拒绝保持兼容——既有面无静默变更。
 *
 * 本文件不构建 dist、不安装/加载实验 SDK、不访问网络或模型凭据。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempSandbox } from '../../../helpers/temp-sandbox.ts';
import {
  assessSettingsConfiguration,
  BUDGET_SNAPSHOT_SCHEMA_VERSION,
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRecoveryCatalog,
  RUNTIME_RECOVERY_CAPABILITY_NAMES,
  RUNTIME_RECOVERY_EVIDENCE_KIND,
  RUNTIME_RECOVERY_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  validateRuntimeRecoveryCapabilities,
  validateRuntimeRecoveryReference,
  validateRuntimeRecoveryRequest,
  WIRE_MESSAGE_SCHEMA_VERSION,
  WORK_ACCEPTED_SCHEMA_VERSION,
} from '../../../../packages/core/src/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const childEntry = resolve(repoRoot, 'test/helpers/runtime-recovery/public-entry-child.mjs');
const publicEntry = resolve(repoRoot, 'packages/core/src/index.ts');
const assemblyEntry = resolve(repoRoot, 'packages/core/src/adapters/composition.ts');

const LOAD_TIMEOUT_MS = 30_000;

/** 在干净子进程中运行公共入口辅助脚本；失败时保留真实 stderr/退出码。 */
function runChild(mode: 'load' | 'guard', entry: string): { status: number | null; stdout: string; stderr: string } {
  return withTempSandbox((root) => {
    const result = spawnSync(process.execPath, [childEntry, mode, entry], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: root,
        NODE_NO_WARNINGS: '1',
      },
      encoding: 'utf8',
      timeout: LOAD_TIMEOUT_MS,
    });
    expect(result.error, result.error?.message).toBeUndefined();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }, { prefix: 'shiploop-f005-entry-' });
}

const digest = 'b'.repeat(64);
const recoverySource = {
  schemaVersion: 1, purpose: 'work', kind: 'conversation', sourceProjectId: 'project-1',
  sourceSessionId: 'session-old', sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old',
  runtime: 'fake', provider: 'provider', model: 'model', providerSessionId: 'native-1',
  nativeArchiveRef: 'artifact-native', nativeFormat: 'synthetic-json',
  nativeFormatVersion: '1', sourceDigest: digest,
};
const recoveryRequest = {
  schemaVersion: 1, projectId: 'project-1', sessionId: 'session-new', executionVersion: 2,
  invocationId: 'invocation-1',
  identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
  strategy: { runtime: 'fake', provider: 'provider', model: 'model' },
  recovery: { mode: 'required', kind: 'conversation', source: recoverySource },
};
const recoveryDescriptor = {
  schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0', sdkVersion: null,
  nativeFormats: [{ format: 'synthetic-json', versions: ['1'] }], limits: [],
  capabilities: Object.fromEntries(RUNTIME_RECOVERY_CAPABILITY_NAMES.map((name) => [name, {
    status: 'verified', limits: [], evidenceRef: 'artifact-evidence',
  }])),
};

function expectValidationReason(fn: () => unknown, reason: string): void {
  expect(fn).toThrowError(expect.objectContaining({
    kind: 'validation',
    details: expect.objectContaining({ reason }),
  }));
}

describe('F-005 public entry loads without any vendor SDK', () => {
  it('loads the Core public entry in a fresh Node process and exposes the recovery contract', () => {
    const result = runChild('load', publicEntry);
    expect(result.status, result.stderr).toBe(0);
    const keys = JSON.parse(result.stdout) as string[];
    for (const exported of [
      'RUNTIME_RECOVERY_SCHEMA_VERSION',
      'RUNTIME_RECOVERY_CAPABILITY_NAMES',
      'RUNTIME_RECOVERY_EVIDENCE_KIND',
      'validateRuntimeRecoveryRequest',
      'validateRuntimeRecoveryReference',
      'validateRuntimeRecoveryCapabilities',
      'decideRuntimeRecovery',
      'createStaticRuntimeRecoveryCatalog',
      'validateRuntimeRecoveryStrategy',
      'createRuntimeRecoveryService',
    ]) expect(keys, exported).toContain(exported);
  });
  it('rejects a forbidden infrastructure import, proving the SDK guard is not vacuous', () => {
    const result = runChild('guard', assemblyEntry);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('forbidden specifier: better-sqlite3');
  });
});

describe('F-005 unknown and duplicate runtimes are rejected via the public entry', () => {
  it('rejects duplicate runtime descriptors and unknown runtimes without mutating the configuration catalog', () => {
    const configuration = createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'fake', providers: [{ providerId: 'provider', models: ['model'] }] },
    ]);
    expectValidationReason(
      () => createStaticRuntimeRecoveryCatalog([recoveryDescriptor, recoveryDescriptor], configuration),
      'duplicate_runtime_id',
    );
    expectValidationReason(
      () => createStaticRuntimeRecoveryCatalog(
        [{ ...recoveryDescriptor, runtimeId: 'pi-durable' }], configuration,
      ),
      'unknown_runtime',
    );
    expect(configuration.resolve('pi-durable')).toBeUndefined();
    expect(configuration.resolve('fake')).toBeDefined();
  });
});

describe('F-005 existing configuration, task strategy, budget and wire surfaces stay compatible', () => {
  it('keeps configuration compatibility assessment: a legal strategy is still not executable or recoverable', () => {
    const payload = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      strategies: { defaultStrategy: { runtime: 'fake', provider: 'provider', model: 'model' } },
    };
    expect(assessSettingsConfiguration(payload as never)).toEqual({
      configured: true, executable: false, reason: 'execution_capability_not_assembled',
    });
    expect(assessSettingsConfiguration({ schemaVersion: SETTINGS_SCHEMA_VERSION } as never)).toEqual({
      configured: false, executable: false, reason: 'no_strategy_configured',
    });
  });
  it('keeps frozen schema versions for settings, wire protocol, budget snapshot and recovery contract', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    expect(WIRE_MESSAGE_SCHEMA_VERSION).toBe(5);
    expect(WORK_ACCEPTED_SCHEMA_VERSION).toBe(6);
    expect(BUDGET_SNAPSHOT_SCHEMA_VERSION).toBe(1);
    expect(RUNTIME_RECOVERY_SCHEMA_VERSION).toBe(1);
    expect(RUNTIME_RECOVERY_EVIDENCE_KIND).toBe('runtime-recovery-evidence');
    expect([...RUNTIME_RECOVERY_CAPABILITY_NAMES]).toEqual([
      'nativeHistory', 'conversationResume', 'executionRecovery', 'modelSwitchOnResume', 'nativeFork',
    ]);
  });
  it('rejects non-v1 recovery schema versions explicitly on every recovery validator', () => {
    expectValidationReason(
      () => validateRuntimeRecoveryRequest({ ...recoveryRequest, schemaVersion: 2 }),
      'unsupported_schema_version',
    );
    expectValidationReason(
      () => validateRuntimeRecoveryReference({ ...recoverySource, schemaVersion: '1' }),
      'unsupported_schema_version',
    );
    expectValidationReason(
      () => validateRuntimeRecoveryCapabilities({ ...recoveryDescriptor, schemaVersion: 0 }),
      'unsupported_schema_version',
    );
  });
});
