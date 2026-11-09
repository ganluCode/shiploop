/**
 * DAG / F-002：已批准规划基线的读取侧投影（SQLite 只读）。
 *
 * 职责：把「Feature 当前获准计划由哪次规划批准应用、其规划 Run 冻结的代码
 * 快照是什么」从持久事实中核验性地读出，供正式编码准备（execution.start
 * 的 workspaceBaseline 解析）使用。不修改任何状态、不发起 I/O。
 *
 * 身份传播链（全部可核验，不引入新事实源）：
 * 1. planning_contexts（decision=approved、applied_revision 非空）→ 该规划的
 *    Run 与决策时间；
 * 2. approvals（feature_plan、subject_digest=当前 planDigest、approved、
 *    decided_at 与上下文决策同一事务时间戳）→ 确认当前计划正是该次规划批准
 *    所应用的计划（计划后来被导入/修订取代时不回溯绑定旧快照）；
 * 3. 该 Run 的 planning Attempt input_snapshot（isPlanningAttemptSnapshot）→
 *    codeBaseline + digests.codeBaselineDigest 逐项重核。
 *
 * fail-closed：存在已批准规划上下文且当前计划确由其应用，但 Attempt 证据
 * 缺失、快照形态非法或基线摘要不一致时抛 StorageError(conflict)，由调用方
 * 结构化阻塞编码，不静默回退到当前 HEAD。
 */
import type { SqliteStorageSession } from './session.js';
import { StorageError } from '../../ports/errors.js';
import { isPlanningAttemptSnapshot } from '../../ports/attempt-store.js';
import type { AttemptInputSnapshot } from '../../ports/attempt-store.js';
import { computePlanningCodeBaselineDigest } from '../../ports/planning-input-prepare.js';

export interface ApprovedPlanningBaseline {
  /** 规划批准时冻结的代码快照 HEAD（编码基线；不随源仓库 HEAD 移动）。 */
  readonly headCommit: string;
  /** 快照来源仓库绑定身份（历史快照可能缺失；缺失时为 null）。 */
  readonly repositoryBindingId: string | null;
  readonly repositoryBindingRevision: number | null;
  readonly runId: string;
  readonly candidateId: string;
  readonly planDigest: string;
}

const OPERATION = 'PlanningBaseline.readApproved';

function fail(reason: string, details: Record<string, unknown>): never {
  throw new StorageError('conflict', OPERATION, `已批准规划基线不可核验（${reason}）`, { details: { reason, ...details } });
}

/**
 * 读取 Feature 当前获准计划对应的已批准规划代码基线。
 * 返回 null 表示当前计划不是规划批准应用的（如导入计划/无规划历史），
 * 调用方按既有语义处理；存在但不可核验时抛 StorageError(conflict)。
 */
export function readApprovedPlanningCodeBaseline(
  session: SqliteStorageSession,
  projectId: string,
  featureId: string,
): ApprovedPlanningBaseline | null {
  const db = session.database;
  const feature = db.prepare<[string, string], { plan_digest: string | null }>(
    'SELECT plan_digest FROM features WHERE project_id = ? AND id = ?',
  ).get(projectId, featureId);
  if (feature === undefined || feature.plan_digest === null) return null;

  const context = db.prepare<[string, string], { run_id: string; candidate_id: string; decided_at: number }>(
    "SELECT run_id, candidate_id, decided_at FROM planning_contexts WHERE project_id = ? AND feature_id = ? " +
      "AND decision = 'approved' AND applied_revision IS NOT NULL ORDER BY decided_at DESC, applied_at DESC, id DESC LIMIT 1",
  ).get(projectId, featureId);
  if (context === undefined) return null;

  /* 当前计划必须正是该次规划批准所应用的计划（同一提交事务的时间戳关联；
   * 计划被导入/修订取代后不回溯绑定旧规划快照）。 */
  const approval = db.prepare<[string, string, string, number], { id: string }>(
    "SELECT id FROM approvals WHERE project_id = ? AND subject_type = 'feature_plan' AND subject_id = ? " +
      'AND subject_digest = ? AND status = \'approved\' AND decided_at = ?',
  ).get(projectId, featureId, feature.plan_digest, context.decided_at);
  if (approval === undefined) return null;

  /* 规划 Run 的 Attempt 输入快照是冻结代码快照的权威持久位置（单候选单
   * Attempt 语义；缺失/漂移按 FR-01 明确阻塞，不回退当前 HEAD）。 */
  const attempt = db.prepare<[string, string], { input_snapshot: string }>(
    'SELECT input_snapshot FROM attempts WHERE project_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
  ).get(projectId, context.run_id);
  if (attempt === undefined) {
    fail('planning_attempt_missing', { runId: context.run_id, candidateId: context.candidate_id });
  }
  const parsed = JSON.parse(attempt.input_snapshot) as unknown;
  const snapshot = isPlanningAttemptSnapshot(parsed as AttemptInputSnapshot)
    ? (parsed as import('../../ports/planning-claim.js').PlanningAttemptInputSnapshot) : null;
  if (snapshot === null) fail('planning_snapshot_invalid', { runId: context.run_id });
  const baseline = snapshot.codeBaseline;
  if (baseline === undefined) fail('planning_code_baseline_missing', { runId: context.run_id });
  if (computePlanningCodeBaselineDigest(baseline) !== snapshot.digests.codeBaselineDigest) {
    fail('planning_code_baseline_digest_mismatch', { runId: context.run_id });
  }
  return {
    headCommit: baseline.headCommit,
    repositoryBindingId: baseline.repositoryBindingId ?? null,
    repositoryBindingRevision: baseline.repositoryBindingRevision ?? null,
    runId: context.run_id,
    candidateId: context.candidate_id,
    planDigest: feature.plan_digest,
  };
}
