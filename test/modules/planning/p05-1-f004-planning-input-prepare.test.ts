/**
 * P05-1 / F-004 规划输入准备与受控工作区绑定（真实临时文件/SQLite/Git 纵向）。
 *
 * 全真实资源：真实 Git 仓库与受管 worktree + 真实 SQLite + 真实制品文件；经
 * 公开命令通道完成 注册 → 配置 → 草稿计划导入 → planning.start；规划输入
 * 准备服务在此真实前置之上捕获/组装/发布/重核。仅以下测试注入使用端口包装
 * 并明确标注：发布失败注入（文件端口）、可变权限读取器、直接 SQL 现场修改
 * （模拟并发漂移/终态/损坏——生产路径不可达，用于重核分支覆盖）。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 合法空草稿规划（无需求制品、无业务计划批准）→ 完整规划输入三正文制品
 *   （planning 专用 kind/locator），snapshot 固定请求依据/目标身份（planDigest
 *   null 如实记录）/代码基线/用途策略副本/权限摘要，不伪造 plan approval；
 * - 规划 prompt 边界披露：候选 schema、planning.candidate.submit、一次性结束、
 *   人工批准边界、资源边界（无业务 SQLite 路径/owner token/未选全局资源）与
 *   可信项目模式披露；不含绝对路径；
 * - 快照不可变：重复准备正文逐字节一致，历史制品保持 ready 不可改写；
 * - 准备中断：发布中断不留下可绑定半完整制品组，已发布正文保留证据；
 * - 失败分支：目标缺失/跨项目/上下文非 open/Task 终态/输入摘要漂移/计划
 *   摘要漂移/代码基线缺失与漂移/权限漂移/策略副本漂移/制品索引漂移/
 *   需求制品不可用；
 * - planning 与 coding 输入判别（classifyPreparedInputGroup）与启动前重核
 *   通过路径；源仓库 refs/worktree 不被准备改变（只读绑定）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqlitePlanningContextStore } from '../../../packages/core/src/adapters/sqlite/planning-context-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspaceAccess } from '../../../packages/core/src/adapters/sqlite/workspace.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import type { ArtifactFileStore } from '../../../packages/core/src/ports/artifact-files.ts';
import { ArtifactFileError, deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createPlanningStartService } from '../../../packages/core/src/application/planning-start.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createExecutionInputService } from '../../../packages/core/src/application/execution-input.ts';
import {
  createPlanningInputPrepareService,
} from '../../../packages/core/src/application/planning-input-prepare.ts';
import type { PlanningInputPreparePort } from '../../../packages/core/src/application/planning-input-prepare.ts';
import { validatePlanningInputSnapshot } from '../../../packages/core/src/ports/planning-input-prepare.ts';
import {
  PLANNING_INPUT_GROUP_LOCATOR_PREFIX,
  PLANNING_MANIFEST_ARTIFACT_KIND,
  PLANNING_PROMPT_ARTIFACT_KIND,
  PLANNING_SNAPSHOT_ARTIFACT_KIND,
  classifyPreparedInputGroup,
} from '../../../packages/core/src/ports/planning-input-prepare.ts';
import type { PreparedPlanningInputGroup } from '../../../packages/core/src/ports/planning-input-prepare.ts';
import {
  EXECUTION_MANIFEST_ARTIFACT_KIND,
  EXECUTION_PROMPT_ARTIFACT_KIND,
  EXECUTION_SNAPSHOT_ARTIFACT_KIND,
  TRUSTED_PROJECT_PERMISSIONS_READER,
} from '../../../packages/core/src/ports/execution-input-prepare.ts';
import type { ExecutionPermissionsReader } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { PLANNING_CANDIDATE_SUBMIT_OPERATION } from '../../../packages/core/src/ports/planning-candidates.ts';
import { deriveManagedFeatureBranch } from '../../../packages/core/src/ports/workspace-preparation.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PlanningAcceptedCommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
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

interface F004Fixture {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly featureRevision: number;
  readonly planningRunId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly service: PlanningInputPreparePort;
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly permissionsRef: { reader: ExecutionPermissionsReader };
  close(): void;
}

let fixture: F004Fixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

function expectPublicError(error: unknown, code: string, reason: string): void {
  expect(error).toBeInstanceOf(PublicError);
  const publicError = error as PublicError;
  expect(publicError.code).toBe(code);
  expect((publicError.details as Record<string, unknown> | undefined)?.reason).toBe(reason);
}

/**
 * 打开 F-004 夹具：真实注册/配置/草稿计划导入/planning.start + 真实受管
 * worktree（git worktree add 于源仓库确认基线）+ managed_workspaces 现场行
 * （代表后续 F-005 认领流程将建立的受管工作区事实；读取与检查路径全真实）。
 */
async function openFixture(options: {
  readonly failPublishForLocatorSuffix?: string;
  readonly withManagedWorkspace?: boolean;
  readonly permissionsRef?: { reader: ExecutionPermissionsReader };
  readonly requirementArtifactIds?: readonly string[];
  readonly constraints?: readonly string[];
} = {}): Promise<F004Fixture> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p051-f004-' });
  try {
    const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
    const session = harness.session;
    const nowUtcMs = (): number => NOW;

    const artifactStore = createSqliteArtifactStore(session, { nowUtcMs });
    const realFiles: ArtifactFileStore = createArtifactFileStore({ dataRoot: box.dataRoot });
    const files: ArtifactFileStore =
      options.failPublishForLocatorSuffix === undefined
        ? realFiles
        : {
            ...realFiles,
            async publishStaging(staging, key) {
              const locator = (key as { locator?: unknown } | undefined)?.locator;
              if (typeof locator === 'string' && locator.endsWith(options.failPublishForLocatorSuffix!)) {
                throw new ArtifactFileError('io', 'ArtifactFileStore.publishStaging', '测试注入的发布失败（io）', {
                  details: { code: 'TEST_INJECTED', locator },
                });
              }
              return realFiles.publishStaging(staging, key);
            },
          };
    const groupPublisher = createArtifactPublisher({
      artifacts: artifactStore,
      files,
      limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 },
    });
    const capturePublisher = createArtifactPublisher({
      artifacts: artifactStore,
      files,
      limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
    });
    const verifier = createArtifactVerifier({
      artifacts: artifactStore,
      files: realFiles,
      limits: { maxReadBytes: 16_000_000 },
    });

    const stateStore = createSqliteStateStore(session);
    const queryStore = createSqliteQueryStore(session);
    const paths = createPathService({ dataRoot: box.root, projectLookup: stateStore, featureLookup: queryStore });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.root], preparationPaths: paths });
    const workResources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, nowUtcMs });
    const workspaceAccess = createSqliteWorkspaceAccess(session, { resources: workResources, nowUtcMs });
    const inspector = createWorkspaceInspector({
      authorizedRoots: [box.root],
      confirmProcessIdentity: async (identity) => ({ launchId: identity.launchId }),
    });
    // 代码基线读取器：与生产装配 readReworkScene 同一受管工作区 + 真实检查器路径。
    const readCodeBaseline = async (input: { readonly projectId: string; readonly featureId: string }) => {
      const managed = workspaceAccess.readWorkspace(input.projectId, input.featureId);
      if (managed === null || managed.gitCommonDir === null) return null;
      const inspection = await inspector.inspect({
        repositoryBindingId: managed.repositoryBindingId,
        repositoryBindingRevision: managed.repositoryBindingRevision,
        repoIdentity: managed.repoIdentity,
        canonicalPath: managed.canonicalPath,
        gitCommonDir: managed.gitCommonDir,
        branch: managed.branch,
        baseCommit: managed.baseCommit,
      });
      return { worktreeId: managed.id, headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest };
    };

    const permissionsRef = options.permissionsRef ?? { reader: TRUSTED_PROJECT_PERMISSIONS_READER };
    const service = createPlanningInputPrepareService({
      views: createSqlitePlanningContextStore(session, { nowUtcMs }),
      inputs: createExecutionInputService({
        artifacts: artifactStore,
        publisher: capturePublisher,
        verifier,
        sources: { openSourceRead: async () => { throw new Error('file sources not configured in this fixture'); } },
        limits: {
          maxItems: 8,
          maxItemBytes: 1_000_000,
          maxTotalBytes: 4_000_000,
          captureTimeoutMs: 30_000,
          readTimeoutMs: 30_000,
        },
        nowMs: nowUtcMs,
      }),
      artifacts: artifactStore,
      publisher: groupPublisher,
      verifier,
      permissions: (input) => permissionsRef.reader(input),
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
      repositoryPath: box.repoDirA, displayName: 'P05-1 F-004', description: null, labels: [],
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
    const featureRowBefore = await submit('feature.plan.import', {
      phaseId: 'phase-1', plan: {
        schemaVersion: 1,
        feature: { title: '规划目标 Feature', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 't-1', title: '既有草稿任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] }],
      },
    }, { scope, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
    const featureId = featureRowBefore.result.feature.id;

    const requirementRefs = (options.requirementArtifactIds ?? []).map((artifactId) => ({ artifactId }));
    const planningReceipt = await submit(PLANNING_START_OPERATION, {
      schemaVersion: 1,
      projectId,
      phaseId: 'phase-1',
      featureId,
      requirementRefs,
      constraints: options.constraints ?? ['不改变既有公开接口', '复用既有输入设施'],
      acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
    }, { scope, expectedRevision: featureRowBefore.result.feature.revision });
    const accepted = planningReceipt as PlanningAcceptedCommandReceipt;
    const branch = deriveManagedFeatureBranch(projectId, featureId);

    /* 真实受管 worktree：git worktree add 于源仓库确认基线（只读准备不改源）。 */
    const worktreeParent = join(box.root, 'managed', featureId, '..');
    mkdirSync(worktreeParent, { recursive: true });
    const worktreePath = join(box.root, 'managed', featureId);
    git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], box.repoDirA);

    if (options.withManagedWorkspace !== false) {
      const binding = await stateStore.getRepositoryBinding(projectId);
      const attemptId = randomUUID();
      /* 真实制品行：attempts 触发器要求 input_snapshot.group 引用真实 ready 制品。 */
      const attemptArtifactBody = Buffer.from(`{"schemaVersion":1,"fixtureAttempt":"${attemptId}"}`, 'utf8');
      const attemptArtifact = await capturePublisher.publishArtifact({
        projectId, kind: 'execution-input', mediaType: 'application/json',
        expectedHash: sha256(attemptArtifactBody), locator: `execution-inputs/f004-fixture-${attemptId}`,
        content: [attemptArtifactBody],
      });
      const attemptArtifactRecord = attemptArtifact.artifact;
      const attemptInputRef = attemptArtifactRecord.id;
      const attemptInputDigest = sha256(`f004-fixture-snapshot-${attemptId}`);
      const groupRef = {
        projectId, artifactId: attemptArtifactRecord.id, version: attemptArtifactRecord.version,
        contentHash: attemptArtifactRecord.contentHash!, sizeBytes: attemptArtifactRecord.sizeBytes!,
        locator: attemptArtifactRecord.locator, mediaType: attemptArtifactRecord.mediaType,
      };
      const attemptInputSnapshot = JSON.stringify({
        schemaVersion: 1, projectId, featureId, taskId: accepted.planningTaskId,
        digests: { snapshotDigest: attemptInputDigest },
        group: { snapshot: groupRef },
      });
      session.transactWrite('f004.fixture.workspace', (db) => {
        // 真实认领路径会推进 Task execution_version；夹具同步推到 1（触发器要求
        // attempts/managed_workspaces/tasks 三者 execution_version 一致）。
        db.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run(accepted.planningTaskId);
        db.prepare(
          'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
            'owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, ' +
            "input_digest, input_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 1, ?, 'preparing', 'preflight', " +
            "?, ?, ?)",
        ).run(attemptId, NOW, projectId, NOW, featureId, accepted.runId, accepted.planningTaskId,
          'f004-fixture-owner', 'f004-fixture-host', NOW + 60_000, attemptInputSnapshot,
          attemptInputDigest, attemptInputRef);
        db.prepare(
          'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
            'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
            'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
            "host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, " +
            "?, ?, NULL, NULL, 'ready', ?, ?, ?, 1, ?, ?)",
        ).run(randomUUID(), NOW, projectId, NOW, featureId, binding.id, binding.bindingRevision,
          binding.repoIdentity, worktreePath, binding.gitCommonDir, branch,
          git(['rev-parse', 'HEAD'], box.repoDirA).trim(),
          randomUUID(), 'f004-fixture-owner', 'f004-fixture-host', accepted.runId, attemptId);
      });
    }

    return {
      box, session, projectId, featureId,
      featureRevision: featureRowBefore.result.feature.revision,
      planningRunId: accepted.runId,
      planningTaskId: accepted.planningTaskId,
      candidateId: accepted.candidateId,
      worktreePath, branch, service,
      artifacts: artifactStore, verifier,
      permissionsRef,
      close() { session.close(); box.cleanup(); },
    };
  } catch (error) {
    box.cleanup();
    throw error;
  }
}

/** 以自定义视图端口重建服务（标注：仅测试注入；其余依赖与真实夹具一致）。 */
function createPlanningInputPrepareServiceForViews(
  f: F004Fixture,
  views: { readPlanningInputPreparationView(projectId: string, runId: string): import('../../../packages/core/src/ports/planning-input-prepare.ts').PlanningInputPreparationView | undefined },
): PlanningInputPreparePort {
  const nowUtcMs = (): number => NOW;
  const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
  return createPlanningInputPrepareService({
    views,
    inputs: createExecutionInputService({
      artifacts: f.artifacts,
      publisher: createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } }),
      verifier: createArtifactVerifier({ artifacts: f.artifacts, files, limits: { maxReadBytes: 16_000_000 } }),
      sources: { openSourceRead: async () => { throw new Error('file sources not configured'); } },
      limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
      nowMs: nowUtcMs,
    }),
    artifacts: f.artifacts,
    publisher: createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } }),
    verifier: createArtifactVerifier({ artifacts: f.artifacts, files, limits: { maxReadBytes: 2_000_000 } }),
    permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    readCodeBaseline: async () => null,
    limits: { maxRequiredItems: 8 },
    nowMs: nowUtcMs,
  });
}

async function readBody(f: F004Fixture, artifactId: string): Promise<string> {
  const verified = await f.verifier.readVerifiedContent(f.projectId, artifactId);
  return Buffer.from(verified.content).toString('utf8');
}

describe('P05-1 / F-004 规划输入准备与受控工作区绑定', () => {
  it('[case:planning-input-empty-draft-complete] 合法空草稿规划生成完整规划输入，不伪造 plan approval', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    try {
      // 身份与判别。
      expect(prepared).toMatchObject({
        projectId: f.projectId, featureId: f.featureId, runId: f.planningRunId,
        planningTaskId: f.planningTaskId, candidateId: f.candidateId, schemaVersion: 1,
      });
      const kinds = [prepared.group.snapshot, prepared.group.manifest, prepared.group.prompt].map((ref) =>
        String((f.session.database.prepare('SELECT kind FROM artifacts WHERE id = ?').get(ref.artifactId) as { kind: string }).kind));
      expect(kinds).toEqual([PLANNING_SNAPSHOT_ARTIFACT_KIND, PLANNING_MANIFEST_ARTIFACT_KIND, PLANNING_PROMPT_ARTIFACT_KIND]);
      expect(classifyPreparedInputGroup(kinds)).toBe('planning');
      expect(classifyPreparedInputGroup([EXECUTION_SNAPSHOT_ARTIFACT_KIND, EXECUTION_MANIFEST_ARTIFACT_KIND, EXECUTION_PROMPT_ARTIFACT_KIND])).toBe('coding');
      expect(classifyPreparedInputGroup([PLANNING_SNAPSHOT_ARTIFACT_KIND, EXECUTION_SNAPSHOT_ARTIFACT_KIND])).toBe('unknown');
      expect(prepared.group.snapshot.locator).toBe(`${PLANNING_INPUT_GROUP_LOCATOR_PREFIX}/${f.planningTaskId}/snapshot`);
      expect(prepared.requiredInputs).toEqual([]);
      for (const digest of Object.values(prepared.digests)) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }

      // snapshot 正文：固定请求依据/目标身份（草稿如实）/代码基线/用途策略/权限。
      const snapshotRaw = JSON.parse(await readBody(f, prepared.group.snapshot.artifactId)) as Record<string, unknown>;
      const snapshot = validatePlanningInputSnapshot(snapshotRaw, 'F004.test');
      expect(snapshot.kind).toBe('planning-input');
      expect(snapshot.request.constraints).toEqual(['不改变既有公开接口', '复用既有输入设施']);
      expect(snapshot.request.acceptance.criteria).toEqual(['候选包含 Task 拆分与验收']);
      expect(snapshot.request.strategy).toEqual({ approvalMode: 'manual', taskLimit: null });
      const featureDigestRow = f.session.database.prepare('SELECT plan_digest, plan_status FROM features WHERE id = ?').get(f.featureId) as { plan_digest: string | null; plan_status: string };
      expect(snapshot.target.planDigest).toBe(featureDigestRow.plan_digest);
      expect(snapshot.target.planStatus).toBe('draft');
      expect(snapshot.target.featureRevision).toBe(f.featureRevision);
      expect(snapshot.codeBaseline.headCommit).toBe(git(['rev-parse', 'HEAD'], f.worktreePath).trim());
      expect(snapshot.codeBaseline.codeDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.purposeStrategy.executionConfig).toMatchObject({
        schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2',
      });
      expect(snapshot.purposeStrategy.configSource).toBe('global_default');
      expect(snapshot.permissions.grants).toEqual([]);
      // 不伪造 plan approval：无任何批准身份字段（decisionId/checkPolicyDigest 不存在）。
      expect(snapshotRaw.decisionId).toBeUndefined();
      expect(snapshotRaw.checkPolicyDigest).toBeUndefined();
      expect(snapshotRaw.approval).toBeUndefined();
      const featureRow = f.session.database.prepare('SELECT plan_status FROM features WHERE id = ?').get(f.featureId) as { plan_status: string };
      expect(featureRow.plan_status).toBe('draft');

      // manifest：逐来源选取证据（固定指导/冻结请求/目标依据/代码基线/策略/权限）。
      const manifest = JSON.parse(await readBody(f, prepared.group.manifest.artifactId)) as {
        sources: { sourceId: string; hash: string }[]; promptDigest: string;
      };
      const sourceIds = manifest.sources.map((source) => source.sourceId);
      expect(sourceIds).toContain('planning-guidance');
      expect(sourceIds).toContain(`planning-request:${snapshot.request.inputDigest}`);
      expect(sourceIds).toContain(`planning-basis:${f.candidateId}`);
      expect(sourceIds).toContain(`code-baseline:${snapshot.codeBaseline.worktreeId}`);
      expect(sourceIds).toContain(`purpose-strategy:${f.planningTaskId}`);
      expect(sourceIds).toContain('permissions');
      expect(manifest.promptDigest).toBe(prepared.digests.promptDigest);

      // 启动前重核通过（无漂移）。
      await f.service.recheckPlanningInputPreparation(f.projectId, prepared);
    } finally {
      await Promise.resolve();
    }
  }, 60_000);

  it('[case:planning-prompt-boundary-disclosure] 规划 prompt 说明候选 schema、独立提交操作、一次性结束、人工批准与资源边界', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    const prompt = await readBody(f, prepared.group.prompt.artifactId);
    expect(prompt).toContain(PLANNING_CANDIDATE_SUBMIT_OPERATION);
    expect(prompt).toContain('一次性规划');
    expect(prompt).toContain('approvalMode: manual');
    expect(prompt).toContain('不能自批');
    expect(prompt).toContain('候选 schema');
    expect(prompt).toContain('业务 SQLite 路径、owner token 或未选择的全局 MCP/Skills/扩展');
    expect(prompt).toContain('不是强 OS 沙箱');
    expect(prompt).toContain('不改变既有公开接口');
    expect(prompt).toContain('候选包含 Task 拆分与验收');
    expect(prompt).toContain(`candidateId: ${f.candidateId}`);
    expect(prompt).toMatch(/planDigest=(?:[0-9a-f]{64}|null（首次规划草稿，无既有业务计划）)/);
    expect(prompt).toContain('planStatus=draft');
    // 秘密纪律：不包含绝对路径或数据库路径。
    expect(prompt).not.toContain(f.box.dbPath);
    expect(prompt).not.toContain(f.worktreePath);
    expect(prompt).not.toContain(f.box.repoDirA);
    expect(prompt).not.toContain(f.box.root);
  }, 60_000);

  it('[case:planning-snapshot-immutable] 重复准备正文逐字节一致，历史制品保持 ready 不可改写', async () => {
    fixture = await openFixture();
    const f = fixture;
    const first = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    const second = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    // 重复准备发布新制品（发布器每注册新行），正文逐字节一致。
    expect(second.group.snapshot.artifactId).not.toBe(first.group.snapshot.artifactId);
    expect(await readBody(f, second.group.snapshot.artifactId)).toBe(await readBody(f, first.group.snapshot.artifactId));
    expect(await readBody(f, second.group.manifest.artifactId)).toBe(await readBody(f, first.group.manifest.artifactId));
    expect(await readBody(f, second.group.prompt.artifactId)).toBe(await readBody(f, first.group.prompt.artifactId));
    expect(second.digests).toEqual(first.digests);
    // 历史制品仍 ready 且可逐字节复验（不可变证据）。
    const oldRow = f.session.database.prepare('SELECT status, content_hash FROM artifacts WHERE id = ?').get(first.group.snapshot.artifactId) as { status: string; content_hash: string };
    expect(oldRow).toMatchObject({ status: 'ready', content_hash: first.group.snapshot.contentHash });
    await f.service.recheckPlanningInputPreparation(f.projectId, first);
    await f.service.recheckPlanningInputPreparation(f.projectId, second);
  }, 60_000);

  it('[case:planning-preparation-interrupted] 发布中断不留下可绑定半完整制品组，已发布正文保留', async () => {
    fixture = await openFixture({ failPublishForLocatorSuffix: '/manifest' });
    const f = fixture;
    await expect(f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'internal', 'publish_failed'); return true; });
    // snapshot 已发布并保持 ready（证据保留）；manifest 发布失败（pending/failed 索引残留）。
    const rows = f.session.database.prepare(
      "SELECT kind, status FROM artifacts WHERE kind LIKE 'planning-%' ORDER BY kind",
    ).all() as { kind: string; status: string }[];
    const byKind = new Map(rows.map((row) => [row.kind, row.status]));
    expect(byKind.get(PLANNING_SNAPSHOT_ARTIFACT_KIND)).toBe('ready');
    expect(byKind.has(PLANNING_MANIFEST_ARTIFACT_KIND)).toBe(true);
    expect(byKind.get(PLANNING_MANIFEST_ARTIFACT_KIND)).not.toBe('ready');
    expect(byKind.has(PLANNING_PROMPT_ARTIFACT_KIND)).toBe(false);
    // 去除注入后重试成功（残留不阻塞新的完整准备）。
    const clean = await openFixture();
    try {
      const prepared = await clean.service.preparePlanningInput(clean.projectId, { runId: clean.planningRunId });
      await clean.service.recheckPlanningInputPreparation(clean.projectId, prepared);
    } finally {
      clean.close();
    }
  }, 60_000);

  it('[case:planning-input-run-not-found] 未知 Run 无规划上下文明确失败', async () => {
    fixture = await openFixture();
    const f = fixture;
    await expect(f.service.preparePlanningInput(f.projectId, { runId: randomUUID() }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'not_found', 'planning_run_not_found'); return true; });
  }, 60_000);

  it('[case:planning-input-cross-project] 跨项目目标不泄漏存在性（not_found 折叠）', async () => {
    fixture = await openFixture();
    const f = fixture;
    await expect(f.service.preparePlanningInput(randomUUID(), { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'not_found', 'planning_run_not_found'); return true; });
  }, 60_000);

  it('[case:planning-input-context-not-open] 候选已发布/决策后不可再准备输入', async () => {
    fixture = await openFixture();
    const f = fixture;
    const contexts = createSqlitePlanningContextStore(f.session, { nowUtcMs: () => NOW });
    const body = Buffer.from('{"schemaVersion":1,"candidate":{}}', 'utf8');
    const publisher = createArtifactPublisher({
      artifacts: f.artifacts,
      files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
      limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 },
    });
    const published = await publisher.publishArtifact({
      projectId: f.projectId, kind: 'planning-candidate', mediaType: 'application/json',
      expectedHash: sha256(body), locator: `candidates/${f.candidateId}.json`, content: [body],
    });
    f.session.transactWrite('f004.publish', () => {
      contexts.publishPlanningCandidateInTransaction({
        projectId: f.projectId, candidateId: f.candidateId, artifactId: published.artifact.id,
        contentHash: published.artifact.contentHash!, candidateDigest: sha256('candidate-digest'),
        summary: '测试候选',
      });
    });
    await expect(f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'planning_context_not_open'); return true; });
  }, 60_000);

  it('[case:planning-input-task-terminal] planning Task 终态不可再准备输入', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    f.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = ?").run(f.planningTaskId);
    await expect(f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'planning_task_terminal'); return true; });
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'planning_task_terminal'); return true; });
  }, 60_000);

  it('[case:planning-input-digest-mismatch] 冻结请求快照与上下文摘要漂移被重算识别（DB 不可变列的纵深防御）', async () => {
    fixture = await openFixture();
    const f = fixture;
    // runs.input_snapshot 与 planning_contexts.input_digest 均有不可变触发器（先验证：
    // 直接 UPDATE 被拒绝——DB 层已是第一道防线）。
    const snapshot = f.session.database.prepare('SELECT input_snapshot FROM runs WHERE id = ?').get(f.planningRunId) as { input_snapshot: string };
    const tampered = JSON.parse(snapshot.input_snapshot) as Record<string, unknown>;
    (tampered.constraints as string[]).push('被篡改的约束');
    expect(() => f.session.database.prepare('UPDATE runs SET input_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(tampered), f.planningRunId)).toThrow(/immutable/);
    // 纵深防御：注入视图包装（标注：仅测试注入）模拟一致但摘要不符的损坏行，
    // 验证服务层重算 inputDigest 分支 fail-closed。
    const realViews = createSqlitePlanningContextStore(f.session, { nowUtcMs: () => NOW });
    const driftedService = createPlanningInputPrepareServiceForViews(f, {
      readPlanningInputPreparationView(projectId: string, runId: string) {
        const view = realViews.readPlanningInputPreparationView(projectId, runId);
        if (view === undefined) return undefined;
        return { ...view, context: { ...view.context, inputDigest: 'f'.repeat(64) } };
      },
    });
    await expect(driftedService.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'corrupt_state', 'input_digest_mismatch'); return true; });
  }, 60_000);

  it('[case:planning-input-feature-plan-drift] 目标 Feature 计划摘要漂移阻止准备与启动', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    // 实质计划修订（合法命令通道）：计划内容变化改变 planDigest。
    const commands = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => NOW }),
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
      ]),
      nowUtcMs: () => NOW,
    });
    const featureRevisionNow = (f.session.database.prepare('SELECT revision FROM features WHERE id = ?').get(f.featureId) as { revision: number }).revision;
    const reviseReceipt = await commands.submit(createLocalOwnerPrincipal(), {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
      operation: 'feature.plan.revise', scope: { kind: 'project', projectId: f.projectId },
      expectedRevision: featureRevisionNow,
      payload: {
        featureId: f.featureId,
        plan: {
          schemaVersion: 1,
          feature: { title: '规划目标 Feature', description: null, labels: [], sourceRefs: [] },
          tasks: [
            { id: 't-1', title: '既有草稿任务（修订）', acceptance: { criteria: ['草稿可规划', '修订后的验收'] }, dependsOn: [] },
          ],
        },
      },
    });
    expect(reviseReceipt.status).toBe('completed');
    await expect(f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'feature_plan_drift'); return true; });
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'feature_plan_drift'); return true; });
  }, 60_000);

  it('[case:planning-input-baseline-missing] 无受管工作区时代码基线结构化失败', async () => {
    fixture = await openFixture({ withManagedWorkspace: false });
    const f = fixture;
    await expect(f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId }))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'code_baseline_unavailable'); return true; });
  }, 60_000);

  it('[case:planning-input-baseline-drift] 代码基线漂移（真实 HEAD 变化）阻止启动且不改源仓库', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    await f.service.recheckPlanningInputPreparation(f.projectId, prepared);
    // 准备（只读绑定）未改变源仓库任何 ref。
    const refsAfterPrepare = git(['for-each-ref', '--format=%(refname) %(objectname)'], f.box.repoDirA);
    const mainRefAfterPrepare = git(['rev-parse', 'refs/heads/main'], f.box.repoDirA).trim();
    // 受管 worktree 前进（真实 Git）：HEAD/codeDigest 变化 → 基线漂移。
    writeFileSync(join(f.worktreePath, 'planning-progress.txt'), 'planner made progress\n');
    commitAll(f.worktreePath, 'planning progress commit');
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'code_baseline_drift'); return true; });
    // 只读绑定断言：主分支 ref 不因准备/重核变化；受管分支因显式提交前进。
    expect(git(['rev-parse', 'refs/heads/main'], f.box.repoDirA).trim()).toBe(mainRefAfterPrepare);
    expect(refsAfterPrepare).toContain(`refs/heads/${f.branch}`);
    expect(git(['symbolic-ref', '--short', 'HEAD'], f.worktreePath).trim()).toBe(f.branch);
  }, 60_000);

  it('[case:planning-input-permissions-changed] 权限面漂移在启动前重核被拒绝', async () => {
    const permissionsRef: { reader: ExecutionPermissionsReader } = {
      reader: () => ({ grants: [] }),
    };
    fixture = await openFixture({ permissionsRef });
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    // 测试注入（标注）：可变权限读取器模拟捕获后权限面变化。
    permissionsRef.reader = () => ({ grants: ['extra:grant'] });
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'permissions_changed'); return true; });
  }, 60_000);

  it('[case:planning-input-strategy-changed] 用途策略副本漂移在启动前重核被拒绝', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    const config = f.session.database.prepare('SELECT execution_config FROM tasks WHERE id = ?').get(f.planningTaskId) as { execution_config: string };
    const changed = JSON.parse(config.execution_config) as Record<string, unknown>;
    changed.model = 'claude-sonnet';
    f.session.database.prepare('UPDATE tasks SET execution_config = ? WHERE id = ?').run(JSON.stringify(changed), f.planningTaskId);
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'strategy_copy_changed'); return true; });
  }, 60_000);

  it('[case:planning-input-artifact-index-drift] 制品索引漂移在启动前重核被拒绝', async () => {
    fixture = await openFixture();
    const f = fixture;
    const prepared = await f.service.preparePlanningInput(f.projectId, { runId: f.planningRunId });
    f.session.database.prepare('UPDATE artifacts SET storage_locator = ? WHERE id = ?')
      .run('planning-input-groups/tampered/snapshot', prepared.group.snapshot.artifactId);
    await expect(f.service.recheckPlanningInputPreparation(f.projectId, prepared))
      .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'conflict', 'artifact_changed'); return true; });
    // 正文文件篡改 → 重核时索引复验（identity 一致）后的正文复验/后续读取失败；
    // 这里直接验证准备路径的逐字节复验对篡改 fail-closed。
    const gone = await openFixture();
    try {
      const prepared2 = await gone.service.preparePlanningInput(gone.projectId, { runId: gone.planningRunId });
      const finalPath = join(gone.box.dataRoot, deriveArtifactFinalRelativePath({
        projectId: gone.projectId, artifactId: prepared2.group.prompt.artifactId,
      }));
      await writeFile(finalPath, 'tampered prompt bytes');
      await expect(gone.service.recheckPlanningInputPreparation(gone.projectId, prepared2))
        .rejects.toBeInstanceOf(PublicError);
      // 正文篡改后：旧制品索引保持 ready（不可变证据不被修补/删除）；新准备发布
      // 新制品（新文件），不受旧文件篡改影响。
      const tamperedRow = gone.session.database.prepare('SELECT status FROM artifacts WHERE id = ?').get(prepared2.group.prompt.artifactId) as { status: string };
      expect(tamperedRow.status).toBe('ready');
      const fresh = await gone.service.preparePlanningInput(gone.projectId, { runId: gone.planningRunId });
      expect(fresh.group.prompt.artifactId).not.toBe(prepared2.group.prompt.artifactId);
      await gone.service.recheckPlanningInputPreparation(gone.projectId, fresh);
    } finally {
      gone.close();
    }
  }, 60_000);

  it('[case:planning-input-requirement-unavailable] 需求制品缺失（采集失败）阻止准备', async () => {
    // planning.start 已核验需求制品 ready（pending 制品无法启动规划）；缺失分支
    // 模拟采集时索引行丢失（标注：直接 SQL 删除模拟存储缺失——采集读取路径全真实）。
    const box = createCommandsTestFixture({ prefix: 'shiploop-p051-f004-missing-' });
    try {
      const harness = await box.openTransactionalHarness();
      const session = harness.session;
      const nowUtcMs = (): number => NOW;
      const artifactStore = createSqliteArtifactStore(session, { nowUtcMs });
      const files = createArtifactFileStore({ dataRoot: box.dataRoot });
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
          schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(), operation, payload, ...extra,
        });
        if (receipt.status !== 'completed' && receipt.status !== 'accepted') throw new Error(JSON.stringify(receipt));
        return receipt;
      };
      const registered = await submit('project.register', {
        repositoryPath: box.repoDirA, displayName: 'P05-1 F-004 missing', description: null, labels: [],
      }, { scope: { kind: 'registration' } }) as CommandReceipt & { result: { project: { id: string } } };
      const projectId = registered.result.project.id;
      await submit('settings.global.create', {
        schemaVersion: 2, strategies: {
          defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
        },
      }, { scope: { kind: 'global' } });
      await submit('phase.create', { id: 'phase-1', title: 'P05-1', description: null, labels: [] }, { scope: { kind: 'project', projectId } });
      const imported = await submit('feature.plan.import', {
        phaseId: 'phase-1', plan: {
          schemaVersion: 1,
          feature: { title: '规划目标 Feature', description: null, labels: [], sourceRefs: [] },
          tasks: [{ id: 't-1', title: '草稿', acceptance: { criteria: ['c'] }, dependsOn: [] }],
        },
      }, { scope: { kind: 'project', projectId }, expectedRevision: 1 }) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
      const featureId = imported.result.feature.id;
      const requirementBody = Buffer.from('# 需求\n\n真实需求正文。\n', 'utf8');
      const requirement = await createArtifactPublisher({
        artifacts: artifactStore, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
      }).publishArtifact({
        projectId, kind: 'requirement', mediaType: 'text/markdown',
        expectedHash: sha256(requirementBody), locator: 'artifacts/f004-requirement.md', content: [requirementBody],
      });
      const accepted = await submit(PLANNING_START_OPERATION, {
        schemaVersion: 1, projectId, phaseId: 'phase-1', featureId,
        requirementRefs: [{ artifactId: requirement.artifact.id }],
        constraints: [], acceptance: { criteria: ['c'] },
        strategy: { approvalMode: 'manual', taskLimit: null },
        budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
      }, { scope: { kind: 'project', projectId }, expectedRevision: imported.result.feature.revision }) as PlanningAcceptedCommandReceipt;
      const service = createPlanningInputPrepareService({
        views: createSqlitePlanningContextStore(session, { nowUtcMs }),
        inputs: createExecutionInputService({
          artifacts: artifactStore,
          publisher: createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } }),
          verifier: createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 16_000_000 } }),
          sources: { openSourceRead: async () => { throw new Error('not used'); } },
          limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
          nowMs: nowUtcMs,
        }),
        artifacts: artifactStore,
        publisher: createArtifactPublisher({ artifacts: artifactStore, files, limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } }),
        verifier: createArtifactVerifier({ artifacts: artifactStore, files, limits: { maxReadBytes: 2_000_000 } }),
        permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
        readCodeBaseline: async () => ({ worktreeId: 'wt-fixture', headCommit: '0'.repeat(40), codeDigest: '1'.repeat(64) }),
        limits: { maxRequiredItems: 8 },
        nowMs: nowUtcMs,
      });
      // 正常路径先通过（ready 需求制品被采集为必需输入）。
      const prepared = await service.preparePlanningInput(projectId, { runId: accepted.runId });
      expect(prepared.requiredInputs).toHaveLength(1);
      expect(prepared.requiredInputs[0]).toMatchObject({ purpose: 'requirements', artifactId: requirement.artifact.id });
      // 索引行缺失 → 采集明确失败（missing 分支），不以空清单代替。
      session.database.prepare('DELETE FROM artifacts WHERE id = ?').run(requirement.artifact.id);
      await expect(service.preparePlanningInput(projectId, { runId: accepted.runId }))
        .rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'not_found', 'source_unavailable'); return true; });
      session.close();
    } finally {
      box.cleanup();
    }
  }, 60_000);

  it('[case:planning-input-file-source-capture] 追加文件来源经获准根采集为不可变制品', async () => {
    fixture = await openFixture();
    const f = fixture;
    const sourcesRoot = join(f.box.root, 'planning-sources');
    mkdirSync(sourcesRoot, { recursive: true });
    writeFileSync(join(sourcesRoot, 'extra-spec.md'), '# 追加规格\n\n规划附加输入。\n', 'utf8');
    // 重建服务以注入真实文件来源读取器（获准根白名单）。
    const { createInputSourceFileReader } = await import('../../../packages/core/src/adapters/fs/input-source-files.ts');
    const nowUtcMs = (): number => NOW;
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const service = createPlanningInputPrepareService({
      views: createSqlitePlanningContextStore(f.session, { nowUtcMs }),
      inputs: createExecutionInputService({
        artifacts: f.artifacts,
        publisher: createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 } }),
        verifier: createArtifactVerifier({ artifacts: f.artifacts, files, limits: { maxReadBytes: 16_000_000 } }),
        sources: createInputSourceFileReader({ roots: { planning: sourcesRoot } }),
        limits: { maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000, captureTimeoutMs: 30_000, readTimeoutMs: 30_000 },
        nowMs: nowUtcMs,
      }),
      artifacts: f.artifacts,
      publisher: createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } }),
      verifier: createArtifactVerifier({ artifacts: f.artifacts, files, limits: { maxReadBytes: 2_000_000 } }),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      readCodeBaseline: async () => {
        const workspaceAccess = createSqliteWorkspaceAccess(f.session, {
          resources: createSqliteWorkResourceAccess(f.session, {
            workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.box.root] }),
            nowUtcMs,
          }),
          nowUtcMs,
        });
        const managed = workspaceAccess.readWorkspace(f.projectId, f.featureId);
        if (managed === null || managed.gitCommonDir === null) return null;
        const inspection = await createWorkspaceInspector({
          authorizedRoots: [f.box.root],
          confirmProcessIdentity: async (identity) => ({ launchId: identity.launchId }),
        }).inspect({
          repositoryBindingId: managed.repositoryBindingId, repositoryBindingRevision: managed.repositoryBindingRevision,
          repoIdentity: managed.repoIdentity, canonicalPath: managed.canonicalPath,
          gitCommonDir: managed.gitCommonDir, branch: managed.branch, baseCommit: managed.baseCommit,
        });
        return { worktreeId: managed.id, headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest };
      },
      limits: { maxRequiredItems: 8 },
      nowMs: nowUtcMs,
    });
    const prepared = await service.preparePlanningInput(f.projectId, {
      runId: f.planningRunId,
      items: [{ purpose: 'planning-extra', source: { kind: 'file', root: 'planning', relativePath: 'extra-spec.md' } }],
    });
    expect(prepared.requiredInputs).toHaveLength(1);
    expect(prepared.requiredInputs[0]).toMatchObject({ purpose: 'planning-extra', origin: { kind: 'file', root: 'planning', relativePath: 'extra-spec.md' } });
    const snapshot = JSON.parse(await readBody(f, prepared.group.snapshot.artifactId)) as { requiredInputs: unknown[] };
    expect(snapshot.requiredInputs).toHaveLength(1);
    await service.recheckPlanningInputPreparation(f.projectId, prepared);
    // 未知根（路径穿越面）明确拒绝。
    await expect(service.preparePlanningInput(f.projectId, {
      runId: f.planningRunId,
      items: [{ purpose: 'escape', source: { kind: 'file', root: 'unknown-root', relativePath: 'extra-spec.md' } }],
    })).rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'invalid_input', 'source_unavailable'); return true; });
  }, 60_000);
});
