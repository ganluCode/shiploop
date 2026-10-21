import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteWorkSessionStore } from '../../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { BINDING_NOW as NOW, openBindingFixture, publishReadyArtifact } from '../../../helpers/p03-6/input-binding-fixture.ts';
import { RECORDING_MANIFEST as manifest } from '../../../helpers/p04-5/recording-fixture.ts';

type Row = Record<string, string | number | null>;
function insert(db: Database.Database, table: 'session_messages' | 'recording_manifests' | 'attempts', row: Row): void {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}

async function fixture() {
  const f = await openBindingFixture({ secondTask: true });
  try {
    const first = f.claimAndLaunch('t-1');
    const attempt = first.receipt.attempt;
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    sessions.createWorkSession({ sessionId: 'recording-session', projectId: f.projectId, attemptId: attempt.id,
      owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
      purpose: 'execution', runtime: 'fake', adapterVersion: '1.0-fake' });
    const locator = 'recordings/public.json';
    const ref = { ...await publishReadyArtifact(f, { kind: 'session-recording', locator,
      content: '{"text":"synthetic-public-body-only-in-artifact"}' }), locator };
    const db = f.session.database;
    const identity = { created_at: NOW, updated_at: NOW, revision: 1, project_id: f.projectId,
      session_id: 'recording-session', run_id: f.runId, attempt_id: attempt.id,
      invocation_id: first.invocationId, execution_version: attempt.executionVersion };
    const messageRow: Row = { ...identity, id: 'message-1', sequence: 1, event_id: 'event-1',
      message_key: 'message-1', kind: 'message', role: 'assistant', content_ref: ref.artifactId,
      content_hash: ref.contentHash, content_size_bytes: ref.sizeBytes, content_locator: ref.locator,
      provider_message_id: null, tool_call_id: null, parent_tool_call_id: null,
      source: 'live', source_refs: '[]', attachment_refs: '[]', occurred_at: NOW, recorded_at: NOW,
      truncated: 0, redacted: 0 };
    const manifestRow: Row = { ...identity, id: 'manifest-1', version: 1, manifest_ref: ref.artifactId,
      manifest_hash: ref.contentHash, manifest_size_bytes: ref.sizeBytes, manifest_locator: ref.locator,
      watermark: null, final_sequence: null, sequence_reconciliation: 'not_available', coverage: 'partial', source: 'mixed',
      scope: JSON.stringify(manifest.scope), missing_reasons: '["unknown_events"]', diagnostics: '[]',
      truncation: JSON.stringify(manifest.truncation), redaction: JSON.stringify(manifest.redaction),
      sdk_version: null, format_version: 'work-recording/v1', native_ref: null, unknown_event_count: null, finalized: 0 };
    return { ...f, db, first, ref, sessions, messageRow, manifestRow,
      message: (overrides: Row = {}) => insert(db, 'session_messages', { ...messageRow, ...overrides }),
      manifest: (overrides: Row = {}) => insert(db, 'recording_manifests', { ...manifestRow, ...overrides }),
    };
  } catch (error) { f.close(); throw error; }
}

describe('P04-5 v32 persistent recording indexes', () => {
  it('retains public indexes, nested tool identities, attachment refs and unknowns across reopen without changing business state', async () => {
    const f = await fixture();
    try {
      const before = ['tasks', 'attempts', 'sessions', 'state_events'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
      f.message();
      // Publishing the next Artifact after indexing must keep the existing publisher path usable.
      const locator = 'recordings/next-attachment.json';
      const attachment = { ...await publishReadyArtifact(f, { kind: 'attachment', locator, content: '{"result":"output"}' }),
        locator, mediaType: 'application/json', name: 'output.json', truncated: false, redacted: true };
      f.message({ id: 'message-2', sequence: 2, event_id: 'event-2', message_key: 'message-2', kind: 'tool_finished', role: 'tool',
        tool_call_id: 'child-call', parent_tool_call_id: 'parent-call', source: 'recovered', source_refs: '["native-export-1"]',
        attachment_refs: JSON.stringify([attachment]) });
      f.manifest({ watermark: 2, final_sequence: 2, sequence_reconciliation: 'match', coverage: 'complete',
        missing_reasons: '[]', unknown_event_count: 0, finalized: 1,
        native_ref: '{"schemaVersion":1,"storageKind":"pi","formatVersion":"v1"}' });
      expect(['tasks', 'attempts', 'sessions', 'state_events'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      const publicRows = f.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all();
      expect(publicRows).toHaveLength(2);
      expect(JSON.stringify(publicRows)).not.toContain('synthetic-public-body-only-in-artifact');
      expect(publicRows[1]).toMatchObject({ tool_call_id: 'child-call', parent_tool_call_id: 'parent-call', source: 'recovered' });
      const path = f.session.path;
      f.session.close();
      const reopened = openSqliteStorageSession({ path });
      try {
        expect(reopened.database.prepare('SELECT * FROM session_messages ORDER BY sequence').all()).toEqual(publicRows);
        expect(reopened.database.prepare('SELECT sdk_version, watermark, final_sequence, unknown_event_count, coverage FROM recording_manifests').get())
          .toEqual({ sdk_version: null, watermark: 2, final_sequence: 2, unknown_event_count: 0, coverage: 'complete' });
        expect(reopened.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { reopened.close(); }
    } finally { f.close(); }
  });

  it('deduplicates sequence, event and public message identity for live/recovered replay', async () => {
    const f = await fixture();
    try {
      f.message();
      for (const override of [
        { sequence: 1, event_id: 'event-2', message_key: 'message-2' },
        { sequence: 2, event_id: 'event-1', message_key: 'message-2' },
        { sequence: 2, event_id: 'event-2', message_key: 'message-1' },
      ]) expect(() => f.message({ id: 'replay', source: 'recovered', ...override })).toThrow(/UNIQUE/);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM session_messages').get()).toEqual({ n: 1 });
    } finally { f.close(); }
  });

  it('rejects cross-project, wrong session/attempt/run/invocation/version, and binds unowned child sessions to their Work ancestor', async () => {
    const f = await fixture();
    try {
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('foreign-project', ?, ?, 'Foreign', 'active', '[]')").run(NOW, NOW);
      // Seed an independent, same-project Attempt without acquiring the occupied workspace again.
      const original = f.db.prepare('SELECT * FROM attempts WHERE id = ?').get(f.first.receipt.attempt.id) as Row;
      const snapshot = { ...JSON.parse(original.input_snapshot as string), taskId: 't-2' };
      f.db.prepare("UPDATE tasks SET execution_version = 1 WHERE id = 't-2'").run();
      insert(f.db, 'attempts', { ...original, id: 'other-attempt', task_id: 't-2', session_id: null,
        invocation_id: 'other-invocation', input_snapshot: JSON.stringify(snapshot) });
      f.sessions.createWorkSession({ sessionId: 'other-session', projectId: f.projectId, attemptId: 'other-attempt',
        owner: f.first.receipt.attempt.owner, hostInstanceId: f.first.receipt.attempt.hostInstanceId,
        executionVersion: 1, purpose: 'execution', runtime: 'fake', adapterVersion: '1.0' });
      const badIdentities: Row[] = [
        { project_id: 'foreign-project' }, { session_id: 'other-session' }, { run_id: 'missing-run' },
        { attempt_id: 'other-attempt' }, { invocation_id: 'other-invocation' }, { execution_version: 2 },
      ];
      for (const override of badIdentities) {
        expect(() => f.message(override)).toThrow();
        expect(() => f.manifest(override)).toThrow();
      }
      f.db.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, parent_session_id, kind, purpose,
        runtime, adapter_version, input_ref, last_activity_at) SELECT 'child-session', ?, ?, project_id,
        id, 'work', 'subtask', runtime, adapter_version, input_ref, ? FROM sessions WHERE id = 'recording-session'`).run(NOW, NOW, NOW);
      f.message({ session_id: 'child-session' });
      f.manifest({ session_id: 'child-session' });
      expect(f.db.prepare('SELECT session_id FROM session_messages').get()).toEqual({ session_id: 'child-session' });
    } finally { f.close(); }
  });

  it('requires ready same-project Artifact hashes, sizes and locators for bodies, attachments and manifests', async () => {
    const f = await fixture();
    try {
      f.db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
        expected_hash, storage_locator) VALUES ('pending', ?, ?, ?, 'session-recording', 'pending', 'application/json', ?, 'pending/body')`)
        .run(NOW, NOW, f.projectId, f.ref.contentHash);
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('foreign-project', ?, ?, 'Foreign', 'active', '[]')").run(NOW, NOW);
      f.db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
        expected_hash, content_hash, size_bytes, storage_locator) VALUES ('foreign-artifact', ?, ?, 'foreign-project',
        'session-recording', 'ready', 'application/json', ?, ?, ?, ?)`)
        .run(NOW, NOW, f.ref.contentHash, f.ref.contentHash, f.ref.sizeBytes, f.ref.locator);
      for (const override of [
        { content_ref: 'pending' }, { content_ref: 'missing' }, { content_ref: 'foreign-artifact' },
        { content_hash: 'ef'.repeat(32) }, { content_size_bytes: f.ref.sizeBytes + 1 }, { content_locator: 'other/locator' },
      ] as Row[]) expect(() => f.message(override)).toThrow();
      for (const override of [
        { manifest_ref: 'pending' }, { manifest_ref: 'missing' }, { manifest_ref: 'foreign-artifact' },
        { manifest_hash: 'ef'.repeat(32) }, { manifest_size_bytes: f.ref.sizeBytes + 1 }, { manifest_locator: 'other/locator' },
        { manifest_ref: null },
      ] as Row[]) expect(() => f.manifest(override)).toThrow();
      const attachment = { ...f.ref, mediaType: 'text/plain', name: null, truncated: false, redacted: false };
      for (const override of [{ artifactId: 'pending' }, { artifactId: 'foreign-artifact' },
        { contentHash: 'ef'.repeat(32) }, { sizeBytes: 1 }, { locator: 'other/locator' }]) {
        expect(() => f.message({ attachment_refs: JSON.stringify([{ ...attachment, ...override }]) })).toThrow();
      }
      f.message();
      f.manifest();
    } finally { f.close(); }
  });

  it('rejects unbounded JSON, private fields, illegal enums, unsafe numbers and dishonest completeness', async () => {
    const f = await fixture();
    try {
      const attachment = { ...f.ref, mediaType: 'text/plain', name: null, truncated: false, redacted: false };
      const badMessages: Row[] = [
        { sequence: 0 }, { sequence: 1.5 }, { sequence: 9007199254740992 }, { role: 'private_reasoning' },
        { source: 'private_sqlite' }, { kind: 'tool_started' }, { event_id: 'x'.repeat(257) }, { id: '../invalid-id' },
        { source_refs: '{}' }, { source_refs: JSON.stringify(Array(17).fill('ref')) }, { source_refs: '[123]' },
        { attachment_refs: JSON.stringify([{ ...attachment, privateBody: 'secret' }]) },
        { attachment_refs: JSON.stringify([{ ...attachment, mediaType: 'x'.repeat(129) }]) },
        { attachment_refs: JSON.stringify([{ ...attachment, redacted: 'false' }]) },
        { attachment_refs: JSON.stringify(Array(33).fill(attachment)) },
        { attachment_refs: JSON.stringify(Array(32).fill({ ...attachment, name: '😀'.repeat(200) })) + ' '.repeat(65536) },
      ];
      for (const override of badMessages) expect(() => f.message(override)).toThrow();
      const badManifests: Row[] = [
        { coverage: 'complete' }, { coverage: 'invented' }, { finalized: 2 }, { watermark: -1 }, { version: 1.5 },
        { watermark: 4, final_sequence: 3 }, { coverage: 'failed', missing_reasons: '[]' },
        { missing_reasons: '[1]' }, { missing_reasons: JSON.stringify(Array(33).fill('gap')) },
        { diagnostics: '[]' + ' '.repeat(65536) }, { scope: '{"covers":["hidden_reasoning"],"excludes":[]}' },
        { scope: JSON.stringify({ ...manifest.scope, privateTable: 'sdk.db' }) },
        { truncation: '{"applied":true,"reasons":[]}' }, { redaction: '{"applied":false,"reasons":[],"body":"secret"}' },
        { native_ref: '{"schemaVersion":1,"storageKind":"/private/pi","formatVersion":"v1"}' },
        { native_ref: '{"schemaVersion":1,"storageKind":"pi","formatVersion":"v1","body":"secret"}' },
      ];
      for (const override of badManifests) expect(() => f.manifest(override)).toThrow();
      f.message();
      const complete: Row = { coverage: 'complete', watermark: 1, final_sequence: 1,
        sequence_reconciliation: 'match', missing_reasons: '[]', unknown_event_count: 0, finalized: 1 };
      for (const override of [{ unknown_event_count: null }, { unknown_event_count: 1 }, { watermark: null },
        { final_sequence: null }, { sequence_reconciliation: 'not_available' },
        { truncation: '{"applied":true,"reasons":["limit"]}' }] as Row[]) {
        expect(() => f.manifest({ ...complete, ...override })).toThrow();
      }
      f.manifest(complete);
    } finally { f.close(); }
  });

  it('appends immutable versions with durable monotonic watermarks and explicit gaps', async () => {
    const f = await fixture();
    try {
      f.message();
      f.message({ id: 'message-3', sequence: 3, event_id: 'event-3', message_key: 'message-3' });
      expect(() => f.manifest({ watermark: 2 })).toThrow(/watermark/);
      f.manifest({ watermark: 1 });
      for (const override of [{ version: 1 }, { version: 2, watermark: null }, { version: 2, watermark: 0 }] as Row[]) {
        expect(() => f.manifest({ id: 'manifest-next', ...override })).toThrow();
      }
      expect(() => f.manifest({ id: 'manifest-next', version: 2, watermark: 3, final_sequence: 3,
        coverage: 'complete', missing_reasons: '[]', unknown_event_count: 0, sequence_reconciliation: 'match', finalized: 1 })).toThrow();
      f.manifest({ id: 'manifest-next', version: 2, watermark: 3, final_sequence: 3,
        missing_reasons: '["sequence_gap:2"]', sequence_reconciliation: 'match', finalized: 1 });
      for (const [table, column, value] of [
        ['session_messages', 'invocation_id', 'wrong-invocation'], ['session_messages', 'project_id', 'wrong-project'],
        ['session_messages', 'content_ref', 'missing'], ['recording_manifests', 'watermark', 0],
        ['recording_manifests', 'manifest_ref', 'missing'],
      ] as const) expect(() => f.db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value)).toThrow(/immutable/);
    } finally { f.close(); }
  });

  it('retains referenced attachments and blocks Artifact mutation after indexing', async () => {
    const f = await fixture();
    try {
      const locator = 'recordings/attachment.json';
      const attachment = { ...await publishReadyArtifact(f, { kind: 'attachment', locator, content: '{"data":"attachment"}' }),
        locator, name: null, mediaType: 'application/json', truncated: false, redacted: false };
      f.message({ attachment_refs: JSON.stringify([attachment]) });
      f.manifest();
      expect(() => f.db.prepare('DELETE FROM artifacts WHERE id = ?').run(attachment.artifactId)).toThrow(/referenced/);
      for (const id of [f.ref.artifactId, attachment.artifactId]) {
        for (const [column, value] of [['content_hash', 'ef'.repeat(32)], ['size_bytes', 999], ['storage_locator', 'changed'], ['status', 'pending']] as const) {
          expect(() => f.db.prepare(`UPDATE artifacts SET ${column} = ? WHERE id = ?`).run(value, id)).toThrow(/immutable/);
        }
      }
    } finally { f.close(); }
  });
});

describe('P04-5 v32 migration compatibility', () => {
  it('freezes v1-v31 predecessor checksums and rolls back a failed v32 migration before retry', async () => {
    // Digest taken from the delivered predecessor, not derived from changed descriptors.
    expect(createHash('sha256').update(SQLITE_MIGRATIONS.slice(0, 31).map(m => m.checksum).join('\n')).digest('hex'))
      .toBe('3fa3bc4bcec8771d6f0a9691448f68fe9f695aa5d2f53344d99a82e7722d5615');
    const sandbox = createTempSandbox('shiploop-recording-rollback-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 31) });
      const sql = `${SQLITE_MIGRATIONS[31]!.sql}\nINSERT INTO absent_table VALUES (1);`;
      await expect(migrateSqliteStorage(session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 31),
        { version: 32, sql, checksum: createHash('sha256').update(sql).digest('hex') }] })).rejects.toThrow();
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('session_messages','recording_manifests')").all()).toEqual([]);
      expect(session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 31 });
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([32]);
    } finally { session.close(); sandbox.cleanup(); }
  });

  it.each([0, 20, 31])('upgrades v%s, preserves existing Session/Artifact/state_events and reopens idempotently', async (version) => {
    const sandbox = createTempSandbox('shiploop-recording-upgrade-');
    const path = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path });
    try {
      if (version > 0) {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version) });
        const db = session.database;
        db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('old-project', ?, ?, 'Preserved', 'active', '[]')").run(NOW, NOW);
        db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
          expected_hash, content_hash, size_bytes, storage_locator) VALUES ('old-artifact', ?, ?, 'old-project', 'report', 'ready', 'application/json', ?, ?, 10, 'artifacts/old.json')`)
          .run(NOW, NOW, 'ab'.repeat(32), 'ab'.repeat(32));
        // Preserve a pre-existing Chat session and its P03-6 Work child without assigning a new Attempt.
        db.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, kind, purpose, runtime, adapter_version,
          input_ref, last_activity_at) VALUES ('old-parent', ?, ?, 'old-project', 'chat', 'chat', 'fake', '1', 'old-artifact', ?)`)
          .run(NOW, NOW, NOW);
        db.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, parent_session_id, kind, purpose, runtime,
          adapter_version, input_ref, last_activity_at, recording_watermark, recording_gaps)
          VALUES ('old-work', ?, ?, 'old-project', 'old-parent', 'work', 'execution', 'fake', '1', 'old-artifact', ?, 2, '["legacy_gap"]')`).run(NOW, NOW, NOW);
        db.prepare(`INSERT INTO state_events (id, created_at, updated_at, project_id, sequence, event_type, aggregate_type,
          aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('old-event', ?, ?, 'old-project', 1, 'session.recording',
          'session', 'old-work', 1, '{"schemaVersion":1}', ?)`).run(NOW, NOW, NOW);
      }
      const oldRecords = ['sessions', 'artifacts', 'state_events'].map(table => version > 0 ? session.database.prepare(`SELECT * FROM ${table}`).all() : []);
      const oldMigrations = version > 0 ? session.database.prepare('SELECT * FROM schema_migrations').all() : [];
      const result = await migrateSqliteStorage(session);
      expect(result.toVersion).toBe(32);
      expect(result.appliedVersions).toEqual(Array.from({ length: 32 - version }, (_, i) => version + i + 1));
      expect(session.database.prepare('SELECT * FROM schema_migrations WHERE version <= ?').all(version)).toEqual(oldMigrations);
      expect(['sessions', 'artifacts', 'state_events'].map(table => session.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(oldRecords);
      expect(session.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      session.close();
      const reopened = openSqliteStorageSession({ path });
      try {
        expect((await migrateSqliteStorage(reopened)).appliedVersions).toEqual([]);
        expect(['sessions', 'artifacts', 'state_events'].map(table => reopened.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(oldRecords);
      } finally { reopened.close(); }
    } finally { session.isOpen() && session.close(); sandbox.cleanup(); }
  });
});
