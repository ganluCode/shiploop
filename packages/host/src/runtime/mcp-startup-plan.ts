import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  RuntimeExecutionRequest,
  RuntimeWorkAccessSnapshot,
} from 'shiploop-core';
import { stableStringify } from 'shiploop-core';

export const MCP_STARTUP_PLAN_SCHEMA_VERSION = 1 as const;
export const MCP_PI_TOOL_NAME_MAX_LENGTH = 64;
export const MCP_STARTUP_MAX_SERVERS = 32;
export const MCP_STARTUP_MAX_TOOLS_PER_SERVER = 128;
export const MCP_STARTUP_MAX_ARGV = 64;
export const MCP_STARTUP_MAX_ENVIRONMENT = 64;

export const MCP_STARTUP_PLAN_REASONS = [
  'invalid_shape',
  'unknown_key',
  'unsupported_schema_version',
  'missing_work_access',
  'identity_mismatch',
  'resource_not_authorized',
  'unexpected_server',
  'duplicate_server',
  'missing_server',
  'resource_identity_mismatch',
  'unsupported_transport',
  'required_resource_unavailable',
  'optional_resource_omitted',
  'missing_tool_authorization',
  'tool_name_invalid',
  'tool_name_collision',
  'built_in_tool_collision',
  'invalid_executable',
  'invalid_argv',
  'invalid_cwd',
  'invalid_environment',
  'invalid_credential_reference',
] as const;
export type McpStartupPlanReason = (typeof MCP_STARTUP_PLAN_REASONS)[number];

/** Errors contain only a stable category; paths, commands and secrets never cross this boundary. */
export class McpStartupPlanError extends Error {
  readonly reason: McpStartupPlanReason;
  readonly details: Readonly<{ reason: McpStartupPlanReason }>;

  constructor(reason: McpStartupPlanReason) {
    super(`MCP startup plan rejected: ${reason}`);
    this.name = 'McpStartupPlanError';
    this.reason = reason;
    this.details = Object.freeze({ reason });
  }
}

export interface McpApprovedServerDefinition {
  /** P06-3 resource UUID, never the server display name. */
  readonly resourceId: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly version: string | null;
  readonly contentDigest: string | null;
  /** References only; values are resolved by trusted assembly into environment. */
  readonly environmentRefs: readonly string[];
  readonly credentialRef: string | null;
  /** Explicit executable and argv. No shell command is accepted. */
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Explicit child environment. It is never merged with process.env. */
  readonly environment: Readonly<Record<string, string>>;
  /** Empty or wildcard allowlists are never interpreted as allow-all. */
  readonly allowedTools: readonly string[];
}

export interface McpResourceResolutionInput {
  readonly request: RuntimeExecutionRequest;
  readonly resource: RuntimeWorkAccessSnapshot['resources']['entries'][number];
}

/**
 * Trusted Host assembly resolves an already approved source into local launch
 * details. It must not discover files, execute candidate commands, or read
 * owner credentials on behalf of this parser.
 */
export interface McpTrustedResourceResolver {
  resolve(input: McpResourceResolutionInput): McpApprovedServerDefinition | null | Promise<McpApprovedServerDefinition | null>;
}

export interface McpStartupToolMapping {
  readonly resourceId: string;
  readonly sourceRef: string;
  readonly originalName: string;
  readonly piName: string;
}

export interface McpStartupServerPlan extends McpApprovedServerDefinition {
  readonly approvalDigest: string;
  readonly tools: readonly McpStartupToolMapping[];
}

export interface McpStartupPlanGap {
  readonly resourceId: string;
  readonly reason: 'optional_resource_omitted' | 'unsupported_transport';
}

export interface McpStartupPlan {
  readonly schemaVersion: typeof MCP_STARTUP_PLAN_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly resourceSnapshotDigest: string;
  readonly selectionRevision?: number;
  readonly selectionDigest?: string;
  readonly loadManifestDigest?: string;
  readonly servers: readonly McpStartupServerPlan[];
  readonly tools: readonly McpStartupToolMapping[];
  readonly gaps: readonly McpStartupPlanGap[];
  readonly digest: string;
}

export interface McpStartupPlanInput {
  readonly request: RuntimeExecutionRequest;
  readonly approvedServers: readonly McpApprovedServerDefinition[];
  readonly builtInToolNames?: readonly string[];
  readonly submissionToolNames?: readonly string[];
}

export interface McpStartupPlanParserOptions {
  readonly resolver: McpTrustedResourceResolver;
  readonly builtInToolNames?: readonly string[];
  readonly submissionToolNames?: readonly string[];
}

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONTROL = /[\0-\x1f\x7f]/;
const SECRET_LIKE = /^(?:sk-|gh[pousr]_|eyJ|bearer\b|token\b|secret\b|key\b)/i;
const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'BASH_ENV', 'ENV',
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'npm_config_userconfig',
]);

function reject(reason: McpStartupPlanReason): never {
  throw new McpStartupPlanError(reason);
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

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || CONTROL.test(value)) reject('invalid_shape');
  return value;
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || value.includes('..')) reject('invalid_shape');
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) reject('invalid_shape');
  return value;
}

function digest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) reject('resource_identity_mismatch');
  return value;
}

function sortedUniqueStrings(value: unknown, max: number, reason: McpStartupPlanReason): string[] {
  if (!Array.isArray(value) || value.length > max) reject('invalid_shape');
  const result = value.map(item => nonEmptyString(item));
  if (new Set(result).size !== result.length) reject(reason);
  return result.sort((a, b) => a.localeCompare(b));
}

function validateEnvironmentRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MCP_STARTUP_MAX_ENVIRONMENT) reject('invalid_environment');
  const refs = value.map(uuid);
  if (new Set(refs).size !== refs.length) reject('invalid_environment');
  return refs.sort((a, b) => a.localeCompare(b));
}

function validateEnvironment(value: unknown): Record<string, string> {
  const raw = plainObject(value, Object.keys((value ?? {}) as object));
  const entries = Object.entries(raw);
  if (entries.length > MCP_STARTUP_MAX_ENVIRONMENT) reject('invalid_environment');
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!ENVIRONMENT_KEY.test(key) || FORBIDDEN_ENVIRONMENT_KEYS.has(key)
      || /^DYLD_/u.test(key) || typeof item !== 'string' || item.length > 16_384 || CONTROL.test(item)) {
      reject('invalid_environment');
    }
    result[key] = item;
  }
  return result;
}

function validateApprovedServer(value: unknown): McpApprovedServerDefinition {
  const raw = plainObject(value, [
    'resourceId', 'sourceRef', 'sourceRevision', 'version', 'contentDigest', 'environmentRefs', 'credentialRef',
    'executable', 'argv', 'cwd', 'environment', 'allowedTools',
  ]);
  const credentialRef = raw.credentialRef;
  if (credentialRef !== null && (typeof credentialRef !== 'string' || !TOKEN.test(credentialRef)
    || credentialRef.includes('..') || SECRET_LIKE.test(credentialRef))) reject('invalid_credential_reference');
  const executable = nonEmptyString(raw.executable);
  const cwd = nonEmptyString(raw.cwd);
  if (!isAbsolute(executable) || executable.endsWith('/') || executable.includes('..')) reject('invalid_executable');
  if (!isAbsolute(cwd) || cwd.includes('..')) reject('invalid_cwd');
  if (!Array.isArray(raw.argv) || raw.argv.length > MCP_STARTUP_MAX_ARGV) reject('invalid_argv');
  const argv = raw.argv.map(item => {
    if (typeof item !== 'string' || item.length > 4096 || CONTROL.test(item) || SECRET_LIKE.test(item)) reject('invalid_argv');
    return item;
  });
  const allowedTools = sortedUniqueStrings(raw.allowedTools, MCP_STARTUP_MAX_TOOLS_PER_SERVER, 'tool_name_collision');
  if (allowedTools.length === 0 || allowedTools.some(name => name === '*')) reject('missing_tool_authorization');
  for (const name of allowedTools) {
    if (name.length > 128 || CONTROL.test(name)) reject('tool_name_invalid');
  }
  return {
    resourceId: uuid(raw.resourceId), sourceRef: uuid(raw.sourceRef), sourceRevision: token(raw.sourceRevision),
    version: raw.version === null ? null : token(raw.version), contentDigest: digest(raw.contentDigest),
    environmentRefs: validateEnvironmentRefs(raw.environmentRefs), credentialRef: credentialRef as string | null,
    executable, argv, cwd, environment: validateEnvironment(raw.environment), allowedTools,
  };
}

function snapshotEntry(value: unknown): RuntimeWorkAccessSnapshot['resources']['entries'][number] {
  const raw = plainObject(value, [
    'id', 'kind', 'name', 'sourceRef', 'sourceRevision', 'version', 'contentDigest', 'required', 'onUnavailable',
    'status', 'capabilities', 'transport', 'environmentRefs', 'credentialRef',
  ]);
  if (raw.kind !== 'auth_plugin' && raw.kind !== 'extension' && raw.kind !== 'mcp' && raw.kind !== 'skill' && raw.kind !== 'tool') {
    reject('resource_not_authorized');
  }
  if (raw.status !== 'available' && raw.status !== 'omitted') reject('invalid_shape');
  if (raw.transport !== null && raw.transport !== 'stdio' && raw.transport !== 'streamable_http') reject('unsupported_transport');
  if (raw.kind === 'mcp') {
    if (raw.transport !== 'stdio' && raw.transport !== 'streamable_http') reject('unsupported_transport');
    const requiredCapability = raw.transport === 'stdio' ? 'mcp_stdio' : 'mcp_streamable_http';
    if (!Array.isArray(raw.capabilities) || !raw.capabilities.includes(requiredCapability)) reject('resource_not_authorized');
  } else if (raw.transport !== null) {
    reject('resource_not_authorized');
  }
  if (!Array.isArray(raw.capabilities)) reject('invalid_shape');
  if (typeof raw.required !== 'boolean' || (raw.required && raw.onUnavailable !== 'reject')
    || (raw.onUnavailable !== 'reject' && raw.onUnavailable !== 'omit')) reject('resource_not_authorized');
  uuid(raw.id); uuid(raw.sourceRef);
  if (raw.sourceRevision !== undefined && typeof raw.sourceRevision !== 'string') reject('resource_identity_mismatch');
  if (raw.version !== null && typeof raw.version !== 'string') reject('resource_identity_mismatch');
  if (raw.contentDigest !== null && !SHA256.test(String(raw.contentDigest))) reject('resource_identity_mismatch');
  return raw as RuntimeWorkAccessSnapshot['resources']['entries'][number];
}

function assertRequestBinding(request: RuntimeExecutionRequest): RuntimeWorkAccessSnapshot {
  if (request.workAccess === undefined) reject('missing_work_access');
  const access = request.workAccess;
  if (request.schemaVersion !== 1 || request.strategy.runtime !== 'pi') reject('unsupported_schema_version');
  if (access.schemaVersion !== 1 || !SHA256.test(access.resources.digest) || access.projectId !== request.projectId || request.identity.purpose !== 'work'
    || access.runId !== request.identity.runId || access.taskId !== request.identity.taskId
    || access.attemptId !== request.identity.attemptId || access.invocationId !== request.invocationId
    || access.executionVersion !== request.executionVersion || access.owner.principalId !== request.owner.principalId
    || access.owner.hostInstanceId !== request.owner.hostInstanceId || access.strategy.runtime !== request.strategy.runtime
    || access.strategy.provider !== request.strategy.provider || access.strategy.model !== request.strategy.model) {
    reject('identity_mismatch');
  }
  if (!Array.isArray(access.resources.entries) || access.resources.entries.length > MCP_STARTUP_MAX_SERVERS) reject('invalid_shape');
  return access;
}

function sameIdentity(expected: RuntimeWorkAccessSnapshot['resources']['entries'][number], actual: McpApprovedServerDefinition): boolean {
  return expected.id === actual.resourceId && expected.sourceRef === actual.sourceRef
    && (expected.sourceRevision === undefined || expected.sourceRevision === actual.sourceRevision)
    && expected.version === actual.version && expected.contentDigest === actual.contentDigest;
}

function optionalSnapshotRefs(entry: RuntimeWorkAccessSnapshot['resources']['entries'][number]): {
  readonly environmentRefs?: readonly string[];
  readonly credentialRef?: string | null;
} {
  const raw = entry as unknown as Record<string, unknown>;
  return {
    ...(raw.environmentRefs === undefined ? {} : { environmentRefs: validateEnvironmentRefs(raw.environmentRefs) }),
    ...(raw.credentialRef === undefined ? {} : { credentialRef: raw.credentialRef === null ? null : token(raw.credentialRef) }),
  };
}

function mapPiName(resourceId: string, originalName: string): string {
  const normalized = originalName.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const toolPart = normalized.length === 0 ? 'tool' : (/^[a-z]/.test(normalized) ? normalized : `tool_${normalized}`);
  const name = `mcp_${createHash('sha256').update(resourceId).digest('hex').slice(0, 8)}_${toolPart.slice(0, 48)}`;
  if (name.length > MCP_PI_TOOL_NAME_MAX_LENGTH || !/^[a-z][a-z0-9_-]*$/.test(name)) reject('tool_name_invalid');
  return name;
}

function toolMappings(server: McpApprovedServerDefinition, occupied: Set<string>, builtIns: ReadonlySet<string>): McpStartupToolMapping[] {
  const mappings = server.allowedTools.map(originalName => {
    if (originalName.length > 128 || CONTROL.test(originalName)) reject('tool_name_invalid');
    const piName = mapPiName(server.resourceId, originalName);
    if (occupied.has(piName)) reject(builtIns.has(piName) ? 'built_in_tool_collision' : 'tool_name_collision');
    occupied.add(piName);
    return { resourceId: server.resourceId, sourceRef: server.sourceRef, originalName, piName };
  });
  return mappings;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function planDigest(body: Omit<McpStartupPlan, 'digest'>): string {
  return createHash('sha256').update(`shiploop:mcp-startup-plan:v1\n${stableStringify(body)}`, 'utf8').digest('hex');
}

/** Synchronous pure parser for definitions already resolved by trusted assembly. */
export function buildMcpStartupPlan(input: McpStartupPlanInput): McpStartupPlan {
  const access = assertRequestBinding(input.request);
  if (!Array.isArray(input.approvedServers) || input.approvedServers.length > MCP_STARTUP_MAX_SERVERS) reject('invalid_shape');
  const definitions = input.approvedServers.map(validateApprovedServer);
  const definitionIds = new Set<string>();
  for (const definition of definitions) {
    if (definitionIds.has(definition.resourceId)) reject('duplicate_server');
    definitionIds.add(definition.resourceId);
  }
  const entries = access.resources.entries.map(snapshotEntry);
  const entryIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) reject('duplicate_server');
    entryIds.add(entry.id);
  }
  const mcpEntries = entries.filter(entry => entry.kind === 'mcp');
  const expectedIds = new Set(mcpEntries.map(entry => entry.id));
  if (definitions.some(definition => !expectedIds.has(definition.resourceId))) reject('unexpected_server');
  const occupied = new Set<string>();
  const builtIns = new Set<string>();
  for (const name of [...(input.builtInToolNames ?? []), ...(input.submissionToolNames ?? [])]) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) reject('built_in_tool_collision');
    occupied.add(name);
    builtIns.add(name);
  }
  const servers: McpStartupServerPlan[] = [];
  const tools: McpStartupToolMapping[] = [];
  const gaps: McpStartupPlanGap[] = [];
  for (const entry of mcpEntries) {
    if (entry.transport !== 'stdio') {
      if (entry.required || entry.onUnavailable !== 'omit') reject('unsupported_transport');
      gaps.push({ resourceId: entry.id, reason: 'unsupported_transport' });
      continue;
    }
    if (entry.status === 'omitted') {
      if (entry.required || entry.onUnavailable !== 'omit') reject('required_resource_unavailable');
      gaps.push({ resourceId: entry.id, reason: 'optional_resource_omitted' });
      continue;
    }
    const definition = definitions.find(item => item.resourceId === entry.id);
    if (definition === undefined) {
      if (entry.required || entry.onUnavailable !== 'omit') reject('missing_server');
      gaps.push({ resourceId: entry.id, reason: 'optional_resource_omitted' });
      continue;
    }
    if (!sameIdentity(entry, definition)) reject('resource_identity_mismatch');
    const refs = optionalSnapshotRefs(entry);
    if (refs.environmentRefs !== undefined && stableStringify(refs.environmentRefs) !== stableStringify(definition.environmentRefs)) {
      reject('resource_identity_mismatch');
    }
    if (refs.credentialRef !== undefined && refs.credentialRef !== definition.credentialRef) reject('resource_identity_mismatch');
    const serverTools = toolMappings(definition, occupied, builtIns);
    const approvalDigest = createHash('sha256').update(`shiploop:mcp-authorization:v1\n${stableStringify({
      resourceId: definition.resourceId, sourceRef: definition.sourceRef, sourceRevision: definition.sourceRevision,
      version: definition.version, contentDigest: definition.contentDigest, environmentRefs: definition.environmentRefs,
      credentialRef: definition.credentialRef, allowedTools: definition.allowedTools,
    })}`, 'utf8').digest('hex');
    const server = { ...definition, approvalDigest, tools: serverTools };
    servers.push(server);
    tools.push(...serverTools);
  }
  const body: Omit<McpStartupPlan, 'digest'> = {
    schemaVersion: MCP_STARTUP_PLAN_SCHEMA_VERSION, projectId: input.request.projectId, sessionId: input.request.sessionId,
    attemptId: access.attemptId, invocationId: input.request.invocationId,
    executionVersion: input.request.executionVersion, resourceSnapshotDigest: access.resources.digest,
    ...(access.resources.selectionRevision === undefined ? {} : { selectionRevision: access.resources.selectionRevision }),
    ...(access.resources.selectionDigest === undefined ? {} : { selectionDigest: access.resources.selectionDigest }),
    ...(access.resources.loadManifestDigest === undefined ? {} : { loadManifestDigest: access.resources.loadManifestDigest }),
    servers: servers.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    tools: tools.sort((a, b) => a.piName.localeCompare(b.piName)), gaps: gaps.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
  };
  return freeze({ ...body, digest: planDigest(body) });
}

/** Resolve approved source definitions and then run the same pure validation path. */
export async function prepareMcpStartupPlan(
  request: RuntimeExecutionRequest,
  options: McpStartupPlanParserOptions,
): Promise<McpStartupPlan> {
  const access = assertRequestBinding(request);
  const definitions: McpApprovedServerDefinition[] = [];
  for (const rawEntry of access.resources.entries) {
    const entry = snapshotEntry(rawEntry);
    if (entry.kind !== 'mcp' || entry.status !== 'available' || entry.transport !== 'stdio') continue;
    let definition: McpApprovedServerDefinition | null;
    try {
      definition = await options.resolver.resolve({ request, resource: entry });
    } catch {
      if (entry.required || entry.onUnavailable !== 'omit') reject('resource_not_authorized');
      definition = null;
    }
    if (definition !== null) definitions.push(definition);
  }
  return buildMcpStartupPlan({ request, approvedServers: definitions,
    builtInToolNames: options.builtInToolNames, submissionToolNames: options.submissionToolNames });
}

export function createMcpStartupPlanParser(options: McpStartupPlanParserOptions): {
  prepare(request: RuntimeExecutionRequest): Promise<McpStartupPlan>;
} {
  return { prepare: (request) => prepareMcpStartupPlan(request, options) };
}

export const parseMcpStartupPlan = buildMcpStartupPlan;
export const resolveMcpStartupPlan = prepareMcpStartupPlan;
