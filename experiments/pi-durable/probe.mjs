import { mkdtemp, rm, readFile, appendFile, readdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as ctx, withCancel } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineExtension, defineTool, hook, ToolTask, watchEvents } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const here = fileURLToPath(import.meta.url);
if (process.versions.node !== '22.19.0') throw new Error('F-004 probe requires Node 22.19.0');
const model = { provider: 'faux', modelId: 'faux-1' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sandbox(run) {
  const dir = await mkdtemp(join(tmpdir(), 'shiploop-f004-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function open(path, options = {}) {
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] });
  const models = createModels(); // Only in-memory credentials and explicitly installed faux provider.
  models.setProvider(faux.provider);
  const registry = createRegistry();
  if (options.extension) registry.install(options.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(path), {
    models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, ctx);
  const root = await harness.root(ctx, { agent: { model } });
  return { harness, root, faux };
}
async function until(check) {
  for (let n = 0; n < 400; n++) {
    const value = await check();
    if (value) return value;
    await pause(10);
  }
  throw new Error('probe condition timed out');
}
function waitSignal(context) {
  return new Promise((_, reject) => {
    if (context.abortSignal?.aborted) reject(context.abortSignal.reason);
    else context.abortSignal?.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true });
  });
}
function toolExtension({ replay = 'unsafe', execute, beforeTool, afterTool } = {}) {
  return defineExtension({ name: 'probe-tools', tools: [defineTool({
    name: 'effect', description: 'Write a controlled local effect', parameters: Type.Object({}), replay,
    execute: execute ?? (async () => ({ output: [{ type: 'text', text: 'ok' }] })),
  })], hooks: [hook(ToolTask, { beforeTool, afterTool })] });
}
const toolMessage = () => fauxAssistantMessage(fauxToolCall('effect', {}, { id: 'tool-1' }), { stopReason: 'toolUse' });

export async function probeDuplicate() {
  return sandbox(async dir => {
    const path = join(dir, 'native.sqlite');
    const first = await open(path);
    let sessionId;
    first.faux.setResponses([(context, options) => {
      sessionId = options.sessionId;
      return fauxAssistantMessage('offline answer');
    }]);
    const a = await first.root.submit({ type: 'input', content: 'hello', requestId: 'request-1' }, ctx);
    const status = (await a.wait(ctx)).status;
    const b = await first.root.submit({ type: 'input', content: 'hello', requestId: 'request-1' }, ctx);
    // SDK intentionally returns the first submission even if the caller changes its payload.
    const conflict = await first.root.submit({ type: 'input', content: 'different', requestId: 'request-1' }, ctx);
    const providerCalls = first.faux.state.callCount;
    await first.harness.close(ctx);
    const second = await open(path);
    try {
      const c = await second.root.submit({ type: 'input', content: 'hello', requestId: 'request-1' }, ctx);
      await c.wait(ctx);
      const reopenedProviderCalls = second.faux.state.callCount;
      const userEntries = (await second.root.context(ctx)).entries.filter(e => e.kind === 'pi.user').length;
      let reopenedSessionId;
      second.faux.setResponses([(_context, options) => {
        reopenedSessionId = options.sessionId;
        return fauxAssistantMessage('new answer');
      }]);
      await (await second.root.submit({ type: 'input', content: 'next', requestId: 'request-2' }, ctx)).wait(ctx);
      return { submissionSame: a.id === b.id && a.id === c.id, conflictingPayloadSame: conflict.id === a.id,
        userEntries, providerCalls, reopenedProviderCalls, providerSessionSame: !!sessionId && sessionId === reopenedSessionId, status };
    } finally { await second.harness.close(ctx); }
  });
}

async function child(dir, point, replay) {
  const effects = join(dir, 'effects.jsonl');
  const mark = async type => appendFile(effects, JSON.stringify({ type }) + '\n');
  let orphanPid;
  const gate = async context => {
    process.send({ type: 'ready' });
    await waitSignal(context);
  };
  const extension = toolExtension({ replay,
    beforeTool: async (_call, _api, context) => {
      await mark('beforeTool');
      if (point === 'before-tool') await gate(context);
    },
    execute: async (_args, api, context) => {
      await mark('effect');
      await api.details({ marker: 'effect-written' }, context);
      if (point === 'orphan') {
        const worker = spawn(process.execPath, ['-e',
          "const fs = require('node:fs'); const tick = () => fs.appendFileSync(process.argv[1], 'tick\\n'); tick(); setInterval(tick, 20);",
          join(dir, 'orphan.txt')], { env: {}, detached: true, stdio: 'ignore' });
        orphanPid = worker.pid;
        process.send({ type: 'orphan', pid: orphanPid });
        await until(async () => readFile(join(dir, 'orphan.txt'), 'utf8').catch(() => false));
      }
      if (point === 'execute' || point === 'orphan') await gate(context);
      return { output: [{ type: 'text', text: 'effect complete' }] };
    },
    afterTool: async (_call, _result, _api, context) => {
      await mark('afterTool');
      if (point === 'after-tool') await gate(context);
    },
  });
  const current = await open(join(dir, 'native.sqlite'), { extension });
  current.faux.setResponses([toolMessage(), async () => {
    if (point === 'after-commit') {
      process.send({ type: 'ready' });
      await new Promise(() => {});
    }
    return fauxAssistantMessage('done');
  }]);
  if (point === 'second-writer') {
    process.send({ type: 'ready' });
    await current.harness.close(ctx);
    process.disconnect();
    return;
  }
  await current.root.submit({ type: 'input', content: 'effect', requestId: 'request-1' }, ctx);
}

async function killAt(dir, point, replay, mode) {
  const proc = spawn(process.execPath, [here, '--child', dir, point, replay], {
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(proc, 'exit');
  let timer;
  let orphanPid;
  let handedOff = false;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        proc.on('message', message => {
          if (message.type === 'orphan') orphanPid = message.pid;
          if (message.type === 'ready') resolve(message);
        });
        proc.once('error', reject);
        proc.once('exit', () => reject(new Error(`child exited before breakpoint: ${stderr}`)));
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child breakpoint timeout')), 10000); }),
    ]);
    proc.kill(mode);
    const [code, signal] = await exited;
    handedOff = true;
    return { code, signal, ...(orphanPid ? { orphanPid } : {}) };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; }
    if (!handedOff && orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch {} }
  }
}

export async function probeOrphan() {
  return sandbox(async dir => {
    const exit = await killAt(dir, 'orphan', 'unsafe', 'SIGKILL');
    try {
      process.kill(exit.orphanPid, 0);
      const before = (await readFile(join(dir, 'orphan.txt'), 'utf8')).length;
      await pause(100);
      const after = (await readFile(join(dir, 'orphan.txt'), 'utf8')).length;
      return { parentSignal: exit.signal, orphanAliveAfterParentExit: true, outputContinued: after > before };
    } finally {
      try { process.kill(exit.orphanPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      // A detached worker is not joinable here; observe that it cannot keep writing before deleting its sandbox.
      const size = (await readFile(join(dir, 'orphan.txt'), 'utf8')).length;
      await pause(80);
      if ((await readFile(join(dir, 'orphan.txt'), 'utf8')).length !== size) throw new Error('orphan cleanup not confirmed');
    }
  });
}

export async function probeCrash(point, replay = 'unsafe', mode = 'SIGKILL', missingTool = false) {
  return sandbox(async dir => {
    const exit = await killAt(dir, point, replay, mode);
    const path = join(dir, 'native.sqlite');
    const db = new DatabaseSync(path);
    const checkpoints = db.prepare('SELECT record FROM tasks WHERE kind = ?').all(JSON.stringify('pi.tool')).map(r => JSON.parse(r.record));
    db.close();
    const recovered = await open(path, { extension: missingTool ? undefined : toolExtension({ replay,
      beforeTool: async () => appendFile(join(dir, 'effects.jsonl'), '{"type":"beforeTool"}\n'),
      execute: async () => {
        await appendFile(join(dir, 'effects.jsonl'), '{"type":"effect"}\n');
        return { output: [{ type: 'text', text: 'recovered effect' }] };
      },
      afterTool: async () => appendFile(join(dir, 'effects.jsonl'), '{"type":"afterTool"}\n'),
    }) });
    recovered.faux.setResponses([fauxAssistantMessage('recovered final')]);
    try {
      const submission = await recovered.root.submit({ type: 'input', content: 'effect', requestId: 'request-1' }, ctx);
      const settled = await submission.wait(ctx);
      const entries = (await recovered.root.context(ctx)).entries;
      const toolResults = entries.filter(e => e.kind === 'pi.tool-result');
      const effects = (await readFile(join(dir, 'effects.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      return { point, replay, missingTool, exit, checkpoints, effects: effects.filter(e => e.type === 'effect').length,
        beforeHooks: effects.filter(e => e.type === 'beforeTool').length, afterHooks: effects.filter(e => e.type === 'afterTool').length,
        status: settled.status, toolResults, liveTasks: (await recovered.harness.inspect(ctx)).tasks.length,
        userEntries: entries.filter(e => e.kind === 'pi.user').length };
    } finally { await recovered.harness.close(ctx); }
  });
}

export async function probeCancellation(action = 'abort') {
  return sandbox(async dir => {
    let started = false;
    let exited = false;
    let release;
    const extension = toolExtension({ execute: async (_args, _api, context) => {
      started = true;
      try {
        if (action === 'non-cooperative') await new Promise(resolve => { release = resolve; });
        else await waitSignal(context);
      } finally { exited = true; }
      return {};
    } });
    const current = await open(join(dir, 'native.sqlite'), { extension });
    try {
      current.faux.setResponses([toolMessage(), fauxAssistantMessage('done')]);
      const submission = await current.root.submit({ type: 'input', content: 'effect', requestId: 'cancel' }, ctx);
      await until(() => started);
      const waiting = withCancel(ctx);
      const wait = submission.wait(waiting.context).then(() => false, () => true);
      waiting.cancel(new Error('cancel only waiter'));
      const waiterRejected = await wait;
      const stillRunningAfterWaitCancel = !exited && (await current.harness.inspect(ctx)).tasks.length > 0;
      let closePendingBeforeRelease = false;
      if (action === 'non-cooperative') {
        let closed = false;
        const close = current.harness.close(ctx).then(() => { closed = true; });
        await pause(50);
        closePendingBeforeRelease = !closed && !exited;
        release();
        await close;
      } else if (action === 'close') await current.harness.close(ctx);
      else await current.root.abort(ctx);
      return { action, waiterRejected, stillRunningAfterWaitCancel, toolExited: exited, closePendingBeforeRelease,
        liveTasks: action === 'abort' ? (await current.harness.inspect(ctx)).tasks.length : null };
    } finally { release?.(); await current.harness.close(ctx); }
  });
}

export async function probeStorageAndEvents() {
  return sandbox(async dir => {
    const path = join(dir, 'native.sqlite');
    const current = await open(path, { extension: toolExtension() });
    const stream = await watchEvents(current.harness, current.root.id, ctx);
    const events = [stream.snapshot];
    stream.start(async batch => { events.push(...batch); });
    let sessionId;
    current.faux.setResponses([toolMessage(), (_context, options) => {
      sessionId = options.sessionId;
      return fauxAssistantMessage('done');
    }]);
    await (await current.root.submit({ type: 'input', content: 'effect', requestId: 'events' }, ctx)).wait(ctx);
    await until(() => events.some(e => e.type === 'run_end'));
    await stream.stop();
    const reconnect = await watchEvents(current.harness, current.root.id, ctx);
    const reconnectSnapshot = reconnect.snapshot;
    await reconnect.stop();
    await current.root.configure({ model: { provider: 'faux', modelId: 'faux-2' }, tools: [] }, ctx);
    let newSessionId;
    let dispatchedModel;
    current.faux.setResponses([(_context, options, _state, selected) => {
      newSessionId = options.sessionId;
      dispatchedModel = selected.id;
      return fauxAssistantMessage('second model');
    }]);
    await (await current.root.submit({ type: 'input', content: 'next', requestId: 'model-switch' }, ctx)).wait(ctx);
    const duringOpen = await readdir(dir);
    // A SQL-consistent snapshot, never a raw copy of an open SQLite main file.
    const database = new DatabaseSync(path);
    const journal = database.prepare('PRAGMA journal_mode').get().journal_mode;
    const schemaVersion = database.prepare('SELECT version FROM durable_schema').get().version;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
    const backupPath = join(dir, 'backup.sqlite');
    database.prepare('VACUUM INTO ?').run(backupPath);
    database.close();
    // The SDK admits another process: this is a negative single-owner result, not a safe concurrency claim.
    const writer = spawn(process.execPath, [here, '--child', dir, 'second-writer', 'unsafe'], {
      env: { PATH: process.env.PATH, HOME: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let writerError = '';
    writer.stderr.on('data', chunk => { writerError += chunk; });
    const writerExit = once(writer, 'exit');
    const timer = setTimeout(() => writer.kill('SIGKILL'), 10000);
    let secondWriterOpened = false;
    writer.on('message', () => { secondWriterOpened = true; });
    const [writerCode] = await writerExit;
    clearTimeout(timer);
    await current.harness.close(ctx);
    const afterClose = await readdir(dir);
    await copyFile(path, join(dir, 'closed-copy.sqlite'));
    const backup = await open(backupPath);
    const closedCopy = await open(join(dir, 'closed-copy.sqlite'));
    try {
      const snapshotEntries = (await backup.root.context(ctx)).entries.length;
      const copyEntries = (await closedCopy.root.context(ctx)).entries.length;
      return { journal, schemaVersion, tables, duringOpen, afterClose, secondWriterOpened, writerCode, writerError,
        snapshotEntries, copyEntries, eventTypes: [...new Set(events.map(e => e.type))],
        toolEvents: events.filter(e => e.type.startsWith('tool_execution')).map(e => ({ type: e.type, toolCallId: e.toolCallId, taskId: e.taskId })),
        reconnect: { type: reconnectSnapshot.type, entries: reconnectSnapshot.entries.length, tools: reconnectSnapshot.tools.length },
        modelSwitch: { dispatchedModel, providerSessionSame: sessionId === newSessionId, tools: (await closedCopy.root.agent(ctx)).tools.length } };
    } finally { await backup.harness.close(ctx); await closedCopy.harness.close(ctx); }
  });
}

export async function runProbe() {
  return { versions: { node: process.versions.node, sqlite: process.versions.sqlite, sdk: '1.2.0' },
    duplicate: await probeDuplicate(),
    crashes: [await probeCrash('before-tool'), await probeCrash('execute'), await probeCrash('after-tool'),
      await probeCrash('execute', 'safe'), await probeCrash('after-tool', 'safe'), await probeCrash('after-commit'),
      await probeCrash('execute', 'unsafe', 'SIGTERM'), await probeCrash('execute', 'safe', 'SIGKILL', true)],
    cancellation: [await probeCancellation(), await probeCancellation('close'), await probeCancellation('non-cooperative')],
    orphan: await probeOrphan(),
    storageAndEvents: await probeStorageAndEvents() };
}
if (process.argv[1] === here) {
  if (process.argv[2] === '--child') await child(process.argv[3], process.argv[4], process.argv[5]);
  else console.log(JSON.stringify(await runProbe(), null, 2));
}
