/**
 * P03-9 / F-009 retryFinal 资格与受限 finalization scope。
 *
 * 聚焦验收（真实临时 Git/SQLite/Artifact，零模型调用）：
 * - 相同输入只读重算，历史 Run/Attempt/VerificationBatch/审批行不被改写；
 * - 源码变更、检查定义变更、缺失/损坏 Artifact 只让相关当前证据待重验，
 *   已通过的其它 Task 证据仍可复用；
 * - 输出只含最终检查/审批/提交步骤，编码 Task、Runtime 启动与新 Attempt 恒为零；
 * - 错误 workKey/项目、非终态历史 Run、旧租约不安全均明确拒绝；
 * - 人审只认当前 planDigest + 当前代码摘要；取消历史不会自动继续。
 */
import { createHash, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createWorkspaceInspector } from '../../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteExecutionResumeFactsReader } from '../../../../packages/core/src/adapters/sqlite/execution-resume.ts';
import { createSqliteFeatureDeliveryQueryStore } from '../../../../packages/core/src/adapters/sqlite/feature-delivery-query-store.ts';
import { createSqliteStateAccess } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteTaskDagStore } from '../../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteTaskEvidenceQueryStore } from '../../../../packages/core/src/adapters/sqlite/task-evidence-query-store.ts';
import { createSqliteWorkResourceAccess } from '../../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createArtifactPublisher } from '../../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../../packages/core/src/application/artifact-verify.ts';
import { createFinalizationRetryPlanner } from '../../../../packages/core/src/application/finalization-retry.ts';
import { createWorkResourceStopVerifier } from '../../../../packages/core/src/application/work-resource-stop.ts';
import type { AttemptRecord } from '../../../../packages/core/src/ports/attempt-store.ts';
import type { ArtifactRecord } from '../../../../packages/core/src/ports/artifact-store.ts';
import type { CheckDefinition } from '../../../../packages/core/src/ports/task-verification-policy.ts';
import { git } from '../../../helpers/git-repo.ts';
import { NOW } from '../../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../../helpers/p03-4/task-claim-fixture.ts';
import { recordTaskCommitFixture } from '../../../helpers/task-commit-receipt.ts';

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;
type ClaimedFixture = Fixture & {
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly publisher: ReturnType<typeof createArtifactPublisher>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly inspection: Awaited<ReturnType<ReturnType<typeof createWorkspaceInspector>['inspect']>>;
  readonly workspaceId: string;
};

const stopVerifier = createWorkResourceStopVerifier({
  process: { recoverStop: async () => ({ confirmed: true }) },
  finalize: async () => true,
});

const lifecycle = (f: Fixture) =>
  createSqliteAttemptLifecycleStore(f.box.session, {
    workspaceAuthority: f.authority,
    nowUtcMs: () => NOW + 1,
    stopVerifier,
  });
const resources = (f: Fixture) =>
  createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });

function decisionDefinition(checkKey: string, argv: readonly string[] = ['node', '--test']): CheckDefinition {
  return {
    checkKey,
    scope: 'task',
    kind: 'command',
    argv: [...argv],
    cwdRef: null,
    environmentRef: null,
    timeout: 60_000,
    required: true,
    requirementRefs: [],
  };
}

function currentPlanDigest(f: Fixture): string {
  return (f.box.session.database.prepare('SELECT plan_digest FROM features WHERE id = ?')
    .get(f.box.featureId) as { plan_digest: string }).plan_digest;
}

async function requireCompleted(promise: Promise<{ status: string }>, label: string): Promise<void> {
  const receipt = await promise;
  if (receipt.status !== 'completed') throw new Error(`${label} failed: ${JSON.stringify(receipt)}`);
}

async function createProjectPolicy(f: Fixture, definitions: readonly CheckDefinition[]): Promise<void> {
  await requireCompleted(f.box.submit('settings.project.create', {
    schemaVersion: 2,
    policies: {
      verification: {
        requireChecksBeforeDone: true,
        checkDefinitions: definitions,
        fullFallback: { checkRefs: definitions.map(definition => definition.checkKey) },
      },
    },
  }, { scope: f.box.scope }), 'settings.project.create');
}

async function approveCurrentPlan(f: Fixture): Promise<void> {
  const featureRow = f.box.session.database.prepare(
    'SELECT plan_digest, revision FROM features WHERE id = ?',
  ).get(f.box.featureId) as { plan_digest: string; revision: number };
  await requireCompleted(f.box.submit('feature.plan.decide', {
    featureId: f.box.featureId,
    planDigest: featureRow.plan_digest,
    decision: 'approve',
    reason: 'F-009 current check policy re-approval',
  }, { scope: f.box.scope, expectedRevision: featureRow.revision }), 'feature.plan.decide');
}

function replaceProjectPolicy(f: Fixture, definitions: readonly CheckDefinition[]): void {
  f.box.session.database.prepare(
    'UPDATE project_settings SET payload = ?, revision = revision + 1, updated_at = ? WHERE project_id = ?',
  ).run(JSON.stringify({
    schemaVersion: 2,
    policies: {
      verification: {
        requireChecksBeforeDone: true,
        checkDefinitions: definitions,
        fullFallback: { checkRefs: definitions.map(definition => definition.checkKey) },
      },
    },
  }), NOW + 10, f.box.projectId);
}

async function publishJson(
  f: Fixture,
  publisher: ReturnType<typeof createArtifactPublisher>,
  kind: string,
  value: unknown,
): Promise<ArtifactRecord> {
  const body = Buffer.from(JSON.stringify(value));
  return (await publisher.publishArtifact({
    projectId: f.box.projectId,
    kind,
    mediaType: 'application/json',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `evidence/${randomUUID()}.json`,
    content: [body],
  })).artifact;
}

interface SeedBatchInput {
  readonly attempt: AttemptRecord;
  readonly taskId: string;
  readonly batchId: string;
  readonly operation: string;
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly codeDigest: string;
  readonly outputArtifactId: string;
  readonly outputDigest: string;
}

function seedVerificationBatch(f: Fixture, input: SeedBatchInput): void {
  const snapshot = {
    checkKey: input.checkKey,
    scope: 'task',
    kind: 'command',
    argv: [...input.argv],
    cwdRef: null,
    environmentRef: null,
    timeout: 60_000,
    required: true,
    requirementRefs: [],
  };
  const policyDigest = input.attempt.inputSnapshot.approval!.checkPolicyDigest;
  f.box.session.database.prepare(
    `INSERT INTO verification_batches
      (id, created_at, updated_at, revision, project_id, feature_id, run_id, task_id, attempt_id,
       execution_version, operation, code_digest, policy_digest, environment_summary, check_snapshot,
       selection, status, started_at, ended_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'passed', ?, ?)`,
  ).run(
    input.batchId, NOW, NOW, f.box.projectId, f.box.featureId, input.attempt.runId, input.taskId,
    input.attempt.id, input.attempt.executionVersion, input.operation, input.codeDigest, policyDigest,
    JSON.stringify([snapshot]),
    JSON.stringify({ schemaVersion: 1, mode: 'full_fallback', reason: 'f009 fixture', selectedCheckKeys: [input.checkKey] }),
    NOW, NOW + 1,
  );
  f.box.session.database.prepare(
    `INSERT INTO check_results
      (id, created_at, updated_at, revision, project_id, batch_id, check_key, argv_json, cwd_ref,
       environment_ref, timeout_ms, required, status, exit_code, signal, timed_out,
       output_artifact_id, output_digest, output_tail, started_at, ended_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, 60000, 1, 'passed', 0, NULL, 0, ?, ?, 'ok', ?, ?)`,
  ).run(
    `${input.batchId}-result`, NOW, NOW, f.box.projectId, input.batchId, input.checkKey,
    JSON.stringify(input.argv), input.outputArtifactId, input.outputDigest, NOW, NOW + 1,
  );
}

function insertApprovalItem(f: Fixture, taskId: string, codeDigest: string, status: 'approved' | 'pending' | 'rejected'): string {
  const id = `approval-${randomUUID()}`;
  const decided = status === 'approved';
  f.box.session.database.prepare(
    `INSERT INTO task_approval_items
      (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
       responsible_party, plan_digest, code_digest, artifact_refs, status, created_by,
       decision, decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'approval', 'final review', 'owner', ?, ?, '[]', ?, 'owner',
       ?, ?, ?, ?, '[]', ?)`,
  ).run(
    id, NOW, f.box.projectId, f.box.featureId, taskId, NOW, currentPlanDigest(f), codeDigest, status,
    decided ? 'approve' : null, decided ? 'reviewer-1' : null, decided ? 'approved' : null,
    decided ? codeDigest : null, decided ? NOW : null,
  );
  return id;
}

async function claimAndPass(
  f: Fixture,
  publisher: ReturnType<typeof createArtifactPublisher>,
  index: number,
  checkKey: string,
  argv: readonly string[],
  codeDigest: string,
): Promise<AttemptRecord> {
  const taskId = `t-${index + 1}`;
  const attempt = f.store().claimTask({ ...f.input(index), claimKey: randomUUID() }).receipt.attempt;
  const identity = {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
  const notification = { ...identity, taskId: attempt.taskId, runId: attempt.runId };
  f.box.session.transactWrite('f009.launch', () => {
    createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt.projectId,
      batchId: f.ids.batchId,
      runId: attempt.runId,
      startKey: attempt.id,
    });
    resources(f).beginLaunchInTransaction(identity);
    resources(f).confirmLaunchInTransaction(identity, {
      launchId: randomUUID(),
      pid: 4_500 + index,
      processGroupId: 4_500 + index,
      startTime: `f009-start-${index}`,
    });
  });
  lifecycle(f).apply({ ...notification, notificationId: 'started', kind: 'executing' });
  const token = await stopVerifier.verify(resources(f).read(identity));
  const completed = lifecycle(f).apply({
    ...notification,
    notificationId: 'complete',
    kind: 'runtime_completed',
    exitCode: 0,
    evidenceRef: attempt.inputRef,
  }, token);
  if (completed.status !== 'verifying') throw new Error(`fixture verification advance failed: ${JSON.stringify(completed)}`);

  const codeArtifact = await publishJson(f, publisher, 'workspace_code', {
    schemaVersion: 1,
    kind: 'workspace-code-identity',
    attemptId: attempt.id,
    taskId,
    runId: attempt.runId,
    codeDigest,
  });
  f.box.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run(codeArtifact.id, attempt.id);

  const output = await publishJson(f, publisher, 'verification_output', {
    schemaVersion: 1,
    checkKey,
    codeDigest,
    status: 'passed',
  });
  const batchId = `${attempt.id}-${checkKey}-batch`;
  seedVerificationBatch(f, {
    attempt,
    taskId,
    batchId,
    operation: 'verification.task',
    checkKey,
    argv,
    codeDigest,
    outputArtifactId: output.id,
    outputDigest: output.contentHash!,
  });
  recordTaskCommitFixture(f, attempt, batchId, codeDigest);
  const verification = lifecycle(f).submitVerification({
    projectId: attempt.projectId,
    attemptId: attempt.id,
    taskId,
    runId: attempt.runId,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
    verificationBatchId: batchId,
    codeDigest,
    observationDigest: createHash('sha256').update(`${attempt.id}:passed`).digest('hex'),
    outcome: 'passed',
  }, token);
  if (verification.status !== 'succeeded') throw new Error(`fixture task pass failed: ${JSON.stringify(verification)}`);
  return attempt;
}

function insertManagedWorkspace(f: Fixture, attempt: AttemptRecord): string {
  const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(f.box.projectId);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim();
  const head = f.box.box.gitHead('A');
  const id = randomUUID();
  f.box.session.database.prepare(
    `INSERT INTO managed_workspaces
      (id, created_at, project_id, revision, updated_at, feature_id, repository_binding_id,
       repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit,
       head_commit, code_digest, status, preparation_operation_id, owner_id, host_instance_id,
       execution_version, run_id, attempt_id)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, NOW, f.box.projectId, NOW, attempt.featureId, binding.id, binding.bindingRevision,
    binding.repoIdentity, binding.canonicalPath, binding.gitCommonDir ?? `${binding.canonicalPath}/.git`,
    branch, head, head, 'ab'.repeat(32), `prep-${id}`, attempt.owner, attempt.hostInstanceId,
    attempt.executionVersion, attempt.runId, attempt.id,
  );
  return id;
}

function workspaceBaseline(f: Fixture) {
  const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(f.box.projectId);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim();
  const head = f.box.box.gitHead('A');
  return {
    repositoryBindingId: binding.id,
    repositoryBindingRevision: binding.bindingRevision,
    repoIdentity: binding.repoIdentity,
    canonicalPath: binding.canonicalPath,
    gitCommonDir: binding.gitCommonDir ?? `${binding.canonicalPath}/.git`,
    branch,
    baseCommit: head,
  };
}

async function openFixture(taskCount = 1): Promise<ClaimedFixture> {
  const f = await openClaimFixture(Array.from({ length: taskCount }, () => []));
  const artifacts = createSqliteArtifactStore(f.box.session, { nowUtcMs: () => NOW });
  const files = createArtifactFileStore({ dataRoot: f.box.box.dataRoot });
  const publisher = createArtifactPublisher({
    artifacts,
    files,
    limits: { maxSizeBytes: 1_000_000, timeoutMs: 30_000 },
    nowMs: () => NOW,
  });
  const verifier = createArtifactVerifier({
    artifacts,
    files,
    limits: { maxReadBytes: 1_000_000 },
    nowMs: () => NOW,
  });
  const inspector = createWorkspaceInspector({
    authorizedRoots: [f.box.box.root, f.box.box.repoDirA],
    confirmProcessIdentity: async identity => identity,
  });
  const inspection = await inspector.inspect(workspaceBaseline(f));
  return { ...f, artifacts, publisher, verifier, inspection, workspaceId: '' };
}

async function withWorkspace(
  fixture: ClaimedFixture,
  attempt: AttemptRecord,
): Promise<ClaimedFixture> {
  const workspaceId = insertManagedWorkspace(fixture, attempt);
  return { ...fixture, workspaceId };
}

function plannerFor(f: ClaimedFixture) {
  const inspector = createWorkspaceInspector({
    authorizedRoots: [f.box.box.root, f.box.box.repoDirA],
    confirmProcessIdentity: async identity => identity,
  });
  return createFinalizationRetryPlanner({
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
    dag: createSqliteTaskDagStore(f.box.session),
    taskEvidence: createSqliteTaskEvidenceQueryStore(f.box.session),
    featureDelivery: createSqliteFeatureDeliveryQueryStore(f.box.session),
    artifacts: f.verifier,
    inspectorFor: async () => inspector,
  });
}

function markHistoricalRunTerminal(f: ClaimedFixture, status: 'failed' | 'cancelled' = 'failed'): void {
  f.box.session.database.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
    .run(status, NOW + 5, f.ids.runId);
  f.box.session.database.prepare('UPDATE execution_batches SET status = ? WHERE id = ?')
    .run(status, f.ids.batchId);
}

function historicalRows(f: ClaimedFixture): string {
  const tables = [
    'runs', 'execution_batches', 'attempts', 'tasks', 'verification_batches', 'check_results',
    'task_approval_items', 'managed_workspaces', 'state_events',
  ];
  return JSON.stringify(Object.fromEntries(tables.map(table => [
    table,
    f.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ])));
}

async function prepareEligibleFixture(taskCount = 1, terminal = true): Promise<ClaimedFixture> {
  const f = await openFixture(taskCount);
  const definitions = taskCount === 2
    ? [decisionDefinition('tests', ['node', '--test', 'a']), decisionDefinition('lint', ['node', 'lint'])]
    : [decisionDefinition('tests')];
  const attempts: AttemptRecord[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const checkKey = taskCount === 2 ? (index === 0 ? 'tests' : 'lint') : 'tests';
    const definition = definitions[index]!;
    attempts.push(await claimAndPass(f, f.publisher, index, checkKey, definition.argv, f.inspection.codeDigest));
  }
  const withWorkspaceFixture = await withWorkspace(f, attempts[0]!);

  // The existing claim fixture starts execution before this task's policy exists.
  // Add the current check policy afterwards, then re-approve the same plan for the
  // new check-policy identity (historical decision rows remain untouched). This
  // exercises finalization eligibility without rewriting execution snapshots.
  await createProjectPolicy(withWorkspaceFixture, definitions);
  await approveCurrentPlan(withWorkspaceFixture);

  // Feature final verification over the current code identity.
  const featureOutput = await publishJson(withWorkspaceFixture, withWorkspaceFixture.publisher, 'feature_verification_output', {
    schemaVersion: 1,
    checkKey: 'tests',
    codeDigest: withWorkspaceFixture.inspection.codeDigest,
    status: 'passed',
  });
  const featureBatchId = `feature-${randomUUID()}`;
  seedVerificationBatch(withWorkspaceFixture, {
    attempt: attempts[0]!,
    taskId: attempts[0]!.taskId,
    batchId: featureBatchId,
    operation: 'FeatureVerification.full',
    checkKey: definitions[0]!.checkKey,
    argv: definitions[0]!.argv,
    codeDigest: withWorkspaceFixture.inspection.codeDigest,
    outputArtifactId: featureOutput.id,
    outputDigest: featureOutput.contentHash!,
  });
  const approvalId = insertApprovalItem(withWorkspaceFixture, attempts[0]!.taskId, withWorkspaceFixture.inspection.codeDigest, 'approved');
  if (terminal) markHistoricalRunTerminal(withWorkspaceFixture);
  return { ...withWorkspaceFixture, approvalId } as ClaimedFixture;
}

describe('P03-9 / F-009 retryFinal eligibility and finalization scope', () => {
  it('相同输入只读重算：保留有效 Task/最终检查/审批，只输出仍缺失的提交步骤', async () => {
    const f = await prepareEligibleFixture();
    try {
      const before = historicalRows(f);
      const planner = plannerFor(f);
      const request = {
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey: (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
          .get(f.ids.runId) as { work_key: string }).work_key,
      };

      const first = await planner.prepare(request);
      expect(first.status).toBe('eligible');
      if (first.status !== 'eligible') throw new Error('unreachable');
      expect(first.plan).toMatchObject({
        historicalRunId: f.ids.runId,
        historicalRunStatus: 'failed',
        retainedTaskIds: ['t-1'],
        revalidateTasks: [],
        finalVerification: { required: false, checkKeys: [], latestBatchId: expect.any(String) },
        approval: { required: true, valid: true, reason: null },
        commit: { required: true, reconcileRequired: false, deliveryStatus: 'not_requested' },
        missingSteps: ['commit'],
        coding: { taskIds: [], runtimeStarts: 0, newAttempts: 0 },
        historicalRecordsMutated: false,
      });
      expect(first.plan.tasks[0]).toMatchObject({ taskId: 't-1', evidence: 'valid', retainedCheckKeys: ['tests'] });

      const second = await planner.prepare(request);
      expect(second).toEqual(first);
      expect(historicalRows(f)).toBe(before);
    } finally { f.box.close(); }
  }, 30_000);

  it('源码变更只让当前 Task/最终检查证据待重验，不改写历史记录且不创建编码 Attempt', async () => {
    const f = await prepareEligibleFixture();
    try {
      const before = historicalRows(f);
      writeFileSync(join(f.box.box.repoDirA, 'src/a.ts'), 'export const project = "changed-after-pass";\n');
      const planner = plannerFor(f);
      const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(f.ids.runId) as { work_key: string }).work_key;
      const result = await planner.prepare({
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey,
      });
      expect(result.status).toBe('eligible');
      if (result.status !== 'eligible') throw new Error('unreachable');
      expect(result.plan.revalidateTasks).toEqual([
        { taskId: 't-1', checkKeys: ['tests'], reasons: ['source_changed'] },
      ]);
      expect(result.plan.finalVerification).toMatchObject({ required: true, checkKeys: ['tests'] });
      expect(result.plan.missingSteps).toEqual(['task_revalidation', 'feature_verification', 'approval', 'commit']);
      expect(result.plan.coding).toEqual({ taskIds: [], runtimeStarts: 0, newAttempts: 0 });
      expect((f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(1);
      expect(historicalRows(f)).toBe(before);
    } finally { f.box.close(); }
  }, 30_000);

  it('检查定义变更只使引用该定义的 Task 待重验，其它 Task 证据继续复用', async () => {
    const f = await prepareEligibleFixture(2);
    try {
      replaceProjectPolicy(f, [
        decisionDefinition('tests', ['node', '--test', 'changed']),
        decisionDefinition('lint', ['node', 'lint']),
      ]);
      await approveCurrentPlan(f);
      const before = historicalRows(f);
      const planner = plannerFor(f);
      const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(f.ids.runId) as { work_key: string }).work_key;
      const result = await planner.prepare({
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey,
      });
      expect(result.status).toBe('eligible');
      if (result.status !== 'eligible') throw new Error('unreachable');
      expect(result.plan.retainedTaskIds).toEqual(['t-2']);
      expect(result.plan.revalidateTasks).toEqual([
        { taskId: 't-1', checkKeys: ['tests'], reasons: ['check_definition_changed'] },
      ]);
      expect(result.plan.tasks.find(task => task.taskId === 't-2')?.evidence).toBe('valid');
      expect(result.plan.finalVerification.required).toBe(true);
      expect(historicalRows(f)).toBe(before);
    } finally { f.box.close(); }
  }, 30_000);

  it('缺失/损坏输出 Artifact：相关证据待重验，历史行保持不变', async () => {
    const f = await prepareEligibleFixture();
    try {
      const before = historicalRows(f);
      const output = f.box.session.database.prepare(
        `SELECT r.output_artifact_id AS id FROM check_results r
         JOIN verification_batches b ON b.id = r.batch_id
         WHERE b.operation = 'verification.task' LIMIT 1`,
      ).get() as { id: string };
      rmSync(join(f.box.box.dataRoot, 'projects', f.box.projectId, 'artifacts', output.id, 'content'));
      const planner = plannerFor(f);
      const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(f.ids.runId) as { work_key: string }).work_key;
      const result = await planner.prepare({
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey,
      });
      expect(result.status).toBe('eligible');
      if (result.status !== 'eligible') throw new Error('unreachable');
      expect(result.plan.revalidateTasks[0]).toMatchObject({ taskId: 't-1', checkKeys: ['tests'] });
      expect(result.plan.revalidateTasks[0]!.reasons).toEqual(['artifact_corrupt']);
      expect(result.plan.missingSteps).toContain('feature_verification');
      expect(historicalRows(f)).toBe(before);
    } finally { f.box.close(); }
  }, 30_000);

  it('错误 workKey/项目、非终态历史 Run 与旧租约不安全均明确拒绝', async () => {
    const nonTerminal = await prepareEligibleFixture(1, false);
    try {
      const planner = plannerFor(nonTerminal);
      const workKey = (nonTerminal.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(nonTerminal.ids.runId) as { work_key: string }).work_key;
      expect(await planner.prepare({
        projectId: nonTerminal.box.projectId,
        featureId: nonTerminal.box.featureId,
        historicalRunId: nonTerminal.ids.runId,
        workKey,
      })).toMatchObject({ status: 'rejected', reason: 'run_not_terminal' });
    } finally { nonTerminal.box.close(); }

    const f = await prepareEligibleFixture();
    try {
      const planner = plannerFor(f);
      const base = {
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
      };
      const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(f.ids.runId) as { work_key: string }).work_key;
      expect(await planner.prepare({ ...base, workKey: 'f'.repeat(64) }))
        .toMatchObject({ status: 'rejected', reason: 'work_key_mismatch' });
      expect(await planner.prepare({ ...base, workKey: 'not-a-digest' }))
        .toMatchObject({ status: 'rejected', reason: 'work_key_mismatch' });
      expect(await planner.prepare({ ...base, projectId: randomUUID(), workKey }))
        .toMatchObject({ status: 'rejected', reason: 'run_not_found' });

      const attempt = f.box.session.database.prepare('SELECT * FROM attempts LIMIT 1').get() as {
        id: string; host_instance_id: string; execution_version: number;
      };
      f.box.session.database.prepare(
        `INSERT INTO workspace_leases
          (id, created_at, updated_at, revision, project_id, resource_key, resource_kind, owner_kind,
           owner_id, host_instance_id, execution_version, state, lease_until, process_identity)
         VALUES (?, ?, ?, 1, ?, ?, 'workspace', 'attempt', ?, ?, ?, 'held', ?, NULL)`,
      ).run(randomUUID(), NOW, NOW, f.box.projectId, `f009-lease-${attempt.id}`, attempt.id,
        attempt.host_instance_id, attempt.execution_version, NOW + 60_000);
      expect(await planner.prepare({ ...base, workKey }))
        .toMatchObject({ status: 'rejected', reason: 'occupancy_unresolved' });
    } finally { f.box.close(); }
  }, 30_000);

  it('人审只认当前摘要：历史代码批准与解除阻塞不构成当前批准，也不触发重跑', async () => {
    const f = await prepareEligibleFixture();
    try {
      f.box.session.database.prepare(
        `UPDATE task_approval_items SET code_digest = ?, decision_code_digest = ? WHERE kind = 'approval'`,
      ).run('e'.repeat(64), 'e'.repeat(64));
      const planner = plannerFor(f);
      const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(f.ids.runId) as { work_key: string }).work_key;
      const before = historicalRows(f);
      const result = await planner.prepare({
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey,
      });
      expect(result.status).toBe('eligible');
      if (result.status !== 'eligible') throw new Error('unreachable');
      expect(result.plan.approval).toMatchObject({ valid: false, approvalItemId: null, reason: 'approval_identity_stale' });
      expect(result.plan.missingSteps).toContain('approval');
      expect((f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(1);
      expect(historicalRows(f)).toBe(before);
    } finally { f.box.close(); }
  }, 30_000);

  it('取消历史不会自动继续：只做显式只读资格重核，不改变终态 Run/Attempt', async () => {
    const f = await prepareEligibleFixture();
    try {
      markHistoricalRunTerminal(f, 'cancelled');
      const before = historicalRows(f);
      const planner = plannerFor(f);
      const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
        .get(f.ids.runId) as { work_key: string }).work_key;
      const result = await planner.prepare({
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey,
      });
      expect(result.status).toBe('eligible');
      if (result.status !== 'eligible') throw new Error('unreachable');
      expect(result.plan.historicalRunStatus).toBe('cancelled');
      expect(result.plan.missingSteps).toContain('commit');
      expect(historicalRows(f)).toBe(before);
    } finally { f.box.close(); }
  }, 30_000);
});
