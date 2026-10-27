import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';
import { ACTIVE_EXECUTION_STATUSES } from '../../../packages/core/src/ports/execution-preview.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { budgetServices, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

let box: BudgetFixture | undefined;
afterEach(() => { box?.close(); box = undefined; });

function feature(b: BudgetFixture) {
  return b.session.database.prepare('SELECT * FROM features WHERE id = ?').get(b.featureId) as {
    id: string; revision: number; phase_id: string; plan_digest: string; plan_status: string;
  };
}
function phaseRevision(b: BudgetFixture, id: string) {
  return (b.session.database.prepare('SELECT revision FROM phases WHERE id = ?').get(id) as { revision: number }).revision;
}
function move(b: BudgetFixture, payload = {}, extra = {}) {
  return b.envelope('feature.phase.move', {
    featureId: b.featureId, sourcePhaseId: 'phase-1', targetPhaseId: 'target',
    sourcePhaseRevision: phaseRevision(b, 'phase-1'), targetPhaseRevision: phaseRevision(b, 'target'),
    ...payload,
  }, { scope: b.scope, expectedRevision: feature(b).revision, ...extra });
}
async function setup() {
  const b = await openBudgetFixture();
  box = b;
  expect(await b.submit('phase.create', { id: 'target', title: 'Target' }, { scope: b.scope }))
    .toMatchObject({ status: 'completed' });
  return b;
}

function snapshot(b: BudgetFixture, includeReceipts = false) {
  const tables = b.session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.filter(t => includeReceipts || t.name !== 'command_receipts')
    .map(t => [t.name, b.session.database.prepare(`SELECT * FROM "${t.name}"`).all()]));
}
async function importDraft(b: BudgetFixture, title = 'Draft', phaseId = 'phase-1') {
  const receipt = await b.submit('feature.plan.import', { phaseId,
    plan: { schemaVersion: 1, feature: { title }, tasks: [] },
  }, { scope: b.scope, expectedRevision: phaseRevision(b, phaseId) });
  expect(receipt.status).toBe('completed');
  return (receipt as { result: { feature: { id: string } } }).result.feature.id;
}
function edge(b: BudgetFixture, id: string, from: string, to: string) {
  b.session.database.prepare(`INSERT INTO feature_dependencies
    (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id)
    VALUES (?, ?, ?, 1, ?, 'phase-1', ?, ?)`).run(id, NOW, b.projectId, NOW, from, to);
}
function terminal(b: BudgetFixture) {
  b.session.transactWrite('fixture.terminal', () => {
    b.session.database.prepare("UPDATE runs SET status = 'cancelled'").run();
    b.session.database.prepare("UPDATE execution_batches SET status = 'cancelled'").run();
  });
}

it('原子调整归属与三份 revision，保留已批准计划和 Task 事实', async () => {
  const b = await setup();
  const before = feature(b);
  const tasks = b.session.database.prepare('SELECT * FROM tasks ORDER BY id').all();
  const approvals = b.session.database.prepare('SELECT * FROM approvals ORDER BY id').all();
  const sourceRevision = phaseRevision(b, 'phase-1');
  const targetRevision = phaseRevision(b, 'target');
  const receipt = await b.services.commands.submit(b.owner, move(b));
  expect(receipt).toMatchObject({ status: 'completed', result: { feature: {
    id: b.featureId, phaseId: 'target', revision: before.revision + 1,
    planDigest: before.plan_digest, planStatus: 'approved',
  } } });
  expect(phaseRevision(b, 'phase-1')).toBe(sourceRevision + 1);
  expect(phaseRevision(b, 'target')).toBe(targetRevision + 1);
  expect(b.session.database.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(tasks);
  expect(b.session.database.prepare('SELECT * FROM approvals ORDER BY id').all()).toEqual(approvals);
  b.reopen();
  expect(feature(b).phase_id).toBe('target');
});

it('重复请求重放且不重复递增或记事件；同 commandId 不同内容冲突', async () => {
  const b = await setup();
  const envelope = move(b);
  const receipt = await b.services.commands.submit(b.owner, envelope);
  const before = snapshot(b, true);
  expect(await b.services.commands.submit(b.owner, envelope)).toEqual({ ...receipt, replayed: true });
  await expect(b.services.commands.submit(b.owner, { ...envelope, payload: { ...envelope.payload as object,
    targetPhaseRevision: 99 } })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'idempotency_key_reuse' } });
  expect(snapshot(b, true)).toEqual(before);
  const row = b.session.database.prepare("SELECT * FROM state_events WHERE event_type = 'feature.phase.moved'").get() as Record<string, unknown>;
  const persisted = { id: row.id, sequence: row.sequence, eventType: row.event_type,
    aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateRevision: row.aggregate_revision,
    projectId: row.project_id, payload: JSON.parse(String(row.payload)), occurredAtUtcMs: row.occurred_at };
  expect(mapStateEvent(persisted as never)).toMatchObject({ type: 'feature.phase.moved',
    aggregate: { type: 'feature', id: b.featureId }, payload: { phaseMoved: true } });
  for (const payload of [{ phaseMoved: false }, { phaseMoved: true, approved: true }]) {
    expect(() => mapStateEvent({ ...persisted, payload } as never)).toThrow(expect.objectContaining({ code: 'corrupt_state' }));
  }
});

it.each(['feature', 'source', 'target'])('%s revision 过期拒绝并持久重放拒绝，业务和事件不变', async entity => {
  const b = await setup();
  const envelope = move(b, entity === 'source' ? { sourcePhaseRevision: 99 }
    : entity === 'target' ? { targetPhaseRevision: 99 } : {}, entity === 'feature' ? { expectedRevision: 99 } : {});
  const before = snapshot(b);
  const receipt = await b.services.commands.submit(b.owner, envelope);
  expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'conflict' } } });
  expect(await b.services.commands.submit(b.owner, envelope)).toEqual({ ...receipt, replayed: true });
  expect(snapshot(b)).toEqual(before);
});

it.each(['source', 'target'])('%s Phase 关闭和归档均阻止归属调整', async side => {
  const b = await setup();
  for (const status of ['closed', 'archived']) {
    b.session.database.prepare('UPDATE phases SET status = ? WHERE id = ?').run(status, side === 'source' ? 'phase-1' : 'target');
    const before = snapshot(b);
    expect(await b.services.commands.submit(b.owner, move(b)))
      .toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_not_open' } } });
    expect(snapshot(b)).toEqual(before);
  }
});

it('缺失引用、跨项目归属、权限与非法 payload 均拒绝且全库不变', async () => {
  const b = await setup();
  const registered = await b.submit('project.register', { repositoryPath: b.box.repoDirB, displayName: 'Other' }, { scope: { kind: 'registration' } });
  const otherId = (registered as { result: { project: { id: string } } }).result.project.id;
  expect(await b.submit('phase.create', { id: 'other', title: 'Other' }, { scope: { kind: 'project', projectId: otherId } }))
    .toMatchObject({ status: 'completed' });
  const before = snapshot(b, true);
  for (const [payload, code] of [
    [{ featureId: 'missing' }, 'not_found'], [{ sourcePhaseId: 'missing' }, 'not_found'],
    [{ targetPhaseId: 'missing' }, 'not_found'], [{ targetPhaseId: 'other' }, 'forbidden'],
    [{ sourcePhaseId: 'other' }, 'forbidden'],
    [{ targetPhaseRevision: 0 }, 'invalid_input'], [{ sourcePhaseRevision: '1' }, 'invalid_input'],
    [{ targetPhaseRevision: null }, 'invalid_input'], [{ featureId: '' }, 'invalid_input'],
    [{ planStatus: 'approved' }, 'invalid_input'], [{ sourcePhaseId: undefined }, 'invalid_input'],
  ] as const) {
    await expect(b.services.commands.submit(b.owner, move(b, payload))).rejects.toMatchObject({ code });
    expect(snapshot(b, true)).toEqual(before);
  }
  await expect(b.services.commands.submit(b.owner, move(b, {}, { scope: { kind: 'project', projectId: otherId } })))
    .rejects.toMatchObject({ code: 'forbidden' });
  const reader = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
  await expect(b.services.commands.submit(reader, move(b))).rejects.toMatchObject({ code: 'forbidden' });
  expect(snapshot(b, true)).toEqual(before);
});

it('源 Phase 不匹配、同阶段及存在任一方向依赖边的单成员移动明确拒绝', async () => {
  const b = await setup();
  for (const [payload, reason] of [
    [{ sourcePhaseId: 'target' }, 'source_phase_mismatch'],
    [{ targetPhaseId: 'phase-1' }, 'same_phase'],
  ] as const) {
    const before = snapshot(b);
    expect(await b.services.commands.submit(b.owner, move(b, payload)))
      .toMatchObject({ status: 'rejected', error: { details: { reason } } });
    expect(snapshot(b)).toEqual(before);
  }
  const peerId = await importDraft(b);
  for (const [from, to] of [[b.featureId, peerId], [peerId, b.featureId]]) {
    edge(b, 'edge', from!, to!);
    const before = snapshot(b);
    expect(await b.services.commands.submit(b.owner, move(b)))
      .toMatchObject({ status: 'rejected', error: { details: { reason: 'feature_has_dependencies' } } });
    expect(snapshot(b)).toEqual(before);
    b.session.database.prepare("DELETE FROM feature_dependencies WHERE id = 'edge'").run();
  }
});

it.each(ACTIVE_EXECUTION_STATUSES)('活动 Batch %s 保护固定成员及传递前置，范围外草稿可追加和移动', async status => {
  const b = await setup();
  await b.start();
  b.session.database.prepare('UPDATE execution_batches SET status = ?').run(status);
  const middle = await importDraft(b, 'Middle');
  const prerequisite = await importDraft(b, 'Prerequisite');
  const outsider = await importDraft(b, 'Outside');
  edge(b, 'edge-1', b.featureId, middle);
  edge(b, 'edge-2', middle, prerequisite);
  // New outside member may depend on active work; it does not become part of the Batch.
  const dependent = await importDraft(b, 'Dependent');
  edge(b, 'edge-3', dependent, b.featureId);
  for (const featureId of [b.featureId, middle, prerequisite]) {
    const revision = (b.session.database.prepare('SELECT revision FROM features WHERE id = ?').get(featureId) as { revision: number }).revision;
    const before = snapshot(b);
    expect(await b.services.commands.submit(b.owner, move(b, { featureId }, { expectedRevision: revision })))
      .toMatchObject({ status: 'rejected', error: { details: { reason: 'active_batch_scope' } } });
    expect(snapshot(b)).toEqual(before);
  }
  const beforeBatch = b.snapshot();
  expect(await b.services.commands.submit(b.owner, move(b, { featureId: outsider }, { expectedRevision: 1 })))
    .toMatchObject({ status: 'completed' });
  expect(b.snapshot().execution_batches).toEqual(beforeBatch.execution_batches);
  expect(b.snapshot().runs).toEqual(beforeBatch.runs);
});

it('终态 Batch 下的活动 Run 与未确认停止仍阻止移动；历史绑定拒绝且不改预算/历史', async () => {
  const b = await setup();
  const ids = await b.start();
  b.session.database.prepare("UPDATE execution_batches SET status = 'cancelled'").run();
  const beforeActive = snapshot(b);
  expect(await b.services.commands.submit(b.owner, move(b)))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'active_execution_inputs' } } });
  expect(snapshot(b)).toEqual(beforeActive);
  terminal(b);
  b.session.database.prepare(`INSERT INTO execution_stop_operations (id, created_at, project_id, updated_at,
    command_id, target_kind, target_id, batch_id, run_id, reason, status, requested_at)
    VALUES ('stop', ?, ?, ?, 'stop-command', 'run', ?, ?, ?, 'user_cancel', 'uncertain', ?)`)
    .run(NOW, b.projectId, NOW, ids.runId, ids.batchId, ids.runId, NOW);
  const beforeStop = snapshot(b);
  expect(await b.services.commands.submit(b.owner, move(b)))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'active_execution_inputs' } } });
  expect(snapshot(b)).toEqual(beforeStop);
  b.session.database.prepare("UPDATE execution_stop_operations SET status = 'stopped', stop_confirmed = 1, settled_at = ?").run(NOW);
  const before = snapshot(b);
  expect(await b.services.commands.submit(b.owner, move(b)))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'feature_batch_scope_bound' } } });
  expect(snapshot(b)).toEqual(before);
});

it.each(['attempt', 'lease', 'claim', 'slot'])('终态 Run 下 %s 占用仍拒绝移动且不释放资源', async resource => {
  const f = await openClaimFixture();
  const b = f.box;
  box = b;
  expect(await b.submit('phase.create', { id: 'target', title: 'Target' }, { scope: b.scope })).toMatchObject({ status: 'completed' });
  const result = f.store().claimTask(f.input());
  terminal(b);
  const db = b.session.database;
  if (resource !== 'attempt') {
    db.prepare("UPDATE attempts SET status = 'interrupted' WHERE id = ?").run(result.receipt.attempt.id);
  }
  if (resource === 'lease') {
    db.prepare("UPDATE workspace_leases SET state = 'quarantined', lease_until = 0").run();
  } else {
    db.prepare('DELETE FROM workspace_leases').run();
  }
  // Slot quarantine retains its dispatch claim; release must follow the existing slot-first protocol.
  if (resource === 'slot') {
    db.prepare("UPDATE execution_slot_claims SET state = 'quarantined', reason = 'uncertain_stop'").run();
  } else {
    db.prepare("UPDATE execution_slot_claims SET state = 'released', released_at = ?").run(NOW);
  }
  if (resource === 'claim') {
    db.prepare("UPDATE run_dispatch_claims SET state = 'quarantined', settled_at = ?, reason = 'uncertain_stop'").run(NOW);
  } else if (resource !== 'slot') {
    db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ?").run(NOW);
  }
  const before = snapshot(b);
  expect(await b.services.commands.submit(b.owner, move(b)))
    .toMatchObject({ status: 'rejected', error: { details: { reason: 'active_execution_inputs' } } });
  expect(snapshot(b)).toEqual(before);
});

it('归属调整后实质计划修订仍按 planDigest 使旧批准失效，保留旧批准记录', async () => {
  const b = await setup();
  const approvals = b.session.database.prepare('SELECT * FROM approvals ORDER BY id').all();
  const oldDigest = feature(b).plan_digest;
  expect(await b.services.commands.submit(b.owner, move(b))).toMatchObject({ status: 'completed' });
  expect(await b.submit('feature.plan.revise', { featureId: b.featureId, plan: {
    schemaVersion: 1, feature: { title: 'Substantive new plan' },
    tasks: [{ id: 't-1', title: 'Task', acceptance: { criteria: ['budget consistency'] }, dependsOn: [] }],
  } }, { scope: b.scope, expectedRevision: feature(b).revision })).toMatchObject({ status: 'completed' });
  expect(feature(b).plan_digest).not.toBe(oldDigest);
  expect(feature(b).plan_status).toBe('draft');
  expect(b.session.database.prepare('SELECT * FROM approvals ORDER BY id').all()).toEqual(approvals);
});

it.each(['feature', 'source', 'target', 'event', 'receipt'])('%s 写入故障整组回滚，相同命令可安全重试', async point => {
  const b = await setup();
  const db = b.session.database;
  const envelope = move(b);
  const before = snapshot(b, true);
  const table = point === 'feature' ? 'features' : point === 'event' ? 'state_events'
    : point === 'receipt' ? 'command_receipts' : 'phases';
  const condition = point === 'source' ? "WHEN OLD.id = 'phase-1'" : point === 'target' ? "WHEN OLD.id = 'target'" : '';
  db.exec(`CREATE TEMP TRIGGER move_fault BEFORE ${point === 'event' || point === 'receipt' ? 'INSERT' : 'UPDATE'}
    ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'injected affiliation fault'); END`);
  await expect(b.services.commands.submit(b.owner, envelope)).rejects.toMatchObject({ code: 'internal' });
  expect(snapshot(b, true)).toEqual(before);
  db.exec('DROP TRIGGER move_fault');
  expect(await b.services.commands.submit(b.owner, envelope)).toMatchObject({ status: 'completed', replayed: false });
});

it('跨连接同 revision 只有一次归属调整；移动后旧预览不能开始执行', async () => {
  const b = await setup();
  const peer = openSqliteStorageSession({ path: b.box.dbPath });
  try {
    const envelope = move(b);
    const receipts = await Promise.all([
      b.services.commands.submit(b.owner, envelope),
      budgetServices(peer).commands.submit(b.owner, { ...envelope, commandId: randomUUID() }),
    ]);
    expect(receipts.map(r => r.status).sort()).toEqual(['completed', 'rejected']);
    expect(b.session.database.prepare("SELECT * FROM state_events WHERE event_type = 'feature.phase.moved'").all()).toHaveLength(1);
    expect(await b.services.commands.submit(b.owner, b.startEnvelope())).toMatchObject({ status: 'rejected' });
    expect(b.snapshot().execution_batches).toEqual([]);
  } finally { peer.close(); }
});

it('Batch 启动先赢事务时移动拒绝；范围外导入保留固定 Batch，非 open Phase 新增被拒', async () => {
  const b = await setup();
  const envelope = move(b);
  await b.start();
  const batch = b.snapshot().execution_batches;
  expect(await b.services.commands.submit(b.owner, envelope)).toMatchObject({ status: 'rejected', error: { details: { reason: 'active_batch_scope' } } });
  await importDraft(b, 'Appended');
  expect(b.snapshot().execution_batches).toEqual(batch);
  for (const status of ['closed', 'archived']) {
    b.session.database.prepare('UPDATE phases SET status = ? WHERE id = ?').run(status, 'target');
    const before = snapshot(b);
    expect(await b.submit('feature.plan.import', { phaseId: 'target',
      plan: { schemaVersion: 1, feature: { title: 'Forbidden' }, tasks: [] },
    }, { scope: b.scope, expectedRevision: phaseRevision(b, 'target') }))
      .toMatchObject({ status: 'rejected', error: { details: { reason: 'phase_not_open' } } });
    expect(() => b.session.transactWrite('fixture.insert', () => createSqlitePlanAccess(b.session).insertFeatureInTransaction({
      projectId: b.projectId, phaseId: 'target', title: 'Bypass',
    }))).toThrow(expect.objectContaining({ kind: 'conflict', details: { reason: 'phase_not_open' } }));
    expect(snapshot(b)).toEqual(before);
  }
});
