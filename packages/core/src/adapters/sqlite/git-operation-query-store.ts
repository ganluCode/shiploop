/**
 * P03-8 / F-009 Git 意图、实际提交与操作回执只读窄端口的 SQLite 装配
 *（adapters 层）。
 *
 * 不变量（与 ports/git-operation-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行；本模块无任何写原语——不注册
 *   意图、不收尾、不写事件、不触发 Git 或执行；
 * - detail 读取跨项目/不存在统一 undefined（存在性折叠由应用层完成，绝不
 *   区分「不存在」与「属于其他项目」）；持久行损坏 fail-closed（复用
 *   gitOperationRecordFromRow：损坏 JSON/不一致回执抛 corrupt，不把损坏
 *   内容泄漏进错误或折算成空结果）；
 * - 列表沿用计划分页纪律：可见范围谓词下推 SQL（visibility 非法形状为
 *   可信装配编程错误 TypeError）、稳定 id 升序、排他下界键集分页；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import type { GitOperationRecord } from '../../ports/git-operations.js';
import type { GitOperationQueryReadStore } from '../../ports/git-operation-query.js';
import type { PlanListRequest, PlanRecordPage } from '../../ports/queries.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import {
  GIT_OPERATION_COLUMNS,
  gitOperationRecordFromRow,
  type GitOperationRow,
} from './git-operations.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'GitOperationQueryStore';

function stableId(operation: string, value: unknown, field: string): string {
  const context: ValidationContext = { operation };
  return validateStableId(value, context, field);
}

/** 键集分页请求复核（应用层已校验；此处为防御纵深，非法即可信装配编程错误）。 */
function assertListRequest(operation: string, request: PlanListRequest): void {
  if (
    request === null ||
    typeof request !== 'object' ||
    (request.afterId !== null && typeof request.afterId !== 'string') ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1
  ) {
    throw new TypeError(`${operation}: 非法 PlanListRequest（可信装配编程错误）`);
  }
}

/** SQLite 装配：只读一致视图 + 稳定 id 键集分页；查询零写入、零事件、零执行触发。 */
export function createSqliteGitOperationQueryStore(
  session: SqliteStorageSession,
): GitOperationQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteGitOperationQueryStore: session 必须是 SqliteStorageSession');
  }

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', operation, 'Storage session is closed');
    }
  }

  function read<T>(operation: string, fn: () => T): T {
    assertOpen(operation);
    return session.database.inTransaction
      ? fn()
      : transactSqliteConsistentRead(session, operation, fn);
  }

  function listByParent(
    visibility: unknown,
    project: unknown,
    parentField: 'feature_id' | 'run_id',
    parent: unknown,
    parentIdField: string,
    request: PlanListRequest,
  ): PlanRecordPage<GitOperationRecord> {
    const operation = `${OPERATION}.list`;
    assertListRequest(operation, request);
    assertPrincipalVisibility(visibility);
    const projectId = stableId(operation, project, 'projectId');
    const parentId = stableId(operation, parent, parentIdField);
    return read(operation, () => {
      const conditions = ['project_id = ?', `${parentField} = ?`, 'id > ?'];
      const params: unknown[] = [projectId, parentId, request.afterId ?? ''];
      const visible = visibilityCondition(visibility, 'project_id');
      if (visible.condition !== undefined) {
        conditions.push(visible.condition);
        params.push(...visible.params);
      }
      params.push(request.limit + 1);
      const rows = session.database
        .prepare<unknown[], GitOperationRow>(
          `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations
           WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`,
        )
        .all(...params);
      const pageRows = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
      const records = pageRows.map(row => gitOperationRecordFromRow(row, operation));
      const last = records[records.length - 1];
      return {
        records,
        nextId:
          rows.length > request.limit && last !== undefined ? last.intent.operationId : null,
      };
    });
  }

  return {
    readGitOperationRecord(project: unknown, operation: unknown): GitOperationRecord | undefined {
      const op = `${OPERATION}.read`;
      const projectId = stableId(op, project, 'projectId');
      const operationId = stableId(op, operation, 'operationId');
      return read(op, () => {
        const row = session.database
          .prepare<[string], GitOperationRow>(
            `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations WHERE id = ?`,
          )
          .get(operationId);
        if (row === undefined || row.project_id !== projectId) {
          return undefined;
        }
        return gitOperationRecordFromRow(row, op);
      });
    },

    listGitOperationRecordsByFeature(
      visibility: unknown,
      projectId: unknown,
      featureId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<GitOperationRecord> {
      return listByParent(visibility, projectId, 'feature_id', featureId, 'featureId', request);
    },

    listGitOperationRecordsByRun(
      visibility: unknown,
      projectId: unknown,
      runId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<GitOperationRecord> {
      return listByParent(visibility, projectId, 'run_id', runId, 'runId', request);
    },
  };
}
