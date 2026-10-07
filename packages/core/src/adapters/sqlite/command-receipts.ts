/**
 * F-006 SQLite CommandReceiptStore 适配器（adapters 层）：持久命令回执的
 * 写入与授权读取端口实现。
 *
 * 设计依据：docs/p02-2-commands-events-contract.md §5.3/§5.5/§5.6/§10 与
 * core-design/03 §1-3（端口先校验后持久化、短同步写事务）。
 *
 * 不变量：
 * - 输入一律为 unknown，先经 validatePersistableCommandReceipt 运行时校验再
 *   持久化：校验失败发生在任何 SQL 之前，真实库中没有半条回执行；
 * - 写入在 F-004 短同步写事务（BEGIN IMMEDIATE）内完成；(principal_id,
 *   command_id) 与 result_ref 的唯一约束冲突映射为 StorageError(kind=
 *   'conflict')——正常命令流由 F-007 在同一事务内先查后写，本映射是防御
 *   纵深，不充当幂等控制流；本版本不持久化 accepted（校验与 DDL 双重拒绝）；
 * - 读取到的持久行必经 ports 的 mapPersistedCommandReceipt 复核：结构损坏/
 *   未知操作/scope 不一致/JSON 列损坏一律显式失败（corrupt），不作为有效
 *   回执返回；缺失返回 undefined（幂等核对的正常结果），不抛 not_found；
 * - 跨身份隔离是结构性的：findReceiptByCommandId 按调用方 principalId 查询，
 *   端口不提供跨主体枚举；resultRef 是不透明随机引用，不接受任何路径/定位符；
 * - 会话已关闭时所有端口操作抛出明确“已关闭”错误，不使用失效连接；
 * - 行 id（UUID）由适配器生成，只作主键，不出现在任何公开返回面。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isValidResultRef, isUuidV4 } from '../../ports/commands.js';
import type { CommandReceipt } from '../../ports/commands.js';
import {
  mapPersistedCommandReceipt,
  validatePersistableCommandReceipt,
} from '../../ports/command-receipts.js';
import type {
  CommandReceiptStore,
  PersistedCommandReceiptRow,
} from '../../ports/command-receipts.js';
import { StorageError } from '../../ports/errors.js';
import { validationError } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

export interface SqliteCommandReceiptStoreOptions {
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
}

/** SELECT 读取的列形态（行 id/时间戳/revision 为内部记账列，不进入应用侧映射）。 */
interface CommandReceiptSqlRow {
  readonly principal_id: string;
  readonly command_id: string;
  readonly scope_kind: string;
  readonly project_id: string | null;
  readonly operation: string;
  readonly request_digest: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly result_ref: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly error_details: string | null;
  readonly issued_at: number;
  readonly completed_at: number;
}

const SELECT_COLUMNS =
  'principal_id, command_id, scope_kind, project_id, operation, request_digest, status, ' +
  'result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at';

/** better-sqlite3 约束冲突识别（SqliteError 带 code 字段）。 */
function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ((error as { code?: unknown }).code as string).startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 装配一个基于真实 SQLite 会话的 CommandReceiptStore 端口实现。
 *
 * - 调用方负责先完成迁移（migrateSqliteStorage 至 v3）再装配本适配器；
 * - import 本模块无副作用；本函数不打开/关闭会话，会话生命周期由调用方管理；
 * - 返回对象不泄漏驱动连接（database 句柄仅在本适配器内部使用）。
 */
export function createSqliteCommandReceiptStore(
  session: SqliteStorageSession,
  options: SqliteCommandReceiptStoreOptions = {},
): CommandReceiptStore {
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function parseJsonColumn(text: string, operation: string, reason: string): unknown {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new StorageError('corrupt', operation, `${operation}: 回执持久 JSON 列损坏`, {
        entity: { type: 'command_receipt' },
        details: { reason },
        cause,
      });
    }
  }

  function toPersistedRow(row: CommandReceiptSqlRow, operation: string): PersistedCommandReceiptRow {
    return {
      principalId: row.principal_id,
      commandId: row.command_id,
      scopeKind: row.scope_kind,
      projectId: row.project_id,
      operation: row.operation,
      requestDigest: row.request_digest,
      status: row.status,
      // undefined 表示列 NULL：JSON.parse 永不产生 undefined，两种情形可区分。
      result:
        row.result_json === null
          ? undefined
          : parseJsonColumn(row.result_json, operation, 'invalid_result_json'),
      resultRef: row.result_ref,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      errorDetails:
        row.error_details === null
          ? null
          : parseJsonColumn(row.error_details, operation, 'invalid_error_details_json'),
      issuedAtUtcMs: row.issued_at,
      completedAtUtcMs: row.completed_at,
    };
  }

  function mapRow(row: CommandReceiptSqlRow | undefined, operation: string): CommandReceipt | undefined {
    if (row === undefined) {
      return undefined;
    }
    return mapPersistedCommandReceipt(toPersistedRow(row, operation), operation);
  }

  return {
    async saveReceipt(receipt: unknown): Promise<void> {
      const operation = 'CommandReceiptStore.saveReceipt';
      assertOpen(operation);
      const valid = validatePersistableCommandReceipt(receipt, operation);
      const timestamp = nowUtcMs();
      try {
        session.transactWrite(operation, (db: Database.Database) => {
          db.prepare(
            'INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, ' +
              'scope_kind, project_id, operation, request_digest, status, result_json, result_ref, ' +
              'error_code, error_message, error_details, issued_at, completed_at) ' +
              'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            randomUUID(),
            timestamp,
            timestamp,
            valid.principalId,
            valid.commandId,
            valid.scope.kind,
            valid.scope.kind === 'project' ? valid.scope.projectId : null,
            valid.operation,
            valid.requestDigest,
            valid.status,
            valid.status === 'completed' ? JSON.stringify(valid.result) : null,
            valid.status === 'completed' ? valid.resultRef : null,
            valid.status === 'rejected' ? valid.error.code : null,
            valid.status === 'rejected' ? valid.error.message : null,
            valid.status === 'rejected' && valid.error.details !== undefined
              ? JSON.stringify(valid.error.details)
              : null,
            Date.parse(valid.issuedAt),
            Date.parse(valid.completedAt),
          );
        });
      } catch (error) {
        // 唯一约束防御纵深（正常流由 F-007 同事务先查后写）：(principal, command)
        // 或 result_ref 冲突映射为结构化 conflict；其余错误原样上抛。
        if (isSqliteConstraintError(error)) {
          if (
            error.message.includes('command_receipts.principal_id') ||
            error.message.includes('command_receipts_principal_command_unique')
          ) {
            throw new StorageError(
              'conflict',
              operation,
              '同一 principal 的 commandId 回执已存在（幂等键冲突），未重复写入',
              { entity: { type: 'command_receipt' }, details: { reason: 'duplicate_command_id' } },
            );
          }
          if (
            error.message.includes('command_receipts.result_ref') ||
            error.message.includes('command_receipts_result_ref_unique')
          ) {
            throw new StorageError(
              'conflict',
              operation,
              'resultRef 已被占用（唯一性冲突），未写入',
              { entity: { type: 'command_receipt' }, details: { reason: 'duplicate_result_ref' } },
            );
          }
        }
        throw error;
      }
    },

    async findReceiptByCommandId(
      principalId: unknown,
      commandId: unknown,
    ): Promise<CommandReceipt | undefined> {
      const operation = 'CommandReceiptStore.findReceiptByCommandId';
      assertOpen(operation);
      const context: ValidationContext = { operation, entity: { type: 'command_receipt' } };
      if (typeof principalId !== 'string' || principalId.length === 0) {
        throw validationError(context, 'principalId', '必须是非空字符串');
      }
      if (!isUuidV4(commandId)) {
        throw validationError(context, 'commandId', '必须是 RFC 4122 UUID v4（小写）');
      }
      const row = session.database
        .prepare<[string, string], CommandReceiptSqlRow>(
          `SELECT ${SELECT_COLUMNS} FROM command_receipts WHERE principal_id = ? AND command_id = ?`,
        )
        .get(principalId, commandId) as CommandReceiptSqlRow | undefined;
      return mapRow(row, operation);
    },

    async findReceiptByResultRef(resultRef: unknown): Promise<CommandReceipt | undefined> {
      const operation = 'CommandReceiptStore.findReceiptByResultRef';
      assertOpen(operation);
      const context: ValidationContext = { operation, entity: { type: 'command_receipt' } };
      if (!isValidResultRef(resultRef)) {
        throw validationError(context, 'resultRef', '必须是 v1. 形态的不透明结果引用');
      }
      const row = session.database
        .prepare<[string], CommandReceiptSqlRow>(
          `SELECT ${SELECT_COLUMNS} FROM command_receipts WHERE result_ref = ?`,
        )
        .get(resultRef) as CommandReceiptSqlRow | undefined;
      return mapRow(row, operation);
    },
  };
}
