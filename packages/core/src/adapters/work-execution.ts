/** Trusted Work composition. No adapter discovery, module loading, environment or SDK. */
import { createHash, randomUUID } from 'node:crypto';
import type { CoreApplication } from './composition.js';
import type { SqliteStorageSession } from './sqlite/session.js';
import { createSqliteSchedulerStore } from './sqlite/scheduler-store.js';
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
import { evaluateTaskDag } from '../application/task-dag.js';
import { validateTaskExecutionConfig } from '../application/task-strategy-selection.js';
import { DEFAULT_TOOL_TIME_LIMIT_MS, DEFAULT_WORK_TIME_LIMIT_MS, resolveExecutionDeadlines } from '../ports/execution-time-limits.js';
import { WORK_TIMEOUT_MS_MIN } from '../ports/settings-schema.js';
import { createRuntimeExecutionService } from '../application/runtime-execution.js';
import { createExecutionService, type ExecutionService } from '../application/execution-service.js';
import { createExecutionInputBindingService } from '../application/execution-input-binding.js';
import { createArtifactPublisher } from '../application/artifact-publish.js';
import { createArtifactVerifier } from '../application/artifact-verify.js';
import { createWorkEvidenceRecorder } from '../application/work-evidence-recorder.js';
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
    'configurationService' | 'workWorkspaceAuthority' | 'taskClaims' | 'workspacePreparation' | 'executionInputPrepare'> & {
      readonly runtimeRecovery?: CoreApplication['runtimeRecovery'];
      readonly runtimeRecoveryCatalog?: CoreApplication['runtimeRecoveryCatalog'];
      readonly workRecoveryContinuation?: CoreApplication['workRecoveryContinuation'];
    };
  readonly capabilityCatalog: import('../ports/runtime-capabilities.js').RuntimeCapabilityCatalog;
  readonly runtimeFactory?: WorkRuntimeFactory;
  readonly nowUtcMs?: () => number;
  readonly startupRecovery: ReturnType<typeof createWorkStartupRecovery>;
  /** P03-9 / F-011：finalization-only Run 在编码认领前分流到受信重验执行。 */
  readonly finalizationExecution?: FinalizationExecutionPort;
  /** P03-9 / F-012：重验 handoff 后继续最终审批/提交/完成（不启动 Runtime）。 */
  readonly finalizationCompletion?: FinalizationCompletionPort;
  /** F-012：受信返工现场读取（同 Feature 受管 worktree 的当前身份；无工作区时
   * 返回 null）。由 composition 用受界检查器实现；缺省时不接返工认领。 */
  readonly readReworkScene?: (projectId: string, featureId: string) => Promise<{
    readonly worktreeId: string; readonly headCommit: string; readonly codeDigest: string;
  } | null>;
}) {
  const { session, application: app } = options;
  const now = options.nowUtcMs ?? Date.now;
  const owner = randomUUID(), hostInstanceId = randomUUID();
  const attempts = createSqliteAttemptAccess(session);
  const verification = createSqliteVerificationStore(session, options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs });
  const dag = createSqliteTaskDagStore(session);
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
    recorder: createWorkEvidenceRecorder({ publisher, verifier, sessions, limits: {
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
  const scheduler = createWorkScheduler({ store, dag: { evaluate: (projectId, runId) => evaluateTaskDag(dag.readTaskDagView(projectId, runId), now()) },
    claims: app.taskClaims,
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
        }, () => undefined);
      } catch (error) {
        cancelRequested.delete(attempt.id);
        // Preparation/launch uncertainty must keep this Host occupied.
        store.recordRunReason(attempt.projectId, attempt.runId, 'not_ready');
        throw error;
      }
    },
  });
  const scan = () => options.startupRecovery.blocked()
    ? Promise.resolve({ closed: false, pages: 0, bounded: true, runs: [] }) : scheduler.scan();
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
      return execution.cancel(identity);
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
