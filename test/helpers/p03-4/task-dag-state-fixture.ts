import type { BudgetFixture } from '../p03-3/budget-fixture.ts';
import { NOW } from '../p03-3/budget-fixture.ts';
import type { PreparedExecutionInputGroup } from '../../../packages/core/src/ports/execution-input-prepare.ts';

/** Trusted persisted Core facts only. No production command can manufacture a pass. */
export function recordVerifiedPass(box: BudgetFixture, ids: { batchId: string; runId: string }, taskId: string,
  overrides: Partial<PreparedExecutionInputGroup> = {}) {
  const db = box.session.database;
  const config = JSON.parse((db.prepare('SELECT config_snapshot FROM execution_batches WHERE id = ?')
    .get(ids.batchId) as { config_snapshot: string }).config_snapshot) as {
      approval: PreparedExecutionInputGroup['approval']; tasks: { taskId: string; digest: string }[];
      permissions: { taskId: string; digest: string }[];
    };
  const hash = 'ab'.repeat(32);
  const ref = (suffix: string) => ({ artifactId: `${taskId}-${suffix}`, version: 1, contentHash: hash,
    sizeBytes: 10, locator: `inputs/${taskId}-${suffix}`, mediaType: 'application/json' });
  const snapshot: PreparedExecutionInputGroup = {
    schemaVersion: 1, projectId: box.projectId, featureId: box.featureId, taskId,
    group: { snapshot: ref('snapshot'), manifest: ref('manifest'), prompt: ref('prompt') }, requiredInputs: [],
    digests: { snapshotDigest: hash, manifestDigest: hash, promptDigest: hash,
      strategyCopyDigest: config.tasks.find(t => t.taskId === taskId)!.digest,
      permissionsDigest: config.permissions.find(t => t.taskId === taskId)!.digest },
    approval: { ...config.approval, featureRevision: 1 }, taskRevision: 1, promptBytes: 10,
    tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' }, preparedAtUtcMs: NOW,
    ...overrides,
  };
  for (const body of [...Object.values(snapshot.group), ref('code')]) {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'execution-input', 'ready', ?, ?, ?, ?, ?)`)
      .run(body.artifactId, NOW, NOW, box.projectId, body.mediaType, hash, hash, body.sizeBytes, body.locator);
  }
  db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
    number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest,
    input_ref, status, execution_stage, started_at, ended_at, duration_ms, exit_code, code_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'owner-1', 'host-1', 1, ?, ?, ?, ?, 'succeeded', 'verification', ?, ?, 0, 0, ?)`)
    .run(`${taskId}-attempt`, NOW, NOW, box.projectId, box.featureId, ids.runId, taskId, NOW + 1000,
      JSON.stringify(snapshot), hash, snapshot.group.snapshot.artifactId, NOW, NOW, ref('code').artifactId);
  db.prepare("UPDATE tasks SET status = 'passed', execution_version = 1, first_passed_at = ?, attempt_counter = 1, code_attempts_used = 1 WHERE id = ?")
    .run(NOW, taskId);
  return snapshot;
}
