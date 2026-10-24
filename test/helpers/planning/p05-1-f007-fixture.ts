/**
 * P05-1 / F-007 规划执行夹具（供 p05-1-f007 与后续控制职责测试共用；真实临时
 * SQLite/Git + 生产组合根 + FakeRuntime/脚本化 Runtime；无付费模型调用）。
 *
 * 夹具完成：项目/阶段/Feature 草稿/全局策略 → planning.start（受批预算）→
 * 受管 feature worktree 与宿主现场行 → 返回可轮询/查询/受限提交的 F007Fixture。
 * 测试文件自持 fixtures 列表与 afterEach 清理；本模块不注册任何测试。
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createFakeRuntimeGate, createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import type { FakeRuntimeOptions } from '../../../packages/core/src/adapters/testing.ts';
import type { WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';
import type { FakeRuntimeScriptStep } from '../../../packages/core/src/ports/fake-runtime-script.ts';
import type { WorkTaskResult } from '../../../packages/core/src/application/work-tool-channel.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { deriveFeatureWorktreeRelativeDir } from '../../../packages/core/src/ports/path-service.ts';
import { deriveManagedFeatureBranch } from '../../../packages/core/src/ports/workspace-preparation.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { PLANNING_CANDIDATE_SUBMIT_OPERATION } from '../../../packages/core/src/ports/planning-candidates.ts';
import type { CommandReceipt, PlanningAcceptedCommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createCommandsTestFixture } from '../p02-2/index.ts';
import type { CommandsTestFixture } from '../p02-2/index.ts';
import { git } from '../git-repo.ts';

export const F007_NOW_BASE = 1_900_000_000_000;
export const F007_STANDARD_STEPS: readonly FakeRuntimeScriptStep[] = [
  { op: 'message', role: 'assistant', text: 'planning start' },
  { op: 'await_gate', name: 'submit' },
  { op: 'message', role: 'assistant', text: 'planning complete' },
];

const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);
const piCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'provider', models: ['model'] }],
    contractVersion: 1, permissionGrants: [], isolationModes: ['trusted_project'] },
]);

export interface F007Fixture {
  readonly box: CommandsTestFixture;
  readonly core: CoreApplication;
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly planningRunId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly gate: ReturnType<typeof createFakeRuntimeGate>;
  readonly runtimeStarts: () => number;
  readonly query: (sql: string, ...params: unknown[]) => Record<string, unknown>;
  readonly candidateBody: (overrides?: Record<string, unknown>) => string;
  /** 轮询等待 Attempt executing + Run/Batch running 的真实执行事实。 */
  waitForExecutingState(): Promise<void>;
  /** P05-1 / F-009：不等待执行状态，直接按当前 Attempt 事实受限绑定提交授权。 */
  bindSubmitBridge(): { invoke(body: string): Promise<CommandReceipt | WorkTaskResult>; revoke(): void };
  /** 以真实 WorkToolChannel 按当前 Attempt 事实颁发受限提交授权并调用一次。 */
  submitCandidate(body: string): Promise<CommandReceipt | WorkTaskResult>;
  close(): Promise<void>;
}

/** 真实受管 feature worktree + managed_workspaces 现场行（宿主 Attempt 终态 succeeded）。 */
async function seedFeatureWorkspace(box: CommandsTestFixture, session: SqliteStorageSession,
  projectId: string, featureId: string, runId: string, now: number): Promise<string> {
  const binding = session.database.prepare<[string], {
    id: string; binding_revision: number; repo_identity: string; git_common_dir: string;
  }>('SELECT id, binding_revision, repo_identity, git_common_dir FROM repository_bindings WHERE project_id = ?').get(projectId)!;
  const branch = deriveManagedFeatureBranch(projectId, featureId);
  const worktreePath = join(box.dataRoot, deriveFeatureWorktreeRelativeDir(projectId, featureId));
  mkdirSync(join(worktreePath, '..'), { recursive: true });
  git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], box.repoDirA);
  const hostAttemptId = randomUUID();
  const artifactStore = createSqliteArtifactStore(session, { nowUtcMs: () => now });
  const artifactFiles = createArtifactFileStore({ dataRoot: box.dataRoot });
  const artifactPublisher = createArtifactPublisher({ artifacts: artifactStore, files: artifactFiles,
    limits: { maxSizeBytes: 1_000_000, timeoutMs: 10_000 }, nowMs: () => now });
  const inputBody = Buffer.from(JSON.stringify({ schemaVersion: 1, fixture: 'f007-host', attemptId: hostAttemptId }));
  const inputArtifact = await artifactPublisher.publishArtifact({
    projectId, kind: 'execution-input', mediaType: 'application/json',
    expectedHash: createHash('sha256').update(inputBody).digest('hex'),
    locator: `execution-inputs/f007-host-${hostAttemptId}`, content: [inputBody],
  });
  const gitCommonDir = binding.git_common_dir ?? resolve(box.repoDirA, git(['rev-parse', '--git-common-dir'], box.repoDirA).trim());
  const hostGroupRef = {
    artifactId: inputArtifact.artifact.id, version: inputArtifact.artifact.version,
    contentHash: inputArtifact.artifact.contentHash!, sizeBytes: inputArtifact.artifact.sizeBytes!,
    locator: inputArtifact.artifact.locator, mediaType: inputArtifact.artifact.mediaType,
  };
  const hostInputDigest = createHash('sha256').update(`fixture-${hostAttemptId}`).digest('hex');
  const hostPlanningSnapshot = {
    schemaVersion: 1, purpose: 'planning', projectId, phaseId: 'phase-1', featureId, runId,
    taskId: 't-1', candidateId: randomUUID(),
    group: { snapshot: hostGroupRef, manifest: hostGroupRef, prompt: hostGroupRef },
    requiredInputs: [],
    digests: { snapshotDigest: hostInputDigest, manifestDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64),
      strategyCopyDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64), codeBaselineDigest: 'e'.repeat(64) },
    preparedAtUtcMs: now,
  };
  session.transactWrite('f007.fixture.workspace', () => {
    session.database.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run('t-1');
    session.database.prepare(
      'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
        "owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, input_digest, input_ref) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, 'f007-fixture-owner', 'f007-fixture-host', 1, ?, 'succeeded', 'preflight', ?, ?, ?)",
    ).run(hostAttemptId, now, projectId, now, featureId, runId, 't-1', now,
      JSON.stringify(hostPlanningSnapshot),
      hostInputDigest, inputArtifact.artifact.id);
    session.database.prepare('UPDATE attempts SET ended_at = ? WHERE id = ?').run(now, hostAttemptId);
    session.database.prepare(
      'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
        'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
        'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
        "host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, " +
        "?, ?, NULL, NULL, 'ready', ?, ?, ?, 1, ?, ?)",
    ).run(randomUUID(), now, projectId, now, featureId, binding.id, binding.binding_revision,
      binding.repo_identity, worktreePath, gitCommonDir, branch,
      git(['rev-parse', 'HEAD'], box.repoDirA).trim(),
      randomUUID(), 'f007-fixture-owner', 'f007-fixture-host', runId, hostAttemptId);
  });
  return worktreePath;
}

export async function openF007Fixture(options: {
  readonly prefix: string;
  readonly steps?: readonly FakeRuntimeScriptStep[];
  readonly lifecycle?: Record<string, unknown>;
  readonly startFailure?: { readonly kind: string; readonly reason: string };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly runTimeLimitMs?: number;
  readonly workRuntimeFactory?: WorkRuntimeFactory;
  /** P05-1 / F-010：提升 Run/Batch 尝试与启动上限（显式 resume 的新 Attempt 预算）。 */
  readonly attemptBudget?: number;
}): Promise<F007Fixture> {
  const box = createCommandsTestFixture({ prefix: options.prefix });
  try {
    const gate = createFakeRuntimeGate();
    const fake: Omit<FakeRuntimeOptions, 'workspaceRoots' | 'reader' | 'commitCommandIdentity'> = {
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      gates: { submit: gate },
      script: {
        schemaVersion: 1,
        steps: options.steps ?? [],
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 12, usage: null },
      },
      ...(options.startFailure === undefined ? {} : { startFailure: options.startFailure as never }),
    };
    const core = await box.openApplication({
      capabilityCatalog: options.workRuntimeFactory === undefined ? fakeCatalog() : piCatalog(),
      workRuntimeFactory: options.workRuntimeFactory ?? createFakeWorkRuntimeFactory(fake),
    });
    const session = openSqliteStorageSession({ path: box.dbPath, busyTimeoutMs: 10_000, busyRetryAttempts: 5 });
    try {
      const owner = box.localOwner();
      const submitCommand = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
        const receipt = await core.commandService.submit(owner, {
          schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
          operation, payload, ...extra,
        });
        if (receipt.status !== 'completed' && receipt.status !== 'accepted') {
          throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
        }
        return receipt;
      };

      const registered = await submitCommand('project.register', {
        repositoryPath: box.repoDirA, displayName: 'P05-1 F-007', description: null, labels: [],
      }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
      const projectId = registered.result.project.id;
      const scope = { kind: 'project' as const, projectId };
      const plannerStrategy = options.workRuntimeFactory === undefined
        ? { runtime: 'fake', provider: 'test-provider', model: 'fake-model' }
        : { runtime: 'pi', provider: 'provider', model: 'model' };
      await submitCommand('settings.global.create', {
        schemaVersion: 2, strategies: {
          defaultStrategy: plannerStrategy,
          purposeStrategies: { planner: plannerStrategy },
        },
      }, { scope: { kind: 'global' } });
      await submitCommand('phase.create', { id: 'phase-1', title: 'P05-1', description: null, labels: [] }, { scope });
      const featureRow = await submitCommand('feature.plan.import', {
        phaseId: 'phase-1', plan: {
          schemaVersion: 1,
          feature: { title: '规划执行目标', description: null, labels: [], sourceRefs: [] },
          tasks: [{ id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] }],
        },
      }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
      const featureId = featureRow.result.feature.id;
      const attempts = options.attemptBudget ?? 1;
      const planningReceipt = await submitCommand(PLANNING_START_OPERATION, {
        schemaVersion: 1, projectId, phaseId: 'phase-1', featureId, requirementRefs: [],
        constraints: ['不改变既有公开接口'],
        acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
        strategy: { approvalMode: 'manual', taskLimit: null },
        budget: {
          batch: { maxRuns: 1, maxTotalAttempts: attempts, maxRuntimeStarts: attempts, maxNoProgressRuns: 1, deadlineUtcMs: F007_NOW_BASE + 3_600_000 },
          run: { maxAttemptsPerRun: attempts, runTimeLimitMs: options.runTimeLimitMs ?? 3_600_000 },
        },
      }, { scope, expectedRevision: featureRow.result.feature.revision });
      const accepted = planningReceipt as PlanningAcceptedCommandReceipt;
      await seedFeatureWorkspace(box, session, projectId, featureId, accepted.runId, F007_NOW_BASE);
      const query = (sql: string, ...params: unknown[]) => session.database.prepare(sql).get(...params) as Record<string, unknown>;
      const candidateBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
        schemaVersion: 1, projectId, featureId, runId: accepted.runId, candidateId: accepted.candidateId,
        plan: {
          schemaVersion: 1,
          feature: { title: '规划后的交付计划', description: null, labels: [], sourceRefs: [] },
          tasks: [
            { id: 'p-1', title: '实现规划执行', acceptance: { criteria: ['规划执行可成功收尾'] }, dependsOn: [] },
            { id: 'p-2', title: '回归规划重放', acceptance: { criteria: ['重复唤醒不重复执行'] }, dependsOn: ['p-1'] },
          ],
        },
        taskVerification: [{ taskId: 'p-1', checkRefs: ['unit-core'], moduleRefs: ['core'], impactScope: ['packages/core'] }],
        summary: '两个任务：实现与回归；单候选一次发布。',
        ...overrides,
      });
      const waitForExecutingState = async (): Promise<void> => {
        /* 轮询等待真实执行事实：最新 Attempt executing + Run/Batch running。 */
        const state = () => {
          const row = query(
            "SELECT CASE WHEN (SELECT status FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1) = 'executing'" +
            " AND (SELECT status FROM runs WHERE id = ?) = 'running'" +
            " AND (SELECT status FROM execution_batches WHERE id = (SELECT batch_id FROM runs WHERE id = ?)) = 'running'" +
            ' THEN 1 ELSE 0 END AS ok', accepted.planningTaskId, accepted.runId, accepted.runId,
          ) as Record<string, unknown> & { ok: number };
          return { ...row,
            attempt: query('SELECT status, execution_stage, invocation_id, error_kind FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', accepted.planningTaskId),
            task: query('SELECT status, execution_version FROM tasks WHERE id = ?', accepted.planningTaskId),
            run: query('SELECT status, reason FROM runs WHERE id = ?', accepted.runId) };
        };
        await expect.poll(() => {
          const current = state();
          if (Number(current.ok) !== 1) throw new Error(`planning-start-state:${JSON.stringify(current)}`);
          return current;
        }, { timeout: 15_000 }).toMatchObject({ ok: 1 });
      };
      /* P05-1 / F-009：不等待执行状态，直接按当前 Attempt 事实受限绑定提交授权
       *（控制状态下 bind/invoke 的拒绝由此验证）。 */
      const bindSubmitBridge = (): { invoke(body: string): Promise<CommandReceipt | WorkTaskResult>; revoke(): void } => {
        const attemptRow = query('SELECT id, invocation_id, execution_version, owner_id, host_instance_id FROM attempts WHERE task_id = ?\n          ORDER BY created_at DESC, rowid DESC LIMIT 1',
          accepted.planningTaskId) as { id: string; invocation_id: string; execution_version: number; owner_id: string; host_instance_id: string };
        let current: unknown = {
          principal: owner, projectId, hostInstanceId: attemptRow.host_instance_id,
          identity: { purpose: 'work' as const, runId: accepted.runId, taskId: accepted.planningTaskId, attemptId: attemptRow.id },
          invocationId: attemptRow.invocation_id, executionVersion: attemptRow.execution_version,
          nowUtcMs: F007_NOW_BASE, strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
        };
        const channel = core.createWorkToolChannel({
          currentBinding: () => current as never,
          candidateContext: () => { throw new Error('coding candidate context unavailable in planning'); },
        });
        const bridge = channel.bind({
          schemaVersion: 1,
          context: {
            grantId: randomUUID(), principalId: owner.principalId, projectId,
            hostInstanceId: attemptRow.host_instance_id,
            identity: { purpose: 'work', runId: accepted.runId, taskId: accepted.planningTaskId, attemptId: attemptRow.id },
            invocationId: attemptRow.invocation_id, executionVersion: attemptRow.execution_version,
            issuedAtUtcMs: F007_NOW_BASE - 100, expiresAtUtcMs: F007_NOW_BASE + 3_600_000,
            operations: ['task.read', PLANNING_CANDIDATE_SUBMIT_OPERATION],
          },
          runtime: 'pi', provider: 'provider', model: 'model',
          authentication: { kind: 'local_login', sourceRef: randomUUID(), pluginId: null, environmentRefs: [] },
          resources: [],
        } as never, current as never);
        return {
          invoke(body: string): Promise<CommandReceipt | WorkTaskResult> {
            return bridge.invoke({
              schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
              operation: PLANNING_CANDIDATE_SUBMIT_OPERATION, scope,
              payload: {
                identity: { purpose: 'work', runId: accepted.runId, taskId: accepted.planningTaskId, attemptId: attemptRow.id },
                invocationId: attemptRow.invocation_id, executionVersion: attemptRow.execution_version,
                candidate: body,
              },
            });
          },
          revoke() { bridge.revoke(); current = null; },
        };
      };
      const submitCandidate = async (body: string): Promise<CommandReceipt | WorkTaskResult> => {
        await waitForExecutingState();
        const bridge = bindSubmitBridge();
        try {
          return await bridge.invoke(body);
        } finally {
          bridge.revoke();
        }
      };
      return {
        box, core, session, projectId, featureId,
        planningRunId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId,
        gate,
        runtimeStarts: () => Number(query('SELECT runtime_starts AS n FROM execution_batches').n),
        query,
        candidateBody,
        waitForExecutingState,
        bindSubmitBridge,
        submitCandidate,
        async close() {
          try { session.close(); } catch { /* closed */ }
          try {
            await core.workExecution.close();
          } catch { /* retained occupancy on failure paths keeps the Host occupied */ }
          try { core.close(); } catch { /* work execution not cleanly closed */ }
          box.cleanup();
        },
      };
    } catch (error) {
      try { session.close(); } catch { /* closed */ }
      try { await core.workExecution.close(); } catch { /* not cleanly closed */ }
      try { core.close(); } catch { /* ignore */ }
      box.cleanup();
      throw error;
    }
  } catch (error) {
    box.cleanup();
    throw error;
  }
}

/** 供受控 Pi Runner 工具桥复用同一夹具（工厂注入；生产组合根不变）。 */
export async function openF007FixtureWithFactory(options: {
  readonly prefix: string;
  readonly workRuntimeFactory: WorkRuntimeFactory;
}): Promise<F007Fixture> {
  return openF007Fixture({ prefix: options.prefix, workRuntimeFactory: options.workRuntimeFactory });
}

/** P05-1 / F-009 控制职责测试复用同一夹具（完整脚本/生命周期/启动失败/Run 时限选项）。 */
export async function openF007ControlFixture(options: {
  readonly prefix: string;
  readonly steps?: readonly FakeRuntimeScriptStep[];
  readonly lifecycle?: Record<string, unknown>;
  readonly startFailure?: { readonly kind: string; readonly reason: string };
  readonly runTimeLimitMs?: number;
  /** P05-1 / F-010：提升 Run/Batch 尝试与启动上限（显式 resume 的新 Attempt 预算）。 */
  readonly attemptBudget?: number;
}): Promise<F007Fixture> {
  return openF007Fixture(options);
}
