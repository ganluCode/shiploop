/**
 * P05-1 / F-005 planning Run 派发与原子认领（真实临时文件/SQLite/Git 纵向）。
 *
 * 全真实资源：真实 Git 仓库与受管 worktree + 真实 SQLite + 真实制品文件；经
 * 公开命令通道完成 注册 → 配置 → 草稿计划导入 → planning.start；真实受管
 * worktree（path-service 受控位置）与 managed_workspaces 现场行；F-004 规划
 * 输入准备/重核 + F-005 派发准备 + planning 原子认领 + 真实调度器（SQLite
 * 补扫队列）全链路。仅以下测试注入使用直接 SQL 现场修改（模拟并发漂移/终态/
 * 隔离——生产路径不可达，用于重核分支覆盖）与跨进程竞争子进程。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 调度器按 Run purpose 路由 planning（capability gap / 真实认领 / 重复扫描
 *   不重复占槽）；planning Task 不进入 coding DAG（evaluateTaskDag 拒绝）；
 * - 原子认领一次提交创建 Attempt、递增 executionVersion、记账预占、保存认领
 *   回执（dispatch 归属 + 槽位 + 三组资源租约 + 计数），事务外才允许 Runtime
 *   启动（runtime_start_reservations 恒 0）；
 * - 规划/编码互斥与单槽竞争：跨进程两连接竞争恰好一份认领；全局执行门
 *   （global:execution/project work 租约）阻止第二个有效执行者；暂停/取消/
 *   quarantined 占用阻止新认领；
 * - 重复投递、同 claimKey 重放不重复创建/占槽/扣额；claimKey 异输入冲突；
 *   租约到期只隔离核对不重新分配写入者；
 * - 漂移拒绝（Run/Batch 控制、Task CAS、上下文/策略/制品/终态/Phase）与
 *   故障边界整组回滚；编码 claimTask 拒绝 planning 快照（独立分支纪律）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqlitePlanningContextStore } from '../../../packages/core/src/adapters/sqlite/planning-context-store.ts';
import { createSqlitePlanningClaimStore } from '../../../packages/core/src/adapters/sqlite/planning-claim-store.ts';
import { createSqliteSchedulerStore } from '../../../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteExecutionSlotAccess } from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
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
import { createTaskDagService } from '../../../packages/core/src/application/task-dag.ts';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
import type { PlanningClaimInput } from '../../../packages/core/src/ports/planning-claim.ts';
import { isPlanningAttemptSnapshot } from '../../../packages/core/src/ports/attempt-store.ts';
import type { TaskClaimReceipt } from '../../../packages/core/src/ports/task-claim.js';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { PLANNING_TASK_KIND } from '../../../packages/core/src/ports/planning-candidates.ts';
import { validatePlanningStrategyCopy } from '../../../packages/core/src/ports/planning-context.ts';
import { deriveManagedFeatureBranch } from '../../../packages/core/src/ports/workspace-preparation.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { CommandReceipt, PlanningAcceptedCommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import type { CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { git, commitAll } from '../../helpers/git-repo.ts';

const NOW = 1_900_200_000_000;
const PLANNING_BUDGET = {
  batch: {
    maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1,
    deadlineUtcMs: NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
};
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

interface F005Fixture {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly planningRunId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly authority: ReturnType<typeof createWorkWorkspaceAuthority>;
  readonly planningInputs: PlanningInputPreparePort;
  readonly dispatchPrepare: ReturnType<typeof createPlanningDispatchPrepareService>;
  readonly prepare: () => Promise<PlanningClaimInput>;
  readonly store: () => ReturnType<typeof createSqlitePlanningClaimStore>;
  close(): void;
}

let fixture: F005Fixture | undefined;
let extraSessions: SqliteStorageSession[] = [];
afterEach(() => {
  for (const session of extraSessions) { try { session.close(); } catch { /* closed */ } }
  extraSessions = [];
  fixture?.close();
  fixture = undefined;
});

/**
 * 打开 F-005 夹具：真实注册/配置/草稿计划导入/planning.start + 真实受管
 * worktree（path-service 受控位置）+ managed_workspaces 现场行（承载宿主
 * Attempt 挂在既有编码草稿任务 t-1 上，已终态 interrupted——不占用活动
 * Attempt 唯一索引，也不阻塞 planning 认领）+ F-004 输入准备服务 + F-005
 * 派发准备与 planning 认领存储。
 */
async function openFixture(): Promise<F005Fixture> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p051-f005-' });
  try {
    const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
    const session = harness.session;
    const nowUtcMs = (): number => NOW;

    const artifactStore = createSqliteArtifactStore(session, { nowUtcMs });
    const files = createArtifactFileStore({ dataRoot: box.dataRoot });
    const publisher = createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } });
    const groupPublisher = createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } });
    const verifier = createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 16_000_000 } });

    const stateStore = createSqliteStateStore(session);
    const queryStore = createSqliteQueryStore(session);
    const paths = createPathService({ dataRoot: box.dataRoot, projectLookup: stateStore, featureLookup: queryStore });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.dataRoot], preparationPaths: paths });
    const inspector = createWorkspaceInspector({
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
      const inspection = await inspector.inspect({
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
        publisher,
        verifier,
        sources: { openSourceRead: async () => { throw new Error('file sources not configured in this fixture'); } },
        limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
        nowMs: nowUtcMs,
      }),
      artifacts: artifactStore,
      publisher: groupPublisher,
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
    const envelope = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
      operation, payload, ...extra,
    });
    const submit = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
      const receipt = await commands.submit(owner, envelope(operation, payload, extra));
      if (receipt.status !== 'completed' && receipt.status !== 'accepted') {
        throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
      }
      return receipt;
    };

    const registered = await submit('project.register', {
      repositoryPath: box.repoDirA, displayName: 'P05-1 F-005', description: null, labels: [],
    }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
    const projectId = registered.result.project.id;
    const scope = { kind: 'project' as const, projectId };
    await submit('settings.global.create', {
      schemaVersion: 2, strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
      },
    }, { scope: { kind: 'global' } });
    await submit('phase.create', { id: 'phase-1', title: 'P05-1', description: null, labels: [] }, { scope });
    const featureRow = await submit('feature.plan.import', {
      phaseId: 'phase-1', plan: {
        schemaVersion: 1,
        feature: { title: '规划派发目标', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] }],
      },
    }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
    const featureId = featureRow.result.feature.id;

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
    }, { scope, expectedRevision: featureRow.result.feature.revision });
    const accepted = planningReceipt as PlanningAcceptedCommandReceipt;

    /* 真实受管 worktree：path-service 受控位置（与 claim verifyPreparation 目标一致）。 */
    const branch = deriveManagedFeatureBranch(projectId, featureId);
    const worktreePath = join(box.dataRoot, deriveFeatureWorktreeRelativeDir(projectId, featureId));
    mkdirSync(join(worktreePath, '..'), { recursive: true });
    git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], box.repoDirA);

    /* managed_workspaces 现场行：宿主 Attempt 挂在编码草稿任务 t-1（终态
     * interrupted——不占活动唯一索引，不阻塞 planning 认领的 Task CAS）。 */
    const binding = await stateStore.getRepositoryBinding(projectId);
    const hostAttemptId = randomUUID();
    const hostArtifactBody = Buffer.from(`{"schemaVersion":1,"fixtureHost":"${hostAttemptId}"}`, 'utf8');
    const hostArtifact = await publisher.publishArtifact({
      projectId, kind: 'execution-input', mediaType: 'application/json',
      expectedHash: sha256(hostArtifactBody), locator: `execution-inputs/f005-host-${hostAttemptId}`, content: [hostArtifactBody],
    });
    const hostGroupRef = {
      projectId, artifactId: hostArtifact.artifact.id, version: hostArtifact.artifact.version,
      contentHash: hostArtifact.artifact.contentHash!, sizeBytes: hostArtifact.artifact.sizeBytes!,
      locator: hostArtifact.artifact.locator, mediaType: hostArtifact.artifact.mediaType,
    };
    const hostSnapshot = JSON.stringify({
      schemaVersion: 1, projectId, featureId, taskId: 't-1',
      digests: { snapshotDigest: sha256(`f005-host-${hostAttemptId}`) },
      group: { snapshot: hostGroupRef },
    });
    session.transactWrite('f005.fixture.workspace', () => {
      session.database.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run('t-1');
      session.database.prepare(
        'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
          'owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, ' +
          "input_digest, input_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 1, ?, 'interrupted', 'preflight', ?, ?, ?)",
      ).run(hostAttemptId, NOW, projectId, NOW, featureId, accepted.runId, 't-1',
        'f005-fixture-owner', 'f005-fixture-host', NOW, hostSnapshot,
        sha256(`f005-host-${hostAttemptId}`), hostArtifact.artifact.id);
      session.database.prepare(
        'UPDATE attempts SET ended_at = ? WHERE id = ?',
      ).run(NOW, hostAttemptId);
      session.database.prepare(
        'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
          'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
          'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
          "host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, " +
          "?, ?, NULL, NULL, 'ready', ?, ?, ?, 1, ?, ?)",
      ).run(randomUUID(), NOW, projectId, NOW, featureId, binding.id, binding.bindingRevision,
        binding.repoIdentity, worktreePath, binding.gitCommonDir, branch,
        git(['rev-parse', 'HEAD'], box.repoDirA).trim(),
        randomUUID(), 'f005-fixture-owner', 'f005-fixture-host', accepted.runId, hostAttemptId);
    });

    const batchDeadline = {
      readDeadlineUtcMs: (p: string, r: string): number | null => session.database.prepare<[string, string], { deadline_at: number | null }>(
        'SELECT b.deadline_at FROM runs r JOIN execution_batches b ON b.project_id = r.project_id AND b.id = r.batch_id WHERE r.project_id = ? AND r.id = ?',
      ).get(p, r)?.deadline_at ?? null,
    };
    const taskFacts = {
      readTaskFacts: (p: string, t: string): { revision: number; executionVersion: number } | null => {
        const row = session.database.prepare<[string], { project_id: string; revision: number; execution_version: number }>(
          'SELECT project_id, revision, execution_version FROM tasks WHERE id = ?').get(t);
        return row === undefined || row.project_id !== p ? null : { revision: row.revision, executionVersion: row.execution_version };
      },
    };
    const dispatchPrepare = createPlanningDispatchPrepareService({
      views: createSqlitePlanningContextStore(session, { nowUtcMs }),
      planningInputs,
      workspaceAuthority: authority,
      repositoryBindings: { getRepositoryBinding: p => stateStore.getRepositoryBinding(p) },
      batchDeadline,
      taskFacts,
      owner: 'f005-owner',
      hostInstanceId: 'f005-host',
      nowMs: nowUtcMs,
    });
    const store = () => createSqlitePlanningClaimStore(session, { workspaceAuthority: authority, nowUtcMs: () => NOW });

    return {
      box, session, projectId, featureId,
      planningRunId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId,
      worktreePath, branch, authority, planningInputs, dispatchPrepare, store,
      prepare: () => dispatchPrepare.preparePlanningClaim({ projectId, runId: accepted.runId }),
      close() { session.close(); box.cleanup(); },
    };
  } catch (error) {
    box.cleanup();
    throw error;
  }
}

interface DurableSnapshot { [table: string]: unknown[] }
function planningAttempts(f: F005Fixture): unknown[] {
  return durable(f).attempts.filter(a => (a as { task_id: string }).task_id === f.planningTaskId);
}
function durable(f: F005Fixture): DurableSnapshot {
  const tables = ['tasks', 'attempts', 'runs', 'execution_batches', 'task_attempt_reservations',
    'runtime_start_reservations', 'workspace_leases', 'state_events', 'task_claim_receipts',
    'run_dispatch_claims', 'execution_slot_claims', 'run_dispatch_intents'];
  return Object.fromEntries(tables.map(table => [table, f.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function rejectionOf(error: unknown): { reason?: unknown; eligibility?: unknown } {
  const details = (error as { details?: { reason?: unknown; eligibility?: unknown } }).details ?? {};
  return details;
}

describe('P05-1 / F-005 planning Run 派发与原子认领', () => {
  it('[case:planning-dispatch-routes-by-purpose] 调度器按 purpose 路由 planning：能力缺口可查询、真实认领恰好一次、不进入编码 DAG', async () => {
    fixture = await openFixture();
    const f = fixture;
    const schedulerStore = createSqliteSchedulerStore(f.session, { nowUtcMs: () => NOW });
    const dag = { evaluate: (projectId: string, runId: string) =>
      createTaskDagService({ store: createSqliteTaskDagStore(f.session), nowMs: () => NOW }).evaluate(projectId, runId) };

    /* 未装配 planning 消费者：capability gap + 持久可查询原因，零认领零写入。 */
    const bare = createWorkScheduler({ store: schedulerStore, dag });
    try {
      const before = durable(f);
      const gapScan = await bare.scan();
      const gapResult = gapScan.runs.find(r => r.runId === f.planningRunId);
      expect(gapResult).toMatchObject({ reason: 'scheduler_capability_missing', capabilityGaps: ['planning_consumer'], claimed: false });
      expect((f.session.database.prepare('SELECT reason FROM runs WHERE id = ?').get(f.planningRunId) as { reason: string }).reason)
        .toBe('scheduler_capability_missing');
      expect(durable(f).attempts).toEqual(before.attempts);
      expect(durable(f).task_claim_receipts).toEqual(before.task_claim_receipts);

      /* planning Task 不进入 coding DAG：purpose=plan 在编码图评估中明确拒绝。 */
      const codingView = dag.evaluate(f.projectId, f.planningRunId);
      expect(codingView.reason).toBe('invalid_graph');
      expect(codingView.readyTaskIds).toEqual([]);
    } finally {
      await bare.close();
    }

    /* 装配真实 planning 消费者：准备（F-004 输入 + 重核）→ 原子认领 → 消费回执。 */
    const consumed: TaskClaimReceipt[] = [];
    const scheduler = createWorkScheduler({
      store: schedulerStore, dag,
      planning: {
        prepare: ref => f.dispatchPrepare.preparePlanningClaim(ref),
        claims: f.store(),
        consume: async receipt => { consumed.push(receipt); },
      },
    });
    try {
      const scan = await scheduler.scan();
      const claimedRun = scan.runs.find(r => r.runId === f.planningRunId);
      expect(claimedRun).toMatchObject({ reason: 'ready', claimed: true });
      expect(consumed).toHaveLength(1);

      const snapshot = durable(f);
      expect(planningAttempts(f)).toHaveLength(1);
      expect(snapshot.task_claim_receipts).toHaveLength(1);
      expect(snapshot.run_dispatch_claims).toHaveLength(1);
      expect(snapshot.execution_slot_claims).toHaveLength(1);
      expect(snapshot.task_attempt_reservations).toHaveLength(1);
      expect(snapshot.workspace_leases).toHaveLength(3);
      expect(snapshot.runtime_start_reservations).toHaveLength(0);
      const taskRow = f.session.database.prepare('SELECT status, execution_version, kind FROM tasks WHERE id = ?').get(f.planningTaskId) as { status: string; execution_version: number; kind: string };
      expect(taskRow).toEqual({ status: 'running', execution_version: 1, kind: PLANNING_TASK_KIND });
      const runRow = f.session.database.prepare('SELECT attempts_created FROM runs WHERE id = ?').get(f.planningRunId) as { attempts_created: number };
      expect(runRow.attempts_created).toBe(1);
      /* 复用现有队列事实：F-003 登记的派发意图仍在（rank 0 补扫来源）。 */
      expect(snapshot.run_dispatch_intents).toHaveLength(1);
      /* 资源记录：全局执行门 + 项目 Work 门 + 工作区三组租约。 */
      const leaseKeys = (snapshot.workspace_leases as { resource_key: string; state: string }[]).map(l => l.resource_key).sort();
      expect(leaseKeys[0]).toBe('global:execution');
      expect(leaseKeys[1]).toBe(`project:${f.projectId}:work`);
      expect(leaseKeys[2]).toMatch(/^workspace:/);

      /* 丢失唤醒后的补扫：再次扫描不重复创建 Attempt/占槽/扣额。 */
      const rescan = await scheduler.scan();
      expect(rescan.runs.find(r => r.runId === f.planningRunId)).toMatchObject({ claimed: false });
      expect(planningAttempts(f)).toHaveLength(1);
      expect(durable(f).execution_slot_claims).toHaveLength(1);
      expect(durable(f).task_attempt_reservations).toHaveLength(1);
      expect(consumed).toHaveLength(1);
    } finally {
      await scheduler.close();
    }
  }, 60_000);

  it('[case:planning-claim-atomic-commit] 原子认领一次提交创建 Attempt、递增版本、记账预占并保存回执', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const { replayed, receipt } = f.store().claimPlanningTask(input);
    expect(replayed).toBe(false);
    expect(f.session.database.inTransaction).toBe(false);
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.dispatch).toMatchObject({ claimVersion: 1, claimId: expect.any(String), slotId: expect.any(String) });
    expect(receipt.batchId).toBe((f.session.database.prepare('SELECT batch_id FROM runs WHERE id = ?').get(f.planningRunId) as { batch_id: string }).batch_id);
    expect(receipt.counts).toEqual({ batchAttempts: 1, runAttempts: 1, taskAttempts: 1, codeAttempts: 1 });
    expect(receipt.launch).toMatchObject({ sessionId: expect.any(String), invocationId: expect.any(String), parentSessionId: null });
    expect(receipt.leases).toHaveLength(3);
    expect(receipt.attempt.status).toBe('preparing');
    expect(receipt.attempt.executionStage).toBe('preflight');

    /* planning Attempt 是一等记录：读取侧按 planning 判别快照读回，不携带编码批准身份。 */
    const attempt = createSqliteAttemptAccess(f.session).getAttempt(f.projectId, receipt.attempt.id);
    expect(isPlanningAttemptSnapshot(attempt.inputSnapshot)).toBe(true);
    if (isPlanningAttemptSnapshot(attempt.inputSnapshot)) {
      expect(attempt.inputSnapshot.purpose).toBe('planning');
      expect(attempt.inputSnapshot.digests.codeBaselineDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((attempt.inputSnapshot as { approval?: unknown }).approval).toBeUndefined();
    const persistedSnapshot = JSON.parse((f.session.database.prepare('SELECT input_snapshot FROM attempts WHERE id = ?').get(receipt.attempt.id) as { input_snapshot: string }).input_snapshot) as Record<string, unknown>;
    expect(persistedSnapshot.purpose).toBe('planning');
    expect(persistedSnapshot.approval).toBeUndefined();
    expect(persistedSnapshot.decisionId).toBeUndefined();
    /* Runtime 启动额度未被认领消耗（事务外才允许启动）。 */
    expect(durable(f).runtime_start_reservations).toHaveLength(0);
  }, 60_000);

  it('[case:planning-claim-replay-idempotent] 同 claimKey 重放返回原回执零新增；新 claimKey 被任务状态拒绝', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const first = f.store().claimPlanningTask(input);
    const before = durable(f);
    expect(f.store().claimPlanningTask(input)).toEqual({ replayed: true, receipt: first.receipt });
    expect(durable(f)).toEqual(before);
    /* 重复投递（新 claimKey、同快照）：单次规划预算已被首次认领耗尽 → 预算
     * 层明确拒绝且零写入（准备端 readiness 同样拒绝 running Task，不再生成新输入）。 */
    await expect(f.prepare()).rejects.toMatchObject({ details: { reason: 'planning_task_not_pending' } });
    expect(() => f.store().claimPlanningTask({ ...input, claimKey: randomUUID() })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ reason: 'budget_exhausted' }),
    }));
    expect(durable(f)).toEqual(before);
    /* 同 claimKey 异输入（租约漂移）：幂等身份冲突。 */
    expect(() => f.store().claimPlanningTask({ ...input, leaseUntilUtcMs: input.leaseUntilUtcMs + 5000 }))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'claim_key_reused' }) }));
    expect(durable(f)).toEqual(before);
  }, 60_000);

  it('[case:planning-cross-process-race] 两个独立消费者/连接竞争同 Run，恰好一份认领、槽位、租约与预占', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const environment = createIsolatedHostEnvironment();
    try {
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/planning/p05-1-claim-race-child.ts', import.meta.url)),
        configs: [0, 1].map(i => ({ dbPath: f.box.dbPath, root: f.box.dataRoot, path: f.worktreePath,
          now: NOW, input: { ...input, workspace: undefined, claimKey: `planning-racer-${i}`, owner: `planning-owner-${i}` } })),
      });
      expect(results.filter(r => r.result.ok)).toHaveLength(1);
      const snapshot = durable(f);
      expect(planningAttempts(f)).toHaveLength(1);
      for (const table of ['run_dispatch_claims', 'execution_slot_claims', 'task_attempt_reservations', 'task_claim_receipts']) {
        expect(snapshot[table]).toHaveLength(1);
      }
      expect(snapshot.workspace_leases).toHaveLength(3);
      expect(snapshot.runtime_start_reservations).toHaveLength(0);
      expect(f.session.database.prepare('SELECT attempts_created FROM runs').get()).toEqual({ attempts_created: 1 });
    } finally {
      await environment.dispose();
    }
  }, 90_000);

  it('[case:planning-global-gate-excludes-second-executor] 规划占用全局执行门后，同库第二个 planning 认领被 resource_busy 阻止', async () => {
    fixture = await openFixture();
    const f = fixture;
    const first = await f.prepare();
    f.store().claimPlanningTask(first);

    /* 同库第二项目：真实注册（仓库 B）→ 配置复用全局 planner 策略 → 草稿导入 → planning.start。 */
    const commands = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => NOW }),
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
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
      repositoryPath: f.box.repoDirB, displayName: 'P05-1 F-005 B', description: null, labels: [],
    }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
    const projectIdB = registered.result.project.id;
    await submit('phase.create', { id: 'phase-b', title: 'P05-1 B', description: null, labels: [] }, { scope: { kind: 'project', projectId: projectIdB } });
    const imported = await submit('feature.plan.import', {
      phaseId: 'phase-b', plan: {
        schemaVersion: 1,
        feature: { title: '规划派发目标 B', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 't-b-1', title: '草稿 B', acceptance: { criteria: ['c'] }, dependsOn: [] }],
      },
    }, { scope: { kind: 'project', projectId: projectIdB }, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
    const acceptedB = await submit(PLANNING_START_OPERATION, {
      schemaVersion: 1, projectId: projectIdB, phaseId: 'phase-b', featureId: imported.result.feature.id,
      requirementRefs: [], constraints: [], acceptance: { criteria: ['c'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
    }, { scope: { kind: 'project', projectId: projectIdB }, expectedRevision: imported.result.feature.revision }) as PlanningAcceptedCommandReceipt;

    /* 项目 B 的受管 worktree + 现场行（与项目 A 同一真实纪律）。 */
    const branchB = deriveManagedFeatureBranch(projectIdB, imported.result.feature.id);
    const worktreeB = join(f.box.dataRoot, deriveFeatureWorktreeRelativeDir(projectIdB, imported.result.feature.id));
    mkdirSync(join(worktreeB, '..'), { recursive: true });
    git(['worktree', 'add', '-b', branchB, worktreeB, 'HEAD'], f.box.repoDirB);
    const stateStore = createSqliteStateStore(f.session);
    const bindingB = await stateStore.getRepositoryBinding(projectIdB);
    const artifactStore = createSqliteArtifactStore(f.session, { nowUtcMs: () => NOW });
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const publisher = createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } });
    const verifier = createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 16_000_000 } });
    const hostB = randomUUID();
    const hostBodyB = Buffer.from(`{"schemaVersion":1,"fixtureHost":"${hostB}"}`, 'utf8');
    const hostArtifactB = await publisher.publishArtifact({
      projectId: projectIdB, kind: 'execution-input', mediaType: 'application/json',
      expectedHash: sha256(hostBodyB), locator: `execution-inputs/f005-host-b-${hostB}`, content: [hostBodyB],
    });
    const planningContextsB = createSqlitePlanningContextStore(f.session, { nowUtcMs: () => NOW });
    const planningTaskB = planningContextsB.getPlanningContextByRun(projectIdB, acceptedB.runId)!.planningTaskId;
    void planningTaskB;
    const groupRefB = {
      projectId: projectIdB, artifactId: hostArtifactB.artifact.id, version: hostArtifactB.artifact.version,
      contentHash: hostArtifactB.artifact.contentHash!, sizeBytes: hostArtifactB.artifact.sizeBytes!,
      locator: hostArtifactB.artifact.locator, mediaType: hostArtifactB.artifact.mediaType,
    };
    f.session.transactWrite('f005.fixture.workspaceB', () => {
      f.session.database.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run('t-b-1');
      f.session.database.prepare(
        'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
          'owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, ' +
          "input_digest, input_ref, ended_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 1, ?, 'interrupted', 'preflight', " +
          '?, ?, ?, ?)',
      ).run(hostB, NOW, projectIdB, NOW, imported.result.feature.id, acceptedB.runId, 't-b-1',
        'f005-fixture-owner', 'f005-fixture-host', NOW,
        JSON.stringify({ schemaVersion: 1, projectId: projectIdB, featureId: imported.result.feature.id, taskId: 't-b-1',
          digests: { snapshotDigest: sha256(`f005-host-b-${hostB}`) }, group: { snapshot: groupRefB } }),
        sha256(`f005-host-b-${hostB}`), hostArtifactB.artifact.id, NOW);
      f.session.database.prepare(
        'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
          'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
          'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
          "host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, " +
          "?, ?, NULL, NULL, 'ready', ?, ?, ?, 1, ?, ?)",
      ).run(randomUUID(), NOW, projectIdB, NOW, imported.result.feature.id, bindingB.id, bindingB.bindingRevision,
        bindingB.repoIdentity, worktreeB, bindingB.gitCommonDir, branchB,
        git(['rev-parse', 'HEAD'], f.box.repoDirB).trim(),
        randomUUID(), 'f005-fixture-owner', 'f005-fixture-host', acceptedB.runId, hostB);
    });

    /* 项目 B 真实准备（输入/基线/重核全部通过）后认领：被项目 A 的全局执行门阻止。 */
    const inspector = createWorkspaceInspector({ authorizedRoots: [f.box.dataRoot], confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
    const dispatchPrepareB = createPlanningDispatchPrepareService({
      views: planningContextsB,
      planningInputs: createPlanningInputPrepareService({
        views: planningContextsB,
        inputs: createExecutionInputService({
          artifacts: artifactStore, publisher, verifier,
          sources: { openSourceRead: async () => { throw new Error('not configured'); } },
          limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
          nowMs: () => NOW,
        }),
        artifacts: artifactStore,
        publisher: createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } }),
        verifier,
        permissions: () => ({ grants: [] }),
        readCodeBaseline: async input => {
          const row = f.session.database.prepare<[string, string], {
            repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
            canonical_path: string; git_common_dir: string; branch: string; base_commit: string; id: string;
          }>('SELECT id, repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit FROM managed_workspaces WHERE project_id = ? AND feature_id = ?')
            .get(input.projectId, input.featureId);
          if (row === undefined) return null;
          const inspection = await inspector.inspect({
            repositoryBindingId: row.repository_binding_id, repositoryBindingRevision: row.repository_binding_revision,
            repoIdentity: row.repo_identity, canonicalPath: row.canonical_path, gitCommonDir: row.git_common_dir,
            branch: row.branch, baseCommit: row.base_commit,
          });
          return { worktreeId: row.id, headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest };
        },
        limits: { maxRequiredItems: 8 },
        nowMs: () => NOW,
      }),
      workspaceAuthority: { verifyPreparation: (b, featureId) => f.authority.verifyPreparation(b, featureId) },
      repositoryBindings: { getRepositoryBinding: p => stateStore.getRepositoryBinding(p) },
      batchDeadline: {
        readDeadlineUtcMs: (p, r) => f.session.database.prepare<[string, string], { deadline_at: number | null }>(
          'SELECT b.deadline_at FROM runs r JOIN execution_batches b ON b.project_id = r.project_id AND b.id = r.batch_id WHERE r.project_id = ? AND r.id = ?',
        ).get(p, r)?.deadline_at ?? null,
      },
      taskFacts: {
        readTaskFacts: (p, t) => {
          const row = f.session.database.prepare<[string], { project_id: string; revision: number; execution_version: number }>(
            'SELECT project_id, revision, execution_version FROM tasks WHERE id = ?').get(t);
          return row === undefined || row.project_id !== p ? null : { revision: row.revision, executionVersion: row.execution_version };
        },
      },
      owner: 'f005-owner-b', hostInstanceId: 'f005-host-b', nowMs: () => NOW,
    });
    const inputB = await dispatchPrepareB.preparePlanningClaim({ projectId: projectIdB, runId: acceptedB.runId });
    expect(() => f.store().claimPlanningTask(inputB)).toThrow(expect.objectContaining({
      details: expect.objectContaining({ reason: 'resource_busy' }),
    }));
    /* 唯一有效执行者仍是项目 A 的认领：B 零写入。 */
    const snapshot = durable(f);
    expect(snapshot.attempts.filter(a => (a as { project_id: string }).project_id === projectIdB)).toHaveLength(1); // 夹具宿主行
    expect(snapshot.task_claim_receipts).toHaveLength(1);
    expect(snapshot.execution_slot_claims).toHaveLength(1);
  }, 90_000);

  it('[case:planning-lease-expiry-no-reassign] 租约到期只触发隔离核对，不重新分配写入者', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const { receipt } = f.store().claimPlanningTask(input);
    const EXPIRED = NOW + 120_000;
    const resources = createSqliteWorkResourceAccess(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => EXPIRED });
    const slots = createSqliteExecutionSlotAccess(f.session, { nowUtcMs: () => EXPIRED });
    f.session.transactWrite('f005.expire', () => {
      resources.expireInTransaction();
      slots.expireInTransaction();
    });
    /* 到期隔离：三组租约与槽位都转 quarantined，不删除、不释放、不换 owner。 */
    const leaseStates = (durable(f).workspace_leases as { state: string; owner_id: string }[]);
    expect(leaseStates.every(l => l.state === 'quarantined' && l.owner_id === receipt.attempt.id)).toBe(true);
    expect((durable(f).execution_slot_claims as { state: string }[])[0]).toMatchObject({ state: 'quarantined' });
    /* 旧回执重放仍是证据（幂等），但不构成新授权。 */
    expect(f.store().claimPlanningTask(input)).toEqual({ replayed: true, receipt });
    const identity = { projectId: receipt.attempt.projectId, attemptId: receipt.attempt.id,
      owner: receipt.attempt.owner, hostInstanceId: receipt.attempt.hostInstanceId, executionVersion: receipt.attempt.executionVersion };
    /* 启动授权被隔离拒绝：quarantined 代次不得启动 Runtime（authorized=false，不抛错伪造失败）。 */
    const launch = f.session.transactWrite('f005.launch-deny', () =>
      createSqliteWorkResourceAccess(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => EXPIRED })
        .beginLaunchInTransaction(identity));
    expect(launch).toEqual({ authorized: false, invocationId: null });
    /* 不重新分配写入者：无新一代 Run 认领、无新 Attempt。 */
    expect(durable(f).run_dispatch_claims).toHaveLength(1);
    expect(planningAttempts(f)).toHaveLength(1);
  }, 60_000);

  it.each([
    ['run-paused', "UPDATE runs SET pause_requested_at = 1900000000000, status = 'paused'", 'not_ready', 'run_control_blocked'],
    ['batch-paused', 'UPDATE execution_batches SET pause_requested_at = 1900000000000', 'not_ready', 'batch_control_blocked'],
    ['task-fence-advanced', 'UPDATE tasks SET execution_version = execution_version + 1', 'stale_task', undefined],
    ['context-cancelled', "UPDATE planning_contexts SET status = 'cancelled'", 'not_ready', 'planning_context_not_open'],
    ['task-terminal', "UPDATE tasks SET status = 'passed'", 'not_ready', 'planning_task_not_pending'],
    ['feature-terminal', "UPDATE features SET status = 'failed'", 'not_ready', 'feature_terminal'],
    ['phase-closed', "UPDATE phases SET status = 'closed'", 'not_ready', 'phase_not_open'],
    ['strategy-copy-changed', "UPDATE tasks SET execution_config = json_set(execution_config, '$.model', 'claude-sonnet') WHERE kind = 'planning'", 'not_ready', 'strategy_copy_changed'],
  ])('[case:planning-drift-%s] 认领前漂移被明确拒绝且零写入', async (_name, sql, reason, eligibility) => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const before = durable(f);
    f.session.database.exec(sql);
    const error = (() => { try { f.store().claimPlanningTask(input); return null; } catch (e) { return e; } })();
    expect(error).not.toBeNull();
    expect(rejectionOf(error)).toMatchObject(eligibility === undefined ? { reason } : { reason, eligibility });
    expect(durable(f).attempts).toEqual(before.attempts);
    expect(durable(f).task_claim_receipts.length).toBe(before.task_claim_receipts.length);
  }, 60_000);

  it.each([
    ['attempt', 'AFTER INSERT ON attempts'],
    ['budget', 'AFTER INSERT ON task_attempt_reservations'],
    ['resources', 'AFTER INSERT ON workspace_leases'],
    ['receipt', 'AFTER INSERT ON task_claim_receipts'],
  ])('[case:planning-rollback-%s] 故障边界整组回滚，无半个归属、槽位或预算', async (_name, boundary) => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const before = durable(f);
    f.session.database.exec(`CREATE TRIGGER planning_fault ${boundary} BEGIN SELECT RAISE(ABORT, 'injected planning fault'); END`);
    expect(() => f.store().claimPlanningTask(input)).toThrow();
    expect(durable(f)).toEqual(before);
  }, 60_000);

  it('[case:planning-snapshot-rejected-by-coding-claim] 编码 claimTask 拒绝 planning 判别快照（独立分支纪律）', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const coding = createSqliteTaskClaimStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
    /* 编码认领入口先经输入校验拒绝 planning 快照（purpose 判别，独立前置校验）。 */
    expect(() => coding.claimTask(input as never)).toThrow(expect.objectContaining({
      details: expect.objectContaining({ field: 'inputSnapshot.purpose' }),
    }));
    expect(durable(f).attempts.filter(a => (a as { task_id: string }).task_id === f.planningTaskId)).toHaveLength(0);
  }, 60_000);

  it('[case:planning-artifact-tampered] 已发布制品索引漂移在认领事务内被拒绝', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const before = durable(f);
    f.session.database.prepare("UPDATE artifacts SET storage_locator = 'planning-input-groups/tampered/snapshot' WHERE id = ?")
      .run(input.inputSnapshot.group.snapshot.artifactId);
    expect(() => f.store().claimPlanningTask(input)).toThrow(expect.objectContaining({
      details: expect.objectContaining({ reason: 'not_ready', eligibility: 'input_artifact_changed' }),
    }));
    expect(durable(f).attempts).toEqual(before.attempts);
  }, 60_000);

  it('[case:planning-strategy-copy-frozen] planning 认领不要求业务计划批准；策略副本与代码基线只读绑定', async () => {
    fixture = await openFixture();
    const f = fixture;
    const input = await f.prepare();
    const { receipt } = f.store().claimPlanningTask(input);
    /* 业务计划仍是草稿、未批准——规划认领不依赖批准状态。 */
    const featureRow = f.session.database.prepare('SELECT plan_status FROM features WHERE id = ?').get(f.featureId) as { plan_status: string };
    expect(featureRow.plan_status).toBe('draft');
    /* 策略副本冻结在 planning Task 上（读取侧完整校验通过）。 */
    const taskConfig = f.session.database.prepare('SELECT execution_config FROM tasks WHERE id = ?').get(f.planningTaskId) as { execution_config: string };
    expect(() => validatePlanningStrategyCopy(JSON.parse(taskConfig.execution_config), 'f005.test')).not.toThrow();
    /* 受管 worktree 只读绑定：源仓库 refs 不因准备/认领变化。 */
    expect(git(['symbolic-ref', '--short', 'HEAD'], f.worktreePath).trim()).toBe(f.branch);
    const mainRef = git(['rev-parse', 'refs/heads/main'], f.box.repoDirA).trim();
    writeFileSync(join(f.worktreePath, 'planning-progress.txt'), 'planner made progress\n');
    commitAll(f.worktreePath, 'planner progress commit');
    expect(git(['rev-parse', 'refs/heads/main'], f.box.repoDirA).trim()).toBe(mainRef);
    void receipt;
  }, 60_000);
});
