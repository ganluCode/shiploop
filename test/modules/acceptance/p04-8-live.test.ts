import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createP04LiveBudget, redactP04Live, runP04Live, validateP04LiveApproval } from '../../../scripts/acceptance/p04-live.ts';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';
import { runP04LiveRunner } from '../../../scripts/acceptance/p04-live-runner.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p04-live-test-'))); dirs.push(root);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  git('add', 'greeting.txt');
  git('-c', 'user.name=Live test', '-c', 'user.email=live@example.invalid', 'commit', '-qm', 'fixture');
  const approval = { schemaVersion: 1, authorization: { approved: true, id: 'approval-1', expiresAt: Date.now() + 60_000 },
    provider: 'anthropic', model: 'claude-sonnet-4-5', authentication: { kind: 'environment', sourceRef: 'approved-key', variable: 'P04_TEST_KEY' },
    repository: repo, expectedCommit: git('rev-parse', 'HEAD'), resources: ['read_greeting', 'write_greeting'], fallback: [],
    budgets: { maxAttempts: 1, maxRequests: 3, timeoutMs: 30_000, maxInputTokens: 12_000, maxOutputTokens: 1024, maxTokens: 40_000 },
    scenario: 'change', reportDir: join(root, 'report') };
  const path = join(root, 'approval.json');
  const save = (value: unknown = approval) => writeFileSync(path, JSON.stringify(value)); save();
  return { root, repo, git, approval, path, save };
}

it('[case:missing-authorization-zero-call] missing approval fails with not_run and no executor call', async () => {
  const runProcess = vi.fn();
  const result = await runP04Live({ runProcess });
  expect(result).toMatchObject({ exitCode: 2, status: 'not_run', realCalls: 0 });
  expect(runProcess).not.toHaveBeenCalled();
});

it.each(['provider', 'model', 'authentication', 'repository', 'resources', 'budgets', 'fallback', 'authorization'])
('[case:missing-%s-zero-call] rejects missing required input before any runner', async field => {
  const f = fixture(); const raw: Record<string, unknown> = { ...f.approval }; delete raw[field]; f.save(raw);
  const runProcess = vi.fn();
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ exitCode: 2, status: 'not_run', realCalls: 0 });
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:example-denied-by-default] checked-in input template is not an authorization and never reaches a Runner', async () => {
  const runProcess = vi.fn();
  expect(await runP04Live({ approvalFile: 'acceptance/p04.live.example.json', environment: { SHIPLOOP_APPROVED_API_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ status: 'not_run', realCalls: 0 });
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:missing-auth-zero-call] does not discover local login or fall back when approved credential is missing', async () => {
  const f = fixture(), runProcess = vi.fn();
  expect(await runP04Live({ approvalFile: f.path, environment: {}, runProcess }))
    .toMatchObject({ exitCode: 2, status: 'not_run', realCalls: 0 });
  expect(runProcess).not.toHaveBeenCalled();
  expect(f.git('rev-parse', 'HEAD')).toBe(f.approval.expectedCommit);
  expect(readFileSync(join(f.repo, 'greeting.txt'), 'utf8')).toBe('hello\n');
});

it.each(['maxAttempts', 'maxRequests', 'timeoutMs', 'maxInputTokens', 'maxOutputTokens', 'maxTokens'])
('[case:budget-%s-zero-call] rejects absent or zero budget before launch', async field => {
  const f = fixture(), runProcess = vi.fn();
  f.save({ ...f.approval, budgets: { ...f.approval.budgets, [field]: 0 } });
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ status: 'not_run', realCalls: 0 });
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:drift-approval-and-policy-zero-call] rejects expired approval, strategy fallback, resource drift and changed Git input', async () => {
  const f = fixture(), runProcess = vi.fn();
  for (const changes of [
    { authorization: { ...f.approval.authorization, approved: false } },
    { authorization: { ...f.approval.authorization, expiresAt: 1 } },
    { fallback: [{ provider: 'other', model: 'other' }] }, { resources: ['bash'] }, { expectedCommit: 'a'.repeat(40) },
  ]) {
    f.save({ ...f.approval, ...changes });
    expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
      .toMatchObject({ status: 'not_run', realCalls: 0 });
  }
  f.save(); writeFileSync(join(f.repo, 'greeting.txt'), 'dirty');
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ status: 'not_run', realCalls: 0 });
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:budget-reservation] each request reserves tokens, enforces strategy/time/count and never refunds unknown usage', () => {
  const f = fixture(), a = validateP04LiveApproval(f.approval);
  let now = Date.now();
  const budget = createP04LiveBudget(a, () => now);
  expect(() => budget.admit('other', a.model, {})).toThrow();
  expect(() => budget.admit(a.provider, a.model, 'x'.repeat(12_000))).toThrow();
  expect(budget.snapshot().requests).toBe(0);
  budget.admit(a.provider, a.model, {}); budget.admit(a.provider, a.model, {}); budget.admit(a.provider, a.model, {});
  expect(() => budget.admit(a.provider, a.model, {})).toThrow();
  expect(budget.snapshot()).toMatchObject({ requests: 3, reservedTokens: 39_072 });
  const limited = createP04LiveBudget({ ...a, budgets: { ...a.budgets, maxTokens: 13_024 } });
  limited.admit(a.provider, a.model, {});
  expect(() => limited.admit(a.provider, a.model, {})).toThrow();
  const expired = createP04LiveBudget(a, () => now); now += 31_000;
  expect(() => expired.admit(a.provider, a.model, {})).toThrow();
});

const PASS: P02BoundedRunOutcome = { kind: 'exit', exitCode: 0, signal: null, durationMs: 1, timedOut: false,
  stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, spawnError: null, stoppedVerified: true };
function simulatedRunner(f: ReturnType<typeof fixture>, changes: Record<string, unknown> = {}) {
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const runProcess: typeof runBoundedProcess = async (command, args, opts) => {
    calls.push({ args, env: opts.env ?? {} });
    if (args[0] === '-e') return runBoundedProcess(command, args, opts);
    const input = JSON.parse(readFileSync(args[1]!, 'utf8'));
    writeFileSync(join(f.repo, 'greeting.txt'), 'hello pi\n');
    const values = [{ type: 'model_request_admitted' }, { type: 'provider_request_started' }, { type: 'tool_completed', name: 'write_greeting' }, { type: 'assistant_completed' }];
    writeFileSync(join(f.approval.reportDir, 'events.jsonl'), values.map((value, index) => JSON.stringify({ sequence: index + 1, attemptId: input.identity.attemptId, value })).join('\n') + '\n');
    writeFileSync(join(f.approval.reportDir, 'runner-result.json'), JSON.stringify({ schemaVersion: 1, executionMode: 'live', identity: input.identity,
      provider: f.approval.provider, model: f.approval.model, realCalls: 1, terminal: 'completed', stopped: true,
      finalSequence: 4, usage: null, usageCoverage: 'unknown', recording: 'complete', ...changes }));
    return { ...PASS, stderr: 'synthetic-secret-private-error' };
  };
  return { runProcess, calls };
}

it('[case:authorized-delivery-boundary] uses only approved key and tools, checks independently then commits the verified change', async () => {
  const f = fixture(), simulated = simulatedRunner(f);
  f.save({ ...f.approval, ignoredSecret: 'must-not-be-forwarded' });
  const result = await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret', OPENAI_API_KEY: 'unapproved' }, runProcess: simulated.runProcess });
  expect(result).toMatchObject({ status: 'pass', realCalls: 1, exitCode: 0 });
  expect(simulated.calls).toHaveLength(2);
  expect(simulated.calls[0]!.env).toMatchObject({ SHIPLOOP_P04_LIVE_KEY: 'synthetic-secret' });
  expect(simulated.calls[0]!.env.OPENAI_API_KEY).toBeUndefined();
  expect(simulated.calls[1]!.env.SHIPLOOP_P04_LIVE_KEY).toBeUndefined();
  expect(JSON.stringify(simulated.calls.map(call => call.args))).not.toContain('synthetic-secret');
  expect(f.git('rev-parse', 'HEAD^')).toBe(f.approval.expectedCommit);
  expect(f.git('status', '--porcelain')).toBe('');
  for (const file of ['input-manifest.json', 'runner-input.json', 'report.json', 'state.json']) {
    const content = readFileSync(join(f.approval.reportDir, file), 'utf8');
    expect(content).not.toContain('synthetic-secret'); expect(content).not.toContain('must-not-be-forwarded');
  }
  const report = JSON.parse(readFileSync(join(f.approval.reportDir, 'report.json'), 'utf8'));
  expect(report).toMatchObject({ executionMode: 'fake', phaseAccepted: false, coreBusinessAcceptance: 'not_run', usageCoverage: 'unknown' });
  expect(report.scenarios).toMatchObject({ cancellation: 'not_run', sameTaskResume: 'not_run', externalToolProcesses: 'not_run' });
});

it('[case:independent-check-rejects-change] a real independent check failure prevents Git delivery without retrying the model', async () => {
  const f = fixture(), simulated = simulatedRunner(f);
  const runProcess: typeof runBoundedProcess = async (command, args, opts) => {
    const outcome = await simulated.runProcess(command, args, opts);
    if (args[0] !== '-e') writeFileSync(join(f.repo, 'greeting.txt'), 'incorrect\n');
    return outcome;
  };
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ status: 'fail', reason: 'independent_check_or_delivery_failed' });
  expect(simulated.calls).toHaveLength(2);
  expect(f.git('rev-parse', 'HEAD')).toBe(f.approval.expectedCommit);
  const report = JSON.parse(readFileSync(join(f.approval.reportDir, 'report.json'), 'utf8'));
  expect(report.check).toMatchObject({ exitCode: 1, stoppedVerified: true });
});

it.each(['cancelled', 'failed', 'unsupported'])('[case:terminal-%s-partial] incomplete executions retain evidence without delivery or retry', async terminal => {
  const f = fixture(), simulated = simulatedRunner(f, { terminal, usage: null, usageCoverage: 'unknown' });
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess: simulated.runProcess }))
    .toMatchObject({ status: 'partial', realCalls: 1 });
  expect(simulated.calls).toHaveLength(1);
  expect(f.git('rev-parse', 'HEAD')).toBe(f.approval.expectedCommit);
  expect(readFileSync(join(f.approval.reportDir, 'report.json'), 'utf8')).not.toContain('synthetic-secret');
});

it('[case:unknown-stop-and-missing-evidence] timeout or lost Runner keeps call count and usage unknown, preserving the scene', async () => {
  const f = fixture(), runProcess = vi.fn(async () => ({ ...PASS, kind: 'timeout' as const, exitCode: null, timedOut: true, stoppedVerified: false }));
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ status: 'partial', realCalls: null });
  const report = JSON.parse(readFileSync(join(f.approval.reportDir, 'report.json'), 'utf8'));
  expect(report).toMatchObject({ stopped: 'unknown', usage: null, usageCoverage: 'unknown', deliveredCommit: null });
  expect(runProcess).toHaveBeenCalledTimes(1);
  // Re-running with the same report directory must fail before another request.
  expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess }))
    .toMatchObject({ status: 'not_run', realCalls: 0 });
  expect(runProcess).toHaveBeenCalledTimes(1);
});

it('[case:evidence-binding-required] mismatched or Fake evidence cannot deliver a live change', async () => {
  for (const invalid of [{ model: 'unapproved' }, { executionMode: 'fake' }, { finalSequence: 99 }, { stopped: false }]) {
    const f = fixture(), simulated = simulatedRunner(f, invalid);
    expect(await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' }, runProcess: simulated.runProcess }))
      .toMatchObject({ status: 'partial' });
    expect(simulated.calls).toHaveLength(1);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.approval.expectedCommit);
  }
});

it('[case:secret-redaction] redacts escaped, encoded and bearer credentials before evidence persistence', () => {
  const secret = 'synthetic-"secret\\line\nvalue';
  const redacted = redactP04Live({ secret, base64: Buffer.from(secret).toString('base64'), encoded: encodeURIComponent(secret), header: 'Bearer synthetic-token' }, [secret]);
  expect(redacted).not.toContain('synthetic');
  expect(JSON.parse(redacted).secret).toBe('[REDACTED]');
});

it('[case:real-sdk-scripted-tools] installed SDK uses only selected tools, bounded requests and in-memory auth; provider stream is offline', async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const f = fixture(), a = validateP04LiveApproval(f.approval);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(a.reportDir); mkdirSync(join(a.reportDir, 'agent'));
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  const original = sdk.ModelRuntime.create;
  let requests = 0;
  runtime.streamSimple = (model, _context, options) => {
    requests++;
    expect(options).toMatchObject({ maxTokens: 1024, maxRetries: 0, apiKey: 'synthetic-secret' });
    const output = ai.createAssistantMessageEventStream();
    const message: import('@earendil-works/pi-ai').AssistantMessage = { role: 'assistant', api: model.api, model: model.id, provider: model.provider,
      content: requests === 1 ? [{ type: 'toolCall', id: 'read-1', name: 'read_greeting', arguments: {} }]
        : requests === 2 ? [{ type: 'toolCall', id: 'write-1', name: 'write_greeting', arguments: {} }] : [{ type: 'text', text: 'done' }],
      stopReason: requests < 3 ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { output.push({ type: 'start', partial: message }); output.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); output.end(); });
    return output;
  };
  const create = vi.spyOn(sdk.ModelRuntime, 'create').mockResolvedValue(runtime);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
  const previousKey = process.env.SHIPLOOP_P04_LIVE_KEY;
  process.env.SHIPLOOP_P04_LIVE_KEY = 'synthetic-secret';
  try {
    await runP04LiveRunner({ approval: a, identity: { runId: 'run', taskId: 'task', attemptId: 'attempt' }, prompt: 'Make the approved greeting change.' });
    expect(readFileSync(join(f.repo, 'greeting.txt'), 'utf8')).toBe('hello pi\n');
    const result = JSON.parse(readFileSync(join(a.reportDir, 'runner-result.json'), 'utf8'));
    expect(result).toMatchObject({ realCalls: 0, admittedRequests: 3, stopped: true, terminal: 'completed', reservedTokens: 39_072, usageCoverage: 'partial' });
    expect(result.usage).toHaveLength(3);
    const events = readFileSync(join(a.reportDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('tool_completed'); expect(events).not.toContain('synthetic-secret');
    expect(network).not.toHaveBeenCalled();
    expect(original).not.toBe(sdk.ModelRuntime.create);
  } finally { create.mockRestore(); network.mockRestore(); if (previousKey === undefined) delete process.env.SHIPLOOP_P04_LIVE_KEY; else process.env.SHIPLOOP_P04_LIVE_KEY = previousKey; }
});

it.each(['authentication', 'cancel'] as const)('[case:sdk-transport-%s] actual installed transport failure/cancel preserves count and unknown usage without fallback', async mode => {
  const { mkdirSync } = await import('node:fs');
  const f = fixture();
  if (mode === 'cancel') Object.assign(f.approval, { scenario: 'cancel', cancelAfterMs: 29_000 });
  const a = validateP04LiveApproval(f.approval);
  mkdirSync(a.reportDir); mkdirSync(join(a.reportDir, 'agent'));
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_request, init) => {
    if (mode === 'authentication') return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'synthetic-secret' } }),
      { status: 401, headers: { 'content-type': 'application/json' } });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      queueMicrotask(() => process.emit('SIGTERM'));
    });
  });
  const previousKey = process.env.SHIPLOOP_P04_LIVE_KEY; process.env.SHIPLOOP_P04_LIVE_KEY = 'synthetic-secret';
  try {
    await runP04LiveRunner({ approval: a, identity: { runId: 'run', taskId: 'task', attemptId: 'attempt' }, prompt: 'Make the approved greeting change.' });
    expect(network).toHaveBeenCalledTimes(1);
    const result = JSON.parse(readFileSync(join(a.reportDir, 'runner-result.json'), 'utf8'));
    expect(result).toMatchObject({ realCalls: 1, admittedRequests: 1, stopped: true, terminal: mode === 'cancel' ? 'cancelled' : 'failed', usageCoverage: 'unknown' });
    expect(readFileSync(join(a.reportDir, 'events.jsonl'), 'utf8')).not.toContain('synthetic-secret');
    expect(readFileSync(join(f.repo, 'greeting.txt'), 'utf8')).toBe('hello\n');
  } finally { network.mockRestore(); if (previousKey === undefined) delete process.env.SHIPLOOP_P04_LIVE_KEY; else process.env.SHIPLOOP_P04_LIVE_KEY = previousKey; }
}, 15_000);

it('[case:required-resume-real-runner-zero-call] real isolated Runner refuses unsupported same-Task continuation without loading SDK or making requests', async () => {
  const f = fixture(); f.approval.scenario = 'resume-required'; f.save();
  const result = await runP04Live({ approvalFile: f.path, environment: { P04_TEST_KEY: 'synthetic-secret' } });
  expect(result).toMatchObject({ status: 'partial', realCalls: 0, reason: 'same_task_resume_unsupported_zero_call' });
  expect(f.git('rev-parse', 'HEAD')).toBe(f.approval.expectedCommit);
  const evidence = JSON.parse(readFileSync(join(f.approval.reportDir, 'runner-result.json'), 'utf8'));
  expect(evidence).toMatchObject({ terminal: 'unsupported', stopped: true, usageCoverage: 'unknown', realCalls: 0 });
});

it('[case:cli-zero-call] real CLI without approval exits nonzero, emits not_run and loads no local credential', async () => {
  const result = await runBoundedProcess(process.execPath, ['scripts/acceptance/p04-live.ts'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 10_000, maxOutputBytes: 4096 });
  expect(result.exitCode, result.stderr).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'not_run', realCalls: 0 });
});
