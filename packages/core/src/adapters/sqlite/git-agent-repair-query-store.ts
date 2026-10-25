import { StorageError } from '../../ports/errors.js';
import { validateTaskClaimDispatch } from '../../ports/task-claim.js';
import { validateGitAgentRepairRequest, validateGitAgentRepairRuntimeOutput } from '../../ports/git-agent-repair.js';
import type { GitAgentRepairView } from '../../ports/git-agent-repair-store.js';
import type { GitAgentRepairQueryReadStore } from '../../ports/git-agent-repair-query.js';
import type { PlanListRequest } from '../../ports/queries.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

interface RepairRow {
  repair_id: string;
  project_id: string;
  request: string;
  receipt: string;
  authorization_version: number;
  run_id: string | null;
  blocked_reason: string | null;
}
interface AttemptRow {
  id: string;
  project_id: string;
  repair_id: string;
  run_id: string;
  owner_id: string;
  host_instance_id: string;
  authorization_version: number;
  dispatch: string;
  started_at: number;
  deadline_at: number;
  max_tokens: number;
  max_runtime_ms: number;
  output: string | null;
  stopped_at: number | null;
}

/** Read-only adapter for the public repair projection. It deliberately omits dispatch/owner facts. */
export function createSqliteGitAgentRepairQueryStore(session: SqliteStorageSession): GitAgentRepairQueryReadStore {
  const db = session.database;
  function read(projectId: unknown, repairId: unknown): GitAgentRepairView | undefined {
    const project = validateStableId(projectId, { operation: 'GitAgentRepairQuery' }, 'projectId');
    const id = validateStableId(repairId, { operation: 'GitAgentRepairQuery' }, 'repairId');
    const row = db.prepare('SELECT repair_id, project_id, request, receipt, authorization_version, run_id, blocked_reason FROM git_agent_repairs WHERE repair_id = ? AND project_id = ?')
      .get(id, project) as RepairRow | undefined;
    if (row === undefined) return undefined;
    try {
      const request = validateGitAgentRepairRequest(JSON.parse(row.request), { nowUtcMs: 0 });
      const receipt = JSON.parse(row.receipt);
      const attempts = (db.prepare('SELECT * FROM git_agent_repair_attempts WHERE project_id = ? AND repair_id = ? ORDER BY started_at, rowid')
        .all(project, id) as AttemptRow[]).map(attempt => ({
          id: attempt.id,
          projectId: attempt.project_id,
          repairId: attempt.repair_id,
          runId: attempt.run_id,
          ownerId: attempt.owner_id,
          hostInstanceId: attempt.host_instance_id,
          authorizationVersion: attempt.authorization_version,
          dispatch: validateTaskClaimDispatch(JSON.parse(attempt.dispatch)),
          startedAtUtcMs: attempt.started_at,
          deadlineUtcMs: attempt.deadline_at,
          maxTokens: attempt.max_tokens,
          maxRuntimeMs: attempt.max_runtime_ms,
          output: attempt.output === null ? null : validateGitAgentRepairRuntimeOutput(JSON.parse(attempt.output), request),
          stoppedAtUtcMs: attempt.stopped_at,
        }));
      if (request.projectId !== project || request.repairId !== id || receipt.repairId !== id || receipt.runId !== row.run_id) {
        throw new Error('repair_identity_corrupt');
      }
      return {
        receipt,
        request,
        authorizationVersion: attemptVersion(row.authorization_version),
        blockedReason: row.blocked_reason as GitAgentRepairView['blockedReason'],
        attempts,
      } as GitAgentRepairView;
    } catch (error) {
      throw new StorageError('corrupt', 'GitAgentRepairQuery', '修复公开查询事实损坏', { cause: error });
    }
  }
  function attemptVersion(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_authorization_version');
    return value;
  }
  return {
    readGitAgentRepair: read,
    listGitAgentRepairs(projectId: unknown, request: PlanListRequest) {
      const project = validateStableId(projectId, { operation: 'GitAgentRepairQuery' }, 'projectId');
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500 ||
          (request.afterId !== null && typeof request.afterId !== 'string')) {
        throw new StorageError('validation', 'GitAgentRepairQuery', '分页参数无效');
      }
      const rows = db.prepare(`SELECT repair_id FROM git_agent_repairs
        WHERE project_id = ? AND (? IS NULL OR repair_id > ?) ORDER BY repair_id LIMIT ?`)
        .all(project, request.afterId, request.afterId, request.limit + 1) as { repair_id: string }[];
      const hasMore = rows.length > request.limit;
      const pageRows = hasMore ? rows.slice(0, request.limit) : rows;
      return { records: pageRows.map(row => read(project, row.repair_id)!).filter(Boolean), nextCursor: hasMore ? pageRows.at(-1)!.repair_id : null };
    },
  };
}
