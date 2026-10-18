/**
 * P03-9 / F-003：Run/Batch 取消提交后的停止控制。
 *
 * 不变量：
 * - 只在取消回执/停止 operation 已提交后运行；不重新解释命令授权，不修改预算、
 *   deadline、历史 Attempt 或代码；
 * - Runtime 停止复用 ExecutionService.cancel（其底层 CommandProcess 已有宽限/
 *   身份核验/必要升级/整组缺席确认）；Verifier 停止复用 AbortSignal 驱动的同一
 *   CommandProcess 停止路径；本模块不新建通用进程管理器；
 * - 停止未确认、旧组不可核对、探测失败或仍可能写文件时，只把仍活动的 Attempt
 *   标记 interrupted 并隔离租约，绝不释放占用、绝不倒写终态；
 * - 已确认停止也只交由既有生命周期/保留步骤释放；本模块在没有活动 Attempt 与
 *   租约时保守收尾目标。证据 Artifact 记录身份、阶段、退出码/信号、强制终止
 *   观察与记录缺口；未知字段保持 null。
 */
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { AttemptRecord, AttemptStore } from '../ports/attempt-store.js';
import type { WorkResourceAccess, WorkResourceIdentity } from '../ports/work-resources.js';
import type { VerificationStopControl, VerificationStopEvidence } from '../ports/verification-stop.js';
import type {
  ExecutionStopAttemptEvidence,
  ExecutionStopControlPort,
  ExecutionStopEvidence,
  ExecutionStopOutcome,
  ExecutionStopRequest,
} from '../ports/execution-stop.js';
import { EXECUTION_STOP_EVIDENCE_KIND, EXECUTION_STOP_EVIDENCE_SCHEMA_VERSION } from '../ports/execution-stop.js';
import type { ExecutionCompletion } from './execution-supervision.js';

export interface ExecutionStopControlDeps {
  readonly atomic: AtomicCommandStore;
  readonly attempts: Pick<AttemptStore, 'getAttempt' | 'listActiveAttempts' | 'listAttemptsWithLeases'>;
  readonly resources: Pick<WorkResourceAccess, 'read' | 'quarantineInTransaction'>;
  readonly stopRuntime: (identity: WorkResourceIdentity) => Promise<ExecutionCompletion | null>;
  readonly verifiers: VerificationStopControl;
  readonly publishEvidence: (projectId: string, operationId: string, evidence: ExecutionStopEvidence) => Promise<string>;
  readonly nowUtcMs?: () => number;
}

type RuntimeObservation = {
  readonly attempt: AttemptRecord;
  readonly completion: ExecutionCompletion | null;
  readonly error: string | null;
};

function identityOf(attempt: AttemptRecord): WorkResourceIdentity {
  return {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function forcedOf(values: readonly (boolean | null)[]): boolean | null {
  if (values.some(value => value === true)) return true;
  if (values.length > 0 && values.every(value => value === false)) return false;
  return null;
}

export function createExecutionStopControl(deps: ExecutionStopControlDeps): ExecutionStopControlPort {
  if (deps === null || typeof deps !== 'object') throw new TypeError('ExecutionStopControl dependencies are required');
  for (const name of ['atomic', 'attempts', 'resources', 'stopRuntime', 'verifiers', 'publishEvidence'] as const) {
    if (deps[name] === undefined || deps[name] === null) throw new TypeError(`ExecutionStopControl dependency ${name} is required`);
  }
  const now = deps.nowUtcMs ?? Date.now;

  return {
    async stop(input: ExecutionStopRequest): Promise<ExecutionStopOutcome | null> {
      if (input === null || typeof input !== 'object'
        || typeof input.projectId !== 'string' || typeof input.stopOperationId !== 'string') {
        throw new TypeError('ExecutionStopControl.stop input is invalid');
      }
      const operation = deps.atomic.getExecutionStopOperation(input.projectId, input.stopOperationId);
      if (operation === undefined || operation.projectId !== input.projectId) return null;
      // Terminal/idempotent operation: never proof-read or replay a stop.
      if (operation.status !== 'stopping') return null;

      const active = deps.attempts.listActiveAttempts(input.projectId, operation.targetKind, operation.targetId);
      const leased = deps.attempts.listAttemptsWithLeases(input.projectId, operation.targetKind, operation.targetId);
      const byId = new Map(active.map(attempt => [attempt.id, attempt]));
      for (const attempt of leased) byId.set(attempt.id, attempt);
      const stopping = [...byId.values()];
      const verifierStop = deps.verifiers.stop({
        projectId: input.projectId,
        targetKind: operation.targetKind,
        targetId: operation.targetId,
      });
      const runtimeStops = Promise.all(stopping.map(async (attempt): Promise<RuntimeObservation> => {
        try {
          const completion = await deps.stopRuntime(identityOf(attempt));
          return { attempt, completion, error: null };
        } catch (error) {
          return { attempt, completion: null, error: error instanceof Error ? error.name : 'stop_failed' };
        }
      }));
      const [runtimeObservations, verifierEvidence] = await Promise.all([runtimeStops, verifierStop]);
      const checkedAt = now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < 1) throw new TypeError('Invalid execution stop clock');

      const attemptsEvidence: ExecutionStopAttemptEvidence[] = [];
      const gaps: string[] = [];
      const forcedValues: (boolean | null)[] = [];
      const interrupted: string[] = [];
      let confirmed = true;

      for (const observation of runtimeObservations) {
        const current = safeAttempt(observation.attempt);
        const identity = identityOf(observation.attempt);
        const leases = safeLeases(identity);
        const completion = observation.completion;
        const verifier = verifierEvidence.filter(item => item.key.attemptId === observation.attempt.id);
        const verifierConfirmed = verifier.length > 0 && verifier.every(item => item.stopConfirmed);
        const verifierUnconfirmed = verifier.some(item => !item.stopConfirmed);
        const runtimeConfirmed = completion?.stopConfirmed === true;
        const attemptStillActive = current === null
          ? false
          : ['preparing', 'executing', 'verifying'].includes(current.status);
        let attemptConfirmed: boolean;
        let state: ExecutionStopAttemptEvidence['state'];
        const attemptGaps: string[] = [];
        if (verifierUnconfirmed) {
          // A verifier batch may still write; runtime stop alone cannot confirm the Attempt.
          attemptConfirmed = false;
          state = 'unconfirmed';
          attemptGaps.push('verifier_stop_unconfirmed');
        } else if (completion !== null && runtimeConfirmed) {
          attemptConfirmed = true;
          state = 'stopped';
        } else if (completion !== null) {
          attemptConfirmed = false;
          state = 'unconfirmed';
          attemptGaps.push('runtime_stop_unconfirmed');
        } else if (verifierConfirmed && verifier.length > 0) {
          attemptConfirmed = true;
          state = verifier.some(item => item.state === 'stopped') ? 'stopped' : 'not_started';
          for (const item of verifier) attemptGaps.push(...item.gaps);
        } else if (!attemptStillActive && leases.length === 0) {
          // The Attempt ended and no lease remains: no controlled process is known to be live.
          attemptConfirmed = true;
          state = 'not_started';
          attemptGaps.push('attempt_inactive_before_stop');
        } else {
          attemptConfirmed = false;
          state = 'unconfirmed';
          attemptGaps.push(verifierUnconfirmed ? 'verifier_stop_unconfirmed' : 'stop_not_observed');
          if (observation.error !== null) attemptGaps.push('runtime_stop_failed');
        }
        if (leases.length > 0 && !attemptConfirmed) attemptGaps.push('occupancy_retained');
        const forced = completion?.forced ?? null;
        if (forced !== null) forcedValues.push(forced);
        gaps.push(...attemptGaps);
        if (!attemptConfirmed) {
          confirmed = false;
          interrupted.push(observation.attempt.id);
        }
        attemptsEvidence.push({
          attemptId: observation.attempt.id,
          taskId: observation.attempt.taskId,
          featureId: observation.attempt.featureId,
          runId: observation.attempt.runId,
          owner: observation.attempt.owner,
          hostInstanceId: observation.attempt.hostInstanceId,
          executionVersion: observation.attempt.executionVersion,
          executionStage: current?.executionStage ?? observation.attempt.executionStage,
          attemptStatus: current?.status ?? null,
          state,
          stopConfirmed: attemptConfirmed,
          exitCode: completion?.exitCode ?? current?.exitCode ?? null,
          signal: completion?.signal ?? null,
          forced,
          settlementRef: current?.diagnosticRef ?? null,
          gaps: unique(attemptGaps),
        });
      }

      // Verifier batches not tied to an active Attempt still participate in the verdict.
      for (const evidence of verifierEvidence) {
        if (stopping.some(attempt => attempt.id === evidence.key.attemptId)) continue;
        if (!evidence.stopConfirmed) {
          confirmed = false;
          gaps.push(...evidence.gaps.map(gap => `verifier:${gap}`));
        }
      }
      if (verifierEvidence.some(item => !item.stopConfirmed)) confirmed = false;

      const evidence: ExecutionStopEvidence = {
        schemaVersion: EXECUTION_STOP_EVIDENCE_SCHEMA_VERSION,
        kind: EXECUTION_STOP_EVIDENCE_KIND,
        projectId: input.projectId,
        stopOperationId: operation.id,
        targetKind: operation.targetKind,
        targetId: operation.targetId,
        batchId: operation.batchId,
        runId: operation.runId,
        requestedAtUtc: new Date(operation.requestedAtUtcMs).toISOString(),
        checkedAtUtc: new Date(checkedAt).toISOString(),
        outcome: confirmed ? 'stopped' : 'unconfirmed',
        stopConfirmed: confirmed,
        forced: forcedOf(forcedValues),
        attempts: attemptsEvidence,
        verifiers: verifierEvidence,
        gaps: unique(gaps),
      };
      const evidenceRef = await deps.publishEvidence(input.projectId, operation.id, evidence);

      const apply = (): { status: 'stopped' | 'uncertain'; interrupted: readonly string[] } =>
        deps.atomic.transact('execution.stop.settle', transaction => {
          if (confirmed) {
            transaction.settleExecutionStop({
              projectId: input.projectId,
              stopOperationId: operation.id,
              status: 'stopped',
              evidenceRef,
              stopConfirmed: true,
              forced: evidence.forced,
              checkedAtUtcMs: checkedAt,
            });
            return { status: 'stopped' as const, interrupted: [] };
          }
          const changed: string[] = [];
          for (const attempt of attemptsEvidence) {
            if (!interrupted.includes(attempt.attemptId)) continue;
            const identity: WorkResourceIdentity = {
              projectId: input.projectId,
              attemptId: attempt.attemptId,
              owner: attempt.owner,
              hostInstanceId: attempt.hostInstanceId,
              executionVersion: attempt.executionVersion,
            };
            if (transaction.interruptAttemptForStop({
              projectId: input.projectId,
              attemptId: attempt.attemptId,
              diagnosticRef: evidenceRef,
              timestamp: checkedAt,
            })) changed.push(attempt.attemptId);
            try {
              if (deps.resources.read(identity).leases.length > 0) deps.resources.quarantineInTransaction(identity);
            } catch {
              // Stale identity/occupancy: retain whatever the durable state already says.
            }
          }
          transaction.settleExecutionStop({
            projectId: input.projectId,
            stopOperationId: operation.id,
            status: 'uncertain',
            evidenceRef,
            stopConfirmed: false,
            forced: evidence.forced,
            checkedAtUtcMs: checkedAt,
          });
          return { status: 'uncertain' as const, interrupted: changed };
        });

      const settled = apply();
      return {
        stopConfirmed: confirmed,
        evidenceRef,
        evidence,
        operationStatus: settled.status,
        interruptedAttemptIds: settled.interrupted,
      };
    },
  };

  function safeAttempt(attempt: AttemptRecord): AttemptRecord | null {
    try { return deps.attempts.getAttempt(attempt.projectId, attempt.id); } catch { return null; }
  }
  function safeLeases(identity: WorkResourceIdentity): readonly unknown[] {
    try { return deps.resources.read(identity).leases; } catch { return []; }
  }
}

/** Exposed for tests/tests-of-contract; evidence is plain bounded JSON. */
export function isValidExecutionStopEvidence(value: unknown): value is ExecutionStopEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== EXECUTION_STOP_EVIDENCE_SCHEMA_VERSION || raw.kind !== EXECUTION_STOP_EVIDENCE_KIND) return false;
  if (typeof raw.stopConfirmed !== 'boolean' || (raw.outcome !== 'stopped' && raw.outcome !== 'unconfirmed')) return false;
  if (!Array.isArray(raw.attempts) || !Array.isArray(raw.verifiers) || !Array.isArray(raw.gaps)) return false;
  for (const item of raw.attempts) {
    if (item === null || typeof item !== 'object') return false;
    const attempt = item as Record<string, unknown>;
    if (typeof attempt.stopConfirmed !== 'boolean') return false;
    if (attempt.exitCode !== null && !Number.isSafeInteger(attempt.exitCode)) return false;
    if (attempt.forced !== null && typeof attempt.forced !== 'boolean') return false;
  }
  return true;
}

export type { VerificationStopEvidence };
