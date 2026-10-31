/**
 * P07-3 / F-015：retention.cleanup.execute 公开命令（Core 层）。
 *
 * 覆盖：已配置政策的一次清理与回执重放、未配置政策的拒绝、受限主体
 * forbidden、未装配端口的 unsupported、信封校验（未知 payload 键/错误 scope）。
 * 清理服务本身的真实文件行为已由 F-013 覆盖；此处聚焦命令面接线与授权。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createRetentionCleanupCommandHandler } from '../../../packages/core/src/application/retention-cleanup-command.ts';
import { createRetentionCleanupService } from '../../../packages/core/src/application/evidence-retention.ts';
import { createSqliteRetentionCleanupStore } from '../../../packages/core/src/adapters/sqlite/evidence-retention.ts';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_900_000_000_000;

async function fixture() {
  const sandbox = createTempSandbox('shiploop-p07-3-f015-cleanup-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'core.sqlite') });
  await migrateSqliteStorage(session);
  const body = new TextEncoder().encode('expired evidence');
  const artifactPath = join(sandbox.path, 'projects', 'p1', 'artifacts', 'a1', 'content');
  mkdirSync(join(artifactPath, '..'), { recursive: true });
  writeFileSync(artifactPath, body);
  session.transactWrite('fixture.seed', db => {
    db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('p1', ?, 1, ?, 'P1', 'active', '[]')").run(NOW - 40 * 86_400_000, NOW - 40 * 86_400_000);
    db.prepare("INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) VALUES ('a1', ?, 'p1', 1, ?, 'recording', 'ready', 'text/plain', ?, ?, ?, 1, 'recording/a1', NULL)").run(NOW - 40 * 86_400_000, NOW - 40 * 86_400_000, 'a'.repeat(64), 'a'.repeat(64), body.byteLength);
  });
  const stateStore = createSqliteStateStore(session, { nowUtcMs: () => NOW });
  const configurationService = createConfigurationService({
    stateStore,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
  });
  const cleanupService = createRetentionCleanupService({
    store: createSqliteRetentionCleanupStore({
      session,
      dataRoot: sandbox.path,
      maintenanceGate: createSqliteMaintenanceWriteGate(session),
      nowUtcMs: () => NOW,
    }),
    nowUtcMs: () => NOW,
  });
  const retentionCleanupCommand = createRetentionCleanupCommandHandler({
    cleanup: cleanupService,
    settings: configurationService,
    atomicStore: createSqliteAtomicCommandStore(session),
    nowUtcMs: () => NOW,
  });
  const commandsWithCleanup = createCommandService({
    atomicStore: createSqliteAtomicCommandStore(session),
    retentionCleanupCommand,
    nowUtcMs: () => NOW,
  });
  const commandsWithoutCleanup = createCommandService({
    atomicStore: createSqliteAtomicCommandStore(session),
    nowUtcMs: () => NOW,
  });
  const owner = createLocalOwnerPrincipal();
  const envelope = () => ({
    schemaVersion: 5,
    commandId: randomUUID(),
    operation: 'retention.cleanup.execute',
    scope: { kind: 'global' },
    issuedAt: new Date(NOW - 1_000).toISOString(),
    payload: {},
  });
  return {
    sandbox, session, owner, envelope, stateStore, configurationService,
    commandsWithCleanup, commandsWithoutCleanup,
    createRestricted: () => createRestrictedPrincipal({ projectScope: { kind: 'all' }, capabilities: [] }),
  };
}

it('[case:cleanup-command-configured-run] 全局配置政策后执行一次有界清理并重放同一回执', async () => {
  const f = await fixture();
  try {
    await f.stateStore.createGlobalSettings({ payload: { schemaVersion: 2, policies: { retentionPolicy: { evidenceRetentionDays: 10 } } } });
    const receipt = await f.commandsWithCleanup.submit(f.owner, f.envelope());
    expect(receipt.status).toBe('completed');
    if (receipt.status !== 'completed') throw new Error(JSON.stringify(receipt));
    expect(receipt.result).toMatchObject({ status: 'completed', itemsDeleted: 1, bytesDeleted: body0() });
    expect(receipt.scope).toEqual({ kind: 'global' });
    const first = JSON.parse(JSON.stringify(receipt)) as { result: { operationId: string } };
    // 重放：同 commandId 返回同一回执（含同一 operationId 与计数），不重复清理。
    const again = await f.commandsWithCleanup.submit(f.owner, { ...f.envelope(), commandId: (receipt as { commandId: string }).commandId });
    const replayed = JSON.parse(JSON.stringify(again)) as typeof first & { replayed: boolean };
    expect(replayed.replayed).toBe(true);
    expect({ ...first, replayed: true }).toEqual(replayed);
    expect(replayed.result.operationId).toBe(first.result.operationId);
    expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM retention_operations').get()).toEqual({ n: 1 });
  } finally {
    f.session.close();
    f.sandbox.cleanup();
  }
});

function body0(): number {
  return 'expired evidence'.length;
}

it('[case:cleanup-command-policy-missing] 未配置保留政策的清理命令返回 rejected 而非伪造执行', async () => {
  const f = await fixture();
  try {
    const receipt = await f.commandsWithCleanup.submit(f.owner, f.envelope());
    expect(receipt.status).toBe('rejected');
    if (receipt.status !== 'rejected') throw new Error(JSON.stringify(receipt));
    expect(receipt.error.code).toBe('conflict');
    expect(receipt.error.details).toMatchObject({ reason: 'retention_policy_not_configured' });
    expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM retention_operations').get()).toEqual({ n: 0 });
  } finally {
    f.session.close();
    f.sandbox.cleanup();
  }
});

it('[case:cleanup-command-authorization] 无 settings.global.write 能力的受限主体被拒绝', async () => {
  const f = await fixture();
  try {
    await expect(f.commandsWithCleanup.submit(f.createRestricted(), f.envelope())).rejects.toMatchObject({ code: 'forbidden' });
  } finally {
    f.session.close();
    f.sandbox.cleanup();
  }
});

it('[case:cleanup-command-unsupported] 未装配清理端口时命令 unsupported', async () => {
  const f = await fixture();
  try {
    await expect(f.commandsWithoutCleanup.submit(f.owner, f.envelope())).rejects.toMatchObject({ code: 'unsupported' });
  } finally {
    f.session.close();
    f.sandbox.cleanup();
  }
});

it('[case:cleanup-command-envelope] 未知 payload 键与项目 scope 均为 invalid_input', async () => {
  const f = await fixture();
  try {
    await expect(f.commandsWithCleanup.submit(f.owner, { ...f.envelope(), payload: { force: true } })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { field: 'payload.force' },
    });
    await expect(f.commandsWithCleanup.submit(f.owner, { ...f.envelope(), scope: { kind: 'project', projectId: 'p1' } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  } finally {
    f.session.close();
    f.sandbox.cleanup();
  }
});
