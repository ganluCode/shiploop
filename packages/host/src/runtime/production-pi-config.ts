import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProductionPiModelOptions {
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly input: readonly ('text' | 'image')[];
  readonly thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;
  readonly compat?: { readonly supportsDeveloperRole: boolean };
}
export interface ProductionPiProvider {
  readonly id: string;
  readonly models: readonly string[];
  readonly custom?: {
    readonly api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
    readonly baseUrl: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly reasoning: boolean;
    readonly compat?: { readonly supportsDeveloperRole: boolean };
    readonly modelOverrides?: Readonly<Record<string, ProductionPiModelOptions>>;
  };
}
export interface ProductionPiConfig {
  readonly schemaVersion: 1;
  readonly providers: readonly ProductionPiProvider[];
  readonly notifications?: { readonly feishu?: { readonly enabled?: boolean;
    readonly notify?: Partial<Record<'task_completed' | 'feature_completed' | 'rate_limited' | 'model_fallback' | 'error_stopped' | 'human_blocked', boolean>> } };
  readonly pi_agent?: {
    readonly transient_retry_attempts?: number;
    readonly transient_retry_backoff_base_seconds?: number;
    readonly fallback_on_connection_exhausted?: boolean;
    readonly fallback_on_server_exhausted?: boolean;
    readonly fallback_on_authentication?: boolean;
  };
  readonly execution?: {
    readonly maxRequests?: number;
    readonly maxInputBytes?: number;
    readonly maxOutputTokens?: number;
    readonly thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    readonly commandTimeoutMs?: number;
    readonly codemode?: boolean;
  };
}

function reject(): never { throw new Error('production_pi_config_invalid'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) reject();
  return object;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)) reject();
  return value;
}
function positive(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) reject();
  return value;
}
function compatibility(value: unknown): { supportsDeveloperRole: boolean } {
  const c = record(value, ['supportsDeveloperRole']);
  if (typeof c.supportsDeveloperRole !== 'boolean') reject();
  return { supportsDeveloperRole: c.supportsDeveloperRole };
}
function modelOptions(value: unknown): ProductionPiModelOptions {
  const m = record(value, ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinkingLevelMap', 'compat']);
  if (typeof m.name !== 'string' || !m.name || m.name.length > 256 || /[\r\n\0]/.test(m.name)
    || typeof m.reasoning !== 'boolean' || !Array.isArray(m.input) || !m.input.length || m.input.length > 2
    || new Set(m.input).size !== m.input.length || m.input.some(v => v !== 'text' && v !== 'image')) reject();
  const contextWindow = positive(m.contextWindow, 2_000_000), maxTokens = positive(m.maxTokens, contextWindow);
  let thinkingLevelMap: ProductionPiModelOptions['thinkingLevelMap'];
  if (m.thinkingLevelMap !== undefined) {
    const map = record(m.thinkingLevelMap, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (Object.values(map).some(v => v !== null && (typeof v !== 'string' || v.length > 128 || /[\r\n\0]/.test(v)))) reject();
    thinkingLevelMap = { ...map } as ProductionPiModelOptions['thinkingLevelMap'];
  }
  return { name: m.name, contextWindow, maxTokens, reasoning: m.reasoning, input: m.input as ('text' | 'image')[],
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(m.compat === undefined ? {} : { compat: compatibility(m.compat) }) };
}
export function parseProductionPiConfig(value: unknown): ProductionPiConfig {
  const raw = record(value, ['schemaVersion', 'providers', 'pi_agent', 'execution', 'notifications']);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.providers) || raw.providers.length < 1 || raw.providers.length > 32) reject();
  const providers = raw.providers.map(value => {
    const p = record(value, ['id', 'models', 'custom']);
    const id = identifier(p.id);
    if (id === 'openai-codex' && p.custom !== undefined) reject();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) reject();
    if (!Array.isArray(p.models) || p.models.length < 1 || p.models.length > 128) reject();
    const models = p.models.map(identifier);
    if (new Set(models).size !== models.length) reject();
    if (p.custom === undefined) return { id, models };
    const c = record(p.custom, ['api', 'baseUrl', 'contextWindow', 'maxTokens', 'reasoning', 'compat', 'modelOverrides']);
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(String(c.api))
      || typeof c.baseUrl !== 'string' || typeof c.reasoning !== 'boolean') reject();
    let endpoint: URL;
    try { endpoint = new URL(c.baseUrl); } catch { return reject(); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'))) reject();
    const contextWindow = positive(c.contextWindow, 2_000_000), maxTokens = positive(c.maxTokens, contextWindow);
    let modelOverrides: Record<string, ProductionPiModelOptions> | undefined;
    if (c.modelOverrides !== undefined) {
      const overrides = record(c.modelOverrides, models);
      modelOverrides = Object.fromEntries(Object.entries(overrides).map(([id, value]) => [id, modelOptions(value)]));
    }
    return { id, models, custom: { api: c.api as NonNullable<ProductionPiProvider['custom']>['api'],
      baseUrl: c.baseUrl, contextWindow, maxTokens, reasoning: c.reasoning,
      ...(c.compat === undefined ? {} : { compat: compatibility(c.compat) }),
      ...(modelOverrides === undefined ? {} : { modelOverrides }) } };
  });
  if (new Set(providers.map(p => p.id)).size !== providers.length) reject();
  let pi_agent: ProductionPiConfig['pi_agent'];
  if (raw.pi_agent !== undefined) {
    const p = record(raw.pi_agent, ['transient_retry_attempts', 'transient_retry_backoff_base_seconds',
      'fallback_on_connection_exhausted', 'fallback_on_server_exhausted', 'fallback_on_authentication']);
    if (p.transient_retry_attempts !== undefined && (!Number.isSafeInteger(p.transient_retry_attempts)
      || Number(p.transient_retry_attempts) < 0 || Number(p.transient_retry_attempts) > 10)) reject();
    if (p.transient_retry_backoff_base_seconds !== undefined) positive(p.transient_retry_backoff_base_seconds, 60);
    for (const key of ['fallback_on_connection_exhausted', 'fallback_on_server_exhausted', 'fallback_on_authentication']) {
      if (p[key] !== undefined && typeof p[key] !== 'boolean') reject();
    }
    pi_agent = { ...p };
  }
  let execution: ProductionPiConfig['execution'];
  if (raw.execution !== undefined) {
    const p = record(raw.execution, ['maxRequests', 'maxInputBytes', 'maxOutputTokens', 'thinkingLevel', 'commandTimeoutMs', 'codemode']);
    for (const [key, maximum] of [['maxRequests', 10000], ['maxInputBytes', 8388608],
      ['maxOutputTokens', 1000000], ['commandTimeoutMs', 3600000]] as const) {
      if (p[key] !== undefined) positive(p[key], maximum);
    }
    if (p.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(p.thinkingLevel))) reject();
    if (p.codemode !== undefined && typeof p.codemode !== 'boolean') reject();
    execution = { ...p };
  }
  let notifications: ProductionPiConfig['notifications'];
  if (raw.notifications !== undefined) {
    const n = record(raw.notifications, ['feishu']);
    if (n.feishu !== undefined) {
      const f = record(n.feishu, ['enabled', 'notify']);
      if (f.enabled !== undefined && typeof f.enabled !== 'boolean') reject();
      if (f.notify !== undefined) {
        const switches = record(f.notify, ['task_completed', 'feature_completed', 'rate_limited', 'model_fallback', 'error_stopped', 'human_blocked']);
        if (Object.values(switches).some(v => typeof v !== 'boolean')) reject();
      }
    }
    notifications = n;
  }
  return { schemaVersion: 1, providers, ...(notifications === undefined ? {} : { notifications }), ...(pi_agent === undefined ? {} : { pi_agent }),
    ...(execution === undefined ? {} : { execution }) };
}

/** Exact per-model metadata; pricing is intentionally unknown for operator-defined providers. */
export function productionPiModel(provider: ProductionPiProvider, id: string) {
  if (!provider.models.includes(id) || !provider.custom) reject();
  const c = provider.custom;
  const override = c.modelOverrides && Object.hasOwn(c.modelOverrides, id) ? c.modelOverrides[id] : undefined;
  return { id, name: override?.name ?? id, input: [...(override?.input ?? ['text'] as const)],
    reasoning: override?.reasoning ?? c.reasoning, contextWindow: override?.contextWindow ?? c.contextWindow,
    maxTokens: override?.maxTokens ?? c.maxTokens,
    ...(override?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: override.thinkingLevelMap }),
    ...(c.compat === undefined && override?.compat === undefined ? {} : { compat: { ...c.compat, ...override?.compat } }),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

/** Operator-owned files only; no global Pi discovery, symlink traversal or secret interpolation. */
export function readPrivatePiJson(dataRoot: string, name: 'runtime.json' | 'auth.json'): unknown | undefined {
  const dir = join(dataRoot, 'pi'), dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat) return undefined;
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o022) !== 0) {
    throw new Error('production_pi_config_directory');
  }
  const path = join(dir, name);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('production_pi_config_unreadable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('production_pi_config_permissions');
    }
    try { return JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw new Error('production_pi_config_invalid'); }
  } finally { closeSync(fd); }
}
export function readProductionPiConfig(dataRoot: string): ProductionPiConfig | undefined {
  const raw = readPrivatePiJson(dataRoot, 'runtime.json');
  return raw === undefined ? undefined : parseProductionPiConfig(raw);
}

export function readProductionPiKey(dataRoot: string, provider: string): string {
  const raw = readPrivatePiJson(dataRoot, 'auth.json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, provider)) {
    throw new Error('production_pi_auth_missing');
  }
  const auth = record((raw as Record<string, unknown>)[provider], ['type', 'key']);
  if (auth.type !== 'api_key' || typeof auth.key !== 'string' || !auth.key.trim() || auth.key.length > 16_384
    || /^[!$]/.test(auth.key) || /[\r\n\0]/.test(auth.key)) throw new Error('production_pi_auth_invalid');
  return auth.key;
}

export function validateProductionPiCredential(provider: string, value: unknown): import('@earendil-works/pi-ai').Credential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('production_pi_auth_invalid');
  const raw = value as Record<string, unknown>;
  const token = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !/[\r\n\0]/.test(v);
  if (raw.type === 'api_key') {
    if (provider === 'openai-codex' || Object.keys(raw).some(k => !['type', 'key'].includes(k))
      || !token(raw.key) || !(raw.key as string).trim() || /^[!$]/.test(raw.key as string)) throw new Error('production_pi_auth_invalid');
    return { type: 'api_key', key: raw.key as string };
  }
  if (provider !== 'openai-codex' || raw.type !== 'oauth'
    || Object.keys(raw).some(k => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(k))
    || !token(raw.access) || !token(raw.refresh) || !token(raw.accountId)
    || !Number.isSafeInteger(raw.expires) || Number(raw.expires) < 0 || Number(raw.expires) > 8640000000000000) throw new Error('production_pi_auth_invalid');
  return { type: 'oauth', access: raw.access as string, refresh: raw.refresh as string,
    expires: raw.expires as number, accountId: raw.accountId };
}

export function readProductionPiCredential(dataRoot: string, provider: string): import('@earendil-works/pi-ai').Credential {
  const raw = readPrivatePiJson(dataRoot, 'auth.json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, provider)) {
    throw new Error('production_pi_auth_missing');
  }
  return validateProductionPiCredential(provider, (raw as Record<string, unknown>)[provider]);
}
