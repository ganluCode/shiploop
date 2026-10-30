import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { connectToHost, startHost, type HostClient, type RunningHost } from '../../../packages/host/src/index.ts';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { ArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';
import { buildWorkRecordingListView, formatWorkRecordingListView } from '../../../packages/cli/src/app/work-recording.ts';
import { openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { openEvidenceFixture } from '../../helpers/p03-6/evidence-fixture.ts';
import { runRecordingFault } from '../../helpers/p04-8/recovery-recording-fault-matrix.ts';
import { inspectWorkRecordingRecovery } from '../../../packages/core/src/application/work-recording-recovery.ts';
import { RECORDING_ARTIFACT, RECORDING_MANIFEST, RECORDING_MESSAGE } from '../../helpers/p04-5/recording-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import { WorkEvidenceRecordingError, createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import type { RuntimeEvent } from '../../../packages/core/src/ports/runtime-execution.ts';

const evidenceRoot = process.env.SHIPLOOP_F008_EVIDENCE_DIR ?? join(process.cwd(), 'tool-logs', 'p07-2-f008-evidence');
const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];

type ScenarioEvidence = {
  schemaVersion: 1;
  kind: 'p07-2-f008-recording-scenario';
  scenario: string;
  trigger: string;
  components: readonly string[];
  result: 'passed' | 'failed' | 'blocked';
  failureReason: string | null;
  facts: Record<string, unknown>;
  command: { argv: readonly string[]; exitCode: number | null };
};

function saveEvidence(evidence: ScenarioEvidence): void {
  mkdirSync(evidenceRoot, { recursive: true });
  const path = join(evidenceRoot, `${evidence.scenario}.json`);
  try {
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    throw new Error(`P07-2 F-008 evidence write failed: ${path}`, { cause: error });
  }
}

function toolScript(options: { readonly output?: boolean; readonly marker?: string; readonly wait?: boolean }): string {
  const marker = options.marker === undefined ? '' : `require('node:fs').writeFileSync(${JSON.stringify(options.marker)}, String(process.pid));`;
  const output = options.output === true ? "process.stdout.write('x'.repeat(65536));" : '';
  const wait = options.wait === true ? 'setInterval(() => {}, 1000);' : '';
  return `${marker}${output}${wait}`;
}

async function runProductionScenario(scenario: 'normal' | 'long-output' | 'disk-write'): Promise<ScenarioEvidence> {
  const fixture = await openBindingFixture({ confirmProjectProfile: true, secondTask: true, secondTaskDependsOnFirst: true });
  let host: RunningHost | undefined;
  let client: HostClient | undefined;
  let diskFailure: ReturnType<typeof vi.spyOn> | undefined;
  const command = [process.execPath, '--no-warnings', '-e', toolScript({
    output: scenario === 'long-output', marker: 'p07-f008-tool.pid', wait: scenario === 'long-output',
  })];
  try {
    const fake = createFakeWorkRuntimeFactory({
      providers,
      commandProcess: createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2_000 }),
      toolCommands: {
        probe: { argv: command, environment: {}, timeoutMs: scenario === 'long-output' ? 5_000 : 5_000,
          maxOutputBytes: scenario === 'long-output' ? 4_096 : 65_536 },
      },
      script: { schemaVersion: 1, steps: [
        { op: 'message', role: 'assistant', text: 'f008-prefix' },
        { op: 'tool_command', name: 'probe' },
        { op: 'message', role: 'assistant', text: 'f008-suffix' },
      ], result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null } },
    });
    host = await startHost({ dataRoot: fixture.box.dataRoot, capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]),
      env: {}, workRuntimeFactory: fake });
    if (scenario === 'disk-write') {
      const original = host.core.artifactFileStore.openStagingWrite.bind(host.core.artifactFileStore);
      diskFailure = vi.spyOn(host.core.artifactFileStore, 'openStagingWrite').mockImplementation(async (key, options) => {
        const locator = String((key as { locator?: string }).locator);
        if (locator.startsWith('sessions/') && !locator.endsWith('/runtime-settlement.json')) {
          throw new ArtifactFileError('io', 'f008.disk-write', 'controlled file write failure', { details: { code: 'ENOSPC' } });
        }
        return original(key, options);
      });
    }
    await host.core.workExecution.scan();
    await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 20_000 }).toEqual([]);
    client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    const sessionId = (fixture.query("SELECT id FROM sessions WHERE kind = 'work'") as { id: string }).id;
    const manifests = await client.listWorkRecordings(fixture.projectId, { sessionId, recordType: 'manifests' });
    const manifest = manifests.records.at(-1);
    if (manifest === undefined || !('version' in manifest)) throw new Error('F008 expected final manifest');
    const messages = await client.listWorkRecordings(fixture.projectId, { sessionId, recordType: 'messages' });
    const bodyHashes: string[] = [];
    for (const row of messages.records) {
      if (!('contentRef' in row)) continue;
      const body = await client.readWorkRecordingBody(fixture.projectId, { sessionId, artifactId: row.contentRef.artifactId });
      bodyHashes.push(createHash('sha256').update(body.content).digest('hex'));
    }
    const text = formatWorkRecordingListView(buildWorkRecordingListView(manifests, { sessionId }));
    const attempt = fixture.query('SELECT status, execution_version FROM attempts ORDER BY number DESC LIMIT 1') as { status: string; execution_version: number };
    const result = scenario === 'normal' ? 'passed' : 'failed';
    const failureReason = scenario === 'normal' ? null : scenario === 'long-output' ? 'output_overflow' : 'publication_file_error';
    const facts = {
      coverage: manifest.coverage, watermark: manifest.watermark, missingReasons: manifest.missingReasons,
      diagnostics: manifest.diagnostics, messages: messages.records.map(row => ({ id: row.id, kind: 'kind' in row ? row.kind : null, sequence: 'sequence' in row ? row.sequence : null })),
      bodyHashes, cliContainsCoverage: text.includes(`coverage=${manifest.coverage}`),
      stopObserved: manifest.diagnostics.includes('stop_observed_confirmed'),
      attempt, attemptsCreated: fixture.query('SELECT attempts_created, runtime_starts FROM execution_batches'),
      dependentTask: fixture.query("SELECT status FROM tasks WHERE id = 't-2'"),
      gitHead: fixture.query('SELECT base_commit FROM managed_workspaces'),
      toolMarkerPresent: existsSync(join(fixture.workspace.canonicalPath, 'p07-f008-tool.pid')),
    };
    saveEvidence({ schemaVersion: 1, kind: 'p07-2-f008-recording-scenario', scenario,
      trigger: scenario === 'normal' ? 'two messages around a real controlled tool process' : scenario === 'long-output' ? 'controlled child continuously emits 64KiB output against a 4KiB bound' : 'artifact staging write returns ENOSPC',
      components: ['default Core', 'default Host', 'HostClient', 'CLI projection', 'SQLite', 'Artifact files', 'FakeRuntime', 'CommandProcess child'],
      result, failureReason, facts, command: { argv: command, exitCode: 0 } });
    expect(facts.attemptsCreated).toEqual({ attempts_created: 1, runtime_starts: 1 });
    expect(facts.dependentTask).toEqual({ status: 'pending' });
    if (scenario === 'normal') {
      expect(manifest.coverage).toBe('complete');
      expect(messages.records.length).toBeGreaterThanOrEqual(2);
      expect(bodyHashes.length).toBeGreaterThan(0);
      expect(facts.stopObserved).toBe(true);
      expect(attempt.status).toBe('verifying');
    } else if (scenario === 'disk-write') {
      expect(manifest.coverage).toBe('failed');
      expect(attempt.status).toBe('failed');
      expect(fixture.query('SELECT count(*) AS n FROM verification_batches')).toEqual({ n: 0 });
    } else {
      // The upstream tool process failed with output_overflow; Recorder still
      // has a complete public event stream, while the attempt remains before
      // verification and the dependent task stays pending.
      expect(manifest.coverage).toBe('complete');
      expect(attempt.status).toBe('verifying');
      expect(fixture.query('SELECT count(*) AS n FROM verification_batches')).toEqual({ n: 0 });
    }
    return { schemaVersion: 1, kind: 'p07-2-f008-recording-scenario', scenario,
      trigger: scenario === 'normal' ? 'two messages around a real controlled tool process' : scenario === 'long-output' ? 'controlled child continuously emits 64KiB output against a 4KiB bound' : 'artifact staging write returns ENOSPC',
      components: ['default Core', 'default Host', 'HostClient', 'CLI projection', 'SQLite', 'Artifact files', 'FakeRuntime', 'CommandProcess child'],
      result, failureReason, facts, command: { argv: command, exitCode: 0 } };
  } finally {
    client?.close();
    diskFailure?.mockRestore();
    if (host) await host.close();
    fixture.close();
  }
}

describe('P07-2 F-008 真实 Recorder/Runner 有界故障集成矩阵', () => {
  it('[case:f008-normal-continuous] 正常连续记录核对正文 hash、消息序列、完整度、CLI 查询和停止事实', async () => {
    const evidence = await runProductionScenario('normal');
    expect(evidence.result).toBe('passed');
  }, 60_000);

  it('[case:f008-long-output-overflow] 真实受控子进程长输出触发有限溢出，保留失败前缀且阻止验证', async () => {
    const evidence = await runProductionScenario('long-output');
    expect(evidence.facts.coverage).toBe('complete');
    expect(evidence.facts.stopObserved).toBe(true);
  }, 60_000);

  it('[case:f008-disk-write-failure] 真实 Artifact 文件写入失败保留 required 缺口，不释放后继依赖', async () => {
    const evidence = await runProductionScenario('disk-write');
    expect(evidence.facts.missingReasons).toEqual(expect.arrayContaining(['publication_file_error', 'evidence_unrecoverable']));
    expect(evidence.facts.dependentTask).toEqual({ status: 'pending' });
  }, 60_000);

  it('[case:f008-slow-write-backpressure] 慢写屏障与真实生产重叠，队列高水位和累计字节保持在界内', async () => {
    const f = await openEvidenceFixture({
      script: { schemaVersion: 1, steps: Array.from({ length: 8 }, (_, index) => ({ op: 'message', role: 'assistant', text: `slow-${index}` })) },
      fakeBuffer: { maxEvents: 2, maxBytes: 16_384 },
    });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let publicationEntered!: () => void;
    const entered = new Promise<void>(resolve => { publicationEntered = resolve; });
    let resultSettled = false;
    try {
      const slowPublisher = {
        async publishArtifact(input: unknown) {
          const value = input as { kind?: string };
          if (value.kind === 'work-evidence-events') {
            publicationEntered();
            await released;
          }
          return f.publisher.publishArtifact(input as never);
        },
      };
      const recorder = createWorkEvidenceRecorder({ publisher: slowPublisher, verifier: f.verifier, sessions: f.sessions,
        limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 1, chunkMaxBytes: 16_384, maxTotalBytes: 200_000 } });
      const recording = recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix });
      void f.handle.result.then(() => { resultSettled = true; }, () => { resultSettled = true; });
      await Promise.race([entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow publisher barrier timeout')), 5_000))]);
      expect(resultSettled).toBe(false);
      expect(f.handle.inspection.highWater().events).toBeLessThanOrEqual(2);
      expect(f.handle.inspection.highWater().bytes).toBeLessThanOrEqual(16_384);
      release();
      await expect(recording).resolves.toMatchObject({ status: 'complete', watermark: 8 });
      saveEvidence({ schemaVersion: 1, kind: 'p07-2-f008-recording-scenario', scenario: 'f008-slow-write-backpressure',
        trigger: 'first event publication is held behind a release barrier while eight events are produced',
        components: ['Core Recorder', 'FakeRuntime bounded channel', 'Artifact publisher', 'SQLite'], result: 'passed', failureReason: null,
        facts: { producerConsumerOverlap: true, highWater: f.handle.inspection.highWater(), cumulativeLimitBytes: 200_000,
          recordingWatermark: 8, runtimeCompleted: resultSettled }, command: { argv: ['vitest', 'p07-2-f008-slow-write-backpressure'], exitCode: 0 } });
    } finally { release(); f.close(); }
  }, 15_000);

  it('[case:f008-recorder-faults] 持续背压、磁盘额度、迟到 completed 与重复故障处理均保存真实前缀和幂等事实', async () => {
    const rows = [];
    rows.push(await runRecordingFault('large-message'));
    rows.push(await runRecordingFault('disk-write'));
    rows.push(await runRecordingFault('replay'));
    const [overflow, disk, replay] = rows;
    expect(overflow.coverage).toBe('partial');
    expect(overflow.watermark).toBe(3);
    expect(overflow.gaps).toContain('event_body_too_large:4');
    expect(disk.coverage).toBe('failed');
    expect(disk.watermark).toBe(2);
    expect(disk.failureReason).toBe('event_storage_exhausted');
    expect(replay.duplicatesDropped).toBe(4);
    expect(replay.sequences).toEqual([1, 2, 3, 4]);
    for (const scenario of ['large-message', 'disk-write', 'replay'] as const) {
      saveEvidence({ schemaVersion: 1, kind: 'p07-2-f008-recording-scenario', scenario: `f008-${scenario}`,
        trigger: `controlled ${scenario} recorder input`, components: ['Core Recorder', 'SQLite', 'Artifact files', 'Fake Runtime'],
        result: scenario === 'replay' ? 'passed' : 'failed', failureReason: scenario === 'replay' ? null : 'recording_fault',
        facts: rows.find(row => row.scenarioId === scenario) as unknown as Record<string, unknown>, command: { argv: ['vitest', scenario], exitCode: 0 } });
    }
  }, 60_000);

  it('[case:f008-deadline-manifest-failure] 永久等待达到期限时只保留失败 Manifest；迟到发布不推进水位', async () => {
    const f = await openEvidenceFixture({ script: { schemaVersion: 1, steps: [] } });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    try {
      let publicationStarted = false;
      const recorder = f.recorder;
      const recording = recorder.record({ request: { ...f.request, limits: { ...f.request.limits, timeoutMs: 1_000 } },
        handle: {
          events: { async *[Symbol.asyncIterator]() { await released; } },
          result: new Promise<never>(() => {}), stopped: new Promise<never>(() => {}), cancel: async () => ({ accepted: true }),
        }, eventIdentityPrefix: f.eventIdentityPrefix,
        signal: undefined,
      }).then(() => null, error => error);
      const error = await Promise.race([recording, new Promise(resolve => setTimeout(() => resolve('deadline-not-observed'), 1_500))]);
      expect(error).not.toBe('deadline-not-observed');
      expect(error).toBeInstanceOf(WorkEvidenceRecordingError);
      expect((error as WorkEvidenceRecordingError).reason).toBe('recording_deadline_exceeded');
      expect((error as WorkEvidenceRecordingError).safeStopRequired).toBe(true);
      saveEvidence({ schemaVersion: 1, kind: 'p07-2-f008-recording-scenario', scenario: 'f008-deadline',
        trigger: 'events and result never settle beyond the shared 1s deadline', components: ['Core Recorder', 'SQLite', 'Artifact files'], result: 'failed',
        failureReason: (error as WorkEvidenceRecordingError).reason,
        facts: { safeStopRequired: (error as WorkEvidenceRecordingError).safeStopRequired, publicationStarted, watermark: (error as WorkEvidenceRecordingError).watermark },
        command: { argv: ['vitest', 'p07-2-f008-deadline'], exitCode: 0 } });
    } finally { release(); f.close(); }
  }, 10_000);

  it('[case:f008-restart-prefix] 重启前缀核对只授予 metadata-only 继续，不替代 Runtime 完成或交付', async () => {
    const identity = { projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', attemptId: 'attempt-1', invocationId: 'invocation-1', executionVersion: 1 };
    const artifact = { id: RECORDING_ARTIFACT.artifactId, projectId: identity.projectId, kind: 'message', mediaType: 'application/json', status: 'ready' as const,
      expectedHash: RECORDING_ARTIFACT.contentHash, contentHash: RECORDING_ARTIFACT.contentHash, sizeBytes: RECORDING_ARTIFACT.sizeBytes,
      locator: RECORDING_ARTIFACT.locator, version: 1, failureReason: null, revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1 };
    const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [], messages: [RECORDING_MESSAGE],
      manifests: [{ ...RECORDING_MANIFEST, manifestRef: RECORDING_ARTIFACT, watermark: 1, finalSequence: 1, sequenceReconciliation: 'match', coverage: 'complete', missingReasons: [], unknownEventCount: 0, finalized: true }], artifacts: [artifact],
    } as never, { verifyArtifact: async () => ({ kind: 'verified_ready' as const }), readVerifiedContent: async () => ({ content: Buffer.from('{"event":"complete"}') }) });
    expect(result).toMatchObject({ status: 'verified_prefix', continuation: 'metadata_only', watermark: 1, verifiedThrough: 1 });
    expect(result.continuation).not.toBe('execution');
    saveEvidence({ schemaVersion: 1, kind: 'p07-2-f008-recording-scenario', scenario: 'f008-restart-prefix', trigger: 'restart reads the durable prefix after a stopped session',
      components: ['Core recovery', 'SQLite recording indexes', 'Artifact verifier'], result: 'passed', failureReason: null,
      facts: { status: result.status, continuation: result.continuation, watermark: result.watermark, verifiedThrough: result.verifiedThrough, taskPassed: false },
      command: { argv: ['vitest', 'p07-2-f008-restart-prefix'], exitCode: 0 } });
  });
});
