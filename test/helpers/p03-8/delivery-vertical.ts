/** F-012 test assembly: real resources; no production Runtime/default changes.
 * Task check evidence uses the existing P03-7 seed; Feature checks run real Node.
 * Final resource reservation is explicit fixture setup: restore the stopped last
 * writer's lease rows after Task settlement, then use the real SQLite reader and
 * process census. This does not implement P03-9 recovery or automatic scheduling.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type Database from 'better-sqlite3';
import { openBindingFixture, BINDING_NOW } from '../p03-6/input-binding-fixture.ts';
import { seedApprovalWaitingVerification } from '../p03-7/approval-continue-seed.ts';
import { createLocalOwnerPrincipal } from '../p02-2/index.ts';
import { git } from '../git-repo.ts';
import { openCoreApplication, type WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createFeatureNodeVerificationExecutor } from '../../../packages/core/src/application/node-task-verification.ts';
import { createFeatureVerificationCoordinator } from '../../../packages/core/src/application/feature-verification.ts';
import { createControlledGitCommitService } from '../../../packages/core/src/application/controlled-git-commit.ts';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { evaluateTaskDag } from '../../../packages/core/src/application/task-dag.ts';
import { evaluateFeatureFinalApproval } from '../../../packages/core/src/application/feature-final-approval.ts';
import { verifyFeaturePlanApprovalInTransaction } from '../../../packages/core/src/application/plan-approval-verification.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { CommandTransaction } from '../../../packages/core/src/ports/atomic-commands.ts';
import type { GitCommitAuthorization } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import type { FeatureDeliveryDependencies } from '../../../packages/core/src/application/feature-delivery-commands.ts';
import type { VerificationPlan } from '../../../packages/core/src/application/verification-plan.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';
import type { WorkResourceIdentity } from '../../../packages/core/src/ports/work-resources.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { WorkspaceBaseline } from '../../../packages/core/src/ports/workspace.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import type { TaskApprovalItemRecord } from '../../../packages/core/src/ports/plan-store.ts';

const POLICY = 'ab'.repeat(32);
const nowUtcMs = () => BINDING_NOW;
const confirm = async (identity: { launchId: string }) => ({ launchId: identity.launchId });

export interface DeliveryVertical {
  fixture: Awaited<ReturnType<typeof openBindingFixture>>;
  core: CoreApplication;
  db: Database.Database;
  root: string;
  baseline: WorkspaceBaseline;
  initialHead: string;
  codeDigest: string;
  operationId: string;
  executionBatchId: string;
  owner: ReturnType<typeof createLocalOwnerPrincipal>;
  resourceIdentity: WorkResourceIdentity;
  operations: ReturnType<typeof createSqliteGitOperationStore>;
  dependencies: FeatureDeliveryDependencies;
  approve(): Promise<TaskApprovalItemRecord>;
  insertItem(kind?: 'approval' | 'block'): TaskApprovalItemRecord;
  submit(operation: string, payload: object, expectedRevision?: number, commandId?: string): Promise<CommandReceipt>;
  featureRevision(): number;
  finalize(commandId?: string): Promise<CommandReceipt>;
  query(): ReturnType<CoreApplication['queryService']['getFeatureDelivery']>;
  head(): string;
  diagnostics(): unknown[];
  counts(): { runtimeCalls: number; verificationCalls: number };
  afterVerify(callback: () => void): void;
  afterCommit(callback: () => void): void;
  hook(body: string): void;
  close(): Promise<void>;
}

export async function openDeliveryVertical(options: { brokenDownstream?: boolean; noChange?: boolean; taskCommits?: boolean; finalChanges?: boolean } = {}): Promise<DeliveryVertical> {
  const fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true,
    ...(options.taskCommits ? { deliveryPolicy: { commitMode: 'task_and_feature' as const,
      gitIdentity: { name: 'Confirmed User', email: 'confirmed@example.test', confirmed: true as const }, deliveryActions: ['commit'] as const } } : {}) });
  const db: Database.Database = fixture.session.database;
  const owner = createLocalOwnerPrincipal();
  const atomic = createSqliteAtomicCommandStore(fixture.session, { nowUtcMs });
  const processes = createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 });
  const operationId = randomUUID();
  const { projectId, featureId, runId } = fixture;
  const executionBatchId = (db.prepare('SELECT batch_id FROM runs WHERE id = ?').get(runId) as { batch_id: string }).batch_id;
  let dependencies: FeatureDeliveryDependencies;
  let runtimeCalls = 0;
  const workRuntimeFactory: WorkRuntimeFactory = context => {
    const make = (second: boolean) => createFakeWorkRuntimeFactory({
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      commandProcess: processes,
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: { schemaVersion: 1, steps: [
        ...(options.noChange ? [] : [{ op: 'write_file', path: second ? 'README.md' : 'src/upstream.ts', content: second ? 'downstream\n' : 'upstream\n' }]),
        ...(second && options.brokenDownstream ? [{ op: 'write_file', path: 'src/upstream.ts', content: 'broken\n' }] : []),
        { op: 'tool_command', name: 'probe' },
        { op: 'message', role: 'assistant', text: 'deterministic work complete' },
      ] },
    })(context);
    const first = make(false), second = make(true);
    return { ...first, entries: first.entries.map(entry => ({ ...entry, adapter: {
      async start(request: RuntimeExecutionRequest) {
        runtimeCalls += 1;
        const selected = request.identity.purpose === 'work' && request.identity.taskId === 't-2' ? second : first;
        return selected.entries[0]!.adapter.start(request);
      },
    } })) };
  };
  const core = await openCoreApplication({
    dataRoot: fixture.box.dataRoot, nowUtcMs,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
    ]),
    workRuntimeFactory,
    featureDeliveryFactory: (): FeatureDeliveryDependencies => ({
      verify: input => dependencies.verify(input), readIntent: input => dependencies.readIntent(input),
      commit: { commit: input => dependencies.commit.commit(input) },
      reconciliation: { reconcile: input => dependencies.reconciliation.reconcile(input) },
    }),
  });
  try {
    let resourceIdentity!: WorkResourceIdentity;
    for (const taskId of ['t-1', 't-2']) {
      const scan = await core.workExecution.scan();
      expect(scan.runs).toMatchObject([{ claimed: true }]);
      await expect.poll(() => core.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
      const attempt = db.prepare('SELECT id, owner_id, host_instance_id, execution_version FROM attempts WHERE task_id = ?').get(taskId) as {
        id: string; owner_id: string; host_instance_id: string; execution_version: number;
      };
      resourceIdentity = { projectId, attemptId: attempt.id, owner: attempt.owner_id,
        hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version };
      const leases = db.prepare('SELECT * FROM workspace_leases').all() as Record<string, unknown>[];
      expect(leases).toHaveLength(3);
      await seedApprovalWaitingVerification({ fixture, completion: core.taskVerificationCompletion, taskId, approvalItem: false });
      if (taskId === 't-2') {
        // Fixture-only final reservation. Never revive an old process or invoke Runtime.
        fixture.session.transactWrite('F012.reserve-final', () => {
          for (const row of leases) {
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO workspace_leases (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
          }
        });
      }
    }
    const managed = db.prepare('SELECT * FROM managed_workspaces').get() as {
      repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
      canonical_path: string; git_common_dir: string; branch: string; base_commit: string;
    };
    const root = managed.canonical_path;
    const baseline = { repositoryBindingId: managed.repository_binding_id, repositoryBindingRevision: managed.repository_binding_revision,
      repoIdentity: managed.repo_identity, canonicalPath: root, gitCommonDir: managed.git_common_dir,
      branch: managed.branch, baseCommit: managed.base_commit };
    const inspector = createWorkspaceInspector({ authorizedRoots: [fixture.box.root], confirmProcessIdentity: confirm });
    const operations = createSqliteGitOperationStore(fixture.session, { nowUtcMs });
    const stopped = createWorkResourceStopVerifier({ process: processes, finalize: async () => true });
    if (options.finalChanges) writeFileSync(join(root, 'src/final.ts'), 'export const final = true;\n');
    const initialInspection = await inspector.inspect(baseline);
    let verifiedInspection: WorkspaceInspection | null = null;
    let latestBatch: string | null = null;
    let verificationCalls = 0;
    let afterVerify: (() => void) | undefined;
    let afterCommit: (() => void) | undefined;
    const featureRevision = () => (db.prepare('SELECT revision FROM features WHERE id = ?').get(featureId) as { revision: number }).revision;
    const codeDigest = verificationCodeIdentity(initialInspection).codeDigest;
    let gitTransaction: CommandTransaction | undefined;
    const evaluateGate = (transaction: CommandTransaction) => evaluateFeatureFinalApproval(transaction,
      verifyFeaturePlanApprovalInTransaction(transaction, projectId, featureId), { codeDigest });
    const gate = () => gitTransaction ? evaluateGate(gitTransaction) : atomic.transact('F012.approval', evaluateGate);
    const intent = () => ({
      projectId, featureId, runId, operationId, attemptId: null, executionVersion: resourceIdentity.executionVersion,
      operationType: 'feature_final_commit' as const, repositoryBindingId: baseline.repositoryBindingId,
      repoIdentity: baseline.repoIdentity, worktreePath: root, expectedHead: initialInspection.repository.headCommit,
      codeDigest, verificationRefs: latestBatch ? [{ kind: 'verification_batch' as const, id: latestBatch, digest: codeDigest }] : [],
      approvalRefs: [], message: 'Deliver final verified Feature',
      gitIdentity: { name: 'Confirmed User', email: 'confirmed@example.test', confirmed: true as const },
      deliveryPolicyDigest: POLICY, runtimeSource: null, ownerId: resourceIdentity.owner,
      hostInstanceId: resourceIdentity.hostInstanceId, expectedFeatureRevision: featureRevision(),
    });
    const readAuthorization = (): GitCommitAuthorization => ({
      intent: intent(), baseline, resourceIdentity, allowedPaths: options.noChange ? [] : ['README.md', 'src/upstream.ts', ...(options.finalChanges ? ['src/final.ts'] : [])],
      verificationPassed: latestBatch !== null && core.verificationStore.getVerificationBatch(projectId, latestBatch).status === 'passed',
      approvalCurrent: gate().valid, finalApprovalCurrent: gate().valid, commitAuthorized: true,
    });
    const realGitDriver = createGitCommitDriver({ confirmProcessIdentity: confirm });
    const gitDeps = { operations, inspector, resources: core.workResources, stopVerifier: stopped,
      lock: createGitPublicMetadataLock(), driver: { open: (...args: Parameters<typeof realGitDriver.open>) => {
        const session = realGitDriver.open(...args);
        return { ...session, async commit(...commitArgs: Parameters<typeof session.commit>) {
          const result = await session.commit(...commitArgs);
          afterCommit?.();
          return result;
        } };
      } }, readAuthorization,
      transact: <T>(callback: () => T) => atomic.transact('F012.git', transaction => {
        gitTransaction = transaction;
        try { return callback(); } finally { gitTransaction = undefined; }
      }), nowMs: nowUtcMs, excludedPaths: ['.shiploop'] };
    const checkScript = options.noChange
      ? "const fs=require('node:fs');if(!fs.existsSync('README.md')||fs.existsSync('src/upstream.ts'))process.exitCode=1;console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:2,targets:['upstream','downstream']}));"
      : "const fs=require('node:fs');const ok=fs.readFileSync('src/upstream.ts','utf8')==='upstream\\n'&&fs.readFileSync('README.md','utf8')==='downstream\\n';console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:2,targets:['upstream','downstream']}));process.exitCode=ok?0:1;";
    const plan: VerificationPlan = {
      status: 'ready', mode: 'full_fallback', affectedModules: ['demo'], coveredModules: ['demo'],
      selectedCheckKeys: ['full'], selectedChecks: [{ checkKey: 'full', scope: 'project', kind: 'command',
        argv: [process.execPath, '-e', checkScript], cwdRef: '.', environmentRef: null, timeout: 5_000,
        required: true, requirementRefs: ['FR-2'] }], unselectedCheckKeys: [], reasonCode: 'candidate_missing',
      reason: 'confirmed complete demo checks', candidateDigest: null, candidateRejection: null,
    };
    const execute = createFeatureNodeVerificationExecutor({ processes, verification: createSqliteVerificationStore(fixture.session, { nowUtcMs }),
      atomic, artifacts: core.artifactStore, files: core.artifactFileStore, nowUtcMs,
      resolveCwd: async () => root, resolveEnvironment: () => ({}), confirmProcessIdentity: async () => {},
      resolveFeatureAttempt: () => ({ taskId: 't-2', attemptId: resourceIdentity.attemptId }),
    });
    const coordinator = createFeatureVerificationCoordinator({
      taskDag: { evaluate: () => {
        const view = createSqliteTaskDagStore(fixture.session).readTaskDagView(projectId, runId);
        const held = core.workResources.read(resourceIdentity);
        // Admission owns exactly these final leases. Other writers still block.
        const leaseCount = (db.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get() as { n: number }).n;
        const otherWriters = db.prepare("SELECT id FROM attempts WHERE status IN ('preparing', 'executing', 'verifying') LIMIT 1").get()
          || db.prepare("SELECT id FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL LIMIT 1").get();
        return evaluateTaskDag({ ...view, resourceBusy: leaseCount !== held.leases.length || Boolean(otherWriters) }, BINDING_NOW);
      } },
      resources: core.workResources, stopVerifier: stopped, workspace: inspector, execute,
      withResource: async (_identity, callback) => { expect(core.workResources.read(resourceIdentity).leases).toHaveLength(3); return callback(); },
      buildPlan: () => plan,
    });
    dependencies = {
      readIntent: () => intent(), commit: createControlledGitCommitService(gitDeps),
      reconciliation: createGitCommitReconciliationService({ ...gitDeps, readVerificationInspection: () => verifiedInspection }),
      async verify() {
        verificationCalls += 1;
        const result = await coordinator.run({ projectId, featureId, runId, batchId: randomUUID(),
          executionVersion: resourceIdentity.executionVersion, resourceIdentity, workspaceBaseline: baseline,
          policy: {}, policyDigest: POLICY, environmentSummary: { node: process.version }, targets: ['upstream', 'downstream'] });
        latestBatch = result.batchId;
        if (result.status === 'passed') verifiedInspection = await inspector.inspect(baseline);
        afterVerify?.();
        return { passed: result.status === 'passed', reason: result.reason };
      },
    };
    const submit = (operation: string, payload: object, expectedRevision = featureRevision(), commandId: string = randomUUID()) =>
      core.commandService.submit(owner, { schemaVersion: 5, commandId, issuedAt: new Date(BINDING_NOW).toISOString(),
        operation, scope: { kind: 'project', projectId }, expectedRevision, payload });
    const insertItem = (kind: 'approval' | 'block' = 'approval') => atomic.transact('F012.item', transaction =>
      transaction.insertTaskApprovalItem({ projectId, featureId, taskId: 't-1', kind, description: 'final human review',
        responsibleParty: 'owner', planDigest: transaction.getFeaturePlan(projectId, featureId).feature.planDigest!,
        codeDigest, artifactRefs: [], createdBy: owner.principalId }).record);
    async function approve() {
      const item = insertItem();
      const result = await submit('task.approval.approve', { taskId: 't-1', itemId: item.id,
        planDigest: item.planDigest, codeDigest, artifactRefs: [], reason: 'approved final source' }, item.revision);
      expect(result.status, JSON.stringify(result)).toBe('completed');
      return item;
    }
    return { fixture, core, db, root, baseline, initialHead: initialInspection.repository.headCommit, codeDigest, operationId, executionBatchId, owner, resourceIdentity,
      operations, dependencies, approve, insertItem, submit, featureRevision,
      finalize: (commandId = randomUUID()) => submit('feature.verification.continue', { featureId, runId, batchId: executionBatchId, operationId }, featureRevision(), commandId),
      query: () => core.queryService.getFeatureDelivery(owner, { projectId, featureId }),
      head: () => git(['rev-parse', 'HEAD'], root).trim(),
      diagnostics: () => db.prepare("SELECT b.status AS batch_status, r.* FROM verification_batches b LEFT JOIN check_results r ON r.batch_id = b.id WHERE b.operation = 'FeatureVerification.full'").all(),
      counts: () => ({ runtimeCalls, verificationCalls }),
      afterVerify(callback: () => void) { afterVerify = callback; },
      afterCommit(callback: () => void) { afterCommit = callback; },
      hook(body: string) {
        const hooks = join(baseline.gitCommonDir, 'hooks'); mkdirSync(hooks, { recursive: true });
        const path = join(hooks, 'pre-commit'); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755);
      },
      async close() {
        expect(await core.workExecution.close()).toMatchObject({ closed: true, pendingAttemptIds: [] });
        core.close(); fixture.close();
      },
    };
  } catch (error) {
    await core.workExecution.close(); core.close(); fixture.close(); throw error;
  }
}
