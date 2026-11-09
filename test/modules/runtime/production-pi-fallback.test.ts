import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { beforeAll, expect, it } from 'vitest';
import { createProductionPiFallback } from '../../../packages/host/src/runtime/production-pi-fallback.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { decideRuntimeFallback } from '../../../packages/core/src/application/runtime-fallback.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { openBindingFixture, BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';

beforeAll(() => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: root, timeout: 60000 });
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'packages/core/tsconfig.json', 'packages/host/tsconfig.json'], { cwd: root, timeout: 60000 });
}, 65000);

const strategy = (model: string) => ({ runtime: 'pi', provider: 'offline', model, credentialRef: 'credential://pi/offline' });

it('accepts stored Codex OAuth for fallback without refreshing or networking', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-oauth-fallback-')));
  try {
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ 'openai-codex': {
      type: 'oauth', access: 'offline', refresh: 'offline-refresh', expires: 1, accountId: 'account',
    } }), { mode: 0o600 });
    const config = { schemaVersion: 1 as const, providers: [{ id: 'openai-codex', models: ['model'] }] };
    const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: [{ providerId: 'openai-codex', models: ['model'] }] }]);
    const routing = createProductionPiFallback({ dataRoot: root, config, catalog, descriptor: catalog.resolve('pi') });
    expect(await routing.authorize({ projectId: 'p', runId: 'r', taskId: 't', source: 'task.fallback.1',
      strategy: { runtime: 'pi', provider: 'openai-codex', model: 'model', credentialRef: 'credential://pi/openai-codex' } })).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('有序备用链、连接未耗尽不切换，新的 Task 重新首选；无备用保持原行为', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-fallback-policy-')));
  try {
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ offline: { type: 'api_key', key: 'offline-key' } }), { mode: 0o600 });
    const config = { schemaVersion: 1 as const, providers: [{ id: 'offline', models: ['primary', 'second', 'third'] }] };
    const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: [{ providerId: 'offline', models: config.providers[0].models }] }]);
    const adapter = createProductionPiFallback({ dataRoot: root, config, catalog, descriptor: catalog.resolve('pi') });
    const input = { projectId: 'p', runId: 'r', taskId: 't', strategy: strategy('primary'), routing: { fallbacks: [strategy('second'), strategy('third')] } };
    const route = adapter.select(input)!;
    expect(await adapter.authorize({ ...input, source: 'task.fallback.1', strategy: strategy('second') })).toBe(true);
    expect(decideRuntimeFallback({ plan: route.plan, failure: { category: 'quota_blocked', reason: 'rate_limit' }, nowUtcMs: Date.now(), capabilities: catalog }))
      .toMatchObject({ mode: 'switch', strategySnapshot: strategy('second') });
    expect(decideRuntimeFallback({ plan: route.plan, failure: { category: 'transient_connection', reason: 'connection' },
      sameAttemptRetryExhausted: false, nowUtcMs: Date.now(), capabilities: catalog })).toMatchObject({ mode: 'stop', stopReason: 'same_attempt_retry_not_exhausted' });
    expect(adapter.select({ ...input, taskId: 'next' })!.plan.preferred.strategy).toEqual(strategy('primary'));
    expect(adapter.select({ ...input, routing: undefined })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('真实 SDK 遇本机模拟 429 后，Core 确认旧 Runner 停止再持久切换备用，不修改 Task 默认副本', async () => {
  const built = await import(new URL('../../../packages/host/dist/runtime/production-pi.js', import.meta.url).href);
  const factory = built.productionPiOptions as typeof import('../../../packages/host/src/runtime/production-pi.js').productionPiOptions;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-fallback-work-')));
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', bytes => chunks.push(bytes));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body.model);
      if (body.model === 'primary') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' } })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: 'chat-fallback', object: 'chat.completion.chunk',
        created: 1, model: 'backup', choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`);
      event({ role: 'assistant', content: '本机模拟完成，不代表代码验收通过。' }, null); event({}, 'stop'); res.end('data: [DONE]\n\n');
    });
  });
  let binding: Awaited<ReturnType<typeof openBindingFixture>> | undefined;
  let core: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ offline: { type: 'api_key', key: 'offline-key' } }), { mode: 0o600 });
    writeFileSync(join(root, 'pi/runtime.json'), JSON.stringify({ schemaVersion: 1, providers: [{ id: 'offline', models: ['primary', 'backup'],
      custom: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32000, maxTokens: 4096, reasoning: false } }] }), { mode: 0o600 });
    const options = await factory(root);
    const frozen = { ...strategy('primary'), fallbacks: [strategy('backup')] };
    binding = await openBindingFixture({ strategy: frozen, capabilityCatalog: options.capabilityCatalog, confirmProjectProfile: true });
    core = await openCoreApplication({ dataRoot: binding.box.dataRoot, capabilityCatalog: options.capabilityCatalog,
      workRuntimeFactory: options.workRuntimeFactory, nowUtcMs: () => BINDING_NOW });
    await core.workExecution.scan();
    try { await expect.poll(() => calls, { timeout: 12000 }).toEqual(['primary', 'backup']); }
    catch (error) {
      const attempts = binding.session.database.prepare('SELECT id, status, error_kind FROM attempts ORDER BY number').all() as { id: string }[];
      const details = await Promise.all(attempts.map(row => core!.queryService.getWorkSession(createLocalOwnerPrincipal(), { projectId: binding!.projectId, attemptId: row.id })));
      throw new Error(JSON.stringify({ calls, run: binding.query('SELECT status, reason FROM runs'), attempts, details }), { cause: error });
    }
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 15000 }).toEqual([]);
    expect(binding.session.database.prepare('SELECT status FROM attempts ORDER BY number').all()).toEqual([
      { status: 'failed' }, { status: 'verifying' },
    ]);
    const rows = binding.session.database.prepare('SELECT input_snapshot FROM attempts ORDER BY number').all() as { input_snapshot: string }[];
    expect(JSON.parse(rows[1].input_snapshot).runtimeFallback).toMatchObject({ strategy: strategy('backup'), previousFailures: [{ category: 'quota_blocked' }] });
    const task = binding.query('SELECT execution_config FROM tasks WHERE id = ?', 't-1') as { execution_config: string };
    expect(JSON.parse(task.execution_config)).toMatchObject(frozen);
  } finally {
    if (core) { await core.workExecution.close(); core.close(); }
    binding?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
}, 65000);
