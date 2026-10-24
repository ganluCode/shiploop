import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';
import { ACTIVE_EXECUTION_STATUSES } from '../../../packages/core/src/ports/execution-preview.ts';
import { budgetServices, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { acquireInput, openSlotFixture, slotIdentity } from '../../helpers/p04-9/slot-fixture.ts';

let box: BudgetFixture | undefined;
afterEach(() => { box?.close(); box = undefined; });

function phase(b: BudgetFixture) {
  return b.session.database.prepare('SELECT * FROM phases WHERE id = ?').get('phase-1') as {
    revision: number; status: string; title: string; description: string | null; labels: string;
  };
}
function command(b: BudgetFixture, operation: string, payload = {}, extra = {}) {
  return b.envelope(operation, { phaseId: 'phase-1', ...payload }, {
    scope: b.scope, expectedRevision: phase(b).revision, ...extra,
  });
}
function businessSnapshot(b: BudgetFixture) {
  return Object.fromEntries(['phases', 'features', 'tasks', 'feature_dependencies', 'task_dependencies',
    'execution_batches', 'runs', 'attempts', 'workspace_leases', 'run_dispatch_claims',
    'execution_slot_claims', 'execution_stop_operations', 'state_events'].map(table =>
    [table, b.session.database.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'state_events' ? 'sequence' : 'id'}`).all()]));
}
function terminal(b: BudgetFixture) {
  b.session.transactWrite('fixture.terminal', () => {
    b.session.database.prepare("UPDATE runs SET status = 'cancelled'").run();
    b.session.database.prepare("UPDATE execution_batches SET status = 'cancelled'").run();
  });
}
async function submit(b: BudgetFixture, operation: string, payload = {}, extra = {}) {
  return b.services.commands.submit(b.owner, command(b, operation, payload, extra));
}

it('以 Phase revision 更新元数据并原子记录回执与脱敏事件', async () => {
  box = await openBudgetFixture();
  const before = phase(box);
  const envelope = command(box, 'phase.metadata.update', {
    title: '新的阶段', description: '新说明', labels: [' Core ', 'core'],
  });
  const receipt = await box.services.commands.submit(box.owner, envelope);
  expect(receipt).toMatchObject({ status: 'completed', result: { phase: {
    id: 'phase-1', title: '新的阶段', description: '新说明', labels: ['core'],
    status: 'open', revision: before.revision + 1,
  } } });
  expect(phase(box)).toMatchObject({ title: '新的阶段', description: '新说明', labels: '["core"]', revision: before.revision + 1 });
  expect(box.session.database.prepare('SELECT event_type, payload FROM state_events ORDER BY sequence DESC LIMIT 1').get())
    .toEqual({ event_type: 'phase.metadata.updated', payload: '{"metadataUpdated":true}' });
  const event = box.session.database.prepare('SELECT * FROM state_events ORDER BY sequence DESC LIMIT 1').get() as Record<string, unknown>;
  const mappedRow = { id: event.id, sequence: event.sequence, eventType: event.event_type,
    aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, aggregateRevision: event.aggregate_revision,
    projectId: event.project_id, payload: JSON.parse(String(event.payload)), occurredAtUtcMs: event.occurred_at };
  expect(mapStateEvent(mappedRow as never)).toMatchObject({ type: 'phase.metadata.updated', payload: { metadataUpdated: true } });
  for (const payload of [{ metadataUpdated: false }, { metadataUpdated: true, title: '不允许泄漏' }]) {
    expect(() => mapStateEvent({ ...mappedRow, payload } as never)).toThrow(expect.objectContaining({ code: 'corrupt_state' }));
  }
  const snapshot = businessSnapshot(box);
  expect(await box.services.commands.submit(box.owner, envelope)).toEqual({ ...receipt, replayed: true });
  expect(businessSnapshot(box)).toEqual(snapshot);
  await expect(box.services.commands.submit(box.owner, { ...envelope, payload: { ...envelope.payload as object, title: '不同参数' } }))
    .rejects.toMatchObject({ code: 'conflict', details: { reason: 'idempotency_key_reuse' } });
  expect(businessSnapshot(box)).toEqual(snapshot);
  expect(await submit(box, 'phase.metadata.update', { description: null })).toMatchObject({ status: 'completed' });
  expect(phase(box)).toMatchObject({ title: '新的阶段', description: null, labels: '["core"]' });
});

it('过期 revision、缺少能力、不可见项目、跨项目目标与未知/非法字段拒绝且零业务写入', async () => {
  box = await openBudgetFixture();
  const before = businessSnapshot(box);
  expect(await submit(box, 'phase.metadata.update', { title: '旧写入' }, { expectedRevision: phase(box).revision + 1 }))
    .toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
  expect(businessSnapshot(box)).toEqual(before);
  const reader = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
  const invisible = createRestrictedPrincipal({ capabilities: ['phase.write'], projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } });
  for (const principal of [reader, invisible]) {
    await expect(box.services.commands.submit(principal, command(box, 'phase.close'))).rejects.toMatchObject({ code: 'forbidden' });
  }
  const registered = await box.submit('project.register', { repositoryPath: box.box.repoDirB, displayName: 'Other' }, { scope: { kind: 'registration' } });
  expect(registered.status).toBe('completed');
  const projectId = (registered as { result: { project: { id: string } } }).result.project.id;
  const crossSnapshot = businessSnapshot(box);
  await expect(submit(box, 'phase.metadata.update', { title: '跨项目' }, { scope: { kind: 'project', projectId } }))
    .rejects.toMatchObject({ code: 'forbidden' });
  for (const payload of [{}, { title: '' }, { description: 12 }, { labels: [12] }, { title: '合法', status: 'archived' }, { expectedRevision: 1 }]) {
    await expect(submit(box, 'phase.metadata.update', payload)).rejects.toMatchObject({ code: 'invalid_input' });
  }
  await expect(submit(box, 'phase.close', { approved: true })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(submit(box, 'phase.close', {}, { expectedRevision: null })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(submit(box, 'phase.close', { phaseId: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  expect(businessSnapshot(box)).toEqual(crossSnapshot);
});

it('显式关闭、重开和归档；重复命令重放，非法迁移稳定拒绝，重开库保留所有历史及源仓库', async () => {
  box = await openBudgetFixture();
  const ids = await box.start();
  terminal(box);
  const db = box.session.database;
  const children = businessSnapshot(box);
  const source = readFileSync(join(box.box.repoDirA, 'README.md'), 'utf8');
  expect(await submit(box, 'phase.archive')).toMatchObject({ status: 'rejected', error: { details: { reason: 'invalid_phase_transition' } } });
  for (const [op, status] of [['phase.close', 'closed'], ['phase.reopen', 'open'], ['phase.close', 'closed'], ['phase.archive', 'archived']]) {
    const envelope = command(box, op!);
    const receipt = await box.services.commands.submit(box.owner, envelope);
    expect(receipt).toMatchObject({ status: 'completed', result: { phase: { status } } });
    const snapshot = businessSnapshot(box);
    expect(await box.services.commands.submit(box.owner, envelope)).toEqual({ ...receipt, replayed: true });
    expect(businessSnapshot(box)).toEqual(snapshot);
    await expect(box.services.commands.submit(box.owner, { ...envelope, expectedRevision: phase(box).revision }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'idempotency_key_reuse' } });
    if (status === 'closed') {
      expect(await submit(box, 'phase.close')).toMatchObject({ status: 'rejected', error: { details: { reason: 'invalid_phase_transition' } } });
    }
  }
  const events = db.prepare("SELECT * FROM state_events WHERE event_type IN ('phase.closed','phase.reopened','phase.archived') ORDER BY sequence").all() as Record<string, unknown>[];
  expect(events).toHaveLength(4);
  for (const row of events) {
    const event = mapStateEvent({ id: row.id, sequence: row.sequence, eventType: row.event_type,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateRevision: row.aggregate_revision,
      projectId: row.project_id, payload: JSON.parse(String(row.payload)), occurredAtUtcMs: row.occurred_at } as never);
    expect(event).toMatchObject({ type: row.event_type, aggregate: { type: 'phase', id: 'phase-1' } });
    expect(JSON.stringify(event.payload)).not.toMatch(/passed|approved|completed/);
  }
  box.reopen();
  expect(phase(box).status).toBe('archived');
  for (const op of ['phase.close', 'phase.reopen', 'phase.archive']) {
    expect(await submit(box, op)).toMatchObject({ status: 'rejected', error: { details: { reason: 'invalid_phase_transition' } } });
  }
  const after = businessSnapshot(box);
  for (const table of ['features', 'tasks', 'task_dependencies', 'execution_batches', 'runs', 'attempts']) {
    expect(after[table]).toEqual(children[table]);
  }
  expect((after.state_events as unknown[]).slice(0, (children.state_events as unknown[]).length)).toEqual(children.state_events);
  expect(readFileSync(join(box.box.repoDirA, 'README.md'), 'utf8')).toBe(source);
  expect(box.session.database.prepare('SELECT id FROM runs WHERE id = ?').get(ids.runId)).toEqual({ id: ids.runId });
});

it.each(ACTIVE_EXECUTION_STATUSES)('活动 Batch %s 阻止关闭；元数据编辑不改变固定执行范围', async status => {
  box = await openBudgetFixture();
  await box.start();
  box.session.database.prepare('UPDATE execution_batches SET status = ?').run(status);
  const before = businessSnapshot(box);
  const envelope = command(box, 'phase.close');
  const receipt = await box.services.commands.submit(box.owner, envelope);
  expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'phase_execution_active' } } });
  expect(businessSnapshot(box)).toEqual(before);
  terminal(box);
  // A rejected command is immutable even after the original guard is resolved.
  expect(await box.services.commands.submit(box.owner, envelope)).toEqual({ ...receipt, replayed: true });
  expect(await submit(box, 'phase.close')).toMatchObject({ status: 'completed' });
});

it('终态 Batch 内仍活动的 Run 拒绝关闭；可独立编辑 Phase 元数据', async () => {
  box = await openBudgetFixture();
  await box.start();
  box.session.database.prepare("UPDATE execution_batches SET status = 'cancelled'").run();
  const runs = box.snapshot().runs;
  expect(await submit(box, 'phase.close')).toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_execution_active' } } });
  expect(await submit(box, 'phase.metadata.update', { title: '下一批说明', labels: ['next'] })).toMatchObject({ status: 'completed' });
  expect(box.snapshot().runs).toEqual(runs);
});

it.each(['stopping', 'uncertain', 'stopped'])('停止记录 %s 缺少停止确认阻止关闭和归档', async status => {
  box = await openBudgetFixture();
  const ids = await box.start();
  terminal(box);
  const db = box.session.database;
  db.prepare(`INSERT INTO execution_stop_operations (id, created_at, project_id, updated_at, command_id,
    target_kind, target_id, batch_id, run_id, reason, status, requested_at)
    VALUES ('stop-1', ?, ?, ?, 'stop-command', 'run', ?, ?, ?, 'user_cancel', ?, ?)`)
    .run(NOW, box.projectId, NOW, ids.runId, ids.batchId, ids.runId, status, NOW);
  for (const phaseStatus of ['open', 'closed']) {
    db.prepare('UPDATE phases SET status = ?').run(phaseStatus);
    const before = businessSnapshot(box);
    expect(await submit(box, phaseStatus === 'open' ? 'phase.close' : 'phase.archive'))
      .toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_execution_active' } } });
    expect(businessSnapshot(box)).toEqual(before);
  }
  db.prepare("UPDATE execution_stop_operations SET status = 'stopped', stop_confirmed = 1, settled_at = ?").run(NOW);
  expect(await submit(box, 'phase.archive')).toMatchObject({ status: 'completed' });
});

it('终态 Run 的活动 Attempt 和过期隔离 worktree 租约仍阻止关闭，且不释放占用', async () => {
  const f = await openClaimFixture();
  box = f.box;
  const result = f.store().claimTask(f.input());
  terminal(box);
  const db = box.session.database;
  // Isolate Attempt/workspace guards from the automatically acquired dispatch claim/slot.
  // This fixture never launches a Runtime or a writer process.
  box.session.transactWrite('fixture.release-dispatch', () => {
    db.prepare("UPDATE execution_slot_claims SET state = 'released', released_at = ?").run(NOW);
    db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ?").run(NOW);
  });
  // A live Attempt blocks independently of its leases.
  const leases = db.prepare('SELECT * FROM workspace_leases').all();
  db.prepare('DELETE FROM workspace_leases').run();
  expect(await submit(box, 'phase.close')).toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_execution_active' } } });
  // Restore one expired lease with the original stable identity; terminal Attempt is insufficient.
  const lease = leases[0] as Record<string, unknown>;
  const columns = Object.keys(lease);
  db.prepare(`INSERT INTO workspace_leases (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(lease));
  db.prepare("UPDATE attempts SET status = 'interrupted' WHERE id = ?").run(result.receipt.attempt.id);
  db.prepare("UPDATE workspace_leases SET state = 'quarantined', lease_until = 0").run();
  const before = businessSnapshot(box);
  expect(await submit(box, 'phase.close')).toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_execution_active' } } });
  expect(businessSnapshot(box)).toEqual(before);
  // No process was launched by this fixture. Simulate verified cleanup, then retain the terminal Attempt on archive.
  db.prepare('DELETE FROM workspace_leases').run();
  const attempts = db.prepare('SELECT * FROM attempts ORDER BY id').all();
  expect(await submit(box, 'phase.close')).toMatchObject({ status: 'completed' });
  expect(await submit(box, 'phase.archive')).toMatchObject({ status: 'completed' });
  expect(db.prepare('SELECT * FROM attempts ORDER BY id').all()).toEqual(attempts);
});

it('终态 Run 的派发认领和隔离槽位仍阻止关闭，不影响另一 Phase', async () => {
  const f = await openSlotFixture();
  box = f.box;
  const slot = box.session.transactWrite('fixture.acquire', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
  terminal(box);
  // Slot quarantine retains its claim by storage invariant; neither may be released by Phase commands.
  box.session.transactWrite('fixture.quarantine', () => f.access.quarantineInTransaction(slotIdentity(f, slot), 'uncertain_stop'));
  const before = businessSnapshot(box);
  expect(await submit(box, 'phase.close')).toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_execution_active' } } });
  expect(businessSnapshot(box)).toEqual(before);
  // The peer phase has its own held claim and must also be rejected.
  expect(await submit(box, 'phase.close', { phaseId: 'phase-slot-peer' }, { expectedRevision: 1 }))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_execution_active' } } });
  expect(await box.submit('phase.create', { id: 'idle', title: 'Idle' }, { scope: box.scope })).toMatchObject({ status: 'completed' });
  expect(await submit(box, 'phase.close', { phaseId: 'idle' }, { expectedRevision: 1 })).toMatchObject({ status: 'completed' });
});

it('两个连接以相同 revision 修改只允许一次；关闭后旧预览不能启动 Batch', async () => {
  box = await openBudgetFixture();
  const peer = openSqliteStorageSession({ path: box.box.dbPath });
  try {
    const envelope = command(box, 'phase.close');
    const receipts = await Promise.all([
      box.services.commands.submit(box.owner, envelope),
      budgetServices(peer).commands.submit(box.owner, { ...envelope, commandId: randomUUID() }),
    ]);
    expect(receipts.map(r => r.status).sort()).toEqual(['completed', 'rejected']);
    expect(await box.services.commands.submit(box.owner, box.startEnvelope())).toMatchObject({ status: 'rejected' });
    expect(box.session.database.prepare('SELECT * FROM execution_batches').all()).toEqual([]);
  } finally { peer.close(); }
});

it.each(['phases', 'state_events', 'command_receipts'])('%s 写入失败整组回滚；相同命令可安全重试', async table => {
  box = await openBudgetFixture();
  const db = box.session.database;
  const envelope = command(box, 'phase.close');
  const before = box.snapshot();
  const beforePhase = phase(box);
  db.exec(`CREATE TEMP TRIGGER phase_fault BEFORE ${table === 'phases' ? 'UPDATE' : 'INSERT'} ON ${table}
    BEGIN SELECT RAISE(ABORT, 'injected phase fault'); END`);
  await expect(box.services.commands.submit(box.owner, envelope)).rejects.toMatchObject({ code: 'internal' });
  expect(box.snapshot()).toEqual(before);
  expect(phase(box)).toEqual(beforePhase);
  db.exec('DROP TRIGGER phase_fault');
  expect(await box.services.commands.submit(box.owner, envelope)).toMatchObject({ status: 'completed', replayed: false });
});
