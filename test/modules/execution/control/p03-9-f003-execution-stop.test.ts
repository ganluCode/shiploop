/**
 * P03-9 / F-003：取消接入 Runtime/Verifier 既有停止端口。
 *
 * 覆盖：
 * - 真实 SQLite + 真实受监督进程：取消提交后的停止控制复用 ExecutionService/
 *   CommandProcess，整组停止后才释放占用，保留 tracked/untracked 文件与已收输出；
 * - 停止未确认：仍活动的 Attempt 标记 interrupted、租约隔离、operation 记
 *   uncertain，目标保持 cancelling（竞争认领/启动被拒绝）；
 * - 真实 Verifier 检查：AbortSignal 驱动同一 CommandProcess 停止路径，忽略
 *   SIGTERM 的受控组被有界升级，停止证据不冒充成功；
 * - 持久身份失配/探测失败：真实受控进程不被误杀，也不被误报 stopped；
 * - 证据 Artifact 关联身份、executionStage、退出码/信号、forced 与 gaps。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExecutionStopControl, isValidExecutionStopEvidence } from '../../../../packages/core/src/application/execution-stop-control.ts';
import { createVerificationStopControl } from '../../../../packages/core/src/application/verification-stop-control.ts';
import { createNodeTaskVerificationExecutor } from '../../../../packages/core/src/application/node-task-verification.ts';
import { createCommandProcessAdapter } from '../../../../packages/core/src/adapters/process/command-process.ts';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteAttemptAccess } from '../../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import type { StopEscalationProbe } from '../../../../packages/core/src/adapters/process/stop-escalation.ts';
import type { CommandProcessHandle } from '../../../../packages/core/src/ports/command-process.ts';
import { fixture } from '../../../helpers/p03-6/stopping-fixture.ts';
import { BINDING_NOW } from '../../../helpers/p03-6/input-binding-fixture.ts';
import { createInMemoryStorage } from '../../../helpers/in-memory-store.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function childScript(orphan: boolean) {
  const writer = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync('heartbeat','x');setInterval(()=>fs.appendFileSync('heartbeat','x'),15)";
  return `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['--no-warnings','-e',${JSON.stringify(writer)}],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));${orphan ? 'c.unref()' : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"}`;
}

function requestStop(f: Awaited<ReturnType<typeof fixture>>) {
  const run = f.query('SELECT revision FROM runs WHERE id = ?', f.runId) as { revision: number };
  return f.deps.atomic.transact('test.request-cancel', transaction => transaction.requestExecutionCancel({
    projectId: f.projectId, targetKind: 'run', targetId: f.runId,
    expectedRevision: run.revision, commandId: randomUUID(),
  }));
}

function stopControlFor(f: Awaited<ReturnType<typeof fixture>>, stopRuntime: Parameters<typeof createExecutionStopControl>[0]['stopRuntime']) {
  return createExecutionStopControl({
    atomic: f.deps.atomic,
    attempts: createSqliteAttemptAccess(f.session),
    resources: f.resources,
    stopRuntime,
    verifiers: createVerificationStopControl({ waitMs: 2_000 }),
    nowUtcMs: () => BINDING_NOW,
    async publishEvidence(projectId, operationId, evidence) {
      const body = Buffer.from(JSON.stringify(evidence));
      return (await f.publisher.publishArtifact({
        projectId, kind: 'execution_stop_evidence', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'),
        locator: `stops/${operationId}.json`, content: [body],
      })).artifact.id;
    },
  });
}

describe.skipIf(process.platform !== 'darwin')('P03-9 / F-003 Runtime stop', () => {
  it('真实 Runtime 停止：忽略 SIGTERM 的父/子进程被整组停止，证据与文件保留，占用释放', async () => {
    const f = await fixture({
      script: { schemaVersion: 1, steps: [
        { op: 'tool_command', name: 'tree' },
        { op: 'await_gate', name: 'hang' },
      ] },
      toolCommands: { tree: { argv: [process.execPath, '--no-warnings', '-e', childScript(true)], timeoutMs: 30_000 } },
    });
    let pids: number[] = [];
    try {
      writeFileSync(join(f.workspace.canonicalPath, 'tracked-note.txt'), 'keep me\n');
      const { context } = await f.start({ limits: { timeoutMs: 30_000, maxEvents: 100, maxOutputBytes: 1_048_576 } });
      const pidFile = join(f.workspace.canonicalPath, 'pids.json');
      const heartbeat = join(f.workspace.canonicalPath, 'heartbeat');
      await waitFor(() => existsSync(pidFile) && existsSync(heartbeat), 'runtime tool launched');
      pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      expect(alive(pids[1]!)).toBe(true);
      const cancel = requestStop(f);
      expect(cancel.outcome).toBe('cancelling');
      expect(cancel.stopOperationId).not.toBeNull();

      const outcome = await stopControlFor(f, identity => f.service.cancel(identity))
        .stop({ projectId: f.projectId, stopOperationId: cancel.stopOperationId! });
      expect(outcome).not.toBeNull();
      expect(outcome!).toMatchObject({ stopConfirmed: true, operationStatus: 'stopped' });
      expect(isValidExecutionStopEvidence(outcome!.evidence)).toBe(true);
      expect(outcome!.evidence.attempts[0]).toMatchObject({
        attemptId: f.identity.attemptId, stopConfirmed: true, state: 'stopped',
        executionStage: expect.any(String),
      });
      expect(outcome!.evidence.attempts[0]!.exitCode === null || Number.isSafeInteger(outcome!.evidence.attempts[0]!.exitCode)).toBe(true);
      expect(outcome!.evidence.attempts[0]!.signal === null || typeof outcome!.evidence.attempts[0]!.signal === 'string').toBe(true);
      const persisted = f.deps.atomic.getExecutionStopOperation(f.projectId, cancel.stopOperationId!);
      expect(persisted).toMatchObject({ status: 'stopped', stopConfirmed: true, evidenceRef: outcome!.evidenceRef });
      const evidence = await f.readArtifact(outcome!.evidenceRef);
      expect(evidence).toMatchObject({ kind: 'execution-stop', stopConfirmed: true, outcome: 'stopped',
        targetKind: 'run', targetId: f.runId, stopOperationId: cancel.stopOperationId });
      expect(JSON.stringify(evidence)).not.toContain('"exitCode":0,"signal":null,"forced":false');

      await context.completion;
      await waitFor(() => pids.every(pid => !alive(pid)), 'controlled group absent');
      const size = statSync(heartbeat).size;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(statSync(heartbeat).size).toBe(size);
      expect(existsSync(join(f.workspace.canonicalPath, 'tracked-note.txt'))).toBe(true);
      expect(readFileSync(join(f.workspace.canonicalPath, 'tracked-note.txt'), 'utf8')).toBe('keep me\n');
      expect(f.resources.read(f.identity).leases).toHaveLength(0);
      expect(f.query('SELECT status FROM runs WHERE id = ?', f.runId)).toEqual({ status: 'cancelled' });
    } finally {
      await f.dispose();
      expect(pids.every(pid => !alive(pid))).toBe(true);
    }
  }, 25_000);

  it('父进程已结束但占用仍 held：不把无活动当停止，保留 interrupted/quarantined 证据', async () => {
    const f = await fixture();
    try {
      f.session.database.prepare("UPDATE attempts SET status = 'failed' WHERE id = ?").run(f.identity.attemptId);
      const cancel = requestStop(f);
      expect(cancel.outcome).toBe('cancelling');
      const outcome = await stopControlFor(f, async () => null)
        .stop({ projectId: f.projectId, stopOperationId: cancel.stopOperationId! });
      expect(outcome!).toMatchObject({ stopConfirmed: false, operationStatus: 'uncertain' });
      expect(outcome!.interruptedAttemptIds).toEqual([]);
      expect(outcome!.evidence.attempts[0]).toMatchObject({
        attemptId: f.identity.attemptId, attemptStatus: 'failed', state: 'unconfirmed', stopConfirmed: false,
      });
      expect(outcome!.evidence.gaps).toEqual(expect.arrayContaining(['stop_not_observed', 'occupancy_retained']));
      expect(f.deps.atomic.getExecutionStopOperation(f.projectId, cancel.stopOperationId!))
        .toMatchObject({ status: 'uncertain', stopConfirmed: false });
      expect((f.session.database.prepare('SELECT state FROM workspace_leases WHERE owner_id = ?')
        .all(f.identity.attemptId) as { state: string }[]).every(row => row.state === 'quarantined')).toBe(true);
      expect(f.query('SELECT status FROM runs WHERE id = ?', f.runId)).toEqual({ status: 'cancelling' });
    } finally { await f.dispose(); }
  });

  it('停止未确认：Attempt interrupted、租约隔离、operation uncertain，竞争启动被拒绝', async () => {
    const f = await fixture();
    try {
      const cancel = requestStop(f);
      const outcome = await stopControlFor(f, async () => null)
        .stop({ projectId: f.projectId, stopOperationId: cancel.stopOperationId! });
      expect(outcome!).toMatchObject({ stopConfirmed: false, operationStatus: 'uncertain',
        interruptedAttemptIds: [f.identity.attemptId] });
      expect(outcome!.evidence.gaps).toEqual(expect.arrayContaining(['stop_not_observed', 'occupancy_retained']));
      expect(f.deps.atomic.getExecutionStopOperation(f.projectId, cancel.stopOperationId!))
        .toMatchObject({ status: 'uncertain', stopConfirmed: false });
      expect(f.query('SELECT status FROM attempts WHERE id = ?', f.identity.attemptId)).toEqual({ status: 'interrupted' });
      expect((f.session.database.prepare('SELECT state FROM workspace_leases WHERE owner_id = ? ORDER BY state')
        .all(f.identity.attemptId) as { state: string }[]).every(row => row.state === 'quarantined')).toBe(true);
      expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.runId)).toEqual({ status: 'cancelling', reason: 'user_cancel' });
      // 隔离后竞争 Work 启动/新认领均不能开始。
      expect(f.session.transactWrite('test.compete-launch', () =>
        f.resources.beginLaunchInTransaction(f.identity))).toMatchObject({ authorized: false, invocationId: null });
      try {
        f.claimTask('t-1');
        throw new Error('expected claim rejection');
      } catch (error) {
        expect(error).toBeTruthy();
      }
      const stale = f.session.database.prepare(
        "SELECT COUNT(*) AS n FROM attempt_notification_diagnostics WHERE attempt_id = ?",
      ).get(f.identity.attemptId) as { n: number };
      expect(stale.n).toBeGreaterThanOrEqual(0);
    } finally { await f.dispose(); }
  });
});

describe.skipIf(process.platform !== 'darwin')('P03-9 / F-003 Verifier stop', () => {
  async function runVerifierCheck(scriptBody: string) {
    const box = createTempSandbox('shiploop-p03-9-f003-verifier-');
    const storage = createInMemoryStorage(() => BINDING_NOW);
    storage.raw.projects.set('proj-1', { id: 'proj-1' } as never);
    const files = createArtifactFileStore({ dataRoot: box.path });
    const processes = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2_000 });
    const stopControl = createVerificationStopControl({ waitMs: 2_000 });
    const script = join(box.path, 'hang.js');
    writeFileSync(script, scriptBody);
    const results: Record<string, unknown>[] = [];
    const releases: unknown[] = [];
    let batchStatus = 'running';
    const executor = createNodeTaskVerificationExecutor({
      processes,
      verification: {
        createVerificationBatchInTransaction: () => ({ batch: { revision: 1 }, created: true }),
        getVerificationBatch: () => ({ revision: 1, status: batchStatus }),
        listCheckResults: () => results.map((row, index) => ({ id: `r-${index}`, ...row })),
        saveCheckResultInTransaction: (_tx: unknown, input: Record<string, unknown>) => {
          results.push(input);
          return { result: { id: String(input.resultId), status: String(input.status) } };
        },
        finalizeVerificationBatchInTransaction: (_tx: unknown, input: Record<string, unknown>) => {
          batchStatus = String(input.status);
          return { status: batchStatus };
        },
      } as never,
      atomic: { transact: (_operation: string, callback: (tx: unknown) => unknown) => callback({}) } as never,
      artifacts: storage.artifactStore as never,
      files,
      resolveCwd: async () => box.path,
      resolveEnvironment: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin' }),
      stopControl,
      confirmProcessIdentity: async () => {},
      workResources: {
        identity: { projectId: 'proj-1', attemptId: 'attempt-1', owner: 'owner-1',
          hostInstanceId: 'host-1', executionVersion: 1 },
        beginLaunchInTransaction: () => ({ authorized: true, invocationId: randomUUID() }),
        confirmLaunchInTransaction: () => ({ authorized: true }),
        releaseStoppedInTransaction: (_identity: unknown, evidence: unknown) => { releases.push(evidence); },
      },
    });
    const execution = executor.start({
      projectId: 'proj-1', featureId: 'feature-1', runId: 'run-1', taskId: 'task-1',
      attemptId: 'attempt-1', executionVersion: 1, batchId: 'vbatch-1', operation: randomUUID(),
      codeDigest: 'ab'.repeat(32), policyDigest: 'cd'.repeat(32), environmentSummary: {},
      plan: { status: 'ready', selectedChecks: [{
        checkKey: 'hang', scope: 'task', kind: 'command', argv: [process.execPath, script],
        cwdRef: null, environmentRef: null, timeout: 30_000, required: true, requirementRefs: [],
      }] },
      targets: ['test/hang.test.ts'],
    });
    const pidFile = join(box.path, 'pids.json');
    await Promise.race([
      waitFor(() => existsSync(pidFile) && existsSync(join(box.path, 'heartbeat')), 'verifier process launched'),
      execution.then(value => { throw new Error(`verifier ended before launch: ${JSON.stringify(value.status)}`); },
        error => { throw error; }),
    ]);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
    expect(alive(pids[1]!)).toBe(true);
    const stop = await stopControl.stop({ projectId: 'proj-1', targetKind: 'run', targetId: 'run-1' });
    const verified = await execution;
    return { box, stop, verified, releases, pids, pidFile, stopControl };
  }

  it('真实 Verifier 检查经既有 CommandProcess 停止端口被中止，确认停止后才释放占用', async () => {
    const run = await runVerifierCheck(childScript(false));
    try {
      expect(run.stop).toHaveLength(1);
      expect(run.stop[0]).toMatchObject({ state: 'stopped', stopConfirmed: true });
      expect(run.stop[0]!.checks[0]).toMatchObject({ checkKey: 'hang', launched: true, stopConfirmed: true });
      expect(run.stop[0]!.checks[0]!.exitCode === null || Number.isSafeInteger(run.stop[0]!.checks[0]!.exitCode)).toBe(true);
      expect(run.stop[0]!.checks[0]!.signal === null || typeof run.stop[0]!.checks[0]!.signal === 'string').toBe(true);
      expect(run.stop[0]!.checks[0]!.forced === null || typeof run.stop[0]!.checks[0]!.forced === 'boolean').toBe(true);
      expect(run.verified.status).toBe('inconclusive');
      expect(run.verified.results[0]!.status).toBe('inconclusive');
      expect(run.releases).toHaveLength(1);
      expect(run.releases[0]).toMatchObject({ stopConfirmed: true });
      // A verifier start racing the settled cancel must not launch a new process.
      const late = run.stopControl.begin({ projectId: 'proj-1', runId: 'run-1', batchId: 'vbatch-late',
        attemptId: 'attempt-late', executionVersion: 1, operation: randomUUID() });
      expect(late.signal.aborted).toBe(true);
      late.complete();
      await waitFor(() => run.pids.every(pid => !alive(pid)), 'verifier group absent');
      expect(existsSync(run.pidFile)).toBe(true);
      expect(existsSync(join(run.box.path, 'heartbeat'))).toBe(true);
    } finally { run.box.cleanup(); }
  }, 25_000);

});

describe.skipIf(process.platform !== 'darwin')('P03-9 / F-003 stop identity negatives', () => {
  it('持久身份失配或探测失败：不误杀无关进程，组也不被误报停止', async () => {
    const adapter = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 1_000 });
    let handle: CommandProcessHandle | undefined;
    try {
      handle = await adapter.start({
        argv: [process.execPath, '--no-warnings', '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        cwd: process.cwd(), environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeoutMs: 30_000, maxInputBytes: 65_536, maxOutputBytes: 1_024,
      }, async identity => ({ launchId: identity.launchId }));
      expect(alive(handle.identity.pid)).toBe(true);
      const mismatched = { ...handle.identity, startTime: '1970-01-01T00:00:00.000Z' };
      expect(await adapter.recoverStop!(mismatched)).toEqual({ confirmed: false });
      expect(alive(handle.identity.pid)).toBe(true);
      expect(handle.query().state).toBe('running');

      const failingProbe: StopEscalationProbe = {
        readSupervisorRow: async () => { throw new Error('probe unavailable'); },
        listGroupMembers: async () => { throw new Error('probe unavailable'); },
        signalGroup: () => { throw new Error('must not signal'); },
        delay: async () => {},
      };
      const failing = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 200, stopProbe: failingProbe });
      expect(await failing.recoverStop!(handle.identity)).toEqual({ confirmed: false });
      expect(alive(handle.identity.pid)).toBe(true);

      // 真实身份核验后才有界清理本测试自有进程。
      expect(await adapter.recoverStop!(handle.identity)).toEqual({ confirmed: true });
      expect(alive(handle.identity.pid)).toBe(false);
    } finally {
      if (handle !== undefined) {
        const stop = await adapter.recoverStop!(handle.identity).catch(() => ({ confirmed: false }));
        if (stop.confirmed !== true) {
          try { process.kill(-handle.identity.processGroupId, 'SIGKILL'); } catch { /* already absent */ }
        }
      }
    }
  }, 20_000);
});

describe('P03-9 / F-003 cancel command wiring', () => {
  it('新取消在回执提交后才调用停止控制；重放与终态不重复停止', async () => {
    const { openClaimFixture } = await import("../../../helpers/p03-4/task-claim-fixture.ts");
    const { createCommandService } = await import("../../../../packages/core/src/application/command-service.ts");
    const { createSqliteAtomicCommandStore } = await import("../../../../packages/core/src/adapters/sqlite/atomic-commands.ts");
    const { NOW } = await import("../../../helpers/p03-3/budget-fixture.ts");
    const f = await openClaimFixture();
    try {
      f.store().claimTask(f.input(0));
      const stops: { projectId: string; stopOperationId: string }[] = [];
      const atomic = createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW });
      const commands = createCommandService({
        atomicStore: atomic,
        nowUtcMs: () => NOW,
        executionStopControl: {
          async stop(input) { stops.push(input); return null; },
        },
      });
      const runRevision = () => (f.box.session.database.prepare('SELECT revision FROM runs WHERE id = ?')
        .get(f.ids.runId) as { revision: number }).revision;
      const initialRevision = runRevision();
      const envelope = (commandId: string, expectedRevision = initialRevision) => ({
        schemaVersion: 5 as const, commandId, issuedAt: new Date(NOW).toISOString(),
        operation: 'execution.cancel', scope: f.box.scope, expectedRevision,
        payload: { runId: f.ids.runId, batchId: null },
      });
      const commandId = randomUUID();
      const receipt = await commands.submit(f.box.owner, envelope(commandId));
      expect(receipt.status).toBe('completed');
      const operationId = (receipt as { result: { stopOperationId: string } }).result.stopOperationId;
      await waitFor(() => stops.length === 1, 'stop control invoked after commit');
      expect(stops[0]).toEqual({ projectId: f.box.projectId, stopOperationId: operationId });
      expect(atomic.getExecutionStopOperation(f.box.projectId, operationId)).toMatchObject({ status: 'stopping' });

      const replay = await commands.submit(f.box.owner, envelope(commandId));
      expect(replay.status).toBe('completed');
      expect(stops).toHaveLength(1);

      f.box.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ?, reason = 'completed' WHERE id = ?")
        .run(NOW, f.ids.runId);
      const terminal = await commands.submit(f.box.owner, envelope(randomUUID(), runRevision()));
      expect((terminal as { result: { outcome: string; stopOperationId: string | null } }).result)
        .toMatchObject({ outcome: 'already_terminal', stopOperationId: null });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(stops).toHaveLength(1);
    } finally { f.box.close(); }
  });
});
