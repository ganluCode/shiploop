import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DELETE_STEPS } from '../../../packages/core/src/ports/project-delete.ts';
import { createResultRef } from '../../../packages/core/src/ports/command-receipts.ts';
import { createCompletedReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createSqliteCommandReceiptStore } from '../../../packages/core/src/adapters/sqlite/command-receipts.ts';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { seedMemoryRecord, seedProjectRow } from '../../helpers/p07-3/delete-preview-fixture.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createProjectDeleteCommandHandler } from '../../../packages/core/src/application/project-delete.ts';
import { createSqliteProjectDeleteStore } from '../../../packages/core/src/adapters/sqlite/project-delete.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openPreviewFixture } from '../../helpers/p07-3/delete-preview-fixture.ts';

async function fixture() {
  const f = await openPreviewFixture();
  await f.archive();
  // The preview fixture settles Attempt/workspace/dispatch ownership, but retains
  // the Feature lease from its real execution.start. This fixture launched no
  // Runtime; explicitly settle that lease before testing permanent deletion.
  f.session.database.prepare("UPDATE feature_resource_leases SET state = 'released', released_at = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND state = 'held'")
    .run(f.clock.now, f.clock.now, f.projectId);
  await createSqliteCommandReceiptStore(f.session).saveReceipt(createCompletedReceipt({
    commandId: randomUUID(), principalId: f.owner.principalId, operation: 'project.register',
    scope: { kind: 'registration' }, requestDigest: 'c'.repeat(64),
    issuedAt: new Date(f.clock.now).toISOString(), completedAt: new Date(f.clock.now).toISOString(),
    resultRef: createResultRef(randomBytes(32)), result: { project: { id: f.projectId, displayName: 'BUSINESS_BODY_MUST_BE_REMOVED' } },
  }));
  const store = createSqliteProjectDeleteStore(f.session, { nowUtcMs: () => f.clock.now });
  const handler = createProjectDeleteCommandHandler({ store, preview: f.previewService(), nowUtcMs: () => f.clock.now });
  const commands = createCommandService({ atomicStore: createSqliteAtomicCommandStore(f.session), projectDelete: handler });
  const page = await f.previewViaCommand();
  const envelope = {
    schemaVersion: 5, commandId: randomUUID(), operation: 'project.delete.confirm',
    scope: { kind: 'project', projectId: f.projectId }, expectedRevision: page.projectRevision,
    issuedAt: new Date(f.clock.now).toISOString(),
    payload: { projectId: f.projectId, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs },
  };
  return { ...f, store, commands, page, envelope };
}

it('[case:atomic-intent-replay] 确认同事务建立 deleting、固定清单与 accepted；命令重放不重复创建', async () => {
  const f = await fixture();
  const accepted = await f.commands.submit(f.owner, f.envelope);
  expect(accepted.status).toBe('accepted');
  if (accepted.status !== 'accepted') throw new Error(JSON.stringify(accepted));
  expect(f.projectRow().status).toBe('deleting');
  const operation = f.store.get(f.owner, accepted.operationId);
  expect(operation.status).toBe('intent');
  expect(operation.manifest?.objects).toEqual(f.page.entries);
  expect(operation.manifest?.retained).toEqual(f.page.summary.retained);
  const replay = await f.commands.submit(f.owner, f.envelope);
  expect(replay).toMatchObject({ status: 'accepted', operationId: accepted.operationId, replayed: true });
  expect((f.session.database.prepare('SELECT COUNT(*) AS n FROM project_delete_operations').get() as { n: number }).n).toBe(1);
  await expect(f.commands.submit(f.owner, { ...f.envelope, commandId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.commands.submit(f.owner, { ...f.envelope, expectedRevision: f.envelope.expectedRevision + 1 }))
    .rejects.toMatchObject({ code: 'conflict' });
});

async function acceptAndClaim(f: Awaited<ReturnType<typeof fixture>>) {
  const receipt = await f.commands.submit(f.owner, f.envelope);
  if (receipt.status !== 'accepted') throw new Error(JSON.stringify(receipt));
  const operation = f.store.get(f.owner, receipt.operationId);
  const claimed = f.store.claim(f.owner, operation.operationId, 'executor-a', operation.fence, false);
  return { operation, identity: { operationId: claimed.operationId, owner: claimed.owner!, fence: claimed.fence } };
}

it('[case:confirm-rechecks] 确认拒绝摘要/revision/过期/活动/维护漂移与越权，且不建立删除意图', async () => {
  const f = await fixture();
  const assertNoIntent = () => {
    expect(f.projectRow().status).toBe('archived');
    expect((f.session.database.prepare('SELECT COUNT(*) AS n FROM project_delete_operations').get() as { n: number }).n).toBe(0);
  };
  for (const envelope of [
    { ...f.envelope, expectedRevision: f.envelope.expectedRevision + 1 },
    { ...f.envelope, payload: { ...f.envelope.payload, previewDigest: 'f'.repeat(64) } },
    { ...f.envelope, payload: { ...f.envelope.payload, expiresAtUtcMs: f.clock.now - 1 } },
  ]) {
    await expect(f.commands.submit(f.owner, envelope)).rejects.toMatchObject({ code: 'conflict' });
    assertNoIntent();
  }
  const denied = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
  await expect(f.commands.submit(denied, f.envelope)).rejects.toMatchObject({ code: 'forbidden' });
  assertNoIntent();
  const gate = createSqliteMaintenanceWriteGate(f.session);
  const lease = gate.acquire({ operation: 'backup', operationId: randomUUID(), owner: 'backup', hostInstanceId: 'host', nowUtcMs: f.clock.now });
  await expect(f.commands.submit(f.owner, f.envelope)).rejects.toMatchObject({ code: 'resource_busy' });
  assertNoIntent();
  gate.release({ ...lease, confirmed: true });
  // Even a fresh, confirmable F-009 preview cannot override an unresolved
  // Feature lease. The confirmation transaction checks these newer references.
  const blockedLeaseId = randomUUID();
  f.session.database.prepare(`INSERT INTO feature_resource_leases (id, created_at, project_id, updated_at, resource_key, resource_kind, access_mode, lease_mode, owner_id, owner_version, acquired_at, lease_until, state)
    VALUES (?, ?, ?, ?, ?, 'migration', 'exclusive', 'lease', 'unconfirmed-owner', 1, ?, ?, 'held')`)
    .run(blockedLeaseId, f.clock.now, f.projectId, f.clock.now, `project:${f.projectId}:migration`, f.clock.now, f.clock.now + 1000);
  const fresh = await f.previewService().preview({ principal: f.owner, projectId: f.projectId });
  await expect(f.commands.submit(f.owner, { ...f.envelope, payload: { ...f.envelope.payload, previewDigest: fresh.previewDigest } }))
    .rejects.toMatchObject({ code: 'conflict', details: { reason: 'active_execution:feature_resource_leases' } });
  assertNoIntent();
  f.session.database.prepare('DELETE FROM feature_resource_leases WHERE id = ?').run(blockedLeaseId);
  // Changes between the observer's database read and the confirming write are
  // injected at the capture seam, so a transaction-time recheck is necessary.
  const original = f.previewService();
  const handler = createProjectDeleteCommandHandler({ store: f.store, nowUtcMs: () => f.clock.now, preview: {
    ...original,
    async captureForConfirmation(...args) {
      const snapshot = await original.captureForConfirmation(...args);
      f.session.database.prepare("UPDATE runs SET status = 'running' WHERE project_id = ?").run(f.projectId);
      return snapshot;
    },
  } });
  const commands = createCommandService({ atomicStore: createSqliteAtomicCommandStore(f.session), projectDelete: handler });
  await expect(commands.submit(f.owner, f.envelope)).rejects.toMatchObject({ code: 'conflict' });
  assertNoIntent();
});

it('[case:pagination-proof] 未完成分页的确认被拒绝，末页游标与有效期绑定后才建立意图', async () => {
  const f = await fixture();
  const preview = f.previewService(8);
  const handler = createProjectDeleteCommandHandler({ store: f.store, preview, nowUtcMs: () => f.clock.now });
  const commands = createCommandService({ atomicStore: createSqliteAtomicCommandStore(f.session), projectDelete: handler });
  let page = await preview.preview({ principal: f.owner, projectId: f.projectId });
  const envelope = { ...f.envelope, payload: { ...f.envelope.payload, previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs } };
  expect(page.pagination.complete).toBe(false);
  await expect(commands.submit(f.owner, envelope)).rejects.toMatchObject({ code: 'conflict' });
  let cursor: string | undefined;
  for (let guard = 0; !page.pagination.complete && guard < 100; guard += 1) {
    cursor = page.pagination.nextCursor!;
    page = await preview.preview({ principal: f.owner, projectId: f.projectId, cursor });
  }
  expect(page.pagination.complete).toBe(true);
  const accepted = await commands.submit(f.owner, { ...envelope, payload: { ...envelope.payload, cursor } });
  expect(accepted.status).toBe('accepted');
});

it('[case:accept-rollback] accepted 回执写入失败回滚项目状态、operation、维护占用及步骤', async () => {
  const f = await fixture();
  f.session.database.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON project_delete_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;");
  await expect(f.commands.submit(f.owner, f.envelope)).rejects.toThrow();
  expect(f.projectRow().status).toBe('archived');
  expect((f.session.database.prepare('SELECT COUNT(*) AS n FROM project_delete_operations').get() as { n: number }).n).toBe(0);
  expect(createSqliteMaintenanceWriteGate(f.session).read().state).toBe('idle');
});

it('[case:fencing-and-partial-progress] 分步进展重开可读，替换执行者前必须核验停止，旧代次不能推进', async () => {
  const f = await fixture();
  const { identity } = await acceptAndClaim(f);
  f.store.recordStep(identity, 'artifact_bodies', 'completed', 'a'.repeat(64));
  f.store.recordStep(identity, 'artifact_staging', 'failed', 'b'.repeat(64));
  const secondSession = openSqliteStorageSession({ path: f.session.path });
  const reopened = createSqliteProjectDeleteStore(secondSession, { nowUtcMs: () => f.clock.now });
  try {
  expect(reopened.get(f.owner, identity.operationId)).toMatchObject({ status: 'failed', failedStep: 'artifact_staging' });
  expect(() => reopened.claim(f.owner, identity.operationId, 'executor-b', identity.fence, false)).toThrow();
  const next = reopened.claim(f.owner, identity.operationId, 'executor-b', identity.fence, true);
  expect(next.fence).toBeGreaterThan(identity.fence);
  expect(() => f.store.recordStep(identity, 'artifact_staging', 'completed', 'c'.repeat(64))).toThrow();
  expect(() => f.store.recordStep({ ...identity, owner: next.owner!, fence: next.fence }, 'artifact_bodies', 'failed', 'd'.repeat(64))).toThrow();
  expect(f.projectRow().status).toBe('deleting');
  expect(next.steps.find(step => step.step === 'artifact_bodies')?.status).toBe('completed');
  const nextIdentity = { operationId: next.operationId, owner: next.owner!, fence: next.fence };
  for (const step of ['artifact_staging', 'managed_worktrees'] as const) reopened.recordStep(nextIdentity, step, 'completed', 'a'.repeat(64));
  await expect(reopened.finish(nextIdentity, async () => {
    f.store.claim(f.owner, next.operationId, 'executor-c', next.fence, true);
    return true;
  })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.store.get(f.owner, next.operationId)).toMatchObject({ owner: 'executor-c', status: 'running' });
  } finally { secondSession.close(); }
});

it('[case:cross-project-retention] 跨项目 JSON 引用在确认和最终事务都阻止清除，保留引用不被级联删除', async () => {
  const f = await fixture();
  seedProjectRow(f, 'project-b', 'kept');
  f.session.database.prepare(`INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator)
    VALUES ('body-b', ?, 'project-b', ?, 'document', 'ready', 'text/plain', ?, ?, 1, 'b')`)
    .run(f.clock.now, f.clock.now, 'a'.repeat(64), 'a'.repeat(64));
  const artifact = f.page.entries.find(entry => entry.kind === 'artifacts')!;
  seedMemoryRecord(f, 'memory-b', 'project-b', 'body-b', [artifact.id]);
  await expect(f.commands.submit(f.owner, f.envelope)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.projectRow().status).toBe('archived');
  f.session.database.prepare("UPDATE memory_records SET source_refs = '[]' WHERE id = 'memory-b'").run();
  const page = await f.previewService().preview({ principal: f.owner, projectId: f.projectId });
  f.envelope.payload.previewDigest = page.previewDigest;
  const { identity } = await acceptAndClaim(f);
  for (const step of PROJECT_DELETE_STEPS) f.store.recordStep(identity, step, 'completed', 'a'.repeat(64));
  f.session.database.prepare('UPDATE memory_records SET source_refs = ? WHERE id = ?').run(JSON.stringify([{ artifactId: artifact.id }]), 'memory-b');
  await expect(f.store.finish(identity, async () => true)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.session.database.prepare("SELECT id FROM memory_records WHERE id = 'memory-b'").get()).toBeDefined();
  expect(f.session.database.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id)).toBeDefined();
  expect(f.projectRow().status).toBe('deleting');
});

it('[case:purge-rollback-and-tombstone] 文件事实未核验拒绝；最终事务失败整体回滚；成功后最小回执/身份独立持久', async () => {
  const f = await fixture();
  seedProjectRow(f, 'project-survivor', 'kept project');
  const { identity } = await acceptAndClaim(f);
  await expect(f.store.finish(identity, async () => true)).rejects.toMatchObject({ code: 'conflict' });
  for (const step of PROJECT_DELETE_STEPS) f.store.recordStep(identity, step, 'completed', 'a'.repeat(64));
  await expect(f.store.finish(identity, async () => false)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.projectRow().status).toBe('deleting');
  // This trusted test observer checks actual absence; production filesystem
  // traversal/removal belongs to F-011. Source repository stays present.
  const manifest = f.store.get(f.owner, identity.operationId).manifest!;
  rmSync(join(f.root, 'projects', f.projectId, 'artifacts'), { recursive: true, force: true });
  rmSync(f.worktreePath(), { recursive: true, force: true });
  const verifyExternal = async () => !existsSync(join(f.root, 'projects', f.projectId, 'artifacts')) && !existsSync(f.worktreePath());
  const beforeRows = f.session.database.prepare('SELECT * FROM tasks WHERE project_id = ?').all(f.projectId);
  f.session.database.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END;");
  await expect(f.store.finish(identity, verifyExternal)).rejects.toThrow('injected purge failure');
  expect(f.projectRow().status).toBe('deleting');
  expect(f.session.database.prepare('SELECT * FROM tasks WHERE project_id = ?').all(f.projectId)).toEqual(beforeRows);
  expect(f.store.get(f.owner, identity.operationId)).toMatchObject({ status: 'failed', failedStep: 'database', manifestDigest: expect.any(String) });
  expect(createSqliteMaintenanceWriteGate(f.session).read().state).toBe('held');
  f.session.database.exec('DROP TRIGGER fail_purge');
  const completed = await f.store.finish(identity, verifyExternal);
  expect(completed).toMatchObject({ status: 'completed', manifest: null, failedStep: null });
  expect(manifest.objects.length).toBeGreaterThan(0);
  expect(f.session.database.prepare('SELECT id FROM projects WHERE id = ?').get(f.projectId)).toBeUndefined();
  expect(f.session.database.prepare("SELECT id FROM projects WHERE id = 'project-survivor'").get()).toBeDefined();
  expect(existsSync(f.claim.box.box.repoDirA)).toBe(true);
  expect(existsSync(join(f.root, 'backups', 'backup-20261029'))).toBe(true);
  expect(f.session.database.pragma('foreign_key_check')).toEqual([]);
  const replay = await f.commands.submit(f.owner, f.envelope);
  expect(replay).toMatchObject({ status: 'accepted', operationId: identity.operationId, replayed: true });
  const receipts = createSqliteCommandReceiptStore(f.session);
  const tombstones = f.session.database.prepare('SELECT receipt_json FROM project_delete_receipts WHERE target_project_id = ?').all(f.projectId) as { receipt_json: string }[];
  expect(tombstones.length).toBeGreaterThan(1);
  for (const row of tombstones) {
    const receipt = JSON.parse(row.receipt_json);
    if (receipt.status === 'completed') {
      expect(receipt.result).toEqual(receipt.scope.kind === 'registration'
        ? { projectDeleted: true, project: { id: f.projectId } } : { projectDeleted: true });
      expect(await receipts.findReceiptByResultRef(receipt.resultRef)).toEqual(receipt);
    }
  }
  expect(JSON.stringify(tombstones)).not.toContain('BUSINESS_BODY_MUST_BE_REMOVED');
  const other = createRestrictedPrincipal({ capabilities: ['project.lifecycle.write', 'receipts.read'], projectScope: { kind: 'all' } });
  expect(() => f.store.get(other, identity.operationId)).toThrow();
  expect(await receipts.findReceiptByCommandId(other.principalId, f.envelope.commandId)).toBeUndefined();
  expect(createSqliteMaintenanceWriteGate(f.session).read().state).toBe('idle');
  expect(() => f.store.recordStep(identity, 'artifact_bodies', 'completed', 'a'.repeat(64))).toThrow();
});
