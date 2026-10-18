/**
 * P03-6 / F-014 真实资源纵向集成门禁（前序正式导入 → 批准 → 有限授权 →
 * 认领 → 工作区准备入口 → 显式 Fake 装配执行真实文件/工具 → 构建 Host/CLI
 * 查询；真实 SQLite/Git/文件/受控进程，仅模型决策为 Fake）。
 *
 * 验收面（.dag_context.json F-014 第 1/3 条）：
 * - 真实 SQLite 断言一次启动预占（runtime_starts=1、单 Attempt）、唯一 Work
 *   Session/Attempt 关联（sessions_attempt_unique 部分唯一索引 + 行级绑定）、
 *   证据可核验（ArtifactVerifier hash/size + CLI 读取一致）、未装配 Verifier
 *   时明确暂停（attempt verifying、Task/Feature 不通过、依赖后继 t-2 不解锁）；
 * - 停止未确认时重开数据库仍保留隔离（execution_uncertain/quarantined、证据字节与
 *   已知指标保留、未知为 null）并拒绝替代执行（同 Task 再认领 conflict）；
 *   确认停止后才安全结束。
 *
 * 正式构建 CLI 入口（dist/bin.js）与 F-013 同一纪律；不读真实凭据、不调用
 * 模型、不修改开发仓库或用户 HOME（沙箱 HOME/数据根）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { startFakeHost } from '../../../packages/host/src/testing.ts';
import { connectToHost, startHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { evaluateTaskDag } from '../../../packages/core/src/application/task-dag.ts';
import {
  BINDING_NOW,
  openBindingFixture,
  type BindingFixture,
} from '../../helpers/p03-6/input-binding-fixture.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () =>
  createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);

const WRITE_PATH = 'f014-output.txt';
const WRITE_CONTENT = 'F-014 纵向真实写入字节（保留现场）。\n';

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  expect(existsSync(CLI_BIN)).toBe(true);
}, 570_000);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  const running = host;
  host = undefined;
  if (running !== undefined) {
    await running.close();
  }
  const box = fixture;
  fixture = undefined;
  box?.close();
});

interface WiredCase {
  readonly attemptId: string;
  readonly dataRoot: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly projectId: string;
  readonly runId: string;
}

/** 显式 Fake 装配（真实文件写 + 真实受控工具进程），经 Host 扫描完成认领/准备/执行。 */
async function openFakeCase(script: unknown, fakeExtra: Record<string, unknown> = {}): Promise<WiredCase> {
  fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  host = await startFakeHost({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: catalog(),
    env: {},
    fake: { providers, script, ...fakeExtra },
  });
  client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
  await host.core.workExecution.scan();
  await expect
    .poll(() => fixture!.query('SELECT id FROM attempts') as { id: string } | undefined, {
      timeout: 20_000,
    })
    .toBeDefined();
  const attempt = fixture.query('SELECT id FROM attempts') as { id: string };
  return {
    attemptId: attempt.id,
    dataRoot: fixture.box.dataRoot,
    homeDir: fixture.box.homeDir,
    workDir: fixture.box.root,
    projectId: fixture.projectId,
    runId: fixture.runId,
  };
}

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 经正式构建入口执行 CLI（沙箱 HOME/TMPDIR；异步 spawn 不阻塞 Host 事件循环）。 */
function runBuiltCli(wired: WiredCase, args: readonly string[]): Promise<CliOutcome> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: wired.homeDir,
    TMPDIR: wired.workDir,
  };
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, '--data-root', wired.dataRoot],
      { cwd: wired.workDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('built CLI timeout');
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        rejectSpawn(failure);
        return;
      }
      resolveSpawn({ status, stdout, stderr });
    });
  });
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * A. 全链路纵向：真实文件/工具执行 → 构建 CLI 查询 → SQLite 持久断言
 * ------------------------------------------------------------------ */

describe('F-014 真实资源纵向集成（构建 CLI + 真实 SQLite/Git/受控进程）', () => {
  it('导入→批准→授权→认领→准备→Fake 真实执行→构建 CLI 查询；启动预占一次、Session 唯一关联、证据可核验、未装配 Verifier 暂停且后继不解锁', async () => {
    const wired = await openFakeCase(
      {
        schemaVersion: 1,
        steps: [
          { op: 'read_input', purpose: 'requirements' },
          { op: 'write_file', path: WRITE_PATH, content: WRITE_CONTENT },
          { op: 'tool_command', name: 'marker' },
          { op: 'message', role: 'assistant', text: 'F-014 vertical done' },
          { op: 'usage', inputTokens: 7, outputTokens: 3, costUsdMicros: null },
        ],
        result: {
          terminal: 'completed',
          reason: null,
          exitCode: 0,
          signal: null,
          durationMs: 21,
          usage: { inputTokens: 7, outputTokens: 3, costUsdMicros: null },
        },
      },
      {
        toolCommands: {
          marker: {
            argv: [process.execPath, '-e', 'process.stdout.write("f014-tool-marker")'],
            timeoutMs: 10_000,
          },
        },
        commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
      },
    );
    await expect
      .poll(
        () =>
          client!.getWorkSession(wired.projectId, wired.attemptId).then((d) => d.attempt.status),
        { timeout: 20_000 },
      )
      .toBe('verifying');

    /* ---- 真实 SQLite：一次启动预占 + 唯一 Work Session/Attempt 关联 ---- */
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(fixture!.query('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({
      runtime_starts: 1,
      attempts_created: 1,
    });
    expect(fixture!.query('SELECT count(*) AS n FROM task_attempt_reservations')).toEqual({ n: 1 });
    const sessionRow = fixture!.query(
      "SELECT id, kind, status, attempt_id, result_ref FROM sessions",
    ) as { id: string; kind: string; status: string; attempt_id: string; result_ref: string | null };
    expect(sessionRow).toMatchObject({
      kind: 'work',
      status: 'stopped',
      attempt_id: wired.attemptId,
    });
    expect(sessionRow.result_ref).toEqual(expect.any(String));
    expect(fixture!.query('SELECT session_id FROM attempts')).toEqual({ session_id: sessionRow.id });
    expect(
      fixture!.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_attempt_unique'",
      ),
    ).toEqual({ name: 'sessions_attempt_unique' });

    /* ---- 未装配 Verifier：明确暂停，Task/Feature 不通过、后继不解锁 ---- */
    expect(fixture!.query("SELECT status, first_passed_at FROM tasks WHERE id = 't-1'")).toEqual({
      status: 'running',
      first_passed_at: null,
    });
    expect(fixture!.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
    const featureRow = fixture!.query('SELECT status FROM features') as { status: string };
    expect(featureRow.status).not.toBe('completed');
    const dag = evaluateTaskDag(
      createSqliteTaskDagStore(fixture!.session).readTaskDagView(wired.projectId, wired.runId),
      BINDING_NOW,
    );
    expect(dag.readyTaskIds).not.toContain('t-2');
    const t2 = dag.tasks.find((task) => task.taskId === 't-2');
    expect(t2).toBeDefined();
    expect(t2!.reason).not.toBe('ready');
    expect(t2!.dependencyIds).toEqual(['t-1']);
    await host!.core.workExecution.scan();
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });

    /* ---- 真实文件写入工作区（真实 Git worktree，untracked 字节保留） ---- */
    const workspaceRow = fixture!.query(
      'SELECT canonical_path, status FROM managed_workspaces',
    ) as { canonical_path: string; status: string };
    expect(workspaceRow.canonical_path).toEqual(expect.any(String));
    expect(readFileSync(join(workspaceRow.canonical_path, WRITE_PATH), 'utf8')).toBe(WRITE_CONTENT);
    const gitStatus = execFileSync('git', ['-C', workspaceRow.canonical_path, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(gitStatus).toContain(`?? ${WRITE_PATH}`);

    /* ---- 构建 CLI 查询：状态/证据结构化输出 ---- */
    const list = okResult(
      await runBuiltCli(wired, [
        'execution', 'sessions', '--project', wired.projectId, '--run', wired.runId, '--json',
      ]),
      'execution.sessions',
    );
    expect(list.records as readonly unknown[]).toHaveLength(1);
    expect((list.records as readonly Record<string, unknown>[])[0]).toMatchObject({
      attemptId: wired.attemptId,
      runtime: 'fake',
      executionState: 'awaiting_verification',
    });

    const detail = okResult(
      await runBuiltCli(wired, [
        'execution', 'session', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      'execution.session',
    );
    expect(detail.acceptance).toMatchObject({
      runtimeCompleted: true,
      stoppedConfirmed: true,
      awaitingVerification: true,
      verifierAssembled: false,
      taskAccepted: false,
      featureVerified: false,
    });
    expect((detail.runtimeResult as Record<string, unknown>).usage).toMatchObject({
      basis: 'synthetic',
      realConsumption: false,
    });

    /* ---- 证据可核验：结果正文 hash/size 经 ArtifactVerifier 复核，CLI 字节一致 ---- */
    const resultArtifactId = (detail.identity as Record<string, unknown>).resultRef as string;
    const verified = await fixture!.verifier.readVerifiedContent(wired.projectId, resultArtifactId);
    const settlementEvidence = okResult(
      await runBuiltCli(wired, [
        'execution', 'session-evidence', wired.attemptId, '--project', wired.projectId,
        '--artifact', resultArtifactId, '--json',
      ]),
      'execution.session-evidence',
    );
    expect(settlementEvidence.content).toBe(Buffer.from(verified.content).toString('utf8'));
    expect(settlementEvidence.content).toContain('runtime-settlement');

    const evidenceRefs = detail.evidence as readonly Record<string, unknown>[];
    const eventsRef = evidenceRefs.find((ref) => ref['kind'] === 'work-evidence-events');
    expect(eventsRef).toBeDefined();
    const eventsEvidence = okResult(
      await runBuiltCli(wired, [
        'execution', 'session-evidence', wired.attemptId, '--project', wired.projectId,
        '--artifact', eventsRef!['artifactId'] as string, '--json',
      ]),
      'execution.session-evidence',
    );
    const eventsText = eventsEvidence.content as string;
    expect(eventsText).toContain('tool_started');
    expect(eventsText).toContain('tool_finished');
    expect(eventsText).toContain('F-014 vertical done');
    await fixture!.verifier.readVerifiedContent(wired.projectId, eventsRef!['artifactId'] as string);
  });

  it('停止未确认时重开数据库保留隔离并拒绝替代执行与安全关闭；已知耗时/合成用量保留、未知为 null', async () => {
    const wired = await openFakeCase({
      schemaVersion: 1,
      steps: [
        { op: 'write_file', path: WRITE_PATH, content: WRITE_CONTENT },
        { op: 'message', role: 'assistant', text: 'F-014 uncertain stop' },
        { op: 'usage', inputTokens: 5, outputTokens: 2, costUsdMicros: null },
      ],
      result: {
        terminal: 'completed',
        reason: null,
        exitCode: 0,
        signal: null,
        durationMs: 34,
        usage: { inputTokens: 5, outputTokens: 2, costUsdMicros: null },
      },
      /* 监督边界故障注入：停止核验如实报告未知（不冒充已停止）。 */
      lifecycle: { stopped: { unconfirmed: true } },
    });
    /* 停止证据未确认：监督等待有界后保存 execution_uncertain（结果已存、占用隔离）。 */
    await expect
      .poll(
        () => (fixture!.query('SELECT status FROM attempts') as { status: string }).status,
        { timeout: 30_000 },
      )
      .toBe('interrupted');
    const sessionRow = fixture!.query('SELECT id, status, result_ref FROM sessions') as {
      id: string;
      status: string;
      result_ref: string | null;
    };
    expect(sessionRow.status).not.toBe('stopped');
    expect(sessionRow.result_ref).toEqual(expect.any(String));

    /* 重开数据库：隔离/占用/证据字节/已知指标原样保留；拒绝替代执行。 */
    const reopened = openSqliteStorageSession({ path: fixture!.session.path });
    try {
      expect(reopened.database.prepare('SELECT status FROM attempts').get()).toEqual({
        status: 'interrupted',
      });
      expect(
        reopened.database.prepare("SELECT count(*) AS n FROM workspace_leases WHERE state = 'quarantined'").get(),
      ).toEqual({ n: 3 });
      expect(reopened.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
      const persistedSession = reopened.database
        .prepare('SELECT status, result_ref FROM sessions WHERE id = ?')
        .get(sessionRow.id) as { status: string; result_ref: string };
      expect(persistedSession).toEqual({ status: sessionRow.status, result_ref: sessionRow.result_ref });

      /* 结果证据字节保留：已知耗时/合成用量不丢，未知（signal/cost）为 null。 */
      const verified = await fixture!.verifier.readVerifiedContent(
        wired.projectId,
        persistedSession.result_ref,
      );
      const evidence = JSON.parse(Buffer.from(verified.content).toString('utf8')) as {
        kind: string;
        execution: {
          result: {
            terminal: string;
            durationMs: number | null;
            signal: string | null;
            usage: { basis: string; inputTokens: number | null; costUsdMicros: number | null } | null;
          } | null;
        };
      };
      expect(evidence.kind).toBe('runtime-settlement');
      expect(evidence.execution.result?.terminal).toBe('completed');
      expect(evidence.execution.result?.durationMs).toBe(34);
      expect(evidence.execution.result?.signal).toBeNull();
      expect(evidence.execution.result?.usage).toMatchObject({
        basis: 'synthetic',
        inputTokens: 5,
        costUsdMicros: null,
      });

      /* 已写入工作区的真实字节保留（产品失败现场不自动删除）。 */
      const workspaceRow = reopened.database
        .prepare('SELECT canonical_path FROM managed_workspaces')
        .get() as { canonical_path: string };
      expect(readFileSync(join(workspaceRow.canonical_path, WRITE_PATH), 'utf8')).toBe(WRITE_CONTENT);

      /* 替代执行被拒绝：同 Task 再认领经既有认领端口 conflict（DAG 不就绪）。 */
      const snapshotRow = reopened.database
        .prepare('SELECT input_snapshot FROM attempts WHERE id = ?')
        .get(wired.attemptId) as { input_snapshot: string };
      const substituteClaims = createSqliteTaskClaimStore(reopened, {
        workspaceAuthority: fixture!.authority,
        nowUtcMs: () => BINDING_NOW,
      });
      expect(() =>
        substituteClaims.claimTask({
          claimKey: 'f014-substitute-claim',
          projectId: wired.projectId,
          runId: wired.runId,
          taskId: 't-1',
          owner: 'owner-1',
          hostInstanceId: 'host-1',
          expectedRevision: 1,
          executionVersion: 0,
          workspace: fixture!.workspace,
          leaseUntilUtcMs: BINDING_NOW + 600_000,
          inputSnapshot: JSON.parse(snapshotRow.input_snapshot),
        }),
      ).toThrowError(/Task claim rejected/);
      expect(reopened.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } finally {
      reopened.close();
    }

    /* 确认停止前不报告安全关闭：Host 关闭被拒绝且持写锁，重开装配同样被拒。 */
    await expect(host!.close()).rejects.toMatchObject({ code: 'resource_busy' });
    await expect(
      startHost({ dataRoot: wired.dataRoot, capabilityCatalog: catalog(), env: {}, lockTimeoutMs: 0 }),
    ).rejects.toBeDefined();
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(fixture!.query('SELECT runtime_starts FROM execution_batches')).toEqual({
      runtime_starts: 1,
    });
    /* 停止未知：Host 按设计拒绝关闭并保留现场（不自动删除失败现场）；本用例
     * Host 实例不重复关闭，loopback 监听随测试进程退出释放。 */
    host = undefined;
  });
});
