import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { createSqliteProjectLifecycleAccess } from '../../../packages/core/src/adapters/sqlite/project-lifecycle.ts';
import { createSqliteStateStore, createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createProjectLifecycleCommandHandler } from '../../../packages/core/src/application/project-lifecycle.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../../../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../../../packages/core/src/application/execution-start.ts';
import { createBaselineWorkspaceReader } from '../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import { NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';

let box: BudgetFixture | undefined;
let extraSessions: SqliteStorageSession[] = [];
afterEach(() => {
  for (const session of extraSessions.splice(0)) session.close();
  box?.close();
  box = undefined;
});

interface ArchiveServicesOptions {
  readonly closeoutBudgetMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 本 Task 的命令面：真实 SQLite 原子命令 + 项目生命周期句柄 + execution.start。 */
function archiveServices(session: SqliteStorageSession, options: ArchiveServicesOptions = {}) {
  const nowUtcMs = () => NOW;
  const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs });
  const inspector = createRepositoryInspector();
  const preview = createExecutionPreviewService({
    views: createSqlitePlanAccess(session, { nowUtcMs }), inspector,
    workspace: createBaselineWorkspaceReader(), permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: nowUtcMs,
  });
  const closeouts = createSqliteProjectLifecycleAccess(session);
  const projectLifecycle = createProjectLifecycleCommandHandler({
    atomicStore: atomic,
    readCloseout: closeouts.readProjectArchiveCloseout,
    nowUtcMs,
    closeoutBudgetMs: options.closeoutBudgetMs ?? 0,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const commands = createCommandService({
    atomicStore: atomic, repositoryInspector: inspector,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
    ]),
    executionPreview: preview,
    executionStart: createExecutionStartService({ preview, permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: nowUtcMs }),
    projectLifecycle,
    nowUtcMs,
  });
  return { atomic, commands, projectLifecycle, closeouts };
}

function projectRow(b: BudgetFixture) {
  return b.session.database.prepare('SELECT revision, status FROM projects WHERE id = ?').get(b.projectId) as {
    revision: number; status: string;
  };
}

function archiveEnvelope(b: BudgetFixture, extra: Record<string, unknown> = {}) {
  return b.envelope('project.archive', { projectId: b.projectId }, {
    scope: b.scope, expectedRevision: projectRow(b).revision, ...extra,
  });
}

function restoreEnvelope(b: BudgetFixture, extra: Record<string, unknown> = {}) {
  return b.envelope('project.restore', { projectId: b.projectId }, {
    scope: b.scope, expectedRevision: projectRow(b).revision, ...extra,
  });
}

function lifecycleEvents(b: BudgetFixture) {
  return b.session.database.prepare(
    "SELECT event_type, payload, aggregate_revision FROM state_events WHERE event_type = 'project.status_changed' ORDER BY sequence",
  ).all() as { event_type: string; payload: string; aggregate_revision: number }[];
}

function terminal(b: BudgetFixture) {
  b.session.transactWrite('fixture.terminal', () => {
    b.session.database.prepare('UPDATE runs SET status = ?').run('cancelled');
    b.session.database.prepare('UPDATE execution_batches SET status = ?').run('cancelled');
  });
}

function businessSnapshot(b: BudgetFixture) {
  return Object.fromEntries(['phases', 'features', 'task_dependencies', 'feature_dependencies', 'tasks',
    'execution_batches', 'runs', 'attempts', 'batch_budget_revisions', 'task_attempt_reservations',
    'runtime_start_reservations', 'workspace_leases', 'run_dispatch_claims', 'execution_slot_claims',
    'execution_stop_operations', 'artifacts', 'sessions', 'baseline_operations', 'baseline_authorizations']
    .map(table => [table, b.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function fileSnapshot(root: string, prefix = ''): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    entries.push(`${prefix}${name}:${stat.isDirectory() ? 'dir' : `${stat.size}:${stat.mtimeMs}`}`);
    if (stat.isDirectory()) entries.push(...fileSnapshot(path, `${prefix}${name}/`));
  }
  return entries;
}

function deferredSleep() {
  const waiting: Array<() => void> = [];
  let calls = 0;
  return {
    get calls() { return calls; },
    sleep: () => {
      calls += 1;
      return new Promise<void>(resolve => { waiting.push(resolve); });
    },
    release: () => { for (const resolve of waiting.splice(0)) resolve(); },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise(resolve => { setTimeout(resolve, 1); });
  }
  expect(condition()).toBe(true);
}

it('[case:archive-closeout-and-restore] 有活动执行时保持可查询 archiving，收口后原子归档并显式恢复', async () => {
  box = await openBudgetFixture();
  const svc = archiveServices(box.session);
  await box.start();
  // 基线取自占用收尾后：归档/恢复自身不得改变业务行与源仓库文件。
  terminal(box);
  const before = businessSnapshot(box);
  const files = fileSnapshot(box.box.repoDirA);
  const revisionBefore = projectRow(box).revision;

  // 重新激活占用：归档进入等待后再次收尾，覆盖 enter→settle 全程。
  box.session.transactWrite('fixture.reactivate', () => {
    box!.session.database.prepare('UPDATE runs SET status = ?').run('queued');
    box!.session.database.prepare('UPDATE execution_batches SET status = ?').run('queued');
  });

  // 预算耗尽：不伪造 archived；回执如实记录 settled=false + 阻塞计数；状态/事件已原子提交。
  const envelope = archiveEnvelope(box);
  const pending = await svc.commands.submit(box.owner, envelope);
  expect(pending).toMatchObject({
    status: 'completed',
    result: { status: 'archiving', settled: false, blockers: { activeRuns: 1 } },
  });
  expect(projectRow(box)).toMatchObject({ status: 'archiving', revision: revisionBefore + 1 });
  expect(lifecycleEvents(box)).toHaveLength(1);
  expect(JSON.parse(lifecycleEvents(box)[0]!.payload)).toEqual({ from: 'active', to: 'archiving' });

  // 同 commandId 同参数返回原结果；不同参数冲突。
  expect(await svc.commands.submit(box.owner, envelope)).toEqual({ ...pending, replayed: true });
  await expect(svc.commands.submit(box.owner, { ...envelope, expectedRevision: projectRow(box).revision }))
    .rejects.toMatchObject({ code: 'conflict', details: { reason: 'idempotency_key_reuse' } });

  // 已开始的执行沿既有路径收尾后，新归档命令完成 archiving→archived。
  terminal(box);
  const settled = await svc.commands.submit(box.owner, archiveEnvelope(box));
  expect(settled).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
  expect(projectRow(box)).toMatchObject({ status: 'archived' });
  expect(lifecycleEvents(box).map(event => JSON.parse(event.payload))).toEqual([
    { from: 'active', to: 'archiving' }, { from: 'archiving', to: 'archived' },
  ]);
  // 归档只改管理状态：业务行与源仓库文件原样保留。
  expect(businessSnapshot(box)).toEqual(before);
  expect(fileSnapshot(box.box.repoDirA)).toEqual(files);

  // 显式恢复：archived→active；revision 重核；不触碰执行/预算/任务事实。
  const cancelledRuns = box.session.database.prepare("SELECT status FROM runs").all();
  const restoreCommand = restoreEnvelope(box);
  const restore = await svc.commands.submit(box.owner, restoreCommand);
  expect(restore).toMatchObject({ status: 'completed', result: { status: 'active' } });
  expect(projectRow(box)).toMatchObject({ status: 'active' });
  expect(box.session.database.prepare('SELECT status FROM runs').all()).toEqual(cancelledRuns);
  expect(businessSnapshot(box)).toEqual(before);
  expect(await svc.commands.submit(box.owner, restoreCommand)).toEqual({ ...restore, replayed: true });
  // 非 archived 状态恢复稳定拒绝（invalid_project_transition）。
  expect(await svc.commands.submit(box.owner, restoreEnvelope(box)))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'invalid_project_transition' } } });
  expect(projectRow(box)).toMatchObject({ status: 'active' });
});

it('[case:archive-immediate-settle] 无活动占用时归档在同一命令内收口并幂等重复归档', async () => {
  box = await openBudgetFixture();
  const svc = archiveServices(box.session);
  const receipt = await svc.commands.submit(box.owner, archiveEnvelope(box));
  expect(receipt).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
  expect(projectRow(box)).toMatchObject({ status: 'archived' });
  expect(await svc.commands.submit(box.owner, archiveEnvelope(box)))
    .toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
  expect(lifecycleEvents(box).map(event => JSON.parse(event.payload))).toEqual([
    { from: 'active', to: 'archiving' }, { from: 'archiving', to: 'archived' },
  ]);
});

it('[case:archive-blocks-new-execution] archiving 即刻阻止新 Batch/Run 且零执行写入', async () => {
  box = await openBudgetFixture();
  const svc = archiveServices(box.session);
  await box.start();
  const pending = await svc.commands.submit(box.owner, archiveEnvelope(box));
  expect(pending).toMatchObject({ status: 'completed', result: { status: 'archiving', settled: false } });
  expect(projectRow(box)).toMatchObject({ status: 'archiving' });
  expect(await svc.commands.submit(box.owner, box.startEnvelope()))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'preview_stale' } } });
  expect(box.session.database.prepare('SELECT COUNT(*) AS n FROM execution_batches').get()).toMatchObject({ n: 1 });
  expect(box.session.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 1 });
});

it('[case:archive-task-claim-gate] archiving 拒绝新 Attempt 认领，既有认领回执可重放', async () => {
  const f = await openClaimFixture([[], []]);
  box = f.box;
  const first = f.store().claimTask(f.input(0));
  expect(first.replayed).toBe(false);
  const svc = archiveServices(box.session);
  const pending = await svc.commands.submit(box.owner, archiveEnvelope(box));
  expect(pending).toMatchObject({
    status: 'completed',
    result: { status: 'archiving', settled: false, blockers: { activeAttempts: 1, heldWorkspaceLeases: 3 } },
  });
  expect(projectRow(box)).toMatchObject({ status: 'archiving' });
  // 新 Attempt（另一 Task）被同事务项目状态门控拒绝。
  let claimError: unknown;
  try { f.store().claimTask(f.input(1)); } catch (error) { claimError = error; }
  expect(isStorageError(claimError, 'conflict')).toBe(true);
  expect((claimError as { details?: { reason?: string; eligibility?: string } }).details)
    .toMatchObject({ reason: 'not_ready', eligibility: 'project_not_active' });
  // 同 claimKey 同参数重放返回原回执：在途执行不因归档丢失身份。
  const replayed = f.store().claimTask(f.input(0));
  expect(replayed).toMatchObject({ replayed: true, receipt: { attempt: { id: first.receipt.attempt.id } } });
});

it('[case:archive-race-barrier] 收尾等待窗口内执行完成的竞争经屏障收敛为 archived', async () => {
  box = await openBudgetFixture();
  await box.start();
  const gate = deferredSleep();
  const svc = archiveServices(box.session, { closeoutBudgetMs: 60_000, sleep: gate.sleep });
  const settling = svc.commands.submit(box.owner, archiveEnvelope(box));
  await waitFor(() => gate.calls >= 1);
  // 等待窗口内：archiving 已持久可查，活动 Run 仍可从另一连接沿既有路径收尾。
  const peer = openSqliteStorageSession({ path: box.box.dbPath });
  extraSessions.push(peer);
  expect(peer.database.prepare('SELECT status FROM projects WHERE id = ?').get(box.projectId)).toMatchObject({ status: 'archiving' });
  peer.transactWrite('peer.terminal', () => {
    peer.database.prepare('UPDATE runs SET status = ?').run('cancelled');
    peer.database.prepare('UPDATE execution_batches SET status = ?').run('cancelled');
  });
  gate.release();
  const receipt = await settling;
  expect(receipt).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
  expect(projectRow(box)).toMatchObject({ status: 'archived' });
});

it('[case:archive-restart-continuation] Host 重启后同 commandId 凭检查点续核并收敛，原调用拿到同一结果', async () => {
  box = await openBudgetFixture();
  await box.start();
  const gate = deferredSleep();
  const svc = archiveServices(box.session, { closeoutBudgetMs: 60_000, sleep: gate.sleep });
  const envelope = archiveEnvelope(box);
  const interrupted = svc.commands.submit(box.owner, envelope);
  await waitFor(() => gate.calls >= 1);

  // 模拟重启：新连接、新命令面；先收尾占用，再以同 commandId 同参数续核。
  const peer = openSqliteStorageSession({ path: box.box.dbPath });
  extraSessions.push(peer);
  peer.transactWrite('peer.terminal', () => {
    peer.database.prepare('UPDATE runs SET status = ?').run('cancelled');
    peer.database.prepare('UPDATE execution_batches SET status = ?').run('cancelled');
  });
  const peerServices = archiveServices(peer);
  const continued = await peerServices.commands.submit(box.owner, envelope);
  expect(continued).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
  expect(peer.database.prepare('SELECT status FROM projects WHERE id = ?').get(box.projectId)).toMatchObject({ status: 'archived' });

  // 原调用恢复等待后取回同一回执（同 commandId 幂等收敛，不产生第二结果）。
  gate.release();
  expect(await interrupted).toEqual({ ...continued, replayed: true });
  // 重启后不同参数复用同 commandId 仍冲突。
  await expect(peerServices.commands.submit(box.owner, { ...envelope, expectedRevision: 999 }))
    .rejects.toMatchObject({ code: 'conflict' });
});

it('[case:project-list-archived-filter] 默认列表隐藏 archived，显式状态筛选与直接读取仍可查询', async () => {
  box = await openBudgetFixture();
  const svc = archiveServices(box.session);
  const registered = await box.submit('project.register', {
    repositoryPath: box.box.repoDirB, displayName: 'To archive', description: null, labels: ['kept', 'history'],
  }, { scope: { kind: 'registration' } });
  const archivedId = (registered as { result: { project: { id: string } } }).result.project.id;
  const db = box.session.database;
  const otherRevision = () => (db.prepare('SELECT revision FROM projects WHERE id = ?').get(archivedId) as { revision: number }).revision;
  const archiveOther = () => box!.envelope('project.archive', { projectId: archivedId }, {
    scope: { kind: 'project', projectId: archivedId }, expectedRevision: otherRevision(),
  });
  expect(await svc.commands.submit(box.owner, archiveOther())).toMatchObject({ status: 'completed' });
  // 目标项目本身没有执行；主项目保持 active。
  const store = createSqliteStateStore(box.session);

  const visible = await store.listProjects();
  expect(visible.records.map(record => record.id)).not.toContain(archivedId);
  expect(visible.records.map(record => record.id)).toContain(box.projectId);

  const all = await store.listProjects({ status: 'all' });
  expect(all.records.map(record => record.id).sort()).toEqual([archivedId, box.projectId].sort());

  const archivedOnly = await store.listProjects({ status: 'archived' });
  expect(archivedOnly.records.map(record => record.id)).toEqual([archivedId]);

  const activeOnly = await store.listProjects({ status: 'active' });
  expect(activeOnly.records.map(record => record.id)).toEqual([box.projectId]);

  // 直接读取保持可查询（归档项可检查/可恢复）。
  expect((await store.getProject(archivedId)).status).toBe('archived');
  // 标签计数与默认列表同一可见性；非法状态值在 SQL 前拒绝。
  expect(await store.countProjectLabels()).toEqual([]);
  await expect(store.listProjects({ status: 'bogus' })).rejects.toMatchObject({ kind: 'validation' });

  // 恢复后回到默认列表。
  const restore = await svc.commands.submit(box.owner, box.envelope('project.restore', { projectId: archivedId }, {
    scope: { kind: 'project', projectId: archivedId }, expectedRevision: otherRevision(),
  }));
  expect(restore).toMatchObject({ status: 'completed', result: { status: 'active' } });
  const afterRestore = await store.listProjects();
  expect(afterRestore.records.map(record => record.id).sort()).toEqual([archivedId, box.projectId].sort());
  expect(await store.countProjectLabels()).toEqual([{ label: 'history', projectCount: 1 }, { label: 'kept', projectCount: 1 }]);
});

it('[case:archive-revision-and-ownership] 过期 revision、越权主体与 scope 不匹配稳定拒绝且零状态写入', async () => {
  box = await openBudgetFixture();
  const svc = archiveServices(box.session);
  const before = projectRow(box);

  expect(await svc.commands.submit(box.owner, archiveEnvelope(box, { expectedRevision: before.revision + 5 })))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'stale_revision', expectedRevision: before.revision + 5 } } });
  expect(projectRow(box)).toEqual(before);

  // 不可见主体统一 forbidden，不泄漏存在性。
  const outsider = createRestrictedPrincipal({
    capabilities: ['project.lifecycle.write'],
    projectScope: { kind: 'allowlist', projectIds: [randomUUID()] },
  });
  await expect(svc.commands.submit(outsider, archiveEnvelope(box))).rejects.toMatchObject({ code: 'forbidden' });
  expect(projectRow(box)).toEqual(before);

  // payload.projectId 与 scope 不匹配在信封层拒绝。
  await expect(svc.commands.submit(box.owner, box.envelope('project.archive', { projectId: randomUUID() }, {
    scope: box.scope, expectedRevision: before.revision,
  }))).rejects.toMatchObject({ code: 'invalid_input' });
  expect(projectRow(box)).toEqual(before);

  // 恢复同样受 revision CAS 约束。
  expect(await svc.commands.submit(box.owner, archiveEnvelope(box))).toMatchObject({ status: 'completed' });
  expect(await svc.commands.submit(box.owner, restoreEnvelope(box, { expectedRevision: 1 })))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'stale_revision' } } });
  expect(projectRow(box)).toMatchObject({ status: 'archived' });
});

it('[case:archive-maintenance-gate] 维护占用阻止归档/恢复写入，释放后继续', async () => {
  box = await openBudgetFixture();
  const { createMaintenanceWriteGate } = await import('../../../packages/core/src/ports/data-maintenance.ts');
  const gate = createMaintenanceWriteGate();
  const nowUtcMs = () => NOW;
  const atomic = createSqliteAtomicCommandStore(box.session, { nowUtcMs });
  const closeouts = createSqliteProjectLifecycleAccess(box.session);
  const projectLifecycle = createProjectLifecycleCommandHandler({
    atomicStore: atomic, readCloseout: closeouts.readProjectArchiveCloseout, nowUtcMs,
    maintenanceGate: gate, closeoutBudgetMs: 0,
  });
  const commands = createCommandService({
    atomicStore: atomic, maintenanceGate: gate,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
    projectLifecycle, nowUtcMs,
  });
  const lease = gate.acquire({
    operation: 'backup', operationId: 'backup-1', owner: 'owner-1', hostInstanceId: 'host-1', nowUtcMs: NOW,
  });
  await expect(commands.submit(box.owner, archiveEnvelope(box))).rejects.toMatchObject({ code: 'resource_busy' });
  expect(projectRow(box)).toMatchObject({ status: 'active' });
  gate.release({ ...lease, confirmed: true });
  expect(await commands.submit(box.owner, archiveEnvelope(box))).toMatchObject({ status: 'completed' });
  expect(projectRow(box)).toMatchObject({ status: 'archived' });
});

it('[case:archive-store-closeout-facts] 收尾快照按项目聚合各占用类别且不越项目', async () => {
  box = await openBudgetFixture();
  const access = createSqliteProjectLifecycleAccess(box.session);
  const registered = await box.submit('project.register', {
    repositoryPath: box.box.repoDirB, displayName: 'Other', description: null, labels: [],
  }, { scope: { kind: 'registration' } });
  const otherId = (registered as { result: { project: { id: string } } }).result.project.id;
  const ids = await box.start();
  const db = box.session.database;
  db.prepare(`INSERT INTO execution_stop_operations (id, created_at, project_id, updated_at, command_id,
    target_kind, target_id, batch_id, run_id, reason, status, requested_at)
    VALUES ('stop-1', ?, ?, ?, 'stop-command', 'run', ?, ?, ?, 'user_cancel', 'stopping', ?)`)
    .run(NOW, box.projectId, NOW, ids.runId, ids.batchId, ids.runId, NOW);
  db.prepare(`INSERT INTO baseline_operations (id, created_at, project_id, updated_at, revision, kind, status)
    VALUES ('baseline-1', ?, ?, ?, 1, 'verify', 'running')`).run(NOW, otherId, NOW);
  terminal(box);
  const closeout = access.readProjectArchiveCloseout(box.projectId);
  expect(closeout).toMatchObject({
    projectId: box.projectId, status: 'active', clear: false,
    blockers: { activeBatches: 0, activeRuns: 0, activeAttempts: 0, heldWorkspaceLeases: 0,
      heldDispatchClaims: 0, heldSlotClaims: 0, unconfirmedStops: 1, activeBaselineOperations: 0 },
  });
  expect(access.readProjectArchiveCloseout(otherId).blockers).toMatchObject({ unconfirmedStops: 0, activeBaselineOperations: 1 });
  db.prepare("UPDATE execution_stop_operations SET status = 'stopped', stop_confirmed = 1, settled_at = ?").run(NOW);
  db.prepare("UPDATE baseline_operations SET status = 'completed', ended_at = ?").run(NOW);
  expect(access.readProjectArchiveCloseout(box.projectId).clear).toBe(true);
  expect(access.readProjectArchiveCloseout(otherId).clear).toBe(true);
  // 未知项目按 not_found 拒绝，不产生可猜测的空快照。
  expect(() => access.readProjectArchiveCloseout(randomUUID())).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  // 状态原语仍可在事务内直接驱动完整生命周期（F-001 迁移表单一权威）。
  const state = createSqliteStateAccess(box.session);
  const revision = projectRow(box).revision;
  box.session.transactWrite('fixture.lifecycle', () => {
    state.transitionProjectStatusInTransaction({ operation: 'archive', projectId: box!.projectId, expectedRevision: revision });
    state.transitionProjectStatusInTransaction({ operation: 'archiveComplete', projectId: box!.projectId, expectedRevision: revision + 1 });
    state.transitionProjectStatusInTransaction({ operation: 'restore', projectId: box!.projectId, expectedRevision: revision + 2 });
  });
  expect(projectRow(box)).toMatchObject({ status: 'active', revision: revision + 3 });
});
