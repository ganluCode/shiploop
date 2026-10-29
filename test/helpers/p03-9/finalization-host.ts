/**
 * P03-9 / F-017 finalization-only Host 纵向测试装配。
 *
 * 仅测试使用：把真实的 finalization 执行/收尾服务注入真实 Host，检查命令仍经
 * HostClient/CLI 授权通道。检查执行使用确定性的受信 Verifier（真实
 * SQLite/Artifact，不调用模型）；F-011 的真实 Node Verifier 已单独覆盖。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FinalizationCompletionPort } from '../../../packages/core/src/ports/finalization-completion.ts';
import type {
  FinalizationExecutionPort,
  FinalizationTaskRevalidationInput,
  FinalizationFeatureVerificationInput,
  FinalizationVerifier,
  FinalizationVerificationEvidence,
  FinalizationCheckEvidence,
} from '../../../packages/core/src/ports/finalization-execution.ts';
import { FEATURE_VERIFICATION_OPERATION } from '../../../packages/core/src/ports/feature-verification.ts';
import { FINALIZATION_TASK_VERIFICATION_OPERATION } from '../../../packages/core/src/ports/finalization-execution.ts';
import type { CheckDefinition } from '../../../packages/core/src/ports/task-verification-policy.ts';
import type { WorkspaceBaseline } from '../../../packages/core/src/ports/workspace.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteExecutionResumeFactsReader } from '../../../packages/core/src/adapters/sqlite/execution-resume.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFinalizationExecutionService } from '../../../packages/core/src/application/finalization-execution.ts';
import { createFinalizationCompletionService } from '../../../packages/core/src/application/finalization-completion.ts';
import { createFinalizationGitDelivery } from '../../../packages/core/src/application/finalization-git-delivery.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { startHost } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import { BUDGET, NOW } from '../p03-3/budget-fixture.ts';
import {
  plannerFor,
  type EligibleFinalizationFixture,
} from './finalization-retry-fixture.ts';

const GIT_IDENTITY = { name: 'Confirmed User', email: 'confirmed@example.test', confirmed: true as const };
const DELIVERY_POLICY = 'cd'.repeat(32);
const MESSAGE = 'Deliver final verified Feature';
const PROVIDERS = [{ providerId: 'fake-provider', models: ['fake-model'] }];
const FAKE_SCRIPT = {
  schemaVersion: 1 as const,
  steps: [{ op: 'message' as const, role: 'assistant' as const, text: 'F-017 must not start coding' }],
  result: { terminal: 'completed' as const, reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
};

export type FinalizationEvidenceStatus = 'passed' | 'failed' | 'inconclusive';

export interface FinalizationBehavior {
  readonly revalidate?: FinalizationEvidenceStatus;
  readonly feature?: FinalizationEvidenceStatus;
  readonly onRevalidate?: (input: FinalizationTaskRevalidationInput) => void;
  readonly onFeature?: (input: FinalizationFeatureVerificationInput) => void;
}

export interface FinalizationPorts {
  readonly execution: FinalizationExecutionPort;
  readonly completion: FinalizationCompletionPort;
  readonly calls: {
    readonly revalidate: FinalizationTaskRevalidationInput[];
    readonly feature: FinalizationFeatureVerificationInput[];
  };
  setBehavior(next: Partial<FinalizationBehavior>): void;
}

export interface FinalizationHost {
  readonly host: RunningHost;
  readonly starts: Array<{ attemptId: string | null; invocationId: string }>;
}

function retryBudget(maxRuns = 4, maxNoProgressRuns = Math.max(maxRuns, 1)) {
  return {
    ...BUDGET,
    batch: {
      ...BUDGET.batch,
      maxRuns,
      maxTotalAttempts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxRuntimeStarts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxNoProgressRuns,
    },
  };
}

export function defaultCheckDefinitions(): readonly CheckDefinition[] {
  return [{
    checkKey: 'tests',
    scope: 'task',
    kind: 'command',
    argv: ['node', '--test'],
    cwdRef: null,
    environmentRef: null,
    timeout: 60_000,
    required: true,
    requirementRefs: [],
  }];
}

export function fixtureBudget(maxRuns = 4, maxNoProgressRuns?: number) {
  return retryBudget(maxRuns, maxNoProgressRuns);
}

async function publishJson(f: EligibleFinalizationFixture, kind: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  return (await f.publisher.publishArtifact({
    projectId: f.box.projectId,
    kind,
    mediaType: 'application/json',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `evidence/f017-${randomUUID()}.json`,
    content: [body],
  })).artifact;
}

function attemptForTask(f: EligibleFinalizationFixture, taskId: string) {
  const attempts = createSqliteAttemptAccess(f.box.session);
  return [...attempts.listTaskAttempts(f.box.projectId, taskId)]
    .sort((left, right) => left.number - right.number)
    .at(-1);
}

function anchorAttempt(f: EligibleFinalizationFixture, featureId: string) {
  const row = f.box.session.database.prepare(
    'SELECT task_id, run_id FROM attempts WHERE project_id = ? AND feature_id = ? ORDER BY number DESC LIMIT 1',
  ).get(f.box.projectId, featureId) as { task_id: string; run_id: string } | undefined;
  if (row === undefined) throw new Error('F-017 missing feature anchor attempt');
  const attempt = attemptForTask(f, row.task_id);
  if (attempt === undefined || attempt.runId !== row.run_id) {
    throw new Error('F-017 feature anchor attempt mismatch');
  }
  return attempt;
}

function definitionsFor(
  definitions: readonly CheckDefinition[],
  input: FinalizationTaskRevalidationInput | FinalizationFeatureVerificationInput,
): readonly CheckDefinition[] {
  const selected = input.checkKeys.map(checkKey => definitions.find(definition => definition.checkKey === checkKey));
  if (selected.some(definition => definition === undefined)) {
    throw new Error(`F-017 missing check definition for ${input.checkKeys.join(',')}`);
  }
  return selected as CheckDefinition[];
}

async function recordEvidence(
  f: EligibleFinalizationFixture,
  definitions: readonly CheckDefinition[],
  input: FinalizationTaskRevalidationInput | FinalizationFeatureVerificationInput,
  operation: string,
  status: FinalizationEvidenceStatus,
  nowUtcMs: number,
): Promise<FinalizationVerificationEvidence> {
  const attempt = 'taskId' in input
    ? attemptForTask(f, input.taskId)
    : anchorAttempt(f, input.featureId);
  if (attempt === undefined) throw new Error('F-017 missing finalization anchor attempt');
  const selected = definitionsFor(definitions, input);
  const batchId = randomUUID();
  const verification = createSqliteVerificationStore(f.box.session, { nowUtcMs: () => nowUtcMs });
  const atomic = createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => nowUtcMs });
  const checks: FinalizationCheckEvidence[] = [];
  for (const definition of selected) {
    const resultStatus = status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'not_run';
    const output = await publishJson(f, 'verification_output', {
      schemaVersion: 1,
      checkKey: definition.checkKey,
      codeDigest: input.codeDigest,
      status: resultStatus,
    });
    checks.push({
      checkKey: definition.checkKey,
      status: resultStatus,
      resultId: randomUUID(),
      outputArtifactId: output.id,
      testCount: status === 'passed' ? 2 : null,
    });
  }
  atomic.transact('F017.recordEvidence', transaction => {
    verification.createVerificationBatchInTransaction(transaction, {
      batchId,
      projectId: input.projectId,
      featureId: input.featureId,
      runId: attempt.runId,
      taskId: 'taskId' in input ? input.taskId : attempt.taskId,
      attemptId: attempt.id,
      executionVersion: attempt.executionVersion,
      operation,
      codeDigest: input.codeDigest,
      policyDigest: input.checkPolicyDigest,
      environmentSummary: { workspace: { headCommit: input.headCommit, codeDigest: input.codeDigest } },
      checkSnapshot: selected.map(definition => ({
        checkKey: definition.checkKey,
        scope: definition.scope,
        kind: definition.kind,
        argv: [...definition.argv],
        cwdRef: definition.cwdRef,
        environmentRef: definition.environmentRef,
        timeout: definition.timeout,
        required: definition.required,
        requirementRefs: [...definition.requirementRefs],
      })),
      selection: {
        schemaVersion: 1,
        mode: 'full_fallback',
        reason: 'F-017 deterministic finalization verification',
        selectedCheckKeys: selected.map(definition => definition.checkKey),
      },
      startedAtUtcMs: nowUtcMs,
    });
    for (const check of checks) {
      verification.saveCheckResultInTransaction(transaction, {
        resultId: check.resultId,
        projectId: f.box.projectId,
        batchId,
        checkKey: check.checkKey,
        status: check.status,
        exitCode: check.status === 'passed' ? 0 : 1,
        signal: null,
        timedOut: false,
        outputArtifactId: check.outputArtifactId,
        outputTail: 'F-017 deterministic evidence',
        startedAtUtcMs: nowUtcMs,
        endedAtUtcMs: nowUtcMs + 1,
      });
    }
    verification.finalizeVerificationBatchInTransaction(transaction, {
      projectId: f.box.projectId,
      batchId,
      expectedRevision: 1,
      status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'inconclusive',
      endedAtUtcMs: nowUtcMs + 2,
    });
  });
  return {
    batchId,
    operation,
    status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'inconclusive',
    invalidated: false,
    checks,
    reason: status === 'passed' ? null : 'F-017 injected finalization failure',
  };
}

function verifierFor(
  f: EligibleFinalizationFixture,
  definitions: readonly CheckDefinition[],
  behavior: () => FinalizationBehavior,
  calls: FinalizationPorts['calls'],
): FinalizationVerifier {
  let tick = 100_000;
  const next = () => NOW + (tick += 10_000);
  return {
    async revalidateTask(input) {
      calls.revalidate.push(input);
      behavior().onRevalidate?.(input);
      return recordEvidence(f, definitions, input, FINALIZATION_TASK_VERIFICATION_OPERATION,
        behavior().revalidate ?? 'passed', next());
    },
    async verifyFeature(input) {
      calls.feature.push(input);
      behavior().onFeature?.(input);
      return recordEvidence(f, definitions, input, FEATURE_VERIFICATION_OPERATION,
        behavior().feature ?? 'passed', next());
    },
  };
}

function baselineFor(f: EligibleFinalizationFixture): WorkspaceBaseline {
  const repository = f.inspection.repository;
  return {
    repositoryBindingId: repository.repositoryBindingId,
    repositoryBindingRevision: repository.repositoryBindingRevision,
    repoIdentity: repository.repoIdentity,
    canonicalPath: repository.canonicalPath,
    gitCommonDir: repository.gitCommonDir,
    branch: repository.branch,
    baseCommit: repository.baseCommit,
  };
}

function completionFor(f: EligibleFinalizationFixture, nowMs: () => number): FinalizationCompletionPort {
  const operations = createSqliteGitOperationStore(f.box.session, { nowUtcMs: nowMs });
  const inspector = createWorkspaceInspector({
    authorizedRoots: [f.box.box.root, f.box.box.repoDirA],
    confirmProcessIdentity: async identity => identity,
  });
  const delivery = createFinalizationGitDelivery({
    publisher: f.publisher, artifacts: f.verifier,
    operations,
    inspector,
    driver: createGitCommitDriver({ confirmProcessIdentity: async identity => identity }),
    lock: createGitPublicMetadataLock(),
    transact: callback => f.box.session.transactWrite('F017.git', callback),
    readFeatureRevision: (projectId, featureId) => {
      const feature = f.box.session.database.prepare(
        'SELECT revision FROM features WHERE project_id = ? AND id = ?',
      ).get(projectId, featureId) as { revision: number } | undefined;
      if (feature === undefined) throw new Error('F-017 feature missing');
      return feature.revision;
    },
    nowMs,
  });
  return createFinalizationCompletionService({
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: nowMs }),
    planner: plannerFor(f),
    atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: nowMs }),
    delivery,
    attempts: createSqliteAttemptAccess(f.box.session),
    readDeliveryConfig: () => ({
      message: MESSAGE,
      gitIdentity: GIT_IDENTITY,
      deliveryPolicyDigest: DELIVERY_POLICY,
    }),
    nowMs,
  });
}

export function createFinalizationPorts(
  f: EligibleFinalizationFixture,
  definitions: readonly CheckDefinition[] = defaultCheckDefinitions(),
  initial: FinalizationBehavior = {},
): FinalizationPorts {
  let behavior: FinalizationBehavior = { ...initial };
  const calls: FinalizationPorts['calls'] = { revalidate: [], feature: [] };
  const nowMs = () => NOW;
  return {
    execution: createFinalizationExecutionService({
      facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: nowMs }),
      planner: plannerFor(f),
      atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: nowMs }),
      verification: createSqliteVerificationStore(f.box.session, { nowUtcMs: nowMs }),
      artifacts: f.verifier,
      verifier: verifierFor(f, definitions, () => behavior, calls),
      nowMs,
    }),
    completion: completionFor(f, nowMs),
    calls,
    setBehavior(next) {
      behavior = { ...behavior, ...next };
    },
  };
}

export async function startFinalizationHost(
  f: EligibleFinalizationFixture,
  ports: FinalizationPorts,
): Promise<FinalizationHost> {
  const starts: FinalizationHost['starts'] = [];
  const requests = new Map<string, RuntimeExecutionRequest>();
  const catalog = createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: PROVIDERS },
    { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
  ]);
  const host = await startHost({
    dataRoot: f.box.box.dataRoot,
    capabilityCatalog: catalog,
    env: {},
    finalizationExecution: ports.execution,
    finalizationCompletion: ports.completion,
    workRuntimeFactory(context) {
      const fake = createFakeRuntime({
        script: FAKE_SCRIPT,
        providers: PROVIDERS,
        workspaceRoots: context.workspaceRoots,
        reader: context.reader,
        commitCommandIdentity: async (identity, launch) => {
          const request = requests.get(launch.invocationId);
          if (request === undefined) throw new TypeError('Unknown F-017 invocation');
          return context.commitCommandIdentity(identity, request);
        },
      });
      return {
        entries: [{
          descriptor: fake.descriptor,
          adapter: {
            ...fake.adapter,
            async start(request) {
              starts.push({
                attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : null,
                invocationId: request.invocationId,
              });
              requests.set(request.invocationId, request);
              return fake.adapter.start(request);
            },
          },
        }],
        eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`,
      };
    },
  });
  return { host, starts };
}

export function workspaceBaseline(f: EligibleFinalizationFixture): WorkspaceBaseline {
  return baselineFor(f);
}

/** Fixture-only: rebind existing Task/Feature evidence to the current worktree. */
export async function bindEvidenceToCurrentSource(
  f: EligibleFinalizationFixture,
  content: string,
): Promise<void> {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(f.box.box.repoDirA, 'src/a.ts'), content);
  const inspector = createWorkspaceInspector({
    authorizedRoots: [f.box.box.root, f.box.box.repoDirA],
    confirmProcessIdentity: async identity => identity,
  });
  const inspection = await inspector.inspect(baselineFor(f));
  const db = f.box.session.database;
  const environment = JSON.stringify({
    workspace: { headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest },
  });
  const batches = db.prepare('SELECT * FROM verification_batches').all() as Record<string, unknown>[];
  for (const batch of batches) {
    const id = `rebound-${randomUUID()}`;
    db.prepare(`INSERT INTO verification_batches
      (id, created_at, updated_at, revision, project_id, feature_id, run_id, task_id, attempt_id,
       execution_version, operation, code_digest, policy_digest, environment_summary, check_snapshot,
       selection, status, started_at, ended_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?)`).run(
      id, NOW + 1, NOW + 1, batch.project_id, batch.feature_id, batch.run_id, batch.task_id, batch.attempt_id,
      batch.execution_version, batch.operation, inspection.codeDigest, batch.policy_digest, environment,
      batch.check_snapshot, batch.selection, batch.started_at, batch.ended_at,
    );
    const checks = db.prepare('SELECT * FROM check_results WHERE batch_id = ?')
      .all(batch.id as string) as Record<string, unknown>[];
    for (const check of checks) {
      db.prepare(`INSERT INTO check_results
        (id, created_at, updated_at, revision, project_id, batch_id, check_key, argv_json, cwd_ref,
         environment_ref, timeout_ms, required, status, exit_code, signal, timed_out,
         output_artifact_id, output_digest, output_tail, started_at, ended_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `rebound-${randomUUID()}`, NOW + 1, NOW + 1, check.project_id, id, check.check_key, check.argv_json,
        check.cwd_ref, check.environment_ref, check.timeout_ms, check.required, check.status, check.exit_code,
        check.signal, check.timed_out, check.output_artifact_id, check.output_digest, check.output_tail,
        check.started_at, check.ended_at,
      );
    }
  }
  const planDigest = (db.prepare('SELECT plan_digest FROM features WHERE id = ?')
    .get(f.box.featureId) as { plan_digest: string }).plan_digest;
  db.prepare(`INSERT INTO task_approval_items
    (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
     responsible_party, plan_digest, code_digest, artifact_refs, status, created_by,
     decision, decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at)
    VALUES (?, ?, ?, ?, 't-1', 1, ?, 'approval', 'final review rebound', 'owner', ?, ?, '[]', 'approved', 'owner',
      'approve', 'reviewer-1', 'approved current source', ?, '[]', ?)`).run(
    `approval-${randomUUID()}`, NOW + 1, f.box.projectId, f.box.featureId, NOW + 1,
    planDigest, inspection.codeDigest, inspection.codeDigest, NOW + 1,
  );
}

