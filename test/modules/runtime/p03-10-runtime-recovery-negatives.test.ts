import { expect, test } from 'vitest';
import { decideRuntimeRecovery, type RuntimeRecoveryCapabilities, type RuntimeRecoveryKind,
  type RuntimeRecoveryRequest, type RuntimeRecoveryReference } from '../../../packages/core/src/ports/runtime-recovery.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createStaticRuntimeRecoveryCatalog } from '../../../packages/core/src/ports/runtime-recovery-catalog.ts';
import { evaluateBatchBudgetReservation, evaluateRunBudgetReservation } from '../../../packages/core/src/ports/execution-budget.ts';
import { BINDING_BUDGET, BINDING_NOW, FAKE_STRATEGY } from '../../helpers/p03-6/input-binding-fixture.ts';
import { fixture as openStoppingFixture } from '../../helpers/p03-6/stopping-fixture.ts';
import { openRuntimeNegativeFixture } from '../../helpers/p03-10/runtime-negative-fixture.ts';

function source(kind: RuntimeRecoveryKind): RuntimeRecoveryReference {
  return { schemaVersion: 1, purpose: 'work', sourceProjectId: 'project-1', sourceSessionId: 'session-0',
    sourceTaskId: 'task-1', sourceAttemptId: 'attempt-0', runtime: 'fake', provider: 'test-provider', model: 'fake-model',
    providerSessionId: 'native-session-0', nativeArchiveRef: 'archive-0', nativeFormat: 'fake-json', nativeFormatVersion: '1',
    sourceDigest: 'a'.repeat(64), ...(kind === 'checkpoint' ? { kind, checkpointRef: 'checkpoint-0' } : { kind }) };
}
function request(kind: RuntimeRecoveryKind): RuntimeRecoveryRequest {
  return { schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1', invocationId: 'invocation-1', executionVersion: 1,
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' }, strategy: FAKE_STRATEGY,
    recovery: { mode: 'required', kind, source: source(kind) } };
}
function capabilities(): RuntimeRecoveryCapabilities {
  const verified = { status: 'verified' as const, evidenceRef: 'environment-proof-1', limits: ['fake_only'] };
  return { schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0', sdkVersion: null,
    nativeFormats: [{ format: 'fake-json', versions: ['1'] }], limits: ['fake_only'],
    capabilities: { nativeHistory: verified, conversationResume: verified, executionRecovery: verified,
      nativeFork: verified, modelSwitchOnResume: verified } };
}

test('[case:recovery-false-claim] verified 声明缺少证据或目录 Runtime 不符在装配期拒绝', () => {
  const configuration = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake',
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]);
  const caps = capabilities();
  expect(() => createStaticRuntimeRecoveryCatalog([{ ...caps, capabilities: { ...caps.capabilities,
    executionRecovery: { status: 'verified', limits: [] } } }], configuration)).toThrow();
  expect(() => createStaticRuntimeRecoveryCatalog([{ ...caps, runtimeId: 'unregistered' }], configuration)).toThrow();
  expect(decideRuntimeRecovery(request('checkpoint'), undefined))
    .toEqual({ mode: 'rejected', reasons: ['capabilities:unverified'] });
});

test('[case:recovery-format] required 拒绝不兼容原生格式，auto 明确降级新执行', () => {
  const input = request('checkpoint');
  const caps = { ...capabilities(), nativeFormats: [{ format: 'fake-json', versions: ['2'] }] };
  expect(decideRuntimeRecovery(input, caps)).toEqual({ mode: 'rejected', reasons: ['nativeFormat:unsupported'] });
  expect(decideRuntimeRecovery({ ...input, recovery: { ...input.recovery, mode: 'auto' } }, caps))
    .toEqual({ mode: 'new', reasons: ['nativeFormat:unsupported'] });
  expect(decideRuntimeRecovery(input, { ...capabilities(), runtimeId: 'other' }))
    .toEqual({ mode: 'rejected', reasons: ['runtime:mismatch'] });
});

test('[case:conversation-not-checkpoint] 仅对话续接不能声明恢复中断的检查点', () => {
  const caps = capabilities();
  const conversationOnly = { ...caps, capabilities: { ...caps.capabilities,
    executionRecovery: { status: 'unsupported', limits: [] } } };
  expect(decideRuntimeRecovery(request('conversation'), conversationOnly)).toEqual({ mode: 'resume', kind: 'conversation', reasons: [] });
  expect(decideRuntimeRecovery(request('checkpoint'), conversationOnly))
    .toEqual({ mode: 'rejected', reasons: ['executionRecovery:unsupported'] });
});

test('[case:required-before-start] 无恢复证据的 required 经真实输入绑定拒绝，Fake 不启动', async () => {
  const f = await openRuntimeNegativeFixture();
  try {
    await expect(f.service.start(f.bindingInput(f.claim, {
      recovery: { mode: 'required', kind: 'checkpoint', source: { ...source('checkpoint'),
        sourceProjectId: f.projectId, sourceTaskId: f.claim.taskId } },
    }))).rejects.toMatchObject({ kind: 'recovery', reason: 'recovery_source_invalid' });
    expect(f.starts()).toBe(0);
    expect(f.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 0 });
    expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
  } finally { f.close(); }
});

test('[case:supervised-timeout] Runtime 挂起受有限时间监督取消，保留现场且不进入自动重试', async () => {
  const f = await openStoppingFixture({ script: { schemaVersion: 1, steps: [
    { op: 'write_file', path: 'timeout-progress.txt', content: 'progress before timeout' },
    { op: 'await_gate', name: 'hang' },
  ] } });
  try {
    const { context } = await f.start({ limits: { timeoutMs: 1000, maxEvents: 1000, maxOutputBytes: 1_048_576 } });
    const completion = await context.completion;
    expect(completion).toMatchObject({ stopConfirmed: true, persisted: true, retained: true, error: null });
    expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'failed', error_kind: 'timeout' });
    expect(f.retain).toHaveBeenCalledTimes(1);
    expect(f.rawHandles.length).toBe(1);
    expect(f.query("SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = 't-1'"))
      .toEqual({ attempt_counter: 1, code_attempts_used: 0 });
    expect(f.query('SELECT attempts_created, runtime_starts FROM execution_batches'))
      .toEqual({ attempts_created: 1, runtime_starts: 1 });
    const settlementRef = f.retain.mock.calls[0]![0].evidenceRef;
    expect((await f.readArtifact(settlementRef)).control).toMatchObject({ reason: 'runtime_timeout' });
    expect(f.query('SELECT diagnostic_ref FROM attempts')).toMatchObject({ diagnostic_ref: expect.any(String) });
  } finally { await f.dispose(); }
});

test('[case:infrastructure-parent-budgets] 退回代码预算不清零总 Attempt/Starts，有限重试准入与绝对时间上限仍拒绝', async () => {
  const f = await openRuntimeNegativeFixture({ startFailure: { kind: 'provider', reason: 'temporary_server_failure' } });
  try {
    await expect(f.start()).rejects.toMatchObject({ kind: 'provider' });
    const row = f.query('SELECT attempts_created, runtime_starts FROM execution_batches') as { attempts_created: number; runtime_starts: number };
    const usage = { attemptsCreated: row.attempts_created, runtimeStarts: row.runtime_starts, runsCreated: 1, noProgressRuns: 0 };
    // At one retained debit, either finite parent cap must prohibit a second start.
    for (const cap of ['maxTotalAttempts', 'maxRuntimeStarts'] as const) {
      const decision = evaluateBatchBudgetReservation({ ...BINDING_BUDGET.batch, [cap]: 1 }, usage, BINDING_NOW);
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map(reason => reason.dimension)).toContain(cap);
    }
    const deadline = evaluateBatchBudgetReservation(BINDING_BUDGET.batch, usage, BINDING_BUDGET.batch.deadlineUtcMs);
    expect(deadline.allowed).toBe(false);
    expect(deadline.reasons.map(reason => reason.dimension)).toContain('deadlineUtcMs');
    const run = evaluateRunBudgetReservation(BINDING_BUDGET.run,
      { attemptsCreated: 1, startedAtUtcMs: BINDING_NOW }, BINDING_NOW + BINDING_BUDGET.run.runTimeLimitMs);
    expect(run.allowed).toBe(false);
    expect(run.reasons.map(reason => reason.dimension)).toContain('runTimeLimitMs');
    // Conservative retry policy: pause, then require explicit authorized continue.
    expect(f.query('SELECT status FROM runs')).toEqual({ status: 'paused' });
    await expect(f.start()).rejects.toBeDefined();
    expect(f.starts()).toBe(1);
    expect(f.query('SELECT attempts_created, runtime_starts FROM execution_batches')).toEqual(row);
    expect(f.query("SELECT code_attempts_used FROM tasks WHERE id = 't-1'")).toEqual({ code_attempts_used: 0 });
  } finally { f.close(); }
});
