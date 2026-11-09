import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fsyncSync, writeFileSync, renameSync, rmSync, realpathSync, lstatSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { AuthInteraction, Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import { acquirePrivateFileLock } from '../locking/writer-lock.js';
import { readPrivatePiJson, readProductionPiConfig, validateProductionPiCredential } from './production-pi-config.js';

function providerId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new Error('provider_auth_invalid_provider');
}
function oauthProvider(provider: string): void {
  if (provider !== 'openai-codex') throw new Error('provider_oauth_unsupported');
}
function checkRoot(root: string): void {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('provider_auth_root_invalid');
}
function authObject(root: string): Record<string, unknown> {
  const value = readPrivatePiJson(root, 'auth.json');
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('production_pi_auth_invalid');
  return value as Record<string, unknown>;
}
function prepareDirectory(root: string): string {
  checkRoot(root);
  const dir = join(root, 'pi');
  if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { mode: 0o700 });
  // Reuse strict ownership/symlink checks even when auth.json does not exist.
  authObject(root);
  return dir;
}
function atomicAuth(root: string, data: Record<string, unknown>): void {
  const dir = prepareDirectory(root), path = join(dir, 'auth.json'), temporary = join(dir, '.auth-' + randomUUID());
  const text = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(text) > 65536) throw new Error('production_pi_auth_limit');
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, text, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    authObject(root);
    renameSync(temporary, path);
    const directory = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

/** App-owned storage; SDK refresh executes under a real cross-process OS lock. */
export function createProductionCredentialStore(root: string, onCredential?: (credential: Credential) => void): CredentialStore {
  checkRoot(root);
  const read = (provider: string) => {
    providerId(provider);
    const data = authObject(root);
    if (!Object.hasOwn(data, provider)) return undefined;
    const credential = validateProductionPiCredential(provider, data[provider]);
    onCredential?.(credential);
    return credential;
  };
  async function write(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    remove: boolean, signal?: AbortSignal): Promise<Credential | undefined> {
    providerId(provider);
    const dir = prepareDirectory(root);
    const release = await acquirePrivateFileLock(join(dir, 'auth.lock'), signal);
    try {
      signal?.throwIfAborted();
      const current = read(provider);
      // Once token rotation starts, cancellation must not discard the newly rotated token.
      const next = remove ? undefined : await fn(current);
      if (!remove && next === undefined) return current;
      const data = authObject(root);
      if (remove) delete data[provider];
      else {
        const checked = validateProductionPiCredential(provider, next);
        onCredential?.(checked);
        data[provider] = checked;
      }
      atomicAuth(root, data);
      return remove ? undefined : validateProductionPiCredential(provider, data[provider]);
    } finally { release(); }
  }
  return {
    async read(provider, options) { options?.signal?.throwIfAborted(); return read(provider); },
    async list(options) {
      options?.signal?.throwIfAborted();
      return Object.keys(authObject(root)).filter(id => id !== 'feishu').map(id => ({ providerId: id, type: read(id)!.type }));
    },
    modify(provider, fn, options) { return write(provider, fn, false, options?.signal); },
    async delete(provider, options) { await write(provider, async () => undefined, true, options?.signal); },
  };
}

export interface ProviderAuthStatus {
  readonly provider: string;
  readonly configured: boolean;
  readonly status: 'not_configured' | 'ready' | 'refresh_required';
  readonly type?: 'oauth' | 'api_key';
  readonly expiresAt?: string;
  readonly verifiedOnline: false;
}
export async function providerAuthStatus(root: string, provider: string): Promise<ProviderAuthStatus> {
  oauthProvider(provider);
  const credential = await createProductionCredentialStore(root).read(provider);
  if (!credential) return { provider, configured: false, status: 'not_configured', verifiedOnline: false };
  return { provider, configured: true, type: credential.type, verifiedOnline: false,
    status: credential.type === 'oauth' && credential.expires <= Date.now() + 300000 ? 'refresh_required' : 'ready',
    ...(credential.type === 'oauth' ? { expiresAt: new Date(credential.expires).toISOString() } : {}) };
}

export async function loginProductionProvider(root: string, provider: string, interaction: AuthInteraction,
  flow?: { login(interaction: AuthInteraction): Promise<OAuthCredential> }): Promise<ProviderAuthStatus> {
  oauthProvider(provider); checkRoot(root);
  await createProductionCredentialStore(root).read(provider);
  if (process.env.PI_OAUTH_CALLBACK_HOST && process.env.PI_OAUTH_CALLBACK_HOST !== '127.0.0.1') {
    throw new Error('provider_auth_callback_host_rejected');
  }
  const signal = interaction.signal ?? AbortSignal.timeout(15 * 60 * 1000);
  const sdk = flow ? undefined : await import('@earendil-works/pi-ai/providers/openai-codex');
  const credential = await (flow ? flow.login({ ...interaction, signal })
    : sdk!.openaiCodexProvider().auth.oauth!.login({ ...interaction, signal }, { agentName: 'ShipLoop' }));
  signal.throwIfAborted();
  await createProductionCredentialStore(root).modify(provider, async () => credential, { signal });
  return providerAuthStatus(root, provider);
}
export async function logoutProductionProvider(root: string, provider: string): Promise<void> {
  oauthProvider(provider);
  const store = createProductionCredentialStore(root);
  if (await store.read(provider)) await store.delete(provider);
}
export async function productionProviderModels(root: string, provider: string) {
  oauthProvider(provider); checkRoot(root);
  const { getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
  const enabled = readProductionPiConfig(root)?.providers.find(p => p.id === provider);
  return { provider, models: getBuiltinModels('openai-codex').map(model => ({
    id: model.id, name: model.name, enabled: enabled?.models.includes(model.id) ?? false,
  })) };
}
