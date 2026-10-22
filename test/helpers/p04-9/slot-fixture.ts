/**
 * P04-9 / F-003 单执行槽位夹具：真实临时 SQLite + 两个已授权 Run。
 *
 * 只做数据准备，不定义产品行为：直接用真实命令路径注册项目/Phase/Feature/Run，
 * 再按迁移 v33 的约束插入 held 的 Run 级派发认领行（认领创建本身属 F-004）。
 * 槽位竞争测试使用同一数据库文件上的独立连接或受控子进程。
 */
import { createSqliteExecutionSlotAccess } from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { BUDGET, NOW, openBudgetFixture } from '../p03-3/budget-fixture.ts';

export const SLOT_NOW = NOW;

export interface SlotRun {
  readonly runId: string;
  readonly featureId: string;
}

export interface SlotFixture {
  readonly box: Awaited<ReturnType<typeof openBudgetFixture>>;
  readonly projectId: string;
  readonly runA: SlotRun;
  readonly runB: SlotRun;
  readonly claimA: string;
  readonly claimB: string;
  readonly access: ReturnType<typeof createSqliteExecutionSlotAccess>;
  now(): number;
  tick(milliseconds: number): void;
  reopen(): void;
  close(): void;
  counts(): Record<string, number>;
  slotRows(): Record<string, unknown>[];
  claimRows(): Record<string, unknown>[];
}

function ticket(id: string, dependsOn: string[] = []) {
  return { id, title: id, acceptance: { criteria: ['slot capacity'] }, dependsOn };
}

export async function openSlotFixture(): Promise<SlotFixture> {
  const box = await openBudgetFixture(BUDGET, [ticket('t-1')]);
  const runA = await box.start();
  const first: SlotRun = { runId: runA.runId, featureId: box.featureId };

  const done = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
    const receipt = await box.submit(operation, payload, extra);
    if (receipt.status !== 'completed') throw new Error(`slot fixture command failed: ${JSON.stringify(receipt)}`);
    return receipt.result;
  };
  const scope = { kind: 'project', projectId: box.projectId };
  await done('phase.create', { id: 'phase-slot-peer', title: 'Slot peer', description: null, labels: [] }, { scope });
  const imported = await done('feature.plan.import', {
    phaseId: 'phase-slot-peer',
    plan: {
      schemaVersion: 1,
      feature: { title: 'Slot peer', description: null, labels: [], sourceRefs: [] },
      tasks: [ticket('t-peer')],
    },
  }, { scope, expectedRevision: 1 }) as { feature: { id: string } };
  const peerFeatureId = imported.feature.id;
  const feature = box.session.database
    .prepare('SELECT revision, plan_digest FROM features WHERE id = ?')
    .get(peerFeatureId) as { revision: number; plan_digest: string };
  await done('feature.plan.decide', {
    featureId: peerFeatureId,
    planDigest: feature.plan_digest,
    decision: 'approve',
    reason: 'slot fixture authorization',
  }, { scope, expectedRevision: feature.revision });
  const preview = await box.services.preview.previewExecution(box.projectId, {
    featureIds: [peerFeatureId],
    budget: BUDGET,
  });
  if (preview.status !== 'ready') throw new Error(`slot fixture preview not ready: ${JSON.stringify(preview)}`);
  const started = await box.submit('execution.start', {
    featureIds: [peerFeatureId],
    budget: BUDGET,
    previewDigest: preview.previewDigest,
  }, { scope });
  if (started.status !== 'accepted' || !('runId' in started)) {
    throw new Error(`slot fixture peer start failed: ${JSON.stringify(started)}`);
  }
  const second: SlotRun = { runId: started.runId, featureId: peerFeatureId };

  const claimA = 'claim-slot-a';
  const claimB = 'claim-slot-b';
  const insertClaim = box.session.database.prepare(
    'INSERT INTO run_dispatch_claims (id, created_at, project_id, updated_at, feature_id, run_id, claim_version, ' +
      "origin, owner_id, host_instance_id, acquired_at, lease_until, state) VALUES (?, ?, ?, ?, ?, ?, 1, 'dispatch', ?, ?, ?, ?, 'held')",
  );
  box.session.transactWrite('fixture.slot-claims', () => {
    insertClaim.run(claimA, SLOT_NOW, box.projectId, SLOT_NOW, first.featureId, first.runId,
      'owner-a', 'host-a', SLOT_NOW, SLOT_NOW + 60_000);
    insertClaim.run(claimB, SLOT_NOW, box.projectId, SLOT_NOW, second.featureId, second.runId,
      'owner-b', 'host-b', SLOT_NOW, SLOT_NOW + 60_000);
  });

  let now = SLOT_NOW;
  let session = box.session;
  let access = createSqliteExecutionSlotAccess(session, { nowUtcMs: () => now });
  const count = (table: string) =>
    (session.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    box,
    projectId: box.projectId,
    runA: first,
    runB: second,
    claimA,
    claimB,
    get access() { return access; },
    now: () => now,
    tick(milliseconds: number) { now += milliseconds; },
    reopen() {
      box.reopen();
      session = box.session;
      access = createSqliteExecutionSlotAccess(session, { nowUtcMs: () => now });
    },
    close() { box.close(); },
    counts() {
      const tables = ['attempts', 'task_attempt_reservations', 'runtime_start_reservations',
        'workspace_leases', 'baseline_occupancy', 'git_operations', 'run_dispatch_intents',
        'execution_slot_claims', 'state_events'];
      return Object.fromEntries(tables.map((table) => [table, count(table)]));
    },
    slotRows() {
      return session.database.prepare('SELECT * FROM execution_slot_claims ORDER BY slot_index, id').all() as Record<string, unknown>[];
    },
    claimRows() {
      return session.database.prepare('SELECT * FROM run_dispatch_claims ORDER BY id').all() as Record<string, unknown>[];
    },
  };
}

/** 获取输入：把夹具 Run/认领身份映射为槽位获取入参。 */
export function acquireInput(f: SlotFixture, which: 'A' | 'B', leaseUntilUtcMs = SLOT_NOW + 10_000) {
  const run = which === 'A' ? f.runA : f.runB;
  return {
    projectId: f.projectId,
    featureId: run.featureId,
    runId: run.runId,
    claimId: which === 'A' ? f.claimA : f.claimB,
    claimVersion: 1,
    ownerId: which === 'A' ? 'owner-a' : 'owner-b',
    hostInstanceId: which === 'A' ? 'host-a' : 'host-b',
    leaseUntilUtcMs,
  };
}

/** 由已取得（或读取）的槽位构造完整操作身份。 */
export function slotIdentity(
  f: SlotFixture,
  slot: { id: string; claimId: string; claimVersion: number; ownerId: string; hostInstanceId: string },
) {
  return {
    projectId: f.projectId,
    slotId: slot.id,
    claimId: slot.claimId,
    claimVersion: slot.claimVersion,
    ownerId: slot.ownerId,
    hostInstanceId: slot.hostInstanceId,
  };
}

/** 打开同一数据库文件的独立连接（模拟第二个消费者）。 */
export function openPeerSession(f: SlotFixture) {
  return openSqliteStorageSession({ path: f.box.box.dbPath });
}
