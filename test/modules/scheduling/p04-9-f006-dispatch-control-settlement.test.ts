/**
 * P04-9 / F-006：暂停、取消与安全收尾接入派发/槽位生命周期。
 *
 * 验收面（.dag_context.json F-006）：
 * 1. 暂停意图提交后立即阻止新 Task 认领；排队中的暂停/取消不先启动 Runner，
 *    周期补扫不能复活任一控制状态；
 * 2. 正常结束、失败、暂停和取消只在「无活动 Attempt、停止确认、工作区占用
 *    已安全释放」时结算派发归属与槽位；不确定时保留或隔离并保留原因；
 * 3. 完成/续租/释放与后续派发都校验 Run owner/认领版本及关联 Attempt 围栏；
 *    迟到结果不能覆盖新状态或释放新 owner 槽位；
 * 4. 验证失败保留现场并允许既有返工复用 Run 消费者；控制阻塞的查询事实可解释；
 * 5. FakeRuntime 可控完成/停止门覆盖取消与完成、停止不确定与重复结算竞态。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteRunDispatchSettlement } from '../../../packages/core/src/adapters/sqlite/dispatch-settlement.ts';
import { createFakeRuntimeGate, openFakeCoreApplication } from '../../../packages/core/src/adapters/testing.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { BINDING_NOW, openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

const fixtures: Array<BindingFixture | ClaimFixture> = [];
const cores: CoreApplication[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.workExecution.close();
    core.close();
  }
  for (const fixture of fixtures.splice(0)) {
    if ('box' in fixture && 'close' in fixture.box) fixture.box.close();
  }
});

interface ClaimRow {
  readonly id: string;
  readonly revision: number;
  readonly claim_version: number;
  readonly state: string;
  readonly reason: string | null;
  readonly lease_until: number;
  readonly owner_id: string;
  readonly host_instance_id: string;
}

interface SlotRow {
  readonly id: string;
  readonly revision: number;
  readonly claim_id: string;
  readonly claim_version: number;
  readonly state: string;
  readonly reason: string | null;
  readonly lease_until: number;
}

const claimRow = (f: ClaimFixture): ClaimRow => f.box.session.database
  .prepare("SELECT id, revision, claim_version, state, reason, lease_until, owner_id, host_instance_id FROM run_dispatch_claims WHERE state IN ('held', 'quarantined')")
  .get() as ClaimRow;
const latestClaimRow = (f: ClaimFixture): ClaimRow => f.box.session.database
  .prepare('SELECT id, revision, claim_version, state, reason, lease_until, owner_id, host_instance_id FROM run_dispatch_claims ORDER BY claim_version DESC LIMIT 1')
  .get() as ClaimRow;
const allClaims = (f: ClaimFixture): ClaimRow[] => f.box.session.database
  .prepare('SELECT id, revision, claim_version, state, reason, lease_until, owner_id, host_instance_id FROM run_dispatch_claims ORDER BY claim_version')
  .all() as ClaimRow[];
const activeSlot = (f: ClaimFixture): SlotRow => f.box.session.database
  .prepare("SELECT id, revision, claim_id, claim_version, state, reason, lease_until FROM execution_slot_claims WHERE state IN ('held', 'quarantined')")
  .get() as SlotRow;

function expectedOf(row: ClaimRow) {
  return { claimId: row.id, claimVersion: row.claim_version, ownerId: row.owner_id, hostInstanceId: row.host_instance_id };
}

function fenceOf(attempt: { id: string; executionVersion: number; owner: string; hostInstanceId: string }) {
  return { attemptId: attempt.id, executionVersion: attempt.executionVersion,
    ownerId: attempt.owner, hostInstanceId: attempt.hostInstanceId };
}

function settle(f: ClaimFixture, input: Record<string, unknown>, runId = f.ids.runId) {
  const port = createSqliteRunDispatchSettlement(f.box.session, { nowUtcMs: () => NOW });
  return f.box.session.transactWrite('test.settle', () => port.settleInTransaction({ projectId: f.box.projectId, runId, ...input }));
}

function renew(f: ClaimFixture, input: Record<string, unknown>) {
  const port = createSqliteRunDispatchSettlement(f.box.session, { nowUtcMs: () => NOW });
  return f.box.session.transactWrite('test.renew', () => port.renewInTransaction({ projectId: f.box.projectId, runId: f.ids.runId, ...input }));
}

/** 用真实 claimTask 建立 Run 级认领 + 槽位 + 活动 Attempt（F-004 同一接点）。 */
function claim(f: ClaimFixture, index = 0) {
  return f.store().claimTask(f.input(index));
}

/** 模拟「停止已确认、工作区现场已由既有保留链释放」：删除该 Attempt 的租约。 */
function clearLeases(f: ClaimFixture): void {
  f.box.session.database.prepare('DELETE FROM workspace_leases').run();
}

function setRun(f: ClaimFixture, status: string, reason: string | null): void {
  f.box.session.database.prepare('UPDATE runs SET status = ?, reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(status, reason, NOW, f.ids.runId);
}

function setAttempt(f: ClaimFixture, attemptId: string, status: string): void {
  f.box.session.database.prepare('UPDATE attempts SET status = ?, ended_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(status, NOW, NOW, attemptId);
}

describe('F-006 派发归属/槽位收尾的安全条件与围栏', () => {
  it('活动 Attempt 保留占槽；终态仍有工作区占用时隔离；重复结算不重复提升 revision', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const receipt = claim(f);
    const held = claimRow(f);
    const slot = activeSlot(f);

    const active = settle(f, { expected: expectedOf(held), attempt: fenceOf(receipt.receipt.attempt) });
    expect(active).toMatchObject({ decision: 'retained', reason: 'active_attempt_present', changed: false });
    expect(claimRow(f)).toMatchObject({ id: held.id, revision: held.revision, state: 'held' });
    expect(activeSlot(f)).toMatchObject({ id: slot.id, revision: slot.revision, state: 'held' });

    // 终态 Run 但工作区占用仍在：停止/副作用不确定 → 隔离，不释放。
    setAttempt(f, receipt.receipt.attempt.id, 'cancelled');
    setRun(f, 'cancelled', 'user_cancel');
    const uncertain = settle(f, { expected: expectedOf(held), attempt: fenceOf(receipt.receipt.attempt) });
    expect(uncertain).toMatchObject({ decision: 'quarantined', reason: 'workspace_uncertain_after_terminal', changed: true });
    expect(claimRow(f)).toMatchObject({ state: 'quarantined', reason: 'workspace_uncertain_after_terminal' });
    expect(activeSlot(f)).toMatchObject({ state: 'quarantined', reason: 'workspace_uncertain_after_terminal' });
    const quarantinedClaim = claimRow(f), quarantinedSlot = activeSlot(f);

    // 隔离不自动回收：重复结算只返回可解释事实。
    const replay = settle(f, { expected: expectedOf(quarantinedClaim) });
    expect(replay).toMatchObject({ decision: 'retained', reason: 'claim_quarantined', changed: false });
    expect(claimRow(f)).toMatchObject({ id: quarantinedClaim.id, revision: quarantinedClaim.revision, state: 'quarantined' });
    expect(activeSlot(f)).toMatchObject({ id: quarantinedSlot.id, revision: quarantinedSlot.revision, state: 'quarantined' });
  });

  it('暂停且无活动 Attempt/工作区占用时释放认领与槽位；重复结算幂等', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const receipt = claim(f);
    setAttempt(f, receipt.receipt.attempt.id, 'failed');
    clearLeases(f);
    setRun(f, 'paused', 'user_pause');

    const released = settle(f, { expected: expectedOf(claimRow(f)) });
    expect(released).toMatchObject({ decision: 'released', reason: 'run_paused_settled', changed: true });
    const releasedClaim = latestClaimRow(f), releasedSlot = f.box.session.database
      .prepare('SELECT id, revision, claim_id, claim_version, state, reason, lease_until FROM execution_slot_claims').get() as SlotRow;
    expect(releasedClaim.state).toBe('released');
    expect(releasedSlot).toMatchObject({ claim_id: releasedClaim.id, state: 'released', reason: null });

    const replay = settle(f, { expected: expectedOf(releasedClaim) });
    expect(replay).toMatchObject({ decision: 'replayed', reason: 'claim_released', changed: false });
    expect(latestClaimRow(f)).toMatchObject({ id: releasedClaim.id, revision: releasedClaim.revision, state: 'released' });
    expect(f.box.session.database.prepare('SELECT revision FROM execution_slot_claims WHERE id = ?')
      .get(releasedSlot.id)).toEqual({ revision: releasedSlot.revision });
    // Run 业务状态不被收尾改写：暂停仍是暂停，可显式继续。
    expect(f.box.session.database.prepare('SELECT status, reason FROM runs WHERE id = ?').get(f.ids.runId))
      .toEqual({ status: 'paused', reason: 'user_pause' });
  });

  it('已释放代次后的显式继续追加 resume 代次；旧代次迟到结算不能释放新归属', async () => {
    const f = await openClaimFixture([[], []]);
    fixtures.push(f);
    const first = claim(f, 0);
    setAttempt(f, first.receipt.attempt.id, 'failed');
    f.box.session.database.prepare("UPDATE tasks SET status = 'failed' WHERE id = 't-1'").run();
    clearLeases(f);
    setRun(f, 'paused', 'user_pause');
    expect(settle(f, { expected: expectedOf(claimRow(f)) })).toMatchObject({ decision: 'released' });
    const releasedClaim = latestClaimRow(f);

    // 显式继续（resume 已把 Run 重新放回可执行状态）：同 Run 只追加受控代次。
    setRun(f, 'running', null);
    const second = claim(f, 1);
    const claims = allClaims(f);
    expect(claims).toHaveLength(2);
    expect(claims[1]).toMatchObject({ claim_version: 2, state: 'held' });
    const resumed = f.box.session.database.prepare(
      'SELECT origin, resumed_from_claim_id, resumed_from_claim_version FROM run_dispatch_claims WHERE id = ?',
    ).get(claims[1]!.id);
    expect(resumed).toEqual({ origin: 'resume', resumed_from_claim_id: releasedClaim.id,
      resumed_from_claim_version: releasedClaim.claim_version });
    const newSlot = activeSlot(f);
    expect(newSlot).toMatchObject({ claim_id: claims[1]!.id, claim_version: 2, state: 'held' });

    // 旧 owner/旧 Attempt 的迟到结算与续租：结构化拒绝且不改写新归属。
    for (const stale of [
      () => settle(f, { expected: expectedOf(releasedClaim), attempt: fenceOf(first.receipt.attempt) }),
      () => settle(f, { expected: expectedOf({ ...claims[1]!, owner_id: 'other-owner' }) }),
      () => renew(f, { expected: expectedOf(releasedClaim), attempt: fenceOf(first.receipt.attempt),
        leaseUntilUtcMs: NOW + 30_000 }),
    ]) {
      await expect(async () => stale()).rejects.toMatchObject({ details: { reason: 'stale_dispatch_identity' } });
    }
    expect(allClaims(f).find(row => row.id === claims[1]!.id)?.state).toBe('held');
    expect(activeSlot(f)).toMatchObject({ id: newSlot.id, revision: newSlot.revision, state: 'held' });
    // 新代次的活动 Attempt 仍受保护：普通结算只保留。
    expect(settle(f, { expected: expectedOf(claims[1]!), attempt: fenceOf(second.receipt.attempt) }))
      .toMatchObject({ decision: 'retained', reason: 'active_attempt_present' });
  });

  it('停止不确定时隔离占槽并保留原因；验证失败回到 running 时保留同一 Run 消费者', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const receipt = claim(f);
    setAttempt(f, receipt.receipt.attempt.id, 'interrupted');
    f.box.session.database.prepare("UPDATE workspace_leases SET state = 'quarantined'").run();
    setRun(f, 'paused', 'user_cancel');

    expect(settle(f, { expected: expectedOf(claimRow(f)) }))
      .toMatchObject({ decision: 'quarantined', reason: 'stop_unverified' });
    expect(claimRow(f)).toMatchObject({ state: 'quarantined', reason: 'stop_unverified' });

    // 验证失败但仍有代码资格：Run 回到 running，返工必须复用同一认领/槽位。
    const other = await openClaimFixture();
    fixtures.push(other);
    const pendingRework = claim(other);
    setAttempt(other, pendingRework.receipt.attempt.id, 'failed');
    const held = claimRow(other), slot = activeSlot(other);
    setRun(other, 'running', null);
    expect(settle(other, { expected: expectedOf(held) }))
      .toMatchObject({ decision: 'retained', reason: 'run_still_active' });
    expect(claimRow(other)).toMatchObject({ id: held.id, revision: held.revision, state: 'held' });
    expect(activeSlot(other)).toMatchObject({ id: slot.id, revision: slot.revision, state: 'held' });
  });

  it('续租校验认领与关联 Attempt 围栏，不缩短租约且到期只隔离', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const receipt = claim(f);
    const held = claimRow(f);
    const fence = fenceOf(receipt.receipt.attempt);

    expect(renew(f, { expected: expectedOf(held), attempt: fence, leaseUntilUtcMs: NOW + 5_000 }))
      .toMatchObject({ decision: 'renewed', reason: null });
    const renewed = claimRow(f);
    expect(renewed.lease_until).toBe(NOW + 5_000);
    expect(activeSlot(f).lease_until).toBe(NOW + 5_000);

    // 不缩短：请求更短租约时原样返回。
    expect(renew(f, { expected: expectedOf(renewed), attempt: fence, leaseUntilUtcMs: NOW + 2_000 }))
      .toMatchObject({ decision: 'unchanged' });
    expect(claimRow(f).lease_until).toBe(NOW + 5_000);

    // 旧 Attempt 版本不能续租当前认领。
    await expect(async () => renew(f, { expected: expectedOf(renewed),
      attempt: { ...fence, executionVersion: fence.executionVersion + 1 }, leaseUntilUtcMs: NOW + 60_000 }))
      .rejects.toMatchObject({ details: { reason: 'stale_dispatch_identity' } });
    expect(claimRow(f)).toMatchObject({ lease_until: NOW + 5_000, state: 'held' });
  });
});

/* ------------------------------------------------------------------ *
 * B. Work 组合根：暂停阻止派发；取消/完成走同一结算；停止不确定保留占槽
 * ------------------------------------------------------------------ */

const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);
const OWNER = createLocalOwnerPrincipal();

function commandEnvelope(operation: 'execution.pause' | 'execution.cancel' | 'execution.resume',
  projectId: string, runId: string, expectedRevision: number) {
  return { schemaVersion: 5 as const, commandId: randomUUID(), issuedAt: new Date(BINDING_NOW).toISOString(),
    operation, scope: { kind: 'project' as const, projectId }, expectedRevision,
    payload: { runId, batchId: null } };
}

function readRun(f: BindingFixture) {
  return f.query('SELECT status, reason, revision, pause_requested_at FROM runs WHERE id = ?', f.runId) as
    { status: string; reason: string | null; revision: number; pause_requested_at: number | null };
}

function count(f: BindingFixture, sql: string, ...params: unknown[]): number {
  return (f.query(sql, ...params) as { n: number }).n;
}

function claimRowOf(f: BindingFixture) {
  return f.query("SELECT id, revision, claim_version, state, reason FROM run_dispatch_claims WHERE state IN ('held', 'quarantined')") as
    { id: string; revision: number; claim_version: number; state: string; reason: string | null };
}

function slotRowOf(f: BindingFixture) {
  return f.query("SELECT id, revision, claim_id, claim_version, state, reason FROM execution_slot_claims WHERE state IN ('held', 'quarantined')") as
    { id: string; revision: number; claim_id: string; claim_version: number; state: string; reason: string | null };
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const idle = (core: CoreApplication) =>
  expect.poll(() => core.workExecution.activeAttemptIds(), { timeout: 15_000 }).toEqual([]);

describe('F-006 Work 组合根的暂停/取消与派发结算', () => {
  it('暂停意图提交后立即阻止新认领；补扫不复活；显式继续后只追加 resume 代次', async () => {
    // Real dispatch uses the P06 confirmed Profile gate; establish it through
    // the fixture's public detect/confirm commands before testing pause/resume.
    const fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true, confirmProjectProfile: true });
    fixtures.push(fixture);
    const core = await openFakeCoreApplication({ dataRoot: fixture.box.dataRoot, capabilityCatalog: fakeCatalog(),
      nowUtcMs: () => BINDING_NOW,
      fake: { providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'F-006 pause' }] } } });
    cores.push(core);

    // 排队中的暂停：尚未认领就阻止派发，不启动 Runner、不建 Attempt。
    const paused = await core.commandService.submit(OWNER,
      commandEnvelope('execution.pause', fixture.projectId, fixture.runId, readRun(fixture).revision) as never);
    expect(paused.status).toBe('completed');
    expect(readRun(fixture)).toMatchObject({ status: 'paused', reason: 'user_pause' });
    expect((await core.workExecution.scan()).runs).toMatchObject([{ claimed: false, reason: 'run_control_blocked' }]);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(0);
    // 周期补扫不能复活暂停状态。
    await core.workExecution.scan();
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(0);
    expect(core.workExecution.dispatchState(fixture.projectId, fixture.runId))
      .toMatchObject({ state: 'paused', blockingReason: 'run_paused', claimId: null, settlement: { decision: 'absent' } });

    // 显式继续：恢复后只创建一个认领代次；Runtime 结束不等于 Task passed。
    const resume = await core.commandService.submit(OWNER,
      commandEnvelope('execution.resume', fixture.projectId, fixture.runId, readRun(fixture).revision) as never);
    expect(resume.status).toBe('completed');
    const resumedScan = await core.workExecution.scan();
    expect(resumedScan.runs, JSON.stringify({ scan: resumedScan, run: readRun(fixture),
      dispatch: core.workExecution.dispatchState(fixture.projectId, fixture.runId) })).toMatchObject([{ claimed: true }]);
    await idle(core);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(readRun(fixture).status).not.toBe('succeeded');
    const current = fixture.query('SELECT id, claim_version, state, origin FROM run_dispatch_claims') as
      { id: string; claim_version: number; state: string; origin: string };
    expect(current).toMatchObject({ claim_version: 1, state: 'held', origin: 'dispatch' });
    expect(slotRowOf(fixture)).toMatchObject({ claim_id: current.id, claim_version: 1, state: 'held' });
  }, 120_000);

  it('排队中的取消不启动 Runner，补扫不复活取消状态', async () => {
    const fixture = await openBindingFixture();
    fixtures.push(fixture);
    const core = await openFakeCoreApplication({ dataRoot: fixture.box.dataRoot, capabilityCatalog: fakeCatalog(),
      nowUtcMs: () => BINDING_NOW,
      fake: { providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [] } } });
    cores.push(core);
    const cancelled = await core.commandService.submit(OWNER,
      commandEnvelope('execution.cancel', fixture.projectId, fixture.runId, readRun(fixture).revision) as never);
    expect(cancelled.status).toBe('completed');
    expect(readRun(fixture).status).toBe('cancelled');
    expect((await core.workExecution.scan()).runs.every(entry => entry.claimed === false)).toBe(true);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(0);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM run_dispatch_claims')).toBe(0);
  }, 120_000);

  it('取消停止当前执行并保留现场，停止确认后释放认领与槽位；重复结算幂等', async () => {
    const fixture = await openBindingFixture({ confirmProjectProfile: true });
    fixtures.push(fixture);
    const hold = createFakeRuntimeGate();
    const core = await openFakeCoreApplication({ dataRoot: fixture.box.dataRoot, capabilityCatalog: fakeCatalog(),
      nowUtcMs: () => BINDING_NOW,
      fake: { providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hold' }] },
        gates: { hold } } });
    cores.push(core);
    expect((await core.workExecution.scan()).runs).toMatchObject([{ claimed: true }]);
    await waitFor(() => core.workExecution.activeAttemptIds().length === 1);
    const held = claimRowOf(fixture), heldSlot = slotRowOf(fixture);
    expect(core.workExecution.dispatchState(fixture.projectId, fixture.runId))
      .toMatchObject({ state: 'claimed', claimState: 'held', slotState: 'held' });

    const cancel = await core.commandService.submit(OWNER,
      commandEnvelope('execution.cancel', fixture.projectId, fixture.runId, readRun(fixture).revision) as never);
    expect(cancel.status).toBe('completed');
    expect(readRun(fixture).status).toBe('cancelling');
    // 取消过程中归属/槽位仍由当前 Attempt 持有，不允许新认领抢占。
    expect((await core.workExecution.scan()).runs.every(entry => entry.claimed === false)).toBe(true);

    // 受监督收尾确认停止；停止 operation 收口为 cancelled 后由补扫安全结算
    // （运行中/cancelling 期间结算器只保留，不提前回收）。
    await idle(core);
    await waitFor(() => readRun(fixture).status === 'cancelled');
    await core.workExecution.scan();
    await waitFor(() => count(fixture, "SELECT COUNT(*) AS n FROM run_dispatch_claims WHERE state = 'released'") === 1);
    expect(fixture.query('SELECT status FROM attempts')).toEqual({ status: 'cancelled' });
    expect(readRun(fixture)).toMatchObject({ status: 'cancelled' });
    expect(count(fixture, "SELECT COUNT(*) AS n FROM execution_slot_claims WHERE state IN ('held', 'quarantined')")).toBe(0);
    const released = fixture.query('SELECT id, state, reason, settled_at FROM run_dispatch_claims') as
      { id: string; state: string; reason: string | null; settled_at: number | null };
    expect(released).toMatchObject({ id: held.id, state: 'released', reason: null });
    expect(released.settled_at).not.toBeNull();
    expect(heldSlot.id).not.toBe('');
    expect(core.workExecution.dispatchState(fixture.projectId, fixture.runId))
      .toMatchObject({ state: 'cancelled', blockingReason: null, claimState: 'released',
        settlement: { decision: 'released' } });
    // 取消现场保留：worktree 以 halted 之外的 retained 结果收尾，可复用现场。
    const retained = fixture.query(
      `SELECT o.status AS status, r.result_json AS result_json FROM workspace_operations o
        JOIN command_receipts r ON r.id = o.receipt_id
        WHERE o.kind = 'retain' ORDER BY o.rowid DESC LIMIT 1`) as { status: string; result_json: string };
    expect(retained.status).toBe('succeeded');
    expect(JSON.parse(retained.result_json)).toMatchObject({ reason: 'cancelled', reusable: true, stop: 'confirmed' });

    // 迟到/重复结算：已释放是终态，不重复提升 revision，也不产生第二个完成事件。
    const replay = core.workExecution.settleDispatch(fixture.projectId, fixture.runId);
    expect(replay).toMatchObject({ decision: 'replayed', reason: 'claim_released', changed: false });
    expect(fixture.query('SELECT revision FROM run_dispatch_claims WHERE id = ?', held.id))
      .toEqual({ revision: held.revision + 1 });
  }, 120_000);
});

function slotRowOfMissing(f: BindingFixture): number {
  return count(f, "SELECT COUNT(*) AS n FROM execution_slot_claims WHERE state IN ('held', 'quarantined')");
}
