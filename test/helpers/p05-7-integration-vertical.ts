import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createIntegrationGitWorkspace } from '../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import { createDeterministicIntegrationService } from '../../packages/core/src/application/deterministic-integration.ts';
import { createSqliteGitOperationStore } from '../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteGitIntegrationJournal } from '../../packages/core/src/adapters/sqlite/git-integration-journal.ts';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../../packages/core/src/ports/integration-execution-plan.ts';
import type { IntegrationWorkspaceAdapter } from '../../packages/core/src/ports/integration-workspace.ts';
import { normalizeFeatureResourceSet } from '../../packages/core/src/ports/feature-resources.ts';
import type { DeterministicIntegrationService } from '../../packages/core/src/application/deterministic-integration.ts';
import type { GitOperationRegisterInput, GitOperationStore } from '../../packages/core/src/ports/git-operations.ts';
import type { IntegrationExecutionPlan } from '../../packages/core/src/ports/integration-execution-plan.ts';
import type { FeatureResourceLeaseRecord, FeatureResourceSet } from '../../packages/core/src/ports/feature-resources.ts';
import { openBudgetFixture, NOW } from './p03-3/budget-fixture.ts';
import type { BudgetFixture } from './p03-3/budget-fixture.ts';

export const sha = (letter: string): string => letter.repeat(40);
export const digest = (letter: string): string => letter.repeat(64);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  }).trim();
}

function freezeSource(
  box: Awaited<ReturnType<typeof openBudgetFixture>>,
  plan: ReturnType<typeof createIntegrationExecutionPlan>,
) {
  const predecessorRevisions: Record<string, number> = {};
  for (const predecessor of plan.predecessors) {
    box.session.database.prepare(`INSERT OR IGNORE INTO features
      (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', 'approved', '[]', '[]', 'succeeded')`)
      .run(predecessor.featureId, NOW, box.projectId, NOW, plan.phaseId, predecessor.featureId);
    predecessorRevisions[predecessor.featureId] = 1;
  }
  const frozen = box.atomic.transact('f008-freeze-source', tx => {
    const source = tx.createIntegrationPlan({
      projectId: plan.projectId,
      phaseId: plan.phaseId,
      batchId: plan.batchId,
      successorFeatureId: plan.successorFeatureId,
      targetBaseline: plan.target.baseCommit,
      predecessors: plan.predecessors.map(predecessor => ({
        projectId: predecessor.projectId,
        phaseId: predecessor.phaseId,
        featureId: predecessor.featureId,
        dependencyPassed: predecessor.dependencyPassed,
        coveredInputIds: predecessor.coveredInputIds,
        ancestorVerified: true,
        delivery: {
          commitSha: predecessor.delivery!.commitSha,
          evidenceId: predecessor.delivery!.evidenceId,
          evidenceDigest: predecessor.delivery!.evidenceDigest,
        },
      })),
      approvedInputs: plan.approvedInputs,
      mergeOrder: plan.mergeOrder,
      verificationScope: plan.verificationScope,
      strategySummary: {},
      integrationResult: null,
    });
    return tx.freezeIntegrationPlan({
      projectId: plan.projectId,
      integrationId: source.integrationId,
      expectedRevision: source.revision,
    });
  });
  return { sourcePlanId: frozen.integrationId, sourcePlanRevision: frozen.revision, predecessorRevisions };
}

export interface IntegrationVerticalFixture {
  readonly box: BudgetFixture;
  readonly plan: IntegrationExecutionPlan;
  readonly intent: GitOperationRegisterInput;
  readonly request: {
    projectId: string;
    operationId: string;
    commandId: string;
    expectedFeatureRevision: number;
    inputDigest: string;
  };
  readonly authorization: {
    intent: GitOperationRegisterInput;
    approvalCurrent: boolean;
    budgetAllowed: boolean;
    ownerVersion: number;
    resourceSet: FeatureResourceSet;
    leases: FeatureResourceLeaseRecord[];
    writerIdentity: Readonly<Record<string, unknown>>;
  };
  readonly operations: GitOperationStore;
  readonly calls: string[];
  service(workspace?: IntegrationWorkspaceAdapter): DeterministicIntegrationService;
  setStopped(value: boolean): void;
  close(): void;
}

export async function openIntegrationFixture(budget?: import('../../packages/core/src/ports/execution-budget.ts').ExecutionBudgetProposal): Promise<IntegrationVerticalFixture> {
  const box = await openBudgetFixture(budget);
  const ids = await box.start();
  const binding = box.atomic.transact('f008-read-binding', tx => tx.getRepositoryBinding(box.projectId));
  const feature = box.atomic.transact('f008-read-feature', tx => tx.getFeaturePlan(box.projectId, box.featureId).feature);
  const approvedInputs = [{ inputId: 'input-a', digest: digest('a') }];
  const plan = createIntegrationExecutionPlan({
    projectId: box.projectId,
    phaseId: feature.phaseId,
    batchId: ids.batchId,
    runId: ids.runId,
    successorFeatureId: box.featureId,
    target: {
      baseCommit: sha('b'),
      repoIdentity: binding.repoIdentity,
      canonicalPath: binding.canonicalPath,
      gitCommonDir: binding.gitCommonDir,
    },
    approvedInputs,
    mergeOrder: ['predecessor-a'],
    verificationScope: ['combined-tests'],
    integrationResult: null,
    predecessors: [{
      projectId: box.projectId,
      phaseId: feature.phaseId,
      batchId: ids.batchId,
      runId: ids.runId,
      featureId: 'predecessor-a',
      dependencyPassed: true,
      coveredInputIds: ['input-a'],
      delivery: {
        commitSha: sha('c'),
        repoIdentity: binding.repoIdentity,
        inputDigest: computeCoveredInputDigest(approvedInputs),
        evidenceId: 'delivery-a',
        evidenceDigest: digest('d'),
      },
    }],
  });
  const intent = {
    operationId: plan.integrationId,
    projectId: box.projectId,
    featureId: box.featureId,
    runId: ids.runId,
    attemptId: null,
    executionVersion: 1,
    operationType: 'integration' as const,
    repositoryBindingId: binding.id,
    repoIdentity: binding.repoIdentity,
    worktreePath: join(box.box.root, 'integration'),
    expectedHead: plan.target.baseCommit,
    candidateTree: plan.target.baseCommit,
    codeDigest: plan.inputDigest,
    verificationRefs: [],
    approvalRefs: [],
    message: 'integration',
    gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true as const },
    deliveryPolicyDigest: digest('e'),
    runtimeSource: null,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    integrationPlan: plan,
    budgetSnapshot: { ownerVersion: 1, ...freezeSource(box, plan) },
    expectedFeatureRevision: feature.revision,
  };
  const resourceSet = normalizeFeatureResourceSet({
    projectId: box.projectId,
    resources: [
      { projectId: box.projectId, kind: 'feature_code_shared', key: 'feature-code' },
      { projectId: box.projectId, kind: 'worktree_write_exclusive', key: `worktree:${plan.integrationId}` },
    ],
  });
  const authorization = {
    intent,
    approvalCurrent: true,
    budgetAllowed: true,
    ownerVersion: 1,
    resourceSet,
    leases: resourceSet.resources.map(resource => ({
      id: randomUUID(),
      projectId: box.projectId,
      resource,
      ownerId: intent.ownerId,
      ownerVersion: 1,
      revision: 1,
      acquiredAtUtcMs: NOW,
      leaseUntilUtcMs: NOW + 100_000,
      state: 'held' as const,
      waitingReason: null,
      releasedAtUtcMs: null,
    })),
    writerIdentity: { launchId: 'old-writer' },
  };
  const request = {
    projectId: box.projectId,
    operationId: plan.integrationId,
    commandId: randomUUID(),
    expectedFeatureRevision: feature.revision,
    inputDigest: plan.inputDigest,
  };
  let stopped = true;
  const calls: string[] = [];
  const operations = createSqliteGitOperationStore(box.session);
  const service = (workspace: IntegrationWorkspaceAdapter = createIntegrationGitWorkspace({
    confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
  })) => createDeterministicIntegrationService({
    atomic: box.atomic,
    journal: createSqliteGitIntegrationJournal(box.session, { nowUtcMs: () => NOW + 1 }),
    workspace: {
      ...workspace,
      async prepare(input) {
        calls.push('prepare');
        return workspace.prepare(input);
      },
      async merge(input) {
        calls.push('merge');
        return workspace.merge(input);
      },
    },
    readAuthorization: () => structuredClone(authorization),
    verifyWriterStopped: async () => stopped,
    nowUtcMs: () => NOW + 1,
  });
  return {
    box,
    plan,
    intent,
    request,
    authorization,
    operations,
    calls,
    service,
    setStopped(value: boolean) { stopped = value; },
    close() { box.close(); },
  };
}

export function createRealInputs(
  fixture: Awaited<ReturnType<typeof openIntegrationFixture>>,
  conflict = false,
) {
  const repo = fixture.plan.target.canonicalPath;
  const base = git(repo, 'rev-parse', 'HEAD');
  const shas = ['a', 'b'].map(letter => {
    const path = join(fixture.box.box.root, `f008-predecessor-${letter}`);
    git(repo, 'worktree', 'add', '--detach', path, base);
    writeFileSync(join(path, conflict ? 'shared.txt' : `${letter}.txt`), `${letter}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-m', `independent ${letter}`);
    const commit = git(path, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'remove', path);
    return commit;
  });
  const inputs = ['a', 'b'].map(letter => ({ inputId: `input-${letter}`, digest: digest(letter) }));
  const { schemaVersion: _schema, integrationId: _id, inputDigest: _inputDigest, status: _status, ...planInput } = fixture.plan;
  const plan = createIntegrationExecutionPlan({
    ...planInput,
    target: { ...planInput.target, baseCommit: base },
    approvedInputs: inputs,
    mergeOrder: ['predecessor-a', 'predecessor-b'],
    predecessors: shas.map((commitSha, index) => ({
      ...planInput.predecessors[0]!,
      featureId: `predecessor-${index === 0 ? 'a' : 'b'}`,
      coveredInputIds: [inputs[index]!.inputId],
      delivery: {
        ...planInput.predecessors[0]!.delivery!,
        commitSha,
        inputDigest: computeCoveredInputDigest([inputs[index]!]),
      },
    })),
  });
  const source = freezeSource(fixture.box, plan);
  fixture.authorization.intent = {
    ...fixture.intent,
    operationId: plan.integrationId,
    integrationPlan: plan,
    expectedHead: base,
    candidateTree: base,
    codeDigest: plan.inputDigest,
    budgetSnapshot: { ownerVersion: 1, ...source },
  };
  fixture.authorization.resourceSet = normalizeFeatureResourceSet({
    projectId: fixture.box.projectId,
    resources: [
      { projectId: fixture.box.projectId, kind: 'feature_code_shared', key: 'feature-code' },
      { projectId: fixture.box.projectId, kind: 'worktree_write_exclusive', key: `worktree:${plan.integrationId}` },
    ],
  });
  fixture.authorization.leases = fixture.authorization.resourceSet.resources.map(resource => ({
    ...fixture.authorization.leases[0]!, id: randomUUID(), resource,
  }));
  fixture.request.operationId = plan.integrationId;
  fixture.request.inputDigest = plan.inputDigest;
  return { repo, base, shas, inputs, plan, path: fixture.intent.worktreePath };
}

export function writeEvidence(path: string, input: {
  readonly scenario: string;
  readonly repo: string;
  readonly targetBase: string;
  readonly inputShas: readonly string[];
  readonly commandResults: readonly { readonly argv: readonly string[]; readonly exitCode: number }[];
  readonly sqlite: Readonly<Record<string, unknown>>;
  readonly evidencePath: string;
}): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...input }, null, 2) + '\n', 'utf8');
}
