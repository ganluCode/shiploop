/**
 * P04-8 F-005 offline observations through public Core ports and real SQLite/Artifacts.
 * No model, network, private SDK tables, or stage-test recursion.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { ArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { buildUsageProjection, normalizeUsageObservations } from '../../../packages/core/src/application/usage-normalization.ts';
import type { UsageProjectionRecord } from '../../../packages/core/src/application/usage-normalization.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createWorkEvidenceRecorder, WorkEvidenceRecordingError } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { validateWorkEvidenceManifest, validateWorkEvidenceEventLine } from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import type { RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import { BINDING_NOW as NOW, openBindingFixture, type BindingFixture } from '../p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../p03-6/evidence-fixture.ts';

/** Diagnostics and recording are not business authority; compare the actual persisted rows. */
function businessSnapshot(f: BindingFixture): string {
  const tables = ['tasks', 'attempts', 'runs', 'execution_batches', 'task_attempt_reservations',
    'runtime_start_reservations', 'workspace_leases', 'verification_batches', 'check_results',
    'git_operations', 'task_approval_items', 'command_receipts', 'state_events',
    'attempt_notifications', 'task_claim_receipts', 'batch_budget_revisions'];
  return JSON.stringify(Object.fromEntries(tables.map(table => [table,
    f.session.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

export async function runLateResultFault(fence: 'task-version' | 'attempt-version' | 'owner' | 'host') {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  try {
    const db = f.session.database;
    const launch = f.claimAndLaunch('t-1');
    const bound = await f.bindingService.bind(f.bindingInput(launch));
    const current = bound.request;
    const sessionsStore = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const identity = { projectId: f.projectId, sessionId: current.sessionId, attemptId: launch.receipt.attempt.id,
      owner: current.owner.principalId, hostInstanceId: current.owner.hostInstanceId, executionVersion: current.executionVersion };
    const created = sessionsStore.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'offline-matrix' });
    sessionsStore.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
    // Attempt authority is immutable. Simulate stale ingress, never disable the database guards.
    if (fence === 'task-version') db.prepare('UPDATE tasks SET execution_version = execution_version + 1 WHERE id = ?').run('t-1');
    const request = { ...current,
      // A late result must not be rebound to a different generation either.
      ...(fence === 'attempt-version' ? { executionVersion: current.executionVersion + 1 } : {}),
      owner: { ...current.owner,
        ...(fence === 'owner' ? { principalId: 'previous-owner' } : {}),
        ...(fence === 'host' ? { hostInstanceId: 'previous-host' } : {}),
      },
    };
    const before = businessSnapshot(f);
    const artifacts = JSON.stringify(await f.artifacts.listArtifacts(f.projectId));
    const sessions = JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY rowid').all());
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.workspace.canonicalPath, encoding: 'utf8', timeout: 5000, maxBuffer: 65_536 }).trim();
    const oldHead = head();
    const settlement = createRuntimeSettlementService({ publisher: f.publisher,
      lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }),
      attempts: createSqliteAttemptAccess(f.session), dag: createSqliteTaskDagStore(f.session) });
    const input = { request, result: { status: 'fulfilled' as const, value: {
      schemaVersion: 1 as const, terminal: 'completed' as const, reason: null, exitCode: 0,
      signal: null, durationMs: 10, lastEventSequence: 0,
      usage: { basis: 'reported' as const, inputTokens: 12345, outputTokens: 6789, costUsdMicros: 5000 },
    } }, stopped: { status: 'fulfilled' as const, value: {
      schemaVersion: 1 as const, confirmed: true, checkedAtUtc: new Date(NOW).toISOString(), detail: null,
    } }, recording: null };
    const receipts = [await settlement.settle(input), await settlement.settle(input)];
    return { schemaVersion: 1, scenarioId: `late-${fence}`, receipts, businessUnchanged: before === businessSnapshot(f),
      artifactsUnchanged: artifacts === JSON.stringify(await f.artifacts.listArtifacts(f.projectId)),
      sessionUnchanged: sessions === JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY rowid').all()),
      diagnostics: (f.query('SELECT COUNT(*) AS n FROM attempt_notification_diagnostics') as { n: number }).n,
      gitHeadUnchanged: head() === oldHead };
  } finally { f.close(); }
}

export function runUsageConsistencyFault() {
  const base: UsageProjectionRecord = { taskId: 'task-1', runId: 'run-1', featureId: 'feature-1',
    identity: { runtime: 'pi', provider: 'offline', model: 'controlled', attemptId: 'attempt-1', sessionId: 'session-1',
      invocationId: 'invoke-1', requestId: 'request-1', messageId: null, eventId: 'summary-1', providerSessionId: null,
      providerRequestId: null, recovery: 'new' },
    kind: 'attempt', final: true, usage: { basis: 'reported', inputTokens: 100, outputTokens: 10,
      costUsdMicros: null, accounting: 'cumulative', coverage: 'reported' } };
  const resumed: UsageProjectionRecord = { ...base, identity: { ...base.identity, attemptId: 'attempt-2',
    sessionId: 'session-2', invocationId: 'invoke-2', requestId: 'request-2', eventId: 'summary-2', recovery: 'resume' },
    usage: { ...base.usage, inputTokens: 150, outputTokens: 15 }, historicalBaseline: { inputTokens: 100, outputTokens: 10 },
    historicalBaselineKey: 'previous-watermark-4' };
  const child = (parent: UsageProjectionRecord): UsageProjectionRecord => ({ ...parent, kind: 'request', final: false,
    identity: { ...parent.identity, eventId: `${parent.identity.eventId}-child` },
    usage: { ...parent.usage, accounting: 'incremental' } });
  const records = [child(base), base, base, child(resumed), resumed, resumed];
  const rows = normalizeUsageObservations(records);
  const projection = buildUsageProjection(records);
  return { schemaVersion: 1, scenarioId: 'usage-scopes', totals: projection.attempts.map(item => item.aggregate.totals.inputTokens),
    featureInputTokens: projection.feature.aggregate.totals.inputTokens, counted: rows.map(row => row.counted),
    reasons: rows.map(row => row.observation.deduplication.reason), rawResumedInputTokens: rows[4]!.rawUsage.inputTokens };
}

export async function runRecordingFault(scenario: 'replay' | 'large-message' | 'disk-write' | 'native-database-corrupt') {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  try {
    const launch = f.claimAndLaunch('t-1');
    const { request } = await f.bindingService.bind(f.bindingInput(launch));
    const identity = { projectId: f.projectId, sessionId: request.sessionId, attemptId: launch.receipt.attempt.id,
      owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'offline-matrix' });
    sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
    const before = businessSnapshot(f);
    const event = (sequence: number, kind: string, payload: object) => ({ schemaVersion: 1, eventId: `evt.matrix.${sequence}`,
      sequence, kind, occurredAtUtc: new Date(NOW).toISOString(), payload });
    const events = [event(1, 'tool_started', { toolCallId: 'parent', toolName: 'read', input: 'parent input' }),
      event(2, 'tool_started', { toolCallId: 'child', parentToolCallId: 'parent', toolName: 'read', input: 'child input' }),
      event(3, 'usage', { basis: 'reported', inputTokens: 7, outputTokens: 3, costUsdMicros: 1, accounting: 'incremental' }),
      event(4, 'message', { messageId: 'answer', role: 'assistant', preview: 'current output' })];
    if (scenario === 'large-message') events[3] = event(4, 'message', {
      messageId: 'large', role: 'assistant', preview: 'large output', text: '大'.repeat(20_000),
    });
    let nativeDatabaseRejected = false;
    let nativePath: string | undefined;
    if (scenario === 'native-database-corrupt') {
      // Generic optional native SQLite backend fixture, NOT the standard Pi JSONL format.
      // It is physically separate from Core, closed before corruption, and contains no SDK private tables.
      nativePath = join(f.box.root, 'controlled-native.sqlite');
      const native = openSqliteStorageSession({ path: nativePath });
      try { native.database.exec('CREATE TABLE native_probe (id TEXT PRIMARY KEY); INSERT INTO native_probe VALUES (\'checkpoint\')'); }
      finally { native.close(); }
      writeFileSync(nativePath, 'corrupted native database header');
    }
    let cancelCalls = 0;
    const handle: RuntimeHandle = {
      events: { async *[Symbol.asyncIterator]() {
        for (const item of events) {
          if (nativePath !== undefined && item.sequence === 3) {
            try { const native = openSqliteStorageSession({ path: nativePath }); native.close(); }
            catch (error) { nativeDatabaseRejected = true; throw error; }
            throw new Error('native corruption was not rejected');
          }
          yield item;
          if (scenario === 'replay') yield item;
        }
      } },
      result: Promise.resolve({ schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0,
        signal: null, durationMs: 10, lastEventSequence: 4,
        usage: { basis: 'reported', inputTokens: 900, outputTokens: 500, costUsdMicros: 100, accounting: 'cumulative' } }),
      stopped: Promise.resolve({ schemaVersion: 1, confirmed: true, checkedAtUtc: new Date(NOW).toISOString(), detail: null }),
      cancel: async () => { cancelCalls++; return { accepted: true, reason: null }; },
    };
    let writes = 0;
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const publisher = createArtifactPublisher({ artifacts: f.artifacts, files: { ...files,
      async openStagingWrite(key) {
        if (scenario === 'disk-write' && ++writes === 2) throw new ArtifactFileError('io', 'matrix.write', 'controlled disk full', {
          details: { code: 'ENOSPC' },
        });
        return files.openStagingWrite(key);
      },
    }, limits: { maxSizeBytes: 4_000_000, timeoutMs: 5000 } });
    const recorder = createWorkEvidenceRecorder({ publisher, verifier: f.verifier, sessions,
      limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 2, tailWaitMs: 200 } });
    let manifestId: string;
    let failureReason: string | null = null;
    try { manifestId = (await recorder.record({ request, handle, eventIdentityPrefix: 'evt.matrix.' })).manifestArtifactId; }
    catch (error) {
      if (!(error instanceof WorkEvidenceRecordingError) || error.manifestArtifactId === null) throw error;
      manifestId = error.manifestArtifactId;
      failureReason = error.reason;
    }
    const bytes = await f.verifier.readVerifiedContent(f.projectId, manifestId);
    const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(bytes.content).toString('utf8')));
    const lines = [];
    for (const chunk of manifest.chunks) {
      const stored = await f.verifier.readVerifiedContent(f.projectId, chunk.artifactId);
      lines.push(...Buffer.from(stored.content).toString('utf8').trim().split('\n')
        .map(line => validateWorkEvidenceEventLine(JSON.parse(line))));
    }
    const session = sessions.getWorkSession(f.projectId, request.sessionId);
    return { schemaVersion: 1, scenarioId: scenario, coverage: manifest.coverage, watermark: manifest.watermark, gaps: manifest.gaps,
      sessionGaps: session.recordingGaps, failureReason, cancelCalls, nativeDatabaseRejected,
      runtimeCompleted: (await handle.result as { terminal: string }).terminal === 'completed',
      failedChunks: (await f.artifacts.listArtifacts(f.projectId)).records.filter(row => row.kind === 'work-evidence-events' && row.status === 'failed').length,
      duplicatesDropped: manifest.stats.duplicatesDropped, sequences: lines.map(line => line.sequence),
      toolParents: lines.filter(line => line.payload.kind === 'tool_started').map(line => {
        if (line.payload.kind !== 'tool_started') throw new Error('tool kind mismatch');
        return [line.payload.toolCallId, line.payload.parentToolCallId ?? null];
      }), inputTokens: manifest.usage.observations.totals.inputTokens,
      finalInputTokens: manifest.usage.finalReported?.inputTokens, notAdditive: manifest.usage.notAdditive,
      businessUnchanged: businessSnapshot(f) === before,
      taskStatus: (f.query('SELECT status FROM tasks WHERE id = ?', 't-1') as { status: string }).status };
  } finally { f.close(); }
}
