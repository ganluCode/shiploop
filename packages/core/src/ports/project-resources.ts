/**
 * P06-3 / F-001：项目 Skills/MCP 资源的版本化纯数据契约。
 *
 * 本端口只校验、规范化和摘要资源声明；不扫描目录、不解析凭据、不加载
 * Skill/MCP，也不替代 P04 WorkAccess 的 Attempt 授权。项目选择的 revision
 * 是配置 CAS/输入快照事实，WorkAccessBinding 仍是执行身份的唯一来源。
 */
import { createHash } from 'node:crypto';
import { WORK_ACCESS_OPERATIONS } from './work-access-operations.js';
import type {
  WorkAccessBinding, WorkAccessCapability, WorkAccessConfiguration, WorkAccessResource,
} from './work-access.js';
import type { WorkResourceLoadPlan } from './work-resource-selection.js';
import { stableStringify } from './feature-plan.js';

export const PROJECT_RESOURCE_SCHEMA_VERSION = 1 as const;
export const PROJECT_RESOURCE_DIGEST_DOMAIN = 'shiploop:project-resources:v1';
export const PROJECT_RESOURCE_IDENTITY_DOMAIN = 'shiploop:project-resource-identity:v1';
export const PROJECT_RESOURCE_MAX_RESOURCES = 64;
export const PROJECT_RESOURCE_MAX_CAPABILITIES = 16;
export const PROJECT_RESOURCE_MAX_OPERATIONS = WORK_ACCESS_OPERATIONS.length;

export const PROJECT_RESOURCE_KINDS = ['skill', 'mcp', 'auth_plugin'] as const;
export type ProjectResourceKind = (typeof PROJECT_RESOURCE_KINDS)[number];
export const PROJECT_RESOURCE_TRANSPORTS = ['stdio', 'streamable_http'] as const;
export type ProjectResourceTransport = (typeof PROJECT_RESOURCE_TRANSPORTS)[number];
export const PROJECT_RESOURCE_PUBLIC_OPERATIONS = WORK_ACCESS_OPERATIONS;
export type ProjectResourcePublicOperation = (typeof PROJECT_RESOURCE_PUBLIC_OPERATIONS)[number];

export const PROJECT_RESOURCE_REASONS = [
  'invalid_shape',
  'unknown_key',
  'unsupported_schema_version',
  'unknown_resource',
  'unknown_transport',
  'unknown_operation',
  'forbidden_operation',
  'duplicate_identity',
  'invalid_reference',
  'cross_project_reference',
  'identity_mismatch',
  'invalid_value',
  'invalid_digest',
  'path_field',
  'plaintext_credential',
  'limit_exceeded',
  'missing_approved_resource',
  'unexpected_resource',
  'resource_identity_mismatch',
  'unapproved_capability',
  'required_unavailable',
  'required_capability_missing',
  'actual_load_mismatch',
] as const;
export type ProjectResourceReason = (typeof PROJECT_RESOURCE_REASONS)[number];

export class ProjectResourceError extends Error {
  readonly reason: ProjectResourceReason;
  readonly details: Readonly<{ reason: ProjectResourceReason }>;

  constructor(reason: ProjectResourceReason) {
    super(`Project resource rejected: ${reason}`);
    this.name = 'ProjectResourceError';
    this.reason = reason;
    this.details = Object.freeze({ reason });
  }
}

export interface ProjectResourceDescriptor {
  readonly id: string;
  readonly projectId: string;
  readonly sourceProjectId: string;
  readonly kind: ProjectResourceKind;
  readonly name: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly version: string | null;
  readonly contentDigest: string | null;
  readonly transport: ProjectResourceTransport | null;
  readonly capabilities: readonly WorkAccessCapability[];
  readonly credentialRef: string | null;
  readonly required: boolean;
  readonly onUnavailable: 'reject' | 'omit';
}

export interface ProjectResourceSummary {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ProjectResourceKind;
  readonly name: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly version: string | null;
  readonly contentDigest: string | null;
  readonly transport: ProjectResourceTransport | null;
  readonly capabilities: readonly WorkAccessCapability[];
  readonly credentialConfigured: boolean;
  readonly required: boolean;
  readonly onUnavailable: 'reject' | 'omit';
}

export interface ProjectResourceCandidate extends ProjectResourceDescriptor {
  readonly schemaVersion: typeof PROJECT_RESOURCE_SCHEMA_VERSION;
  readonly state: 'candidate';
  readonly summary: ProjectResourceSummary;
  readonly digest: string;
}

export interface ProjectResourceAuthorization {
  readonly resourceIds: readonly string[];
  readonly operations: readonly ProjectResourcePublicOperation[];
}

export interface ProjectResourceSelection {
  readonly schemaVersion: typeof PROJECT_RESOURCE_SCHEMA_VERSION;
  readonly state: 'selected';
  readonly projectId: string;
  /** Project configuration CAS revision; it is not an Attempt executionVersion. */
  readonly revision: number;
  readonly resources: readonly ProjectResourceDescriptor[];
  readonly operations: readonly ProjectResourcePublicOperation[];
  readonly authorization: ProjectResourceAuthorization;
  readonly allowGlobalScan: false;
  readonly allowProjectDirectoryScan: false;
  readonly allowSdkDefaultScan: false;
  readonly digest: string;
}

export interface ProjectResourceLoadPlanEntry extends ProjectResourceDescriptor {}

export interface ProjectResourceLoadPlan {
  readonly schemaVersion: typeof PROJECT_RESOURCE_SCHEMA_VERSION;
  readonly state: 'selected';
  readonly projectId: string;
  readonly selectionRevision: number;
  readonly selectedResourceIds: readonly string[];
  readonly resources: readonly ProjectResourceLoadPlanEntry[];
  readonly allowGlobalScan: false;
  readonly allowProjectDirectoryScan: false;
  readonly allowSdkDefaultScan: false;
  readonly digest: string;
}

export interface ProjectResourceLoadObservation extends ProjectResourceDescriptor {
  readonly status: 'available' | 'unavailable';
  readonly unavailableReason: 'unsupported' | 'unverified' | null;
  readonly loadedCapabilities: readonly WorkAccessCapability[];
}

export interface ProjectResourceLoadManifestEntry extends ProjectResourceDescriptor {
  readonly status: 'available' | 'omitted';
  readonly unavailableReason: 'unsupported' | 'unverified' | null;
  readonly loadedCapabilities: readonly WorkAccessCapability[];
}

export interface ProjectResourceCapabilityGap {
  readonly resourceId: string;
  readonly capability: WorkAccessCapability;
  readonly reason: 'unsupported' | 'unverified';
}

export interface ProjectResourceLoadManifest {
  readonly schemaVersion: typeof PROJECT_RESOURCE_SCHEMA_VERSION;
  readonly state: 'loaded';
  readonly projectId: string;
  readonly selectionRevision: number;
  readonly resources: readonly ProjectResourceLoadManifestEntry[];
  readonly gaps: readonly ProjectResourceCapabilityGap[];
  readonly digest: string;
}

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/;
const SAFE_NAME = /^[^/\\~\0-\x1f\x7f]{1,128}$/;
const RESOURCE_KEYS = [
  'id', 'projectId', 'sourceProjectId', 'kind', 'name', 'sourceRef', 'sourceRevision', 'version',
  'contentDigest', 'transport', 'capabilities', 'credentialRef', 'required', 'onUnavailable',
] as const;

function reject(reason: ProjectResourceReason): never {
  throw new ProjectResourceError(reason);
}

function plainObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_shape');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject('invalid_shape');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) reject('unknown_key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject('invalid_shape');
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) reject('invalid_reference');
  return value;
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || value.includes('..')) reject('invalid_value');
  return value;
}

function safeName(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_NAME.test(value) || value.trim() !== value) reject('path_field');
  return value;
}

function safeCredentialRef(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !TOKEN.test(value) || value.includes('..')) reject('plaintext_credential');
  if (/^(?:sk-|gh[pousr]_|eyJ|bearer\b|token\b|secret\b|key\b)/i.test(value)) reject('plaintext_credential');
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject('invalid_value');
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) reject('invalid_digest');
  return value;
}

function capability(value: unknown): WorkAccessCapability {
  const allowed: readonly WorkAccessCapability[] = [
    'resource_selection', 'tool_interception', 'mcp_stdio', 'mcp_streamable_http', 'auth_plugin',
  ];
  if (typeof value !== 'string' || !allowed.includes(value as WorkAccessCapability)) reject('invalid_value');
  return value as WorkAccessCapability;
}

function capabilities(value: unknown): WorkAccessCapability[] {
  if (!Array.isArray(value)) reject('invalid_shape');
  if (value.length > PROJECT_RESOURCE_MAX_CAPABILITIES) reject('limit_exceeded');
  const result = value.map(capability);
  if (new Set(result).size !== result.length) reject('duplicate_identity');
  return result.sort();
}

function canonicalIdentity(value: {
  readonly projectId: string;
  readonly sourceProjectId: string;
  readonly kind: ProjectResourceKind;
  readonly name: string;
  readonly sourceRef: string;
}): string {
  return stableStringify({
    projectId: value.projectId,
    sourceProjectId: value.sourceProjectId,
    kind: value.kind,
    name: value.name,
    sourceRef: value.sourceRef,
  });
}

/** Deterministic UUID-shaped identity compatible with WorkAccessResource.id. */
export function deriveProjectResourceIdentity(value: unknown): string {
  const raw = plainObject(value, RESOURCE_KEYS);
  const projectId = uuid(raw.projectId);
  const sourceProjectId = uuid(raw.sourceProjectId);
  if (projectId !== sourceProjectId) reject('cross_project_reference');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !PROJECT_RESOURCE_KINDS.includes(kind as ProjectResourceKind)) reject('unknown_resource');
  const name = safeName(raw.name);
  const sourceRef = uuid(raw.sourceRef);
  const bytes = createHash('sha256')
    .update(`${PROJECT_RESOURCE_IDENTITY_DOMAIN}\n${canonicalIdentity({
      projectId, sourceProjectId, kind: kind as ProjectResourceKind, name, sourceRef,
    })}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const projectResourceIdentity = deriveProjectResourceIdentity;

function resourceFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, value[key]]));
}

function parseResource(value: unknown, expectedProjectId?: string): ProjectResourceDescriptor {
  const raw = plainObject(value, RESOURCE_KEYS);
  const projectId = uuid(raw.projectId);
  const sourceProjectId = uuid(raw.sourceProjectId);
  if (projectId !== sourceProjectId) reject('cross_project_reference');
  if (expectedProjectId !== undefined && projectId !== expectedProjectId) reject('cross_project_reference');
  const kindValue = raw.kind;
  if (typeof kindValue !== 'string' || !PROJECT_RESOURCE_KINDS.includes(kindValue as ProjectResourceKind)) reject('unknown_resource');
  const kind = kindValue as ProjectResourceKind;
  const name = safeName(raw.name);
  const sourceRef = uuid(raw.sourceRef);
  const sourceRevision = token(raw.sourceRevision);
  const version = raw.version === null ? null : token(raw.version);
  const contentDigest = raw.contentDigest === null ? null : digest(raw.contentDigest);
  if (version === null && contentDigest === null) reject('invalid_value');
  const transport = raw.transport === null ? null : (() => {
    if (typeof raw.transport !== 'string' || !PROJECT_RESOURCE_TRANSPORTS.includes(raw.transport as ProjectResourceTransport)) reject('unknown_transport');
    return raw.transport as ProjectResourceTransport;
  })();
  if ((kind === 'mcp') !== (transport !== null)) reject('invalid_value');
  const parsedCapabilities = capabilities(raw.capabilities);
  if (kind === 'mcp') {
    const requiredCapability = transport === 'stdio' ? 'mcp_stdio' : 'mcp_streamable_http';
    if (!parsedCapabilities.includes(requiredCapability)) reject('invalid_value');
  }
  if (kind === 'auth_plugin' && !parsedCapabilities.includes('auth_plugin')) reject('invalid_value');
  if (typeof raw.required !== 'boolean') reject('invalid_value');
  if (raw.onUnavailable !== 'reject' && raw.onUnavailable !== 'omit') reject('invalid_value');
  const onUnavailable = raw.onUnavailable as 'reject' | 'omit';
  if (raw.required && onUnavailable !== 'reject') reject('invalid_value');
  const credentialRef = safeCredentialRef(raw.credentialRef);
  const id = deriveProjectResourceIdentity({ projectId, sourceProjectId, kind, name, sourceRef });
  if (raw.id !== undefined && raw.id !== id) reject('identity_mismatch');
  return {
    id, projectId, sourceProjectId, kind, name, sourceRef, sourceRevision, version, contentDigest,
    transport, capabilities: parsedCapabilities, credentialRef, required: raw.required, onUnavailable,
  };
}

function resourceSummary(resource: ProjectResourceDescriptor): ProjectResourceSummary {
  return {
    id: resource.id, projectId: resource.projectId, kind: resource.kind, name: resource.name,
    sourceRef: resource.sourceRef, sourceRevision: resource.sourceRevision, version: resource.version,
    contentDigest: resource.contentDigest, transport: resource.transport,
    capabilities: [...resource.capabilities], credentialConfigured: resource.credentialRef !== null,
    required: resource.required, onUnavailable: resource.onUnavailable,
  };
}

function resourceDigest(resource: ProjectResourceDescriptor): string {
  return createHash('sha256').update(`${PROJECT_RESOURCE_DIGEST_DOMAIN}\n${stableStringify({
    schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION, resource,
  })}`, 'utf8').digest('hex');
}

function sortResources(resources: readonly ProjectResourceDescriptor[]): ProjectResourceDescriptor[] {
  const result = [...resources].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(result.map((item) => item.id)).size !== result.length) reject('duplicate_identity');
  return result;
}

/** Candidate state is intentionally separate from selected project configuration. */
export function validateProjectResourceCandidate(value: unknown): ProjectResourceCandidate {
  const raw = plainObject(value, [...RESOURCE_KEYS, 'schemaVersion', 'state', 'summary', 'digest']);
  if (raw.schemaVersion !== PROJECT_RESOURCE_SCHEMA_VERSION) reject('unsupported_schema_version');
  if (raw.state !== 'candidate') reject('invalid_value');
  const resource = parseResource(resourceFields(raw));
  const summary = resourceSummary(resource);
  const resourceDigestValue = resourceDigest(resource);
  if (raw.summary !== undefined && stableStringify(raw.summary) !== stableStringify(summary)) reject('identity_mismatch');
  if (raw.digest !== undefined && (typeof raw.digest !== 'string' || raw.digest !== resourceDigestValue)) reject('invalid_digest');
  return {
    ...resource, schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION, state: 'candidate',
    summary, digest: resourceDigestValue,
  };
}

/** Normalize the explicit selected set; no global or SDK catalog is ever implied. */
export function validateProjectResourceSelection(value: unknown): ProjectResourceSelection {
  const raw = plainObject(value, [
    'schemaVersion', 'projectId', 'revision', 'resources', 'operations',
    'allowGlobalScan', 'allowProjectDirectoryScan', 'allowSdkDefaultScan', 'state', 'authorization', 'digest',
  ]);
  if (raw.schemaVersion !== PROJECT_RESOURCE_SCHEMA_VERSION) reject('unsupported_schema_version');
  const projectId = uuid(raw.projectId);
  const revision = nonNegativeInteger(raw.revision);
  if (!Array.isArray(raw.resources)) reject('invalid_shape');
  if (raw.resources.length > PROJECT_RESOURCE_MAX_RESOURCES) reject('limit_exceeded');
  const resources = sortResources(raw.resources.map((item) => parseResource(item, projectId)));
  if (raw.allowGlobalScan !== false || raw.allowProjectDirectoryScan !== false || raw.allowSdkDefaultScan !== false) {
    reject('forbidden_operation');
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0 || raw.operations.length > PROJECT_RESOURCE_MAX_OPERATIONS) reject('invalid_shape');
  const operations = raw.operations.map((item): ProjectResourcePublicOperation => {
    if (typeof item !== 'string' || !PROJECT_RESOURCE_PUBLIC_OPERATIONS.includes(item as ProjectResourcePublicOperation)) reject('unknown_operation');
    return item as ProjectResourcePublicOperation;
  }).sort();
  if (new Set(operations).size !== operations.length) reject('duplicate_identity');
  const authorization: ProjectResourceAuthorization = {
    resourceIds: resources.map((item) => item.id), operations,
  };
  const body = {
    schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION, state: 'selected' as const, projectId, revision,
    resources, operations, authorization, allowGlobalScan: false as const, allowProjectDirectoryScan: false as const,
    allowSdkDefaultScan: false as const,
  };
  const selectionDigest = createHash('sha256').update(`${PROJECT_RESOURCE_DIGEST_DOMAIN}\n${stableStringify(body)}`, 'utf8').digest('hex');
  if (raw.state !== undefined && raw.state !== 'selected') reject('invalid_value');
  if (raw.authorization !== undefined) {
    const auth = plainObject(raw.authorization, ['resourceIds', 'operations']);
    if (stableStringify(auth.resourceIds) !== stableStringify(authorization.resourceIds)
      || stableStringify(auth.operations) !== stableStringify(authorization.operations)) reject('identity_mismatch');
  }
  if (raw.digest !== undefined && (typeof raw.digest !== 'string' || raw.digest !== selectionDigest)) reject('invalid_digest');
  return { ...body, digest: selectionDigest };
}

export const validateProjectResourceConfiguration = validateProjectResourceSelection;
export const normalizeProjectResourceSelection = validateProjectResourceSelection;

export function buildProjectResourceLoadPlan(value: unknown): ProjectResourceLoadPlan {
  const selection = validateProjectResourceSelection(value);
  const body = {
    schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION, state: 'selected' as const,
    projectId: selection.projectId, selectionRevision: selection.revision,
    selectedResourceIds: selection.resources.map((resource) => resource.id), resources: selection.resources,
    allowGlobalScan: false as const, allowProjectDirectoryScan: false as const, allowSdkDefaultScan: false as const,
  };
  return { ...body, digest: createHash('sha256').update(`${PROJECT_RESOURCE_DIGEST_DOMAIN}:load-plan\n${stableStringify(body)}`, 'utf8').digest('hex') };
}

export const createProjectResourceLoadPlan = buildProjectResourceLoadPlan;

function observation(value: unknown, projectId: string): ProjectResourceLoadObservation {
  const raw = plainObject(value, [...RESOURCE_KEYS, 'status', 'unavailableReason', 'loadedCapabilities']);
  const resource = parseResource(resourceFields(raw), projectId);
  if (raw.status !== 'available' && raw.status !== 'unavailable') reject('invalid_shape');
  const status = raw.status as ProjectResourceLoadObservation['status'];
  if (raw.unavailableReason !== null && raw.unavailableReason !== 'unsupported' && raw.unavailableReason !== 'unverified') reject('invalid_shape');
  if (status === 'available' && raw.unavailableReason !== null) reject('actual_load_mismatch');
  if (status === 'unavailable' && raw.unavailableReason === null) reject('actual_load_mismatch');
  const loadedCapabilities = capabilities(raw.loadedCapabilities);
  if (loadedCapabilities.some((item) => !resource.capabilities.includes(item))) reject('unapproved_capability');
  return {
    ...resource, status, unavailableReason: raw.unavailableReason as 'unsupported' | 'unverified' | null,
    loadedCapabilities,
  };
}

function sameIdentity(expected: ProjectResourceDescriptor, actual: ProjectResourceDescriptor): boolean {
  return expected.id === actual.id && expected.projectId === actual.projectId
    && expected.sourceProjectId === actual.sourceProjectId && expected.kind === actual.kind
    && expected.name === actual.name && expected.sourceRef === actual.sourceRef
    && expected.sourceRevision === actual.sourceRevision && expected.version === actual.version
    && expected.contentDigest === actual.contentDigest && expected.transport === actual.transport
    && expected.credentialRef === actual.credentialRef;
}

/** Build an immutable actual-load snapshot from the selected set only. */
export function assembleProjectResourceLoadManifest(value: unknown, observations: readonly unknown[]): ProjectResourceLoadManifest {
  const selection = validateProjectResourceSelection(value);
  if (!Array.isArray(observations)) reject('invalid_shape');
  const actual = observations.map((item) => observation(item, selection.projectId));
  if (new Set(actual.map((item) => item.id)).size !== actual.length) reject('duplicate_identity');
  const expectedById = new Map(selection.resources.map((resource) => [resource.id, resource]));
  for (const item of actual) {
    const expected = expectedById.get(item.id);
    if (!expected) reject('unexpected_resource');
    if (!sameIdentity(expected, item)) reject('resource_identity_mismatch');
  }
  const gaps: ProjectResourceCapabilityGap[] = [];
  const resources = selection.resources.map((expected): ProjectResourceLoadManifestEntry => {
    const actualItem = actual.find((item) => item.id === expected.id);
    if (!actualItem) reject('missing_approved_resource');
    if (actualItem.status === 'unavailable') {
      if (expected.required || expected.onUnavailable !== 'omit') reject('required_unavailable');
      for (const capability of expected.capabilities) gaps.push({ resourceId: expected.id, capability, reason: actualItem.unavailableReason! });
      return { ...expected, status: 'omitted', unavailableReason: actualItem.unavailableReason, loadedCapabilities: [] };
    }
    for (const capability of expected.capabilities) {
      if (!actualItem.loadedCapabilities.includes(capability)) {
        if (expected.required || expected.onUnavailable !== 'omit') reject('required_capability_missing');
        gaps.push({ resourceId: expected.id, capability, reason: 'unsupported' });
      }
    }
    return { ...expected, status: 'available', unavailableReason: null, loadedCapabilities: actualItem.loadedCapabilities };
  });
  const body = {
    schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION, state: 'loaded' as const, projectId: selection.projectId,
    selectionRevision: selection.revision, resources,
    gaps: gaps.sort((a, b) => `${a.resourceId}:${a.capability}`.localeCompare(`${b.resourceId}:${b.capability}`)),
  };
  return { ...body, digest: createHash('sha256').update(`${PROJECT_RESOURCE_DIGEST_DOMAIN}:load-manifest\n${stableStringify(body)}`, 'utf8').digest('hex') };
}

export const buildProjectResourceLoadManifest = assembleProjectResourceLoadManifest;

/** 持久化的项目资源条目：身份/版本/摘要字段不可变，enabled/status 由 Core CAS 更新。 */
export interface ProjectResourceRecord extends ProjectResourceDescriptor {
  readonly candidateDigest: string;
  readonly importedAtUtcMs: number;
  readonly enabled: boolean;
  readonly status: 'active' | 'revoked';
}

export interface ProjectResourceConfiguration {
  readonly schemaVersion: typeof PROJECT_RESOURCE_SCHEMA_VERSION;
  readonly projectId: string;
  /** Uses the authoritative project_settings CAS revision; absent settings starts at zero. */
  readonly revision: number;
  readonly resources: readonly ProjectResourceRecord[];
  readonly digest: string;
}

export function computeProjectResourceConfigurationDigest(
  value: Pick<ProjectResourceConfiguration, 'schemaVersion' | 'projectId' | 'revision' | 'resources'>,
): string {
  return createHash('sha256').update(`${PROJECT_RESOURCE_DIGEST_DOMAIN}:configuration\n${stableStringify({
    schemaVersion: value.schemaVersion,
    projectId: value.projectId,
    revision: value.revision,
    resources: value.resources,
  })}`, 'utf8').digest('hex');
}

/** Strip P06 project metadata while preserving the P04 WorkAccess identity fields. */
export function toWorkAccessResource(resource: ProjectResourceDescriptor): WorkAccessResource {
  const parsed = parseResource(resource, resource.projectId);
  return {
    id: parsed.id, kind: parsed.kind, sourceRef: parsed.sourceRef, version: parsed.version,
    contentDigest: parsed.contentDigest, required: parsed.required, onUnavailable: parsed.onUnavailable,
    capabilities: [...parsed.capabilities], transport: parsed.transport, environmentRefs: [],
  };
}

export function toWorkAccessConfiguration(
  value: unknown,
  input: {
    readonly grantId: string;
    readonly issuedAtUtcMs: number;
    readonly expiresAtUtcMs: number;
    readonly binding: WorkAccessBinding;
  },
): WorkAccessConfiguration {
  const selection = validateProjectResourceSelection(value);
  if (selection.projectId !== input.binding.projectId) reject('cross_project_reference');
  const plugin = selection.resources.find((resource) => resource.kind === 'auth_plugin');
  const sourceRef = plugin?.sourceRef ?? selection.resources[0]?.sourceRef;
  if (!sourceRef) reject('invalid_reference');
  const context = {
    grantId: input.grantId, projectId: selection.projectId, identity: input.binding.identity,
    principalId: input.binding.principal.principalId, hostInstanceId: input.binding.hostInstanceId,
    invocationId: input.binding.invocationId, executionVersion: input.binding.executionVersion,
    issuedAtUtcMs: input.issuedAtUtcMs, expiresAtUtcMs: input.expiresAtUtcMs,
    operations: [...selection.authorization.operations],
  };
  if (input.binding.strategy.runtime !== 'pi') reject('invalid_value');
  return {
    schemaVersion: 1, context, runtime: 'pi',
    provider: input.binding.strategy.provider, model: input.binding.strategy.model,
    authentication: plugin
      ? { kind: 'plugin', sourceRef, pluginId: plugin.id, environmentRefs: [] }
      : { kind: 'local_login', sourceRef, pluginId: null, environmentRefs: [] },
    resources: selection.resources.map(toWorkAccessResource),
  };
}

/** Use the existing P04 WorkResourceLoadPlan shape at the adapter boundary. */
export function toWorkResourceLoadPlan(value: unknown, binding: WorkAccessBinding): WorkResourceLoadPlan {
  const access = toWorkAccessConfiguration(value, {
    binding, grantId: binding.projectId, issuedAtUtcMs: binding.nowUtcMs,
    expiresAtUtcMs: binding.nowUtcMs + 1,
  });
  return {
    schemaVersion: 1, selectedResourceIds: access.resources.map((resource) => resource.id),
    resources: access.resources.map((resource) => ({ ...resource })),
    allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false,
  };
}
