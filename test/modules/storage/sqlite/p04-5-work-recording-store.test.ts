import { expect, it } from 'vitest';
import { createSqliteWorkRecordingStore } from '../../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createSqliteWorkSessionStore } from '../../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { BINDING_NOW as NOW, openBindingFixture, publishReadyArtifact } from '../../../helpers/p03-6/input-binding-fixture.ts';
import { RECORDING_MESSAGE, RECORDING_MANIFEST } from '../../../helpers/p04-5/recording-fixture.ts';

async function fixture() {
  const f = await openBindingFixture();
  try {
    const bound = f.claimAndLaunch('t-1');
    const attempt = bound.receipt.attempt;
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const identity = { projectId: f.projectId, sessionId: 'recording-session', runId: f.runId,
      attemptId: attempt.id, invocationId: bound.invocationId, executionVersion: attempt.executionVersion,
      owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, purpose: 'work' as const };
    const created = sessions.createWorkSession({ sessionId: identity.sessionId, projectId: identity.projectId,
      attemptId: identity.attemptId, owner: identity.owner, hostInstanceId: identity.hostInstanceId,
      executionVersion: identity.executionVersion, purpose: 'execution', runtime: 'fake', adapterVersion: '1' });
    const locator = 'recordings/public.json';
    const ref = { ...await publishReadyArtifact(f, { kind: 'session-recording', locator, content: '{"public":"body"}' }), locator };
    const { owner: _owner, hostInstanceId: _host, purpose: _purpose, ...recordIdentity } = identity;
    const message = { ...RECORDING_MESSAGE, ...recordIdentity, contentRef: ref, createdAtUtcMs: NOW,
      updatedAtUtcMs: NOW, occurredAtUtcMs: NOW, recordedAtUtcMs: NOW };
    const manifest = { ...RECORDING_MANIFEST, ...recordIdentity, manifestRef: ref, watermark: 1,
      createdAtUtcMs: NOW, updatedAtUtcMs: NOW };
    const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
    const input = { identity, expectedSessionRevision: created.session.revision, expectedManifestRevision: 0,
      messages: [message], manifest };
    return { ...f, store, input, message, manifest, identity, sessions, ref };
  } catch (error) { f.close(); throw error; }
}

it('[case:stable-replay] stable event/message replay indexes once and preserves the durable manifest', async () => {
  const f = await fixture();
  try {
    const businessTables = ['tasks', 'attempts', 'runs', 'execution_batches', 'state_events'];
    const businessBefore = businessTables.map(table => f.session.database.prepare(`SELECT * FROM ${table}`).all());
    const first = f.store.commitRecording(f.input);
    expect(first).toMatchObject({ status: 'applied', inserted: 1, manifest: { watermark: 1, version: 1, revision: 1 } });
    expect(f.store.commitRecording(f.input)).toMatchObject({ status: 'duplicate', inserted: 0 });
    const replay = { ...f.input, expectedSessionRevision: first.sessionRevision, expectedManifestRevision: 1,
      messages: [{ ...f.message, id: 'replayed-message', source: 'recovered' as const, sourceRefs: ['native-history'], recordedAtUtcMs: NOW + 1 }],
      manifest: { ...f.manifest, id: 'manifest-2', revision: 2, version: 2, source: 'recovered' as const } };
    const second = f.store.commitRecording(replay);
    expect(second).toMatchObject({ status: 'applied', inserted: 0 });
    expect(f.store.commitRecording(f.input)).toMatchObject({ status: 'duplicate', inserted: 0, manifest: second.manifest });
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 1 });
    expect(f.store.getLatestManifest(f.projectId, f.identity.sessionId)).toEqual(second.manifest);
    expect(f.sessions.getWorkSession(f.projectId, f.identity.sessionId)).toMatchObject({ recordingWatermark: 1,
      recordingGaps: f.manifest.missingReasons, revision: second.sessionRevision });
    expect(businessTables.map(table => f.session.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(businessBefore);
  } finally { f.close(); }
});

it('[case:conflicting-content] content conflicts append bounded diagnostics without replacing evidence or admitting other batch messages', async () => {
  const f = await fixture();
  try {
    const first = f.store.commitRecording(f.input);
    const next = { ...f.input, expectedSessionRevision: first.sessionRevision, expectedManifestRevision: 1,
      messages: [{ ...f.message, id: 'fresh-message', sequence: 2, eventId: 'fresh-event', messageKey: 'fresh-key' },
        { ...f.message, id: 'conflict-message', role: 'error' as const }],
      manifest: { ...f.manifest, id: 'next-manifest', version: 2, revision: 2, watermark: 2 } };
    const conflict = f.store.commitRecording(next);
    expect(conflict).toMatchObject({ status: 'conflict', inserted: 0, manifest: { version: 2, watermark: 1,
      coverage: 'partial', manifestRef: null, diagnostics: ['stable_identity_content_conflict'] } });
    expect(f.store.getLatestManifest(f.projectId, f.identity.sessionId)).toEqual(conflict.manifest);
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 1 });
    expect(f.query('SELECT role FROM session_messages')).toEqual({ role: 'assistant' });
    expect(f.query('SELECT COUNT(*) AS n FROM recording_manifests')).toEqual({ n: 2 });
    expect(f.query('SELECT coverage FROM recording_manifests WHERE version = 1')).toEqual({ coverage: 'partial' });
    expect(() => f.store.commitRecording(next)).toThrow(/CAS/);
  } finally { f.close(); }
});

it('[case:fenced-ownership] rejects foreign projects, sessions, runs, invocations, owners, purposes and obsolete execution generations', async () => {
  const f = await fixture();
  try {
    for (const override of [{ projectId: 'foreign-project' }, { sessionId: 'missing-session' }, { runId: 'other-run' },
      { attemptId: 'other-attempt' }, { invocationId: 'old-invocation' }, { executionVersion: 2 },
      { owner: 'other-owner' }, { hostInstanceId: 'old-host' }, { purpose: 'chat' }]) {
      expect(() => f.store.commitRecording({ ...f.input, identity: { ...f.identity, ...override } } as never)).toThrow();
    }
    for (const override of [{ projectId: 'foreign-project' }, { sessionId: 'other-session' }, { invocationId: 'other-invocation' }]) {
      expect(() => f.store.commitRecording({ ...f.input, messages: [{ ...f.message, ...override }] })).toThrow();
      expect(() => f.store.commitRecording({ ...f.input, manifest: { ...f.manifest, ...override } })).toThrow();
    }
    const db = f.session.database;
    db.prepare('UPDATE tasks SET execution_version = execution_version + 1 WHERE id = ?').run('t-1');
    expect(() => f.store.commitRecording(f.input)).toThrow(/identity/);
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 0 });
    expect(f.store.getLatestManifest(f.projectId, f.identity.sessionId)).toBeNull();
    expect(() => f.store.getLatestManifest('other-project', f.identity.sessionId)).toThrow(/scope/);
  } finally { f.close(); }
});

it('[case:artifact-readiness] pending, wrong hash/size/locator and foreign Artifact refs cannot advance durable watermarks', async () => {
  const f = await fixture();
  try {
    const pending = await f.artifacts.registerArtifact({ projectId: f.projectId, kind: 'session-recording',
      mediaType: 'application/json', expectedHash: f.ref.contentHash, locator: 'recordings/pending.json' });
    f.session.database.prepare(`INSERT INTO projects (id, created_at, updated_at, display_name, status, labels)
      VALUES ('foreign-project', ?, ?, 'Foreign', 'active', '[]')`).run(NOW, NOW);
    f.session.database.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES ('foreign-artifact', ?, ?, 'foreign-project',
      'session-recording', 'ready', 'application/json', ?, ?, ?, ?)`)
      .run(NOW, NOW, f.ref.contentHash, f.ref.contentHash, f.ref.sizeBytes, f.ref.locator);
    const badRefs = [{ ...f.ref, artifactId: pending.id }, { ...f.ref, artifactId: 'foreign-artifact' },
      { ...f.ref, contentHash: 'ef'.repeat(32) },
      { ...f.ref, sizeBytes: f.ref.sizeBytes + 1 }, { ...f.ref, locator: 'recordings/other.json' }];
    for (const ref of badRefs) {
      expect(() => f.store.commitRecording({ ...f.input, messages: [{ ...f.message, contentRef: ref }] })).toThrow(/Artifact/);
      expect(() => f.store.commitRecording({ ...f.input, manifest: { ...f.manifest, manifestRef: ref } })).toThrow(/Artifact/);
      expect(() => f.store.commitRecording({ ...f.input, messages: [{ ...f.message, attachments: [
        { ...ref, name: null, mediaType: 'text/plain', truncated: false, redacted: false },
      ] }] })).toThrow(/Artifact/);
    }
    expect(f.sessions.getWorkSession(f.projectId, f.identity.sessionId)).toMatchObject({ recordingWatermark: null,
      revision: f.input.expectedSessionRevision });
    expect(f.query('SELECT status FROM artifacts WHERE id = ?', pending.id)).toEqual({ status: 'pending' });
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 0 });
  } finally { f.close(); }
});

it('[case:manifest-cas] independent connections race on manifest and Session CAS; stale writes retain all committed evidence', async () => {
  const f = await fixture();
  const other = openSqliteStorageSession({ path: f.session.path });
  try {
    const peer = createSqliteWorkRecordingStore(other, { nowUtcMs: () => NOW });
    const snapshot = f.store.getLatestManifest(f.projectId, f.identity.sessionId);
    expect(snapshot).toBeNull();
    const first = f.store.commitRecording(f.input);
    const message = { ...f.message, id: 'message-2', sequence: 2, eventId: 'event-2', messageKey: 'key-2' };
    const manifest = { ...f.manifest, id: 'manifest-2', version: 2, revision: 2, watermark: 2 };
    expect(() => peer.commitRecording({ ...f.input, messages: [message], manifest })).toThrow(/CAS/);
    expect(() => peer.commitRecording({ ...f.input, expectedSessionRevision: first.sessionRevision,
      messages: [message], manifest })).toThrow(/CAS/);
    const second = peer.commitRecording({ ...f.input, expectedSessionRevision: first.sessionRevision,
      expectedManifestRevision: 1, messages: [message], manifest });
    expect(second).toMatchObject({ inserted: 1, manifest: { watermark: 2 } });
    expect(() => f.store.commitRecording({ ...f.input, expectedSessionRevision: second.sessionRevision,
      expectedManifestRevision: 2, messages: [], manifest: { ...manifest, id: 'regression', revision: 3, version: 3, watermark: 1 } }))
      .toThrow(/watermark/);
    other.close();
    const reopened = openSqliteStorageSession({ path: f.session.path });
    try {
      expect(createSqliteWorkRecordingStore(reopened).getLatestManifest(f.projectId, f.identity.sessionId)).toEqual(second.manifest);
    } finally { reopened.close(); }
  } finally { other.close(); f.close(); }
});

it('[case:atomic-failure] a failure after index/manifest inserts rolls back links, gaps and watermark but retains ready body evidence', async () => {
  const f = await fixture();
  try {
    const first = f.store.commitRecording(f.input);
    const db = f.session.database;
    db.exec(`CREATE TRIGGER fail_recording_progress BEFORE UPDATE OF recording_watermark ON sessions
      BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END;`);
    const next = { ...f.input, expectedSessionRevision: first.sessionRevision, expectedManifestRevision: 1,
      messages: [{ ...f.message, id: 'message-2', sequence: 2, eventId: 'event-2', messageKey: 'key-2',
        kind: 'tool_finished' as const, toolCallId: 'child', parentToolCallId: 'parent' }],
      manifest: { ...f.manifest, id: 'manifest-2', version: 2, revision: 2, watermark: 2, missingReasons: ['new-gap'] } };
    expect(() => f.store.commitRecording(next)).toThrow(/injected/);
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 1 });
    expect(f.store.getLatestManifest(f.projectId, f.identity.sessionId)).toEqual(first.manifest);
    expect(f.sessions.getWorkSession(f.projectId, f.identity.sessionId)).toMatchObject({ recordingWatermark: 1,
      recordingGaps: f.manifest.missingReasons, revision: first.sessionRevision });
    expect(f.query('SELECT status FROM artifacts WHERE id = ?', f.ref.artifactId)).toEqual({ status: 'ready' });
    db.exec('DROP TRIGGER fail_recording_progress');
    expect(f.store.commitRecording(next)).toMatchObject({ inserted: 1 });
    expect(f.query('SELECT tool_call_id, parent_tool_call_id FROM session_messages WHERE sequence = 2'))
      .toEqual({ tool_call_id: 'child', parent_tool_call_id: 'parent' });
  } finally { f.close(); }
});

it('[case:terminal-and-child-scope] Work child sessions inherit the active Attempt fence; Chat and completed Attempts cannot write', async () => {
  const f = await fixture();
  try {
    const db = f.session.database;
    for (const [id, kind, purpose] of [['child', 'work', 'subtask'], ['chat-child', 'chat', 'chat'], ['wrong-purpose', 'work', 'chat']]) {
      db.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, parent_session_id, kind, purpose,
        runtime, adapter_version, input_ref, last_activity_at) SELECT ?, ?, ?, project_id, id, ?, ?,
        runtime, adapter_version, input_ref, ? FROM sessions WHERE id = ?`)
        .run(id, NOW, NOW, kind, purpose, NOW, f.identity.sessionId);
    }
    const childInput = { ...f.input, identity: { ...f.identity, sessionId: 'child' },
      messages: [{ ...f.message, sessionId: 'child' }], manifest: { ...f.manifest, sessionId: 'child' } };
    const first = f.store.commitRecording(childInput);
    expect(first).toMatchObject({ inserted: 1 });
    for (const sessionId of ['chat-child', 'wrong-purpose']) {
      expect(() => f.store.commitRecording({ ...childInput, identity: { ...childInput.identity, sessionId },
        messages: [{ ...f.message, sessionId }], manifest: { ...f.manifest, sessionId } })).toThrow(/identity/);
    }
    db.prepare("UPDATE attempts SET status = 'succeeded' WHERE id = ?").run(f.identity.attemptId);
    expect(() => f.store.commitRecording(childInput)).toThrow(/identity/);
    expect(f.store.getLatestManifest(f.projectId, 'child')).toEqual(first.manifest);
    expect(f.query('SELECT status FROM attempts WHERE id = ?', f.identity.attemptId)).toEqual({ status: 'succeeded' });
  } finally { f.close(); }
});

it('[case:tool-identities] duplicate tools and parent links remain one admission; a conflicting phase is diagnosed atomically', async () => {
  const f = await fixture();
  try {
    const tool = { ...f.message, kind: 'tool_finished' as const, role: 'tool' as const,
      toolCallId: 'child-call', parentToolCallId: 'parent-call' };
    const first = f.store.commitRecording({ ...f.input, messages: [tool, { ...tool, id: 'duplicate-tool' }] });
    expect(first).toMatchObject({ inserted: 1 });
    const conflict = f.store.commitRecording({ ...f.input, expectedSessionRevision: first.sessionRevision,
      expectedManifestRevision: 1,
      messages: [{ ...tool, id: 'conflicting-tool', eventId: 'other-event', sequence: 2, messageKey: 'other-key' }],
      manifest: { ...f.manifest, id: 'manifest-2', revision: 2, version: 2, watermark: 2 } });
    expect(conflict).toMatchObject({ status: 'conflict', inserted: 0 });
    expect(f.query('SELECT tool_call_id, parent_tool_call_id, sequence FROM session_messages'))
      .toEqual({ tool_call_id: 'child-call', parent_tool_call_id: 'parent-call', sequence: 1 });
  } finally { f.close(); }
});

it('[case:batch-and-revision-bounds] bounds transaction input and refuses manifest revision jumps or unsupported watermarks', async () => {
  const f = await fixture();
  try {
    expect(() => f.store.commitRecording({ ...f.input, messages: Array(65).fill(f.message) })).toThrow(/bounded/);
    expect(() => f.store.commitRecording({ ...f.input, manifest: { ...f.manifest, version: 2, revision: 2 } })).toThrow(/CAS/);
    expect(() => f.store.commitRecording({ ...f.input, manifest: { ...f.manifest, watermark: 2,
      missingReasons: ['sequence_gap'] } })).toThrow(/watermark/);
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 0 });
    expect(f.query('SELECT COUNT(*) AS n FROM recording_manifests')).toEqual({ n: 0 });
  } finally { f.close(); }
});

it('[case:declared-gaps] out-of-order durable bodies require explicit sequence gaps and cannot claim complete coverage', async () => {
  const f = await fixture();
  try {
    const input = { ...f.input, messages: [{ ...f.message, sequence: 3 }], manifest: { ...f.manifest, watermark: 3 } };
    expect(() => f.store.commitRecording(input)).toThrow(/gaps/);
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 0 });
    const result = f.store.commitRecording({ ...input, manifest: { ...input.manifest, missingReasons: ['sequence_gap'] } });
    expect(result.manifest).toMatchObject({ watermark: 3, missingReasons: ['sequence_gap'], coverage: 'partial' });
    expect(() => f.store.commitRecording({ ...input, expectedSessionRevision: result.sessionRevision,
      expectedManifestRevision: 1, messages: [], manifest: { ...input.manifest, id: 'complete', revision: 2, version: 2,
        coverage: 'complete', unknownEventCount: 0, missingReasons: [], finalSequence: 3,
        sequenceReconciliation: 'match', finalized: true } })).toThrow(/gaps/);
  } finally { f.close(); }
});
