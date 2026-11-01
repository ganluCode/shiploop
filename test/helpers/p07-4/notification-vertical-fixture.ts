/**
 * P07-4 / F-010 通知纵向闭环夹具（真实临时 Git/SQLite/数据根 + 受控检查进程 +
 * FakeRuntime + 真实进程内 Host；仅测试使用，不进 packages/）。
 *
 * 纪律：
 * - 项目/计划/授权/输入/Run 全部经公开命令建立（openBindingFixture 的
 *   project.register → feature.plan.import → decide → execution.input.prepare →
 *   preview → execution.start），项目 Profile 经公开 Core 装配入口确认；
 * - 业务执行经真实进程内 Host（startHost）驱动：调度器自动认领，FakeRuntime
 *   受信注入写入真实 worktree 文件并派发真实工具进程（进程身份可核验）；
 * - 验证经生产 NodeTaskVerificationExecutor 启动真实受控检查进程
 *   （p07-1 check-runner.mjs：自写启动标记、校验目标文件、输出协议行），
 *   通过后经公开 core.taskVerificationCompletion 收尾（真实 Git task commit）；
 * - 通知只经默认 Host 通知运行时产生（F-008 自动启动；渠道可受信注入）；
 *   本夹具不插入/修改通知表身份来制造完成状态。
 *
 * 唯一允许的直接 SQL：只读断言（q/probe）与 F-008 同一先例的受限时间模拟
 * （UPDATE notification_deliveries SET next_attempt_at = created_at，退避流逝）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost as launchHost } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import type { HostStartOptions } from '../../../packages/host/src/runtime/host-startup.ts';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { observeP07Entry } from '../p07-5/entry-observation.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createNodeTaskVerificationExecutor } from '../../../packages/core/src/application/node-task-verification.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import type { WorkspaceBaseline } from '../../../packages/core/src/ports/workspace.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION,
  RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../../../packages/core/src/ports/runtime-execution.ts';
import type { NotificationChannel } from '../../../packages/core/src/ports/notification-delivery.ts';
import { openBindingFixture, type BindingFixture } from '../p03-6/input-binding-fixture.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from '../host/index.ts';

export const CHECK_RUNNER = fileURLToPath(new URL('./p07-4-check-runner.mjs', import.meta.url));

/** FakeRuntime 写入并由真实检查进程校验的目标（worktree 相对路径）。 */
export const RUNTIME_TARGET = { path: 'src/p074-marker.ts', content: 'export const p074VerticalMarker = 1;\n' } as const;

/** 阻塞工作流固定预算（摘要稳定：preview 与 start 的 deadline 必须一致）。 */
const BLOCKED_BUDGET = {
  batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 2, deadlineUtcMs: 1_900_100_000_000 + 3_600_000 },
  run: { maxAttemptsPerRun: 4, runTimeLimitMs: 3_600_000 },
} as const;

const PROVIDERS = [{ providerId: 'test-provider', models: ['fake-model'] }];
const CATALOG = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: PROVIDERS }]);
const OWNER = createLocalOwnerPrincipal();

const SUCCESS_SCRIPT = {
  schemaVersion: 1,
  steps: [
    { op: 'write_file', path: RUNTIME_TARGET.path, content: RUNTIME_TARGET.content },
    { op: 'tool_command', name: 'probe' },
    { op: 'message', role: 'assistant', text: 'P07-4 F-010 vertical run' },
  ],
  result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
} as const;

export function healthyChannel(): NotificationChannel {
  return {
    channelId: 'local-results',
    async send(input) {
      if (input.signal.aborted) throw new Error('cancelled');
      return { channelId: 'local-results', deliveryId: input.deliveryId, attempt: input.attempt };
    },
    async cancel() { return true; },
  };
}

export function failingChannel(reason = 'channel down (F-010 injection)'): NotificationChannel {
  return {
    channelId: 'local-results',
    async send() { throw new Error(reason); },
    async cancel() { return true; },
  };
}

export interface VerifyingAttemptRow {
  readonly id: string; readonly task_id: string; readonly run_id: string; readonly feature_id: string;
  readonly project_id: string; readonly owner_id: string; readonly host_instance_id: string;
  readonly execution_version: number; readonly exit_code: number | null;
  readonly diagnostic_ref: string | null; readonly input_snapshot: string;
}

export interface BusinessFacts {
  readonly runs: string;
  readonly features: string;
  readonly attempts: string;
  readonly tasks: string;
  readonly gitOperations: string;
  readonly budget: string;
  readonly runtimeStarts: number;
  readonly headCommit: string;
}

export interface NotificationFacts {
  readonly deliveries: string;
  readonly results: string;
  readonly watermark: number;
}

export interface VerticalHostOptions {
  readonly channels?: readonly NotificationChannel[];
  /** 启动后立即停止通知轮次（确定性中断屏障；默认 false）。 */
  readonly quiesceNotifications?: boolean;
}

export interface NotificationVerticalFixture {
  readonly env: IsolatedHostEnvironment;
  readonly binding: BindingFixture;
  readonly projectId: string;
  readonly runId: string;
  readonly featureId: string;
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly markerDir: string;
  readonly requirementArtifactId: string;
  startHost(options?: VerticalHostOptions): Promise<RunningHost>;
  /** 等待并处理一个 verifying Attempt：真实检查进程 + 公开收尾。 */
  verifyNextAttempt(host: RunningHost, expectPass: boolean): Promise<{ attemptId: string; batchId: string; status: string }>;
  /** 驱动成功工作流到 Task passed（真实 Git task commit）。 */
  driveSuccess(host: RunningHost): Promise<{ attemptId: string; batchId: string; commit: string }>;
  /** 驱动失败工作流：检查持续失败直至代码额度耗尽 Task failed。 */
  driveFailure(host: RunningHost): Promise<void>;
  /** 公开命令创建第二个 Feature 并在启动前人工阻塞其 Task（task.approval.block）。 */
  createBlockedWorkflow(host: RunningHost, options?: BlockedWorkflowOptions): Promise<{ featureId: string; runId: string; taskId: string }>;
  submitCommand(host: RunningHost, operation: string, payload: Record<string, unknown>, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  businessFacts(): BusinessFacts;
  notificationFacts(): NotificationFacts;
  eventRows(): Array<{ id: string; sequence: number; event_type: string; aggregate_id: string }>;
  workspacePath(): string | undefined;
  verifierMarker(): { pid: number } | undefined;
  headCommit(): string;
  q(sql: string, ...params: unknown[]): any;
  /** F-008 同例退避流逝模拟：唯一允许的通知表写入（不改身份/次数/状态）。 */
  forceDeliveriesDue(ids: readonly string[]): void;
  closeHost(host: RunningHost): Promise<void>;
  cleanup(): Promise<void>;
}

export interface VerticalFixtureOptions {
  readonly prefix?: string;
  /** P07-5 / F-009：计划追加 t-2（dependsOn t-1），用于同一 Run 内制造失败结果。 */
  readonly secondTaskChain?: boolean;
}

/** P07-5 / F-009：阻塞工作流参数化（默认值与 P07-4 F-010 行为一致）。 */
export interface BlockedWorkflowOptions {
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly title?: string;
  readonly description?: string;
}

/** 有界等待（固定间隔轮询持久事实；不用 sleep 假装竞争）。 */
export async function waitFor(label: string, condition: () => boolean, timeoutMs = 30_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export async function openNotificationVerticalFixture(
  options: VerticalFixtureOptions = {},
): Promise<NotificationVerticalFixture> {
  const env = createIsolatedHostEnvironment({ prefix: options.prefix ?? 'shiploop-p074-f010-' });
  let host: RunningHost | undefined;
  let probe: SqliteStorageSession | undefined;
  let disposed = false;

  /* 公开入口建立项目/计划/授权/输入/Run（含交付策略与已确认 Git 身份）。 */
  const binding = await openBindingFixture({
    deliveryPolicy: {
      commitMode: 'task_and_feature',
      gitIdentity: { name: 'P07-4 F-010 Owner', email: 'p07-4-f010@example.test', confirmed: true },
    },
    ...(options.secondTaskChain === true ? { secondTask: true, secondTaskDependsOnFirst: true } : {}),
  });
  try {
    /* P06 起 Task 认领要求已确认项目 Profile：经公开 Core 装配入口建立。 */
    const scope = { kind: 'project' as const, projectId: binding.projectId };
    const profileNowMs = 1_900_000_100_000;
    const profileApp = await binding.box.openApplication({
      capabilityCatalog: binding.box.capabilityCatalog,
      nowUtcMs: () => profileNowMs,
    });
    try {
      const submitProfile = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
        const receipt = await profileApp.commandService.submit(OWNER, {
          schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(profileNowMs).toISOString(),
          operation, payload, ...extra,
        } as never);
        if (receipt.status !== 'completed' || receipt.result === null) {
          throw new Error(`project.profile 命令失败（${operation}）: ${JSON.stringify(receipt)}`);
        }
        return receipt as unknown as { result: Record<string, unknown> };
      };
      const detected = await submitProfile('project.profile.detect', {}, { scope });
      const candidate = detected.result['profile'];
      if (typeof candidate !== 'object' || candidate === null) throw new Error('profile.detect 未返回候选');
      const revisionRow = binding.query(
        'SELECT revision FROM project_profiles WHERE project_id = ? ORDER BY version DESC LIMIT 1',
        binding.projectId,
      ) as { revision: number } | undefined;
      if (revisionRow === undefined) throw new Error('project.profile.detect 未持久化候选 Profile');
      await submitProfile('project.profile.confirm', { profile: candidate }, { scope, expectedRevision: revisionRow.revision });
    } finally {
      await profileApp.close();
    }

    const markerDir = join(binding.box.root, 'p07-4-markers');
    mkdirSync(markerDir, { recursive: true });
    const verifierMarkerPath = join(markerDir, 'verifier-started.json');
    binding.session.close();
    probe = openSqliteStorageSession({ path: binding.box.dbPath, busyTimeoutMs: 2_000, busyRetryAttempts: 8 });

    const q = (sql: string, ...params: unknown[]): any => probe!.database.prepare(sql).get(...params as never[]);

    function startHost(hostOptions: VerticalHostOptions = {}): Promise<RunningHost> {
      if (host !== undefined) throw new Error('vertical fixture: 同一时刻只允许一个 Host 实例');
      const base: HostStartOptions = {
        dataRoot: binding.box.dataRoot,
        capabilityCatalog: CATALOG,
        env: {},
        workRuntimeFactory(context) {
          const requests = new Map<string, RuntimeExecutionRequest>();
          const fake = createFakeRuntime({
            providers: PROVIDERS,
            script: SUCCESS_SCRIPT as never,
            workspaceRoots: context.workspaceRoots,
            reader: context.reader,
            toolCommands: { probe: { argv: ['/usr/bin/true'], environment: {}, timeoutMs: 10_000 } } as never,
            commandProcess: createCommandProcessAdapter({ stopGraceMs: 200, stopConfirmMs: 1_000 }),
            commitCommandIdentity: (identity, launch) => {
              const request = requests.get(launch.invocationId);
              if (request === undefined) throw new TypeError('Unknown invocation');
              return context.commitCommandIdentity(identity, request);
            },
          });
          return {
            entries: [{
              descriptor: fake.descriptor,
              adapter: {
                ...fake.adapter,
                async start(request) {
                  requests.set(request.invocationId, request);
                  try {
                    const handle = await fake.adapter.start(request);
                    void handle.stopped.then(() => requests.delete(request.invocationId), () => undefined);
                    return handle;
                  } catch (error) {
                    requests.delete(request.invocationId);
                    throw error;
                  }
                },
              },
            }],
            eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`,
          };
        },
        ...(hostOptions.channels === undefined ? {} : { notificationChannels: hostOptions.channels }),
      };
      const started = launchHost(base).then(async (startedHost) => {
        if (hostOptions.quiesceNotifications === true) {
          startedHost.core.notificationRuntime.enterQuiesce();
        }
        return startedHost;
      });
      return started.then(startedHost => {
        host = startedHost;
        return startedHost;
      });
    }

    async function closeHost(target: RunningHost): Promise<void> {
      if (host !== target) throw new Error('vertical fixture: Host 实例不匹配');
      host = undefined;
      await target.close();
    }

    function pollVerifyingAttempt(timeoutMs: number, exclude: ReadonlySet<string>): Promise<VerifyingAttemptRow | null> {
      const statement = probe!.database.prepare(
        "SELECT id, task_id, run_id, feature_id, project_id, owner_id, host_instance_id, execution_version,"
        + ' exit_code, diagnostic_ref, input_snapshot FROM attempts'
        + " WHERE status = 'verifying' AND diagnostic_ref IS NOT NULL ORDER BY number DESC LIMIT 1",
      );
      const deadline = Date.now() + timeoutMs;
      return new Promise(resolve => {
        const poll = (): void => {
          const row = statement.get() as VerifyingAttemptRow | undefined;
          if (row !== undefined && !exclude.has(row.id)) { resolve(row); return; }
          if (Date.now() >= deadline) { resolve(null); return; }
          setTimeout(poll, 100);
        };
        poll();
      });
    }

    async function verifyNextAttempt(target: RunningHost, expectPass: boolean) {
      const handled = new Set<string>();
      const attempt = await pollVerifyingAttempt(60_000, handled);
      if (attempt === null) {
        const diagnostic = {
          attempts: probe!.database.prepare('SELECT id, task_id, run_id, status, execution_stage, diagnostic_ref, owner_id, host_instance_id FROM attempts ORDER BY number').all(),
          tasks: probe!.database.prepare('SELECT id, status, execution_version, revision FROM tasks ORDER BY id').all(),
          runs: probe!.database.prepare('SELECT id, status, reason, revision FROM runs ORDER BY id').all(),
          batches: probe!.database.prepare('SELECT id, status, attempts_created, runtime_starts, no_progress_runs FROM execution_batches ORDER BY id').all(),
        };
        throw new Error(`verifyNextAttempt: 等待 verifying Attempt 超时；state=${JSON.stringify(diagnostic)}`);
      }
      const workspace = probe!.database.prepare(
        'SELECT repository_binding_id, repository_binding_revision, repo_identity, canonical_path,'
        + ' git_common_dir, branch, base_commit FROM managed_workspaces WHERE feature_id = ?',
      ).get(attempt.feature_id) as {
        repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
        canonical_path: string; git_common_dir: string; branch: string; base_commit: string;
      } | undefined;
      if (workspace === undefined) throw new Error('vertical fixture: managed workspace missing');
      const baseline: WorkspaceBaseline = {
        repositoryBindingId: workspace.repository_binding_id,
        repositoryBindingRevision: workspace.repository_binding_revision,
        repoIdentity: workspace.repo_identity,
        canonicalPath: workspace.canonical_path,
        gitCommonDir: workspace.git_common_dir,
        branch: workspace.branch,
        baseCommit: workspace.base_commit,
      };
      const inspection = await createWorkspaceInspector({
        authorizedRoots: [binding.box.root],
        confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
      }).inspect(baseline);
      const identity = verificationCodeIdentity(inspection);
      const snapshot = JSON.parse(attempt.input_snapshot) as { approval: { checkPolicyDigest: string } };
      const now = () => Date.now();
      const processes = createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 2_000 });
      const executor = createNodeTaskVerificationExecutor({
        processes,
        verification: createSqliteVerificationStore(probe!, { nowUtcMs: now }),
        atomic: createSqliteAtomicCommandStore(probe!, { nowUtcMs: now }),
        artifacts: createSqliteArtifactStore(probe!, { nowUtcMs: now }),
        files: createArtifactFileStore({ dataRoot: binding.box.dataRoot }),
        resolveCwd: async () => workspace.canonical_path,
        resolveEnvironment: () => ({}),
        stopControl: target.core.verificationStops,
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
        batchId: `p07-4-verif-${attempt.id}`,
        operation: 'task.verify.checks',
        evidenceOperationId: randomUUID(),
        codeDigest: identity.codeDigest,
        codeIdentity: { headCommit: identity.headCommit, workingTreeDigest: identity.codeDigest, hasUncommittedChanges: true },
        policyDigest: snapshot.approval.checkPolicyDigest,
        environmentSummary: { runner: 'node', nodeVersion: process.version, platform: process.platform },
        plan: {
          status: 'ready',
          selectedChecks: [{
            checkKey: 'tests', scope: 'task' as const, kind: 'command' as const,
            /* 真实受控检查进程：启动即写标记；期望内容不匹配或 --fail 时确定性失败。 */
            argv: [process.execPath, '--no-warnings', CHECK_RUNNER, verifierMarkerPath,
              join(workspace.canonical_path, RUNTIME_TARGET.path),
              expectPass ? RUNTIME_TARGET.content : '--fail'],
            cwdRef: null, environmentRef: null, timeout: 60_000, required: true, requirementRefs: [],
          }],
        },
        targets: ['p07-4-f010'],
        signal: new AbortController().signal,
      });
      const status = result.status;
      const detail = JSON.stringify(result.results.map(item => ({ checkKey: item.checkKey, status: item.status, reason: item.reason })));
      if (expectPass) {
        if (status !== 'passed') {
          const saved = q('SELECT status, exit_code, output_tail, timed_out FROM check_results ORDER BY created_at DESC LIMIT 1');
          throw new Error(`verifyNextAttempt: 期望 passed 实际 ${status}; results=${detail}; saved=${JSON.stringify(saved)}`);
        }
        const completion = await target.core.taskVerificationCompletion.complete({
          identity: {
            projectId: attempt.project_id, attemptId: attempt.id, owner: attempt.owner_id,
            hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version,
          },
          taskId: attempt.task_id, runId: attempt.run_id, verificationBatchId: result.batchId,
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
        if (completion.outcome !== 'passed') {
          throw new Error(`verifyNextAttempt: 收尾结果 ${completion.outcome} ${completion.reason ?? ''}`);
        }
      } else {
        if (status !== 'failed') {
          throw new Error(`verifyNextAttempt: 期望 failed 实际 ${status}; results=${detail}`);
        }
        const completion = await target.core.taskVerificationCompletion.complete({
          identity: {
            projectId: attempt.project_id, attemptId: attempt.id, owner: attempt.owner_id,
            hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version,
          },
          taskId: attempt.task_id, runId: attempt.run_id, verificationBatchId: result.batchId,
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
          failures: { tests: 'code' },
        });
        if (completion.outcome !== 'code_failure') {
          throw new Error(`verifyNextAttempt: 失败收尾结果 ${completion.outcome} ${completion.reason ?? ''}`);
        }
      }
      return { attemptId: attempt.id, batchId: result.batchId, status };
    }

    async function driveSuccess(target: RunningHost) {
      const verified = await verifyNextAttempt(target, true);
      await waitFor('Task passed', () =>
        (q("SELECT status FROM tasks WHERE id = 't-1'") as { status: string } | undefined)?.status === 'passed', 30_000);
      const receipt = q('SELECT actual_commit FROM git_operations WHERE attempt_id = ? AND operation_type = ?', verified.attemptId, 'task_commit');
      if (receipt === undefined) throw new Error('driveSuccess: 缺少真实 task commit 回执');
      return { attemptId: verified.attemptId, batchId: verified.batchId, commit: receipt.actual_commit as string };
    }

    async function driveFailure(target: RunningHost) {
      for (;;) {
        const taskRow = q("SELECT status FROM tasks WHERE id = 't-1'") as { status: string } | undefined;
        if (taskRow?.status === 'failed') return;
        const verified = await verifyNextAttempt(target, false);
        void verified;
        await waitFor('失败收尾生效', () => {
          const row = q("SELECT status FROM tasks WHERE id = 't-1'") as { status: string } | undefined;
          return row?.status === 'failed' || row?.status === 'pending';
        }, 30_000);
      }
    }

    async function submitCommand(target: RunningHost, operation: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      const receipt = await target.core.commandService.submit(OWNER, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
        operation, payload, ...extra,
      } as never);
      if (receipt.status !== 'completed' && receipt.status !== 'accepted') {
        throw new Error(`vertical fixture 命令失败（${operation}）: ${JSON.stringify(receipt)}`);
      }
      return receipt as unknown as Record<string, unknown>;
    }

    async function createBlockedWorkflow(target: RunningHost, workflowOptions: BlockedWorkflowOptions = {}) {
      const phaseId = workflowOptions.phaseId ?? 'phase-2';
      const taskId = workflowOptions.taskId ?? 't-b';
      const scope = { kind: 'project' as const, projectId: binding.projectId };
      /* 新阶段避免与成功工作流的活动 Batch 冲突（active_batch_in_phase）。 */
      await submitCommand(target, 'phase.create', {
        id: phaseId, title: `阻塞工作流阶段 ${phaseId}`, description: null, labels: [],
      }, { scope });
      const imported = await submitCommand(target, 'feature.plan.import', {
        phaseId,
        plan: {
          schemaVersion: 1,
          feature: { title: workflowOptions.title ?? 'F-010 blocked workflow', description: null, labels: ['p07-4'], sourceRefs: [] },
          tasks: [{
            id: taskId, title: '人工阻塞任务', acceptance: { criteria: ['blocked workflow notification'] },
            requirementsRefs: [{ artifactId: binding.requirementArtifactId }],
          }],
        },
      }, { scope, expectedRevision: 1 });
      const featureId = ((imported as { result?: { feature?: { id?: string } } }).result?.feature?.id) ?? '';
      if (featureId === '') throw new Error('createBlockedWorkflow: feature.plan.import 未返回 feature id');
      const featureRow = q('SELECT plan_digest, revision FROM features WHERE id = ?', featureId) as { plan_digest: string; revision: number };
      await submitCommand(target, 'feature.plan.decide', {
        featureId, planDigest: featureRow.plan_digest, decision: 'approve', reason: 'F-010 blocked workflow',
      }, { scope, expectedRevision: featureRow.revision });
      await submitCommand(target, 'execution.input.prepare', {
        featureId, taskId,
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: binding.requirementArtifactId } }],
      }, { scope });
      const preview = await target.core.executionPreview.previewExecution(binding.projectId, {
        featureIds: [featureId], budget: BLOCKED_BUDGET,
      });
      if (preview.status !== 'ready') throw new Error(`createBlockedWorkflow: preview ${JSON.stringify(preview).slice(0, 600)}`);
      /* 确定性顺序：先停止调度器新认领（enterQuiesce），再启动 Run，再人工阻塞。
       * 调度 quiesce 后 execution.start 的派发信号不触发认领，task.approval.block
       * 在无人竞争的 Task 上落盘（task.action_required 事件）。通知运行时不受影响。 */
      target.core.workExecution.enterQuiesce();
      /* 成功工作流收尾后的异步状态推进可能使 preview 过期（preview_stale）：
       * 有界重试——重新预览后重试启动，不伪造通过。 */
      let previewReady = preview;
      let started: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 4 && started === undefined; attempt++) {
        try {
          started = await submitCommand(target, 'execution.start', {
            featureIds: [featureId],
            budget: BLOCKED_BUDGET,
            previewDigest: previewReady.previewDigest,
          }, { scope }) as Record<string, unknown>;
        } catch (error) {
          if (!String(error).includes('preview_stale') || attempt === 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 500));
          previewReady = await target.core.executionPreview.previewExecution(binding.projectId, {
            featureIds: [featureId],
            budget: BLOCKED_BUDGET,
          });
          if (previewReady.status !== 'ready') throw new Error(`createBlockedWorkflow: 重试 preview ${previewReady.status}`);
        }
      }
      const runId = (started as { runId?: string }).runId ?? '';
      if (runId === '') throw new Error('createBlockedWorkflow: execution.start 未返回 runId');
      const taskRevision2 = (q('SELECT revision FROM tasks WHERE id = ?', taskId) as { revision: number }).revision;
      await submitCommand(target, 'task.approval.block', {
        taskId, planDigest: featureRow.plan_digest,
        description: workflowOptions.description ?? 'F-010 manual block', responsibleParty: 'project-owner',
      }, { scope, expectedRevision: taskRevision2 });
      return { featureId, runId, taskId };
    }

    function businessFacts(): BusinessFacts {
      return {
        /* Run 行的 status/reason/revision 会随真实重启语义变化（restart_recovery/
         * interrupted），不属于“业务结果不变”断言范围；这里断言 Run 数量与
         * Task/Feature 结果、Attempt、Git 回执、预算与 HEAD 等持久业务事实。 */
        runs: JSON.stringify(probe!.database.prepare('SELECT COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM runs').all()),
        features: JSON.stringify(probe!.database.prepare('SELECT id, status, delivery_status FROM features ORDER BY id').all()),
        attempts: JSON.stringify(probe!.database.prepare('SELECT id, task_id, status, execution_version, number FROM attempts ORDER BY id').all()),
        tasks: JSON.stringify(probe!.database.prepare('SELECT id, status, revision, code_attempts_used FROM tasks ORDER BY id').all()),
        gitOperations: JSON.stringify(probe!.database.prepare('SELECT id, operation_type, status, actual_commit FROM git_operations ORDER BY id').all()),
        budget: JSON.stringify(probe!.database.prepare('SELECT attempts_created, runtime_starts, no_progress_runs FROM execution_batches ORDER BY id').all()),
        runtimeStarts: (q('SELECT runtime_starts FROM execution_batches') as { runtime_starts: number }).runtime_starts,
        headCommit: headCommit(),
      };
    }

    function notificationFacts(): NotificationFacts {
      return {
        deliveries: JSON.stringify(probe!.database.prepare(
          'SELECT id, event_id, channel_id, status, attempt_count, next_attempt_at FROM notification_deliveries ORDER BY event_sequence, id',
        ).all()),
        results: JSON.stringify(probe!.database.prepare(
          'SELECT delivery_id, attempt, outcome FROM notification_delivery_results ORDER BY created_at, id',
        ).all()),
        watermark: (q('SELECT last_scanned_sequence AS n FROM notification_scan_state WHERE channel_id = ?', 'local-results') as { n: number } | undefined)?.n ?? 0,
      };
    }

    function eventRows(): Array<{ id: string; sequence: number; event_type: string; aggregate_id: string }> {
      return probe!.database.prepare('SELECT id, sequence, event_type, aggregate_id FROM state_events ORDER BY sequence').all() as never;
    }

    function workspacePath(): string | undefined {
      return (q('SELECT canonical_path FROM managed_workspaces ORDER BY created_at LIMIT 1') as { canonical_path: string } | undefined)?.canonical_path;
    }

    function verifierMarker(): { pid: number } | undefined {
      try {
        return JSON.parse(readFileSync(verifierMarkerPath, 'utf8')) as { pid: number };
      } catch {
        return undefined;
      }
    }

    function headCommit(): string {
      const path = workspacePath();
      if (path === undefined) return '';
      const row = q('SELECT actual_commit FROM git_operations WHERE actual_commit IS NOT NULL ORDER BY created_at DESC LIMIT 1') as { actual_commit: string } | undefined;
      return row?.actual_commit ?? '';
    }

    function forceDeliveriesDue(ids: readonly string[]): void {
      const statement = probe!.database.prepare('UPDATE notification_deliveries SET next_attempt_at = created_at WHERE id = ?');
      for (const id of ids) statement.run(id);
    }

    async function cleanup(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        if (host !== undefined) {
          await host.close().catch(() => undefined);
          host = undefined;
        }
      } finally {
        observeP07Entry(binding.box.root, binding.box.dbPath);
        probe?.close();
        probe = undefined;
        /* binding.session 已提前关闭（只为让位给 Host 写者）；这里只回收临时资源。 */
        try {
          if (binding.session.isOpen()) binding.close();
          else binding.box.cleanup();
        } catch { /* 保留原始错误，不因清理抛出掩盖 */ }
        env.dispose();
      }
    }

    return {
      env, binding, projectId: binding.projectId, runId: binding.runId, featureId: binding.featureId,
      dataRoot: binding.box.dataRoot, dbPath: binding.box.dbPath, markerDir,
      requirementArtifactId: binding.requirementArtifactId,
      startHost, verifyNextAttempt, driveSuccess, driveFailure, createBlockedWorkflow, submitCommand,
      businessFacts, notificationFacts, eventRows, workspacePath, verifierMarker, headCommit,
      q, forceDeliveriesDue, closeHost, cleanup,
    };
  } catch (error) {
    try { binding.close(); } catch { /* 保留原始错误 */ }
    env.dispose();
    throw error;
  }
}
