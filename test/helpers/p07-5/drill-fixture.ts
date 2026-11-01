/**
 * P07-5 / F-002 故障演练隔离资源夹具（父进程侧，仅测试使用，不进 packages/）。
 *
 * 为 P07 阶段故障演练（F-003～F-009 场景）提供集中持有的真实临时资源与
 * 结构化事实采集；复用既有隔离环境、受管子进程、Git/SQLite 夹具与屏障
 * 协议（p02-2/p02-3/p03-6/p06-7/p07-1 的资源、屏障与观测方法）：
 *
 * - 资源：隔离 HOME/TMPDIR、真实 SQLite（WAL/FK）、两个真实 Git 仓库
 *   （repoA/repoB）、Host 子进程（drill-host-child）与受控工具命令管理；
 * - 业务状态全部经公开 Core 装配入口建立（openCoreApplication 命令面）：
 *   两个项目（各自 phase/feature/带依赖 Task/需求制品/批准/Profile 确认）；
 *   本夹具对 SQLite 只做只读观察，不补写业务表；
 * - 屏障：有界就绪（ready→go→host_ready）、暂停写入（FakeRuntime 门闩）、
 *   进入验证（真实检查进程启动标记 + drill_barrier）、进入提交（批次通过后
 *   drill_barrier；父进程可植入条件 post-commit 钩子获得「commit 已落盘、
 *   回执未持久化」边界）。FakeRuntime 只替代模型输出；
 * - 采集：身份绑定（run/受测 commit/输入摘要/场景）的结构化证据（业务行、
 *   预算与 deadline、Git HEAD/tree/status/worktree、进程身份与退出、制品
 *   摘要、命令退出码、并发事实、耗时）；采集错误显式失败（capture_failed）；
 * - 并发：runConcurrent 记录真实时间窗重叠；公共元数据锁争用记录
 *   「第一持有期内第二请求被拒」的重叠事实，不用固定 sleep 代替竞争证据；
 * - 清理（fail-closed）：先核验自有进程树停止（升级 + 标记 PID 缺席普查），
 *   导出并保存事实、关闭数据库，然后仅清理自有临时根（box/env 各自沙箱）；
 *   部分初始化、超时、取消、清理未确认均有结构化事实；cleanup_unconfirmed
 *   保留现场并阻止验收通过（dispose 抛错），不吞掉清理错误；
 * - 脱敏：合成敏感哨兵（凭据值 + Bearer 形状）与开发机受保护路径登记
 *   fail-closed；普通事实输出不含真实凭据、真实用户目录或开发机绝对路径。
 */
import { createHash, randomUUID } from 'node:crypto';
import { observeP07Entry, p07CaptureActive } from './entry-observation.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { deriveObservedRepoIdentity } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { OwnedProcessTree } from '../../../scripts/acceptance/owned-process-tree.ts';
import { CHECK_RUNNER } from '../p07-1/fault-barrier-host.ts';
import { spawnSampleProcess, type SampleProcess } from '../p02-3/process-tools.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../p02-2/commands-fixture.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from '../host/isolated-environment.ts';
import type { ManagedChild } from '../host/index.ts';
import { createEvidenceLog, type EvidenceLog } from '../host/evidence.ts';
import { git } from '../git-repo.ts';
import { processRows } from '../process-matrix.ts';

export const DRILL_CHILD = fileURLToPath(new URL('./drill-host-child.ts', import.meta.url));

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SETUP_NOW = 1_900_000_100_000;
const DRILL_FAKE_STRATEGY = { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } as const;
const DRILL_BUDGET = {
  batch: {
    maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 2,
    deadlineUtcMs: SETUP_NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 4, runTimeLimitMs: 3_600_000 },
} as const;
export { DRILL_BUDGET };

/** Runtime 写入并交由真实 Verifier 校验的目标（worktree 相对路径）。 */
export const DRILL_RUNTIME_TARGET = { path: 'src/p07-drill-marker.ts', content: 'export const p07DrillMarker = 1;\n' } as const;

const GIT_HOOK = [
  '#!/bin/sh',
  '# P07-5 / F-002 test fault point: after the real task commit is durable,',
  '# block the driver return (and therefore the receipt transaction) while the',
  '# hold file exists. Bounded by a finite wait; exits 0 either way.',
  'common_dir=$(git rev-parse --git-common-dir)',
  'marker="$common_dir/p07-5-git-barrier.json"',
  'hold="$common_dir/p07-5-git-hold"',
  'if [ -f "$hold" ]; then',
  '  printf \'{"pid":%s,"head":"%s","startedAt":"%s"}\\n\' "$$" "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"',
  '  i=0',
  '  while [ -f "$hold" ] && [ "$i" -lt 600 ]; do sleep 0.5 2>/dev/null || sleep 1; i=$((i+1)); done',
  'fi',
  'exit 0',
].join('\n');

/* ------------------------------------------------------------------ *
 * 部分初始化注入：结构化失败事实
 * ------------------------------------------------------------------ */

export type DrillFixtureStage =
  | 'sandbox'
  | 'box'
  | 'application'
  | 'project-a'
  | 'project-b'
  | 'barriers'
  | 'complete';

/** 部分初始化失败：保留已完成阶段事实；自有临时根已尽力清理。 */
export class DrillFixturePartialInitError extends Error {
  readonly kind = 'partial_init' as const;
  readonly stage: DrillFixtureStage;
  readonly prepared: readonly DrillFixtureStage[];
  readonly root: string;

  constructor(stage: DrillFixtureStage, prepared: readonly DrillFixtureStage[], root: string) {
    super(`P07 演练夹具在阶段 ${stage} 后按要求中止（部分初始化）；已完成：${prepared.join(' -> ')}`);
    this.name = 'DrillFixturePartialInitError';
    this.stage = stage;
    this.prepared = prepared;
    this.root = root;
  }
}

/** 采集失败（fail-closed）：保留场景身份与原因，不静默吞掉。 */
export class DrillCaptureError extends Error {
  readonly kind = 'capture_failed' as const;
  readonly scenarioId: string;
  readonly reason: string;

  constructor(scenarioId: string, reason: string) {
    super(`drill 证据采集失败（${scenarioId}）: ${reason}`);
    this.name = 'DrillCaptureError';
    this.scenarioId = scenarioId;
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface DrillProjectFacts {
  readonly key: 'a' | 'b';
  readonly projectId: string;
  readonly featureId: string;
  readonly repositoryPath: string;
  readonly taskIds: readonly [string, string, ...string[]];
  /** 依赖 Task（dependsOn: [首个 Task]）。 */
  readonly dependentTaskId: string;
  readonly requirementArtifactIds: Readonly<Record<string, string>>;
}

export interface DrillEvidenceIdentity {
  readonly schemaVersionBrand: 'p07-5-drill';
  readonly runId: string;
  readonly testedCommit: string;
  readonly inputDigest: string;
  readonly scenarioId: string;
  readonly attempt: number;
}

export interface DrillCommandFact {
  readonly label: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly escalated: readonly string[];
  readonly stopConfirmed: boolean;
}

export interface DrillGitFacts {
  readonly repository: 'a' | 'b';
  readonly head: string;
  readonly tree: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headBeyondBase: boolean;
  readonly statusEntries: readonly string[];
  readonly worktreePath: string | null;
  readonly workspaceGone: boolean;
}

export interface DrillProcessFact {
  readonly pid: number;
  readonly label: string;
  readonly alive: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stopEscalated: readonly string[];
  readonly source: string;
}

export interface DrillArtifactFact {
  readonly projectId: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export interface DrillBusinessRows {
  readonly projects: readonly { readonly projectId: string; readonly featureId: string }[];
  readonly runs: readonly { readonly runId: string; readonly status: string }[];
  readonly attempts: readonly {
    readonly attemptId: string; readonly taskId: string; readonly runId: string;
    readonly status: string; readonly executionStage: string | null; readonly exitCode: number | null;
  }[];
  readonly tasks: readonly { readonly projectId: string; readonly taskId: string; readonly status: string }[];
  readonly workspaces: readonly { readonly branch: string; readonly baseCommit: string; readonly status: string }[];
  readonly verificationBatches: readonly { readonly batchId: string; readonly status: string; readonly attemptId: string }[];
}

export interface DrillBudgetFact {
  readonly runId: string;
  readonly attemptsCreated: number;
  readonly runtimeStarts: number;
  readonly deadlineAt: number | string | null;
}

export interface DrillEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'p07-5-drill-evidence';
  readonly identity: DrillEvidenceIdentity;
  readonly phase: 'before' | 'after';
  readonly collectedAtIso: string;
  readonly business: DrillBusinessRows;
  readonly budget: DrillBudgetFact | null;
  readonly git: readonly DrillGitFacts[];
  readonly processes: readonly DrillProcessFact[];
  readonly artifacts: readonly DrillArtifactFact[];
  readonly commands: readonly DrillCommandFact[];
  readonly concurrency: readonly Record<string, unknown>[];
  readonly timings: Readonly<Record<string, number>>;
}

export interface DrillCleanupFacts {
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown';
  readonly processStopped: boolean;
  readonly factsExported: boolean;
  readonly sqliteClosed: boolean;
  readonly resourcesRemoved: boolean;
  readonly retainedRoot: string | null;
  readonly reason?: string;
}

export interface DrillSpawnOptions {
  readonly label: string;
  /** 暂停写入屏障：FakeRuntime 在写入目标文件前挂起（gates: ['pause_write']）。 */
  readonly pauseWrite?: boolean;
  /** 进入验证/进入提交 IPC drill_barrier 屏障。 */
  readonly barriers?: { readonly verificationEntry?: boolean; readonly commitEntry?: boolean; readonly taskId?: string };
  /** Write a tracked progress file and a new untracked file on each Task. */
  readonly progressWrites?: boolean;
  readonly verifierTestCount?: number;
  /** Trusted fault injection: persist another live PID with an unmatching start identity. */
  readonly verifierIdentityOverride?: { readonly pid: number; readonly processGroupId: number; readonly startTime: string };
  /** 预置 Verifier hold 文件（检查命令启动后挂起，构成可终止的验证边界）。 */
  readonly verifierHold?: boolean;
  /** F-005：整体替换 FakeRuntime 脚本（含 lifecycle 故障注入与门闩引用）。 */
  readonly script?: Record<string, unknown>;
  /** F-005：记录故障演练装配（模式/真实有界通道/请求输出上限收窄）。 */
  readonly recording?: {
    readonly mode?: 'required' | 'best_effort';
    readonly channel?: { readonly slowConsumer?: boolean };
    readonly limits?: { readonly maxOutputBytes?: number };
  };
  /** F-012：通知渠道受控故障（hold 文件存在期间 local-results 投递失败）。 */
  readonly notificationFault?: boolean;
  /** 有界子进程生命周期（默认 150s/300s；演示闭环需要更长时显式放宽，上限 600s）。 */
  readonly closeTimeoutMs?: number;
  readonly watchdogMs?: number;
}

export interface DrillFixtureOptions {
  readonly taskCount?: 2 | 3;
  readonly prefix?: string;
  readonly stopAfter?: DrillFixtureStage;
  /** 部分初始化/清理观察：box 临时根创建后回调（测试断言清理事实）。 */
  readonly observeRoot?: (root: string) => void;
  readonly stepMs?: number;
}

export interface DrillFixture {
  readonly root: string;
  readonly homeDir: string;
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly markerDir: string;
  readonly evidenceDir: string;
  readonly projectA: DrillProjectFacts;
  readonly projectB: DrillProjectFacts;
  readonly evidence: EvidenceLog;
  readonly sensitiveSentinelValue: string;
  readonly bearerSentinelValue: string;
  readonly runtimeTarget: { readonly path: string; readonly content: string };
  readonly timings: Readonly<Record<string, number>>;

  /** 白名单 env（HOME/TMPDIR 指向沙箱）；不透传真实凭据环境。 */
  childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  /** 公开命令启动真实 Run（preview + execution.start；in-process 派发已静止）。 */
  startRun(project: 'a' | 'b'): Promise<{ readonly runId: string }>;
  /** 启动演练 Host 子进程（就绪屏障：ready → go → host_ready）。 */
  spawnDrillHost(options: DrillSpawnOptions): Promise<ManagedChild>;
  /** 等待/放行具名 drill 屏障（进入验证、进入提交）。 */
  awaitBarrier(child: ManagedChild, barrier: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  releaseBarrier(child: ManagedChild, barrier: string): void;
  /** F-005：放行子进程 FakeRuntime 具名门闩（受控生产屏障）。 */
  releaseGate(child: ManagedChild, name: string): void;
  /** F-005：放行慢消费者屏障（recording.channel.slowConsumer）。 */
  releaseRecordingConsumer(child: ManagedChild): void;
  /** F-012：受控通知故障点——hold 存在期间 local-results 投递失败，移除后恢复。 */
  plantNotificationFault(): void;
  releaseNotificationFault(): void;
  /** F-012：只读通知事实（deliveries/results，按 event_sequence 排序）。 */
  notificationFacts(): {
    readonly deliveries: ReadonlyArray<{ readonly id: string; readonly eventId: string; readonly channelId: string;
      readonly status: string; readonly attemptCount: number; readonly nextAttemptAt: number | null }>;
    readonly results: ReadonlyArray<{ readonly deliveryId: string; readonly attempt: number; readonly outcome: string }>;
  };
  /** F-012：受控时间推进——仅把指定 delivery 的 next_attempt_at 提前为 created_at
   * （p07-4 notification-vertical-fixture 同一模式）；不修改业务状态或投递结果。 */
  forceDeliveriesDue(ids: readonly string[]): void;
  /** F-005：真实有界通道事实（上限/峰值/溢出，来自 marker JSONL）。 */
  recordingChannelFacts(): Array<Record<string, unknown>>;
  /** 植入条件 post-commit 钩子（可信测试故障点：commit 落盘后阻塞回执事务）。 */
  plantCommitBoundary(project: 'a' | 'b'): void;
  /** 受控工具命令：有界超时走停止核验升级；记录退出事实。 */
  runCommand(label: string, argv: readonly string[], options?: { readonly timeoutMs?: number; readonly cwd?: string }): Promise<DrillCommandFact>;
  /** 受控工具命令（不等待；供取消场景外部终止）。 */
  spawnCommand(label: string, argv: readonly string[], options?: { readonly cwd?: string }): SampleProcess;
  commandFacts(): readonly DrillCommandFact[];
  /** 并发事实：记录参与者真实时间窗与两两重叠。 */
  runConcurrent(label: string, jobs: readonly { readonly id: string; readonly run: () => Promise<unknown> }[]): Promise<{
    readonly label: string;
    readonly participants: readonly { readonly id: string; readonly startedAtMs: number; readonly endedAtMs: number; readonly error: string | null }[];
    readonly pairs: readonly { readonly a: string; readonly b: string; readonly overlapped: boolean; readonly overlapMillis: number }[];
  }>;
  /** 公共元数据锁真实争用事实（第一持有期内第二请求被拒）。 */
  publicLockContentionFacts(project: 'a' | 'b'): Promise<{
    readonly first: { readonly acquired: boolean; readonly heldMs: number };
    readonly second: { readonly acquired: boolean; readonly rejectedReason: string | null; readonly attemptedDuringHold: boolean };
    readonly concurrentlyHeld: boolean;
  }>;

  runtimeStarts(): Array<Record<string, unknown>>;
  verifierMarker(): { readonly pid: number; readonly startedAtIso: string } | undefined;
  gitMarker(project: 'a' | 'b'): { readonly pid: number; readonly head: string; readonly startedAt: string } | undefined;
  workspaceRow(project: 'a' | 'b'): { readonly canonical_path: string; readonly branch: string; readonly base_commit: string; readonly status: string } | undefined;
  gitFacts(project: 'a' | 'b'): DrillGitFacts;
  /** 只读 SQLite 观察（业务状态建立的断言辅助，不做写事务）。 */
  q(sql: string, ...params: unknown[]): unknown;
  /** 采集结构化证据（身份绑定 + 脱敏 fail-closed + 落盘）。 */
  collectDrillEvidence(scenarioId: string, phase: 'before' | 'after', options?: { readonly runId?: string }): Promise<DrillEvidence>;
  lastEvidence(): DrillEvidence | null;
  /** 无绝对路径/无敏感内容的普通事实摘要。 */
  describeFacts(): Record<string, unknown>;
  /** 可观察清理：停止核验 → 事实导出 → 关闭 SQLite → 仅清理自有临时根。 */
  cleanup(options?: { readonly confirmStopped?: () => boolean }): Promise<DrillCleanupFacts>;
  /** cleanup_unconfirmed 后的测试收尾兜底（不作为验收路径）。 */
  forceDispose(): Promise<void>;
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 实现
 * ------------------------------------------------------------------ */

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const scenarioPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function sameRealPath(candidate: string, reference: string): boolean {
  const resolve = (path: string): string => {
    try { return realpathSync(path); } catch { return path; }
  };
  return resolve(candidate) === resolve(reference);
}

export async function openDrillFixture(options: DrillFixtureOptions = {}): Promise<DrillFixture> {
  const stepMs = options.stepMs ?? 1_000;
  const realHome = realpathSync(homedir());
  const realTmp = realpathSync(tmpdir());
  const protectedPaths = [REPO_ROOT, homedir()];
  const prepared: DrillFixtureStage[] = [];
  const timings: Record<string, number> = { prepareResourcesMs: 0, migrationMs: 0, processWaitMs: 0, cleanupMs: 0 };

  let env: IsolatedHostEnvironment | undefined;
  let box: CommandsTestFixture | undefined;
  let harness: Awaited<ReturnType<CommandsTestFixture['openTransactionalHarness']>> | undefined;
  let app: CoreApplication | undefined;
  let inputDigest = '';

  const stopAfter = (stage: DrillFixtureStage): void => {
    prepared.push(stage);
    if (options.stopAfter === stage) {
      finishPartialCleanup();
      throw new DrillFixturePartialInitError(stage, [...prepared], box?.root ?? '');
    }
  };

  function finishPartialCleanup(): void {
    try { harness?.close(); } catch { /* best effort */ }
    try { if (app !== undefined) app.close(); } catch { /* best effort */ }
    try { box?.cleanup(); } catch { /* best effort */ }
    try { if (env !== undefined) void env.dispose().catch(() => undefined); } catch { /* best effort */ }
  }

  try {
    /* 阶段 sandbox：隔离 Host 环境（子进程沙箱 + 白名单 env）。 */
    const prepareStart = Date.now();
    env = createIsolatedHostEnvironment({ prefix: options.prefix ?? 'shiploop-p07f002-' });
    stopAfter('sandbox');

    /* 阶段 box：真实临时资源（隔离 HOME、真实 SQLite、两个真实 Git 仓库）。 */
    box = createCommandsTestFixture({ prefix: `${options.prefix ?? 'shiploop-p07f002-'}box-` });
    options.observeRoot?.(box.root);
    timings.prepareResourcesMs = Date.now() - prepareStart;
    stopAfter('box');

    /* 运行期共享状态（清理前导出）。 */
    const sensitiveSentinelValue = `p07-sentinel-${randomUUID()}`;
    const bearerSentinelValue = `Bearer p07-${randomUUID().replace(/-/g, '')}`;
    const evidence = createEvidenceLog({
      secrets: [sensitiveSentinelValue, bearerSentinelValue],
      protectedStrings: [REPO_ROOT, homedir(), realHome],
    });
    const drillChildren: ManagedChild[] = [];
    const childExits = new Map<number, { code: number | null; signal: string | null; escalated: readonly string[] }>();
    const ownedProcesses: SampleProcess[] = [];
    const ownedTrees = new Map<number, OwnedProcessTree>();
    const cancelledPids = new Set<number>();
    const commandRecords: DrillCommandFact[] = [];
    const concurrencyRecords: Array<Record<string, unknown>> = [];
    const startedRunIds = new Set<string>();
    let lastCollected: DrillEvidence | null = null;
    let lastCleanupFailure: DrillCleanupFacts | null = null;
    let cleaned = false;
    let cleanupRecord: DrillCleanupFacts = {
      status: 'pending', processStopped: false, factsExported: false,
      sqliteClosed: false, resourcesRemoved: false, retainedRoot: box.root,
    };

    /* 阶段 application：公开 Core 装配（命令面）+ 只读迁移观察。 */
    const migrationStart = Date.now();
    harness = await box.openTransactionalHarness();
    timings.migrationMs = Date.now() - migrationStart;
    const probe: SqliteStorageSession = harness.session;
    app = await box.openApplication({
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: DRILL_FAKE_STRATEGY.runtime, providers: [{ providerId: DRILL_FAKE_STRATEGY.provider, models: [DRILL_FAKE_STRATEGY.model] }] },
      ]),
      nowUtcMs: () => SETUP_NOW,
    });
    /* 静止 in-process 派发：Run 保持 queued，由演练 Host 子进程认领。 */
    app.workExecution.enterQuiesce();
    stopAfter('application');

    const owner = box.localOwner();
    const publisher = createArtifactPublisher({
      artifacts: app.artifactStore,
      files: app.artifactFileStore,
      limits: { maxSizeBytes: 4_000_000, timeoutMs: 60_000 },
    });

    const submitCommand = async (operation: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      app!.commandService.submit(owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(SETUP_NOW).toISOString(),
        operation, payload, ...extra,
      } as never);
    const requireCompleted = (receipt: unknown, label: string): Record<string, unknown> => {
      const record = receipt as { status?: string; result?: unknown };
      if (record === null || typeof record !== 'object' || record.status !== 'completed' || record.result === null) {
        throw new Error(`drill 夹具命令失败（${label}）: ${JSON.stringify(receipt)}`);
      }
      return record.result as Record<string, unknown>;
    };

    requireCompleted(await submitCommand('settings.global.create', {
      schemaVersion: 2,
      strategies: { defaultStrategy: { ...DRILL_FAKE_STRATEGY } },
      policies: {
        deliveryPolicy: {
          commitMode: 'task_and_feature',
          gitIdentity: { name: 'P07 Drill Owner', email: 'p07-drill@example.test', confirmed: true },
        },
      },
    }, { scope: { kind: 'global' } }), 'settings.global.create');

    const setupProject = async (key: 'a' | 'b'): Promise<DrillProjectFacts> => {
      const repositoryPath = key === 'a' ? box!.repoDirA : box!.repoDirB;
      const registered = requireCompleted(await submitCommand('project.register', {
        repositoryPath, displayName: `P07 Drill ${key.toUpperCase()}`, description: null, labels: [],
      }, { scope: { kind: 'registration' } }), 'project.register');
      const projectId = (registered['project'] as { id: string }).id;
      const scope = { kind: 'project' as const, projectId };
      const phaseId = `phase-${key}`;
      requireCompleted(await submitCommand('phase.create', {
        id: phaseId, title: `演练阶段 ${key}`, description: null, labels: [],
      }, { scope }), 'phase.create');

      const taskIds: [string, string, ...string[]] = [`t-${key}1`, `t-${key}2`];
      if (options.taskCount === 3) taskIds.push(`t-${key}3`);
      const contents = Object.fromEntries(taskIds.map((id, index) =>
        [id, `# 演练需求（${key} / ${index + 1}）\n\nP07 故障演练规格正文，经公开入口建立依赖链。\n`]));
      const requirementArtifactIds: Record<string, string> = {};
      for (const taskId of taskIds) {
        const body = Buffer.from(contents[taskId], 'utf8');
        const published = await publisher.publishArtifact({
          projectId, kind: 'requirement', mediaType: 'text/markdown',
          expectedHash: sha256(body), locator: `requirements/drill-${key}-${taskId}.md`, content: [body],
        });
        requirementArtifactIds[taskId] = published.artifact.id;
      }

      const imported = requireCompleted(await submitCommand('feature.plan.import', {
        phaseId,
        plan: {
          schemaVersion: 1,
          feature: { title: `演练 Feature ${key}`, description: null, labels: [], sourceRefs: [] },
          tasks: taskIds.map((id, index) => ({
            id, title: `演练任务（${key} / ${index + 1}）`,
            acceptance: { criteria: ['经公开入口建立，依赖通过才解锁，不补写状态'] },
            requirementsRefs: [{ artifactId: requirementArtifactIds[id]! }],
            ...(index === 0 ? {} : { dependsOn: [taskIds[index - 1]!] }),
          })),
        },
      }, { scope, expectedRevision: 1 }), 'feature.plan.import');
      const featureId = (imported['feature'] as { id: string }).id;
      const featureRow = probe.database.prepare('SELECT plan_digest, revision FROM features WHERE id = ?')
        .get(featureId) as { plan_digest: string; revision: number };
      requireCompleted(await submitCommand('feature.plan.decide', {
        featureId, planDigest: featureRow.plan_digest, decision: 'approve', reason: 'P07 演练授权',
      }, { scope, expectedRevision: featureRow.revision }), 'feature.plan.decide');

      const detected = requireCompleted(await submitCommand('project.profile.detect', {}, { scope }), 'project.profile.detect');
      const candidate = detected['profile'];
      if (typeof candidate !== 'object' || candidate === null) {
        throw new Error(`project.profile.detect 未返回候选 Profile（${key}）`);
      }
      const revisionRow = probe.database.prepare('SELECT revision FROM project_profiles WHERE project_id = ? ORDER BY version DESC LIMIT 1')
        .get(projectId) as { revision: number } | undefined;
      if (revisionRow === undefined) throw new Error(`project.profile.detect 未持久化候选 Profile（${key}）`);
      requireCompleted(await submitCommand('project.profile.confirm', { profile: candidate },
        { scope, expectedRevision: revisionRow.revision }), 'project.profile.confirm');

      return {
        key, projectId, featureId, repositoryPath,
        taskIds: [...taskIds], dependentTaskId: taskIds[1], requirementArtifactIds,
      };
    };

    /* 阶段 project-a / project-b：两个项目（各自带依赖 Task，公开命令建立）。 */
    const projectA = await setupProject('a');
    stopAfter('project-a');
    const projectB = await setupProject('b');
    stopAfter('project-b');

    /* 阶段 barriers：标记目录与屏障文件路径。 */
    const markerDir = join(box.root, 'p07-5-markers');
    const evidenceDir = join(box.root, 'p07-5-evidence');
    const secretsDir = join(box.root, 'secrets');
    mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const verifierMarkerPath = join(markerDir, 'verifier-started.json');
    const verifierHoldPath = join(markerDir, 'verifier-hold');
    const notificationHoldPath = join(markerDir, 'notification-hold');
    writeFileSync(join(secretsDir, 'sentinel.env'),
      `# Synthetic fixture secret; must never appear in evidence text.\nP07_DRILL_SENTINEL=${sensitiveSentinelValue}\nHTTP_AUTHORIZATION=${bearerSentinelValue}\n`, 'utf8');
    const gitBarrierPaths: Record<'a' | 'b', { readonly marker: string; readonly hold: string }> = {
      a: { marker: join(box.repoDirA, '.git', 'p07-5-git-barrier.json'), hold: join(box.repoDirA, '.git', 'p07-5-git-hold') },
      b: { marker: join(box.repoDirB, '.git', 'p07-5-git-barrier.json'), hold: join(box.repoDirB, '.git', 'p07-5-git-hold') },
    };
    stopAfter('barriers');

    /* 输入摘要：同一夹具内稳定，绑定全部证据。 */
    inputDigest = sha256(JSON.stringify({
      kind: 'p07-5-drill-input',
      strategy: DRILL_FAKE_STRATEGY,
      budget: DRILL_BUDGET,
      runtimeTarget: DRILL_RUNTIME_TARGET,
      projects: [projectA, projectB].map(project => ({
        projectId: project.projectId, featureId: project.featureId,
        tasks: project.taskIds, repositoryBasename: basename(project.repositoryPath),
      })),
    }));
    prepared.push('complete');

    const projects: Readonly<Record<'a' | 'b', DrillProjectFacts>> = { a: projectA, b: projectB };
    const initialHeads: Readonly<Record<'a' | 'b', string>> = {
      a: box.gitHead('A'), b: box.gitHead('B'),
    };

    /* ---------------- 运行期 API ---------------- */

    const childEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
      const envMap: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: box!.homeDir,
        TMPDIR: join(box!.root, 'home'),
        NODE_NO_WARNINGS: '1',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete envMap[key];
        else envMap[key] = value;
      }
      return envMap;
    };

    const startRun = async (project: 'a' | 'b'): Promise<{ readonly runId: string }> => {
      const target = projects[project];
      const scope = { kind: 'project' as const, projectId: target.projectId };
      for (const taskId of target.taskIds) {
        requireCompleted(await submitCommand('execution.input.prepare', {
          featureId: target.featureId, taskId,
          items: [{
            purpose: taskId === target.taskIds[0] ? 'requirements' : 'spec',
            source: { kind: 'artifact', artifactId: target.requirementArtifactIds[taskId] },
          }],
        }, { scope }), 'execution.input.prepare');
      }
      const preview = await app!.executionPreview.previewExecution(target.projectId, {
        featureIds: [target.featureId], budget: DRILL_BUDGET,
      });
      if (preview.status !== 'ready') {
        throw new Error(`drill 预览失败（${project}）: ${JSON.stringify(preview)}`);
      }
      const receipt = await submitCommand('execution.start', {
        featureIds: [target.featureId], budget: DRILL_BUDGET, previewDigest: preview.previewDigest,
      }, { scope }) as unknown as { status: string; runId?: string };
      if (receipt.status !== 'accepted' || typeof receipt.runId !== 'string') {
        throw new Error(`drill 启动失败（${project}）: ${JSON.stringify(receipt)}`);
      }
      startedRunIds.add(receipt.runId);
      return { runId: receipt.runId };
    };

    const buildChildConfig = (spawnOptions: DrillSpawnOptions): Record<string, unknown> => {
      if (spawnOptions.closeTimeoutMs !== undefined && (!Number.isSafeInteger(spawnOptions.closeTimeoutMs)
        || spawnOptions.closeTimeoutMs < 1_000 || spawnOptions.closeTimeoutMs > 600_000)) {
        throw new Error('drill 夹具：closeTimeoutMs 必须在 1_000..600_000 内');
      }
      if (spawnOptions.watchdogMs !== undefined && (!Number.isSafeInteger(spawnOptions.watchdogMs)
        || spawnOptions.watchdogMs < 1_000 || spawnOptions.watchdogMs > 600_000)) {
        throw new Error('drill 夹具：watchdogMs 必须在 1_000..600_000 内');
      }
      if (spawnOptions.closeTimeoutMs !== undefined && spawnOptions.watchdogMs !== undefined
        && spawnOptions.watchdogMs <= spawnOptions.closeTimeoutMs) {
        throw new Error('drill 夹具：watchdogMs 必须大于 closeTimeoutMs');
      }
      const result = { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null };
      const steps: Array<Record<string, unknown>> = [];
      if (spawnOptions.pauseWrite === true) steps.push({ op: 'await_gate', name: 'pause_write' });
      steps.push({ op: 'write_file', path: DRILL_RUNTIME_TARGET.path, content: DRILL_RUNTIME_TARGET.content });
      steps.push({ op: 'tool_command', name: 'probe' });
      steps.push({ op: 'message', role: 'assistant', text: `P07-5 drill run (${spawnOptions.label})` });
      return {
        dataRoot: box!.dataRoot,
        dbPath: box!.dbPath,
        markerDir,
        fixtureRoot: box!.root,
        stopGraceMs: 200,
        stopConfirmMs: 1_000,
        closeTimeoutMs: spawnOptions.closeTimeoutMs ?? 150_000,
        watchdogMs: spawnOptions.watchdogMs ?? 300_000,
        gates: spawnOptions.pauseWrite === true ? ['pause_write'] : [],
        script: spawnOptions.script ?? { schemaVersion: 1, steps, result },
        recording: spawnOptions.recording,
        toolCommands: { probe: { argv: spawnOptions.progressWrites ? [process.execPath, '-e',
          "const fs = require('node:fs'); const p = 'progress.txt'; const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) + 1 : 1; fs.writeFileSync(p, String(n)); fs.writeFileSync('pending-' + n + '.txt', 'preserved progress ' + n);"
        ] : ['/usr/bin/true'], environment: {}, timeoutMs: 10_000 } },
        verifier: {
          checkRunner: CHECK_RUNNER,
          markerPath: verifierMarkerPath,
          holdPath: verifierHoldPath,
          targetPath: DRILL_RUNTIME_TARGET.path,
          expectedContent: DRILL_RUNTIME_TARGET.content,
          checkTimeoutMs: 60_000,
          holdBudgetMs: 120_000,
          waitAttemptTimeoutMs: 120_000,
          stopGraceMs: 500,
          stopConfirmMs: 2_000,
          testCount: spawnOptions.verifierTestCount ?? 1,
        },
        barriers: spawnOptions.barriers ?? {},
        verifierIdentityOverride: spawnOptions.verifierIdentityOverride,
        ...(spawnOptions.notificationFault === true ? { notification: { failWhileHold: notificationHoldPath } } : {}),
      };
    };

    const spawnDrillHost = async (spawnOptions: DrillSpawnOptions): Promise<ManagedChild> => {
      if (spawnOptions.verifierHold === true) writeFileSync(verifierHoldPath, 'hold\n', 'utf8');
      try { rmSync(verifierMarkerPath, { force: true }); } catch { /* stale marker */ }
      const child = env!.processes.spawn({
        scriptPath: DRILL_CHILD,
        config: buildChildConfig(spawnOptions),
        cwd: env!.sandboxRoot,
        env: env!.childEnv(),
        label: spawnOptions.label,
        readyTimeoutMs: 30_000,
        requireInside: env!.sandboxRoot,
      });
      drillChildren.push(child);
      void child.exited.then(exit => { childExits.set(child.pid, exit); }).catch(() => undefined);
      const waitStart = Date.now();
      try {
        await child.waitReady(30_000);
        child.releaseGo();
        await child.waitMessage('host_ready', 30_000);
      } finally {
        timings.processWaitMs += Date.now() - waitStart;
      }
      return child;
    };

    const awaitBarrier = async (child: ManagedChild, barrier: string, timeoutMs = 90_000): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeoutMs;
      const waitStart = Date.now();
      try {
        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`等待 drill_barrier ${barrier} 超时`);
          const message = await child.waitMessage(`drill_barrier:${barrier}`, remaining) as Record<string, unknown>;
          if (message['barrier'] === barrier) return message;
        }
      } finally {
        timings.processWaitMs += Date.now() - waitStart;
      }
    };

    const releaseBarrier = (child: ManagedChild, barrier: string): void => {
      child.send({ kind: 'release_drill_barrier', barrier });
    };

    const releaseGate = (child: ManagedChild, name: string): void => {
      child.send({ kind: 'release_gate', name });
    };

    const releaseRecordingConsumer = (child: ManagedChild): void => {
      child.send({ kind: 'release_recording_consumer' });
    };

    const plantNotificationFault = (): void => {
      writeFileSync(notificationHoldPath, 'hold\n', 'utf8');
    };

    const releaseNotificationFault = (): void => {
      rmSync(notificationHoldPath, { force: true });
    };

    const notificationFacts = () => {
      const deliveries = (probe.database.prepare(
        'SELECT id, event_id, channel_id, status, attempt_count, next_attempt_at FROM notification_deliveries ORDER BY event_sequence, id',
      ).all() as Array<{ id: string; event_id: string; channel_id: string; status: string; attempt_count: number; next_attempt_at: number | null }>)
        .map(row => ({ id: row.id, eventId: row.event_id, channelId: row.channel_id,
          status: row.status, attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at }));
      const results = (probe.database.prepare(
        'SELECT delivery_id, attempt, outcome FROM notification_delivery_results ORDER BY created_at, id',
      ).all() as Array<{ delivery_id: string; attempt: number; outcome: string }>)
        .map(row => ({ deliveryId: row.delivery_id, attempt: row.attempt, outcome: row.outcome }));
      return { deliveries, results };
    };

    const forceDeliveriesDue = (ids: readonly string[]): void => {
      const statement = probe.database.prepare('UPDATE notification_deliveries SET next_attempt_at = created_at WHERE id = ?');
      for (const id of ids) statement.run(id);
    };

    const recordingChannelFacts = (): Array<Record<string, unknown>> => {
      const path = join(markerDir, 'recording-channel.jsonl');
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
    };

    const plantCommitBoundary = (project: 'a' | 'b'): void => {
      const repositoryPath = projects[project].repositoryPath;
      const hooksDir = join(repositoryPath, '.git', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'post-commit'), GIT_HOOK, { mode: 0o755 });
      chmodSync(join(hooksDir, 'post-commit'), 0o755);
      writeFileSync(gitBarrierPaths[project].hold, 'hold\n', 'utf8');
    };

    const spawnTrackedCommand = (label: string, argv: readonly string[], cwd?: string, autoRecord = false): SampleProcess => {
      const startedAt = performance.now();
      const child = spawnSampleProcess({
        argv: [...argv],
        cwd: cwd ?? box!.root,
        env: childEnv(),
        label,
      });
      ownedProcesses.push(child);
      ownedTrees.set(child.pid, new OwnedProcessTree(child.pid));
      void child.exited.then(exit => {
        if (!autoRecord) return;
        commandRecords.push({
          label, argv: [...argv], exitCode: exit.code, signal: exit.signal,
          timedOut: false, cancelled: cancelledPids.has(child.pid),
          durationMs: Math.round(performance.now() - startedAt), escalated: exit.escalated, stopConfirmed: true,
        });
      }).catch(() => undefined);
      return child;
    };

    const runCommand = async (label: string, argv: readonly string[], runOptions: { readonly timeoutMs?: number; readonly cwd?: string } = {}): Promise<DrillCommandFact> => {
      const startedAt = Date.now();
      const child = spawnTrackedCommand(label, argv, runOptions.cwd, false);
      const timeoutMs = runOptions.timeoutMs ?? 10_000;
      let timedOut = false;
      let escalated: readonly string[] = [];
      let exit: { code: number | null; signal: string | null };
      const waitStart = Date.now();
      const waited = await child.waitExit(timeoutMs);
      timings.processWaitMs += Date.now() - waitStart;
      if (waited === null) {
        timedOut = true;
        const stopStart = Date.now();
        const stopped = await child.verifyStopped({ stepMs });
        timings.processWaitMs += Date.now() - stopStart;
        escalated = stopped.escalated;
        exit = { code: stopped.code, signal: stopped.signal };
      } else {
        exit = { code: waited.code, signal: waited.signal };
      }
      const fact: DrillCommandFact = {
        label, argv: [...argv], exitCode: exit.code, signal: exit.signal,
        timedOut, cancelled: cancelledPids.has(child.pid), durationMs: Date.now() - startedAt,
        escalated, stopConfirmed: !child.isAlive(),
      };
      commandRecords.push(fact);
      return fact;
    };

    const spawnCommand = (label: string, argv: readonly string[], spawnOptions: { readonly cwd?: string } = {}): SampleProcess => {
      const child = spawnTrackedCommand(label, argv, spawnOptions.cwd, true);
      return {
        ...child,
        kill(signal?: NodeJS.Signals): boolean {
          cancelledPids.add(child.pid);
          return child.kill(signal);
        },
      };
    };

    const runConcurrent = async (label: string, jobs: readonly { readonly id: string; readonly run: () => Promise<unknown> }[]) => {
      const participants = await Promise.all(jobs.map(async (job) => {
        const startedAtMs = Date.now();
        let error: string | null = null;
        try { await job.run(); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
        return { id: job.id, startedAtMs, endedAtMs: Date.now(), error };
      }));
      const pairs: Array<{ a: string; b: string; overlapped: boolean; overlapMillis: number }> = [];
      for (let i = 0; i < participants.length; i++) {
        for (let j = i + 1; j < participants.length; j++) {
          const first = participants[i]!;
          const second = participants[j]!;
          const overlapMillis = Math.max(0, Math.min(first.endedAtMs, second.endedAtMs) - Math.max(first.startedAtMs, second.startedAtMs));
          pairs.push({ a: first.id, b: second.id, overlapped: overlapMillis > 0, overlapMillis });
        }
      }
      const facts = { schemaVersion: 1, kind: 'drill-concurrency', label, participants, pairs };
      concurrencyRecords.push(facts as unknown as Record<string, unknown>);
      return facts;
    };

    const publicLockContentionFacts = async (project: 'a' | 'b') => {
      const repositoryPath = projects[project].repositoryPath;
      const gitCommonDir = join(repositoryPath, '.git');
      const repoIdentity = deriveObservedRepoIdentity(realpathSync(gitCommonDir));
      const lock = app!.gitPublicMetadataLock;
      const base = { repoIdentity, workspacePath: repositoryPath, gitCommonDir };
      const firstLease = await lock.acquire({ ...base, operationId: randomUUID() });
      const acquiredAt = Date.now();
      const secondAttemptStartedAt = Date.now();
      /* 立即挂接结果分支：争用拒绝不成为未处理 rejection，事实仍真实记录。 */
      const secondOutcome = lock.acquire({ ...base, operationId: randomUUID() }).then(
        lease => ({ ok: true as const, lease }),
        error => ({ ok: false as const, error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const releasedAt = Date.now();
      await firstLease.release();
      let second: { acquired: boolean; rejectedReason: string | null };
      const outcome = await secondOutcome;
      if (outcome.ok) {
        await outcome.lease.release();
        second = { acquired: true, rejectedReason: null };
      } else {
        const code = String((outcome.error as { code?: unknown })?.code ?? '');
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        second = {
          acquired: false,
          rejectedReason: code === 'resource_busy' || message.includes('resource_busy') ? 'resource_busy' : 'other',
        };
      }
      const facts = {
        schemaVersion: 1, kind: 'drill-lock-contention', label: `public-lock-${project}`,
        first: { acquired: true, acquiredAtMs: acquiredAt, releasedAtMs: releasedAt, heldMs: releasedAt - acquiredAt },
        second: { ...second, attemptedAtMs: secondAttemptStartedAt, attemptedDuringHold: secondAttemptStartedAt >= acquiredAt && secondAttemptStartedAt <= releasedAt },
        concurrentlyHeld: false,
      };
      concurrencyRecords.push(facts as unknown as Record<string, unknown>);
      return facts;
    };

    const runtimeStarts = (): Array<Record<string, unknown>> => {
      const path = join(markerDir, 'runtime-starts.jsonl');
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
    };

    const verifierMarker = (): { pid: number; startedAtIso: string } | undefined => {
      if (!existsSync(verifierMarkerPath)) return undefined;
      const parsed = JSON.parse(readFileSync(verifierMarkerPath, 'utf8')) as { pid: number; startedAtIso: string };
      return { pid: parsed.pid, startedAtIso: parsed.startedAtIso };
    };

    const gitMarker = (project: 'a' | 'b'): { pid: number; head: string; startedAt: string } | undefined => {
      const path = gitBarrierPaths[project].marker;
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; head: string; startedAt: string };
    };

    const workspaceRow = (project: 'a' | 'b') => {
      const rows = probe.database.prepare(
        'SELECT canonical_path, git_common_dir, branch, base_commit, status FROM managed_workspaces',
      ).all() as Array<{ canonical_path: string; git_common_dir: string; branch: string; base_commit: string; status: string }>;
      const repositoryPath = projects[project].repositoryPath;
      return rows.find(row => sameRealPath(row.git_common_dir, join(repositoryPath, '.git')));
    };

    const gitFacts = (project: 'a' | 'b'): DrillGitFacts => {
      const repositoryPath = projects[project].repositoryPath;
      const workspace = workspaceRow(project);
      const gitDir = workspace?.canonical_path ?? repositoryPath;
      const gitOptions = { home: box!.homeDir };
      const head = git(['rev-parse', 'HEAD'], gitDir, gitOptions).trim();
      const tree = git(['rev-parse', 'HEAD^{tree}'], gitDir, gitOptions).trim();
      const statusPorcelain = git(['status', '--porcelain=v1'], gitDir, gitOptions);
      const branch = workspace?.branch ?? 'main';
      const baseCommit = workspace?.base_commit ?? initialHeads[project];
      return {
        repository: project,
        head,
        tree,
        branch,
        baseCommit,
        headBeyondBase: head !== baseCommit,
        statusEntries: statusPorcelain.split('\n').filter(line => line.length > 0),
        worktreePath: workspace?.canonical_path ?? null,
        workspaceGone: false,
      };
    };

    const workerPids = (): number[] => {
      const found: number[] = [];
      const walk = (path: string, depth: number): void => {
        if (depth > 6) return;
        try {
          for (const name of readdirSync(path)) {
            const full = join(path, name);
            if (name === 'worker.pid') {
              const pid = Number(readFileSync(full, 'utf8'));
              if (Number.isSafeInteger(pid) && pid > 1) found.push(pid);
              continue;
            }
            try { if (statSync(full).isDirectory()) walk(full, depth + 1); } catch { /* gone */ }
          }
        } catch { /* gone */ }
      };
      walk(box!.root, 0);
      return found;
    };

    const q = (sql: string, ...params: unknown[]): unknown =>
      probe.database.prepare(sql).get(...params as never[]);

    const scenarioAttempts = new Map<string, number>();

    const collectDrillEvidence = async (
      scenarioId: string,
      phase: 'before' | 'after',
      collectOptions: { readonly runId?: string } = {},
    ): Promise<DrillEvidence> => {
      try {
        if (!scenarioPattern.test(scenarioId)) throw new DrillCaptureError(scenarioId, 'invalid_scenario');
        const attempt = (scenarioAttempts.get(scenarioId) ?? 0) + 1;
        scenarioAttempts.set(scenarioId, attempt);

        const projects_ = [projectA, projectB];
        const runs = (probe.database.prepare('SELECT id, status FROM runs').all() as Array<{ id: string; status: string }>)
          .map(row => ({ runId: row.id, status: row.status }));
        const attempts = (probe.database.prepare(
          'SELECT id, task_id, run_id, status, execution_stage, exit_code FROM attempts ORDER BY number',
        ).all() as Array<{ id: string; task_id: string; run_id: string; status: string; execution_stage: string | null; exit_code: number | null }>)
          .map(row => ({
            attemptId: row.id, taskId: row.task_id, runId: row.run_id,
            status: row.status, executionStage: row.execution_stage, exitCode: row.exit_code,
          }));
        const tasks = (probe.database.prepare(
          'SELECT project_id, id, status FROM tasks',
        ).all() as Array<{ project_id: string; id: string; status: string }>)
          .map(row => ({ projectId: row.project_id, taskId: row.id, status: row.status }));
        const workspaces = (probe.database.prepare(
          'SELECT branch, base_commit, status FROM managed_workspaces',
        ).all() as Array<{ branch: string; base_commit: string; status: string }>)
          .map(row => ({ branch: row.branch, baseCommit: row.base_commit, status: row.status }));
        const verificationBatches = (probe.database.prepare(
          'SELECT id, status, attempt_id FROM verification_batches',
        ).all() as Array<{ id: string; status: string; attempt_id: string }>)
          .map(row => ({ batchId: row.id, status: row.status, attemptId: row.attempt_id }));

        const runId = collectOptions.runId ?? [...startedRunIds].at(-1) ?? `drill-${randomUUID()}`;
        const budgetRow = (collectOptions.runId === undefined
          ? probe.database.prepare('SELECT attempts_created, runtime_starts, deadline_at FROM execution_batches ORDER BY created_at DESC LIMIT 1')
          : probe.database.prepare('SELECT eb.attempts_created AS attempts_created, eb.runtime_starts AS runtime_starts, eb.deadline_at AS deadline_at FROM execution_batches eb'
            + ' JOIN runs r ON r.batch_id = eb.id WHERE r.id = ?')
        ).get(...(collectOptions.runId === undefined ? [] : [collectOptions.runId]) as never[]) as
          | { attempts_created: number; runtime_starts: number; deadline_at: number | null }
          | undefined;
        const budget: DrillBudgetFact | null = budgetRow === undefined
          ? null
          : {
            runId, attemptsCreated: budgetRow.attempts_created,
            runtimeStarts: budgetRow.runtime_starts, deadlineAt: budgetRow.deadline_at,
          };

        const gitFactsList = [gitFacts('a'), gitFacts('b')];

        const census = await processRows();
        const censusAlive = (pid: number): boolean => census.some(row => row.pid === pid);
        const processes: DrillProcessFact[] = [];
        for (const child of drillChildren) {
          const exit = childExits.get(child.pid);
          processes.push({
            pid: child.pid, label: `host-child:${child.label}`, alive: child.isAlive(),
            exitCode: exit?.code ?? null, signal: exit?.signal ?? null,
            stopEscalated: exit?.escalated ?? [], source: 'managed-child',
          });
        }
        for (const child of ownedProcesses) {
          processes.push({
            pid: child.pid, label: child.label, alive: child.isAlive(),
            exitCode: null, signal: null, stopEscalated: [], source: 'sample-process',
          });
        }
        const verifier = verifierMarker();
        if (verifier !== undefined) {
          processes.push({
            pid: verifier.pid, label: 'verifier-check', alive: censusAlive(verifier.pid),
            exitCode: null, signal: null, stopEscalated: [], source: 'verifier-started.json',
          });
        }
        for (const project of ['a', 'b'] as const) {
          const hook = gitMarker(project);
          if (hook !== undefined) {
            processes.push({
              pid: hook.pid, label: `git-post-commit-hook:${project}`, alive: censusAlive(hook.pid),
              exitCode: null, signal: null, stopEscalated: [], source: 'p07-5-git-barrier.json',
            });
          }
        }
        for (const pid of workerPids()) {
          processes.push({
            pid, label: 'worker', alive: censusAlive(pid),
            exitCode: null, signal: null, stopEscalated: [], source: 'worker.pid',
          });
        }

        const artifacts: DrillArtifactFact[] = [];
        for (const project of projects_) {
          const rows = probe.database.prepare(
            'SELECT id, kind, content_hash, size_bytes FROM artifacts WHERE project_id = ?',
          ).all(project.projectId) as Array<{ id: string; kind: string; content_hash: string; size_bytes: number }>;
          for (const row of rows) {
            artifacts.push({
              projectId: project.projectId, artifactId: row.id, kind: row.kind,
              contentHash: row.content_hash, sizeBytes: row.size_bytes,
            });
          }
        }

        const testedCommit = git(['rev-parse', 'HEAD'], process.cwd(), { home: box!.homeDir }).trim();
        const collected: DrillEvidence = {
          schemaVersion: 1,
          kind: 'p07-5-drill-evidence',
          identity: {
            schemaVersionBrand: 'p07-5-drill', runId, testedCommit, inputDigest, scenarioId, attempt,
          },
          phase,
          collectedAtIso: new Date().toISOString(),
          business: {
            projects: projects_.map(project => ({ projectId: project.projectId, featureId: project.featureId })),
            runs, attempts, tasks, workspaces, verificationBatches,
          },
          budget,
          git: gitFactsList,
          processes,
          artifacts,
          commands: commandRecords.map(fact => ({ ...fact })),
          concurrency: concurrencyRecords.map(fact => ({ ...fact })),
          timings: { ...timings },
        };

        /* 脱敏 fail-closed：哨兵与开发机路径绝不进入证据。 */
        const serialized = JSON.stringify(collected);
        if (serialized.includes(sensitiveSentinelValue) || serialized.includes(bearerSentinelValue)) {
          throw new DrillCaptureError(scenarioId, 'sensitive_content');
        }
        for (const protectedPath of [REPO_ROOT, homedir(), realHome]) {
          if (serialized.includes(protectedPath)) throw new DrillCaptureError(scenarioId, 'protected_path');
        }
        writeFileSync(join(evidenceDir, `${scenarioId}.jsonl`), `${serialized}\n`, { flag: 'a' });
        lastCollected = collected;
        return collected;
      } catch (error) {
        if (error instanceof DrillCaptureError) throw error;
        throw new DrillCaptureError(scenarioId, error instanceof Error ? error.message.slice(0, 200) : 'collection_failed');
      }
    };

    const describeFacts = (): Record<string, unknown> => ({
      fixtureKind: 'p07-5-drill',
      sandboxBasename: basename(box!.root),
      projects: [projectA, projectB].map(project => ({
        key: project.key, projectId: project.projectId, featureId: project.featureId,
        taskIds: project.taskIds, dependentTaskId: project.dependentTaskId,
        repositoryBasename: basename(project.repositoryPath),
      })),
      runtimeTarget: { path: DRILL_RUNTIME_TARGET.path },
      runs: { started: startedRunIds.size },
      processes: {
        hostChildren: drillChildren.length,
        commands: ownedProcesses.length,
      },
      timings: { ...timings },
    });

    const removeHolds = (): void => {
      try { rmSync(verifierHoldPath, { force: true }); } catch { /* best effort */ }
      for (const project of ['a', 'b'] as const) {
        try { rmSync(gitBarrierPaths[project].hold, { force: true }); } catch { /* best effort */ }
      }
    };

    const terminateMarkerPids = async (): Promise<string[]> => {
      const unconfirmed: string[] = [];
      const targets: Array<{ pid: number; label: string }> = [];
      const verifier = verifierMarker();
      if (verifier !== undefined) targets.push({ pid: verifier.pid, label: 'verifier-check' });
      for (const project of ['a', 'b'] as const) {
        const hook = gitMarker(project);
        if (hook !== undefined) targets.push({ pid: hook.pid, label: `git-post-commit-hook:${project}` });
      }
      for (const pid of workerPids()) targets.push({ pid, label: 'worker' });
      const seen = new Set<number>();
      for (const target of targets) {
        if (seen.has(target.pid)) continue;
        seen.add(target.pid);
        try {
          try { process.kill(-target.pid, 'SIGKILL'); } catch { /* no group */ }
          try { process.kill(target.pid, 'SIGKILL'); } catch { /* exited */ }
        } catch {
          unconfirmed.push(`${target.label}:${target.pid}:signal_failed`);
        }
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const pending = targets.filter(target => {
          try { process.kill(target.pid, 0); return true; } catch { return false; }
        });
        if (pending.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (const target of targets) {
        try { process.kill(target.pid, 0); unconfirmed.push(`${target.label}:${target.pid}:still_alive`); } catch { /* gone */ }
      }
      /* 进程普查核验标记 PID 缺席（防 PID 复用误判）。 */
      try {
        const census = await processRows();
        for (const target of targets) {
          if (census.some(row => row.pid === target.pid)) unconfirmed.push(`census:${target.label}:${target.pid}`);
        }
      } catch {
        unconfirmed.push('census:unavailable');
      }
      return unconfirmed;
    };

    const cleanup = async (cleanupOptions: { readonly confirmStopped?: () => boolean } = {}): Promise<DrillCleanupFacts> => {
      if (cleaned) return cleanupRecord;
      const failures: string[] = [];
      const cleanupStart = Date.now();
      removeHolds();

      for (const child of drillChildren) {
        try {
          if (child.isAlive()) {
            const stopStart = Date.now();
            const stopped = await child.verifyStopped({ stepMs });
            timings.processWaitMs += Date.now() - stopStart;
            childExits.set(child.pid, stopped);
          }
        } catch (error) {
          failures.push(`host-child:${child.label}:exit_unconfirmed:${error instanceof Error ? error.name : 'unknown'}`);
        }
      }
      for (const child of ownedProcesses) {
        try {
          if (child.isAlive()) await child.verifyStopped({ stepMs });
        } catch (error) {
          failures.push(`command:${child.label}:exit_unconfirmed:${error instanceof Error ? error.name : 'unknown'}`);
        }
      }
      for (const tree of ownedTrees.values()) {
        try {
          if (!(await tree.finish(true))) failures.push(tree.diagnostic());
        } catch (error) {
          failures.push(`owned-tree:${String(error)}`);
        }
      }
      const processStopped = drillChildren.every(child => !child.isAlive())
        && ownedProcesses.every(child => !child.isAlive());
      if (!processStopped) failures.push('自有进程停止未确认');
      failures.push(...await terminateMarkerPids());

      let factsExported = false;
      try {
        const payload = {
          schemaVersion: 1, kind: 'p07-5-drill-cleanup-facts',
          describe: describeFacts(), timings: { ...timings },
          commands: commandRecords.map(fact => ({ ...fact })),
          concurrency: concurrencyRecords.map(fact => ({ ...fact })),
          lastEvidence: lastCollected === null ? null : { identity: lastCollected.identity, phase: lastCollected.phase },
        };
        writeFileSync(join(evidenceDir, 'cleanup-facts.json'), JSON.stringify(payload, null, 2), 'utf8');
        evidence.record('p075.drill.cleanup', payload.describe);
        factsExported = true;
      } catch (error) {
        failures.push(`事实导出失败:${error instanceof Error ? error.message : String(error)}`);
      }

      if (p07CaptureActive()) {
        const snapshot = await collectDrillEvidence('entry-final', 'after');
        observeP07Entry(box!.root, box!.dbPath, { drill: snapshot });
      }
      let sqliteClosed = true;
      try { harness!.close(); } catch { /* box.cleanup closes remainder */ }
      try { await app!.close(); } catch (error) {
        sqliteClosed = false;
        failures.push(`SQLite/应用关闭失败:${error instanceof Error ? error.name : 'unknown'}`);
      }

      if (cleanupOptions.confirmStopped?.() === false) failures.push('停止确认回调返回 false');

      if (failures.length > 0) {
        cleanupRecord = {
          status: 'failed', processStopped, factsExported, sqliteClosed,
          resourcesRemoved: false, retainedRoot: box!.root, reason: failures.join('; '),
        };
        lastCleanupFailure = cleanupRecord;
        timings.cleanupMs = Date.now() - cleanupStart;
        return cleanupRecord;
      }

      try {
        box!.cleanup();
        await env!.dispose();
      } catch (error) {
        cleanupRecord = {
          status: 'unknown', processStopped: true, factsExported, sqliteClosed,
          resourcesRemoved: false, retainedRoot: box!.root,
          reason: `临时根删除未确认:${error instanceof Error ? error.message : String(error)}`,
        };
        lastCleanupFailure = cleanupRecord;
        timings.cleanupMs = Date.now() - cleanupStart;
        return cleanupRecord;
      }
      cleaned = true;
      lastCleanupFailure = null;
      cleanupRecord = {
        status: 'passed', processStopped: true, factsExported, sqliteClosed: true,
        resourcesRemoved: !existsSync(box!.root), retainedRoot: null,
      };
      timings.cleanupMs = Date.now() - cleanupStart;
      return cleanupRecord;
    };

    const forceDispose = async (): Promise<void> => {
      if (cleaned) return;
      removeHolds();
      for (const child of drillChildren.splice(0)) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        try { await child.exited; } catch { /* already gone */ }
      }
      for (const child of ownedProcesses.splice(0)) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        try { await child.exited; } catch { /* already gone */ }
      }
      for (const tree of ownedTrees.values()) {
        try { tree.kill(); } catch { /* already gone */ }
      }
      await terminateMarkerPids().catch(() => undefined);
      try { harness!.close(); } catch { /* already closed */ }
      try { await app!.close(); } catch { /* already closed */ }
      try { box!.cleanup(); } catch { /* best effort */ }
      try { await env!.dispose(); } catch { /* best effort */ }
      cleaned = true;
      lastCleanupFailure = null;
      cleanupRecord = {
        status: 'passed', processStopped: true, factsExported: false, sqliteClosed: true,
        resourcesRemoved: !existsSync(box!.root), retainedRoot: null,
      };
    };

    const fixture: DrillFixture = {
      root: box.root,
      homeDir: box.homeDir,
      dataRoot: box.dataRoot,
      dbPath: box.dbPath,
      markerDir,
      evidenceDir,
      projectA,
      projectB,
      evidence,
      sensitiveSentinelValue,
      bearerSentinelValue,
      runtimeTarget: DRILL_RUNTIME_TARGET,
      get timings(): Readonly<Record<string, number>> { return { ...timings }; },

      childEnv,
      startRun,
      spawnDrillHost,
      awaitBarrier,
      releaseBarrier,
      releaseGate,
      releaseRecordingConsumer,
      recordingChannelFacts,
      plantNotificationFault,
      releaseNotificationFault,
      notificationFacts,
      forceDeliveriesDue,
      plantCommitBoundary,
      runCommand,
      spawnCommand,
      commandFacts: () => commandRecords.map(fact => ({ ...fact })),
      runConcurrent,
      publicLockContentionFacts,

      runtimeStarts,
      verifierMarker,
      gitMarker,
      workspaceRow,
      gitFacts,
      q,
      collectDrillEvidence,
      lastEvidence: () => lastCollected,
      describeFacts,
      cleanup,
      forceDispose,

      async dispose(): Promise<void> {
        /* 上一次清理失败（cleanup_unconfirmed）阻止验收：现场保留，直至显式
         * 重试成功或 forceDispose；不吞掉清理错误。 */
        const prior = lastCleanupFailure;
        const result = prior ?? await cleanup();
        if (result.status !== 'passed') {
          throw new AggregateError(
            [new Error(result.reason ?? 'cleanup failed')],
            `P07-5 演练夹具清理未确认，现场已保留：${box!.root}`,
          );
        }
      },
    };
    return fixture;
  } catch (error) {
    if (error instanceof DrillFixturePartialInitError) throw error;
    finishPartialCleanup();
    throw error;
  }
}
