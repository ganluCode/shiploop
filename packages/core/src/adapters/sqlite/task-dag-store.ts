import type { TaskDagStore, TaskDagView } from '../../ports/task-dag.js';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqlitePlanAccess } from './plan-store.js';
import { createSqliteStateAccess, transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

export function createSqliteTaskDagStore(session: SqliteStorageSession): TaskDagStore {
  const operation = 'TaskDagStore.read';
  const execution = createSqliteExecutionAccess(session);
  const plans = createSqlitePlanAccess(session);
  const state = createSqliteStateAccess(session);
  const attempts = createSqliteAttemptAccess(session);
  return {
    readTaskDagView(project: unknown, run: unknown): TaskDagView {
      const projectId = validateStableId(project, { operation }, 'projectId');
      const runId = validateStableId(run, { operation }, 'runId');
      const read = (): TaskDagView => {
        const db = session.database;
        const currentRun = execution.getExecutionRunInTransaction(projectId, runId);
        const batch = execution.getExecutionBatchInTransaction(projectId, currentRun.batchId);
        const plan = plans.getFeaturePlanInTransaction(projectId, currentRun.featureId);
        const global = state.getGlobalSettingsOrNull();
        const local = state.getProjectSettingsOrNull(projectId);
        const facts = plan.tasks.map(task => {
          const row = db.prepare<[string], { kind: string; manual_block: number; execution_version: number;
            attempt_counter: number; code_attempts_used: number }>(
            'SELECT kind, manual_block, execution_version, attempt_counter, code_attempts_used FROM tasks WHERE id = ?',
          ).get(task.id)!;
          if (!['coding', 'planning'].includes(row.kind) || ![0, 1].includes(row.manual_block)
            || ![row.execution_version, row.attempt_counter, row.code_attempts_used].every(n => Number.isSafeInteger(n) && n >= 0)) {
            throw new StorageError('corrupt', operation, 'Invalid stored Task scheduling facts');
          }
          // Missing or altered Artifact indices cannot make a historical Attempt valid.
          const history = attempts.listTaskAttempts(projectId, task.id).filter(attempt => {
            const refs = [...Object.values(attempt.inputSnapshot.group), ...attempt.inputSnapshot.requiredInputs];
            if (attempt.codeRef === null) return false;
            const code = db.prepare('SELECT id FROM artifacts WHERE id = ? AND project_id = ? AND status = ?')
              .get(attempt.codeRef, projectId, 'ready');
            return code !== undefined && refs.every(ref => db.prepare(
              'SELECT id FROM artifacts WHERE id = ? AND project_id = ? AND status = ? AND version = ? AND content_hash = ? AND size_bytes = ? AND storage_locator = ? AND media_type = ?',
            ).get(ref.artifactId, projectId, 'ready', ref.version, ref.contentHash, ref.sizeBytes, ref.locator, ref.mediaType) !== undefined);
          });
          return { taskId: task.id, kind: row.kind as 'coding' | 'planning', manualBlock: row.manual_block === 1,
            executionVersion: row.execution_version, attemptCounter: row.attempt_counter,
            codeAttemptsUsed: row.code_attempts_used, attempts: history };
        });
        const inputs: TaskDagView['inputs'][number][] = [];
        let inputsAvailable = true;
        const refs = new Map([...plan.feature.sourceRefs, ...plan.tasks.filter(t => facts.find(f => f.taskId === t.id)?.kind === 'coding')
          .flatMap(t => t.requirementsRefs)].map(ref => [`${ref.artifactId}\u0000${ref.contentHash ?? ''}`, ref]));
        for (const ref of refs.values()) {
          try {
            const resolved = plans.getArtifactInputRefInTransaction(projectId, ref.artifactId);
            if (ref.contentHash && resolved.contentHash !== ref.contentHash) inputsAvailable = false;
            if (!inputs.some(input => input.artifactId === resolved.artifactId)) {
              inputs.push({ artifactId: resolved.artifactId, version: resolved.version, contentHash: resolved.contentHash });
            }
          } catch (error) {
            if (!(error instanceof StorageError) || !['not_found', 'conflict', 'ownership'].includes(error.kind)) throw error;
            inputsAvailable = false;
          }
        }
        inputs.sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0);
        return {
          projectStatus: state.getProject(projectId).status,
          phase: plans.getPhaseInTransaction(projectId, plan.feature.phaseId), plan, run: currentRun, batch,
          approvals: plans.listPlanApprovalsInTransaction(projectId, plan.feature.id),
          settings: { global: global === null ? null : { scopeRevision: global.revision, payload: global.payload },
            project: local === null ? null : { scopeRevision: local.revision, payload: local.payload } },
          facts, inputs, inputsAvailable,
          // P05-4：工作资源的排他范围是当前 Feature；不同 Feature 的受管
          // worktree 可以并行。baseline 仍是项目级公共资源，保持全局阻塞。
          resourceBusy: db.prepare(`SELECT l.id FROM workspace_leases l
            JOIN attempts a ON a.project_id = l.project_id AND a.id = l.owner_id
            WHERE l.project_id = ? AND a.feature_id = ? LIMIT 1`).get(projectId, currentRun.featureId) !== undefined
            || db.prepare('SELECT id FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL LIMIT 1').get() !== undefined
            || db.prepare("SELECT id FROM attempts WHERE project_id = ? AND feature_id = ? AND status IN ('preparing', 'executing', 'verifying') LIMIT 1")
              .get(projectId, currentRun.featureId) !== undefined
            || db.prepare("SELECT id FROM tasks WHERE project_id = ? AND feature_id = ? AND status = 'running' LIMIT 1")
              .get(projectId, currentRun.featureId) !== undefined,
        };
      };
      if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
      const guardedRead = (): TaskDagView => {
        try { return read(); }
        catch (error) {
          if (error instanceof StorageError && error.kind === 'corrupt') {
            const identity = session.database.prepare<[string], { project_id: string; feature_id: string }>(
              'SELECT project_id, feature_id FROM runs WHERE id = ?',
            ).get(runId);
            if (identity?.project_id === projectId) throw new StorageError('corrupt', operation, 'Invalid persisted Task DAG view', {
              entity: { type: 'run', projectId, id: runId },
              details: { reason: 'invalid_graph', featureId: identity.feature_id }, cause: error,
            });
          }
          throw error;
        }
      };
      return session.database.inTransaction ? guardedRead() : transactSqliteConsistentRead(session, operation, guardedRead);
    },
  };
}
