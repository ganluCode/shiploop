/**
 * F-009 SQLite ArtifactStore 适配器（adapters 层）：制品索引的 pending 登记、
 * CAS 状态转换与有效输入引用查询。
 *
 * 设计依据：core-design/03 §4（pending 登记 → staging → 校验 → ready；SQLite 只
 * 保存索引，大正文永不进库）与 core-design/11 §8（artifacts 字段字典）；端口契约
 * 见 ports/artifact-store.ts，语义基线为 test/storage-contracts.test.ts 的制品组
 * 断言与 test/helpers/in-memory-store.ts——本适配器实现同组行为断言的真实 SQLite 版本。
 *
 * 不变量：
 * - SQLite 只保存索引（预期摘要、实测 hash/size、受控逻辑 locator、状态与失败
 *   原因）；物理文件由 F-010/F-011 的制品文件适配器与 PathService 承担，不属于
 *   本端口；locator 只做契约校验，本模块不做任何文件系统操作；
 * - 输入一律 unknown，先经 F-002 运行时校验器再持久化：校验失败发生在任何 SQL
 *   之前，真实库中没有半条记录；稳定 ID（UUID）与应用侧 UTC 毫秒时间由注入时钟
 *   提供，kind/mediaType/locator 不参与 ID 推导；
 * - 状态机 pending→ready / pending→failed，ready/failed 为索引级终态：
 *   transitionArtifact 在 F-004 短同步写事务（BEGIN IMMEDIATE）内先做归属与
 *   前置状态检查，再以“UPDATE ... WHERE id = ? AND revision = ? AND status =
 *   'pending'”单语句 CAS 完成条件更新，不采用先读后无条件覆盖；ready 转换要求
 *   实测 hash 与登记的预期摘要一致并携带实际 size；内容身份（hash/size/version/
 *   locator）一经 ready 不接受普通更新覆盖（端口不提供任何更新入口，终态重复
 *   转换返回 conflict），正文变更必须创建新制品；
 * - 跨项目访问（项目 A 请求项目 B 的制品）返回 kind='ownership'，不能仅凭全局
 *   artifactId 放行；仅同项目且核验通过的 ready 制品可取得有效输入引用
 *   （ArtifactInputRef 是内容身份摘要，不是正文本身）；读取路径不信任持久层，
 *   ready 行缺少 hash/size（直接 SQL 注入的历史损坏）一律拒绝放行，损坏诊断
 *   （missing/hash_mismatch/size_mismatch）的检测由 F-012 的中断核对实现；
 * - 会话已关闭时所有端口操作抛出明确“已关闭”错误，不使用失效连接；
 * - listArtifacts（F-012 起）为中断核对/批量恢复提供有界只读分页（按稳定 id
 *   排序，游标为上一页最后一条 id）：缺失项目 not_found，非法分页参数
 *   validation，不参与任何写路径；
 * - 本模块不实现：制品文件 staging/发布（F-010/F-011）、中断核对与损坏诊断
 *   的用例编排（F-012 application 层，经本端口与文件端口组合）、
 *   retention_class 持久化（取值无设计结论）、Host/CLI 命令。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import {
  validateArtifactListOptions,
  validateRegisterArtifactInput,
  validateTransitionArtifactInput,
} from '../../ports/artifact-store.js';
import type {
  ArtifactInputRef,
  ArtifactListPage,
  ArtifactRecord,
  ArtifactStatus,
  ArtifactStore,
} from '../../ports/artifact-store.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

export interface SqliteArtifactStoreOptions {
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
}

interface ArtifactRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly kind: string;
  readonly status: string;
  readonly media_type: string;
  readonly expected_hash: string;
  readonly content_hash: string | null;
  readonly size_bytes: number | null;
  readonly version: number;
  readonly storage_locator: string;
  readonly failure_reason: string | null;
}

const ARTIFACT_STATUSES: readonly ArtifactStatus[] = ['pending', 'ready', 'failed'];

function statusFromRow(row: ArtifactRow, context: ValidationContext): ArtifactStatus {
  const status = ARTIFACT_STATUSES.find((candidate) => candidate === row.status);
  if (status === undefined) {
    throw new StorageError(
      'corrupt',
      context.operation,
      `${context.operation}: 制品状态列超出契约枚举`,
      { entity: context.entity, details: { reason: 'unknown_status' } },
    );
  }
  return status;
}

function artifactFromRow(row: ArtifactRow, context: ValidationContext): ArtifactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    mediaType: row.media_type,
    status: statusFromRow(row, context),
    expectedHash: row.expected_hash,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    locator: row.storage_locator,
    version: row.version,
    failureReason: row.failure_reason,
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
  };
}

/**
 * 装配一个基于真实 SQLite 会话的 ArtifactStore 端口实现。
 *
 * - 调用方负责先完成迁移（F-005 migrateSqliteStorage）再装配本适配器；
 * - import 本模块无副作用；本函数不打开/关闭会话，会话生命周期由调用方管理；
 * - 返回对象不泄漏驱动连接（database 句柄仅在适配器内部与测试诊断中使用）。
 */
export function createSqliteArtifactStore(
  session: SqliteStorageSession,
  options: SqliteArtifactStoreOptions = {},
): ArtifactStore {
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function validateArtifactId(artifactId: string, projectId: string, operation: string): string {
    return validateStableId(
      artifactId,
      { operation, entity: { type: 'artifact', id: artifactId, projectId } },
      'artifactId',
    );
  }

  function selectArtifactRow(
    db: Database.Database,
    projectId: string,
    artifactId: string,
    operation: string,
  ): ArtifactRow {
    const row = db
      .prepare<[string], ArtifactRow>('SELECT * FROM artifacts WHERE id = ?')
      .get(artifactId) as ArtifactRow | undefined;
    if (row === undefined) {
      throw new StorageError(
        'not_found',
        operation,
        `制品 ${artifactId} 不存在`,
        { entity: { type: 'artifact', id: artifactId, projectId } },
      );
    }
    if (row.project_id !== projectId) {
      // 跨项目归属违规：制品存在但不属于请求项目，即使 ready 也不放行。
      throw new StorageError(
        'ownership',
        operation,
        '制品不属于请求项目，禁止跨项目访问（即使制品 ready）',
        { entity: { type: 'artifact', id: artifactId, projectId } },
      );
    }
    return row;
  }

  function requireArtifact(
    db: Database.Database,
    projectId: string,
    artifactId: string,
    operation: string,
  ): ArtifactRow {
    const id = validateArtifactId(artifactId, projectId, operation);
    return selectArtifactRow(db, projectId, id, operation);
  }

  return {
    async registerArtifact(input: unknown): Promise<ArtifactRecord> {
      const operation = 'ArtifactStore.registerArtifact';
      assertOpen(operation);
      const valid = validateRegisterArtifactInput(input, operation);
      const timestamp = nowUtcMs();
      const id = randomUUID();
      const context: ValidationContext = { operation, entity: { type: 'artifact', id, projectId: valid.projectId } };
      return session.transactWrite(operation, (db) => {
        // 缺失项目：外键之外端口先给出明确 not_found（注册流程尚不支持自动建项目）。
        if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(valid.projectId) === undefined) {
          throw new StorageError('not_found', operation, `项目 ${valid.projectId} 不存在`, {
            entity: { type: 'project', id: valid.projectId },
          });
        }
        db.prepare(
          'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, ' +
            'media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) ' +
            "VALUES (?, ?, ?, 1, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?, NULL)",
        ).run(
          id,
          timestamp,
          valid.projectId,
          timestamp,
          valid.kind,
          valid.mediaType,
          valid.expectedHash,
          valid.version,
          valid.locator,
        );
        return artifactFromRow(selectArtifactRow(db, valid.projectId, id, operation), context);
      });
    },

    async getArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord> {
      const operation = 'ArtifactStore.getArtifact';
      assertOpen(operation);
      const row = requireArtifact(session.database, projectId, artifactId, operation);
      const context: ValidationContext = { operation, entity: { type: 'artifact', id: row.id, projectId: row.project_id } };
      return artifactFromRow(row, context);
    },

    async transitionArtifact(projectId: string, artifactId: string, input: unknown): Promise<ArtifactRecord> {
      const operation = 'ArtifactStore.transitionArtifact';
      assertOpen(operation);
      const valid = validateTransitionArtifactInput(input, operation);
      const timestamp = nowUtcMs();
      const entity: StorageEntityRef = { type: 'artifact', id: artifactId, projectId };
      const context: ValidationContext = { operation, entity };
      return session.transactWrite(operation, (db) => {
        const existing = requireArtifact(db, projectId, artifactId, operation);
        if (existing.revision !== valid.expectedRevision) {
          throw new StorageError(
            'conflict',
            operation,
            'expectedRevision 与当前 revision 不匹配（CAS 冲突），未改变制品状态',
            {
              entity,
              details: { expectedRevision: valid.expectedRevision, actualRevision: existing.revision },
            },
          );
        }
        if (existing.status !== 'pending') {
          throw new StorageError(
            'conflict',
            operation,
            `制品已处于终态 ${existing.status}，内容身份不可覆盖；正文变更必须创建新制品`,
            { entity, details: { status: existing.status } },
          );
        }
        let sql: string;
        let params: unknown[];
        if (valid.outcome.status === 'ready') {
          if (valid.outcome.actualHash !== existing.expected_hash) {
            throw new StorageError(
              'validation',
              operation,
              '实际 hash 与登记的预期摘要不一致，不能标记 ready',
              {
                entity,
                details: { field: 'outcome.actualHash', reason: 'hash_mismatch_with_expected' },
              },
            );
          }
          sql =
            'UPDATE artifacts SET revision = revision + 1, updated_at = ?, status = ?, ' +
            'content_hash = ?, size_bytes = ? WHERE id = ? AND project_id = ? AND revision = ? AND status = ?';
          params = [
            timestamp,
            'ready',
            valid.outcome.actualHash,
            valid.outcome.sizeBytes,
            existing.id,
            existing.project_id,
            existing.revision,
            'pending',
          ];
        } else {
          sql =
            'UPDATE artifacts SET revision = revision + 1, updated_at = ?, status = ?, ' +
            'failure_reason = ? WHERE id = ? AND project_id = ? AND revision = ? AND status = ?';
          params = [
            timestamp,
            'failed',
            valid.outcome.reason,
            existing.id,
            existing.project_id,
            existing.revision,
            'pending',
          ];
        }
        const result = db.prepare(sql).run(...params);
        // 事务持有写锁，SELECT 与 UPDATE 之间不存在交错；0 行只可能是调用方
        // bug（修改了检查与更新之间的语句），fail-closed 返回 conflict 而不是
        // 静默成功。
        if (result.changes === 0) {
          throw new StorageError(
            'conflict',
            operation,
            '制品状态转换的 CAS 条件未命中，未改变既有状态',
            { entity, details: { status: existing.status } },
          );
        }
        return artifactFromRow(selectArtifactRow(db, projectId, existing.id, operation), context);
      });
    },

    async getArtifactInputRef(projectId: string, artifactId: string): Promise<ArtifactInputRef> {
      const operation = 'ArtifactStore.getArtifactInputRef';
      assertOpen(operation);
      const row = requireArtifact(session.database, projectId, artifactId, operation);
      const entity: StorageEntityRef = { type: 'artifact', id: row.id, projectId: row.project_id };
      if (row.status !== 'ready' || row.content_hash === null || row.size_bytes === null) {
        // pending/failed 与缺少 hash/size 证据的损坏 ready 行都不能取得有效输入引用。
        throw new StorageError(
          'conflict',
          operation,
          `制品状态 ${row.status} 不能取得有效输入引用（仅核验通过的 ready 制品可用）`,
          { entity, details: { status: row.status } },
        );
      }
      return {
        artifactId: row.id,
        projectId: row.project_id,
        contentHash: row.content_hash,
        sizeBytes: row.size_bytes,
        locator: row.storage_locator,
        version: row.version,
      };
    },

    async listArtifacts(projectId: string, options?: unknown): Promise<ArtifactListPage> {
      const operation = 'ArtifactStore.listArtifacts';
      assertOpen(operation);
      const validProjectId = validateStableId(
        projectId,
        { operation, entity: { type: 'project', id: projectId } },
        'projectId',
      );
      const scan = validateArtifactListOptions(options, operation);
      const context: ValidationContext = {
        operation,
        entity: { type: 'project', id: validProjectId },
      };
      const db = session.database;
      if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(validProjectId) === undefined) {
        throw new StorageError('not_found', operation, `项目 ${validProjectId} 不存在`, {
          entity: { type: 'project', id: validProjectId },
        });
      }
      // 按稳定 id 排序分页（游标 = 上一页最后一条 id）：只读路径，不改任何行。
      const rows = db
        .prepare<[string, string, number], ArtifactRow>(
          'SELECT * FROM artifacts WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?',
        )
        .all(validProjectId, scan.cursor ?? '', scan.limit + 1) as ArtifactRow[];
      const hasMore = rows.length > scan.limit;
      const pageRows = hasMore ? rows.slice(0, scan.limit) : rows;
      return {
        records: pageRows.map((row) => artifactFromRow(row, context)),
        nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
      };
    },
  };
}
