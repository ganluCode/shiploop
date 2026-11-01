/**
 * P07-5 / F-002 故障演练 Host 子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 在 p07-1 fault-barrier-host-child 的 ready/go 屏障协议与受信 Verifier 模式上，
 * 为 P07 阶段演练场景提供四个具名有界边界（全部可由父测试在可证明位置终止
 * 自有进程）：
 *
 * 1. 就绪（readiness）：ready → go → host_ready 有界 IPC 屏障；
 * 2. 暂停写入（pause-write）：FakeRuntime 门闩在写入工作区目标文件之前挂起，
 *    Runtime 已启动但目标文件尚未落盘；
 * 3. 进入验证（entered_verification）：生产 NodeTaskVerificationExecutor 启动
 *    真实检查命令进程（自写启动标记）后、批次定版前，drill_barrier IPC 屏障；
 * 4. 进入提交（entered_commit）：验证批次通过后、公开
 *    taskVerificationCompletion（真实 git commit + 回执事务）之前 drill_barrier
 *    IPC 屏障；父进程可另行在仓库植入条件 post-commit 钩子获得
 *    「commit 已落盘、回执未持久化」的第二个提交边界。
 *
 * 纪律（与 p07-1 相同）：项目/计划/授权/Run 均由父测试经公开入口建立；本进程
 * 只注入可信测试故障点（FakeRuntime 门闩、检查命令 hold、父进程植入的
 * post-commit 钩子），不补写业务表、不伪造通过记录。所有等待有界；watchdog
 * 兜底退出。FakeRuntime 只替代模型输出；Git、SQLite、文件与进程全部真实。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startHost } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { PI_RUNNER_BUFFER_BYTES, PI_RUNNER_BUFFER_EVENTS, PiRunnerEventChannel } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken, createFakeRuntimeGate } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { collectFakeRuntimeGateRefs } from '../../../packages/core/src/ports/fake-runtime-script.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createNodeTaskVerificationExecutor } from '../../../packages/core/src/application/node-task-verification.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import type { WorkspaceBaseline } from '../../../packages/core/src/ports/workspace.ts';
import type { RuntimeEvent, RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION,
  RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../../../packages/core/src/ports/runtime-execution.ts';
import type { RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import { readChildConfig } from '../host/child-runtime.ts';

const send = process.send?.bind(process);
if (!send) throw new Error('drill-host-child 必须以 IPC 通道启动');

/** 有界 drill IPC 屏障：上报后等待父进程 release_drill_barrier（同一 barrier 名）。 */
async function drillBarrier(barrier: string, context: Record<string, unknown>): Promise<void> {
  /* 每个屏障独立 kind：父进程 waitMessage 按 kind 精确匹配（消息缓冲不删除旧消息）。 */
  send!({ kind: `drill_barrier:${barrier}`, barrier, pid: process.pid, ...context });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', release);
      reject(new Error(`drill_barrier ${barrier}: 等待释放超时`));
    }, 90_000);
    const release = (message: unknown): void => {
      if (typeof message === 'object' && message !== null
        && (message as { kind?: unknown }).kind === 'release_drill_barrier'
        && (message as { barrier?: unknown }).barrier === barrier) {
        clearTimeout(timer);
        process.off('message', release);
        resolve();
      }
    };
    process.on('message', release);
  });
}

const config = readChildConfig();
for (const field of ['dataRoot', 'dbPath', 'markerDir', 'fixtureRoot'] as const) {
  if (typeof config[field] !== 'string' || (config[field] as string) === '') {
    throw new Error(`drill-host-child: ${field} 必须是非空字符串`);
  }
}
const verifierConfig = config.verifier === null || config.verifier === undefined
  ? undefined
  : config.verifier as {
    readonly checkRunner: string; readonly markerPath: string; readonly holdPath: string;
    readonly targetPath: string; readonly expectedContent: string;
    readonly checkTimeoutMs: number; readonly holdBudgetMs: number; readonly waitAttemptTimeoutMs: number;
    readonly stopGraceMs: number; readonly stopConfirmMs: number; readonly testCount?: number;
  };
if (verifierConfig !== undefined) {
  for (const field of ['checkRunner', 'markerPath', 'holdPath', 'targetPath', 'expectedContent'] as const) {
    if (typeof verifierConfig[field] !== 'string' || (verifierConfig[field] as string) === '') {
      throw new Error(`drill-host-child: verifier.${field} 必须是非空字符串`);
    }
  }
}
const barriers = config.barriers === null || config.barriers === undefined
  ? {}
  : config.barriers as { readonly verificationEntry?: boolean; readonly commitEntry?: boolean; readonly taskId?: string };
const closeTimeoutMs = typeof config.closeTimeoutMs === 'number' ? config.closeTimeoutMs : 150_000;
const watchdogMs = typeof config.watchdogMs === 'number' ? config.watchdogMs : 300_000;
/* 可信装配定时释放门闩（有限预算，watchdog 兜底）：暂停写入场景的正常续跑。 */
const gateRelease = config.gateRelease === null || config.gateRelease === undefined
  ? undefined
  : config.gateRelease as { readonly name: string; readonly afterMs: number };
if (gateRelease !== undefined) {
  if (typeof gateRelease.name !== 'string' || !Number.isSafeInteger(gateRelease.afterMs)
    || gateRelease.afterMs < 0 || gateRelease.afterMs > 180_000) {
    throw new Error('drill-host-child: gateRelease 参数非法');
  }
}

const markerDir = config.markerDir as string;
const runtimeStartsPath = join(markerDir, 'runtime-starts.jsonl');
const recordingChannelPath = join(markerDir, 'recording-channel.jsonl');
mkdirSync(markerDir, { recursive: true });

/* P07-5 / F-005 记录故障演练配置（可信测试装配；生产代码不感知）：
 * - recording.mode：显式用户记录策略（startHost workRecordingMode）；
 * - recording.channel：FakeRuntime 事件经真实 PiRunnerEventChannel（生产
 *   协议常量 64 事件/64KiB、满即 fail-closed）交付 Recorder；slowConsumer
 *   以受控消费屏障挂起 Recorder 拉取，制造慢消费者/队列背压；
 * - recording.limits.maxOutputBytes：经工厂 prepareRequest 收窄请求输出上限
 *   （可信装配行为；Recorder/发布限制保持生产默认）。 */
const recordingConfig = config.recording === null || config.recording === undefined
  ? undefined
  : config.recording as {
    readonly mode?: 'required' | 'best_effort';
    readonly channel?: { readonly slowConsumer?: boolean };
    readonly limits?: { readonly maxOutputBytes?: number };
  };
if (recordingConfig !== undefined && recordingConfig.mode !== undefined
  && recordingConfig.mode !== 'required' && recordingConfig.mode !== 'best_effort') {
  throw new Error('drill-host-child: recording.mode 必须是 required 或 best_effort');
}
const recordingMaxOutputBytes = recordingConfig?.limits?.maxOutputBytes;
if (recordingMaxOutputBytes !== undefined && (!Number.isSafeInteger(recordingMaxOutputBytes)
  || recordingMaxOutputBytes < 1 || recordingMaxOutputBytes > 8_388_608)) {
  throw new Error('drill-host-child: recording.limits.maxOutputBytes 必须是收窄正整数');
}
/* 慢消费者放行钩子：父进程 IPC release_recording_consumer 或溢出时自动释放。 */
let releaseRecordingConsumerHook: (() => void) | undefined;
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const kind = (message as { kind?: unknown }).kind;
  if (kind === 'release_gate' && typeof (message as { name?: unknown }).name === 'string') {
    gates[(message as { name: string }).name]?.release();
    return;
  }
  if (kind === 'release_recording_consumer') releaseRecordingConsumerHook?.();
});

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const capabilityCatalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);
const gates = Object.fromEntries((Array.isArray(config.gates) ? config.gates : [])
  .filter((name): name is string => typeof name === 'string')
  .map(name => [name, createFakeRuntimeGate()]));
/* F-005：脚本引用的门闩（await_gate/生命周期门闩）全部自动装配，可经
 * release_gate IPC 由父进程在可证明位置放行（受控生产屏障）。 */
for (const ref of collectFakeRuntimeGateRefs(config.script as never)) {
  if (!(ref in gates)) gates[ref] = createFakeRuntimeGate();
}
const toolCommands = config.toolCommands;

const watchdog = setTimeout(() => {
  process.stderr.write('drill-host-child: watchdog 超时\n');
  process.exit(9);
}, watchdogMs);

send({
  kind: 'ready', pid: process.pid, cwd: process.cwd(),
  home: process.env.HOME ?? '', tmpdir: process.env.TMPDIR ?? '',
});

function waitForClose(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      resolve(false);
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (typeof message === 'object' && message !== null
        && (message as { kind?: unknown }).kind === 'close') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve(true);
      }
    };
    process.on('message', onMessage);
  });
}

function waitForGate(timeoutMs: number): Promise<'go' | 'close'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      reject(new Error('drill-host-child: 等待父进程 go 屏障超时'));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (message === 'go') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('go');
        return;
      }
      if (typeof message === 'object' && message !== null
        && (message as { kind?: unknown }).kind === 'close') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('close');
      }
    };
    process.on('message', onMessage);
  });
}

const gate = await waitForGate(30_000);
if (gate === 'close') {
  clearTimeout(watchdog);
  process.exit(0);
}
if (gateRelease !== undefined) {
  setTimeout(() => gates[gateRelease.name]?.release(), gateRelease.afterMs);
}

const host: RunningHost = await startHost({
  dataRoot: config.dataRoot as string,
  capabilityCatalog,
  env: {},
  ...(recordingConfig?.mode === undefined ? {} : { workRecordingMode: recordingConfig.mode }),
  workRuntimeFactory(context) {
    const requests = new Map<string, RuntimeExecutionRequest>();
    const fake = createFakeRuntime({
      script: config.script,
      workspaceRoots: context.workspaceRoots,
      reader: context.reader,
      providers,
      gates,
      ...(toolCommands === undefined ? {} : { toolCommands: toolCommands as never }),
      ...(toolCommands === undefined ? {} : {
        commandProcess: createCommandProcessAdapter({
          stopGraceMs: typeof config.stopGraceMs === 'number' ? config.stopGraceMs : 200,
          stopConfirmMs: typeof config.stopConfirmMs === 'number' ? config.stopConfirmMs : 1_000,
        }),
        commitCommandIdentity: async (identity, launch) => {
          const request = requests.get(launch.invocationId);
          if (request === undefined) throw new TypeError('Unknown invocation');
          return context.commitCommandIdentity(identity, request);
        },
      }),
    });
    /* F-005：真实 PiRunnerEventChannel 包裹（生产有界通道与 fail-closed 语义）。
     * 溢出语义与 pi-adapter 一致：terminal failed + reason event_queue_backpressure
     * + 取消，已接受前缀保持可交付；队列峰值/上限事实写入 marker JSONL。 */
    const wrapRecordingChannel = (handle: Awaited<ReturnType<typeof fake.adapter.start>>, request: RuntimeExecutionRequest) => {
      if (recordingConfig?.channel === undefined) return handle;
      const channel = new PiRunnerEventChannel(() => { channelFacts.abandoned += 1; });
      const channelFacts = {
        schemaVersion: 1 as const, kind: 'p07-5-recording-channel',
        attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : null,
        invocationId: request.invocationId, sessionId: request.sessionId,
        bounds: { events: PI_RUNNER_BUFFER_EVENTS, bytes: PI_RUNNER_BUFFER_BYTES },
        slowConsumer: recordingConfig.channel.slowConsumer === true,
        pushed: 0, delivered: 0, highWaterEvents: 0, highWaterBytes: 0,
        overflow: false, abandoned: 0, lastAcceptedSequence: null as number | null,
      };
      let consumerReleased = !recordingConfig.channel.slowConsumer;
      let releaseConsumer!: () => void;
      const consumerGate = new Promise<void>(resolve => { releaseConsumer = resolve; });
      releaseRecordingConsumerHook = () => { consumerReleased = true; releaseConsumer(); };
      let settleWrapper!: (value: RuntimeExecutionResult) => void;
      const wrapperResult = new Promise<RuntimeExecutionResult>(resolve => {
        settleWrapper = value => { consumerReleased = true; releaseConsumer(); resolve(value); };
      });
      void handle.result.then(result => {
        if (!channelFacts.overflow) settleWrapper(result as RuntimeExecutionResult);
      }, () => { if (!channelFacts.overflow) settleWrapper({
        schemaVersion: 1, terminal: 'failed', reason: 'internal_error', exitCode: null,
        signal: null, durationMs: null, usage: null, lastEventSequence: channelFacts.lastAcceptedSequence,
      }); });
      const pump = (async () => {
        try {
          for await (const event of handle.events as AsyncIterable<RuntimeEvent>) {
            channelFacts.pushed += 1;
            const accepted = channel.push(event);
            const snapshot = channel.snapshot();
            if (snapshot.events > channelFacts.highWaterEvents) channelFacts.highWaterEvents = snapshot.events;
            if (snapshot.bytes > channelFacts.highWaterBytes) channelFacts.highWaterBytes = snapshot.bytes;
            if (!accepted) {
              channelFacts.overflow = true;
              settleWrapper({
                schemaVersion: 1, terminal: 'failed', reason: 'event_queue_backpressure',
                exitCode: null, signal: null, durationMs: null, usage: null,
                lastEventSequence: channelFacts.lastAcceptedSequence,
              });
              void handle.cancel().catch(() => undefined);
              break;
            }
            channelFacts.lastAcceptedSequence = event.sequence;
          }
        } catch { /* 生产适配器同样不以外来流异常阻塞控制通道 */ }
        channel.close();
        appendFileSync(recordingChannelPath, `${JSON.stringify(channelFacts)}\n`);
      })();
      void pump.catch(() => undefined);
      const inner = channel[Symbol.asyncIterator]();
      return {
        ...handle,
        events: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!consumerReleased) await consumerGate;
                const item = await inner.next();
                if (!item.done) channelFacts.delivered += 1;
                return item as IteratorResult<RuntimeEvent>;
              },
            };
          },
        },
        result: wrapperResult,
      };
    };
    return {
      entries: [{
        descriptor: fake.descriptor,
        adapter: {
          ...fake.adapter,
          async start(request) {
            appendFileSync(runtimeStartsPath, `${JSON.stringify({
              schemaVersion: 1,
              attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : null,
              invocationId: request.invocationId,
              sessionId: request.sessionId,
              executionVersion: request.executionVersion,
            })}\n`);
            requests.set(request.invocationId, request);
            return wrapRecordingChannel(await fake.adapter.start(request), request);
          },
        },
      }],
      eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`,
      ...(recordingMaxOutputBytes === undefined ? {} : {
        prepareRequest: async (request: RuntimeExecutionRequest) => ({ ...request,
          limits: { ...request.limits, maxOutputBytes: Math.min(request.limits.maxOutputBytes, recordingMaxOutputBytes) } }),
      }),
    };
  },
});

send({ kind: 'host_ready', pid: process.pid, port: host.port, hostInstanceId: host.hostInstanceId });

/* ------------------------------------------------------------------ *
 * 受信 Verifier 嵌入（与 p07-1 同一模式；持续循环支持多 Attempt/多项目）
 * ------------------------------------------------------------------ */

interface VerifyingAttemptRow {
  readonly id: string; readonly task_id: string; readonly run_id: string; readonly feature_id: string;
  readonly project_id: string;
  readonly owner_id: string; readonly host_instance_id: string; readonly execution_version: number;
  readonly exit_code: number | null; readonly diagnostic_ref: string | null; readonly input_snapshot: string;
}

function pollVerifyingAttempt(
  db: import('../../../packages/core/src/adapters/sqlite/session.ts').SqliteStorageSession['database'],
  timeoutMs: number,
  exclude: ReadonlySet<string>,
): Promise<VerifyingAttemptRow | null> {
  const statement = db.prepare("SELECT id, task_id, run_id, feature_id, project_id, owner_id, host_instance_id,"
    + " execution_version, exit_code, diagnostic_ref, input_snapshot FROM attempts"
    + " WHERE status = 'verifying' ORDER BY number DESC");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      const rows = statement.all() as VerifyingAttemptRow[];
      const row = rows.find(candidate => !exclude.has(candidate.id) && candidate.diagnostic_ref !== null);
      if (row !== undefined) { resolve(row); return; }
      if (Date.now() >= deadline) { resolve(null); return; }
      setTimeout(poll, 100);
    };
    poll();
  });
}

const runVerifierLoop = async (signal: AbortSignal): Promise<void> => {
  if (verifierConfig === undefined) return;
  const probe = openSqliteStorageSession({ path: config.dbPath as string });
  const handled = new Set<string>();
  try {
    while (!signal.aborted) {
      const attempt = await pollVerifyingAttempt(probe.database, 4_000, handled);
      if (attempt === null) {
        /* 无更多待验证 Attempt：短退避后继续（close 时由 abort 终止）。 */
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      handled.add(attempt.id);
      if (signal.aborted) return;
      const workspace = probe.database.prepare(
        'SELECT repository_binding_id, repository_binding_revision, repo_identity, canonical_path,'
        + ' git_common_dir, branch, base_commit FROM managed_workspaces WHERE feature_id = ?',
      ).get(attempt.feature_id) as {
        repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
        canonical_path: string; git_common_dir: string; branch: string; base_commit: string;
      } | undefined;
      if (workspace === undefined) throw new Error('drill-host-child: managed workspace missing');
      const baseline: WorkspaceBaseline = {
        repositoryBindingId: workspace.repository_binding_id,
        repositoryBindingRevision: workspace.repository_binding_revision,
        repoIdentity: workspace.repo_identity,
        canonicalPath: workspace.canonical_path,
        gitCommonDir: workspace.git_common_dir,
        branch: workspace.branch,
        baseCommit: workspace.base_commit,
      };
      /* 真实代码身份：生产 WorkspaceInspector 对真实 worktree 的只读观察。 */
      const inspection = await createWorkspaceInspector({
        authorizedRoots: [config.fixtureRoot as string],
        confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
      }).inspect(baseline);
      const identity = verificationCodeIdentity(inspection);
      const snapshot = JSON.parse(attempt.input_snapshot) as { approval: { checkPolicyDigest: string; planDigest: string } };
      const now = () => Date.now();
      const selectedBoundary = barriers.taskId === undefined || barriers.taskId === attempt.task_id;
      const processes = createCommandProcessAdapter({
        stopGraceMs: verifierConfig.stopGraceMs, stopConfirmMs: verifierConfig.stopConfirmMs,
      });
      const executor = createNodeTaskVerificationExecutor({
        processes: {
          ...processes,
          async start(...args) {
            const override = config.verifierIdentityOverride as
              { pid: number; processGroupId: number; startTime: string } | undefined;
            const handle = await processes.start(args[0], identity => args[1](
              override === undefined ? identity : { ...identity, ...override }), args[2]);
            if (barriers.verificationEntry !== true || !selectedBoundary) return handle;
            /* 进入验证边界：真实检查命令已启动（等待其自写启动标记，有界），
             * 批次尚未定版；阻塞 executor 使父进程可在此终止 Host 或放行。 */
            const markerDeadline = Date.now() + 10_000;
            while (!existsSync(verifierConfig.markerPath)) {
              if (Date.now() > markerDeadline) throw new Error('verifier marker 未在预算内出现');
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await drillBarrier('entered_verification', {
              attemptId: attempt.id, taskId: attempt.task_id, projectId: attempt.project_id,
            });
            return handle;
          },
        },
        verification: createSqliteVerificationStore(probe, { nowUtcMs: now }),
        atomic: createSqliteAtomicCommandStore(probe, { nowUtcMs: now }),
        artifacts: createSqliteArtifactStore(probe, { nowUtcMs: now }),
        files: createArtifactFileStore({ dataRoot: config.dataRoot as string }),
        resolveCwd: async () => workspace.canonical_path,
        resolveEnvironment: () => ({}),
        stopControl: host.core.verificationStops,
        confirmProcessIdentity: async () => {},
        nowUtcMs: now,
      });
      const result = await executor.start({
        projectId: attempt.project_id,
        featureId: attempt.feature_id,
        runId: attempt.run_id,
        taskId: attempt.task_id,
        attemptId: attempt.id,
        executionVersion: attempt.execution_version,
        batchId: `p07-5-drill-${attempt.id}`,
        operation: 'task.verify.checks',
        evidenceOperationId: randomUUID(),
        codeDigest: identity.codeDigest,
        codeIdentity: {
          headCommit: identity.headCommit,
          workingTreeDigest: identity.codeDigest,
          hasUncommittedChanges: true,
        },
        policyDigest: snapshot.approval.checkPolicyDigest,
        environmentSummary: { runner: 'node', nodeVersion: process.version, platform: process.platform },
        plan: {
          status: 'ready',
          selectedChecks: [{
            checkKey: 'tests', scope: 'task' as const, kind: 'command' as const,
            argv: [process.execPath, '--no-warnings', verifierConfig.checkRunner,
              verifierConfig.markerPath, selectedBoundary ? verifierConfig.holdPath : `${verifierConfig.holdPath}.unused`, verifierConfig.targetPath,
              verifierConfig.expectedContent, String(verifierConfig.holdBudgetMs),
              String(verifierConfig.testCount ?? 1)],
            cwdRef: null, environmentRef: null,
            timeout: verifierConfig.checkTimeoutMs, required: true, requirementRefs: [],
          }],
        },
        /* 目标清单须与复用的 p07-1 check-runner 协议行一致（结果解析校验）。 */
        targets: ['p07-1-f001'],
        signal,
      });
      send({
        kind: 'verifier_result', batchId: result.batchId, status: result.status,
        checks: result.results.map(item => ({ checkKey: item.checkKey, status: item.status, reason: item.reason })),
        testCount: result.results[0]?.testCount ?? null,
      });
      if (result.status !== 'passed') continue;
      if (barriers.commitEntry === true && selectedBoundary) {
        /* 进入提交边界：批次已通过、公开收尾（真实 commit + 回执）未开始。 */
        await drillBarrier('entered_commit', {
          attemptId: attempt.id, taskId: attempt.task_id, projectId: attempt.project_id,
          batchId: result.batchId,
        });
      }
      const completion = await host.core.taskVerificationCompletion.complete({
        identity: {
          projectId: attempt.project_id,
          attemptId: attempt.id,
          owner: attempt.owner_id,
          hostInstanceId: attempt.host_instance_id,
          executionVersion: attempt.execution_version,
        },
        taskId: attempt.task_id,
        runId: attempt.run_id,
        verificationBatchId: result.batchId,
        observation: {
          runtime: {
            result: {
              schemaVersion: RUNTIME_RESULT_SCHEMA_VERSION, terminal: 'completed', reason: null,
              exitCode: attempt.exit_code ?? 0, signal: null, durationMs: 1, usage: null, lastEventSequence: null,
            },
            stopped: {
              schemaVersion: RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION, confirmed: true,
              checkedAtUtc: new Date().toISOString(), detail: null,
            },
          },
          workspaceHeld: true,
          beforeIdentity: { headCommit: identity.headCommit, codeDigest: identity.codeDigest, executionDigest: snapshot.approval.checkPolicyDigest },
          afterIdentity: { headCommit: identity.headCommit, codeDigest: identity.codeDigest, executionDigest: snapshot.approval.checkPolicyDigest },
          testCounts: { tests: result.results[0]?.testCount ?? 1 },
        },
        failures: {},
      });
      send({
        kind: 'verifier_completion', outcome: completion.outcome, reason: completion.reason,
        receipt: { disposition: completion.receipt.disposition, waitingFor: completion.receipt.waitingFor },
        stopConfirmed: completion.stopConfirmed,
      });
    }
  } finally {
    probe.close();
  }
};

const verifierAbort = new AbortController();
const verifierDone = runVerifierLoop(verifierAbort.signal).catch((error: unknown) => {
  /* 夹具自身诊断：执行/收尾异常以结构化消息上报，不静默吞掉。 */
  send({
    kind: 'verifier_error',
    name: error instanceof Error && error.name ? error.name : 'unexpected',
    message: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
  });
  if (typeof (error as { details?: unknown })?.details === 'object'
    && (error as { details: unknown }).details !== null) {
    process.stderr.write(`drill-host-child verifier details: ${JSON.stringify((error as { details: unknown }).details)}\n`);
  }
});

const closed = await waitForClose(closeTimeoutMs);
if (!closed) {
  process.stderr.write('drill-host-child: 等待 close 屏障超时\n');
  verifierAbort.abort();
  clearTimeout(watchdog);
  process.exit(9);
}
verifierAbort.abort();
await verifierDone;
await host.close();
clearTimeout(watchdog);
send({ kind: 'closed', pid: process.pid });
process.exit(0);
