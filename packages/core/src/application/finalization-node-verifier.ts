/**
 * P03-9 / F-011 受信 Node finalization Verifier 适配器。
 *
 * 复用既有 NodeTaskVerificationExecutor：同一个受监督 CommandProcess、
 * Artifact 证据、VerificationBatch/CheckResult 存储与停止信号。与普通 Task
 * 检查的区别只有：
 * - 计划来自当前已确认检查政策的 full_fallback，并只保留 F-009 scope 列出的
 *   检查键；
 * - 持久批次仍绑定历史 Attempt/Run 以满足存储身份约束，停止控制可按
 *   finalization Run 登记（controlRunId）；
 * - 不更新 Task/Run/Feature，不创建 Attempt，不启动 Runtime。
 */
import { randomUUID } from 'node:crypto';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { CommandProcessPort } from '../ports/command-process.js';
import { FEATURE_VERIFICATION_OPERATION } from '../ports/feature-verification.js';
import {
  FINALIZATION_TASK_VERIFICATION_OPERATION,
  type FinalizationCheckEvidence,
  type FinalizationFeatureVerificationInput,
  type FinalizationTaskRevalidationInput,
  type FinalizationVerificationEvidence,
  type FinalizationVerifier,
} from '../ports/finalization-execution.js';
import type { VerificationStore } from '../ports/verification-store.js';
import type { VerificationStopControl } from '../ports/verification-stop.js';
import { buildVerificationPlan, type VerificationPlan } from './verification-plan.js';
import { createNodeTaskVerificationExecutor, type NodeTaskVerificationResult } from './node-task-verification.js';

export interface FinalizationFeatureAnchor {
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
}

export interface NodeFinalizationVerifierOptions {
  readonly processes: CommandProcessPort;
  readonly verification: VerificationStore;
  readonly atomic: AtomicCommandStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly attempts: Pick<AttemptStore, 'listTaskAttempts'>;
  /** 当前已确认检查政策（由受信装配按项目读取；不接受客户端提交）。 */
  readonly readPolicy: (input: {
    readonly projectId: string;
    readonly featureId: string;
  }) => unknown | Promise<unknown>;
  readonly resolveCwd: (cwdRef: string | null) => Promise<string>;
  readonly resolveEnvironment: (environmentRef: string | null) => Readonly<Record<string, string>>;
  /** Feature 全量检查必须绑定当前 Feature 的一个真实历史 Attempt（存储锚点）。 */
  readonly resolveFeatureAnchor: (
    input: FinalizationFeatureVerificationInput,
  ) => FinalizationFeatureAnchor | Promise<FinalizationFeatureAnchor>;
  readonly environmentSummary?: (
    input: FinalizationTaskRevalidationInput | FinalizationFeatureVerificationInput,
  ) => Readonly<Record<string, unknown>>;
  readonly stopControl?: VerificationStopControl;
  readonly nowUtcMs?: () => number;
}

function planFor(policy: unknown, checkKeys: readonly string[]): VerificationPlan | null {
  let plan: VerificationPlan;
  try {
    plan = buildVerificationPlan({ policy, changedPaths: [], candidate: null });
  } catch {
    return null;
  }
  if (plan.status !== 'ready' || plan.mode !== 'full_fallback') return null;
  const selected = checkKeys.map(checkKey => plan.selectedChecks.find(check => check.checkKey === checkKey));
  if (selected.some(check => check === undefined)) return null;
  const checks = selected as NonNullable<(typeof selected)[number]>[];
  return { ...plan, selectedChecks: checks, selectedCheckKeys: checks.map(check => check.checkKey) };
}

function evidenceFrom(
  operation: string,
  batchId: string,
  result: NodeTaskVerificationResult,
): FinalizationVerificationEvidence {
  const checks: FinalizationCheckEvidence[] = result.results.map(item => ({
    checkKey: item.checkKey,
    status: item.status,
    resultId: item.resultId,
    outputArtifactId: item.evidence?.output?.artifactId ?? null,
    testCount: item.testCount,
  }));
  return {
    batchId,
    operation,
    status: result.status,
    invalidated: false,
    checks,
    reason: result.results.find(item => item.status !== 'passed')?.reason ?? null,
  };
}

function rejectedEvidence(operation: string, reason: string): FinalizationVerificationEvidence {
  return {
    batchId: `not-started-${randomUUID()}`,
    operation,
    status: 'inconclusive',
    invalidated: false,
    checks: [],
    reason,
  };
}

export function createNodeFinalizationVerifier(options: NodeFinalizationVerifierOptions): FinalizationVerifier {
  const now = options.nowUtcMs ?? Date.now;
  const executor = createNodeTaskVerificationExecutor({
    processes: options.processes,
    verification: options.verification,
    atomic: options.atomic,
    artifacts: options.artifacts,
    files: options.files,
    resolveCwd: options.resolveCwd,
    resolveEnvironment: options.resolveEnvironment,
    confirmProcessIdentity: async () => undefined,
    nowUtcMs: now,
    ...(options.stopControl === undefined ? {} : { stopControl: options.stopControl }),
  });

  function environment(
    input: FinalizationTaskRevalidationInput | FinalizationFeatureVerificationInput,
  ): Readonly<Record<string, unknown>> {
    return options.environmentSummary?.(input) ?? {
      workspace: { headCommit: input.headCommit, codeDigest: input.codeDigest },
    };
  }

  async function runTask(
    input: FinalizationTaskRevalidationInput,
    plan: VerificationPlan,
    attempt: { id: string; executionVersion: number; runId: string },
  ): Promise<FinalizationVerificationEvidence> {
    const batchId = randomUUID();
    const result = await executor.start({
      projectId: input.projectId,
      featureId: input.featureId,
      runId: input.historicalRunId,
      controlRunId: input.finalizationRunId,
      taskId: input.taskId,
      attemptId: attempt.id,
      executionVersion: attempt.executionVersion,
      batchId,
      operation: FINALIZATION_TASK_VERIFICATION_OPERATION,
      evidenceOperationId: randomUUID(),
      codeDigest: input.codeDigest,
      codeIdentity: {
        headCommit: input.headCommit,
        workingTreeDigest: input.codeDigest,
        hasUncommittedChanges: true,
      },
      policyDigest: input.checkPolicyDigest,
      environmentSummary: environment(input),
      plan: { status: plan.status, selectedChecks: plan.selectedChecks },
      targets: [...input.checkKeys],
      selectionMode: 'full_fallback',
      deadlineUtcMs: input.deadlineUtcMs,
      signal: input.signal,
    });
    return evidenceFrom(FINALIZATION_TASK_VERIFICATION_OPERATION, batchId, result);
  }

  return {
    async revalidateTask(input) {
      const attempts = [...options.attempts.listTaskAttempts(input.projectId, input.taskId)]
        .sort((left, right) => left.number - right.number);
      const attempt = attempts[attempts.length - 1];
      if (attempt === undefined || attempt.featureId !== input.featureId
        || attempt.runId !== input.historicalRunId) {
        return rejectedEvidence(FINALIZATION_TASK_VERIFICATION_OPERATION, 'task_attempt_missing');
      }
      const plan = planFor(await options.readPolicy({ projectId: input.projectId, featureId: input.featureId }),
        input.checkKeys);
      if (plan === null) return rejectedEvidence(FINALIZATION_TASK_VERIFICATION_OPERATION, 'verification_plan_unavailable');
      return runTask(input, plan, {
        id: attempt.id,
        executionVersion: attempt.executionVersion,
        runId: attempt.runId,
      });
    },
    async verifyFeature(input) {
      const anchor = await options.resolveFeatureAnchor(input);
      const plan = planFor(await options.readPolicy({ projectId: input.projectId, featureId: input.featureId }),
        input.checkKeys);
      if (plan === null) return rejectedEvidence(FEATURE_VERIFICATION_OPERATION, 'verification_plan_unavailable');
      const batchId = randomUUID();
      const result = await executor.start({
        projectId: input.projectId,
        featureId: input.featureId,
        runId: input.historicalRunId,
        controlRunId: input.finalizationRunId,
        taskId: anchor.taskId,
        attemptId: anchor.attemptId,
        executionVersion: anchor.executionVersion,
        batchId,
        operation: FEATURE_VERIFICATION_OPERATION,
        evidenceOperationId: randomUUID(),
        codeDigest: input.codeDigest,
        codeIdentity: {
          headCommit: input.headCommit,
          workingTreeDigest: input.codeDigest,
          hasUncommittedChanges: true,
        },
        policyDigest: input.checkPolicyDigest,
        environmentSummary: environment(input),
        plan: { status: plan.status, selectedChecks: plan.selectedChecks },
        targets: [...input.checkKeys],
        selectionMode: 'full_fallback',
        deadlineUtcMs: input.deadlineUtcMs,
        signal: input.signal,
      });
      return evidenceFrom(FEATURE_VERIFICATION_OPERATION, batchId, result);
    },
  };
}
