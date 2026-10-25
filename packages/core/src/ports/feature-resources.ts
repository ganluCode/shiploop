/**
 * P05-5 / F-001 Feature 共享资源端口契约（纯校验与排序，无 I/O）。
 *
 * 该契约表达 Feature 层的资源门控，职责独立于 P04 的执行槽位、
 * `global:execution` / `project:<id>:work` / workspace Attempt 租约和 Git
 * 公共元数据适配器。资源集合由 Core 在进入短事务前规范化；适配器随后必须按
 * `FEATURE_RESOURCE_KIND_ORDER` 的顺序整组认领，不能在事务内等待 Runtime、网络、Git
 * 或测试。
 */
import { StorageError } from './errors.js';
import type { StorageEntityType } from './errors.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const FEATURE_RESOURCE_SCHEMA_VERSION = 1 as const;

/**
 * Canonical categories. The suffix describes the ownership semantics and is part of
 * the contract so a slot or an Attempt lease cannot be silently reused as a Feature
 * resource.
 */
export const FEATURE_RESOURCE_KINDS = [
  'planning_exclusive',
  'feature_code_shared',
  'worktree_write_exclusive',
  'git_public_metadata_short',
  'migration',
  'contract',
] as const;
export type FeatureResourceKind = (typeof FEATURE_RESOURCE_KINDS)[number];

/** A small compatibility vocabulary accepted at the JSON boundary and normalized above. */
const RESOURCE_KIND_ALIASES: Readonly<Record<string, FeatureResourceKind>> = {
  planning: 'planning_exclusive',
  feature_code: 'feature_code_shared',
  worktree: 'worktree_write_exclusive',
  git_public_metadata: 'git_public_metadata_short',
};

export const FEATURE_RESOURCE_ACCESS_MODES = ['exclusive', 'shared'] as const;
export type FeatureResourceAccessMode = (typeof FEATURE_RESOURCE_ACCESS_MODES)[number];
export const FEATURE_RESOURCE_LEASE_MODES = ['lease', 'short'] as const;
export type FeatureResourceLeaseMode = (typeof FEATURE_RESOURCE_LEASE_MODES)[number];

/** This order is the single lock order for every multi-resource acquisition. */
export const FEATURE_RESOURCE_KIND_ORDER = [
  'planning_exclusive',
  'feature_code_shared',
  'migration',
  'contract',
  'worktree_write_exclusive',
  'git_public_metadata_short',
] as const satisfies readonly FeatureResourceKind[];

const RESOURCE_SEMANTICS: Readonly<Record<FeatureResourceKind, {
  readonly accessMode: FeatureResourceAccessMode;
  readonly leaseMode: FeatureResourceLeaseMode;
}>> = {
  planning_exclusive: { accessMode: 'exclusive', leaseMode: 'lease' },
  feature_code_shared: { accessMode: 'shared', leaseMode: 'lease' },
  worktree_write_exclusive: { accessMode: 'exclusive', leaseMode: 'lease' },
  git_public_metadata_short: { accessMode: 'exclusive', leaseMode: 'short' },
  migration: { accessMode: 'exclusive', leaseMode: 'lease' },
  contract: { accessMode: 'exclusive', leaseMode: 'lease' },
};

export interface FeatureResourceDeclaration {
  readonly projectId: string;
  readonly kind: FeatureResourceKind;
  /** Canonical key, always rooted at the current project. */
  readonly key: string;
  readonly accessMode: FeatureResourceAccessMode;
  readonly leaseMode: FeatureResourceLeaseMode;
}

export interface FeatureResourceSet {
  readonly schemaVersion: typeof FEATURE_RESOURCE_SCHEMA_VERSION;
  readonly projectId: string;
  /** Deduplicated and sorted using the global lock order. */
  readonly resources: readonly FeatureResourceDeclaration[];
}

/**
 * The immutable resource set admitted immediately before a Run/Attempt claim.
 * Batch snapshots are intentionally accepted as unknown here: this is the final
 * Core boundary where scope and resource declarations are rechecked inside the
 * claim transaction, rather than trusting a scheduler's earlier read.
 */
export interface FeatureDispatchResourceSetInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly purpose: 'plan' | 'code';
  readonly batch: {
    readonly scopeSnapshot: unknown;
    readonly configSnapshot: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaredResourceItems(configSnapshot: unknown, featureId: string): readonly unknown[] {
  if (!isRecord(configSnapshot)) {
    throw new StorageError('corrupt', `${OPERATION}.deriveDispatchSet`, 'Batch config snapshot 不是对象');
  }
  const candidates = ['resourceSet', 'resourceDeclarations', 'featureResources', 'resourcesByFeature', 'resources'] as const;
  for (const name of candidates) {
    if (!(name in configSnapshot)) continue;
    const value = configSnapshot[name];
    if (name === 'resources' && Array.isArray(value)
      && !value.some(item => isRecord(item) && ('key' in item || FEATURE_RESOURCE_KINDS.includes(item.kind as FeatureResourceKind)
        || Object.keys(RESOURCE_KIND_ALIASES).includes(String(item.kind))))) {
      // Existing runtime/access snapshots also use a `resources` field. They are
      // unrelated to Feature resource declarations and must not be interpreted as
      // locks merely because the JSON field has the same generic name.
      return [];
    }
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) {
      throw new StorageError('validation', `${OPERATION}.deriveDispatchSet`, `${name} 必须是资源数组或按 Feature 分组的对象`, {
        details: { field: name },
      });
    }
    const grouped = isRecord(value.byFeature) ? value.byFeature : value;
    const selected = grouped[featureId];
    if (selected !== undefined) {
      if (!Array.isArray(selected)) {
        throw new StorageError('validation', `${OPERATION}.deriveDispatchSet`, 'Feature 资源声明必须是数组', {
          details: { field: `${name}.${featureId}` },
        });
      }
      return selected;
    }
    if (Array.isArray(value.resources)) return value.resources;
    throw new StorageError('validation', `${OPERATION}.deriveDispatchSet`, 'Batch 资源声明缺少当前 Feature 分组', {
      details: { field: name, featureId },
    });
  }
  return [];
}

/**
 * Derive the resource set for one dispatch consumer. The mandatory defaults are
 * Core-owned: planning is project-exclusive; coding shares the project Feature
 * gate but always owns its Feature worktree exclusively. Additional migration or
 * contract declarations come only from the fixed Batch snapshot.
 */
export function deriveFeatureDispatchResourceSet(input: FeatureDispatchResourceSetInput): FeatureResourceSet {
  const context = { operation: `${OPERATION}.deriveDispatchSet` } as const;
  const projectId = validateStableId(input.projectId, context, 'projectId');
  const featureId = validateStableId(input.featureId, context, 'featureId');
  if (input.purpose !== 'plan' && input.purpose !== 'code') {
    throw validationError(context, 'purpose', '必须是 plan 或 code', input.purpose);
  }
  if (!isRecord(input.batch)) {
    throw validationError(context, 'batch', '必须是对象', input.batch);
  }
  const scope = requirePlainObject(input.batch.scopeSnapshot, context, 'batch.scopeSnapshot');
  const featureIds = scope.featureIds;
  if (!Array.isArray(featureIds) || !featureIds.some(candidate => candidate === featureId)) {
    throw new StorageError('conflict', `${OPERATION}.deriveDispatchSet`, 'Feature 不属于批准 Batch 固定范围', {
      entity: { type: 'feature', projectId, id: featureId },
      details: { reason: 'feature_outside_batch_scope', featureId },
    });
  }
  for (const [index, candidate] of featureIds.entries()) validateStableId(candidate, context, `batch.scopeSnapshot.featureIds[${index}]`);

  const mandatory = input.purpose === 'plan'
    ? [{ kind: 'planning_exclusive', key: 'planning' }]
    : [
      { kind: 'feature_code_shared', key: 'feature-code' },
      { kind: 'worktree_write_exclusive', key: `worktree:${featureId}` },
    ];
  const declarations = [...mandatory, ...declaredResourceItems(input.batch.configSnapshot, featureId).map(item => {
    if (!isRecord(item)) return item;
    // accessMode/leaseMode are derived semantics. Accept a persisted normalized
    // declaration, but never trust either field to change the kind's meaning.
    const { accessMode: _accessMode, leaseMode: _leaseMode, ...declaration } = item;
    return declaration;
  })];
  return normalizeFeatureResourceSet({ projectId, resources: declarations });
}

export const FEATURE_RESOURCE_WAIT_REASONS = [
  'resource_occupied',
  'resource_quarantined',
  'lease_expired_unverified',
] as const;
export type FeatureResourceWaitReasonCode = (typeof FEATURE_RESOURCE_WAIT_REASONS)[number];

export interface FeatureResourceWaitReason {
  readonly code: FeatureResourceWaitReasonCode;
  readonly resourceKey: string;
  readonly blockingOwnerId: string | null;
  readonly blockingOwnerVersion: number | null;
}

export const FEATURE_RESOURCE_LEASE_STATES = ['held', 'quarantined', 'released'] as const;
export type FeatureResourceLeaseState = (typeof FEATURE_RESOURCE_LEASE_STATES)[number];

export interface FeatureResourceLeaseRecord {
  readonly id: string;
  readonly projectId: string;
  readonly resource: FeatureResourceDeclaration;
  /** Durable owner identity. A later owner must use a new record. */
  readonly ownerId: string;
  /** Monotonic owner/fencing version, separate from Attempt executionVersion. */
  readonly ownerVersion: number;
  /** CAS revision for this lease row. */
  readonly revision: number;
  readonly acquiredAtUtcMs: number;
  readonly leaseUntilUtcMs: number;
  readonly state: FeatureResourceLeaseState;
  /** Structured reason returned to a waiter; never free-form blocking text. */
  readonly waitingReason: FeatureResourceWaitReason | null;
  readonly releasedAtUtcMs: number | null;
}

export interface FeatureResourceOwner {
  readonly ownerId: string;
  readonly ownerVersion: number;
}

export interface FeatureResourceAcquireInput {
  readonly resourceSet: FeatureResourceSet;
  readonly owner: FeatureResourceOwner;
  readonly leaseUntilUtcMs: number;
}

const ACQUIRE_KEYS = ['resourceSet', 'owner', 'leaseUntilUtcMs'] as const;

/** Validate the complete immutable input admitted by the SQLite claim primitive. */
export function validateFeatureResourceAcquireInput(value: unknown): FeatureResourceAcquireInput {
  const ctx = context('validateAcquire', 'feature_resource_lease');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ACQUIRE_KEYS, ctx, 'input');
  const resourceSet = normalizeFeatureResourceSet(raw.resourceSet);
  const owner = validateFeatureResourceOwner(raw.owner);
  const leaseUntilUtcMs = validateNonNegativeInteger(raw.leaseUntilUtcMs, ctx, 'leaseUntilUtcMs');
  return { resourceSet, owner, leaseUntilUtcMs };
}

/** Narrow read input; a read is always scoped to one canonical project resource. */
export function validateFeatureResourceReadInput(value: unknown): FeatureResourceDeclaration {
  return validateFeatureResourceDeclaration(value);
}

/** Narrow storage port reserved for F-002+ adapters; this file provides no implementation. */
export interface FeatureResourceAccess {
  normalize(input: unknown): FeatureResourceSet;
  read(resource: unknown): readonly FeatureResourceLeaseRecord[];
  /** List all resource rows owned by one dispatch generation inside its write transaction. */
  listOwnerInTransaction(projectId: unknown, owner: unknown): readonly FeatureResourceLeaseRecord[];
  acquireInTransaction(input: unknown): readonly FeatureResourceLeaseRecord[];
  renewInTransaction(owner: unknown, resource: unknown, leaseUntilUtcMs: unknown): FeatureResourceLeaseRecord;
  /** Normal release: released is idempotent; held must be unexpired and quarantined is rejected. */
  releaseInTransaction(owner: unknown, resource: unknown): FeatureResourceLeaseRecord;
  /** Release every lease of one owner in the canonical resource order. */
  releaseOwnerInTransaction(projectId: unknown, owner: unknown): readonly FeatureResourceLeaseRecord[];
  /** Renew every lease of one owner or quarantine the whole group when any lease is stale. */
  renewOwnerInTransaction(projectId: unknown, owner: unknown, leaseUntilUtcMs: unknown): readonly FeatureResourceLeaseRecord[];
  /** Trusted stop/recovery release; permits an expired or quarantined row only after external evidence. */
  releaseOwnerAfterStopInTransaction(projectId: unknown, owner: unknown): readonly FeatureResourceLeaseRecord[];
  /** Quarantine every held lease of one owner. */
  quarantineOwnerInTransaction(projectId: unknown, owner: unknown, reason: unknown): readonly FeatureResourceLeaseRecord[];
  quarantineInTransaction(owner: unknown, resource: unknown, waitingReason: unknown): FeatureResourceLeaseRecord;
}

const OPERATION = 'FeatureResources';
const DECLARATION_KEYS = ['projectId', 'kind', 'key'] as const;
const SET_KEYS = ['schemaVersion', 'projectId', 'resources'] as const;
const OWNER_KEYS = ['ownerId', 'ownerVersion'] as const;
const WAIT_REASON_KEYS = ['code', 'resourceKey', 'blockingOwnerId', 'blockingOwnerVersion'] as const;
const LEASE_KEYS = [
  'id', 'projectId', 'resource', 'ownerId', 'ownerVersion', 'revision',
  'acquiredAtUtcMs', 'leaseUntilUtcMs', 'state', 'waitingReason', 'releasedAtUtcMs',
] as const;
const MAX_RESOURCE_SET_SIZE = 128;
const MAX_RESOURCE_KEY_LENGTH = 256;
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESOURCE_KEY_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

function context(operation: string, entityType: StorageEntityType = 'project'): ValidationContext {
  return { operation: `${OPERATION}.${operation}`, entity: { type: entityType } };
}

function fail(
  operation: string,
  kind: 'conflict' | 'ownership' | 'validation',
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new StorageError(kind, `${OPERATION}.${operation}`, message, {
    entity: { type: 'project' },
    details,
  });
}

function canonicalKind(value: unknown, ctx: ValidationContext): FeatureResourceKind {
  if (typeof value !== 'string') {
    throw validationError(ctx, 'kind', `必须是 ${FEATURE_RESOURCE_KINDS.join('|')} 之一`, value);
  }
  const kind = RESOURCE_KIND_ALIASES[value] ?? value;
  if (!(FEATURE_RESOURCE_KINDS as readonly string[]).includes(kind)) {
    throw validationError(ctx, 'kind', `必须是 ${FEATURE_RESOURCE_KINDS.join('|')} 之一`, value);
  }
  return kind as FeatureResourceKind;
}

function validateResourceName(value: string, ctx: ValidationContext, field: string): string {
  if (!RESOURCE_NAME_PATTERN.test(value)) {
    throw validationError(ctx, field, '必须是 1-64 位字母数字、点、下划线或短横线组成的名称', value);
  }
  return value;
}

function canonicalResourceKey(
  projectId: string,
  kind: FeatureResourceKind,
  rawKey: unknown,
  ctx: ValidationContext,
): string {
  const key = requireNonEmptyString(rawKey, ctx, 'key').trim();
  if (key.length > MAX_RESOURCE_KEY_LENGTH || !RESOURCE_KEY_PATTERN.test(key)) {
    throw validationError(ctx, 'key', '必须是有界且不含空白/控制字符的资源键', rawKey);
  }

  const prefix = `project:${projectId}:`;
  let suffix = key;
  if (key.startsWith('project:')) {
    if (!key.startsWith(prefix)) {
      throw new StorageError('ownership', ctx.operation, `${ctx.operation}: key 引用了其他项目`, {
        entity: { type: 'project', projectId },
        details: { field: 'key', reason: 'cross_project_resource' },
      });
    }
    suffix = key.slice(prefix.length);
  } else if (key.startsWith('global:') || key === 'workspace' || key.includes(':work')) {
    throw validationError(ctx, 'key', '不能使用执行槽位或 Attempt 工作区租约资源', rawKey);
  }

  let canonicalSuffix: string;
  switch (kind) {
    case 'planning_exclusive':
      if (suffix !== 'planning') throw validationError(ctx, 'key', '规划资源键必须是 project:<id>:planning', rawKey);
      canonicalSuffix = suffix;
      break;
    case 'feature_code_shared':
      if (suffix !== 'feature-code') throw validationError(ctx, 'key', 'Feature 编码门控键必须是 project:<id>:feature-code', rawKey);
      canonicalSuffix = suffix;
      break;
    case 'worktree_write_exclusive': {
      const featureId = suffix.startsWith('worktree:') ? suffix.slice('worktree:'.length) : '';
      canonicalSuffix = `worktree:${validateResourceName(featureId, ctx, 'key')}`;
      break;
    }
    case 'git_public_metadata_short':
      if (suffix !== 'git-public-metadata') {
        throw validationError(ctx, 'key', 'Git 公共元数据键必须是 project:<id>:git-public-metadata', rawKey);
      }
      canonicalSuffix = suffix;
      break;
    case 'migration':
    case 'contract': {
      const label = `${kind}:`;
      if (!suffix.startsWith(label)) throw validationError(ctx, 'key', `声明资源键必须是 project:<id>:${kind}:<name>`, rawKey);
      canonicalSuffix = `${label}${validateResourceName(suffix.slice(label.length), ctx, 'key')}`;
      break;
    }
  }
  return `${prefix}${canonicalSuffix}`;
}

/** Validate one JSON declaration and normalize its key and semantic mode. */
export function validateFeatureResourceDeclaration(
  value: unknown,
  expectedProjectId?: string,
): FeatureResourceDeclaration {
  const ctx = context('validateDeclaration');
  const raw = requirePlainObject(value, ctx, 'resource');
  rejectUnknownKeys(raw, DECLARATION_KEYS, ctx, 'resource');
  const projectId = validateStableId(raw.projectId, ctx, 'projectId');
  if (expectedProjectId !== undefined) {
    const expected = validateStableId(expectedProjectId, ctx, 'expectedProjectId');
    if (projectId !== expected) {
      throw new StorageError('ownership', ctx.operation, `${ctx.operation}: resource 不属于当前项目`, {
        entity: { type: 'project', projectId: expected },
        details: { field: 'projectId', reason: 'cross_project_resource' },
      });
    }
  }
  const kind = canonicalKind(raw.kind, ctx);
  const key = canonicalResourceKey(projectId, kind, raw.key, ctx);
  return { projectId, kind, key, ...RESOURCE_SEMANTICS[kind] };
}

/** Normalize a declaration key without introducing a storage dependency. */
export function normalizeFeatureResourceKey(
  value: unknown,
  expectedProjectId?: string,
): string {
  return validateFeatureResourceDeclaration(value, expectedProjectId).key;
}

function compareDeclarations(a: FeatureResourceDeclaration, b: FeatureResourceDeclaration): number {
  const kindOrder = FEATURE_RESOURCE_KIND_ORDER.indexOf(a.kind) - FEATURE_RESOURCE_KIND_ORDER.indexOf(b.kind);
  return kindOrder !== 0 ? kindOrder : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Validate, deduplicate and sort a complete resource collection deterministically. */
export function normalizeFeatureResourceSet(value: unknown): FeatureResourceSet {
  const ctx = context('normalizeSet');
  const raw = requirePlainObject(value, ctx, 'resourceSet');
  rejectUnknownKeys(raw, SET_KEYS, ctx, 'resourceSet');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== FEATURE_RESOURCE_SCHEMA_VERSION) {
    throw validationError(ctx, 'schemaVersion', `必须是 ${FEATURE_RESOURCE_SCHEMA_VERSION}`, raw.schemaVersion);
  }
  const projectId = validateStableId(raw.projectId, ctx, 'projectId');
  if (!Array.isArray(raw.resources) || raw.resources.length > MAX_RESOURCE_SET_SIZE) {
    throw validationError(ctx, 'resources', `必须是最多 ${MAX_RESOURCE_SET_SIZE} 项的数组`, raw.resources);
  }
  const unique = new Map<string, FeatureResourceDeclaration>();
  for (const item of raw.resources) {
    // A set is already scoped by its project; declarations may omit the repeated
    // projectId, while an explicit different project remains a cross-project error.
    const declarationInput = requirePlainObject(item, ctx, 'resources[]');
    const { accessMode, leaseMode, ...rawDeclaration } = declarationInput;
    const declaration = validateFeatureResourceDeclaration(
      { projectId, ...rawDeclaration },
      projectId,
    );
    if ((accessMode !== undefined && accessMode !== declaration.accessMode)
      || (leaseMode !== undefined && leaseMode !== declaration.leaseMode)) {
      throw validationError(ctx, 'resources[]', '资源占用语义不能由声明输入改写', item);
    }
    const previous = unique.get(declaration.key);
    if (previous !== undefined && previous.kind !== declaration.kind) {
      fail('normalizeSet', 'validation', '同一资源键不能对应多个资源类别', { resourceKey: declaration.key });
    }
    unique.set(declaration.key, declaration);
  }
  return {
    schemaVersion: FEATURE_RESOURCE_SCHEMA_VERSION,
    projectId,
    resources: [...unique.values()].sort(compareDeclarations),
  };
}

export function validateFeatureResourceSet(value: unknown): FeatureResourceSet {
  return normalizeFeatureResourceSet(value);
}

function validateWaitReason(value: unknown, resourceKey: string, ctx: ValidationContext): FeatureResourceWaitReason {
  const raw = requirePlainObject(value, ctx, 'waitingReason');
  rejectUnknownKeys(raw, WAIT_REASON_KEYS, ctx, 'waitingReason');
  if (typeof raw.code !== 'string' || !(FEATURE_RESOURCE_WAIT_REASONS as readonly string[]).includes(raw.code)) {
    throw validationError(ctx, 'waitingReason.code', `必须是 ${FEATURE_RESOURCE_WAIT_REASONS.join('|')} 之一`, raw.code);
  }
  const key = requireNonEmptyString(raw.resourceKey, ctx, 'waitingReason.resourceKey');
  if (key !== resourceKey) throw validationError(ctx, 'waitingReason.resourceKey', '必须与租约资源键一致', raw.resourceKey);
  const blockingOwnerId = raw.blockingOwnerId === null
    ? null
    : validateStableId(raw.blockingOwnerId, ctx, 'waitingReason.blockingOwnerId');
  const blockingOwnerVersion = raw.blockingOwnerVersion === null
    ? null
    : validatePositiveInteger(raw.blockingOwnerVersion, ctx, 'waitingReason.blockingOwnerVersion');
  if ((blockingOwnerId === null) !== (blockingOwnerVersion === null)) {
    throw validationError(ctx, 'waitingReason', 'blockingOwnerId 与 blockingOwnerVersion 必须同时为空或同时存在');
  }
  return { code: raw.code as FeatureResourceWaitReasonCode, resourceKey: key, blockingOwnerId, blockingOwnerVersion };
}

/** Validate the durable lease shape used by F-002 adapters. */
export function validateFeatureResourceLeaseRecord(value: unknown): FeatureResourceLeaseRecord {
  const ctx = context('validateLease', 'feature_resource_lease');
  const raw = requirePlainObject(value, ctx, 'lease');
  rejectUnknownKeys(raw, LEASE_KEYS, ctx, 'lease');
  const id = validateStableId(raw.id, ctx, 'id');
  const projectId = validateStableId(raw.projectId, ctx, 'projectId');
  const resourceInput = requirePlainObject(raw.resource, ctx, 'resource');
  rejectUnknownKeys(resourceInput, [...DECLARATION_KEYS, 'accessMode', 'leaseMode'], ctx, 'resource');
  const resource = validateFeatureResourceDeclaration({
    projectId: resourceInput.projectId ?? projectId,
    kind: resourceInput.kind,
    key: resourceInput.key,
  }, projectId);
  if ((resourceInput.accessMode !== undefined && resourceInput.accessMode !== resource.accessMode)
    || (resourceInput.leaseMode !== undefined && resourceInput.leaseMode !== resource.leaseMode)) {
    throw validationError(ctx, 'resource', '资源占用语义不能由记录输入改写');
  }
  const ownerId = validateStableId(raw.ownerId, ctx, 'ownerId');
  const ownerVersion = validatePositiveInteger(raw.ownerVersion, ctx, 'ownerVersion');
  const revision = validatePositiveInteger(raw.revision, ctx, 'revision');
  const acquiredAtUtcMs = validateNonNegativeInteger(raw.acquiredAtUtcMs, ctx, 'acquiredAtUtcMs');
  const leaseUntilUtcMs = validateNonNegativeInteger(raw.leaseUntilUtcMs, ctx, 'leaseUntilUtcMs');
  if (leaseUntilUtcMs < acquiredAtUtcMs) throw validationError(ctx, 'leaseUntilUtcMs', '不得早于 acquiredAtUtcMs');
  if (typeof raw.state !== 'string' || !(FEATURE_RESOURCE_LEASE_STATES as readonly string[]).includes(raw.state)) {
    throw validationError(ctx, 'state', `必须是 ${FEATURE_RESOURCE_LEASE_STATES.join('|')} 之一`, raw.state);
  }
  const state = raw.state as FeatureResourceLeaseState;
  const waitingReason = raw.waitingReason === null
    ? null
    : validateWaitReason(raw.waitingReason, resource.key, ctx);
  const releasedAtUtcMs = raw.releasedAtUtcMs === null
    ? null
    : validateNonNegativeInteger(raw.releasedAtUtcMs, ctx, 'releasedAtUtcMs');
  if (state === 'held' && (waitingReason !== null || releasedAtUtcMs !== null)) {
    throw validationError(ctx, 'lease', 'held 租约不能带 waitingReason 或 releasedAtUtcMs');
  }
  if (state === 'quarantined' && (waitingReason === null || releasedAtUtcMs !== null)) {
    throw validationError(ctx, 'lease', 'quarantined 租约必须带 waitingReason 且不能带 releasedAtUtcMs');
  }
  if (state === 'released' && releasedAtUtcMs === null) {
    throw validationError(ctx, 'releasedAtUtcMs', 'released 租约必须记录释放时刻');
  }
  return {
    id, projectId, resource, ownerId, ownerVersion, revision,
    acquiredAtUtcMs, leaseUntilUtcMs, state, waitingReason, releasedAtUtcMs,
  };
}

export function validateFeatureResourceOwner(value: unknown): FeatureResourceOwner {
  const ctx = context('validateOwner', 'feature_resource_lease');
  const raw = requirePlainObject(value, ctx, 'owner');
  rejectUnknownKeys(raw, OWNER_KEYS, ctx, 'owner');
  return {
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    ownerVersion: validatePositiveInteger(raw.ownerVersion, ctx, 'ownerVersion'),
  };
}

/** Fencing check used before every lease mutation. */
export function assertFeatureResourceLeaseOwner(
  record: FeatureResourceLeaseRecord,
  owner: unknown,
): void {
  const current = validateFeatureResourceLeaseRecord(record);
  const expected = validateFeatureResourceOwner(owner);
  if (current.ownerId !== expected.ownerId || current.ownerVersion !== expected.ownerVersion) {
    throw new StorageError('ownership', `${OPERATION}.assertOwner`, '旧 owner/version 不能修改当前资源租约', {
      entity: { type: 'workspace', id: current.id, projectId: current.projectId },
      details: { reason: 'resource_owner_fenced', resourceKey: current.resource.key },
    });
  }
}

/** Pure CAS/state-transition guard; storage adapters still perform the atomic write. */
export function assertFeatureResourceLeaseTransition(
  previous: FeatureResourceLeaseRecord,
  next: FeatureResourceLeaseRecord,
): void {
  const before = validateFeatureResourceLeaseRecord(previous);
  const after = validateFeatureResourceLeaseRecord(next);
  if (before.id !== after.id || before.projectId !== after.projectId || before.resource.key !== after.resource.key
    || before.ownerId !== after.ownerId || before.ownerVersion !== after.ownerVersion) {
    fail('assertTransition', 'ownership', '资源租约身份不可变，旧 owner/version 不能修改新 owner 的租约', {
      resourceKey: before.resource.key,
    });
  }
  if (after.revision !== before.revision + 1) {
    throw validationError(context('assertTransition', 'feature_resource_lease'), 'revision', '必须严格递增一代', after.revision);
  }
  if (after.acquiredAtUtcMs !== before.acquiredAtUtcMs || after.leaseUntilUtcMs < before.leaseUntilUtcMs) {
    throw validationError(context('assertTransition', 'feature_resource_lease'), 'lease', '获得时刻不可变且租约不得缩短');
  }
  if (before.state === 'released' && after.state !== 'released') {
    fail('assertTransition', 'conflict', 'released 租约是终态，不能复活');
  }
  if (before.state === 'quarantined' && after.state === 'held') {
    fail('assertTransition', 'conflict', 'quarantined 租约不能未经核对恢复为 held');
  }
}
