/** Trusted Work composition. No adapter discovery, module loading, environment or SDK. */
import { createHash, randomUUID } from 'node:crypto';
import type { CoreApplication } from './composition.js';
import type { SqliteStorageSession } from './sqlite/session.js';
import { createSqliteSchedulerStore } from './sqlite/scheduler-store.js';
import { createSqliteFeatureDagStore } from './sqlite/feature-dag-store.js';
import { closeSucceededPlanningBatchInTransaction } from './sqlite/planning-batch-settlement.js';
import { createSqliteTaskDagStore } from './sqlite/task-dag-store.js';
import { createSqliteAttemptAccess } from './sqlite/attempt-store.js';
import { createSqliteVerificationStore } from './sqlite/verification-store.js';
import { createSqliteWorkSessionStore } from './sqlite/work-session-store.js';
import { createSqliteAttemptLifecycleStore } from './sqlite/attempt-lifecycle-store.js';
import { createSqliteWorkResourceAccess } from './sqlite/work-resources.js';
import { createSqliteWorkspaceAccess } from './sqlite/workspace.js';
import { createSqliteWorkspaceRetentionStore } from './sqlite/workspace-retention.js';
import { createSqliteAtomicCommandStore } from './sqlite/atomic-commands.js';
import { createRuntimeInferencePreflight, resolveRuntimeInferencePreflightPolicy } from '../application/runtime-inference-preflight.js';
import type { WorkInferencePreflightAssembly } from '../ports/runtime-inference-preflight.js';
import { decideRuntimeFallback, validateRuntimeFallbackPlan, type RuntimeFallbackPlanV1 } from '../application/runtime-fallback.js';
import { classifyRuntimeExecutionResult } from '../ports/runtime-failure.js';
import type { RuntimeFallbackCapabilityEvidence } from '../ports/runtime-fallback-switch.js';
import type { RuntimeStrategyV1 } from '../ports/settings-schema.js';
import type { TaskClaimReceipt } from '../ports/task-claim.js';
import { createSqliteRuntimeFallbackSwitchService } from './sqlite/runtime-fallback-switch.js';
import { stableStringify } from '../ports/feature-plan.js';
import { validateRuntimeStrategy } from '../ports/settings-schema.js';
import { createWorkScheduler } from '../application/work-scheduler.js';
import { createPlanningDispatchPrepareService } from '../application/planning-dispatch.js';
import { createSqlitePlanningClaimStore } from './sqlite/planning-claim-store.js';
import { createSqlitePlanningContextStore } from './sqlite/planning-context-store.js';
import { transactSqliteConsistentRead } from './sqlite/state-store.js';
import { evaluateTaskDag } from '../application/task-dag.js';
import { createFeatureDagService } from '../application/feature-dag.js';
import { validateTaskExecutionConfig } from '../application/task-strategy-selection.js';
import { DEFAULT_TOOL_TIME_LIMIT_MS, DEFAULT_WORK_TIME_LIMIT_MS, resolveExecutionDeadlines } from '../ports/execution-time-limits.js';
import { WORK_TIMEOUT_MS_MIN } from '../ports/settings-schema.js';
import { createRuntimeExecutionService } from '../application/runtime-execution.js';
import { createExecutionService, type ExecutionService } from '../application/execution-service.js';
import { createExecutionInputBindingService } from '../application/execution-input-binding.js';
import { createArtifactPublisher } from '../application/artifact-publish.js';
import { createArtifactVerifier } from '../application/artifact-verify.js';
import { createWorkEvidenceRecorder, type RecordingMode } from '../application/work-evidence-recorder.js';
import { createWorkRecordingPublisher } from '../application/work-recording-publish.js';
import { createSqliteWorkRecordingStore } from './sqlite/work-recording-store.js';
import { createRuntimeSettlementService } from '../application/runtime-settlement.js';
import { createWorkspaceRetentionService } from '../application/workspace-retention.js';
import { createExecutionWorkspaceRetainer } from '../application/execution-workspace-retention.js';
import { createStaticRuntimeRegistry, type RuntimeRegistryEntry } from '../ports/runtime-registry.js';
import type { RuntimeExecutionRequest } from '../ports/runtime-execution.js';
import { observeWithin } from '../application/execution-supervision.js';
import { StorageError } from '../ports/errors.js';
import type { BoundExecutionInputReader } from '../ports/execution-input-binding.js';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../ports/execution-input-prepare.js';
import { validateRuntimeRecoveryDecision } from '../ports/runtime-recovery.js';
import type { CommandProcessIdentity } from '../ports/command-process.js';
import type { WorkResourceIdentity } from '../ports/work-resources.js';
import { PublicError } from '../ports/commands.js';
import { isFinalizationOnlyRun, type FinalizationExecutionPort } from '../ports/finalization-execution.js';
import type { FinalizationCompletionPort } from '../ports/finalization-completion.js';
import type { createWorkStartupRecovery } from '../application/work-startup-recovery.js';
import { createSqliteRunDispatchSettlement } from './sqlite/dispatch-settlement.js';
import { isPlanningAttemptSnapshot } from '../ports/attempt-store.js';
import { computePlanningStrategyCopyDigest } from '../ports/planning-input-prepare.js';
import { deriveRunDispatchDisplay } from '../ports/execution-dispatch.js';
import type { DispatchAttemptFence, DispatchSettlementResult } from '../ports/dispatch-settlement.js';
import type { ExecutionRunStatus } from '../ports/execution-store.js';

export interface WorkRuntimeContext {
  readonly capabilityCatalog: import('../ports/runtime-capabilities.js').RuntimeCapabilityCatalog;
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly reader: (request: RuntimeExecutionRequest) => BoundExecutionInputReader | undefined;
  readonly commitCommandIdentity: (identity: CommandProcessIdentity, request: RuntimeExecutionRequest) => Promise<{ launchId: string }>;
}
/** Approved Task-local routing, supplied by trusted assembly; authorization is checked on every switch. */
export interface WorkFailureRoutingAssembly {
  select(context: { projectId: string; runId: string; taskId: string; strategy: RuntimeStrategyV1 }): {
    readonly plan: RuntimeFallbackPlanV1;
    readonly policyVersion: string;
    readonly capabilityEvidence: RuntimeFallbackCapabilityEvidence;
  } | undefined;
  authorize(context: { projectId: string; runId: string; taskId: string; source: string; strategy: RuntimeStrategyV1 }): Promise<boolean>;
}

/** A function supplied by trusted code only; never serialized in settings or commands. */
export type WorkRuntimeFactory = (context: WorkRuntimeContext) => {
  readonly entries: readonly RuntimeRegistryEntry[];
  readonly eventIdentityPrefix: (request: RuntimeExecutionRequest) => string;
  readonly prepareRequest?: (request: RuntimeExecutionRequest) => Promise<RuntimeExecutionRequest>;
  readonly inferencePreflight?: WorkInferencePreflightAssembly;
  readonly failureRouting?: WorkFailureRoutingAssembly;
};

export function assembleWorkExecution(options: {
  readonly session: SqliteStorageSession;
  readonly application: Pick<CoreApplication, 'dataRoot' | 'artifactStore' | 'artifactFileStore' | 'stateStore' |
    'configurationService' | 'workWorkspaceAuthority' | 'taskClaims' | 'workspacePreparation' | 'executionInputPrepare' | 'planningInputPrepare'> & {
      readonly runtimeRecovery?: CoreApplication['runtimeRecovery'];
      readonly runtimeRecoveryCatalog?: CoreApplication['runtimeRecoveryCatalog'];
      readonly workRecoveryContinuation?: CoreApplication['workRecoveryContinuation'];
    };
  readonly capabilityCatalog: import('../ports/runtime-capabilities.js').RuntimeCapabilityCatalog;
  readonly runtimeFactory?: WorkRuntimeFactory;
  readonly recordingMode?: RecordingMode;
  readonly nowUtcMs?: () => number;
  readonly startupRecovery: ReturnType<typeof createWorkStartupRecovery>;
  /** P03-9 / F-011：finalization-only Run 在编码认领前分流到受信重验执行。 */
  readonly finalizationExecution?: FinalizationExecutionPort;
  /** P03-9 / F-012：重验 handoff 后继续最终审批/提交/完成（不启动 Runtime）。 */
  readonly finalizationCompletion?: FinalizationCompletionPort;
  /**
   * P05-1 / F-005：planning 回执消费者（回执已提交后调用；Runtime 启动属于
   * 事务外后续，由 F-007 接线真实执行）。未装配时调度器保留 planning_consumer
   * capability gap，不准备规划输入也不认领。
   */
  readonly planningExecution?: {
    consumePlanningClaim(receipt: import('../ports/task-claim.js').TaskClaimReceipt,
      ref: { readonly projectId: string; readonly runId: string }): Promise<void>;
  };
  /** F-012：受信返工现场读取（同 Feature 受管 worktree 的当前身份；无工作区时
   * 返回 null）。由 composition 用受界检查器实现；缺省时不接返工认领。 */
  readonly readReworkScene?: (projectId: string, featureId: string) => Promise<{
    readonly worktreeId: string; readonly headCommit: string; readonly codeDigest: string;
  } | null>;
  /** F-006：派发归属/槽位心跳续租周期（毫秒）；0 关闭周期续租（测试可显式调用）。 */
  readonly heartbeatIntervalMs?: number;
}) {
  const { session, application: app } = options;
  const now = options.nowUtcMs ?? Date.now;
  const owner = randomUUID(), hostInstanceId = randomUUID();
  const attempts = createSqliteAttemptAccess(session);
  const verification = createSqliteVerificationStore(session, options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs });
  const dag = createSqliteTaskDagStore(session);
  const featureDag = createFeatureDagService({ store: createSqliteFeatureDagStore(session) });
  const store = createSqliteSchedulerStore(session, { nowUtcMs: now });
  const sessions = createSqliteWorkSessionStore(session, { nowUtcMs: now });
  const publisher = createArtifactPublisher({ artifacts: app.artifactStore, files: app.artifactFileStore,
    limits: { maxSizeBytes: 16_000_000, timeoutMs: 30_000 } });
  const verifier = createArtifactVerifier({ artifacts: app.artifactStore, files: app.artifactFileStore,
    limits: { maxReadBytes: 16_000_000 } });
  const workspaceRoots = { 'managed-work': app.dataRoot };
  const readers = new Map<string, BoundExecutionInputReader>();
  let execution: ExecutionService;
  const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: app.workWorkspaceAuthority,
    stopVerifier: { inspect: token => execution.stopVerifier.inspect(token) }, nowUtcMs: now });
  // P04-9 / F-006：Run 级派发归属与槽位的收尾/续租（短事务、完整身份 CAS）。
  const dispatchSettlement = createSqliteRunDispatchSettlement(session, { nowUtcMs: now });
  // P05-1 / F-007：planning 生命周期结算（executing/preparation_failed/runtime_settled）。
  const planningLifecycle = createSqliteAttemptLifecycleStore(session, { workspaceAuthority: app.workWorkspaceAuthority, nowUtcMs: now });
  const dispatches = new Map<string, { readonly projectId: string; readonly runId: string;
    readonly claimId: string; readonly claimVersion: number; readonly slotId: string;
    readonly attempt: DispatchAttemptFence }>();
  const settlementNotes = new Map<string, { readonly decision: string; readonly reason: string | null;
    readonly atUtcMs: number }>();
  const runKey = (projectId: string, runId: string) => `${projectId}\u0000${runId}`;
  const DISPATCH_LEASE_MS = 60_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  function settlementReasonOf(error: unknown): string {
    return error instanceof StorageError && typeof error.details?.reason === 'string'
      ? error.details.reason : 'settlement_failed';
  }

  /**
   * 结算一个 Run 的派发归属与槽位。只读事实 + 短写事务；失败保留当前占槽并
   * 记下可解释原因，绝不因调用方结果 Promise 结束而“假定”可以回收。
   * `attempt` 为关联 Attempt 围栏：迟到结果只能命中旧代次并被拒绝。
   */
  function settleRun(projectId: string, runId: string, attempt?: DispatchAttemptFence): DispatchSettlementResult | null {
    let facts: ReturnType<typeof dispatchSettlement.read>;
    try {
      facts = dispatchSettlement.read({ projectId, runId });
    } catch (error) {
      settlementNotes.set(runKey(projectId, runId), { decision: 'failed', reason: settlementReasonOf(error), atUtcMs: now() });
      return null;
    }
    const claim = facts.claim;
    if (claim === null) {
      // 无派发归属也是可解释事实：排队中的暂停/取消尚未产生消费者。
      settlementNotes.set(runKey(projectId, runId), { decision: 'absent', reason: null, atUtcMs: now() });
      return null;
    }
    try {
      const result = session.transactWrite('WorkExecution.settleRun', () => {
        const settled = dispatchSettlement.settleInTransaction({
          projectId, runId,
          expected: { claimId: claim.id, claimVersion: claim.claimVersion,
            ownerId: claim.ownerId, hostInstanceId: claim.hostInstanceId },
          ...(attempt === undefined ? {} : { attempt }),
        });
        if (settled.decision === 'released' || settled.decision === 'replayed') {
          const run = session.database.prepare<[string, string], { batch_id: string; purpose: string }>(
            'SELECT batch_id, purpose FROM runs WHERE project_id = ? AND id = ?',
          ).get(projectId, runId);
          if (run?.purpose === 'plan') closeSucceededPlanningBatchInTransaction(session, projectId, run.batch_id, now());
        }
        return settled;
      });
      settlementNotes.set(runKey(projectId, runId), { decision: result.decision, reason: result.reason, atUtcMs: now() });
      return result;
    } catch (error) {
      settlementNotes.set(runKey(projectId, runId), { decision: 'failed', reason: settlementReasonOf(error), atUtcMs: now() });
      return null;
    }
  }

  function scheduleHeartbeat(): void {
    if (heartbeatTimer !== null || heartbeatIntervalMs <= 0 || closed) return;
    const timer = setTimeout(() => {
      heartbeatTimer = null;
      if (closed) return;
      void heartbeat().catch(() => undefined).finally(() => { scheduleHeartbeat(); });
    }, heartbeatIntervalMs);
    heartbeatTimer = timer;
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  }

  /** 活动执行期间的派发/槽位续租：每次均重核认领身份与关联 Attempt 围栏。 */
  async function heartbeat(): Promise<{ renewed: number; unchanged: number; quarantined: number; failed: number }> {
    const outcome = { renewed: 0, unchanged: 0, quarantined: 0, failed: 0 };
    for (const [attemptId, entry] of [...dispatches]) {
      try {
        const result = session.transactWrite('WorkExecution.renewDispatch', () => dispatchSettlement.renewInTransaction({
          projectId: entry.projectId, runId: entry.runId,
          expected: { claimId: entry.claimId, claimVersion: entry.claimVersion,
            ownerId: entry.attempt.ownerId, hostInstanceId: entry.attempt.hostInstanceId },
          attempt: entry.attempt, leaseUntilUtcMs: now() + DISPATCH_LEASE_MS,
        }));
        if (result.decision === 'renewed') outcome.renewed += 1;
        else if (result.decision === 'unchanged') outcome.unchanged += 1;
        else {
          outcome.quarantined += 1;
          dispatches.delete(attemptId);
          settlementNotes.set(runKey(entry.projectId, entry.runId),
            { decision: 'quarantined', reason: result.reason, atUtcMs: now() });
        }
      } catch (error) {
        outcome.failed += 1;
        const reason = settlementReasonOf(error);
        // 旧代次/旧 Attempt 不再续租：保留当前归属，停止重复尝试。
        if (reason === 'stale_dispatch_identity') dispatches.delete(attemptId);
        settlementNotes.set(runKey(entry.projectId, entry.runId), { decision: 'renew_failed', reason, atUtcMs: now() });
      }
    }
    return outcome;
  }
  const runtimeAssembly = options.runtimeFactory?.({ capabilityCatalog: options.capabilityCatalog, workspaceRoots, reader: request => readers.get(request.invocationId),
    async commitCommandIdentity(processIdentity, request) {
      if (request.identity.purpose !== 'work') throw new TypeError('Work identity required');
      const work = request.identity;
      const confirmation = session.transactWrite('WorkRuntime.confirmCommandIdentity', () => resources.confirmLaunchInTransaction({
        projectId: request.projectId, attemptId: work.attemptId, owner: request.owner.principalId,
        hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion,
      }, processIdentity));
      if (!confirmation.authorized) throw new PublicError('conflict', 'execution.start');
      return { launchId: processIdentity.launchId };
    } });
  const registry = createStaticRuntimeRegistry(runtimeAssembly?.entries ?? [], options.capabilityCatalog);
  type Route = NonNullable<ReturnType<WorkFailureRoutingAssembly['select']>>;
  const preparedRoutes = new Map<string, Route>();
  const routes = new Map<string, Route>();
  let consumeFallbackClaim: (claim: TaskClaimReceipt) => Promise<void>;
  const fallbackSwitch = createSqliteRuntimeFallbackSwitchService(session, {
    workspaceAuthority: app.workWorkspaceAuthority, stopVerifier: resourcesStopVerifier(), nowUtcMs: now,
  });
  const probeAssembly = runtimeAssembly?.inferencePreflight;
  const probePolicy = resolveRuntimeInferencePreflightPolicy(probeAssembly?.policy);
  const probeCancellation = new AbortController();
  const probes = new Map<string, ReturnType<typeof createRuntimeInferencePreflight>>();
  async function checkInference(projectId: string, runId: string, taskId: string, config: unknown) {
    if (!probePolicy.enabled) return;
    const strategy = validateRuntimeStrategy(config, { operation: 'WorkRuntime.inferencePreflight' }, 'strategy');
    const selection = probeAssembly!.select({ projectId, runId, taskId, strategy });
    if (stableStringify(selection.strategy) !== stableStringify(strategy)) {
      throw new StorageError('conflict', 'WorkRuntime.prepare', 'Probe strategy differs from frozen Task strategy', {
        details: { reason: 'inference_preflight_strategy_mismatch' },
      });
    }
    let probe = probes.get(projectId);
    if (!probe) {
      probe = createRuntimeInferencePreflight({ ...probeAssembly!, policy: probePolicy, nowUtcMs: now,
        async audit(record) {
          const body = Buffer.from(JSON.stringify(record));
          await publisher.publishArtifact({ projectId, kind: 'inference_preflight', mediaType: 'application/json',
            expectedHash: createHash('sha256').update(body).digest('hex'),
            locator: `inference-preflight/${record.probeId}/${randomUUID()}.json`, content: [body] });
        },
      });
      if (probes.size >= 256) probes.delete(probes.keys().next().value!);
      probes.set(projectId, probe);
    }
    const decision = await probe.check(selection, probeCancellation.signal);
    if (!decision.dispatchAllowed) throw new StorageError('conflict', 'WorkRuntime.prepare', 'Inference preflight blocked dispatch', {
      details: { reason: `inference_preflight_${decision.reason}` },
    });
  }
  const inputBinding = createExecutionInputBindingService({ artifacts: app.artifactStore, verifier, attempts, resources,
    workspaceAuthority: app.workWorkspaceAuthority, workspaceRoots, publisher, nowMs: now,
    ...(app.runtimeRecoveryCatalog === undefined ? {} : { recoveryCatalog: app.runtimeRecoveryCatalog }),
    ...(app.runtimeRecovery === undefined ? {} : { recovery: app.runtimeRecovery }) });
  const retention = createWorkspaceRetentionService({
    stopVerifier: resourcesStopVerifier(),
    store: createSqliteWorkspaceRetentionStore(session, { resources, workspaceAuthority: app.workWorkspaceAuthority, nowUtcMs: now }),
    async publishEvidence(projectId, operationId, evidence) {
      const body = Buffer.from(JSON.stringify(evidence));
      return (await publisher.publishArtifact({ projectId, kind: 'workspace_evidence', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${operationId}.json`, content: [body] })).artifact.id;
    },
  });
  execution = createExecutionService({ atomic: createSqliteAtomicCommandStore(session, { nowUtcMs: now }), resources, sessions, attempts, dag,
    inputBinding: { async bind(input) { const bound = await inputBinding.bind(input); readers.set(bound.request.invocationId, bound.reader); return bound; } },
    runtime: createRuntimeExecutionService({ configuration: options.capabilityCatalog, registry }),
    settlement: createRuntimeSettlementService({ publisher, attempts, dag, sessions,
      lifecycle: createSqliteAttemptLifecycleStore(session, { workspaceAuthority: app.workWorkspaceAuthority, nowUtcMs: now }) }),
    recorder: createWorkEvidenceRecorder({ publisher, verifier, sessions, recordingMode: options.recordingMode,
      recording: { store: createSqliteWorkRecordingStore(session, { nowUtcMs: now }), nowUtcMs: now,
        publisher: createWorkRecordingPublisher({ artifacts: publisher, limits: {
          maxBodyBytes: 131_072, maxAttachmentBytes: 65_536, maxTotalBytes: 262_144,
          maxChunkBytes: 8192, maxQueueBytes: 8192,
        } }) }, limits: {
      maxEventBodyBytes: 8_192, chunkMaxEvents: 32, chunkMaxBytes: 262_144, maxTotalEvents: 10_000,
      maxTotalBytes: 8_000_000, reorderWindow: 8, tailWaitMs: 2_000,
    } }),
    eventIdentityPrefix: runtimeAssembly?.eventIdentityPrefix ?? (() => 'unregistered.'),
    ...(runtimeAssembly?.prepareRequest === undefined ? {} : { prepareRuntimeRequest: runtimeAssembly.prepareRequest }),
    nowUtcMs: now,
    supervision: { stopWaitMs: 2_000, drainWaitMs: 2_000, closeWaitMs: 5_000,
      retain: createExecutionWorkspaceRetainer({ workspaces: createSqliteWorkspaceAccess(session, { resources, nowUtcMs: now }), retention }),
      async routeFailure(input) {
        const work = input.request.identity;
        if (work.purpose !== 'work') return false;
        const route = routes.get(work.attemptId);
        routes.delete(work.attemptId);
        if (!route || quiescing || input.control && input.control.reason !== 'runtime_failed'
          || input.result.status !== 'fulfilled' || input.result.value.terminal !== 'failed'
          || input.recording?.status !== 'fulfilled' || input.recording.value.status !== 'complete') return false;
        const identity = { projectId: input.request.projectId, attemptId: work.attemptId,
          owner: input.request.owner.principalId, hostInstanceId: input.request.owner.hostInstanceId,
          executionVersion: input.request.executionVersion };
        const previous = attempts.getAttempt(identity.projectId, work.attemptId);
        const failure = classifyRuntimeExecutionResult(input.result.value, {
          errorChain: [{ source: 'sdk', code: input.result.value.reason === 'temporary_server_failure' ? 'server_error' : input.result.value.reason ?? 'unknown',
            message: (input.result.value.reason ?? 'unknown').replace(/_/g, ' ') }],
        });
        if (failure.category === null) return false;
        const pause = (reason = 'all_candidates_unavailable') => {
          const view = dag.readTaskDagView(identity.projectId, work.runId);
          if (view.facts.find(fact => fact.taskId === work.taskId)?.executionVersion !== identity.executionVersion
            || view.run.pauseRequestedAtUtcMs !== null || view.batch.pauseRequestedAtUtcMs !== null) return;
          if (view.run.status === 'running') {
            fallbackSwitch.stop({ pause: { projectId: identity.projectId, targetKind: 'run', targetId: work.runId,
              expectedRevision: view.run.revision }, reason: 'all_candidates_unavailable' });
          } else if (view.run.status !== 'paused' || view.run.reason !== 'runtime_failed') return;
          store.recordRunReason(identity.projectId, work.runId, reason);
        };
        try {
          const authorization: Record<string, 'authorized' | 'denied'> = {};
          for (const candidate of route.plan.fallbacks) {
            authorization[candidate.source] = await observeWithin(runtimeAssembly!.failureRouting!.authorize({
              projectId: identity.projectId, runId: work.runId, taskId: work.taskId,
              source: candidate.source, strategy: candidate.strategy }), 2_000) === true ? 'authorized' : 'denied';
          }
          const decision = decideRuntimeFallback({ plan: route.plan, failure: { category: failure.category, reason: failure.reason },
            previousFailures: previous.inputSnapshot.runtimeFallback?.previousFailures ?? [], sameAttemptRetryExhausted: true,
            nowUtcMs: now(), capabilities: options.capabilityCatalog, registry, authorization });
          if (decision.mode === 'stop') { pause(decision.stopReason); return false; }
          await checkInference(identity.projectId, work.runId, work.taskId, decision.strategySnapshot);
          if (quiescing || await observeWithin(runtimeAssembly!.failureRouting!.authorize({ projectId: identity.projectId, runId: work.runId,
            taskId: work.taskId, source: decision.strategySource, strategy: decision.strategySnapshot }), 2_000) !== true) { pause('fallback_not_authorized'); return false; }
          const stopEvidence = await execution.stopVerifier.verify(resources.read(identity));
          if (stopEvidence === null) { pause(); return false; }
          const binding = await app.stateStore.getRepositoryBinding(identity.projectId);
          const workspace = await app.workWorkspaceAuthority.verifyPreparation(binding, input.request.featureId);
          const view = dag.readTaskDagView(identity.projectId, work.runId);
          if (quiescing) { pause(); return false; }
          const switched = fallbackSwitch.switch({ switchKey: randomUUID(), projectId: identity.projectId,
            runId: work.runId, taskId: work.taskId, oldAttempt: { attemptId: work.attemptId, owner: identity.owner,
              hostInstanceId: identity.hostInstanceId, executionVersion: identity.executionVersion },
            newOwner: owner, newHostInstanceId: hostInstanceId, workspace, stopEvidence, authorized: true, decision: { mode: 'switch', triggerCategory: decision.triggerCategory,
              previousFailures: decision.previousFailures, strategySource: decision.strategySource, strategySnapshot: decision.strategySnapshot },
            leaseUntilUtcMs: Math.min(now() + 60_000, previous.leaseUntilUtcMs, view.batch.deadlineAtUtcMs),
            policyVersion: route.policyVersion, capabilityEvidence: route.capabilityEvidence, inputSnapshot: previous.inputSnapshot });
          const index = route.plan.fallbacks.findIndex(candidate => candidate.source === decision.strategySource);
          routes.set(switched.receipt.attempt.id, { ...route, plan: { ...route.plan,
            preferred: route.plan.fallbacks[index]!, fallbacks: route.plan.fallbacks.slice(index + 1) } });
          // The transaction has transferred ownership. Startup failure belongs to the new Attempt.
          void consumeFallbackClaim(switched.receipt).catch(() => undefined);
          return true;
        } catch (error) {
          const candidate = error instanceof StorageError && typeof error.details?.reason === 'string' ? error.details.reason : '';
          const reason = /^[a-z][a-z0-9_]{0,95}$/.test(candidate) ? candidate : 'fallback_routing_failed';
          pause(reason);
          return false;
        }
      } },
  });
  const active = new Set<string>();
  const cancelRequested = new Set<string>();
  const pending = () => [...new Set([...active, ...(
    session.database.prepare(`SELECT DISTINCT l.owner_id FROM workspace_leases l
      JOIN attempts a ON a.id = l.owner_id
      LEFT JOIN sessions s ON s.id = a.session_id
      WHERE s.status IS NULL OR s.status <> 'stopped' OR s.result_ref IS NULL`).all() as { owner_id: string }[]
  ).map(row => row.owner_id)])];
  let quiescing = false, closed = false;
  // 仅收尾 Run 不创建编码 Attempt，但不得绕过单槽/项目 Work 门控：读取既有
  // 持久占用事实（只读、短查询），忙时由调度器保留可查询阻塞原因。
  function finalizationAdmission(projectId: string): string | null {
    const activeSlot = session.database.prepare(
      "SELECT id FROM execution_slot_claims WHERE project_id = ? AND state IN ('held', 'quarantined') AND lease_until > ? LIMIT 1",
    ).get(projectId, now());
    if (activeSlot !== undefined) return 'execution_slot_unavailable';
    const executionGate = session.database.prepare(
      "SELECT id FROM workspace_leases WHERE project_id = ? AND resource_key = 'global:execution' AND state IN ('held', 'quarantined') LIMIT 1",
    ).get(projectId);
    if (executionGate !== undefined) return 'project_execution_gate_busy';
    return null;
  }
  // P05-1 / F-005：planning 消费端口（准备/认领真实实现；消费者由装配注入，
  // 未注入时调度器保留 planning_consumer capability gap，不认领不占槽）。
  const planningClaims = createSqlitePlanningClaimStore(session, {
    workspaceAuthority: app.workWorkspaceAuthority,
    assertCanClaim() {
      if (options.startupRecovery.blocked()) {
        throw new StorageError('conflict', 'PlanningClaim.claimPlanningTask', 'Startup recovery census is not complete',
          { details: { reason: 'startup_recovery' } });
      }
    },
    ...(options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs }),
  });
  const planningDispatchPrepare = createPlanningDispatchPrepareService({
    views: createSqlitePlanningContextStore(session, options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs }),
    planningInputs: app.planningInputPrepare,
    workspaceAuthority: app.workWorkspaceAuthority,
    repositoryBindings: { getRepositoryBinding: projectId => app.stateStore.getRepositoryBinding(projectId) },
    batchDeadline: {
      readDeadlineUtcMs: (projectId, runId) => transactSqliteConsistentRead(session, 'PlanningDispatch.deadline', () => {
        const row = session.database.prepare<[string, string], { deadline_at: number | null }>(
          'SELECT b.deadline_at FROM runs r JOIN execution_batches b ON b.project_id = r.project_id AND b.id = r.batch_id WHERE r.project_id = ? AND r.id = ?',
        ).get(projectId, runId);
        return row?.deadline_at ?? null;
      }),
    },
    taskFacts: {
      readTaskFacts: (projectId, taskId) => transactSqliteConsistentRead(session, 'PlanningDispatch.taskFacts', () => {
        const row = session.database.prepare<[string], { project_id: string; revision: number; execution_version: number }>(
          'SELECT project_id, revision, execution_version FROM tasks WHERE id = ?',
        ).get(taskId);
        if (row === undefined || row.project_id !== projectId) return null;
        return { revision: row.revision, executionVersion: row.execution_version };
      }),
    },
    owner,
    hostInstanceId,
    ...(options.nowUtcMs === undefined ? {} : { nowMs: options.nowUtcMs }),
  });
  /**
   * P05-1 / F-007 planning 认领回执消费者：以冻结 planner 策略与 F-004 规划输入
   * 发起一次标准 Work（ExecutionService/受监督 Runner/Session/Recorder/启动预检
   * 全链复用；Runtime identity 保持 work）。会话开始后推进 Attempt → executing、
   * Run/Batch → running（受限工具通道准入依赖这些事实）；完成/失败经 supervision
   * 结算（候选已发布且停止/记录/终态满足才成功），再由既有派发收尾释放占用。
   * 重复唤醒不重复调用 Runtime（已启动或已结算的 Attempt 直接返回）。
   */
  async function consumePlanningExecutionClaim(receipt: import('../ports/task-claim.js').TaskClaimReceipt,
    ref: { readonly projectId: string; readonly runId: string }): Promise<void> {
    const attempt = receipt.attempt;
    // 幂等：重复唤醒/丢失唤醒补扫对已启动（beginLaunch 已授权）或已结算的
    // planning Attempt 不再启动 Runtime（claimKey 重放由调度器/认领存储承担）。
    const current = attempts.getAttempt(attempt.projectId, attempt.id);
    if (attempt.projectId !== ref.projectId || attempt.runId !== ref.runId
      || !isPlanningAttemptSnapshot(current.inputSnapshot)
      || current.status !== 'preparing' || current.executionStage !== 'preflight' || current.invocationId !== null) {
      dispatches.delete(attempt.id);
      return;
    }
    const identity = { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
      hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
    const fence: DispatchAttemptFence = { attemptId: attempt.id, executionVersion: attempt.executionVersion,
      ownerId: attempt.owner, hostInstanceId: attempt.hostInstanceId };
    if (receipt.dispatch !== undefined) {
      dispatches.set(attempt.id, { projectId: attempt.projectId, runId: attempt.runId,
        claimId: receipt.dispatch.claimId, claimVersion: receipt.dispatch.claimVersion, slotId: receipt.dispatch.slotId,
        attempt: fence });
      scheduleHeartbeat();
    }
    active.add(attempt.id);
    try {
      /* 冻结 planner 策略（planning Task executionConfig 副本）+ 行级事实/摘要重核。 */
      const taskRow = session.database.prepare<[string], { kind: string; status: string; execution_version: number;
        execution_config: string; config_source: string; config_source_key: string | null }>(
        'SELECT kind, status, execution_version, execution_config, config_source, config_source_key FROM tasks WHERE id = ?',
      ).get(attempt.taskId);
      if (taskRow === undefined || taskRow.kind !== 'planning' || taskRow.status !== 'running'
        || taskRow.execution_version !== attempt.executionVersion) {
        throw new StorageError('conflict', 'PlanningRuntime.prepare', 'Planning Task drift rejected the launch', {
          details: { reason: 'planning_identity_mismatch' },
        });
      }
      const configJson = JSON.parse(taskRow.execution_config) as Record<string, unknown>;
      const config = validateTaskExecutionConfig(configJson, 'PlanningRuntime.prepare');
      if (computePlanningStrategyCopyDigest({ executionConfig: configJson,
        configSource: taskRow.config_source, configSourceKey: taskRow.config_source_key })
        !== current.inputSnapshot.digests.strategyCopyDigest) {
        throw new StorageError('conflict', 'PlanningRuntime.prepare', 'Frozen planner strategy copy drifted', {
          details: { reason: 'strategy_copy_changed' },
        });
      }
      if (!registry.resolve(config.runtime)) {
        throw new StorageError('conflict', 'PlanningRuntime.prepare', 'Runtime adapter is not installed', {
          details: { reason: 'runtime_not_found' },
        });
      }
      const { schemaVersion: _schema, maxCodeAttempts: _attempts, workTimeoutMs: _work, toolTimeoutMs: _tool, ...strategy } = config;

      /* 工作区（与认领同一权威的幂等复核）与截止（Batch/Run/租约）。 */
      const binding = await app.stateStore.getRepositoryBinding(attempt.projectId);
      const workspace = await app.workWorkspaceAuthority.verifyPreparation(binding, attempt.featureId);
      const view = dag.readTaskDagView(attempt.projectId, attempt.runId);
      const nowMs = now();
      const batchDeadline = Math.min(view.batch.deadlineAtUtcMs, view.batch.budgetSnapshot.batch.deadlineUtcMs);
      const sessionLimit = Math.min(config.workTimeoutMs ?? DEFAULT_WORK_TIME_LIMIT_MS,
        Math.max(0, attempt.leaseUntilUtcMs - nowMs));
      const deadlines = resolveExecutionDeadlines({
        nowUtcMs: nowMs,
        sessionTimeLimitMs: Math.max(1, sessionLimit),
        toolTimeLimitMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIME_LIMIT_MS,
        runStartedAtUtcMs: view.run.startedAtUtcMs,
        runTimeLimitMs: view.run.runTimeLimitMs,
        batchDeadlineUtcMs: batchDeadline,
      });
      if (deadlines.expired || deadlines.remainingMs < WORK_TIMEOUT_MS_MIN) {
        throw new StorageError('conflict', 'PlanningRuntime.start', 'Execution deadline has already been reached', {
          details: { reason: deadlines.expiredLayers.includes('run') || deadlines.remainingMs <= 0
            ? 'run_time_exhausted' : 'deadline_exhausted' },
        });
      }

      /* 发起一次 Work：Runtime identity 保持 work；认证/资源预检随工厂
       * prepareRequest（prepareAccess）复用，不引入 Durable 或托管 Chat。
       * P05-1 / F-010：同一未完成 planning Task 的会话策略——首次 Attempt 显式
       * 新会话；重启核对后的 resume Attempt 默认 auto（conversation）：无受信
       * 原生归档来源或能力未验证时由输入绑定按授权政策降级新会话并记录原因
       * （绑定证据 recovery 记录）；required 只能经恢复来源显式给出，能力不足
       * 时在绑定层明确拒绝启动（不降级）。新进程启动由既有预算记账，活进程
       * 重连不重复计启动；原生续聊不等于检查点工具可重放。 */
      const priorAttempts = attempts.listTaskAttempts(attempt.projectId, attempt.taskId)
        .filter(entry => entry.id !== attempt.id);
      const planningRecovery = priorAttempts.length === 0
        ? { mode: 'new' as const }
        : { mode: 'auto' as const, kind: 'conversation' as const };
      const started = await execution.start({
        claim: receipt, workspace,
        sessionId: receipt.launch?.sessionId ?? randomUUID(),
        ...(receipt.launch === undefined ? {} : { invocationId: receipt.launch.invocationId, parentSessionId: receipt.launch.parentSessionId }),
        strategy,
        permissions: { ...TRUSTED_PROJECT_PERMISSIONS_READER({ projectId: attempt.projectId, featureId: attempt.featureId, taskId: attempt.taskId }), isolation: 'trusted_project' },
        limits: {
          timeoutMs: Math.max(1, deadlines.remainingMs),
          toolTimeoutMs: Math.max(1, Math.min(deadlines.toolTimeoutMs ?? DEFAULT_TOOL_TIME_LIMIT_MS, deadlines.remainingMs)),
          maxEvents: 10_000,
          maxOutputBytes: 8_000_000,
        },
        recovery: planningRecovery, cwdRoot: 'managed-work',
      });

      /* 会话已开始：Attempt → executing、Run/Batch queued → running（受限工具
       * 通道按这些事实准入；短会话可能已先结算，届时跳过推进不伪造状态）。 */
      const afterStart = attempts.getAttempt(attempt.projectId, attempt.id);
      if (afterStart.status === 'preparing' && afterStart.executionStage === 'runtime') {
        try {
          planningLifecycle.apply({ ...identity, taskId: attempt.taskId, runId: attempt.runId,
            notificationId: `planning-execution-started-${attempt.id}`, kind: 'executing' });
        } catch (error) {
          const settled = attempts.getAttempt(attempt.projectId, attempt.id);
          if (settled.status === 'preparing') throw error;
        }
      }
      if (cancelRequested.delete(attempt.id)) void execution.cancel(identity).catch(() => undefined);
      void started.context.completion!.then(result => {
        if (result.stopConfirmed && result.persisted && result.error === null) active.delete(attempt.id);
        readers.delete(started.context.request.invocationId);
        dispatches.delete(attempt.id);
        // 完成/失败/取消共用同一结算入口：释放与否由持久事实决定。
        settleRun(attempt.projectId, attempt.runId, fence);
      }, () => undefined);
    } catch (error) {
      cancelRequested.delete(attempt.id);
      dispatches.delete(attempt.id);
      active.delete(attempt.id);
      // 启动不确定性保留可查询原因（与编码 consumeClaim 同一纪律；失败结算
      // 已由 ExecutionService 的 rejectLaunch/settlement 路径承担）。
      store.recordRunReason(attempt.projectId, attempt.runId, 'not_ready');
      throw error;
    }
  }

  const scheduler = createWorkScheduler({ store, featureDag, dag: { evaluate: (projectId, runId) => evaluateTaskDag(dag.readTaskDagView(projectId, runId), now()) },
    claims: app.taskClaims,
    admission: { check: ref => finalizationAdmission(ref.projectId) },
    beforeRun: ref => { settleRun(ref.projectId, ref.runId); },
    ...(options.finalizationExecution === undefined ? {} : {
      finalization: {
        async execute(handoff: { readonly projectId: string; readonly runId: string }) {
          const result = await options.finalizationExecution!.execute({ projectId: handoff.projectId, runId: handoff.runId });
          return {
            recordHandoff: result.status === 'verification_passed'
              || result.status === 'verification_failed'
              || result.status === 'invalidated',
          };
        },
      },
    }),
    ...(options.finalizationCompletion === undefined ? {} : {
      finalizationCompletion: {
        async execute(handoff: { readonly projectId: string; readonly runId: string }) {
          return options.finalizationCompletion!.execute({ projectId: handoff.projectId, runId: handoff.runId });
        },
      },
    }),
    // P05-1 / F-005：planning Run 按 purpose 路由（准备/重核在事务外，认领自有
    // 短事务，消费只在回执提交后）。F-007：优先使用受信注入的消费者；否则在
    // 装配了 Runtime 工厂时接入内部真实执行（复用标准 ExecutionService 链路）；
    // 两者皆缺时保留 planning_consumer capability gap，不认领不占槽。
    ...(options.planningExecution === undefined && options.runtimeFactory === undefined ? {} : {
      planning: {
        prepare: async (ref: { readonly projectId: string; readonly runId: string }) =>
          planningDispatchPrepare.preparePlanningClaim(ref),
        claims: planningClaims,
        consume: async (receipt: import('../ports/task-claim.js').TaskClaimReceipt,
          ref: { readonly projectId: string; readonly runId: string }) =>
          (options.planningExecution !== undefined
            ? options.planningExecution.consumePlanningClaim(receipt, ref)
            : consumePlanningExecutionClaim(receipt, ref)),
      },
    }),
    async prepareClaim({ candidate, taskId }) {
      if (isFinalizationOnlyRun(candidate.run)) {
        throw new PublicError('conflict', 'execution.start', undefined, { details: { reason: 'finalization_only_run' } });
      }
      if (quiescing || options.startupRecovery.blocked()) throw new PublicError('resource_busy', 'execution.start');
      const projectId = candidate.run.projectId;
      const view = dag.readTaskDagView(projectId, candidate.run.id);
      const task = view.plan.tasks.find(task => task.id === taskId)!;
      const config = validateTaskExecutionConfig(task.executionConfig, 'WorkRuntime.prepare');
      // Check adapter availability before any claim, workspace process or debit.
      if (!registry.resolve(config.runtime)) throw new StorageError('conflict', 'WorkRuntime.prepare', 'Runtime adapter is not installed', { details: { reason: 'runtime_not_found' } });
      const { schemaVersion: _schema, maxCodeAttempts: _attempts, workTimeoutMs: _work, toolTimeoutMs: _tool, ...probeStrategy } = config;
      const selectedRoute = runtimeAssembly?.failureRouting?.select({ projectId, runId: candidate.run.id, taskId, strategy: probeStrategy });
      const frozenRoute = selectedRoute === undefined ? undefined : { ...structuredClone(selectedRoute),
        plan: validateRuntimeFallbackPlan(selectedRoute.plan) };
      if (frozenRoute && (frozenRoute.plan.fallbacks.length > 32
        || stableStringify(frozenRoute.plan.preferred.strategy) !== stableStringify(probeStrategy))) {
        throw new StorageError('conflict', 'WorkRuntime.prepare', 'Fallback plan differs from frozen Task strategy');
      }
      await checkInference(projectId, candidate.run.id, taskId, probeStrategy);
      const refs = [...view.plan.feature.sourceRefs, ...task.requirementsRefs];
      // F-012：同 Task 已有历史 Attempt 时构造返工输入（F-011 契约）：关联当前
      // 预生成的新 Attempt、直接上一终态 Attempt、同一 worktree 已核对现场身份
      // 与必需失败证据引用；仍按受预算的获准新代码 Attempt 记账，人工阻塞仍由
      // DAG/认领拒绝，不伪造恢复能力。
      const prior = [...attempts.listTaskAttempts(projectId, taskId)].sort((left, right) => left.number - right.number);
      let attemptId: string | undefined;
      let rework: import('../ports/context-build.js').ContextReworkInput | undefined;
      if (prior.length > 0) {
        const previous = prior[prior.length - 1]!;
        if (['preparing', 'executing', 'verifying'].includes(previous.status)) {
          throw new StorageError('conflict', 'WorkRuntime.prepare', 'Previous Attempt is not terminal', { details: { reason: 'previous_attempt_active' } });
        }
        if (options.readReworkScene === undefined) {
          throw new StorageError('conflict', 'WorkRuntime.prepare', 'Rework scene reader is not assembled', { details: { reason: 'rework_scene_not_assembled' } });
        }
        const scene = await options.readReworkScene(projectId, task.featureId);
        if (scene === null) throw new StorageError('conflict', 'WorkRuntime.prepare', 'Rework workspace is missing', { details: { reason: 'rework_workspace_missing' } });
        attemptId = randomUUID();
        const evidenceIds = new Set<string>();
        if (previous.diagnosticRef !== null) evidenceIds.add(previous.diagnosticRef);
        for (const batch of verification.listAttemptVerificationBatches(projectId, previous.id)) {
          for (const check of verification.listCheckResults(projectId, batch.id)) {
            if (check.outputArtifactId !== null) evidenceIds.add(check.outputArtifactId);
          }
        }
        if (evidenceIds.size > 16) throw new StorageError('conflict', 'WorkRuntime.prepare', 'Failure evidence exceeds the rework limit', { details: { reason: 'failure_evidence_limit' } });
        if (evidenceIds.size === 0) throw new StorageError('conflict', 'WorkRuntime.prepare', 'Previous Attempt has no failure evidence', { details: { reason: 'failure_evidence_missing' } });
        const failureEvidenceRefs = await Promise.all([...evidenceIds].map(async artifactId => {
          const record = await app.artifactStore.getArtifact(projectId, artifactId);
          if (record.status !== 'ready' || record.contentHash === null || record.sizeBytes === null) {
            throw new StorageError('conflict', 'WorkRuntime.prepare', 'Failure evidence is not a ready artifact', { details: { reason: 'failure_evidence_not_ready' } });
          }
          return { projectId, artifactId: record.id, kind: record.kind, purpose: 'failure-evidence',
            version: record.version, contentHash: record.contentHash, sizeBytes: record.sizeBytes,
            locator: record.locator, mediaType: record.mediaType, origin: { kind: 'artifact' as const } };
        }));
        rework = { attemptId, previousAttemptId: previous.id, previousTaskId: taskId, scene,
          failureEvidenceRefs,
          recovery: { selection: { mode: 'new' }, decision: validateRuntimeRecoveryDecision({ mode: 'new', reasons: ['explicit_new'] }) } };
      }
      const inputSnapshot = await app.executionInputPrepare.prepareExecutionInput(projectId, { featureId: task.featureId, taskId,
        items: [...new Set(refs.map(ref => ref.artifactId))].map(artifactId => ({ purpose: 'requirements', source: { kind: 'artifact' as const, artifactId } })),
        ...(rework === undefined ? {} : { rework }) });
      const binding = await app.stateStore.getRepositoryBinding(projectId);
      const workspace = await app.workWorkspaceAuthority.verifyPreparation(binding, task.featureId);
      const fact = view.facts.find(fact => fact.taskId === taskId)!;
      const claimKey = randomUUID();
      if (frozenRoute) preparedRoutes.set(claimKey, frozenRoute);
      const launch = { sessionId: randomUUID(), invocationId: randomUUID(),
        parentSessionId: prior.length > 0 && prior[prior.length - 1]!.sessionId !== null
          ? prior[prior.length - 1]!.sessionId : null };
      return { claimKey, projectId, runId: candidate.run.id, taskId, owner, hostInstanceId,
        expectedRevision: task.revision, executionVersion: fact.executionVersion,
        workspace, leaseUntilUtcMs: Math.min(now() + 60_000, view.batch.deadlineAtUtcMs), inputSnapshot,
        launch,
        ...(attemptId === undefined ? {} : { attemptId }) };
    },
    consumeClaim: consumeFallbackClaim = async claim => {
      const attempt = claim.attempt;
      const route = preparedRoutes.get(claim.claimKey);
      preparedRoutes.delete(claim.claimKey);
      if (route) routes.set(attempt.id, route);
      const identity = { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
      active.add(attempt.id);
      const fence: DispatchAttemptFence = { attemptId: attempt.id, executionVersion: attempt.executionVersion,
        ownerId: attempt.owner, hostInstanceId: attempt.hostInstanceId };
      if (claim.dispatch !== undefined) {
        // 登记派发归属用于心跳续租；续租时重核认领身份与本次 Attempt 围栏。
        dispatches.set(attempt.id, { projectId: attempt.projectId, runId: attempt.runId,
          claimId: claim.dispatch.claimId, claimVersion: claim.dispatch.claimVersion, slotId: claim.dispatch.slotId,
          attempt: fence });
        scheduleHeartbeat();
      }
      try {
        // F-012：同一 Feature 已存在受管 worktree 时复用其工作区身份（新准备操作
        // 仍用随机 operationId；journal 现场检查点按工作区的 preparationOperationId
        // 读取，Preparer 据此走复用分支并核对 directoryIdentity/expectedHead）。
        // 不凭路径或分支推断复用许可，全部经 begin/Preparer 的既有把关。
        const managed = createSqliteWorkspaceAccess(session, { resources, nowUtcMs: now })
          .readWorkspace(attempt.projectId, attempt.featureId);
        const prepared = await app.workspacePreparation.prepare({ identity, runId: attempt.runId, taskId: attempt.taskId,
          claimKey: claim.claimKey, operationId: randomUUID(), workspaceId: managed?.id ?? randomUUID() });
        if (prepared.operation.status !== 'succeeded' || prepared.workspace.status !== 'ready') throw new Error('workspace_not_ready');
        const binding = await app.stateStore.getRepositoryBinding(attempt.projectId);
        const workspace = await app.workWorkspaceAuthority.verify(binding, prepared.workspace.canonicalPath);
        const view = dag.readTaskDagView(attempt.projectId, attempt.runId);
        const task = view.plan.tasks.find(task => task.id === attempt.taskId)!;
        const config = validateTaskExecutionConfig(task.executionConfig, 'WorkRuntime.start');
        const {
          schemaVersion: _,
          maxCodeAttempts: __,
          workTimeoutMs: configuredSessionLimit,
          toolTimeoutMs: configuredToolLimit,
          ...preferredStrategy
        } = config;
        const strategy = attempt.inputSnapshot.runtimeFallback?.strategy ?? preferredStrategy;
        const nowMs = now();
        const batchDeadline = Math.min(view.batch.deadlineAtUtcMs, view.batch.budgetSnapshot.batch.deadlineUtcMs);
        const sessionLimit = Math.min(
          configuredSessionLimit ?? DEFAULT_WORK_TIME_LIMIT_MS,
          Math.max(0, attempt.leaseUntilUtcMs - nowMs),
        );
        const deadlines = resolveExecutionDeadlines({
          nowUtcMs: nowMs,
          sessionTimeLimitMs: Math.max(1, sessionLimit),
          toolTimeLimitMs: configuredToolLimit ?? DEFAULT_TOOL_TIME_LIMIT_MS,
          runStartedAtUtcMs: view.run.startedAtUtcMs,
          runTimeLimitMs: view.run.runTimeLimitMs,
          batchDeadlineUtcMs: batchDeadline,
        });
        // 已到期不启动新的 Runtime/工具/检查；保持既有 Run/Batch 状态供恢复诊断。
        if (deadlines.expired || deadlines.remainingMs < WORK_TIMEOUT_MS_MIN) {
          throw new StorageError('conflict', 'WorkRuntime.start', 'Execution deadline has already been reached', {
            details: { reason: deadlines.expiredLayers.includes('run') || deadlines.remainingMs <= 0
              ? 'run_time_exhausted' : 'deadline_exhausted' },
          });
        }
        const started = await execution.start({ claim, workspace, sessionId: claim.launch?.sessionId ?? randomUUID(),
          ...(claim.launch === undefined ? {} : { invocationId: claim.launch.invocationId, parentSessionId: claim.launch.parentSessionId }), strategy,
          permissions: { ...TRUSTED_PROJECT_PERMISSIONS_READER({ projectId: attempt.projectId, featureId: attempt.featureId, taskId: attempt.taskId }), isolation: 'trusted_project' },
          limits: {
            timeoutMs: Math.max(1, deadlines.remainingMs),
            toolTimeoutMs: Math.max(1, Math.min(deadlines.toolTimeoutMs ?? DEFAULT_TOOL_TIME_LIMIT_MS, deadlines.remainingMs)),
            maxEvents: 10_000,
            maxOutputBytes: 8_000_000,
          },
          recovery: attempt.inputSnapshot.recovery?.selection ?? { mode: 'new' }, cwdRoot: 'managed-work' });
        if (cancelRequested.delete(attempt.id)) void execution.cancel(identity).catch(() => undefined);
        void started.context.completion!.then(result => {
          if (result.stopConfirmed && result.persisted && result.error === null) active.delete(attempt.id);
          readers.delete(started.context.request.invocationId);
          routes.delete(attempt.id);
          dispatches.delete(attempt.id);
          // 完成/失败/取消共用同一结算入口：是否释放由持久事实（活动 Attempt、
          // 停止/保留的占用、Run 状态）决定，不由结果 Promise 结束本身决定。
          settleRun(attempt.projectId, attempt.runId, fence);
        }, () => undefined);
      } catch (error) {
        cancelRequested.delete(attempt.id);
        dispatches.delete(attempt.id);
        // Preparation/launch uncertainty must keep this Host occupied.
        store.recordRunReason(attempt.projectId, attempt.runId, 'not_ready');
        throw error;
      }
    },
  });
  /**
   * 有界收尾扫描：终态/暂停/中断且已无活动 Attempt 的 Run 即使不在调度候选页
   * （例如取消后不再活跃）也必须由持久派发事实被发现，否则占槽会永久泄漏。
   * 不做进程/网络 I/O，只走短事务结算。
   */
  function settleClaimedRuns(): void {
    const rows = session.database.prepare(
      `SELECT c.project_id AS project_id, c.run_id AS run_id FROM run_dispatch_claims c
        JOIN runs r ON r.project_id = c.project_id AND r.id = c.run_id
        WHERE c.state IN ('held', 'quarantined')
          AND r.status IN ('succeeded', 'failed', 'cancelled', 'paused', 'interrupted')
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.project_id = c.project_id AND a.run_id = c.run_id
            AND a.status IN ('preparing', 'executing', 'verifying'))
        ORDER BY c.updated_at, c.rowid LIMIT 64`,
    ).all() as { project_id: string; run_id: string }[];
    for (const row of rows) settleRun(row.project_id, row.run_id);
  }
  const scan = () => options.startupRecovery.blocked()
    ? Promise.resolve({ closed: false, pages: 0, bounded: true, runs: [] })
    : (() => { settleClaimedRuns(); return scheduler.scan(); })();
  return {
    scan,
    enterRecovery: () => options.startupRecovery.enter(),
    recover: () => options.startupRecovery.recover(),
    recoveryState: () => options.startupRecovery.state(),
    start() { if (options.runtimeFactory && !options.startupRecovery.blocked()) scheduler.start(); },
    signalRunDispatched(input: { projectId: string; runId: string }) {
      if (quiescing || options.startupRecovery.blocked()) return;
      if (!options.runtimeFactory) { store.recordRunReason(input.projectId, input.runId, 'runtime_not_found'); return; }
      scheduler.wake(input.projectId, input.runId);
    },
    assertCancel(projectId: string, attemptId: string): WorkResourceIdentity {
      const attempt = attempts.getAttempt(projectId, attemptId);
      if (attempt.owner !== owner || attempt.hostInstanceId !== hostInstanceId) {
        throw new PublicError('unsupported', 'execution.attempt.cancel');
      }
      if (!['preparing', 'executing'].includes(attempt.status)) throw new PublicError('conflict', 'execution.attempt.cancel');
      if (!active.has(attemptId)) throw new PublicError('unsupported', 'execution.attempt.cancel');
      return { projectId, attemptId, owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
    },
    async cancel(identity: WorkResourceIdentity) {
      if (!execution.get(identity.projectId, identity.attemptId)) { cancelRequested.add(identity.attemptId); return null; }
      const completion = await execution.cancel(identity);
      // 取消停止后同样走持久事实结算：停止未确认/现场仍保留时保留或隔离占槽。
      const attempt = attempts.getAttempt(identity.projectId, identity.attemptId);
      settleRun(identity.projectId, attempt.runId, { attemptId: attempt.id, executionVersion: attempt.executionVersion,
        ownerId: attempt.owner, hostInstanceId: attempt.hostInstanceId });
      return completion;
    },
    settleDispatch(projectId: string, runId: string) { return settleRun(projectId, runId); },
    heartbeat,
    dispatchState(projectId: string, runId: string) {
      const facts = dispatchSettlement.read({ projectId, runId });
      const display = deriveRunDispatchDisplay({ runStatus: facts.runStatus as ExecutionRunStatus,
        claim: facts.claim, slot: facts.slot, activeAttempt: facts.activeAttempt,
        slotCapacityAvailable: facts.slotCapacityAvailable, nowUtcMs: now() });
      return { ...display, runStatus: facts.runStatus, pauseRequested: facts.pauseRequested,
        claimId: facts.claim?.id ?? null, claimVersion: facts.claim?.claimVersion ?? null,
        claimState: facts.claim?.state ?? null, claimReason: facts.claim?.reason ?? null,
        slotId: facts.slot?.id ?? null, slotState: facts.slot?.state ?? null,
        slotLeaseUntilUtcMs: facts.slot?.leaseUntilUtcMs ?? null,
        activeAttemptCount: facts.activeAttemptCount, retainedLeaseCount: facts.retainedLeaseCount,
        settlement: settlementNotes.get(runKey(projectId, runId)) ?? null };
    },
    activeAttemptIds() { return pending(); },
    enterQuiesce() { quiescing = true; return { accepted: pending().length }; },
    async awaitQuiesce(budgetMs: number) {
      const result = await observeWithin(this.close(), Math.max(1, budgetMs));
      return { confirmed: result?.closed === true, pending: result?.pendingAttemptIds ?? pending() };
    },
    async close() {
      quiescing = true;
      probeCancellation.abort();
      if (heartbeatTimer !== null) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
      await scheduler.close();
      const result = await execution.close();
      const pendingAttemptIds = [...new Set([...pending(), ...result.pendingAttemptIds])];
      closed = result.closed && pendingAttemptIds.length === 0;
      return { closed, pendingAttemptIds };
    },
    isClosed() { return closed; },
  };
  function resourcesStopVerifier(): import('../ports/work-resources.js').WorkResourceStopVerifier {
    return { verify: snapshot => execution.stopVerifier.verify(snapshot), inspect: token => execution.stopVerifier.inspect(token) };
  }
}
export type WorkExecution = ReturnType<typeof assembleWorkExecution>;
