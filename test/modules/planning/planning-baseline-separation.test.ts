/**
 * DAG / F-002 规划基线身份传播与编码准备分离（真实临时 SQLite/Git；无模型调用）。
 *
 * 覆盖：
 * - 纯规则（见 planning-baseline-rules.test.ts）：computePlanningCodeBaselineDigest
 *   覆盖仓库绑定身份、历史摘要公式兼容、成组校验、resolveWorkspaceBaseCommit
 *   优先级与绑定不一致拒绝、planning 目录派生。
 * - 服务级（生产形态读取器=项目绑定源仓库只读快照）：planning.start → 输入
 *   准备 → 启动前重核全链成功，快照/manifest 携带绑定身份；绑定 revision 漂移
 *   或仓库身份变化 fail-closed；快照缺失结构化拒绝。
 * - 模块足迹：规划输入准备/重核不创建 managed_workspaces、不产生 workspace
 *   租约、不改变源仓库 refs/worktree（只读快照；无 Feature 编码分支提交）。
 * - 已批准规划基线读取（readApprovedPlanningCodeBaseline）：规划批准应用的
 *   当前计划返回冻结 headCommit（源仓库 HEAD 后来移动不跟随）；计划非规划
 *   应用（无同事务审批行）返回 null；Attempt 缺失或基线摘要漂移结构化拒绝。
 *
 * DAG / F-002（attempt 2 追加）规划 Runtime 工作区分离：
 * - locatePlanningWorkspace 令牌与 Feature 编码 worktree 资源键严格不同；
 * - locatePlanningWorkspace 令牌与 Feature 编码 worktree 资源键严格不同；
 * - createPlanningSnapshotWorktreePreparer：detached worktree 固定冻结基线、
 *   幂等复用、漂移/非祖先/脏现场 fail-closed、源仓库 refs 零写入。
 *   （F-007 夹具级运行时行为由 p05-1-f007-planning-execution 覆盖。）
 *
 * 本文件不覆盖（留给 Phase 集成）：真实 planning Runtime 进程全链、SQLite
 * 重启恢复与跨层 Host 调度场景。
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqlitePlanningContextStore } from '../../../packages/core/src/adapters/sqlite/planning-context-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import type { ArtifactFileStore } from '../../../packages/core/src/ports/artifact-files.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createPlanningSnapshotWorktreePreparer } from '../../../packages/core/src/adapters/fs/planning-snapshot-workspace.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { derivePlanningWorkspaceRelativeDir } from '../../../packages/core/src/ports/path-service.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createPlanningStartService } from '../../../packages/core/src/application/planning-start.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createExecutionInputService } from '../../../packages/core/src/application/execution-input.ts';
import { createPlanningInputPrepareService } from '../../../packages/core/src/application/planning-input-prepare.ts';
import type { PlanningInputPreparePort } from '../../../packages/core/src/application/planning-input-prepare.ts';
import { computePlanningCodeBaselineDigest } from '../../../packages/core/src/ports/planning-input-prepare.ts';
import type { PlanningCodeBaseline } from '../../../packages/core/src/ports/planning-input-prepare.ts';
import { readApprovedPlanningCodeBaseline } from '../../../packages/core/src/adapters/sqlite/planning-baseline.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PlanningAcceptedCommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import type { CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { testPromptTemplates } from '../../helpers/prompt-templates.ts';

const NOW = 1_901_400_000_000;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const PLANNING_BUDGET = {
  batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: NOW + 3_600_000 },
  run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
};

function expectPublicError(error: unknown, code: string, reason?: string): void {
  expect(error).toBeInstanceOf(PublicError);
  const publicError = error as PublicError;
  expect(publicError.code).toBe(code);
  if (reason !== undefined) {
    expect((publicError.details as Record<string, unknown> | undefined)?.reason).toBe(reason);
  }
}

/* ------------------------------------------------------------------ *
 * 真实夹具（生产形态读取器：项目绑定源仓库只读快照）
 * ------------------------------------------------------------------ */

interface F002Fixture {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly featureRevision: number;
  readonly planningRunId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly service: PlanningInputPreparePort;
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  /** 测试注入：读取器视角的绑定并发计数漂移。 */
  driftBinding(revision: number): void;
  /** 测试注入：读取器视角的仓库身份漂移。 */
  driftRepoIdentity(): void;
  close(): void;
}

let fixture: F002Fixture | undefined;
const fixtures: F002Fixture[] = [];
afterEach(() => {
  fixture?.close();
  fixture = undefined;
  for (const extra of fixtures.splice(0)) extra.close();
});

async function openFixture(): Promise<F002Fixture> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-dag-f002-' });
  try {
    const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
    const session = harness.session;
    const nowUtcMs = (): number => NOW;

    const artifactStore = createSqliteArtifactStore(session, { nowUtcMs });
    const files: ArtifactFileStore = createArtifactFileStore({ dataRoot: box.dataRoot });
    const publisher = createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } });
    const verifier = createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 16_000_000 } });

    const stateStore = createSqliteStateStore(session);
    /* 生产形态代码基线读取器：项目绑定源仓库只读快照 + 绑定身份核验
     * （与 composition.readCodeBaseline 同一语义；不依赖任何受管 worktree）。
     * bindingOverride 仅测试注入：模拟绑定并发计数/身份漂移（绑定行不可变
     * 触发器阻止直接 UPDATE；生产路径不可达）。 */
    let bindingOverride: { revision: number; repoIdentity: string } | null = null;
    const repositoryInspector = createRepositoryInspector();
    const readCodeBaseline = async (input: { readonly projectId: string; readonly featureId: string }) => {
      const binding = await stateStore.getRepositoryBinding(input.projectId);
      const inspection = await repositoryInspector.inspect(binding.canonicalPath);
      const repoIdentity = bindingOverride?.repoIdentity ?? binding.repoIdentity;
      const bindingRevision = bindingOverride?.revision ?? binding.bindingRevision;
      if (inspection.repoIdentity !== repoIdentity || inspection.gitCommonDir !== binding.gitCommonDir) {
        throw new PublicError('conflict', 'planning.baseline', undefined, { details: { reason: 'repository_binding_changed' } });
      }
      if (inspection.headCommit === null || inspection.workingTreeDigest === undefined) return null;
      return { worktreeId: binding.id, headCommit: inspection.headCommit, codeDigest: inspection.workingTreeDigest,
        repositoryBindingId: binding.id, repositoryBindingRevision: bindingRevision, repoIdentity };
    };

    const service = createPlanningInputPrepareService({ promptTemplates: testPromptTemplates,
      views: createSqlitePlanningContextStore(session, { nowUtcMs }),
      inputs: createExecutionInputService({
        artifacts: artifactStore, publisher, verifier,
        sources: { openSourceRead: async () => { throw new Error('file sources not configured in this fixture'); } },
        limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
        nowMs: nowUtcMs,
      }),
      artifacts: artifactStore, publisher, verifier,
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      readCodeBaseline,
      limits: { maxRequiredItems: 8 },
      nowMs: nowUtcMs,
    });

    const commands = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
      repositoryInspector,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
      ]),
      planningStart: createPlanningStartService({ nowMs: nowUtcMs }),
      nowUtcMs,
    });
    const owner = createLocalOwnerPrincipal();
    const envelope = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(), operation, payload, ...extra,
    });
    const submit = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
      const receipt = await commands.submit(owner, envelope(operation, payload, extra));
      if (receipt.status !== 'completed' && receipt.status !== 'accepted') {
        throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
      }
      return receipt;
    };

    const registered = await submit('project.register', {
      repositoryPath: box.repoDirA, displayName: 'DAG F-002', description: null, labels: [],
    }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
    const projectId = registered.result.project.id;
    const scope = { kind: 'project' as const, projectId };
    await submit('settings.global.create', {
      schemaVersion: 2, strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
      },
    }, { scope: { kind: 'global' } });
    await submit('phase.create', { id: 'phase-1', title: 'DAG', description: null, labels: [] }, { scope });
    const imported = await submit('feature.plan.import', {
      phaseId: 'phase-1', plan: {
        schemaVersion: 1,
        feature: { title: '规划基线目标', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 't-1', title: '草稿任务', acceptance: { criteria: ['可规划'] }, dependsOn: [] }],
      },
    }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
    const featureId = imported.result.feature.id;

    const planningReceipt = await submit(PLANNING_START_OPERATION, {
      schemaVersion: 1, projectId, phaseId: 'phase-1', featureId,
      requirementRefs: [],
      constraints: ['不占用正式编码工作区'],
      acceptance: { criteria: ['候选包含 Task 拆分'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
    }, { scope, expectedRevision: imported.result.feature.revision });
    const accepted = planningReceipt as PlanningAcceptedCommandReceipt;
    /* 注册后捕获绑定事实（漂移注入的基准快照）。 */
    const bindingSnapshot = await stateStore.getRepositoryBinding(projectId);

    return {
      box, session, projectId, featureId,
      featureRevision: imported.result.feature.revision,
      planningRunId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId,
      service, artifacts: artifactStore,
      driftBinding(revision) {
        bindingOverride = { revision, repoIdentity: bindingSnapshot.repoIdentity };
      },
      driftRepoIdentity() {
        bindingOverride = { revision: bindingSnapshot.bindingRevision, repoIdentity: 'gitdir-sha256:' + 'f'.repeat(64) };
      },
      close() { session.close(); box.cleanup(); },
    };
  } catch (error) {
    box.cleanup();
    throw error;
  }
}

describe('DAG / F-002 规划输入准备（生产形态只读快照读取器）', () => {
  it('准备与重核成功：快照/manifest 携带仓库绑定身份；模块不产生编码工作区/分支/租约', async () => {
    const f = fixture = await openFixture();
    const refsBefore = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: f.box.repoDirA, encoding: 'utf8' });
    const worktreesBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: f.box.repoDirA, encoding: 'utf8' });

    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    await f.service.recheckPlanningInputPreparation(f.projectId, prepared);

    /* 快照正文中的代码基线=项目绑定源仓库只读快照（含绑定身份三元组）。 */
    const stateStore = createSqliteStateStore(f.session);
    const binding = await stateStore.getRepositoryBinding(f.projectId);
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.box.repoDirA, encoding: 'utf8' }).trim();
    expect(prepared.codeBaseline).toMatchObject({
      worktreeId: binding.id, headCommit: sourceHead,
      repositoryBindingId: binding.id,
      repositoryBindingRevision: binding.bindingRevision,
      repoIdentity: binding.repoIdentity,
    });
    const snapshotArtifact = await createArtifactVerifier({
      artifacts: f.artifacts, files: createArtifactFileStore({ dataRoot: f.box.dataRoot }), limits: { maxReadBytes: 2_000_000 },
    }).readVerifiedContent(f.projectId, prepared.group.snapshot.artifactId);
    const snapshot = JSON.parse(Buffer.from(snapshotArtifact.content).toString('utf8')) as { codeBaseline: PlanningCodeBaseline };
    expect(snapshot.codeBaseline).toMatchObject({ repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision });
    /* 摘要覆盖绑定身份：按同一公式重算一致。 */
    expect(computePlanningCodeBaselineDigest(snapshot.codeBaseline)).toBe(prepared.digests.codeBaselineDigest);

    /* 模块足迹：不创建 managed_workspaces / workspace_leases / 源仓库 refs 不变。 */
    expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get()).toEqual({ n: 0 });
    expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get()).toEqual({ n: 0 });
    expect(execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: f.box.repoDirA, encoding: 'utf8' })).toBe(refsBefore);
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: f.box.repoDirA, encoding: 'utf8' })).toBe(worktreesBefore);
  }, 60_000);

  it('绑定 revision 漂移：启动前重核 fail-closed（code_baseline_drift）', async () => {
    const f = fixture = await openFixture();
    const binding = await createSqliteStateStore(f.session).getRepositoryBinding(f.projectId);
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared)).resolves.toBeUndefined();
    /* 模拟绑定并发计数推进（重登记/绑定更新；生产路径不可达的漂移注入）。 */
    f.driftBinding(binding.bindingRevision + 1);
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => {
        expectPublicError(error, 'conflict', 'code_baseline_drift');
        return true;
      });
  }, 60_000);

  it('仓库身份变化：读取器 fail-closed（repository_binding_changed），不被改写为 internal', async () => {
    const f = fixture = await openFixture();
    await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    f.driftRepoIdentity();
    await expect(f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => {
        expectPublicError(error, 'conflict', 'repository_binding_changed');
        return true;
      });
  }, 60_000);

  it('快照缺失（无 HEAD/摘要不可得）：结构化拒绝（code_baseline_unavailable）', async () => {
    const f = fixture = await openFixture();
    /* 注入返回 null 的读取器（同 F-004 纪律的测试注入；生产不可达）。 */
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const nullReaderService = createPlanningInputPrepareService({
      promptTemplates: testPromptTemplates,
      views: createSqlitePlanningContextStore(f.session, { nowUtcMs: () => NOW }),
      inputs: createExecutionInputService({
        artifacts: f.artifacts,
        publisher: createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } }),
        verifier: createArtifactVerifier({ artifacts: f.artifacts, files, limits: { maxReadBytes: 16_000_000 } }),
        sources: { openSourceRead: async () => { throw new Error('file sources not configured'); } },
        limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
        nowMs: () => NOW,
      }),
      artifacts: f.artifacts,
      publisher: createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } }),
      verifier: createArtifactVerifier({ artifacts: f.artifacts, files, limits: { maxReadBytes: 2_000_000 } }),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      readCodeBaseline: async () => null,
      limits: { maxRequiredItems: 8 },
      nowMs: () => NOW,
    });
    await expect(nullReaderService.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => {
        expectPublicError(error, 'conflict', 'code_baseline_unavailable');
        return true;
      });
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * 已批准规划基线读取与编码基线解析（criterion 3）
 * ------------------------------------------------------------------ */

/** 在真实 planning.start 事实之上伪造「已批准并应用」链（测试注入；决策/审批
 * 行为本身由 p05-1-f008 覆盖）。返回伪造使用的冻结基线。 */
async function fabricateApprovedPlanningChain(f: F002Fixture, options: {
  readonly baseline?: PlanningCodeBaseline;
  readonly skipApproval?: boolean;
  readonly skipAttempt?: boolean;
  readonly corruptDigest?: boolean;
} = {}): Promise<{ readonly headCommit: string; readonly decidedAt: number }> {
  const stateStore = createSqliteStateStore(f.session);
  const binding = await stateStore.getRepositoryBinding(f.projectId);
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.box.repoDirA, encoding: 'utf8' }).trim();
  const codeBaseline: PlanningCodeBaseline = options.baseline ?? {
    worktreeId: binding.id, headCommit: sourceHead,
    codeDigest: sha256('f002-frozen-code'),
    repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision,
    repoIdentity: binding.repoIdentity,
  };
  const decidedAt = NOW + 1_000;
  const feature = f.session.database.prepare<[string, string], { revision: number; plan_digest: string | null }>(
    'SELECT revision, plan_digest FROM features WHERE project_id = ? AND id = ?').get(f.projectId, f.featureId)!;

  /* 伪造 planning attempt（真实 planning Run 已存在；group 引用真实 ready 制品）。 */
  let attemptId: string | null = null;
  if (!options.skipAttempt) {
    const body = Buffer.from(`{"schemaVersion":1,"fixture":"f002-${randomUUID()}"}`, 'utf8');
    const published = await createArtifactPublisher({
      artifacts: f.artifacts, files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
      limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 },
    }).publishArtifact({ projectId: f.projectId, kind: 'execution-input', mediaType: 'application/json',
      expectedHash: sha256(body), locator: `execution-inputs/f002-${randomUUID()}`, content: [body] });
    const record = published.artifact;
    const groupRef = { projectId: f.projectId, artifactId: record.id, version: record.version,
      contentHash: record.contentHash!, sizeBytes: record.sizeBytes!, locator: record.locator, mediaType: record.mediaType };
    attemptId = randomUUID();
    const digest = computePlanningCodeBaselineDigest(codeBaseline);
    const inputSnapshot = {
      purpose: 'planning', schemaVersion: 1, projectId: f.projectId, featureId: f.featureId,
      taskId: f.planningTaskId, runId: f.planningRunId, candidateId: f.candidateId,
      group: { snapshot: groupRef }, requiredInputs: [],
      digests: { snapshotDigest: sha256('f002-snapshot'), manifestDigest: sha256('f002-manifest'),
        promptDigest: sha256('f002-prompt'), strategyCopyDigest: sha256('f002-strategy'),
        permissionsDigest: sha256('f002-permissions'),
        codeBaselineDigest: options.corruptDigest ? '0'.repeat(64) : digest },
      codeBaseline, preparedAtUtcMs: NOW,
    };
    f.session.database.prepare(
      'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
        'owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, ' +
        'input_digest, input_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    ).run(attemptId, NOW, f.projectId, NOW, f.featureId, f.planningRunId, f.planningTaskId,
      'f002-fixture-owner', 'f002-fixture-host', NOW + 60_000, 'failed', 'runtime',
      JSON.stringify(inputSnapshot), sha256('f002-snapshot'), record.id);
  }

  /* 规划上下文决策 + 同事务时间戳的 plan approval（当前 plan_digest 即应用结果）。
   * planning.start 已建立真实上下文行；此处补齐候选字段（CHECK 形状要求 +
   * candidate_artifact FK）并更新决策字段（测试注入，决策行为本身由
   * p05-1-f008 覆盖）。 */
  const candidateBody = Buffer.from(`{"schemaVersion":1,"fixtureCandidate":"${randomUUID()}"}`, 'utf8');
  const candidateArtifact = await createArtifactPublisher({
    artifacts: f.artifacts, files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 },
  }).publishArtifact({ projectId: f.projectId, kind: 'planning-candidate', mediaType: 'application/json',
    expectedHash: sha256(candidateBody), locator: `planning-candidates/f002-${randomUUID()}`, content: [candidateBody] });
  const candidateDigest = sha256('f002-candidate');
  f.session.database.prepare(
    "UPDATE planning_contexts SET status = 'applied', decision = 'approved', decision_reason = 'fixture', " +
      'decided_at = ?, applied_revision = ?, applied_at = ?, updated_at = ?, candidate_artifact_id = ?, ' +
      'candidate_content_hash = ?, candidate_digest = ?, candidate_summary = ? WHERE project_id = ? AND candidate_id = ?',
  ).run(decidedAt, feature.revision, decidedAt, decidedAt, candidateArtifact.artifact.id,
    candidateArtifact.artifact.contentHash, candidateDigest, 'fixture summary',
    f.projectId, f.candidateId);
  if (!options.skipApproval) {
    f.session.database.prepare(
      'INSERT INTO approvals (id, created_at, project_id, revision, updated_at, subject_type, subject_id, ' +
        "subject_digest, check_policy_digest, status, decision_actor, reason, decided_at) VALUES (?, ?, ?, 1, ?, " +
        "'feature_plan', ?, ?, ?, 'approved', 'f002-fixture', 'fixture', ?)",
    ).run(randomUUID(), decidedAt, f.projectId, decidedAt, f.featureId, feature.plan_digest,
      sha256('f002-policy'), decidedAt);
  }
  return { headCommit: codeBaseline.headCommit, decidedAt };
}

describe('DAG / F-002 已批准规划基线读取（readApprovedPlanningCodeBaseline）', () => {
  it('规划批准应用的当前计划：返回冻结 headCommit，不跟随源仓库后来移动的 HEAD', async () => {
    const f = fixture = await openFixture();
    const { headCommit } = await fabricateApprovedPlanningChain(f);
    expect(readApprovedPlanningCodeBaseline(f.session, f.projectId, f.featureId)).toMatchObject({
      headCommit, repositoryBindingId: (await createSqliteStateStore(f.session).getRepositoryBinding(f.projectId)).id,
      runId: f.planningRunId, candidateId: f.candidateId,
    });
    /* 源仓库 HEAD 前进后仍返回冻结快照（不跟随移动的 HEAD）。 */
    execFileSync('git', ['commit', '--allow-empty', '-m', 'move head after planning'], { cwd: f.box.repoDirA });
    expect(readApprovedPlanningCodeBaseline(f.session, f.projectId, f.featureId)?.headCommit).toBe(headCommit);
  }, 60_000);

  it('当前计划非规划批准应用（无同事务审批行）时返回 null（沿用既有预览语义）', async () => {
    const f = fixture = await openFixture();
    await fabricateApprovedPlanningChain(f, { skipApproval: true });
    expect(readApprovedPlanningCodeBaseline(f.session, f.projectId, f.featureId)).toBeNull();
  }, 60_000);

  it('Attempt 证据缺失或基线摘要漂移：结构化拒绝（fail-closed，不回退当前 HEAD）', async () => {
    const fA = await openFixture();
    fixtures.push(fA);
    await fabricateApprovedPlanningChain(fA, { skipAttempt: true });
    expect(() => readApprovedPlanningCodeBaseline(fA.session, fA.projectId, fA.featureId))
      .toThrowError(/planning_attempt_missing/);

    const fB = await openFixture();
    fixtures.push(fB);
    await fabricateApprovedPlanningChain(fB, { corruptDigest: true });
    expect(() => readApprovedPlanningCodeBaseline(fB.session, fB.projectId, fB.featureId))
      .toThrowError(/planning_code_baseline_digest_mismatch/);
  }, 120_000);
});

describe('DAG / F-002 规划快照准备器（真实 Git）', () => {
  it('在冻结基线创建 detached worktree：无分支、幂等复用、源仓库零写入', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-dag-f002-prep-' });
    try {
      const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
      const session = harness.session;
      const nowUtcMs = (): number => NOW;
      const artifactStore = createSqliteArtifactStore(session, { nowUtcMs });
      const stateStore = createSqliteStateStore(session);
      const queryStore = createSqliteQueryStore(session, { nowUtcMs });
      const files = createArtifactFileStore({ dataRoot: box.dataRoot });
      const publisher = createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } });
      const verifier = createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 16_000_000 } });
      const paths = createPathService({ dataRoot: box.dataRoot, projectLookup: stateStore, featureLookup: queryStore });
      const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.dataRoot], preparationPaths: paths });
      const commands = createCommandService({
        atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
        repositoryInspector: createRepositoryInspector(),
        capabilityCatalog: createStaticRuntimeCapabilityCatalog([
          { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
        ]),
        planningStart: createPlanningStartService({ nowMs: nowUtcMs }),
        nowUtcMs,
      });
      const owner = createLocalOwnerPrincipal();
      const submit = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
        const receipt = await commands.submit(owner, {
          schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(), operation, payload, ...extra,
        });
        if (receipt.status !== 'completed' && receipt.status !== 'accepted') {
          throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
        }
        return receipt;
      };
      const registered = await submit('project.register', {
        repositoryPath: box.repoDirA, displayName: 'F-002 prep', description: null, labels: [],
      }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
      const projectId = registered.result.project.id;
      const scope = { kind: 'project' as const, projectId };
      await submit('settings.global.create', {
        schemaVersion: 2, strategies: {
          defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        },
      }, { scope: { kind: 'global' } });
      await submit('phase.create', { id: 'phase-1', title: 'DAG', description: null, labels: [] }, { scope });
      const imported = await submit('feature.plan.import', {
        phaseId: 'phase-1', plan: {
          schemaVersion: 1,
          feature: { title: '快照准备目标', description: null, labels: [], sourceRefs: [] },
          tasks: [{ id: 't-1', title: '草稿', acceptance: { criteria: ['可规划'] }, dependsOn: [] }],
        },
      }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string } } };
      const featureId = imported.result.feature.id;

      const binding = await stateStore.getRepositoryBinding(projectId);
      const preparer = createPlanningSnapshotWorktreePreparer({
        inspector: createRepositoryInspector(),
        paths,
        commandProcess: createCommandProcessAdapter(),
        confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
      });
      const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.repoDirA, encoding: 'utf8' }).trim();
      const refsBefore = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: box.repoDirA, encoding: 'utf8' });

      const first = await preparer.ensure({ binding, featureId, headCommit: baselineCommit });
      const target = join(box.dataRoot, derivePlanningWorkspaceRelativeDir(projectId, featureId));
      expect(first.canonicalPath).toBe(target);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim()).toBe(baselineCommit);
      expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim()).toBe('HEAD');
      /* 源仓库零写入：无新分支/引用移动（规划不产生编码分支提交）。 */
      expect(execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: box.repoDirA, encoding: 'utf8' })).toBe(refsBefore);

      /* 幂等复用：同一冻结基线再次 ensure 返回同一路径，不重建。 */
      const again = await preparer.ensure({ binding, featureId, headCommit: baselineCommit });
      expect(again.canonicalPath).toBe(target);

      /* 认领令牌与编码 worktree 资源键严格不同（规划不占编码资源租约）。 */
      const planningToken = await authority.locatePlanningWorkspace(binding, featureId);
      const codingToken = await authority.verifyPreparation(binding, featureId);
      expect(planningToken.resourceKey).not.toBe(codingToken.resourceKey);
      expect(planningToken.canonicalPath).toContain('/planning/');
      session.close();
    } finally {
      box.cleanup();
    }
  }, 120_000);

  it('[case:planning-snapshot-stale] 现场不在冻结基线或基线非祖先：fail-closed', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-dag-f002-stale-' });
    try {
      const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
      const session = harness.session;
      const stateStore = createSqliteStateStore(session);
      const queryStore = createSqliteQueryStore(session);
      const paths = createPathService({ dataRoot: box.dataRoot, projectLookup: stateStore, featureLookup: queryStore });
      const commands = createCommandService({
        atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW }),
        repositoryInspector: createRepositoryInspector(),
        capabilityCatalog: createStaticRuntimeCapabilityCatalog([
          { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['m'] }] },
        ]),
        planningStart: createPlanningStartService({ nowMs: () => NOW }),
        nowUtcMs: () => NOW,
      });
      const owner = createLocalOwnerPrincipal();
      const submit = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
        const receipt = await commands.submit(owner, {
          schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(), operation, payload, ...extra,
        });
        if (receipt.status !== 'completed' && receipt.status !== 'accepted') throw new Error(JSON.stringify(receipt));
        return receipt;
      };
      const registered = await submit('project.register', {
        repositoryPath: box.repoDirA, displayName: 'F-002 stale', description: null, labels: [],
      }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
      const projectId = registered.result.project.id;
      const scope = { kind: 'project' as const, projectId };
      await submit('settings.global.create', {
        schemaVersion: 2, strategies: {
          defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'm' },
          purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'm' } },
        },
      }, { scope: { kind: 'global' } });
      await submit('phase.create', { id: 'phase-1', title: 'DAG', description: null, labels: [] }, { scope });
      const imported = await submit('feature.plan.import', {
        phaseId: 'phase-1', plan: {
          schemaVersion: 1,
          feature: { title: '漂移目标', description: null, labels: [], sourceRefs: [] },
          tasks: [{ id: 't-1', title: '草稿', acceptance: { criteria: ['可规划'] }, dependsOn: [] }],
        },
      }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string } } };
      const featureId = imported.result.feature.id;
      const binding = await stateStore.getRepositoryBinding(projectId);
      const preparer = createPlanningSnapshotWorktreePreparer({
        inspector: createRepositoryInspector(),
        paths,
        commandProcess: createCommandProcessAdapter(),
        confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
      });

      /* 基线对象不在源仓库（历史缺失）：拒绝（cat-file 非零 → git_command_failed）。 */
      await expect(preparer.ensure({ binding, featureId, headCommit: 'e'.repeat(40) }))
        .rejects.toMatchObject({ name: 'PlanningSnapshotWorkspaceError', reason: 'git_command_failed' });

      /* 源 HEAD 前进后旧快照仍是祖先：可创建（固定旧基线）。 */
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.repoDirA, encoding: 'utf8' }).trim();
      execFileSync('git', ['commit', '--allow-empty', '-m', 'advance head'], { cwd: box.repoDirA });
      const ensured = await preparer.ensure({ binding, featureId, headCommit: base });
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ensured.canonicalPath, encoding: 'utf8' }).trim()).toBe(base);

      /* 现场漂移：既有目录不在（新的）冻结基线时拒绝，不自动重建。 */
      const moved = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.repoDirA, encoding: 'utf8' }).trim();
      await expect(preparer.ensure({ binding, featureId, headCommit: moved }))
        .rejects.toMatchObject({ name: 'PlanningSnapshotWorkspaceError', reason: 'planning_workspace_not_at_baseline' });
      session.close();
    } finally {
      box.cleanup();
    }
  }, 120_000);
});
