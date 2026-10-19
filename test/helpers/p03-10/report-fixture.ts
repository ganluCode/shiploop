import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BudgetFixture } from '../p03-3/budget-fixture.ts';
import { NOW } from '../p03-3/budget-fixture.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import type { AttemptStatus } from '../../../packages/core/src/ports/attempt-store.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';

export const HASH = 'ab'.repeat(32);
export function reportDatabaseSnapshot(f: BudgetFixture) {
  const tables = f.session.database.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, f.session.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
export function reportArtifact(f: BudgetFixture, id: string, locator = `inputs/${id}`, body?: unknown, kind = 'execution-input') {
  const bytes = Buffer.from(body === undefined ? 'input body' : JSON.stringify(body));
  const hash = createHash('sha256').update(bytes).digest('hex');
  f.session.database.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status,
    media_type, expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, ?, 'ready', 'application/json', ?, ?, ?, ?)`)
    .run(id, NOW, NOW, f.projectId, kind, hash, hash, bytes.length, locator);
  const path = join(f.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId: id }));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { artifactId: id, version: 1, contentHash: hash, sizeBytes: bytes.length, locator, mediaType: 'application/json' };
}
export function reportSecondRun(f: BudgetFixture, runId: string) {
  const db = f.session.database;
  db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
  const row = db.prepare<[string], Record<string, string | number | null>>('SELECT * FROM runs WHERE id = ?').get(runId)!;
  const next = { ...row, id: 'run-2', dispatch_ordinal: 2, status: 'succeeded', created_at: NOW + 1,
    started_at: NOW, ended_at: NOW + 200, reason: null };
  db.prepare(`INSERT INTO runs (${Object.keys(next).join(',')}) VALUES (${Object.keys(next).map(() => '?').join(',')})`).run(...Object.values(next));
  return next.id;
}
export function reportAttempt(f: BudgetFixture, options: {
  id: string; runId: string; taskId?: string; number?: number; status?: AttemptStatus;
  session?: boolean; start?: number; end?: number | null; previousAttemptId?: string; failureEvidenceId?: string;
}) {
  const { id, runId, taskId = 't-1', number = 1, status = 'failed', session = true, start = NOW, end = NOW + 100 } = options;
  const snapshot = reportArtifact(f, `${id}-input`);
  const manifest = reportArtifact(f, `${id}-manifest`);
  const prompt = reportArtifact(f, `${id}-prompt`);
  const rework = options.previousAttemptId === undefined ? undefined : {
    attemptId: id, previousAttemptId: options.previousAttemptId, previousTaskId: taskId,
    scene: { worktreeId: 'wt-report', headCommit: 'b'.repeat(40), codeDigest: HASH },
    failureEvidenceRefs: [{ ...snapshot, artifactId: options.failureEvidenceId ?? snapshot.artifactId, projectId: f.projectId, kind: 'execution-input', purpose: 'failure', origin: { kind: 'artifact' } }],
    recovery: { selection: { mode: 'new' }, decision: { mode: 'new', reasons: ['explicit_new'] } },
  };
  const input = { schemaVersion: rework === undefined ? 1 : 2, projectId: f.projectId, featureId: f.featureId, taskId,
    group: { snapshot, manifest, prompt }, requiredInputs: [],
    digests: { snapshotDigest: HASH, manifestDigest: HASH, promptDigest: HASH, strategyCopyDigest: HASH, permissionsDigest: HASH },
    approval: { planDigest: HASH, checkPolicyDigest: HASH, decisionId: null, featureRevision: 1 },
    taskRevision: 1, promptBytes: 10, tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' }, preparedAtUtcMs: NOW,
    ...(rework === undefined ? {} : { rework }) };
  const sessionId = session ? `${id}-session` : null;
  f.session.database.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
    number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref,
    status, execution_stage, started_at, ended_at, duration_ms, exit_code, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner-report', 'host-report', ?, ?, ?, ?, ?, ?, 'runtime', ?, ?, ?, ?, ?)`)
    .run(id, NOW, NOW, f.projectId, f.featureId, runId, taskId, number, number, NOW + 1000, JSON.stringify(input), HASH,
      snapshot.artifactId, status, session ? start : null, session ? end : null, session && end !== null ? end - start : null, session ? 1 : null, sessionId);
  if (session) f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, attempt_id,
    kind, purpose, runtime, adapter_version, status, execution_stage, input_ref, last_activity_at, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, 'work', 'coding', 'fake', '1', ?, 'runtime', ?, ?, ?, ?)` )
    .run(sessionId, NOW, NOW, f.projectId, id, end === null ? 'started' : 'ended', snapshot.artifactId, end ?? start, start, end);
  return { id, runId, taskId, sessionId, snapshot };
}
export function reportSettlement(f: BudgetFixture, attempt: ReturnType<typeof reportAttempt>, overrides: Record<string, unknown> = {}) {
  const body = { schemaVersion: 1, kind: 'runtime-settlement', identity: { projectId: f.projectId, attemptId: attempt.id,
    taskId: attempt.taskId, runId: attempt.runId, sessionId: attempt.sessionId, executionVersion: 1,
    owner: 'owner-report', hostInstanceId: 'host-report' },
    execution: { result: { schemaVersion: 1, terminal: 'failed', reason: 'process', exitCode: 17, signal: 'SIGTERM', durationMs: 75,
      usage: { basis: 'synthetic', inputTokens: 23, outputTokens: null, costUsdMicros: null }, lastEventSequence: 3 }, failure: null },
    recording: { complete: false, manifestRef: null, failure: null, gaps: ['historical_tail_missing'], watermark: 3 },
    stop: { evidence: null, failure: null }, ...overrides };
  const ref = reportArtifact(f, `${attempt.id}-result`, `sessions/${attempt.sessionId}/runtime-settlement.json`, body, 'runtime-settlement');
  f.session.database.prepare('UPDATE sessions SET result_ref = ? WHERE id = ?').run(ref.artifactId, attempt.sessionId);
  return ref;
}
export function reportVerification(f: BudgetFixture, attempt: ReturnType<typeof reportAttempt>, id: string, operation = 'FeatureVerification.full') {
  f.session.database.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run(attempt.taskId);
  const store = createSqliteVerificationStore(f.session, { nowUtcMs: () => NOW });
  store.createVerificationBatch({ batchId: id, projectId: f.projectId, featureId: f.featureId,
    runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id, executionVersion: 1, operation,
    codeDigest: HASH, policyDigest: HASH, environmentSummary: {},
    checkSnapshot: [{ checkKey: 'tests', scope: 'project', kind: 'command', argv: ['node', 'check.mjs'], cwdRef: null,
      environmentRef: null, timeout: 1000, required: true, requirementRefs: ['T38'] }],
    selection: { schemaVersion: 1, mode: 'full_fallback', reason: 'report fixture', selectedCheckKeys: ['tests'] }, startedAtUtcMs: NOW });
  store.saveCheckResult({ resultId: `${id}-check`, projectId: f.projectId, batchId: id, checkKey: 'tests', status: 'failed',
    exitCode: null, signal: 'SIGTERM', timedOut: false, outputArtifactId: null, outputTail: null, startedAtUtcMs: NOW, endedAtUtcMs: NOW + 20 });
  store.finalizeVerificationBatch({ projectId: f.projectId, batchId: id, expectedRevision: 1, status: 'failed', endedAtUtcMs: NOW + 20 });
}
export function reportOperation(f: BudgetFixture, runId: string) {
  const db = f.session.database;
  const binding = db.prepare<[string], { id: string; repo_identity: string }>('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?').get(f.projectId)!;
  const feature = db.prepare<[string], { revision: number }>('SELECT revision FROM features WHERE id = ?').get(f.featureId)!;
  return createSqliteGitOperationStore(f.session, { nowUtcMs: () => NOW }).registerGitOperation({
    operationId: 'op-report', projectId: f.projectId, featureId: f.featureId, runId, attemptId: null, executionVersion: 1,
    operationType: 'feature_final_commit', repositoryBindingId: binding.id, repoIdentity: binding.repo_identity,
    worktreePath: f.box.repoDirA, expectedHead: f.box.gitHead('A'), candidateTree: 'b'.repeat(40), codeDigest: HASH,
    verificationRefs: [{ kind: 'verification_batch', id: 'verify-final', digest: HASH }],
    approvalRefs: [], message: 'report fixture', gitIdentity: { name: 'Report', email: 'report@example.test', confirmed: true },
    deliveryPolicyDigest: HASH, runtimeSource: null, ownerId: 'owner-report', hostInstanceId: 'host-report', expectedFeatureRevision: feature.revision,
  });
}
