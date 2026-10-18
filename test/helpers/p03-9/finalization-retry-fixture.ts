/**
 * P03-9 / F-010 finalization-only retry 测试夹具。
 *
 * 复用真实临时 Git/SQLite/Artifact：Task 通过证据、最终检查批次、当前审批和
 * 受管 worktree 均落真实行；F-009 planner 与 F-010 命令使用同一生产服务。
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteExecutionResumeFactsReader } from '../../../packages/core/src/adapters/sqlite/execution-resume.ts';
import { createSqliteFeatureDeliveryQueryStore } from '../../../packages/core/src/adapters/sqlite/feature-delivery-query-store.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteTaskEvidenceQueryStore } from '../../../packages/core/src/adapters/sqlite/task-evidence-query-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createFinalizationRetryPlanner } from '../../../packages/core/src/application/finalization-retry.ts';
import { createFinalizationRetryExecutionService } from '../../../packages/core/src/application/finalization-retry-execution.ts';
import { createTaskDagService } from '../../../packages/core/src/application/task-dag.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { AttemptRecord } from '../../../packages/core/src/ports/attempt-store.ts';
import type { ArtifactRecord } from '../../../packages/core/src/ports/artifact-store.ts';
import type { ExecutionBudgetProposal } from '../../../packages/core/src/ports/execution-budget.ts';
import type {
  FinalizationRetryCommandPayload,
  FinalizationRetryExecutionPort,
} from '../../../packages/core/src/ports/finalization-retry.ts';
import type { CheckDefinition } from '../../../packages/core/src/ports/task-verification-policy.ts';
import type { TaskClaimInput, TaskClaimStore } from '../../../packages/core/src/ports/task-claim.ts';
import type { TaskDagResult } from '../../../packages/core/src/ports/task-dag.ts';
import type { VerifiedWorkWorkspace } from '../../../packages/core/src/ports/work-resources.ts';
import { git } from '../git-repo.ts';
import { BUDGET, NOW, openBudgetFixture } from '../p03-3/budget-fixture.ts';
import type { BudgetFixture } from '../p03-3/budget-fixture.ts';
import { publishPreparedInputFixture } from '../p03-4/task-dag-state-fixture.ts';

const stopVerifier = createWorkResourceStopVerifier({
  process: { recoverStop: async () => ({ confirmed: true }) },
  finalize: async () => true,
});

export interface FinalizationFixtureOptions {
  readonly taskCount?: number;
  readonly budget?: ExecutionBudgetProposal;
  readonly terminalStatus?: 'failed' | 'cancelled' | null;
}

export interface FinalizationFixture {
  readonly box: BudgetFixture;
  readonly ids: { projectId: string; batchId: string; runId: string; taskId: string };
  readonly budget: ExecutionBudgetProposal;
  readonly workspace: VerifiedWorkWorkspace;
  readonly lifecycle: ReturnType<typeof createSqliteAttemptLifecycleStore>;
  readonly resources: ReturnType<typeof createSqliteWorkResourceAccess>;
  store(): TaskClaimStore;
  input(index?: number): TaskClaimInput;
  evaluate(): TaskDagResult;
}

export interface EligibleFinalizationFixture extends FinalizationFixture {
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly publisher: ReturnType<typeof createArtifactPublisher>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly inspection: Awaited<ReturnType<ReturnType<typeof createWorkspaceInspector>['inspect']>>;
  readonly workspaceId: string;
  readonly approvalId: string;
}

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

function currentPlanDigest(f: FinalizationFixture): string {
  return (f.box.session.database.prepare('SELECT plan_digest FROM features WHERE id = ?')
    .get(f.box.featureId) as { plan_digest: string }).plan_digest;
}

async function requireCompleted(promise: Promise<{ status: string }>, label: string): Promise<void> {
  const receipt = await promise;
  if (receipt.status !== 'completed') throw new Error(`${label} failed: ${JSON.stringify(receipt)}`);
}

async function createProjectPolicy(
  f: FinalizationFixture,
  definitions: readonly CheckDefinition[],
): Promise<void> {
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

async function approveCurrentPlan(f: FinalizationFixture): Promise<void> {
  const featureRow = f.box.session.database.prepare(
    'SELECT plan_digest, revision FROM features WHERE id = ?',
  ).get(f.box.featureId) as { plan_digest: string; revision: number };
  await requireCompleted(f.box.submit('feature.plan.decide', {
    featureId: f.box.featureId,
    planDigest: featureRow.plan_digest,
    decision: 'approve',
    reason: 'F-010 current check policy re-approval',
  }, { scope: f.box.scope, expectedRevision: featureRow.revision }), 'feature.plan.decide');
}

async function publishJson(
  f: FinalizationFixture,
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

function seedVerificationBatch(f: FinalizationFixture, input: SeedBatchInput): void {
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
  const policyDigest = input.attempt.inputSnapshot.approval.checkPolicyDigest;
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
    JSON.stringify({ schemaVersion: 1, mode: 'full_fallback', reason: 'f010 fixture', selectedCheckKeys: [input.checkKey] }),
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

function insertApprovalItem(
  f: FinalizationFixture,
  taskId: string,
  codeDigest: string,
  status: 'approved' | 'pending' | 'rejected',
): string {
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
  f: FinalizationFixture,
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
  f.box.session.transactWrite('f010.launch', () => {
    createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt.projectId,
      batchId: f.ids.batchId,
      runId: attempt.runId,
      startKey: attempt.id,
    });
    f.resources.beginLaunchInTransaction(identity);
    f.resources.confirmLaunchInTransaction(identity, {
      launchId: randomUUID(),
      pid: 4_700 + index,
      processGroupId: 4_700 + index,
      startTime: `f010-start-${index}`,
    });
  });
  f.lifecycle.apply({ ...notification, notificationId: 'started', kind: 'executing' });
  const token = await stopVerifier.verify(f.resources.read(identity));
  const completed = f.lifecycle.apply({
    ...notification,
    notificationId: 'complete',
    kind: 'runtime_completed',
    exitCode: 0,
    evidenceRef: attempt.inputRef,
  }, token);
  if (completed.status !== 'verifying') {
    throw new Error(`fixture verification advance failed: ${JSON.stringify(completed)}`);
  }

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
  const verification = f.lifecycle.submitVerification({
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
  if (verification.status !== 'succeeded') {
    throw new Error(`fixture task pass failed: ${JSON.stringify(verification)}`);
  }
  return attempt;
}

function insertManagedWorkspace(f: FinalizationFixture, attempt: AttemptRecord): string {
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

function workspaceBaseline(f: FinalizationFixture) {
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

export async function openFinalizationFixture(
  options: FinalizationFixtureOptions = {},
): Promise<FinalizationFixture> {
  const taskCount = options.taskCount ?? 1;
  const budget = options.budget ?? BUDGET;
  const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = budget.batch;
  const box = await openBudgetFixture({ ...budget, batch }, Array.from({ length: taskCount }, (_, index) => ({
    id: `t-${index + 1}`,
    title: `Task ${index + 1}`,
    acceptance: { criteria: ['finalization retry'] },
    dependsOn: [] as string[],
  })));
  const ids = await box.start();
  const snapshots = Array.from({ length: taskCount }, (_, index) =>
    publishPreparedInputFixture(box, ids, `t-${index + 1}`));
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.box.root] });
  const binding = createSqliteStateAccess(box.session).getRepositoryBinding(box.projectId);
  const workspace = await authority.verify(binding, box.box.repoDirA);
  const lifecycle = createSqliteAttemptLifecycleStore(box.session, {
    workspaceAuthority: authority,
    nowUtcMs: () => NOW + 1,
    stopVerifier,
  });
  const resources = createSqliteWorkResourceAccess(box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
  return {
    box,
    ids,
    budget,
    workspace,
    lifecycle,
    resources,
    store: () => createSqliteTaskClaimStore(box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW }),
    input: (index = 0): TaskClaimInput => ({
      claimKey: `claim-${index + 1}`,
      projectId: box.projectId,
      runId: ids.runId,
      taskId: `t-${index + 1}`,
      owner: 'owner-1',
      hostInstanceId: 'host-1',
      expectedRevision: 1,
      executionVersion: 0,
      workspace,
      leaseUntilUtcMs: NOW + 1000,
      inputSnapshot: snapshots[index]!,
    }),
    evaluate: (): TaskDagResult => createTaskDagService({
      store: createSqliteTaskDagStore(box.session),
      nowMs: () => NOW,
    }).evaluate(box.projectId, ids.runId),
  };
}

export async function prepareEligibleFixture(
  options: FinalizationFixtureOptions = {},
): Promise<EligibleFinalizationFixture> {
  const f = await openFinalizationFixture(options);
  const taskCount = options.taskCount ?? 1;
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
  const definitions = taskCount === 2
    ? [decisionDefinition('tests', ['node', '--test', 'a']), decisionDefinition('lint', ['node', 'lint'])]
    : [decisionDefinition('tests')];
  const attempts: AttemptRecord[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const checkKey = taskCount === 2 ? (index === 0 ? 'tests' : 'lint') : 'tests';
    const definition = definitions[index]!;
    attempts.push(await claimAndPass(f, publisher, index, checkKey, definition.argv, inspection.codeDigest));
  }
  const workspaceId = insertManagedWorkspace(f, attempts[0]!);
  const withWorkspace: EligibleFinalizationFixture = {
    ...f,
    artifacts,
    publisher,
    verifier,
    inspection,
    workspaceId,
    approvalId: '',
  };

  await createProjectPolicy(withWorkspace, definitions);
  await approveCurrentPlan(withWorkspace);

  const featureOutput = await publishJson(withWorkspace, publisher, 'feature_verification_output', {
    schemaVersion: 1,
    checkKey: definitions[0]!.checkKey,
    codeDigest: inspection.codeDigest,
    status: 'passed',
  });
  seedVerificationBatch(withWorkspace, {
    attempt: attempts[0]!,
    taskId: attempts[0]!.taskId,
    batchId: `feature-${randomUUID()}`,
    operation: 'FeatureVerification.full',
    checkKey: definitions[0]!.checkKey,
    argv: definitions[0]!.argv,
    codeDigest: inspection.codeDigest,
    outputArtifactId: featureOutput.id,
    outputDigest: featureOutput.contentHash!,
  });
  const approvalId = insertApprovalItem(withWorkspace, attempts[0]!.taskId, inspection.codeDigest, 'approved');
  if (options.terminalStatus !== null) {
    const status = options.terminalStatus ?? 'failed';
    f.box.session.database.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
      .run(status, NOW + 5, f.ids.runId);
    f.box.session.database.prepare('UPDATE execution_batches SET status = ? WHERE id = ?')
      .run(status, f.ids.batchId);
  }
  return { ...withWorkspace, approvalId };
}

export function plannerFor(f: EligibleFinalizationFixture) {
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

export interface RetryCommands {
  readonly service: FinalizationRetryExecutionPort;
  readonly signals: { projectId: string; batchId: string; runId: string; featureId: string }[];
  submit(
    commandId: string,
    payload: FinalizationRetryCommandPayload,
  ): Promise<import('../../../packages/core/src/ports/commands.ts').CommandReceipt>;
}

export function retryCommandsFor(f: EligibleFinalizationFixture): RetryCommands {
  const service = createFinalizationRetryExecutionService({
    planner: plannerFor(f),
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
    nowMs: () => NOW,
  });
  const signals: { projectId: string; batchId: string; runId: string; featureId: string }[] = [];
  const commands = createCommandService({
    atomicStore: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW }),
    finalizationRetry: service,
    executionDispatchSignal: { signalRunDispatched: input => { signals.push(input); } },
    nowUtcMs: () => NOW,
  });
  const owner = createLocalOwnerPrincipal();
  return {
    service,
    signals,
    submit: (commandId, payload) => commands.submit(owner, {
      schemaVersion: 5,
      commandId,
      issuedAt: new Date(NOW).toISOString(),
      operation: 'execution.retryFinal',
      scope: f.box.scope,
      payload,
    } as import('../../../packages/core/src/ports/commands.ts').ValidatedCommandEnvelope),
  };
}

export function retryPayload(f: EligibleFinalizationFixture): FinalizationRetryCommandPayload {
  const workKey = (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
    .get(f.ids.runId) as { work_key: string }).work_key;
  return {
    featureId: f.box.featureId,
    historicalRunId: f.ids.runId,
    workKey,
  };
}

export function historicalRunWorkKey(f: EligibleFinalizationFixture, runId: string): string {
  return (f.box.session.database.prepare('SELECT work_key FROM runs WHERE id = ?')
    .get(runId) as { work_key: string }).work_key;
}

export function businessRows(f: FinalizationFixture): string {
  const tables = [
    'runs', 'execution_batches', 'attempts', 'tasks', 'verification_batches', 'check_results',
    'task_approval_items', 'managed_workspaces', 'batch_budget_revisions',
  ];
  return JSON.stringify(Object.fromEntries(tables.map(table => [
    table,
    f.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ])));
}

export function tableRows<T = Record<string, unknown>>(f: FinalizationFixture, sql: string, ...params: unknown[]): T[] {
  return f.box.session.database.prepare(sql).all(...params) as T[];
}

export function row<T = Record<string, unknown>>(f: FinalizationFixture, sql: string, ...params: unknown[]): T | undefined {
  return f.box.session.database.prepare(sql).get(...params) as T | undefined;
}

/** 故意制造当前源码漂移，供 needs-revalidation 场景使用。 */
export function changeSource(f: EligibleFinalizationFixture): void {
  writeFileSync(join(f.box.box.repoDirA, 'src/a.ts'), 'export const project = "changed-after-pass";\n');
}
