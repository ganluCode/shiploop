/**
 * P04-2 Work 访问声明：纯数据校验与摘要，无 SDK、文件系统、时钟或业务存储。
 * binding 必须由可信控制层从当前执行/认证上下文提供，不能取自模型请求。
 * 本层只证明声明与 binding 相符；签发、撤销、终态及授权操作执行仍由 Core 核验。
 * sourceRef/environmentRefs 为可信装配注册的 UUID 引用，绝不接受路径、环境值或配置正文。
 */
import { createHash } from 'node:crypto';
import { WORK_ACCESS_OPERATIONS } from './work-access-operations.js';
export { WORK_ACCESS_OPERATIONS } from './work-access-operations.js';
import { assertTrustedPrincipal, isProjectVisible } from './authorization.js';
import type { TrustedPrincipal } from './authorization.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import { stableStringify } from './feature-plan.js';

export const WORK_ACCESS_SCHEMA_VERSION = 1;
export const WORK_ACCESS_DIGEST_DOMAIN = 'shiploop:work-access:v1';
export const WORK_ACCESS_MAX_RESOURCES = 64;
export const WORK_ACCESS_MAX_ENVIRONMENT_REFS = 32;
export const WORK_ACCESS_MAX_LIFETIME_MS = 86_400_000;
export const WORK_ACCESS_RESOURCE_KINDS = ['auth_plugin', 'skill', 'mcp', 'extension', 'tool'] as const;
export const WORK_ACCESS_CAPABILITIES = [
  'resource_selection', 'tool_interception', 'mcp_stdio', 'mcp_streamable_http', 'auth_plugin',
] as const;
export const WORK_ACCESS_REASONS = [
  'invalid_shape', 'unknown_key', 'invalid_reference', 'invalid_value', 'limit_exceeded',
  'unknown_resource', 'unknown_operation', 'unknown_capability', 'duplicate_identity',
  'identity_mismatch', 'invalid_validity', 'expired', 'not_yet_valid', 'capability_required',
] as const;
export type WorkAccessReason = (typeof WORK_ACCESS_REASONS)[number];
export type WorkAccessOperation = (typeof WORK_ACCESS_OPERATIONS)[number];
export type WorkAccessResourceKind = (typeof WORK_ACCESS_RESOURCE_KINDS)[number];
export type WorkAccessCapability = (typeof WORK_ACCESS_CAPABILITIES)[number];

/** 错误只含受控分类；不附加原始值、未知键、路径、cause 或第三方异常。 */
export class WorkAccessError extends Error {
  readonly reason: WorkAccessReason;
  readonly details: Readonly<{ reason: WorkAccessReason }>;
  constructor(reason: WorkAccessReason) {
    super(`Work access rejected: ${reason}`);
    this.name = 'WorkAccessError';
    this.reason = reason;
    this.details = Object.freeze({ reason });
  }
}

export interface WorkAccessIdentity {
  readonly purpose: 'work';
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
}
export interface WorkAccessBinding {
  readonly principal: TrustedPrincipal;
  readonly projectId: string;
  readonly hostInstanceId: string;
  readonly identity: WorkAccessIdentity;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly nowUtcMs: number;
  /** 当前 Attempt 已批准策略；不能从待校验声明反向构造。 */
  readonly strategy: Pick<RuntimeStrategyV1, 'runtime' | 'provider' | 'model'>;
}
export interface WorkAccessContext {
  readonly grantId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly hostInstanceId: string;
  readonly identity: WorkAccessIdentity;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly issuedAtUtcMs: number;
  readonly expiresAtUtcMs: number;
  readonly operations: readonly WorkAccessOperation[];
}
export interface WorkAccessAuthentication {
  readonly kind: 'environment' | 'local_login' | 'plugin';
  readonly sourceRef: string;
  readonly pluginId: string | null;
  readonly environmentRefs: readonly string[];
}
export interface WorkAccessResource {
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
export interface WorkAccessConfiguration {
  readonly schemaVersion: typeof WORK_ACCESS_SCHEMA_VERSION;
  readonly context: WorkAccessContext;
  readonly runtime: 'pi';
  readonly provider: string;
  readonly model: string;
  readonly authentication: WorkAccessAuthentication;
  readonly resources: readonly WorkAccessResource[];
}
export interface WorkAccessCapabilityGap {
  readonly resourceId: string;
  readonly capability: WorkAccessCapability;
  readonly reason: 'unsupported' | 'unverified';
}
/** 批准声明及已报告缺口，不代表实际认证 ready 或模型推理成功。 */
export interface WorkAccessManifest {
  readonly schemaVersion: typeof WORK_ACCESS_SCHEMA_VERSION;
  readonly access: WorkAccessConfiguration;
  readonly gaps: readonly WorkAccessCapabilityGap[];
  readonly digest: string;
}

function reject(reason: WorkAccessReason): never { throw new WorkAccessError(reason); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_shape');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject('invalid_shape');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) reject('unknown_key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject('invalid_shape');
  }
  return value as Record<string, unknown>;
}
function member<T extends string>(value: unknown, choices: readonly T[], reason: WorkAccessReason = 'invalid_value'): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) reject(reason);
  return value as T;
}
function reference(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    reject('invalid_reference');
  }
  return value;
}
function token(value: unknown, model = false): string {
  if (typeof value !== 'string') reject('invalid_value');
  if (value.length > 128) reject('limit_exceeded');
  // 模型允许单个 provider/model 分隔符；其它字段均无路径语义。
  const grammar = model ? /^[a-zA-Z0-9][a-zA-Z0-9._:+-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:+-]*)?$/ : /^[a-zA-Z0-9][a-zA-Z0-9._:+-]*$/;
  if (!grammar.test(value) || value.includes('..') || /^(?:sk-|gh[pousr]_|eyJ|Bearer|HOME$)/i.test(value)) reject('invalid_value');
  return value;
}
function integer(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) reject('invalid_value');
  return value;
}
function list<T>(value: unknown, max: number, parse: (entry: unknown) => T, key: (entry: T) => string): T[] {
  if (!Array.isArray(value)) reject('invalid_shape');
  if (value.length > max) reject('limit_exceeded');
  const result: T[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = parse(entry);
    const id = key(item);
    if (seen.has(id)) reject('duplicate_identity');
    seen.add(id);
    result.push(item);
  }
  return result.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}
function refs(value: unknown): string[] {
  return list(value, WORK_ACCESS_MAX_ENVIRONMENT_REFS, reference, (v) => v);
}
function identity(value: unknown): WorkAccessIdentity {
  const raw = object(value, ['purpose', 'runId', 'taskId', 'attemptId']);
  return {
    purpose: member(raw.purpose, ['work']), runId: token(raw.runId),
    taskId: token(raw.taskId), attemptId: token(raw.attemptId),
  };
}
function resource(value: unknown): WorkAccessResource {
  const raw = object(value, ['id', 'kind', 'sourceRef', 'version', 'contentDigest', 'required', 'onUnavailable', 'capabilities', 'transport', 'environmentRefs']);
  const kind = member(raw.kind, WORK_ACCESS_RESOURCE_KINDS, 'unknown_resource');
  const transport = raw.transport === null ? null : member(raw.transport, ['stdio', 'streamable_http']);
  if ((kind === 'mcp') !== (transport !== null)) reject('invalid_value');
  if (typeof raw.required !== 'boolean') reject('invalid_value');
  const onUnavailable = member(raw.onUnavailable, ['reject', 'omit']);
  if (raw.required && onUnavailable !== 'reject') reject('invalid_value');
  const version = raw.version === null ? null : token(raw.version);
  const contentDigest = raw.contentDigest;
  if (contentDigest !== null && (typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contentDigest))) reject('invalid_value');
  if ((version === null && contentDigest === null) || (kind === 'auth_plugin' && version === null)) reject('invalid_value');
  return {
    id: reference(raw.id), kind, sourceRef: reference(raw.sourceRef), version,
    contentDigest, required: raw.required, onUnavailable,
    capabilities: list(raw.capabilities, WORK_ACCESS_CAPABILITIES.length,
      (v) => member(v, WORK_ACCESS_CAPABILITIES, 'unknown_capability'), (v) => v),
    transport, environmentRefs: refs(raw.environmentRefs),
  };
}

/** 不读取实时状态；调用者须每次提供当前 principal、执行身份和时刻。 */
export function validateWorkAccessConfiguration(value: unknown, binding: WorkAccessBinding): WorkAccessConfiguration {
  const raw = object(value, ['schemaVersion', 'context', 'runtime', 'provider', 'model', 'authentication', 'resources']);
  if (raw.schemaVersion !== WORK_ACCESS_SCHEMA_VERSION) reject('invalid_value');
  const ctx = object(raw.context, ['grantId', 'principalId', 'projectId', 'hostInstanceId', 'identity', 'invocationId', 'executionVersion', 'issuedAtUtcMs', 'expiresAtUtcMs', 'operations']);
  const operations = list(ctx.operations, WORK_ACCESS_OPERATIONS.length,
    (v) => member(v, WORK_ACCESS_OPERATIONS, 'unknown_operation'), (v) => v);
  if (operations.length === 0) reject('invalid_value');
  const context: WorkAccessContext = {
    grantId: reference(ctx.grantId), projectId: reference(ctx.projectId), principalId: token(ctx.principalId),
    hostInstanceId: token(ctx.hostInstanceId), identity: identity(ctx.identity), invocationId: token(ctx.invocationId),
    executionVersion: integer(ctx.executionVersion, true), issuedAtUtcMs: integer(ctx.issuedAtUtcMs),
    expiresAtUtcMs: integer(ctx.expiresAtUtcMs), operations,
  };
  // 包装可信 principal 校验的异常，避免其形状错误携带外部原文。
  try { assertTrustedPrincipal(binding.principal); } catch { reject('identity_mismatch'); }
  const expectedIdentity = identity(binding.identity);
  if (context.projectId !== reference(binding.projectId)
    || context.principalId !== binding.principal.principalId
    || context.hostInstanceId !== token(binding.hostInstanceId)
    || context.invocationId !== token(binding.invocationId)
    || context.executionVersion !== integer(binding.executionVersion, true)
    || stableStringify(context.identity) !== stableStringify(expectedIdentity)
    || !isProjectVisible(binding.principal, context.projectId)) reject('identity_mismatch');
  if (context.expiresAtUtcMs <= context.issuedAtUtcMs
    || context.expiresAtUtcMs - context.issuedAtUtcMs > WORK_ACCESS_MAX_LIFETIME_MS) reject('invalid_validity');
  const now = integer(binding.nowUtcMs);
  if (now < context.issuedAtUtcMs) reject('not_yet_valid');
  if (now >= context.expiresAtUtcMs) reject('expired');
  const auth = object(raw.authentication, ['kind', 'sourceRef', 'pluginId', 'environmentRefs']);
  const authentication: WorkAccessAuthentication = {
    kind: member(auth.kind, ['environment', 'local_login', 'plugin']), sourceRef: reference(auth.sourceRef),
    pluginId: auth.pluginId === null ? null : reference(auth.pluginId), environmentRefs: refs(auth.environmentRefs),
  };
  const resources = list(raw.resources, WORK_ACCESS_MAX_RESOURCES, resource, (v) => v.id);
  const plugins = resources.filter((entry) => entry.kind === 'auth_plugin');
  if (authentication.kind === 'plugin') {
    if (!plugins.some((entry) => entry.id === authentication.pluginId && entry.required && entry.onUnavailable === 'reject')) reject('invalid_reference');
  } else if (authentication.pluginId !== null) reject('invalid_reference');
  if (plugins.some((entry) => entry.id !== authentication.pluginId)) reject('invalid_reference');
  const runtime = member(raw.runtime, ['pi']);
  const provider = token(raw.provider);
  const model = token(raw.model, true);
  if (runtime !== binding.strategy.runtime || provider !== binding.strategy.provider || model !== binding.strategy.model) {
    reject('identity_mismatch');
  }
  return {
    schemaVersion: WORK_ACCESS_SCHEMA_VERSION, context, runtime, provider, model, authentication, resources,
  };
}

/** gaps 由可信能力核验提供；只允许明确批准可省略的资源降级，必需缺口拒绝。 */
export function buildWorkAccessManifest(value: unknown, binding: WorkAccessBinding, gaps: unknown = []): WorkAccessManifest {
  const access = validateWorkAccessConfiguration(value, binding);
  const validatedGaps = list(gaps, WORK_ACCESS_MAX_RESOURCES * WORK_ACCESS_CAPABILITIES.length, (entry): WorkAccessCapabilityGap => {
    const raw = object(entry, ['resourceId', 'capability', 'reason']);
    const gap: WorkAccessCapabilityGap = {
      resourceId: reference(raw.resourceId), capability: member(raw.capability, WORK_ACCESS_CAPABILITIES, 'unknown_capability'),
      reason: member(raw.reason, ['unsupported', 'unverified']),
    };
    const selected = access.resources.find((item) => item.id === gap.resourceId);
    if (!selected || !selected.capabilities.includes(gap.capability)) reject('invalid_reference');
    if (selected.required || selected.onUnavailable !== 'omit') reject('capability_required');
    return gap;
  }, (gap) => `${gap.resourceId}:${gap.capability}`);
  const body = { schemaVersion: WORK_ACCESS_SCHEMA_VERSION, access, gaps: validatedGaps } as const;
  const digest = createHash('sha256').update(`${WORK_ACCESS_DIGEST_DOMAIN}\n${stableStringify(body)}`, 'utf8').digest('hex');
  return { ...body, digest };
}
