/**
 * P03-8 / F-010：Feature Task、最终检查、人工审批与交付分轴结果查询（真实
 * SQLite + 真实 Host 纵向，非 mock）。
 *
 * 验收面（.dag_context.json F-010）：
 * 1. 复用已存在的 Feature/Run 结果查询面，返回全部必需 Task 当前有效结果与
 *    历史引用、独立 Feature VerificationBatch 及逐检查状态、最终审批/阻塞、
 *    Git operation 和 deliveryStatus；completed 不掩盖缺失证据或其他轴失败；
 * 2. 所有 Task passed 但最终失败、机器通过待人工批准、Git 已提交但新阻塞、
 *    提交失败和正常完成具有可区分的结构化结果；失败阶段使用 executionStage，
 *    包含相关身份、可理解原因与显式下一步，不暗示自动重跑编码；
 * 3. 结果从持久状态重建而非日志或模型文本推断；有界分页、同项目授权和输出
 *    脱敏遵循既有查询契约；重复读取不增加计数，缺失耗时/退出信息保留未知，
 *    SQLite 重开后结果一致。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectToHost,
  startHost,
  validateAppQueryResponse,
  resolveAppRoute,
  isHostProtocolError,
  type HostClient,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { APP_OPERATIONS } from '../packages/host/src/contract/errors.ts';
import { APPLICATION_QUERY_CAPABILITIES } from '../packages/host/src/contract/lifecycle.ts';
import { FEATURE_DELIVERY_QUERY_OPERATIONS } from '../packages/core/src/protocol.ts';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import type { QueryService } from '../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createFeatureFinalizationService } from '../packages/core/src/application/feature-finalization.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteGitOperationStore } from '../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { openBudgetFixture, NOW, type BudgetFixture } from './helpers/p03-3/budget-fixture.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
} from './helpers/p02-2/principals.ts';
import { loopbackRequest } from './helpers/host/index.ts';

const HASH = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const CANDIDATE_TREE = 'b'.repeat(40);
const ACTUAL_COMMIT = 'c'.repeat(40);
const owner = createLocalOwnerPrincipal();

const fixtures: BudgetFixture[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（固定时钟）。 */
function assembleQueries(session: SqliteStorageSession, dataRoot: string): QueryService {
  const queryStore = createSqliteQueryStore(session);
  const stateStore = createSqliteStateStore(session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    gitOperationReads: queryStore,
    featureDeliveryReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => NOW,
  });
}

function preparedInput(projectId: string, featureId: string, taskId = 't-1') {
  const ref = (artifactId: string) => ({ artifactId, version: 1, contentHash: HASH,
    sizeBytes: 10, locator: `inputs/${artifactId}`, mediaType: 'application/json' });
  return { schemaVersion: 1, projectId, featureId, taskId,
    group: { snapshot: ref('snapshot-1'), manifest: ref('manifest-1'), prompt: ref('prompt-1') },
    requiredInputs: [], digests: { snapshotDigest: HASH, manifestDigest: HASH, promptDigest: HASH,
      strategyCopyDigest: HASH, permissionsDigest: HASH },
    approval: { planDigest: HASH, checkPolicyDigest: HASH, decisionId: null, featureRevision: 1 },
    taskRevision: 1, promptBytes: 10,
    tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' }, preparedAtUtcMs: NOW };
}

const CHECK_UNIT = {
  checkKey: 'unit-tests', scope: 'project', kind: 'command',
  argv: ['node', 'scripts/run-tests.ts'], cwdRef: null, environmentRef: null,
  timeout: 600_000, required: true, requirementRefs: ['T39'],
} as const;
const CHECK_BUILD = {
  checkKey: 'build', scope: 'project', kind: 'command',
  argv: ['npm', 'run', 'build'], cwdRef: null, environmentRef: null,
  timeout: 600_000, required: true, requirementRefs: ['T39'],
} as const;

interface SeededRun {
  readonly fixture: BudgetFixture;
  readonly runId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly head: string;
  readonly worktreePath: string;
}

async function openStartedFixture(): Promise<SeededRun> {
  const fixture = await openBudgetFixture();
  fixtures.push(fixture);
  const ids = await fixture.start();
  return {
    fixture,
    runId: ids.runId,
    batchId: ids.batchId,
    taskId: ids.taskId,
    head: fixture.box.gitHead('A'),
    worktreePath: fixture.box.repoDirA,
  };
}

/** Task 有效通过 + Feature/Run/Batch 进入 running（与 F-007 同一终态前置）。 */
function markReadyForFinalization(seeded: SeededRun): void {
  const db = seeded.fixture.session.database;
  db.prepare(
    "UPDATE tasks SET status = 'passed', execution_version = 1, first_passed_at = ?, attempt_counter = 1, code_attempts_used = 1, revision = revision + 1 WHERE id = ?",
  ).run(NOW, seeded.taskId);
  db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(seeded.fixture.featureId);
  db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(seeded.runId);
  db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(seeded.batchId);
}

interface FeatureCheckSeed {
  readonly checkKey: 'unit-tests' | 'build';
  readonly status: 'passed' | 'failed' | 'error';
  readonly exitCode: number | null;
  readonly outputArtifactId: string | null;
}

/**
 * 播种真实 Attempt 与独立 Feature VerificationBatch（operation 恒为
 * 'FeatureVerification.full'）+ 逐检查结果；未知退出/耗时保持 null。
 */
function seedFeatureVerification(
  seeded: SeededRun,
  options: { readonly batchStatus: 'passed' | 'failed'; readonly checks: readonly FeatureCheckSeed[] },
): void {
  const { fixture } = seeded;
  const db = fixture.session.database;
  const inputSnapshot = preparedInput(fixture.projectId, fixture.featureId, seeded.taskId);
  const insertInputArtifact = (id: string) => {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'execution-input', 'ready', 'application/json', ?, ?, 10, ?)`)
      .run(id, NOW, NOW, fixture.projectId, HASH, HASH, `inputs/${id}`);
  };
  for (const ref of Object.values(inputSnapshot.group)) insertInputArtifact(ref.artifactId);
  for (const artifactId of ['output-1', 'output-2']) {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'verification-output', 'ready', 'text/plain', ?, ?, 128, ?)`)
      .run(artifactId, NOW, NOW, fixture.projectId, HASH, HASH, `outputs/${artifactId}.log`);
  }
  // Attempt 代码现场制品（attempts_code_fk 引用必须真实存在）。
  db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
    expected_hash, content_hash, size_bytes, storage_locator) VALUES ('code-1', ?, ?, ?, 'execution-input', 'ready', 'application/json', ?, ?, 10, 'inputs/code-1')`)
    .run(NOW, NOW, fixture.projectId, HASH, HASH);
  db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
    number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest,
    input_ref, status, execution_stage, started_at, ended_at, duration_ms, exit_code, code_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'owner-1', 'host-1', 1, ?, ?, ?, ?, 'succeeded', 'verification', ?, ?, 0, 0, ?)`)
    .run('attempt-1', NOW, NOW, fixture.projectId, fixture.featureId, seeded.runId, seeded.taskId,
      NOW + 1000, JSON.stringify(inputSnapshot), HASH, 'snapshot-1', NOW, NOW, 'code-1');

  const store = createSqliteVerificationStore(fixture.session, { nowUtcMs: () => NOW });
  const definitions = { 'unit-tests': CHECK_UNIT, build: CHECK_BUILD } as const;
  store.createVerificationBatch({
    batchId: 'vbatch-feature-1',
    projectId: fixture.projectId,
    featureId: fixture.featureId,
    runId: seeded.runId,
    taskId: seeded.taskId,
    attemptId: 'attempt-1',
    executionVersion: 1,
    operation: 'FeatureVerification.full',
    codeDigest: HASH,
    policyDigest: HASH_B,
    environmentSummary: { runner: 'node', nodeVersion: 'v22.19.0', platform: 'darwin' },
    checkSnapshot: options.checks.map((check) => definitions[check.checkKey]),
    selection: {
      schemaVersion: 1,
      mode: 'full_fallback',
      reason: 'Feature 最终全量检查',
      selectedCheckKeys: options.checks.map((check) => check.checkKey),
    },
    startedAtUtcMs: NOW,
  });
  options.checks.forEach((check, index) => {
    store.saveCheckResult({
      resultId: `vres-${index + 1}`,
      projectId: fixture.projectId,
      batchId: 'vbatch-feature-1',
      checkKey: check.checkKey,
      status: check.status,
      exitCode: check.exitCode,
      signal: null,
      timedOut: false,
      outputArtifactId: check.outputArtifactId,
      outputTail: check.outputArtifactId === null ? null : '12 passed\n0 failed',
      startedAtUtcMs: check.exitCode === null ? null : NOW,
      endedAtUtcMs: check.exitCode === null ? null : NOW + 1_000,
    });
  });
  store.finalizeVerificationBatch({
    projectId: fixture.projectId,
    batchId: 'vbatch-feature-1',
    expectedRevision: 1,
    status: options.batchStatus,
  });
}

/** 播种 Feature 最终提交 Git operation（register → finalize 逐条交错约束）。 */
function seedGitOperation(
  seeded: SeededRun,
  options: {
    readonly operationId?: string;
    readonly status: 'succeeded' | 'failed' | 'unknown';
    readonly reasonCode?: string | null;
  },
): string {
  const { fixture } = seeded;
  const operationId = options.operationId ?? 'op-final-1';
  const db = fixture.session.database;
  const feature = db
    .prepare('SELECT revision FROM features WHERE project_id = ? AND id = ?')
    .get(fixture.projectId, fixture.featureId) as { revision: number };
  const binding = db
    .prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?')
    .get(fixture.projectId) as { id: string; repo_identity: string };
  const store = createSqliteGitOperationStore(fixture.session, { nowUtcMs: () => NOW });
  store.registerGitOperation({
    operationId,
    projectId: fixture.projectId,
    featureId: fixture.featureId,
    runId: seeded.runId,
    attemptId: null,
    executionVersion: 1,
    operationType: 'feature_final_commit',
    repositoryBindingId: binding.id,
    repoIdentity: binding.repo_identity,
    worktreePath: seeded.worktreePath,
    expectedHead: seeded.head,
    candidateTree: CANDIDATE_TREE,
    codeDigest: HASH,
    verificationRefs: [{ kind: 'verification_batch', id: 'vbatch-feature-1', digest: HASH }],
    approvalRefs: [{ kind: 'human_approval', id: 'approval-1', digest: HASH_B }],
    message: 'P03-8 F-010 controlled commit',
    gitIdentity: { name: 'Test User', email: 'test@example.com', confirmed: true },
    deliveryPolicyDigest: HASH_B,
    runtimeSource: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      source: { kind: 'global_default', sourceKey: 'strategies.defaultStrategy' },
    },
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    expectedFeatureRevision: feature.revision,
  });
  if (options.status === 'succeeded') {
    store.finalizeGitOperation({
      operationId,
      projectId: fixture.projectId,
      expectedRevision: 1,
      status: 'succeeded',
      actualCommit: ACTUAL_COMMIT,
      actualTree: CANDIDATE_TREE,
      exitCode: 0,
      durationMs: 250,
      reasonCode: null,
      deliveryStatus: 'succeeded',
      settledAtUtcMs: NOW + 1_000,
    });
  } else if (options.status === 'failed') {
    store.finalizeGitOperation({
      operationId,
      projectId: fixture.projectId,
      expectedRevision: 1,
      status: 'failed',
      actualCommit: 'd'.repeat(40),
      actualTree: 'e'.repeat(40),
      exitCode: 1,
      durationMs: 180,
      reasonCode: options.reasonCode ?? 'hook_failed',
      deliveryStatus: 'failed',
      settledAtUtcMs: NOW + 1_000,
    });
  } else {
    store.finalizeGitOperation({
      operationId,
      projectId: fixture.projectId,
      expectedRevision: 1,
      status: 'unknown',
      actualCommit: null,
      actualTree: null,
      exitCode: null,
      durationMs: null,
      reasonCode: options.reasonCode ?? 'receipt_lost',
      deliveryStatus: 'pending',
      settledAtUtcMs: NOW + 1_000,
    });
  }
  return operationId;
}

function currentPlanDigest(fixture: BudgetFixture): string {
  return (
    fixture.session.database
      .prepare<[string], { plan_digest: string }>('SELECT plan_digest FROM features WHERE id = ?')
      .get(fixture.featureId)!
  ).plan_digest;
}

/** 播种人审事项（真实行；决定绑定与持久 CHECK 同源）。 */
function insertApprovalItem(
  fixture: BudgetFixture,
  taskId: string,
  item: {
    readonly id: string;
    readonly kind: 'block' | 'approval';
    readonly description?: string;
    readonly status: 'pending' | 'approved';
    readonly codeDigest?: string | null;
    readonly decisionCodeDigest?: string | null;
  },
): void {
  const decided = item.status === 'approved';
  fixture.session.database.prepare(
    `INSERT INTO task_approval_items
      (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
       responsible_party, plan_digest, code_digest, artifact_refs, status, created_by,
       decision, decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'owner', ?, ?, '[]', ?, 'owner', ?, ?, ?, ?, '[]', ?)`,
  ).run(
    item.id,
    NOW,
    fixture.projectId,
    fixture.featureId,
    taskId,
    NOW,
    item.kind,
    item.description ?? `Review ${item.id}`,
    currentPlanDigest(fixture),
    item.codeDigest === undefined ? HASH : item.codeDigest,
    item.status,
    decided ? 'approve' : null,
    decided ? 'reviewer-1' : null,
    decided ? 'reviewed' : null,
    decided ? (item.decisionCodeDigest === undefined ? HASH : item.decisionCodeDigest) : null,
    decided ? NOW : null,
  );
}

/** 驱动真实 finalization 原子事务（与 F-007 同一服务；verify/approval/commit 为显式替身）。 */
async function finalizeFeature(
  seeded: SeededRun,
  options: {
    readonly verifyPassed: boolean;
    readonly approvalValid?: boolean;
    readonly commit:
      | { readonly kind: 'succeeded' | 'failed'; readonly reasonCode?: string }
      | { readonly kind: 'throws' };
    readonly operationId: string | null;
  },
): Promise<void> {
  const service = createFeatureFinalizationService({
    atomic: seeded.fixture.services.atomic,
    verify: async () => ({
      passed: options.verifyPassed,
      reason: options.verifyPassed ? 'full_verification_passed' : 'verification_failed',
    }),
    readApproval: async () => ({
      valid: options.approvalValid ?? true,
      reason: (options.approvalValid ?? true) ? 'approval_current' : 'approval_required',
    }),
    commit: {
      commit: async () => {
        if (options.commit.kind === 'throws') throw new Error('delivery_outcome_unknown');
        if (options.commit.kind === 'failed') {
          return {
            intent: { operationId: options.operationId },
            status: 'failed',
            reasonCode: options.commit.reasonCode ?? 'hook_failed',
            deliveryStatus: 'failed',
          } as never;
        }
        return {
          intent: { operationId: options.operationId },
          status: 'succeeded',
          deliveryStatus: 'succeeded',
        } as never;
      },
    },
  });
  await service.finalize({
    projectId: seeded.fixture.projectId,
    featureId: seeded.fixture.featureId,
    batchId: seeded.batchId,
    runId: seeded.runId,
    operationId: options.operationId,
  });
}

/** 完成现场：验证 passed + 批准 + 提交成功 + 真实 Git operation 记录。 */
async function seedCompletedFeature(): Promise<SeededRun> {
  const seeded = await openStartedFixture();
  markReadyForFinalization(seeded);
  seedFeatureVerification(seeded, {
    batchStatus: 'passed',
    checks: [
      { checkKey: 'unit-tests', status: 'passed', exitCode: 0, outputArtifactId: 'output-1' },
      { checkKey: 'build', status: 'passed', exitCode: 0, outputArtifactId: 'output-2' },
    ],
  });
  insertApprovalItem(seeded.fixture, seeded.taskId, {
    id: 'approval-1',
    kind: 'approval',
    status: 'approved',
  });
  const operationId = seedGitOperation(seeded, { status: 'succeeded' });
  await finalizeFeature(seeded, {
    verifyPassed: true,
    commit: { kind: 'succeeded' },
    operationId,
  });
  return seeded;
}

function maxEventSequence(db: BudgetFixture['session']['database']): number {
  return (db.prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM state_events').get() as { s: number }).s;
}

describe('F-010 Feature 分轴结果查询（Core 授权与持久事实）', () => {
  it('正常完成：四轴内容、结构化 completed outcome 与真实持久状态逐字段相符', async () => {
    const seeded = await seedCompletedFeature();
    const { fixture } = seeded;
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);

    const result = await queries.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    expect(result.schemaVersion).toBe(5);
    expect(result.scope).toBe('feature-delivery');
    expect(result.feature).toMatchObject({
      featureId: fixture.featureId,
      status: 'completed',
      deliveryStatus: 'succeeded',
      planStatus: 'approved',
      planDigest: currentPlanDigest(fixture),
    });

    // Task 轴：全部必需 Task 当前有效结果 + 历史引用（latestAttemptId）。
    expect(result.axes.tasks.total).toBe(1);
    expect(result.axes.tasks.passed).toBe(1);
    expect(result.axes.tasks.allPassed).toBe(true);
    expect(result.axes.tasks.records[0]).toEqual({
      taskId: seeded.taskId,
      status: 'passed',
      effectivePassed: true,
      manualBlock: false,
      firstPassedAt: new Date(NOW).toISOString(),
      latestAttemptId: 'attempt-1',
    });

    // 最终检查轴：独立 Feature VerificationBatch + 逐检查状态。
    expect(result.axes.verification.status).toBe('passed');
    const batch = result.axes.verification.batch!;
    expect(batch).toMatchObject({
      id: 'vbatch-feature-1',
      runId: seeded.runId,
      operation: 'FeatureVerification.full',
      codeDigest: HASH,
      policyDigest: HASH_B,
      status: 'passed',
    });
    expect(batch.selection).toMatchObject({
      mode: 'full_fallback',
      selectedCheckKeys: ['unit-tests', 'build'],
    });
    expect(batch.checks.map((check) => [check.checkKey, check.status, check.exitCode])).toEqual([
      ['unit-tests', 'passed', 0],
      ['build', 'passed', 0],
    ]);

    // 审批轴：当前决定有效。
    expect(result.axes.approval.status).toBe('approved');
    expect(result.axes.approval.itemsTruncated).toBe(false);
    expect(result.axes.approval.items.map((item) => [item.id, item.status])).toEqual([
      ['approval-1', 'approved'],
    ]);

    // 交付轴：deliveryStatus + Git operation 脱敏投影。
    expect(result.axes.delivery.status).toBe('succeeded');
    expect(result.axes.delivery.operation).toMatchObject({
      operationId: 'op-final-1',
      status: 'succeeded',
      actualCommit: ACTUAL_COMMIT,
      deliveryStatus: 'succeeded',
    });

    // 总体 outcome：completed，无失败阶段，身份齐全。
    expect(result.run).toMatchObject({ id: seeded.runId, batchId: seeded.batchId, status: 'succeeded' });
    expect(result.outcome).toEqual({
      status: 'completed',
      executionStage: null,
      reason: 'feature_finalized',
      nextStep: 'none',
      identities: {
        featureId: fixture.featureId,
        runId: seeded.runId,
        batchId: seeded.batchId,
        verificationBatchId: 'vbatch-feature-1',
        gitOperationId: 'op-final-1',
      },
    });
  });

  it('重复读取无状态变更，真实 SQLite 重开后结果逐字节一致', async () => {
    const seeded = await seedCompletedFeature();
    const { fixture } = seeded;
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    const before = {
      sequence: maxEventSequence(fixture.session.database),
      features: fixture.session.database
        .prepare('SELECT id, revision, updated_at, status FROM features ORDER BY id')
        .all(),
    };
    const first = await queries.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    const second = await queries.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
    // 查询零写入、零事件、重复读取不增加任何计数。
    expect(maxEventSequence(fixture.session.database)).toBe(before.sequence);
    expect(
      fixture.session.database
        .prepare('SELECT id, revision, updated_at, status FROM features ORDER BY id')
        .all(),
    ).toEqual(before.features);

    fixture.reopen();
    const reopened = assembleQueries(fixture.session, fixture.box.dataRoot);
    const relisted = await reopened.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    expect(JSON.parse(JSON.stringify(relisted))).toEqual(JSON.parse(JSON.stringify(first)));
  });

  it('所有 Task passed 但最终失败：保留有效 Task，outcome 可区分且缺失退出信息保持未知', async () => {
    const seeded = await openStartedFixture();
    markReadyForFinalization(seeded);
    // error 检查：未知退出码/耗时保持 null（不以 0 冒充）。
    seedFeatureVerification(seeded, {
      batchStatus: 'failed',
      checks: [
        { checkKey: 'unit-tests', status: 'failed', exitCode: 1, outputArtifactId: 'output-1' },
        { checkKey: 'build', status: 'error', exitCode: null, outputArtifactId: null },
      ],
    });
    await finalizeFeature(seeded, {
      verifyPassed: false,
      commit: { kind: 'succeeded' },
      operationId: null,
    });
    const queries = assembleQueries(seeded.fixture.session, seeded.fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: seeded.fixture.projectId,
      featureId: seeded.fixture.featureId,
    });

    // 有效 Task 与历史不被最终失败掩盖。
    expect(result.axes.tasks.allPassed).toBe(true);
    expect(result.axes.tasks.records[0]).toMatchObject({ status: 'passed', effectivePassed: true });
    expect(result.feature.status).toBe('partial');
    expect(result.axes.verification.status).toBe('failed');
    const checks = result.axes.verification.batch!.checks;
    expect(checks.find((check) => check.checkKey === 'build')).toMatchObject({
      status: 'error',
      exitCode: null,
      signal: null,
      startedAt: null,
      endedAt: null,
    });
    expect(result.axes.delivery).toEqual({ status: 'not_requested', operation: null });
    expect(result.outcome).toMatchObject({
      status: 'final_verification_failed',
      executionStage: 'feature_verification',
      reason: 'verification_failed',
      nextStep: 'rework_authorization',
      identities: { verificationBatchId: 'vbatch-feature-1', gitOperationId: null },
    });
    // 显式下一步不暗示自动重跑编码。
    expect(result.outcome.nextStep).not.toBe('continue_execution');
  });

  it('机器通过待人工批准：awaiting_approval 与 pending 审批轴可区分', async () => {
    const seeded = await openStartedFixture();
    markReadyForFinalization(seeded);
    seedFeatureVerification(seeded, {
      batchStatus: 'passed',
      checks: [{ checkKey: 'unit-tests', status: 'passed', exitCode: 0, outputArtifactId: 'output-1' }],
    });
    insertApprovalItem(seeded.fixture, seeded.taskId, {
      id: 'approval-pending-1',
      kind: 'approval',
      status: 'pending',
    });
    await finalizeFeature(seeded, {
      verifyPassed: true,
      approvalValid: false,
      commit: { kind: 'succeeded' },
      operationId: null,
    });
    const queries = assembleQueries(seeded.fixture.session, seeded.fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: seeded.fixture.projectId,
      featureId: seeded.fixture.featureId,
    });

    expect(result.feature.status).toBe('awaiting_approval');
    expect(result.feature.deliveryStatus).toBe('not_requested');
    expect(result.axes.verification.status).toBe('passed');
    expect(result.axes.approval.status).toBe('pending');
    expect(result.axes.approval.items[0]).toMatchObject({ id: 'approval-pending-1', status: 'pending' });
    expect(result.run).toMatchObject({ status: 'paused', reason: 'approval_required' });
    expect(result.outcome).toMatchObject({
      status: 'awaiting_approval',
      executionStage: 'final_approval',
      reason: 'approval_required',
      nextStep: 'feature_approval_decision',
    });
  });

  it('Git 已提交但新阻塞：completed 不掩盖当前人工阻塞', async () => {
    const seeded = await seedCompletedFeature();
    const { fixture } = seeded;
    // 完成后新增绑定当前计划/代码身份的人工阻塞（持久事实）。
    insertApprovalItem(fixture, seeded.taskId, {
      id: 'block-after-commit',
      kind: 'block',
      status: 'pending',
    });
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });

    expect(result.feature.status).toBe('completed');
    expect(result.axes.delivery.status).toBe('succeeded');
    expect(result.axes.approval.status).toBe('blocked');
    expect(result.outcome).toMatchObject({
      status: 'committed_but_blocked',
      executionStage: 'final_approval',
      reason: 'manual_block',
      nextStep: 'manual_block_resolution',
      identities: { gitOperationId: 'op-final-1' },
    });
    expect(result.outcome.status).not.toBe('completed');
  });

  it('提交失败与提交待核对：delivery_failed 与 delivery_uncertain 可区分', async () => {
    // 提交失败：deliveryStatus failed，原因取持久 Run reason（hook_failed）。
    const failed = await openStartedFixture();
    markReadyForFinalization(failed);
    seedFeatureVerification(failed, {
      batchStatus: 'passed',
      checks: [{ checkKey: 'unit-tests', status: 'passed', exitCode: 0, outputArtifactId: 'output-1' }],
    });
    const failedOperationId = seedGitOperation(failed, { status: 'failed', reasonCode: 'hook_failed' });
    await finalizeFeature(failed, {
      verifyPassed: true,
      commit: { kind: 'failed', reasonCode: 'hook_failed' },
      operationId: failedOperationId,
    });
    const failedQueries = assembleQueries(failed.fixture.session, failed.fixture.box.dataRoot);
    const failedResult = await failedQueries.getFeatureDelivery(owner, {
      projectId: failed.fixture.projectId,
      featureId: failed.fixture.featureId,
    });
    expect(failedResult.feature.status).toBe('partial');
    expect(failedResult.axes.delivery.status).toBe('failed');
    expect(failedResult.axes.delivery.operation).toMatchObject({
      operationId: failedOperationId,
      status: 'failed',
      reasonCode: 'hook_failed',
    });
    expect(failedResult.outcome).toMatchObject({
      status: 'delivery_failed',
      executionStage: 'git_delivery',
      reason: 'hook_failed',
      nextStep: 'feature_verification_continue',
      identities: { gitOperationId: failedOperationId },
    });

    // 提交待核对：deliveryStatus pending，绝不显示为成功或失败。
    const uncertain = await openStartedFixture();
    markReadyForFinalization(uncertain);
    seedFeatureVerification(uncertain, {
      batchStatus: 'passed',
      checks: [{ checkKey: 'unit-tests', status: 'passed', exitCode: 0, outputArtifactId: 'output-1' }],
    });
    const uncertainOperationId = seedGitOperation(uncertain, { status: 'unknown', reasonCode: 'receipt_lost' });
    await finalizeFeature(uncertain, {
      verifyPassed: true,
      commit: { kind: 'throws' },
      operationId: uncertainOperationId,
    });
    const uncertainQueries = assembleQueries(uncertain.fixture.session, uncertain.fixture.box.dataRoot);
    const uncertainResult = await uncertainQueries.getFeatureDelivery(owner, {
      projectId: uncertain.fixture.projectId,
      featureId: uncertain.fixture.featureId,
    });
    expect(uncertainResult.feature.deliveryStatus).toBe('pending');
    expect(uncertainResult.axes.delivery.operation).toMatchObject({
      operationId: uncertainOperationId,
      status: 'unknown',
      deliveryStatus: 'pending',
    });
    expect(uncertainResult.outcome).toMatchObject({
      status: 'delivery_uncertain',
      executionStage: 'git_delivery',
      reason: 'delivery_outcome_unknown',
      nextStep: 'git_operation_reconcile',
    });
    expect(uncertainResult.outcome.status).not.toBe('delivery_failed');
    expect(uncertainResult.outcome.status).not.toBe('completed');
  });

  it('completed 但缺失最终检查证据：evidence_incomplete，绝不报告 completed', async () => {
    const seeded = await openStartedFixture();
    markReadyForFinalization(seeded);
    // 不播种 Feature VerificationBatch（证据缺失），其余完成条件齐备。
    insertApprovalItem(seeded.fixture, seeded.taskId, {
      id: 'approval-1',
      kind: 'approval',
      status: 'approved',
    });
    const operationId = seedGitOperation(seeded, { status: 'succeeded' });
    await finalizeFeature(seeded, {
      verifyPassed: true,
      commit: { kind: 'succeeded' },
      operationId,
    });
    const queries = assembleQueries(seeded.fixture.session, seeded.fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: seeded.fixture.projectId,
      featureId: seeded.fixture.featureId,
    });

    expect(result.feature.status).toBe('completed');
    expect(result.axes.verification).toEqual({ status: 'none', batch: null });
    expect(result.outcome).toMatchObject({
      status: 'evidence_incomplete',
      executionStage: 'feature_verification',
      reason: 'feature_verification_evidence_missing',
      nextStep: 'feature_verification_continue',
    });
    expect(result.outcome.status).not.toBe('completed');
  });

  it('执行中：in_progress 定位 task_execution 阶段，身份与空轴如实展示', async () => {
    const seeded = await openStartedFixture();
    const queries = assembleQueries(seeded.fixture.session, seeded.fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: seeded.fixture.projectId,
      featureId: seeded.fixture.featureId,
    });

    expect(result.axes.tasks).toMatchObject({ total: 1, passed: 0, allPassed: false });
    expect(result.axes.tasks.records[0]).toMatchObject({
      taskId: seeded.taskId,
      status: 'pending',
      effectivePassed: false,
      latestAttemptId: null,
    });
    expect(result.axes.verification).toEqual({ status: 'none', batch: null });
    expect(result.axes.approval).toMatchObject({ status: 'none', items: [], itemsTruncated: false });
    expect(result.axes.delivery).toEqual({ status: 'not_requested', operation: null });
    expect(result.outcome).toMatchObject({
      status: 'in_progress',
      executionStage: 'task_execution',
      reason: 'tasks_not_passed',
      nextStep: 'continue_execution',
      identities: {
        featureId: seeded.fixture.featureId,
        runId: seeded.runId,
        verificationBatchId: null,
        gitOperationId: null,
      },
    });
  });

  it('审批事项有界读取：超出上限置 itemsTruncated，不静默丢弃语义', async () => {
    const seeded = await openStartedFixture();
    const { fixture } = seeded;
    const digest = currentPlanDigest(fixture);
    const statement = fixture.session.database.prepare(
      `INSERT INTO task_approval_items
        (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
         responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'block', ?, 'owner', ?, NULL, '[]', 'pending', 'owner', '[]')`,
    );
    for (let index = 0; index < 129; index += 1) {
      statement.run(
        `block-${String(index).padStart(4, '0')}`,
        NOW + index,
        fixture.projectId,
        fixture.featureId,
        seeded.taskId,
        NOW + index,
        `Bounded review ${index}`,
        digest,
      );
    }
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    expect(result.axes.approval.itemsTruncated).toBe(true);
    expect(result.axes.approval.items).toHaveLength(128);
    expect(result.axes.approval.items[0]!.id).toBe('block-0000');
    expect(result.axes.approval.status).toBe('blocked');
  });

  it('跨项目读取与无权限主体按现有错误契约拒绝，不泄漏存在性', async () => {
    const seeded = await seedCompletedFeature();
    const { fixture } = seeded;
    // 第二个项目/Feature（真实行）用于跨项目存在性折叠断言。
    const db = fixture.session.database;
    db.prepare(
      `INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels)
       VALUES (?, ?, 1, ?, 'Project B', 'active', NULL, '[]')`,
    ).run(randomUUID(), NOW, NOW);
    const projectB = db.prepare('SELECT id FROM projects WHERE display_name = ?').get('Project B') as { id: string };
    db.prepare(
      `INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels)
       VALUES ('phase-b', ?, ?, 1, ?, 'Phase B', 'open', NULL, '[]')`,
    ).run(NOW, projectB.id, NOW);
    db.prepare(
      `INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status,
         plan_status, description, labels, source_refs, plan_digest)
       VALUES ('feature-b', ?, ?, 1, ?, 'phase-b', 'Feature B', 'draft', 'draft', NULL, '[]', '[]', NULL)`,
    ).run(NOW, projectB.id, NOW);

    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    // 无 project.read 能力 → forbidden（能力核验先于任何读取）。
    const noCapability = createRestrictedPrincipal({
      capabilities: ['events.read'],
      projectScope: { kind: 'all' },
    });
    await expect(
      queries.getFeatureDelivery(noCapability, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // 可见范围不含目标项目 → forbidden。
    const hidden = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'allowlist', projectIds: [randomUUID()] },
    });
    await expect(
      queries.getFeatureDelivery(hidden, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // 跨项目 Feature 与不存在目标统一 not_found（同一形状，不回显归属）。
    await expect(
      queries.getFeatureDelivery(owner, { projectId: fixture.projectId, featureId: 'feature-b' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.getFeatureDelivery(owner, { projectId: fixture.projectId, featureId: 'feature-x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.getFeatureDelivery(owner, { projectId: randomUUID(), featureId: fixture.featureId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // 未知键（含提权字段）与非法身份在任何读取前拒绝。
    await expect(
      queries.getFeatureDelivery(owner, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
        principalId: 'local-owner',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      queries.getFeatureDelivery(owner, { projectId: fixture.projectId, featureId: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('公开输出不含 worktree 路径、执行归属或凭据材料', async () => {
    const seeded = await seedCompletedFeature();
    const { fixture } = seeded;
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    const result = await queries.getFeatureDelivery(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(seeded.worktreePath);
    expect(payload).not.toContain('owner-1');
    expect(payload).not.toContain('host-1');
    expect(payload).not.toContain(fixture.box.dataRoot);
    expect(payload).not.toContain('worktreePath');
    expect(payload).not.toContain('ownerId');
    expect(payload).not.toContain('hostInstanceId');
  });
});

describe('F-010 Host 路由与能力白名单接线', () => {
  it('Feature 分轴结果路由冻结，其他形态未匹配', () => {
    expect(resolveAppRoute('/v1/features/f-1/delivery')).toEqual({
      operation: 'features.delivery.get',
      method: 'GET',
      pathParam: { name: 'featureId', value: 'f-1' },
    });
    expect(resolveAppRoute('/v1/features/f-1/approvals')).toEqual({
      operation: 'features.approvals',
      method: 'GET',
      pathParam: { name: 'featureId', value: 'f-1' },
    });
    expect(resolveAppRoute('/v1/features/f-1/delivery/extra')).toBeUndefined();
    expect(resolveAppRoute('/v1/features/f-1/bogus')).toBeUndefined();
    expect(resolveAppRoute('/v1/features//delivery')).toBeUndefined();
  });

  it('新增操作/能力白名单与 Core 操作身份同步，不漂移', () => {
    for (const operation of FEATURE_DELIVERY_QUERY_OPERATIONS) {
      expect(APP_OPERATIONS).toContain(operation);
      expect(APPLICATION_QUERY_CAPABILITIES).toContain(operation);
    }
    expect(new Set(APP_OPERATIONS).size).toBe(APP_OPERATIONS.length);
  });
});

describe('F-010 HostClient 查询接线（真实 Host 纵向）', () => {
  let client: HostClient | undefined;
  afterEach(() => {
    client?.close();
    client = undefined;
  });

  it('经既有 HostClient 取得分轴结果，内容与真实持久状态相符且错误协议稳定', async () => {
    const seeded = await seedCompletedFeature();
    const { fixture } = seeded;
    const host = await startHost({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fixture.box.capabilityCatalog,
      env: {},
    });
    hosts.push(host);
    client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    expect(client.handshake.capabilities.application.queries).toContain('features.delivery.get');

    const result = await client.getFeatureDelivery(fixture.projectId, fixture.featureId);
    expect(result.scope).toBe('feature-delivery');
    expect(result.feature).toMatchObject({ status: 'completed', deliveryStatus: 'succeeded' });
    expect(result.axes.tasks.allPassed).toBe(true);
    expect(result.axes.verification.status).toBe('passed');
    expect(result.axes.approval.status).toBe('approved');
    expect(result.axes.delivery).toMatchObject({ status: 'succeeded' });
    expect(result.outcome).toMatchObject({ status: 'completed', executionStage: null, nextStep: 'none' });
    expect(JSON.stringify(result)).not.toContain(seeded.worktreePath);

    // 线协议冻结字段集：未知键、completed 携带失败阶段、Task 有效通过与
    // 状态不一致、验证轴状态与批次不一致均 response_malformed。
    const extraKey = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    extraKey['worktreePath'] = seeded.worktreePath;
    expectWireMalformed('features.delivery.get', extraKey);
    const stagedCompleted = JSON.parse(JSON.stringify(result)) as {
      outcome: { executionStage: unknown };
    };
    stagedCompleted.outcome.executionStage = 'git_delivery';
    expectWireMalformed('features.delivery.get', stagedCompleted);
    const inconsistentTask = JSON.parse(JSON.stringify(result)) as {
      axes: { tasks: { records: { effectivePassed: boolean }[] } };
    };
    inconsistentTask.axes.tasks.records[0]!.effectivePassed = false;
    expectWireMalformed('features.delivery.get', inconsistentTask);
    const inconsistentVerification = JSON.parse(JSON.stringify(result)) as {
      axes: { verification: { status: string } };
    };
    inconsistentVerification.axes.verification.status = 'failed';
    expectWireMalformed('features.delivery.get', inconsistentVerification);

    // 稳定错误协议：未认证 401；未知查询参数 400；跨项目/不存在 not_found。
    const token = readFileSync(join(fixture.box.dataRoot, 'host', 'auth.token'), 'utf8');
    const base = `/v1/features/${encodeURIComponent(fixture.featureId)}/delivery?projectId=${encodeURIComponent(fixture.projectId)}`;
    expect((await loopbackRequest({ port: host.port, method: 'GET', path: base })).statusCode).toBe(401);
    expect(
      (
        await loopbackRequest({
          port: host.port,
          method: 'GET',
          path: `${base}&bogus=1`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(400);
    await expect(client.getFeatureDelivery(randomUUID(), fixture.featureId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(client.getFeatureDelivery(fixture.projectId, 'feature-x')).rejects.toMatchObject({
      code: 'not_found',
    });
    // 客户端输入校验先于任何请求。
    await expect(client.getFeatureDelivery(fixture.projectId, '../etc')).rejects.toSatisfy(
      (error: unknown) => isHostProtocolError(error) && error.code === 'invalid_input',
    );
  }, 60_000);
});

function expectWireMalformed(operation: string, body: unknown): void {
  try {
    validateAppQueryResponse(operation as never, body);
  } catch (error) {
    if (!isHostProtocolError(error)) throw error;
    expect(error.code).toBe('response_malformed');
    return;
  }
  throw new Error(`预期 response_malformed（${operation}），实际通过`);
}
