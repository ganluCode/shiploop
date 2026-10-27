/**
 * P05-1 / F-012：规划命令/查询接入版本化 Host 协议与 HostClient。
 *
 * 验收面（真实临时 Host/SQLite/Git + 真实 HostClient + 脚本化 Runtime，无付费模型）：
 * - 规划启动（planning.start accepted v7 四重身份）、候选读取/列表
 *   （planning.contexts.list / planning.context.get / planning.candidate.get，
 *   候选正文经受管内容接口核验读取）、候选 approve/reject
 *   （planning.candidate.decide）与既有取消/resume 路径全部经真实 Host 路由与
 *   HostClient 公共方法往返；复用既有认证、项目授权、commandId 查询/重试与
 *   事件协议；
 * - accepted 返回的候选身份与 Run 可查询；客户端请求响应丢失后以原 commandId
 *   查回执恢复，不创建第二个规划；过期摘要/CAS/重复命令按 rejected/conflict
 *   明确返回；畸形/伪造响应一律协议错误，不默认成功或批准；
 * - 权限隔离：低能力/跨项目主体被拒；工具 token 调用管理路由 401；无规划
 *   操作的 grant 提交规划候选被拒；伪造 principal 字段被信封严格校验拒绝；
 * - 生产 startHost 组合根同样接线规划查询（planningQueryService 真实路由）；
 *   HTTP/SSE 连接断开不取消已接受的规划；规划事件 payload 只含有界
 *   身份/摘要，不含输入正文或凭据；
 * - HostClient 保持只依赖 shiploop-core/protocol（工程边界测试另行守护）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectToHost,
  createEventStreamHub,
  createHostLifecycleServer,
  createHostStopController,
  createHostWorkToolAccess,
  createIdleActivityGate,
  createWorkToolClient,
  CURRENT_HOST_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  HostProtocolError,
  isHostProtocolError,
  startHost,
  validateCommandReceiptWire,
  validateAppQueryResponse,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import type { HostWorkToolAccess } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createFakeRuntimeGate, createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { deriveFeatureWorktreeRelativeDir } from '../../../packages/core/src/ports/path-service.ts';
import { deriveManagedFeatureBranch } from '../../../packages/core/src/ports/workspace-preparation.ts';
import type { FakeRuntimeScriptStep } from '../../../packages/core/src/ports/fake-runtime-script.ts';
import type { CommandReceipt, PlanningAcceptedCommandReceipt } from '../../../packages/core/src/index.ts';
import { computeCommandRequestDigest, validateCommandEnvelope, createCompletedReceipt, createResultRef } from '../../../packages/core/src/index.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import type { CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { openStorageProbe } from '../../helpers/p02-2/storage-probe.ts';
import {
  createIsolatedHostEnvironment,
  loopbackRequest,
  publishLoopbackDiscovery,
} from '../../helpers/host/index.ts';
import type { IsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { git } from '../../helpers/git-repo.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error)).toBe(true);
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

async function rejectionOf(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

function asAcceptedPlanning(receipt: CommandReceipt): PlanningAcceptedCommandReceipt {
  expect(receipt.status).toBe('accepted');
  if (receipt.status !== 'accepted') throw new Error('expected accepted planning receipt');
  expect(receipt.schemaVersion).toBe(7);
  expect(receipt.operation).toBe('planning.start');
  return receipt as PlanningAcceptedCommandReceipt;
}

function asRejected(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'rejected' }> {
  expect(receipt.status).toBe('rejected');
  if (receipt.status !== 'rejected') throw new Error('expected rejected receipt');
  return receipt;
}

function asCompleted(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'completed' }> {
  expect(receipt.status, JSON.stringify(receipt)).toBe('completed');
  if (receipt.status !== 'completed') throw new Error('expected completed receipt');
  return receipt;
}

const TOOL_STRATEGY = { runtime: 'pi', provider: 'provider', model: 'model' } as const;
const FAKE_STRATEGY = { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } as const;
const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);

const HOST_SCRIPT_STEPS: readonly FakeRuntimeScriptStep[] = [
  { op: 'message', role: 'assistant', text: 'planning start' },
  { op: 'await_gate', name: 'submit' },
  { op: 'message', role: 'assistant', text: 'planning complete' },
];

interface PlanningRef {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
}

function planningStartInput(
  projectId: string,
  phaseId: string,
  featureId: string,
  expectedRevision: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId,
    phaseId,
    featureId,
    requirementRefs: [],
    constraints: ['不改变既有公开接口'],
    acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
    strategy: { approvalMode: 'manual', taskLimit: null },
    budget: {
      batch: {
        maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1,
        deadlineUtcMs: Date.now() + 3_600_000,
      },
      run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
    },
    expectedRevision,
    ...overrides,
  };
}

function candidateBody(ref: PlanningRef, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    projectId: ref.projectId,
    featureId: ref.featureId,
    runId: ref.runId,
    candidateId: ref.candidateId,
    plan: {
      schemaVersion: 1,
      feature: { title: '规划后的交付计划', description: null, labels: [], sourceRefs: [] },
      tasks: [
        { id: 't-1', title: '保留既有草稿任务', acceptance: { criteria: ['保留历史归属'] }, dependsOn: [] },
        { id: 'p-1', title: '实现规划接入', acceptance: { criteria: ['规划接入可成功收尾'] }, dependsOn: [] },
        { id: 'p-2', title: '回归规划重放', acceptance: { criteria: ['重复唤醒不重复执行'] }, dependsOn: ['p-1'] },
      ],
    },
    taskVerification: [
      { taskId: 'p-1', checkRefs: ['unit-core'], moduleRefs: ['core'], impactScope: ['packages/core'] },
    ],
    summary: '两个任务：实现与回归；单候选一次发布。',
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * 真实 Host 夹具（真实 Core + 脚本化 Runtime + 真实 HostClient）
 * ------------------------------------------------------------------ */

interface PlanningHostRig {
  readonly box: CommandsTestFixture;
  readonly core: CoreApplication;
  readonly session: SqliteStorageSession;
  readonly client: HostClient;
  readonly token: string;
  readonly port: number;
  readonly server: Server;
  readonly hub: ReturnType<typeof createEventStreamHub>;
  readonly gate: ReturnType<typeof createFakeRuntimeGate>;
  readonly workTools: HostWorkToolAccess;
  readonly environment: IsolatedHostEnvironment;
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T;
  seedWorkspace(projectId: string, featureId: string, runId: string): Promise<void>;
  setPlanningRef(ref: PlanningRef | null): void;
  waitRunStatusNot(runId: string, statuses: readonly string[]): Promise<string>;
  /** 在同一 Core/数据库上以指定主体再服务一个生命周期面（权限隔离测试）。 */
  serveSecondary(principal: ReturnType<CommandsTestFixture['restrictedPrincipal']>): Promise<HostClient>;
  close(): Promise<void>;
}

const rigs: PlanningHostRig[] = [];
const startedHosts: RunningHost[] = [];
const secondaryServers: { server: Server; environment: IsolatedHostEnvironment; client: HostClient }[] = [];
/** 最后执行的清理（丢弃代理/生产 Host 的临时环境与数据根在生产 Host 关闭之后）。 */
const lateCleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const host of startedHosts.splice(0)) {
    await host.close();
  }
  for (const secondary of secondaryServers.splice(0)) {
    try { secondary.client.close(); } catch { /* closed */ }
    await new Promise<void>((resolveClose) => {
      secondary.server.close(() => resolveClose());
      secondary.server.closeAllConnections();
    });
    await secondary.environment.dispose();
  }
  for (const cleanup of lateCleanup.splice(0)) {
    await cleanup();
  }
});

/** 宿主现场行（真实受管 feature worktree + host Attempt + managed_workspaces）。 */
async function seedManagedWorkspace(
  box: CommandsTestFixture,
  session: SqliteStorageSession,
  projectId: string,
  featureId: string,
  runId: string,
): Promise<void> {
  const now = Date.now();
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
  const inputBody = Buffer.from(JSON.stringify({ schemaVersion: 1, fixture: 'f012-host', attemptId: hostAttemptId }));
  const inputArtifact = await artifactPublisher.publishArtifact({
    projectId, kind: 'execution-input', mediaType: 'application/json',
    expectedHash: createHash('sha256').update(inputBody).digest('hex'),
    locator: `execution-inputs/f012-host-${hostAttemptId}`, content: [inputBody],
  });
  const gitCommonDir = binding.git_common_dir ?? resolve(box.repoDirA, git(['rev-parse', '--git-common-dir'], box.repoDirA).trim());
  const hostGroupRef = {
    artifactId: inputArtifact.artifact.id, version: inputArtifact.artifact.version,
    contentHash: inputArtifact.artifact.contentHash!, sizeBytes: inputArtifact.artifact.sizeBytes!,
    locator: inputArtifact.artifact.locator, mediaType: inputArtifact.artifact.mediaType,
  };
  const hostInputDigest = createHash('sha256').update(`fixture-${hostAttemptId}`).digest('hex');
  const phaseId = (session.database.prepare('SELECT phase_id FROM features WHERE id = ?').get(featureId) as { phase_id: string }).phase_id;
  const hostPlanningSnapshot = {
    schemaVersion: 1, purpose: 'planning', projectId, phaseId, featureId, runId,
    taskId: 't-1', candidateId: randomUUID(),
    group: { snapshot: hostGroupRef, manifest: hostGroupRef, prompt: hostGroupRef },
    requiredInputs: [],
    digests: { snapshotDigest: hostInputDigest, manifestDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64),
      strategyCopyDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64), codeBaselineDigest: 'e'.repeat(64) },
    preparedAtUtcMs: now,
  };
  session.transactWrite('f012.fixture.workspace', () => {
    session.database.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run('t-1');
    session.database.prepare(
      'INSERT INTO attempts (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, ' +
        "owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, input_digest, input_ref) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, 'f012-fixture-owner', 'f012-fixture-host', 1, ?, 'succeeded', 'preflight', ?, ?, ?)",
    ).run(hostAttemptId, now, projectId, now, featureId, runId, 't-1', now,
      JSON.stringify(hostPlanningSnapshot),
      hostInputDigest, inputArtifact.artifact.id);
    session.database.prepare('UPDATE attempts SET ended_at = ? WHERE id = ?').run(now, hostAttemptId);
    session.database.prepare(
      'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
        'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
        'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
        'host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ' +
        "?, ?, NULL, NULL, 'ready', ?, ?, ?, 1, ?, ?)",
    ).run(randomUUID(), now, projectId, now, featureId, binding.id, binding.binding_revision,
      binding.repo_identity, worktreePath, gitCommonDir, branch,
      git(['rev-parse', 'HEAD'], box.repoDirA).trim(),
      randomUUID(), 'f012-fixture-owner', 'f012-fixture-host', runId, hostAttemptId);
  });
}

async function openPlanningHostRig(options?: {
  readonly principal?: ReturnType<CommandsTestFixture['restrictedPrincipal']>;
  readonly prefix?: string;
}): Promise<PlanningHostRig> {
  const box = createCommandsTestFixture({ prefix: options?.prefix ?? 'shiploop-f012-host-' });
  const gate = createFakeRuntimeGate();
  let core: CoreApplication | undefined;
  let session: SqliteStorageSession | undefined;
  let environment: IsolatedHostEnvironment | undefined;
  try {
    core = await box.openApplication({
      capabilityCatalog: fakeCatalog(),
      workRuntimeFactory: createFakeWorkRuntimeFactory({
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        gates: { submit: gate },
        script: {
          schemaVersion: 1,
          steps: HOST_SCRIPT_STEPS,
          result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 12, usage: null },
        },
      }),
      nowUtcMs: undefined,
    });
    session = openSqliteStorageSession({ path: box.dbPath, busyTimeoutMs: 10_000, busyRetryAttempts: 5 });
    const owner = box.localOwner();
    let planningRef: PlanningRef | null = null;
    const channel = core.createWorkToolChannel({
      currentBinding: () => {
        if (planningRef === null) return null;
        const row = session!.database.prepare<[string], { id: string; invocation_id: string | null; execution_version: number; host_instance_id: string }>(
          'SELECT id, invocation_id, execution_version, host_instance_id FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        ).get(planningRef.planningTaskId);
        if (row === undefined || row.invocation_id === null) return null;
        return {
          principal: owner, projectId: planningRef.projectId, hostInstanceId: row.host_instance_id,
          identity: { purpose: 'work', runId: planningRef.runId, taskId: planningRef.planningTaskId, attemptId: row.id },
          invocationId: row.invocation_id, executionVersion: row.execution_version,
          nowUtcMs: Date.now(), strategy: { ...TOOL_STRATEGY },
        };
      },
      candidateContext: () => {
        throw new Error('coding candidate context unavailable in planning');
      },
    });
    const workTools = createHostWorkToolAccess(channel);
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-env-' });
    const root = environment.dataRoot();
    const credential = environment.mintHostCredential(root.canonicalRoot);
    let lifecycle = 'ready' as const;
    const stopController = createHostStopController({
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => lifecycle,
      setLifecycleState: () => {},
      prepareTeardown: () => Promise.resolve(),
      releaseAfterTeardown: () => Promise.resolve(),
    });
    const hub = createEventStreamHub({
      queryService: core.queryService,
      principal: owner,
      getLifecycleState: () => lifecycle,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 60_000,
    });
    const server = createHostLifecycleServer({
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      authToken: credential.token,
      getLifecycleState: () => lifecycle,
      getActivities: () => stopController.getActivities(),
      stop: stopController,
      application: {
        workTools,
        principal: options?.principal ?? owner,
        commandService: core.commandService,
        queryService: core.queryService,
        commandReceiptsService: core.commandReceiptsService,
        onboardingService: core.onboardingService,
        baselineQueryService: core.baselineQueryService,
        baselineExecutionService: core.baselineExecutionService,
        planningQueryService: core.planningQueryService,
        getLifecycleState: () => lifecycle,
        eventStreams: hub,
      },
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const port = (server.address() as { port: number }).port;
    publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });
    const client = await connectToHost({ canonicalRoot: root.canonicalRoot });
    const query = <T = Record<string, unknown>>(sql: string, ...params: unknown[]): T =>
      session!.database.prepare(sql).get(...params) as T;

    const serveSecondary = async (principal: ReturnType<CommandsTestFixture['restrictedPrincipal']>): Promise<HostClient> => {
      const secondaryEnvironment = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-sec-' });
      const secondaryRoot = secondaryEnvironment.dataRoot();
      const secondaryCredential = secondaryEnvironment.mintHostCredential(secondaryRoot.canonicalRoot);
      let secondaryLifecycle = 'ready' as const;
      const secondaryStop = createHostStopController({
        activityGate: createIdleActivityGate(),
        getLifecycleState: () => secondaryLifecycle,
        setLifecycleState: () => {},
        prepareTeardown: () => Promise.resolve(),
        releaseAfterTeardown: () => Promise.resolve(),
      });
      const secondaryServer = createHostLifecycleServer({
        hostInstanceId: secondaryCredential.hostInstanceId,
        dataRootIdentity: secondaryCredential.dataRootIdentity,
        startedAt: new Date().toISOString(),
        pid: process.pid,
        authToken: secondaryCredential.token,
        getLifecycleState: () => secondaryLifecycle,
        getActivities: () => secondaryStop.getActivities(),
        stop: secondaryStop,
        application: {
          principal,
          commandService: core!.commandService,
          queryService: core!.queryService,
          commandReceiptsService: core!.commandReceiptsService,
          onboardingService: core!.onboardingService,
          baselineQueryService: core!.baselineQueryService,
          baselineExecutionService: core!.baselineExecutionService,
          planningQueryService: core!.planningQueryService,
          getLifecycleState: () => secondaryLifecycle,
        },
      });
      await new Promise<void>((resolveListen) => {
        secondaryServer.listen(0, '127.0.0.1', () => resolveListen());
      });
      const secondaryPort = (secondaryServer.address() as { port: number }).port;
      publishLoopbackDiscovery({
        canonicalRoot: secondaryRoot.canonicalRoot,
        port: secondaryPort,
        hostInstanceId: secondaryCredential.hostInstanceId,
        store: secondaryCredential.store,
        token: secondaryCredential.token,
      });
      const secondaryClient = await connectToHost({ canonicalRoot: secondaryRoot.canonicalRoot });
      secondaryServers.push({ server: secondaryServer, environment: secondaryEnvironment, client: secondaryClient });
      return secondaryClient;
    };

    const rig: PlanningHostRig = {
      box, core, session, client, token: credential.token, port, server, hub, gate, workTools, environment,
      query,
      seedWorkspace: async (projectId, featureId, runId) => {
        await seedManagedWorkspace(box, session!, projectId, featureId, runId);
      },
      setPlanningRef: (ref) => {
        planningRef = ref;
      },
      async waitRunStatusNot(runId, statuses) {
        let last = 'unknown';
        await expect.poll(() => {
          const row = query<{ status: string }>('SELECT status FROM runs WHERE id = ?', runId);
          last = row?.status ?? 'missing';
          if (statuses.includes(last)) throw new Error(`run still ${last}`);
          return last;
        }, { timeout: 20_000 }).toBeTruthy();
        return last;
      },
      serveSecondary,
      async close() {
        try { client.close(); } catch { /* closed */ }
        try { await hub.closeAll(); } catch { /* closed */ }
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        });
        workTools.close();
        try { session!.close(); } catch { /* closed */ }
        try {
          await core!.workExecution.close();
        } catch { /* retained occupancy on failure paths keeps the host busy */ }
        try { core!.close(); } catch { /* work execution not cleanly closed */ }
        await environment!.dispose();
        box.cleanup();
      },
    };
    rigs.push(rig);
    return rig;
  } catch (error) {
    try { session?.close(); } catch { /* closed */ }
    try {
      if (core !== undefined) await core.workExecution.close();
    } catch { /* not closed cleanly */ }
    try { core?.close(); } catch { /* ignore */ }
    await environment?.dispose();
    box.cleanup();
    throw error;
  }
}

const configuredBoxes = new WeakSet<CommandsTestFixture>();

/** 经 HostClient 完成注册 → 全局策略 → Phase → 草稿 Feature 导入。 */
async function seedDraftFeature(
  client: HostClient,
  box: CommandsTestFixture,
  displayName: string,
  repositoryPath?: string,
  taskId = 't-1',
): Promise<{ projectId: string; phaseId: string; featureId: string; featureRevision: number }> {
  const registered = asCompleted(await client.submitCommand({
    operation: 'project.register',
    scope: { kind: 'registration' },
    payload: { repositoryPath: repositoryPath ?? box.repoDirA, displayName, description: null, labels: [] },
  }));
  const projectId = (registered.result as { project: { id: string } }).project.id;
  if (!configuredBoxes.has(box)) {
  asCompleted(await client.submitCommand({
    operation: 'settings.global.create',
    scope: { kind: 'global' },
    payload: {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: { ...FAKE_STRATEGY },
        purposeStrategies: { planner: { ...FAKE_STRATEGY } },
      },
    },
  }));
  configuredBoxes.add(box);
  }
  const phaseId = `phase-${randomUUID().slice(0, 8)}`;
  asCompleted(await client.createPhase({ projectId, id: phaseId, title: 'F-012 阶段', description: null, labels: [] }));
  const imported = asCompleted(await client.importFeaturePlan({
    projectId,
    phaseId,
    expectedRevision: 1,
    plan: {
      schemaVersion: 1,
      feature: { title: `${displayName} 草稿`, description: null, labels: [], sourceRefs: [] },
      tasks: [
        { id: taskId, title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] },
      ],
    },
  }));
  const feature = (imported.result as { feature: { id: string; revision: number } }).feature;
  return { projectId, phaseId, featureId: feature.id, featureRevision: feature.revision };
}

/** 等待最新 planning Attempt 进入 executing。 */
async function waitPlanningExecuting(rig: PlanningHostRig, planningTaskId: string): Promise<void> {
  await rig.core.workExecution.scan();
  await expect.poll(() => rig.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND status = 'executing'", planningTaskId,
  ).n, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
}

/** 经真实 Host 受限入口（/v1/work/tools）颁发规划提交工具客户端。 */
function issuePlanningSubmitTool(rig: PlanningHostRig, ref: PlanningRef, operations: readonly string[] = ['task.read', 'planning.candidate.submit']) {
  const row = rig.query<{ id: string; invocation_id: string; execution_version: number; host_instance_id: string }>(
    'SELECT id, invocation_id, execution_version, host_instance_id FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ref.planningTaskId,
  );
  const now = Date.now();
  const binding = {
    principal: rig.box.localOwner(), projectId: ref.projectId, hostInstanceId: row.host_instance_id,
    identity: { purpose: 'work' as const, runId: ref.runId, taskId: ref.planningTaskId, attemptId: row.id },
    invocationId: row.invocation_id, executionVersion: row.execution_version,
    nowUtcMs: now, strategy: { ...TOOL_STRATEGY },
  };
  const grant = rig.workTools.issue({
    schemaVersion: 1,
    context: {
      grantId: randomUUID(), principalId: binding.principal.principalId, projectId: ref.projectId,
      hostInstanceId: row.host_instance_id,
      identity: binding.identity,
      invocationId: row.invocation_id, executionVersion: row.execution_version,
      issuedAtUtcMs: now - 100, expiresAtUtcMs: now + 3_600_000,
      operations: [...operations],
    },
    runtime: 'pi', provider: 'provider', model: 'model',
    authentication: { kind: 'local_login', sourceRef: randomUUID(), pluginId: null, environmentRefs: [] },
    resources: [],
  }, binding);
  const client = createWorkToolClient({ port: rig.port, token: grant.token });
  const invoke = (body: string, commandId = randomUUID(), overrides: Record<string, unknown> = {}): Promise<unknown> =>
    client.invoke({
      schemaVersion: 5, commandId, issuedAt: new Date().toISOString(),
      operation: 'planning.candidate.submit',
      scope: { kind: 'project', projectId: ref.projectId },
      payload: {
        identity: binding.identity,
        invocationId: row.invocation_id,
        executionVersion: row.execution_version,
        candidate: body,
        ...overrides,
      },
    });
  return { invoke, token: grant.token, revoke: grant.revoke };
}

/* ------------------------------------------------------------------ *
 * A. 规划启动/查询纵向（真实 Host 路由 + HostClient）
 * ------------------------------------------------------------------ */

describe('P05-1 / F-012 规划 Host 协议与 HostClient 纵向', () => {
  it('[case:planning-start-receipt-and-queries] planning.start accepted v7 后候选身份与 Run 立即可查询', async () => {
    const rig = await openPlanningHostRig({ prefix: 'shiploop-f012-a1-' });
    const seed = await seedDraftFeature(rig.client, rig.box, 'F-012 A1');

    const input = planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision);
    const accepted = asAcceptedPlanning(await rig.client.startPlanning(input as never));
    expect(accepted.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.operationId).toBe(accepted.batchId);
    expect(accepted.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.planningTaskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.candidateId).toMatch(/^[0-9a-f-]{36}$/);

    // 详情：候选身份/Run/预算一致读视图；生成前候选明确 pending_generation。
    const detail = await rig.client.getPlanningContext(seed.projectId, accepted.candidateId);
    expect(detail.context.projectId).toBe(seed.projectId);
    expect(detail.context.featureId).toBe(seed.featureId);
    expect(detail.context.runId).toBe(accepted.runId);
    expect(detail.context.planningTaskId).toBe(accepted.planningTaskId);
    expect(detail.context.candidateId).toBe(accepted.candidateId);
    expect(detail.context.status).toBe('open');
    expect(detail.context.candidate.state).toBe('pending_generation');
    expect(['queued', 'running']).toContain(detail.executionState);
    expect(detail.outcomeAxes.runSucceeded).toBe(false);
    expect(detail.run.purpose).toBe('plan');
    expect(detail.budget.batch.id).toBe(accepted.batchId);
    for (const malformed of [
      { ...detail, executionState: 'unknown_terminal' },
      { ...detail, schemaVersion: undefined },
      { ...detail, run: { ...detail.run, id: randomUUID() } },
      { ...detail, context: { ...detail.context, planningTask: { ...detail.context.planningTask, status: 'pretend_passed' } } },
      { ...detail, outcomeAxes: { ...detail.outcomeAxes, notExecutableReasons: ['invented_reason'] } },
    ]) {
      expect(() => validateAppQueryResponse('planning.context.get', malformed)).toThrow(HostProtocolError);
    }

    // 列表：项目范围与 Feature 过滤。
    const listed = await rig.client.listPlanningContexts(seed.projectId);
    expect(listed.records.map((record) => record.candidateId)).toEqual([accepted.candidateId]);
    const filtered = await rig.client.listPlanningContexts(seed.projectId, { featureId: seed.featureId });
    expect(filtered.records).toHaveLength(1);
    const filteredOther = await rig.client.listPlanningContexts(seed.projectId, { featureId: randomUUID() });
    expect(filteredOther.records).toHaveLength(0);

    // 候选正文：生成前不伪造空候选。
    const candidate = await rig.client.getPlanningCandidate(seed.projectId, accepted.candidateId);
    expect(candidate.context.candidateId).toBe(accepted.candidateId);
    expect(candidate.candidate.state).toBe('pending_generation');

    // 不存在目标 → not_found。
    const mismatched = await rejectionOf(() => rig.client.getPlanningContext(seed.projectId, randomUUID()));
    expectProtocolError(mismatched, 'not_found');
    // 有合法结构的伪造详情仍须核对请求 candidateId，不能接受另一候选身份。
    const forgedHost = await openScriptedHost();
    scriptedHosts.push(forgedHost);
    forgedHost.respondWith(() => ({ kind: 'json', status: 200,
      body: { ...detail, context: { ...detail.context, candidateId: randomUUID() } } }));
    await expect(rejectionOf(() => forgedHost.client.getPlanningContext(seed.projectId, accepted.candidateId))).resolves.toMatchObject({ code: 'response_malformed' });
    for (const query of [
      `projectId=${seed.projectId}&principal=local-owner`,
      `projectId=${seed.projectId}&projectId=${seed.projectId}`,
      '',
    ]) {
      expect((await loopbackRequest({ port: rig.port, method: 'GET', path: `/v1/planning-contexts?${query}`, token: rig.token })).statusCode).toBe(400);
    }

    // 同 commandId 重放：复用原回执，不创建第二个规划。
    const replay = asAcceptedPlanning(await rig.client.startPlanning(
      input as never,
      { commandId: accepted.commandId, issuedAt: accepted.issuedAt },
    ));
    expect(replay.replayed).toBe(true);
    expect(replay.candidateId).toBe(accepted.candidateId);
    const probe = openStorageProbe(rig.box.dbPath);
    try {
      expect(probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM planning_contexts')?.n).toBe(1);
      expect(probe.selectOne<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE purpose = 'plan'")?.n).toBe(1);
    } finally {
      probe.close();
    }

    // 旧 CAS：过期 revision → rejected(conflict)，仍只有一个规划。
    const stale = asRejected(await rig.client.startPlanning(
      planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision + 99) as never,
    ));
    expect(stale.error.code).toBe('conflict');

    // 既有 pause/resume 对 queued planning Run 成功往返，保留同一候选与 Run。
    const beforePause = rig.query<{ revision: number }>('SELECT revision FROM runs WHERE id = ?', accepted.runId);
    asCompleted(await rig.client.pauseExecution({ projectId: seed.projectId, runId: accepted.runId, expectedRevision: beforePause.revision }));
    const beforeResume = rig.query<{ revision: number }>('SELECT revision FROM runs WHERE id = ?', accepted.runId);
    asCompleted(await rig.client.resumeExecution({ projectId: seed.projectId, runId: accepted.runId, expectedRevision: beforeResume.revision }));
    expect((await rig.client.getPlanningContext(seed.projectId, accepted.candidateId)).context.runId).toBe(accepted.runId);
  }, 60_000);

  it('[case:planning-sse-bounded-and-disconnect-keeps-run] 规划事件脱敏且连接断开不取消已接受的规划', async () => {
    const rig = await openPlanningHostRig({ prefix: 'shiploop-f012-a2-' });
    const seed = await seedDraftFeature(rig.client, rig.box, 'F-012 A2');
    const snapshot = await rig.client.getSnapshot({ kind: 'project', projectId: seed.projectId });
    const observed: { type: string; aggregateType: string; payload: unknown }[] = [];
    const subscription = await rig.client.subscribeEvents({
      scope: { kind: 'project', projectId: seed.projectId },
      cursor: snapshot.watermark.cursor,
      onEvent: (event) => {
        observed.push({ type: event.type, aggregateType: event.aggregate.type, payload: event.payload });
      },
    });
    try {
      const accepted = asAcceptedPlanning(await rig.client.startPlanning(
        planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision) as never,
      ));
      await rig.seedWorkspace(seed.projectId, seed.featureId, accepted.runId);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !observed.some((event) => event.type === 'execution.run.dispatched')) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const dispatched = observed.find((event) => event.type === 'execution.run.dispatched');
      expect(dispatched).toBeDefined();
      expect(dispatched?.aggregateType).toBe('run');
      // 事件 payload 只含有界身份/摘要：不含输入正文/凭据/预算数值。
      const serialized = JSON.stringify(observed);
      expect(serialized).not.toContain(rig.token);
      expect(serialized).not.toContain('不改变既有公开接口');
      expect(serialized).not.toContain(accepted.candidateId);

      // 断开订阅：只释放本地观察资源；已接受的规划不被取消。
      subscription.close();
      await subscription.ended;
      await waitPlanningExecuting(rig, accepted.planningTaskId);
      const afterDrop = await rig.client.getPlanningContext(seed.projectId, accepted.candidateId);
      expect(['queued', 'running']).toContain(afterDrop.executionState);
      expect(afterDrop.run.status).not.toBe('cancelled');

      // 收尾：释放门闩让 Run 自行终态（无候选 → failed，不是 cancelled）。
      rig.gate.release();
      const finalStatus = await rig.waitRunStatusNot(accepted.runId, ['queued', 'running']);
      expect(finalStatus).not.toBe('cancelled');
      const finalDetail = await rig.client.getPlanningContext(seed.projectId, accepted.candidateId);
      expect(finalDetail.run.status).not.toBe('cancelled');
    } finally {
      rig.gate.release();
      try { subscription.close(); await subscription.ended; } catch { /* already closed */ }
    }
  }, 90_000);

  it.each(['approve', 'reject'] as const)('[case:planning-candidate-body-and-decision-%s] 候选正文经受管内容接口读取；摘要/CAS 错误明确拒绝；人工决策生效', async (decisionMode) => {
    const rig = await openPlanningHostRig({ prefix: 'shiploop-f012-a3-' });
    const seed = await seedDraftFeature(rig.client, rig.box, 'F-012 A3');
    const accepted = asAcceptedPlanning(await rig.client.startPlanning(
      planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision) as never,
    ));
    const ref: PlanningRef = { ...seed, runId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId };
    rig.setPlanningRef(ref);
    await rig.seedWorkspace(seed.projectId, seed.featureId, accepted.runId);
    await waitPlanningExecuting(rig, ref.planningTaskId);

    // 受限工具经真实 Host /v1/work/tools 提交候选（planning Runner 通道）。
    const tool = issuePlanningSubmitTool(rig, ref);
    try {
      const published = asCompleted(await tool.invoke(candidateBody(ref)) as CommandReceipt);
      const digest = (published.result as { candidateDigest: string }).candidateDigest;
      expect(digest).toMatch(/^[0-9a-f]{64}$/);

      // 候选正文：planning.candidate.get 经受管 Artifact 完整性核验读取。
      const candidate = await rig.client.getPlanningCandidate(seed.projectId, ref.candidateId);
      expect(candidate.candidate.state).toBe('published');
      if (candidate.candidate.state !== 'published') throw new Error('unreachable');
      expect(candidate.candidate.candidateDigest).toBe(digest);
      expect(candidate.candidate.plan.tasks.map((task) => task.id)).toEqual(['p-1', 'p-2', 't-1']);
      expect(candidate.candidate.plan.taskCount).toBe(3);
      expect(candidate.candidate.taskVerification[0]?.checkRefs).toEqual(['unit-core']);
      for (const malformed of [
        { ...candidate, candidate: { ...candidate.candidate, candidateDigest: 'e'.repeat(64) } },
        { ...candidate, candidate: { ...candidate.candidate, artifact: { ...candidate.candidate.artifact, contentHash: 'f'.repeat(64) } } },
        { ...candidate, candidate: { ...candidate.candidate, state: 'pending_generation' } },
        { ...candidate, candidate: { ...candidate.candidate, taskVerification: undefined } },
        { ...candidate, candidate: { ...candidate.candidate, plan: { ...candidate.candidate.plan, taskCount: 99 } } },
      ]) {
        expect(() => validateAppQueryResponse('planning.candidate.get', malformed)).toThrow(HostProtocolError);
      }

      // 摘要上限按 Unicode 码点计算，不能把合法 emoji 摘要误判为超限。
      const summary = '🧪'.repeat(2000);
      expect(() => validateAppQueryResponse('planning.candidate.get', {
        ...candidate,
        context: { ...candidate.context, candidate: { ...candidate.context.candidate, summary } },
        candidate: { ...candidate.candidate, summary },
      })).not.toThrow();

      // 过期摘要：错误 candidateDigest → rejected(conflict)。
      const wrongDigest = await rejectionOf(() => rig.client.decidePlanningCandidate({
        projectId: seed.projectId, candidateId: ref.candidateId,
        candidateDigest: 'f'.repeat(64), decision: 'approve', reason: null,
        expectedRevision: seed.featureRevision,
      }));
      expectProtocolError(wrongDigest, 'conflict');

      // 过期 CAS：revision 漂移 → rejected(conflict)。
      const staleRevision = asRejected(await rig.client.decidePlanningCandidate({
        projectId: seed.projectId, candidateId: ref.candidateId,
        candidateDigest: digest, decision: 'approve', reason: null,
        expectedRevision: seed.featureRevision + 5,
      }));
      expect(staleRevision.error.code).toBe('conflict');

      // 批准前必须 Run 已成功：运行中批准 → 结构化拒绝。
      const early = asRejected(await rig.client.decidePlanningCandidate({
        projectId: seed.projectId, candidateId: ref.candidateId,
        candidateDigest: digest, decision: 'approve', reason: null,
        expectedRevision: seed.featureRevision,
      }));
      expect(JSON.stringify(early.error.details)).toMatch(/planning_run_not_succeeded|run_not_succeeded/);

      // 释放门闩 → Run 成功收尾（有效候选 + 正常终态）。
      rig.gate.release();
      await rig.waitRunStatusNot(ref.runId, ['queued', 'running']);
      await expect.poll(() => rig.query<{ status: string }>('SELECT status FROM execution_batches WHERE id = ?', accepted.batchId).status,
        { timeout: 15_000 }).toBe('succeeded');
      const settledBatch = rig.query('SELECT revision, status FROM execution_batches WHERE id = ?', accepted.batchId);
      await rig.core.workExecution.scan();
      expect(rig.query('SELECT revision, status FROM execution_batches WHERE id = ?', accepted.batchId)).toEqual(settledBatch);

      if (decisionMode === 'reject') {
        const rejected = asCompleted(await rig.client.decidePlanningCandidate({
          projectId: seed.projectId, candidateId: ref.candidateId, candidateDigest: digest,
          decision: 'reject', reason: '需求需要重新核对', expectedRevision: seed.featureRevision,
        }));
        expect(rejected.result).toMatchObject({ applied: false, decision: 'reject' });
        const rejectedContext = await rig.client.getPlanningContext(seed.projectId, ref.candidateId);
        expect(rejectedContext.context.status).toBe('rejected');
        expect(rejectedContext.run.status).toBe('succeeded');
        expect((await rig.client.getPlanningCandidate(seed.projectId, ref.candidateId)).candidate.state).toBe('published');
        return;
      }
      const decision = asCompleted(await rig.client.decidePlanningCandidate({
        projectId: seed.projectId, candidateId: ref.candidateId,
        candidateDigest: digest, decision: 'approve', reason: null,
        expectedRevision: seed.featureRevision,
      }));
      expect(decision.result).toMatchObject({ decision: 'approve', candidateId: ref.candidateId });

      const applied = await rig.client.getPlanningContext(seed.projectId, ref.candidateId);
      expect(applied.context.status).toBe('applied');
      expect(applied.executionState).toBe('applied');
      expect(applied.outcomeAxes.planApproved).toBe(true);
      expect(applied.outcomeAxes.runSucceeded).toBe(true);
      expect(applied.context.decision?.decision).toBe('approved');

      // Feature 侧：计划批准；业务 Task 列表含 p-1/p-2/t-1（planning Task 不入业务列表）。
      const feature = await rig.client.getFeature(seed.featureId);
      expect(feature.feature.planStatus).toBe('approved');
      const tasks = await rig.client.listTasks(seed.projectId, seed.featureId, { limit: 50 });
      expect(tasks.records.map((task) => task.id).sort()).toEqual(['p-1', 'p-2', 't-1']);

      // 旧计划命令兼容：另一草稿 Feature 仍走既有 feature.plan.decide 审批。
      const legacySeed = await seedDraftFeature(rig.client, rig.box, 'F-012 A3 legacy', rig.box.repoDirB, 'l-1');
      const legacyFeature = (await rig.client.getFeature(legacySeed.featureId)).feature;
      const legacyDecided = asCompleted(await rig.client.decideFeaturePlan({
        projectId: legacySeed.projectId,
        featureId: legacyFeature.id,
        planDigest: legacyFeature.planDigest!,
        decision: 'approve',
        reason: null,
        expectedRevision: legacyFeature.revision,
      }));
      expect(legacyDecided.result).toBeTruthy();
      const legacyAfter = await rig.client.getFeature(legacyFeature.id);
      expect(legacyAfter.feature.planStatus).toBe('approved');
    } finally {
      rig.gate.release();
      tool.revoke();
    }
  }, 120_000);

  it('[case:planning-cancel-resume-host-paths] 既有取消/resume 命令面覆盖 planning Run 并保持终态纪律', async () => {
    const rig = await openPlanningHostRig({ prefix: 'shiploop-f012-a4-' });
    const seed = await seedDraftFeature(rig.client, rig.box, 'F-012 A4');
    const accepted = asAcceptedPlanning(await rig.client.startPlanning(
      planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision) as never,
    ));
    await rig.seedWorkspace(seed.projectId, seed.featureId, accepted.runId);
    await waitPlanningExecuting(rig, accepted.planningTaskId);

    const runRow = rig.query<{ revision: number }>('SELECT revision FROM runs WHERE id = ?', accepted.runId);
    const cancelled = asCompleted(await rig.client.cancelExecution({
      projectId: seed.projectId, runId: accepted.runId, expectedRevision: runRow.revision,
    }));
    expect(cancelled.status).toBe('completed');

    const finalStatus = await rig.waitRunStatusNot(accepted.runId, ['queued', 'running', 'cancelling']);
    expect(finalStatus).toBe('cancelled');
    const detail = await rig.client.getPlanningContext(seed.projectId, accepted.candidateId);
    expect(detail.executionState).toBe('cancelled');
    expect(detail.run.status).toBe('cancelled');

    // 终态 Run 不可 resume：显式恢复对已取消目标明确拒绝（用当前 revision，
    // 排除 CAS 原因，验证的是终态纪律）。
    const revisionAfterCancel = rig.query<{ revision: number }>('SELECT revision FROM runs WHERE id = ?', accepted.runId).revision;
    const revived = asRejected(await rig.client.resumeExecution({
      projectId: seed.projectId, runId: accepted.runId, expectedRevision: revisionAfterCancel,
    }));
    expect(revived.error.code).toBe('conflict');
  }, 90_000);
});

/* ------------------------------------------------------------------ *
 * B. 权限与凭据隔离（人工面 vs 受限工具面）
 * ------------------------------------------------------------------ */

describe('P05-1 / F-012 规划 Host 权限与凭据隔离', () => {
  it('[case:planning-host-authorization] 低能力/跨项目/伪造主体/工具 token 越权全部拒绝', async () => {
    const rig = await openPlanningHostRig({ prefix: 'shiploop-f012-b1-' });
    const seed = await seedDraftFeature(rig.client, rig.box, 'F-012 B1');
    const accepted = asAcceptedPlanning(await rig.client.startPlanning(
      planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision) as never,
    ));

    // 低能力主体（同一 Core 上的另一生命周期服务器 + 受限 principal，仅测试装配）。
    const noRead = rig.box.restrictedPrincipal({ capabilities: ['events.read'], projectScope: rig.box.scopeAllowlist([seed.projectId]) });
    const secondary = await rig.serveSecondary(noRead);
    await expect(rejectionOf(() => secondary.listPlanningContexts(seed.projectId))).resolves
      .toMatchObject({ code: 'forbidden' });
    await expect(rejectionOf(() => secondary.getPlanningContext(seed.projectId, accepted.candidateId))).resolves
      .toMatchObject({ code: 'forbidden' });
    await expect(rejectionOf(() => secondary.getPlanningCandidate(seed.projectId, accepted.candidateId))).resolves
      .toMatchObject({ code: 'forbidden' });
    await expect(rejectionOf(() => secondary.startPlanning(
      planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision) as never,
    ))).resolves.toMatchObject({ code: 'forbidden' });
    await expect(rejectionOf(() => secondary.decidePlanningCandidate({
      projectId: seed.projectId, candidateId: accepted.candidateId, candidateDigest: 'a'.repeat(64),
      decision: 'approve', expectedRevision: seed.featureRevision,
    }))).resolves.toMatchObject({ code: 'forbidden' });

    // 跨项目：可见项目内主体读取不可见项目的候选 → 统一 not_found（不区分存在性）。
    const projectBSeed = await seedDraftFeature(rig.client, rig.box, 'F-012 B1 项目B', rig.box.repoDirB, 'b-1');
    const acceptedB = asAcceptedPlanning(await rig.client.startPlanning(
      planningStartInput(projectBSeed.projectId, projectBSeed.phaseId, projectBSeed.featureId, projectBSeed.featureRevision) as never,
    ));
    const scopedPrincipal = rig.box.restrictedPrincipal({ capabilities: ['project.read'], projectScope: rig.box.scopeAllowlist([seed.projectId]) });
    const scoped = await rig.serveSecondary(scopedPrincipal);
    const hidden = await rejectionOf(() => scoped.getPlanningContext(projectBSeed.projectId, acceptedB.candidateId));
    expectProtocolError(hidden, 'not_found');
    const missing = await rejectionOf(() => scoped.getPlanningContext(projectBSeed.projectId, randomUUID()));
    expectProtocolError(missing, 'not_found');
    expect(JSON.stringify((hidden as HostProtocolError).details)).toBe(JSON.stringify((missing as HostProtocolError).details));
    await expect(rejectionOf(() => scoped.listPlanningContexts(projectBSeed.projectId))).resolves
      .toMatchObject({ code: 'forbidden' });
    await expect(scoped.listPlanningContexts(seed.projectId)).resolves
      .toMatchObject({ records: [{ candidateId: accepted.candidateId }] });

    // 工具 token 调用管理路由：401（不落入任何业务判定）。
    const ref: PlanningRef = { ...seed, runId: accepted.runId, planningTaskId: accepted.planningTaskId, candidateId: accepted.candidateId };
    rig.setPlanningRef(ref);
    await rig.seedWorkspace(seed.projectId, seed.featureId, accepted.runId);
    await waitPlanningExecuting(rig, accepted.planningTaskId);
    const tool = issuePlanningSubmitTool(rig, ref);
    try {
      const commandAttempt = await loopbackRequest({
        port: rig.port, method: 'POST', path: '/v1/commands', token: tool.token,
        body: { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
          operation: 'execution.cancel', scope: { kind: 'project', projectId: seed.projectId },
          expectedRevision: 1, payload: { runId: accepted.runId } },
      });
      expect(commandAttempt.statusCode).toBe(401);
      const queryAttempt = await loopbackRequest({
        port: rig.port, method: 'GET',
        path: `/v1/planning-contexts?projectId=${encodeURIComponent(seed.projectId)}`,
        token: tool.token,
      });
      expect(queryAttempt.statusCode).toBe(401);
      // owner token 不在受限入口生效。
      const toolAttempt = await loopbackRequest({
        port: rig.port, method: 'POST', path: '/v1/work/tools', token: rig.token, body: {},
      });
      expect(toolAttempt.statusCode).toBe(401);

      // planning Task 不属于 coding DAG，coding grant 在可信颁发时即拒绝。
      expect(() => issuePlanningSubmitTool(rig, ref, ['task.read'])).toThrow();
      // 已签发的规划 grant 也不能换 Attempt、执行版本或跨项目 Run。
      for (const overrides of [
        { executionVersion: -1 },
        { identity: { purpose: 'work', runId: ref.runId, taskId: ref.planningTaskId, attemptId: randomUUID() } },
        { identity: { purpose: 'work', runId: acceptedB.runId, taskId: acceptedB.planningTaskId, attemptId: randomUUID() } },
      ]) {
        const denied = await rejectionOf(() => tool.invoke(candidateBody(ref), randomUUID(), overrides));
        expect(['forbidden', 'invalid_input']).toContain((denied as HostProtocolError).code);
      }

      // 伪造 principal：信封携带未知键 → 结构校验 400。
      const forged = await loopbackRequest({
        port: rig.port, method: 'POST', path: '/v1/commands', token: rig.token,
        body: {
          schemaVersion: 5,
          commandId: randomUUID(),
          operation: 'planning.start',
          scope: { kind: 'project', projectId: seed.projectId },
          expectedRevision: seed.featureRevision,
          issuedAt: new Date().toISOString(),
          payload: planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision, { expectedRevision: undefined }),
          principal: 'forged-owner',
        },
      });
      expect(forged.statusCode).toBe(400);
      expect((forged.json() as { error: { code: string } }).error.code).toBe('invalid_input');
    } finally {
      rig.gate.release();
      tool.revoke();
    }
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * C. 响应丢失恢复与生产 startHost 组合根
 * ------------------------------------------------------------------ */

describe('P05-1 / F-012 响应丢失恢复与生产组合根', () => {
  it('[case:planning-response-loss-recovery] 响应丢失后以原 commandId 查回执恢复，不创建第二个规划', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-f012-c1-' });
    const gate = createFakeRuntimeGate();
    const host = await startHost({
      dataRoot: box.dataRoot,
      capabilityCatalog: fakeCatalog(),
      workRuntimeFactory: createFakeWorkRuntimeFactory({
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        gates: { submit: gate },
        script: {
          schemaVersion: 1,
          steps: HOST_SCRIPT_STEPS,
          result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 12, usage: null },
        },
      }),
      env: {},
    });
    startedHosts.push(host);
    const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-c1-env-' });
    let droppedRequests = 0;
    let dropPlanning = false;
    const proxy: Server = createServer((incoming, outgoing) => {
        const dropThis = dropPlanning && incoming.method === 'POST' && (incoming.url ?? '').split('?')[0] === '/v1/commands' && droppedRequests < 1;
        const upstream = httpRequest(
          {
            host: '127.0.0.1', port: host.port, method: incoming.method, path: incoming.url,
            headers: { ...incoming.headers, host: `127.0.0.1:${host.port}` },
          },
          (upstreamResponse) => {
            if (outgoing.destroyed) {
              upstreamResponse.resume();
              return;
            }
            outgoing.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
            upstreamResponse.pipe(outgoing);
          },
        );
        upstream.on('error', () => {
          outgoing.destroy();
        });
        if (dropThis) {
          droppedRequests += 1;
          upstream.on('finish', () => {
            outgoing.destroy();
          });
        }
        incoming.pipe(upstream);
      });
      lateCleanup.push(async () => {
        await new Promise<void>((resolveClose) => {
          proxy.close(() => resolveClose());
          proxy.closeAllConnections();
        });
        await environment.dispose();
        box.cleanup();
      });
      await new Promise<void>((resolveListen) => {
        proxy.listen(0, '127.0.0.1', () => resolveListen());
      });
      try {
      const proxyPort = (proxy.address() as { port: number }).port;
      publishLoopbackDiscovery({
        canonicalRoot: box.dataRoot, port: proxyPort,
        hostInstanceId: host.hostInstanceId,
      });
      const client = await connectToHost({ canonicalRoot: box.dataRoot });
      try {
        const seed = await seedDraftFeature(client, box, 'F-012 C1');
        dropPlanning = true;
        const input = planningStartInput(seed.projectId, seed.phaseId, seed.featureId, seed.featureRevision);
        const recovered = asAcceptedPlanning(await client.startPlanning(input as never));
        expect(droppedRequests).toBeGreaterThanOrEqual(1);
        expect(recovered.schemaVersion).toBe(7);
        expect(recovered.operationId).toBe(recovered.batchId);

        // 恢复后不重开新规划：同一 commandId 重放仍指向原身份。
        const replay = asAcceptedPlanning(await client.startPlanning(
          input as never,
          { commandId: recovered.commandId, issuedAt: recovered.issuedAt },
        ));
        expect(replay.replayed).toBe(true);
        expect(replay.candidateId).toBe(recovered.candidateId);

        const probe = openStorageProbe(box.dbPath);
        try {
          expect(probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM planning_contexts')?.n).toBe(1);
          expect(probe.selectOne<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE purpose = 'plan'")?.n).toBe(1);
        } finally {
          probe.close();
        }

        // 生产 startHost 组合根：规划查询经真实 Host 路由可达（连接丢失不影响事实）。
        const detail = await client.getPlanningContext(seed.projectId, recovered.candidateId);
        expect(detail.context.candidateId).toBe(recovered.candidateId);
        expect(detail.run.status).not.toBe('cancelled');
        const candidate = await client.getPlanningCandidate(seed.projectId, recovered.candidateId);
        expect(candidate.candidate.state).toBe('pending_generation');

        // 缺少基线时 queued 是可查询阻塞；观察断开不隐式取消，显式取消才收尾。
        const probeControl = openStorageProbe(box.dbPath);
        let revision: number;
        try {
          revision = probeControl.selectOne<{ revision: number }>('SELECT revision FROM runs WHERE id = ?', [recovered.runId])!.revision;
        } finally { probeControl.close(); }
        asCompleted(await client.cancelExecution({ projectId: seed.projectId, runId: recovered.runId, expectedRevision: revision }));
        await expect.poll(async () => (await client.getPlanningContext(seed.projectId, recovered.candidateId)).run.status,
          { timeout: 15_000 }).toBe('cancelled');
      } finally {
        client.close();
      }
    } finally {
      gate.release();
    }
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * D. 畸形/伪造响应 → 协议错误（可编排对端，不默认成功或批准）
 * ------------------------------------------------------------------ */

type ScriptedResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'drop' };

interface ScriptedHost {
  readonly client: HostClient;
  readonly server: Server;
  readonly environment: IsolatedHostEnvironment;
  respondWith(responder: (method: string, path: string, body: unknown) => ScriptedResponse | undefined): void;
  close(): Promise<void>;
}

async function openScriptedHost(): Promise<ScriptedHost> {
  const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-d-env-' });
  const root = environment.dataRoot();
  const credential = environment.mintHostCredential(root.canonicalRoot);
  let responder: ((method: string, path: string, body: unknown) => ScriptedResponse | undefined) | undefined;
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw.length === 0 ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const url = incoming.url ?? '/';
      const path = url.split('?')[0] ?? '/';
      if (path === HANDSHAKE_ROUTE) {
        const text = JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          hostInstanceId: credential.hostInstanceId,
          dataRootIdentity: credential.dataRootIdentity,
          lifecycleState: 'ready',
          startedAt: new Date().toISOString(),
          capabilities: CURRENT_HOST_CAPABILITIES,
        });
        outgoing.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        outgoing.end(text);
        return;
      }
      const scripted = responder?.(incoming.method ?? 'GET', url, body);
      if (scripted === undefined || scripted.kind === 'drop') {
        outgoing.destroy();
        return;
      }
      const text = JSON.stringify(scripted.body);
      outgoing.writeHead(scripted.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      });
      outgoing.end(text);
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as { port: number }).port;
  publishLoopbackDiscovery({
    canonicalRoot: root.canonicalRoot, port,
    hostInstanceId: credential.hostInstanceId, store: credential.store, token: credential.token,
  });
  const client = await connectToHost({ canonicalRoot: root.canonicalRoot });
  return {
    client, server, environment,
    respondWith(next) {
      responder = next;
    },
    async close() {
      try { client.close(); } catch { /* closed */ }
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
      await environment.dispose();
    },
  };
}

const scriptedHosts: ScriptedHost[] = [];
afterEach(async () => {
  for (const host of scriptedHosts.splice(0)) {
    await host.close();
  }
});

function fakeV7Receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const batchId = randomUUID();
  return {
    schemaVersion: 7,
    commandId: randomUUID(),
    principalId: 'scripted-principal',
    operation: 'planning.start',
    scope: { kind: 'project', projectId: randomUUID() },
    requestDigest: 'a'.repeat(64),
    issuedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    replayed: false,
    status: 'accepted',
    operationId: batchId,
    batchId,
    runId: randomUUID(),
    planningTaskId: randomUUID(),
    candidateId: randomUUID(),
    ...overrides,
  };
}

describe('P05-1 / F-012 规划客户端协议错误（畸形/伪造响应不默认成功或批准）', () => {
  it('[case:planning-client-strict-inputs] 嵌套未知字段、非法分页与伪造权限零网络拒绝', async () => {
    const host = await openScriptedHost();
    scriptedHosts.push(host);
    let calls = 0;
    host.respondWith(() => { calls += 1; return { kind: 'drop' }; });
    const input = planningStartInput(randomUUID(), 'phase-1', 'feature-1', 1);
    for (const bad of [
      { ...input, principal: 'owner' },
      { ...input, acceptance: { criteria: ['a'], approved: true } },
      { ...input, strategy: { approvalMode: 'manual', taskLimit: null, autoApprove: true } },
      { ...input, constraints: [''] },
      { ...input, strategy: { approvalMode: 'auto', taskLimit: null } },
    ]) {
      await expect(rejectionOf(() => host.client.startPlanning(bad as never))).resolves.toMatchObject({ code: 'invalid_input' });
    }
    await expect(rejectionOf(() => host.client.listPlanningContexts(input.projectId as string, { limit: 201 }))).resolves.toMatchObject({ code: 'invalid_input' });
    expect(calls).toBe(0);
  });

  it('[case:planning-forged-decisions] 完成回执不能伪造批准或拒绝结果', async () => {
    const host = await openScriptedHost();
    scriptedHosts.push(host);
    const projectId = randomUUID(), candidateId = randomUUID(), candidateDigest = 'a'.repeat(64);
    for (const result of [
      {},
      { decision: 'approve', candidateId, candidateDigest },
      { decision: 'reject', candidateId: randomUUID(), candidateDigest, applied: false, summary: '', planningContextStatus: 'rejected' },
      { decision: 'reject', candidateId, candidateDigest, applied: true, summary: '', planningContextStatus: 'rejected' },
    ]) {
      host.respondWith((_method, _path, body) => {
        const envelope = validateCommandEnvelope(body);
        return { kind: 'json', status: 200, body: createCompletedReceipt({
          commandId: envelope.commandId, principalId: 'scripted-principal', operation: envelope.operation,
          scope: envelope.scope, requestDigest: computeCommandRequestDigest(envelope),
          issuedAt: envelope.issuedAt, completedAt: new Date().toISOString(),
          resultRef: createResultRef(new Uint8Array(32).fill(1)), result,
        }) };
      });
      await expect(rejectionOf(() => host.client.decidePlanningCandidate({
        projectId, candidateId, candidateDigest, decision: 'reject', expectedRevision: 1,
      }))).resolves.toMatchObject({ code: 'response_malformed' });
    }
  });

  it('[case:planning-malformed-query-responses] 规划查询畸形/未知版本响应 → 协议错误', async () => {
    const host = await openScriptedHost();
    scriptedHosts.push(host);
    const projectId = 'proj-f012';
    host.respondWith(() => ({
      kind: 'json', status: 200,
      body: { schemaVersion: 5, scope: 'planning-context-list', records: [{ broken: true }], nextCursor: null, limit: 20 },
    }));
    await expect(rejectionOf(() => host.client.listPlanningContexts(projectId))).resolves
      .toMatchObject({ code: 'response_malformed' });

    host.respondWith(() => ({
      kind: 'json', status: 200,
      body: { schemaVersion: 99, scope: 'planning-context-list', records: [], nextCursor: null, limit: 20 },
    }));
    await expect(rejectionOf(() => host.client.listPlanningContexts(projectId))).resolves
      .toMatchObject({ code: 'unsupported_schema_version' });

    host.respondWith(() => ({
      kind: 'json', status: 200,
      body: { schemaVersion: 5, scope: 'wrong-scope', context: {}, executionState: 'queued', outcomeAxes: {}, run: {}, attempts: [], attemptsTruncated: false, budget: {} },
    }));
    await expect(rejectionOf(() => host.client.getPlanningContext(projectId, randomUUID()))).resolves
      .toMatchObject({ code: 'response_malformed' });

    // 伪造 published 候选：字段缺失/形状漂移 → 协议错误，不当成已发布。
    host.respondWith(() => ({
      kind: 'json', status: 200,
      body: {
        schemaVersion: 5, scope: 'planning-candidate',
        context: { candidateId: 'c' }, runStatus: 'succeeded',
        candidate: { state: 'published', artifact: { artifactId: 'x' } },
      },
    }));
    await expect(rejectionOf(() => host.client.getPlanningCandidate(projectId, randomUUID()))).resolves
      .toMatchObject({ code: 'response_malformed' });
  });

  it('[case:planning-forged-receipts] 伪造 v7 回执（缺失身份/operationId 漂移/错误身份）→ 协议错误', async () => {
    const host = await openScriptedHost();
    scriptedHosts.push(host);
    const inputBase = {
      projectId: randomUUID(),
      phaseId: 'phase-1',
      featureId: 'feat-1',
      requirementRefs: [],
      constraints: ['c'],
      acceptance: { criteria: ['a'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { batch: {}, run: {} },
      expectedRevision: 1,
    };

    // 缺失 planningTaskId/candidateId → response_malformed。
    const missing = fakeV7Receipt();
    delete (missing as Record<string, unknown>).planningTaskId;
    delete (missing as Record<string, unknown>).candidateId;
    host.respondWith(() => ({ kind: 'json', status: 202, body: missing }));
    await expect(rejectionOf(() => host.client.startPlanning(inputBase as never))).resolves
      .toMatchObject({ code: 'response_malformed' });

    // operationId ≠ batchId → response_malformed（回执关联身份必须一致）。
    host.respondWith(() => ({ kind: 'json', status: 202, body: fakeV7Receipt({ operationId: randomUUID() }) }));
    await expect(rejectionOf(() => host.client.startPlanning(inputBase as never))).resolves
      .toMatchObject({ code: 'response_malformed' });

    // 与冻结信封不匹配的 commandId/operation → response_malformed。
    host.respondWith(() => ({ kind: 'json', status: 202, body: fakeV7Receipt() }));
    await expect(rejectionOf(() => host.client.startPlanning(inputBase as never))).resolves
      .toMatchObject({ code: 'response_malformed' });

    // 显式 commandId + 回显摘要：摘要漂移 → response_malformed。
    const commandId = randomUUID();
    const issuedAt = new Date().toISOString();
    host.respondWith(() => ({ kind: 'json', status: 202, body: fakeV7Receipt({ commandId, requestDigest: 'b'.repeat(64) }) }));
    await expect(rejectionOf(() => host.client.startPlanning(inputBase as never, { commandId, issuedAt }))).resolves
      .toMatchObject({ code: 'response_malformed' });

    // 未支持版本（v8）→ unsupported_schema_version。
    host.respondWith(() => ({ kind: 'json', status: 202, body: fakeV7Receipt({ schemaVersion: 8 }) }));
    await expect(rejectionOf(() => host.client.startPlanning(inputBase as never))).resolves
      .toMatchObject({ code: 'unsupported_schema_version' });

    // planning.start 只允许 accepted v7；伪造 completed v5 不能表示启动成功。
    host.respondWith((_method, _path, body) => {
      const envelope = validateCommandEnvelope(body);
      return { kind: 'json', status: 200, body: createCompletedReceipt({
        commandId: envelope.commandId, principalId: 'scripted-principal', operation: envelope.operation,
        scope: envelope.scope, requestDigest: computeCommandRequestDigest(envelope),
        issuedAt: envelope.issuedAt, completedAt: new Date().toISOString(),
        resultRef: createResultRef(new Uint8Array(32).fill(2)), result: {},
      }) };
    });
    await expect(rejectionOf(() => host.client.startPlanning(inputBase as never))).resolves.toMatchObject({ code: 'response_malformed' });

    // 结构合法且身份一致的 v7 回执可被线校验器接受（正面对照：服务端回显
    // 冻结信封的 commandId 与按同一算法重算的 requestDigest）。
    host.respondWith((_method, _path, body) => ({
      kind: 'json', status: 202,
      body: fakeV7Receipt({
        commandId: (body as { commandId?: string } | undefined)?.commandId,
        requestDigest: computeCommandRequestDigest(validateCommandEnvelope(body)),
        scope: (body as { scope: unknown }).scope,
      }),
    }));
    const accepted = await host.client.startPlanning(inputBase as never);
    expect(accepted.status).toBe('accepted');
    expect(validateCommandReceiptWire(accepted, { expectedOperation: 'planning.start' }).status).toBe('accepted');
  });
});
