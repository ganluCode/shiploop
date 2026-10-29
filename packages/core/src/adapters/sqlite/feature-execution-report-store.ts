import { featureReportAttemptArtifactIds, type FeatureExecutionReportReadStore, type FeatureExecutionReportView } from '../../ports/feature-execution-report.js';
import type { FeatureDeliveryQueryReadStore, FeatureDeliveryRunRow } from '../../ports/feature-delivery-query.js';
import type { WorkSessionQueryReadStore } from '../../ports/work-session-query.js';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import { taskApprovalItemFromRow, type TaskApprovalItemSqlRow } from './plan-store.js';
import { validateAttemptNotificationDiagnosticRecord } from '../../ports/execution-schedule-query.js';
import { createSqliteFeatureDeliveryQueryStore } from './feature-delivery-query-store.js';
import { createSqliteWorkSessionQueryStore } from './work-session-query-store.js';
import { artifactFromRow, type ArtifactRow } from './artifact-store.js';
import { GIT_OPERATION_COLUMNS, gitOperationRecordFromRow, type GitOperationRow } from './git-operations.js';
import { SESSION_COLUMNS, workSessionRecordFromRow, type SessionRow } from './work-session-store.js';
import { VERIFICATION_BATCH_COLUMNS, CHECK_RESULT_COLUMNS, verificationBatchRecordFromRow,
  checkResultRecordFromRow, type VerificationBatchRow, type CheckResultRow } from './verification-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { parseStoredRunLabels } from './run-labels.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'FeatureExecutionReport.read';
const PAGE_SIZE = 128;

/** Bounded keyset pages are drained synchronously inside ONE read transaction.
 * No joins to multi-valued evidence/approval associations can multiply Attempts.
 */
export function createSqliteFeatureExecutionReportStore(
  session: SqliteStorageSession,
  delivery: FeatureDeliveryQueryReadStore = createSqliteFeatureDeliveryQueryStore(session),
  work: WorkSessionQueryReadStore = createSqliteWorkSessionQueryStore(session),
): FeatureExecutionReportReadStore {
  const db = session.database;
  function pages<T extends { id: string }>(sql: string, projectId: string, featureId: string): T[] {
    const rows: T[] = [];
    let after = '';
    for (;;) {
      const page = db.prepare<[string, string, string, number], T>(sql).all(projectId, featureId, after, PAGE_SIZE);
      rows.push(...page);
      if (page.length < PAGE_SIZE) return rows;
      after = page[page.length - 1].id;
    }
  }
  return {
    readFeatureExecutionReportView(project, feature) {
      const projectId = validateStableId(project, { operation: OPERATION }, 'projectId');
      const featureId = validateStableId(feature, { operation: OPERATION }, 'featureId');
      if (!session.isOpen()) throw new StorageError('corrupt', OPERATION, 'Storage session is closed');
      const assemble = (): FeatureExecutionReportView | undefined => {
        const base = delivery.readFeatureDeliveryView(projectId, featureId);
        if (base === undefined) return undefined;
        const approvalItems = pages<TaskApprovalItemSqlRow>(
          'SELECT * FROM task_approval_items WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?',
          projectId, featureId).map(taskApprovalItemFromRow);
        const axes = { ...base, approvalItems, approvalItemsTruncated: false };
        const eventWatermark = db.prepare<[string], { value: number }>(
          'SELECT COALESCE(MAX(sequence), 0) AS value FROM state_events WHERE project_id = ?').get(projectId)!.value;
        const ids = pages<{ id: string }>(
          'SELECT id FROM attempts WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?', projectId, featureId);
        const attempts = ids.map(({ id }) => {
          const detail = work.readWorkSessionDetail(projectId, id);
          if (detail === undefined) throw new StorageError('corrupt', OPERATION, 'Attempt vanished inside snapshot');
          const diagnostics = db.prepare<[string, string], { id: string; project_id: string; attempt_id: string;
            notification_digest: string; reason: string; occurred_at: number }>(
            'SELECT * FROM attempt_notification_diagnostics WHERE project_id = ? AND attempt_id = ? ORDER BY id').all(projectId, id)
            .map(row => validateAttemptNotificationDiagnosticRecord({ id: row.id, projectId: row.project_id,
              attemptId: row.attempt_id, notificationDigest: row.notification_digest, reason: row.reason, occurredAtUtcMs: row.occurred_at }));
          const prefixes = [`attempts/${id}/`, ...(detail.session === null ? [] : [`sessions/${detail.session.id}/`])];
          const evidence = db.prepare<unknown[], ArtifactRow>(`SELECT * FROM artifacts WHERE project_id = ? AND (
            ${prefixes.map(() => 'substr(storage_locator, 1, length(?)) = ?').join(' OR ')}) ORDER BY id`)
            .all(projectId, ...prefixes.flatMap(p => [p, p])).map(row => artifactFromRow(row, { operation: OPERATION }));
          return { ...detail, evidence, evidenceTruncated: false, diagnostics, diagnosticsTruncated: false };
        });
        const runs = pages<{ id: string; batch_id: string; labels: string; status: FeatureDeliveryRunRow['status']; reason: string | null;
          started_at: number | null; ended_at: number | null }>(
          'SELECT id, batch_id, labels, status, reason, started_at, ended_at FROM runs WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?',
          projectId, featureId).map(r => ({ id: r.id, batchId: r.batch_id, status: r.status, reason: r.reason,
          startedAtUtcMs: r.started_at, endedAtUtcMs: r.ended_at, labels: parseStoredRunLabels(r.labels, OPERATION) }));
        const verifications = pages<VerificationBatchRow>(
          `SELECT ${VERIFICATION_BATCH_COLUMNS} FROM verification_batches WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?`,
          projectId, featureId).map(row => ({ batch: verificationBatchRecordFromRow(row), checks: db
            .prepare<[string, string], CheckResultRow>(`SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE project_id = ? AND batch_id = ? ORDER BY id`)
            .all(projectId, row.id).map(checkResultRecordFromRow) }));
        const operations = pages<GitOperationRow>(
          `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?`,
          projectId, featureId).map(row => gitOperationRecordFromRow(row, OPERATION));
        const sessionRows = db.prepare<[string, string], SessionRow & { root_attempt_id: string }>(`
          WITH RECURSIVE tree(id, root_attempt_id) AS (
            SELECT s.id, a.id FROM sessions s JOIN attempts a ON a.id = s.attempt_id AND a.project_id = s.project_id
              WHERE a.project_id = ? AND a.feature_id = ? AND s.kind = 'work'
            UNION
            SELECT s.id, tree.root_attempt_id FROM sessions s JOIN tree ON s.parent_session_id = tree.id WHERE s.kind = 'work'
          ) SELECT ${SESSION_COLUMNS.split(',').map(c => `s.${c.trim()}`).join(',')}, tree.root_attempt_id
            FROM sessions s JOIN tree ON tree.id = s.id ORDER BY s.id`).all(projectId, featureId);
        const sessions = sessionRows.map(row => ({ attemptId: row.root_attempt_id, session: workSessionRecordFromRow(row) }));
        // Include direct references even when old evidence lacks the modern locator prefix.
        const refs = new Set<string>();
        for (const { attempt, evidence } of attempts) {
          for (const ref of featureReportAttemptArtifactIds(attempt)) refs.add(ref);
          for (const artifact of evidence) refs.add(artifact.id);
        }
        for (const { session: s } of sessions) {
          refs.add(s.inputRef);
          if (s.resultRef !== null) refs.add(s.resultRef);
          if (s.parentSessionId !== null) {
            const prefix = `sessions/${s.id}/`;
            for (const row of db.prepare<[string, string, string], { id: string }>(
              'SELECT id FROM artifacts WHERE project_id = ? AND substr(storage_locator, 1, length(?)) = ? ORDER BY id')
              .all(projectId, prefix, prefix)) refs.add(row.id);
          }
        }
        for (const item of approvalItems) for (const ref of [...item.artifactRefs, ...item.decisionArtifactRefs]) refs.add(ref.artifactId);
        for (const v of verifications) for (const c of v.checks) if (c.outputArtifactId !== null) refs.add(c.outputArtifactId);
        const artifacts = [...refs].sort().flatMap(id => {
          const row = db.prepare<[string, string], ArtifactRow>('SELECT * FROM artifacts WHERE project_id = ? AND id = ?').get(projectId, id);
          return row === undefined ? [] : [artifactFromRow(row, { operation: OPERATION })];
        });
        return { delivery: axes, eventWatermark, runs, attempts, sessions, verifications, operations, artifactIds: [...refs].sort(), artifacts };
      };
      return db.inTransaction ? assemble() : transactSqliteConsistentRead(session, OPERATION, assemble);
    },
  };
}
