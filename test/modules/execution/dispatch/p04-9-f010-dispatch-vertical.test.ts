/**
 * P04-9 / F-010 生产组合根派发纵向场景（真实临时 SQLite/Git + FakeRuntime）。
 *
 * 覆盖验收面（.dag_context.json F-010）：
 * 1. 单 Feature 两个有依赖 Task 从授权到派发、认领、执行、验证/必要提交和结束；
 *    Run 级认领/槽位不按 Task 重复分配，收尾无无法解释的占槽。
 * 2. 两个独立消费者实例竞争同一持久状态：同 Run 重复入队/唤醒最多一个有效
 *    Attempt；不同已授权 Run 竞争容量 1 时仅胜者启动。事实断言落在 Attempt、
 *    Runtime 启动预算/预占、认领回执与持久事件，不只统计内存回调。
 * 3. 丢失唤醒与 Host 重建：只依赖持久派发事实补扫，已完成到 verifying 的
 *    Task 不被重复执行。
 *
 * 各职责故障窗口（暂停/取消不复活、认领后崩溃、旧 owner 迟到、停止不确定、
 * 显式 resume、返工与失败保留、仅收尾兼容、旧数据升级）由 F-004/F-006/F-007
 * 与 P03-7/P03-8/P03-9/P04-8 的既有测试覆盖，本索引复用而不复制。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  openCoreApplication,
  type CoreApplication,
  type WorkRuntimeFactory,
} from '../../../../packages/core/src/adapters/composition.ts';
import { createFakeWorkRuntimeFactory, openFakeCoreApplication } from '../../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../../../../packages/core/src/adapters/process/command-process.ts';
import type { RuntimeExecutionRequest } from '../../../../packages/core/src/ports/runtime-execution.ts';
import {
  BINDING_BUDGET,
  BINDING_NOW,
  openBindingFixture,
  type BindingFixture,
} from '../../../helpers/p03-6/input-binding-fixture.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import { seedApprovalWaitingVerification } from '../../../helpers/p03-7/approval-continue-seed.ts';
import { openDeliveryVertical } from '../../../helpers/p03-8/delivery-vertical.ts';

const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);

const fixtures: BindingFixture[] = [];
const cores: CoreApplication[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.workExecution.close();
    core.close();
  }
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const row = (fixture: BindingFixture, sql: string, ...params: unknown[]) =>
  fixture.query(sql, ...params) as Record<string, unknown>;
const count = (fixture: BindingFixture, sql: string, ...params: unknown[]) =>
  (row(fixture, sql, ...params) as { n: number }).n;

async function waitIdle(core: CoreApplication): Promise<void> {
  await expect.poll(() => core.workExecution.activeAttemptIds(), { timeout: 15_000 }).toEqual([]);
}

/** 生产组合根：每个 Task 使用同一可信脚本，写入不同文件以产生真实 Task 提交。 */
const fileFor = (taskId: string): string => `src/${taskId}-delivery.txt`;

async function openVertical(options: {
  readonly workStartupRecoveryRequired?: boolean;
  readonly dataRoot?: string;
} = {}) {
  const fixture = await openBindingFixture({
    secondTask: true,
    secondTaskDependsOnFirst: true,
    deliveryPolicy: {
      commitMode: 'task_and_feature',
      gitIdentity: { name: 'Confirmed Owner', email: 'owner@example.test', confirmed: true },
    },
  });
  fixtures.push(fixture);
  const processes = createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 });
  const runtimeCalls: string[] = [];
  const workRuntimeFactory: WorkRuntimeFactory = context => {
    const make = (file: string) => createFakeWorkRuntimeFactory({
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      commandProcess: processes,
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: { schemaVersion: 1, steps: [
        { op: 'write_file', path: file, content: `${file} delivered\n` },
        { op: 'tool_command', name: 'probe' },
        { op: 'message', role: 'assistant', text: 'deterministic work complete' },
      ] },
    })(context);
    const first = make(fileFor('t-1'));
    const second = make(fileFor('t-2'));
    return {
      ...first,
      entries: first.entries.map(entry => ({
        ...entry,
        adapter: {
          async start(request: RuntimeExecutionRequest) {
            runtimeCalls.push(request.identity.purpose === 'work'
              ? (request.identity.taskId ?? 'unknown') : request.identity.purpose);
            const selected = request.identity.purpose === 'work' && request.identity.taskId === 't-2'
              ? second : first;
            return selected.entries[0]!.adapter.start(request);
          },
        },
      })),
    };
  };
  const core = await openCoreApplication({
    dataRoot: options.dataRoot ?? fixture.box.dataRoot,
    capabilityCatalog: fakeCatalog(),
    nowUtcMs: () => BINDING_NOW,
    workRuntimeFactory,
    busyTimeoutMs: 5_000,
    ...(options.workStartupRecoveryRequired === undefined
      ? {} : { workStartupRecoveryRequired: options.workStartupRecoveryRequired }),
  });
  cores.push(core);
  return { fixture, core, runtimeCalls };
}

/** 断言此刻没有无法解释的占槽：每个活动认领都对应非终态 Run 与可读原因。 */
function expectNoUnexplainedOccupancy(fixture: BindingFixture): void {
  const claims = fixture.session.database.prepare(
    "SELECT c.id, c.run_id, c.state, r.status AS run_status, r.reason AS run_reason FROM run_dispatch_claims c " +
    'LEFT JOIN runs r ON r.project_id = c.project_id AND r.id = c.run_id ORDER BY c.id',
  ).all() as { id: string; run_id: string; state: string; run_status: string | null; run_reason: string | null }[];
  for (const claim of claims) {
    expect(claim.run_status, `claim ${claim.id} has no run`).not.toBeNull();
    if (claim.state !== 'released') {
      // 活动/隔离认领必须仍属于非终态 Run，并保留可查询的阻塞原因。
      expect(['queued', 'running', 'pausing', 'paused'], claim.run_status ?? '')
        .toContain(claim.run_status);
    }
  }
  const slots = fixture.session.database.prepare(
    "SELECT s.id, s.state, c.run_id FROM execution_slot_claims s " +
    'LEFT JOIN run_dispatch_claims c ON c.id = s.claim_id ORDER BY s.id',
  ).all() as { id: string; state: string; run_id: string | null }[];
  for (const slot of slots) {
    expect(slot.run_id, `slot ${slot.id} has no claim`).not.toBeNull();
  }
}

describe('P04-9 F-010 单 Feature 双 Task 派发纵向', () => {
  it('[case:two-task-dispatch-commit] 依赖 Task 串行执行、复用同一 Run 认领/槽位并产生真实任务提交', async () => {
    const { fixture, core, runtimeCalls } = await openVertical();
    const db = fixture.session.database;

    // 第一轮：派发 → 认领 → FakeRuntime → verifying（Runtime 完成不等于 passed）。
    expect(await core.workExecution.scan()).toMatchObject({ runs: [{ claimed: true }] });
    await waitIdle(core);
    expect(runtimeCalls).toEqual(['t-1']);
    expect(row(fixture, 'SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'running' });
    expect(row(fixture, 'SELECT status FROM attempts WHERE task_id = ?', 't-1')).toEqual({ status: 'verifying' });
    const firstClaim = row(fixture, 'SELECT id, claim_version FROM run_dispatch_claims');
    const firstSlot = row(fixture, 'SELECT id, claim_id, claim_version, state, slot_index FROM execution_slot_claims');
    expect(firstSlot).toMatchObject({
      claim_id: firstClaim.id, claim_version: firstClaim.claim_version, state: 'held', slot_index: 0,
    });

    // 验证通过 + 受控 Task 提交，再由 DAG 解锁第二个依赖 Task。
    await seedApprovalWaitingVerification({
      fixture, completion: core.taskVerificationCompletion, taskId: 't-1', approvalItem: false,
    });
    expect(row(fixture, 'SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'passed' });
    const firstCommit = row(fixture,
      "SELECT attempt_id, status, actual_commit FROM git_operations WHERE operation_type = 'task_commit'");
    expect(firstCommit).toMatchObject({
      attempt_id: (row(fixture, 'SELECT id FROM attempts WHERE task_id = ?', 't-1') as { id: string }).id,
      status: 'succeeded',
      actual_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });

    // 第二轮：同一 Run 消费者/槽位继续，不重复占槽；Runtime 启动预算累计到 2。
    expect(await core.workExecution.scan()).toMatchObject({ runs: [{ claimed: true }] });
    await waitIdle(core);
    expect(runtimeCalls).toEqual(['t-1', 't-2']);
    expect(row(fixture, 'SELECT status FROM attempts WHERE task_id = ?', 't-2')).toEqual({ status: 'verifying' });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(2);
    expect(row(fixture, 'SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 2 });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM runtime_start_reservations')).toBe(2);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM run_dispatch_claims')).toBe(1);
    expect(row(fixture, 'SELECT id, claim_version, state FROM run_dispatch_claims'))
      .toEqual({ id: firstClaim.id, claim_version: firstClaim.claim_version, state: 'held' });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM execution_slot_claims')).toBe(1);
    expect(row(fixture, 'SELECT id, claim_id, claim_version, state FROM execution_slot_claims'))
      .toEqual({ id: firstSlot.id, claim_id: firstClaim.id, claim_version: firstClaim.claim_version, state: 'held' });

    await seedApprovalWaitingVerification({
      fixture, completion: core.taskVerificationCompletion, taskId: 't-2', approvalItem: false,
    });
    expect(row(fixture, 'SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'passed' });
    const commits = db.prepare(
      "SELECT attempt_id, status, actual_commit FROM git_operations WHERE operation_type = 'task_commit' ORDER BY created_at, rowid",
    ).all() as { attempt_id: string; status: string; actual_commit: string }[];
    expect(commits).toHaveLength(2);
    expect(commits.every(commit => commit.status === 'succeeded'
      && /^[0-9a-f]{40}$/.test(commit.actual_commit))).toBe(true);
    expect(new Set(commits.map(commit => commit.actual_commit)).size).toBe(2);
    // 两个 Task 的已验证代码提交都绑定真实 Attempt，而非复用同一份提交。
    expect(new Set(commits.map(commit => commit.attempt_id))).toEqual(new Set(
      (db.prepare('SELECT id FROM attempts ORDER BY created_at, rowid').all() as { id: string }[]).map(item => item.id)));

    // 收尾：未装配 Feature 最终验证消费者时保留可查询原因，不伪造 passed。
    const final = await core.workExecution.scan();
    expect(final.runs.every(entry => entry.claimed === false)).toBe(true);
    expect(row(fixture, 'SELECT status FROM features WHERE id = ?', fixture.featureId)).toEqual({ status: 'draft' });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(2);
    expectNoUnexplainedOccupancy(fixture);
    expect(core.workExecution.dispatchState(fixture.projectId, fixture.runId)).toMatchObject({
      runStatus: 'running', claimState: 'held', slotState: 'held', activeAttemptCount: 0,
    });

    // 关闭顺序：先派发/执行器关闭并核验停止，再关闭状态库。
    const closed = await core.workExecution.close();
    expect(closed).toEqual({ closed: true, pendingAttemptIds: [] });
    cores.splice(cores.indexOf(core), 1);
    core.close();
  }, 180_000);
});

describe('P04-9 F-010 双消费者竞争同一持久状态', () => {
  it('[case:dual-consumer-same-run] 同 Run 重复入队/唤醒只产生一个有效 Attempt、归属、槽位与启动预算', async () => {
    const fixture = await openBindingFixture();
    fixtures.push(fixture);
    const open = () => openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fakeCatalog(),
      nowUtcMs: () => BINDING_NOW,
      busyTimeoutMs: 5_000,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'dual consumer' }] },
      },
    });
    const first = await open();
    const second = await open();
    cores.push(first, second);

    const ref = { projectId: fixture.projectId, runId: fixture.runId };
    first.workExecution.signalRunDispatched(ref);
    second.workExecution.signalRunDispatched(ref);
    const scans = await Promise.all([first.workExecution.scan(), second.workExecution.scan()]);
    expect(scans.flatMap(scan => scan.runs).filter(run => run.claimed)).toHaveLength(1);
    await waitIdle(first);
    await waitIdle(second);

    // 事实断言：不是回调次数，而是持久 Attempt/归属/槽位/回执/预算/事件。
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM run_dispatch_claims')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM execution_slot_claims')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM task_claim_receipts')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM runtime_start_reservations')).toBe(1);
    expect(row(fixture, 'SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
    expect(count(fixture, "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'task.claimed'")).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts WHERE status IN (\'preparing\', \'executing\')')).toBe(0);

    // 重复唤醒/补扫在 Task 仍等待验证时不得产生第二个 Attempt 或第二份预算。
    first.workExecution.signalRunDispatched(ref);
    second.workExecution.signalRunDispatched(ref);
    await Promise.all([first.workExecution.scan(), second.workExecution.scan()]);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM runtime_start_reservations')).toBe(1);
    expect(row(fixture, 'SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });

    // 有限清理：两个消费者都确认无活动 Attempt，再关闭夹具数据库。
    expect(await first.workExecution.close()).toEqual({ closed: true, pendingAttemptIds: [] });
    expect(await second.workExecution.close()).toEqual({ closed: true, pendingAttemptIds: [] });
    cores.splice(0);
    fixture.close();
    fixtures.splice(fixtures.indexOf(fixture), 1);
    expect(fixture.box.cleaned).toBe(true);
  }, 180_000);

  it('[case:dual-consumer-two-runs] 两个已授权 Run 竞争容量 1 时仅胜者启动，败者保留可解释阻塞', async () => {
    const fixture = await openBindingFixture();
    fixtures.push(fixture);
    try {
      const owner = createLocalOwnerPrincipal();
      const scope = { kind: 'project' as const, projectId: fixture.projectId };
      // 授权装配根（无 Runtime）：只经生产命令面创建第二个已授权 Run，不消费派发。
      const authoring = await openCoreApplication({
        dataRoot: fixture.box.dataRoot,
        capabilityCatalog: fakeCatalog(),
        nowUtcMs: () => BINDING_NOW,
        busyTimeoutMs: 5_000,
      });
      const submit = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) =>
        authoring.commandService.submit(owner, { schemaVersion: 5, commandId: randomUUID(),
          issuedAt: new Date(BINDING_NOW).toISOString(), operation, scope, payload, ...extra } as never);
      try {
        expect((await submit('phase.create', {
          id: 'phase-f010-peer', title: 'F-010 竞争阶段', description: null, labels: [],
        })).status).toBe('completed');
        const imported = await submit('feature.plan.import', {
          phaseId: 'phase-f010-peer',
          plan: {
            schemaVersion: 1,
            feature: { title: 'F-010 竞争 Feature', description: null, labels: [], sourceRefs: [] },
            tasks: [{
              id: 'peer-1', title: 'F-010 竞争 Task', acceptance: { criteria: ['仅胜者启动'] },
              requirementsRefs: [{ artifactId: fixture.requirementArtifactId }],
            }],
          },
        }, { expectedRevision: 1 });
        if (imported.status !== 'completed' || imported.result === null) {
          throw new Error(`F-010 peer plan import failed: ${JSON.stringify(imported)}`);
        }
        const peerFeatureId = (imported.result as { feature: { id: string } }).feature.id;
        const peer = fixture.query('SELECT plan_digest, revision FROM features WHERE id = ?', peerFeatureId) as
          { plan_digest: string; revision: number };
        expect((await submit('feature.plan.decide', {
          featureId: peerFeatureId, planDigest: peer.plan_digest, decision: 'approve', reason: 'F-010 capacity race',
        }, { expectedRevision: peer.revision })).status).toBe('completed');
        const preview = await authoring.executionPreview.previewExecution(fixture.projectId, {
          featureIds: [peerFeatureId], budget: BINDING_BUDGET,
        });
        expect(preview.status).toBe('ready');
        if (preview.status !== 'ready') throw new Error('F-010 peer preview not ready');
        const started = await submit('execution.start', {
          featureIds: [peerFeatureId], budget: BINDING_BUDGET, previewDigest: preview.previewDigest,
        });
        expect(started.status).toBe('accepted');
      } finally {
        await authoring.workExecution.close();
        authoring.close();
      }
      // 两个已授权 Run 现在都留在持久队列，等待两个独立消费者竞争唯一槽位。
      const db = fixture.session.database;
      expect((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get() as { n: number }).n).toBe(2);

      const open = () => openFakeCoreApplication({
        dataRoot: fixture.box.dataRoot,
        capabilityCatalog: fakeCatalog(),
        nowUtcMs: () => BINDING_NOW,
        busyTimeoutMs: 5_000,
        fake: {
          providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
          script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'two runs' }] },
        },
      });
      const first = await open();
      const second = await open();
      cores.push(first, second);

      const scans = await Promise.all([first.workExecution.scan(), second.workExecution.scan()]);
      const persisted = db.prepare('SELECT id, status, reason FROM runs ORDER BY id').all();
      const claimed = scans.flatMap(scan => scan.runs).filter(run => run.claimed);
      expect(claimed, JSON.stringify({ scans, persisted })).toHaveLength(1);
      const rejected = scans.flatMap(scan => scan.runs).filter(run => !run.claimed
        && (run.reason === 'claim_rejected' || run.reason === 'resource_busy'));
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      await waitIdle(first);
      await waitIdle(second);

      expect((db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM run_dispatch_claims').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM execution_slot_claims').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM runtime_start_reservations').get() as { n: number }).n).toBe(1);
      const starts = db.prepare('SELECT id, runtime_starts FROM execution_batches ORDER BY id').all() as
        { id: string; runtime_starts: number }[];
      expect(starts.reduce((sum, batch) => sum + batch.runtime_starts, 0)).toBe(1);
      // 败者 Run 仍是 queued，且由持久原因解释；不提前启动 Runner、不记 Attempt。
      const runs = db.prepare('SELECT id, status, reason FROM runs ORDER BY id').all() as
        { id: string; status: string; reason: string | null }[];
      expect(runs.filter(run => run.status === 'queued')).toHaveLength(1);
      const winner = (db.prepare('SELECT run_id FROM run_dispatch_claims').get() as { run_id: string }).run_id;
      const loserRun = runs.find(run => run.id !== winner)!;
      expect(loserRun).toMatchObject({ status: 'queued', reason: 'resource_busy' });
    } finally {
      for (const core of cores.splice(0)) {
        await core.workExecution.close();
        core.close();
      }
    }
  }, 180_000);
});

describe('P04-9 F-010 Host 重建与丢失唤醒', () => {
  it('[case:host-rebuild-lost-wake] 未收到唤醒且 Host 被重建后，恢复门控解除即从持久状态补扫执行', async () => {
    const fixture = await openBindingFixture();
    fixtures.push(fixture);
    const open = () => openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fakeCatalog(),
      workStartupRecoveryRequired: true,
      nowUtcMs: () => BINDING_NOW,
      busyTimeoutMs: 5_000,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'host rebuild' }] },
      },
    });
    const stale = await open();
    const ref = { projectId: fixture.projectId, runId: fixture.runId };
    // 恢复门控期间信号只唤醒内存，不消费；进程在收到真实唤醒前“崩溃”。
    stale.workExecution.signalRunDispatched(ref);
    expect(await stale.workExecution.scan()).toMatchObject({ pages: 0, runs: [] });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(0);
    expect(await stale.workExecution.close()).toEqual({ closed: true, pendingAttemptIds: [] });
    stale.close();

    // 新 Host 实例只依赖同一 SQLite 持久状态，不继承任何内存信号。
    const rebuilt = await open();
    cores.push(rebuilt);
    expect(rebuilt.workExecution.recoveryState().status).toBe('recovering');
    await rebuilt.workExecution.recover();
    expect(rebuilt.workExecution.recoveryState()).toEqual({ status: 'complete', reason: null });
    expect(await rebuilt.workExecution.scan()).toMatchObject({ runs: [{ claimed: true, reason: 'ready' }] });
    await waitIdle(rebuilt);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM run_dispatch_claims')).toBe(1);
    expect(row(fixture, 'SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });

    // 重建后重复补扫不重复执行已完成到 verifying 的 Task。
    await rebuilt.workExecution.scan();
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(row(fixture, 'SELECT status FROM attempts')).toEqual({ status: 'verifying' });

    expect(await rebuilt.workExecution.close()).toEqual({ closed: true, pendingAttemptIds: [] });
    cores.splice(cores.indexOf(rebuilt), 1);
    rebuilt.close();
  }, 180_000);
});

describe('P04-9 F-010 单 Feature 交付兼容', () => {
  it('[case:single-feature-delivery] 双 Task 经真实提交与 Feature 最终交付结束，派发终态可解释', async () => {
    const vertical = await openDeliveryVertical({ finalChanges: true });
    try {
      await vertical.approve();
      const receipt = await vertical.finalize();
      expect(receipt).toMatchObject({
        status: 'completed',
        result: { outcome: 'completed', deliveryStatus: 'succeeded' },
      });
      // 两个 Task 的验证/受控提交与 Feature 最终提交都只发生一次。
      const operations = vertical.db.prepare(
        'SELECT operation_type, status, attempt_id FROM git_operations ORDER BY rowid',
      ).all() as { operation_type: string; status: string; attempt_id: string | null }[];
      expect(operations.filter(operation => operation.operation_type === 'task_commit')).toHaveLength(2);
      expect(operations.filter(operation => operation.operation_type === 'feature_final_commit')).toHaveLength(1);
      expect(operations.every(operation => ['succeeded', 'no_change'].includes(operation.status))).toBe(true);
      expect(new Set(operations.filter(operation => operation.operation_type === 'task_commit')
        .map(operation => operation.attempt_id)).size).toBe(2);
      expect(vertical.db.prepare('SELECT status, delivery_status FROM features').get())
        .toMatchObject({ status: 'completed', delivery_status: 'succeeded' });
      expect(vertical.db.prepare('SELECT status FROM runs').get()).toMatchObject({ status: 'succeeded' });
      expect(vertical.db.prepare('SELECT status FROM attempts ORDER BY number').all())
        .toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
      expect(vertical.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
      expect(vertical.head()).not.toBe(vertical.initialHead);

      // 终态补扫只做受信结算：归属/槽位移交后无可解释的遗留占槽，不重跑 Task/提交。
      await vertical.core.workExecution.scan();
      const dispatch = vertical.core.workExecution.dispatchState(
        vertical.fixture.projectId, vertical.fixture.runId);
      // 夹具在最终验证前恢复的 3 份现场租约使归属/槽位按不安全占用隔离，
      // 原因必须可解释、与槽位一致；不是无原因的遗留占槽。
      expect(dispatch).toMatchObject({
        state: 'succeeded', activeAttemptCount: 0, retainedLeaseCount: 3,
        claimState: 'quarantined', slotState: 'quarantined',
        claimReason: 'workspace_uncertain_after_terminal',
        settlement: { decision: 'quarantined', reason: 'workspace_uncertain_after_terminal' },
      });
      const heldClaims = vertical.db.prepare(
        "SELECT id, state, reason FROM run_dispatch_claims WHERE state IN ('held', 'quarantined')",
      ).all() as { id: string; state: string; reason: string | null }[];
      const heldSlots = vertical.db.prepare(
        "SELECT id, state, reason FROM execution_slot_claims WHERE state IN ('held', 'quarantined')",
      ).all() as { id: string; state: string; reason: string | null }[];
      expect(heldClaims).toHaveLength(1);
      expect(heldClaims[0]).toMatchObject({ state: 'quarantined', reason: 'workspace_uncertain_after_terminal' });
      expect(heldSlots).toHaveLength(1);
      expect(heldSlots[0]).toMatchObject({ state: 'quarantined', reason: 'workspace_uncertain_after_terminal' });
      expect(vertical.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
      expect(operations).toEqual(vertical.db.prepare(
        'SELECT operation_type, status, attempt_id FROM git_operations ORDER BY rowid',
      ).all());
    } finally {
      await vertical.close();
    }
  }, 180_000);
});
