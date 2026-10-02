/**
 * F-002 StateStore / ArtifactStore 窄契约的行为回归（经契约测试专用内存假存储）。
 *
 * 覆盖（P01-2 / F-002）：
 * - 项目创建：稳定 ID、默认空 labels、可选 description、初始 revision=1、UTC 毫秒时间；
 *   非法输入（缺 displayName、非法 labels、未知键）在校验阶段抛出带操作/实体身份的错误，
 *   且假存储中没有任何持久化副作用；
 * - 当前配置：全局单例与项目唯一记录、重复创建冲突、expectedRevision CAS
 *   （过期值冲突且原 payload/revision 不变）、两项目读取严格隔离；
 *   损坏持久 JSON / 未知格式不能从读取端口作为有效配置返回（corrupt）；
 * - 制品索引：pending 登记（项目/kind/mediaType/预期 hash/受控 locator/version/revision）、
 *   缺失项目与非法元数据拒绝、hash 不匹配不能转 ready、过期 revision 冲突、
 *   终态不可覆盖、跨项目归属拒绝、仅同项目 ready 制品可取得有效输入引用；
 * - 公共入口（packages/core/src/index.ts）真实导出契约面，且契约区不依赖
 *   Pi/HTTP/Electron/Drizzle/better-sqlite3（后者另由 typescript-build 与 check-boundaries 强制）。
 *
 * 假存储（test/helpers/in-memory-store.ts）只是契约的可执行规格说明，
 * 真实 SQLite 适配器自 F-003 起实现并须通过同一组行为断言的适配版本。
 */
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import { GLOBAL_SETTINGS_ID } from '../packages/core/src/ports/state-store.ts';
import * as coreEntry from '../packages/core/src/index.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { createInMemoryStorage } from './helpers/in-memory-store.ts';
import type { InMemoryStorage } from './helpers/in-memory-store.ts';

const VALID_HASH = 'ab'.repeat(32);
const OTHER_HASH = 'cd'.repeat(32);

/** 确定性递增时钟：每次调用 +1ms，便于断言 createdAt/updatedAt 变化。 */
function createHarness(): InMemoryStorage {
  let tick = 1_700_000_000_000;
  return createInMemoryStorage(() => {
    tick += 1;
    return tick;
  });
}

async function expectStorageError(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(true);
    return error as StorageError;
  }
  throw new Error(`expected StorageError(${kind})`);
}

async function createProject(harness: InMemoryStorage, displayName = '示例项目') {
  return harness.stateStore.createProject({ displayName });
}

describe('F-002 public contract surface', () => {
  it('exports the contract validators, error type and constants from the Core entry', () => {
    expect(typeof coreEntry.validateCreateProjectInput).toBe('function');
    expect(typeof coreEntry.validateUpdateProjectInput).toBe('function');
    expect(typeof coreEntry.validatePutSettingsInput).toBe('function');
    expect(typeof coreEntry.validateUpdateSettingsInput).toBe('function');
    expect(typeof coreEntry.validateSettingsPayload).toBe('function');
    expect(typeof coreEntry.parseStoredSettingsPayload).toBe('function');
    expect(typeof coreEntry.validateRegisterArtifactInput).toBe('function');
    expect(typeof coreEntry.validateTransitionArtifactInput).toBe('function');
    expect(typeof coreEntry.validateMigrationDescriptor).toBe('function');
    expect(typeof coreEntry.normalizeLabels).toBe('function');
    expect(coreEntry.SETTINGS_SCHEMA_VERSION).toBe(1);
    expect(coreEntry.GLOBAL_SETTINGS_ID).toBe('global');
    expect(typeof coreEntry.StorageError).toBe('function');
  });
});

describe('F-002 project contract (create / read / metadata CAS)', () => {
  it('creates a project with stable id, default empty labels, null description and revision 1', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.displayName).toBe('示例项目');
    expect(project.description).toBeNull();
    expect(project.labels).toEqual([]);
    expect(project.status).toBe('active');
    expect(project.repositoryBindingId).toBeNull();
    expect(project.revision).toBe(1);
    expect(Number.isInteger(project.createdAtUtcMs)).toBe(true);
    expect(project.updatedAtUtcMs).toBe(project.createdAtUtcMs);

    const fetched = await harness.stateStore.getProject(project.id);
    expect(fetched).toEqual(project);
  });

  it('keeps an optional description and normalized labels when provided', async () => {
    const harness = createHarness();
    const project = await harness.stateStore.createProject({
      displayName: 'P',
      description: '可选说明（相对 core-design/11 字段字典的补充，依据见契约注释）',
      labels: [' Bug ', 'bug', '核心'],
    });
    expect(project.description).toContain('可选说明');
    expect(project.labels).toEqual(['bug', '核心']);
  });

  it('rejects invalid create input with validation error and persists nothing', async () => {
    const harness = createHarness();
    for (const input of [
      {},
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 1 },
      { displayName: 'x', labels: 'not-an-array' },
      { displayName: 'x', labels: [''] },
      { displayName: 'x', unknownKey: true },
      'not-an-object',
    ]) {
      const error = await expectStorageError('validation', () => harness.stateStore.createProject(input));
      expect(error.operation).toBe('StateStore.createProject');
      expect(error.entity?.type).toBe('project');
    }
    expect(harness.raw.projects.size).toBe(0);
  });

  it('returns not_found with entity identity for a missing project', async () => {
    const harness = createHarness();
    const error = await expectStorageError('not_found', () => harness.stateStore.getProject('p-missing'));
    expect(error.operation).toBe('StateStore.getProject');
    expect(error.entity).toEqual({ type: 'project', id: 'p-missing' });
  });

  it('applies metadata updates under expectedRevision CAS and rejects stale revisions', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const updated = await harness.stateStore.updateProject(project.id, {
      expectedRevision: 1,
      labels: ['Alpha'],
    });
    expect(updated.revision).toBe(2);
    expect(updated.labels).toEqual(['alpha']);
    expect(updated.displayName).toBe('示例项目');
    expect(updated.updatedAtUtcMs).toBeGreaterThan(project.updatedAtUtcMs);

    const stale = await expectStorageError('conflict', () =>
      harness.stateStore.updateProject(project.id, { expectedRevision: 1, displayName: '改名' }),
    );
    expect(stale.operation).toBe('StateStore.updateProject');
    expect(stale.entity).toEqual({ type: 'project', id: project.id });
    expect(stale.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
    const after = await harness.stateStore.getProject(project.id);
    expect(after.displayName).toBe('示例项目');
    expect(after.revision).toBe(2);
  });

  it('rejects metadata updates without any updatable field', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    await expectStorageError('validation', () =>
      harness.stateStore.updateProject(project.id, { expectedRevision: 1 }),
    );
    expect((await harness.stateStore.getProject(project.id)).revision).toBe(1);
  });
});

describe('F-002 current settings contract (global singleton and per-project)', () => {
  const VALID_PAYLOAD = {
    schemaVersion: 1,
    strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  };

  it('creates the single global settings record and rejects a duplicate create', async () => {
    const harness = createHarness();
    const created = await harness.stateStore.createGlobalSettings({ payload: VALID_PAYLOAD });
    expect(created.id).toBe(GLOBAL_SETTINGS_ID);
    expect(created.schemaVersion).toBe(1);
    expect(created.payload).toEqual(VALID_PAYLOAD);
    expect(created.revision).toBe(1);

    const duplicate = await expectStorageError('conflict', () =>
      harness.stateStore.createGlobalSettings({ payload: VALID_PAYLOAD }),
    );
    expect(duplicate.entity?.type).toBe('global_settings');
    const fetched = await harness.stateStore.getGlobalSettings();
    expect(fetched.revision).toBe(1);
  });

  it('updates global settings via expectedRevision CAS without silent overwrite', async () => {
    const harness = createHarness();
    await harness.stateStore.createGlobalSettings({ payload: VALID_PAYLOAD });
    const nextPayload = { schemaVersion: 1 };
    const updated = await harness.stateStore.updateGlobalSettings({ expectedRevision: 1, payload: nextPayload });
    expect(updated.revision).toBe(2);
    expect(updated.payload).toEqual(nextPayload);

    const stale = await expectStorageError('conflict', () =>
      harness.stateStore.updateGlobalSettings({ expectedRevision: 1, payload: VALID_PAYLOAD }),
    );
    expect(stale.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
    const fetched = await harness.stateStore.getGlobalSettings();
    expect(fetched.payload).toEqual(nextPayload);
    expect(fetched.revision).toBe(2);
  });

  it('rejects invalid settings payloads before persistence, leaving no side effect', async () => {
    const harness = createHarness();
    for (const input of [
      {},
      { payload: {} },
      { payload: { schemaVersion: 2 } },
      { payload: { schemaVersion: 1, executionLimits: {} } },
      { payload: 'arbitrary' },
    ]) {
      const error = await expectStorageError('validation', () => harness.stateStore.createGlobalSettings(input));
      expect(error.operation).toBe('StateStore.createGlobalSettings');
      expect(error.entity?.type).toBe('global_settings');
    }
    expect(harness.raw.settings.size).toBe(0);

    await harness.stateStore.createGlobalSettings({ payload: VALID_PAYLOAD });
    await expectStorageError('validation', () =>
      harness.stateStore.updateGlobalSettings({ expectedRevision: 1, payload: { schemaVersion: 9 } }),
    );
    expect((await harness.stateStore.getGlobalSettings()).payload).toEqual(VALID_PAYLOAD);
  });

  it('returns not_found when reading settings that were never created', async () => {
    const harness = createHarness();
    await expectStorageError('not_found', () => harness.stateStore.getGlobalSettings());
  });

  it('keeps per-project settings strictly isolated and one record per project', async () => {
    const harness = createHarness();
    const projectA = await createProject(harness, '项目A');
    const projectB = await createProject(harness, '项目B');
    await harness.stateStore.createProjectSettings(projectA.id, { payload: VALID_PAYLOAD });
    await harness.stateStore.createProjectSettings(projectB.id, { payload: { schemaVersion: 1 } });

    const settingsA = await harness.stateStore.getProjectSettings(projectA.id);
    const settingsB = await harness.stateStore.getProjectSettings(projectB.id);
    expect(settingsA.projectId).toBe(projectA.id);
    expect(settingsA.payload).toEqual(VALID_PAYLOAD);
    expect(settingsB.payload).toEqual({ schemaVersion: 1 });

    await expectStorageError('conflict', () =>
      harness.stateStore.createProjectSettings(projectA.id, { payload: { schemaVersion: 1 } }),
    );
    await expectStorageError('not_found', () =>
      harness.stateStore.createProjectSettings('p-missing', { payload: { schemaVersion: 1 } }),
    );

    const updated = await harness.stateStore.updateProjectSettings(projectB.id, {
      expectedRevision: 1,
      payload: VALID_PAYLOAD,
    });
    expect(updated.revision).toBe(2);
    expect((await harness.stateStore.getProjectSettings(projectA.id)).revision).toBe(1);
  });

  it('never returns corrupted persisted JSON as a valid config from the read port', async () => {
    const harness = createHarness();
    await harness.stateStore.createGlobalSettings({ payload: VALID_PAYLOAD });

    harness.raw.settings.get(GLOBAL_SETTINGS_ID)!.json = '{broken';
    const broken = await expectStorageError('corrupt', () => harness.stateStore.getGlobalSettings());
    expect(broken.entity?.type).toBe('global_settings');

    harness.raw.settings.get(GLOBAL_SETTINGS_ID)!.json = '{"schemaVersion":2}';
    await expectStorageError('corrupt', () => harness.stateStore.getGlobalSettings());
  });
});

describe('F-002 artifact index contract (pending / ready / failed)', () => {
  async function registerPending(harness: InMemoryStorage, projectId: string) {
    return harness.artifactStore.registerArtifact({
      projectId,
      kind: 'verification-report',
      mediaType: 'application/json',
      expectedHash: VALID_HASH,
      locator: `artifacts/${projectId}/report-1`,
    });
  }

  it('registers a pending artifact with expected hash, locator, version and revision', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const artifact = await registerPending(harness, project.id);
    expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifact.projectId).toBe(project.id);
    expect(artifact.status).toBe('pending');
    expect(artifact.expectedHash).toBe(VALID_HASH);
    expect(artifact.contentHash).toBeNull();
    expect(artifact.sizeBytes).toBeNull();
    expect(artifact.locator).toBe(`artifacts/${project.id}/report-1`);
    expect(artifact.version).toBe(1);
    expect(artifact.revision).toBe(1);
    expect(artifact.failureReason).toBeNull();
  });

  it('rejects registration for a missing project and for illegal metadata, persisting nothing', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const missing = await expectStorageError('not_found', () => registerPending(harness, 'p-missing'));
    expect(missing.entity?.type).toBe('project');

    for (const input of [
      { projectId: project.id, kind: '', mediaType: 'application/json', expectedHash: VALID_HASH, locator: 'a/b' },
      { projectId: project.id, kind: 'k', mediaType: '', expectedHash: VALID_HASH, locator: 'a/b' },
      { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: 'xyz', locator: 'a/b' },
      { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: '/abs/path' },
      { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: 'a/../b' },
      { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: 'a/b', version: 0 },
    ]) {
      const error = await expectStorageError('validation', () => harness.artifactStore.registerArtifact(input));
      expect(error.operation).toBe('ArtifactStore.registerArtifact');
    }
    expect(harness.raw.artifacts.size).toBe(0);
  });

  it('transitions pending to ready only with matching hash and actual size, under CAS', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const artifact = await registerPending(harness, project.id);

    const mismatch = await expectStorageError('validation', () =>
      harness.artifactStore.transitionArtifact(project.id, artifact.id, {
        expectedRevision: 1,
        outcome: { status: 'ready', actualHash: OTHER_HASH, sizeBytes: 10 },
      }),
    );
    expect(mismatch.details?.field).toBe('outcome.actualHash');
    expect((await harness.artifactStore.getArtifact(project.id, artifact.id)).status).toBe('pending');

    const ready = await harness.artifactStore.transitionArtifact(project.id, artifact.id, {
      expectedRevision: 1,
      outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 0 },
    });
    expect(ready.status).toBe('ready');
    expect(ready.contentHash).toBe(VALID_HASH);
    expect(ready.sizeBytes).toBe(0);
    expect(ready.revision).toBe(2);
  });

  it('rejects stale revisions and repeated transitions without overwriting existing state', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const artifact = await registerPending(harness, project.id);

    await expectStorageError('conflict', () =>
      harness.artifactStore.transitionArtifact(project.id, artifact.id, {
        expectedRevision: 7,
        outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 1 },
      }),
    );
    expect((await harness.artifactStore.getArtifact(project.id, artifact.id)).status).toBe('pending');

    await harness.artifactStore.transitionArtifact(project.id, artifact.id, {
      expectedRevision: 1,
      outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 5 },
    });
    const again = await expectStorageError('conflict', () =>
      harness.artifactStore.transitionArtifact(project.id, artifact.id, {
        expectedRevision: 2,
        outcome: { status: 'ready', actualHash: OTHER_HASH, sizeBytes: 99 },
      }),
    );
    expect(again.entity).toEqual({ type: 'artifact', id: artifact.id, projectId: project.id });
    const after = await harness.artifactStore.getArtifact(project.id, artifact.id);
    expect(after.contentHash).toBe(VALID_HASH);
    expect(after.sizeBytes).toBe(5);
    expect(after.revision).toBe(2);
  });

  it('keeps failure reason and evidence on failed transitions; failed is terminal at index level', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const artifact = await registerPending(harness, project.id);
    const failed = await harness.artifactStore.transitionArtifact(project.id, artifact.id, {
      expectedRevision: 1,
      outcome: { status: 'failed', reason: 'staging 写入 I/O 失败（注入）' },
    });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('staging');
    expect(failed.contentHash).toBeNull();

    await expectStorageError('conflict', () =>
      harness.artifactStore.transitionArtifact(project.id, artifact.id, {
        expectedRevision: 2,
        outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 5 },
      }),
    );
    expect((await harness.artifactStore.getArtifact(project.id, artifact.id)).status).toBe('failed');
  });

  it('issues a valid input reference only for same-project ready artifacts', async () => {
    const harness = createHarness();
    const projectA = await createProject(harness, '项目A');
    const projectB = await createProject(harness, '项目B');
    const pending = await registerPending(harness, projectA.id);

    const notReady = await expectStorageError('conflict', () =>
      harness.artifactStore.getArtifactInputRef(projectA.id, pending.id),
    );
    expect(notReady.details).toMatchObject({ status: 'pending' });

    await harness.artifactStore.transitionArtifact(projectA.id, pending.id, {
      expectedRevision: 1,
      outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 12 },
    });
    const reference = await harness.artifactStore.getArtifactInputRef(projectA.id, pending.id);
    expect(reference).toEqual({
      artifactId: pending.id,
      projectId: projectA.id,
      contentHash: VALID_HASH,
      sizeBytes: 12,
      locator: pending.locator,
      version: 1,
    });

    const crossProject = await expectStorageError('ownership', () =>
      harness.artifactStore.getArtifactInputRef(projectB.id, pending.id),
    );
    expect(crossProject.operation).toBe('ArtifactStore.getArtifactInputRef');
    expect(crossProject.entity).toEqual({ type: 'artifact', id: pending.id, projectId: projectB.id });

    await expectStorageError('ownership', () => harness.artifactStore.getArtifact(projectB.id, pending.id));
    await expectStorageError('not_found', () => harness.artifactStore.getArtifact(projectA.id, 'a-missing'));
  });

  it('rejects invalid transition input at the boundary before touching stored state', async () => {
    const harness = createHarness();
    const project = await createProject(harness);
    const artifact = await registerPending(harness, project.id);
    for (const input of [
      { expectedRevision: 0, outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 1 } },
      { expectedRevision: 1, outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: -1 } },
      { expectedRevision: 1, outcome: { status: 'ready', actualHash: VALID_HASH } },
      { expectedRevision: 1, outcome: { status: 'failed', reason: '' } },
      { expectedRevision: 1, outcome: { status: 'archived' } },
      { expectedRevision: 1 },
    ]) {
      await expectStorageError('validation', () =>
        harness.artifactStore.transitionArtifact(project.id, artifact.id, input),
      );
    }
    const after = await harness.artifactStore.getArtifact(project.id, artifact.id);
    expect(after.status).toBe('pending');
    expect(after.revision).toBe(1);
  });
});
