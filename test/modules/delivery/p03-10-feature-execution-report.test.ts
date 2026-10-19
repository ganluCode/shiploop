import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { buildFeatureExecutionReport } from '../../../packages/core/src/application/feature-execution-report.ts';
import { createSqliteFeatureExecutionReportStore } from '../../../packages/core/src/adapters/sqlite/feature-execution-report-store.ts';
import { createSqliteFeatureDeliveryQueryStore } from '../../../packages/core/src/adapters/sqlite/feature-delivery-query-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { afterEach, expect, test } from 'vitest';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import { reportAttempt, reportSettlement, reportSecondRun, reportDatabaseSnapshot, reportVerification, reportOperation, reportArtifact, HASH } from '../../helpers/p03-10/report-fixture.ts';
import { openBudgetFixture, BUDGET, NOW, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const fixtures: BudgetFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function fixture() {
  const f = await openBudgetFixture(BUDGET, [1, 2, 3].map(n => ({
    id: `t-${n}`, title: `Task ${n}`, acceptance: { criteria: ['report completeness'] }, dependsOn: [],
  })));
  fixtures.push(f);
  return f;
}
function queries(f: BudgetFixture) {
  const store = createSqliteQueryStore(f.session);
  const stateStore = createSqliteStateStore(f.session);
  return createQueryService({
    projectReads: store, snapshots: store, eventReads: store, stateStore,
    configurationService: createConfigurationService({ stateStore, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) }),
    planReads: store, executionBudgetReads: store, scheduleReads: store, workspaceReads: store,
    workSessionReads: store, taskEvidenceReads: store, gitOperationReads: store,
    featureDeliveryReads: store, featureReportReads: store, executionControlReads: store,
    artifacts: createSqliteArtifactStore(f.session), artifactFiles: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    dataRootIdentity: computeDataRootIdentity(f.box.dataRoot), nowUtcMs: () => NOW,
  });
}

test('[case:all-tasks-read-only] complete report preserves all Tasks and independent completion axes without writes', async () => {
  const f = await fixture();
  const before = reportDatabaseSnapshot(f);
  const q = queries(f);
  const input = { projectId: f.projectId, featureId: f.featureId };
  const report = await q.getFeatureReport(f.owner, input);
  expect(report.tasks.map(t => t.current.taskId)).toEqual(['t-1', 't-2', 't-3']);
  expect(report.tasks.every(t => t.attempts.length === 0)).toBe(true);
  expect(report.axes.tasks.total).toBe(3);
  expect(report.outcome.status).not.toBe('completed');
  expect(await q.getFeatureReport(f.owner, input)).toEqual(report);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
  f.session.database.prepare("UPDATE tasks SET status = 'passed'").run();
  const passed = await queries(f).getFeatureReport(f.owner, input);
  expect(passed.axes.tasks.allPassed).toBe(true);
  expect(passed.outcome.status).not.toBe('completed');
});

test('[case:history-evidence-timing] cross-Run histories, overlapping Sessions, operations and partial metrics stay independent', async () => {
  const f = await fixture();
  const firstRun = (await f.start()).runId!;
  const run2 = reportSecondRun(f, firstRun);
  const first = reportAttempt(f, { id: 'a-1', runId: firstRun });
  reportSettlement(f, first);
  reportAttempt(f, { id: 'a-2', runId: run2, number: 2, status: 'succeeded', previousAttemptId: first.id });
  reportAttempt(f, { id: 'a-cancel', taskId: 't-2', runId: firstRun, status: 'cancelled', session: false });
  reportAttempt(f, { id: 'a-interrupted', taskId: 't-3', runId: run2, status: 'interrupted' });
  f.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-1'").run();
  f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, parent_session_id,
    kind, purpose, runtime, adapter_version, status, execution_stage, input_ref, last_activity_at, started_at, ended_at)
    VALUES ('child-session', ?, ?, ?, ?, 'work', 'review', 'fake', '1', 'ended', 'runtime', ?, ?, ?, ?)`)
    .run(NOW, NOW, f.projectId, first.sessionId, first.snapshot.artifactId, NOW + 100, NOW + 20, NOW + 100);
  reportVerification(f, first, 'verify-final');
  reportOperation(f, run2);
  for (let n = 0; n < 130; n++) f.session.database.prepare(`INSERT INTO task_approval_items (id, created_at, updated_at, project_id, feature_id, task_id,
    kind, description, responsible_party, plan_digest, artifact_refs, created_by)
    VALUES (?, ?, ?, ?, ?, 't-2', 'block', ?, 'owner', ?, '[]', 'owner')`)
    .run(`approval-${String(n).padStart(3, '0')}`, NOW, NOW, f.projectId, f.featureId, `needs decision ${n}`, HASH);
  for (let n = 0; n < 35; n++) f.session.database.prepare(`INSERT INTO attempt_notification_diagnostics
    (id, project_id, attempt_id, notification_digest, reason, occurred_at)
    VALUES (?, ?, ?, ?, 'stale_execution_identity', ?)`)
    .run(`diag-${String(n).padStart(3, '0')}`, f.projectId, first.id, n.toString(16).padStart(64, '0'), NOW);
  const before = reportDatabaseSnapshot(f);
  const report = await queries(f).getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  expect(report.counts).toEqual({ tasks: 3, runs: 2, attempts: 4, sessions: 4, operations: 1 });
  const task = report.tasks.find(t => t.current.taskId === 't-1')!;
  expect(task.current.status).toBe('passed');
  expect(task.latestAttempt?.id).toBe('a-2');
  expect(task.cumulative).toMatchObject({ attempts: 2, reworks: 1, byStatus: { failed: 1, succeeded: 1 } });
  expect(task.attempts[0]).toMatchObject({ executionStage: 'runtime', exitCode: 1, signal: 'SIGTERM', durationMs: 100,
    runtimeDurationMs: 75, usage: { basis: 'synthetic', inputTokens: 23, outputTokens: null, costMicros: null, cacheReadTokens: null },
    sessionIds: ['a-1-session', 'child-session'], completeness: 'partial' });
  // SQLite bounds persisted notification diagnostics to 32 per Attempt.
  expect(task.attempts[0].diagnostics).toHaveLength(32);
  expect(report.tasks[1].cumulative.byStatus.cancelled).toBe(1);
  expect(report.tasks[1].attempts[0]).toMatchObject({ sessionId: null, completeness: 'partial', signal: null,
    usage: { inputTokens: null, outputTokens: null, costMicros: null } });
  expect(report.tasks[2].cumulative.byStatus.interrupted).toBe(1);
  expect(report.verifications).toHaveLength(1);
  expect(report.verifications[0].checks[0]).toMatchObject({ signal: 'SIGTERM', exitCode: null });
  expect(report.axes.approval.items).toHaveLength(130);
  expect(report.operations[0]).toMatchObject({ operationId: 'op-report', status: 'pending' });
  expect(report.outcome.status).not.toBe('completed');
  expect(report.timing).toMatchObject({ cumulativeSessionMs: 380, wallClockMs: 100, totalSessions: 4 });
  expect(report.evidence.filter(e => e.artifactId === first.snapshot.artifactId)).toHaveLength(1);
  expect(await queries(f).getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId })).toEqual(report);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:pages-and-missing] exhausts keyset pages and retains missing or foreign evidence', async () => {
  const f = await fixture();
  const runId = (await f.start()).runId!;
  for (let n = 1; n <= 130; n++) reportAttempt(f, { id: `page-${String(n).padStart(3, '0')}`, runId, number: n, session: false,
    ...(n === 2 ? { previousAttemptId: 'page-001', failureEvidenceId: 'lost-evidence' } : {}) });
  const bad = reportAttempt(f, { id: 'bad-evidence', taskId: 't-2', runId });
  reportAttempt(f, { id: 'open-session', taskId: 't-3', runId, status: 'interrupted', end: null });
  reportSettlement(f, bad, { identity: { projectId: f.projectId, attemptId: 'page-001' } });
  const before = reportDatabaseSnapshot(f);
  const q = queries(f);
  const input = { projectId: f.projectId, featureId: f.featureId };
  const report = await q.getFeatureReport(f.owner, input);
  expect(report.counts.attempts).toBe(132);
  expect(report.tasks[0].cumulative.attempts).toBe(130);
  expect(report.tasks[0].latestAttempt?.id).toBe('page-130');
  expect(report.tasks[0].attempts[1].evidence).toContainEqual({ artifactId: 'lost-evidence', availability: 'missing', artifact: null });
  expect(report.tasks[1].attempts[0].issues).toContain('result_evidence_invalid');
  expect(report.tasks[1].attempts[0].resultEvidence).toBeNull();
  expect(report.completeness).toBe('partial');
  expect(report.timing.wallClockMs).toBeNull();
  expect(report.timing.cumulativeSessionMs).toBe(100);
  expect(report.timing.completeness).toBe('partial');
  expect(await q.getFeatureReport(f.owner, input)).toEqual(report);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:snapshot-and-dedup] WAL writer cannot mix facts into a paged snapshot; repeated association IDs count once', async () => {
  const f = await fixture();
  const runId = (await f.start()).runId!;
  reportAttempt(f, { id: 'a-original', runId });
  reportOperation(f, runId);
  const writer = openSqliteStorageSession({ path: f.box.dbPath });
  try {
    const base = createSqliteFeatureDeliveryQueryStore(f.session);
    const store = createSqliteFeatureExecutionReportStore(f.session, {
      readFeatureDeliveryView(projectId, featureId) {
        const captured = base.readFeatureDeliveryView(projectId, featureId);
        const row = writer.database.prepare<[], Record<string, string | number | null>>('SELECT * FROM attempts').get()!;
        const added = { ...row, id: 'a-concurrent', number: 2, execution_version: 2, session_id: null };
        writer.database.prepare(`INSERT INTO attempts (${Object.keys(added).join(',')}) VALUES (${Object.keys(added).map(() => '?').join(',')})`).run(...Object.values(added));
        writer.database.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
        return captured;
      },
    });
    const captured = store.readFeatureExecutionReportView(f.projectId, f.featureId)!;
    expect(captured.attempts.map(a => a.attempt.id)).toEqual(['a-original']);
    expect(captured.runs[0].status).toBe('queued');
    const next = createSqliteFeatureExecutionReportStore(f.session).readFeatureExecutionReportView(f.projectId, f.featureId)!;
    expect(next.attempts).toHaveLength(2);
    expect(next.runs[0].status).toBe('failed');
    const duplicated = { ...captured,
      delivery: { ...captured.delivery, tasks: [...captured.delivery.tasks, ...captured.delivery.tasks] },
      attempts: [...captured.attempts, ...captured.attempts], sessions: [...captured.sessions, ...captured.sessions],
      runs: [...captured.runs, ...captured.runs], operations: [...captured.operations, ...captured.operations],
      artifacts: [...captured.artifacts, ...captured.artifacts], artifactIds: [...captured.artifactIds, ...captured.artifactIds] };
    expect(buildFeatureExecutionReport(duplicated)).toEqual(buildFeatureExecutionReport(captured));
  } finally { writer.close(); }
});

test('[case:report-authorization] report requires project.read and folds missing/cross-project targets', async () => {
  const f = await fixture();
  const q = queries(f);
  const input = { projectId: f.projectId, featureId: f.featureId };
  const before = reportDatabaseSnapshot(f);
  const noRead = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: { kind: 'all' } });
  const hidden = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } });
  await expect(q.getFeatureReport(noRead, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(q.getFeatureReport(hidden, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(q.getFeatureReport(f.owner, { ...input, featureId: 'missing-feature' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(q.getFeatureReport(f.owner, { ...input, projectId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
  await expect(q.getFeatureReport(f.owner, { ...input, principalId: 'local-owner' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:artifact-integrity] corrupt and absent bodies remain partial records; launch rejection needs no Session', async () => {
  const f = await fixture();
  const runId = (await f.start()).runId!;
  const corrupted = reportAttempt(f, { id: 'corrupt-result', runId });
  const absent = reportAttempt(f, { id: 'absent-result', runId, taskId: 't-2' });
  const corruptRef = reportSettlement(f, corrupted);
  const absentRef = reportSettlement(f, absent);
  const path = (artifactId: string) => join(f.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId }));
  writeFileSync(path(corruptRef.artifactId), 'corrupt body');
  unlinkSync(path(absentRef.artifactId));
  const rejected = reportAttempt(f, { id: 'not-started', runId, taskId: 't-3', status: 'cancelled', session: false });
  reportArtifact(f, 'launch-rejected', `attempts/${rejected.id}/launch-rejection.json`, {
    schemaVersion: 1, kind: 'runtime-not-started',
    identity: { projectId: f.projectId, attemptId: rejected.id, executionVersion: 1, owner: 'owner-report', hostInstanceId: 'host-report' },
    taskId: rejected.taskId, runId, failure: { kind: 'permission', reason: 'launch_rejected' },
    recording: { complete: false, gaps: ['runtime_not_started'] },
  }, 'runtime-settlement');
  const before = reportDatabaseSnapshot(f);
  const report = await queries(f).getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  expect(report.counts.attempts).toBe(3);
  for (const task of report.tasks.slice(0, 2)) {
    expect(task.attempts[0].issues).toContain('result_evidence_invalid');
    expect(task.attempts[0].completeness).toBe('partial');
    expect(task.attempts[0].runtimeDurationMs).toBeNull();
  }
  expect(report.tasks[2].attempts[0]).toMatchObject({ sessionId: null, completeness: 'partial',
    resultEvidence: { kind: 'runtime-not-started', failure: { reason: 'launch_rejected' } } });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});
