/**
 * P03-6 / F-008：已提交认领到 Runtime 启动的最小编排。
 *
 * 这层只拥有顺序与授权边界：所有 workspace/input 读取在 SQLite 事务外完成；
 * 短事务只负责 beginLaunch、预算账本和 reserved Session。Runtime adapter 在
 * 事务提交后才被调用，因此拒绝或预算冲突不会产生进程/文件副作用。
 */
import type { TaskClaimReceipt } from '../ports/task-claim.js';
import {
  EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
  type ExecutionInputBindingInput,
  validateExecutionInputBindingInput,
} from '../ports/execution-input-binding.js';
import type { ExecutionInputBindingService } from './execution-input-binding.js';
import type { RuntimeExecutionService, RuntimeSession } from './runtime-execution.js';
import type { WorkResourceAccess, WorkResourceIdentity } from '../ports/work-resources.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { WorkSessionRecord, WorkSessionStore } from '../ports/work-session.js';
import type { RuntimeExecutionLimits, RuntimeExecutionRequest, RuntimeStopEvidence, RuntimeExecutionResult } from '../ports/runtime-execution.js';
import { RuntimeError, isRuntimeError } from '../ports/runtime-execution.js';
import { StorageError } from '../ports/errors.js';
import type { TaskDagStore } from '../ports/task-dag.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import { evaluateTaskDag } from './task-dag.js';
import { computeExecutionPermissionsDigest, TRUSTED_PROJECT_PERMISSIONS_READER, type ExecutionPermissionsReader } from '../ports/execution-input-prepare.js';
import type { WorkEvidenceRecorder, WorkEvidenceRecordingOutcome } from './work-evidence-recorder.js';
import type { RuntimeSettlementService } from './runtime-settlement.js';
import type { RuntimeRecoverySelection } from '../ports/runtime-recovery.js';
import type { RuntimeStrategyV1 } from '../ports/settings-schema.js';
import { createHash } from 'node:crypto';

export interface ExecutionServiceInput {
  readonly claim: TaskClaimReceipt;
  readonly workspace: unknown;
  readonly sessionId: string;
  readonly strategy: RuntimeStrategyV1;
  readonly permissions: { readonly grants: readonly string[]; readonly isolation: string };
  readonly limits: RuntimeExecutionLimits;
  readonly recovery: RuntimeRecoverySelection;
  readonly cwdRoot: string;
}

export interface ExecutionServiceResult {
  readonly session: WorkSessionRecord;
  readonly runtime: RuntimeSession;
  readonly invocationId: string;
  /** Events are owned by evidence recording; observe these promises instead. */
  readonly context: ExecutionContext;
}

export interface ExecutionContext {
  readonly request: RuntimeExecutionRequest;
  readonly runtime: RuntimeSession;
  readonly controller: AbortController;
  readonly result: Promise<PromiseSettledResult<RuntimeExecutionResult>>;
  readonly stopped: Promise<PromiseSettledResult<RuntimeStopEvidence>>;
  readonly recording: Promise<PromiseSettledResult<WorkEvidenceRecordingOutcome>>;
}

export interface ExecutionServiceDeps {
  readonly atomic: AtomicCommandStore;
  readonly resources: WorkResourceAccess;
  readonly sessions: WorkSessionStore;
  readonly inputBinding: ExecutionInputBindingService;
  readonly runtime: RuntimeExecutionService;
  readonly dag: TaskDagStore;
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  readonly recorder: WorkEvidenceRecorder;
  /** Trusted assembly; startup errors use the same fenced settlement as execution results. */
  readonly settlement?: RuntimeSettlementService;
  /** Trusted event identity rule supplied by the adapter assembly. */
  readonly eventIdentityPrefix: (request: RuntimeExecutionRequest) => string;
  readonly permissions?: ExecutionPermissionsReader;
  readonly nowUtcMs?: () => number;
}

export interface ExecutionService {
  start(input: unknown): Promise<ExecutionServiceResult>;
  get(projectId: string, attemptId: string): ExecutionContext | undefined;
  /** Only discard an observed, settled context; never releases resource leases. */
  forget(projectId: string, attemptId: string): boolean;
}

function startKey(attemptId: string, executionVersion: number): string {
  return createHash('sha256')
    .update(`shiploop:runtime-start\n${attemptId}\n${executionVersion}`)
    .digest('hex');
}

function identity(claim: TaskClaimReceipt): WorkResourceIdentity {
  const attempt = claim.attempt;
  return {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
}

function bindingInput(input: ExecutionServiceInput, invocationId: string): ExecutionInputBindingInput {
  return {
    schemaVersion: EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
    claim: input.claim,
    workspace: input.workspace,
    sessionId: input.sessionId,
    invocationId,
    strategy: input.strategy,
    permissions: input.permissions,
    limits: input.limits,
    recovery: input.recovery,
    cwdRoot: input.cwdRoot,
  };
}

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  if (deps === null || typeof deps !== 'object') throw new TypeError('ExecutionService dependencies are required');
  for (const name of ['atomic', 'resources', 'sessions', 'inputBinding', 'runtime', 'dag', 'attempts', 'recorder', 'eventIdentityPrefix'] as const) {
    if (deps[name] === undefined || deps[name] === null) throw new TypeError(`ExecutionService dependency ${name} is required`);
  }
  const contexts = new Map<string, { context: ExecutionContext; settled: boolean }>();
  const key = (projectId: string, attemptId: string) => JSON.stringify([projectId, attemptId]);
  return {
    start,
    get(projectId, attemptId) { return contexts.get(key(projectId, attemptId))?.context; },
    forget(projectId, attemptId) {
      const id = key(projectId, attemptId);
      if (!contexts.get(id)?.settled) return false;
      return contexts.delete(id);
    },
  };

  async function start(value: unknown): Promise<ExecutionServiceResult> {
    // Validate the complete binding shape before changing the durable launch gate.
    const input = validateServiceInput(value);
    const workIdentity = identity(input.claim);
    const invocationId = deps.atomic.transact('execution.begin-launch', () => {
      const result = deps.resources.beginLaunchInTransaction(workIdentity);
      if (!result.authorized || result.invocationId === null) {
        throw new StorageError('conflict', 'ExecutionService.start', 'Launch authorization denied');
      }
      return result.invocationId;
    });

    let bound: Awaited<ReturnType<ExecutionInputBindingService['bind']>>;
    let adapterVersion: string;
    let eventIdentityPrefix: string;
    try {
      // Binding may inspect workspace, artifacts and the filesystem. It is deliberately
      // after beginLaunch but outside the write transaction.
      bound = await deps.inputBinding.bind(bindingInput(input, invocationId));
      adapterVersion = deps.runtime.prepare(bound.request).adapterVersion;
      eventIdentityPrefix = deps.eventIdentityPrefix(bound.request);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(eventIdentityPrefix)) {
        throw new RuntimeError('configuration', 'invalid_event_identity_prefix');
      }
    } catch (error) {
      // beginLaunch is durable. Once binding has observed the authorized invocation,
      // quarantine the lease group on a pre-start failure; do not debit the Runtime
      // start budget or pretend the authorization never existed.
      quarantineUnstarted(workIdentity);
      throw error;
    }

    let reservedSession: WorkSessionRecord;
    try {
      reservedSession = deps.atomic.transact('execution.reserve-runtime-start', (transaction) => {
        assertAuthorized(input, invocationId);
        for (const ref of [...Object.values(input.claim.attempt.inputSnapshot.group), ...input.claim.attempt.inputSnapshot.requiredInputs]) {
          const current = transaction.getArtifactInputRef(workIdentity.projectId, ref.artifactId);
          if (current.version !== ref.version || current.contentHash !== ref.contentHash || current.sizeBytes !== ref.sizeBytes
            || current.locator !== ref.locator) {
            throw new RuntimeError('protocol', 'input_identity_changed');
          }
        }
        transaction.reserveRuntimeStart({
          projectId: input.claim.attempt.projectId,
          batchId: input.claim.batchId,
          runId: input.claim.attempt.runId,
          startKey: startKey(input.claim.attempt.id, input.claim.attempt.executionVersion),
        });
        const created = deps.sessions.createWorkSessionInTransaction(transaction, {
          ...workIdentity,
          sessionId: input.sessionId,
          purpose: 'work',
          runtime: input.strategy.runtime,
          adapterVersion,
        });
        return created.session;
      });
    } catch (error) {
      quarantineUnstarted(workIdentity);
      throw error;
    }

    let runtime: RuntimeSession;
    try {
      runtime = await deps.runtime.start(bound.request);
    } catch (error) {
      if (deps.settlement) {
        try {
          await deps.settlement.settle({ request: bound.request, result: { status: 'rejected', reason: error }, recording: null, stopped: null });
        } catch {
          // A failed evidence/DB commit cannot replace the original Runtime error or free the lease.
          quarantineUnstarted(workIdentity);
        }
        throw isRuntimeError(error) ? error : new RuntimeError('process', 'adapter_start_failed', { cause: error });
      }
      // The start budget remains consumed by design. Session is ended after the
      // adapter call, while the launch gate remains durable for diagnosis/recovery.
      try {
        deps.sessions.applyWorkSessionProgress({
          ...workIdentity,
          sessionId: reservedSession.id,
          expectedRevision: reservedSession.revision,
          kind: 'ended',
          executionStage: 'runtime',
          recordingGaps: [`runtime_start_failed:${isRuntimeError(error) ? error.kind : 'process'}`],
        });
      } catch {
        // Preserve the original adapter error; recovery can inspect the reserved row.
      }
      throw isRuntimeError(error) ? error : new RuntimeError('process', 'adapter_start_failed', { cause: error });
    }

    // Attach independent result/stop observers before any further persistence. A
    // failed progress write must not lose the live handle or leave rejections unobserved.
    const controller = new AbortController();
    const result = settled(runtime.result);
    const stopped = settled(runtime.stopped);
    let started: ReturnType<WorkSessionStore['applyWorkSessionProgress']>;
    let recording: ExecutionContext['recording'];
    try {
      started = deps.sessions.applyWorkSessionProgress({
        ...workIdentity, sessionId: reservedSession.id,
        expectedRevision: reservedSession.revision, kind: 'started', executionStage: 'runtime',
      });
      recording = settled(deps.recorder.record({ request: bound.request, handle: runtime, eventIdentityPrefix, signal: controller.signal }));
    } catch (error) {
      // Keep the handle and stop observation even when post-start persistence fails.
      recording = Promise.resolve({ status: 'rejected', reason: error });
      retain();
      void runtime.cancel().catch(() => undefined);
      throw error;
    }
    const context = retain();
    return { session: started.session, runtime, invocationId, context };

    function retain(): ExecutionContext {
      const context: ExecutionContext = { request: bound.request, runtime, controller, result, stopped, recording };
      const entry = { context, settled: false };
      contexts.set(key(workIdentity.projectId, workIdentity.attemptId), entry);
      void recording.then(outcome => {
        if (outcome.status === 'rejected') void runtime.cancel().catch(() => undefined);
      });
      void Promise.all([result, stopped, recording]).then(([, stop]) => {
        entry.settled = stop.status === 'fulfilled' && stop.value.confirmed;
      });
      return context;
    }
  }

  function quarantineUnstarted(workIdentity: WorkResourceIdentity): void {
    try {
      deps.atomic.transact('execution.quarantine-unstarted', () => {
        deps.resources.quarantineInTransaction(workIdentity);
      });
    } catch { /* Preserve the original failure; existing leases remain occupied. */ }
  }
  function assertAuthorized(input: ExecutionServiceInput, invocationId: string): void {
    const attempt = input.claim.attempt;
    const now = (deps.nowUtcMs ?? Date.now)();
    const deny = (reason: string): never => { throw new StorageError('conflict', 'ExecutionService.start', 'Runtime launch rejected', { details: { reason } }); };
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError('Invalid execution clock');
    const view = deps.dag.readTaskDagView(attempt.projectId, attempt.runId);
    const eligibility = evaluateTaskDag(view, now);
    // The claimed Attempt already owns global/project/workspace occupancy and its
    // Task is running. Reuse all DAG input, policy, approval and dependency checks.
    if (eligibility.reason !== 'resource_busy' || eligibility.tasks.find(task => task.taskId === attempt.taskId)?.reason !== 'resource_busy') {
      deny(eligibility.reason);
    }
    if (view.batch.id !== input.claim.batchId || view.run.projectId !== attempt.projectId) deny('claim_identity_mismatch');
    const fact = view.facts.find(task => task.taskId === attempt.taskId);
    const current = deps.attempts.getAttempt(attempt.projectId, attempt.id);
    if (!current || current.status !== 'preparing' || current.executionStage !== 'runtime'
      || current.invocationId !== invocationId || current.inputDigest !== attempt.inputDigest
      || current.owner !== attempt.owner || current.hostInstanceId !== attempt.hostInstanceId
      || current.executionVersion !== attempt.executionVersion || fact?.executionVersion !== attempt.executionVersion
      || current.leaseUntilUtcMs <= now) deny('stale_execution_identity');
    const resources = deps.resources.read(identity(input.claim));
    if (resources.invocationId !== invocationId || resources.leases.length !== 3
      || resources.leases.some(lease => lease.state !== 'held' || lease.leaseUntilUtcMs <= now)) deny('launch_not_held');
    const face = (deps.permissions ?? TRUSTED_PROJECT_PERMISSIONS_READER)({ projectId: attempt.projectId, featureId: attempt.featureId, taskId: attempt.taskId });
    if (computeExecutionPermissionsDigest(face.grants) !== attempt.inputSnapshot.digests.permissionsDigest) deny('permissions_changed');
    if (view.run.startedAtUtcMs !== null && now - view.run.startedAtUtcMs >= view.run.runTimeLimitMs) deny('run_time_exhausted');
    const limits = view.batch.budgetSnapshot.batch;
    if (now >= view.batch.deadlineAtUtcMs || now >= limits.deadlineUtcMs) deny('deadline_exhausted');
    if (view.batch.noProgressRuns >= limits.maxNoProgressRuns || limits.maxCostTotal !== undefined || limits.maxTokenTotal !== undefined) deny('budget_exhausted');
  }
}

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
}

function validateServiceInput(value: unknown): ExecutionServiceInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ExecutionService input must be an object');
  }
  const raw = value as Record<string, unknown>;
  const candidate = {
    schemaVersion: EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
    claim: raw.claim,
    workspace: raw.workspace,
    sessionId: raw.sessionId,
    invocationId: '00000000-0000-4000-8000-000000000000',
    strategy: raw.strategy,
    permissions: raw.permissions,
    limits: raw.limits,
    recovery: raw.recovery,
    cwdRoot: raw.cwdRoot,
  };
  // This validates all caller-controlled policy/input fields. invocationId is replaced
  // only because it is generated by beginLaunch and cannot be caller supplied.
  const checked = validateExecutionInputBindingInput(candidate);
  return {
    claim: checked.claim,
    workspace: checked.workspace,
    sessionId: checked.sessionId,
    strategy: checked.strategy,
    permissions: checked.permissions,
    limits: checked.limits,
    recovery: checked.recovery,
    cwdRoot: checked.cwdRoot,
  };
}
