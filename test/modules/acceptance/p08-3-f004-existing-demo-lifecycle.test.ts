/**
 * P08-3 / F-004 存量项目生命周期场景（integration：真实 Core 应用装配 +
 * 临时 SQLite 数据根 + 真实 Git 仓库；不启动 Host 进程、不调用模型）。
 *
 * 覆盖验收点（input/p08-existing-demo.md FR-2）：
 * - 同一规范仓库重复 init 返回原 projectId，不覆盖名称、绑定、脏状态或
 *   历史检查事实；同 remote 的不同 clone 保持不同项目身份；
 * - 归档前后项目状态、归档授权（回执/事件）与 pending/历史检查事实可查询；
 *   归档（含 archiving）项目不得启动新的基线或工作执行，拒绝是结构化
 *   rejected/错误而不是伪造的成功（含准备与提交事务之间的竞争窗口）；
 * - 显式 restore 后原 projectId、仓库绑定、检查历史与证据引用可查询且
 *   未被改写；归档/恢复不导入或覆盖 Harness 业务状态（业务行与源仓库
 *   文件原样），历史失败报告保持历史身份，不被冒充为当前 live 结果；
 * - 仓库移动、绑定 revision 漂移或 repo identity 不匹配需要显式预览与
 *   确认；冲突被拒绝且不创建错误绑定、不删除源仓库文件。
 *
 * 真实 Host 重启、跨进程 SQLite 持久性、真实生产仓库移动与归档/恢复演练
 * 属 Phase 集成验收；本文件未运行这些场景，按下方声明保持 not_run。
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication, type CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { RepositoryInspector, RepositoryInspection } from '../../../packages/core/src/ports/repository-inspector.ts';
import { computeBrownfieldCheckCommandDigest } from '../../../packages/core/src/ports/brownfield.ts';
import {
  collectBrownfieldEvidenceEnvelope,
  validateBrownfieldEvidenceEnvelope,
} from '../../../packages/core/src/ports/brownfield-evidence.ts';
import { openDataRootStorageProbe } from '../../helpers/p02-4/index.ts';
import type { StorageProbe } from '../../helpers/p02-2/storage-probe.ts';
import { commitAll, git, initGitRepo } from '../../helpers/git-repo.ts';
import { createTempSandbox, type TempSandbox } from '../../helpers/temp-sandbox.ts';
import {
  createLegacyTodoFixture,
  type LegacyTodoFixture,
} from '../../helpers/p08-3/legacy-todo-fixture.ts';

/** Phase 必需集成验收的未执行声明：本 Task 局部通过不折算这些证据。 */
const P08_3_F004_PHASE_INTEGRATION_NOT_RUN = [
  { id: 'host-restart-lifecycle', status: 'not_run', owner: 'phase-integration', reason: 'phase_host_restart_pending' },
  { id: 'sqlite-persistence-across-restart', status: 'not_run', owner: 'phase-integration', reason: 'phase_sqlite_persistence_pending' },
  { id: 'real-repository-move-drill', status: 'not_run', owner: 'phase-integration', reason: 'phase_real_move_pending' },
  { id: 'archive-restore-host-drill', status: 'not_run', owner: 'phase-integration', reason: 'phase_archive_restore_pending' },
] as const;

const BUDGET = {
  batch: {
    maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2, maxNoProgressRuns: 2,
    deadlineUtcMs: Date.now() + 3_600_000, maxTokenTotal: 1000, maxCostTotal: 10,
  },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 },
};

const OWNER = createLocalOwnerPrincipal();

interface ActiveScenario {
  dispose(): Promise<void>;
}

const active: ActiveScenario[] = [];

function sha256(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Scenario {
  readonly app: CoreApplication;
  readonly legacy: LegacyTodoFixture;
  readonly sandbox: TempSandbox;
  readonly probe: StorageProbe;
  readonly dataRoot: string;
}

async function openScenario(prefix: string, extra: { readonly inspector?: RepositoryInspector } = {}): Promise<Scenario> {
  const sandbox = createTempSandbox(prefix);
  const legacy = createLegacyTodoFixture({ prefix });
  const dataRoot = join(sandbox.path, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const app = await openCoreApplication({
    dataRoot,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
    ]),
    ...(extra.inspector === undefined ? {} : { repositoryInspector: extra.inspector }),
  });
  const probe = openDataRootStorageProbe(dataRoot);
  active.push({
    async dispose() {
      // 尽力收尾在途基线（保留 fail-closed 关闭语义：取消失败时出错的
      // 断言仍在测试体内优先暴露）。
      for (const operationId of app.baselineExecutionService.activeOperationIds()) {
        try {
          const row = app.baselineStore.getBaselineOperation(operationId);
          if (row !== undefined) {
            await app.baselineExecutionService.cancel(OWNER, row.projectId, operationId);
          }
        } catch {
          // 夹具回收保持权威：临时目录的删除与核验由下方 dispose 负责。
        }
      }
      await app.baselineExecutionService.waitForIdle();
      probe.close();
      app.close();
      legacy.dispose();
      legacy.cleanupSandbox();
      sandbox.cleanup();
    },
  });
  return { app, legacy, sandbox, probe, dataRoot };
}

afterEach(async () => {
  for (const item of active.splice(0).reverse()) await item.dispose();
});

function commandEnvelope(operation: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    issuedAt: new Date().toISOString(),
    operation,
    payload,
    ...extra,
  };
}

function projectScope(projectId: string) {
  return { kind: 'project' as const, projectId };
}

function projectRevision(scenario: Scenario, projectId: string): number {
  const row = scenario.probe.projectRow(projectId);
  if (row === undefined) throw new Error(`project row missing: ${projectId}`);
  return row.revision;
}

function submitProjectCommand(scenario: Scenario, operation: string, projectId: string, payload: Record<string, unknown> = {}) {
  return scenario.app.commandService.submit(OWNER, commandEnvelope(operation, { projectId, ...payload }, {
    scope: projectScope(projectId),
    expectedRevision: projectRevision(scenario, projectId),
  }));
}

function baselinePlan(checkKey: string, argv: readonly string[], timeoutMs = 10_000) {
  return { checks: [{ checkKey, kind: 'command' as const, argv: [...argv], timeoutMs, required: true }] };
}

const LEGACY_FAILED_PLAN = baselinePlan('known-failure', ['node', 'checks/known-failure.mjs']);
const LEGACY_PASSING_PLAN = baselinePlan('existing-check', ['node', 'checks/existing-check.mjs']);

/** 通过公开基线用例执行一次检查并等待收尾，返回 operationId 与检查事实。 */
async function runBaselineAndWait(
  app: CoreApplication,
  projectId: string,
  plan: unknown,
): Promise<{ operationId: string; checks: readonly Record<string, any>[] }> {
  const preview = await app.baselineService.previewBaseline(OWNER, projectId, { plan });
  const receipt = await app.baselineExecutionService.submit(OWNER, commandEnvelope('baseline.run', {
    decision: 'authorize', plan, previewDigest: preview.previewDigest,
  }, { scope: projectScope(projectId) }));
  const operationId = (receipt as { operationId?: string }).operationId;
  if (receipt.status !== 'accepted' || operationId === undefined) {
    throw new Error(`baseline submit failed: ${JSON.stringify(receipt)}`);
  }
  await app.baselineExecutionService.waitForIdle();
  const checks = app.baselineStore.listBaselineCheckResults(operationId) as unknown as Record<string, any>[];
  return { operationId, checks };
}

/** 为工作执行准备已批准计划（与调度夹具同一公开命令路径）。 */
async function prepareApprovedPlan(scenario: Scenario, projectId: string): Promise<string> {
  const { app } = scenario;
  const submit = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    app.commandService.submit(OWNER, commandEnvelope(operation, payload, extra));
  const requireCompleted = async (promise: Promise<{ status: string }>) => {
    const receipt = await promise;
    if (receipt.status !== 'completed') throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
    return receipt;
  };
  await requireCompleted(submit('settings.global.create', {
    schemaVersion: 2,
    strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  }, { scope: { kind: 'global' } }));
  await requireCompleted(submit('phase.create', {
    id: 'phase-1', title: '生命周期门控', description: null, labels: [],
  }, { scope: projectScope(projectId) }));
  const imported = (await requireCompleted(submit('feature.plan.import', {
    phaseId: 'phase-1',
    plan: {
      schemaVersion: 1,
      feature: { title: '存量演示执行', description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: 't-1', title: 'Task', acceptance: { criteria: ['生命周期门控一致'] }, dependsOn: [] }],
    },
  }, { scope: projectScope(projectId), expectedRevision: 1 }))) as unknown as {
    result: { feature: { id: string; planDigest: string; revision: number } };
  };
  await requireCompleted(submit('feature.plan.decide', {
    featureId: imported.result.feature.id,
    planDigest: imported.result.feature.planDigest,
    decision: 'approve',
    reason: 'test authorization',
  }, { scope: projectScope(projectId), expectedRevision: 1 }));
  return imported.result.feature.id;
}

async function waitFor(claim: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (claim()) return;
    await new Promise(resolve => { setTimeout(resolve, 20); });
  }
  throw new Error(`condition not met within ${timeoutMs}ms: ${what}`);
}

function cloneLegacyRepository(legacy: LegacyTodoFixture, sandbox: TempSandbox, name: string): string {
  const target = join(sandbox.path, name);
  git(['clone', legacy.repositoryPath, target], sandbox.path);
  return target;
}

function assertPhaseIntegrationNotRun(): void {
  expect(P08_3_F004_PHASE_INTEGRATION_NOT_RUN.every(entry => entry.status === 'not_run')).toBe(true);
}

describe('P08-3 F-004 存量项目生命周期场景', () => {
  it('[case:p08-3-f004-repeat-init-and-clone-identity] 重复 init 复用原项目身份，同 remote 不同 clone 独立成项目', async () => {
    const scenario = await openScenario('shiploop-p08-3-f004-init-');
    const { app, legacy, sandbox } = scenario;
    const first = await app.projectService.registerRepository({
      repositoryPath: legacy.repositoryPath, displayName: '存量 Todo', description: 'legacy demo', labels: ['brownfield'],
    });
    expect(first.status).toBe('registered');
    const projectId = first.project.id;

    // 历史检查事实：真实基线运行记录 known-failure（exit 3）证据。
    const history = await runBaselineAndWait(app, projectId, LEGACY_FAILED_PLAN);
    expect(history.checks[0]).toMatchObject({ checkKey: 'known-failure', status: 'failed', exitCode: 3 });
    const historyBefore = await app.baselineQueryService.getBaseline(OWNER, history.operationId);
    const dirtyBefore = legacy.dirtyFileDigests();
    const porcelainBefore = git(['status', '--porcelain', '--untracked-files=all'], legacy.repositoryPath);

    // 同一规范仓库重复 init：already_exists 复用原 projectId，不覆盖任何字段。
    const repeat = await app.projectService.registerRepository({
      repositoryPath: legacy.repositoryPath, displayName: '试图覆盖的名称', description: 'must not overwrite', labels: ['evil'],
    });
    expect(repeat.status).toBe('already_exists');
    expect(repeat.project.id).toBe(projectId);
    expect(repeat.project).toMatchObject({ displayName: '存量 Todo', description: 'legacy demo' });
    expect(repeat.project.labels).toEqual(['brownfield']);
    expect(repeat.binding).toEqual(first.binding);

    // 名称/绑定/脏状态/历史检查均未被覆盖；仓库工作区字节不变。
    expect(await app.projectService.getProject(projectId)).toMatchObject({ displayName: '存量 Todo' });
    expect(await app.projectService.getRepositoryBinding(projectId)).toEqual(first.binding);
    expect(legacy.dirtyFileDigests()).toEqual(dirtyBefore);
    expect(git(['status', '--porcelain', '--untracked-files=all'], legacy.repositoryPath)).toBe(porcelainBefore);
    expect(await app.baselineQueryService.getBaseline(OWNER, history.operationId)).toEqual(historyBefore);

    // 同 remote 的不同 clone：独立项目身份（不同 projectId 与 repoIdentity）。
    const cloneA = cloneLegacyRepository(legacy, sandbox, 'clone-a');
    const cloneB = cloneLegacyRepository(legacy, sandbox, 'clone-b');
    const remoteA = git(['remote', 'get-url', 'origin'], cloneA).trim();
    const remoteB = git(['remote', 'get-url', 'origin'], cloneB).trim();
    expect(remoteA).toBe(legacy.repositoryPath);
    expect(remoteB).toBe(remoteA);
    const projectA = await app.projectService.registerRepository({ repositoryPath: cloneA, displayName: 'clone A' });
    const projectB = await app.projectService.registerRepository({ repositoryPath: cloneB, displayName: 'clone B' });
    expect(projectA.status).toBe('registered');
    expect(projectB.status).toBe('registered');
    expect(new Set([projectA.project.id, projectB.project.id, projectId]).size).toBe(3);
    expect(new Set([
      projectA.binding.repoIdentity, projectB.binding.repoIdentity, first.binding.repoIdentity,
    ]).size).toBe(3);
    // 不同 clone 的绑定互不串扰。
    expect(await app.projectService.getRepositoryBinding(projectA.project.id))
      .toMatchObject({ canonicalPath: realpathSync(cloneA) });
    expect(await app.projectService.getRepositoryBinding(projectB.project.id))
      .toMatchObject({ canonicalPath: realpathSync(cloneB) });

    assertPhaseIntegrationNotRun();
  }, 120_000);

  it('[case:p08-3-f004-archive-rejects-new-baseline-and-work] 归档拒绝新基线与新工作执行，拒绝不伪造为成功', async () => {
    const scenario = await openScenario('shiploop-p08-3-f004-gate-');
    const { app, legacy, probe } = scenario;
    const registered = await app.projectService.registerRepository({
      repositoryPath: legacy.repositoryPath, displayName: '存量归档演示',
    });
    const projectId = registered.project.id;
    const featureId = await prepareApprovedPlan(scenario, projectId);
    const readyPreview = await app.executionPreview.previewExecution(projectId, { featureIds: [featureId], budget: BUDGET });
    expect(readyPreview.status).toBe('ready');

    const history = await runBaselineAndWait(app, projectId, LEGACY_FAILED_PLAN);
    expect(history.checks[0]).toMatchObject({ status: 'failed', exitCode: 3 });
    const artifactId = history.checks[0].outputArtifactId as string;
    expect(artifactId).toMatch(/^[0-9a-f-]{36}$/);
    const historyBefore = await app.baselineQueryService.getBaseline(OWNER, history.operationId);
    const baselineCountBefore = probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ?', [projectId],
    )!.n;
    // 归档前取得的合法预览（用于归档后证明运行前置被拒，而不是摘要格式错误）。
    const previewWhileActive = await app.baselineService.previewBaseline(OWNER, projectId, { plan: LEGACY_PASSING_PLAN });

    // 显式归档（无活动占用：单命令内收口）。
    const archive = await submitProjectCommand(scenario, 'project.archive', projectId);
    expect(archive).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
    expect(await app.projectService.getProject(projectId)).toMatchObject({ status: 'archived' });

    // 归档授权与状态事实可查询：持久回执（principal/command/operation）+ 状态事件。
    const receiptRow = probe.receiptRow(OWNER.principalId, (archive as { commandId: string }).commandId);
    expect(receiptRow).toMatchObject({ operation: 'project.archive', status: 'completed' });
    const events = probe.stateEvents()
      .filter(event => event.event_type === 'project.status_changed')
      .map(event => JSON.parse(event.payload));
    expect(events).toEqual([{ from: 'active', to: 'archiving' }, { from: 'archiving', to: 'archived' }]);

    // 历史检查事实在归档后仍可查询（含证据制品正文）。
    expect(await app.baselineQueryService.getBaseline(OWNER, history.operationId)).toEqual(historyBefore);
    const artifact = await app.baselineQueryService.readArtifactContent(OWNER, artifactId);
    expect(artifact.content.length).toBeGreaterThan(0);

    // 归档项目不得启动新基线：预览与运行前置准备均结构化拒绝（零副作用）。
    await expect(app.baselineService.previewBaseline(OWNER, projectId, { plan: LEGACY_PASSING_PLAN }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'project_not_active' } });
    await expect(app.baselineExecutionService.submit(OWNER, commandEnvelope('baseline.run', {
      decision: 'authorize', plan: LEGACY_PASSING_PLAN, previewDigest: previewWhileActive.previewDigest,
    }, { scope: projectScope(projectId) }))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'project_not_active' } });
    expect(probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ?', [projectId],
    )!.n).toBe(baselineCountBefore);

    // 归档项目不得启动新工作执行：预览被阻塞、启动被拒绝且零执行写入。
    const blocked = await app.executionPreview.previewExecution(projectId, { featureIds: [featureId], budget: BUDGET });
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'project_not_active', status: 'archived' }),
    ]));
    const start = await app.commandService.submit(OWNER, commandEnvelope('execution.start', {
      featureIds: [featureId], budget: BUDGET, previewDigest: readyPreview.previewDigest,
    }, { scope: projectScope(projectId) }));
    expect(start).toMatchObject({ status: 'rejected', error: { details: { reason: 'preview_stale' } } });
    expect(probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM execution_batches WHERE project_id = ?', [projectId],
    )!.n).toBe(0);
    expect(probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?', [projectId])!.n).toBe(0);

    assertPhaseIntegrationNotRun();
  }, 120_000);

  it('[case:p08-3-f004-archive-race-rejects-in-transaction] 准备与提交之间的归档竞争在事务内 fail-closed 拒绝', async () => {
    // 注入检查器：在 baseline.run 事务外准备阶段（读取项目为 active 之后、
    // 提交事务之前）完成一次真实归档，覆盖事务内重核路径。
    const realInspector = createRepositoryInspector();
    let armed = false;
    let race: { readonly app: CoreApplication; readonly projectId: string; readonly canonicalPath: string } | undefined;
    const inspector: RepositoryInspector = {
      async inspect(value: unknown): Promise<RepositoryInspection> {
        const inspection = await realInspector.inspect(value);
        if (armed && race !== undefined && value === race.canonicalPath) {
          armed = false;
          const project = await race.app.stateStore.getProject(race.projectId);
          const archive = await race.app.commandService.submit(OWNER, commandEnvelope('project.archive', {
            projectId: race.projectId,
          }, { scope: projectScope(race.projectId), expectedRevision: project.revision }));
          expect(archive).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
        }
        return inspection;
      },
    };
    const scenario = await openScenario('shiploop-p08-3-f004-race-', { inspector });
    const { app, legacy, probe } = scenario;
    const registered = await app.projectService.registerRepository({
      repositoryPath: legacy.repositoryPath, displayName: '存量竞争演示',
    });
    const projectId = registered.project.id;
    const preview = await app.baselineService.previewBaseline(OWNER, projectId, { plan: LEGACY_PASSING_PLAN });
    const baselineCountBefore = probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ?', [projectId],
    )!.n;

    race = { app, projectId, canonicalPath: registered.binding.canonicalPath };
    armed = true;
    const receipt = await app.baselineExecutionService.submit(OWNER, commandEnvelope('baseline.run', {
      decision: 'authorize', plan: LEGACY_PASSING_PLAN, previewDigest: preview.previewDigest,
    }, { scope: projectScope(projectId) }));

    // 竞争窗口内归档已提交：运行命令以 rejected（非 accepted、非伪造成功）
    // 固化拒绝，且不产生任何基线操作行。
    expect(receipt).toMatchObject({ status: 'rejected', error: { details: { reason: 'project_not_active' } } });
    expect(probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ?', [projectId],
    )!.n).toBe(baselineCountBefore);
    expect(await app.baselineExecutionService.activeOperationIds()).toEqual([]);

    assertPhaseIntegrationNotRun();
  }, 120_000);

  it('[case:p08-3-f004-archive-closeout-pending-baseline] 进行中基线阻塞归档收尾，pending 事实可查询且新基线被拒', async () => {
    const scenario = await openScenario('shiploop-p08-3-f004-closeout-');
    const { app, legacy } = scenario;
    const registered = await app.projectService.registerRepository({
      repositoryPath: legacy.repositoryPath, displayName: '存量收尾演示',
    });
    const projectId = registered.project.id;
    const hangPlan = baselinePlan('hang-check', [process.execPath, '-e', 'process.stdout.write("barrier\\n"); setInterval(() => {}, 1000)'], 60_000);
    const preview = await app.baselineService.previewBaseline(OWNER, projectId, { plan: hangPlan });
    const submitted = await app.baselineExecutionService.submit(OWNER, commandEnvelope('baseline.run', {
      decision: 'authorize', plan: hangPlan, previewDigest: preview.previewDigest,
    }, { scope: projectScope(projectId) }));
    expect(submitted.status).toBe('accepted');
    const submittedOperationId = (submitted as { operationId: string }).operationId;
    await waitFor(() => app.baselineStore.getBaselineOperation(submittedOperationId)?.status === 'running', 15_000, 'baseline running');

    // 进行中的基线操作阻塞归档收尾：不伪造 archived，回执如实记录 settled=false。
    const archive = await submitProjectCommand(scenario, 'project.archive', projectId);
    expect(archive).toMatchObject({
      status: 'completed',
      result: { status: 'archiving', settled: false, blockers: { activeBaselineOperations: 1 } },
    });
    expect(await app.projectService.getProject(projectId)).toMatchObject({ status: 'archiving' });

    // pending 检查事实可查询：占用中的操作保持 running、逐项结果仍可读。
    const pendingOperation = await app.baselineQueryService.getBaseline(OWNER, submittedOperationId);
    expect(pendingOperation.operation.status).toBe('running');
    expect(app.baselineStore.listBaselineCheckResults(submittedOperationId)).toHaveLength(1);

    // archiving 状态同样拒绝新基线（非 active 一律拒绝）。
    await expect(app.baselineService.previewBaseline(OWNER, projectId, { plan: LEGACY_PASSING_PLAN }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'project_not_active', status: 'archiving' } });

    // 既有基线沿自身路径收尾后，新归档命令完成 archiving→archived。
    await app.baselineExecutionService.cancel(OWNER, projectId, submittedOperationId);
    await app.baselineExecutionService.waitForIdle();
    const settle = await submitProjectCommand(scenario, 'project.archive', projectId);
    expect(settle).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });
    // 取消后的操作事实保留可查询（历史不被收尾改写为通过）。
    const cancelled = await app.baselineQueryService.getBaseline(OWNER, submittedOperationId);
    expect(cancelled.operation.status).toBe('cancelled');

    assertPhaseIntegrationNotRun();
  }, 120_000);

  it('[case:p08-3-f004-restore-keeps-history-and-independent-report] 显式恢复保留身份/历史/证据，不覆盖业务状态或冒充 live 结果', async () => {
    const scenario = await openScenario('shiploop-p08-3-f004-restore-');
    const { app, legacy, probe } = scenario;
    const registered = await app.projectService.registerRepository({
      repositoryPath: legacy.repositoryPath, displayName: '存量恢复演示',
    });
    const projectId = registered.project.id;
    const bindingBefore = await app.projectService.getRepositoryBinding(projectId);
    const history = await runBaselineAndWait(app, projectId, LEGACY_FAILED_PLAN);
    const artifactId = history.checks[0].outputArtifactId as string;
    const artifactContentBefore = await app.baselineQueryService.readArtifactContent(OWNER, artifactId);
    const historyBefore = await app.baselineQueryService.getBaseline(OWNER, history.operationId);
    const baselineCountBefore = probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ?', [projectId],
    )!.n;

    // 恢复前后业务行快照（projects/state_events/command_receipts 属管理面，合法变化）。
    const businessTables = ['repository_bindings', 'baseline_authorizations', 'baseline_operations',
      'baseline_check_results', 'phases', 'features', 'tasks', 'execution_batches', 'runs', 'attempts', 'artifacts'];
    const businessSnapshot = () => Object.fromEntries(businessTables.map(table => [
      table, probe.selectAll(`SELECT * FROM ${table} ORDER BY id`),
    ]));
    const businessBefore = businessSnapshot();
    const dirtyBefore = legacy.dirtyFileDigests();

    const archive = await submitProjectCommand(scenario, 'project.archive', projectId);
    expect(archive).toMatchObject({ status: 'completed', result: { status: 'archived' } });
    const restore = await submitProjectCommand(scenario, 'project.restore', projectId);
    expect(restore).toMatchObject({ status: 'completed', result: { status: 'active' } });

    // 原 projectId、仓库绑定、检查历史与证据引用全部保持可查询且未改写。
    expect(await app.projectService.getProject(projectId)).toMatchObject({ id: projectId, status: 'active' });
    expect(await app.projectService.getRepositoryBinding(projectId)).toEqual(bindingBefore);
    expect(await app.baselineQueryService.getBaseline(OWNER, history.operationId)).toEqual(historyBefore);
    const artifactContentAfter = await app.baselineQueryService.readArtifactContent(OWNER, artifactId);
    expect(sha256(artifactContentAfter.content)).toBe(sha256(artifactContentBefore.content));

    // 恢复不导入/覆盖 Harness 业务状态：业务行原样，源仓库文件与脏状态原样，
    // 仓库内不落入任何 ShipLoop 状态文件。
    expect(businessSnapshot()).toEqual(businessBefore);
    expect(legacy.dirtyFileDigests()).toEqual(dirtyBefore);
    expect(legacy.stateIsolation().status).toBe('isolated');

    // 不把历史报告冒充当前 live 结果：恢复不制造新基线操作；最近一次操作仍是
    // 原历史记录（操作生命周期 completed，逐项检查保持失败事实），项目当前
    // live 状态没有因恢复变成通过。
    expect(probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ?', [projectId],
    )!.n).toBe(baselineCountBefore);
    const latest = probe.selectOne<{ id: string; status: string }>(
      'SELECT id, status FROM baseline_operations WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [projectId],
    )!;
    expect(latest).toMatchObject({ id: history.operationId, status: 'completed' });
    const historyChecks = (await app.baselineQueryService.getBaseline(OWNER, history.operationId)).checks;
    expect(historyChecks[0]).toMatchObject({ checkKey: 'known-failure', status: 'failed', exitCode: 3 });

    // 独立的存量报告：从持久事实重建 F-002 证据封套，两次采集摘要一致且可
    // 验证——历史报告独立于归档/恢复存在，仍以失败事实呈现。
    const authorization = app.baselineStore.getBaselineAuthorization(
      (app.baselineStore.getBaselineOperation(history.operationId) as { authorizationId: string }).authorizationId,
    );
    if (authorization === undefined) throw new Error('history baseline authorization missing');
    const environmentIdentity = sha256('shiploop:p08-3-f004:check-environment');
    const checks = app.baselineStore.listBaselineCheckResults(history.operationId).map(row => {
      const check = {
        checkKey: row.checkKey, argv: [...row.argv], environmentIdentity, timeoutMs: row.timeoutMs, required: row.required,
      };
      return {
        check,
        commandDigest: computeBrownfieldCheckCommandDigest(check),
        result: row.status === 'failed'
          ? { status: 'failed', reasonCode: 'non_zero_exit', exitCode: row.exitCode, evidenceRefs: [artifactId], failureCaseIds: ['case:known-failure-exit-3'] }
          : { status: 'passed', evidenceRefs: [artifactId] },
      };
    });
    const codeIdentity = {
      repoIdentity: bindingBefore.repoIdentity,
      headCommit: authorization.headCommit,
      workingTreeDigest: authorization.workingTreeDigest,
      hasUncommittedChanges: authorization.hasUncommittedChanges,
    };
    const dirtyFiles = legacy.dirtyFileDigests().map(file => ({ path: file.path, state: 'modified_unstaged' as const, digest: file.digest }));
    const envelopeInput = {
      projectId,
      binding: {
        projectId,
        repositoryBindingId: bindingBefore.id,
        bindingRevision: bindingBefore.bindingRevision,
        canonicalPath: bindingBefore.canonicalPath,
        repoIdentity: bindingBefore.repoIdentity,
      },
      testCommit: authorization.headCommit,
      baselineCodeIdentity: codeIdentity,
      currentCodeIdentity: codeIdentity,
      checkScope: { requiredCheckKeys: ['known-failure'], optionalCheckKeys: [] },
      baselineChecks: checks,
      currentChecks: checks,
      artifacts: [{ ref: artifactId, digest: sha256(artifactContentBefore.content), bytes: artifactContentBefore.content.length }],
      baselineDirtyFiles: dirtyFiles,
      currentDirtyFiles: dirtyFiles,
      phaseIntegration: [{ id: 'host-restart-lifecycle', reason: 'phase_host_restart_pending' }],
      collectedAtUtcMs: 1_900_000_000_000,
    };
    const envelope = collectBrownfieldEvidenceEnvelope(envelopeInput);
    expect(envelope.remainingGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'known-failure:known-failure', kind: 'existing_failure' }),
    ]));
    const rebuilt = collectBrownfieldEvidenceEnvelope(envelopeInput);
    expect(rebuilt.envelopeDigest).toBe(envelope.envelopeDigest);
    expect(validateBrownfieldEvidenceEnvelope(rebuilt)).toEqual(envelope);
    // 历史报告保持失败事实：不因恢复被改写为通过。
    expect(envelope.summary).toMatchObject({ checks: 1, existingFailure: 1, passed: 0 });

    assertPhaseIntegrationNotRun();
  }, 120_000);

  it('[case:p08-3-f004-move-preview-confirm-and-identity-conflicts] 移动需显式预览确认，漂移/身份冲突被拒绝且零破坏', async () => {
    const scenario = await openScenario('shiploop-p08-3-f004-move-');
    const { app, legacy, sandbox } = scenario;
    const movedRepository = cloneLegacyRepository(legacy, sandbox, 'move-source');
    const registered = await app.projectService.registerRepository({
      repositoryPath: movedRepository, displayName: '存量移动演示',
    });
    const projectId = registered.project.id;
    const moveService = app.repositoryMoveService;

    // 物理移动后预览：显式确认边界；cancel 决定被拒绝，绑定不变。
    const movedPath = join(sandbox.path, 'move-target');
    renameSync(movedRepository, movedPath);
    const preview = await moveService.preview(OWNER, { projectId, repositoryPath: movedPath });
    expect(preview).toMatchObject({ projectId, requiresExplicitConfirmation: true, identityRelation: 'different' });
    expect(preview.oldBinding.canonicalPath).toBe(registered.binding.canonicalPath);
    const readmeBefore = readFileSync(join(movedPath, 'README.md'), 'utf8');
    await expect(moveService.confirm(OWNER, {
      preview,
      decision: { schemaVersion: 1, projectId, oldBinding: preview.oldBinding, previewDigest: preview.previewDigest, decision: 'cancel' },
    })).rejects.toMatchObject({ kind: 'validation' });
    expect((await app.projectService.getRepositoryBinding(projectId)).canonicalPath).toBe(registered.binding.canonicalPath);
    expect(readFileSync(join(movedPath, 'README.md'), 'utf8')).toBe(readmeBefore);

    // 项目 revision 漂移：预览后元数据变更 → 确认拒绝，不创建错误绑定。
    await app.projectService.updateProjectMetadata(projectId, {
      expectedRevision: (await app.projectService.getProject(projectId)).revision, displayName: '改名后的存量演示',
    });
    await expect(moveService.confirm(OWNER, {
      preview,
      decision: { schemaVersion: 1, projectId, oldBinding: preview.oldBinding, previewDigest: preview.previewDigest, decision: 'confirm' },
    })).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'project_changed_after_preview' } });
    expect((await app.projectService.getRepositoryBinding(projectId)).canonicalPath).toBe(registered.binding.canonicalPath);
    expect(readFileSync(join(movedPath, 'README.md'), 'utf8')).toBe(readmeBefore);

    // 刷新预览后确认成功：原 projectId 保持，绑定切换并保留历史快照。
    const freshPreview = await moveService.preview(OWNER, { projectId, repositoryPath: movedPath });
    const confirmed = await moveService.confirm(OWNER, {
      preview: freshPreview,
      decision: { schemaVersion: 1, projectId, oldBinding: freshPreview.oldBinding, previewDigest: freshPreview.previewDigest, decision: 'confirm' },
    });
    expect(confirmed.project.id).toBe(projectId);
    expect(confirmed.binding.canonicalPath).toBe(realpathSync(movedPath));
    const snapshots = await app.stateStore.listRepositoryBindingSnapshots(projectId);
    expect(snapshots.map(snapshot => snapshot.changeKind)).toEqual(expect.arrayContaining(['previous', 'current']));

    // 绑定 revision 漂移：确认成功后同一预览再次确认 → 预览已失效被拒
    // （重新绑定会同步通推进项目 revision，project CAS 先命中；旧绑定
    // 比对作为同层防御保留）。绑定未被错误改写、源仓库文件未被删除。
    const otherClone = cloneLegacyRepository(legacy, sandbox, 'other-clone');
    const stalePreview = await moveService.preview(OWNER, { projectId, repositoryPath: otherClone });
    expect(stalePreview.oldBinding.bindingRevision).toBe(confirmed.binding.bindingRevision);
    const rebound = await moveService.confirm(OWNER, {
      preview: stalePreview,
      decision: { schemaVersion: 1, projectId, oldBinding: stalePreview.oldBinding, previewDigest: stalePreview.previewDigest, decision: 'confirm' },
    });
    expect(rebound.binding.canonicalPath).toBe(realpathSync(otherClone));
    await expect(moveService.confirm(OWNER, {
      preview: stalePreview,
      decision: { schemaVersion: 1, projectId, oldBinding: stalePreview.oldBinding, previewDigest: stalePreview.previewDigest, decision: 'confirm' },
    })).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'project_changed_after_preview' } });
    expect((await app.projectService.getRepositoryBinding(projectId)).canonicalPath).toBe(realpathSync(otherClone));
    // 源仓库文件未被删除：移动源与目标 clone 均保持文件。
    expect(readFileSync(join(movedPath, 'README.md'), 'utf8')).toBe(readmeBefore);
    expect(readFileSync(join(otherClone, 'README.md'), 'utf8')).toBe(readmeBefore);

    // repo identity 不匹配（绑定路径被另一仓库替换）：基线预览拒绝，不创建错误绑定、不删源文件。
    const identityClone = cloneLegacyRepository(legacy, sandbox, 'identity-clone');
    const replacedProject = await app.projectService.registerRepository({
      repositoryPath: identityClone, displayName: '将被替换身份的 clone',
    });
    rmSync(join(identityClone, '.git'), { recursive: true, force: true });
    initGitRepo(identityClone);
    writeFileSync(join(identityClone, 'README.md'), 'replacement repository\n', 'utf8');
    commitAll(identityClone, 'replacement: different repository identity');
    await expect(app.baselineService.previewBaseline(OWNER, replacedProject.project.id, { plan: LEGACY_PASSING_PLAN }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'binding_identity_mismatch' } });
    expect(await app.projectService.getRepositoryBinding(replacedProject.project.id)).toMatchObject({
      repoIdentity: replacedProject.binding.repoIdentity,
      canonicalPath: replacedProject.binding.canonicalPath,
    });
    expect(readFileSync(join(identityClone, 'README.md'), 'utf8')).toBe('replacement repository\n');

    assertPhaseIntegrationNotRun();
  }, 120_000);
});
