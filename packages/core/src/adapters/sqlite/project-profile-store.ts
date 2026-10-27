import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import {
  validateCapabilityModule,
  validateDetectionEvidence,
  validateProjectProfile,
  type CapabilityModule,
  type DetectionEvidence,
  type ProjectProfile,
} from '../../ports/project-profile.js';
import {
  computeCapabilityModuleDigest,
  type PersistedCapabilityModule,
  type PersistedProjectProfile,
  type ProjectProfileStore,
} from '../../ports/project-profile-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
} from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

type ModuleRow = {
  id: string; created_at: number; project_id: string; revision: number; updated_at: number;
  schema_version: number; module_key: string; version: string; scope: string;
  applies_to: string; dependencies: string; content_ref: string; digest: string; status: string;
};

type ProfileRow = {
  id: string; created_at: number; project_id: string; revision: number; updated_at: number;
  schema_version: number; version: number; profile_revision: string | null; status: string; modules: string;
  document_refs: string; detection_refs: string; detection_evidence: string;
  confirmed_by: string | null; profile_digest: string;
};

const OPERATION = 'ProjectProfileStore';
const PROFILE_STATUSES = ['candidate', 'confirmed', 'rejected', 'manual_configuration_required'] as const;

function entity(type: 'project' | 'capability_module' | 'project_profile', projectId: string, id?: string) {
  return { type, projectId, ...(id === undefined ? {} : { id }) } as const;
}

function context(operation: string, entityRef?: ReturnType<typeof entity>): ValidationContext {
  return { operation, ...(entityRef === undefined ? {} : { entity: entityRef }) };
}

function fail(kind: ConstructorParameters<typeof StorageError>[0], operation: string, message: string, entityRef?: ReturnType<typeof entity>, details?: Readonly<Record<string, unknown>>): never {
  throw new StorageError(kind, operation, message, {
    ...(entityRef === undefined ? {} : { entity: entityRef }),
    ...(details === undefined ? {} : { details }),
  });
}

function assertOpen(session: SqliteStorageSession): void {
  if (!session.isOpen()) fail('corrupt', `${OPERATION}.read`, 'SQLite 存储会话已关闭');
}

function timestamp(now: () => number, operation: string): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 1) fail('validation', operation, '时钟必须返回正安全整数');
  return value;
}

function isConstraint(error: unknown): boolean {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as unknown as { code: string }).code.startsWith('SQLITE_CONSTRAINT');
}

function parseJson<T>(value: string, field: string, operation: string, entityRef: ReturnType<typeof entity>): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new StorageError('corrupt', operation, `持久 JSON 损坏：${field}`, {
      entity: entityRef,
      details: { field },
      cause,
    });
  }
}

function parseVersion(value: unknown, operation: string, field: string): number {
  try {
    return validatePositiveInteger(value, context(operation), field);
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError('validation', operation, `${field} 必须是正整数`, { cause });
  }
}

function moduleKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function parseModuleReference(value: string): { id: string; version: string } | undefined {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { id: value.slice(0, separator), version: value.slice(separator + 1) };
}

function parseModuleInput(raw: unknown): { projectId: string; module: CapabilityModule; digest: string } {
  const operation = `${OPERATION}.createCapabilityModule`;
  const object = requirePlainObject(raw, context(operation), 'input');
  rejectUnknownKeys(object, ['projectId', 'module', 'digest'], context(operation), 'input');
  const projectId = validateStableId(object.projectId, context(operation), 'projectId');
  const module = validateCapabilityModule(object.module);
  const digest = validateSha256Digest(object.digest, context(operation, entity('capability_module', projectId, module.id)), 'digest');
  return { projectId, module, digest };
}

function parseProfileInput(raw: unknown): { profile: ProjectProfile; evidence: readonly DetectionEvidence[] } {
  const operation = `${OPERATION}.createProjectProfile`;
  const object = requirePlainObject(raw, context(operation), 'input');
  rejectUnknownKeys(object, ['profile', 'evidence'], context(operation), 'input');
  const profile = validateProjectProfile(object.profile);
  const rawEvidence = object.evidence === undefined ? [] : object.evidence;
  if (!Array.isArray(rawEvidence)) {
    throw new StorageError('validation', operation, 'evidence 必须是数组', { entity: entity('project_profile', profile.projectId) });
  }
  const evidence = rawEvidence.map((item) => validateDetectionEvidence(item));
  const ids = new Set<string>();
  for (const item of evidence) {
    if (ids.has(item.id)) fail('validation', operation, 'evidence 不允许重复 ID', entity('project_profile', profile.projectId));
    ids.add(item.id);
  }
  for (const ref of profile.detectionEvidenceRefs) {
    if (!ids.has(ref)) fail('validation', operation, '画像引用了未提供的检测证据', entity('project_profile', profile.projectId), { reason: 'missing_detection_evidence', ref });
  }
  return { profile, evidence };
}

function moduleFromRow(row: ModuleRow, operation = `${OPERATION}.read`): PersistedCapabilityModule {
  const entityRef = entity('capability_module', row.project_id, row.module_key);
  if (row.schema_version !== 1) fail('corrupt', operation, '能力模块 schemaVersion 未知', entityRef, { schemaVersion: row.schema_version });
  let module: CapabilityModule;
  try {
    module = validateCapabilityModule({
      schemaVersion: row.schema_version,
      id: row.module_key,
      version: row.version,
      scope: parseJson(row.scope, 'scope', operation, entityRef),
      appliesTo: parseJson(row.applies_to, 'applies_to', operation, entityRef),
      dependencies: parseJson(row.dependencies, 'dependencies', operation, entityRef),
      contentRef: row.content_ref,
      status: row.status,
    });
  } catch (cause) {
    if (cause instanceof StorageError && cause.kind === 'corrupt') throw cause;
    throw new StorageError('corrupt', operation, '能力模块持久结构损坏', { entity: entityRef, cause });
  }
  try {
    validateSha256Digest(row.digest, context(operation, entityRef), 'digest');
  } catch (cause) {
    throw new StorageError('corrupt', operation, '能力模块摘要损坏', { entity: entityRef, cause });
  }
  return {
    moduleId: row.id,
    projectId: row.project_id,
    module,
    digest: row.digest,
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
  };
}

function profileFromRow(row: ProfileRow, operation = `${OPERATION}.read`): PersistedProjectProfile {
  const entityRef = entity('project_profile', row.project_id, row.id);
  if (row.schema_version !== 1) fail('corrupt', operation, '项目画像 schemaVersion 未知', entityRef, { schemaVersion: row.schema_version });
  let profile: ProjectProfile;
  try {
    profile = validateProjectProfile({
      schemaVersion: row.schema_version,
      projectId: row.project_id,
      version: row.version,
      ...(row.profile_revision === null ? {} : { revision: row.profile_revision }),
      status: row.status,
      modules: parseJson(row.modules, 'modules', operation, entityRef),
      documentRefs: parseJson(row.document_refs, 'document_refs', operation, entityRef),
      detectionEvidenceRefs: parseJson(row.detection_refs, 'detection_refs', operation, entityRef),
      confirmedBy: row.confirmed_by,
    });
  } catch (cause) {
    if (cause instanceof StorageError && cause.kind === 'corrupt') throw cause;
    throw new StorageError('corrupt', operation, '项目画像持久结构损坏', { entity: entityRef, cause });
  }
  const detectionEvidence = parseJson<unknown[]>(row.detection_evidence, 'detection_evidence', operation, entityRef).map((item) => {
    try {
      return validateDetectionEvidence(item);
    } catch (cause) {
      throw new StorageError('corrupt', operation, '检测证据结构损坏', { entity: entityRef, cause });
    }
  });
  const expectedDigest = createHash('sha256').update(JSON.stringify(profile), 'utf8').digest('hex');
  if (row.profile_digest !== expectedDigest) {
    fail('corrupt', operation, '项目画像摘要与内容不一致', entityRef, { reason: 'profile_digest_mismatch' });
  }
  return {
    profileId: row.id,
    projectId: row.project_id,
    profile,
    detectionEvidence,
    profileDigest: row.profile_digest,
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
  };
}

function projectExists(db: Database.Database, projectId: string, operation: string): void {
  if (db.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(projectId) === undefined) {
    fail('not_found', operation, '项目不存在', entity('project', projectId));
  }
}

function readModuleRows(db: Database.Database, projectId: string): ModuleRow[] {
  return db.prepare('SELECT * FROM capability_modules WHERE project_id = ? ORDER BY module_key, version, id').all(projectId) as ModuleRow[];
}

function validateModuleGraph(db: Database.Database, projectId: string, candidates: readonly { module: CapabilityModule }[], operation: string): void {
  const all = new Map<string, CapabilityModule>();
  for (const row of readModuleRows(db, projectId)) all.set(moduleKey(row.module_key, row.version), moduleFromRow(row, operation).module);
  for (const candidate of candidates) all.set(moduleKey(candidate.module.id, candidate.module.version), candidate.module);
  for (const module of all.values()) {
    for (const dependency of module.dependencies) {
      if (parseModuleReference(dependency) === undefined || !all.has(dependency)) {
        fail('validation', operation, '能力模块依赖不存在或引用格式无效', entity('capability_module', projectId, module.id), { reason: 'missing_dependency', dependency });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) fail('validation', operation, '能力模块依赖存在循环', entity('capability_module', projectId, key), { reason: 'dependency_cycle' });
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of all.get(key)?.dependencies ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of all.keys()) visit(key);
}

function assertProfileModules(db: Database.Database, profile: ProjectProfile, operation: string, corrupt = false): void {
  const mode = corrupt ? 'corrupt' : 'validation';
  const check = (message: string, details: Readonly<Record<string, unknown>>): never => fail(mode, operation, message, entity('project_profile', profile.projectId, `v${profile.version}`), details);
  const refs = new Set<string>();
  for (const item of profile.modules) refs.add(moduleKey(item.id, item.version));
  for (const item of profile.modules) for (const ref of item.capabilityRefs) refs.add(ref);
  for (const ref of refs) {
    const parsed = parseModuleReference(ref);
    if (parsed === undefined) check('画像能力模块引用格式无效', { reason: 'invalid_module_reference', ref });
    const row = db.prepare('SELECT project_id FROM capability_modules WHERE project_id = ? AND module_key = ? AND version = ?').get(profile.projectId, parsed!.id, parsed!.version) as { project_id: string } | undefined;
    if (row === undefined) {
      const other = db.prepare('SELECT project_id FROM capability_modules WHERE module_key = ? AND version = ? LIMIT 1').get(parsed!.id, parsed!.version) as { project_id: string } | undefined;
      if (other !== undefined && other.project_id !== profile.projectId) check('画像引用了其他项目的能力模块', { reason: 'ownership', ref });
      check('画像引用了失效或不存在的能力模块', { reason: 'missing_module', ref });
    }
  }
}

export function createSqliteProjectProfileStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): ProjectProfileStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;

  const readModule = (projectId: string, moduleId: string, version?: string): PersistedCapabilityModule => {
    const operation = `${OPERATION}.getCapabilityModule`;
    const row = version === undefined
      ? db.prepare('SELECT * FROM capability_modules WHERE project_id = ? AND module_key = ? ORDER BY version DESC, id DESC LIMIT 1').get(projectId, moduleId) as ModuleRow | undefined
      : db.prepare('SELECT * FROM capability_modules WHERE project_id = ? AND module_key = ? AND version = ?').get(projectId, moduleId, version) as ModuleRow | undefined;
    if (row === undefined) {
      const other = version === undefined
        ? db.prepare('SELECT project_id FROM capability_modules WHERE module_key = ? LIMIT 1').get(moduleId) as { project_id: string } | undefined
        : db.prepare('SELECT project_id FROM capability_modules WHERE module_key = ? AND version = ? LIMIT 1').get(moduleId, version) as { project_id: string } | undefined;
      if (other !== undefined && other.project_id !== projectId) fail('ownership', operation, '能力模块不属于请求项目', entity('capability_module', projectId, moduleId));
      fail('not_found', operation, '能力模块不存在', entity('capability_module', projectId, moduleId));
    }
    return moduleFromRow(row);
  };

  const readProfile = (projectId: string, version?: number): PersistedProjectProfile => {
    const operation = `${OPERATION}.getProjectProfile`;
    const row = version === undefined
      ? db.prepare('SELECT * FROM project_profiles WHERE project_id = ? ORDER BY version DESC, id DESC LIMIT 1').get(projectId) as ProfileRow | undefined
      : db.prepare('SELECT * FROM project_profiles WHERE project_id = ? AND version = ?').get(projectId, version) as ProfileRow | undefined;
    if (row === undefined) {
      const other = version === undefined
        ? db.prepare('SELECT project_id FROM project_profiles WHERE project_id <> ? LIMIT 1').get(projectId) as { project_id: string } | undefined
        : db.prepare('SELECT project_id FROM project_profiles WHERE version = ? AND project_id <> ? LIMIT 1').get(version, projectId) as { project_id: string } | undefined;
      if (other !== undefined) fail('ownership', operation, '项目画像不属于请求项目', entity('project_profile', projectId, version === undefined ? undefined : `v${version}`));
      fail('not_found', operation, '项目画像不存在', entity('project_profile', projectId, version === undefined ? undefined : `v${version}`));
    }
    const result = profileFromRow(row);
    assertProfileModules(db, result.profile, operation, true);
    return result;
  };

  const createModules = (inputs: readonly unknown[]): readonly PersistedCapabilityModule[] => {
    const operation = `${OPERATION}.createCapabilityModule`;
    if (!Array.isArray(inputs) || inputs.length === 0) fail('validation', operation, '能力模块输入不能为空');
    const parsed = inputs.map(parseModuleInput);
    const projectId = parsed[0]!.projectId;
    if (parsed.some((item) => item.projectId !== projectId)) fail('validation', operation, '批量能力模块必须属于同一项目');
    return session.transactWrite(operation, () => {
      projectExists(db, projectId, operation);
      const keys = new Set<string>();
      for (const item of parsed) {
        const key = moduleKey(item.module.id, item.module.version);
        if (keys.has(key) || db.prepare('SELECT 1 FROM capability_modules WHERE project_id = ? AND module_key = ? AND version = ?').get(projectId, item.module.id, item.module.version) !== undefined) {
          fail('conflict', operation, '能力模块版本已存在', entity('capability_module', projectId, item.module.id), { version: item.module.version });
        }
        keys.add(key);
      }
      validateModuleGraph(db, projectId, parsed, operation);
      const at = timestamp(now, operation);
      const insert = db.prepare(`INSERT INTO capability_modules
        (id, created_at, project_id, revision, updated_at, schema_version, module_key, version, scope, applies_to, dependencies, content_ref, digest, status)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of parsed) {
        insert.run(randomUUID(), at, projectId, at, item.module.schemaVersion, item.module.id, item.module.version,
          JSON.stringify(item.module.scope), JSON.stringify(item.module.appliesTo), JSON.stringify(item.module.dependencies),
          item.module.contentRef, item.digest, item.module.status);
      }
      return parsed.map((item) => readModule(projectId, item.module.id, item.module.version));
    });
  };

  const createProfile = (raw: unknown): PersistedProjectProfile => {
    const operation = `${OPERATION}.createProjectProfile`;
    const { profile, evidence } = parseProfileInput(raw);
    const profileDigest = createHash('sha256').update(JSON.stringify(profile), 'utf8').digest('hex');
    return session.transactWrite(operation, () => {
      projectExists(db, profile.projectId, operation);
      if (db.prepare('SELECT 1 FROM project_profiles WHERE project_id = ? AND version = ?').get(profile.projectId, profile.version) !== undefined) {
        fail('conflict', operation, '项目画像版本已存在', entity('project_profile', profile.projectId, `v${profile.version}`));
      }
      assertProfileModules(db, profile, operation);
      const at = timestamp(now, operation);
      try {
        db.prepare(`INSERT INTO project_profiles
          (id, created_at, project_id, revision, updated_at, schema_version, version, profile_revision, status, modules, document_refs, detection_refs, detection_evidence, confirmed_by, profile_digest)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), at, profile.projectId, at, profile.schemaVersion, profile.version, profile.revision ?? null, profile.status,
          JSON.stringify(profile.modules), JSON.stringify(profile.documentRefs), JSON.stringify(profile.detectionEvidenceRefs),
          JSON.stringify(evidence), profile.confirmedBy, profileDigest,
        );
      } catch (error) {
        if (isConstraint(error)) throw new StorageError('conflict', operation, '项目画像版本或归属约束冲突', { entity: entity('project_profile', profile.projectId, `v${profile.version}`), cause: error });
        throw error;
      }
      return readProfile(profile.projectId, profile.version);
    });
  };

  return {
    createCapabilityModule(input): PersistedCapabilityModule {
      return createModules([input])[0]!;
    },
    createCapabilityModules: createModules,
    getCapabilityModule(projectIdInput, moduleIdInput, versionInput): PersistedCapabilityModule {
      const operation = `${OPERATION}.getCapabilityModule`;
      assertOpen(session);
      const projectId = validateStableId(projectIdInput, context(operation), 'projectId');
      const moduleId = validateStableId(moduleIdInput, context(operation), 'moduleId');
      const version = versionInput === undefined ? undefined : String(versionInput);
      return readModule(projectId, moduleId, version);
    },
    listCapabilityModules(projectIdInput): readonly PersistedCapabilityModule[] {
      const operation = `${OPERATION}.listCapabilityModules`;
      assertOpen(session);
      const projectId = validateStableId(projectIdInput, context(operation), 'projectId');
      return readModuleRows(db, projectId).map((row) => moduleFromRow(row, operation));
    },
    createProjectProfile: createProfile,
    getProjectProfile(projectIdInput, versionInput): PersistedProjectProfile {
      const operation = `${OPERATION}.getProjectProfile`;
      assertOpen(session);
      const projectId = validateStableId(projectIdInput, context(operation), 'projectId');
      const version = versionInput === undefined ? undefined : parseVersion(versionInput, operation, 'version');
      return readProfile(projectId, version);
    },
    listProjectProfiles(projectIdInput): readonly PersistedProjectProfile[] {
      const operation = `${OPERATION}.listProjectProfiles`;
      assertOpen(session);
      const projectId = validateStableId(projectIdInput, context(operation), 'projectId');
      const rows = db.prepare('SELECT * FROM project_profiles WHERE project_id = ? ORDER BY version, id').all(projectId) as ProfileRow[];
      return rows.map((row) => {
        const result = profileFromRow(row, operation);
        assertProfileModules(db, result.profile, operation, true);
        return result;
      });
    },
  };
}
