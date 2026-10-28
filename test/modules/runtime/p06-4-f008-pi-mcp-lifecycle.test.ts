import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle } from '../../../packages/core/src/ports/command-process.ts';
import type { McpStdioProcessRegistration } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { createPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import type { PiSessionFactoryOptions, PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { mcpWorkFixture, MCP_WORK_PROJECT } from '../../helpers/p06-4/pi-mcp-fixture.ts';
import { ScriptedPiSession } from '../../helpers/p04-1/pi-adapter-fixture.ts';
import { processRows, until } from '../../helpers/process-matrix.ts';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function expectStopped(f: Awaited<ReturnType<typeof mcpWorkFixture>>) {
  for (const reg of f.registrations) expect(f.registry.list(reg)).toEqual([]);
  const rows = await processRows();
  for (const reg of f.registrations) expect(rows.some(row => row.processGroupId === reg.processIdentity.processGroupId)).toBe(false);
}

it.each(['input', 'cwd', 'recovery', 'factory', 'subscribe', 'manifest'] as const)(
  '[case:startup-cleanup-%s] cleans MCP acquired before a later startup failure without sending a prompt', async stage => {
    const f = await mcpWorkFixture();
    const prompt = vi.fn(async () => {}), dispose = vi.fn();
    try {
      const overrides: Partial<PiTrustedAssembly> = {
        ...(stage === 'input' ? { inputReader: { read: async () => { throw new Error('broken input'); } } } : {}),
        ...(stage === 'cwd' ? { resolveWorkingDirectory: () => { throw new Error('broken cwd'); } } : {}),
        ...(stage === 'recovery' ? { recoverySourceManager: { acquire: async () => { throw new Error('source still active'); } } } : {}),
        ...(stage === 'manifest' ? { mcp: { ...f.assembly.mcp!, recordManifest: async () => { throw new Error('evidence write failed'); } } } : {}),
      };
      const request = stage === 'recovery' ? { ...f.request, recovery: { mode: 'auto' as const, kind: 'conversation' as const,
        source: { schemaVersion: 1 as const, purpose: 'work' as const, kind: 'conversation' as const,
          sourceProjectId: MCP_WORK_PROJECT, sourceSessionId: 'old-session', sourceTaskId: 'task-1', sourceAttemptId: 'old-attempt',
          runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5', providerSessionId: 'old-provider',
          nativeArchiveRef: 'archive-old', nativeFormat: 'pi-jsonl', nativeFormatVersion: '3', sourceDigest: 'a'.repeat(64) } } } : f.request;
      await expect(f.adapter(async () => {
        if (stage === 'factory') throw new Error('session creation failed');
        return { prompt, dispose, abort: async () => {}, subscribe: () => { throw new Error('SDK subscribe failed'); } };
      }, overrides).start(request)).rejects.toBeDefined();
      expect(prompt).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(1);
      if (stage === 'subscribe') expect(dispose).toHaveBeenCalledOnce();
      await expectStopped(f);
    } finally { await f.cleanup(); }
  });

it('[case:sdk-initialization-cleanup] real SDK factory failure stops an already initialized MCP server', async () => {
  const f = await mcpWorkFixture();
  try {
    await expect(f.adapter(undefined, { resolveModel: undefined }).start(f.request))
      .rejects.toMatchObject({ reason: 'model_resolution_unavailable' });
    expect(f.registrations).toHaveLength(1);
    await expectStopped(f);
  } finally { await f.cleanup(); }
});

it('[case:preflight-and-empty-selection] access rejection starts no server; no MCP selection never resolves or connects', async () => {
  const f = await mcpWorkFixture({ selected: false });
  const resolve = vi.fn(() => { throw new Error('must not discover'); });
  try {
    await expect(f.adapter(undefined, { prepareAccess: async () => { throw new Error('expired restricted authorization'); } }).start(f.request))
      .rejects.toMatchObject({ reason: 'work_access_preflight_failed' });
    const handle = await f.adapter(async () => new ScriptedPiSession(), { mcp: { ...f.assembly.mcp!, resolver: { resolve } } }).start(f.request);
    expect(await handle.result).toMatchObject({ terminal: 'completed' });
    expect(resolve).not.toHaveBeenCalled();
    expect(f.registrations).toEqual([]);
  } finally { await f.cleanup(); }
});

it.each([true, false])('[case:missing-tool-%s] required tools reject before prompt; optional missing tools retain an unverified gap', async required => {
  const f = await mcpWorkFixture({ required, server: { toolName: 'unselected' } });
  const factory = vi.fn(async (options: PiSessionFactoryOptions) => {
    expect(options.customTools ?? []).toEqual([]);
    return new ScriptedPiSession();
  });
  try {
    const start = f.adapter(factory).start(f.request);
    if (required) {
      await expect(start).rejects.toMatchObject({ reason: 'mcp_required_tool_missing' });
      expect(factory).not.toHaveBeenCalled();
    } else {
      const handle = await start;
      expect(await handle.result).toMatchObject({ terminal: 'completed' });
      expect(f.actualManifests[0]).toMatchObject({ resources: [{ status: 'omitted', loadedCapabilities: [] }],
        gaps: [{ resourceId: f.resourceId, capability: 'mcp_stdio', reason: 'unverified' }] });
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(JSON.stringify(events)).toContain('pi.mcp.unverified');
    }
    await expectStopped(f);
  } finally { await f.cleanup(); }
});

it('[case:optional-unsupported] optional HTTP never connects and records unsupported in the actual manifest', async () => {
  const f = await mcpWorkFixture({ required: false, transport: 'streamable_http' });
  try {
    const handle = await f.adapter(async () => new ScriptedPiSession()).start(f.request);
    await handle.result;
    expect(f.actualManifests[0]).toMatchObject({ resources: [{ status: 'omitted' }],
      gaps: [{ resourceId: f.resourceId, capability: 'mcp_streamable_http', reason: 'unsupported' }] });
    expect(f.registrations).toEqual([]);
  } finally { await f.cleanup(); }
});

it.each(['missing', 'rejected'] as const)('[case:optional-source-%s] an unavailable optional source is omitted without launch', async mode => {
  const f = await mcpWorkFixture({ required: false });
  try {
    const handle = await f.adapter(async () => new ScriptedPiSession(), { mcp: { ...f.assembly.mcp!, resolver: { resolve: () => {
      if (mode === 'rejected') throw new Error('source unavailable');
      return null;
    } } } }).start(f.request);
    await handle.result;
    expect(f.actualManifests[0]).toMatchObject({ resources: [{ status: 'omitted' }], gaps: [{ reason: 'unverified' }] });
    expect(f.registrations).toEqual([]);
  } finally { await f.cleanup(); }
});

it('[case:tool-collisions] custom tools cannot replace built-ins or an approved MCP name', async () => {
  const f = await mcpWorkFixture();
  try {
    const { prepareMcpStartupPlan } = await import('../../../packages/host/src/runtime/mcp-startup-plan.ts');
    const plan = await prepareMcpStartupPlan(f.request, { resolver: f.assembly.mcp!.resolver });
    for (const name of ['read', plan.tools[0]!.piName]) {
      await expect(f.adapter(async () => new ScriptedPiSession(), { resolveSubmissionTools: () => [{ name,
        label: 'Collision', description: 'must reject', parameters: { type: 'object' }, execute: async () => ({}) }] }).start(f.request)).rejects.toBeDefined();
    }
    expect(f.registrations).toEqual([]);
  } finally { await f.cleanup(); }
});

it('[case:tool-error-exit] real MCP JSON-RPC failure exits through owned cleanup and preserves failure', async () => {
  const f = await mcpWorkFixture({ server: { callMode: 'error' } });
  try {
    const handle = await f.adapter(async options => ({ subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
      prompt: async () => { await options.customTools![0]!.execute('failed-call', {}); } })).start(f.request);
    expect(await handle.result).toMatchObject({ terminal: 'failed' });
    expect(existsSync(join(f.box.path, 'call.entered'))).toBe(true);
    await expectStopped(f);
  } finally { await f.cleanup(); }
});

it('[case:abort-owned-tools] Session cancellation closes a real in-flight MCP call and the server', async () => {
  const f = await mcpWorkFixture({ server: { callMode: 'hang' } });
  const entered = deferred();
  try {
    const handle = await f.adapter(async options => ({ subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
      prompt: async () => { const call = options.customTools![0]!.execute('cancel-call', {}); entered.resolve(); await call; } })).start(f.request);
    await entered.promise;
    await handle.cancel();
    expect(await handle.result).toMatchObject({ terminal: 'cancelled' });
    await expectStopped(f);
  } finally { await f.cleanup(); }
});

it.each(['input', 'session'] as const)('[case:runner-start-abort-%s] Runner termination during startup closes MCP before SDK prompt', async stage => {
  const f = await mcpWorkFixture();
  const entered = deferred(), release = deferred(), signal = new AbortController();
  const session = new ScriptedPiSession();
  try {
    const runner = createPiWorkRunner({ signal: signal.signal, write: async () => {},
      adapter: f.adapter(async () => {
        if (stage === 'session') { entered.resolve(); await release.promise; }
        return session;
      }, stage === 'input' ? { inputReader: { read: async () => { entered.resolve(); await release.promise; return 'input'; } } } : {}) });
    const pending = runner.start(f.request);
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'runner_runtime_start_failed' });
    await entered.promise;
    signal.abort(); release.resolve();
    await rejection;
    await expectStopped(f);
    if (stage === 'session') expect(session.wasDisposed()).toBe(true);
  } finally { release.resolve(); await f.cleanup(); }
});

it('[case:runner-output-failure] disconnected Runner sink waits for MCP cleanup', async () => {
  const f = await mcpWorkFixture();
  try {
    const runner = createPiWorkRunner({ adapter: f.adapter(async () => new ScriptedPiSession()),
      write: async () => { throw new Error('sink disconnected'); } });
    await expect(runner.start(f.request)).rejects.toBeDefined();
    await expectStopped(f);
  } finally { await f.cleanup(); }
});

it('[case:runner-real-sigterm] real Runner SIGTERM closes its detached MCP group before exit', async () => {
  const f = await mcpWorkFixture();
  const port = createCommandProcessAdapter({ stopGraceMs: 3_000, stopConfirmMs: 2_000 });
  let handle: CommandProcessHandle | undefined, drain: Promise<void> | undefined;
  let registration: McpStdioProcessRegistration | undefined;
  const output: string[] = [];
  try {
    const marker = join(f.box.path, 'runner-ready.json');
    handle = await port.start({ argv: [process.execPath, '--experimental-transform-types', '--import',
      fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url)),
      fileURLToPath(new URL('../../helpers/p06-4/pi-mcp-runner-child.ts', import.meta.url)), marker],
      cwd: process.cwd(), environment: {}, stdin: Buffer.from(JSON.stringify(f.request)),
      timeoutMs: 15_000, maxInputBytes: 65_536, maxOutputBytes: 100_000 }, async identity => ({ launchId: identity.launchId }));
    const current = handle;
    drain = (async () => { for await (const chunk of current.output) output.push(Buffer.from(chunk.bytes).toString('utf8')); })();
    await until(() => existsSync(marker), 'real MCP Runner ready', 8_000);
    registration = JSON.parse(readFileSync(marker, 'utf8')).registration;
    expect((await processRows()).some(row => row.pid === registration!.processIdentity.pid)).toBe(true);
    await handle.cancel();
    const result = await handle.result;
    await drain;
    expect(result.stop.confirmed).toBe(true);
    expect((await processRows()).some(row => row.processGroupId === registration!.processIdentity.processGroupId)).toBe(false);
    expect(output.join('')).toContain('"terminal":"cancelled"');
  } finally {
    if (handle) { await handle.cancel(); await handle.result; }
    await drain;
    if (registration) {
      const id = registration.processIdentity;
      const row = (await processRows()).find(item => item.pid === id.pid);
      if (row && row.processGroupId === id.processGroupId && row.startTime === id.startTime) {
        process.kill(-id.processGroupId, 'SIGKILL');
        await until(async () => !(await processRows()).some(item => item.processGroupId === id.processGroupId), 'emergency owned cleanup');
      }
    }
    await f.cleanup();
  }
}, 20_000);

it('[case:stop-persistence-unconfirmed] retains registration and fails the result when MCP stop cannot be committed', async () => {
  const f = await mcpWorkFixture();
  try {
    const handle = await f.adapter(async () => new ScriptedPiSession(), {
      mcp: { ...f.assembly.mcp!, processRegistry: { ...f.registry, markStopped: async () => false } },
    }).start(f.request);
    expect(await handle.result).toMatchObject({ terminal: 'failed', reason: 'mcp_cleanup_unconfirmed' });
    expect(await handle.stopped).toMatchObject({ confirmed: false, detail: 'pi_sdk_stop_unknown' });
    expect(f.registry.list(f.registrations[0]!)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it('[case:optional-unassembled] optional MCP with no trusted assembly produces an unverified gap and no connection', async () => {
  const f = await mcpWorkFixture({ required: false });
  try {
    const handle = await f.adapter(async () => new ScriptedPiSession(), { mcp: undefined }).start(f.request);
    await handle.result;
    const events = [];
    for await (const event of handle.events) events.push(event);
    expect(JSON.stringify(events)).toContain('pi.mcp.unverified');
    expect(f.registrations).toEqual([]);
  } finally { await f.cleanup(); }
});

it('[case:attempt-input-pinned] caller changes do not rewrite an active Attempt; next Attempt rechecks revoked sources', async () => {
  const f = await mcpWorkFixture();
  const entered = deferred(), release = deferred();
  let factoryOptions: PiSessionFactoryOptions | undefined;
  try {
    const callerRequest = structuredClone(f.request);
    const first = f.adapter(async options => {
      factoryOptions = options;
      entered.resolve(); await release.promise;
      return { subscribe: listener => { listener({ type: 'agent_settled' }); return () => {}; }, abort: async () => {}, dispose: () => {},
        prompt: async () => { await options.customTools![0]!.execute('same-call-id', {}); }, waitForIdle: async () => {} };
    });
    const starting = first.start(callerRequest);
    await entered.promise;
    callerRequest.workAccess = { ...callerRequest.workAccess!, resources: { ...callerRequest.workAccess!.resources, entries: [] } };
    release.resolve();
    const handle = await starting;
    expect(await handle.result).toMatchObject({ terminal: 'completed' });
    expect(factoryOptions!.customTools).toHaveLength(1);
    const secondRequest = { ...f.request, sessionId: 'session-2', invocationId: 'invocation-2',
      identity: { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-2' },
      workAccess: { ...f.snapshot, invocationId: 'invocation-2', attemptId: 'attempt-2' } };
    await expect(f.adapter(async () => new ScriptedPiSession(), { mcp: { ...f.assembly.mcp!, resolver: { resolve: () => null } } })
      .start(secondRequest)).rejects.toBeDefined();
    expect(f.registrations).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8')).count).toBe(1);
    await expectStopped(f);
  } finally { release.resolve(); await f.cleanup(); }
});
