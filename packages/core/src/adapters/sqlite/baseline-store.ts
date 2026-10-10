/**
 * F-007（P02-3）SQLite 基线窄存储适配器（adapters 层）：迁移 v4 四表的
 * 读取端口与原子命令事务原语实现。
 *
 * 契约依据：docs/p02-3-onboarding-contract.md §6.2/§8/§9.2/§10/§13；
 * 端口语义基线见 ports/baseline-store.ts（本模块实现同组行为断言的
 * 真实 SQLite 版本，测试见 test/sqlite-baseline-store.test.ts）。
 *
 * 不变量：
 * - 输入一律为 unknown，先经 ports 校验器再持久化：校验失败发生在任何 SQL
 *   之前，真实库中没有半条记录；读取到的持久行必经 ports 行列映射复核，
 *   非法状态/损坏 JSON 一律 corrupt，不作为有效记录返回；
 * - 全部写原语必须在 F-004 短同步写事务（BEGIN IMMEDIATE）内调用（与\n *   atomic-commands.ts 的唯一事务所有者约定一致）：授权/操作/检查/占用/\n *   事件/回执在同一事务内原子生效，任一失败整组回滚；Git/进程/文件输出/\n *   人审都在事务外（本模块不含任何相应 I/O）；
 * - 不可变授权：只有插入与读取 SQL，没有 UPDATE/DELETE 路径；检查行种子\n *   revision=1，一次性收尾（revision 1→2）后任何再收尾一律 conflict（迟到\n *   执行版本拒绝、终态证据不可覆盖）；操作终态不可覆盖；未产生的退出码\n *   为 NULL；
 * - 占用为固定单行（id='global'，DDL 单例 CHECK）：BEGIN IMMEDIATE 下\n *   读-判-写无竞争窗口；另一在途操作获取/非持有者心跳与释放均结构化拒绝；\n *   可恢复进程身份仅保存受控 JSON 对象；
 * - 跨项目引用在端口与 DDL 双重拒绝：绑定/授权/操作归属核对在事务内完成，\n *   直接 SQL 由同项目复合外键兜底；输出制品引用要求存在且属于同项目；
 * - 会话已关闭时所有端口操作抛出明确“已关闭”错误，不使用失效连接；
 * - 行 id（UUID）由适配器生成：操作 id 即公开 operationId；检查/事件行 id\n *   只作主键，不出现在公开返回面之外。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isUuidV4 } from '../../ports/commands.js';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import {
  validateBaselineCheckPlan,
  validateBaselineListQuery,
  type BaselineCheckPlan,
  type BaselineCheckStatus,
  type BaselineOperationStatus,
  type BaselineReasonCode,
  type ProjectHealthInput,
} from '../../ports/baseline.js';
import {
  BASELINE_OCCUPANCY_SINGLETON_ID,
  isTerminalBaselineOperation,
  mapBaselineAuthorizationRow,
  mapBaselineCheckResultRow,
  mapBaselineOccupancyRow,
  mapBaselineOperationRow,
  validateBaselineAuthorizationInsert,
  validateBaselineCheckFinalization,
  validateBaselineEventAppend,
  validateBaselineOperationInsert,
  validateBaselineOperationUpdate,
  validateBaselineOccupancyAcquire,
  validateBaselineProcessIdentity,
  type BaselineAuthorizationRecord,
  type BaselineCheckResultRecord,
  type BaselineOccupancySnapshot,
  type BaselineOperationPage,
  type BaselineOperationRecord,
  type BaselineStore,
} from '../../ports/baseline-store.js';
import { validationError } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

export interface SqliteBaselineStoreOptions {
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
}

interface AuthorizationSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly repository_binding_id: string;
  readonly head_commit: string | null;
  readonly working_tree_digest: string;
  readonly has_uncommitted_changes: number;
  readonly policy_revision: string;
  readonly plan_digest: string;
  readonly plan_json: string;
  readonly authorized_by: string;
  readonly authorized_at: number;
}

interface OperationSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly revision: number;
  readonly project_id: string;
  readonly kind: string;
  readonly authorization_id: string | null;
  readonly status: string;
  readonly reason_code: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

interface CheckResultSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly revision: number;
  readonly project_id: string;
  readonly operation_id: string;
  readonly check_key: string;
  readonly argv_json: string;
  readonly cwd_ref: string | null;
  readonly environment_ref: string | null;
  readonly timeout_ms: number;
  readonly required: number;
  readonly status: string;
  readonly reason_code: string | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: number;
  readonly output_artifact_id: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

interface OccupancySqlRow {
  readonly id: string;
  readonly holder_operation_id: string | null;
  readonly acquired_at: number | null;
  readonly heartbeat_at: number | null;
  readonly process_identity: string | null;
}

const SELECT_AUTHORIZATION =
  'SELECT id, created_at, project_id, repository_binding_id, head_commit, working_tree_digest, ' +
  'has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by, authorized_at ' +
  'FROM baseline_authorizations';
const SELECT_OPERATION =
  'SELECT id, created_at, updated_at, revision, project_id, kind, authorization_id, status, ' +
  'reason_code, started_at, ended_at FROM baseline_operations';
const SELECT_CHECK =
  'SELECT id, created_at, updated_at, revision, project_id, operation_id, check_key, argv_json, ' +
  'cwd_ref, environment_ref, timeout_ms, required, status, reason_code, exit_code, signal, ' +
  'timed_out, output_artifact_id, started_at, ended_at FROM baseline_check_results';
const SELECT_OCCUPANCY =
  "SELECT id, holder_operation_id, acquired_at, heartbeat_at, process_identity FROM baseline_occupancy WHERE id = 'global'";

function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ((error as { code?: unknown }).code as string).startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 装配基于真实 SQLite 会话的基线窄端口。调用方负责先完成迁移（至 v4）；
 * import 本模块无副作用；返回对象不泄漏驱动连接。
 */
export function createSqliteBaselineStore(
  session: SqliteStorageSession,
  options: SqliteBaselineStoreOptions = {},
): BaselineStore {
  return createSqliteBaselineAccess(session, options).store;
}

/** 同会话同步原语集合：供原子命令事务复用，绝不嵌套 Promise/事务。 */
export interface SqliteBaselineAccess {
  readonly store: BaselineStore;
  insertBaselineAuthorizationInTransaction(input: unknown): BaselineAuthorizationRecord;
  insertBaselineOperationInTransaction(input: unknown): BaselineOperationRecord;
  insertBaselineCheckResultsInTransaction(
    operationId: string,
    plan: unknown,
  ): readonly BaselineCheckResultRecord[];
  finalizeBaselineCheckResultInTransaction(
    operationId: string,
    checkKey: string,
    input: unknown,
  ): BaselineCheckResultRecord;
  updateBaselineOperationInTransaction(
    operationId: string,
    input: unknown,
  ): BaselineOperationRecord;
  acquireBaselineOccupancyInTransaction(input: unknown): BaselineOccupancySnapshot;
  heartbeatBaselineOccupancyInTransaction(
    operationId: string,
    processIdentity?: unknown,
  ): BaselineOccupancySnapshot;
  releaseBaselineOccupancyInTransaction(operationId: string): BaselineOccupancySnapshot;
  appendBaselineEventInTransaction(input: unknown): void;
}

export function createSqliteBaselineAccess(
  session: SqliteStorageSession,
  options: SqliteBaselineStoreOptions = {},
): SqliteBaselineAccess {
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function assertInTransaction(operation: string): void {
    if (!session.database.inTransaction) {
      throw new TypeError(`${operation}: 基线写原语必须位于写事务内（原子命令事务拥有唯一事务）`);
    }
  }

  function context(
    operation: string,
    entity: StorageEntityRef,
  ): ValidationContext {
    return { operation, entity };
  }

  function notFound(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('not_found', operation, `${operation}: ${message}`, { entity });
  }

  function ownership(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('ownership', operation, `${operation}: ${message}`, { entity });
  }

  function conflict(
    operation: string,
    message: string,
    entity: StorageEntityRef,
    details: Record<string, unknown>,
  ): StorageError {
    return new StorageError('conflict', operation, `${operation}: ${message}`, { entity, details });
  }

  function parseJsonColumn(text: string, operation: string, reason: string): unknown {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new StorageError('corrupt', operation, `${operation}: 基线持久 JSON 列损坏`, {
        details: { reason },
        cause,
      });
    }
  }

  function authorizationFromRow(row: AuthorizationSqlRow): BaselineAuthorizationRecord {
    const operation = 'BaselineStore.getBaselineAuthorization';
    return mapBaselineAuthorizationRow({
      id: row.id,
      projectId: row.project_id,
      repositoryBindingId: row.repository_binding_id,
      headCommit: row.head_commit,
      workingTreeDigest: row.working_tree_digest,
      hasUncommittedChanges: row.has_uncommitted_changes,
      policyRevision: row.policy_revision,
      planDigest: row.plan_digest,
      plan: parseJsonColumn(row.plan_json, operation, 'invalid_plan_json'),
      authorizedBy: row.authorized_by,
      authorizedAtUtcMs: row.authorized_at,
      createdAtUtcMs: row.created_at,
    });
  }

  function operationFromRow(row: OperationSqlRow): BaselineOperationRecord {
    return mapBaselineOperationRow({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      authorizationId: row.authorization_id,
      status: row.status,
      reasonCode: row.reason_code,
      startedAtUtcMs: row.started_at,
      endedAtUtcMs: row.ended_at,
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    });
  }

  function checkFromRow(row: CheckResultSqlRow): BaselineCheckResultRecord {
    const operation = 'BaselineStore.listBaselineCheckResults';
    return mapBaselineCheckResultRow({
      id: row.id,
      projectId: row.project_id,
      operationId: row.operation_id,
      checkKey: row.check_key,
      argv: parseJsonColumn(row.argv_json, operation, 'invalid_argv_json'),
      cwdRef: row.cwd_ref,
      environmentRef: row.environment_ref,
      timeoutMs: row.timeout_ms,
      required: row.required,
      status: row.status,
      reasonCode: row.reason_code,
      exitCode: row.exit_code,
      signal: row.signal,
      timedOut: row.timed_out,
      outputArtifactId: row.output_artifact_id,
      startedAtUtcMs: row.started_at,
      endedAtUtcMs: row.ended_at,
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    });
  }

  function occupancyFromRow(row: OccupancySqlRow): BaselineOccupancySnapshot {
    return mapBaselineOccupancyRow({
      holderOperationId: row.holder_operation_id,
      acquiredAtUtcMs: row.acquired_at,
      heartbeatAtUtcMs: row.heartbeat_at,
      processIdentity:
        row.process_identity === null
          ? null
          : parseJsonColumn(row.process_identity, 'BaselineStore.readBaselineOccupancy', 'invalid_process_identity_json'),
    });
  }

  function readOperationRow(db: Database.Database, operationId: string): OperationSqlRow | undefined {
    return db
      .prepare<[string], OperationSqlRow>(`${SELECT_OPERATION} WHERE id = ?`)
      .get(operationId) as OperationSqlRow | undefined;
  }

  function readOccupancyRow(db: Database.Database): OccupancySqlRow | undefined {
    return db.prepare<[], OccupancySqlRow>(SELECT_OCCUPANCY).get() as OccupancySqlRow | undefined;
  }

  /** 事务内核对：绑定必须存在且属于授权声明的项目（跨项目/缺失均拒绝）。 */
  function assertBindingOwnership(db: Database.Database, operation: string, projectId: string, bindingId: string): void {
    const entity: StorageEntityRef = { type: 'baseline_authorization', projectId };
    const row = db
      .prepare<[string], { project_id: string }>('SELECT project_id FROM repository_bindings WHERE id = ?')
      .get(bindingId) as { project_id: string } | undefined;
    if (row === undefined) {
      throw notFound(operation, entity, '仓库绑定不存在');
    }
    if (row.project_id !== projectId) {
      throw ownership(operation, entity, '仓库绑定不属于授权声明的项目（跨项目引用被拒绝）');
    }
  }

  function assertProjectExists(db: Database.Database, operation: string, projectId: string, entity: StorageEntityRef): void {
    const row = db.prepare<[string], { id: string }>('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (row === undefined) {
      throw notFound(operation, entity, '项目不存在');
    }
  }

  /* ---------------------------------------------------------------- *
   * 写原语（仅限原子命令事务内）
   * ---------------------------------------------------------------- */

  function insertBaselineAuthorizationInTransaction(input: unknown): BaselineAuthorizationRecord {
    const operation = 'BaselineStore.insertBaselineAuthorization';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateBaselineAuthorizationInsert(input, operation);
    const entity: StorageEntityRef = { type: 'baseline_authorization', projectId: valid.projectId };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    assertBindingOwnership(db, operation, valid.projectId, valid.repositoryBindingId);
    const timestamp = nowUtcMs();
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO baseline_authorizations (id, created_at, project_id, repository_binding_id, head_commit, ' +
          'working_tree_digest, has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by, authorized_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        timestamp,
        valid.projectId,
        valid.repositoryBindingId,
        valid.headCommit,
        valid.workingTreeDigest,
        valid.hasUncommittedChanges ? 1 : 0,
        valid.policyRevision,
        valid.planDigest,
        JSON.stringify(valid.plan),
        valid.authorizedBy,
        valid.authorizedAtUtcMs,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        // 防御纵深：端口核对未命中时由 DDL（FK/复合外键/CHECK）兜底拒写。
        throw new StorageError('validation', operation, `${operation}: 授权输入违反存储约束`, {
          entity,
          details: { reason: 'authorization_constraint_rejected' },
          cause: error,
        });
      }
      throw error;
    }
    const row = db
      .prepare<[string], AuthorizationSqlRow>(`${SELECT_AUTHORIZATION} WHERE id = ?`)
      .get(id) as AuthorizationSqlRow;
    return authorizationFromRow(row);
  }

  function insertBaselineOperationInTransaction(input: unknown): BaselineOperationRecord {
    const operation = 'BaselineStore.insertBaselineOperation';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateBaselineOperationInsert(input, operation);
    const entity: StorageEntityRef = { type: 'baseline_operation', projectId: valid.projectId };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    if (valid.authorizationId !== null) {
      const authorization = db
        .prepare<[string], { project_id: string }>('SELECT project_id FROM baseline_authorizations WHERE id = ?')
        .get(valid.authorizationId) as { project_id: string } | undefined;
      if (authorization === undefined) {
        throw notFound(operation, entity, '引用的授权不存在');
      }
      if (authorization.project_id !== valid.projectId) {
        throw ownership(operation, entity, '引用的授权不属于操作声明的项目（跨项目引用被拒绝）');
      }
    }
    const timestamp = nowUtcMs();
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO baseline_operations (id, created_at, updated_at, revision, project_id, kind, ' +
          'authorization_id, status, reason_code, started_at, ended_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        timestamp,
        timestamp,
        valid.projectId,
        valid.kind,
        valid.authorizationId,
        valid.status,
        valid.reasonCode,
        valid.startedAtUtcMs,
        valid.endedAtUtcMs,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError('validation', operation, `${operation}: 操作输入违反存储约束`, {
          entity,
          details: { reason: 'operation_constraint_rejected' },
          cause: error,
        });
      }
      throw error;
    }
    return operationFromRow(readOperationRow(db, id)!);
  }

  function insertBaselineCheckResultsInTransaction(
    operationId: string,
    plan: unknown,
  ): readonly BaselineCheckResultRecord[] {
    const operation = 'BaselineStore.insertBaselineCheckResults';
    assertOpen(operation);
    assertInTransaction(operation);
    const contextEntity: StorageEntityRef = { type: 'baseline_check_result' };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, contextEntity), 'operationId', '必须是 UUID v4', operationId);
    }
    const validatedPlan = validateBaselineCheckPlanOf(plan, operation);
    const db = session.database;
    const operationRow = readOperationRow(db, operationId);
    if (operationRow === undefined) {
      throw notFound(operation, contextEntity, '目标基线操作不存在');
    }
    if (isTerminalBaselineOperation(operationRow.status as BaselineOperationStatus)) {
      throw conflict(operation, '操作已终态，检查种子窗口关闭（迟到写入拒绝）', contextEntity, {
        reason: 'operation_terminal',
        operationId,
      });
    }
    const timestamp = nowUtcMs();
    try {
      for (const check of validatedPlan.checks) {
        db.prepare(
          'INSERT INTO baseline_check_results (id, created_at, updated_at, revision, project_id, operation_id, ' +
            'check_key, argv_json, cwd_ref, environment_ref, timeout_ms, required, status, reason_code, ' +
            'exit_code, signal, timed_out, output_artifact_id, started_at, ended_at) ' +
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'not_run', NULL, NULL, NULL, 0, NULL, NULL, NULL)",
        ).run(
          randomUUID(),
          timestamp,
          timestamp,
          operationRow.project_id,
          operationId,
          check.checkKey,
          JSON.stringify(check.argv),
          check.cwdRef ?? null,
          check.environmentRef ?? null,
          check.timeoutMs,
          check.required ? 1 : 0,
        );
      }
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw conflict(operation, '同一操作的 checkKey 已存在（检查种子唯一冲突）', contextEntity, {
          reason: 'duplicate_check_key',
          operationId,
        });
      }
      throw error;
    }
    return listCheckRows(db, operationId);
  }

  function validateBaselineCheckPlanOf(plan: unknown, operation: string): BaselineCheckPlan {
    return validateBaselineCheckPlan(plan, operation);
  }

  function listCheckRows(db: Database.Database, operationId: string): BaselineCheckResultRecord[] {
    const rows = db
      .prepare<[string], CheckResultSqlRow>(`${SELECT_CHECK} WHERE operation_id = ? ORDER BY check_key`)
      .all(operationId);
    return rows.map((row) => checkFromRow(row));
  }

  function finalizeBaselineCheckResultInTransaction(
    operationId: string,
    checkKey: string,
    input: unknown,
  ): BaselineCheckResultRecord {
    const operation = 'BaselineStore.finalizeBaselineCheckResult';
    assertOpen(operation);
    assertInTransaction(operation);
    const entity: StorageEntityRef = { type: 'baseline_check_result', id: checkKey };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, entity), 'operationId', '必须是 UUID v4', operationId);
    }
    if (typeof checkKey !== 'string' || checkKey.length === 0) {
      throw validationError(context(operation, entity), 'checkKey', '必须是非空字符串', checkKey);
    }
    const valid = validateBaselineCheckFinalization(input, operation);
    const db = session.database;
    const row = db
      .prepare<[string, string], CheckResultSqlRow>(
        `${SELECT_CHECK} WHERE operation_id = ? AND check_key = ?`,
      )
      .get(operationId, checkKey) as CheckResultSqlRow | undefined;
    if (row === undefined) {
      throw notFound(operation, entity, '目标检查记录不存在');
    }
    if (row.revision !== 1) {
      throw conflict(operation, '检查证据已收尾，不可被后续更新覆盖', entity, {
        reason: 'check_result_finalized',
        operationId,
        checkKey,
      });
    }
    if (valid.expectedRevision !== row.revision) {
      throw conflict(operation, 'expectedRevision 与当前 revision 不匹配（迟到执行版本拒绝）', entity, {
        reason: 'stale_revision',
        expectedRevision: valid.expectedRevision,
        actualRevision: row.revision,
      });
    }
    const operationRow = readOperationRow(db, operationId);
    if (operationRow === undefined) {
      throw notFound(operation, entity, '目标基线操作不存在');
    }
    if (isTerminalBaselineOperation(operationRow.status as BaselineOperationStatus)) {
      throw conflict(operation, '操作已终态，检查证据窗口关闭（迟到写入拒绝）', entity, {
        reason: 'operation_terminal',
        operationId,
      });
    }
    if (valid.outputArtifactId !== null) {
      const artifact = db
        .prepare<[string], { project_id: string }>('SELECT project_id FROM artifacts WHERE id = ?')
        .get(valid.outputArtifactId) as { project_id: string } | undefined;
      if (artifact === undefined) {
        throw notFound(operation, entity, '输出制品不存在');
      }
      if (artifact.project_id !== row.project_id) {
        throw ownership(operation, entity, '输出制品不属于检查所属项目（跨项目引用被拒绝）');
      }
    }
    const timestamp = nowUtcMs();
    db.prepare(
      'UPDATE baseline_check_results SET updated_at = ?, revision = 2, status = ?, reason_code = ?, ' +
        'exit_code = ?, signal = ?, timed_out = ?, output_artifact_id = ?, started_at = ?, ended_at = ? ' +
        'WHERE operation_id = ? AND check_key = ? AND revision = 1',
    ).run(
      timestamp,
      valid.status,
      valid.reasonCode,
      valid.exitCode,
      valid.signal,
      valid.timedOut ? 1 : 0,
      valid.outputArtifactId,
      valid.startedAtUtcMs,
      valid.endedAtUtcMs,
      operationId,
      checkKey,
    );
    const updated = db
      .prepare<[string, string], CheckResultSqlRow>(
        `${SELECT_CHECK} WHERE operation_id = ? AND check_key = ?`,
      )
      .get(operationId, checkKey) as CheckResultSqlRow;
    return checkFromRow(updated);
  }

  function updateBaselineOperationInTransaction(
    operationId: string,
    input: unknown,
  ): BaselineOperationRecord {
    const operation = 'BaselineStore.updateBaselineOperation';
    assertOpen(operation);
    assertInTransaction(operation);
    const entity: StorageEntityRef = { type: 'baseline_operation', id: operationId };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, entity), 'operationId', '必须是 UUID v4', operationId);
    }
    const valid = validateBaselineOperationUpdate(input, operation);
    const db = session.database;
    const row = readOperationRow(db, operationId);
    if (row === undefined) {
      throw notFound(operation, entity, '目标基线操作不存在');
    }
    if (isTerminalBaselineOperation(row.status as BaselineOperationStatus)) {
      throw conflict(operation, '操作已终态，不可被后续更新覆盖', entity, {
        reason: 'operation_terminal',
        expectedRevision: valid.expectedRevision,
        actualRevision: row.revision,
      });
    }
    const timestamp = nowUtcMs();
    const result = db
      .prepare(
        'UPDATE baseline_operations SET updated_at = ?, revision = revision + 1, status = ?, ' +
          'reason_code = CASE WHEN ? THEN ? ELSE reason_code END, ' +
          'started_at = CASE WHEN ? THEN ? ELSE started_at END, ' +
          'ended_at = CASE WHEN ? THEN ? ELSE ended_at END ' +
          'WHERE id = ? AND revision = ?',
      ).run(
        timestamp,
        valid.status,
        valid.reasonCode !== undefined ? 1 : 0,
        valid.reasonCode ?? null,
        valid.startedAtUtcMs !== undefined ? 1 : 0,
        valid.startedAtUtcMs ?? null,
        valid.endedAtUtcMs !== undefined ? 1 : 0,
        valid.endedAtUtcMs ?? null,
        operationId,
        valid.expectedRevision,
      );
    if (result.changes === 0) {
      throw conflict(operation, 'expectedRevision 与当前 revision 不匹配（迟到执行版本拒绝）', entity, {
        reason: 'stale_revision',
        expectedRevision: valid.expectedRevision,
        actualRevision: row.revision,
      });
    }
    return operationFromRow(readOperationRow(db, operationId)!);
  }

  function acquireBaselineOccupancyInTransaction(input: unknown): BaselineOccupancySnapshot {
    const operation = 'BaselineStore.acquireBaselineOccupancy';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateBaselineOccupancyAcquire(input, operation);
    const entity: StorageEntityRef = { type: 'baseline_occupancy', id: valid.operationId };
    const db = session.database;
    const operationRow = readOperationRow(db, valid.operationId);
    if (operationRow === undefined) {
      throw notFound(operation, entity, '占用持有者操作不存在');
    }
    const timestamp = nowUtcMs();
    const identityJson =
      valid.processIdentity === null ? null : JSON.stringify(valid.processIdentity);
    const existing = readOccupancyRow(db);
    if (existing === undefined) {
      try {
        db.prepare(
          "INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at, heartbeat_at, process_identity) " +
            "VALUES ('global', ?, ?, ?, ?)",
        ).run(valid.operationId, timestamp, timestamp, identityJson);
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw conflict(operation, '另一基线操作在途（全局单并发占用）', entity, {
            reason: 'baseline_in_progress',
            holderOperationId: valid.operationId,
          });
        }
        throw error;
      }
      return occupancyFromRow(readOccupancyRow(db)!);
    }
    if (existing.holder_operation_id !== null && existing.holder_operation_id !== valid.operationId) {
      throw conflict(operation, '另一基线操作在途（全局单并发占用）', entity, {
        reason: 'baseline_in_progress',
        holderOperationId: existing.holder_operation_id,
      });
    }
    if (existing.holder_operation_id === null) {
      // 空闲：获取占用并记录获取时刻与进程身份。
      db.prepare(
        'UPDATE baseline_occupancy SET holder_operation_id = ?, acquired_at = ?, heartbeat_at = ?, process_identity = ? WHERE id = ?',
      ).run(valid.operationId, timestamp, timestamp, identityJson, BASELINE_OCCUPANCY_SINGLETON_ID);
      return occupancyFromRow(readOccupancyRow(db)!);
    }
    // 同持有者重复获取幂等：保留原获取时刻，刷新心跳与进程身份。
    db.prepare(
      'UPDATE baseline_occupancy SET heartbeat_at = ?, process_identity = ? WHERE id = ? AND holder_operation_id = ?',
    ).run(timestamp, identityJson, BASELINE_OCCUPANCY_SINGLETON_ID, valid.operationId);
    return occupancyFromRow(readOccupancyRow(db)!);
  }

  function heartbeatBaselineOccupancyInTransaction(
    operationId: string,
    processIdentity?: unknown,
  ): BaselineOccupancySnapshot {
    const operation = 'BaselineStore.heartbeatBaselineOccupancy';
    assertOpen(operation);
    assertInTransaction(operation);
    const entity: StorageEntityRef = { type: 'baseline_occupancy', id: operationId };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, entity), 'operationId', '必须是 UUID v4', operationId);
    }
    const identity =
      processIdentity === undefined ? undefined : validateBaselineProcessIdentity(processIdentity, operation);
    const db = session.database;
    const existing = readOccupancyRow(db);
    if (existing === undefined || existing.holder_operation_id === null) {
      throw ownership(operation, entity, '占用空闲，无持有者可心跳');
    }
    if (existing.holder_operation_id !== operationId) {
      throw ownership(operation, entity, '只有占用持有者可以心跳（非持有者被拒绝）');
    }
    const timestamp = nowUtcMs();
    if (identity === undefined) {
      db.prepare('UPDATE baseline_occupancy SET heartbeat_at = ? WHERE id = ? AND holder_operation_id = ?').run(
        timestamp,
        BASELINE_OCCUPANCY_SINGLETON_ID,
        operationId,
      );
    } else {
      db.prepare(
        'UPDATE baseline_occupancy SET heartbeat_at = ?, process_identity = ? WHERE id = ? AND holder_operation_id = ?',
      ).run(timestamp, identity === null ? null : JSON.stringify(identity), BASELINE_OCCUPANCY_SINGLETON_ID, operationId);
    }
    return occupancyFromRow(readOccupancyRow(db)!);
  }

  function releaseBaselineOccupancyInTransaction(operationId: string): BaselineOccupancySnapshot {
    const operation = 'BaselineStore.releaseBaselineOccupancy';
    assertOpen(operation);
    assertInTransaction(operation);
    const entity: StorageEntityRef = { type: 'baseline_occupancy', id: operationId };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, entity), 'operationId', '必须是 UUID v4', operationId);
    }
    const db = session.database;
    const existing = readOccupancyRow(db);
    if (existing === undefined || existing.holder_operation_id === null) {
      // 已空闲：释放幂等（无持有者可清）。
      return occupancyFromRow(existing ?? { id: BASELINE_OCCUPANCY_SINGLETON_ID, holder_operation_id: null, acquired_at: null, heartbeat_at: null, process_identity: null });
    }
    if (existing.holder_operation_id !== operationId) {
      throw ownership(operation, entity, '只有占用持有者可以释放（非持有者被拒绝）');
    }
    db.prepare(
      "UPDATE baseline_occupancy SET holder_operation_id = NULL, acquired_at = NULL, heartbeat_at = NULL, process_identity = NULL WHERE id = ? AND holder_operation_id = ?",
    ).run(BASELINE_OCCUPANCY_SINGLETON_ID, operationId);
    return occupancyFromRow(readOccupancyRow(db)!);
  }

  function appendBaselineEventInTransaction(input: unknown): void {
    const operation = 'BaselineStore.appendBaselineEvent';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateBaselineEventAppend(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    const nextSequence = db
      .prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events')
      .get();
    db.prepare(
      'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      timestamp,
      timestamp,
      valid.projectId,
      nextSequence?.next ?? 1,
      valid.eventType,
      'project',
      valid.projectId,
      valid.aggregateRevision,
      JSON.stringify(valid.payload),
      timestamp,
    );
  }

  /* ---------------------------------------------------------------- *
   * 读取端口
   * ---------------------------------------------------------------- */

  function getBaselineOperation(operationId: unknown): BaselineOperationRecord | undefined {
    const operation = 'BaselineStore.getBaselineOperation';
    assertOpen(operation);
    const entity: StorageEntityRef = { type: 'baseline_operation' };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, entity), 'operationId', '必须是 UUID v4', operationId);
    }
    const row = readOperationRow(session.database, operationId);
    return row === undefined ? undefined : operationFromRow(row);
  }

  function listBaselineOperations(projectId: unknown, query: unknown): BaselineOperationPage {
    const operation = 'BaselineStore.listBaselineOperations';
    assertOpen(operation);
    const entity: StorageEntityRef = { type: 'baseline_operation' };
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128) {
      throw validationError(context(operation, entity), 'projectId', '必须是稳定项目 ID', projectId);
    }
    const valid = validateBaselineListQuery(query, operation);
    const rows = session.database
      .prepare<[string, string, number], OperationSqlRow>(
        `${SELECT_OPERATION} WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(projectId, valid.cursor ?? '', valid.limit + 1);
    const hasMore = rows.length > valid.limit;
    const records = rows.slice(0, valid.limit).map((row) => operationFromRow(row));
    const last = records[records.length - 1];
    return {
      records,
      nextCursor: hasMore && last !== undefined ? last.id : null,
    };
  }

  function listBaselineCheckResults(operationId: unknown): readonly BaselineCheckResultRecord[] {
    const operation = 'BaselineStore.listBaselineCheckResults';
    assertOpen(operation);
    const entity: StorageEntityRef = { type: 'baseline_check_result' };
    if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
      throw validationError(context(operation, entity), 'operationId', '必须是 UUID v4', operationId);
    }
    const exists = readOperationRow(session.database, operationId);
    if (exists === undefined) {
      throw notFound(operation, entity, '目标基线操作不存在');
    }
    return listCheckRows(session.database, operationId);
  }

  function getBaselineAuthorization(authorizationId: unknown): BaselineAuthorizationRecord | undefined {
    const operation = 'BaselineStore.getBaselineAuthorization';
    assertOpen(operation);
    const entity: StorageEntityRef = { type: 'baseline_authorization' };
    if (typeof authorizationId !== 'string' || !isUuidV4(authorizationId)) {
      throw validationError(context(operation, entity), 'authorizationId', '必须是 UUID v4', authorizationId);
    }
    const row = session.database
      .prepare<[string], AuthorizationSqlRow>(`${SELECT_AUTHORIZATION} WHERE id = ?`)
      .get(authorizationId) as AuthorizationSqlRow | undefined;
    return row === undefined ? undefined : authorizationFromRow(row);
  }

  function readBaselineOccupancy(): BaselineOccupancySnapshot {
    const operation = 'BaselineStore.readBaselineOccupancy';
    assertOpen(operation);
    const row = readOccupancyRow(session.database);
    return occupancyFromRow(
      row ?? {
        id: BASELINE_OCCUPANCY_SINGLETON_ID,
        holder_operation_id: null,
        acquired_at: null,
        heartbeat_at: null,
        process_identity: null,
      },
    );
  }

  /** §7.3 overview 健康派生输入：最近一次终态操作 + 其逐项检查（§8.2）。 */
  function readProjectHealthInput(projectId: unknown): ProjectHealthInput {
    const operation = 'BaselineStore.readProjectHealthInput';
    assertOpen(operation);
    const entity: StorageEntityRef = { type: 'baseline_operation' };
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128) {
      throw validationError(context(operation, entity), 'projectId', '必须是稳定项目 ID', projectId);
    }
    const row = session.database
      .prepare<[string], OperationSqlRow>(
        `${SELECT_OPERATION} WHERE project_id = ? AND status IN ('completed','cancelled','failed','interrupted','not_run') ` +
          'ORDER BY COALESCE(ended_at, created_at) DESC, id DESC LIMIT 1',
      )
      .get(projectId) as OperationSqlRow | undefined;
    if (row === undefined) {
      return { operation: null, checks: [] };
    }
    const record = operationFromRow(row);
    const checkRows = listCheckRows(session.database, record.id);
    return {
      operation: {
        operationId: record.id,
        kind: 'baseline',
        status: record.status,
        ...(record.reasonCode !== null ? { reasonCode: record.reasonCode } : {}),
        createdAt: new Date(record.createdAtUtcMs).toISOString(),
        startedAt: record.startedAtUtcMs === null ? null : new Date(record.startedAtUtcMs).toISOString(),
        endedAt: record.endedAtUtcMs === null ? null : new Date(record.endedAtUtcMs).toISOString(),
      },
      checks: checkRows.map((check) => ({
        status: check.status as BaselineCheckStatus,
        required: check.required,
        ...(check.reasonCode !== null ? { reasonCode: check.reasonCode as BaselineReasonCode } : {}),
      })),
    };
  }

  const store: BaselineStore = {
    getBaselineOperation,
    listBaselineOperations,
    listBaselineCheckResults,
    getBaselineAuthorization,
    readBaselineOccupancy,
    readProjectHealthInput,
    listRecoverableBaselineOperations() {
      assertOpen('BaselineStore.listRecoverableBaselineOperations');
      const rows = session.database.prepare("SELECT * FROM baseline_operations WHERE status IN ('accepted','running','cancelling') OR id IN (SELECT holder_operation_id FROM baseline_occupancy) ORDER BY id").all() as OperationSqlRow[];
      return rows.map(operationFromRow);
    },
  };

  return {
    store,
    insertBaselineAuthorizationInTransaction,
    insertBaselineOperationInTransaction,
    insertBaselineCheckResultsInTransaction,
    finalizeBaselineCheckResultInTransaction,
    updateBaselineOperationInTransaction,
    acquireBaselineOccupancyInTransaction,
    heartbeatBaselineOccupancyInTransaction,
    releaseBaselineOccupancyInTransaction,
    appendBaselineEventInTransaction,
  };
}
