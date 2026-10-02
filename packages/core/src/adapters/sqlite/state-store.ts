/**
 * F-006 SQLite StateStore 适配器（adapters 层）：项目与全局/项目当前配置的
 * 基础创建、读取与 expectedRevision CAS 更新。
 *
 * 设计依据：core-design/03 §1-3（端口先校验后持久化、短同步写事务、revision CAS）、
 * core-design/11 §1/§3（projects / global_settings 单例 id=global / project_settings
 * UNIQUE(project_id)；更新走 revision CAS，不建配置历史版本表）与 F-002 端口契约
 * （ports/state-store.ts；语义基线见 test/storage-contracts.test.ts 与
 * test/helpers/in-memory-store.ts——本适配器实现同组行为断言的真实 SQLite 版本）。
 *
 * 不变量：
 * - 输入一律为 unknown，先经 F-002 运行时校验器再持久化：校验失败发生在任何
 *   SQL 执行之前，真实库中没有半条记录；读取持久 JSON 时重新经
 *   parseStoredSettingsPayload 校验，损坏 JSON / 未知 schemaVersion 一律以
 *   kind='corrupt' 拒绝，不作为有效配置返回；
 * - 所有写入在 F-004 短同步写事务（BEGIN IMMEDIATE）内完成：重复创建以事务内
 *   存在性检查给出结构化 conflict（写入被串行化，不存在 check-then-insert 竞争窗口），
 *   CAS 更新以“UPDATE ... WHERE revision = expectedRevision”单语句完成，不采用
 *   先读后无条件覆盖；createProjectWithInitialSettings（F-007）把项目与初始项目配置
 *   封装为同一业务原子操作——两个输入都在任何 SQL 之前完成校验，第二步失败时
 *   整组回滚，无残留项目或配置；跨进程竞争、失败注入与组合写入的深度验证见
 *   test/sqlite-cas-and-atomicity.test.ts；
 * - 稳定 ID（UUID）与应用侧 UTC 毫秒时间由注入时钟提供；displayName/description
 *   与标签不参与 ID 或物理路径推导；payload 只保存经校验的结构化 JSON，
 *   不存明文凭据（F-002 Schema 限定 credentialRef 为引用形态）；
 * - 会话已关闭时所有端口操作抛出明确“已关闭”错误，不使用失效连接；
 * - 本模块不实现：仓库注册流程、PathService 默认 OS 数据根、标签统计筛选、
 *   配置有效合并、模型路由、项目列表分页（最小窄契约 F-002 未定义列表方法，
 *   不在本 Feature 扩展契约面）、Host/CLI 命令。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import { parseStoredSettingsPayload } from '../../ports/settings-schema.js';
import type { SettingsPayload } from '../../ports/settings-schema.js';
import {
  GLOBAL_SETTINGS_ID,
  validateCreateProjectInput,
  validateUpdateProjectInput,
  validatePutSettingsInput,
  validateUpdateSettingsInput,
} from '../../ports/state-store.js';
import type {
  GlobalSettingsRecord,
  ProjectRecord,
  ProjectSettingsRecord,
  ProjectStatus,
  ProjectWithInitialSettingsRecord,
  StateStore,
  ValidatedCreateProjectInput,
} from '../../ports/state-store.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

export interface SqliteStateStoreOptions {
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
}

interface ProjectRow {
  readonly id: string;
  readonly created_at: number;
  readonly revision: number;
  readonly updated_at: number;
  readonly display_name: string;
  readonly status: string;
  readonly description: string | null;
  readonly labels: string;
  readonly repository_binding_id: string | null;
}

interface GlobalSettingsRow {
  readonly id: string;
  readonly created_at: number;
  readonly revision: number;
  readonly updated_at: number;
  readonly schema_version: number;
  readonly payload: string;
}

interface ProjectSettingsRow extends GlobalSettingsRow {
  readonly project_id: string;
}

const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'archiving', 'archived', 'deleting'];

function statusFromRow(row: ProjectRow, context: ValidationContext): ProjectStatus {
  const status = PROJECT_STATUSES.find((candidate) => candidate === row.status);
  if (status === undefined) {
    throw new StorageError('corrupt', context.operation, `${context.operation}: 项目状态列超出契约枚举`, {
      entity: context.entity,
      details: { reason: 'unknown_status' },
    });
  }
  return status;
}

function labelsFromRow(row: ProjectRow, context: ValidationContext): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.labels);
  } catch (cause) {
    throw new StorageError('corrupt', context.operation, `${context.operation}: 项目标签持久 JSON 损坏`, {
      entity: context.entity,
      details: { reason: 'invalid_labels_json' },
      cause,
    });
  }
  if (!Array.isArray(parsed) || parsed.some((label) => typeof label !== 'string')) {
    throw new StorageError('corrupt', context.operation, `${context.operation}: 项目标签不是字符串数组`, {
      entity: context.entity,
      details: { reason: 'labels_not_string_array' },
    });
  }
  return [...parsed];
}

function projectFromRow(row: ProjectRow, context: ValidationContext): ProjectRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    status: statusFromRow(row, context),
    labels: labelsFromRow(row, context),
    repositoryBindingId: row.repository_binding_id,
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
  };
}

/** 设置行的读取路径：持久 JSON 必须重新通过 F-002 结构校验，否则 corrupt。 */
function payloadFromRow(row: GlobalSettingsRow, context: ValidationContext): SettingsPayload {
  return parseStoredSettingsPayload(row.payload, context);
}

function globalSettingsFromRow(row: GlobalSettingsRow, context: ValidationContext): GlobalSettingsRecord {
  const payload = payloadFromRow(row, context);
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    payload,
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
  };
}

function projectSettingsFromRow(row: ProjectSettingsRow, context: ValidationContext): ProjectSettingsRecord {
  return { ...globalSettingsFromRow(row, context), projectId: row.project_id };
}

/**
 * 装配一个基于真实 SQLite 会话的 StateStore 端口实现。
 *
 * - 调用方负责先完成迁移（F-005 migrateSqliteStorage）再装配本适配器；
 * - import 本模块无副作用；本函数不打开/关闭会话，会话生命周期由调用方管理；
 * - 返回对象不泄漏驱动连接（database 句柄仅在适配器内部与测试诊断中使用）。
 */
export function createSqliteStateStore(
  session: SqliteStorageSession,
  options: SqliteStateStoreOptions = {},
): StateStore {
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function conflict(
    operation: string,
    message: string,
    entity: StorageEntityRef,
    details?: Record<string, unknown>,
  ): StorageError {
    return new StorageError('conflict', operation, message, { entity, details });
  }

  function notFound(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('not_found', operation, message, { entity });
  }

  function validateProjectId(projectId: string, operation: string, entityType: StorageEntityRef['type']): string {
    return validateStableId(projectId, { operation, entity: { type: entityType, id: projectId } }, 'projectId');
  }

  function selectProjectRow(db: Database.Database, id: string, operation: string): ProjectRow {
    const row = db
      .prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    if (row === undefined) {
      throw notFound(operation, { type: 'project', id }, `项目 ${id} 不存在`);
    }
    return row;
  }

  function selectGlobalSettingsRow(
    db: Database.Database,
    operation: string,
  ): GlobalSettingsRow {
    const row = db
      .prepare<[string], GlobalSettingsRow>('SELECT * FROM global_settings WHERE id = ?')
      .get(GLOBAL_SETTINGS_ID) as GlobalSettingsRow | undefined;
    if (row === undefined) {
      throw notFound(
        operation,
        { type: 'global_settings', id: GLOBAL_SETTINGS_ID },
        '全局当前配置不存在',
      );
    }
    return row;
  }

  function selectProjectSettingsRow(
    db: Database.Database,
    projectId: string,
    operation: string,
  ): ProjectSettingsRow {
    const row = db
      .prepare<[string], ProjectSettingsRow>('SELECT * FROM project_settings WHERE project_id = ?')
      .get(projectId) as ProjectSettingsRow | undefined;
    if (row === undefined) {
      throw notFound(
        operation,
        { type: 'project_settings', projectId },
        `项目 ${projectId} 的当前配置不存在`,
      );
    }
    return row;
  }

  /** 项目行插入（事务内使用；调用方保证输入已通过 F-002 校验）。 */
  function insertProjectRow(
    db: Database.Database,
    id: string,
    timestamp: number,
    valid: ValidatedCreateProjectInput,
  ): void {
    db.prepare(
      'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels, repository_binding_id) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)',
    ).run(id, timestamp, timestamp, valid.displayName, 'active', valid.description, JSON.stringify(valid.labels));
  }

  /** 项目配置行插入（事务内使用；调用方保证项目存在且 payload 已通过 F-002 校验）。 */
  function insertProjectSettingsRow(
    db: Database.Database,
    projectId: string,
    timestamp: number,
    payload: SettingsPayload,
  ): void {
    db.prepare(
      'INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) ' +
        'VALUES (?, ?, ?, 1, ?, ?, ?)',
    ).run(randomUUID(), timestamp, projectId, timestamp, payload.schemaVersion, JSON.stringify(payload));
  }

  /** CAS 更新结果为 0 行时的判定：实体缺失（not_found）或 revision 过期（conflict）。 */
  function requireCasTarget<T extends { revision: number }>(
    row: T | undefined,
    operation: string,
    entity: StorageEntityRef,
    expectedRevision: number,
    missingMessage: string,
  ): void {
    if (row === undefined) {
      throw notFound(operation, entity, missingMessage);
    }
    throw conflict(
      operation,
      'expectedRevision 与当前 revision 不匹配（CAS 冲突），未覆盖现有记录',
      entity,
      { expectedRevision, actualRevision: row.revision },
    );
  }

  return {
    async createProject(input: unknown): Promise<ProjectRecord> {
      const operation = 'StateStore.createProject';
      assertOpen(operation);
      const valid = validateCreateProjectInput(input, operation);
      const timestamp = nowUtcMs();
      const id = randomUUID();
      const context: ValidationContext = { operation, entity: { type: 'project', id } };
      return session.transactWrite(operation, (db) => {
        insertProjectRow(db, id, timestamp, valid);
        return projectFromRow(selectProjectRow(db, id, operation), context);
      });
    },

    async createProjectWithInitialSettings(
      projectInput: unknown,
      settingsInput: unknown,
    ): Promise<ProjectWithInitialSettingsRecord> {
      const operation = 'StateStore.createProjectWithInitialSettings';
      assertOpen(operation);
      // 两个输入都在任何 SQL 之前完成校验：第二步校验失败不会残留项目行。
      const validProject = validateCreateProjectInput(projectInput, operation);
      const validSettings = validatePutSettingsInput(settingsInput, operation, { type: 'project_settings' });
      const timestamp = nowUtcMs();
      const projectId = randomUUID();
      const projectContext: ValidationContext = { operation, entity: { type: 'project', id: projectId } };
      const settingsContext: ValidationContext = {
        operation,
        entity: { type: 'project_settings', projectId },
      };
      return session.transactWrite(operation, (db) => {
        insertProjectRow(db, projectId, timestamp, validProject);
        insertProjectSettingsRow(db, projectId, timestamp, validSettings.payload);
        return {
          project: projectFromRow(selectProjectRow(db, projectId, operation), projectContext),
          settings: projectSettingsFromRow(selectProjectSettingsRow(db, projectId, operation), settingsContext),
        };
      });
    },

    async getProject(projectId: string): Promise<ProjectRecord> {
      const operation = 'StateStore.getProject';
      assertOpen(operation);
      const id = validateProjectId(projectId, operation, 'project');
      const context: ValidationContext = { operation, entity: { type: 'project', id } };
      const row = selectProjectRow(session.database, id, operation);
      return projectFromRow(row, context);
    },

    async updateProject(projectId: string, input: unknown): Promise<ProjectRecord> {
      const operation = 'StateStore.updateProject';
      assertOpen(operation);
      const id = validateProjectId(projectId, operation, 'project');
      const valid = validateUpdateProjectInput(input, operation);
      const timestamp = nowUtcMs();
      const entity: StorageEntityRef = { type: 'project', id };
      const context: ValidationContext = { operation, entity };
      return session.transactWrite(operation, (db) => {
        const assignments = ['revision = revision + 1', 'updated_at = ?'];
        const params: unknown[] = [timestamp];
        if (valid.displayName !== undefined) {
          assignments.push('display_name = ?');
          params.push(valid.displayName);
        }
        if (valid.description !== undefined) {
          assignments.push('description = ?');
          params.push(valid.description);
        }
        if (valid.labels !== undefined) {
          assignments.push('labels = ?');
          params.push(JSON.stringify(valid.labels));
        }
        params.push(id, valid.expectedRevision);
        const result = db
          .prepare(`UPDATE projects SET ${assignments.join(', ')} WHERE id = ? AND revision = ?`)
          .run(...params);
        if (result.changes === 0) {
          requireCasTarget(
            (db.prepare('SELECT revision FROM projects WHERE id = ?').get(id) as { revision: number } | undefined),
            operation,
            entity,
            valid.expectedRevision,
            `项目 ${id} 不存在`,
          );
        }
        return projectFromRow(selectProjectRow(db, id, operation), context);
      });
    },

    async createGlobalSettings(input: unknown): Promise<GlobalSettingsRecord> {
      const operation = 'StateStore.createGlobalSettings';
      assertOpen(operation);
      const entity: StorageEntityRef = { type: 'global_settings', id: GLOBAL_SETTINGS_ID };
      const valid = validatePutSettingsInput(input, operation, entity);
      const timestamp = nowUtcMs();
      const context: ValidationContext = { operation, entity };
      return session.transactWrite(operation, (db) => {
        if (db.prepare('SELECT 1 FROM global_settings WHERE id = ?').get(GLOBAL_SETTINGS_ID) !== undefined) {
          throw conflict(
            operation,
            '全局当前配置已存在（单例），重复创建被拒绝而不是覆盖',
            entity,
          );
        }
        db.prepare(
          'INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) ' +
            "VALUES (?, ?, 1, ?, ?, ?)",
        ).run(
          GLOBAL_SETTINGS_ID,
          timestamp,
          timestamp,
          valid.payload.schemaVersion,
          JSON.stringify(valid.payload),
        );
        return globalSettingsFromRow(selectGlobalSettingsRow(db, operation), context);
      });
    },

    async getGlobalSettings(): Promise<GlobalSettingsRecord> {
      const operation = 'StateStore.getGlobalSettings';
      assertOpen(operation);
      const entity: StorageEntityRef = { type: 'global_settings', id: GLOBAL_SETTINGS_ID };
      const context: ValidationContext = { operation, entity };
      const row = selectGlobalSettingsRow(session.database, operation);
      return globalSettingsFromRow(row, context);
    },

    async updateGlobalSettings(input: unknown): Promise<GlobalSettingsRecord> {
      const operation = 'StateStore.updateGlobalSettings';
      assertOpen(operation);
      const entity: StorageEntityRef = { type: 'global_settings', id: GLOBAL_SETTINGS_ID };
      const valid = validateUpdateSettingsInput(input, operation, entity);
      const timestamp = nowUtcMs();
      const context: ValidationContext = { operation, entity };
      return session.transactWrite(operation, (db) => {
        const result = db
          .prepare(
            'UPDATE global_settings SET revision = revision + 1, updated_at = ?, schema_version = ?, payload = ? ' +
              'WHERE id = ? AND revision = ?',
          )
          .run(timestamp, valid.payload.schemaVersion, JSON.stringify(valid.payload), GLOBAL_SETTINGS_ID, valid.expectedRevision);
        if (result.changes === 0) {
          requireCasTarget(
            (db
              .prepare('SELECT revision FROM global_settings WHERE id = ?')
              .get(GLOBAL_SETTINGS_ID) as { revision: number } | undefined),
            operation,
            entity,
            valid.expectedRevision,
            '全局当前配置不存在',
          );
        }
        return globalSettingsFromRow(selectGlobalSettingsRow(db, operation), context);
      });
    },

    async createProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord> {
      const operation = 'StateStore.createProjectSettings';
      assertOpen(operation);
      const id = validateProjectId(projectId, operation, 'project_settings');
      const entity: StorageEntityRef = { type: 'project_settings', projectId: id };
      const valid = validatePutSettingsInput(input, operation, entity);
      const timestamp = nowUtcMs();
      const context: ValidationContext = { operation, entity };
      return session.transactWrite(operation, (db) => {
        if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) === undefined) {
          throw notFound(operation, { type: 'project', id }, `项目 ${id} 不存在`);
        }
        if (db.prepare('SELECT 1 FROM project_settings WHERE project_id = ?').get(id) !== undefined) {
          throw conflict(
            operation,
            '该项目当前配置已存在（每项目一条），重复创建被拒绝而不是覆盖',
            entity,
          );
        }
        insertProjectSettingsRow(db, id, timestamp, valid.payload);
        return projectSettingsFromRow(selectProjectSettingsRow(db, id, operation), context);
      });
    },

    async getProjectSettings(projectId: string): Promise<ProjectSettingsRecord> {
      const operation = 'StateStore.getProjectSettings';
      assertOpen(operation);
      const id = validateProjectId(projectId, operation, 'project_settings');
      const entity: StorageEntityRef = { type: 'project_settings', projectId: id };
      const context: ValidationContext = { operation, entity };
      const row = selectProjectSettingsRow(session.database, id, operation);
      return projectSettingsFromRow(row, context);
    },

    async updateProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord> {
      const operation = 'StateStore.updateProjectSettings';
      assertOpen(operation);
      const id = validateProjectId(projectId, operation, 'project_settings');
      const entity: StorageEntityRef = { type: 'project_settings', projectId: id };
      const valid = validateUpdateSettingsInput(input, operation, entity);
      const timestamp = nowUtcMs();
      const context: ValidationContext = { operation, entity };
      return session.transactWrite(operation, (db) => {
        const result = db
          .prepare(
            'UPDATE project_settings SET revision = revision + 1, updated_at = ?, schema_version = ?, payload = ? ' +
              'WHERE project_id = ? AND revision = ?',
          )
          .run(timestamp, valid.payload.schemaVersion, JSON.stringify(valid.payload), id, valid.expectedRevision);
        if (result.changes === 0) {
          requireCasTarget(
            (db
              .prepare('SELECT revision FROM project_settings WHERE project_id = ?')
              .get(id) as { revision: number } | undefined),
            operation,
            entity,
            valid.expectedRevision,
            `项目 ${id} 的当前配置不存在`,
          );
        }
        return projectSettingsFromRow(selectProjectSettingsRow(db, id, operation), context);
      });
    },
  };
}
