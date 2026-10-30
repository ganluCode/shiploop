/**
 * P05-1 / F-005 planning Run 原子认领存储原语（adapters/sqlite 层）。
 *
 * 设计依据：ports/planning-claim.ts（契约）、core-design/04 §2（原子认领）、
 * §3（planning Task 使用已确认规划输入，不要求业务计划批准）、core-design/15
 * §2/§3（复用 Run 级认领、单执行槽位与三组资源租约；资源获取次序与编码认领
 * 一致）。实施约束：现有 claimTask 只接收 kind=coding——本存储是**独立 planning
 * 分支**，前置校验以规划上下文/规划输入/策略副本/权限面为权威，不是删除编码
 * 审批检查后的复用；不开放多 Feature 并发门控与额度。
 *
 * 一次 claimPlanningTask 调用 = 一个自有 BEGIN IMMEDIATE 短同步写事务：
 * 1. 同 claimKey 幂等重放（请求摘要一致返回原回执，零新增写入）；
 * 2. 事务内重核（全部 fail-closed，任一失败整组回滚）：
 *    Run（purpose=plan、queued/running、无暂停意图、Run 尝试上限）、Batch
 *    （queued/running、无暂停意图、deadline/预算）、Project active、Phase open、
 *    Feature 非终态且计划摘要未漂移、规划上下文 open 且身份绑定一致、planning
 *    Task（kind=planning、pending、无人工阻塞、revision/executionVersion CAS、
 *    无仍活动历史 Attempt）、inputDigest 重算、策略副本/权限面内容身份、三正文与
 *    必需输入逐条 ready 制品身份、项目 Work 排他（workspace 租约/基线占用）；
 * 3. 写入次序与编码认领一致：Task CAS → Attempt 插入 → 预算预占 → Run 级认领
 *    +槽位 → 三组资源租约 → task.claimed 事件 → 认领回执；
 * 4. Runtime 启动只允许在事务提交之后（本模块不含任何进程/Git/模型 I/O；
 *    不持 Git 短锁、不在事务内等待模型）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mergeEffectiveSettings } from '../../application/effective-settings.js';
import { computePlanningInputDigest } from '../../ports/planning-candidates.js';
import { validateAttemptRecord, validateWorkspaceLeaseRecord } from '../../ports/attempt-store.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { TASK_CLAIMED_EVENT_TYPE } from '../../ports/execution-store.js';
import {
  evaluateRunBudgetReservation,
} from '../../ports/execution-budget.js';
import {
  TRUSTED_PROJECT_PERMISSIONS_READER,
  type ExecutionPermissionsReader,
} from '../../ports/execution-input-prepare.js';
import {
  computePlanningPermissionsDigest,
  computePlanningStrategyCopyDigest,
} from '../../ports/planning-input-prepare.js';
import { PLANNING_RUN_PURPOSE } from '../../ports/planning-candidates.js';
import {
  PLANNING_CLAIM_OPERATION,
  validatePlanningClaimInput,
} from '../../ports/planning-claim.js';
import type { PlanningClaimStore } from '../../ports/planning-claim.js';
import type { TaskClaimReceipt } from '../../ports/task-claim.js';
import { validateTaskClaimDispatch, validateTaskClaimLaunch } from '../../ports/task-claim.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId } from '../../ports/validation.js';
import type { WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import type { MaintenanceWriteGate } from '../../ports/data-maintenance.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteAttemptDispatchAccess } from './attempt-dispatch.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqlitePlanAccess } from './plan-store.js';
import { createSqlitePlanningContextStore } from './planning-context-store.js';
import { createSqliteStateAccess } from './state-store.js';
import { createSqliteWorkResourceAccess } from './work-resources.js';
import type { SqliteStorageSession } from './session.js';

const operation = PLANNING_CLAIM_OPERATION;

/** Feature 终态（不可再认领规划）。 */
const FEATURE_TERMINAL_STATUSES = ['completed', 'partial', 'failed'] as const;

/** No workspace preparation, Git, process or Runtime I/O belongs in this adapter. */
export function createSqlitePlanningClaimStore(session: SqliteStorageSession, options: {
  /** P07-3：同一短写事务内的维护占用资格检查。 */
  readonly maintenanceGate?: MaintenanceWriteGate;
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  /** Trusted startup gate, checked inside the committing claim transaction. */
  readonly assertCanClaim?: () => void;
  /** Trusted synchronous in-memory policy reader; must not perform external I/O. */
  readonly permissions?: ExecutionPermissionsReader;
  readonly nowUtcMs?: () => number;
}): PlanningClaimStore {
  const db = session.database;
  const attempts = createSqliteAttemptAccess(session);
  const clock = options.nowUtcMs ?? Date.now;
  const fail = (reason: string, extra: Record<string, unknown> = {}): never => {
    throw new StorageError('conflict', operation, `Planning claim rejected: ${reason}`, { details: { reason, ...extra } });
  };
  const notReady = (eligibility: string): never => fail('not_ready', { eligibility });

  function readReceipt(json: string): TaskClaimReceipt {
    try {
      const context = { operation };
      const value = requirePlainObject(JSON.parse(json), context, 'receipt');
      rejectUnknownKeys(value, ['schemaVersion', 'claimKey', 'batchId', 'attempt', 'taskRevision',
        'reservationId', 'leases', 'counts', 'eventId', 'launch', 'dispatch'], context, 'receipt');
      for (const field of ['claimKey', 'batchId', 'reservationId', 'eventId']) validateStableId(value[field], context, field);
      requirePlainObject(value.counts, context, 'counts');
      const raw = value as unknown as TaskClaimReceipt;
      const attempt = validateAttemptRecord(raw.attempt);
      const leases = raw.leases.map(validateWorkspaceLeaseRecord);
      if (raw.schemaVersion !== 1 || typeof raw.claimKey !== 'string' || typeof raw.batchId !== 'string'
        || typeof raw.reservationId !== 'string' || typeof raw.eventId !== 'string'
        || !Number.isSafeInteger(raw.taskRevision) || raw.taskRevision < 1
        || Object.keys(raw.counts).sort().join(',') !== 'batchAttempts,codeAttempts,runAttempts,taskAttempts'
        || Object.values(raw.counts).some(n => !Number.isSafeInteger(n) || n < 0)
        || raw.counts.taskAttempts !== attempt.number
        || raw.counts.codeAttempts > raw.counts.taskAttempts
        || raw.counts.runAttempts > raw.counts.batchAttempts
        || attempt.status !== 'preparing'
        || leases.length !== 3 || leases[0]?.resourceKey !== 'global:execution'
        || leases[1]?.resourceKey !== `project:${attempt.projectId}:work`
        || leases.map(l => l.resourceKind).join(',') !== 'global,project,workspace'
        || leases.some(l => l.owner !== attempt.id || l.projectId !== attempt.projectId
          || l.hostInstanceId !== attempt.hostInstanceId || l.executionVersion !== attempt.executionVersion
          || l.leaseUntilUtcMs !== attempt.leaseUntilUtcMs || l.state !== 'held')) throw new Error('invalid_receipt');
      return { ...raw, attempt, leases,
        ...(raw.dispatch === undefined ? {} : { dispatch: validateTaskClaimDispatch(raw.dispatch) }),
        ...(raw.launch === undefined ? {} : { launch: validateTaskClaimLaunch(raw.launch, context, 'receipt.launch') }) };
    } catch (cause) {
      throw new StorageError('corrupt', operation, 'Invalid persisted planning claim receipt', { cause });
    }
  }

  return {
    claimPlanningTask(input) {
      // A savepoint cannot issue a committed receipt to its caller.
      if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
      if (db.inTransaction) throw new TypeError('claimPlanningTask must own its committing transaction');
      const valid = validatePlanningClaimInput(input, token => options.workspaceAuthority.inspect(token));
      const requestDigest = createHash('sha256').update(stableStringify(valid)).digest('hex');
      try {
        return session.transactWrite(operation, () => {
          /* 1) 幂等重放：同 claimKey 同请求摘要返回原回执（证据，不是新授权）。 */
          const existing = db.prepare<[string], { project_id: string; attempt_id: string; request_digest: string; receipt: string }>(
            'SELECT project_id, attempt_id, request_digest, receipt FROM task_claim_receipts WHERE id = ?',
          ).get(valid.claimKey);
          if (existing) {
            if (existing.project_id !== valid.projectId || existing.request_digest !== requestDigest) fail('claim_key_reused');
            const receipt = readReceipt(existing.receipt);
            if (receipt.claimKey !== valid.claimKey || receipt.attempt.id !== existing.attempt_id
              || receipt.attempt.projectId !== valid.projectId || receipt.attempt.runId !== valid.runId
              || receipt.attempt.taskId !== valid.taskId || receipt.attempt.owner !== valid.owner
              || receipt.attempt.hostInstanceId !== valid.hostInstanceId
              || receipt.attempt.executionVersion !== valid.executionVersion + 1
              || receipt.attempt.leaseUntilUtcMs !== valid.leaseUntilUtcMs
              || !isDeepStrictEqual(receipt.attempt.inputSnapshot, valid.inputSnapshot)
              || !isDeepStrictEqual(receipt.launch, valid.launch)) {
              throw new StorageError('corrupt', operation, 'Planning claim receipt identity mismatch');
            }
            return { replayed: true, receipt };
          }
          options.assertCanClaim?.();
          options.maintenanceGate?.assertCanWrite('planning');
          const now = clock();
          if (!Number.isSafeInteger(now) || now < 1) throw new StorageError('validation', operation, 'Invalid claim clock');
          if (valid.leaseUntilUtcMs <= now) throw new StorageError('validation', operation, 'Expired new claim lease');

          /* 2) 一致读视图（同一事务内权威读）：规划上下文 + planning Task 业务字段
           *    + Feature 当前身份 + 规划 Run 冻结请求快照。 */
          const planningContexts = createSqlitePlanningContextStore(session, { nowUtcMs: () => now });
          const view = planningContexts.readPlanningInputPreparationView(valid.projectId, valid.runId);
          if (view === undefined || view.run.purpose !== PLANNING_RUN_PURPOSE) return notReady('planning_identity_mismatch');
          const context = view.context;
          const basis = view.run.inputSnapshot;
          /* 身份绑定：上下文/Task/Run/快照四方一致（任一漂移都是 not_ready）。 */
          if (context.runId !== valid.runId || context.planningTaskId !== valid.taskId
            || view.planningTask.id !== valid.taskId || view.planningTask.kind !== 'planning'
            || valid.inputSnapshot.taskId !== valid.taskId || valid.inputSnapshot.runId !== valid.runId
            || valid.inputSnapshot.projectId !== valid.projectId || valid.inputSnapshot.featureId !== view.feature.id
            || valid.inputSnapshot.phaseId !== context.phaseId || valid.inputSnapshot.candidateId !== context.candidateId
            || basis.candidateId !== context.candidateId) return notReady('planning_identity_mismatch');

          /* 3) Run/Batch 控制状态与预算重核（不因暂停/取消/终态重开）。 */
          const execution = createSqliteExecutionAccess(session, { nowUtcMs: () => now });
          const run = execution.getExecutionRunInTransaction(valid.projectId, valid.runId);
          const batch = execution.getExecutionBatchInTransaction(valid.projectId, run.batchId);
          if (run.purpose !== PLANNING_RUN_PURPOSE) return notReady('task_outside_scope');
          if (run.pauseRequestedAtUtcMs !== null || !['queued', 'running'].includes(run.status)) return notReady('run_control_blocked');
          if (batch.pauseRequestedAtUtcMs !== null || !['queued', 'running'].includes(batch.status)) return notReady('batch_control_blocked');
          if (now >= batch.deadlineAtUtcMs) fail('budget_exhausted');
          if (valid.leaseUntilUtcMs > batch.deadlineAtUtcMs) fail('lease_exceeds_deadline');
          if (run.attemptsCreated >= run.maxAttemptsPerRun) fail('budget_exhausted');
          if (!evaluateRunBudgetReservation(run, run, now).allowed) fail('budget_exhausted');
          /* Batch 层额度按认领语义重核（与编码 DAG 的 exhausted 同一维度：Run 已创建，
           * 不因 runsCreated 达到 maxRuns 拒绝本 Run 内的 Attempt；权威扣减由
           * reserveTaskAttemptInTransaction 在同事务内执行）。 */
          const batchLimits = batch.budgetSnapshot.batch;
          if (batch.attemptsCreated >= batchLimits.maxTotalAttempts
            || batch.noProgressRuns >= batchLimits.maxNoProgressRuns
            || now >= batchLimits.deadlineUtcMs) fail('budget_exhausted');

          /* 4) Project/Phase/Feature 归属与版本重核。 */
          const state = createSqliteStateAccess(session);
          if (state.getProject(valid.projectId).status !== 'active') return notReady('project_not_active');
          if (createSqlitePlanAccess(session).getPhaseInTransaction(valid.projectId, context.phaseId).status !== 'open') return notReady('phase_not_open');
          if ((FEATURE_TERMINAL_STATUSES as readonly string[]).includes(view.feature.status)) return notReady('feature_terminal');
          if (view.feature.planDigest !== context.planDigest) return notReady('feature_plan_drift');

          /* 5) 规划上下文状态：候选已发布/已决策/取消后不再接受认领。 */
          if (context.status !== 'open') return notReady('planning_context_not_open');

          /* 6) planning Task 行级事实（kind/status/人工阻塞/CAS；编码 DAG 不参与）。 */
          const taskRow = db.prepare<[string], { kind: string; status: string; manual_block: number;
            execution_version: number; revision: number; attempt_counter: number }>(
            'SELECT kind, status, manual_block, execution_version, revision, attempt_counter FROM tasks WHERE id = ?',
          ).get(valid.taskId);
          if (!taskRow) return notReady('planning_identity_mismatch');
          if (taskRow.kind !== 'planning') return notReady('task_outside_scope');
          if (taskRow.status !== 'pending' || taskRow.manual_block !== 0) return notReady('planning_task_not_pending');
          if (taskRow.revision !== valid.expectedRevision || taskRow.execution_version !== valid.executionVersion) fail('stale_task');
          /* 首次规划认领：仍活动的历史 Attempt 一律拒绝。P05-1 / F-010：重启核对
           * /恢复补完后的 planning Task 回到 pending 且占用已收口，此时允许用户
           * 显式 resume 后的新 Attempt（受 Run 尝试上限、项目排他与上下文状态
           * 门控约束；不重置计数、不绕过 deadline）。 */
          const history = attempts.listTaskAttempts(valid.projectId, valid.taskId);
          if (history.some(attempt => ['preparing', 'executing', 'verifying'].includes(attempt.status))) {
            return notReady('planning_attempt_history_present');
          }
          if ([taskRow.execution_version, taskRow.attempt_counter, taskRow.revision, batch.attemptsCreated,
            batch.revision, run.attemptsCreated, run.revision].some(n => n >= Number.MAX_SAFE_INTEGER - 2)) {
            fail('counter_overflow');
          }

          /* 7) 输入与策略摘要重核（事务内权威；无业务计划批准要求）。 */
          if (computePlanningInputDigest({
            projectId: context.projectId, phaseId: context.phaseId, featureId: context.featureId,
            requirementRefs: [...view.planningTask.requirementsRefs],
            constraints: [...basis.constraints],
            acceptance: { criteria: [...basis.acceptance.criteria] },
            strategy: { approvalMode: basis.strategy.approvalMode, taskLimit: basis.strategy.taskLimit },
          }) !== context.inputDigest) return notReady('input_digest_mismatch');
          if (computePlanningStrategyCopyDigest({
            executionConfig: view.planningTask.executionConfig as unknown as Readonly<Record<string, unknown>>,
            configSource: view.planningTask.configSource,
            configSourceKey: view.planningTask.configSourceKey,
          }) !== valid.inputSnapshot.digests.strategyCopyDigest) return notReady('strategy_copy_changed');
          const face = (options.permissions ?? TRUSTED_PROJECT_PERMISSIONS_READER)({
            projectId: valid.projectId, featureId: view.feature.id, taskId: valid.taskId,
          });
          if (!face || !Array.isArray(face.grants) || face.grants.length > 256
            || face.grants.some(g => typeof g !== 'string' || g.length > 256)) {
            throw new StorageError('validation', operation, 'Invalid trusted permissions face');
          }
          if (computePlanningPermissionsDigest(face.grants) !== valid.inputSnapshot.digests.permissionsDigest) {
            return notReady('permissions_changed');
          }
          /* 制品身份：三正文 + 必需输入逐条 ready 且身份一致；必需输入集合与
           * planning Task 持久需求引用解析后的当前索引身份一致。 */
          const artifactRef = db.prepare('SELECT id FROM artifacts WHERE project_id = ? AND id = ? AND status = ? AND version = ? AND content_hash = ? AND size_bytes = ? AND storage_locator = ? AND media_type = ?');
          for (const ref of [valid.inputSnapshot.group.snapshot, valid.inputSnapshot.group.manifest, valid.inputSnapshot.group.prompt, ...valid.inputSnapshot.requiredInputs]) {
            if (!artifactRef.get(valid.projectId, ref.artifactId, 'ready', ref.version, ref.contentHash, ref.sizeBytes, ref.locator, ref.mediaType)) {
              return notReady('input_artifact_changed');
            }
          }
          const plans = createSqlitePlanAccess(session);
          const required = [...new Map(view.planningTask.requirementsRefs.map(ref => [ref.artifactId, ref])).values()]
            .map(ref => {
              const resolved = plans.getArtifactInputRefInTransaction(valid.projectId, ref.artifactId);
              return { artifactId: resolved.artifactId, version: resolved.version, contentHash: resolved.contentHash };
            })
            .sort((a, b) => a.artifactId < b.artifactId ? -1 : 1);
          const supplied = valid.inputSnapshot.requiredInputs.map(ref => ({ artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash }))
            .sort((a, b) => a.artifactId < b.artifactId ? -1 : 1);
          if (!isDeepStrictEqual(required, supplied)) return notReady('required_inputs_changed');

          /* 8) 项目 Work 排他（held/quarantined 占用一律阻止；编码认领同语义）。 */
          if (db.prepare('SELECT id FROM workspace_leases LIMIT 1').get()
            || db.prepare('SELECT id FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL LIMIT 1').get()) {
            fail('resource_busy');
          }

          /* 9) 原子写入（次序与编码认领一致；任一步失败整组回滚）。 */
          const attemptId = randomUUID();
          const executionVersion = taskRow.execution_version + 1;
          const number = taskRow.attempt_counter + 1;
          const changed = db.prepare("UPDATE tasks SET status = 'running', execution_version = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ? AND execution_version = ? AND status = 'pending' AND manual_block = 0 AND kind = 'planning'")
            .run(executionVersion, now, valid.taskId, valid.projectId, valid.expectedRevision, valid.executionVersion);
          if (changed.changes !== 1) fail('stale_task');
          db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, revision, feature_id, run_id, task_id,
            number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(attemptId, now, now, valid.projectId, view.feature.id, valid.runId, valid.taskId, number,
              valid.owner, valid.hostInstanceId, executionVersion, valid.leaseUntilUtcMs,
              JSON.stringify(valid.inputSnapshot), valid.inputSnapshot.digests.snapshotDigest, valid.inputSnapshot.group.snapshot.artifactId);
          const globalSettings = state.getGlobalSettingsOrNull();
          const projectSettings = state.getProjectSettingsOrNull(valid.projectId);
          const maxAttemptsPerTask = mergeEffectiveSettings({
            ...(globalSettings === null ? {} : { global: { scopeRevision: globalSettings.revision, payload: globalSettings.payload } }),
            ...(projectSettings === null ? {} : { project: { scopeRevision: projectSettings.revision, payload: projectSettings.payload } }),
          }).policies.executionLimits?.value.maxAttemptsPerTask ?? null;
          const reservation = execution.reserveTaskAttemptInTransaction({ projectId: valid.projectId, batchId: batch.id,
            runId: valid.runId, taskId: valid.taskId, attemptKey: attemptId, ...(maxAttemptsPerTask === null ? {} : { maxAttemptsPerTask }) });
          const dispatch = createSqliteAttemptDispatchAccess(session, { nowUtcMs: () => now })
            .acquireInTransaction(attempts.getAttempt(valid.projectId, attemptId), valid.dispatch);
          const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: options.workspaceAuthority, nowUtcMs: () => now });
          const occupied = resources.acquireInTransaction({ projectId: valid.projectId, attemptId,
            owner: valid.owner, hostInstanceId: valid.hostInstanceId, executionVersion }, valid.workspace, valid.leaseUntilUtcMs);
          const counters = execution.getTaskExecutionCountersInTransaction(valid.projectId, valid.taskId);
          const eventId = execution.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: TASK_CLAIMED_EVENT_TYPE,
            aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { claimed: true } });
          const receipt: TaskClaimReceipt = { schemaVersion: 1, dispatch, claimKey: valid.claimKey, batchId: batch.id,
            attempt: attempts.getAttempt(valid.projectId, attemptId), taskRevision: counters.revision,
            reservationId: reservation.id, leases: occupied.leases, counts: { batchAttempts: batch.attemptsCreated + 1,
              runAttempts: run.attemptsCreated + 1, taskAttempts: counters.attemptCounter, codeAttempts: counters.codeAttemptsUsed },
            ...(valid.launch === undefined ? {} : { launch: { ...valid.launch, parentSessionId: valid.launch.parentSessionId ?? null } }), eventId };
          db.prepare('INSERT INTO task_claim_receipts (id, project_id, attempt_id, request_digest, receipt) VALUES (?, ?, ?, ?, ?)')
            .run(valid.claimKey, valid.projectId, attemptId, requestDigest, JSON.stringify(receipt));
          return { replayed: false, receipt };
        });
      } catch (error) {
        if (error instanceof StorageError || error instanceof TypeError) throw error;
        if (typeof (error as { code?: unknown })?.code === 'string'
          && String((error as { code: string }).code).startsWith('SQLITE_CONSTRAINT')) {
          throw new StorageError('conflict', operation, 'Planning claim transaction rejected by a persistence constraint', {
            details: { reason: 'claim_constraint' }, cause: error,
          });
        }
        throw error;
      }
    },
  };
}
