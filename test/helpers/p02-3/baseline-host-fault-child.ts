/** Owned real Host, with private barriers at the durable-release/result boundaries. */
import { startHost } from '../../../packages/host/src/index.ts';
import { createBaselineExecutionService } from '../../../packages/core/src/application/baseline-execution.ts';
import { createBaselineWorkspaceReader } from '../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createBaselineRepositoryGuard } from '../../../packages/core/src/adapters/fs/baseline-repository-guard.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(process.argv[2]) as { root: string; repositoryPath: string; script: string; counter: string; release: string; mode: string };
const send = (message: object) => process.send?.(message);
let execution: ReturnType<typeof createBaselineExecutionService> | undefined;
let identity: import('../../../packages/core/src/index.ts').CommandProcessIdentity | undefined;
const watchdog = setTimeout(() => { process.exit(9); }, 60_000);
send({ kind: 'ready', pid: process.pid, cwd: process.cwd(), home: process.env.HOME, tmpdir: process.env.TMPDIR });
await new Promise<void>(resolve => { process.once('message', () => resolve()); });
const host = await startHost({ dataRoot: config.root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), env: {},
  activityGate: { enterQuiesce: () => execution?.enterQuiesce() ?? { accepted: 0 },
    awaitQuiesce: ms => execution?.awaitQuiesce(ms) ?? Promise.resolve({ confirmed: true, pending: [] }) } });
const app = host.core;
const owner = createLocalOwnerPrincipal();
const projectId = (await app.projectService.registerRepository({ repositoryPath: config.repositoryPath, displayName: 'fault' })).project.id;
const plan = { checks: [{ checkKey: 'a', kind: 'command', argv: [process.execPath, config.script, config.counter, config.release,
  config.mode === 'result-uncommitted' ? 'once' : 'hang'], required: true, timeoutMs: 30_000 }] };
const preview = await app.baselineService.previewBaseline(owner, projectId, { plan });
const request = { schemaVersion: 5, commandId: randomUUID(), operation: 'baseline.run', scope: { kind: 'project', projectId },
  issuedAt: new Date().toISOString(), payload: { decision: 'authorize', plan, previewDigest: preview.previewDigest } };
const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
const atomic = createSqliteAtomicCommandStore(session);
const real = createCommandProcessAdapter();
let operationId: string | undefined;
execution = createBaselineExecutionService({ commands: app.commandService,
  atomicStore: { ...atomic, transact(operation, callback) {
    if (config.mode === 'result-uncommitted' && operation === 'baseline.check') throw new Error('Injected result commit failure');
    return atomic.transact(operation, callback);
  } }, baselines: app.baselineStore, state: app.stateStore, inspector: app.repositoryInspector,
  workspace: createBaselineWorkspaceReader(), artifacts: app.artifactStore, files: app.artifactFileStore,
  repositoryGuard: createBaselineRepositoryGuard(), environmentDirectory: { resolveEnvironmentRef: () => null },
  resolveEnvironment: () => ({ PATH: '/usr/bin:/bin' }),
  processes: { ...real, async start(req, confirm, signal) {
    const handle = await real.start(req, async id => {
      identity = id;
      const ack = await confirm(id);
      if (config.mode === 'pre-release') {
        send({ kind: 'checkpoint', projectId, operationId: app.baselineStore.readBaselineOccupancy().holderOperationId, request, identity });
        await new Promise<void>(() => {}); // Host SIGKILL, never acknowledge release
      }
      return ack;
    }, signal);
    identity = handle.identity;
    return handle;
  } },
});
const receipt = await (config.mode === 'intent' ? app.commandService : execution).submit(owner, request);
if (receipt.status !== 'accepted') throw new Error('Expected accepted');
operationId = receipt.operationId;
if (config.mode === 'intent') send({ kind: 'checkpoint', projectId, operationId, request });
else if (config.mode === 'result-uncommitted') {
  await execution.waitForIdle();
  send({ kind: 'checkpoint', projectId, operationId, request, identity });
} else if (config.mode !== 'pre-release') {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = app.baselineStore.readBaselineOccupancy().processIdentity;
    try {
      if (typeof snapshot?.stagingRelativePath === 'string' && statSync(join(config.root, snapshot.stagingRelativePath)).size > 0) break;
    } catch { /* wait for actual collector write */ }
    if (Date.now() >= deadline) throw new Error('Partial evidence barrier timeout');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  send({ kind: 'checkpoint', projectId, operationId, request, identity });
}
process.on('message', (message: unknown) => {
  const kind = (message as { kind?: string })?.kind;
  if (kind === 'freeze' && identity) { process.kill(identity.pid, 'SIGSTOP'); send({ kind: 'frozen' }); }
  if (kind === 'lose-supervisor' && identity) {
    process.kill(identity.pid, 'SIGKILL');
    void execution!.waitForIdle().then(() => send({ kind: 'supervisor-lost' }));
  }
  if (kind === 'close') {
    void (async () => {
      session.close(); await host.close(); clearTimeout(watchdog); process.exit(0);
    })().catch(() => send({ kind: 'close-unconfirmed' }));
  }
});
