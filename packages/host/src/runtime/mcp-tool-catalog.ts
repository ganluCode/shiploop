import { createHash } from 'node:crypto';
import {
  McpAbortError, McpConnectionClosedError, McpError, McpTimeoutError, toLlmContent,
  type CallToolResult, type ContentBlock,
} from '@earendil-works/pi-mcp';
import { stableStringify } from 'shiploop-core';
import type { McpStartupPlan, McpStartupServerPlan } from './mcp-startup-plan.js';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';

export type McpToolFailureReason = 'invalid_discovery' | 'invalid_tool_name' | 'duplicate_tool'
  | 'invalid_schema' | 'unsupported_schema' | 'limit_exceeded' | 'pagination_no_progress'
  | 'unauthorized_server' | 'mapping_collision' | 'invalid_mapping' | 'invalid_arguments'
  | 'tool_unavailable' | 'tool_identity_drift' | 'discovery_failed' | 'call_failed'
  | 'unauthorized_call' | 'concurrency_limit' | 'invalid_response' | 'unsupported_content'
  | 'mcp_tool_error' | 'json_rpc_error' | 'call_timeout' | 'call_cancelled'
  | 'connection_closed' | 'response_lost';
export class McpToolCatalogError extends Error {
  constructor(readonly reason: McpToolFailureReason) {
    super(`MCP tools rejected: ${reason}`);
    this.name = 'McpToolCatalogError';
  }
}
function fail(reason: McpToolFailureReason): never { throw new McpToolCatalogError(reason); }
export const MCP_DISCOVERY_LIMITS = Object.freeze({ tools: 128, pages: 32, bytes: 262_144,
  descriptionBytes: 4096, schemaBytes: 32_768, schemaDepth: 16, argumentBytes: 65_536 });
/** Limits apply to the complete result before it is handed to Pi. Oversize results fail closed. */
export interface McpCallLimits {
  readonly maxConcurrentCalls: number;
  readonly maxResultBytes: number;
  readonly maxContentBlocks: number;
  readonly maxTextBytes: number;
  readonly maxStructuredBytes: number;
  readonly maxToolCallIdBytes: number;
}
export const MCP_CALL_LIMITS: McpCallLimits = Object.freeze({
  maxConcurrentCalls: 8, maxResultBytes: 262_144, maxContentBlocks: 128,
  maxTextBytes: 65_536, maxStructuredBytes: 65_536, maxToolCallIdBytes: 256,
});
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function json(value: unknown, maxBytes: number, reason: McpToolFailureReason): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
        || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) fail(reason);
      return item;
    });
  } catch { return fail(reason); }
  if (text === undefined) fail(reason);
  if (Buffer.byteLength(text) > maxBytes) fail('limit_exceeded');
  return text;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type Schema = Record<string, unknown>;
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'anyOf', 'oneOf', 'allOf', 'description', 'title', 'default', '$schema']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
/** Deliberately closed JSON Schema subset. Unsupported constraints are rejected, never silently ignored. */
function checkSchema(value: unknown, depth = 0): asserts value is Schema {
  if (!record(value)) fail('invalid_schema');
  if (depth > MCP_DISCOVERY_LIMITS.schemaDepth) fail('limit_exceeded');
  if (Object.keys(value).some(key => !KEYWORDS.has(key))) fail('unsupported_schema');
  if (value.$schema !== undefined && value.$schema !== 'https://json-schema.org/draft/2020-12/schema'
    && value.$schema !== 'http://json-schema.org/draft-07/schema#') fail('unsupported_schema');
  if (value.type !== undefined && (typeof value.type !== 'string' || !TYPES.has(value.type))) fail('unsupported_schema');
  for (const key of ['description', 'title']) if (value[key] !== undefined && typeof value[key] !== 'string') fail('invalid_schema');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])
      || (key === 'multipleOf' && value[key] <= 0))) fail('invalid_schema');
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) fail('invalid_schema');
  }
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') fail('invalid_schema');
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0
    || new Set(value.enum.map(item => stableStringify(item))).size !== value.enum.length)) fail('invalid_schema');
  if (value.properties !== undefined) {
    if (!record(value.properties)) fail('invalid_schema');
    for (const child of Object.values(value.properties)) checkSchema(child, depth + 1);
  }
  if (value.required !== undefined && (!Array.isArray(value.required)
    || value.required.some(key => typeof key !== 'string') || new Set(value.required).size !== value.required.length)) fail('invalid_schema');
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') checkSchema(value.additionalProperties, depth + 1);
  if (value.items !== undefined) checkSchema(value.items, depth + 1);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length === 0) fail('invalid_schema');
    for (const child of value[key]) checkSchema(child, depth + 1);
  }
}
function matches(s: Schema, value: unknown): boolean {
  const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
  if ('const' in s && !same(s.const, value)) return false;
  if (Array.isArray(s.enum) && !s.enum.some(item => same(item, value))) return false;
  if (Array.isArray(s.allOf) && !s.allOf.every(child => matches(child, value))) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.some(child => matches(child, value))) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter(child => matches(child, value)).length !== 1) return false;
  if (s.type === 'object' && !record(value) || s.type === 'array' && !Array.isArray(value)
    || s.type === 'null' && value !== null || s.type === 'string' && typeof value !== 'string'
    || s.type === 'boolean' && typeof value !== 'boolean'
    || (s.type === 'number' || s.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))
    || s.type === 'integer' && !Number.isInteger(value)) return false;
  if (typeof value === 'number') {
    const multiple = typeof s.multipleOf === 'number' ? value / s.multipleOf : undefined;
    if (multiple !== undefined && Math.abs(multiple - Math.round(multiple)) > Number.EPSILON * Math.max(1, Math.abs(multiple))) return false;
    if (typeof s.minimum === 'number' && value < s.minimum || typeof s.maximum === 'number' && value > s.maximum
      || typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum
      || typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return false;
  }
  const size = typeof value === 'string' ? [...value].length : Array.isArray(value) ? value.length : record(value) ? Object.keys(value).length : undefined;
  const suffix = typeof value === 'string' ? 'Length' : Array.isArray(value) ? 'Items' : 'Properties';
  if (size !== undefined && (typeof s[`min${suffix}`] === 'number' && size < (s[`min${suffix}`] as number)
    || typeof s[`max${suffix}`] === 'number' && size > (s[`max${suffix}`] as number))) return false;
  if (Array.isArray(value)) {
    if (s.uniqueItems && new Set(value.map(item => stableStringify(item))).size !== value.length) return false;
    if (record(s.items) && !value.every(item => matches(s.items as Schema, item))) return false;
  }
  if (record(value)) {
    if (Array.isArray(s.required) && s.required.some(key => !Object.hasOwn(value, key))) return false;
    const properties = record(s.properties) ? s.properties : {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) { if (!matches(properties[key] as Schema, item)) return false; }
      else if (s.additionalProperties === false || record(s.additionalProperties) && !matches(s.additionalProperties, item)) return false;
    }
  }
  return true;
}
interface DiscoveredTool { readonly name: string; readonly description?: string; readonly inputSchema: Schema }
export function validateMcpDiscoveredTools(raw: unknown): readonly DiscoveredTool[] {
  const snapshot = JSON.parse(json(raw, MCP_DISCOVERY_LIMITS.bytes, 'invalid_discovery')) as unknown;
  if (!Array.isArray(snapshot)) fail('invalid_discovery');
  if (snapshot.length > MCP_DISCOVERY_LIMITS.tools) fail('limit_exceeded');
  const names = new Set<string>();
  for (const tool of snapshot) {
    if (!record(tool)) fail('invalid_discovery');
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool.name)) fail('invalid_tool_name');
    if (names.has(tool.name)) fail('duplicate_tool');
    names.add(tool.name);
    if (tool.description !== undefined && typeof tool.description !== 'string') fail('invalid_discovery');
    if (Buffer.byteLength(tool.description ?? '') > MCP_DISCOVERY_LIMITS.descriptionBytes) fail('limit_exceeded');
    json(tool.inputSchema, MCP_DISCOVERY_LIMITS.schemaBytes, 'invalid_schema');
    checkSchema(tool.inputSchema);
    if (tool.inputSchema.type !== 'object') fail('invalid_schema');
  }
  return freeze(snapshot as DiscoveredTool[]);
}
/** Own pagination so count/bytes/deadline limits apply before accumulating arbitrary server pages. */
export async function discoverMcpTools(request: (cursor?: string) => Promise<unknown>): Promise<readonly DiscoveredTool[]> {
  const all: unknown[] = [], cursors = new Set<string>();
  let cursor: string | undefined, bytes = 0;
  for (let page = 0; page < MCP_DISCOVERY_LIMITS.pages; page++) {
    const result = await request(cursor);
    bytes += Buffer.byteLength(json(result, MCP_DISCOVERY_LIMITS.bytes, 'invalid_discovery'));
    if (bytes > MCP_DISCOVERY_LIMITS.bytes) fail('limit_exceeded');
    if (!record(result) || !Array.isArray(result.tools)) fail('invalid_discovery');
    if (all.length + result.tools.length > MCP_DISCOVERY_LIMITS.tools) fail('limit_exceeded');
    all.push(...result.tools);
    if (result.nextCursor === undefined) return validateMcpDiscoveredTools(all);
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length === 0 || result.nextCursor.length > 1024) fail('invalid_discovery');
    if (result.tools.length === 0 || cursors.has(result.nextCursor)) fail('pagination_no_progress');
    cursors.add(result.nextCursor); cursor = result.nextCursor;
  }
  return fail('limit_exceeded');
}
export interface McpToolCallContext {
  readonly toolCallId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly resourceId: string;
  readonly serverId: string;
  readonly sourceRef: string;
  readonly originalName: string;
  readonly piName: string;
}
export interface McpToolEndpoint {
  readonly server: McpStartupServerPlan;
  discover(signal?: AbortSignal): Promise<readonly unknown[]>;
  /** The optional context is for correlation only; it is never an authorization source. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal, context?: McpToolCallContext): Promise<unknown>;
  /** Recheck the trusted execution qualification immediately before the side effect. */
  authorize?(binding: McpToolBinding): void | Promise<void>;
  /** A closed/revoked connection must fail before calling the server. */
  isAvailable?(): boolean;
}
async function discoverEndpoint(endpoint: McpToolEndpoint, signal?: AbortSignal): Promise<readonly DiscoveredTool[]> {
  try { return validateMcpDiscoveredTools(await endpoint.discover(signal)); }
  catch (error) {
    if (error instanceof McpToolCatalogError) throw error;
    if (error instanceof McpError || typeof (error as { code?: unknown })?.code === 'number') {
      throw new McpToolCatalogError('json_rpc_error');
    }
    if (error instanceof McpTimeoutError || error instanceof Error && error.name === 'McpTimeoutError') {
      throw new McpToolCatalogError('call_timeout');
    }
    if (error instanceof McpAbortError || error instanceof Error && error.name === 'McpAbortError') {
      throw new McpToolCatalogError('call_cancelled');
    }
    if (error instanceof McpConnectionClosedError || error instanceof Error && error.name === 'McpConnectionClosedError'
      || (typeof (error as { code?: unknown })?.code === 'string' && ['closed', 'server_exited'].includes((error as { code: string }).code))) {
      throw new McpToolCatalogError('connection_closed');
    }
    throw new McpToolCatalogError('discovery_failed');
  }
}
export interface McpToolBinding {
  readonly projectId: string; readonly sessionId: string; readonly invocationId: string;
  readonly resourceId: string; readonly sourceRef: string; readonly originalName: string; readonly piName: string;
}
export interface McpToolCatalog {
  readonly tools: readonly PiSubmissionToolDefinition[];
  resolve(piName: string): McpToolBinding | undefined;
  dispatch(binding: McpToolBinding, params: unknown, signal?: AbortSignal, toolCallId?: string): Promise<unknown>;
}

function strictJson(value: unknown, maxBytes: number, reason: McpToolFailureReason): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
        || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) fail(reason);
      return item;
    });
  } catch { return fail(reason); }
  if (text === undefined || Buffer.byteLength(text) > maxBytes) fail('limit_exceeded');
  return text;
}

function validateCallContent(value: unknown, limits: McpCallLimits): asserts value is ContentBlock[] {
  if (!Array.isArray(value) || value.length > limits.maxContentBlocks) fail('invalid_response');
  for (const block of value) {
    if (!record(block) || typeof block.type !== 'string') fail('invalid_response');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('invalid_response');
      if (Buffer.byteLength(block.text) > limits.maxTextBytes) fail('limit_exceeded');
      continue;
    }
    if (block.type === 'image') {
      if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') fail('invalid_response');
      if (Buffer.byteLength(block.data) > limits.maxTextBytes) fail('limit_exceeded');
      continue;
    }
    if (block.type === 'resource' && record(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === 'string') {
        if (Buffer.byteLength(resource.text) > limits.maxTextBytes) fail('limit_exceeded');
        continue;
      }
    }
    // Resource links, audio and binary resources have no safe Pi mapping in this bridge.
    fail('unsupported_content');
  }
}

function validateCallResult(value: unknown, limits: McpCallLimits): CallToolResult {
  if (!record(value) || !Object.hasOwn(value, 'content')) fail('invalid_response');
  validateCallContent(value.content, limits);
  if (value.structuredContent !== undefined) {
    if (!record(value.structuredContent)) fail('invalid_response');
    strictJson(value.structuredContent, limits.maxStructuredBytes, 'invalid_response');
  }
  if (value.isError !== undefined && typeof value.isError !== 'boolean') fail('invalid_response');
  strictJson(value, limits.maxResultBytes, 'invalid_response');
  return value as unknown as CallToolResult;
}

function callFailureReason(error: unknown): McpToolFailureReason {
  if (error instanceof McpToolCatalogError) return error.reason;
  if (error instanceof McpError || typeof (error as { code?: unknown })?.code === 'number') return 'json_rpc_error';
  if (error instanceof McpTimeoutError || error instanceof Error && error.name === 'McpTimeoutError') return 'call_timeout';
  if (error instanceof McpAbortError || error instanceof Error && error.name === 'McpAbortError') return 'call_cancelled';
  if (error instanceof McpConnectionClosedError || error instanceof Error && error.name === 'McpConnectionClosedError') return 'connection_closed';
  const code = (error as { code?: unknown })?.code;
  if (code === 'call_timeout') return 'call_timeout';
  if (code === 'call_cancelled') return 'call_cancelled';
  if (code === 'closed' || code === 'server_exited') return 'connection_closed';
  if (code === 'protocol_error' || code === 'process_exited_during_start') return 'response_lost';
  if (error instanceof Error && /response|connection|pipe|socket/i.test(error.name)) return 'response_lost';
  return 'call_failed';
}
/** Private Host assembly only. Endpoints and launch details never become model-facing definitions. */
export async function createMcpToolCatalog(input: {
  readonly plan: McpStartupPlan;
  readonly endpoints: readonly McpToolEndpoint[];
  readonly maxConcurrentCalls?: number;
  readonly limits?: Partial<McpCallLimits>;
}): Promise<McpToolCatalog> {
  const requestedLimits = { ...MCP_CALL_LIMITS, ...(input.limits ?? {}),
    ...(input.maxConcurrentCalls === undefined ? {} : { maxConcurrentCalls: input.maxConcurrentCalls }) };
  for (const value of Object.values(requestedLimits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail('limit_exceeded');
  }
  const limits = requestedLimits;
  const plan = structuredClone(input.plan);
  const names = new Set<string>();
  for (const mapping of plan.tools) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(mapping.piName) || names.has(mapping.piName)) fail('mapping_collision');
    names.add(mapping.piName);
  }
  const entries = new Map<string, { binding: McpToolBinding; tool: DiscoveredTool; fingerprint: string;
    endpoint: McpToolEndpoint; server: McpStartupServerPlan; unavailable?: McpToolFailureReason }>();
  const servers = new Set<string>();
  const fingerprint = (tool: DiscoveredTool) => createHash('sha256').update(stableStringify(tool)).digest('hex');
  for (const endpoint of input.endpoints) {
    const server = plan.servers.find(item => stableStringify(item) === stableStringify(endpoint.server));
    if (!server || servers.has(server.resourceId)) fail('unauthorized_server');
    servers.add(server.resourceId);
    const tools = await discoverEndpoint(endpoint);
    for (const mapping of server.tools) {
      if (!server.allowedTools.includes(mapping.originalName) || mapping.resourceId !== server.resourceId
        || mapping.sourceRef !== server.sourceRef || !plan.tools.some(item => stableStringify(item) === stableStringify(mapping))
        || entries.has(mapping.piName)) fail('invalid_mapping');
      const tool = tools.find(item => item.name === mapping.originalName);
      if (!tool) continue;
      const binding = freeze({ projectId: plan.projectId, sessionId: plan.sessionId, invocationId: plan.invocationId, ...mapping });
      entries.set(mapping.piName, { binding, tool, fingerprint: fingerprint(tool), endpoint, server });
    }
  }
  let activeCalls = 0;
  const dispatch: McpToolCatalog['dispatch'] = async (binding, params, signal, toolCallId = '') => {
    if (typeof toolCallId !== 'string' || Buffer.byteLength(toolCallId) > limits.maxToolCallIdBytes) fail('limit_exceeded');
    const entry = binding && entries.get(binding.piName);
    // Object identity makes mappings opaque: copying or importing one from another Session cannot authorize a call.
    if (!entry || entry.binding !== binding) fail('invalid_mapping');
    if (entry.unavailable) fail(entry.unavailable);
    if (entry.endpoint.isAvailable && !entry.endpoint.isAvailable()) {
      entry.unavailable = 'connection_closed';
      fail(entry.unavailable);
    }
    if (stableStringify(entry.server) !== stableStringify(entry.endpoint.server)) {
      entry.unavailable = 'tool_identity_drift';
      fail(entry.unavailable);
    }
    const args = JSON.parse(json(params, MCP_DISCOVERY_LIMITS.argumentBytes, 'invalid_arguments')) as unknown;
    // Compare original JSON too: undefined/non-finite values cannot be silently converted into valid parameters.
    if (!record(params) || !record(args) || stableStringify(params) !== stableStringify(args)
      || !matches(entry.tool.inputSchema, args)) fail('invalid_arguments');
    if (activeCalls >= limits.maxConcurrentCalls) fail('concurrency_limit');
    activeCalls++;
    const context: McpToolCallContext = freeze({ toolCallId, serverId: binding.resourceId, ...binding });
    try {
      if (entry.endpoint.authorize) {
        try { await entry.endpoint.authorize(binding); }
        catch { fail('unauthorized_call'); }
      }
      let current: readonly DiscoveredTool[];
      try { current = await discoverEndpoint(entry.endpoint, signal); }
      catch (error) {
        const failure = error instanceof McpToolCatalogError ? error : new McpToolCatalogError('discovery_failed');
        entry.unavailable = failure.reason;
        throw failure;
      }
      const tool = current.find(item => item.name === binding.originalName);
      if (!tool || fingerprint(tool) !== entry.fingerprint
        || stableStringify(entry.server) !== stableStringify(entry.endpoint.server)) {
        entry.unavailable = tool ? 'tool_identity_drift' : 'tool_unavailable';
        fail(entry.unavailable);
      }
      // A tool-call id is supplied by the Pi closure below; the placeholder is replaced there.
      try {
        const raw = await entry.endpoint.call(binding.originalName, args, signal, context);
        const result = validateCallResult(raw, limits);
        return {
          content: toLlmContent(result),
          details: result.structuredContent,
          structuredContent: result.structuredContent,
          isError: result.isError === true,
        };
      } catch (error) {
        if (error instanceof McpToolCatalogError) throw error;
        throw new McpToolCatalogError(callFailureReason(error));
      }
    } finally {
      activeCalls--;
    }
  };
  const tools = [...entries.values()].sort((a, b) => a.binding.piName.localeCompare(b.binding.piName)).map(entry => freeze({
    name: entry.binding.piName, label: entry.binding.piName, description: entry.tool.description || 'Approved MCP tool',
    parameters: entry.tool.inputSchema,
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => dispatch(entry.binding, params, signal, toolCallId),
  }));
  return Object.freeze({ tools: Object.freeze(tools), resolve: (name: string) => entries.get(name)?.binding, dispatch });
}
