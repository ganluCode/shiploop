import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createGitAgentRepairRequest, createGitAgentRuntimeRequest, computeGitAgentRepairBaselineDigest,
  createStaticRuntimeCapabilityCatalog, superviseGitAgentRuntime, RuntimeError, validateGitAgentRuntimeResult,
  runGitAgentRepairAttempt, validateGitAgentRepairRuntimeOutput, toGitAgentRepairRuntimeOutput } from '../../../packages/core/src/index.ts';
import type { RuntimeExecutionRequest, RuntimeExecutionResult, WorkflowLocale } from '../../../packages/core/src/index.ts';
import type { WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';
import { createPiRuntimeDescriptor } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createProductionPiGitAgentDriver } from '../../../packages/host/src/runtime/production-pi-git-agent.ts';
import { productionGitAgentRequest } from '../../../packages/host/src/runtime/pi-git-agent-adapter.ts';
import { createProductionGitAgentTools } from '../../../packages/host/src/runtime/production-pi-tools.ts';

afterEach(() => vi.useRealTimers());

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const intent = 'Preserve both dependency results', evidence = 'src/conflict.ts has merge conflicts';
function request() {
  const authorization = createGitAgentRepairRequest({
    projectId: 'project', phaseId: 'phase', parentBatchId: 'batch', featureId: 'feature', runId: 'run', repairId: 'repair', commandId: 'command',
    source: { projectId: 'project', phaseId: 'phase', parentBatchId: 'batch', featureId: 'feature', runId: 'run',
      integrationId: 'integration', operationId: 'operation', operationType: 'integration', operationDigest: hash('operation'),
      failureKind: 'conflict', evidenceId: 'evidence', evidenceDigest: hash(evidence), inputDigest: hash('input') },
    target: { repoIdentity: 'repo', baselineCommitSha: 'a'.repeat(40), baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: 'repo', baselineCommitSha: 'a'.repeat(40) }) },
    workspace: { workspaceId: 'workspace', workspaceDigest: hash('workspace') },
    conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'], intent: { intentId: 'intent', digest: hash(intent) },
    verification: { strategyId: 'verify', digest: hash('verify') },
    budget: { remainingAttempts: 1, remainingTokens: 10000, remainingRuntimeMs: 10000, deadlineUtcMs: 20000 },
  }, { nowUtcMs: 1000 });
  return createGitAgentRuntimeRequest({ authorization, claim: { projectId: 'project', repairId: 'repair', attemptId: 'attempt',
    ownerId: 'owner', hostInstanceId: 'host', authorizationVersion: 1 }, invocationId: 'invocation', executionVersion: 1 });
}
const descriptor = createPiRuntimeDescriptor({ providers: [{ providerId: 'p', models: ['m'] }], permissionGrants: [], isolationModes: ['trusted_project'] });
const catalog = createStaticRuntimeCapabilityCatalog([descriptor]);
function fixture() {
  const value = request();
  let received!: RuntimeExecutionRequest;
  let context!: Parameters<WorkRuntimeFactory>[0];
  const result: RuntimeExecutionResult = { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
    durationMs: 12, usage: { basis: 'reported', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheReadIncludedInInput: false, cacheWriteIncludedInInput: false, costUsdMicros: null }, lastEventSequence: null };
  const stop = { schemaVersion: 1 as const, confirmed: true, checkedAtUtc: '2026-01-01T00:00:00.000Z', detail: null };
  const cancel = vi.fn(async () => ({ accepted: true, reason: null }));
  const handle = { events: (async function* () {})() as AsyncIterable<unknown>, result: Promise.resolve(result) as Promise<unknown>,
    stopped: Promise.resolve(stop) as Promise<unknown>, cancel };
  const start = vi.fn(async (input: RuntimeExecutionRequest) => { received = input; return handle; });
  const runtimeFactory: WorkRuntimeFactory = input => { context = input; return { entries: [{ descriptor, adapter: { start } }], eventIdentityPrefix: () => 'git-agent' }; };
  const binding = { requestDigest: value.requestDigest, strategy: { runtime: 'pi', provider: 'p', model: 'm', credentialRef: 'credential://pi/p' },
    locale: 'zh-CN' as WorkflowLocale, cwd: { root: 'managed-work', relativePath: 'integration/workspace' }, workspaceRoots: { 'managed-work': '/private/data' },
    intent, evidence, maxRequests: 2 };
  const authority = { resolve: vi.fn(async () => binding), assertCurrent: vi.fn(async () => {}),
    confirmProcess: vi.fn(async () => ({ launchId: 'launch' })), inspectCandidate: vi.fn(async () => ['src/conflict.ts']),
    record: vi.fn(async (_record: unknown) => {}) };
  const options = { runtimeFactory, capabilityCatalog: catalog, authority, nowUtcMs: () => 1000 };
  const driver = createProductionPiGitAgentDriver(options);
  return { driver, options, handle, authority, binding, value, start, result, stop, cancel, received: () => received, context: () => context };
}

it('[case:production-git-agent-frozen-request] maps frozen repair context into the production runtime without fallback', async () => {
  const f = fixture();
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion.result).toMatchObject({ terminal: 'completed', failure: null, stop: { confirmed: true } });
  expect(completion.candidateDelivered).toBe(true);
  expect(completion.result.changedPaths).toEqual(['src/conflict.ts']);
  expect(completion.result.usage).toEqual({ consumedTokens: 12, runtimeMs: 12 });
  const actual = f.received();
  expect(actual).toMatchObject({ invocationId: 'invocation', executionVersion: 1, owner: { principalId: 'owner', hostInstanceId: 'host' },
    identity: { purpose: 'work', runId: 'run', attemptId: 'attempt' }, strategy: f.binding.strategy,
    prompt: { kind: 'git-agent-repair-prompt' }, limits: { timeoutMs: 10000 }, recovery: { mode: 'new' } });
  const reader = f.context().reader(actual)!;
  const manifest = JSON.parse(Buffer.from((await reader.read('manifest')).content).toString());
  expect(manifest).toMatchObject({ gitAgent: f.value, locale: 'zh-CN', productionLimits: { maxRequests: 2, tokenLimit: 10000 } });
  expect(f.authority.record).toHaveBeenCalledOnce();
});

it('[case:production-git-agent-idempotency] admits one launch and fences a changed invocation', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.driver.start(f.value), f.driver.start(f.value)]);
  expect(first).toBe(second);
  await first.result;
  expect(f.start).toHaveBeenCalledOnce();
  const other = createGitAgentRuntimeRequest({ authorization: f.value.authorization,
    claim: { projectId: 'project', repairId: 'repair', attemptId: 'attempt', ownerId: 'other-owner', hostInstanceId: 'host', authorizationVersion: 1 },
    invocationId: 'invocation', executionVersion: 2 });
  await expect(f.driver.start(other)).rejects.toMatchObject({ reason: 'git_agent_invocation_conflict' });
  expect(f.start).toHaveBeenCalledOnce();
});

it('[case:production-git-agent-unavailable] missing driver and authentication fail without model fallback', async () => {
  const f = fixture();
  expect(() => createProductionPiGitAgentDriver({ ...f.options, runtimeFactory: undefined }))
    .toThrow(expect.objectContaining({ kind: 'missing_runtime', reason: 'git_agent_driver_unavailable' }));
  expect(f.authority.resolve).not.toHaveBeenCalled();
  f.start.mockRejectedValue(new RuntimeError('authentication', 'production_pi_auth_missing'));
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion.result.failure?.code).toBe('production_pi_auth_missing');
  expect(completion.candidateDelivered).toBe(false);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.authority.inspectCandidate).not.toHaveBeenCalled();
});

it('[case:production-git-agent-binding] rejects drifted identity, credentials, context, model and expired budget before launch', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.binding.requestDigest = hash('different'); },
    (f: ReturnType<typeof fixture>) => { f.binding.strategy.credentialRef = 'credential://owner'; },
    (f: ReturnType<typeof fixture>) => { f.binding.intent = 'unfrozen'; },
    (f: ReturnType<typeof fixture>) => { f.binding.evidence = 'unfrozen'; },
    (f: ReturnType<typeof fixture>) => { f.binding.strategy.model = 'unapproved'; },
    (f: ReturnType<typeof fixture>) => { f.binding.maxRequests = 0; },
    (f: ReturnType<typeof fixture>) => { f.options.nowUtcMs = () => 20000; },
  ]) {
    const f = fixture();
    mutate(f);
    const driver = createProductionPiGitAgentDriver(f.options);
    await expect(driver.start(f.value)).rejects.toBeDefined();
    expect(f.start).not.toHaveBeenCalled();
  }
});

it('[case:production-git-agent-launch-fence] process confirmation cannot change owner/version or envelope', async () => {
  const f = fixture();
  await (await f.driver.start(f.value)).result;
  const context = f.context(), actual = f.received();
  const identity = { launchId: 'launch' } as Parameters<typeof context.commitCommandIdentity>[0];
  await expect(context.commitCommandIdentity(identity, { ...actual, executionVersion: 2 })).rejects.toMatchObject({ reason: 'git_agent_execution_identity_mismatch' });
  expect(f.authority.confirmProcess).not.toHaveBeenCalled();
  f.authority.assertCurrent.mockRejectedValue(new Error('stale owner'));
  await expect(context.commitCommandIdentity(identity, actual)).rejects.toThrow('stale owner');
  expect(f.authority.confirmProcess).not.toHaveBeenCalled();
});

it('[case:production-git-agent-manifest] child rechecks repair identity and the exact token reservation', async () => {
  const f = fixture();
  await (await f.driver.start(f.value)).result;
  const actual = f.received();
  const manifest = JSON.parse(Buffer.from((await f.context().reader(actual)!.read('manifest')).content).toString());
  expect(productionGitAgentRequest(manifest, actual)).toEqual(f.value);
  expect(() => productionGitAgentRequest(manifest, { ...actual, owner: { ...actual.owner, principalId: 'other' } })).toThrow();
  expect(() => productionGitAgentRequest({ ...manifest, productionLimits: { ...manifest.productionLimits, tokenLimit: 10001 } }, actual)).toThrow();
  expect(() => productionGitAgentRequest({ ...manifest, gitAgent: { ...f.value, execution: { ...f.value.execution, executionVersion: 2 } } }, actual)).toThrow();
});

it('[case:production-git-agent-file-scope] exposes only file tools and rejects extra writes before filesystem access', async () => {
  const tools = createProductionGitAgentTools({ cwd: '/does-not-exist', deadline: Date.now() + 10000, writablePaths: ['src/conflict.ts'] });
  expect(tools.map(tool => tool.name)).toEqual(['list_files', 'read_file', 'write_file', 'edit_file']);
  for (const name of ['write_file', 'edit_file']) {
    const tool = tools.find(tool => tool.name === name)!;
    await expect(tool.execute('call', { path: 'metadata/state.json', content: 'bad', oldText: 'a', newText: 'b' })).rejects.toThrow('git_agent_path_not_authorized');
    await expect(tool.execute('call', { path: '../src/conflict.ts', content: 'bad' })).rejects.toThrow('git_agent_path_not_authorized');
  }
});

it('[case:production-git-agent-stop-hold] unconfirmed stop retains hold and never inspects a candidate', async () => {
  const f = fixture();
  f.handle.stopped = Promise.resolve({ ...f.stop, confirmed: false, detail: 'private secret' });
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion).toMatchObject({ isolated: true, candidateDelivered: false, hold: { code: 'stop_unconfirmed', execution: f.value.execution } });
  expect(f.authority.inspectCandidate).not.toHaveBeenCalled();
  expect(f.authority.record).toHaveBeenCalledWith(expect.objectContaining({ hold: 'stop_unconfirmed' }));
  expect(JSON.stringify(f.authority.record.mock.calls)).not.toContain('private secret');
});

it('[case:production-git-agent-usage] rejects unknown usage and preserves an over-budget failure without a candidate', async () => {
  for (const usage of [null, { ...fixture().result.usage!, inputTokens: 10001 }]) {
    const f = fixture();
    f.handle.result = Promise.resolve({ ...f.result, usage });
    const completion = await superviseGitAgentRuntime(f.driver, f.value);
    expect(completion.candidateDelivered).toBe(false);
    expect(completion.result.failure?.code).toBe(usage ? 'budget_exhausted' : 'git_agent_usage_unknown');
    if (usage) expect(completion.result.usage.consumedTokens).toBe(10003);
    expect(f.authority.inspectCandidate).not.toHaveBeenCalled();
  }
});

it('[case:production-git-agent-events] wrong execution events cancel and cannot leak model text to records', async () => {
  const f = fixture();
  f.handle.events = (async function* () { yield { schemaVersion: 1, eventId: 'other.1', sequence: 1,
    occurredAtUtc: '2026-01-01T00:00:00.000Z', kind: 'message', payload: { messageId: 'msg', role: 'assistant', preview: 'private secret' } }; })();
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion.candidateDelivered).toBe(false);
  expect(f.cancel).toHaveBeenCalled();
  expect(JSON.stringify(f.authority.record.mock.calls)).not.toContain('private secret');
});

it('[case:production-git-agent-record-redaction] valid model text is omitted while event sequence remains auditable', async () => {
  const f = fixture();
  f.handle.events = (async function* () { yield { schemaVersion: 1, eventId: 'git-agent.1', sequence: 1,
    occurredAtUtc: '2026-01-01T00:00:00.000Z', kind: 'message', payload: { messageId: 'msg', role: 'assistant', preview: 'private secret' } }; })();
  f.handle.result = Promise.resolve({ ...f.result, lastEventSequence: 1 });
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion.candidateDelivered).toBe(true);
  expect(f.authority.record).toHaveBeenCalledWith(expect.objectContaining({ events: [{ sequence: 1, kind: 'message' }] }));
  expect(JSON.stringify(f.authority.record.mock.calls)).not.toContain('private secret');
});

it('[case:production-git-agent-watermark] missing final event evidence blocks a candidate', async () => {
  const f = fixture();
  f.handle.result = Promise.resolve({ ...f.result, lastEventSequence: 1 });
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion.candidateDelivered).toBe(false);
  expect(completion.result.failure?.code).toBe('git_agent_event_watermark_mismatch');
  expect(f.authority.inspectCandidate).not.toHaveBeenCalled();
});

it('[case:production-git-agent-cancel] cancellation rejects a late completed result', async () => {
  const f = fixture();
  const handle = await f.driver.start(f.value);
  await handle.cancel();
  const result = await handle.result;
  expect(result.terminal).toBe('cancelled');
  expect(f.authority.inspectCandidate).not.toHaveBeenCalled();
});

it('[case:supervision-start-timeout] a hanging startup is bounded, held and cancelled when it later returns', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release!: (handle: Awaited<ReturnType<typeof f.driver.start>>) => void;
  const start = vi.fn(() => new Promise<Awaited<ReturnType<typeof f.driver.start>>>(resolve => { release = resolve; }));
  const pending = superviseGitAgentRuntime({ start }, f.value, { timeoutMs: 10, stopWaitMs: 5 });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject({ control: 'timed_out', isolated: true, candidateDelivered: false, hold: { code: 'stop_unconfirmed' } });
  const cancel = vi.fn(async () => ({ accepted: true, reason: null }));
  release({ result: new Promise(() => {}), stopped: new Promise(() => {}), cancel });
  await vi.advanceTimersByTimeAsync(1);
  expect(cancel).toHaveBeenCalledOnce();
});

it('[case:supervision-cancel-timeout] a hanging cancel receipt cannot prevent a structured hold', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const cancel = vi.fn(() => new Promise<{ accepted: boolean; reason: string | null }>(() => {}));
  const pending = superviseGitAgentRuntime({ start: async () => ({ result: new Promise(() => {}), stopped: new Promise(() => {}), cancel }) },
    f.value, { timeoutMs: 10, stopWaitMs: 5 });
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toMatchObject({ control: 'timed_out', isolated: true, candidateDelivered: false });
  expect(cancel).toHaveBeenCalledOnce();
});

it('[case:supervision-abort] explicit cancellation does not deliver a late candidate', async () => {
  const f = fixture();
  const signal = new AbortController();
  const cancel = vi.fn(async () => ({ accepted: true, reason: null }));
  const pending = superviseGitAgentRuntime({ start: async () => ({ result: new Promise(() => {}),
    stopped: Promise.resolve({ confirmed: false, detail: null }), cancel }) }, f.value, { signal: signal.signal, stopWaitMs: 1 });
  signal.abort();
  expect(await pending).toMatchObject({ control: 'cancelled', candidateDelivered: false });
});

it('[case:supervision-invalid-identity] forged result identity is held even if stopped claims success', async () => {
  const f = fixture();
  const valid = await (await f.driver.start(f.value)).result;
  const forged = { ...valid, execution: { ...valid.execution, ownerId: 'wrong-owner' } };
  expect(() => validateGitAgentRuntimeResult(forged, f.value)).toThrow();
  const completion = await superviseGitAgentRuntime({ start: async () => ({ result: Promise.resolve(forged),
    stopped: Promise.resolve({ confirmed: true, detail: null }), cancel: async () => ({ accepted: true, reason: null }) }) }, f.value);
  expect(completion).toMatchObject({ isolated: true, candidateDelivered: false, result: { terminal: 'invalid' } });
});

it('[case:supervision-invalid-handle] malformed driver handles produce an isolated hold', async () => {
  const f = fixture();
  const completion = await superviseGitAgentRuntime({ start: async () => null as never }, f.value);
  expect(completion).toMatchObject({ isolated: true, candidateDelivered: false, result: { failure: { code: 'invalid_runtime_handle' } } });
});

it('[case:production-git-agent-budget-settlement] only a failed budget result may retain usage above reservation', async () => {
  const f = fixture();
  f.handle.result = Promise.resolve({ ...f.result, usage: { ...f.result.usage!, inputTokens: 10001 } });
  const output = await (await f.driver.start(f.value)).result;
  const settlement = toGitAgentRepairRuntimeOutput(output);
  expect(validateGitAgentRepairRuntimeOutput(settlement, f.value.authorization).usage.consumedTokens).toBe(10003);
  expect(() => validateGitAgentRuntimeResult({ ...output, terminal: 'completed' }, f.value)).toThrow();
  expect(() => validateGitAgentRepairRuntimeOutput({ ...settlement, status: 'modified', changedPaths: ['src/conflict.ts'] }, f.value.authorization)).toThrow();
});

it('[case:production-git-agent-process-exit] process exit never becomes a successful candidate', async () => {
  const f = fixture();
  f.handle.result = Promise.resolve({ ...f.result, terminal: 'failed', reason: 'runner_crashed', exitCode: 1 });
  const completion = await superviseGitAgentRuntime(f.driver, f.value);
  expect(completion.result).toMatchObject({ terminal: 'process_exited', failure: { classification: 'process_exited', code: 'git_agent_process_exited' } });
  expect(completion.candidateDelivered).toBe(false);
  expect(f.authority.inspectCandidate).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledOnce();
});

it('[case:production-git-agent-no-evidence] failed record publication or out-of-scope inspection cannot produce a candidate', async () => {
  for (const mode of ['record', 'scope']) {
    const f = fixture();
    if (mode === 'record') f.authority.record.mockRejectedValue(new Error('private secret'));
    else f.authority.inspectCandidate.mockResolvedValue(['metadata/state.json']);
    const completion = await superviseGitAgentRuntime(f.driver, f.value);
    expect(completion).toMatchObject({ candidateDelivered: false, isolated: true, result: { terminal: 'invalid' } });
    expect(JSON.stringify(completion)).not.toContain('private secret');
  }
});

it('[case:production-git-agent-locale] renders the approved English prompt without rereading project context', async () => {
  const f = fixture();
  f.binding.locale = 'en-US';
  await (await f.driver.start(f.value)).result;
  const prompt = Buffer.from((await f.context().reader(f.received())!.read('prompt')).content).toString();
  expect(prompt).toContain('Controlled Git conflict repair');
  expect(prompt).toContain(intent);
  expect(prompt).toContain(evidence);
  expect(prompt).toContain(f.value.requestDigest);
});

it('[case:supervision-cancel-settlement] a completed result after cancellation settles as cancelled', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const valid = await (await f.driver.start(f.value)).result;
  const signal = new AbortController();
  let resolveResult!: (result: typeof valid) => void;
  const result = new Promise<typeof valid>(resolve => { resolveResult = resolve; });
  const repair = { settle: vi.fn() };
  const pending = runGitAgentRepairAttempt({ start: async () => ({ result, stopped: Promise.resolve({ confirmed: true, detail: null }),
    cancel: async () => { resolveResult(valid); return { accepted: true, reason: null }; } }) }, f.value,
    {} as NonNullable<Parameters<typeof runGitAgentRepairAttempt>[2]>, {
      signal: signal.signal, stopWaitMs: 10, repair,
      claim: { projectId: 'project', repairId: 'repair', attemptId: 'attempt', ownerId: 'owner', hostInstanceId: 'host', authorizationVersion: 1 },
    });
  await vi.advanceTimersByTimeAsync(0);
  signal.abort();
  await vi.advanceTimersByTimeAsync(0);
  const outcome = await pending;
  expect(outcome.output).toMatchObject({ status: 'cancelled', failureCode: 'cancelled' });
  expect(outcome.completion?.candidateDelivered).toBe(false);
  expect(repair.settle).toHaveBeenCalledOnce();
});
