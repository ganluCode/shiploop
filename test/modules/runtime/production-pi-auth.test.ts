import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createProductionCredentialStore, providerAuthStatus, loginProductionProvider, logoutProductionProvider } from '../../../packages/host/src/runtime/production-pi-auth.ts';
import { createModels, createProvider, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

const oauth = (n = 0) => ({ type: 'oauth' as const, access: 'access-' + n, refresh: 'refresh-' + n, expires: Date.now() + 3600000, accountId: 'account' });
beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'packages/core/tsconfig.json', 'packages/host/tsconfig.json'],
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 60000 });
}, 65000);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-oauth-')));
  mkdirSync(join(root, 'pi'), { mode: 0o700 });
  return { root, auth: join(root, 'pi/auth.json'), close() { rmSync(root, { recursive: true, force: true }); } };
}

it('status is read-only, missing credentials do not create files or resolve auth', async () => {
  const f = fixture();
  try {
    expect(await providerAuthStatus(f.root, 'openai-codex')).toMatchObject({ provider: 'openai-codex', status: 'not_configured', configured: false });
    expect(() => statSync(f.auth)).toThrow();
    await expect(loginProductionProvider(f.root, 'other', {} as never)).rejects.toThrow('provider_oauth_unsupported');
  } finally { f.close(); }
});

it('persists SDK login privately, preserves API/Feishu entries and logs out only the requested account', async () => {
  const f = fixture();
  const other = { p: { type: 'api_key', key: 'private-key' }, feishu: { type: 'webhook', url: 'private-webhook' } };
  const credential = oauth();
  try {
    writeFileSync(f.auth, JSON.stringify(other), { mode: 0o600 });
    const result = await loginProductionProvider(f.root, 'openai-codex', {} as never, { login: async () => credential });
    expect(result).toMatchObject({ provider: 'openai-codex', status: 'ready', type: 'oauth' });
    expect(JSON.stringify(result)).not.toMatch(/access-0|refresh-0|private-key/);
    expect(statSync(f.auth).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))).toEqual({ ...other, 'openai-codex': credential });
    await logoutProductionProvider(f.root, 'openai-codex');
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))).toEqual(other);
    expect(await providerAuthStatus(f.root, 'openai-codex')).toMatchObject({ status: 'not_configured' });
  } finally { f.close(); }
});

it('serializes OAuth refresh across independent stores and persists the rotated credential before the next reader', async () => {
  const f = fixture();
  try {
    writeFileSync(f.auth, JSON.stringify({ 'openai-codex': { ...oauth(), expires: 1 } }), { mode: 0o600 });
    let refreshes = 0;
    const provider = createProvider({ id: 'openai-codex', name: 'offline', models: [], auth: { oauth: {
      name: 'test', login: async () => oauth(),
      refresh: async () => { refreshes++; await new Promise(r => setTimeout(r, 15)); return oauth(1); },
      toAuth: async (c: ReturnType<typeof oauth>) => ({ apiKey: c.access }),
    } }, api: { stream: () => { throw new Error('must_not_send_model_request'); }, streamSimple: () => { throw new Error('must_not_send_model_request'); } } });
    const first = createModels({ credentials: createProductionCredentialStore(f.root), modelsStore: new InMemoryModelsStore() });
    const second = createModels({ credentials: createProductionCredentialStore(f.root), modelsStore: new InMemoryModelsStore() });
    first.setProvider(provider); second.setProvider(provider);
    const values = await Promise.all([first.getAuth('openai-codex'), second.getAuth('openai-codex')]);
    expect(refreshes).toBe(1);
    expect(values.map(v => v?.auth.apiKey)).toEqual(['access-1', 'access-1']);
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))['openai-codex'].refresh).toBe('refresh-1');
  } finally { f.close(); }
});

it('rejects unsafe credential paths and invalid OAuth without overwriting unrelated state', async () => {
  const f = fixture();
  try {
    writeFileSync(f.auth, '{}', { mode: 0o600 });
    chmodSync(f.auth, 0o644);
    await expect(providerAuthStatus(f.root, 'openai-codex')).rejects.toThrow();
    chmodSync(f.auth, 0o600);
    const store = createProductionCredentialStore(f.root);
    await expect(store.modify('p', async () => oauth())).rejects.toThrow();
    await expect(store.modify('openai-codex', async () => ({ ...oauth(), expires: NaN }))).rejects.toThrow();
    expect(readFileSync(f.auth, 'utf8')).toBe('{}');
    rmSync(f.auth); symlinkSync(join(f.root, 'outside'), f.auth);
    await expect(store.read('openai-codex')).rejects.toThrow();
  } finally { f.close(); }
});

it('builtin Codex SDK uses the subscription access token on SSE without any external request', async () => {
  const f = fixture();
  try {
    const access = Buffer.from('{}').toString('base64') + '.' + Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' },
    })).toString('base64') + '.signature';
    writeFileSync(f.auth, JSON.stringify({ 'openai-codex': { ...oauth(), access } }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ credentials: createProductionCredentialStore(f.root),
      modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', getBuiltinModels('openai-codex')[0]!.id)!;
    let calls = 0;
    const message = await runtime.streamSimple(model, {
      messages: [{ role: 'user', content: 'offline', timestamp: Date.now() }],
    }, { transport: 'sse', maxRetries: 0, fetch: async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + access);
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('offline-account');
      const item = { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'offline', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'r-1' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.content_part.added', item_id: 'msg-1', content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'offline' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'r-1', status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ];
      return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    } }).result();
    expect(calls).toBe(1);
    expect(message.stopReason, JSON.stringify(message)).toBe('stop');
    expect(message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'offline' })]));
    expect(message.usage.input).toBe(10);
  } finally { f.close(); }
});

it('cancellation waits for lock acquisition but never discards an already rotated token', async () => {
  const f = fixture();
  try {
    const store = createProductionCredentialStore(f.root);
    await store.modify('openai-codex', async () => oauth());
    const stop = new AbortController();
    await store.modify('openai-codex', async () => { stop.abort(); return oauth(2); }, { signal: stop.signal });
    expect((await store.read('openai-codex'))?.type).toBe('oauth');
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))['openai-codex'].refresh).toBe('refresh-2');
    await expect(store.modify('openai-codex', async () => oauth(3), { signal: stop.signal })).rejects.toThrow();
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))['openai-codex'].refresh).toBe('refresh-2');
  } finally { f.close(); }
});

it('serializes real child-process writers and releases the OS lock after process exit', async () => {
  const f = fixture();
  try {
    await createProductionCredentialStore(f.root).modify('openai-codex', async () => oauth());
    const module = new URL('../../../packages/host/dist/runtime/production-pi-auth.js', import.meta.url).href;
    const script = `import {createProductionCredentialStore} from ${JSON.stringify(module)};
      const store=createProductionCredentialStore(process.argv[1]);
      await store.modify('openai-codex',async current=>{
        const n=Number(current.access.split('-').at(-1))+1;
        await new Promise(resolve=>setTimeout(resolve,75));
        return {...current,access:'access-'+n,refresh:'refresh-'+n};
      });`;
    const run = promisify(execFile);
    await Promise.all([run(process.execPath, ['--input-type=module', '-e', script, f.root]),
      run(process.execPath, ['--input-type=module', '-e', script, f.root])]);
    expect(JSON.parse(readFileSync(f.auth, 'utf8'))['openai-codex'].access).toBe('access-2');
    await logoutProductionProvider(f.root, 'openai-codex');
    expect(await providerAuthStatus(f.root, 'openai-codex')).toMatchObject({ status: 'not_configured' });
  } finally { f.close(); }
}, 20000);
