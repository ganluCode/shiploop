import { StorageError } from '../../ports/errors.js';
import type { WorkRecordingReadStore, WorkRecordingTarget, WorkRecordingQueryRow } from '../../ports/work-recording-query.js';
import { messageFromRow, manifestFromRow } from './work-recording-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

type Row = Record<string, string | number | null>;
const operation = 'WorkSessionQueryStore.recording';

/** Reused by WorkSessionQueryReadStore. No writers, native archive access or SDK loading. */
export function createSqliteWorkRecordingReads(session: SqliteStorageSession): WorkRecordingReadStore {
  const db = session.database;
  function read<T>(fn: () => T): T {
    return db.inTransaction ? fn() : transactSqliteConsistentRead(session, operation, fn);
  }
  function tree(projectId: string, target: WorkRecordingTarget) {
    // Descendants inherit only their Work root's Attempt. A Chat edge or a child
    // declaring another Attempt cannot borrow a parent's recording membership.
    const filter = target.kind === 'run' ? 'AND a.run_id = ?' : target.kind === 'attempt' ? 'AND a.id = ?' : '';
    return { sql: `WITH RECURSIVE work_tree(id, parent_session_id, attempt_id, run_id, invocation_id, execution_version) AS (
      SELECT s.id, s.parent_session_id, a.id, a.run_id, a.invocation_id, a.execution_version
        FROM sessions s JOIN attempts a ON a.session_id = s.id AND s.attempt_id = a.id AND s.project_id = a.project_id
        WHERE s.project_id = ? AND s.kind = 'work' AND s.purpose <> 'chat' ${filter}
      UNION
      SELECT s.id, s.parent_session_id, t.attempt_id, t.run_id, t.invocation_id, t.execution_version
        FROM sessions s JOIN work_tree t ON s.parent_session_id = t.id
        WHERE s.project_id = ? AND s.kind = 'work' AND s.purpose <> 'chat' AND s.attempt_id IS NULL
    )`, params: [projectId, ...(target.kind === 'session' ? [] : [target.id]), projectId] };
  }
  function exists(projectId: string, target: WorkRecordingTarget): boolean {
    if (target.kind !== 'session') {
      const table = target.kind === 'run' ? 'runs' : 'attempts';
      return db.prepare(`SELECT id FROM ${table} WHERE project_id = ? AND id = ?`).get(projectId, target.id) !== undefined;
    }
    const cte = tree(projectId, target);
    return db.prepare(`${cte.sql} SELECT id FROM work_tree WHERE id = ?`).get(...cte.params, target.id) !== undefined;
  }
  function select(projectId: string, target: WorkRecordingTarget, table: string) {
    const cte = tree(projectId, target);
    return { sql: `${cte.sql} SELECT r.*, t.parent_session_id, t.attempt_id AS trusted_attempt,
      t.run_id AS trusted_run, t.invocation_id AS trusted_invocation, t.execution_version AS trusted_version
      FROM ${table} r JOIN work_tree t ON t.id = r.session_id WHERE r.project_id = ?
      ${target.kind === 'session' ? 'AND t.id = ?' : ''}`,
    params: [...cte.params, projectId, ...(target.kind === 'session' ? [target.id] : [])] };
  }
  function decode(row: Row, manifests: boolean) {
    const record = manifests ? manifestFromRow(row) : messageFromRow(row);
    if (record.attemptId !== row.trusted_attempt || record.runId !== row.trusted_run
      || record.invocationId !== row.trusted_invocation || record.executionVersion !== row.trusted_version) {
      throw new StorageError('corrupt', operation, 'Recording execution membership mismatch');
    }
    return record;
  }
  return {
    listWorkRecordingRows(projectId, target, recordType, request) {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200
        || (request.after !== null && (!Number.isSafeInteger(request.after.sort) || request.after.sort < 0))) {
        throw new TypeError('Invalid bounded recording page');
      }
      return read(() => {
        if (!exists(projectId, target)) return undefined;
        const manifests = recordType === 'manifests';
        const selection = select(projectId, target, manifests ? 'recording_manifests' : 'session_messages');
        const sort = manifests ? 'version' : 'sequence';
        const rows = db.prepare<unknown[], Row>(`${selection.sql}
          AND (r.${sort} > ? OR (r.${sort} = ? AND r.id > ?)) ORDER BY r.${sort}, r.id LIMIT ?`)
          .all(...selection.params, request.after?.sort ?? -1, request.after?.sort ?? -1, request.after?.id ?? '', request.limit + 1);
        const records: WorkRecordingQueryRow[] = rows.slice(0, request.limit).map(row => {
          const record = decode(row, manifests);
          const latest = manifests ? null : db.prepare<[string, string], Row>(`SELECT * FROM recording_manifests
            WHERE project_id = ? AND session_id = ? ORDER BY version DESC LIMIT 1`).get(projectId, record.sessionId);
          const manifest = manifests ? record as ReturnType<typeof manifestFromRow> : latest ? manifestFromRow(latest) : null;
          if (manifest && (manifest.attemptId !== record.attemptId || manifest.runId !== record.runId
            || manifest.invocationId !== record.invocationId || manifest.executionVersion !== record.executionVersion)) {
            throw new StorageError('corrupt', operation, 'Recording manifest membership mismatch');
          }
          return { record, manifest, parentSessionId: row.parent_session_id as string | null };
        });
        const last = rows[Math.min(rows.length, request.limit) - 1];
        return { records, nextKey: rows.length > request.limit ? { sort: Number(last[sort]), id: String(last.id) } : null };
      });
    },
    readWorkRecordingArtifactRef(projectId, target, artifactId) {
      return read(() => {
        if (!exists(projectId, target)) return undefined;
        const messages = select(projectId, target, 'session_messages');
        const message = db.prepare<unknown[], Row>(`${messages.sql} AND (r.content_ref = ? OR EXISTS
          (SELECT 1 FROM json_each(r.attachment_refs) a WHERE json_extract(a.value, '$.artifactId') = ?)) LIMIT 1`)
          .get(...messages.params, artifactId, artifactId);
        if (message) {
          const record = decode(message, false) as ReturnType<typeof messageFromRow>;
          return record.contentRef.artifactId === artifactId ? record.contentRef : record.attachments.find(ref => ref.artifactId === artifactId);
        }
        const manifests = select(projectId, target, 'recording_manifests');
        const manifest = db.prepare<unknown[], Row>(`${manifests.sql} AND r.manifest_ref = ? LIMIT 1`).get(...manifests.params, artifactId);
        return manifest ? (decode(manifest, true) as ReturnType<typeof manifestFromRow>).manifestRef ?? undefined : undefined;
      });
    },
  };
}
