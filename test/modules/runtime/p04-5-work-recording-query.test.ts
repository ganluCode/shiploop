import { expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { WORK_SESSION_EVIDENCE_MAX_READ_BYTES } from '../../../packages/core/src/ports/work-session-query.ts';
import type { WorkRecordingMessageRecord, WorkRecordingManifestRecord } from '../../../packages/core/src/ports/work-recording.ts';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { openBindingFixture, publishReadyArtifact, BINDING_NOW as NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { RECORDING_MESSAGE, RECORDING_MANIFEST } from '../../helpers/p04-5/recording-fixture.ts';
import { createLocalOwnerPrincipal, createRestrictedPrincipal, scopeAllowlist } from '../../helpers/p02-2/principals.ts';

const owner = createLocalOwnerPrincipal();
function queries(f: Awaited<ReturnType<typeof openBindingFixture>>, session: SqliteStorageSession = f.session, root = f.box.dataRoot) {
  const reads = createSqliteQueryStore(session);
  const stateStore = createSqliteStateStore(session);
  return createQueryService({ projectReads: reads, snapshots: reads, eventReads: reads, stateStore,
    configurationService: createConfigurationService({ stateStore, capabilityCatalog: f.box.capabilityCatalog }),
    planReads: reads, executionBudgetReads: reads, scheduleReads: reads, workspaceReads: reads,
    workSessionReads: reads, taskEvidenceReads: reads, gitOperationReads: reads,
    featureDeliveryReads: reads, executionControlReads: reads,
    artifacts: createSqliteArtifactStore(session), artifactFiles: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    dataRootIdentity: computeDataRootIdentity(root), nowUtcMs: () => NOW });
}
async function fixture() {
  const f = await openBindingFixture();
  try {
    const launch = f.claimAndLaunch('t-1');
    const attempt = launch.receipt.attempt;
    const identity = { projectId: f.projectId, sessionId: 'recording-session', runId: f.runId,
      attemptId: attempt.id, invocationId: launch.invocationId, executionVersion: attempt.executionVersion,
      owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, purpose: 'work' as const };
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const created = sessions.createWorkSession({ sessionId: identity.sessionId, projectId: identity.projectId,
      attemptId: identity.attemptId, owner: identity.owner, hostInstanceId: identity.hostInstanceId,
      executionVersion: identity.executionVersion, purpose: 'execution', runtime: 'fake', adapterVersion: '1' });
    const locator = 'sessions/recording-session/messages/1.json';
    const ref = { ...await publishReadyArtifact(f, { kind: 'session-recording', locator, content: '{"public":"body"}' }), locator };
    const { owner: _owner, hostInstanceId: _host, purpose: _purpose, ...recordIdentity } = identity;
    const message = { ...RECORDING_MESSAGE, ...recordIdentity, contentRef: ref, createdAtUtcMs: NOW,
      updatedAtUtcMs: NOW, occurredAtUtcMs: NOW, recordedAtUtcMs: NOW };
    const manifest = { ...RECORDING_MANIFEST, ...recordIdentity, manifestRef: ref, watermark: 1,
      createdAtUtcMs: NOW, updatedAtUtcMs: NOW };
    const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
    const input = { identity, expectedSessionRevision: created.session.revision, expectedManifestRevision: 0,
      messages: [message], manifest };
    store.commitRecording(input);
    return { ...f, identity, message, manifest, ref, store, input };
  } catch (error) { f.close(); throw error; }
}

it('[case:recording-page] reads a bounded public recording page by Run, Attempt and Session', async () => {
  const f = await fixture();
  try {
    const q = queries(f);
    for (const parent of [{ runId: f.runId }, { attemptId: f.identity.attemptId }, { sessionId: f.identity.sessionId }]) {
      const page = await q.listWorkRecording(owner, { projectId: f.projectId, ...parent, recordType: 'messages', limit: 1 });
      expect(page).toMatchObject({ scope: 'work-recording', recordType: 'messages', limit: 1, nextCursor: null,
        records: [{ id: f.message.id, sessionId: f.identity.sessionId, sequence: 1,
          source: 'live', contentRef: { artifactId: f.ref.artifactId, contentHash: f.ref.contentHash, sizeBytes: f.ref.sizeBytes } }] });
      expect(page.records[0]).not.toHaveProperty('contentRef.locator');
    }
  } finally { f.close(); }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
function append(f: Fixture, messages: readonly WorkRecordingMessageRecord[], overrides: Partial<WorkRecordingManifestRecord> = {}) {
  const latest = f.store.getLatestManifest(f.projectId, f.identity.sessionId)!;
  const revision = f.session.database.prepare('SELECT revision FROM sessions WHERE id = ?').get(f.identity.sessionId) as { revision: number };
  return f.store.commitRecording({ ...f.input, expectedSessionRevision: revision.revision,
    expectedManifestRevision: latest.revision, messages, manifest: { ...f.manifest,
      id: `manifest-${latest.version + 1}`, version: latest.version + 1, revision: latest.version + 1,
      watermark: Math.max(latest.watermark ?? 0, ...messages.map(m => m.sequence)), ...overrides } });
}
function corruptIndex(f: Fixture, trigger: string, mutate: () => void) {
  // Simulate damaged on-disk metadata. Restore the real guard before querying;
  // normal production writes remain immutable and are covered by storage tests.
  const guard = f.session.database.prepare('SELECT sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?').get(trigger) as { sql: string };
  f.session.database.exec(`DROP TRIGGER ${trigger}`);
  try { mutate(); } finally { f.session.database.exec(guard.sql); }
}
function snapshot(session: SqliteStorageSession) {
  const tables = session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: session.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
}
const listInput = (f: Fixture, recordType = 'messages') => ({ projectId: f.projectId, runId: f.runId, recordType });
const bodyInput = (f: Fixture, artifactId = f.ref.artifactId) => ({ projectId: f.projectId, sessionId: f.identity.sessionId, artifactId });

it('[case:stable-pagination] orders all public kinds and immutable manifests with exclusive bounded cursors', async () => {
  const f = await fixture();
  try {
    const kinds = ['tool_started', 'tool_finished', 'error', 'final_result'] as const;
    const messages = kinds.map((kind, i) => ({ ...f.message, id: `message-${i + 2}`, sequence: i + 2,
      eventId: `event-${i + 2}`, messageKey: `key-${i + 2}`, kind, role: kind === 'error' ? 'error' as const : kind === 'final_result' ? 'result' as const : 'tool' as const,
      toolCallId: kind.startsWith('tool') ? 'child' : null, parentToolCallId: kind.startsWith('tool') ? 'parent' : null }));
    append(f, messages);
    const q = queries(f);
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await q.listWorkRecording(owner, { ...listInput(f), limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.records.length).toBeLessThanOrEqual(2);
      seen.push(...page.records.map(r => 'kind' in r ? r.kind : null));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(['message', ...kinds]);
    const first = await q.listWorkRecording(owner, { ...listInput(f, 'manifests'), limit: 1 });
    expect(first.records[0]).toMatchObject({ version: 1, coverage: 'partial', watermark: 1 });
    const second = await q.listWorkRecording(owner, { ...listInput(f, 'manifests'), cursor: first.nextCursor, limit: 1 });
    expect(second).toMatchObject({ records: [{ version: 2, watermark: 5 }], nextCursor: null });
    const defaults = await q.listWorkRecording(owner, listInput(f));
    expect(defaults.limit).toBe(50);
  } finally { f.close(); }
});

it('[case:cursor-boundaries] rejects invalid limits, parent shapes and cursor reuse across scope, record type, root or project', async () => {
  const f = await fixture();
  try {
    append(f, [{ ...f.message, id: 'message-2', sequence: 2, eventId: 'event-2', messageKey: 'key-2' }]);
    const q = queries(f);
    const first = await q.listWorkRecording(owner, { ...listInput(f), limit: 1 });
    expect(first.nextCursor).toBeTypeOf('string');
    for (const input of [
      { projectId: f.projectId, attemptId: f.identity.attemptId, recordType: 'messages' },
      { ...listInput(f), runId: 'other-run' }, { ...listInput(f), recordType: 'manifests' },
      { ...listInput(f), projectId: randomUUID() },
    ]) {
      await expect(q.listWorkRecording(owner, { ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    }
    await expect(queries(f, f.session, `${f.box.dataRoot}-other`).listWorkRecording(owner, { ...listInput(f), cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    for (const limit of [0, -1, 201, 1.5, '1', Infinity, NaN]) {
      await expect(q.listWorkRecording(owner, { ...listInput(f), limit })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const input of [{ ...listInput(f), cursor: 'invalid' }, { ...listInput(f), sessionId: f.identity.sessionId },
      { projectId: f.projectId, recordType: 'messages' }, { ...listInput(f), path: '/private/file' },
      { ...listInput(f), recordType: 'native' }]) {
      await expect(q.listWorkRecording(owner, input)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  } finally { f.close(); }
});

it('[case:authorization] denies missing capability and visibility before storage access and folds foreign parents into not_found', async () => {
  const f = await fixture();
  try {
    const q = queries(f);
    const noRead = createRestrictedPrincipal({ capabilities: [], projectScope: { kind: 'all' } });
    const foreignScope = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: scopeAllowlist([randomUUID()]) });
    const before = snapshot(f.session);
    for (const principal of [noRead, foreignScope]) {
      await expect(q.listWorkRecording(principal, listInput(f))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(q.readWorkRecordingBody(principal, bodyInput(f))).rejects.toMatchObject({ code: 'forbidden' });
    }
    for (const parent of [{ runId: f.runId }, { attemptId: f.identity.attemptId }, { sessionId: f.identity.sessionId }]) {
      await expect(q.listWorkRecording(owner, { projectId: randomUUID(), ...parent, recordType: 'messages' })).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(q.readWorkRecordingBody(owner, { ...bodyInput(f), projectId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
    expect(snapshot(f.session)).toEqual(before);
    f.session.close();
    // A closed store proves authorization does not first touch SQLite.
    await expect(q.listWorkRecording(noRead, listInput(f))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(q.readWorkRecordingBody(foreignScope, bodyInput(f))).rejects.toMatchObject({ code: 'forbidden' });
  } finally { f.close(); }
});

it('[case:public-projection] preserves sources, gaps and tool links while excluding native paths, provider identities and free text', async () => {
  const f = await fixture();
  try {
    append(f, [
      { ...f.message, id: 'parent-message', eventId: 'parent-event', messageKey: 'parent-key', sequence: 2,
        kind: 'tool_started', role: 'tool', toolCallId: '/private/native-parent', providerMessageId: 'secret-provider-token', sourceRefs: ['/private/native-history'] },
      { ...f.message, id: 'child-message', eventId: 'child-event', messageKey: 'child-key', sequence: 3,
        kind: 'tool_finished', role: 'tool', toolCallId: 'child', parentToolCallId: '/private/native-parent', source: 'recovered' },
    ], { source: 'mixed', missingReasons: ['sequence_gap', '/private/credential-file'], diagnostics: ['secret provider error', 'token_secret_123'],
      nativeRef: { schemaVersion: 1, storageKind: 'jsonl', formatVersion: '1' } });
    const q = queries(f);
    const messages = await q.listWorkRecording(owner, listInput(f));
    const parent = messages.records[1];
    const child = messages.records[2];
    expect(parent).toHaveProperty('toolCallId');
    expect(child).toMatchObject({ parentToolCallId: 'toolCallId' in parent ? parent.toolCallId : undefined,
      source: 'recovered', watermark: 3, coverage: 'partial', missingReasons: ['sequence_gap', 'recording_detail_redacted'] });
    const manifests = await q.listWorkRecording(owner, listInput(f, 'manifests'));
    expect(manifests.records[1]).toMatchObject({ source: 'mixed', diagnostics: ['recording_detail_redacted', 'recording_detail_redacted'] });
    const serialized = JSON.stringify([messages, manifests]);
    for (const secret of ['/private/', 'secret-provider-token', 'nativeRef', 'providerMessageId', 'sourceRefs', 'locator', 'secret provider error', 'token_secret_123']) {
      expect(serialized).not.toContain(secret);
    }
  } finally { f.close(); }
});

it('[case:body-membership] only indexed same-project ready bodies, attachments and manifests belong to the target', async () => {
  const f = await fixture();
  try {
    const locator = 'sessions/recording-session/attachment.json';
    const attachment = { ...await publishReadyArtifact(f, { kind: 'attachment', locator, content: 'attachment' }), locator,
      name: 'stdout', mediaType: 'text/plain', truncated: false, redacted: false };
    const manifestLocator = 'sessions/recording-session/manifest.json';
    const manifestRef = { ...await publishReadyArtifact(f, { kind: 'manifest', locator: manifestLocator, content: '{"coverage":"partial"}' }), locator: manifestLocator };
    append(f, [{ ...f.message, id: 'message-2', sequence: 2, eventId: 'event-2', messageKey: 'key-2', attachments: [attachment] }], { manifestRef });
    const q = queries(f);
    for (const [artifactId, expected] of [[f.ref.artifactId, '{"public":"body"}'], [attachment.artifactId, 'attachment'], [manifestRef.artifactId, '{"coverage":"partial"}']]) {
      for (const parent of [{ sessionId: f.identity.sessionId }, { attemptId: f.identity.attemptId }]) {
        const body = await q.readWorkRecordingBody(owner, { projectId: f.projectId, ...parent, artifactId });
        expect(Buffer.from(body.content).toString()).toBe(expected);
        expect(body.artifact.artifactId).toBe(artifactId);
        expect(body).not.toHaveProperty('artifact.locator');
      }
    }
    const unindexed = await publishReadyArtifact(f, { kind: 'session-recording', locator: 'sessions/recording-session/unindexed', content: 'not public' });
    await expect(q.readWorkRecordingBody(owner, bodyInput(f, unindexed.artifactId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(q.readWorkRecordingBody(owner, { ...bodyInput(f), sessionId: 'other-session' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(q.readWorkRecordingBody(owner, { ...bodyInput(f), path: f.ref.locator })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(q.readWorkRecordingBody(owner, { projectId: f.projectId, runId: f.runId, artifactId: f.ref.artifactId })).rejects.toMatchObject({ code: 'invalid_input' });
    corruptIndex(f, 'recording_artifact_identity_guard', () => {
      f.session.database.prepare("UPDATE artifacts SET status = 'pending', content_hash = NULL, size_bytes = NULL WHERE id = ?").run(f.ref.artifactId);
    });
    await expect(q.readWorkRecordingBody(owner, bodyInput(f))).rejects.toMatchObject({ code: 'not_found' });
  } finally { f.close(); }
});

it('[case:body-integrity] distinguishes missing, damaged and mismatched referenced bodies without writing repair state', async () => {
  const f = await fixture();
  try {
    const q = queries(f);
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const placement = files.resolvePlacement({ projectId: f.projectId, artifactId: f.ref.artifactId, locator: f.ref.locator });
    const path = join(f.box.dataRoot, placement.finalRelativePath);
    const before = snapshot(f.session);
    writeFileSync(path, 'x'.repeat(f.ref.sizeBytes));
    await expect(q.readWorkRecordingBody(owner, bodyInput(f))).rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_corrupt' } });
    writeFileSync(path, 'short');
    await expect(q.readWorkRecordingBody(owner, bodyInput(f))).rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_corrupt' } });
    unlinkSync(path);
    await expect(q.readWorkRecordingBody(owner, bodyInput(f))).rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_missing' } });
    expect(snapshot(f.session)).toEqual(before);
    corruptIndex(f, 'session_messages_immutable', () => {
      f.session.database.prepare('UPDATE session_messages SET content_hash = ? WHERE id = ?').run('ef'.repeat(32), f.message.id);
    });
    await expect(q.readWorkRecordingBody(owner, bodyInput(f))).rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_reference_mismatch' } });
  } finally { f.close(); }
});

it('[case:bounded-body] refuses indexed bodies larger than the existing bounded verifier limit', async () => {
  const f = await fixture();
  try {
    const locator = 'sessions/recording-session/large';
    const bytes = Buffer.alloc(WORK_SESSION_EVIDENCE_MAX_READ_BYTES + 1, 'x');
    const publisher = createArtifactPublisher({ artifacts: f.artifacts, files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
      limits: { maxSizeBytes: bytes.length, timeoutMs: 60_000 } });
    const published = await publisher.publishArtifact({ projectId: f.projectId, kind: 'session-recording', locator,
      mediaType: 'text/plain', expectedHash: createHash('sha256').update(bytes).digest('hex'), content: [bytes] });
    const ref = { artifactId: published.artifact.id, contentHash: published.artifact.contentHash!, sizeBytes: bytes.length, locator };
    append(f, [{ ...f.message, id: 'large-message', sequence: 2, eventId: 'large-event', messageKey: 'large-key', contentRef: ref }]);
    const before = snapshot(f.session);
    await expect(queries(f).readWorkRecordingBody(owner, bodyInput(f, ref.artifactId)))
      .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_size_limit' } });
    expect(snapshot(f.session)).toEqual(before);
  } finally { f.close(); }
});

it('[case:work-descendants] includes Work children with parent links, excludes Chat edges and does not borrow sibling membership', async () => {
  const f = await fixture();
  try {
    const db = f.session.database;
    for (const [id, kind, purpose] of [['child', 'work', 'subtask'], ['sibling', 'work', 'subtask'], ['chat-child', 'chat', 'chat'], ['wrong-purpose', 'work', 'chat']]) {
      db.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, parent_session_id, kind, purpose,
        runtime, adapter_version, input_ref, last_activity_at) SELECT ?, ?, ?, project_id, id, ?, ?,
        runtime, adapter_version, input_ref, ? FROM sessions WHERE id = ?`).run(id, NOW, NOW, kind, purpose, NOW, f.identity.sessionId);
    }
    const locator = 'sessions/child/messages/1.json';
    const ref = { ...await publishReadyArtifact(f, { kind: 'session-recording', locator, content: 'child body' }), locator };
    f.store.commitRecording({ ...f.input, identity: { ...f.identity, sessionId: 'child' },
      messages: [{ ...f.message, id: 'child-message', eventId: 'child-event', messageKey: 'child-key', sessionId: 'child', contentRef: ref }],
      manifest: { ...f.manifest, id: 'child-manifest', sessionId: 'child', manifestRef: ref } });
    const q = queries(f);
    const byRun = await q.listWorkRecording(owner, listInput(f));
    expect(byRun.records).toHaveLength(2);
    expect(byRun.records.find(r => r.sessionId === 'child')).toMatchObject({ parentSessionId: f.identity.sessionId });
    const child = await q.listWorkRecording(owner, { projectId: f.projectId, sessionId: 'child', recordType: 'messages' });
    expect(child.records).toHaveLength(1);
    expect(Buffer.from((await q.readWorkRecordingBody(owner, { ...bodyInput(f, ref.artifactId), sessionId: 'child' })).content).toString()).toBe('child body');
    await expect(q.readWorkRecordingBody(owner, { ...bodyInput(f, ref.artifactId), sessionId: 'sibling' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(q.readWorkRecordingBody(owner, bodyInput(f, ref.artifactId))).rejects.toMatchObject({ code: 'not_found' });
    expect((await q.readWorkRecordingBody(owner, { projectId: f.projectId, attemptId: f.identity.attemptId, artifactId: ref.artifactId })).artifact.artifactId).toBe(ref.artifactId);
    for (const sessionId of ['chat-child', 'wrong-purpose']) {
      await expect(q.listWorkRecording(owner, { projectId: f.projectId, sessionId, recordType: 'messages' })).rejects.toMatchObject({ code: 'not_found' });
    }
  } finally { f.close(); }
});

it('[case:missing-manifest] retains an explicit partial gap when the public message index has no manifest', async () => {
  const f = await fixture();
  try {
    f.session.database.prepare('DELETE FROM recording_manifests WHERE session_id = ?').run(f.identity.sessionId);
    const before = snapshot(f.session);
    const q = queries(f);
    expect((await q.listWorkRecording(owner, listInput(f))).records[0]).toMatchObject({ watermark: null,
      coverage: 'partial', missingReasons: ['recording_manifest_missing'] });
    expect((await q.listWorkRecording(owner, listInput(f, 'manifests'))).records).toEqual([]);
    expect((await q.readWorkRecordingBody(owner, bodyInput(f))).artifact.artifactId).toBe(f.ref.artifactId);
    expect(snapshot(f.session)).toEqual(before);
  } finally { f.close(); }
});

it('[case:corrupt-membership] fails closed on persisted execution identity mismatches without leaking or repairing data', async () => {
  const f = await fixture();
  try {
    corruptIndex(f, 'session_messages_immutable', () => {
      f.session.database.prepare('UPDATE session_messages SET invocation_id = ? WHERE id = ?').run('foreign-invocation', f.message.id);
    });
    const before = snapshot(f.session);
    const q = queries(f);
    await expect(q.listWorkRecording(owner, listInput(f))).rejects.toMatchObject({ code: 'corrupt_state' });
    await expect(q.readWorkRecordingBody(owner, bodyInput(f))).rejects.toMatchObject({ code: 'corrupt_state' });
    expect(snapshot(f.session)).toEqual(before);
  } finally { f.close(); }
});

it('[case:readonly-reopen] all queries leave the entire SQLite snapshot unchanged and remain identical after closing and reopening storage', async () => {
  const f = await fixture();
  try {
    append(f, [{ ...f.message, id: 'message-2', sequence: 2, eventId: 'event-2', messageKey: 'key-2', source: 'recovered' }]);
    const q = queries(f);
    const before = snapshot(f.session);
    const page = await q.listWorkRecording(owner, { ...listInput(f), limit: 1 });
    const tail = await q.listWorkRecording(owner, { ...listInput(f), limit: 1, cursor: page.nextCursor });
    const manifests = await q.listWorkRecording(owner, listInput(f, 'manifests'));
    const body = await q.readWorkRecordingBody(owner, bodyInput(f));
    expect(snapshot(f.session)).toEqual(before);
    const dbPath = f.session.path;
    f.session.close();
    const reopened = openSqliteStorageSession({ path: dbPath });
    try {
      const requery = queries(f, reopened);
      const reopenedBefore = snapshot(reopened);
      expect(await requery.listWorkRecording(owner, { ...listInput(f), limit: 1 })).toEqual(page);
      expect(await requery.listWorkRecording(owner, { ...listInput(f), limit: 1, cursor: page.nextCursor })).toEqual(tail);
      expect(await requery.listWorkRecording(owner, listInput(f, 'manifests'))).toEqual(manifests);
      expect(await requery.readWorkRecordingBody(owner, bodyInput(f))).toEqual(body);
      expect(snapshot(reopened)).toEqual(reopenedBefore);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
