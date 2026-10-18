import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteWorkRecoveryReconciliationStore } from '../packages/core/src/adapters/sqlite/work-recovery-reconciliation.ts';
import { createSqliteGitOperationStore } from '../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkStartupRecoveryStore } from '../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { createRecoveryGitReader } from '../packages/core/src/adapters/fs/recovery-git-reader.ts';
import { createGitCommitDriver } from '../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createWorkspaceInspector } from '../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createWorkRecoveryReconciler } from '../packages/core/src/application/work-recovery-reconciliation.ts';
import { createWorkResourceStopVerifier } from '../packages/core/src/application/work-resource-stop.ts';
import { createWorkStartupRecovery } from '../packages/core/src/application/work-startup-recovery.ts';
import { BINDING_NOW, openBindingFixture, type BindingFixture } from './helpers/p03-6/input-binding-fixture.ts';
import { git } from './helpers/git-repo.ts';
import type { TaskClaimReceipt } from '../packages/core/src/ports/task-claim.ts';

const NOW = BINDING_NOW;
const confirm = async (identity: { launchId: string }) => ({ launchId: identity.launchId });

function seedWorkspace(f: BindingFixture, claim: TaskClaimReceipt,
  options: { readonly branch?: string; readonly baseCommit?: string; readonly canonicalPath?: string } = {}) {
  const a = claim.attempt, b = f.workspace.binding;
  const branch = options.branch ?? git(['branch', '--show-current'], f.workspace.canonicalPath).trim();
  const baseCommit = options.baseCommit ?? git(['rev-parse', 'HEAD'], f.workspace.canonicalPath).trim();
  f.session.database.prepare(`INSERT INTO managed_workspaces (id, created_at, updated_at, project_id, feature_id,
    repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir,
    branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, host_instance_id,
    execution_version, run_id, attempt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'ready', ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), NOW, NOW, f.projectId, f.featureId, b.id, b.revision, b.repoIdentity,
      options.canonicalPath ?? f.workspace.canonicalPath, b.gitCommonDir, branch, baseCommit, randomUUID(),
      a.owner, a.hostInstanceId, a.executionVersion, a.runId, a.id);
}

function recordedEvidence(f: BindingFixture) {
  const row = f.query("SELECT payload FROM state_events WHERE json_extract(payload, '$.phase') = 'recorded' ORDER BY sequence DESC LIMIT 1") as { payload: string };
  return JSON.parse(row.payload);
}

async function recoveryEvidence(f: BindingFixture, attemptId: string) {
  const row = f.query('SELECT diagnostic_ref FROM attempts WHERE id = ?', attemptId) as { diagnostic_ref: string };
  const artifact = await f.verifier.readVerifiedContent(f.projectId, row.diagnostic_ref);
  return JSON.parse(Buffer.from(artifact.content).toString()) as Record<string, any>;
}

function processIdentity() {
  return { launchId: randomUUID(), pid: 4_242, processGroupId: 4_242, startTime: 'f006-real-git-fake-process' };
}

function markRunning(f: BindingFixture, claim: TaskClaimReceipt) {
  const identity = processIdentity();
  f.session.database.prepare("UPDATE attempts SET status = 'executing', started_at = ? WHERE id = ?")
    .run(NOW, claim.attempt.id);
  f.session.database.prepare('UPDATE workspace_leases SET process_identity = ? WHERE owner_id = ?')
    .run(JSON.stringify({ schemaVersion: 2, ...identity }), claim.attempt.id);
  return identity;
}

async function publishJson(f: BindingFixture, value: unknown): Promise<string> {
  const body = Buffer.from(JSON.stringify(value));
  return (await f.publisher.publishArtifact({ projectId: f.projectId, kind: 'workspace_evidence',
    mediaType: 'application/json', expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `evidence/${randomUUID()}.json`, content: [body] })).artifact.id;
}

function recoveryStack(f: BindingFixture) {
  const stopVerifier = createWorkResourceStopVerifier({
    process: { recoverStop: async () => ({ confirmed: true }) },
    finalize: async () => true,
  });
  const resources = createSqliteWorkResourceAccess(f.session, {
    workspaceAuthority: f.authority, stopVerifier, nowUtcMs: () => NOW,
  });
  const store = createSqliteWorkRecoveryReconciliationStore(f.session, {
    resources, nowUtcMs: () => NOW,
  });
  const reconciler = createWorkRecoveryReconciler({
    store,
    inspect: (_projectId, baseline) => createWorkspaceInspector({
      authorizedRoots: [f.box.root], confirmProcessIdentity: confirm,
    }).inspect(baseline),
    git: createRecoveryGitReader({ driverFor: () => createGitCommitDriver({ confirmProcessIdentity: confirm }) }),
    artifacts: f.verifier,
    stopVerifier,
    publishEvidence: (_projectId, evidence) => publishJson(f, evidence),
    nowUtcMs: () => NOW,
  });
  const startup = createWorkStartupRecovery({
    store: createSqliteWorkStartupRecoveryStore(f.session, { nowUtcMs: () => NOW }),
    process: { recoverStop: async () => ({ confirmed: true }) },
    publishEvidence: (_projectId, evidence) => publishJson(f, evidence),
    reconcile: reconciler.reconcile,
    nowUtcMs: () => NOW,
  });
  return { startup, reconciler, stopVerifier, resources, store };
}

describe.skipIf(process.platform !== 'darwin')('P03-9 / F-006 recovery reconciliation', () => {
  it('verifies the surviving Git/worktree facts, pauses the Run and releases only the matching recovered holder', async () => {
    const f = await openBindingFixture({ secondTask: true });
    const claim = f.claimAndLaunch('t-1');
    seedWorkspace(f, claim.receipt);
    markRunning(f, claim.receipt);
    const root = f.workspace.canonicalPath;
    writeFileSync(join(root, 'src/a.ts'), 'export const project = "A-progress";\n');
    writeFileSync(join(root, 'untracked-keep.txt'), 'must survive recovery\n');
    const progressHead = (() => {
      git(['add', 'src/a.ts'], root);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
        'commit', '--quiet', '-m', 'committed progress before restart'], root);
      return git(['rev-parse', 'HEAD'], root).trim();
    })();
    // A valid passed Task and all historical events must remain untouched by recovery.
    f.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-2'").run();
    const before = f.query('SELECT COUNT(*) AS n FROM state_events') as { n: number };

    const stack = recoveryStack(f);
    stack.startup.enter();
    await stack.startup.recover();

    expect(stack.startup.state()).toEqual({ status: 'complete', reason: null });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.runId))
      .toEqual({ status: 'paused', reason: 'restart_recovery' });
    expect(f.query('SELECT status, head_commit, code_digest FROM managed_workspaces'))
      .toMatchObject({ status: 'retained', head_commit: progressHead, code_digest: expect.any(String) });
    expect(f.query('SELECT status FROM attempts WHERE id = ?', claim.receipt.attempt.id))
      .toEqual({ status: 'interrupted' });
    expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 0 });
    expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'passed' });
    expect((f.query('SELECT COUNT(*) AS n FROM state_events') as { n: number }).n).toBeGreaterThanOrEqual(before.n);
    expect(readFileSync(join(root, 'untracked-keep.txt'), 'utf8')).toBe('must survive recovery\n');
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('export const project = "A-progress";\n');
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(progressHead);

    const diagnostic = f.query('SELECT diagnostic_ref FROM attempts WHERE id = ?', claim.receipt.attempt.id) as { diagnostic_ref: string };
    const artifact = await f.verifier.readVerifiedContent(f.projectId, diagnostic.diagnostic_ref);
    const evidence = JSON.parse(Buffer.from(artifact.content).toString()) as Record<string, any>;
    expect(evidence).toMatchObject({
      kind: 'work-recovery-reconciliation',
      status: 'reconciled',
      gaps: [],
      taskPassed: false,
      newAttemptCreated: false,
      workspace: { headCommit: progressHead, retainedUntrackedCount: 1 },
    });

    const events = f.query('SELECT COUNT(*) AS n FROM state_events') as { n: number };
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'complete', reason: null });
    expect(f.query('SELECT COUNT(*) AS n FROM state_events')).toEqual(events);
    expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
  }, 30_000);

  it('quarantines a worktree whose registered branch no longer matches', async () => {
    const f = await openBindingFixture();
    const claim = f.claimAndLaunch('t-1');
    seedWorkspace(f, claim.receipt, { branch: 'other-branch' });
    markRunning(f, claim.receipt);
    const stack = recoveryStack(f);
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.runId)).toEqual({ status: 'interrupted' });
    expect(f.query('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
    expect(f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
    expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    const evidence = await recoveryEvidence(f, claim.receipt.attempt.id);
    expect(evidence).toMatchObject({ status: 'quarantined' });
    expect(evidence.gaps).toEqual(expect.arrayContaining(['workspace_branch_mismatch']));
  }, 20_000);

  it('quarantines a missing canonical worktree and still preserves the lease holder', async () => {
    const f = await openBindingFixture();
    const claim = f.claimAndLaunch('t-1');
    seedWorkspace(f, claim.receipt, { canonicalPath: join(f.box.root, 'missing-f006-worktree') });
    markRunning(f, claim.receipt);
    const stack = recoveryStack(f);
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
    expect(f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
    const evidence = await recoveryEvidence(f, claim.receipt.attempt.id);
    expect(evidence.gaps).toEqual(expect.arrayContaining(['workspace_not_found', 'workspace_resource_mismatch']));
  }, 20_000);

  it('quarantines external HEAD drift instead of resetting to the prepared baseline', async () => {
    const f = await openBindingFixture();
    const root = f.workspace.canonicalPath;
    const claim = f.claimAndLaunch('t-1');
    const branch = git(['branch', '--show-current'], root).trim();
    const oldHead = git(['rev-parse', 'HEAD'], root).trim();
    const tree = git(['rev-parse', 'HEAD^{tree}'], root).trim();
    const unrelated = git(['-c', 'user.name=External', '-c', 'user.email=external@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'external unrelated history'], root).trim();
    git(['update-ref', `refs/heads/${branch}`, unrelated, oldHead], root);
    git(['reset', '--hard', unrelated], root);
    seedWorkspace(f, claim.receipt, { baseCommit: oldHead });
    markRunning(f, claim.receipt);
    const stack = recoveryStack(f);
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(unrelated);
    const evidence = await recoveryEvidence(f, claim.receipt.attempt.id);
    expect(evidence.gaps).toEqual(expect.arrayContaining(['head_not_descended_from_base']));
  }, 20_000);

  it('records a missing Recorder watermark as a gap and keeps the Run interrupted', async () => {
    const f = await openBindingFixture();
    const claim = f.claimAndLaunch('t-1');
    seedWorkspace(f, claim.receipt);
    markRunning(f, claim.receipt);
    const a = claim.receipt.attempt;
    f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, revision, project_id, attempt_id,
      parent_session_id, kind, title, purpose, runtime, adapter_version, provider_session_id, status,
      execution_stage, input_ref, result_ref, last_activity_at, started_at, ended_at, stopped_at, native_ref,
      recording_watermark, recording_gaps)
      VALUES (?, ?, ?, 1, ?, ?, NULL, 'work', NULL, 'work', 'fake', '1', NULL, 'started',
        'runtime', ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)`)
      .run(`session-${a.id}`, NOW, NOW, f.projectId, a.id, a.inputRef, NOW, NOW);
    const stack = recoveryStack(f);
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
    const evidence = await recoveryEvidence(f, a.id);
    expect(evidence.gaps).toEqual(expect.arrayContaining(['recording_watermark_missing']));
    expect(evidence.recording).toMatchObject({ status: 'started', watermark: null });
  }, 20_000);

  it('records an already executed commit against its pending intent without committing again', async () => {
    const f = await openBindingFixture();
    const root = f.workspace.canonicalPath;
    const claim = f.claimAndLaunch('t-1');
    markRunning(f, claim.receipt);
    const operationId = randomUUID();
    const message = `Feature delivery\n\nShipLoop-Operation: ${operationId}\n`;
    writeFileSync(join(root, 'src/a.ts'), 'export const project = "pending-commit";\n');
    git(['add', 'src/a.ts'], root);
    git(['-c', 'user.name=Pending', '-c', 'user.email=pending@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '--cleanup=verbatim', '-m', message], root);
    const actualCommit = git(['rev-parse', 'HEAD'], root).trim();
    const expectedHead = git(['rev-parse', 'HEAD^'], root).trim();
    const candidateTree = git(['rev-parse', 'HEAD^{tree}'], root).trim();
    seedWorkspace(f, claim.receipt, { baseCommit: expectedHead });
    const b = f.workspace.binding, a = claim.receipt.attempt;
    const feature = f.query('SELECT revision FROM features WHERE id = ?', f.featureId) as { revision: number };
    createSqliteGitOperationStore(f.session, { nowUtcMs: () => NOW }).registerGitOperation({
      operationId, projectId: f.projectId, featureId: f.featureId, runId: a.runId, attemptId: a.id,
      executionVersion: a.executionVersion, operationType: 'feature_final_commit', repositoryBindingId: b.id,
      repoIdentity: b.repoIdentity, worktreePath: root, expectedHead, candidateTree, codeDigest: 'a'.repeat(64),
      verificationRefs: [], approvalRefs: [], message: 'Feature delivery',
      gitIdentity: { name: 'Pending', email: 'pending@example.invalid', confirmed: true },
      deliveryPolicyDigest: 'b'.repeat(64), runtimeSource: null, ownerId: a.owner,
      hostInstanceId: a.hostInstanceId, expectedFeatureRevision: feature.revision,
    });
    const stack = recoveryStack(f);
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'complete', reason: null });
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(actualCommit);
    expect(f.query('SELECT status, actual_commit FROM git_operations WHERE id = ?', operationId))
      .toEqual({ status: 'pending', actual_commit: null });
    const evidence = await recoveryEvidence(f, a.id);
    expect(evidence.gitOperations).toEqual([{ operationId, outcome: 'matched', actualCommit, actualTree: candidateTree,
      reasonCode: null }]);
  }, 20_000);

  it('records native archive format metadata as read-only facts without opening the archive', async () => {
    const f = await openBindingFixture();
    const claim = f.claimAndLaunch('t-1');
    seedWorkspace(f, claim.receipt);
    markRunning(f, claim.receipt);
    const a = claim.receipt.attempt;
    f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, revision, project_id, attempt_id,
      parent_session_id, kind, title, purpose, runtime, adapter_version, provider_session_id, status,
      execution_stage, input_ref, result_ref, last_activity_at, started_at, ended_at, stopped_at, native_ref,
      recording_watermark, recording_gaps)
      VALUES (?, ?, ?, 1, ?, ?, NULL, 'work', NULL, 'work', 'fake', '1', 'native-session', 'started',
        'runtime', ?, NULL, ?, ?, NULL, NULL, ?, 5, NULL)`)
      .run(`session-${a.id}`, NOW, NOW, f.projectId, a.id, a.inputRef, NOW, NOW,
        JSON.stringify({ schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.2.0' }));
    const stack = recoveryStack(f);
    await stack.startup.recover();
    expect(stack.startup.state()).toEqual({ status: 'complete', reason: null });
    const evidence = await recoveryEvidence(f, a.id);
    expect(evidence.native).toEqual({
      sessionStorageKind: 'sqlite', sessionFormatVersion: '1.2.0', sourceArchiveRef: null,
      sourceDigest: null, sourceVerified: false, singleWriter: 'confirmed_stopped', opened: false,
    });
    expect(evidence.recording).toMatchObject({ status: 'started', watermark: 5 });
  }, 20_000);

  it('marks a pending Artifact reference as an unresolved gap during repeated reconciliation', async () => {
    const f = await openBindingFixture();
    const claim = f.claimAndLaunch('t-1');
    seedWorkspace(f, claim.receipt);
    markRunning(f, claim.receipt);
    // F-005 records the stopped observation but deliberately leaves workspace reconciliation pending.
    const f005 = createWorkStartupRecovery({
      store: createSqliteWorkStartupRecoveryStore(f.session, { nowUtcMs: () => NOW }),
      process: { recoverStop: async () => ({ confirmed: true }) },
      publishEvidence: (_projectId, evidence) => publishJson(f, evidence),
      nowUtcMs: () => NOW,
    });
    await f005.recover();
    expect(f005.state()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
    const pending = await f.artifacts.registerArtifact({ projectId: f.projectId, kind: 'diagnostic',
      mediaType: 'application/json', expectedHash: 'd'.repeat(64), locator: 'diagnostics/pending-f006.json' });
    f.session.database.prepare('UPDATE attempts SET diagnostic_ref = ? WHERE id = ?').run(pending.id, claim.receipt.attempt.id);
    const direct = recoveryStack(f);
    const result = await direct.reconciler.reconcile(recordedEvidence(f));
    expect(result.status).toBe('quarantined');
    expect(result.gaps).toEqual(expect.arrayContaining(['artifact_not_ready']));
    expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
  }, 20_000);
});
