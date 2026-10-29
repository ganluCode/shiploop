/**
 * P03-7 / F-012：受信 Task 验证收尾入口。
 *
 * 只做三件事，不新增第二套状态机：
 * 1. 从已定版 VerificationBatch/CheckResult 只读重建机器观察（复用 F-006
 *    aggregateStored/F-009 classify），得到 outcome 与 observationDigest；
 * 2. （必需且仅一次）为验证中的 Attempt 记录代码现场制品引用 code_ref；
 * 3. 经既有 F-010 submitVerification 单事务结算预算并按结论推进：
 *    · passed + 人审有效 → 完成 Attempt/Task；
 *    · passed + 人审缺失 → 保存机器证据，等待批准（不调用 Runtime）；
 *    · code_failure + 代码资格未尽 → Task 回 pending、Run 回 running，
 *      由既有调度重新认领同 worktree 返工（快照由 F-011 契约携带）；
 *    · code_failure + 额度耗尽 → Task failed，依赖后继 blocked；
 *    · non_code_failure → 独立 infrastructure_error 暂停分支，不进代码返工循环。
 *
 * 旧 Runtime/Verifier 停止证据在提交前再次核对：停止未确认时不携带释放
 * 证据提交，占用保留隔离并拒绝重跑。本入口不运行检查、不启动 Runtime、
 * 不解除人工阻塞，也不建设 P03-9 的通用取消/重启恢复。
 */
import { createHash } from 'node:crypto';
import type { ArtifactPublisher } from './artifact-publish.js';
import { classifyStoredCodeAttempt } from './code-attempt-budget.js';
import type { CheckFailureKind } from './code-attempt-budget.js';
import type { StoredVerificationAggregationInput } from './verification-aggregate-service.js';
import type { AttemptLifecycleStore, AttemptApplicationResult } from '../ports/attempt-lifecycle.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { VerificationStore } from '../ports/verification-store.js';
import type { WorkResourceIdentity, WorkResourceStopVerifier, WorkResourceAccess } from '../ports/work-resources.js';
import { StorageError } from '../ports/errors.js';

export interface TaskVerificationCompletionInput {
  readonly identity: WorkResourceIdentity;
  readonly taskId: string;
  readonly runId: string;
  readonly verificationBatchId: string;
  /** F-006 已定版机器观察（批次外的运行时/占用/前后代码身份等事实）。 */
  readonly observation: Omit<StoredVerificationAggregationInput, 'projectId' | 'batchId'>;
  /** F-009 适配器核验的逐检查失败类别；空表即全部视为代码失败判定依据缺失时回退非代码。 */
  readonly failures: Readonly<Record<string, CheckFailureKind>>;
}

export interface TaskVerificationCompletionResult {
  readonly receipt: AttemptApplicationResult;
  readonly outcome: 'passed' | 'code_failure' | 'non_code_failure';
  readonly reason: string;
  readonly observationDigest: string;
  readonly codeRef: string;
  readonly stopConfirmed: boolean;
}

export interface TaskVerificationCompletionService {
  complete(input: unknown): Promise<TaskVerificationCompletionResult>;
}

export function createTaskVerificationCompletionService(deps: {
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  readonly resources: Pick<WorkResourceAccess, 'read'>;
  readonly stopVerifier: WorkResourceStopVerifier;
  readonly verification: VerificationStore;
  readonly lifecycle: AttemptLifecycleStore;
  readonly publisher: ArtifactPublisher;
  /** Trusted local Git delivery; missing adapter can never grant Task passed. */
  readonly commitTask?: (input: TaskVerificationCompletionInput) => Promise<void>;
  readonly verifyEvidence?: (projectId: string, batchId: string) => Promise<void>;
  readonly nowMs?: () => number;
}): TaskVerificationCompletionService {
  if (deps.lifecycle.recordAttemptCode === undefined) {
    throw new StorageError('corrupt', 'TaskVerificationCompletion.create', 'Lifecycle store lacks attempt code recording');
  }
  const recordAttemptCode = deps.lifecycle.recordAttemptCode;
  return { async complete(raw) {
    const input = raw as TaskVerificationCompletionInput;
    const { identity } = input;
    // 1) 只读重建机器观察：批次↔Attempt 身份、前后代码身份与证据一致性
    //    全部由 F-006/F-009 契约核对，不一致即抛结构化冲突，不产生部分写入。
    await deps.verifyEvidence?.(identity.projectId, input.verificationBatchId);
    const classified = classifyStoredCodeAttempt(deps.verification,
      { projectId: identity.projectId, batchId: input.verificationBatchId, runId: input.runId,
        taskId: input.taskId, attemptKey: identity.attemptId },
      { projectId: identity.projectId, batchId: input.verificationBatchId, ...input.observation },
      input.failures);
    // 2) 验证中 Attempt 的代码现场引用：已记录则复用（不可变、不覆盖），
    //    未记录则把批次核验过的代码身份发布为不可变制品并 CAS 记录。
    let attempt = deps.attempts.getAttempt(identity.projectId, identity.attemptId);
    if (attempt.owner !== identity.owner || attempt.hostInstanceId !== identity.hostInstanceId
      || attempt.executionVersion !== identity.executionVersion || attempt.taskId !== input.taskId
      || attempt.runId !== input.runId) {
      throw new StorageError('conflict', 'TaskVerificationCompletion.complete', 'Attempt identity does not match the submission');
    }
    let codeRef = attempt.codeRef;
    if (codeRef === null) {
      const body = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        kind: 'workspace-code-identity',
        attemptId: identity.attemptId,
        taskId: input.taskId,
        runId: input.runId,
        verificationBatchId: input.verificationBatchId,
        codeDigest: classified.batch.codeDigest,
        headCommit: input.observation.afterIdentity.headCommit,
      }), 'utf8');
      const published = await deps.publisher.publishArtifact({
        projectId: identity.projectId, kind: 'workspace_code', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'),
        locator: `attempts/${identity.attemptId}/code-identity.json`, content: [body],
      });
      const recorded = recordAttemptCode({ identity, expectedRevision: attempt.revision, codeRef: published.artifact.id });
      codeRef = recorded.codeRef;
      attempt = deps.attempts.getAttempt(identity.projectId, identity.attemptId);
    }
    if (classified.assessment.outcome === 'passed' && deps.commitTask) {
      await deps.commitTask(input);
    }
    // 3) 提交前再次核对旧 Runtime/Verifier 停止证据：受信 stop verifier 对
    //    当前占用快照复核；未确认（null）即不携带释放证据提交。
    let stopToken: object | null = null;
    try {
      stopToken = await deps.stopVerifier.verify(deps.resources.read(identity));
    } catch {
      stopToken = null;
    }
    const receipt = deps.lifecycle.submitVerification({
      ...identity, taskId: input.taskId, runId: input.runId,
      verificationBatchId: input.verificationBatchId, codeDigest: classified.batch.codeDigest,
      observationDigest: classified.observationDigest, outcome: classified.assessment.outcome,
    }, stopToken ?? undefined);
    return { receipt, outcome: classified.assessment.outcome, reason: classified.assessment.reason,
      observationDigest: classified.observationDigest, codeRef, stopConfirmed: receipt.stopConfirmed };
  } };
}
