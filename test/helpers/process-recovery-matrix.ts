import { createHash, randomUUID } from 'node:crypto';
import { createCommandProcessAdapter } from '../../packages/core/src/adapters/process/command-process.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { createSqliteWorkRecoveryReconciliationStore } from '../../packages/core/src/adapters/sqlite/work-recovery-reconciliation.ts';
import { createSqliteWorkResourceAccess } from '../../packages/core/src/adapters/sqlite/work-resources.ts';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createWorkspaceInspector } from '../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createGitCommitDriver } from '../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createRecoveryGitReader } from '../../packages/core/src/adapters/fs/recovery-git-reader.ts';
import { createWorkResourceStopVerifier } from '../../packages/core/src/application/work-resource-stop.ts';
import { createWorkRecoveryReconciler } from '../../packages/core/src/application/work-recovery-reconciliation.ts';
import { createWorkStartupRecovery } from '../../packages/core/src/application/work-startup-recovery.ts';
import type { WorkStartupRecoveryState } from '../../packages/core/src/ports/work-startup-recovery.ts';
import type { WorkRecoveryReconciliationEvidence } from '../../packages/core/src/ports/work-recovery-reconciliation.ts';
import type { CommandProcessPort } from '../../packages/core/src/ports/command-process.ts';
import type { WorkResourceIdentity } from '../../packages/core/src/ports/work-resources.ts';
import { BINDING_NOW as NOW, openBindingFixture } from './p03-6/input-binding-fixture.ts';
import { git } from './git-repo.ts';
import { matrixFileInventory } from './process-matrix.ts';

/** Real Git/SQLite/input authorization. Only the crash/fault facts below are deliberately seeded. */
export async function openProcessRecoveryFixture(launch = true, sessionMode: 'stopped' | 'started' | 'flush-failed' = 'stopped') {
  const f = await openBindingFixture({ secondTask: true });
  let now = NOW;
  const claimed = f.claimTask('t-1');
  if (launch) f.launch(claimed);
  const a = claimed.receipt.attempt, b = f.workspace.binding;
  const identity: WorkResourceIdentity = { projectId: f.projectId, attemptId: a.id,
    owner: a.owner, hostInstanceId: a.hostInstanceId, executionVersion: a.executionVersion };
  f.session.database.prepare(`INSERT INTO managed_workspaces (id, created_at, updated_at, project_id, feature_id,
    repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir,
    branch, base_commit, status, preparation_operation_id, owner_id, host_instance_id, execution_version, run_id, attempt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), NOW, NOW, f.projectId, f.featureId, b.id, b.revision, b.repoIdentity,
      f.workspace.canonicalPath, b.gitCommonDir, git(['branch', '--show-current'], f.workspace.canonicalPath).trim(),
      git(['rev-parse', 'HEAD'], f.workspace.canonicalPath).trim(), randomUUID(), a.owner, a.hostInstanceId, a.executionVersion, a.runId, a.id);
  f.session.database.prepare("UPDATE attempts SET status = 'executing', execution_stage = 'runtime', started_at = ? WHERE id = ?").run(NOW, a.id);
  f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, revision, project_id, attempt_id,
    parent_session_id, kind, title, purpose, runtime, adapter_version, provider_session_id, status,
    execution_stage, input_ref, result_ref, last_activity_at, started_at, ended_at, stopped_at, native_ref,
    recording_watermark, recording_gaps)
    VALUES (?, ?, ?, 1, ?, ?, NULL, 'work', NULL, 'work', 'fake', '1', 'matrix-native-session', ?,
      'runtime', ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(`session-${a.id}`, NOW, NOW, f.projectId, a.id, sessionMode === 'started' ? 'started' : 'stopped',
      a.inputRef, NOW, NOW, sessionMode === 'started' ? null : NOW, sessionMode === 'started' ? null : NOW,
      sessionMode === 'flush-failed' ? null : 5, sessionMode === 'flush-failed' ? JSON.stringify(['recording_flush_failed']) : null);
  async function publish(value: unknown) {
    const content = Buffer.from(JSON.stringify(value));
    return (await f.publisher.publishArtifact({ projectId: f.projectId, kind: 'workspace_evidence', mediaType: 'application/json',
      expectedHash: createHash('sha256').update(content).digest('hex'), locator: `matrix/${randomUUID()}.json`, content: [content] })).artifact.id;
  }
  async function recover(process: Pick<CommandProcessPort, 'recoverStop'> = createCommandProcessAdapter({ stopConfirmMs: 1_000 }),
    beforeFinish?: (evidence: WorkRecoveryReconciliationEvidence) => Promise<void>):
    Promise<{ state: WorkStartupRecoveryState; evidence: WorkRecoveryReconciliationEvidence }> {
    // A fresh Host-side connection and service read the persisted identity, never a live handle.
    const restarted = openSqliteStorageSession({ path: f.box.dbPath });
    try {
      const stopVerifier = createWorkResourceStopVerifier({ process, finalize: async () => true });
      const resources = createSqliteWorkResourceAccess(restarted, { workspaceAuthority: f.authority, stopVerifier, nowUtcMs: () => now });
      const confirm = async (id: { launchId: string }) => ({ launchId: id.launchId });
      const reconciler = createWorkRecoveryReconciler({
        store: createSqliteWorkRecoveryReconciliationStore(restarted, { resources, nowUtcMs: () => now }),
        inspect: (_projectId, baseline) => createWorkspaceInspector({ authorizedRoots: [f.box.root], confirmProcessIdentity: confirm }).inspect(baseline),
        git: createRecoveryGitReader({ driverFor: () => createGitCommitDriver({ confirmProcessIdentity: confirm }) }),
        artifacts: f.verifier, stopVerifier, publishEvidence: async (_projectId, evidence) => {
          const ref = await publish(evidence);
          await beforeFinish?.(evidence);
          return ref;
        }, nowUtcMs: () => now,
      });
      const startup = createWorkStartupRecovery({ store: createSqliteWorkStartupRecoveryStore(restarted, { nowUtcMs: () => now }),
        process, reconcile: reconciler.reconcile, publishEvidence: (_projectId, evidence) => publish(evidence), nowUtcMs: () => now });
      const state = await startup.recover();
      const { diagnostic_ref: ref } = f.query('SELECT diagnostic_ref FROM attempts WHERE id = ?', a.id) as { diagnostic_ref: string };
      const verified = await f.verifier.readVerifiedContent(f.projectId, ref);
      return { state, evidence: JSON.parse(Buffer.from(verified.content).toString()) };
    } finally { restarted.close(); }
  }
  function snapshot() {
    return {
      root: f.box.root, database: f.box.dbPath, workspace: f.workspace.canonicalPath, files: matrixFileInventory(f.box.root),
      attempts: f.session.database.prepare('SELECT * FROM attempts').all(),
      leases: f.session.database.prepare('SELECT * FROM workspace_leases').all(),
      sessions: f.session.database.prepare('SELECT * FROM sessions').all(),
      runs: f.session.database.prepare('SELECT * FROM runs').all(),
      workspaces: f.session.database.prepare('SELECT * FROM managed_workspaces').all(),
      events: f.session.database.prepare('SELECT * FROM state_events').all(),
    };
  }
  return { ...f, advance(ms: number) { now += ms; f.advance(ms); }, identity, claimed, publish, recover, snapshot };
}
