/**
 * P03-2 / F-006 执行输入准备（execution.input.prepare）纵向切片
 * （真实临时 SQLite + 真实临时文件数据根 + 真实命令通道/独立只读探针，
 * 非 mock；仅发布失败注入与可变权限读取器使用端口包装，明确标注）。
 *
 * 覆盖（F-006 验收点）：
 * - 正常制品组：一致视图捕获（批准复合身份/Task revision 与策略副本/需求与
 *   依赖证据/检查政策/权限/必需引用）→ 事务外采集与 ContextBuilder 组装 →
 *   三正文发布与逐字节复验 → 最终写事务重核、脱敏事件与 completed 回执
 *   原子一致；返回同项目制品组引用、schemaVersion 与各正文摘要；不创建
 *   Batch/Run/Attempt 等任何执行实体；
 * - 读取复验：重开真实库后制品索引/事件/回执一致；readVerifiedContent
 *   逐字节复验通过；正文篡改明确 corrupt；
 * - 并发身份变更：组装后计划实质修订/检查政策变化/Task 策略副本编辑/权限面
 *   变化令最终重核明确拒绝（旧视图不得作为当前有效输入）；纯标签编辑与
 *   不影响 Task 副本的默认 modelMap 更新不误报；
 * - 部分发布失败：任一正文发布失败不留下可绑定半完整制品组（已发布正文
 *   不可变保留、索引 failed 证据与 staging 残留、零回执零事件）；必需输入
 *   缺失明确失败；
 * - 命令重放：同 commandId 同请求复用原回执不重复发布；异参 conflict；
 *   历史回执重放不代表满足当前前置条件（策略变更后重放仍返回旧回执，
 *   新命令的最终重核明确拒绝旧视图）；
 * - 策略编辑后新快照：无活动 Attempt 的 Task 策略副本编辑并满足当前批准
 *   条件后，新快照反映新策略，旧 snapshot/manifest/prompt 与源制品逐字节
 *   不变；凭据始终只有引用；
 * - 未批准/拒绝/跨项目/缺失目标 fail-closed；预算超限结构化失败；
 *   未装配端口 unsupported。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createInputSourceFileReader } from '../packages/core/src/adapters/fs/input-source-files.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { createExecutionInputService } from '../packages/core/src/application/execution-input.ts';
import { createContextBuilder } from '../packages/core/src/application/context-build.ts';
import type { ContextBudget } from '../packages/core/src/application/context-build.ts';
import {
  DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
  EXECUTION_INPUT_PREPARE_OPERATION,
  createExecutionInputPrepareService,
  submitExecutionInputPrepare,
} from '../packages/core/src/application/execution-input-prepare.ts';
import type {
  ExecutionInputPreparePort,
  ExecutionInputPrepareServiceDeps,
} from '../packages/core/src/application/execution-input-prepare.ts';
import type { ArtifactFileStore } from '../packages/core/src/ports/artifact-files.ts';
import { ArtifactFileError, deriveArtifactFinalRelativePath } from '../packages/core/src/ports/artifact-files.ts';
import { computeCommandRequestDigest } from '../packages/core/src/ports/command-receipts.ts';
import { isPublicError, validateCommandEnvelope } from '../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PublicError, ValidatedCommandEnvelope } from '../packages/core/src/ports/commands.ts';
import { mapStateEvent } from '../packages/core/src/ports/events.ts';
import {
  EXECUTION_GROUP_JSON_MEDIA_TYPE,
  EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
  EXECUTION_MANIFEST_ARTIFACT_KIND,
  EXECUTION_PROMPT_ARTIFACT_KIND,
  EXECUTION_SNAPSHOT_ARTIFACT_KIND,
  TRUSTED_PROJECT_PERMISSIONS_READER,
} from '../packages/core/src/ports/execution-input-prepare.ts';
import type { PreparedExecutionInputGroup } from '../packages/core/src/ports/execution-input-prepare.ts';
import { CONTEXT_FIXED_GUIDANCE } from '../packages/core/src/ports/context-build.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const HASH_A = sha256('artifact-source-content');
const HASH_B = sha256('artifact-requirements-content');

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

const GLOBAL_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};
const PROJECT_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
};

/** 三 Task 链计划（t-1 ← t-2 ← t-3），t-2 携带 requirementsRefs；variant 追加实质变化（改变 planDigest）。 */
function samplePlan(
  artifactIds: { readonly src: string; readonly req: string },
  variant = '',
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '执行输入准备验收',
      labels: [],
      sourceRefs: [{ artifactId: artifactIds.src, contentHash: HASH_A }],
    },
    tasks: [
      { id: 't-1', title: '任务一', complexity: 'low', acceptance: { criteria: ['任务一验收'] } },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: {
          criteria: ['任务二验收甲', '任务二验收乙', ...(variant === '' ? [] : [variant])],
        },
        dependsOn: ['t-1'],
        requirementsRefs: [{ artifactId: artifactIds.req }],
      },
      { id: 't-3', title: '任务三', acceptance: { criteria: ['任务三验收'] }, dependsOn: ['t-2'] },
    ],
  };
}

interface HarnessOptions {
  /** 可变权限读取器（并发身份变更测试注入；缺省生产空集边界宣告）。 */
  readonly permissions?: ExecutionInputPrepareServiceDeps['permissions'];
  /** 文件端口故障注入（部分发布失败测试；标注：仅测试注入）。 */
  readonly failPublishForLocatorSuffix?: string;
  /** ContextBuilder 预算覆盖（预算超限测试）。 */
  readonly contextBudget?: ContextBudget;
  /** 不装配执行输入准备端口（unsupported 测试）。 */
  readonly withoutPreparePort?: boolean;
}

interface PreparedHarness {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly service: CommandService;
  readonly preparePort: ExecutionInputPreparePort | undefined;
  readonly probe: ReturnType<CommandsTestFixture['openProbe']>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly artifactIds: { readonly src: string; readonly req: string };
  readonly sourcesRoot: string;
  readonly submit: (
    payload: Record<string, unknown>,
    operation: string,
    extra?: Record<string, unknown>,
  ) => Promise<CommandReceipt>;
  readonly prepareEnvelope: (changes?: Record<string, unknown>) => Record<string, unknown>;
  readonly eventCount: (eventType: string) => number;
  readonly advanceClock: () => void;
  readonly reopenSessionAndVerify: () => Promise<{
    readonly artifactsReady: number;
    readonly preparedEvents: number;
  }>;
}

async function setup(options: HarnessOptions = {}): Promise<PreparedHarness> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p032-f006-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const nowUtcMs = (): number => now;

  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs });
  const realFiles = createArtifactFileStore({ dataRoot: box.dataRoot });
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
  const publisher = createArtifactPublisher({
    artifacts: artifactStore,
    files,
    limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
  });
  const verifier = createArtifactVerifier({
    artifacts: artifactStore,
    files: realFiles,
    limits: { maxReadBytes: 16_000_000 },
  });
  const sourcesRoot = join(box.root, 'sources');
  mkdirSync(sourcesRoot, { recursive: true });
  writeFileSync(join(sourcesRoot, 'spec.md'), '# 需求规格\n\n任务二必需输入规格正文。\n', 'utf8');

  const atomicStore = createSqliteAtomicCommandStore(harness.session, { nowUtcMs });
  const preparePort = options.withoutPreparePort
    ? undefined
    : createExecutionInputPrepareService({
        views: createSqlitePlanAccess(harness.session, { nowUtcMs }),
        inputs: createExecutionInputService({
          artifacts: artifactStore,
          publisher,
          verifier,
          sources: createInputSourceFileReader({ roots: { src: sourcesRoot } }),
          limits: {
            maxItems: 8,
            maxItemBytes: 1_000_000,
            maxTotalBytes: 4_000_000,
            captureTimeoutMs: 30_000,
            readTimeoutMs: 30_000,
          },
          nowMs: nowUtcMs,
        }),
        builder: createContextBuilder({
          budget: options.contextBudget ?? DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
        }),
        publisher,
        verifier,
        permissions: options.permissions ?? TRUSTED_PROJECT_PERMISSIONS_READER,
        limits: { maxRequiredItems: 8 },
        nowMs: nowUtcMs,
      });

  const service: CommandService = createCommandService({
    atomicStore,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    ...(preparePort === undefined ? {} : { executionInputPrepare: preparePort }),
    nowUtcMs,
  });
  const probe = box.openProbe();
  const owner = box.localOwner();
  const envelopeBase = { schemaVersion: 4, issuedAt: NOW_ISO };
  const submit = async (
    payload: Record<string, unknown>,
    operation: string,
    extra: Record<string, unknown> = {},
  ): Promise<CommandReceipt> =>
    service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit(
    { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registered.status !== 'completed' || registered.result === null) {
    throw new Error('夹具注册失败');
  }
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const globalSettings = await submit(GLOBAL_SETTINGS_PAYLOAD, 'settings.global.create', {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') throw new Error('夹具全局配置失败');
  const projectSettings = await submit(PROJECT_SETTINGS_PAYLOAD, 'settings.project.create', {
    scope: { kind: 'project', projectId },
  });
  if (projectSettings.status !== 'completed') throw new Error('夹具项目配置失败');

  const phase = await submit(
    { id: 'phase-1', title: '第一阶段', description: null, labels: [] },
    'phase.create',
    { scope: { kind: 'project', projectId } },
  );
  if (phase.status !== 'completed') throw new Error('夹具 Phase 创建失败');

  const seedReady = async (contentHash: string, locatorName: string): Promise<string> => {
    const record = await artifactStore.registerArtifact({
      projectId,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: contentHash,
      locator: `artifacts/${locatorName}.md`,
    });
    await artifactStore.transitionArtifact(projectId, record.id, {
      expectedRevision: record.revision,
      outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
    });
    return record.id;
  };
  const artifactIds = { src: await seedReady(HASH_A, 'art-src'), req: await seedReady(HASH_B, 'art-req') };

  const imported = await submit(
    { phaseId: 'phase-1', plan: samplePlan(artifactIds) },
    'feature.plan.import',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) throw new Error('夹具计划导入失败');
  const feature = (imported.result as { feature: { id: string; planDigest: string } }).feature;

  const approve = await submit(
    {
      featureId: feature.id,
      planDigest: feature.planDigest,
      decision: 'approve',
      reason: '准备执行输入',
    },
    'feature.plan.decide',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (approve.status !== 'completed') throw new Error('夹具批准失败');

  const prepareEnvelope = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: EXECUTION_INPUT_PREPARE_OPERATION,
    scope: { kind: 'project', projectId },
    payload: {
      featureId: feature.id,
      taskId: 't-2',
      items: [
        { purpose: 'spec', source: { kind: 'file', root: 'src', relativePath: 'spec.md' } },
        { purpose: 'requirements', source: { kind: 'artifact', artifactId: artifactIds.req } },
      ],
    },
    ...changes,
  });

  const eventCount = (eventType: string): number =>
    probe.stateEvents().filter((event) => event.event_type === eventType).length;

  const reopenSessionAndVerify = async () => {
    const session = openSqliteStorageSession({ path: box.dbPath });
    try {
      const artifactsReady = session.database
        .prepare('SELECT COUNT(*) AS n FROM artifacts WHERE status = ?')
        .get('ready') as { n: number };
      const preparedEvents = session.database
        .prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?')
        .get('execution.input.prepared') as { n: number };
      return { artifactsReady: artifactsReady.n, preparedEvents: preparedEvents.n };
    } finally {
      session.close();
    }
  };

  return {
    box,
    session: harness.session,
    service,
    preparePort,
    probe,
    owner,
    projectId,
    featureId: feature.id,
    planDigest: feature.planDigest,
    artifactIds,
    sourcesRoot,
    submit,
    prepareEnvelope,
    eventCount,
    advanceClock: () => {
      now += 1;
    },
    reopenSessionAndVerify,
  };
}

interface GroupResult {
  readonly schemaVersion: number;
  readonly bindable: boolean;
  readonly group: {
    readonly snapshot: Record<string, unknown> & { readonly contentHash: string; readonly artifactId: string };
    readonly manifest: Record<string, unknown> & { readonly contentHash: string; readonly artifactId: string };
    readonly prompt: Record<string, unknown> & { readonly contentHash: string; readonly artifactId: string };
  };
  readonly requiredInputs: readonly {
    readonly purpose: string;
    readonly artifactId: string;
    readonly contentHash: string;
  }[];
  readonly digests: Record<string, string>;
  readonly approval: { readonly planDigest: string; readonly checkPolicyDigest: string };
  readonly taskRevision: number;
}

function groupResultOf(receipt: CommandReceipt): GroupResult {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as unknown as GroupResult;
}

function rejectedErrorOf(receipt: CommandReceipt): { code: string; details?: Record<string, unknown> } {
  if (receipt.status !== 'rejected') {
    throw new Error(`expected rejected receipt, got ${receipt.status}`);
  }
  return receipt.error;
}

async function expectPublicError(
  run: (() => Promise<unknown>) | Promise<unknown>,
  expected: { readonly code: string; readonly reason?: string },
): Promise<PublicError> {
  const promise = typeof run === 'function' ? run() : run;
  const thrown = (await promise.then(
    (value) => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value).slice(0, 200)}`);
    },
    (error: unknown) => error,
  )) as PublicError;
  expect(isPublicError(thrown)).toBe(true);
  expect(thrown.code).toBe(expected.code);
  if (expected.reason !== undefined) {
    expect(thrown.details?.reason).toBe(expected.reason);
  }
  return thrown;
}

async function bodyPath(box: CommandsTestFixture, projectId: string, artifactId: string): Promise<string> {
  return join(box.dataRoot, deriveArtifactFinalRelativePath({ projectId, artifactId }));
}

/* ------------------------------------------------------------------ *
 * 正常制品组
 * ------------------------------------------------------------------ */

describe('F-006 正常制品组（视图捕获 → 组装发布 → 最终重核）', () => {
  it('completed 回执携带同项目制品组引用/schemaVersion/各正文摘要；事件与回执原子提交；不创建执行实体', async () => {
    const s = await setup();
    const before = s.probe.counts();
    const receipt = await s.service.submit(s.owner, s.prepareEnvelope());
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: EXECUTION_INPUT_PREPARE_OPERATION,
      scope: { kind: 'project', projectId: s.projectId },
    });
    const result = groupResultOf(receipt);
    expect(result.schemaVersion).toBe(1);
    expect(result.bindable).toBe(true);
    expect(result.group.snapshot).toMatchObject({
      mediaType: EXECUTION_GROUP_JSON_MEDIA_TYPE,
      locator: `execution-input-groups/t-2/snapshot`,
      version: 1,
    });
    expect(result.group.manifest.locator).toBe('execution-input-groups/t-2/manifest');
    expect(result.group.prompt).toMatchObject({
      mediaType: EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
      locator: 'execution-input-groups/t-2/prompt',
    });
    for (const digest of Object.values(result.digests)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.approval.planDigest).toBe(s.planDigest);
    expect(result.approval.checkPolicyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.taskRevision).toBe(1);
    expect(result.requiredInputs.map((ref) => ref.purpose)).toEqual(['spec', 'requirements']);
    // 制品索引新增：三正文 + 一个文件来源采集制品（制品来源复用既有 ready 制品）。
    const after = s.probe.counts();
    expect(after.artifacts - before.artifacts).toBe(4);
    // 脱敏事件（聚合为目标 Task；payload 恒 {prepared:true}）。
    expect(s.eventCount('execution.input.prepared')).toBe(1);
    const eventRow = s.probe
      .stateEvents()
      .find((event) => event.event_type === 'execution.input.prepared');
    expect(
      mapStateEvent({
        id: eventRow!.id,
        sequence: eventRow!.sequence,
        eventType: eventRow!.event_type,
        aggregateType: eventRow!.aggregate_type,
        aggregateId: eventRow!.aggregate_id,
        aggregateRevision: eventRow!.aggregate_revision,
        projectId: eventRow!.project_id,
        payload: JSON.parse(eventRow!.payload),
        occurredAtUtcMs: eventRow!.occurred_at,
      }),
    ).toMatchObject({
      type: 'execution.input.prepared',
      scope: { kind: 'project', projectId: s.projectId },
      aggregate: { type: 'task', id: 't-2' },
      payload: { prepared: true },
    });
    // P03-2 存储边界：不创建 Batch/Run/Attempt 等执行实体表。
    for (const table of ['runs', 'attempts', 'batches', 'sessions']) {
      expect(s.probe.tableExists(table)).toBe(false);
    }
  });

  it('三正文发布为同项目不可变制品：文件字节可复算 hash、snapshot 反映策略副本/依赖证据/检查政策/权限、manifest 与 prompt 绑定', async () => {
    const s = await setup();
    const receipt = await s.service.submit(s.owner, s.prepareEnvelope());
    const result = groupResultOf(receipt);

    const snapshotBytes = await readFile(await bodyPath(s.box, s.projectId, result.group.snapshot.artifactId));
    expect(sha256(snapshotBytes)).toBe(result.group.snapshot.contentHash);
    const snapshot = JSON.parse(snapshotBytes.toString('utf8')) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      projectId: s.projectId,
      featureId: s.featureId,
      taskId: 't-2',
    });
    const task = snapshot.task as Record<string, unknown>;
    expect(task.title).toBe('任务二');
    expect((task.acceptance as { criteria: string[] }).criteria).toEqual(['任务二验收甲', '任务二验收乙']);
    // 策略副本按任务行的实际副本原样进入快照（不读默认路由，不重算）。
    const taskRow = s.probe.selectOne<{ execution_config: string; config_source: string }>(
      'SELECT execution_config, config_source FROM tasks WHERE id = ?',
      ['t-2'],
    );
    expect(task.executionConfig).toEqual(JSON.parse(taskRow!.execution_config));
    expect(task.configSource).toBe(taskRow!.config_source);
    // 依赖证据：上游 t-1（来自同一视图）。
    expect(task.dependencies).toEqual([
      { taskId: 't-1', evidenceRefs: [] },
    ]);
    // 权限面（生产缺省空集）与必需输入引用。
    expect(snapshot.permissions).toEqual({ grants: [] });
    const requiredInputs = snapshot.requiredInputs as { purpose: string; projectId: string }[];
    expect(requiredInputs.map((ref) => ref.purpose)).toEqual(['spec', 'requirements']);
    for (const ref of requiredInputs) {
      expect(ref.projectId).toBe(s.projectId);
    }
    expect(snapshot.checkPolicy).toMatchObject({ digest: result.approval.checkPolicyDigest });

    const manifestBytes = await readFile(await bodyPath(s.box, s.projectId, result.group.manifest.artifactId));
    expect(sha256(manifestBytes)).toBe(result.group.manifest.contentHash);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      sources: { sourceId: string; kind: string; required: boolean }[];
      promptDigest: string;
    };
    expect(manifest.promptDigest).toBe(result.digests.promptDigest);
    const sourceKinds = manifest.sources.map((source) => source.kind);
    expect(sourceKinds).toContain('fixed-guidance');
    expect(sourceKinds).toContain('acceptance');
    expect(sourceKinds.filter((kind) => kind === 'required-input')).toHaveLength(2);

    const prompt = (await readFile(await bodyPath(s.box, s.projectId, result.group.prompt.artifactId))).toString('utf8');
    expect(sha256(Buffer.from(prompt, 'utf8'))).toBe(result.group.prompt.contentHash);
    expect(prompt).toContain(CONTEXT_FIXED_GUIDANCE);
    expect(prompt.indexOf(CONTEXT_FIXED_GUIDANCE)).toBeLessThan(prompt.indexOf('## Task'));
    expect(prompt).toContain('任务二验收甲');
    expect(prompt).toContain('任务二验收乙');
    // 必需输入以受管引用进入 prompt（文件来源采集制品与既有制品的权威摘要）。
    const specRef = result.requiredInputs.find((ref) => ref.purpose === 'spec');
    const requirementsRef = result.requiredInputs.find((ref) => ref.purpose === 'requirements');
    expect(prompt).toContain(specRef!.contentHash);
    expect(prompt).toContain(requirementsRef!.contentHash);
    // 凭据纪律：正文只有引用，不内联任何凭据字段。
    expect(prompt).not.toMatch(/credential|apiKey|password/i);
  });

  it('重开真实库后索引/事件/回执一致，readVerifiedContent 逐字节复验通过；正文篡改明确 corrupt', async () => {
    const s = await setup();
    const receipt = await s.service.submit(s.owner, s.prepareEnvelope());
    const result = groupResultOf(receipt);

    const reopened = await s.reopenSessionAndVerify();
    expect(reopened.artifactsReady).toBeGreaterThanOrEqual(5); // 三正文 + 采集制品 + 两个种子制品
    expect(reopened.preparedEvents).toBe(1);

    // 重开会话上的独立 verifier（只读语义：仅使用 getArtifact/文件读取）。
    const session = openSqliteStorageSession({ path: s.box.dbPath });
    try {
      const harnessVerifier = createArtifactVerifier({
        artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => NOW }),
        files: createArtifactFileStore({ dataRoot: s.box.dataRoot }),
        limits: { maxReadBytes: 16_000_000 },
      });
      const promptPath = await bodyPath(s.box, s.projectId, result.group.prompt.artifactId);
      const original = await readFile(promptPath);
      const verified = await harnessVerifier.readVerifiedContent(s.projectId, result.group.prompt.artifactId);
      expect(Buffer.compare(Buffer.from(verified.content), original)).toBe(0);

      // 篡改正文 → 校验读取明确 corrupt（不修补、不放行）。
      await writeFile(promptPath, Buffer.concat([original, Buffer.from('tampered')]));
      await expect(
        harnessVerifier.readVerifiedContent(s.projectId, result.group.prompt.artifactId),
      ).rejects.toMatchObject({ name: 'ArtifactVerifyError', code: 'corrupt' });
      await writeFile(promptPath, original);
    } finally {
      session.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 并发身份变更（组装/发布期间漂移 → 最终重核拒绝；不误报边界）
 * ------------------------------------------------------------------ */

interface SubmitContext {
  readonly identity: {
    principalId: string;
    commandId: string;
    operation: typeof EXECUTION_INPUT_PREPARE_OPERATION;
    scope: { kind: 'project'; projectId: string };
    requestDigest: string;
    issuedAt: string;
    completedAt: string;
  };
  readonly envelope: PrepareEnvelope;
}

type PrepareEnvelope = Extract<
  ValidatedCommandEnvelope,
  { operation: typeof EXECUTION_INPUT_PREPARE_OPERATION }
>;

async function prepareOnly(
  s: PreparedHarness,
  envelopeInput: Record<string, unknown>,
): Promise<{ prepared: PreparedExecutionInputGroup; submitContext: SubmitContext }> {
  if (s.preparePort === undefined) throw new Error('prepare port missing');
  const envelope = validateCommandEnvelope(envelopeInput) as PrepareEnvelope;
  const prepared = await s.preparePort.prepareExecutionInput(s.projectId, envelope.payload);
  return {
    prepared,
    submitContext: {
      identity: {
        principalId: s.owner.principalId,
        commandId: envelope.commandId,
        operation: EXECUTION_INPUT_PREPARE_OPERATION,
        scope: envelope.scope as { kind: 'project'; projectId: string },
        requestDigest: computeCommandRequestDigest(envelope),
        issuedAt: envelope.issuedAt,
        completedAt: new Date(NOW).toISOString(),
      },
      envelope,
    },
  };
}

/** 最终事务内使用的最小端口实现：权限面恒空集（与生产缺省一致），事务外
 * 准备入口在事务内不可达（防御断言）。 */
const FINAL_SUBMIT_STUB_PORT: ExecutionInputPreparePort = {
  async prepareExecutionInput(): Promise<never> {
    throw new Error('最终事务内不得触发事务外准备');
  },
  readExecutionPermissions: () => ({ grants: [] }),
};

function finalSubmit(s: PreparedHarness, context: SubmitContext, prepared: PreparedExecutionInputGroup): CommandReceipt {
  const store = createSqliteAtomicCommandStore(s.session, { nowUtcMs: () => NOW });
  return store.transact(EXECUTION_INPUT_PREPARE_OPERATION, (transaction) =>
    submitExecutionInputPrepare(context.identity, context.envelope, transaction, prepared, FINAL_SUBMIT_STUB_PORT),
  );
}

describe('F-006 并发身份变更（最终重核 fail-closed）', () => {
  it('组装后 Task 策略副本被编辑：最终重核拒绝 task_strategy_changed，零事件', async () => {
    const s = await setup();
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    const before = s.probe.counts();
    // 组装后（提交前）并发编辑策略副本（无活动 Attempt 边界内允许编辑）。
    const edited = await s.submit(
      {
        taskId: 't-2',
        executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(edited.status).toBe('completed');
    const receipt = finalSubmit(s, submitContext, prepared);
    expect(rejectedErrorOf(receipt)).toMatchObject({ code: 'conflict', details: { reason: 'task_strategy_changed' } });
    const after = s.probe.counts();
    expect(after.state_events).toBe(before.state_events + 1); // 只有策略编辑事件
    expect(s.eventCount('execution.input.prepared')).toBe(0);
  });

  it('组装后检查政策变化：批准复合身份过期，最终重核拒绝 check_policy_changed', async () => {
    const s = await setup();
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    const settingsRow = s.probe.settingsRow('project', s.projectId);
    const updated = await s.submit(
      {
        ...PROJECT_SETTINGS_PAYLOAD,
        policies: { verification: { requireChecksBeforeDone: true } },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: (settingsRow as { revision: number }).revision },
    );
    expect(updated.status).toBe('completed');
    const receipt = finalSubmit(s, submitContext, prepared);
    expect(rejectedErrorOf(receipt)).toMatchObject({ code: 'conflict', details: { reason: 'check_policy_changed' } });
    expect(s.eventCount('execution.input.prepared')).toBe(0);
  });

  it('组装后计划实质修订（即使已重新批准）：旧视图不得作为当前有效输入，拒绝 plan_changed', async () => {
    const s = await setup();
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    const revised = await s.submit(
      {
        featureId: s.featureId,
        plan: samplePlan(s.artifactIds, '修订后新增验收条目'),
      },
      'feature.plan.revise',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    expect(revised.status).toBe('completed');
    // 修订使 planStatus 回 draft：先重新批准当前身份（模拟「修订且重批」的更强竞争）。
    const featureRow = s.probe.selectOne<{ plan_digest: string; revision: number; plan_status: string }>(
      'SELECT plan_digest, revision, plan_status FROM features WHERE id = ?',
      [s.featureId],
    );
    expect(featureRow?.plan_status).toBe('draft');
    const reapproved = await s.submit(
      { featureId: s.featureId, planDigest: featureRow!.plan_digest, decision: 'approve' },
      'feature.plan.decide',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: featureRow!.revision },
    );
    expect(reapproved.status).toBe('completed');
    const receipt = finalSubmit(s, submitContext, prepared);
    expect(rejectedErrorOf(receipt)).toMatchObject({ code: 'conflict', details: { reason: 'plan_changed' } });
  });

  it('组装后权限面变化：最终重核拒绝 permissions_changed（可变读取器注入，标注：测试注入）', async () => {
    let grants: string[] = [];
    const s = await setup({
      permissions: () => ({ grants }),
    });
    const port = s.preparePort!;
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    grants = ['repo.read']; // 组装后权限变更
    const store = createSqliteAtomicCommandStore(s.session, { nowUtcMs: () => NOW });
    const receipt = store.transact(EXECUTION_INPUT_PREPARE_OPERATION, (transaction) =>
      submitExecutionInputPrepare(submitContext.identity, submitContext.envelope, transaction, prepared, port),
    );
    expect(rejectedErrorOf(receipt)).toMatchObject({ code: 'conflict', details: { reason: 'permissions_changed' } });
    expect(s.eventCount('execution.input.prepared')).toBe(0);
  });

  it('纯标签编辑只递增 revision：最终重核照常通过（不误报业务失效）', async () => {
    const s = await setup();
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    const labeled = await s.submit(
      { entityType: 'task', id: 't-2', labels: ['wip'] },
      'plan.labels.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(labeled.status).toBe('completed');
    const receipt = finalSubmit(s, submitContext, prepared);
    expect(receipt.status).toBe('completed');
    expect(groupResultOf(receipt).bindable).toBe(true);
    expect(s.eventCount('execution.input.prepared')).toBe(1);
  });

  it('不影响 Task 副本的默认 modelMap 更新：最终重核照常通过（策略按副本使用）', async () => {
    const s = await setup();
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    const settingsRow = s.probe.settingsRow('project', s.projectId);
    const remapped = await s.submit(
      {
        ...PROJECT_SETTINGS_PAYLOAD,
        strategies: {
          modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: (settingsRow as { revision: number }).revision },
    );
    expect(remapped.status).toBe('completed');
    const receipt = finalSubmit(s, submitContext, prepared);
    expect(receipt.status).toBe('completed');
    expect(groupResultOf(receipt).bindable).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 部分发布失败与必需输入缺失
 * ------------------------------------------------------------------ */

describe('F-006 部分发布失败（不留下可绑定的半完整制品组）', () => {
  it('prompt 正文发布失败：已有正文不可变保留、索引 failed 证据与 staging 残留保留、零回执零事件', async () => {
    const s = await setup({ failPublishForLocatorSuffix: '/prompt' });
    const receiptsBefore = s.probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM command_receipts')!.n;
    const artifactsBefore = s.probe.counts().artifacts;
    await expectPublicError(s.service.submit(s.owner, s.prepareEnvelope()), {
      code: 'internal',
      reason: 'publish_failed',
    });
    // 零回执零事件（失败不写回执；发布证据保留在制品索引）。
    expect(s.probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM command_receipts')!.n).toBe(receiptsBefore);
    expect(s.eventCount('execution.input.prepared')).toBe(0);
    const after = s.probe.counts();
    const before = { artifacts: artifactsBefore };
    // snapshot/manifest 已发布（不可变保留），prompt 索引 failed，采集制品 ready。
    const statuses = s.probe.selectAll<{ kind: string; status: string; storage_locator: string }>(
      "SELECT kind, status, storage_locator FROM artifacts WHERE kind IN ('execution-snapshot','execution-manifest','execution-prompt')",
    );
    const groupKinds = statuses;
    expect(groupKinds.map((row) => row.kind).sort()).toEqual([
      'execution-manifest',
      'execution-prompt',
      'execution-snapshot',
    ]);
    const promptRow = groupKinds.find((row) => row.kind === 'execution-prompt');
    expect(promptRow?.status).toBe('failed');
    expect(groupKinds.find((row) => row.kind === 'execution-snapshot')?.status).toBe('ready');
    expect(groupKinds.find((row) => row.kind === 'execution-manifest')?.status).toBe('ready');
    expect(after.artifacts - before.artifacts).toBe(4);
    // staging 残留保留（不自动删除，供残留核对；真实文件系统证据）。
    const stagingEntries = await readdir(join(s.box.dataRoot, 'staging', s.projectId));
    expect(stagingEntries.some((name) => name.endsWith('.part'))).toBe(true);
  });

  it('必需输入源文件缺失：明确失败，不发布任何组正文，零回执', async () => {
    const s = await setup();
    const before = s.probe.counts();
    await expectPublicError(
      s.service.submit(
        s.owner,
        s.prepareEnvelope({
          payload: {
            featureId: s.featureId,
            taskId: 't-2',
            items: [
              { purpose: 'missing', source: { kind: 'file', root: 'src', relativePath: 'nope.md' } },
            ],
          },
        }),
      ),
      { code: 'not_found', reason: 'required_input_not_found' },
    );
    const after = s.probe.counts();
    expect(after.artifacts).toBe(before.artifacts);
    expect(s.eventCount('execution.input.prepared')).toBe(0);
  });

  it('必需内容超预算：结构化 limit_exceeded，不发布组正文', async () => {
    const s = await setup({
      contextBudget: {
        maxPromptBytes: 200,
        maxRequiredSnapshotBytes: 100_000,
        maxRequiredInputRefs: 8,
        maxHistoryEntries: 20,
        maxHistoryEntryChars: 120,
        bytesPerTokenEstimate: 4,
      },
    });
    const before = s.probe.counts();
    await expectPublicError(s.service.submit(s.owner, s.prepareEnvelope()), {
      code: 'invalid_input',
      reason: 'limit_exceeded',
    });
    const after = s.probe.counts();
    // 采集制品可能已发布（F-004 采集先于组装），但组正文零发布。
    const groupKinds = s.probe.selectAll<{ kind: string }>(
      "SELECT kind FROM artifacts WHERE kind IN ('execution-snapshot','execution-manifest','execution-prompt')",
    );
    expect(groupKinds).toEqual([]);
    expect(after.artifacts - before.artifacts).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ *
 * 命令重放与历史回执语义
 * ------------------------------------------------------------------ */

describe('F-006 命令幂等与历史回执语义', () => {
  it('同 commandId 同请求重放复用原回执，不重复发布制品；异参复用 conflict', async () => {
    const s = await setup();
    const envelope = s.prepareEnvelope();
    const first = await s.service.submit(s.owner, envelope);
    expect(first.status).toBe('completed');
    const afterFirst = s.probe.counts();
    const replayed = await s.service.submit(s.owner, { ...envelope });
    expect(replayed).toMatchObject({ status: 'completed', replayed: true });
    expect(groupResultOf(replayed).group).toEqual(groupResultOf(first).group);
    expect(s.probe.counts()).toEqual(afterFirst);
    await expectPublicError(
      s.service.submit(s.owner, {
        ...envelope,
        payload: { ...(envelope.payload as Record<string, unknown>), taskId: 't-3' },
      }),
      { code: 'conflict', reason: 'idempotency_key_reuse' },
    );
  });

  it('历史回执重放不代表满足当前前置条件：策略变更后重放仍返回旧回执，新命令最终重核拒绝旧视图', async () => {
    const s = await setup();
    const envelope = s.prepareEnvelope();
    const original = await s.service.submit(s.owner, envelope);
    expect(original.status).toBe('completed');
    // 组装完成后策略被编辑（旧输入不再反映当前策略）。
    const edited = await s.submit(
      {
        taskId: 't-2',
        executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(edited.status).toBe('completed');
    // 重放：既有幂等规则复用原回执（不重核当前前置条件，也不重复发布）。
    const replayed = await s.service.submit(s.owner, { ...envelope });
    expect(replayed).toMatchObject({ status: 'completed', replayed: true });
    // 新命令：捕获旧视图后并发再编辑 → 最终重核拒绝。
    const { prepared, submitContext } = await prepareOnly(s, s.prepareEnvelope());
    const editedAgain = await s.submit(
      {
        taskId: 't-2',
        executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    expect(editedAgain.status).toBe('completed');
    const receipt = finalSubmit(s, submitContext, prepared);
    expect(rejectedErrorOf(receipt)).toMatchObject({ code: 'conflict', details: { reason: 'task_strategy_changed' } });
  });
});

/* ------------------------------------------------------------------ *
 * 策略编辑后的新快照（历史正文逐字节不变）
 * ------------------------------------------------------------------ */

describe('F-006 策略编辑后新快照', () => {
  it('新快照反映新策略副本与来源；旧 snapshot/manifest/prompt 及源制品逐字节不变', async () => {
    const s = await setup();
    const first = groupResultOf(await s.service.submit(s.owner, s.prepareEnvelope()));
    const firstBodies = await Promise.all(
      (['snapshot', 'manifest', 'prompt'] as const).map(async (part) =>
        readFile(await bodyPath(s.box, s.projectId, first.group[part].artifactId)),
      ),
    );
    const specArtifactId = first.requiredInputs.find((ref) => ref.purpose === 'spec')!.artifactId;
    const firstSourceArtifact = await readFile(
      join(s.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: s.projectId, artifactId: specArtifactId })),
    );

    // 无活动 Attempt 的 Task 策略副本编辑（批准条件仍满足）。
    const edited = await s.submit(
      {
        taskId: 't-2',
        executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(edited.status).toBe('completed');

    const second = groupResultOf(await s.service.submit(s.owner, s.prepareEnvelope()));
    expect(second.group.snapshot.artifactId).not.toBe(first.group.snapshot.artifactId);
    expect(second.digests.snapshotDigest).not.toBe(first.digests.snapshotDigest);
    expect(second.digests.strategyCopyDigest).not.toBe(first.digests.strategyCopyDigest);
    const secondSnapshot = JSON.parse(
      (await readFile(await bodyPath(s.box, s.projectId, second.group.snapshot.artifactId))).toString('utf8'),
    ) as { task: { executionConfig: Record<string, unknown>; configSource: string } };
    expect(secondSnapshot.task.executionConfig).toMatchObject({
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    expect(secondSnapshot.task.configSource).toBe('task_edit');

    // 旧正文逐字节不变（新制品不覆盖历史）。
    await Promise.all(
      (['snapshot', 'manifest', 'prompt'] as const).map(async (part, index) => {
        const current = await readFile(await bodyPath(s.box, s.projectId, first.group[part].artifactId));
        expect(Buffer.compare(current, firstBodies[index])).toBe(0);
      }),
    );
    const sourceArtifactNow = await readFile(
      join(s.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: s.projectId, artifactId: specArtifactId })),
    );
    expect(Buffer.compare(sourceArtifactNow, firstSourceArtifact)).toBe(0);
    expect(s.eventCount('execution.input.prepared')).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 批准/归属 fail-closed 与装配边界
 * ------------------------------------------------------------------ */

describe('F-006 批准与归属 fail-closed', () => {
  it('未批准：捕获阶段即拒绝 not_approved，零发布零回执', async () => {
    const s = await setup();
    // 撤回批准路径不可用（决策不可改写）；改用计划修订使批准失效。
    const revised = await s.submit(
      { featureId: s.featureId, plan: samplePlan(s.artifactIds, '修订后新增验收条目') },
      'feature.plan.revise',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    expect(revised.status).toBe('completed');
    const before = s.probe.counts();
    await expectPublicError(s.service.submit(s.owner, s.prepareEnvelope()), {
      code: 'conflict',
      reason: 'plan_changed', // 旧摘要 approved 决策 → 修订后无当前身份决定（F-003 词汇）
    });
    expect(s.probe.counts()).toEqual(before);
  });

  it('拒绝决策不提供执行依据：rejected', async () => {
    const s = await setup();
    // 修订回 draft 后拒绝当前身份。
    await s.submit(
      { featureId: s.featureId, plan: samplePlan(s.artifactIds, '修订后新增验收条目') },
      'feature.plan.revise',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    const featureRow = s.probe.selectOne<{ plan_digest: string; revision: number }>(
      'SELECT plan_digest, revision FROM features WHERE id = ?',
      [s.featureId],
    );
    const rejected = await s.submit(
      { featureId: s.featureId, planDigest: featureRow!.plan_digest, decision: 'reject' },
      'feature.plan.decide',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: featureRow!.revision },
    );
    expect(rejected.status).toBe('completed');
    await expectPublicError(s.service.submit(s.owner, s.prepareEnvelope()), {
      code: 'conflict',
      reason: 'rejected',
    });
  });

  it('跨项目目标：forbidden ownership_denied；缺失目标：not_found', async () => {
    const s = await setup();
    const registerB = await s.submit(
      { repositoryPath: s.box.repoDirB, displayName: 'Repo B', description: null, labels: [] },
      'project.register',
      { scope: { kind: 'registration' } },
    );
    if (registerB.status !== 'completed' || registerB.result === null) {
      throw new Error('夹具项目 B 注册失败');
    }
    const projectBId = (registerB.result as { project: { id: string } }).project.id;
    await expectPublicError(
      s.service.submit(s.owner, s.prepareEnvelope({ scope: { kind: 'project', projectId: projectBId } })),
      { code: 'forbidden', reason: 'ownership_denied' },
    );
    await expectPublicError(
      s.service.submit(
        s.owner,
        s.prepareEnvelope({ payload: { featureId: 'f-missing', taskId: 't-2', items: [] } }),
      ),
      { code: 'not_found', reason: 'feature_not_found' },
    );
    await expectPublicError(
      s.service.submit(
        s.owner,
        s.prepareEnvelope({ payload: { featureId: s.featureId, taskId: 't-missing', items: [] } }),
      ),
      { code: 'not_found', reason: 'task_not_in_plan' },
    );
  });

  it('未装配执行输入准备端口：unsupported；受限主体缺能力：forbidden', async () => {
    const s = await setup({ withoutPreparePort: true });
    await expectPublicError(s.service.submit(s.owner, s.prepareEnvelope()), { code: 'unsupported' });
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'allowlist', projectIds: [s.projectId] },
    });
    const s2 = await setup();
    const envelope = s2.prepareEnvelope();
    const error = (await s2.service.submit(restricted, envelope).then(
      () => {
        throw new Error('expected forbidden');
      },
      (thrown: unknown) => thrown,
    )) as PublicError;
    expect(error.code).toBe('forbidden');
  });

  it('权限读取器返回非法形态：fail-closed（不默认为空集）', async () => {
    const s = await setup({ permissions: () => ({ grants: 'repo.read' }) as never });
    await expectPublicError(s.service.submit(s.owner, s.prepareEnvelope()), {
      code: 'corrupt_state',
    });
  });
});
