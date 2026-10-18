/**
 * F-008 P02-4 基线失败、未授权及执行异常的真实 CLI/Host 验收场景。
 *
 * 对应 docs/p02-4-acceptance-contract.md §2.1 冻结的必需检查（required）：
 * - `P02-FR2-BASELINE-FAILURE`（FR-2 基线失败）：固定非零退出、拒绝授权
 *   `not_run`、缺命令/未知脚本、超时 `timed_out`、显式取消 `cancelled`、停止
 *   未确认 `stop_unconfirmed` 保留占用、`preview_stale`；失败不撤销注册、不删
 *   证据、不冒充通过。
 *
 * 覆盖 F-008 五条验收：
 * 1. 获准的确定性失败命令（P02-3 nonzeroExit 样例）：`--wait` 保留实际非零
 *    子命令退出码（CLI 退出码 1、检查退出码固定 3）；持久检查 `failed` 并保存
 *    argv/cwdRef/environmentRef/timeoutMs/耗时/代码身份与输出制品证据（只读
 *    探针核对 `baseline_check_results`/`baseline_authorizations` 行）；overview
 *    仍显示已注册项目与失败健康（注册轴/健康轴独立），失败后成功基线才转
 *    healthy（后续必需检查不豁免）。
 * 2. 拒绝基线授权（`--decline`）：可查询 `not_run` + `authorization_rejected`、
 *    启动次数为零（marker 计数零、零检查行、零基线事件、哨兵不存在）；
 *    缺命令/未知脚本分别保留前序契约 `error`/`missing_command`、
 *    `error`/`unknown_script` 原因，不偷偷安装依赖、不替换命令、不修复仓库
 *    （仓库快照字节级一致、node_modules 不存在、缺命令可执行文件仍缺失）。
 * 3. 复用现有挂起/超时/显式取消用例（P02-3 样例语义 + F-007 pid 计数脚本
 *    模式），用真实受控进程验证 `timed_out` 与 `cancelled` 原因、pid 实际
 *    消失、部分输出保留；占用真实（在途期间另一提交 → `resource_busy`/
 *    `baseline_in_progress` 零持久副作用），停止核验确认后占用释放才可继续；
 *    spawnWriter 孙进程一并真实停止（不以父进程退出替代进程树停止）。停止
 *    未确认保持占用/不重跑的完整覆盖由前序 `supervised-process-stopping.test.ts`
 *    / `baseline-host-faults.test.ts` / `baseline-host-recovery.test.ts` 承担
 *    （F-001 §2.3 冻结回归清单；本套件复用其样例与停止核验语义，验收内无法
 *    经只读纪律伪造不可核验身份）；`preview_stale` 由
 *    `p02-3-baseline-preview-authorize.test.ts` 承担。
 * 4. 失败/取消后通过另一 CLI 查询结果；Host 显式 stop（三证据）重启后项目、
 *    失败检查与输出引用仍可读（逐字段一致）；基线失败不回滚注册、不删除
 *    失败证据、不豁免后续必需检查。
 * 5. 预期失败场景只有在错误/状态、输出及副作用断言均满足时才计为阶段 pass；
 *    保留实际非零子命令退出码（`--wait` 失败/超时 = 1、取消 = 1、拒绝回执
 *    resource_busy = 1、decline 业务完成 = 0），不把预期负例退出码改写为 0。
 *
 * 纪律与 F-003 ~ F-007 相同：写入全部经产品公共入口（真实
 * `packages/cli/dist/bin.js`），数据库只经 p02-2 只读探针核对；每个等待有限
 * 预算；结果查询来自新进程/新连接；证据脱敏导出（token/认证头不出现）；
 * 回收 fail-closed（停止未确认即保留资源与诊断）。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SAMPLES,
  NONZERO_EXIT_CODE,
  artifactContentDigest,
  assertDistCliBuilt,
  commandSampleCheck,
  createAcceptanceFixture,
  exportEvidenceDocument,
  extractHostIdentity,
  extractOperationSnapshot,
  openDataRootStorageProbe,
  scanForCredentialShapes,
  singleEnvelope,
  type AcceptanceFixture,
  type DistCliResult,
  type EvidenceDocumentInput,
  type OperationSnapshot,
} from '../../helpers/p02-4/index.ts';
import { UNKNOWN_PACKAGE_SCRIPT } from '../../helpers/p02-3/command-samples.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 挂起检查超时（ms）：明显大于启动/握手抖动，小于整体步骤预算。 */
const HANG_CHECK_TIMEOUT_MS = 2_500;
/** spawnWriter 检查超时（ms）。 */
const TREE_CHECK_TIMEOUT_MS = 3_000;

/* ------------------------------------------------------------------ *
 * 夹具与公共小工具
 * ------------------------------------------------------------------ */

const activeFixtures: AcceptanceFixture[] = [];

function useFixture(): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix: 'shiploop-p02-4-f008-', stepMs: 300 });
  activeFixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  const pending = activeFixtures.splice(0);
  for (const fixture of pending) {
    if (!fixture.disposed) {
      await fixture.dispose();
    }
  }
});

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  assertDistCliBuilt();
}, 570_000);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 有界轮询等待（不用固定 sleep）；超时即失败。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor 条件在 ${timeoutMs}ms 内未满足`);
}

function resultOf(result: DistCliResult): Record<string, unknown> {
  const envelope = singleEnvelope(result);
  expect(envelope.ok, result.stderr).toBe(true);
  return envelope.result as Record<string, unknown>;
}

/** 失败信封核验：退出码 + ok:false + 错误码（业务完成不以文本判定）。 */
function failureEnvelopeOf(
  result: DistCliResult,
  expectedExitCode: number,
  expectedCode: string,
): { command: string | null; error: { code: string; commandId?: unknown; details?: unknown } } {
  expect(result.exitCode, result.stderr).toBe(expectedExitCode);
  const envelope = singleEnvelope(result);
  expect(envelope.ok, result.stderr).toBe(false);
  const error = envelope.error;
  expect(error?.code, result.stderr).toBe(expectedCode);
  return {
    command: envelope.command,
    error: error as { code: string; commandId?: unknown; details?: unknown },
  };
}

function readHostToken(dataRoot: string): string {
  return readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8').trim();
}

/** 导出脱敏证据文档：凭据形状扫描为空 + 真实 token 不出现（fail-closed）。 */
function exportScannedEvidence(input: EvidenceDocumentInput, tokens: readonly string[]): string {
  const document = exportEvidenceDocument(input);
  expect(scanForCredentialShapes(JSON.parse(document))).toEqual([]);
  for (const token of tokens) {
    expect(document).not.toContain(token);
  }
  return document;
}

/** 命令检查计划条目（§6.1 线形状；argv 直接 spawn、无 shell）。 */
function commandCheck(
  checkKey: string,
  argv: readonly string[],
  timeoutMs = 60_000,
  cwdRef?: string,
): Record<string, unknown> {
  return {
    checkKey,
    kind: 'command',
    argv: [...argv],
    ...(cwdRef !== undefined ? { cwdRef } : {}),
    timeoutMs,
    required: true,
  };
}

function writePlanFile(fixture: AcceptanceFixture, checks: readonly unknown[]): string {
  const dir = join(fixture.root, 'plans');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `plan-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ checks }), 'utf8');
  return file;
}

/**
 * pid 计数挂起脚本（复用 F-007 writeHangCounterScript 模式）：追加启动行、
 * 记录自身 pid、写出部分输出后挂起（SIGTERM 可停；永不主动退出）。
 * 供 timed_out / cancelled 场景做「实际启动一次 + pid 实际停止 + 部分输出保留」
 * 的真实受控进程证据。
 */
function writePidHangScript(fixture: AcceptanceFixture, outputLine: string): string {
  const script = join(fixture.root, `pid-hang-${randomUUID().slice(0, 8)}.cjs`);
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.argv[2], 'launch\\n');",
      "fs.writeFileSync(process.argv[3], String(process.pid));",
      `process.stdout.write(${JSON.stringify(`${outputLine}\n`)});`,
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
}

function markerLaunchCount(markerFile: string): number {
  try {
    return readFileSync(markerFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/** 基线操作轮询：终态依据只来自持久检查状态（不来自 accepted 回执）。 */
async function pollTerminalOperation(
  fixture: AcceptanceFixture,
  dataRoot: string,
  operationId: string,
  budgetMs: number,
): Promise<OperationSnapshot> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await fixture.runDistCli(
      ['baseline', 'status', operationId, '--data-root', dataRoot, '--json'],
      { label: 'baseline-status-poll' },
    );
    expect(status.exitCode, status.stderr).toBe(0);
    const snapshot = extractOperationSnapshot(resultOf(status));
    if (snapshot.status !== 'accepted' && snapshot.status !== 'running' && snapshot.status !== 'cancelling') {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `基线操作 ${operationId} 在 ${budgetMs}ms 内未达终态（最后状态：${String(snapshot.status)}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/** 经另一 CLI 轮询列表至指定操作实际进入 running（实际运行就绪信号）。 */
async function pollListedOperationRunning(
  fixture: AcceptanceFixture,
  dataRoot: string,
  projectId: string,
  budgetMs: number,
  expectedOperationId?: string,
): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const list = await fixture.runDistCli(
      ['baseline', 'list', '--project', projectId, '--data-root', dataRoot, '--json'],
      { label: 'client-b-baseline-list' },
    );
    expect(list.exitCode, list.stderr).toBe(0);
    const records = (resultOf(list) as { records: Array<{ operationId: string; status: string }> }).records;
    const record = expectedOperationId === undefined
      ? records[0]
      : records.find((entry) => entry.operationId === expectedOperationId);
    if (record !== undefined) {
      // 运行前的合法中间态只有 accepted；出现其他状态说明场景假设被破坏。
      expect(['accepted', 'running']).toContain(record.status);
      if (record.status === 'running') {
        return record.operationId;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `基线操作 ${expectedOperationId ?? '(最新)'} 在 ${budgetMs}ms 内未进入 running（列表记录数：${records.length}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/* ------------------------------------------------------------------ *
 * 只读探针行形状（核对持久检查/授权/操作；绝不写业务状态）
 * ------------------------------------------------------------------ */

interface CheckResultProbeRow {
  readonly check_key: string;
  readonly argv_json: string;
  readonly cwd_ref: string | null;
  readonly environment_ref: string | null;
  readonly timeout_ms: number;
  readonly required: number;
  readonly status: string;
  readonly reason_code: string | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: number;
  readonly output_artifact_id: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

interface OperationProbeRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly authorization_id: string | null;
  readonly status: string;
  readonly reason_code: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

interface AuthorizationProbeRow {
  readonly id: string;
  readonly head_commit: string | null;
  readonly working_tree_digest: string;
  readonly has_uncommitted_changes: number;
  readonly plan_digest: string;
  readonly plan_json: string;
}

function checkRowsOf(probe: ReturnType<typeof openDataRootStorageProbe>, operationId: string): CheckResultProbeRow[] {
  return probe.selectAll<CheckResultProbeRow>(
    'SELECT check_key, argv_json, cwd_ref, environment_ref, timeout_ms, required, status, ' +
      'reason_code, exit_code, signal, timed_out, output_artifact_id, started_at, ended_at ' +
      'FROM baseline_check_results WHERE operation_id = ? ORDER BY created_at, id',
    [operationId],
  );
}

function operationRowOf(
  probe: ReturnType<typeof openDataRootStorageProbe>,
  operationId: string,
): OperationProbeRow | undefined {
  return probe.selectOne<OperationProbeRow>(
    'SELECT id, project_id, kind, authorization_id, status, reason_code, started_at, ended_at ' +
      'FROM baseline_operations WHERE id = ?',
    [operationId],
  );
}

function authorizationRowOf(
  probe: ReturnType<typeof openDataRootStorageProbe>,
  operationId: string,
): AuthorizationProbeRow | undefined {
  return probe.selectOne<AuthorizationProbeRow>(
    'SELECT a.id, a.head_commit, a.working_tree_digest, a.has_uncommitted_changes, a.plan_digest, a.plan_json ' +
      'FROM baseline_authorizations a JOIN baseline_operations o ON o.authorization_id = a.id WHERE o.id = ?',
    [operationId],
  );
}

/* ------------------------------------------------------------------ *
 * P02-FR2-BASELINE-FAILURE（验收 1/5）：确定性失败命令真实闭环
 * ------------------------------------------------------------------ */

describe('P02-FR2-BASELINE-FAILURE 确定性失败命令真实闭环', () => {
  it('获准确定性失败命令：固定非零退出码 + 持久 failed 检查（argv/cwd/环境引用/timeout/耗时/代码身份/输出证据）+ overview 注册/失败健康 + 失败不回滚注册', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const headCommit = f.repos.headOf('withHead');
    const checkKey = 'p02-4-failure-nonzero';
    const timeoutMs = 60_000;

    // 仓库快照（失败不得修复/改动仓库）。
    const before = f.snapshotRepository(repoPath);

    // CLI A：正式 init 注册受检仓库（首个应用命令自动启动 Host）。
    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '基线失败验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);

    // 获准的确定性失败命令（P02-3 nonzeroExit 样例；cwdRef 落在仓库 src/ 子目录，
    // 连同 argv/environmentRef/timeout 一并进入持久检查行）。
    const failureCheck = commandSampleCheck('nonzeroExit', { checkKey, timeoutMs, cwdRef: 'src' });
    const plan = { checks: [failureCheck] };
    const planFile = writePlanFile(f, plan.checks);

    // CLI A：baseline run --confirm --wait → 实际非零子命令退出码保留（1）。
    const run = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', planFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-a-baseline-run-wait' },
    );
    expect(run.exitCode, run.stderr).toBe(1);
    expect(run.signal).toBeNull();
    const runResult = resultOf(run);
    expect(runResult.state).toBe('failed');
    expect(runResult.status).toBe('completed');
    expect(runResult.reasonCode).toBeUndefined();
    const operationId = runResult.operationId as string;
    expect(operationId).toMatch(UUID_V4_PATTERN);
    const runChecks = runResult.checks as Array<Record<string, unknown>>;
    expect(runChecks).toHaveLength(1);
    expect(runChecks[0]).toMatchObject({
      checkKey,
      status: 'failed',
      required: true,
      timedOut: false,
      exitCode: NONZERO_EXIT_CODE,
      durationMs: expect.any(Number) as number,
    });
    expect(runChecks[0]!.reasonCode).toBeUndefined();
    const artifactId = (runChecks[0]!.output as { artifactId: string }).artifactId;
    expect(artifactId).toMatch(UUID_V4_PATTERN);
    const durationMs = runChecks[0]!.durationMs as number;
    expect(durationMs).toBeGreaterThanOrEqual(0);

    // CLI B（另一进程/新连接）查询同一结果：failed 不因客户端不同而变形。
    const statusB = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', operationId, '--data-root', root, '--json'], {
          label: 'client-b-baseline-status',
        }),
      ),
    );
    expect(statusB.operationId).toBe(operationId);
    expect(statusB.status).toBe('completed');
    expect(statusB.state).toBe('failed');
    expect(statusB.checks[0]).toMatchObject({
      checkKey,
      status: 'failed',
      exitCode: NONZERO_EXIT_CODE,
      reasonCode: null,
      output: { artifactId, truncated: false },
    });

    // 输出制品正文可校验（新进程/新连接；stderr 前缀流形状）。
    const evidenceB = await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], {
      label: 'client-b-evidence',
    });
    const evidenceResult = resultOf(evidenceB) as { artifactId: string; byteSize: number; content: string };
    expect(evidenceResult.artifactId).toBe(artifactId);
    expect(evidenceResult.content).toBe(`[stderr]sample-nonzero-exit:${NONZERO_EXIT_CODE}\n`);
    expect(evidenceResult.byteSize).toBe(evidenceResult.content.length);

    // 持久检查行（只读探针）：argv/cwd/环境引用/timeout/耗时/退出码/输出证据。
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      const rows = checkRowsOf(probe, operationId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.check_key).toBe(checkKey);
      expect(JSON.parse(row.argv_json)).toEqual(failureCheck.argv);
      expect(row.cwd_ref).toBe('src');
      expect(row.environment_ref).toBeNull();
      expect(row.timeout_ms).toBe(timeoutMs);
      expect(row.required).toBe(1);
      expect(row.status).toBe('failed');
      expect(row.reason_code).toBeNull();
      expect(row.exit_code).toBe(NONZERO_EXIT_CODE);
      expect(row.signal).toBeNull();
      expect(row.timed_out).toBe(0);
      expect(row.output_artifact_id).toBe(artifactId);
      expect(row.started_at).not.toBeNull();
      expect(row.ended_at).not.toBeNull();
      expect((row.ended_at as number) - (row.started_at as number)).toBeGreaterThanOrEqual(0);

      // 操作行 + 授权行（代码身份持久：headCommit/工作树摘要/无未提交变更）。
      const operationRow = operationRowOf(probe, operationId);
      expect(operationRow).toMatchObject({
        id: operationId,
        project_id: projectId,
        kind: 'baseline',
        status: 'completed',
        reason_code: null,
      });
      expect(operationRow!.started_at).not.toBeNull();
      expect(operationRow!.ended_at).not.toBeNull();
      const authorization = authorizationRowOf(probe, operationId);
      expect(authorization).toBeDefined();
      expect(authorization!.head_commit).toBe(headCommit);
      expect(authorization!.working_tree_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(authorization!.has_uncommitted_changes).toBe(0);
      expect(JSON.parse(authorization!.plan_json)).toEqual({ checks: [failureCheck] });

      // 事件序列：注册 → 授权 → 启动 → 检查完成 → 完成（失败也是 completed 事件，
      // 带失败 summary；不产生 cancel 痕迹）。
      expect(probe.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'baseline.authorized',
        'baseline.started',
        'baseline.check_completed',
        'baseline.completed',
      ]);
    } finally {
      probe.close();
    }

    // overview（CLI C）：仍显示已注册项目 + 失败健康（注册轴/健康轴独立，
    // 不冒充项目不存在或检查通过）。
    const overview = await f.runDistCli(
      ['project', 'overview', projectId, '--data-root', root, '--json'],
      { label: 'client-c-overview' },
    );
    expect(overview.exitCode, overview.stderr).toBe(0);
    const overviewResult = resultOf(overview) as {
      registration: { status: string };
      health: { status: string; lastBaselineOperationId: string | null; reasonCode?: string };
    };
    expect(overviewResult.registration.status).toBe('registered');
    expect(overviewResult.health.status).toBe('unhealthy');
    expect(overviewResult.health.lastBaselineOperationId).toBe(operationId);

    // 项目列表仍含该项目（不冒充项目不存在）。
    const list = await f.runDistCli(['project', 'list', '--data-root', root, '--json'], {
      label: 'client-c-project-list',
    });
    const listResult = resultOf(list) as { records: Array<{ id: string }> };
    expect(listResult.records).toHaveLength(1);
    expect(listResult.records[0]!.id).toBe(projectId);

    // 失败不修复仓库：字节级快照一致（无 stash/reset/commit/依赖安装）。
    const after = f.snapshotRepository(repoPath);
    expect(after.headCommit).toBe(before.headCommit);
    expect(after.statusPorcelain).toBe(before.statusPorcelain);
    expect(after.treeDigest).toBe(before.treeDigest);
    expect(after.tracked).toEqual(before.tracked);
    expect(after.untracked).toEqual(before.untracked);
    expect(existsSync(join(repoPath, 'node_modules'))).toBe(false);

    // 后续必需检查不豁免：失败后健康仍 unhealthy；成功基线后才转 healthy。
    const successPlan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-failure-then-success' });
    const successPlanFile = writePlanFile(f, successPlan.checks);
    const successRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', successPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-c-fresh-baseline-run' },
    );
    expect(successRun.exitCode, successRun.stderr).toBe(0);
    const successOperationId = (resultOf(successRun) as { operationId: string }).operationId;
    const successTerminal = await pollTerminalOperation(f, root, successOperationId, 60_000);
    expect(successTerminal.state).toBe('passed');
    const overviewAfter = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-c-overview-after-success',
      }),
    ) as { registration: { status: string }; health: { status: string } };
    expect(overviewAfter.registration.status).toBe('registered');
    expect(overviewAfter.health.status).toBe('healthy');

    // 失败证据不被后续成功删除：失败检查行仍在、两条操作/检查行并存（只读探针）。
    const probeAfter = openDataRootStorageProbe(root);
    try {
      expect(
        probeAfter.selectOne('SELECT status FROM baseline_check_results WHERE operation_id = ?', [operationId])?.status,
      ).toBe('failed');
      expect(probeAfter.counts().projects).toBe(1);
      expect(probeAfter.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(2);
      expect(probeAfter.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(2);
    } finally {
      probeAfter.close();
    }

    // 证据（脱敏）：实际退出码/持久字段核对记录 + 输出制品摘要。
    f.evidence.record('p02-4.fr2.baseline_failure.nonzero_exit', {
      operationId,
      cliExitCode: run.exitCode,
      checkStatus: 'failed',
      checkExitCode: NONZERO_EXIT_CODE,
      persistedFields: 'argv/cwdRef/environmentRef/timeoutMs/duration/codeIdentity/output',
      healthAfterFailure: 'unhealthy',
      healthAfterSubsequentPass: 'healthy',
      repoPreserved: true,
    });
    const digest = artifactContentDigest(artifactId, evidenceResult.content);
    const document = exportScannedEvidence(
      {
        repositories: [after],
        operation: statusB,
        artifacts: [digest],
        notes: ['P02-FR2-BASELINE-FAILURE (deterministic nonzero exit)'],
      },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);
    expect(document).toContain(headCommit as string);

    // 收尾：经产品命令受控停止 Host（夹具回收要求）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR2-BASELINE-FAILURE（验收 2）：拒绝授权与缺命令/未知脚本
 * ------------------------------------------------------------------ */

describe('P02-FR2-BASELINE-FAILURE 拒绝授权与缺命令/未知脚本', () => {
  it('拒绝基线授权：--decline → 可查询 not_run + authorization_rejected、启动次数为零、健康 not_run 且注册保持', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '拒绝授权验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // 受检命令：真实启动即向 marker 文件追加一行（启动次数可数的受控进程）。
    const markerFile = join(f.root, `decline-marker-${randomUUID().slice(0, 8)}.log`);
    const pidFile = join(f.root, `decline-pid-${randomUUID().slice(0, 8)}.txt`);
    const hangScript = writePidHangScript(f, 'f008-decline-started');
    const planFile = writePlanFile(f, [
      commandCheck('p02-4-failure-declined', [process.execPath, hangScript, markerFile, pidFile], 60_000),
    ]);

    // CLI A：拒绝授权（--decline；业务完成 → 退出码 0，但绝不折算成功）。
    const declined = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', planFile, '--decline', '--data-root', root, '--json'],
      { label: 'client-a-baseline-decline' },
    );
    expect(declined.exitCode, declined.stderr).toBe(0);
    const declinedResult = resultOf(declined);
    expect(declinedResult.state).toBe('not_run');
    expect(declinedResult.status).toBe('not_run');
    const declinedOperationId = declinedResult.operationId as string;
    expect(declinedOperationId).toMatch(UUID_V4_PATTERN);

    // CLI B（另一进程/新连接）：not_run 可查询 + 原因 + 零启动。
    const statusB = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', declinedOperationId, '--data-root', root, '--json'], {
          label: 'client-b-decline-status',
        }),
      ),
    );
    expect(statusB.status).toBe('not_run');
    expect(statusB.state).toBe('not_run');
    expect(statusB.checks).toEqual([]);
    // 启动次数为零：marker/pid 文件不存在（受检进程从未启动）。
    expect(markerLaunchCount(markerFile)).toBe(0);
    expect(existsSync(pidFile)).toBe(false);

    // 持久行（只读探针）：not_run 操作行 + authorization_rejected 原因、
    // 零检查行、零基线事件（decline 零种子/零占用/零事件）。
    const probe = openDataRootStorageProbe(root);
    try {
      const operationRow = operationRowOf(probe, declinedOperationId);
      expect(operationRow).toMatchObject({
        id: declinedOperationId,
        project_id: projectId,
        status: 'not_run',
        reason_code: 'authorization_rejected',
        started_at: null,
      });
      // 拒绝即终态：零启动（started_at 为空）但有结束时间。
      expect(operationRow!.ended_at).not.toBeNull();
      expect(operationRow!.authorization_id).toBeNull();
      expect(checkRowsOf(probe, declinedOperationId)).toEqual([]);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_authorizations')?.n).toBe(0);
      expect(probe.stateEvents().map((event) => event.event_type)).toEqual(['project.registered']);
    } finally {
      probe.close();
    }

    // overview：注册保持 + 健康 not_run（原因 authorization_rejected）。
    const overview = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-b-overview',
      }),
    ) as {
      registration: { status: string };
      health: { status: string; reasonCode?: string; lastBaselineOperationId: string | null };
    };
    expect(overview.registration.status).toBe('registered');
    expect(overview.health.status).toBe('not_run');
    expect(overview.health.reasonCode).toBe('authorization_rejected');
    expect(overview.health.lastBaselineOperationId).toBe(declinedOperationId);

    f.evidence.record('p02-4.fr2.baseline_failure.declined', {
      operationId: declinedOperationId,
      state: 'not_run',
      reasonCode: 'authorization_rejected',
      markerLaunches: 0,
      checkRows: 0,
    });
    const document = exportScannedEvidence(
      { operation: statusB, notes: ['P02-FR2-BASELINE-FAILURE (declined authorization)'] },
      [readHostToken(root)],
    );
    expect(document).toContain(declinedOperationId);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 180_000);

  it('缺命令与未知脚本：分别保留前序 error/missing_command、error/unknown_script 原因；不偷偷安装依赖、不替换命令、不修复仓库', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const before = f.snapshotRepository(repoPath);
    const packageJsonBefore = readFileSync(join(repoPath, 'package.json'), 'utf8');

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '缺命令未知脚本验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // --- 缺命令（P02-3 missingCommand 样例：argv[0] 指向确定性不存在的可执行文件）。 ---
    const missingExecutable = COMMAND_SAMPLES.missingCommand.argv()[0]!;
    expect(existsSync(missingExecutable)).toBe(false);
    const missingPlan = { checks: [commandSampleCheck('missingCommand', { checkKey: 'p02-4-failure-missing-command', timeoutMs: 30_000 })] };
    const missingPlanFile = writePlanFile(f, missingPlan.checks);
    const missingRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', missingPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-a-missing-command-run' },
    );
    // 预期负例保留实际非零子命令退出码（必需检查非 passed → 1）。
    expect(missingRun.exitCode, missingRun.stderr).toBe(1);
    const missingResult = resultOf(missingRun);
    expect(missingResult.state).toBe('failed');
    expect(missingResult.status).toBe('completed');
    const missingOperationId = missingResult.operationId as string;
    const missingChecks = missingResult.checks as Array<Record<string, unknown>>;
    expect(missingChecks).toHaveLength(1);
    expect(missingChecks[0]).toMatchObject({
      checkKey: 'p02-4-failure-missing-command',
      status: 'error',
      reasonCode: 'missing_command',
      timedOut: false,
    });

    // --- 未知脚本（前序契约 P02-3 §8.3「计划引用的脚本不在项目内」与执行器契约
    //     「npm/pnpm/yarn 已识别缺脚本诊断记 unknown_script；其他非零保留真实失败」）：
    //     ① './absent-relative-script'（计划内相对脚本不存在）；② npm run <未知 script>
    //     （已识别缺脚本诊断）；③ node --run <未知 script>（其他非零 → 真实 failed，
    //     不自动 install/不替换命令）。三种形态一次计划内顺序执行。 ---
    const unknownPlan = {
      checks: [
        commandCheck('p02-4-failure-unknown-absent', ['./absent-relative-script'], 30_000),
        commandCheck('p02-4-failure-unknown-npm', ['npm', 'run', UNKNOWN_PACKAGE_SCRIPT], 60_000),
        commandCheck('p02-4-failure-unknown-node-run', [process.execPath, '--run', UNKNOWN_PACKAGE_SCRIPT], 30_000),
      ],
    };
    const unknownPlanFile = writePlanFile(f, unknownPlan.checks);
    const unknownRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', unknownPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-a-unknown-script-run' },
    );
    expect(unknownRun.exitCode, unknownRun.stderr).toBe(1);
    const unknownResult = resultOf(unknownRun);
    expect(unknownResult.state).toBe('failed');
    const unknownOperationId = unknownResult.operationId as string;
    const unknownChecks = unknownResult.checks as Array<Record<string, unknown>>;
    expect(unknownChecks).toHaveLength(3);
    const checkByKey = (key: string): Record<string, unknown> =>
      unknownChecks.find((entry) => entry.checkKey === key)!;
    expect(checkByKey('p02-4-failure-unknown-absent')).toMatchObject({
      status: 'error',
      reasonCode: 'unknown_script',
      timedOut: false,
    });
    expect(checkByKey('p02-4-failure-unknown-npm')).toMatchObject({
      status: 'error',
      reasonCode: 'unknown_script',
      timedOut: false,
    });
    expect(checkByKey('p02-4-failure-unknown-node-run')).toMatchObject({
      status: 'failed',
      exitCode: 1,
      timedOut: false,
    });
    expect(checkByKey('p02-4-failure-unknown-node-run').reasonCode).toBeUndefined();

    // CLI B：两条结果均可查询（跨客户端；原因保持前序契约，不被修复/替换）。
    const missingStatus = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', missingOperationId, '--data-root', root, '--json'], {
          label: 'client-b-missing-status',
        }),
      ),
    );
    expect(missingStatus.checks[0]).toMatchObject({ status: 'error', reasonCode: 'missing_command' });
    const unknownStatus = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', unknownOperationId, '--data-root', root, '--json'], {
          label: 'client-b-unknown-status',
        }),
      ),
    );
    expect(unknownStatus.checks.map((check) => check.reasonCode)).toEqual(
      expect.arrayContaining(['unknown_script', 'unknown_script']) as never,
    );
    expect(unknownStatus.checks.filter((check) => check.status === 'failed')).toHaveLength(1);

    // 不偷偷安装依赖、不替换命令、不修复仓库：快照字节级一致 + 无 node_modules/
    // lockfile + 缺命令可执行文件仍缺失 + package.json 原文不变。
    expect(existsSync(missingExecutable)).toBe(false);
    expect(existsSync(join(repoPath, 'node_modules'))).toBe(false);
    expect(existsSync(join(repoPath, 'package-lock.json'))).toBe(false);
    expect(readFileSync(join(repoPath, 'package.json'), 'utf8')).toBe(packageJsonBefore);
    const after = f.snapshotRepository(repoPath);
    expect(after.headCommit).toBe(before.headCommit);
    expect(after.statusPorcelain).toBe(before.statusPorcelain);
    expect(after.treeDigest).toBe(before.treeDigest);
    expect(after.tracked).toEqual(before.tracked);
    expect(after.untracked).toEqual(before.untracked);

    // overview：注册保持 + 失败健康（最近终态 = 未知脚本失败）。
    const overview = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-b-overview',
      }),
    ) as { registration: { status: string }; health: { status: string; lastBaselineOperationId: string | null } };
    expect(overview.registration.status).toBe('registered');
    expect(overview.health.status).toBe('unhealthy');
    expect(overview.health.lastBaselineOperationId).toBe(unknownOperationId);

    // 持久行（只读探针）：缺命令 error 行 + 三条未知脚本形态检查行、argv 原样（未替换命令）。
    const probe = openDataRootStorageProbe(root);
    try {
      const missingRows = checkRowsOf(probe, missingOperationId);
      expect(missingRows).toHaveLength(1);
      expect(missingRows[0]).toMatchObject({ status: 'error', reason_code: 'missing_command', exit_code: null });
      expect(JSON.parse(missingRows[0]!.argv_json)).toEqual(missingPlan.checks[0]!.argv);
      const unknownRows = checkRowsOf(probe, unknownOperationId);
      expect(unknownRows).toHaveLength(3);
      const rowByKey = (key: string): CheckResultProbeRow =>
        unknownRows.find((row) => row.check_key === key)!;
      expect(rowByKey('p02-4-failure-unknown-absent')).toMatchObject({
        status: 'error',
        reason_code: 'unknown_script',
        exit_code: null,
      });
      expect(JSON.parse(rowByKey('p02-4-failure-unknown-absent').argv_json)).toEqual(['./absent-relative-script']);
      expect(rowByKey('p02-4-failure-unknown-npm')).toMatchObject({
        status: 'error',
        reason_code: 'unknown_script',
      });
      expect(JSON.parse(rowByKey('p02-4-failure-unknown-npm').argv_json)).toEqual(['npm', 'run', UNKNOWN_PACKAGE_SCRIPT]);
      expect(rowByKey('p02-4-failure-unknown-node-run')).toMatchObject({
        status: 'failed',
        reason_code: null,
        exit_code: 1,
      });
      expect(probe.counts().projects).toBe(1);
    } finally {
      probe.close();
    }

    f.evidence.record('p02-4.fr2.baseline_failure.missing_and_unknown', {
      missingOperationId,
      unknownOperationId,
      missingReason: 'missing_command',
      unknownReasonAbsentAndNpm: 'unknown_script',
      unknownNodeRun: 'failed (real nonzero, no auto install)',
      repoPreserved: true,
      dependenciesInstalled: false,
    });
    const document = exportScannedEvidence(
      { repositories: [after], operation: unknownStatus, notes: ['P02-FR2-BASELINE-FAILURE (missing command / unknown script)'] },
      [readHostToken(root)],
    );
    expect(document).toContain(unknownOperationId);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR2-BASELINE-FAILURE（验收 3）：超时/取消/进程树停止（真实受控进程）
 * ------------------------------------------------------------------ */

describe('P02-FR2-BASELINE-FAILURE 超时/取消/进程树停止', () => {
  it('timed_out：真实受控进程按超时停止（pid 实际消失）、部分输出保留、启动恰一次、停止核验后占用释放', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const claimFile = join(repoPath, '.git', 'shiploop-baseline.claim');

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '超时失败验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // pid 计数挂起脚本（真实受控进程）：记录 pid、追加启动行、写部分输出后挂起。
    const markerFile = join(f.root, `timeout-marker-${randomUUID().slice(0, 8)}.log`);
    const pidFile = join(f.root, `timeout-pid-${randomUUID().slice(0, 8)}.txt`);
    const hangScript = writePidHangScript(f, 'f008-timedout-started');
    const planFile = writePlanFile(f, [
      commandCheck('p02-4-failure-timeout', [process.execPath, hangScript, markerFile, pidFile], HANG_CHECK_TIMEOUT_MS),
    ]);

    // CLI A：--wait 观察到终态（超时不是观察中断；退出码 1 = 终态非全 passed）。
    const run = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', planFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-a-baseline-run-wait', resultTimeoutMs: 120_000 },
    );
    expect(run.exitCode, run.stderr).toBe(1);
    const runResult = resultOf(run);
    expect(runResult.state).toBe('timeout');
    expect(runResult.status).toBe('completed');
    expect(runResult.reasonCode).toBe('timed_out');
    const operationId = runResult.operationId as string;
    const checks = runResult.checks as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      checkKey: 'p02-4-failure-timeout',
      status: 'inconclusive',
      reasonCode: 'timed_out',
      timedOut: true,
      exitCode: null,
    });
    // 耗时证据：≥ 超时预算（毫秒粒度宽松下界）。
    expect(checks[0]!.durationMs as number).toBeGreaterThanOrEqual(HANG_CHECK_TIMEOUT_MS - 500);
    const artifactId = (checks[0]!.output as { artifactId: string }).artifactId;
    expect(artifactId).toMatch(UUID_V4_PATTERN);

    // 实际停止（不以 accepted 或父进程退出替代）：受控进程 pid 真实消失。
    expect(existsSync(pidFile)).toBe(true);
    const hangPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(hangPid)).toBe(true);
    await waitFor(() => !pidAlive(hangPid), 10_000);
    expect(pidAlive(hangPid)).toBe(false);
    // 启动恰一次（停止后未偷偷重跑）。
    expect(markerLaunchCount(markerFile)).toBe(1);
    // 部分输出保留：制品正文含挂起前写出的部分输出。
    const evidenceB = resultOf(
      await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], {
        label: 'client-b-evidence',
      }),
    ) as { content: string };
    expect(evidenceB.content).toContain('f008-timedout-started');

    // 停止核验确认后占用释放（claim 消失）；失败证据保留（只读探针）。
    expect(existsSync(claimFile)).toBe(false);
    const probe = openDataRootStorageProbe(root);
    try {
      const rows = checkRowsOf(probe, operationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'inconclusive',
        reason_code: 'timed_out',
        timed_out: 1,
        exit_code: null,
        output_artifact_id: artifactId,
      });
      expect(rows[0]!.started_at).not.toBeNull();
      expect(rows[0]!.ended_at).not.toBeNull();
      expect(operationRowOf(probe, operationId)).toMatchObject({
        status: 'completed',
        reason_code: 'timed_out',
      });
    } finally {
      probe.close();
    }

    // overview：注册保持 + 失败健康（不冒充通过）。
    const overview = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-b-overview',
      }),
    ) as { registration: { status: string }; health: { status: string } };
    expect(overview.registration.status).toBe('registered');
    expect(overview.health.status).toBe('unhealthy');

    // 占用已释放：新基线可继续（获准成功样例）。
    const freshPlan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-timeout-then-success' });
    const freshPlanFile = writePlanFile(f, freshPlan.checks);
    const freshRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', freshPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-b-fresh-baseline-run' },
    );
    expect(freshRun.exitCode, freshRun.stderr).toBe(0);
    expect((resultOf(freshRun) as { state: string }).state).toBe('passed');
    // 未重跑挂起检查（启动次数仍为 1）。
    expect(markerLaunchCount(markerFile)).toBe(1);

    f.evidence.record('p02-4.fr2.baseline_failure.timed_out', {
      operationId,
      cliExitCode: run.exitCode,
      checkStatus: 'inconclusive',
      reasonCode: 'timed_out',
      hangPidStopped: 'verified',
      markerLaunches: 1,
      partialOutputRetained: true,
      claimReleased: true,
    });
    const document = exportScannedEvidence(
      { operation: extractOperationSnapshot(runResult), notes: ['P02-FR2-BASELINE-FAILURE (timed_out)'] },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);

  it('cancelled：显式取消 → 进程真实停止、部分输出保留、不重跑；在途期间占用真实（另一提交 resource_busy 零副作用）', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const claimFile = join(repoPath, '.git', 'shiploop-baseline.claim');

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '显式取消验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // pid 计数挂起脚本：长时间预算内不退出（只能经显式取消停止）。
    const markerFile = join(f.root, `cancel-marker-${randomUUID().slice(0, 8)}.log`);
    const pidFile = join(f.root, `cancel-pid-${randomUUID().slice(0, 8)}.txt`);
    const hangScript = writePidHangScript(f, 'f008-cancel-started');
    const planFile = writePlanFile(f, [
      commandCheck('p02-4-failure-cancel', [process.execPath, hangScript, markerFile, pidFile], 120_000),
    ]);

    // CLI A：受理后返回（不 --wait；观察由另一 CLI 承担）。
    const run = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', planFile, '--confirm', '--data-root', root, '--json'],
      { label: 'client-a-baseline-run' },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    const runResult = resultOf(run);
    expect(runResult.state).toBe('accepted');
    const operationId = runResult.operationId as string;
    expect(operationId).toMatch(UUID_V4_PATTERN);

    // 实际运行就绪信号：受控进程已启动（marker 1 行 + pid 文件 + pid 存活），
    // 操作 running、仓库占用 claim 存在。
    await waitFor(() => markerLaunchCount(markerFile) === 1 && existsSync(pidFile), 30_000);
    const hangPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(hangPid)).toBe(true);
    expect(pidAlive(hangPid)).toBe(true);
    await pollListedOperationRunning(f, root, projectId, 30_000);
    expect(existsSync(claimFile)).toBe(true);

    // 在途期间占用真实：CLI C 提交另一基线（显式 commandId，错误体保留以便查回执）
    // → resource_busy/baseline_in_progress，退出码 1（预期负例保留实际非零退出码）
    // 且零持久副作用（无第二操作行）。
    const busyCommandId = randomUUID();
    const busyPlanFile = writePlanFile(f, f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-busy-competing' }).checks);
    const busy = await f.runDistCli(
      [
        'baseline', 'run', '--project', projectId, '--input', busyPlanFile,
        '--confirm', '--command-id', busyCommandId, '--data-root', root, '--json',
      ],
      { label: 'client-c-competing-run' },
    );
    const busyEnvelope = failureEnvelopeOf(busy, 1, 'resource_busy');
    expect(busyEnvelope.error.details).toMatchObject({ reason: 'baseline_in_progress' });
    expect(busyEnvelope.error.commandId).toBe(busyCommandId);
    const probeBusy = openDataRootStorageProbe(root);
    try {
      expect(probeBusy.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(1);
    } finally {
      probeBusy.close();
    }

    // CLI B：显式取消（唯一取消途径；回执状态驱动展示，不提前声称已停止）。
    const cancel = await f.runDistCli(
      ['baseline', 'cancel', operationId, '--confirm', '--data-root', root, '--json'],
      { label: 'client-b-baseline-cancel' },
    );
    expect(cancel.exitCode, cancel.stderr).toBe(0);
    const cancelResult = resultOf(cancel);
    expect(cancelResult.operationId).toBe(operationId);
    expect(['cancelling', 'cancelled']).toContain(cancelResult.status);

    // 终态：cancelled + 检查 inconclusive/cancelled；进程真实停止、部分输出保留。
    const terminal = await pollTerminalOperation(f, root, operationId, 60_000);
    expect(terminal.status).toBe('cancelled');
    expect(terminal.state).toBe('cancelled');
    expect(terminal.checks).toHaveLength(1);
    expect(terminal.checks[0]).toMatchObject({
      checkKey: 'p02-4-failure-cancel',
      status: 'inconclusive',
      reasonCode: 'cancelled',
      exitCode: null,
    });
    await waitFor(() => !pidAlive(hangPid), 15_000);
    expect(pidAlive(hangPid)).toBe(false);
    expect(markerLaunchCount(markerFile)).toBe(1);
    const artifactId = terminal.checks[0]!.output!.artifactId;
    expect(artifactId).toMatch(UUID_V4_PATTERN);
    const evidenceB = resultOf(
      await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], {
        label: 'client-b-evidence',
      }),
    ) as { content: string };
    expect(evidenceB.content).toContain('f008-cancel-started');

    // 停止核验确认后占用释放（claim 消失）；持久 cancelled 证据（只读探针）。
    expect(existsSync(claimFile)).toBe(false);
    const probe = openDataRootStorageProbe(root);
    try {
      const rows = checkRowsOf(probe, operationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'inconclusive',
        reason_code: 'cancelled',
        exit_code: null,
        output_artifact_id: artifactId,
      });
      expect(operationRowOf(probe, operationId)).toMatchObject({ status: 'cancelled', reason_code: 'cancelled' });
      expect(probe.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'baseline.authorized',
        'baseline.started',
        'baseline.check_completed',
        'baseline.cancelled',
      ]);
    } finally {
      probe.close();
    }

    // overview：注册保持 + 失败健康（cancelled 不折算通过）。
    const overview = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-b-overview',
      }),
    ) as { registration: { status: string }; health: { status: string; reasonCode?: string } };
    expect(overview.registration.status).toBe('registered');
    expect(overview.health.status).toBe('unhealthy');

    // 取消后占用释放：新基线可继续（不重跑已取消检查）。
    const freshPlan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-cancel-then-success' });
    const freshPlanFile = writePlanFile(f, freshPlan.checks);
    const freshRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', freshPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-b-fresh-baseline-run' },
    );
    expect(freshRun.exitCode, freshRun.stderr).toBe(0);
    expect((resultOf(freshRun) as { state: string }).state).toBe('passed');
    expect(markerLaunchCount(markerFile)).toBe(1);

    f.evidence.record('p02-4.fr2.baseline_failure.cancelled', {
      operationId,
      cancelStatus: cancelResult.status,
      terminalStatus: terminal.status,
      checkReason: 'cancelled',
      hangPidStopped: 'verified',
      markerLaunches: 1,
      partialOutputRetained: true,
      competingRunRejected: 'resource_busy/baseline_in_progress',
      claimReleased: true,
    });
    const document = exportScannedEvidence(
      { operation: terminal, notes: ['P02-FR2-BASELINE-FAILURE (explicit cancel)'] },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);

  it('进程树停止：spawnWriter 超时后孙进程一并真实停止（不以父进程退出替代进程树停止）', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '进程树停止验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // P02-3 spawnWriter 样例（复用现有挂起用例语义）：父进程派生持续写入孙进程后
    // 挂起；只杀父进程不足以停止进程树，监督方必须核验整棵树。
    const writeDir = join(f.root, `spawn-writer-${randomUUID().slice(0, 8)}`);
    const planChecks = [commandSampleCheck('spawnWriter', { checkKey: 'p02-4-failure-tree-stop', timeoutMs: TREE_CHECK_TIMEOUT_MS, args: [writeDir] })];
    const planFile = writePlanFile(f, planChecks);

    const run = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', planFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-a-baseline-run-wait', resultTimeoutMs: 120_000 },
    );
    expect(run.exitCode, run.stderr).toBe(1);
    const runResult = resultOf(run);
    expect(runResult.state).toBe('timeout');
    const operationId = runResult.operationId as string;
    const checks = runResult.checks as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      checkKey: 'p02-4-failure-tree-stop',
      status: 'inconclusive',
      reasonCode: 'timed_out',
      timedOut: true,
      exitCode: null,
    });
    const artifactId = (checks[0]!.output as { artifactId: string }).artifactId;

    // 部分输出保留：制品正文含父/孙进程真实 pid（供停止核验）。
    const evidenceB = resultOf(
      await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], {
        label: 'client-b-evidence',
      }),
    ) as { content: string };
    const content = evidenceB.content;
    const parentPid = Number(content.match(/spawn-writer:(\d+)/)?.[1]);
    const childPid = Number(content.match(/spawn-writer-child-pid:(\d+)/)?.[1]);
    expect(Number.isInteger(parentPid) && parentPid > 0).toBe(true);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(childPid).not.toBe(parentPid);

    // 真实进程树停止：父进程与孙进程 pid 均实际消失（组级停止核验，
    // 不以父进程退出或 accepted 回执替代）。
    await waitFor(() => !pidAlive(parentPid) && !pidAlive(childPid), 15_000);
    expect(pidAlive(parentPid)).toBe(false);
    expect(pidAlive(childPid)).toBe(false);

    // 孙进程确已停止：写入目录文件数在观察窗口内稳定（无新写入）。
    const countFiles = (): number => readdirSync(writeDir).length;
    expect(countFiles()).toBeGreaterThan(0);
    const firstCount = countFiles();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(countFiles()).toBe(firstCount);

    // 占用释放（停止核验确认）：新基线可继续。
    expect(existsSync(join(repoPath, '.git', 'shiploop-baseline.claim'))).toBe(false);
    const freshPlan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-tree-then-success' });
    const freshPlanFile = writePlanFile(f, freshPlan.checks);
    const freshRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', freshPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-b-fresh-baseline-run' },
    );
    expect(freshRun.exitCode, freshRun.stderr).toBe(0);
    expect((resultOf(freshRun) as { state: string }).state).toBe('passed');

    f.evidence.record('p02-4.fr2.baseline_failure.tree_stop', {
      operationId,
      reasonCode: 'timed_out',
      parentPidStopped: 'verified',
      grandchildPidStopped: 'verified',
      writeDirStable: true,
      partialOutputRetained: true,
    });
    const document = exportScannedEvidence(
      { operation: extractOperationSnapshot(runResult), notes: ['P02-FR2-BASELINE-FAILURE (process tree stop)'] },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR2-BASELINE-FAILURE（验收 4）：失败/取消后跨 CLI 查询与 Host 重启持久
 * ------------------------------------------------------------------ */

describe('P02-FR2-BASELINE-FAILURE 失败/取消后跨 CLI 查询与 Host 重启持久', () => {
  it('失败与取消后 Host 显式 stop 重启：项目/失败检查/输出引用仍可读、注册不回滚、失败证据不删除、不豁免后续必需检查', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const headCommit = f.repos.headOf('withHead');

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '失败重启持久验收项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // --- 失败基线（nonzeroExit 样例；--wait 退出码 1）。 ---
    const failureCheck = commandSampleCheck('nonzeroExit', { checkKey: 'p02-4-restart-failure' });
    const failurePlanFile = writePlanFile(f, [failureCheck]);
    const failureRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', failurePlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-a-failure-run' },
    );
    expect(failureRun.exitCode, failureRun.stderr).toBe(1);
    const failedOperationId = (resultOf(failureRun) as { operationId: string }).operationId;

    // --- 取消基线（显式取消 → cancelled）。 ---
    const markerFile = join(f.root, `restart-cancel-${randomUUID().slice(0, 8)}.log`);
    const pidFile = join(f.root, `restart-pid-${randomUUID().slice(0, 8)}.txt`);
    const hangScript = writePidHangScript(f, 'f008-restart-cancel-started');
    const cancelPlanFile = writePlanFile(f, [
      commandCheck('p02-4-restart-cancel', [process.execPath, hangScript, markerFile, pidFile], 120_000),
    ]);
    const cancelRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', cancelPlanFile, '--confirm', '--data-root', root, '--json'],
      { label: 'client-a-cancel-run' },
    );
    expect(cancelRun.exitCode, cancelRun.stderr).toBe(0);
    const cancelledOperationId = (resultOf(cancelRun) as { operationId: string }).operationId;
    await waitFor(() => markerLaunchCount(markerFile) === 1 && existsSync(pidFile), 30_000);
    const hangPid = Number(readFileSync(pidFile, 'utf8').trim());
    await pollListedOperationRunning(f, root, projectId, 30_000, cancelledOperationId);
    const cancel = await f.runDistCli(
      ['baseline', 'cancel', cancelledOperationId, '--confirm', '--data-root', root, '--json'],
      { label: 'client-b-baseline-cancel' },
    );
    expect(cancel.exitCode, cancel.stderr).toBe(0);
    const cancelledTerminal = await pollTerminalOperation(f, root, cancelledOperationId, 60_000);
    expect(cancelledTerminal.status).toBe('cancelled');
    await waitFor(() => !pidAlive(hangPid), 15_000);

    // --- 重启前持久状态快照（新进程/新连接；重启后逐字段比对）。 ---
    const projectBefore = resultOf(
      await f.runDistCli(['project', 'get', projectId, '--data-root', root, '--json'], { label: 'client-b-project-get' }),
    );
    const failedStatusBefore = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', failedOperationId, '--data-root', root, '--json'], {
          label: 'client-b-failed-status',
        }),
      ),
    );
    expect(failedStatusBefore.checks[0]).toMatchObject({ status: 'failed', exitCode: NONZERO_EXIT_CODE });
    const failedArtifactId = failedStatusBefore.checks[0]!.output!.artifactId;
    const failedEvidenceBefore = resultOf(
      await f.runDistCli(['baseline', 'evidence', failedArtifactId, '--data-root', root, '--json'], {
        label: 'client-b-failed-evidence',
      }),
    ) as { artifactId: string; byteSize: number; content: string };
    const cancelledStatusBefore = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', cancelledOperationId, '--data-root', root, '--json'], {
          label: 'client-b-cancelled-status',
        }),
      ),
    );
    const overviewBefore = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-b-overview',
      }),
    ) as { registration: { status: string }; health: { status: string; reasonCode?: string } };
    expect(overviewBefore.registration.status).toBe('registered');
    expect(overviewBefore.health.status).toBe('unhealthy');

    // --- 正式显式 host stop（三证据：进程退出/锁可获取/发现移除）。 ---
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    const stopResult = resultOf(stop) as {
      status: string;
      hostInstanceId: string;
      evidence: { processExit: string; lock: string; discovery: string };
    };
    expect(stopResult.status).toBe('stopped');
    expect(stopResult.evidence).toEqual({ processExit: 'confirmed', lock: 'acquirable', discovery: 'removed' });
    await waitFor(() => f.liveHostPid() === null, 10_000);

    // --- 重启（新 CLI 进程/新连接）：新 hostInstanceId。 ---
    const restart = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'client-c-host-restart',
    });
    expect(restart.exitCode, restart.stderr).toBe(0);
    const restartResult = resultOf(restart) as { outcome: string; hostInstanceId: string };
    expect(restartResult.outcome).toBe('started');
    const newInstance = restartResult.hostInstanceId;
    expect(newInstance).toMatch(UUID_V4_PATTERN);
    expect(f.liveHostPid()).not.toBeNull();

    // --- 失败/取消结果来自重启后的持久状态（新进程/新连接，不用旧客户端缓存）。 ---
    const projectAfter = resultOf(
      await f.runDistCli(['project', 'get', projectId, '--data-root', root, '--json'], { label: 'client-d-project-get' }),
    );
    expect(projectAfter).toEqual(projectBefore);

    const failedStatusAfter = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', failedOperationId, '--data-root', root, '--json'], {
          label: 'client-d-failed-status',
        }),
      ),
    );
    expect(failedStatusAfter).toEqual(failedStatusBefore);
    expect(failedStatusAfter.checks[0]).toMatchObject({
      checkKey: 'p02-4-restart-failure',
      status: 'failed',
      exitCode: NONZERO_EXIT_CODE,
      reasonCode: null,
    });

    // 输出引用仍可读且正文一致（失败证据未删除）。
    const failedEvidenceAfter = resultOf(
      await f.runDistCli(['baseline', 'evidence', failedArtifactId, '--data-root', root, '--json'], {
        label: 'client-d-failed-evidence',
      }),
    ) as { artifactId: string; byteSize: number; content: string };
    expect(failedEvidenceAfter).toEqual(failedEvidenceBefore);

    const cancelledStatusAfter = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', cancelledOperationId, '--data-root', root, '--json'], {
          label: 'client-d-cancelled-status',
        }),
      ),
    );
    expect(cancelledStatusAfter).toEqual(cancelledStatusBefore);
    expect(cancelledStatusAfter.checks[0]).toMatchObject({
      status: 'inconclusive',
      reasonCode: 'cancelled',
    });

    // baseline list：失败与取消两条记录均保留（无重跑/删除）。
    const listAfter = resultOf(
      await f.runDistCli(['baseline', 'list', '--project', projectId, '--data-root', root, '--json'], {
        label: 'client-d-baseline-list',
      }),
    ) as { records: Array<{ operationId: string; status: string }> };
    expect(listAfter.records.map((record) => record.operationId).sort()).toEqual(
      [failedOperationId, cancelledOperationId].sort(),
    );
    const failedRecord = listAfter.records.find((record) => record.operationId === failedOperationId)!;
    const cancelledRecord = listAfter.records.find((record) => record.operationId === cancelledOperationId)!;
    expect(failedRecord.status).toBe('completed');
    expect(cancelledRecord.status).toBe('cancelled');

    // overview：注册未回滚 + 失败健康（最近终态 = cancelled）。
    const overviewAfter = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-d-overview',
      }),
    ) as { registration: { status: string }; health: { status: string; reasonCode?: string; lastBaselineOperationId: string | null } };
    expect(overviewAfter.registration.status).toBe('registered');
    expect(overviewAfter.health.status).toBe('unhealthy');
    expect(overviewAfter.health.lastBaselineOperationId).toBe(cancelledOperationId);

    // 持久行核对（只读探针）：项目/绑定/两条检查行/授权行均在（未回滚/未删除）。
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.counts()).toMatchObject({ projects: 1, repository_bindings: 1 });
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(2);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(2);
      const failedRow = checkRowsOf(probe, failedOperationId)[0]!;
      expect(failedRow).toMatchObject({ status: 'failed', exit_code: NONZERO_EXIT_CODE, output_artifact_id: failedArtifactId });
      const cancelledRow = checkRowsOf(probe, cancelledOperationId)[0]!;
      expect(cancelledRow).toMatchObject({ status: 'inconclusive', reason_code: 'cancelled' });
      const authorization = authorizationRowOf(probe, failedOperationId);
      expect(authorization?.head_commit).toBe(headCommit);
    } finally {
      probe.close();
    }

    // 不豁免后续必需检查：重启后获准成功基线 → 健康 healthy（此前失败不替代）。
    const successPlan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-restart-then-success' });
    const successPlanFile = writePlanFile(f, successPlan.checks);
    const successRun = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', successPlanFile, '--confirm', '--wait', '--data-root', root, '--json'],
      { label: 'client-d-fresh-baseline-run' },
    );
    expect(successRun.exitCode, successRun.stderr).toBe(0);
    const successTerminal = await pollTerminalOperation(
      f,
      root,
      (resultOf(successRun) as { operationId: string }).operationId,
      60_000,
    );
    expect(successTerminal.state).toBe('passed');
    const overviewFinal = resultOf(
      await f.runDistCli(['project', 'overview', projectId, '--data-root', root, '--json'], {
        label: 'client-d-overview-final',
      }),
    ) as { health: { status: string } };
    expect(overviewFinal.health.status).toBe('healthy');

    f.evidence.record('p02-4.fr2.baseline_failure.restart_persistence', {
      newInstance,
      failedOperationId,
      cancelledOperationId,
      stopEvidence: stopResult.evidence,
      persistentResults: 'project/failed-check/cancelled-check/output-artifact:consistent',
      failureEvidenceDeleted: false,
      subsequentPassRequired: true,
    });
    const document = exportScannedEvidence(
      {
        repositories: [f.snapshotRepository(repoPath)],
        operation: failedStatusAfter,
        hostIdentity: extractHostIdentity(restartResult),
        notes: ['P02-FR2-BASELINE-FAILURE (restart persistence)'],
      },
      [readHostToken(root)],
    );
    expect(document).toContain(failedOperationId);

    const stopAgain = await f.stopHost();
    expect(stopAgain.exitCode, stopAgain.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 360_000);
});
