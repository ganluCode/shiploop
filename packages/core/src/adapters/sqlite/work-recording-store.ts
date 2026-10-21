import { createHash, randomUUID } from 'node:crypto';
import { StorageError } from '../../ports/errors.js';
import { ACTIVE_ATTEMPT_STATUSES } from '../../ports/attempt-store.js';
import { validateWorkResourceIdentity } from '../../ports/work-resources.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from '../../ports/validation.js';
import { assertWorkRecordingIdentity, validateWorkRecordingManifest, validateWorkRecordingMessage,
  WORK_RECORDING_MAX_DIAGNOSTICS, WORK_RECORDING_MAX_MISSING_REASONS } from '../../ports/work-recording.js';
import type { WorkRecordingArtifactRef, WorkRecordingManifestRecord, WorkRecordingMessageRecord } from '../../ports/work-recording.js';
import { WORK_RECORDING_MAX_BATCH_MESSAGES } from '../../ports/work-recording-store.js';
import type { WorkRecordingCommitInput, WorkRecordingStore, WorkRecordingWriteIdentity } from '../../ports/work-recording-store.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';

const context = { operation: 'WorkRecordingStore.commit' };
type Row = Record<string, string | number | null>;
const common = { id: 'id', createdAtUtcMs: 'created_at', updatedAtUtcMs: 'updated_at', revision: 'revision',
  projectId: 'project_id', sessionId: 'session_id', runId: 'run_id', attemptId: 'attempt_id',
  invocationId: 'invocation_id', executionVersion: 'execution_version' };
const messageColumns = { ...common, sequence: 'sequence', eventId: 'event_id', messageKey: 'message_key',
  kind: 'kind', role: 'role', providerMessageId: 'provider_message_id', toolCallId: 'tool_call_id',
  parentToolCallId: 'parent_tool_call_id', source: 'source', sourceRefs: 'source_refs', attachments: 'attachment_refs',
  occurredAtUtcMs: 'occurred_at', recordedAtUtcMs: 'recorded_at', truncated: 'truncated', redacted: 'redacted' };
const manifestColumns = { ...common, version: 'version', watermark: 'watermark', finalSequence: 'final_sequence',
  sequenceReconciliation: 'sequence_reconciliation', coverage: 'coverage', source: 'source', scope: 'scope',
  missingReasons: 'missing_reasons', diagnostics: 'diagnostics', truncation: 'truncation', redaction: 'redaction',
  sdkVersion: 'sdk_version', formatVersion: 'format_version', nativeRef: 'native_ref',
  unknownEventCount: 'unknown_event_count', finalized: 'finalized' };
const jsonFields = new Set(['sourceRefs', 'attachments', 'scope', 'missingReasons', 'diagnostics', 'truncation', 'redaction', 'nativeRef']);
const boolFields = new Set(['truncated', 'redacted', 'finalized']);

function encode(record: object, columns: Record<string, string>): Row {
  const values = record as Record<string, unknown>;
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => [column,
    values[key] === null ? null : jsonFields.has(key) ? JSON.stringify(values[key])
      : boolFields.has(key) ? Number(values[key]) : values[key]])) as Row;
}
function decode(row: Row, columns: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => [key,
    row[column] === null ? null : jsonFields.has(key) ? JSON.parse(row[column] as string)
      : boolFields.has(key) ? row[column] === 1 : row[column]]));
}
function refColumns(ref: WorkRecordingArtifactRef | null, prefix: 'content' | 'manifest'): Row {
  return { [`${prefix}_ref`]: ref?.artifactId ?? null, [`${prefix}_hash`]: ref?.contentHash ?? null,
    [`${prefix}_size_bytes`]: ref?.sizeBytes ?? null, [`${prefix}_locator`]: ref?.locator ?? null };
}
function refFromRow(row: Row, prefix: 'content' | 'manifest'): unknown {
  return row[`${prefix}_ref`] === null ? null : { artifactId: row[`${prefix}_ref`], contentHash: row[`${prefix}_hash`],
    sizeBytes: row[`${prefix}_size_bytes`], locator: row[`${prefix}_locator`] };
}
function messageFromRow(row: Row): WorkRecordingMessageRecord {
  try { return validateWorkRecordingMessage({ ...decode(row, messageColumns), contentRef: refFromRow(row, 'content') }); }
  catch { throw new StorageError('corrupt', context.operation, 'Invalid stored recording message'); }
}
function manifestFromRow(row: Row): WorkRecordingManifestRecord {
  try { return validateWorkRecordingManifest({ ...decode(row, manifestColumns), manifestRef: refFromRow(row, 'manifest') }); }
  catch { throw new StorageError('corrupt', context.operation, 'Invalid stored recording manifest'); }
}
function fail(message: string): never { throw new StorageError('conflict', context.operation, message); }
function integer(value: unknown, min: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw validationError(context, 'revision', 'Invalid revision');
  return Number(value);
}
function parseInput(value: unknown): WorkRecordingCommitInput {
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['identity', 'expectedSessionRevision', 'expectedManifestRevision', 'messages', 'manifest'], context, 'input');
  const identity = requirePlainObject(raw.identity, context, 'identity');
  const { sessionId, runId, invocationId, purpose, ...resource } = identity;
  if (purpose !== 'work') throw validationError(context, 'purpose', 'Recording requires Work purpose');
  const trusted: WorkRecordingWriteIdentity = { ...validateWorkResourceIdentity(resource),
    sessionId: validateStableId(sessionId, context, 'sessionId'), runId: validateStableId(runId, context, 'runId'),
    invocationId: validateStableId(invocationId, context, 'invocationId'), purpose };
  if (!Array.isArray(raw.messages) || raw.messages.length > WORK_RECORDING_MAX_BATCH_MESSAGES) {
    throw validationError(context, 'messages', 'Recording batch exceeds bounded message count');
  }
  const messages = raw.messages.map(message => validateWorkRecordingMessage(message));
  const manifest = validateWorkRecordingManifest(raw.manifest);
  for (const record of [...messages, manifest]) assertWorkRecordingIdentity(record, trusted);
  return { identity: trusted, messages, manifest,
    expectedSessionRevision: integer(raw.expectedSessionRevision, 1),
    expectedManifestRevision: integer(raw.expectedManifestRevision, 0) };
}

/** Semantic identity excludes delivery timestamps, row IDs and observation source. */
function messageDigest(message: WorkRecordingMessageRecord): string {
  const { id: _id, createdAtUtcMs: _created, updatedAtUtcMs: _updated, revision: _revision,
    recordedAtUtcMs: _recorded, source: _source, sourceRefs: _refs, ...content } = message;
  // Artifact publication can assign a new ID/locator to identical bytes during replay.
  const body = { contentHash: content.contentRef.contentHash, sizeBytes: content.contentRef.sizeBytes };
  const attachments = content.attachments.map(({ artifactId: _artifact, locator: _locator, ...attachment }) => attachment);
  return createHash('sha256').update(JSON.stringify({ ...content, contentRef: body, attachments })).digest('hex');
}

export function createSqliteWorkRecordingStore(
  session: SqliteStorageSession, options: { readonly nowUtcMs?: () => number } = {},
): WorkRecordingStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  function latest(sessionId: string): WorkRecordingManifestRecord | null {
    const row = db.prepare<[string], Row>('SELECT * FROM recording_manifests WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(sessionId);
    return row ? manifestFromRow(row) : null;
  }
  function insert(table: 'session_messages' | 'recording_manifests', row: Row): void {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  function checkRef(ref: WorkRecordingArtifactRef | null, projectId: string): void {
    if (ref === null) return;
    const row = db.prepare<[string], Row>('SELECT project_id, status, expected_hash, content_hash, size_bytes, storage_locator FROM artifacts WHERE id = ?').get(ref.artifactId);
    if (!row || row.project_id !== projectId || row.status !== 'ready' || row.expected_hash !== ref.contentHash
      || row.content_hash !== ref.contentHash || row.size_bytes !== ref.sizeBytes || row.storage_locator !== ref.locator) {
      fail('Recording Artifact is not ready or its content identity differs');
    }
  }
  function fence(identity: WorkRecordingWriteIdentity): Row {
    const row = db.prepare<[string, string, string, string], Row>(`WITH RECURSIVE ancestry(id, parent_session_id, attempt_id) AS (
      SELECT id, parent_session_id, attempt_id FROM sessions WHERE id = ? AND project_id = ? AND kind = 'work' AND purpose <> 'chat'
      UNION
      SELECT s.id, s.parent_session_id, s.attempt_id FROM sessions s JOIN ancestry c ON s.id = c.parent_session_id
        WHERE s.project_id = ? AND s.kind = 'work' AND s.purpose <> 'chat' AND c.attempt_id IS NULL
    ) SELECT a.*, t.execution_version AS task_version FROM ancestry s
      JOIN attempts a ON a.id = s.attempt_id AND a.session_id = s.id
      JOIN tasks t ON t.id = a.task_id AND t.project_id = a.project_id
      WHERE a.id = ?`).get(identity.sessionId, identity.projectId, identity.projectId, identity.attemptId);
    if (!row || row.project_id !== identity.projectId || row.run_id !== identity.runId
      || row.invocation_id !== identity.invocationId || row.execution_version !== identity.executionVersion
      || row.task_version !== identity.executionVersion || row.owner_id !== identity.owner
      || row.host_instance_id !== identity.hostInstanceId || !(ACTIVE_ATTEMPT_STATUSES as readonly unknown[]).includes(row.status)) {
      fail('Stale or mismatched Work recording execution identity');
    }
    const target = db.prepare<[string], Row>('SELECT revision, recording_watermark, recording_gaps, status FROM sessions WHERE id = ?').get(identity.sessionId)!;
    if (target.status === 'stopped') fail('Stopped Work session cannot accept recording writes');
    return target;
  }
  return {
    getLatestManifest(projectId, sessionId) {
      validateStableId(projectId, context, 'projectId');
      validateStableId(sessionId, context, 'sessionId');
      return transactSqliteConsistentRead(session, context.operation, () => {
        const row = db.prepare<[string], Row>('SELECT project_id, kind FROM sessions WHERE id = ?').get(sessionId);
        if (!row) throw new StorageError('not_found', context.operation, 'Work session not found');
        if (row.project_id !== projectId || row.kind !== 'work') throw new StorageError('ownership', context.operation, 'Work recording scope mismatch');
        return latest(sessionId);
      });
    },
    commitRecording(raw) {
      const input = parseInput(raw);
      return session.transactWrite(context.operation, () => {
        const { identity, manifest } = input;
        const target = fence(identity);
        const current = latest(identity.sessionId);
        const fresh: WorkRecordingMessageRecord[] = [];
        let conflict = false;
        for (const message of input.messages) {
          const rows = db.prepare<[string, string, string, string, number, string], Row>(`SELECT * FROM session_messages
            WHERE id = ? OR (project_id = ? AND event_id = ?) OR (session_id = ? AND (sequence = ? OR message_key = ?))`)
            .all(message.id, identity.projectId, message.eventId, identity.sessionId, message.sequence, message.messageKey);
          const pending = fresh.filter(other => other.id === message.id || other.eventId === message.eventId
            || other.sequence === message.sequence || other.messageKey === message.messageKey);
          // Tool start/finish are separate stable identities; conflicting phases cannot silently become new messages.
          if (message.toolCallId !== null && ['tool_started', 'tool_finished'].includes(message.kind)) {
            rows.push(...db.prepare<[string, string, string], Row>(`SELECT * FROM session_messages
              WHERE session_id = ? AND tool_call_id = ? AND kind = ?`).all(identity.sessionId, message.toolCallId, message.kind));
            pending.push(...fresh.filter(other => other.toolCallId === message.toolCallId && other.kind === message.kind));
          }
          const matches = [...rows.map(messageFromRow), ...pending];
          if (matches.some(other => messageDigest(other) !== messageDigest(message))) conflict = true;
          else if (matches.length === 0) fresh.push(message);
        }
        // Exact retry is safe without replaying a prior Session CAS or any metering.
        const priorRow = db.prepare<[string, string], Row>('SELECT * FROM recording_manifests WHERE project_id = ? AND id = ?').get(identity.projectId, manifest.id);
        if (!conflict && fresh.length === 0 && priorRow && JSON.stringify(manifestFromRow(priorRow)) === JSON.stringify(manifest)) {
          return { status: 'duplicate', inserted: 0, manifest: current!, sessionRevision: Number(target.revision) };
        }
        if (target.revision !== input.expectedSessionRevision || (current?.revision ?? 0) !== input.expectedManifestRevision) {
          fail('Recording Session or manifest revision CAS conflict');
        }
        if (manifest.version !== input.expectedManifestRevision + 1 || manifest.revision !== manifest.version) {
          fail('Recording manifest version/revision CAS conflict');
        }
        const timestamp = now();
        let next = manifest;
        if (conflict) {
          const base = current ?? manifest;
          const diagnostic = 'stable_identity_content_conflict';
          next = validateWorkRecordingManifest({ ...base, id: randomUUID(), revision: manifest.revision, version: manifest.version,
            createdAtUtcMs: timestamp, updatedAtUtcMs: timestamp, manifestRef: null,
            watermark: current?.watermark ?? target.recording_watermark, finalSequence: base.finalSequence,
            sequenceReconciliation: 'not_available', coverage: 'partial', finalized: false,
            diagnostics: [...new Set([diagnostic, ...base.diagnostics])].slice(0, WORK_RECORDING_MAX_DIAGNOSTICS),
            missingReasons: [...new Set([diagnostic, ...base.missingReasons])].slice(0, WORK_RECORDING_MAX_MISSING_REASONS) });
        } else {
          checkRef(manifest.manifestRef, identity.projectId);
          for (const message of fresh) {
            checkRef(message.contentRef, identity.projectId);
            for (const attachment of message.attachments) checkRef(attachment, identity.projectId);
            insert('session_messages', { ...encode(message, messageColumns), ...refColumns(message.contentRef, 'content') });
          }
        }
        const floor = Math.max(Number(current?.watermark ?? 0), Number(target.recording_watermark ?? 0));
        if ((current?.watermark != null || target.recording_watermark !== null)
          && (next.watermark === null || next.watermark < floor)) {
          fail('Recording durable watermark cannot regress');
        }
        if (next.watermark !== null && next.watermark > 0) {
          const count = db.prepare<[string, number], { n: number }>('SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ? AND sequence <= ?')
            .get(identity.sessionId, next.watermark)!.n;
          if (count < next.watermark && (next.coverage === 'complete' || !next.missingReasons.includes('sequence_gap'))) {
            fail('Recording watermark has undeclared sequence gaps');
          }
        }
        insert('recording_manifests', { ...encode(next, manifestColumns), ...refColumns(next.manifestRef, 'manifest') });
        const changed = db.prepare(`UPDATE sessions SET revision = revision + 1, updated_at = ?, recording_watermark = ?, recording_gaps = ?
          WHERE id = ? AND project_id = ? AND revision = ?`).run(timestamp, next.watermark, JSON.stringify(next.missingReasons),
          identity.sessionId, identity.projectId, input.expectedSessionRevision);
        if (changed.changes !== 1) fail('Recording Session revision CAS conflict');
        return { status: conflict ? 'conflict' : 'applied', inserted: conflict ? 0 : fresh.length,
          manifest: next, sessionRevision: input.expectedSessionRevision + 1 };
      });
    },
  };
}
