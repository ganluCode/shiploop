/**
 * F-002 契约测试专用内存假存储（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 作用：在真实 SQLite 适配器（F-003 起）落地前，把 ports 契约语义固定为可执行断言：
 * - 所有写入口先经 ports 公共校验器做运行时校验，校验失败时底层 Map 完全不变
 *   （测试据此断言“非法输入没有持久化副作用”）；
 * - expectedRevision CAS：只匹配当前 revision 才写入并递增；过期值返回 conflict；
 * - 配置以 JSON 文本形态保存、读取时经 parseStoredSettingsPayload 重新校验，
 *   模拟“损坏 JSON/未知格式不能作为有效配置返回”的读取路径；
 * - 制品 pending→ready/failed 单向转换、跨项目归属拒绝、仅 ready 可取得输入引用。
 *
 * 真实适配器（F-006/F-007/F-009）实现同样的端口接口，并须通过本组行为断言的适配版本；
 * 本文件不声明也不约束任何 SQLite/文件行为。
 */
import { randomUUID } from 'node:crypto';
import { StorageError } from '../../packages/core/src/ports/errors.ts';
import { parseStoredSettingsPayload } from '../../packages/core/src/ports/settings-schema.ts';
import type { SettingsPayload } from '../../packages/core/src/ports/settings-schema.ts';
import {
  GLOBAL_SETTINGS_ID,
  validateCreateProjectInput,
  validateUpdateProjectInput,
  validatePutSettingsInput,
  validateUpdateSettingsInput,
} from '../../packages/core/src/ports/state-store.ts';
import type {
  GlobalSettingsRecord,
  ProjectRecord,
  ProjectSettingsRecord,
  ProjectWithInitialSettingsRecord,
  StateStore,
} from '../../packages/core/src/ports/state-store.ts';
import {
  validateRegisterArtifactInput,
  validateTransitionArtifactInput,
} from '../../packages/core/src/ports/artifact-store.ts';
import type {
  ArtifactInputRef,
  ArtifactRecord,
  ArtifactStore,
} from '../../packages/core/src/ports/artifact-store.ts';
import { validateStableId } from '../../packages/core/src/ports/validation.ts';
import type { StorageEntityRef } from '../../packages/core/src/ports/errors.ts';

export type StoredSettingsRow = {
  revision: number;
  createdAtUtcMs: number;
  updatedAtUtcMs: number;
  /** 持久化形态：JSON 文本。测试可直接改写以注入损坏数据。 */
  json: string;
};

export type InMemoryStorage = {
  readonly stateStore: StateStore;
  readonly artifactStore: ArtifactStore;
  /** 测试探针：直接观察/篡改“持久层”，用于无副作用与损坏读取断言。 */
  readonly raw: {
    readonly projects: Map<string, ProjectRecord>;
    /** key 为 GLOBAL_SETTINGS_ID（全局单例）或 projectId（每项目一条）。 */
    readonly settings: Map<string, StoredSettingsRow>;
    readonly artifacts: Map<string, ArtifactRecord>;
  };
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryStorage(now: () => number): InMemoryStorage {
  const projects = new Map<string, ProjectRecord>();
  const settings = new Map<string, StoredSettingsRow>();
  const artifacts = new Map<string, ArtifactRecord>();

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

  function requireProject(projectId: string, operation: string): ProjectRecord {
    const id = validateStableId(projectId, { operation, entity: { type: 'project', id: projectId } }, 'projectId');
    const record = projects.get(id);
    if (record === undefined) {
      throw notFound(operation, { type: 'project', id }, `项目 ${id} 不存在`);
    }
    return record;
  }

  function readSettingsRecord(
    key: string,
    operation: string,
    entity: StorageEntityRef,
  ): { row: StoredSettingsRow; payload: SettingsPayload } {
    const row = settings.get(key);
    if (row === undefined) {
      throw notFound(operation, entity, '当前配置不存在');
    }
    // 读取路径重新校验：损坏 JSON / 未知 schemaVersion 在此抛出 corrupt。
    const payload = parseStoredSettingsPayload(row.json, { operation, entity });
    return { row, payload };
  }

  function toGlobalRecord(key: string, row: StoredSettingsRow, payload: SettingsPayload): GlobalSettingsRecord {
    return {
      id: key,
      schemaVersion: payload.schemaVersion,
      payload,
      revision: row.revision,
      createdAtUtcMs: row.createdAtUtcMs,
      updatedAtUtcMs: row.updatedAtUtcMs,
    };
  }

  function writeCas(
    key: string,
    operation: string,
    entity: StorageEntityRef,
    expectedRevision: number,
    payload: SettingsPayload,
  ): StoredSettingsRow {
    const existing = settings.get(key);
    if (existing === undefined) {
      throw notFound(operation, entity, '当前配置不存在');
    }
    if (existing.revision !== expectedRevision) {
      throw conflict(operation, 'expectedRevision 与当前 revision 不匹配（CAS 冲突），未覆盖现有配置', entity, {
        expectedRevision,
        actualRevision: existing.revision,
      });
    }
    const next: StoredSettingsRow = {
      revision: existing.revision + 1,
      createdAtUtcMs: existing.createdAtUtcMs,
      updatedAtUtcMs: now(),
      json: JSON.stringify(payload),
    };
    settings.set(key, next);
    return next;
  }

  const stateStore: StateStore = {
    async createProject(input: unknown): Promise<ProjectRecord> {
      const operation = 'StateStore.createProject';
      const valid = validateCreateProjectInput(input, operation);
      const timestamp = now();
      const record: ProjectRecord = {
        id: randomUUID(),
        displayName: valid.displayName,
        description: valid.description,
        status: 'active',
        labels: valid.labels,
        repositoryBindingId: null,
        revision: 1,
        createdAtUtcMs: timestamp,
        updatedAtUtcMs: timestamp,
      };
      projects.set(record.id, record);
      return clone(record);
    },

    async getProject(projectId: string): Promise<ProjectRecord> {
      return clone(requireProject(projectId, 'StateStore.getProject'));
    },

    async updateProject(projectId: string, input: unknown): Promise<ProjectRecord> {
      const operation = 'StateStore.updateProject';
      const valid = validateUpdateProjectInput(input, operation);
      const existing = requireProject(projectId, operation);
      if (existing.revision !== valid.expectedRevision) {
        throw conflict(
          operation,
          'expectedRevision 与当前 revision 不匹配（CAS 冲突），未修改项目元数据',
          { type: 'project', id: projectId },
          { expectedRevision: valid.expectedRevision, actualRevision: existing.revision },
        );
      }
      const next: ProjectRecord = {
        ...existing,
        displayName: valid.displayName ?? existing.displayName,
        description: valid.description !== undefined ? valid.description : existing.description,
        labels: valid.labels !== undefined ? valid.labels : existing.labels,
        revision: existing.revision + 1,
        updatedAtUtcMs: now(),
      };
      projects.set(projectId, next);
      return clone(next);
    },

    async createProjectWithInitialSettings(
      projectInput: unknown,
      settingsInput: unknown,
    ): Promise<ProjectWithInitialSettingsRecord> {
      const operation = 'StateStore.createProjectWithInitialSettings';
      // 两个输入都在任何持久化副作用之前完成校验：第二步校验失败不得残留项目。
      const validProject = validateCreateProjectInput(projectInput, operation);
      const validSettings = validatePutSettingsInput(settingsInput, operation, { type: 'project_settings' });
      const timestamp = now();
      const project: ProjectRecord = {
        id: randomUUID(),
        displayName: validProject.displayName,
        description: validProject.description,
        status: 'active',
        labels: validProject.labels,
        repositoryBindingId: null,
        revision: 1,
        createdAtUtcMs: timestamp,
        updatedAtUtcMs: timestamp,
      };
      // 内存实现同步执行，两步写入之间不存在交错；真实适配器以单事务保证同等原子性。
      projects.set(project.id, project);
      settings.set(project.id, {
        revision: 1,
        createdAtUtcMs: timestamp,
        updatedAtUtcMs: timestamp,
        json: JSON.stringify(validSettings.payload),
      });
      const entity: StorageEntityRef = { type: 'project_settings', projectId: project.id };
      const { row, payload } = readSettingsRecord(project.id, operation, entity);
      return { project: clone(project), settings: { ...toGlobalRecord(project.id, row, payload), projectId: project.id } };
    },

    async createGlobalSettings(input: unknown): Promise<GlobalSettingsRecord> {
      const operation = 'StateStore.createGlobalSettings';
      const entity: StorageEntityRef = { type: 'global_settings', id: GLOBAL_SETTINGS_ID };
      const valid = validatePutSettingsInput(input, operation, entity);
      if (settings.has(GLOBAL_SETTINGS_ID)) {
        throw conflict(operation, '全局当前配置已存在（单例），重复创建被拒绝而不是覆盖', entity);
      }
      const timestamp = now();
      settings.set(GLOBAL_SETTINGS_ID, {
        revision: 1,
        createdAtUtcMs: timestamp,
        updatedAtUtcMs: timestamp,
        json: JSON.stringify(valid.payload),
      });
      const { row, payload } = readSettingsRecord(GLOBAL_SETTINGS_ID, operation, entity);
      return toGlobalRecord(GLOBAL_SETTINGS_ID, row, payload);
    },

    async getGlobalSettings(): Promise<GlobalSettingsRecord> {
      const operation = 'StateStore.getGlobalSettings';
      const entity: StorageEntityRef = { type: 'global_settings', id: GLOBAL_SETTINGS_ID };
      const { row, payload } = readSettingsRecord(GLOBAL_SETTINGS_ID, operation, entity);
      return toGlobalRecord(GLOBAL_SETTINGS_ID, row, payload);
    },

    async updateGlobalSettings(input: unknown): Promise<GlobalSettingsRecord> {
      const operation = 'StateStore.updateGlobalSettings';
      const entity: StorageEntityRef = { type: 'global_settings', id: GLOBAL_SETTINGS_ID };
      const valid = validateUpdateSettingsInput(input, operation, entity);
      const row = writeCas(GLOBAL_SETTINGS_ID, operation, entity, valid.expectedRevision, valid.payload);
      return toGlobalRecord(GLOBAL_SETTINGS_ID, row, valid.payload);
    },

    async createProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord> {
      const operation = 'StateStore.createProjectSettings';
      const entity: StorageEntityRef = { type: 'project_settings', projectId };
      const valid = validatePutSettingsInput(input, operation, entity);
      requireProject(projectId, operation);
      if (settings.has(projectId)) {
        throw conflict(operation, '该项目当前配置已存在（每项目一条），重复创建被拒绝而不是覆盖', entity);
      }
      const timestamp = now();
      settings.set(projectId, {
        revision: 1,
        createdAtUtcMs: timestamp,
        updatedAtUtcMs: timestamp,
        json: JSON.stringify(valid.payload),
      });
      const { row, payload } = readSettingsRecord(projectId, operation, entity);
      return { ...toGlobalRecord(projectId, row, payload), projectId };
    },

    async getProjectSettings(projectId: string): Promise<ProjectSettingsRecord> {
      const operation = 'StateStore.getProjectSettings';
      const id = validateStableId(
        projectId,
        { operation, entity: { type: 'project_settings', projectId } },
        'projectId',
      );
      const entity: StorageEntityRef = { type: 'project_settings', projectId: id };
      const { row, payload } = readSettingsRecord(id, operation, entity);
      return { ...toGlobalRecord(id, row, payload), projectId: id };
    },

    async updateProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord> {
      const operation = 'StateStore.updateProjectSettings';
      const entity: StorageEntityRef = { type: 'project_settings', projectId };
      const valid = validateUpdateSettingsInput(input, operation, entity);
      const row = writeCas(projectId, operation, entity, valid.expectedRevision, valid.payload);
      return { ...toGlobalRecord(projectId, row, valid.payload), projectId };
    },
  };

  function requireArtifact(projectId: string, artifactId: string, operation: string): ArtifactRecord {
    const id = validateStableId(
      artifactId,
      { operation, entity: { type: 'artifact', id: artifactId, projectId } },
      'artifactId',
    );
    const record = artifacts.get(id);
    if (record === undefined) {
      throw notFound(operation, { type: 'artifact', id, projectId }, `制品 ${id} 不存在`);
    }
    if (record.projectId !== projectId) {
      throw new StorageError(
        'ownership',
        operation,
        '制品不属于请求项目，禁止跨项目访问（即使制品 ready）',
        { entity: { type: 'artifact', id, projectId } },
      );
    }
    return record;
  }

  const artifactStore: ArtifactStore = {
    async registerArtifact(input: unknown): Promise<ArtifactRecord> {
      const operation = 'ArtifactStore.registerArtifact';
      const valid = validateRegisterArtifactInput(input, operation);
      requireProject(valid.projectId, operation);
      const timestamp = now();
      const record: ArtifactRecord = {
        id: randomUUID(),
        projectId: valid.projectId,
        kind: valid.kind,
        mediaType: valid.mediaType,
        status: 'pending',
        expectedHash: valid.expectedHash,
        contentHash: null,
        sizeBytes: null,
        locator: valid.locator,
        version: valid.version,
        failureReason: null,
        revision: 1,
        createdAtUtcMs: timestamp,
        updatedAtUtcMs: timestamp,
      };
      artifacts.set(record.id, record);
      return clone(record);
    },

    async getArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord> {
      return clone(requireArtifact(projectId, artifactId, 'ArtifactStore.getArtifact'));
    },

    async transitionArtifact(projectId: string, artifactId: string, input: unknown): Promise<ArtifactRecord> {
      const operation = 'ArtifactStore.transitionArtifact';
      const valid = validateTransitionArtifactInput(input, operation);
      const existing = requireArtifact(projectId, artifactId, operation);
      const entity: StorageEntityRef = { type: 'artifact', id: existing.id, projectId };
      if (existing.revision !== valid.expectedRevision) {
        throw conflict(operation, 'expectedRevision 与当前 revision 不匹配（CAS 冲突），未改变制品状态', entity, {
          expectedRevision: valid.expectedRevision,
          actualRevision: existing.revision,
        });
      }
      if (existing.status !== 'pending') {
        throw conflict(
          operation,
          `制品已处于终态 ${existing.status}，内容身份不可覆盖；正文变更必须创建新制品`,
          entity,
          { status: existing.status },
        );
      }
      const timestamp = now();
      let next: ArtifactRecord;
      if (valid.outcome.status === 'ready') {
        if (valid.outcome.actualHash !== existing.expectedHash) {
          throw new StorageError('validation', operation, '实际 hash 与登记的预期摘要不一致，不能标记 ready', {
            entity,
            details: { field: 'outcome.actualHash', reason: 'hash_mismatch_with_expected' },
          });
        }
        next = {
          ...existing,
          status: 'ready',
          contentHash: valid.outcome.actualHash,
          sizeBytes: valid.outcome.sizeBytes,
          revision: existing.revision + 1,
          updatedAtUtcMs: timestamp,
        };
      } else {
        next = {
          ...existing,
          status: 'failed',
          failureReason: valid.outcome.reason,
          revision: existing.revision + 1,
          updatedAtUtcMs: timestamp,
        };
      }
      artifacts.set(existing.id, next);
      return clone(next);
    },

    async getArtifactInputRef(projectId: string, artifactId: string): Promise<ArtifactInputRef> {
      const operation = 'ArtifactStore.getArtifactInputRef';
      const record = requireArtifact(projectId, artifactId, operation);
      if (record.status !== 'ready' || record.contentHash === null || record.sizeBytes === null) {
        throw conflict(
          operation,
          `制品状态 ${record.status} 不能取得有效输入引用（仅核验通过的 ready 制品可用）`,
          { type: 'artifact', id: record.id, projectId },
          { status: record.status },
        );
      }
      return {
        artifactId: record.id,
        projectId: record.projectId,
        contentHash: record.contentHash,
        sizeBytes: record.sizeBytes,
        locator: record.locator,
        version: record.version,
      };
    },
  };

  return { stateStore, artifactStore, raw: { projects, settings, artifacts } };
}
