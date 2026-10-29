import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  RUNTIME_EXECUTION_SCHEMA_VERSION,
  validateRuntimeExecutionRequest,
} from '../../../../packages/core/src/ports/runtime-execution.ts';
import {
  MAX_CONCURRENT_WORKS_MAX,
  TOOL_TIMEOUT_MS_MAX,
  TOOL_TIMEOUT_MS_MIN,
  WORK_TIMEOUT_MS_MIN,
  validateSettingsPayload,
} from '../../../../packages/core/src/ports/settings-schema.ts';
import {
  DEFAULT_TOOL_TIME_LIMIT_MS,
  resolveExecutionDeadlines,
  resolveLayerTimeoutMs,
} from '../../../../packages/core/src/ports/execution-time-limits.ts';
import { selectTaskStrategy, validateTaskExecutionConfig } from '../../../../packages/core/src/application/task-strategy-selection.ts';
import { createFakeRuntimeGate } from '../../../../packages/core/src/adapters/fake-runtime.ts';
import { createNodeTaskVerificationExecutor } from '../../../../packages/core/src/application/node-task-verification.ts';
import { createCommandProcessAdapter } from '../../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessPort } from '../../../../packages/core/src/ports/command-process.ts';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createInMemoryStorage } from '../../../helpers/in-memory-store.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { fixture } from '../../../helpers/p03-6/stopping-fixture.ts';
import { BINDING_NOW } from '../../../helpers/p03-6/input-binding-fixture.ts';

const digest = 'a'.repeat(64);
const strategy = { runtime: 'fake', provider: 'provider', model: 'model' };

function inputRef(purpose: string) {
  return {
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'application/json', origin: { kind: 'artifact' },
  };
}

function validRequest() {
  return {
    schemaVersion: RUNTIME_EXECUTION_SCHEMA_VERSION,
    projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1', executionVersion: 1,
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', strategy,
    prompt: inputRef('prompt'), inputManifest: inputRef('manifest'),
    cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.write'], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 },
    recovery: { mode: 'new' },
  };
}

function settlement(f: Awaited<ReturnType<typeof fixture>>) {
  const row = f.query('SELECT result_ref FROM sessions') as { result_ref: string };
  return f.readArtifact(row.result_ref);
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function childScript() {
  const writer = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync('heartbeat','x');setInterval(()=>fs.appendFileSync('heartbeat','x'),15)";
  return `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['--no-warnings','-e',${JSON.stringify(writer)}],{stdio:'ignore'});fs.writeFileSync('pids.json.tmp',JSON.stringify([process.pid,c.pid]));fs.renameSync('pids.json.tmp','pids.json');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
}

function verifierHarness(nowUtcMs?: () => number) {
  const box = createTempSandbox('shiploop-p03-9-f004-check-');
  const storage = createInMemoryStorage(() => Date.now());
  storage.raw.projects.set('proj-1', { id: 'proj-1' } as never);
  const files = createArtifactFileStore({ dataRoot: box.path });
  const results: Record<string, unknown>[] = [];
  let batchStatus = 'running';
  let starts = 0;
  const processes: CommandProcessPort = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2_000 });
  return {
    box, results, processes,
    starts: () => starts,
    executor: createNodeTaskVerificationExecutor({
      processes: { ...processes, start: async (request, confirm, signal) => {
        starts += 1;
        return processes.start(request, confirm, signal);
      } },
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
      confirmProcessIdentity: async () => {},
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    }),
  };
}

function checkInput(options: { timeout: number; deadlineUtcMs?: number }) {
  return {
    projectId: 'proj-1', featureId: 'feature-1', runId: 'run-1', taskId: 'task-1',
    attemptId: 'attempt-1', executionVersion: 1, batchId: 'vbatch-1', operation: 'check',
    evidenceOperationId: randomUUID(),
    codeDigest: 'ab'.repeat(32), policyDigest: 'cd'.repeat(32), environmentSummary: {},
    targets: ['test/hang.test.ts'],
    ...(options.deadlineUtcMs === undefined ? {} : { deadlineUtcMs: options.deadlineUtcMs, deadlineLayer: 'run' as const }),
    plan: { status: 'ready' as const, selectedChecks: [{
      checkKey: 'hang', scope: 'task' as const, kind: 'command' as const,
      argv: [process.execPath, '--no-warnings', '-e', 'setInterval(()=>{},1000)'],
      cwdRef: null, environmentRef: null, timeout: options.timeout, required: true, requirementRefs: [],
    }] },
  };
}

describe('P03-9 / F-004 layered time limits', () => {
  it('reuses the v2 policy/task snapshot for Session and tool limits and rejects invalid extensions', () => {
    const payload = validateSettingsPayload({
      schemaVersion: 2,
      strategies: { defaultStrategy: strategy },
      policies: { executionLimits: { maxConcurrentWorks: MAX_CONCURRENT_WORKS_MAX, workTimeoutMs: 120_000, toolTimeoutMs: 5_000 } },
    }, { operation: 'test' });
    expect(payload.policies?.executionLimits).toMatchObject({ workTimeoutMs: 120_000, toolTimeoutMs: 5_000 });

    const selection = selectTaskStrategy({ global: { scopeRevision: 1, payload } });
    expect(selection.executionConfig).toMatchObject({ workTimeoutMs: 120_000, toolTimeoutMs: 5_000 });
    expect(validateTaskExecutionConfig(selection.executionConfig, 'test')).toEqual(selection.executionConfig);

    // 旧 v2 payload 无新增键仍有效，任务快照也不注入“无限”缺省。
    const legacy = selectTaskStrategy({
      global: { scopeRevision: 1, payload: { schemaVersion: 2, strategies: { defaultStrategy: strategy } } },
    });
    expect(legacy.executionConfig).not.toHaveProperty('workTimeoutMs');
    expect(legacy.executionConfig).not.toHaveProperty('toolTimeoutMs');
    expect(() => validateSettingsPayload({ schemaVersion: 3, policies: {} }, { operation: 'test' })).toThrow();

    for (const toolTimeoutMs of [0, TOOL_TIMEOUT_MS_MIN - 1, TOOL_TIMEOUT_MS_MAX + 1, 1.5, '1000']) {
      expect(() => validateSettingsPayload({
        schemaVersion: 2, policies: { executionLimits: { toolTimeoutMs } },
      }, { operation: 'test' })).toThrow();
      expect(() => validateTaskExecutionConfig({ schemaVersion: 2, ...strategy, toolTimeoutMs }, 'test')).toThrow();
    }
    expect(() => validateTaskExecutionConfig({ schemaVersion: 2, ...strategy, workTimeoutMs: WORK_TIMEOUT_MS_MIN - 1 }, 'test'))
      .toThrow();
  });

  it('accepts toolTimeoutMs as a compatible runtime limit only when it does not exceed the Session', () => {
    const accepted = validateRuntimeExecutionRequest({
      ...validRequest(),
      limits: { timeoutMs: 60_000, toolTimeoutMs: 5_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 },
    });
    expect(accepted.limits.toolTimeoutMs).toBe(5_000);
    expect(validateRuntimeExecutionRequest(validRequest()).limits).toEqual({
      timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 1_048_576,
    });
    expect(() => validateRuntimeExecutionRequest({
      ...validRequest(), limits: { timeoutMs: 5_000, toolTimeoutMs: 6_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 },
    })).toThrow();
  });

  it('resolves Session, Run and Batch independently from the persisted run start', () => {
    const base = {
      nowUtcMs: 10_000, sessionTimeLimitMs: 60_000, toolTimeLimitMs: 5_000, checkTimeLimitMs: 8_000,
      runStartedAtUtcMs: 5_000, runTimeLimitMs: 4_000, batchDeadlineUtcMs: 100_000,
    };
    expect(resolveExecutionDeadlines(base)).toMatchObject({
      sessionDeadlineUtcMs: 70_000, runDeadlineUtcMs: 9_000, batchDeadlineUtcMs: 100_000,
      effectiveDeadlineUtcMs: 9_000, effectiveLayer: 'run', remainingMs: 0, expired: true,
      expiredLayers: ['run'], toolTimeoutMs: 5_000, checkTimeoutMs: 8_000,
    });
    const sessionBinds = resolveExecutionDeadlines({
      ...base, runStartedAtUtcMs: 10_000, runTimeLimitMs: 60_000, sessionTimeLimitMs: 1_500,
    });
    expect(sessionBinds).toMatchObject({ effectiveLayer: 'session', remainingMs: 1_500, expired: false });
    const batchBinds = resolveExecutionDeadlines({
      ...base, sessionTimeLimitMs: 60_000, runStartedAtUtcMs: 9_000, runTimeLimitMs: 60_000, batchDeadlineUtcMs: 10_500,
    });
    expect(batchBinds).toMatchObject({ effectiveLayer: 'batch', remainingMs: 500, expired: false });
    // 工具/检查是 Session 内子额度：自身配置更大时被 Session 剩余额度收窄。
    expect(resolveExecutionDeadlines({
      ...base, sessionTimeLimitMs: 1_000, toolTimeLimitMs: 5_000, checkTimeLimitMs: 8_000,
      runStartedAtUtcMs: 10_000, runTimeLimitMs: 60_000, batchDeadlineUtcMs: 100_000,
    })).toMatchObject({ toolTimeoutMs: 1_000, checkTimeoutMs: 1_000 });

    for (const invalid of [
      { ...base, nowUtcMs: 0 },
      { ...base, sessionTimeLimitMs: 0 },
      { ...base, runTimeLimitMs: -1 },
      { ...base, batchDeadlineUtcMs: Number.POSITIVE_INFINITY },
      { ...base, runStartedAtUtcMs: 20_000 },
      { ...base, unknown: 1 },
    ]) {
      expect(() => resolveExecutionDeadlines(invalid)).toThrow();
    }
    expect(resolveLayerTimeoutMs({ limitMs: 5_000, sessionRemainingMs: 2_000, parentRemainingMs: 9_000 })).toBe(2_000);
    expect(resolveLayerTimeoutMs({ limitMs: 1_000, sessionRemainingMs: 9_000, parentRemainingMs: 9_000 })).toBe(1_000);
    expect(resolveLayerTimeoutMs({ limitMs: 5_000, sessionRemainingMs: 0, parentRemainingMs: 9_000 })).toBe(0);
    expect(resolveLayerTimeoutMs({ limitMs: null, sessionRemainingMs: 7_000, parentRemainingMs: 9_000 })).toBe(7_000);
    expect(DEFAULT_TOOL_TIME_LIMIT_MS).toBeGreaterThan(0);
  });

  it('does not start a new execution after the persisted Run or Batch deadline', async () => {
    const runExpired = await fixture();
    try {
      runExpired.session.database.prepare('UPDATE runs SET started_at = ?').run(BINDING_NOW - 3_600_001);
      await expect(runExpired.start()).rejects.toMatchObject({ details: { reason: 'run_time_exhausted' } });
      expect(runExpired.query('SELECT count(*) AS n FROM sessions')).toEqual({ n: 0 });
      expect(runExpired.rawHandles).toHaveLength(0);
      expect(runExpired.query('SELECT started_at FROM runs')).toEqual({ started_at: BINDING_NOW - 3_600_001 });
    } finally { await runExpired.dispose(); }

    const batchExpired = await fixture();
    try {
      batchExpired.session.database.prepare('UPDATE execution_batches SET deadline_at = ?').run(BINDING_NOW - 1);
      await expect(batchExpired.start()).rejects.toMatchObject({ details: { reason: 'deadline_exhausted' } });
      expect(batchExpired.query('SELECT count(*) AS n FROM sessions')).toEqual({ n: 0 });
      expect(batchExpired.rawHandles).toHaveLength(0);
    } finally { await batchExpired.dispose(); }
  });

  it('Session timeout uses controlled stop, preserves timeout layer/stage/elapsed and is not overwritten by a later cancel', async () => {
    const gate = createFakeRuntimeGate();
    const f = await fixture({ script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hang' }] }, gates: { hang: gate } });
    try {
      const { context } = await f.start({ limits: { timeoutMs: 1_000, maxEvents: 100, maxOutputBytes: 1_048_576 } });
      const completion = await context.completion;
      expect(completion).toMatchObject({ stopConfirmed: true, persisted: true, retained: true });
      const evidence = await settlement(f);
      expect(evidence.control).toMatchObject({
        reason: 'runtime_timeout', cancel: 'accepted',
        timeout: { layer: 'session', stage: 'runtime', limitMs: 1_000 },
      });
      expect(evidence.control.timeout.elapsedMs).toBeGreaterThanOrEqual(1_000);
      expect(f.query('SELECT status, execution_stage, error_kind FROM attempts'))
        .toEqual({ status: 'failed', execution_stage: 'runtime', error_kind: 'timeout' });
      const notifications = f.query('SELECT count(*) AS n FROM attempt_notifications');
      await f.service.cancel(f.identity);
      expect(f.query('SELECT count(*) AS n FROM attempt_notifications')).toEqual(notifications);
      expect((await settlement(f)).control).toEqual(evidence.control);
    } finally { await f.dispose(); }
  });

  it('tool timeout is independent from the Session and stops the real process group before any later side effect', async () => {
    const f = await fixture({
      script: { schemaVersion: 1, steps: [
        { op: 'usage', inputTokens: 7, outputTokens: null, costUsdMicros: null },
        { op: 'tool_command', name: 'tree' },
        { op: 'write_file', path: 'must-not-exist', content: 'bad' },
      ] },
      toolCommands: { tree: { argv: [process.execPath, '--no-warnings', '-e', childScript()], timeoutMs: 10_000 } },
    });
    let pids: number[] = [];
    try {
      const { context } = await f.start({ limits: { timeoutMs: 10_000, toolTimeoutMs: 1_000, maxEvents: 100, maxOutputBytes: 1_048_576 } });
      const pidFile = join(f.workspace.canonicalPath, 'pids.json');
      await waitFor(() => existsSync(pidFile), 'tool process launched');
      pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      const completion = await context.completion;
      expect(completion).toMatchObject({ stopConfirmed: true, persisted: true });
      const evidence = await settlement(f);
      expect(evidence.control).toMatchObject({
        reason: 'tool_timeout',
        timeout: { layer: 'tool', stage: 'runtime', limitMs: 1_000 },
      });
      expect(evidence.execution.result.usage).toEqual({ basis: 'synthetic', inputTokens: 7, outputTokens: null, costUsdMicros: null });
      await waitFor(() => pids.every(pid => !alive(pid)), 'tool process group absent');
      const heartbeat = join(f.workspace.canonicalPath, 'heartbeat');
      const size = statSync(heartbeat).size;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(statSync(heartbeat).size).toBe(size);
      expect(existsSync(join(f.workspace.canonicalPath, 'must-not-exist'))).toBe(false);
      expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'failed', error_kind: 'timeout' });
    } finally {
      await f.dispose();
      expect(pids.every(pid => !alive(pid))).toBe(true);
    }
  }, 15_000);

  it('rejects a tool allowance above the Session before any start', async () => {
    const f = await fixture();
    try {
      await expect(f.start({ limits: { timeoutMs: 1_000, toolTimeoutMs: 5_000, maxEvents: 100, maxOutputBytes: 1_048_576 } }))
        .rejects.toThrow(/toolTimeoutMs/);
      expect(f.query('SELECT count(*) AS n FROM sessions')).toEqual({ n: 0 });
      expect(f.rawHandles).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it('timeout with unconfirmed stop keeps the Attempt interrupted and occupancy quarantined', async () => {
    const f = await fixture({
      script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hang' }],
        lifecycle: { stopped: { unconfirmed: true } } },
      gates: { hang: createFakeRuntimeGate() },
    });
    try {
      const { context } = await f.start({ limits: { timeoutMs: 1_000, maxEvents: 100, maxOutputBytes: 1_048_576 } });
      expect(await context.completion).toMatchObject({ stopConfirmed: false, persisted: true, retained: false });
      const evidence = await settlement(f);
      expect(evidence.control).toMatchObject({ reason: 'runtime_timeout', timeout: { layer: 'session' } });
      expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'interrupted', error_kind: 'timeout' });
      expect(f.resources.read(f.identity).leases.map(lease => lease.state))
        .toEqual(['quarantined', 'quarantined', 'quarantined']);
      expect((await f.service.close()).closed).toBe(false);
    } finally { await f.dispose(); }
  }, 10_000);

  it('a Verifier check has its own bound and does not launch after the parent Run deadline', async () => {
    const now = Date.now();
    const h = verifierHarness(() => now);
    try {
      const result = await h.executor.start(checkInput({ timeout: 1_000, deadlineUtcMs: now - 1 }));
      expect(h.starts()).toBe(0);
      expect(result).toMatchObject({ status: 'inconclusive' });
      expect(h.results).toHaveLength(1);
      expect(h.results[0]).toMatchObject({ status: 'not_run', timedOut: false });
      expect(result.results[0]).toMatchObject({ status: 'not_run', reason: 'run_deadline_reached' });
    } finally { h.box.cleanup(); }
  });

  it('a hanging Verifier check times out at its own limit and records timedOut without waiting forever', async () => {
    const h = verifierHarness();
    try {
      const started = Date.now();
      const result = await h.executor.start(checkInput({ timeout: 1_000 }));
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(h.starts()).toBe(1);
      expect(h.results[0]).toMatchObject({ timedOut: true });
      expect(result.results[0]).toMatchObject({ status: 'error', reason: 'timed_out' });
      expect(result.status).toBe('error');
    } finally { h.box.cleanup(); }
  }, 15_000);
});
