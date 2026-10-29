/**
 * P07-1 / F-001 真实 Host 故障屏障子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 在 p03-9 recovery-host-child 的 ready/go 屏障协议上扩展三类确定性边界，
 * 供父测试在「真实副作用已发生、业务回执尚未持久化」的精确位置终止 Host：
 *
 * 1. Runner 边界：FakeRuntime 经受控 tool_command 派发真实工具进程（父进程
 *    以 worker.pid/heartbeat 证据观察「Runner 正在写入」）；
 * 2. Verifier 边界：子进程作为受信 Verifier 嵌入，经生产
 *    NodeTaskVerificationExecutor 启动真实检查命令进程（check-runner.mjs，
 *    自写启动标记并可被 hold 文件屏障），批次经真实 SQLite 定版；
 * 3. Git 提交边界：验证通过后经公开 core.taskVerificationCompletion 收尾，
 *    由生产 task committer 执行真实 git commit；父进程在仓库植入条件
 *    post-commit 钩子（可信测试故障点，不替换生产服务），使 commit 已落盘
 *    而回执事务尚未持久化。
 *
 * 纪律：项目/计划/授权/Run 均由父测试经公开入口建立；本进程只注入可信
 * 测试故障点（FakeRuntime 门闩、检查命令 hold、post-commit 钩子由父进程
 * 植入），不补写业务表、不伪造通过记录。所有等待有界；watchdog 兜底退出。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startHost } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken, createFakeRuntimeGate } from '../../../packages/core/src/adapters/fake-runtime.ts';
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
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION,
  RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../../../packages/core/src/ports/runtime-execution.ts';
import { readChildConfig } from '../host/child-runtime.ts';

const send = process.send?.bind(process);

/** Trusted test-only IPC barrier after observable command/batch completion. */
async function verificationBarrier(kind: string): Promise<void> {
  send?.({ kind });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { process.off('message', release); reject(new Error(`${kind}: barrier timeout`)); }, 90_000);
    const release = (message: unknown) => {
      if ((message as { kind?: string })?.kind === `release_${kind}`) {
        clearTimeout(timer); process.off('message', release); resolve();
      }
    };
    process.on('message', release);
  });
}
if (!send) throw new Error('fault-barrier-host-child 必须以 IPC 通道启动');

const config = readChildConfig();
for (const field of ['dataRoot', 'dbPath', 'markerDir', 'fixtureRoot'] as const) {
  if (typeof config[field] !== 'string' || (config[field] as string) === '') {
    throw new Error(`fault-barrier-host-child: ${field} 必须是非空字符串`);
  }
}
const verifierConfig = config.verifier === null || config.verifier === undefined
  ? undefined
  : config.verifier as {
    readonly checkRunner: string; readonly markerPath: string; readonly holdPath: string;
    readonly targetPath: string; readonly expectedContent: string;
    readonly checkTimeoutMs: number; readonly holdBudgetMs: number; readonly waitAttemptTimeoutMs: number;
    readonly stopGraceMs: number; readonly stopConfirmMs: number;
    readonly testCount?: number; readonly descendantPath?: string;
  };
if (verifierConfig !== undefined) {
  for (const field of ['checkRunner', 'markerPath', 'holdPath', 'targetPath', 'expectedContent'] as const) {
    if (typeof verifierConfig[field] !== 'string' || verifierConfig[field] === '') {
      throw new Error(`fault-barrier-host-child: verifier.${field} 必须是非空字符串`);
    }
  }
}
const closeTimeoutMs = typeof config.closeTimeoutMs === 'number' ? config.closeTimeoutMs : 120_000;
const watchdogMs = typeof config.watchdogMs === 'number' ? config.watchdogMs : 240_000;
/* 可信装配定时释放门闩（有限预算，watchdog 兑底）：用于验证 Verifier 等待
 * 预算耗尽后 Host 仍可服务的场景；不提供任何远端/文件触发入口。 */
const gateRelease = config.gateRelease === null || config.gateRelease === undefined
  ? undefined
  : config.gateRelease as { readonly name: string; readonly afterMs: number };
if (gateRelease !== undefined) {
  if (typeof gateRelease.name !== 'string' || !Number.isSafeInteger(gateRelease.afterMs)
    || gateRelease.afterMs < 0 || gateRelease.afterMs > 180_000) {
    throw new Error('fault-barrier-host-child: gateRelease 参数非法');
  }
  setTimeout(() => gates[gateRelease.name]?.release(), gateRelease.afterMs);
}

const markerDir = config.markerDir as string;
const runtimeStartsPath = join(markerDir, 'runtime-starts.jsonl');
mkdirSync(markerDir, { recursive: true });

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const capabilityCatalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);
const gates = Object.fromEntries((Array.isArray(config.gates) ? config.gates : [])
  .filter((name): name is string => typeof name === 'string')
  .map(name => [name, createFakeRuntimeGate()]));
const toolCommands = config.toolCommands;

const watchdog = setTimeout(() => {
  process.stderr.write('fault-barrier-host-child: watchdog 超时\n');
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
      if (typeof message === 'object' && message !== null &&
          (message as { kind?: unknown }).kind === 'close') {
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
      reject(new Error('fault-barrier-host-child: 等待父进程 go 屏障超时'));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (message === 'go') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('go');
        return;
      }
      if (typeof message === 'object' && message !== null &&
          (message as { kind?: unknown }).kind === 'close') {
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

const host: RunningHost = await startHost({
  dataRoot: config.dataRoot as string,
  capabilityCatalog,
  env: {},
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
    return {
      entries: [{
        descriptor: fake.descriptor,
        adapter: {
          ...fake.adapter,
          async start(request) {
            appendFileSync(runtimeStartsPath, `${JSON.stringify({
              attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : null,
              invocationId: request.invocationId,
              sessionId: request.sessionId,
              executionVersion: request.executionVersion,
            })}\n`);
            requests.set(request.invocationId, request);
            return fake.adapter.start(request);
          },
        },
      }],
      eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`,
    };
  },
});

send({ kind: 'host_ready', pid: process.pid, port: host.port, hostInstanceId: host.hostInstanceId });

/* ------------------------------------------------------------------ *
 * 受信 Verifier 嵌入：真实检查进程 + 公开验证收尾入口
 * ------------------------------------------------------------------ */

interface VerifyingAttemptRow {
  readonly id: string; readonly task_id: string; readonly run_id: string; readonly feature_id: string;
  readonly project_id: string;
  readonly owner_id: string; readonly host_instance_id: string; readonly execution_version: number;
  readonly exit_code: number | null; readonly diagnostic_ref: string | null; readonly input_snapshot: string;
}

function pollVerifyingAttempt(db: import('../../../packages/core/src/adapters/sqlite/session.ts').SqliteStorageSession['database'],
  timeoutMs: number): Promise<VerifyingAttemptRow | null> {
  const statement = db.prepare("SELECT id, task_id, run_id, feature_id, project_id, owner_id, host_instance_id,"
    + " execution_version, exit_code, diagnostic_ref, input_snapshot FROM attempts"
    + " WHERE status = 'verifying' ORDER BY number DESC LIMIT 1");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      const row = statement.get() as VerifyingAttemptRow | undefined;
      if (row !== undefined && row.diagnostic_ref !== null) { resolve(row); return; }
      if (Date.now() >= deadline) { resolve(null); return; }
      setTimeout(poll, 100);
    };
    poll();
  });
}

const runVerifierLoop = async (signal: AbortSignal): Promise<void> => {
  if (verifierConfig === undefined) return;
  const probe = openSqliteStorageSession({ path: config.dbPath as string });
  try {
    const attempt = await pollVerifyingAttempt(probe.database, verifierConfig.waitAttemptTimeoutMs);
    if (attempt === null) {
      send({ kind: 'verifier_skipped', reason: 'attempt_wait_timeout' });
      return;
    }
    if (signal.aborted) { send({ kind: 'verifier_skipped', reason: 'aborted' }); return; }
    const workspace = probe.database.prepare(
      'SELECT repository_binding_id, repository_binding_revision, repo_identity, canonical_path,'
      + ' git_common_dir, branch, base_commit FROM managed_workspaces WHERE feature_id = ?',
    ).get(attempt.feature_id) as {
      repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
      canonical_path: string; git_common_dir: string; branch: string; base_commit: string;
    } | undefined;
    if (workspace === undefined) throw new Error('fault-barrier-host-child: managed workspace missing');
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
    const processes = createCommandProcessAdapter({
      stopGraceMs: verifierConfig.stopGraceMs, stopConfirmMs: verifierConfig.stopConfirmMs,
    });
    const executor = createNodeTaskVerificationExecutor({
      processes: {
        ...processes,
        async start(...args) {
          const handle = await processes.start(...args);
          if (config.verifierExitBarrier !== true) return handle;
          return { ...handle, result: handle.result.then(async result => {
            await verificationBarrier('verifier_command_exited');
            return result;
          }) };
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
      batchId: `p07-1-verif-${attempt.id}`,
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
            verifierConfig.markerPath, verifierConfig.holdPath, verifierConfig.targetPath,
            verifierConfig.expectedContent, String(verifierConfig.holdBudgetMs),
            String(verifierConfig.testCount ?? 1), ...(verifierConfig.descendantPath ? [verifierConfig.descendantPath] : [])],
          cwdRef: null, environmentRef: null,
          timeout: verifierConfig.checkTimeoutMs, required: true, requirementRefs: [],
        }],
      },
      targets: ['p07-1-f001'],
      ...(config.verifierBatchBarrier === true ? {
        assertCurrentIdentity: async () => {
          await verificationBarrier('verifier_check_saved');
          const current = await createWorkspaceInspector({ authorizedRoots: [config.fixtureRoot as string],
            confirmProcessIdentity: async process => ({ launchId: process.launchId }) }).inspect(baseline);
          return verificationCodeIdentity(current).codeDigest === identity.codeDigest;
        },
      } : {}),
      signal,
    });
    send({
      kind: 'verifier_result', batchId: result.batchId, status: result.status,
      checks: result.results.map(item => ({ checkKey: item.checkKey, status: item.status, reason: item.reason })),
      testCount: result.results[0]?.testCount ?? null,
    });
    if (result.status !== 'passed') return;
    if (config.verifierCompletionBarrier === true) await verificationBarrier('verifier_batch_finalized');
    /* 公开收尾入口：passed 批次经真实 task committer 提交并结算（真实 Git 副作用）。 */
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
  } finally {
    probe.close();
  }
};

const verifierAbort = new AbortController();
const verifierDone = verifierConfig === undefined
  ? Promise.resolve()
  : runVerifierLoop(verifierAbort.signal).catch((error: unknown) => {
    /* 夹具自身诊断：执行/收尾异常以结构化消息上报，不静默吞掉，也不因此
     * 拒绝后续 Host 协作关闭（屏障场景需要 Host 保持可服务）。 */
    send({
      kind: 'verifier_error',
      name: error instanceof Error && error.name ? error.name : 'unexpected',
      message: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
    });
    if (typeof (error as { details?: unknown })?.details === 'object'
      && (error as { details: unknown }).details !== null) {
      process.stderr.write(`fault-barrier-host-child verifier details: ${JSON.stringify((error as { details: unknown }).details)}\n`);
    }
  });

const closed = await waitForClose(closeTimeoutMs);
if (!closed) {
  process.stderr.write('fault-barrier-host-child: 等待 close 屏障超时\n');
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
