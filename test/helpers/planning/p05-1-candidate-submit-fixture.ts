/**
 * P05-1 / F-006 规划候选受限提交夹具（真实临时文件/SQLite/Git 纵向）。
 *
 * 全真实资源：真实 Git 仓库 + 真实 SQLite + 真实制品文件；经公开命令通道完成
 * 注册 → 配置 → 草稿计划导入 → planning.start（F-003）→ F-004 规划输入准备 →
 * F-005 派发准备与真实 planning 原子认领。随后以直接 SQL 把认领产物推进到
 * 「Runtime 已启动」的等价现场（attempt executing + invocation 绑定、Run/Batch
 * running——生产路径由后续启动 Task 接线；与 P04-2 work-tool-fixture 同一
 * 夹具纪律），再装配带规划发布依赖的 Core Work 工具通道。
 *
 * 本夹具不调用模型；不提供任何文件路径/数据库直连的候选提交入口。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqlitePlanningContextStore } from '../../../packages/core/src/adapters/sqlite/planning-context-store.ts';
import { createSqlitePlanningClaimStore } from '../../../packages/core/src/adapters/sqlite/planning-claim-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { deriveFeatureWorktreeRelativeDir } from '../../../packages/core/src/ports/path-service.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createPlanningStartService } from '../../../packages/core/src/application/planning-start.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createExecutionInputService } from '../../../packages/core/src/application/execution-input.ts';
import { createPlanningInputPrepareService } from '../../../packages/core/src/application/planning-input-prepare.ts';
import type { PlanningInputPreparePort } from '../../../packages/core/src/application/planning-input-prepare.ts';
import { createPlanningDispatchPrepareService } from '../../../packages/core/src/application/planning-dispatch.ts';
import { createWorkToolChannel } from '../../../packages/core/src/application/work-tool-channel.ts';
import type { WorkToolBridge } from '../../../packages/core/src/application/work-tool-channel.ts';
import { createVerificationCandidateValidator } from '../../../packages/core/src/application/verification-candidates.ts';
import { createTestTargetResolver } from '../../../packages/core/src/adapters/fs/verification-target-resolver.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import {
  PLANNING_CANDIDATE_SUBMIT_OPERATION,
} from '../../../packages/core/src/ports/planning-candidates.ts';
import type { WorkAccessOperation } from '../../../packages/core/src/ports/work-access.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createCommandsTestFixture } from '../p02-2/index.ts';
import type { CommandsTestFixture } from '../p02-2/index.ts';
import { git } from '../git-repo.ts';

export const SUBMIT_NOW = 1_900_300_000_000;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const PLANNING_BUDGET = {
  batch: {
    maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1,
    deadlineUtcMs: SUBMIT_NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
};

/** 与 settings.purposeStrategies.planner 一致的冻结策略（F-002 策略副本）。 */
export const PLANNER_STRATEGY = { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } as const;

export interface PlanningSubmitBinding {
  readonly principal: TrustedPrincipal;
  readonly projectId: string;
  readonly hostInstanceId: string;
  readonly identity: { purpose: 'work'; runId: string; taskId: string; attemptId: string };
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly nowUtcMs: number;
  readonly strategy: { runtime: 'pi'; provider: string; model: string };
}

export interface PlanningSubmitFixture {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly invocationId: string;
  readonly hostInstanceId: string;
  readonly dataRoot: string;
  readonly channel: ReturnType<typeof createWorkToolChannel>;
  readonly bridge: WorkToolBridge;
  readonly binding: PlanningSubmitBinding;
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly files: ReturnType<typeof createArtifactFileStore>;
  readonly publisher: Pick<ReturnType<typeof createArtifactPublisher>, 'publishArtifact'>;
  /** 有效规划候选正文（JSON 文本；可覆盖字段）。 */
  candidateBody(overrides?: Record<string, unknown>): string;
  /** 命令信封工厂（默认 planning.candidate.submit + candidate 正文）。 */
  request(options?: {
    operation?: string;
    commandId?: string;
    candidate?: string;
    payload?: Record<string, unknown>;
    scope?: { kind: 'project'; projectId: string };
  }): Record<string, unknown>;
  /** 重新 bind（不同 operations / 是否装配规划发布依赖 / 独立 grant）。 */
  bindBridge(options?: { operations?: readonly WorkAccessOperation[]; withPlanning?: boolean }): WorkToolBridge;
  /** 切换当前可信绑定（null = 撤权）。 */
  setCurrent(value: PlanningSubmitBinding | null): void;
  /** 关键持久表受控快照。 */
  snapshot(): Record<string, unknown[]>;
  /** planning_contexts 当前行（含绑定 planning Task 快照）。 */
  planningContext(): Record<string, unknown>;
  close(): void;
}

export async function openPlanningSubmitFixture(options: {
  /** 包装受管发布（注入撤权/延迟等；返回原发布结果）。 */
  wrapPublisher?: (
    publisher: ReturnType<typeof createArtifactPublisher>,
  ) => { publishArtifact(input: unknown): Promise<import('../../../packages/core/src/application/artifact-publish.ts').ArtifactPublishResult> };
} = {}): Promise<PlanningSubmitFixture> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p051-f006-' });
  try {
    const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
    const session = harness.session;
    const nowUtcMs = (): number => SUBMIT_NOW;

    const artifactStore = createSqliteArtifactStore(session, { nowUtcMs });
    const files = createArtifactFileStore({ dataRoot: box.dataRoot });
    const realPublisher = createArtifactPublisher({
      artifacts: artifactStore, files,
      limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 }, nowMs: nowUtcMs,
    });
    const publisher: Pick<typeof realPublisher, 'publishArtifact'> = options.wrapPublisher === undefined
      ? realPublisher
      : { publishArtifact: (input: unknown) => options.wrapPublisher!(realPublisher).publishArtifact(input) };
    const verifier = createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 16_000_000 } });

    const stateStore = createSqliteStateStore(session);
    const queryStore = createSqliteQueryStore(session);
    const paths = createPathService({ dataRoot: box.dataRoot, projectLookup: stateStore, featureLookup: queryStore });
    const workspaceAuthority = createWorkWorkspaceAuthority({ authorizedRoots: [box.dataRoot], preparationPaths: paths });
    const workspaceInspector = createWorkspaceInspector({
      authorizedRoots: [box.dataRoot],
      confirmProcessIdentity: async (identity) => ({ launchId: identity.launchId }),
    });
    const readCodeBaseline = async (input: { readonly projectId: string; readonly featureId: string }) => {
      const row = session.database.prepare<[string, string], {
        repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
        canonical_path: string; git_common_dir: string; branch: string; base_commit: string; id: string;
      }>('SELECT id, repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit FROM managed_workspaces WHERE project_id = ? AND feature_id = ?')
        .get(input.projectId, input.featureId);
      if (row === undefined) return null;
      const inspection = await workspaceInspector.inspect({
        repositoryBindingId: row.repository_binding_id,
        repositoryBindingRevision: row.repository_binding_revision,
        repoIdentity: row.repo_identity,
        canonicalPath: row.canonical_path,
        gitCommonDir: row.git_common_dir,
        branch: row.branch,
        baseCommit: row.base_commit,
      });
      return { worktreeId: row.id, headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest };
    };

    const planningInputs: PlanningInputPreparePort = createPlanningInputPrepareService({
      views: createSqlitePlanningContextStore(session, { nowUtcMs }),
      inputs: createExecutionInputService({
        artifacts: artifactStore,
        publisher: realPublisher,
        verifier,
        sources: { openSourceRead: async () => { throw new Error('file sources not configured in this fixture'); } },
        limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
        nowMs: nowUtcMs,
      }),
      artifacts: artifactStore,
      publisher: createArtifactPublisher({
        artifacts: artifactStore, files,
        limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 }, nowMs: nowUtcMs,
      }),
      verifier,
      permissions: () => ({ grants: [] }),
      readCodeBaseline,
      limits: { maxRequiredItems: 8 },
      nowMs: nowUtcMs,
    });

    const commands = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
      ]),
      planningStart: createPlanningStartService({ nowMs: nowUtcMs }),
      nowUtcMs,
    });
    const owner = createLocalOwnerPrincipal();
    const submit = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
      const receipt = await commands.submit(owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(SUBMIT_NOW).toISOString(),
        operation, payload, ...extra,
      });
      if (receipt.status !== 'completed' && receipt.status !== 'accepted') {
        throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
      }
      return receipt as CommandReceipt & { result: Record<string, unknown> };
    };

    const registered = await submit('project.register', {
      repositoryPath: box.repoDirA, displayName: 'P05-1 F-006', description: null, labels: [],
    }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
    const projectId = registered.result.project.id;
    const scope = { kind: 'project' as const, projectId };
    await submit('settings.global.create', {
      schemaVersion: 2, strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        purposeStrategies: { planner: { ...PLANNER_STRATEGY } },
      },
    }, { scope: { kind: 'global' } });
    await submit('phase.create', { id: 'phase-1', title: 'P05-1 F-006', description: null, labels: [] }, { scope });
    const featureRow = await submit('feature.plan.import', {
      phaseId: 'phase-1', plan: {
        schemaVersion: 1,
        feature: { title: '规划候选提交目标', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] }],
      },
    }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
    const featureId = featureRow.result.feature.id;
    const featureRevision = featureRow.result.feature.revision;

    const planningReceipt = await submit(PLANNING_START_OPERATION, {
      schemaVersion: 1,
      projectId,
      phaseId: 'phase-1',
      featureId,
      requirementRefs: [],
      constraints: ['不改变既有公开接口'],
      acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
    }, { scope, expectedRevision: featureRevision }) as CommandReceipt & {
      runId: string; planningTaskId: string; candidateId: string;
    };
    const accepted = planningReceipt;

    /* 真实受管 worktree + managed_workspaces 现场行（与 F-005 同一夹具形态）。 */
    const { deriveManagedFeatureBranch } = await import('../../../packages/core/src/ports/workspace-preparation.ts');
    const branch = deriveManagedFeatureBranch(projectId, featureId);
    const worktreePath = join(box.dataRoot, deriveFeatureWorktreeRelativeDir(projectId, featureId));
    mkdirSync(join(worktreePath, '..'), { recursive: true });
    git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], box.repoDirA);

    const binding = await stateStore.getRepositoryBinding(projectId);
    const hostAttemptId = randomUUID();
    const hostBodyRef = async (purpose: string) => {
      const body = Buffer.from(`{"schemaVersion":1,"fixtureHost":"${hostAttemptId}","purpose":"${purpose}"}`, 'utf8');
      const artifact = await realPublisher.publishArtifact({
        projectId, kind: 'execution-input', mediaType: 'application/json',
        expectedHash: sha256(body), locator: `execution-inputs/f006-host-${hostAttemptId}-${purpose}`, content: [body],
      });
      return { artifactId: artifact.artifact.id, version: artifact.artifact.version,
        contentHash: artifact.artifact.contentHash!, sizeBytes: artifact.artifact.sizeBytes!,
        locator: artifact.artifact.locator, mediaType: artifact.artifact.mediaType };
    };
    const [hostSnapshotRef, hostManifestRef, hostPromptRef] = await Promise.all(
      [hostBodyRef('snapshot'), hostBodyRef('manifest'), hostBodyRef('prompt')]);
    const hostSnapshot = JSON.stringify({
      schemaVersion: 3, projectId, featureId, taskId: 't-1',
      group: { snapshot: hostSnapshotRef, manifest: hostManifestRef, prompt: hostPromptRef },
      requiredInputs: [],
      digests: {
        snapshotDigest: sha256(`f006-host-${hostAttemptId}`),
        manifestDigest: sha256(`f006-host-manifest-${hostAttemptId}`),
        promptDigest: sha256(`f006-host-prompt-${hostAttemptId}`),
        strategyCopyDigest: sha256(`f006-host-strategy-${hostAttemptId}`),
        permissionsDigest: sha256(`f006-host-permissions-${hostAttemptId}`),
      },
      approval: { planDigest: sha256(`f006-host-plan-${hostAttemptId}`), checkPolicyDigest: sha256(`f006-host-checks-${hostAttemptId}`),
        decisionId: null, featureRevision: featureRevision + 1 },
      taskRevision: 1, promptBytes: 32, preparedAtUtcMs: SUBMIT_NOW,
      tokenEstimate: { value: 64, kind: 'estimation', method: 'fixture' },
    });
    session.transactWrite('f006.fixture.workspace', () => {
      session.database.prepare("UPDATE tasks SET execution_version = 1 WHERE id = ?").run('t-1');
      session.database.prepare(
        'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
          'owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, ' +
          "input_digest, input_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 1, ?, 'interrupted', 'preflight', ?, ?, ?)",
      ).run(hostAttemptId, SUBMIT_NOW, projectId, SUBMIT_NOW, featureId, accepted.runId, 't-1',
        'f006-fixture-owner', 'f006-fixture-host', SUBMIT_NOW, hostSnapshot,
        sha256(`f006-host-${hostAttemptId}`), hostSnapshotRef.artifactId);
      session.database.prepare(
        'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
          'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
          'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
          'host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ' +
          "?, ?, NULL, NULL, 'ready', ?, ?, ?, 1, ?, ?)",
      ).run(randomUUID(), SUBMIT_NOW, projectId, SUBMIT_NOW, featureId, binding.id, binding.bindingRevision,
        binding.repoIdentity, worktreePath, binding.gitCommonDir, branch,
        git(['rev-parse', 'HEAD'], box.repoDirA).trim(),
        randomUUID(), 'f006-fixture-owner', 'f006-fixture-host', accepted.runId, hostAttemptId);
    });

    const dispatchPrepare = createPlanningDispatchPrepareService({
      views: createSqlitePlanningContextStore(session, { nowUtcMs }),
      planningInputs,
      workspaceAuthority: workspaceAuthority,
      repositoryBindings: { getRepositoryBinding: p => stateStore.getRepositoryBinding(p) },
      batchDeadline: {
        readDeadlineUtcMs: (p: string, r: string): number | null => session.database.prepare<[string, string], { deadline_at: number | null }>(
          'SELECT b.deadline_at FROM runs r JOIN execution_batches b ON b.project_id = r.project_id AND b.id = r.batch_id WHERE r.project_id = ? AND r.id = ?',
        ).get(p, r)?.deadline_at ?? null,
      },
      taskFacts: {
        readTaskFacts: (p: string, t: string): { revision: number; executionVersion: number } | null => {
          const row = session.database.prepare<[string], { project_id: string; revision: number; execution_version: number }>(
            'SELECT project_id, revision, execution_version FROM tasks WHERE id = ?').get(t);
          return row === undefined || row.project_id !== p ? null : { revision: row.revision, executionVersion: row.execution_version };
        },
      },
      owner: 'f006-owner',
      hostInstanceId: 'f006-host',
      nowMs: nowUtcMs,
    });
    const claimInput = await dispatchPrepare.preparePlanningClaim({ projectId, runId: accepted.runId });
    const claimStore = createSqlitePlanningClaimStore(session, { workspaceAuthority, nowUtcMs: () => SUBMIT_NOW });
    const claim = claimStore.claimPlanningTask(claimInput);
    const attemptId = claim.receipt.attempt.id;
    const executionVersion = claim.receipt.attempt.executionVersion;

    /* 推进到「Runtime 已启动」等价现场（生产由启动链路写入；夹具直改受控状态列）。 */
    const invocationId = 'invocation-f006';
    session.transactWrite('f006.fixture.launch', () => {
      session.database.prepare("UPDATE attempts SET status = 'executing', invocation_id = ? WHERE id = ?").run(invocationId, attemptId);
      session.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(accepted.runId);
      session.database.prepare("UPDATE execution_batches SET status = 'running' WHERE id = (SELECT batch_id FROM runs WHERE id = ?)").run(accepted.runId);
    });

    const submitBinding: PlanningSubmitBinding = {
      principal: owner, projectId, hostInstanceId: 'f006-host',
      identity: { purpose: 'work', runId: accepted.runId, taskId: accepted.planningTaskId, attemptId },
      invocationId, executionVersion, nowUtcMs: SUBMIT_NOW,
      strategy: { ...PLANNER_STRATEGY },
    };
    let current: PlanningSubmitBinding | null = submitBinding;
    const candidateWorkspace = join(box.dataRoot, 'f006-candidate-workspace');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(join(candidateWorkspace, 'stray-plan.json'), '{"not":"registered"}');
    const channelDeps = {
      currentBinding: () => current,
      candidateContext: () => ({
        policy: {
          requireChecksBeforeDone: true,
          checkDefinitions: [{ checkKey: 'unit-core', scope: 'module', kind: 'command', argv: ['node', 'test.js'],
            cwdRef: null, environmentRef: null, timeout: 120_000, required: true, requirementRefs: [] }],
          modules: [{ moduleKey: 'core', allowedTargets: ['packages/core'], impactScope: ['packages/core'], sharedHighRiskFiles: [] }],
          fullFallback: { checkRefs: ['unit-core'] },
        },
        workspaceRoot: candidateWorkspace,
        codeDigest: 'cd'.repeat(32),
      }),
    };
    const attempts = createSqliteAttemptAccess(session);
    const channel = createWorkToolChannel({
      ...channelDeps,
      atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
      attempts,
      dag: createSqliteTaskDagStore(session),
      verifier,
      candidates: createVerificationCandidateValidator({ attempts, verifier, resolver: createTestTargetResolver() }),
      planning: { publisher },
    });
    const buildAccess = (operations: readonly WorkAccessOperation[]) => ({
      schemaVersion: 1,
      context: {
        grantId: randomUUID(), principalId: submitBinding.principal.principalId, projectId,
        hostInstanceId: submitBinding.hostInstanceId, identity: submitBinding.identity,
        invocationId, executionVersion, issuedAtUtcMs: SUBMIT_NOW - 100, expiresAtUtcMs: SUBMIT_NOW + 3_600_000,
        operations: [...operations],
      },
      runtime: 'pi', provider: PLANNER_STRATEGY.provider, model: PLANNER_STRATEGY.model,
      authentication: { kind: 'local_login' as const, sourceRef: randomUUID(), pluginId: null, environmentRefs: [] },
      resources: [],
    });
    const defaultOperations: readonly WorkAccessOperation[] = ['task.read', 'planning.candidate.submit'];
    const bridge = channel.bind(buildAccess(defaultOperations), submitBinding);

    const candidateBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
      schemaVersion: 1,
      projectId,
      featureId,
      runId: accepted.runId,
      candidateId: accepted.candidateId,
      plan: {
        schemaVersion: 1,
        feature: { title: '规划后的交付计划', description: null, labels: [], sourceRefs: [] },
        tasks: [
          { id: 'p-1', title: '实现候选提交', acceptance: { criteria: ['候选可提交并通过校验'] }, dependsOn: [] },
          { id: 'p-2', title: '回归候选重放', acceptance: { criteria: ['重放不重复发布'] }, dependsOn: ['p-1'] },
        ],
      },
      taskVerification: [
        { taskId: 'p-1', checkRefs: ['unit-core'], moduleRefs: ['core'], impactScope: ['packages/core'] },
      ],
      summary: '两个任务：实现与回归；单候选一次发布。',
      ...overrides,
    });

    const request = (options: {
      operation?: string; commandId?: string; candidate?: string;
      payload?: Record<string, unknown>; scope?: { kind: 'project'; projectId: string };
    } = {}) => ({
      schemaVersion: 5,
      commandId: options.commandId ?? randomUUID(),
      issuedAt: new Date(SUBMIT_NOW).toISOString(),
      operation: options.operation ?? PLANNING_CANDIDATE_SUBMIT_OPERATION,
      scope: options.scope ?? { kind: 'project', projectId },
      payload: options.payload ?? {
        identity: submitBinding.identity, invocationId, executionVersion,
        candidate: options.candidate ?? candidateBody(),
      },
    });

    const snapshotTables = ['tasks', 'attempts', 'runs', 'execution_batches', 'planning_contexts',
      'command_receipts', 'artifacts', 'task_claim_receipts', 'state_events'];
    const snapshot = (): Record<string, unknown[]> => Object.fromEntries(snapshotTables.map(
      table => [table, session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()],
    ));

    return {
      box, session, projectId, featureId,
      runId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId,
      attemptId, executionVersion, invocationId, hostInstanceId: 'f006-host', dataRoot: box.dataRoot,
      channel, bridge, binding: submitBinding, artifacts: artifactStore, files, publisher,
      candidateBody, request,
      bindBridge(options: { operations?: readonly WorkAccessOperation[]; withPlanning?: boolean } = {}) {
        const operations = options.operations ?? defaultOperations;
        if (options.withPlanning === false) {
          const bareChannel = createWorkToolChannel({
            ...channelDeps,
            atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
            attempts,
            dag: createSqliteTaskDagStore(session),
            verifier,
            candidates: createVerificationCandidateValidator({ attempts, verifier, resolver: createTestTargetResolver() }),
          });
          return bareChannel.bind(buildAccess(operations), submitBinding);
        }
        return channel.bind(buildAccess(operations), submitBinding);
      },
      setCurrent(value: PlanningSubmitBinding | null) { current = value; },
      snapshot,
      planningContext: () => session.database.prepare(
        'SELECT * FROM planning_contexts WHERE project_id = ? AND run_id = ?',
      ).get(projectId, accepted.runId) as Record<string, unknown>,
      close() { session.close(); box.cleanup(); },
    };
  } catch (error) {
    box.cleanup();
    throw error;
  }
}
