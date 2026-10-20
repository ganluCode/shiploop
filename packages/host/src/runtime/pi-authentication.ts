/** Explicit Pi auth sources. No HOME discovery, credential commands, refresh or model requests. */
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { WorkAuthenticationSourceError } from 'shiploop-core';
import type {
  WorkAuthenticationSource, WorkAuthenticationState, WorkAuthenticationPreflightDependencies,
  WorkAuthenticationCatalog,
} from 'shiploop-core';
import { PI_SDK_VERSION } from './pi-adapter.js';

export const PI_AUTHENTICATION_MAX_FILE_BYTES = 65_536;
export const PI_AUTHENTICATION_MAX_KEY_BYTES = 16_384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function literalKey(value: unknown): WorkAuthenticationState {
  if (typeof value !== 'string' || value.trim() === '') return 'missing';
  if (Buffer.byteLength(value, 'utf8') > PI_AUTHENTICATION_MAX_KEY_BYTES) throw new WorkAuthenticationSourceError('input_limit');
  // Resolving commands or environment interpolation requires a separate approved reference.
  if (/^[!$]/.test(value) || /[\r\n\0]/.test(value)) throw new WorkAuthenticationSourceError('credential_reference_unsupported');
  return 'ready';
}
function credentialState(value: unknown, nowUtcMs: number): WorkAuthenticationState {
  if (value === undefined) return 'missing';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const credential = value as Record<string, unknown>;
  if (credential.type === 'api_key') {
    // Provider-scoped environment requires separately approved reference mapping.
    if (credential.env !== undefined) throw new WorkAuthenticationSourceError('credential_reference_unsupported');
    return literalKey(credential.key);
  }
  if (credential.type !== 'oauth' || typeof credential.expires !== 'number'
    || !Number.isSafeInteger(credential.expires) || credential.expires < 0
    || typeof credential.access !== 'string' || !credential.access.trim()
    || typeof credential.refresh !== 'string' || !credential.refresh.trim()) return 'invalid';
  if (literalKey(credential.access) !== 'ready' || literalKey(credential.refresh) !== 'ready') return 'invalid';
  return credential.expires <= nowUtcMs ? 'expired' : 'ready';
}

/** Path is registered by trusted Host code under a source UUID, never supplied by a model/request. */
export function createPiLocalLoginAuthenticationSource(options: {
  readonly provider: string;
  readonly authPath: string;
}): WorkAuthenticationSource {
  if (!isAbsolute(options.authPath)) throw new Error('Pi authentication requires an explicit absolute path');
  const { provider, authPath } = options;
  return Object.freeze({
    kind: 'local_login', provider, environmentRefs: Object.freeze([]),
    async inspect({ nowUtcMs, signal }) {
      signal.throwIfAborted();
      try {
        // SDK write/lock permission is checked separately from permission to request inference.
        await access(dirname(authPath), constants.R_OK | constants.W_OK | constants.X_OK);
        const file = await open(authPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          signal.throwIfAborted();
          const stat = await file.stat();
          if (!stat.isFile()) throw new WorkAuthenticationSourceError('authentication_directory_denied');
          if (stat.size > PI_AUTHENTICATION_MAX_FILE_BYTES) throw new WorkAuthenticationSourceError('input_limit');
          await access(authPath, constants.R_OK | constants.W_OK);
          const bytes = Buffer.alloc(PI_AUTHENTICATION_MAX_FILE_BYTES + 1);
          let size = 0;
          try {
            while (size < bytes.length) {
              signal.throwIfAborted();
              const read = await file.read(bytes, size, bytes.length - size, size);
              if (read.bytesRead === 0) break;
              size += read.bytesRead;
            }
            if (size > PI_AUTHENTICATION_MAX_FILE_BYTES) throw new WorkAuthenticationSourceError('input_limit');
            signal.throwIfAborted();
            let parsed: unknown;
            try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)).replace(/^\uFEFF/, '')); }
            catch { return 'invalid'; }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
            // Only the selected provider is interpreted; other entries are never resolved.
            return credentialState(Object.hasOwn(parsed, provider) ? (parsed as Record<string, unknown>)[provider] : undefined, nowUtcMs);
          } finally { bytes.fill(0); }
        } finally { await file.close(); }
      } catch (error) {
        if (error instanceof WorkAuthenticationSourceError) throw error;
        if (signal.aborted) throw new Error('Pi authentication cancelled');
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw new WorkAuthenticationSourceError('authentication_directory_denied');
      }
    },
  } satisfies WorkAuthenticationSource);
}

/** Reads exactly one approved variable; no Object.entries(process.env), inherited env, or fallback. */
export function createPiEnvironmentAuthenticationSource(options: {
  readonly provider: string; readonly environmentRef: string; readonly variableName: string;
  readonly readVariable?: (name: string) => string | undefined;
}): WorkAuthenticationSource {
  if (!UUID.test(options.environmentRef) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(options.variableName)
    || /OWNER|SHIPLOOP|NEZHA|^HOME$|^PATH$|^NODE_|^PI_/.test(options.variableName)) {
    throw new Error('Pi authentication environment reference rejected');
  }
  const { provider, environmentRef, variableName } = options;
  const read = options.readVariable ?? ((name: string) => process.env[name]);
  return Object.freeze({
    kind: 'environment', provider, environmentRefs: Object.freeze([environmentRef]),
    async inspect({ signal }) {
      signal.throwIfAborted();
      return literalKey(read(variableName));
    },
  } satisfies WorkAuthenticationSource);
}

/**
 * Offline pinned catalog. Builtin lookup performs no ModelRuntime creation, auth resolution,
 * models.json discovery, remote catalog refresh or inference. Plugins must already be loaded
 * by trusted selective assembly; inventory callbacks must report actual loaded versions.
 */
export function createPiAuthenticationCatalog(options: {
  readonly inspectPlugin?: (id: string, signal: AbortSignal) => Promise<{
    readonly id: string; readonly sourceRef: string; readonly version: string; readonly contentDigest: string | null;
    readonly provider: string; readonly models: readonly string[];
  } | undefined>;
} = {}): WorkAuthenticationPreflightDependencies['catalog'] {
  return async (manifest, signal) => {
    signal.throwIfAborted();
    const { VERSION } = await import('@earendil-works/pi-coding-agent');
    if (VERSION !== PI_SDK_VERSION) return { sdkVersion: VERSION, providerExists: false, modelExists: false, plugins: [] };
    const { getBuiltinProviders, getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
    signal.throwIfAborted();
    const providerId = manifest.access.provider;
    const builtin = getBuiltinProviders().find(id => id === providerId);
    let providerExists = builtin !== undefined;
    let modelExists = builtin !== undefined && getBuiltinModels(builtin).some(model => model.id === manifest.access.model);
    const plugins: WorkAuthenticationCatalog['plugins'][number][] = [];
    for (const resource of manifest.access.resources.filter(r => r.kind === 'auth_plugin')) {
      const plugin = await options.inspectPlugin?.(resource.id, signal);
      signal.throwIfAborted();
      if (!plugin) continue;
      plugins.push({ id: plugin.id, sourceRef: plugin.sourceRef, version: plugin.version, contentDigest: plugin.contentDigest });
      if (plugin.provider === providerId) {
        providerExists = true;
        modelExists = plugin.models.includes(manifest.access.model);
      }
    }
    return { sdkVersion: VERSION, providerExists, modelExists, plugins };
  };
}
