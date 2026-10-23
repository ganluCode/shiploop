/**
 * P05-1 / F-007 生产组合根 planning 执行定向测试（真实临时 SQLite/Git +
 * FakeRuntime/脚本化 Runtime + 受控 Pi Runner 工具桥；无付费模型调用）。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 按 Run purpose 接入 planning 执行分支：复用标准 ExecutionService（受监督
 *   Runner/Session/Recorder/启动预检）以冻结 planner 策略发起一次 Work，Runtime
 *   identity 保持 work；会话开始后 Attempt → executing、Run/Batch → running，
 *   受限工具通道（真实 Core WorkToolChannel）按这些事实准入；
 * - 成功：模型经工具桥提交有效候选（F-006 单候选绑定）后 Run 正常结束且停止
 *   确认、记录完整（含重复事件去重）→ planning Attempt succeeded、Task passed、
 *   Run succeeded、预算 settle、占用经 retention 释放、派发归属/槽位 released；
 *   候选处于可审阅状态，Feature 仍无获准编码计划，不自动创建编码 Run；
 * - 缺候选/无效候选：Runtime 正常结束但无有效提交（或仅有被拒绝的诊断回执）
 *   → 不伪造成功，Attempt/Task/Run failed（planning_candidate_missing），占用隔离；
 * - 记录 required 失败（事件缺口→manifest partial）：失败结算，不因正文声称
 *   完成放行；停止未确认：interrupted + Run 暂停，占用隔离；
 * - 启动预检失败：Runtime 启动抛错 → preparation_failed 结算（Attempt/Task/Run
 *   failed、runtime_starts 保守保留、未启动释放占用）；
 * - 重复 result/事件与重复唤醒：终态后迟到/重复通知被围栏拒绝（diagnostics
 *   留痕、零重复结算），重复扫描不再调用 Runtime；
 * - 受控 Pi Runner 工具桥：真实 Pi 适配器/Runner 协议子进程经 resolveSubmissionTools
 *   注入 planning_candidate_submit，经真实环回 HTTP → Core 通道发布候选并成功收尾。
 *
 * 真实 provider/model 调用：not_run（未获额外授权；全部为 FakeRuntime/离线
 * Runner 子进程，无网络模型请求）。
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import type { CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { git } from '../../helpers/git-repo.ts';

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

const NOW_BASE = 1_900_000_000_000;
const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);
const piCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'provider', models: ['model'] }],
    contractVersion: 1, permissionGrants: [], isolationModes: ['trusted_project'] },
]);

/** 供受控 Pi Runner 工具桥复用同一夹具（工厂注入；生产组合根不变）。 */
export async function openF007FixtureWithFactory(options: {
  readonly prefix: string;
  readonly workRuntimeFactory: WorkRuntimeFactory;
}): Promise<F007Fixture> {
  return openF007Fixture({ prefix: options.prefix, workRuntimeFactory: options.workRuntimeFactory });
}

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
  /** 以真实 WorkToolChannel 按当前 Attempt 事实颁发受限提交授权并调用一次。 */
  submitCandidate(body: string): Promise<CommandReceipt | WorkTaskResult>;
  close(): Promise<void>;
}

const fixtures: F007Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

/** 真实受管 feature worktree + managed_workspaces 现场行（宿主 Attempt 终态 interrupted）。 */
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

async function openF007Fixture(options: {
  readonly prefix: string;
  readonly steps?: readonly FakeRuntimeScriptStep[];
  readonly lifecycle?: Record<string, unknown>;
  readonly startFailure?: { readonly kind: string; readonly reason: string };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly workRuntimeFactory?: WorkRuntimeFactory;
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
          schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW_BASE).toISOString(),
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
      const planningReceipt = await submitCommand(PLANNING_START_OPERATION, {
        schemaVersion: 1, projectId, phaseId: 'phase-1', featureId, requirementRefs: [],
        constraints: ['不改变既有公开接口'],
        acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
        strategy: { approvalMode: 'manual', taskLimit: null },
        budget: {
          batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: NOW_BASE + 3_600_000 },
          run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
        },
      }, { scope, expectedRevision: featureRow.result.feature.revision });
      const accepted = planningReceipt as PlanningAcceptedCommandReceipt;
      await seedFeatureWorkspace(box, session, projectId, featureId, accepted.runId, NOW_BASE);
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
      return {
        box, core, session, projectId, featureId,
        planningRunId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId,
        gate,
        runtimeStarts: () => Number(query('SELECT runtime_starts AS n FROM execution_batches').n),
        query,
        candidateBody,
        async submitCandidate(body: string): Promise<CommandReceipt | WorkTaskResult> {
          /* 轮询等待真实执行事实：Attempt executing + Run/Batch running。 */
          const state = () => {
            const row = query(
              "SELECT CASE WHEN (SELECT status FROM attempts WHERE task_id = ?) = 'executing'" +
              " AND (SELECT status FROM runs WHERE id = ?) = 'running'" +
              " AND (SELECT status FROM execution_batches WHERE id = (SELECT batch_id FROM runs WHERE id = ?)) = 'running'" +
              ' THEN 1 ELSE 0 END AS ok', accepted.planningTaskId, accepted.runId, accepted.runId,
            ) as Record<string, unknown> & { ok: number };
            return { ...row,
              attempt: query('SELECT status, execution_stage, invocation_id, error_kind FROM attempts WHERE task_id = ?', accepted.planningTaskId),
              task: query('SELECT status, execution_version FROM tasks WHERE id = ?', accepted.planningTaskId),
              run: query('SELECT status, reason FROM runs WHERE id = ?', accepted.runId) };
          };
          await expect.poll(() => {
            const current = state();
            if (Number(current.ok) !== 1) throw new Error(`planning-start-state:${JSON.stringify(current)}`);
            return current;
          }, { timeout: 15_000 }).toMatchObject({ ok: 1 });
          const attemptRow = query('SELECT id, invocation_id, execution_version, owner_id, host_instance_id FROM attempts WHERE task_id = ?',
            accepted.planningTaskId) as { id: string; invocation_id: string; execution_version: number; owner_id: string; host_instance_id: string };
          let current: unknown = {
            principal: owner, projectId, hostInstanceId: attemptRow.host_instance_id,
            identity: { purpose: 'work' as const, runId: accepted.runId, taskId: accepted.planningTaskId, attemptId: attemptRow.id },
            invocationId: attemptRow.invocation_id, executionVersion: attemptRow.execution_version,
            nowUtcMs: NOW_BASE, strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
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
              issuedAtUtcMs: NOW_BASE - 100, expiresAtUtcMs: NOW_BASE + 3_600_000,
              operations: ['task.read', PLANNING_CANDIDATE_SUBMIT_OPERATION],
            },
            runtime: 'pi', provider: 'provider', model: 'model',
            authentication: { kind: 'local_login', sourceRef: randomUUID(), pluginId: null, environmentRefs: [] },
            resources: [],
          } as never, current as never);
          try {
            return await bridge.invoke({
              schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW_BASE).toISOString(),
              operation: PLANNING_CANDIDATE_SUBMIT_OPERATION, scope,
              payload: {
                identity: { purpose: 'work', runId: accepted.runId, taskId: accepted.planningTaskId, attemptId: attemptRow.id },
                invocationId: attemptRow.invocation_id, executionVersion: attemptRow.execution_version,
                candidate: body,
              },
            });
          } finally {
            bridge.revoke();
            current = null;
          }
        },
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

const standardSteps: readonly FakeRuntimeScriptStep[] = [
  { op: 'message', role: 'assistant', text: 'planning start' },
  { op: 'await_gate', name: 'submit' },
  { op: 'message', role: 'assistant', text: 'planning complete' },
];

describe('P05-1 / F-007 生产组合根 planning 执行', () => {
  it('[case:planning-execution-success] 复用标准 Work 链路执行规划：候选发布后成功收尾并释放占用', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-ok-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'succeeded' });
    /* planning Task passed + Run succeeded（仅代表候选已生成并验证，不代表批准）。 */
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'passed' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'succeeded', reason: 'planning_candidate_published' });
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published' });
    /* 候选仍处可审阅状态：Feature 保持 draft、无获准编码计划、无自动编码 Run。 */
    expect(f.query('SELECT status, plan_status FROM features WHERE id = ?', f.featureId))
      .toMatchObject({ status: 'draft', plan_status: 'draft' });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM runs') as { n: number }).n)).toBe(1);
    /* 预算结算（passed）与用量记录（Session resultRef/回执/清单保留）。 */
    expect(String(f.query('SELECT reason FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId).reason))
      .toMatch(/^verification-budget:v1:/);
    expect(f.query('SELECT result_ref FROM sessions WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)',
      f.planningTaskId).result_ref).toBeTruthy();
    /* 停止确认后占用释放（retention planning_delivered）+ 派发归属/槽位 released。 */
    await expect.poll(() => f.query(
      "SELECT (SELECT COUNT(*) FROM workspace_leases) AS leases, (SELECT state FROM run_dispatch_claims WHERE run_id = ?) AS claim," +
      ' (SELECT state FROM execution_slot_claims LIMIT 1) AS slot', f.planningRunId),
    { timeout: 15_000 }).toMatchObject({ leases: 0, claim: 'released', slot: 'released' });
    expect(f.query('SELECT status FROM managed_workspaces WHERE feature_id = ?', f.featureId))
      .toMatchObject({ status: 'retained' });
    /* 重复唤醒不再调用 Runtime：无新 Attempt、runtime_starts 不变。 */
    expect(f.runtimeStarts()).toBe(1);
    await f.core.workExecution.scan();
    await f.core.workExecution.scan();
    expect(f.runtimeStarts()).toBe(1);
    expect(Number((f.query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.planningTaskId) as { n: number }).n)).toBe(1);
  }, 120_000);

  it('[case:planning-candidate-missing] Runtime 正常结束但无有效提交：不伪造成功，Run failed 且占用隔离', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-miss-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    /* 不提交候选，直接放行结束。 */
    f.gate.release();
    await expect.poll(() => f.query('SELECT status, error_kind FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'failed', reason: 'planning_candidate_missing' });
    /* 规划失败不消耗代码返工次数；预算按 non_code_failure 结算。 */
    expect(String(f.query('SELECT reason FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId).reason))
      .toContain('"outcome":"non_code_failure"');
    expect(f.query('SELECT classification FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId))
      .toMatchObject({ classification: 'infrastructure' });
    /* 失败现场隔离保留；候选上下文保持 open（可再次人工决策路径另由后续任务承担）。 */
    expect(f.query('SELECT state FROM workspace_leases LIMIT 1')).toMatchObject({ state: 'quarantined' });
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'open' });
    expect(f.runtimeStarts()).toBe(1);
  }, 120_000);

  it('[case:planning-candidate-invalid] 非法候选只产生诊断回执：Run 结束仍按缺候选失败', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-inval-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate('{"broken": ') as CommandReceipt;
    expect(receipt.status).toBe('rejected');
    expect((receipt as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('candidate_json_invalid');
    /* 上下文保持 open、无候选制品绑定；诊断回执持久化。 */
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'open', candidate_artifact_id: null });
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId),
      { timeout: 15_000 }).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ reason: 'planning_candidate_missing' });
    expect(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId))
      .toMatchObject({ status: 'failed' });
  }, 120_000);

  it('[case:planning-recording-required-failure] 事件缺口使 required 记录不完整：失败结算不放行', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-rec-', steps: standardSteps,
      lifecycle: { events: { drop: [2] } } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'interrupted' });
    /* 记录缺口/停止不确定均不得伪造成功；保留 Run 暂停和现场。 */
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'paused' });
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published' });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM workspace_leases') as { n: number }).n)).toBe(0);
  }, 120_000);

  it('[case:planning-stop-unconfirmed] 停止未确认：Attempt interrupted、Run 暂停且不终结', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-stop-', steps: standardSteps,
      lifecycle: { stopped: { unconfirmed: true } } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'interrupted' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'paused' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'running' });
    expect(f.query('SELECT state FROM workspace_leases LIMIT 1')).toMatchObject({ state: 'quarantined' });
  }, 120_000);

  it('[case:planning-startup-preflight-failure] Runtime 启动抛错：preparation_failed 结算且不重试', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-start-', steps: standardSteps,
      startFailure: { kind: 'process', reason: 'runner_start_failed' } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await expect.poll(() => f.query('SELECT status, error_kind FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'failed', error_kind: 'process' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'failed' });
    expect(String(f.query('SELECT reason FROM runs WHERE id = ?', f.planningRunId).reason))
      .toContain('runtime_failed');
    /* 启动额度保守保留；已启动进程身份未确认前占用不释放。 */
    expect(f.runtimeStarts()).toBe(1);
    expect(Number((f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state IN ('held', 'quarantined')") as { n: number }).n))
      .toBeGreaterThan(0);
  }, 120_000);

  it('[case:planning-duplicate-result-fenced] 终态后迟到/重复通知被围栏拒绝，重复扫描零副作用', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-dup-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'succeeded' });
    /* 迟到的重复 runtime_settled 通知（同身份、不同通知 ID）被 invalid_transition 拒绝。 */
    const attemptRow = f.query('SELECT id, owner_id, host_instance_id, execution_version FROM attempts WHERE task_id = ?',
      f.planningTaskId) as { id: string; owner_id: string; host_instance_id: string; execution_version: number };
    const lifecycle = createSqliteAttemptLifecycleStore(f.session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.box.dataRoot] }), nowUtcMs: () => NOW_BASE });
    const fenced = lifecycle.apply({
      projectId: f.projectId, attemptId: attemptRow.id, taskId: f.planningTaskId, runId: f.planningRunId,
      owner: attemptRow.owner_id, hostInstanceId: attemptRow.host_instance_id,
      executionVersion: attemptRow.execution_version,
      notificationId: `late-duplicate-${randomUUID()}`,
      kind: 'runtime_settled',
      runtime: {
        sessionId: String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attemptRow.id).id),
        invocationId: String(f.query('SELECT invocation_id FROM attempts WHERE id = ?', attemptRow.id).invocation_id),
        result: null, failure: { kind: 'process', reason: 'late_duplicate_result' },
        recording: { complete: false, manifestRef: null }, stopped: null,
      },
      evidenceRef: String(f.query('SELECT result_ref FROM sessions WHERE attempt_id = ?', attemptRow.id).result_ref),
    });
    expect(fenced).toMatchObject({ disposition: 'ignored', reason: 'invalid_transition' });
    expect(f.query('SELECT status FROM attempts WHERE id = ?', attemptRow.id)).toMatchObject({ status: 'succeeded' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'succeeded' });
    /* 终态通知重放（同 notificationId 语义由持久回执承担）：重复扫描零新增执行。 */
    await f.core.workExecution.scan();
    expect(f.runtimeStarts()).toBe(1);
    expect(Number((f.query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.planningTaskId) as { n: number }).n)).toBe(1);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * 受控 Pi Runner 工具桥（真实 Pi 适配器/Runner 协议 + 真实环回 HTTP）
 * ------------------------------------------------------------------ */
describe('P05-1 / F-007 受控 Pi Runner 工具桥', () => {
  it('[case:pi-runner-tool-bridge] 真实 Runner 子进程经 submission 工具发布候选并成功收尾', async () => {
    const { startHostlessPlanningRunnerBridge } = await import('../../helpers/planning/p05-1-f007-runner-bridge.ts');
    const harness = await startHostlessPlanningRunnerBridge({ prefix: 'shiploop-p051-f007-bridge-' });
    fixtures.push(harness.fixture);
    try {
      await harness.drive();
      const f = harness.fixture;
      await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
        { timeout: 25_000 }).toMatchObject({ status: 'interrupted' });
      expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId))
        .toMatchObject({ status: 'paused' });
      expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId))
        .toMatchObject({ status: 'candidate_published' });
      expect(Number((f.query('SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?', 'planning-candidate') as { n: number }).n)).toBe(1);
    } finally {
      await harness.close();
    }
  }, 180_000);
});

/* 真实 provider/model 调用：not_run（本文件全部离线；未经授权不发起真实模型请求）。 */
