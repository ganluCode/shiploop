/**
 * P04-2 / F-003：Work 项目资源的显式选集与实际加载核对。
 *
 * 这是 Core 的纯数据端口：不扫描文件系统、不读取 SDK 默认配置、不加载模块，
 * 也不接受命令、环境覆盖或数据库路径。Host/Adapter 只能消费这里生成的计划，
 * 并把受控的实际加载报告传回装配函数。
 */
import { createHash } from 'node:crypto';
import {
  type WorkAccessBinding,
  type WorkAccessCapability,
  type WorkAccessConfiguration,
  type WorkAccessResource,
  type WorkAccessResourceKind,
  validateWorkAccessConfiguration,
} from './work-access.js';
import { stableStringify } from './feature-plan.js';

export const WORK_RESOURCE_SELECTION_SCHEMA_VERSION = 1;
export const WORK_RESOURCE_SELECTION_DIGEST_DOMAIN = 'shiploop:work-resource-selection:v1';

export const WORK_RESOURCE_SELECTION_REASONS = [
  'invalid_shape',
  'unknown_resource',
  'unknown_transport',
  'duplicate_identity',
  'unapproved_extension',
  'unexpected_resource',
  'missing_approved_resource',
  'resource_identity_mismatch',
  'unapproved_capability',
  'required_unavailable',
  'required_capability_missing',
  'actual_load_mismatch',
] as const;
export type WorkResourceSelectionReason = (typeof WORK_RESOURCE_SELECTION_REASONS)[number];

/** 错误详情只保留稳定分类，避免回显路径、命令、环境值或第三方错误正文。 */
export class WorkResourceSelectionError extends Error {
  readonly reason: WorkResourceSelectionReason;
  readonly details: Readonly<{ reason: WorkResourceSelectionReason }>;

  constructor(reason: WorkResourceSelectionReason) {
    super(`Work resource selection rejected: ${reason}`);
    this.name = 'WorkResourceSelectionError';
    this.reason = reason;
    this.details = Object.freeze({ reason });
  }
}

/** 适配器实际观察到的单项结果；它不包含路径、命令或环境正文。 */
export interface WorkResourceLoadObservation {
  readonly id: string;
  readonly kind: WorkAccessResourceKind;
  readonly sourceRef: string;
  readonly version: string | null;
  readonly contentDigest: string | null;
  readonly capabilities: readonly WorkAccessCapability[];
  readonly transport: 'stdio' | 'streamable_http' | null;
  readonly status: 'available' | 'unavailable';
  readonly unavailableReason: 'unsupported' | 'unverified' | null;
}

/**
 * 资源加载计划只从已验证的批准资源生成。三个扫描开关固定为 false，
 * 使组合根无法通过默认值把全局或项目目录资源带入执行。
 */
export interface WorkResourceLoadPlan {
  readonly schemaVersion: typeof WORK_RESOURCE_SELECTION_SCHEMA_VERSION;
  readonly selectedResourceIds: readonly string[];
  readonly resources: readonly WorkResourceLoadPlanEntry[];
  readonly allowGlobalScan: false;
  readonly allowProjectDirectoryScan: false;
  readonly allowSdkDefaultScan: false;
}
export interface WorkResourceLoadPlanEntry {
  readonly id: string;
  readonly kind: WorkAccessResourceKind;
  readonly sourceRef: string;
  readonly version: string | null;
  readonly contentDigest: string | null;
  readonly required: boolean;
  readonly onUnavailable: 'reject' | 'omit';
  readonly capabilities: readonly WorkAccessCapability[];
  readonly transport: 'stdio' | 'streamable_http' | null;
  readonly environmentRefs: readonly string[];
}

export interface WorkResourceManifestEntry extends WorkResourceLoadPlanEntry {
  readonly status: 'available' | 'omitted';
  readonly loadedCapabilities: readonly WorkAccessCapability[];
}
export interface WorkResourceCapabilityGap {
  readonly resourceId: string;
  readonly capability: WorkAccessCapability;
  readonly reason: 'unsupported' | 'unverified';
}
export interface WorkResourceLoadDifference {
  readonly kind: 'omitted_optional_resource';
  readonly resourceId: string;
  readonly reason: 'unsupported' | 'unverified';
}
export interface WorkResourceManifest {
  readonly schemaVersion: typeof WORK_RESOURCE_SELECTION_SCHEMA_VERSION;
  readonly access: WorkAccessConfiguration;
  readonly resources: readonly WorkResourceManifestEntry[];
  readonly gaps: readonly WorkResourceCapabilityGap[];
  readonly differences: readonly WorkResourceLoadDifference[];
  readonly digest: string;
}

function reject(reason: WorkResourceSelectionReason): never {
  throw new WorkResourceSelectionError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateObservation(value: unknown): WorkResourceLoadObservation {
  if (!isPlainObject(value)) reject('invalid_shape');
  const allowed = ['id', 'kind', 'sourceRef', 'version', 'contentDigest', 'capabilities', 'transport', 'status', 'unavailableReason'];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) reject('invalid_shape');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) reject('invalid_shape');
  }
  const id = value.id;
  const sourceRef = value.sourceRef;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
    || typeof sourceRef !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sourceRef)) {
    reject('invalid_shape');
  }
  if (!['auth_plugin', 'skill', 'mcp', 'extension', 'tool'].includes(value.kind as string)) reject('unknown_resource');
  if (value.transport !== null && value.transport !== 'stdio' && value.transport !== 'streamable_http') reject('unknown_transport');
  if (typeof value.version !== 'string' && value.version !== null) reject('invalid_shape');
  if (value.contentDigest !== null && (typeof value.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentDigest))) reject('invalid_shape');
  if (value.version === null && value.contentDigest === null) reject('invalid_shape');
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) =>
    !['resource_selection', 'tool_interception', 'mcp_stdio', 'mcp_streamable_http', 'auth_plugin'].includes(item as string))) {
    reject('unknown_resource');
  }
  if (new Set(value.capabilities as unknown[]).size !== (value.capabilities as unknown[]).length) reject('duplicate_identity');
  if (value.status !== 'available' && value.status !== 'unavailable') reject('invalid_shape');
  if (value.unavailableReason !== null && value.unavailableReason !== 'unsupported' && value.unavailableReason !== 'unverified') reject('invalid_shape');
  if (value.status === 'available' && value.unavailableReason !== null) reject('invalid_shape');
  if (value.status === 'unavailable' && value.unavailableReason === null) reject('invalid_shape');
  if ((value.kind === 'mcp') !== (value.transport !== null)) reject('actual_load_mismatch');
  return {
    id, kind: value.kind as WorkAccessResourceKind, sourceRef, version: value.version as string | null,
    contentDigest: value.contentDigest as string | null,
    capabilities: [...value.capabilities] as WorkAccessCapability[],
    transport: value.transport as 'stdio' | 'streamable_http' | null,
    status: value.status, unavailableReason: value.unavailableReason as 'unsupported' | 'unverified' | null,
  };
}

function planEntry(resource: WorkAccessResource): WorkResourceLoadPlanEntry {
  return {
    id: resource.id, kind: resource.kind, sourceRef: resource.sourceRef, version: resource.version,
    contentDigest: resource.contentDigest, required: resource.required, onUnavailable: resource.onUnavailable,
    capabilities: [...resource.capabilities], transport: resource.transport, environmentRefs: [...resource.environmentRefs],
  };
}

function resourcePlan(access: WorkAccessConfiguration): WorkResourceLoadPlan {
  const resources = access.resources.map(planEntry);
  return {
    schemaVersion: WORK_RESOURCE_SELECTION_SCHEMA_VERSION,
    selectedResourceIds: resources.map((resource) => resource.id),
    resources,
    allowGlobalScan: false,
    allowProjectDirectoryScan: false,
    allowSdkDefaultScan: false,
  };
}

/** 生成唯一的显式资源选集；调用者无需也不能提供资源目录或 SDK catalog。 */
export function selectWorkResources(value: unknown, binding: WorkAccessBinding): WorkResourceLoadPlan {
  return resourcePlan(validateWorkAccessConfiguration(value, binding));
}

export function buildWorkResourceLoadPlan(value: unknown, binding: WorkAccessBinding): WorkResourceLoadPlan {
  return selectWorkResources(value, binding);
}

function sameIdentity(expected: WorkResourceLoadPlanEntry, actual: WorkResourceLoadObservation): boolean {
  return expected.id === actual.id && expected.kind === actual.kind && expected.sourceRef === actual.sourceRef
    && expected.version === actual.version && expected.contentDigest === actual.contentDigest
    && expected.transport === actual.transport;
}

function manifestEntry(expected: WorkResourceLoadPlanEntry, actual: WorkResourceLoadObservation | null): WorkResourceManifestEntry {
  return {
    ...expected,
    status: actual?.status === 'available' ? 'available' : 'omitted',
    loadedCapabilities: actual?.status === 'available' ? [...actual.capabilities] : [],
  };
}

/**
 * 核对实际加载报告并生成执行快照。报告必须逐项列出批准资源，包括明确的 unavailable
 * 结果；缺项、额外项、身份漂移、能力扩大和必需能力缺失均在启动前拒绝。
 */
export function assembleWorkResourceManifest(
  value: unknown,
  binding: WorkAccessBinding,
  observations: readonly unknown[],
): WorkResourceManifest {
  const access = validateWorkAccessConfiguration(value, binding);
  const plan = resourcePlan(access);
  if (!Array.isArray(observations)) reject('invalid_shape');
  const actual = observations.map(validateObservation);
  const actualIds = new Set<string>();
  for (const item of actual) {
    if (actualIds.has(item.id)) reject('duplicate_identity');
    actualIds.add(item.id);
  }
  const expectedById = new Map(plan.resources.map((resource) => [resource.id, resource]));
  for (const item of actual) {
    const expected = expectedById.get(item.id);
    if (expected === undefined) reject(item.kind === 'extension' ? 'unapproved_extension' : 'unexpected_resource');
    if (item.kind === 'extension' && expected.kind !== 'extension') reject('unapproved_extension');
    if (!sameIdentity(expected, item)) reject('resource_identity_mismatch');
    if (item.status === 'available') {
      if (item.capabilities.some((capability) => !expected.capabilities.includes(capability))) reject('unapproved_capability');
      if (expected.kind === 'mcp') {
        const expectedTransportCapability = expected.transport === 'stdio' ? 'mcp_stdio' : 'mcp_streamable_http';
        if (!item.capabilities.includes(expectedTransportCapability)) reject('required_capability_missing');
      }
    }
  }
  const gaps: WorkResourceCapabilityGap[] = [];
  const differences: WorkResourceLoadDifference[] = [];
  const resources = plan.resources.map((expected) => {
    const observed = actual.find((item) => item.id === expected.id);
    if (observed === undefined) reject('missing_approved_resource');
    if (observed.status === 'unavailable') {
      if (expected.required || expected.onUnavailable !== 'omit') reject('required_unavailable');
      const reason = observed.unavailableReason;
      if (reason === null) reject('actual_load_mismatch');
      differences.push({ kind: 'omitted_optional_resource', resourceId: expected.id, reason });
      for (const capability of expected.capabilities) gaps.push({ resourceId: expected.id, capability, reason });
      return manifestEntry(expected, observed);
    }
    for (const capability of expected.capabilities) {
      if (!observed.capabilities.includes(capability)) {
        if (expected.required || expected.onUnavailable !== 'omit') reject('required_capability_missing');
        gaps.push({ resourceId: expected.id, capability, reason: 'unsupported' });
      }
    }
    return manifestEntry(expected, observed);
  });
  const body = {
    schemaVersion: WORK_RESOURCE_SELECTION_SCHEMA_VERSION,
    access,
    resources,
    gaps: gaps.sort((a, b) => {
      const left = `${a.resourceId}:${a.capability}`;
      const right = `${b.resourceId}:${b.capability}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    differences: differences.sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0),
  } as const;
  const digest = createHash('sha256')
    .update(`${WORK_RESOURCE_SELECTION_DIGEST_DOMAIN}\n${stableStringify(body)}`, 'utf8').digest('hex');
  return { ...body, digest };
}

export function buildWorkResourceManifest(
  value: unknown,
  binding: WorkAccessBinding,
  observations: readonly unknown[],
): WorkResourceManifest {
  return assembleWorkResourceManifest(value, binding, observations);
}
