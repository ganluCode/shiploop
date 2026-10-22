/**
 * P04-9 / F-008 Core 派发队列与执行槽位只读投影（真实临时 SQLite）。
 *
 * 验收面（.dag_context.json F-008）：
 * 1. 复用既有调度/控制查询：从 Run + 认领 + 槽位 + 活动 Attempt 派生
 *    queued/claimed/running/waiting_slot/paused/cancelling/interrupted/blocked/
 *    终态，给出稳定身份、owner/认领版本、关联 Attempt、槽位与租约、阻塞原因；
 *    展示状态不落库为第二套可写状态。
 * 2. 无槽位能说明占用/恢复隔离；容量限制与 Runtime 未装配可区分；未知时间与
 *    停止证据保持 null；跨项目槽位只返回摘要/通用忙碌原因，不泄漏身份。
 * 3. 只读一致读 + 能力/可见性检查 + 不存在折叠；稳定排序、有界分页；非法/
 *    跨项目/跨根游标、坏参数和损坏持久行按既有错误纪律拒绝。
 * 4. 重复查询零写入（状态/事件/预算/认领/续租/唤醒），输出不含凭据、SQL、
 *    输入正文、进程环境或本机绝对路径。
 */
import { describe, expect, it } from 'vitest';
import { BUDGET, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import type { BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { publishPreparedInputFixture } from '../../helpers/p03-4/task-dag-state-fixture.ts';
import {
  acquireInput,
  openSlotFixture,
  type SlotFixture,
} from '../../helpers/p04-9/slot-fixture.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import {
  createSqliteExecutionSlotAccess,
} from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import type { QueryService } from '../../../packages/core/src/application/query-service.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import {
  PLAN_LIST_DEFAULT_LIMIT,
  PLAN_LIST_MAX_LIMIT,
} from '../../../packages/core/src/ports/queries.ts';
import { EXECUTION_DISPATCH_LIST_OPERATION } from '../../../packages/core/src/ports/execution-schedule-query.ts';
import { isPublicError, WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';
import type { PublicError } from '../../../packages/core/src/ports/commands.ts';
import type { ExecutionSlotClaimRecord } from '../../../packages/core/src/ports/execution-dispatch.ts';
import type { PreparedExecutionInputGroup } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { createRestrictedPrincipal, scopeAllowlist } from '../../helpers/p02-2/principals.ts';

const OPERATION = EXECUTION_DISPATCH_LIST_OPERATION;

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（固定时钟）。 */
function assembleQueries(
  box: BudgetFixture,
  options: { readonly now?: number; readonly dataRootIdentity?: string } = {},
): QueryService {
  const queryStore = createSqliteQueryStore(box.session);
  const stateStore = createSqliteStateStore(box.session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: box.box.capabilityCatalog,
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    gitOperationReads: queryStore,
    featureDeliveryReads: queryStore,
    executionControlReads: queryStore,
    artifacts: createSqliteArtifactStore(box.session),
    artifactFiles: createArtifactFileStore({ dataRoot: box.box.dataRoot }),
    dataRootIdentity:
      options.dataRootIdentity ?? computeDataRootIdentity(box.box.dataRoot),
    nowUtcMs: () => options.now ?? NOW,
  });
}

interface DispatchFixture extends SlotFixture {
  readonly snapshot: PreparedExecutionInputGroup;
  readonly runABatchId: string;
  readonly runBBatchId: string;
}

function db(f: { readonly box: BudgetFixture }) {
  return f.box.session.database;
}

function releaseClaim(f: SlotFixture, claimId: string, when = NOW): void {
  db(f)
    .prepare(
      "UPDATE run_dispatch_claims SET state = 'released', settled_at = ?, reason = NULL, " +
        'revision = revision + 1, updated_at = ? WHERE id = ?',
    )
    .run(when, when, claimId);
}

function quarantineClaim(f: SlotFixture, claimId: string, when = NOW): void {
  db(f)
    .prepare(
      "UPDATE run_dispatch_claims SET state = 'quarantined', reason = 'manual_verification', " +
        'settled_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    )
    .run(when, when, claimId);
}

function updateRun(
  f: SlotFixture,
  runId: string,
  patch: {
    readonly status?: string;
    readonly reason?: string | null;
    readonly startedAt?: number | null;
    readonly endedAt?: number | null;
    readonly pauseRequestedAt?: number | null;
  },
): void {
  const row = db(f)
    .prepare('SELECT status, reason, started_at, ended_at, pause_requested_at FROM runs WHERE id = ?')
    .get(runId) as {
    status: string;
    reason: string | null;
    started_at: number | null;
    ended_at: number | null;
    pause_requested_at: number | null;
  };
  db(f)
    .prepare(
      'UPDATE runs SET status = @status, reason = @reason, started_at = @startedAt, ended_at = @endedAt, ' +
        'pause_requested_at = @pauseRequestedAt, revision = revision + 1, updated_at = @updatedAt WHERE id = @id',
    )
    .run({
      status: patch.status ?? row.status,
      reason: patch.reason === undefined ? row.reason : patch.reason,
      startedAt: patch.startedAt === undefined ? row.started_at : patch.startedAt,
      endedAt: patch.endedAt === undefined ? row.ended_at : patch.endedAt,
      pauseRequestedAt:
        patch.pauseRequestedAt === undefined ? row.pause_requested_at : patch.pauseRequestedAt,
      updatedAt: NOW,
      id: runId,
    });
}


function insertAttempt(
  f: SlotFixture,
  runId: string,
  snapshot: PreparedExecutionInputGroup,
  overrides: {
    readonly id?: string;
    readonly ownerId?: string;
    readonly hostInstanceId?: string;
    readonly status?: string;
    readonly executionStage?: string;
    readonly startedAt?: number | null;
    readonly endedAt?: number | null;
    readonly exitCode?: number | null;
    readonly durationMs?: number | null;
  } = {},
): void {
  const id = overrides.id ?? `attempt-${runId}-1`;
  db(f)
    .prepare(
      `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
        number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest,
        input_ref, status, execution_stage, started_at, ended_at, duration_ms, exit_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      NOW,
      NOW,
      f.box.projectId,
      snapshot.featureId,
      runId,
      snapshot.taskId,
      overrides.ownerId ?? 'owner-a',
      overrides.hostInstanceId ?? 'host-a',
      NOW + 60_000,
      JSON.stringify(snapshot),
      snapshot.digests.snapshotDigest,
      snapshot.group.snapshot.artifactId,
      overrides.status ?? 'executing',
      overrides.executionStage ?? 'runtime',
      overrides.startedAt === undefined ? NOW : overrides.startedAt,
      overrides.endedAt === undefined ? null : overrides.endedAt,
      overrides.durationMs === undefined ? null : overrides.durationMs,
      overrides.exitCode === undefined ? null : overrides.exitCode,
    );
}

function acquireSlotA(f: SlotFixture): ExecutionSlotClaimRecord {
  return f.box.session.transactWrite('test.f008.acquire', () =>
    f.access.acquireInTransaction(acquireInput(f, 'A')),
  );
}

function releaseSlotA(f: SlotFixture): ExecutionSlotClaimRecord {
  const held = f.access.readActive({ projectId: f.projectId, runId: f.runA.runId });
  if (held === null) throw new Error('fixture expected a held slot for run A');
  return f.box.session.transactWrite('test.f008.release', () =>
    f.access.releaseInTransaction({
      projectId: f.projectId,
      slotId: held.id,
      claimId: held.claimId,
      claimVersion: held.claimVersion,
      ownerId: held.ownerId,
      hostInstanceId: held.hostInstanceId,
    }),
  );
}

function quarantineSlotA(f: SlotFixture): ExecutionSlotClaimRecord {
  const held = f.access.readActive({ projectId: f.projectId, runId: f.runA.runId });
  if (held === null) throw new Error('fixture expected a held slot for run A');
  return f.box.session.transactWrite('test.f008.quarantine', () =>
    f.access.quarantineInTransaction(
      {
        projectId: f.projectId,
        slotId: held.id,
        claimId: held.claimId,
        claimVersion: held.claimVersion,
        ownerId: held.ownerId,
        hostInstanceId: held.hostInstanceId,
      },
      'manual_verification',
    ),
  );
}

/** 业务事实快照（查询前后必须逐表一致）。 */
function factsSnapshot(f: SlotFixture): Record<string, unknown[]> {
  const tables = [
    'runs',
    'run_dispatch_claims',
    'execution_slot_claims',
    'run_dispatch_intents',
    'attempts',
    'tasks',
    'workspace_leases',
    'execution_batches',
    'runtime_start_reservations',
    'task_attempt_reservations',
    'state_events',
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db(f).prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown[],
    ]),
  );
}

/** 两个已授权 Run：A 可持有槽位，B 的认领已核对停止释放（无槽位）。 */
async function openDispatchFixture(): Promise<DispatchFixture> {
  const f = await openSlotFixture();
  releaseClaim(f, f.claimB);
  const runABatchId = (
    db(f).prepare('SELECT batch_id FROM runs WHERE id = ?').get(f.runA.runId) as {
      batch_id: string;
    }
  ).batch_id;
  const runBBatchId = (
    db(f).prepare('SELECT batch_id FROM runs WHERE id = ?').get(f.runB.runId) as {
      batch_id: string;
    }
  ).batch_id;
  const snapshot = publishPreparedInputFixture(
    f.box,
    { batchId: runABatchId, runId: f.runA.runId },
    't-1',
  );
  return { ...f, snapshot, runABatchId, runBBatchId };
}

async function expectPublicError(
  run: () => Promise<unknown>,
  expected: { readonly code: string; readonly operation: string; readonly reason?: string },
): Promise<PublicError> {
  const error = (await run().then(
    (value) => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value)}`);
    },
    (thrown: unknown) => thrown,
  )) as PublicError;
  expect(isPublicError(error)).toBe(true);
  expect(error).toMatchObject({ code: expected.code, operation: expected.operation });
  if (expected.reason !== undefined) {
    expect(error.details?.reason).toBe(expected.reason);
  }
  return error;
}

function byRunId(
  result: Awaited<ReturnType<QueryService['listExecutionDispatchQueue']>>,
  runId: string,
) {
  const record = result.records.find((entry) => entry.runId === runId);
  if (record === undefined) throw new Error(`missing dispatch record for ${runId}`);
  return record;
}

/**
 * 建立第二个项目并持有唯一执行槽位（跨项目摘要用）。只经真实命令路径创建
 * Feature/Run；槽位经真实槽位原语取得。
 */
async function addPeerProjectWithSlot(
  box: BudgetFixture,
): Promise<{ projectId: string; runId: string; claimId: string; slotId: string }> {
  const done = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
    const receipt = await box.submit(operation, payload, extra);
    if (receipt.status !== 'completed') {
      throw new Error(`peer fixture command failed: ${operation} ${JSON.stringify(receipt)}`);
    }
    return receipt.result;
  };
  const registered = (await done(
    'project.register',
    {
      repositoryPath: box.box.repoDirB,
      displayName: 'Peer project',
      description: null,
      labels: [],
    },
    { scope: { kind: 'registration' } },
  )) as { project: { id: string } };
  const projectId = registered.project.id;
  const scope = { kind: 'project', projectId };
  await done(
    'phase.create',
    { id: 'phase-peer-f008', title: 'Peer phase', description: null, labels: [] },
    { scope },
  );
  const imported = (await done(
    'feature.plan.import',
    {
      phaseId: 'phase-peer-f008',
      plan: {
        schemaVersion: 1,
        feature: { title: 'Peer feature', description: null, labels: [], sourceRefs: [] },
        tasks: [
          { id: 't-peer-f008', title: 'Peer task', acceptance: { criteria: ['peer'] }, dependsOn: [] },
        ],
      },
    },
    { scope, expectedRevision: 1 },
  )) as { feature: { id: string } };
  const featureId = imported.feature.id;
  const feature = db({ box })
    .prepare('SELECT revision, plan_digest FROM features WHERE id = ?')
    .get(featureId) as { revision: number; plan_digest: string };
  await done(
    'feature.plan.decide',
    {
      featureId,
      planDigest: feature.plan_digest,
      decision: 'approve',
      reason: 'peer project slot fixture',
    },
    { scope, expectedRevision: feature.revision },
  );
  const preview = await box.services.preview.previewExecution(projectId, {
    featureIds: [featureId],
    budget: { ...BUDGET },
  });
  if (preview.status !== 'ready') {
    throw new Error(`peer fixture preview not ready: ${JSON.stringify(preview)}`);
  }
  const started = await box.submit(
    'execution.start',
    { featureIds: [featureId], budget: { ...BUDGET }, previewDigest: preview.previewDigest },
    { scope },
  );
  if (started.status !== 'accepted' || !('runId' in started)) {
    throw new Error(`peer fixture start failed: ${JSON.stringify(started)}`);
  }
  const runId = started.runId;
  const claimId = 'claim-peer-1';
  const database = box.session.database;
  database
    .prepare(
      'INSERT INTO run_dispatch_claims (id, created_at, project_id, updated_at, feature_id, run_id, ' +
        "claim_version, origin, owner_id, host_instance_id, acquired_at, lease_until, state) " +
        "VALUES (?, ?, ?, ?, ?, ?, 1, 'dispatch', 'owner-peer', 'host-peer', ?, ?, 'held')",
    )
    .run(claimId, NOW, projectId, NOW, featureId, runId, NOW, NOW + 60_000);
  const access = createSqliteExecutionSlotAccess(box.session, { nowUtcMs: () => NOW });
  const slot = box.session.transactWrite('test.f008.peer-slot', () =>
    access.acquireInTransaction({
      projectId,
      featureId,
      runId,
      claimId,
      claimVersion: 1,
      ownerId: 'owner-peer',
      hostInstanceId: 'host-peer',
      leaseUntilUtcMs: NOW + 10_000,
    }),
  );
  return { projectId, runId, claimId, slotId: slot.id };
}

describe('P04-9 / F-008 dispatch queue & execution slot read-only projection', () => {
  it('[case:queue-projection] derives claimed/running/waiting/terminal facts without a second mutable state', async () => {
    const f = await openDispatchFixture();
    try {
      const queries = assembleQueries(f.box);
      const before = factsSnapshot(f);
      const slot = acquireSlotA(f);

      // 已认领：Run queued + held 认领 + held 槽位，尚无 Attempt。
      const claimed = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      expect(claimed.schemaVersion).toBe(WIRE_MESSAGE_SCHEMA_VERSION);
      expect(claimed.scope).toBe('dispatch-queue');
      // 稳定排序：runs.created_at,id 升序（同一夹具时钟下由 id 决胜）。
      expect(claimed.records.map((record) => record.runId)).toEqual(
        [f.runA.runId, f.runB.runId].sort(),
      );
      const claimedA = byRunId(claimed, f.runA.runId);
      expect(claimedA).toMatchObject({
        featureId: f.runA.featureId,
        runStatus: 'queued',
        state: 'claimed',
        blockingReason: null,
        attemptCount: 0,
        activeAttempt: null,
        latestAttempt: null,
      });
      expect(claimedA.claim).toMatchObject({
        claimId: f.claimA,
        claimVersion: 1,
        origin: 'dispatch',
        ownerId: 'owner-a',
        hostInstanceId: 'host-a',
        state: 'held',
        settledAt: null,
        reason: null,
      });
      expect(claimedA.slot).toMatchObject({
        slotId: slot.id,
        slotIndex: 0,
        claimId: f.claimA,
        claimVersion: 1,
        ownerId: 'owner-a',
        state: 'held',
        releasedAt: null,
      });
      expect(claimedA.slot?.leaseUntil).toBe(new Date(NOW + 10_000).toISOString());

      const waitingB = byRunId(claimed, f.runB.runId);
      expect(waitingB).toMatchObject({ state: 'waiting_slot', blockingReason: 'execution_slot_unavailable' });
      // 最近一代认领按历史如实展示（已核对停止释放），但派生状态不得当作活动认领。
      expect(waitingB.claim).toMatchObject({
        claimId: f.claimB,
        state: 'released',
        reason: null,
      });
      expect(waitingB.claim?.settledAt).not.toBeNull();
      expect(waitingB.slot).toBeNull();
      expect(claimed.slots).toEqual({
        capacity: 1,
        activeCount: 1,
        availableCount: 0,
        quarantinedCount: 0,
        projectActiveCount: 1,
        otherProjectActive: false,
      });

      // 执行中：Run running + 匹配 owner/host 的活动 Attempt。
      updateRun(f, f.runA.runId, { status: 'running', startedAt: NOW });
      insertAttempt(f, f.runA.runId, f.snapshot);
      const running = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      const runningA = byRunId(running, f.runA.runId);
      expect(runningA).toMatchObject({
        state: 'running',
        blockingReason: null,
        attemptCount: 1,
        activeAttempt: {
          id: `attempt-${f.runA.runId}-1`,
          taskId: 't-1',
          number: 1,
          status: 'executing',
          executionStage: 'runtime',
          ownerId: 'owner-a',
          executionVersion: 1,
        },
      });
      expect(runningA.startedAt).toBe(new Date(NOW).toISOString());

      // 完成：先核对停止释放槽位，再结算认领；终态复用 Run 领域状态。
      releaseSlotA(f);
      releaseClaim(f, f.claimA);
      updateRun(f, f.runA.runId, { status: 'succeeded', endedAt: NOW + 30_000 });
      const finished = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      expect(byRunId(finished, f.runA.runId)).toMatchObject({
        state: 'succeeded',
        blockingReason: null,
        runStatus: 'succeeded',
      });
      expect(byRunId(finished, f.runA.runId).endedAt).toBe(new Date(NOW + 30_000).toISOString());

      // 查询零写入；关闭并重开数据库后一致（状态来自 SQLite）。
      const stable = factsSnapshot(f);
      const repeated = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      expect(repeated).toEqual(finished);
      expect(factsSnapshot(f)).toEqual(stable);
      expect(factsSnapshot(f).state_events).toEqual(before.state_events);

      f.reopen();
      const reopened = await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      expect(reopened).toEqual(finished);
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:blocking-reasons] explains recovery isolation, control states and unknown evidence', async () => {
    const f = await openDispatchFixture();
    try {
      updateRun(f, f.runA.runId, { status: 'running', startedAt: NOW });
      insertAttempt(f, f.runA.runId, f.snapshot);
      acquireSlotA(f);

      // 暂停/取消/中断优先复用 Run 领域状态（不被认领/槽位事实覆盖）。
      updateRun(f, f.runA.runId, { status: 'paused', pauseRequestedAt: NOW });
      const paused = byRunId(
        await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
        f.runA.runId,
      );
      expect(paused).toMatchObject({ state: 'paused', blockingReason: 'run_paused' });
      expect(paused.pauseRequestedAt).toBe(new Date(NOW).toISOString());

      updateRun(f, f.runA.runId, { status: 'pausing' });
      expect(
        byRunId(
          await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
          f.runA.runId,
        ),
      ).toMatchObject({ state: 'pausing', blockingReason: 'run_paused' });

      updateRun(f, f.runA.runId, { status: 'cancelling' });
      expect(
        byRunId(
          await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
          f.runA.runId,
        ),
      ).toMatchObject({ state: 'cancelling', blockingReason: 'run_cancelling' });

      updateRun(f, f.runA.runId, { status: 'interrupted' });
      expect(
        byRunId(
          await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
          f.runA.runId,
        ),
      ).toMatchObject({ state: 'interrupted', blockingReason: 'run_interrupted' });

      // 恢复隔离：隔离认领只呈现为需人工核对的阻塞原因，不伪造已停止。
      updateRun(f, f.runA.runId, { status: 'running' });
      quarantineClaim(f, f.claimA);
      const quarantined = byRunId(
        await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
        f.runA.runId,
      );
      expect(quarantined).toMatchObject({ state: 'blocked', blockingReason: 'claim_quarantined' });
      expect(quarantined.claim).toMatchObject({
        state: 'quarantined',
        reason: 'manual_verification',
        settledAt: new Date(NOW).toISOString(),
      });
      expect(quarantined.slot).toMatchObject({ state: 'held', releasedAt: null });
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:slot-quarantine-expiry] reports slot isolation and unverified lease expiry without stop claims', async () => {
    const f = await openDispatchFixture();
    try {
      updateRun(f, f.runA.runId, { status: 'running', startedAt: NOW });
      insertAttempt(f, f.runA.runId, f.snapshot);
      acquireSlotA(f);
      quarantineSlotA(f);

      const result = byRunId(
        await assembleQueries(f.box).listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
        f.runA.runId,
      );
      expect(result).toMatchObject({ state: 'blocked', blockingReason: 'slot_quarantined' });
      expect(result.slot).toMatchObject({
        state: 'quarantined',
        reason: 'manual_verification',
        releasedAt: null,
      });
      expect(result.claim).toMatchObject({ state: 'held', settledAt: null });
      // 未知停止证据保持 null（不因隔离就声明已停止或已通过）。
      expect(result.endedAt).toBeNull();
      expect(result.slot?.releasedAt).toBeNull();
    } finally {
      f.close();
    }

    const expired = await openDispatchFixture();
    try {
      updateRun(expired, expired.runA.runId, { status: 'running', startedAt: NOW });
      insertAttempt(expired, expired.runA.runId, expired.snapshot);
      acquireSlotA(expired);
      const later = assembleQueries(expired.box, { now: NOW + 120_000 });
      const result = byRunId(
        await later.listExecutionDispatchQueue(expired.box.owner, { projectId: expired.projectId }),
        expired.runA.runId,
      );
      expect(result).toMatchObject({
        state: 'blocked',
        blockingReason: 'claim_lease_expired_unverified',
      });
      expect(result.endedAt).toBeNull();
      expect(result.claim?.settledAt).toBeNull();
    } finally {
      expired.close();
    }
  }, 60_000);

  it('[case:runtime-assembly] distinguishes slot capacity from an unassembled Runtime', async () => {
    const f = await openDispatchFixture();
    try {
      // Runtime 未装配：Run 持久原因可查询；槽位额度可用 => 不是容量阻塞。
      updateRun(f, f.runB.runId, { reason: 'scheduler_not_assembled' });
      const queries = assembleQueries(f.box);
      const idle = await queries.listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId });
      const idleB = byRunId(idle, f.runB.runId);
      expect(idleB).toMatchObject({
        runReason: 'scheduler_not_assembled',
        state: 'queued',
        blockingReason: null,
      });
      expect(idle.slots).toMatchObject({ availableCount: 1, activeCount: 0 });

      // 容量限制：同一槽位被占用后变成等待，原因与 Runtime 未装配独立可辨。
      acquireSlotA(f);
      const busy = await queries.listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId });
      const busyB = byRunId(busy, f.runB.runId);
      expect(busyB).toMatchObject({
        runReason: 'scheduler_not_assembled',
        state: 'waiting_slot',
        blockingReason: 'execution_slot_unavailable',
      });
      expect(busy.slots).toMatchObject({ capacity: 1, activeCount: 1, availableCount: 0 });
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:cross-project-summary] reports another project busy without leaking its identity', async () => {
    const f = await openDispatchFixture();
    try {
      const peer = await addPeerProjectWithSlot(f.box);
      const queries = assembleQueries(f.box);
      const result = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      expect(result.slots).toEqual({
        capacity: 1,
        activeCount: 1,
        availableCount: 0,
        quarantinedCount: 0,
        projectActiveCount: 0,
        otherProjectActive: true,
      });
      const record = byRunId(result, f.runB.runId);
      expect(record).toMatchObject({
        state: 'waiting_slot',
        blockingReason: 'execution_slot_unavailable',
      });
      // 跨项目槽位只给摘要：不出现另一项目的项目/Run/认领/owner/host 身份。
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(peer.projectId);
      expect(serialized).not.toContain(peer.runId);
      expect(serialized).not.toContain(peer.claimId);
      expect(serialized).not.toContain(peer.slotId);
      expect(serialized).not.toContain('owner-peer');
      expect(serialized).not.toContain('host-peer');
      expect(serialized).not.toContain('Peer feature');
      expect(serialized).not.toContain('Peer project');
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:pagination-cursor] bounds pages and rejects bad, cross-project and cross-root cursors', async () => {
    const f = await openDispatchFixture();
    try {
      const queries = assembleQueries(f.box);
      const all = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
      });
      expect(all.limit).toBe(PLAN_LIST_DEFAULT_LIMIT);
      expect(all.nextCursor).toBeNull();
      const ordered = [f.runA.runId, f.runB.runId].sort();
      expect(all.records.map((record) => record.runId)).toEqual(ordered);

      const page1 = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
        limit: 1,
      });
      expect(page1.records.map((record) => record.runId)).toEqual([ordered[0]]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
        limit: 1,
        cursor: page1.nextCursor,
      });
      expect(page2.records.map((record) => record.runId)).toEqual([ordered[1]]);
      expect(page2.nextCursor).toBeNull();

      const max = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
        limit: PLAN_LIST_MAX_LIMIT,
      });
      expect(max.limit).toBe(PLAN_LIST_MAX_LIMIT);
      expect(max.records.map((record) => record.runId)).toEqual(all.records.map((record) => record.runId));

      await expectPublicError(
        () => queries.listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId, limit: 0 }),
        { code: 'invalid_input', operation: OPERATION },
      );
      await expectPublicError(
        () =>
          queries.listExecutionDispatchQueue(f.box.owner, {
            projectId: f.projectId,
            limit: PLAN_LIST_MAX_LIMIT + 1,
          }),
        { code: 'invalid_input', operation: OPERATION },
      );
      await expectPublicError(
        () =>
          queries.listExecutionDispatchQueue(f.box.owner, {
            projectId: f.projectId,
            actorId: 'attacker',
          }),
        { code: 'invalid_input', operation: OPERATION },
      );
      await expectPublicError(
        () =>
          queries.listExecutionDispatchQueue(f.box.owner, {
            projectId: f.projectId,
            cursor: 'not-a-cursor',
          }),
        { code: 'invalid_input', operation: OPERATION, reason: 'invalid_cursor' },
      );

      // 跨项目游标：项目 A 签发的游标用于项目 B 一律 invalid_cursor。
      const peer = await addPeerProjectWithSlot(f.box);
      await expectPublicError(
        () =>
          queries.listExecutionDispatchQueue(f.box.owner, {
            projectId: peer.projectId,
            limit: 1,
            cursor: page1.nextCursor,
          }),
        { code: 'invalid_input', operation: OPERATION, reason: 'invalid_cursor' },
      );

      // 跨数据根游标：同一请求在另一数据根装配下拒绝。
      const otherRoot = assembleQueries(f.box, {
        dataRootIdentity: computeDataRootIdentity('/tmp/shiploop-other-data-root'),
      });
      await expectPublicError(
        () =>
          otherRoot.listExecutionDispatchQueue(f.box.owner, {
            projectId: f.projectId,
            limit: 1,
            cursor: page1.nextCursor,
          }),
        { code: 'invalid_input', operation: OPERATION, reason: 'invalid_cursor' },
      );
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:authorization-corruption] applies visibility/capability checks and fails closed on corrupt rows', async () => {
    const f = await openDispatchFixture();
    try {
      const queries = assembleQueries(f.box);
      const peer = await addPeerProjectWithSlot(f.box);

      // 不可见项目：与不存在项目同一 forbidden（授权先于读取）。
      const restricted = createRestrictedPrincipal({
        capabilities: ['project.read'],
        projectScope: scopeAllowlist([f.projectId]),
      });
      await expectPublicError(
        () => queries.listExecutionDispatchQueue(restricted, { projectId: peer.projectId }),
        { code: 'forbidden', operation: OPERATION },
      );
      // 无 project.read 能力：先行 forbidden。
      const incapable = createRestrictedPrincipal({
        capabilities: [],
        projectScope: scopeAllowlist([f.projectId]),
      });
      await expectPublicError(
        () => queries.listExecutionDispatchQueue(incapable, { projectId: f.projectId }),
        { code: 'forbidden', operation: OPERATION },
      );
      // 可见项目列表正常；未知项目自然空页（不泄漏存在性）。
      const visible = await queries.listExecutionDispatchQueue(restricted, {
        projectId: f.projectId,
      });
      expect(visible.records.map((record) => record.runId)).toEqual(
        [f.runA.runId, f.runB.runId].sort(),
      );
      const unknown = await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: 'no-such-project',
      });
      expect(unknown.records).toEqual([]);
      expect(unknown.slots.activeCount).toBe(1);

      // 损坏持久行（绕过 DDL CHECK 模拟磁盘损坏）：fail-closed，不折算空结果。
      db(f).pragma('ignore_check_constraints = ON');
      db(f).prepare("UPDATE run_dispatch_claims SET state = 'bogus' WHERE id = ?").run(f.claimA);
      db(f).pragma('ignore_check_constraints = OFF');
      await expectPublicError(
        () => queries.listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId }),
        { code: 'corrupt_state', operation: OPERATION, reason: 'corrupt_state' },
      );
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:read-only-redaction] repeated reads never write and never expose bodies, secrets or paths', async () => {
    const f = await openDispatchFixture();
    try {
      updateRun(f, f.runA.runId, { status: 'running', startedAt: NOW });
      insertAttempt(f, f.runA.runId, f.snapshot);
      acquireSlotA(f);
      const queries = assembleQueries(f.box);
      const before = factsSnapshot(f);
      const first = await queries.listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId });
      await queries.listExecutionDispatchQueue(f.box.owner, { projectId: f.projectId });
      await queries.listExecutionDispatchQueue(f.box.owner, {
        projectId: f.projectId,
        limit: 1,
      });
      expect(factsSnapshot(f)).toEqual(before);

      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain(f.box.box.repoDirA);
      expect(serialized).not.toContain(f.box.box.repoDirB);
      expect(serialized).not.toContain(f.box.box.dataRoot);
      expect(serialized).not.toContain(f.box.box.root);
      expect(serialized).not.toContain(f.snapshot.group.prompt.locator);
      expect(serialized).not.toContain(f.snapshot.digests.permissionsDigest);
      expect(serialized).not.toContain('SELECT ');
      expect(first.records[0]).not.toHaveProperty('inputSnapshot');
      expect(first.records[0]).not.toHaveProperty('configSnapshot');
      expect(first.records[0]).not.toHaveProperty('processIdentity');
      // 凭据形态不进入投影（无 token/apiKey/authorization 字段）。
      for (const record of first.records) {
        expect(record).not.toHaveProperty('apiKey');
        expect(record).not.toHaveProperty('token');
        expect(record).not.toHaveProperty('authorization');
      }
    } finally {
      f.close();
    }
  }, 60_000);
});
