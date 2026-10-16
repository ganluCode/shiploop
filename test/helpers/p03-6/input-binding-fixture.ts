/**
 * P03-6 / F-002 执行输入绑定测试夹具（仅测试，不进 packages/）。
 *
 * 全真实资源纵向：真实 Git 仓库 + 真实 SQLite + 真实制品文件；经公开命令通道
 * 完成 注册 → 配置 → 计划导入（含真实需求制品引用）→ 批准 → execution.input.prepare
 * （真实 snapshot/manifest/prompt 制品组）→ execution.start → P03-4 真实认领 →
 * beginLaunch（授权 invocationId）。绑定服务在此真实前置之上核验。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createInputSourceFileReader } from '../../../packages/core/src/adapters/fs/input-source-files.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createBaselineWorkspaceReader } from '../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import { createExecutionInputService } from '../../../packages/core/src/application/execution-input.ts';
import {
  DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
  createExecutionInputPrepareService,
} from '../../../packages/core/src/application/execution-input-prepare.ts';
import { createExecutionPreviewService } from '../../../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../../../packages/core/src/application/execution-start.ts';
import { createExecutionInputBindingService } from '../../../packages/core/src/application/execution-input-binding.ts';
import { createRuntimeRecoveryService } from '../../../packages/core/src/application/runtime-recovery.ts';
import type { RuntimeRecoverySourceReader } from '../../../packages/core/src/ports/runtime-recovery-source.ts';
import { createLocalOwnerPrincipal } from '../p02-2/index.ts';
import { createCommandsTestFixture } from '../p02-2/index.ts';
import type { CommandsTestFixture } from '../p02-2/commands-fixture.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createStaticRuntimeRecoveryCatalog } from '../../../packages/core/src/ports/runtime-recovery-catalog.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import type { PreparedExecutionInputGroup } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import type { TaskClaimReceipt } from '../../../packages/core/src/ports/task-claim.ts';
import type { VerifiedWorkWorkspace } from '../../../packages/core/src/ports/work-resources.ts';
import type { RuntimeRecoveryCatalog } from '../../../packages/core/src/ports/runtime-recovery-catalog.ts';
import type { ExecutionInputBindingLimits } from '../../../packages/core/src/ports/execution-input-binding.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';

export const BINDING_NOW = 1_900_000_200_000;
export const BINDING_BUDGET = {
  batch: {
    maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 2,
    deadlineUtcMs: BINDING_NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 4, runTimeLimitMs: 3_600_000 },
} as const;

export const FAKE_STRATEGY = { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } as const;

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export interface BindingFixtureOptions {
  /** P03-3A 可信恢复能力描述符数组（缺省即无目录、全部 unverified）。 */
  readonly recoveryDescriptors?: unknown[];
  readonly recoverySources?: RuntimeRecoverySourceReader;
  readonly bindingLimits?: ExecutionInputBindingLimits;
  readonly bindingNowMs?: () => number;
  /** 第二 Task（独立 spec 输入、无依赖；用于 Task 上下文隔离）。 */
  readonly secondTask?: boolean;
}

export interface BoundAttempt {
  readonly taskId: string;
  readonly receipt: TaskClaimReceipt;
  readonly invocationId: string;
  readonly inputSnapshot: PreparedExecutionInputGroup;
}

/** 已认领但尚未授权启动的 Attempt。 */
export interface ClaimedAttempt {
  readonly taskId: string;
  readonly receipt: TaskClaimReceipt;
  readonly inputSnapshot: PreparedExecutionInputGroup;
}

export interface BindingFixture {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly requirementArtifactId: string;
  readonly requirementContent: string;
  readonly workspace: VerifiedWorkWorkspace;
  readonly authority: ReturnType<typeof createWorkWorkspaceAuthority>;
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly publisher: ReturnType<typeof createArtifactPublisher>;
  readonly bindingService: ReturnType<typeof createExecutionInputBindingService>;
  /** 推进夹具时钟（毫秒）。 */
  advance(ms: number): void;
  /** 认领（不启动）。 */
  claimTask(taskId: string): ClaimedAttempt;
  /** beginLaunch 授权并返回完整绑定上下文。 */
  launch(claimed: ClaimedAttempt): BoundAttempt;
  /** 认领 + beginLaunch，返回真实回执与授权 invocationId。 */
  claimAndLaunch(taskId: string): BoundAttempt;
  /** 过期释放全部到期租约（真实写事务）。 */
  expireLeases(): number;
  /** 新建工作区资源访问端口（夹具时钟）。 */
  createResources(): ReturnType<typeof createSqliteWorkResourceAccess>;
  /** 构造绑定输入（可覆盖字段做负例）。 */
  bindingInput(bound: ClaimedAttempt | BoundAttempt, overrides?: Record<string, unknown>): Record<string, unknown>;
  /** 直接 SQL 读取（断言辅助）。 */
  query(sql: string, ...params: unknown[]): unknown;
  close(): void;
}

export async function openBindingFixture(options: BindingFixtureOptions = {}): Promise<BindingFixture> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p036-f002-' });
  let session: SqliteStorageSession | undefined;
  try {
    const harness = await box.openTransactionalHarness();
    session = harness.session;
    const activeSession = harness.session;
    const db = activeSession.database;
    let now = BINDING_NOW;
    const nowUtcMs = () => now;
    const advance = (ms: number): void => { now += ms; };

    const artifacts = createSqliteArtifactStore(session, { nowUtcMs });
    const files = createArtifactFileStore({ dataRoot: box.dataRoot });
    const publisher = createArtifactPublisher({
      artifacts, files, limits: { maxSizeBytes: 4_000_000, timeoutMs: 60_000 },
    });
    const verifier = createArtifactVerifier({
      artifacts, files, limits: { maxReadBytes: 4_000_000 }, nowMs: nowUtcMs,
    });
    const capabilityCatalog = createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
    ]);
    const views = createSqlitePlanAccess(session, { nowUtcMs });
    const preview = createExecutionPreviewService({
      views, inspector: createRepositoryInspector(), workspace: createBaselineWorkspaceReader(),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: nowUtcMs,
    });
    const commands = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog,
      executionPreview: preview,
      executionStart: createExecutionStartService({
        preview, permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: nowUtcMs,
      }),
      executionInputPrepare: createExecutionInputPrepareService({
        views,
        inputs: createExecutionInputService({
          artifacts, publisher, verifier,
          sources: createInputSourceFileReader({ roots: {} }),
          limits: {
            maxItems: 8, maxItemBytes: 1_000_000, maxTotalBytes: 4_000_000,
            captureTimeoutMs: 30_000, readTimeoutMs: 30_000,
          },
          nowMs: nowUtcMs,
        }),
        builder: createContextBuilder({ budget: DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET }),
        publisher, verifier,
        permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
        limits: { maxRequiredItems: 8 },
        nowMs: nowUtcMs,
      }),
      executionDispatchSignal: { signalRunDispatched: () => undefined },
      nowUtcMs,
    });

    const owner = createLocalOwnerPrincipal();
    const submit = async (
      operation: string,
      payload: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ): Promise<CommandReceipt> =>
      commands.submit(owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(now).toISOString(),
        operation, payload, ...extra,
      } as never);
    const requireCompleted = (receipt: CommandReceipt, label: string): Record<string, unknown> => {
      if (receipt.status !== 'completed' || receipt.result === null) {
        throw new Error(`夹具命令失败（${label}）: ${JSON.stringify(receipt)}`);
      }
      return receipt.result as Record<string, unknown>;
    };

    const registered = requireCompleted(
      await submit('project.register', {
        repositoryPath: box.repoDirA, displayName: 'Binding', description: null, labels: [],
      }, { scope: { kind: 'registration' } }),
      'project.register',
    );
    const projectId = (registered['project'] as { id: string }).id;
    const scope = { kind: 'project', projectId };
    requireCompleted(
      await submit('settings.global.create', {
        schemaVersion: 2, strategies: { defaultStrategy: { ...FAKE_STRATEGY } },
      }, { scope: { kind: 'global' } }),
      'settings.global.create',
    );
    requireCompleted(
      await submit('phase.create', { id: 'phase-1', title: '绑定阶段', description: null, labels: [] }, { scope }),
      'phase.create',
    );

    /* 真实需求制品（真实文件正文；Task 必需输入引用）。 */
    const requirementContent = '# 需求规格\n\n任务一必须阅读的验收依据正文（真实字节）。\n';
    const requirement = await publisher.publishArtifact({
      projectId,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: sha256(requirementContent),
      locator: 'requirements/task-1.md',
      content: [Buffer.from(requirementContent, 'utf8')],
    });
    const requirementArtifactId = requirement.artifact.id;
    let secondRequirementArtifactId: string | undefined;
    if (options.secondTask === true) {
      const second = await publisher.publishArtifact({
        projectId,
        kind: 'requirement',
        mediaType: 'text/markdown',
        expectedHash: sha256('任务二规格正文（不同内容，隔离证据）。'),
        locator: 'requirements/task-2.md',
        content: [Buffer.from('任务二规格正文（不同内容，隔离证据）。', 'utf8')],
      });
      secondRequirementArtifactId = second.artifact.id;
    }

    const tasks: Record<string, unknown>[] = [
      {
        id: 't-1', title: '绑定任务一', acceptance: { criteria: ['验收条目甲：必须完整可读', '验收条目乙：不得删项'] },
        requirementsRefs: [{ artifactId: requirementArtifactId }],
      },
    ];
    if (options.secondTask === true) {
      tasks.push({
        id: 't-2', title: '绑定任务二', acceptance: { criteria: ['任务二验收'] },
        requirementsRefs: [{ artifactId: secondRequirementArtifactId }],
      });
    }
    const imported = requireCompleted(
      await submit('feature.plan.import', {
        phaseId: 'phase-1',
        plan: {
          schemaVersion: 1,
          feature: { title: '绑定 Feature', description: null, labels: [], sourceRefs: [] },
          tasks,
        },
      }, { scope, expectedRevision: 1 }),
      'feature.plan.import',
    );
    const featureId = (imported['feature'] as { id: string }).id;
    const featureRow = db.prepare('SELECT plan_digest, revision FROM features WHERE id = ?').get(featureId) as {
      plan_digest: string; revision: number;
    };
    requireCompleted(
      await submit('feature.plan.decide', {
        featureId, planDigest: featureRow.plan_digest, decision: 'approve', reason: '绑定测试授权',
      }, { scope, expectedRevision: featureRow.revision }),
      'feature.plan.decide',
    );

    /* 真实准备：发布 snapshot/manifest/prompt 制品组。 */
    const prepareFor = async (taskId: string): Promise<PreparedExecutionInputGroup> => {
      const receipt = await submit('execution.input.prepare', {
        featureId, taskId,
        items: taskId === 't-1'
          ? [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: requirementArtifactId } }]
          : [{ purpose: 'spec', source: { kind: 'artifact', artifactId: secondRequirementArtifactId } }],
      }, { scope });
      const result = requireCompleted(receipt, 'execution.input.prepare');
      const group = result['group'] as PreparedExecutionInputGroup['group'];
      const requiredInputs = (result['requiredInputs'] as Record<string, unknown>[]).map((ref) => ({
        ...ref,
        projectId,
        kind: (db.prepare('SELECT kind FROM artifacts WHERE project_id = ? AND id = ?')
          .get(projectId, ref['artifactId']) as { kind: string }).kind,
      }));
      return {
        schemaVersion: result['schemaVersion'] as number,
        projectId,
        featureId,
        taskId,
        group,
        requiredInputs: requiredInputs as unknown as PreparedExecutionInputGroup['requiredInputs'],
        digests: result['digests'] as PreparedExecutionInputGroup['digests'],
        approval: result['approval'] as PreparedExecutionInputGroup['approval'],
        taskRevision: result['taskRevision'] as number,
        promptBytes: result['promptBytes'] as number,
        tokenEstimate: result['tokenEstimate'] as PreparedExecutionInputGroup['tokenEstimate'],
        preparedAtUtcMs: Date.parse(result['preparedAt'] as string),
      };
    };
    const prepared = new Map<string, PreparedExecutionInputGroup>();
    prepared.set('t-1', await prepareFor('t-1'));
    if (options.secondTask === true) {
      prepared.set('t-2', await prepareFor('t-2'));
    }

    /* 显式执行启动（真实 Batch/Run）。 */
    const previewResult = await preview.previewExecution(projectId, {
      featureIds: [featureId], budget: BINDING_BUDGET,
    });
    if (previewResult.status !== 'ready') {
      throw new Error(`夹具预览失败: ${JSON.stringify(previewResult)}`);
    }
    const started = await submit('execution.start', {
      featureIds: [featureId], budget: BINDING_BUDGET, previewDigest: previewResult.previewDigest,
    }, { scope });
    if (started.status !== 'accepted' || !('runId' in started)) {
      throw new Error(`夹具启动失败: ${JSON.stringify(started)}`);
    }
    const runId = started.runId;

    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.root] });
    const bindingRecord = createSqliteStateAccess(session).getRepositoryBinding(projectId);
    const workspace = await authority.verify(bindingRecord, box.repoDirA);
    const resources = () => createSqliteWorkResourceAccess(activeSession, { workspaceAuthority: authority, nowUtcMs });

    const claimTask = (taskId: string): ClaimedAttempt => {
      const inputSnapshot = prepared.get(taskId);
      if (inputSnapshot === undefined) throw new Error(`夹具缺少 ${taskId} 的准备输入`);
      const claimed = createSqliteTaskClaimStore(activeSession, { workspaceAuthority: authority, nowUtcMs })
        .claimTask({
          claimKey: `claim-${taskId}`, projectId, runId, taskId,
          owner: 'owner-1', hostInstanceId: 'host-1', expectedRevision: 1, executionVersion: 0,
          workspace, leaseUntilUtcMs: now + 600_000, inputSnapshot,
        });
      if (claimed.replayed) throw new Error('夹具认领被重放（非预期）');
      return { taskId, receipt: claimed.receipt, inputSnapshot };
    };
    const launch = (claimed: ClaimedAttempt): BoundAttempt => {
      const attempt = claimed.receipt.attempt;
      const launched = activeSession.transactWrite('Fixture.beginLaunch', () =>
        resources().beginLaunchInTransaction({
          projectId, attemptId: attempt.id, owner: attempt.owner,
          hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
        }));
      if (!launched.authorized || launched.invocationId === null) {
        throw new Error('夹具 beginLaunch 未授权');
      }
      return { ...claimed, invocationId: launched.invocationId };
    };
    const claimAndLaunch = (taskId: string): BoundAttempt => launch(claimTask(taskId));
    const expireLeases = (): number =>
      activeSession.transactWrite('Fixture.expireLeases', () => resources().expireInTransaction());

    const bindingInput = (bound: ClaimedAttempt | BoundAttempt, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      schemaVersion: 1,
      claim: JSON.parse(JSON.stringify(bound.receipt)) as unknown,
      workspace,
      sessionId: `session-${bound.taskId}-1`,
      invocationId: 'invocationId' in bound ? bound.invocationId : 'invocation-not-launched',
      strategy: { ...FAKE_STRATEGY },
      permissions: { grants: [], isolation: 'trusted_project' },
      limits: { timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 },
      recovery: { mode: 'new' },
      cwdRoot: 'workspace-root',
      ...overrides,
    });

    const recoveryCatalog: RuntimeRecoveryCatalog | undefined =
      options.recoveryDescriptors === undefined
        ? undefined
        : createStaticRuntimeRecoveryCatalog(options.recoveryDescriptors, capabilityCatalog);

    const bindingService = createExecutionInputBindingService({
      artifacts,
      verifier,
      attempts: createSqliteAttemptAccess(activeSession),
      resources: resources(),
      workspaceAuthority: authority,
      workspaceRoots: { 'workspace-root': box.root },
      publisher,
      ...(recoveryCatalog !== undefined ? { recoveryCatalog } : {}),
      ...(options.recoverySources === undefined ? {} : {
        recovery: createRuntimeRecoveryService({ configuration: capabilityCatalog, capabilities: recoveryCatalog,
          sources: options.recoverySources, artifacts, verifier }),
      }),
      ...(options.bindingLimits !== undefined ? { limits: options.bindingLimits } : {}),
      ...(options.bindingNowMs !== undefined ? { nowMs: options.bindingNowMs } : { nowMs: nowUtcMs }),
    });

    return {
      box, session: activeSession, projectId, featureId, runId,
      requirementArtifactId, requirementContent,
      workspace, authority, artifacts, verifier, publisher, bindingService,
      advance, claimTask, launch, claimAndLaunch, expireLeases, createResources: resources, bindingInput,
      query: (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as never[]),
      close() { session?.close(); box.cleanup(); },
    };
  } catch (error) {
    session?.close();
    box.cleanup();
    throw error;
  }
}

/** 发布同项目 ready 证据/归档制品（恢复来源测试用）。 */
export async function publishReadyArtifact(
  fixture: BindingFixture,
  input: { kind: string; locator: string; content: string },
): Promise<{ artifactId: string; contentHash: string; sizeBytes: number }> {
  const body = Buffer.from(input.content, 'utf8');
  const published = await fixture.publisher.publishArtifact({
    projectId: fixture.projectId,
    kind: input.kind,
    mediaType: 'application/json',
    expectedHash: sha256(body),
    locator: input.locator,
    content: [body],
  });
  return {
    artifactId: published.artifact.id,
    contentHash: sha256(body),
    sizeBytes: body.byteLength,
  };
}

export { join };
