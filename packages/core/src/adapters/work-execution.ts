/** Trusted Work composition. No adapter discovery, module loading, environment or SDK. */
import { createHash, randomUUID } from 'node:crypto';
import type { CoreApplication } from './composition.js';
import type { SqliteStorageSession } from './sqlite/session.js';
import { createSqliteSchedulerStore } from './sqlite/scheduler-store.js';
import { createSqliteTaskDagStore } from './sqlite/task-dag-store.js';
import { createSqliteAttemptAccess } from './sqlite/attempt-store.js';
import { createSqliteWorkSessionStore } from './sqlite/work-session-store.js';
import { createSqliteAttemptLifecycleStore } from './sqlite/attempt-lifecycle-store.js';
import { createSqliteWorkResourceAccess } from './sqlite/work-resources.js';
import { createSqliteWorkspaceAccess } from './sqlite/workspace.js';
import { createSqliteWorkspaceRetentionStore } from './sqlite/workspace-retention.js';
import { createSqliteAtomicCommandStore } from './sqlite/atomic-commands.js';
import { createWorkScheduler } from '../application/work-scheduler.js';
import { evaluateTaskDag } from '../application/task-dag.js';
import { validateTaskExecutionConfig } from '../application/task-strategy-selection.js';
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
import type { CommandProcessIdentity } from '../ports/command-process.js';
import type { WorkResourceIdentity } from '../ports/work-resources.js';
import { PublicError } from '../ports/commands.js';

export interface WorkRuntimeContext {
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly reader: (request: RuntimeExecutionRequest) => BoundExecutionInputReader | undefined;
  readonly commitCommandIdentity: (identity: CommandProcessIdentity, request: RuntimeExecutionRequest) => Promise<{ launchId: string }>;
}
/** A function supplied by trusted code only; never serialized in settings or commands. */
export type WorkRuntimeFactory = (context: WorkRuntimeContext) => {
  readonly entries: readonly RuntimeRegistryEntry[];
  readonly eventIdentityPrefix: (request: RuntimeExecutionRequest) => string;
};

export function assembleWorkExecution(options: {
  readonly session: SqliteStorageSession;
  readonly application: Pick<CoreApplication, 'dataRoot' | 'artifactStore' | 'artifactFileStore' | 'stateStore' |
    'configurationService' | 'workWorkspaceAuthority' | 'taskClaims' | 'workspacePreparation' | 'executionInputPrepare'>;
  readonly capabilityCatalog: import('../ports/runtime-capabilities.js').RuntimeCapabilityCatalog;
  readonly runtimeFactory?: WorkRuntimeFactory;
  readonly nowUtcMs?: () => number;
}) {
  const { session, application: app } = options;
  const now = options.nowUtcMs ?? Date.now;
  const owner = randomUUID(), hostInstanceId = randomUUID();
  const attempts = createSqliteAttemptAccess(session);
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
  const runtimeAssembly = options.runtimeFactory?.({ workspaceRoots, reader: request => readers.get(request.invocationId),
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
  const inputBinding = createExecutionInputBindingService({ artifacts: app.artifactStore, verifier, attempts, resources,
    workspaceAuthority: app.workWorkspaceAuthority, workspaceRoots, publisher, nowMs: now });
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
    settlement: createRuntimeSettlementService({ publisher, attempts, dag,
      lifecycle: createSqliteAttemptLifecycleStore(session, { workspaceAuthority: app.workWorkspaceAuthority, nowUtcMs: now }) }),
    recorder: createWorkEvidenceRecorder({ publisher, verifier, sessions, limits: {
      maxEventBodyBytes: 8_192, chunkMaxEvents: 32, chunkMaxBytes: 262_144, maxTotalEvents: 10_000,
      maxTotalBytes: 8_000_000, reorderWindow: 8, tailWaitMs: 2_000,
    } }),
    eventIdentityPrefix: runtimeAssembly?.eventIdentityPrefix ?? (() => 'unregistered.'), nowUtcMs: now,
    supervision: { stopWaitMs: 2_000, drainWaitMs: 2_000, closeWaitMs: 5_000,
      retain: createExecutionWorkspaceRetainer({ workspaces: createSqliteWorkspaceAccess(session, { resources, nowUtcMs: now }), retention }) },
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
    async prepareClaim({ candidate, taskId }) {
      if (quiescing) throw new PublicError('resource_busy', 'execution.start');
      const projectId = candidate.run.projectId;
      const view = dag.readTaskDagView(projectId, candidate.run.id);
      const task = view.plan.tasks.find(task => task.id === taskId)!;
      const config = validateTaskExecutionConfig(task.executionConfig, 'WorkRuntime.prepare');
      // Check adapter availability before any claim, workspace process or debit.
      if (!registry.resolve(config.runtime)) throw new StorageError('conflict', 'WorkRuntime.prepare', 'Runtime adapter is not installed', { details: { reason: 'runtime_not_found' } });
      const refs = [...view.plan.feature.sourceRefs, ...task.requirementsRefs];
      const inputSnapshot = await app.executionInputPrepare.prepareExecutionInput(projectId, { featureId: task.featureId, taskId,
        items: [...new Set(refs.map(ref => ref.artifactId))].map(artifactId => ({ purpose: 'requirements', source: { kind: 'artifact' as const, artifactId } })) });
      const binding = await app.stateStore.getRepositoryBinding(projectId);
      const workspace = await app.workWorkspaceAuthority.verifyPreparation(binding, task.featureId);
      const fact = view.facts.find(fact => fact.taskId === taskId)!;
      return { claimKey: randomUUID(), projectId, runId: candidate.run.id, taskId, owner, hostInstanceId,
        expectedRevision: task.revision, executionVersion: fact.executionVersion,
        workspace, leaseUntilUtcMs: Math.min(now() + 60_000, view.batch.deadlineAtUtcMs), inputSnapshot };
    },
    async consumeClaim(claim) {
      const attempt = claim.attempt;
      const identity = { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
      active.add(attempt.id);
      try {
        const prepared = await app.workspacePreparation.prepare({ identity, runId: attempt.runId, taskId: attempt.taskId,
          claimKey: claim.claimKey, operationId: randomUUID(), workspaceId: randomUUID() });
        if (prepared.operation.status !== 'succeeded' || prepared.workspace.status !== 'ready') throw new Error('workspace_not_ready');
        const binding = await app.stateStore.getRepositoryBinding(attempt.projectId);
        const workspace = await app.workWorkspaceAuthority.verify(binding, prepared.workspace.canonicalPath);
        const view = dag.readTaskDagView(attempt.projectId, attempt.runId);
        const task = view.plan.tasks.find(task => task.id === attempt.taskId)!;
        const { schemaVersion: _, maxCodeAttempts: __, ...strategy } = validateTaskExecutionConfig(task.executionConfig, 'WorkRuntime.start');
        const started = await execution.start({ claim, workspace, sessionId: randomUUID(), strategy,
          permissions: { ...TRUSTED_PROJECT_PERMISSIONS_READER({ projectId: attempt.projectId, featureId: attempt.featureId, taskId: attempt.taskId }), isolation: 'trusted_project' },
          limits: { timeoutMs: Math.max(1, Math.min(60_000, view.run.runTimeLimitMs, attempt.leaseUntilUtcMs - now())), maxEvents: 10_000, maxOutputBytes: 8_000_000 },
          recovery: { mode: 'new' }, cwdRoot: 'managed-work' });
        if (cancelRequested.delete(attempt.id)) void execution.cancel(identity).catch(() => undefined);
        void started.context.completion!.then(result => {
          if (result.stopConfirmed && result.persisted && result.error === null) active.delete(attempt.id);
          readers.delete(started.context.request.invocationId);
        }, () => undefined);
      } catch (error) {
        cancelRequested.delete(attempt.id);
        // Preparation/launch uncertainty must keep this Host occupied.
        store.recordRunReason(attempt.projectId, attempt.runId, 'not_ready');
        throw error;
      }
    },
  });
  const scan = () => scheduler.scan();
  return {
    scan,
    start() { if (options.runtimeFactory) scheduler.start(); },
    signalRunDispatched(input: { projectId: string; runId: string }) {
      if (quiescing) return;
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
      if (!execution.get(identity.projectId, identity.attemptId)) cancelRequested.add(identity.attemptId);
      else await execution.cancel(identity);
    },
    activeAttemptIds() { return pending(); },
    enterQuiesce() { quiescing = true; return { accepted: pending().length }; },
    async awaitQuiesce(budgetMs: number) {
      const result = await observeWithin(this.close(), Math.max(1, budgetMs));
      return { confirmed: result?.closed === true, pending: result?.pendingAttemptIds ?? pending() };
    },
    async close() {
      quiescing = true;
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
