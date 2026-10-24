/**
 * P03-9 / F-008 显式工作流 resume 的只读现场读取（adapters/sqlite）。
 *
 * 单一 DEFERRED 读事务内取得目标 Run/Batch、所属 Batch 的 Run 集合、受管工作区、
 * 活动/仍持租约的 Attempt 与 lease；供 application/execution-resume 在写事务外
 * 核验计划/依赖/审批/worktree/占用/预算。这里只读，不创建 Attempt、不解除暂停、
 * 不启动 Runtime，也不读取供应商原生库。
 */
import type {
  ExecutionResumeFacts,
  ExecutionResumeFactsReader,
  ExecutionResumeFactsRequest,
  ExecutionResumeWorkspaceFacts,
} from '../../ports/execution-resume-facts.js';
import { StorageError } from '../../ports/errors.js';
import type { ExecutionBatchRecord, RunRecord } from '../../ports/execution-store.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteDispatchRecovery } from './dispatch-recovery.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteStateAccess } from './state-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'ExecutionResumeFacts.read';

export function createSqliteExecutionResumeFactsReader(
  session: SqliteStorageSession,
  options: {
    readonly nowUtcMs?: () => number;
  } = {},
): ExecutionResumeFactsReader {
  const now = options.nowUtcMs ?? Date.now;
  const attempts = createSqliteAttemptAccess(session);
  return {
    readFacts(request: ExecutionResumeFactsRequest): ExecutionResumeFacts {
      if (request === null || typeof request !== 'object') {
        throw new StorageError('validation', OPERATION, 'resume facts request must be an object');
      }
      return transactSqliteConsistentRead(session, OPERATION, () => {
        const execution = createSqliteExecutionAccess(session, { nowUtcMs: now });
        const state = createSqliteStateAccess(session);
        const project = state.getProject(request.projectId);
        let target: RunRecord | ExecutionBatchRecord;
        let batch: ExecutionBatchRecord;
        let runs: RunRecord[];
        if (request.targetKind === 'run') {
          const run = execution.getExecutionRunInTransaction(request.projectId, request.targetId);
          batch = execution.getExecutionBatchInTransaction(request.projectId, run.batchId);
          target = run;
          runs = [run];
        } else {
          batch = execution.getExecutionBatchInTransaction(request.projectId, request.targetId);
          target = batch;
          const ids = session.database.prepare<[string, string], { id: string }>(
            'SELECT id FROM runs WHERE project_id = ? AND batch_id = ? ORDER BY id',
          ).all(request.projectId, batch.id);
          runs = ids.map(row => execution.getExecutionRunInTransaction(request.projectId, row.id));
        }
        const featureId = batch.featureId;
        const managed = session.database.prepare<[string, string], {
          id: string; revision: number; status: string; repository_binding_id: string;
          repository_binding_revision: number; repo_identity: string; canonical_path: string;
          git_common_dir: string; branch: string; base_commit: string; head_commit: string | null;
          code_digest: string | null; run_id: string; attempt_id: string;
        }>(`SELECT id, revision, status, repository_binding_id, repository_binding_revision,
          repo_identity, canonical_path, git_common_dir, branch, base_commit, head_commit,
          code_digest, run_id, attempt_id
          FROM managed_workspaces WHERE project_id = ? AND feature_id = ?`)
          .get(request.projectId, featureId);
        const workspace: ExecutionResumeWorkspaceFacts | null = managed === undefined ? null : {
          workspaceId: managed.id,
          revision: managed.revision,
          status: managed.status,
          repositoryBindingId: managed.repository_binding_id,
          repositoryBindingRevision: managed.repository_binding_revision,
          repoIdentity: managed.repo_identity,
          canonicalPath: managed.canonical_path,
          gitCommonDir: managed.git_common_dir,
          branch: managed.branch,
          baseCommit: managed.base_commit,
          headCommit: managed.head_commit,
          codeDigest: managed.code_digest,
          runId: managed.run_id,
          attemptId: managed.attempt_id,
        };
        const activeAttempts = attempts.listActiveAttempts(request.projectId, request.targetKind, request.targetId);
        const attemptsWithLeases = attempts.listAttemptsWithLeases(request.projectId, request.targetKind, request.targetId);
        const attemptsWithLeasesIds = new Set(attemptsWithLeases.map(attempt => attempt.id));
        const leases = attempts.listWorkspaceLeases(request.projectId)
          .filter(lease => attemptsWithLeasesIds.has(lease.owner));
        /* P05-1 / F-010：planning Run 只读事实（同一次一致读；非 planning 目标为 null）。 */
        const planningRun = runs.find(run => run.purpose === 'plan');
        let planning: ExecutionResumeFacts['planning'] = null;
        if (planningRun !== undefined) {
          const context = session.database.prepare<[string, string], {
            status: string; candidate_id: string; input_digest: string; target_revision: number;
            plan_digest: string | null; planning_task_id: string;
          } | undefined>(`SELECT status, candidate_id, input_digest, target_revision, plan_digest, planning_task_id
            FROM planning_contexts WHERE project_id = ? AND run_id = ?`)
            .get(request.projectId, planningRun.id);
          if (context !== undefined) {
            const task = session.database.prepare<[string], {
              status: string; revision: number; execution_version: number; manual_block: number;
            } | undefined>('SELECT status, revision, execution_version, manual_block FROM tasks WHERE id = ?')
              .get(context.planning_task_id);
            const feature = session.database.prepare<[string], {
              status: string; plan_digest: string | null; revision: number;
            } | undefined>('SELECT status, plan_digest, revision FROM features WHERE id = ?')
              .get(planningRun.featureId);
            const attemptCount = session.database.prepare<[string, string], { n: number }>(
              'SELECT COUNT(*) AS n FROM attempts WHERE project_id = ? AND task_id = ?',
            ).get(request.projectId, context.planning_task_id)!.n;
            planning = {
              contextStatus: context.status,
              candidateId: context.candidate_id,
              inputDigest: context.input_digest,
              targetRevision: context.target_revision,
              planDigest: context.plan_digest,
              planningTaskId: context.planning_task_id,
              taskStatus: task?.status ?? 'missing',
              taskRevision: task?.revision ?? 0,
              taskExecutionVersion: task?.execution_version ?? 0,
              taskManualBlock: (task?.manual_block ?? 0) !== 0,
              featureStatus: feature?.status ?? 'missing',
              featurePlanDigest: feature?.plan_digest ?? null,
              featureRevision: feature?.revision ?? 0,
              attemptCount: Number(attemptCount),
            };
          }
        }
        return {
          projectId: request.projectId,
          projectStatus: project.status,
          targetKind: request.targetKind,
          target,
          batch,
          runs,
          workspace,
          activeAttempts,
          attemptsWithLeases,
          leases,
          dispatchOccupied: runs.some(run => createSqliteDispatchRecovery(session).resumeBlocked(run.id, now())),
          ...(planning === null ? {} : { planning }),
        };
      });
    },
  };
}
