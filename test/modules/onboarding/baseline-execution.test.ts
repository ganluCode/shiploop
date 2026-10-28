import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { BaselineExecutionOptions } from '../../../packages/core/src/application/baseline-execution.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { createFaultyArtifactFileStore } from '../../helpers/p02-3/evidence-faults.ts';
import { createBaselineExecutionService } from '../../../packages/core/src/application/baseline-execution.ts';
import { createBaselineRepositoryGuard } from '../../../packages/core/src/adapters/fs/baseline-repository-guard.ts';
import { createBaselineWorkspaceReader } from '../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { CommandProcessError } from '../../../packages/core/src/ports/command-process.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { BaselineCheck, AtomicCommandStore, CommandProcessHandle, CommandProcessPort, CommandProcessResult } from '../../../packages/core/src/index.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: [{ providerId: 'test', models: ['test'] }] }]);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function command(operation: string, projectId: string, payload: unknown, commandId = randomUUID()) {
  return { schemaVersion: 5, operation, scope: { kind: 'project', projectId }, commandId, issuedAt: new Date().toISOString(), payload };
}
function check(checkKey: string, argv: string[], timeoutMs = 10_000): BaselineCheck {
  return { checkKey, kind: 'command' as const, argv, required: true, timeoutMs };
}
/**
 * npm CLI 绝对路径（检查 argv 不经 shell，子进程环境 PATH 受限，必须绝对路径）：
 * 优先 `npm run` 注入的 npm_execpath；测试被直接以 node 运行（如验收选中清单经
 * `node scripts/run-tests.ts` 执行）时回退 Node 安装前缀的标准 npm 布局
 *（<prefix>/lib/node_modules/npm/bin/npm-cli.js），不依赖启动器环境。
 */
const npmCliPath =
  process.env.npm_execpath ??
  join(dirname(realpathSync(process.execPath)), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
async function setup(processes: CommandProcessPort = createCommandProcessAdapter(), decorate?: (s: AtomicCommandStore) => AtomicCommandStore,
  overrides?: (app: Awaited<ReturnType<typeof openCoreApplication>>) => Partial<BaselineExecutionOptions>) {
  const box = createBaselineFixture();
  const environmentDirectory = { resolveEnvironmentRef: (ref: string) => ref === 'test-home' ? { allowedVariables: ['HOME', 'TMPDIR'] } : null };
  const app = await openCoreApplication({ dataRoot: box.dataRoot(), capabilityCatalog: catalog, baselineEnvironmentDirectory: environmentDirectory });
  const registered = await app.projectService.registerRepository({ repositoryPath: box.repos.withHead, displayName: 'test' });
  const projectId = registered.project.id;
  const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
  const atomicStore = createSqliteAtomicCommandStore(session);
  const execution = createBaselineExecutionService({ commands: app.commandService, atomicStore: decorate ? decorate(atomicStore) : atomicStore,
    baselines: app.baselineStore, state: app.stateStore, inspector: app.repositoryInspector, workspace: createBaselineWorkspaceReader(),
    processes, artifacts: app.artifactStore, files: app.artifactFileStore, repositoryGuard: createBaselineRepositoryGuard(),
    environmentDirectory, resolveEnvironment: () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: box.homeDir, TMPDIR: box.root }), ...overrides?.(app) });
  const f = { box, app, projectId, session, execution: { ...execution, async submit(...args: Parameters<typeof execution.submit>) {
    const receipt = await execution.submit(...args);
    if (receipt.status !== 'accepted') throw new Error(`Expected accepted, got ${receipt.status}`);
    return receipt;
  } }, atomicStore,
    async request(checks: ReturnType<typeof check>[]) {
      const plan = { checks };
      const preview = await app.baselineService.previewBaseline(owner, projectId, { plan });
      return command('baseline.run', projectId, { decision: 'authorize', plan, previewDigest: preview.previewDigest });
    },
    results(id: string) { return app.baselineStore.listBaselineCheckResults(id); },
  };
  cleanup.push(async () => {
    try {
      for (const id of execution.activeOperationIds()) await execution.cancel(owner, projectId, id);
      await execution.waitForIdle();
    } finally { session.close(); app.close(); await box.dispose(); }
  });
  return f;
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function gatedProcess(stopConfirmed = true, text = 'checked\n') {
  const outputBytes = Buffer.byteLength(text);
  const started = deferred<void>();
  const finish = deferred<CommandProcessResult>();
  let starts = 0;
  const port: CommandProcessPort = { async start(_request, confirm, signal) {
    starts++;
    const identity = { launchId: randomUUID(), pid: 1, processGroupId: 1, startTime: 'fake' };
    await confirm(identity);
    const handle: CommandProcessHandle = { identity, output: (async function* () { yield { stream: 'stdout' as const, bytes: Buffer.from(text) }; await finish.promise; })(),
      result: finish.promise, stopped: finish.promise.then(r => r.stop),
      query: () => ({ identity, state: 'running', bufferedOutputBytes: 0 }),
      cancel: async () => { finish.resolve({ exitCode: null, signal: 'SIGTERM', reason: 'cancelled', outputBytes, droppedOutputBytes: 0, stop: { confirmed: stopConfirmed } }); return { accepted: true }; } };
    signal?.addEventListener('abort', () => { void handle.cancel(); }, { once: true });
    if (signal?.aborted) await handle.cancel();
    started.resolve(); return handle;
  } };
  return { port, started: started.promise, starts: () => starts,
    finish: () => finish.resolve({ exitCode: 0, signal: null, reason: null, outputBytes, droppedOutputBytes: 0, stop: { confirmed: stopConfirmed } }) };
}

describe('Core baseline execution invariants', () => {
  it('quiesce includes in-flight authorization; explicit cancel fences it before any process launch', async () => {
    const fake = gatedProcess();
    const admitted = deferred<void>();
    const release = deferred<void>();
    const f = await setup(fake.port, undefined, app => ({ commands: { async submit(principal, envelope) {
      admitted.resolve();
      await release.promise;
      return app.commandService.submit(principal, envelope);
    } } }));
    const pending = f.execution.submit(owner, await f.request([check('a', ['node', '--version'])]));
    await admitted.promise;
    expect(f.execution.enterQuiesce('cancel')).toEqual({ accepted: 1 });
    expect(await f.execution.awaitQuiesce(0)).toEqual({ confirmed: false, pending: ['baseline-submission'] });
    release.resolve();
    const receipt = await pending;
    await f.execution.waitForIdle();
    expect(fake.starts()).toBe(0);
    expect(f.app.baselineStore.getBaselineOperation(receipt.operationId)?.status).toBe('cancelled');
    expect(f.results(receipt.operationId)).toMatchObject([{ status: 'not_run', reasonCode: 'cancelled' }]);
    expect(await f.execution.awaitQuiesce(0)).toEqual({ confirmed: true, pending: [] });
  });
  it('known zero-test output is inconclusive despite zero exit and complete artifacts', async () => {
    const fake = gatedProcess(true, 'Tests 0 passed (0)\n'); const f = await setup(fake.port);
    const r = await f.execution.submit(owner, await f.request([check('a', ['node', '--version'])]));
    await fake.started; fake.finish(); await f.execution.waitForIdle();
    expect(f.results(r.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'evidence_incomplete' }]);
  });
  it('binding revision drift between preparation and the short transaction invalidates authorization', async () => {
    const fake = gatedProcess(); const f = await setup(fake.port);
    const request = await f.request([check('a', ['node', '--version'])]);
    const prepared = await f.app.baselineService.prepareBaselineRun(owner, f.projectId, request.payload);
    // 夹具通过受控 SQL 模拟外部绑定漂移；生产触发器阻止任意事实篡改。
    f.session.database.exec('DROP TRIGGER repository_bindings_immutable');
    f.session.database.prepare('UPDATE repository_bindings SET revision = revision + 1, binding_revision = binding_revision + 1 WHERE project_id = ?').run(f.projectId);
    const result = f.atomicStore.transact('baseline.run', tx => f.app.baselineService.submitBaselineRun(tx, {
      principalId: owner.principalId, commandId: request.commandId, scope: { kind: 'project', projectId: f.projectId },
      requestDigest: 'a'.repeat(64), issuedAt: request.issuedAt,
    }, prepared));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Expected stale rejection');
    expect(result.error.details?.reason).toBe('preview_stale');
    expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM baseline_authorizations').get()).toEqual({ n: 0 });
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    expect(fake.starts()).toBe(0);
  });
  it('real checks run in checkKey order once; replay is same operation, different digest conflicts', async () => {
    const seen: string[] = [];
    const real = createCommandProcessAdapter();
    const f = await setup({ start: async (r, c, s) => { seen.push(r.argv.at(-1)!); return real.start(r, c, s); } });
    const request = await f.request([check('z', [process.execPath, '-p', '"last"']), check('a', [process.execPath, '-p', '"first"'])]);
    const [first, replay] = await Promise.all([f.execution.submit(owner, request), f.execution.submit(owner, request)]);
    expect(first.operationId).toBe(replay.operationId);
    await f.execution.waitForIdle();
    expect(seen).toEqual(['"first"', '"last"']);
    expect(f.results(first.operationId!)).toMatchObject([{ status: 'passed', exitCode: 0 }, { status: 'passed', exitCode: 0 }]);
    expect(f.app.baselineStore.getBaselineOperation(first.operationId!)?.status).toBe('completed');
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    await expect(f.execution.submit(owner, { ...request, payload: { ...request.payload as object, decision: 'decline' } })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.execution.submit(owner, request)).operationId).toBe(first.operationId);
    expect(seen).toHaveLength(2);
    expect((await f.execution.cancel(owner, f.projectId, first.operationId)).status).toBe('completed');
    expect(f.results(first.operationId)).toMatchObject([{ status: 'passed' }, { status: 'passed' }]);
  });
  it('persists failure, missing command, unknown script and permission denial without deregistering', async () => {
    const f = await setup();
    const denied = join(f.box.repos.withHead, 'denied'); writeFileSync(denied, 'not executable'); chmodSync(denied, 0o600);
    const receipt = await f.execution.submit(owner, await f.request([
      check('a', [process.execPath, '-e', 'process.exit(7)']), check('b', ['shiploop-not-a-command']),
      check('c', ['./absent-script']), check('d', ['./denied']),
      { ...check('e', [process.execPath, npmCliPath, 'run', 'shiploop-absent-script']), environmentRef: 'test-home' },
    ]));
    await f.execution.waitForIdle();
    expect(f.results(receipt.operationId!)).toMatchObject([{ status: 'failed', exitCode: 7 }, { status: 'error', reasonCode: 'missing_command' },
      { status: 'error', reasonCode: 'unknown_script' }, { status: 'error', reasonCode: 'permission_denied' }, { status: 'error', reasonCode: 'unknown_script' }]);
    expect((await f.app.stateStore.getProject(f.projectId)).status).toBe('active');
  });
  it('zero exit with empty output or source changes cannot pass; changes are retained', async () => {
    const f = await setup();
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '-e', 'process.exit(0)']),
      check('b', [process.execPath, '-e', 'require("fs").writeFileSync("new-source.ts","changed");console.log("ok")'])]));
    await f.execution.waitForIdle();
    expect(f.results(r.operationId!)).toMatchObject([{ status: 'inconclusive', reasonCode: 'evidence_incomplete' }, { status: 'inconclusive', reasonCode: 'source_changed' }]);
    expect(readFileSync(join(f.box.repos.withHead, 'new-source.ts'), 'utf8')).toBe('changed');
    expect(f.app.baselineStore.getBaselineOperation(r.operationId!)?.reasonCode).toBe('source_changed');
    const summary = (await f.app.artifactStore.listArtifacts(f.projectId)).records.find(a => a.kind === 'baseline-summary');
    expect(summary?.status).toBe('ready');
    const content = JSON.parse(readFileSync(join(f.app.dataRoot, 'projects', f.projectId, 'artifacts', summary!.id, 'content'), 'utf8'));
    expect(content.after.workingTreeDigest).not.toBe(content.before.workingTreeDigest);
    expect(content.operationId).toBe(r.operationId);
  });
  it('explicit cancellation of a real hanging command confirms stop and persists evidence', async () => {
    const outputReady = deferred<void>(); const real = createCommandProcessAdapter(); let handle: CommandProcessHandle | undefined;
    const f = await setup({ async start(request, confirm, signal) {
      handle = await real.start(request, confirm, signal);
      const output = handle.output;
      return { ...handle, output: (async function* () {
        for await (const chunk of output) { outputReady.resolve(); yield chunk; }
      })() };
    } });
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '-e', 'console.log("active");setInterval(()=>{},1000)'])]));
    try {
      await outputReady.promise;
      expect(f.app.baselineStore.getBaselineOperation(r.operationId)?.status).toBe('running');
      expect((await f.execution.cancel(owner, f.projectId, r.operationId)).status).toBe('cancelled');
      expect((await handle!.stopped).confirmed).toBe(true);
      expect(f.results(r.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'cancelled', outputArtifactId: expect.any(String) }]);
      expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    } finally { await handle?.cancel(); if (handle) expect((await handle.stopped).confirmed).toBe(true); }
  });
  it('timeout stops the real process, leaves following checks not_run', async () => {
    const f = await setup();
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '-e', 'console.log("start");setInterval(()=>{},1000)'], 150), check('b', [process.execPath, '--version'])]));
    await f.execution.waitForIdle();
    expect(f.results(r.operationId!)).toMatchObject([{ status: 'inconclusive', reasonCode: 'timed_out', timedOut: true }, { status: 'not_run' }]);
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
  });
  it('active operation is queryable; cancel wins against late successful result and does not start next item', async () => {
    const fake = gatedProcess(); const f = await setup(fake.port);
    const r = await f.execution.submit(owner, await f.request([check('a', ['node', '--version']), check('b', ['node', '--version'])]));
    await fake.started;
    expect(f.app.baselineStore.getBaselineOperation(r.operationId!)?.status).toBe('running');
    const cancellation = f.execution.cancel(owner, f.projectId, r.operationId!); fake.finish();
    expect((await cancellation).status).toBe('cancelled');
    expect(f.results(r.operationId!)).toMatchObject([{ status: 'inconclusive', reasonCode: 'cancelled' }, { status: 'not_run', reasonCode: 'cancelled' }]);
    expect(fake.starts()).toBe(1);
    expect((await f.execution.cancel(owner, f.projectId, r.operationId!)).status).toBe('cancelled');
  });
  it('cancel during uncertain supervisor startup preserves inconclusive stop_unconfirmed, not not_run', async () => {
    const arrived = deferred<void>();
    const f = await setup({ async start(_request, _confirm, signal) {
      arrived.resolve();
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
      throw new CommandProcessError('stop_unconfirmed');
    } });
    const r = await f.execution.submit(owner, await f.request([check('a', ['node', '--version']), check('b', ['node', '--version'])]));
    await arrived.promise;
    expect((await f.execution.cancel(owner, f.projectId, r.operationId)).reasonCode).toBe('stop_unconfirmed');
    expect(f.results(r.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'stop_unconfirmed' }, { status: 'not_run' }]);
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
  });
  it('unconfirmed stop retains both data-root occupancy and repository guard; another root cannot bypass', async () => {
    const fake = gatedProcess(false); const f = await setup(fake.port);
    const r = await f.execution.submit(owner, await f.request([check('a', ['node', '--version'])]));
    await fake.started;
    expect((await f.execution.cancel(owner, f.projectId, r.operationId!)).reasonCode).toBe('stop_unconfirmed');
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    await expect(f.execution.submit(owner, await f.request([check('a', ['node', '--version'])]))).rejects.toMatchObject({ code: 'resource_busy' });
    const binding = await f.app.stateStore.getRepositoryBinding(f.projectId);
    await expect(createBaselineRepositoryGuard().acquire({ canonicalPath: binding.canonicalPath, gitCommonDir: binding.gitCommonDir!, operationId: randomUUID() })).rejects.toMatchObject({ code: 'resource_busy' });
  });
  it('transaction fault on check event rolls back result and keeps occupancy, without fake passed', async () => {
    const f = await setup(undefined, store => ({ ...store, transact: (op, cb) => store.transact(op, tx => cb({ ...tx, appendBaselineEvent: input => {
      if ((input as { type: string }).type === 'baseline.check_completed') throw new Error('injected event failure'); tx.appendBaselineEvent(input);
    } })) }));
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '--version'])]));
    await f.execution.waitForIdle();
    expect(f.results(r.operationId!)[0]).toMatchObject({ status: 'not_run', revision: 1 });
    expect(f.app.baselineStore.getBaselineOperation(r.operationId!)?.status).toBe('running');
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    expect(f.execution.diagnostics()).toMatchObject([{ operationId: r.operationId, reasonCode: 'evidence_incomplete' }]);
  });
  it('final event failure rolls back the terminal state and release together', async () => {
    const f = await setup(undefined, store => ({ ...store, transact: (op, cb) => store.transact(op, tx => cb({ ...tx, appendBaselineEvent: input => {
      if ((input as { type: string }).type === 'baseline.completed') throw new Error('injected final event failure'); tx.appendBaselineEvent(input);
    } })) }));
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '--version'])]));
    await f.execution.waitForIdle();
    expect(f.app.baselineStore.getBaselineOperation(r.operationId)?.status).toBe('running');
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    expect(f.session.database.prepare("SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'baseline.completed'").get()).toEqual({ n: 0 });
    await expect(f.execution.submit(owner, await f.request([check('a', [process.execPath, '--version'])]))).rejects.toMatchObject({ code: 'resource_busy' });
  });
  it('denied and empty plans launch nothing; direct application cancel enforces current permission', async () => {
    const fake = gatedProcess(); const f = await setup(fake.port);
    const request = await f.request([check('a', ['node', '--version'])]);
    const reader = createRestrictedPrincipal({ capabilities: ['baseline.read'], projectScope: { kind: 'all' } });
    await expect(f.execution.submit(reader, request)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.app.baselineExecutionService.submit(owner, command('baseline.run', f.projectId, {
      decision: 'authorize', plan: { checks: [] }, previewDigest: 'a'.repeat(64),
    }))).rejects.toMatchObject({ code: 'invalid_input' });
    const declined = await f.app.baselineExecutionService.submit(owner, { ...request, payload: { ...request.payload as object, decision: 'decline' } });
    expect(declined.status).toBe('completed');
    expect(fake.starts()).toBe(0);
    const r = await f.execution.submit(owner, { ...request, commandId: randomUUID() });
    await fake.started;
    await expect(f.execution.cancel(reader, f.projectId, r.operationId)).rejects.toMatchObject({ code: 'forbidden' });
    await f.execution.cancel(owner, f.projectId, r.operationId);
  });
  it('pre-start cancellation leaves all items not_run and releases only after the durable final event', async () => {
    const gate = deferred<void>(); const entered = deferred<void>();
    const guard = createBaselineRepositoryGuard();
    const fake = gatedProcess();
    const f = await setup(fake.port, undefined, () => ({ repositoryGuard: { async acquire(input) {
      const lease = await guard.acquire(input); entered.resolve(); await gate.promise; return lease;
    } } }));
    const r = await f.execution.submit(owner, await f.request([check('a', ['node', '--version'])]));
    await entered.promise;
    const cancellation = f.execution.cancel(owner, f.projectId, r.operationId);
    expect(f.app.baselineStore.getBaselineOperation(r.operationId)?.status).toBe('cancelling');
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    gate.resolve();
    expect((await cancellation).status).toBe('cancelled');
    expect(fake.starts()).toBe(0);
    expect(f.results(r.operationId)).toMatchObject([{ status: 'not_run', reasonCode: 'cancelled' }]);
    const events = f.session.database.prepare("SELECT event_type FROM state_events WHERE event_type LIKE 'baseline.%' ORDER BY sequence").all();
    expect(events).toMatchObject([{ event_type: 'baseline.authorized' }, { event_type: 'baseline.check_completed' }, { event_type: 'baseline.cancelled' }]);
  });
  it('source changed during supervisor handshake is rejected before any approved script runs', async () => {
    const real = createCommandProcessAdapter(); let released = false;
    const f = await setup({ start: (request, confirm, signal) => real.start(request, async identity => {
      writeFileSync(join(request.cwd, 'changed.ts'), 'changed before release');
      const ack = await confirm(identity); released = true; return ack;
    }, signal) });
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '--version'])]));
    await f.execution.waitForIdle();
    expect(released).toBe(false);
    expect(f.results(r.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'source_changed' }]);
    expect(f.app.baselineStore.getBaselineOperation(r.operationId)?.reasonCode).toBe('source_changed');
    expect(readFileSync(join(f.box.repos.withHead, 'changed.ts'), 'utf8')).toContain('changed');
  });
  it('publication fault never passes or releases exclusions even if the process returned zero', async () => {
    const f = await setup(undefined, undefined, app => ({ files: createFaultyArtifactFileStore(app.artifactFileStore, { times: Infinity }).store }));
    const r = await f.execution.submit(owner, await f.request([check('a', [process.execPath, '--version']), check('b', [process.execPath, '--version'])]));
    await f.execution.waitForIdle();
    expect(f.results(r.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'evidence_incomplete' }, { status: 'not_run' }]);
    expect(f.app.baselineStore.getBaselineOperation(r.operationId)).toMatchObject({ status: 'running', reasonCode: 'evidence_incomplete' });
    expect(f.app.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    const binding = await f.app.stateStore.getRepositoryBinding(f.projectId);
    await expect(createBaselineRepositoryGuard().acquire({ canonicalPath: binding.canonicalPath, gitCommonDir: binding.gitCommonDir!, operationId: randomUUID() })).rejects.toMatchObject({ code: 'resource_busy' });
  });
  it('two actual Core data roots exclude related workspaces sharing public Git resources', async () => {
    const fake = gatedProcess(); const f = await setup(fake.port);
    const linked = join(f.box.root, 'linked');
    execFileSync('git', ['-C', f.box.repos.withHead, 'worktree', 'add', '--detach', linked, 'HEAD'], {
      env: f.box.childEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }), timeout: 10_000, maxBuffer: 1_048_576, stdio: 'pipe',
    });
    const r = await f.execution.submit(owner, await f.request([check('a', ['node', '--version'])])); await fake.started;
    const other = await openCoreApplication({ dataRoot: f.box.dataRoot('other'), capabilityCatalog: catalog });
    try {
      const registered = await other.projectService.registerRepository({ repositoryPath: linked, displayName: 'other' });
      const projectId = registered.project.id;
      const plan = { checks: [check('a', [process.execPath, '--version'])] };
      const preview = await other.baselineService.previewBaseline(owner, projectId, { plan });
      const competing = await other.baselineExecutionService.submit(owner, command('baseline.run', projectId, { decision: 'authorize', plan, previewDigest: preview.previewDigest }));
      if (competing.status !== 'accepted') throw new Error('Expected accepted');
      await other.baselineExecutionService.waitForIdle();
      expect(other.baselineStore.getBaselineOperation(competing.operationId)).toMatchObject({ status: 'failed', reasonCode: 'baseline_in_progress', startedAtUtcMs: null });
      expect(other.baselineStore.listBaselineCheckResults(competing.operationId)).toMatchObject([{ status: 'not_run' }]);
      expect(fake.starts()).toBe(1);
      fake.finish(); await f.execution.waitForIdle();
      const next = await other.baselineService.previewBaseline(owner, projectId, { plan });
      const after = await other.baselineExecutionService.submit(owner, command('baseline.run', projectId, { decision: 'authorize', plan, previewDigest: next.previewDigest }));
      if (after.status !== 'accepted') throw new Error('Expected accepted');
      await other.baselineExecutionService.waitForIdle();
      expect(other.baselineStore.listBaselineCheckResults(after.operationId)).toMatchObject([{ status: 'passed' }]);
    } finally { await f.execution.cancel(owner, f.projectId, r.operationId); other.close(); }
  });
});
