import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessPort, CommandProcessResult } from '../../../packages/core/src/ports/command-process.ts';
import type { FakeRuntimeHandle } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { RuntimeError } from '../../../packages/core/src/ports/runtime-execution.ts';
import { validateFakeRuntimeScript, FAKE_RUNTIME_STEP_BODY_MAX_BYTES } from '../../../packages/core/src/ports/fake-runtime-script.ts';
import { validateWorkEvidenceManifest } from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import { openEvidenceFixture } from '../../helpers/p03-6/evidence-fixture.ts';
import { openRuntimeNegativeFixture } from '../../helpers/p03-10/runtime-negative-fixture.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('[case:large-stream-backpressure] 上限内多字节消息流分块可读，数量/字节背压保持有界', async () => {
  const text = '界'.repeat(200);
  const f = await openEvidenceFixture({ script: { schemaVersion: 1,
    steps: Array.from({ length: 128 }, () => ({ op: 'message', role: 'assistant', text })) },
    fakeBuffer: { maxEvents: 1, maxBytes: 2048 }, limits: { chunkMaxEvents: 3, chunkMaxBytes: 4096 } });
  try {
    // Let production reach its first bounded push before attaching the consumer.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.handle.inspection.highWater().events).toBeLessThanOrEqual(1);
    expect(f.handle.inspection.opLog().length).toBeLessThan(128);
    const outcome = await f.recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix });
    expect(outcome.status).toBe('complete');
    const manifestRead = await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId);
    const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(manifestRead.content).toString('utf8')));
    expect(manifest.chunks.length).toBeGreaterThan(40);
    let bytes = 0;
    const messages: string[] = [];
    for (const chunk of manifest.chunks) {
      const read = await f.verifier.readVerifiedContent(f.projectId, chunk.artifactId);
      expect(read.content.byteLength).toBe(chunk.sizeBytes);
      expect(sha256(read.content)).toBe(chunk.contentHash);
      expect(chunk.sizeBytes).toBeLessThanOrEqual(4096);
      bytes += read.content.byteLength;
      for (const line of Buffer.from(read.content).toString('utf8').trim().split('\n')) {
        const event = JSON.parse(line);
        if (event.kind === 'message') messages.push(event.payload.preview);
      }
    }
    expect(messages).toEqual(Array.from({ length: 128 }, () => text));
    expect(bytes).toBe(manifest.stats.bytesPersisted);
    expect(bytes).toBeGreaterThan(128 * Buffer.byteLength(text));
    expect(manifest.stats.eventsOmitted).toBe(0);
    expect(f.handle.inspection.highWater().bytes).toBeLessThanOrEqual(2048);
  } finally { f.close(); }
});

test('[case:body-cap-artifact] 大正文按实际 UTF-8 字节上限核对，完整文件制品可访问，超一字节明确拒绝', async () => {
  const content = '界'.repeat(Math.floor(FAKE_RUNTIME_STEP_BODY_MAX_BYTES / 3))
    + 'x'.repeat(FAKE_RUNTIME_STEP_BODY_MAX_BYTES % 3);
  expect(Buffer.byteLength(content)).toBe(FAKE_RUNTIME_STEP_BODY_MAX_BYTES);
  const script = { schemaVersion: 1, steps: [{ op: 'write_file', path: 'large.txt', content }] };
  expect(() => validateFakeRuntimeScript(script)).not.toThrow();
  let rejected = false;
  try { validateFakeRuntimeScript({ ...script, steps: [{ ...script.steps[0], content: `${content}x` }] }); }
  catch { rejected = true; }
  expect(rejected).toBe(true);
  const f = await openRuntimeNegativeFixture({ script });
  try {
    const { context } = await f.start();
    const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
    expect(result).toMatchObject({ status: 'fulfilled', value: { terminal: 'completed' } });
    const bytes = readFileSync(join(f.workspace.canonicalPath, 'large.txt'));
    expect(bytes.byteLength).toBe(FAKE_RUNTIME_STEP_BODY_MAX_BYTES);
    const output = await f.publisher.publishArtifact({ projectId: f.projectId, kind: 'runtime-output',
      mediaType: 'text/plain', expectedHash: sha256(bytes), locator: 'outputs/large.txt', content: [bytes] });
    const read = await f.verifier.readVerifiedContent(f.projectId, output.artifact.id);
    expect(Buffer.compare(Buffer.from(read.content), bytes)).toBe(0);
    expect((await f.settlement.settle({ request: context.request, result, recording, stopped })).status).toBe('verifying');
  } finally { f.close(); }
});

test('[case:oversize-gap] 单事件正文超限标记缺口，保存可读清单且不提前通过', async () => {
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1,
    steps: [{ op: 'message', role: 'assistant', text: '界'.repeat(200) }] } }, undefined,
  { limits: { maxEventBodyBytes: 256 } });
  try {
    const { context } = await f.start();
    const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
    expect(recording).toMatchObject({ status: 'fulfilled', value: { status: 'partial' } });
    if (recording.status !== 'fulfilled') throw new Error('recording_not_fulfilled');
    expect(recording.value.gaps.some(gap => gap.startsWith('event_body_too_large:'))).toBe(true);
    const manifest = validateWorkEvidenceManifest(await f.json(recording.value.manifestArtifactId));
    expect(manifest.stats.eventsOmitted).toBeGreaterThan(0);
    expect((await f.settlement.settle({ request: context.request, result, recording, stopped })))
      .toMatchObject({ status: 'verifying', waitingFor: 'recording_required' });
    expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
  } finally { f.close(); }
});

test('[case:tool-overflow-artifact] 真实工具输出溢出保留计数/摘要/丢弃量，已保留前缀可制品化读取', async () => {
  const processes = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2000 });
  const retained: Uint8Array[] = [];
  let observed: Promise<CommandProcessResult> | undefined;
  let raw: FakeRuntimeHandle | undefined;
  const tap: CommandProcessPort = { async start(request, confirm, signal) {
    const handle = await processes.start(request, confirm, signal);
    observed = handle.result;
    return { ...handle, output: (async function* () {
      for await (const chunk of handle.output) { retained.push(chunk.bytes.slice()); yield chunk; }
    })() };
  } };
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1, steps: [{ op: 'tool_command', name: 'large' }] },
    commandProcess: tap, toolCommands: { large: { argv: [process.execPath, '--no-warnings', '-e',
      "process.stdout.write('x'.repeat(1024));setTimeout(()=>process.stdout.write('y'.repeat(65536)),50)"],
      environment: {}, timeoutMs: 2000, maxOutputBytes: 4096 } },
    commitCommandIdentity: async identity => ({ launchId: identity.launchId }),
  }, adapter => ({ async start(request) { raw = await adapter.start(request) as FakeRuntimeHandle; return raw; } }));
  try {
    const { context } = await f.start();
    const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
    const command = await observed;
    expect(command).toMatchObject({ reason: 'output_overflow', stop: { confirmed: true } });
    expect(command!.outputBytes).toBeGreaterThan(0);
    expect(command!.outputBytes).toBeLessThanOrEqual(4096);
    expect(command!.droppedOutputBytes).toBeGreaterThan(0);
    const bytes = Buffer.concat(retained);
    expect(bytes.byteLength).toBe(command!.outputBytes);
    expect(raw!.inspection.opLog().find(op => op.op === 'tool_command')).toMatchObject({ outcome: 'failed',
      reason: 'output_overflow', bytes: bytes.byteLength, digest: sha256(bytes),
      droppedOutputBytes: command!.droppedOutputBytes, stopConfirmed: true });
    const output = await f.publisher.publishArtifact({ projectId: f.projectId, kind: 'runtime-output', mediaType: 'text/plain',
      expectedHash: sha256(bytes), locator: 'outputs/retained-tool-prefix.txt', content: [bytes] });
    expect(Buffer.from((await f.verifier.readVerifiedContent(f.projectId, output.artifact.id)).content).equals(bytes)).toBe(true);
    expect((await f.settlement.settle({ request: context.request, result, recording, stopped })).status).toBe('verifying');
    expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
  } finally { f.close(); }
});

test('[case:runtime-output-cap] Runtime 输出字节上限有限且超限失败，证据清单仍可访问', async () => {
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1, steps:
    Array.from({ length: 16 }, () => ({ op: 'message', role: 'assistant', text: '界'.repeat(200) })) } });
  try {
    const { context } = await f.service.start(f.bindingInput(f.claim, {
      limits: { timeoutMs: 60_000, maxEvents: 1000, maxOutputBytes: 2048 },
    }));
    const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
    expect(result).toMatchObject({ status: 'fulfilled', value: { terminal: 'failed', reason: 'output_limit_exceeded' } });
    expect(recording.status).toBe('fulfilled');
    if (recording.status !== 'fulfilled') throw new Error('recording_not_fulfilled');
    const manifest = validateWorkEvidenceManifest(await f.json(recording.value.manifestArtifactId));
    expect(manifest.stats.eventsPersisted).toBeLessThan(16);
    expect((await f.settlement.settle({ request: context.request, result, recording, stopped })).status).toBe('failed');
    expect(f.query("SELECT code_attempts_used FROM tasks WHERE id = 't-1'")).toEqual({ code_attempts_used: 0 });
  } finally { f.close(); }
});

test('[case:redacted-final-result] 结果原因也在 Recorder 持久化前脱敏，未知退出码及耗时保持 null', async () => {
  const secret = randomUUID().replaceAll('-', '');
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1, steps: [], result: {
    terminal: 'failed', reason: secret, exitCode: null, signal: null, durationMs: null, usage: null,
  } } }, undefined, { secrets: [secret] });
  try {
    const { context } = await f.start();
    const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
    await f.settlement.settle({ request: context.request, result, recording, stopped });
    if (recording.status !== 'fulfilled') throw new Error('recording_not_fulfilled');
    const manifest = validateWorkEvidenceManifest(await f.json(recording.value.manifestArtifactId));
    expect(JSON.stringify(manifest).includes(secret)).toBe(false);
    expect(manifest.result).toMatchObject({ exitCode: null, durationMs: null });
    expect(f.query('SELECT exit_code, duration_ms FROM attempts')).toEqual({ exit_code: null, duration_ms: null });
  } finally { f.close(); }
});

test('[case:redacted-evidence] 事件、清单及结算原因均脱敏，诊断不写入凭据正文', async () => {
  // Never include this literal in assertion operands, titles or emitted diagnostics.
  const secret = randomUUID().replaceAll('-', '');
  const f = await openRuntimeNegativeFixture({ script: { schemaVersion: 1, steps: [
    { op: 'message', role: 'assistant', text: `Authorization: Bearer ${secret}` },
    { op: 'usage', inputTokens: null, outputTokens: 7, costUsdMicros: null },
  ] } }, adapter => ({ async start(request) {
    const handle = await adapter.start(request);
    return { ...handle, result: handle.result.then(() => { throw new RuntimeError('provider', `provider_${secret}`); }) };
  } }), { secrets: [secret] });
  try {
    const { context } = await f.start();
    const [result, recording, stopped] = await Promise.all([context.result, context.recording, context.stopped]);
    await f.settlement.settle({ request: context.request, result, recording, stopped });
    if (recording.status !== 'fulfilled') throw new Error('recording_not_fulfilled');
    const manifest = validateWorkEvidenceManifest(await f.json(recording.value.manifestArtifactId));
    const evidenceRef = (f.query('SELECT diagnostic_ref FROM attempts') as { diagnostic_ref: string }).diagnostic_ref;
    const refs = [evidenceRef, recording.value.manifestArtifactId, ...manifest.chunks.map(chunk => chunk.artifactId)];
    for (const ref of refs) {
      const body = Buffer.from((await f.verifier.readVerifiedContent(f.projectId, ref)).content).toString('utf8');
      expect(body.includes(secret)).toBe(false);
    }
    expect(manifest.redaction).toEqual({ applied: true, secretValueCount: 1 });
    expect(manifest.usage).toMatchObject({ basis: 'synthetic', observations: {
      totals: { inputTokens: null, outputTokens: 7, costUsdMicros: null, complete: false } } });
    expect((await f.json(evidenceRef)).execution.failure).toEqual({ kind: 'provider', reason: 'provider_redacted' });
    expect(f.query('SELECT exit_code, duration_ms, usage_summary FROM attempts'))
      .toEqual({ exit_code: null, duration_ms: null, usage_summary: null });
  } finally { f.close(); }
});
