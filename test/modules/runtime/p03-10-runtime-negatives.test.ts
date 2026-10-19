import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { RuntimeError, type RuntimeAdapter } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { ExecutionContext } from '../../../packages/core/src/application/execution-service.ts';
import { aggregateMachineVerification } from '../../../packages/core/src/application/verification-aggregate.ts';
import type { MachineVerificationInput, VerificationRuntimeFacts } from '../../../packages/core/src/ports/verification-aggregate.ts';
import { createFakeRuntimeGate } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { validateWorkEvidenceManifest } from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import { openRuntimeNegativeFixture } from '../../helpers/p03-10/runtime-negative-fixture.ts';

function greenChecks(runtime: VerificationRuntimeFacts): MachineVerificationInput {
  const identity = { headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64) };
  return { runtime, workspaceHeld: true, beforeIdentity: identity, afterIdentity: identity,
    plan: { status: 'ready', selectedChecks: [{ checkKey: 'diagnostic', required: true }] },
    results: [{ id: 'green-check', projectId: 'p', batchId: 'v', revision: 1,
      createdAtUtcMs: 1, updatedAtUtcMs: 1, checkKey: 'diagnostic', argv: ['node', 'diagnostic.js'],
      cwdRef: null, environmentRef: null, timeoutMs: 1000, status: 'passed', required: true,
      exitCode: 0, signal: null, timedOut: false, outputArtifactId: 'green-output', outputDigest: 'c'.repeat(64),
      outputTail: 'synthetic diagnostic passed', startedAtUtcMs: 1, endedAtUtcMs: 2 }],
    evidence: { diagnostic: { status: 'complete', reference: 'green-output' } }, testCounts: { diagnostic: 1 } };
}

function rejectResult(kind: ConstructorParameters<typeof RuntimeError>[0], reason: string): (adapter: RuntimeAdapter) => RuntimeAdapter {
  return adapter => ({ async start(request) {
    const handle = await adapter.start(request);
    return { ...handle, result: handle.result.then(() => { throw new RuntimeError(kind, reason); }) };
  } });
}

async function facts(context: ExecutionContext) {
  const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
  return { request: context.request, result, recording, stopped };
}

const structuredFailures = [
  ['quota', 'rate_limited', 'provider_quota_exhausted'],
  ['server', 'provider', 'server_temporarily_unavailable'],
  ['protocol', 'protocol', 'invalid_provider_frame'],
] as const;

for (const [id, kind, reason] of structuredFailures) {
  test(`[case:${id}-budget] ${kind} 独立保存原因、诊断全绿仍失败且启动不自重试`, async () => {
    const f = await openRuntimeNegativeFixture({}, rejectResult(kind, reason));
    try {
      const { context } = await f.start();
      const observation = await facts(context);
      expect(observation.result).toMatchObject({ status: 'rejected', reason: { kind, reason } });
      const receipt = await f.settlement.settle(observation);
      expect(receipt).toMatchObject({ status: 'failed', runtimeCompleted: false, stopConfirmed: true });
      const artifact = await f.json((f.query('SELECT diagnostic_ref FROM attempts') as { diagnostic_ref: string }).diagnostic_ref);
      expect(artifact.execution.failure).toEqual({ kind, reason });
      expect(artifact.stop.evidence.confirmed).toBe(true);
      expect(artifact.recording.manifestRef).toBeTruthy();
      expect(aggregateMachineVerification(greenChecks({ result: null, failure: artifact.execution.failure,
        stopped: artifact.stop.evidence }))).toMatchObject({ machinePassed: false, category: 'runtime_error' });
      expect(f.query("SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = 't-1'"))
        .toEqual({ attempt_counter: 1, code_attempts_used: 0 });
      expect(f.query('SELECT attempts_created, runtime_starts FROM execution_batches'))
        .toEqual({ attempts_created: 1, runtime_starts: 1 });
      expect(f.query('SELECT status FROM runs')).toEqual({ status: 'paused' });
      expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
      expect(readFileSync(join(f.workspace.canonicalPath, 'retained.txt'), 'utf8')).toBe('retained progress\n');
      expect((await f.settlement.settle(observation)).disposition).toBe('replayed');
      await expect(f.start()).rejects.toBeDefined();
      expect(f.starts()).toBe(1);
      expect(f.query("SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = 't-1'"))
        .toEqual({ attempt_counter: 1, code_attempts_used: 0 });
    } finally { f.close(); }
  });
}

test('[case:unknown-terminal] 未知终止为协议错误，不猜退出原因、时间或真实用量', async () => {
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1, steps: [],
    lifecycle: { result: { terminalOverride: 'future_terminal' } } } });
  try {
    const { context } = await f.start();
    const observation = await facts(context);
    expect(observation.result).toMatchObject({ status: 'rejected', reason: { kind: 'protocol', reason: 'unknown_terminal' } });
    expect((await f.settlement.settle(observation)).status).toBe('failed');
    expect(f.query('SELECT exit_code, duration_ms, usage_summary, error_kind FROM attempts'))
      .toEqual({ exit_code: null, duration_ms: null, usage_summary: null, error_kind: 'protocol' });
  } finally { f.close(); }
});

test('[case:rate-limit-notice] 信息型限流事件正常记录，用量为 synthetic 且不能冒充已通过', async () => {
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1, steps: [
    { op: 'message', role: 'assistant', text: 'rate limit notice' },
    { op: 'usage', inputTokens: 5, outputTokens: 7, costUsdMicros: 0 },
  ] } }, adapter => ({ async start(request) {
    const handle = await adapter.start(request);
    return { ...handle, events: (async function* () {
      for await (const raw of handle.events) {
        const event = raw as { kind: string; payload: unknown };
        yield event.kind === 'message' ? { ...event, kind: 'warning',
          payload: { code: 'rate_limit_notice', message: 'informational_rate_limit' } } : event;
      }
    })() };
  } }));
  try {
    const { context } = await f.start();
    const observation = await facts(context);
    expect(observation.result).toMatchObject({ status: 'fulfilled', value: { terminal: 'completed', durationMs: null } });
    expect(observation.recording.status).toBe('fulfilled');
    const receipt = await f.settlement.settle(observation);
    expect(receipt).toMatchObject({ status: 'verifying', waitingFor: 'verification_not_assembled' });
    expect(f.query('SELECT error_kind, duration_ms, usage_summary FROM attempts'))
      .toEqual({ error_kind: null, duration_ms: null, usage_summary: null });
    expect(f.query("SELECT code_attempts_used FROM tasks WHERE id = 't-1'")).toEqual({ code_attempts_used: 1 });
    if (observation.recording.status !== 'fulfilled') throw new Error('recording_not_fulfilled');
    const manifest = validateWorkEvidenceManifest(await f.json(observation.recording.value.manifestArtifactId));
    expect(manifest.usage).toMatchObject({ basis: 'synthetic', historicalBaseline: null, notAdditive: true });
    const chunks = await Promise.all(manifest.chunks.map(async chunk => {
      const read = await f.verifier.readVerifiedContent(f.projectId, chunk.artifactId);
      return Buffer.from(read.content).toString('utf8');
    }));
    expect(chunks.join('')).toContain('rate_limit_notice');
    expect(f.starts()).toBe(1);
  } finally { f.close(); }
});

for (const missing of ['events', 'stopped', 'result'] as const) {
  test(`[case:independent-${missing}] ${missing} 闩锁独立，缺失时保留证据和现场且不放行后继`, async () => {
    const gate = createFakeRuntimeGate();
    const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1,
      steps: [{ op: 'write_file', path: 'retained.txt', content: 'retained progress\n' }] } },
    adapter => ({ async start(request) {
      const handle = await adapter.start(request);
      // Delay one public observation only, after the real Fake run has finished.
      if (missing === 'result') return { ...handle, result: handle.result.then(async result => {
        await gate.wait(); return result;
      }) };
      if (missing === 'stopped') return { ...handle, stopped: handle.stopped.then(async stopped => {
        await gate.wait(); return stopped;
      }) };
      return { ...handle, events: (async function* () {
        for await (const event of handle.events) yield event;
        await gate.wait();
      })() };
    } }));
    let context: Awaited<ReturnType<typeof f.start>>['context'] | undefined;
    try {
      context = (await f.start()).context;
      let heldSettled = false;
      const held = missing === 'events' ? context.recording : context[missing];
      void held.then(() => { heldSettled = true; });
      if (missing !== 'result') expect(await context.result).toMatchObject({ status: 'fulfilled', value: { terminal: 'completed' } });
      if (missing !== 'stopped') expect(await context.stopped).toMatchObject({ status: 'fulfilled', value: { confirmed: true } });
      // Recorder enforces its own finite tail wait when result/stream evidence is missing.
      if (missing === 'stopped') await context.recording;
      expect(heldSettled).toBe(false);
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'preparing' });
      expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
      if (missing === 'stopped') {
        const receipt = await f.settlement.settle({ request: context.request, result: await context.result,
          recording: await context.recording, stopped: null });
        expect(receipt).toMatchObject({ status: 'verifying', stopConfirmed: false, waitingFor: 'execution_uncertain' });
      } else {
        const recording = await context.recording;
        expect(recording).toMatchObject({ status: 'fulfilled', value: { status: 'partial' } });
        const result = missing === 'result' ? { status: 'rejected' as const,
          reason: new RuntimeError('timeout', 'runtime_result_unobserved') } : await context.result;
        const receipt = await f.settlement.settle({ request: context.request, result, recording, stopped: await context.stopped });
        expect(receipt).toMatchObject(missing === 'result' ? { status: 'failed' }
          : { status: 'verifying', waitingFor: 'recording_required' });
      }
      const evidenceRef = (f.query('SELECT diagnostic_ref FROM attempts') as { diagnostic_ref: string }).diagnostic_ref;
      const artifact = await f.json(evidenceRef);
      expect(artifact.recording.manifestRef).toBeTruthy();
      if (missing === 'result') expect(artifact.execution).toMatchObject({ result: null,
        failure: { kind: 'timeout', reason: 'runtime_result_unobserved' } });
      if (missing === 'stopped') expect(artifact.stop.evidence).toBeNull();
      expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
      expect(readFileSync(join(f.workspace.canonicalPath, 'retained.txt'), 'utf8')).toBe('retained progress\n');
    } finally {
      gate.release();
      if (context) await Promise.all([context.result, context.recording, context.stopped]);
      f.close();
    }
  });
}

test('[case:required-evidence] Runtime 正常与诊断全绿仍不能覆盖 required 检查证据缺失', async () => {
  const f = await openRuntimeNegativeFixture();
  try {
    const observation = await facts((await f.start()).context);
    if (observation.result.status !== 'fulfilled' || observation.stopped.status !== 'fulfilled') throw new Error('fake_not_complete');
    const green = greenChecks({ result: observation.result.value, stopped: observation.stopped.value });
    expect(aggregateMachineVerification(green).machinePassed).toBe(true);
    expect(aggregateMachineVerification({ ...green, evidence: {} }))
      .toMatchObject({ machinePassed: false, category: 'evidence_incomplete' });
    expect(aggregateMachineVerification({ ...green, runtime: { ...green.runtime, stopped: null } }))
      .toMatchObject({ machinePassed: false, category: 'runtime_not_stopped' });
    expect((await f.settlement.settle(observation)).status).toBe('verifying');
    expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
  } finally { f.close(); }
});

test('[case:authentication-budget] 认证阻塞保留结构化原因及启动计数，不消耗代码修复预算', async () => {
  const f = await openRuntimeNegativeFixture({ startFailure: { kind: 'authentication', reason: 'credentials_unavailable' } });
  try {
    await expect(f.start()).rejects.toMatchObject({ kind: 'authentication', reason: 'credentials_unavailable' });
    expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'failed', error_kind: 'authentication' });
    expect(f.query("SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = 't-1'"))
      .toEqual({ attempt_counter: 1, code_attempts_used: 0 });
    expect(f.query('SELECT attempts_created, runtime_starts FROM execution_batches'))
      .toEqual({ attempts_created: 1, runtime_starts: 1 });
    expect(f.starts()).toBe(1);
  } finally { f.close(); }
});
