/**
 * P03-7 / F-012：人工批准后的授权显式验证继续。
 *
 * 只推进当前验证收尾：复用第一次提交时已定版保存的机器证据（预算结算
 * observationDigest + 已定版 passed 批次），在同一命令事务内经既有
 * AttemptLifecycle.submitVerification 完成放行。未变代码、定义、环境和证据
 * 才可复用；任何身份漂移（批次/代码摘要、Task 修订、批准状态）都以
 * conflict 拒绝并要求重验/重新批准。不再次调用 Runtime，不创建 Attempt，
 * 不解除人工阻塞；迟到成功与重复继续经 commandId 回执与观察幂等吸收，
 * 不产生重复副作用。
 */
import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { CODE_ATTEMPT_SETTLEMENT_PREFIX } from '../ports/code-attempt-budget.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { VerificationStore } from '../ports/verification-store.js';
import type { AttemptApplicationResult } from '../ports/attempt-lifecycle.js';
import { createCompletedReceipt, PublicError, type AppCapability, type CommandReceipt, type ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';

export const TASK_VERIFICATION_CONTINUE_OPERATION = 'task.verification.continue' as const;
export type TaskVerificationContinueEnvelope = Extract<ValidatedCommandEnvelope, { operation: typeof TASK_VERIFICATION_CONTINUE_OPERATION }>;

export interface TaskVerificationContinueDeps {
  /** 在短写事务外核对当前代码、环境及证据正文；无法证明有效时必须拒绝。 */
  verifyCurrentEvidence(envelope: TaskVerificationContinueEnvelope): Promise<unknown>;
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  readonly verification: Pick<VerificationStore, 'getVerificationBatch'>;
  /** 同库短写事务内复用 F-010 放行逻辑（不开嵌套事务）。 */
  readonly lifecycle: {
    submitVerificationInTransaction(transaction: CommandTransaction, input: unknown, verifierStopEvidence?: unknown): AttemptApplicationResult;
  };
}

/** 首版只复用可在当前 Node Host 核对的环境；未知字段不能被忽略。 */
export function assertVerificationReuseIdentity(
  saved: { codeDigest: string; environmentSummary: Readonly<Record<string, unknown>> },
  currentCodeDigest: string | null,
): void {
  const env = saved.environmentSummary;
  if (currentCodeDigest !== saved.codeDigest || env.runner !== 'node'
    || env.nodeVersion !== process.version || env.platform !== process.platform
    || Object.keys(env).some(key => !['runner', 'nodeVersion', 'platform'].includes(key))) {
    throw new PublicError('conflict', TASK_VERIFICATION_CONTINUE_OPERATION, undefined,
      { details: { reason: 'verification_evidence_stale' } });
  }
}

/** Used before external Git I/O and again in its authorization transaction. */
export function validateTaskVerificationContinue(envelope: TaskVerificationContinueEnvelope,
  transaction: CommandTransaction, deps: Pick<TaskVerificationContinueDeps, 'attempts' | 'verification'>) {
  const identity = { operation: TASK_VERIFICATION_CONTINUE_OPERATION };
  const projectId = envelope.scope.projectId;
  const payload = envelope.payload;
  transaction.getProject(projectId);
  const task = transaction.getTask(projectId, payload.taskId);
  // Task 修订 CAS：批准/阻塞/策略等并发变化使旧继续请求过期，要求重新确认。
  if (task.revision !== envelope.expectedRevision) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'task_revision_conflict' } });
  }
  const attempt = deps.attempts.getAttempt(projectId, payload.attemptId);
  if (attempt.taskId !== payload.taskId || attempt.projectId !== projectId || attempt.featureId !== task.featureId) {
    throw new PublicError('not_found', identity.operation, undefined, { details: { entityType: 'task' } });
  }
  if (attempt.status !== 'verifying' || attempt.executionStage !== 'verification') {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'attempt_not_awaiting_verification_release' } });
  }
  // 已保存机器证据：第一次提交在等待批准时已完成幂等预算结算；其
  // observationDigest 是复用有效性的权威身份。未结算过说明没有可继续的证据。
  const reservation = transaction.getTaskAttemptReservation(projectId, payload.taskId, payload.attemptId);
  if (reservation === null || !reservation.reason?.startsWith(CODE_ATTEMPT_SETTLEMENT_PREFIX)) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'saved_observation_required' } });
  }
  let settled: { outcome?: unknown; observationDigest?: unknown };
  try {
    settled = JSON.parse(reservation.reason.slice(CODE_ATTEMPT_SETTLEMENT_PREFIX.length)) as typeof settled;
  } catch {
    throw new PublicError('corrupt_state', identity.operation, undefined, { details: { reason: 'settlement_reason_corrupt' } });
  }
  if (settled.observationDigest !== payload.observationDigest) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'observation_digest_mismatch' } });
  }
  if (settled.outcome !== 'passed') {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'continue_requires_passed_observation' } });
  }
  // 已定版 passed 批次身份逐项比对：代码/批次摘要漂移即拒绝（变化后重验）。
  const batch = deps.verification.getVerificationBatch(projectId, payload.verificationBatchId);
  if (batch.taskId !== payload.taskId || batch.attemptId !== payload.attemptId || batch.runId !== attempt.runId
    || batch.executionVersion !== attempt.executionVersion || batch.codeDigest !== payload.codeDigest
    || batch.status !== 'passed') {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'verification_batch_identity_mismatch' } });
  }
  return { attempt, batch };
}

export function submitTaskVerificationContinue(identity: {
  readonly principalId: string;
  readonly capabilities: ReadonlySet<AppCapability>;
  readonly commandId: string;
  readonly operation: typeof TASK_VERIFICATION_CONTINUE_OPERATION;
  readonly scope: TaskVerificationContinueEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}, envelope: TaskVerificationContinueEnvelope, transaction: CommandTransaction, deps: TaskVerificationContinueDeps,
  stopEvidence?: unknown): CommandReceipt {
  const projectId = envelope.scope.projectId;
  const payload = envelope.payload;
  const { attempt } = validateTaskVerificationContinue(envelope, transaction, deps);
  // 复用既有放行：批准仍缺失/新增阻塞时保持等待（不重复扣预算/写事件）；
  // 批准有效时 CAS 完成 Attempt/Task；迟到/过期身份由 submitVerification 拒绝。
  const submission = deps.lifecycle.submitVerificationInTransaction(transaction, {
    projectId, attemptId: payload.attemptId, taskId: payload.taskId, runId: attempt.runId,
    owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
    verificationBatchId: payload.verificationBatchId, codeDigest: payload.codeDigest,
    observationDigest: payload.observationDigest, outcome: 'passed',
  }, stopEvidence);
  const receipt = createCompletedReceipt({ ...identity, resultRef: createResultRef(randomBytes(32)),
    result: { taskId: payload.taskId, attemptId: payload.attemptId, verificationBatchId: payload.verificationBatchId,
      disposition: submission.disposition, status: submission.status, waitingFor: submission.waitingFor,
      reason: submission.reason, runtimeCalled: false, executionStarted: false } });
  transaction.saveReceipt(receipt);
  return receipt;
}
