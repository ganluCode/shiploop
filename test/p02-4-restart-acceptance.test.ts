/**
 * F-007 P02-4 客户端退出与 Host 安全停止/重启闭环的真实端到端验收场景。
 *
 * 对应 docs/p02-4-acceptance-contract.md §2.1 冻结的两个必需检查（全部 required）：
 * - `P02-FR2-CLIENT-EXIT`（FR-2 客户端退出）：受控基线取得实际运行就绪信号后，
 *   SIGINT 中断真实 dist CLI 的 `baseline run --wait` / `--follow` 观察——退出码 4
 *   `observation_interrupted` + 观察中断错误体（operationId/reason）；退出观察不发
 *   stop/cancel（Host 同实例存活、发现不变、事件/回执零 cancel 痕迹）；另一 CLI
 *   仍可认证同一 Host 并查询原操作继续运行，随后正常收尾（completed/passed、
 *   退出码 0、输出制品可校验、代码身份不变）。
 * - `P02-FR1-RESTART-QUERY`（FR-1 重启查询）：对已完成基线执行正式显式
 *   `host stop`（进程退出/锁可获取/发现移除三证据 + 独立复核实际退出与锁释放）
 *   后重启取得新 `hostInstanceId`；两个新 CLI（新进程/新连接，不用旧客户端缓存）
 *   读取原 `projectId`、配置值/`revision`、基线结果、代码身份与输出制品
 *   `hash`/`size` 逐字段一致；旧 token/旧实例对新 Host 明确拒绝；旧实例清理
 *   不删除当前发现信息（按实例清理第二道防线）；持久回执可查询、原基线未
 *   自动重跑（受检命令真实启动计数不变）。
 *
 * 验收 4（复用前序真实活动停止/崩溃恢复回归）：P02-3 的
 * `baseline-host-faults.test.ts` / `baseline-host-recovery.test.ts` /
 * `supervised-process-stopping.test.ts`（F-001 §2.3 冻结回归清单）继续承担
 * 停止核验与停止未确认保持占用/不重跑的完整覆盖；本套件另以真实 dist CLI
 * 复验可端到端观察的部分：SIGKILL Host 崩溃后经正式 CLI 重启——受监督进程
 * fail-closed（IPC 断开即真实停止受控进程组）、重启恢复对旧组做停止核验
 * （组不存在探测确认）后原操作 interrupted/restart_recovery 不重跑（启动计数
 * 不变）、占用释放后新基线可继续。只验证 P02 基线进程，不实现 Work/Runner
 * 恢复；停止未确认保持占用的完整覆盖由上述 P02-3 回归承担（验收内无法经
 * 只读纪律伪造不可核验身份）。
 *
 * 纪律与 F-003 ~ F-006 相同：写入全部经产品公共入口（真实
 * `packages/cli/dist/bin.js`），数据库只经只读探针核对；每个等待有限预算；
 * 结果查询来自新进程与新连接；证据脱敏导出（token/认证头不出现）；
 * 回收 fail-closed（停止未确认即保留资源与诊断）。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquireWriterLock, createHostFileStore } from '../packages/host/src/index.ts';
import {
  artifactContentDigest,
  assertDistCliBuilt,
  createAcceptanceFixture,
  exportEvidenceDocument,
  extractHostIdentity,
  extractOperationSnapshot,
  openDataRootStorageProbe,
  parseJsonEnvelopes,
  scanForCredentialShapes,
  singleEnvelope,
  type AcceptanceFixture,
  type DistCliResult,
  type EvidenceDocumentInput,
  type OperationSnapshot,
} from './helpers/p02-4/index.ts';
import { loopbackRequest, type LoopbackResponse } from './helpers/host/http-probe.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 延迟成功命令的延迟（ms）：覆盖「运行中中断观察 → 继续运行 → 正常收尾」窗口。 */
const LATE_SUCCESS_DELAY_MS = 12_000;

/* ------------------------------------------------------------------ *
 * 夹具与公共小工具
 * ------------------------------------------------------------------ */

const activeFixtures: AcceptanceFixture[] = [];

function useFixture(): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix: 'shiploop-p02-4-f007-', stepMs: 300 });
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

interface DiscoveryFileRecord {
  readonly hostInstanceId?: unknown;
  readonly dataRootIdentity?: unknown;
  readonly listenAddress?: unknown;
  readonly port?: unknown;
  readonly pid?: unknown;
}

function readDiscoveryFile(dataRoot: string): DiscoveryFileRecord {
  return JSON.parse(readFileSync(join(dataRoot, 'host', 'discovery.json'), 'utf8')) as DiscoveryFileRecord;
}

function readHostToken(dataRoot: string): string {
  return readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8').trim();
}

function resultOf(result: DistCliResult): Record<string, unknown> {
  const envelope = singleEnvelope(result);
  expect(envelope.ok, result.stderr).toBe(true);
  return envelope.result as Record<string, unknown>;
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
function commandCheck(checkKey: string, argv: readonly string[], timeoutMs = 60_000): Record<string, unknown> {
  return { checkKey, kind: 'command', argv: [...argv], timeoutMs, required: true };
}

function writePlanFile(fixture: AcceptanceFixture, checks: readonly unknown[]): string {
  const dir = join(fixture.root, 'plans');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `plan-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ checks }), 'utf8');
  return file;
}

/** 延迟成功脚本：延迟后写出 late-ok 并以退出码 0 结束（受控「正在运行」窗口）。 */
function writeLateSuccessScript(fixture: AcceptanceFixture): string {
  const script = join(fixture.root, `late-success-${randomUUID().slice(0, 8)}.cjs`);
  writeFileSync(
    script,
    [
      "const delayMs = Number(process.argv[2] ?? '12000');",
      'setTimeout(() => {',
      "  process.stdout.write('late-ok\\n');",
      '  process.exit(0);',
      '}, delayMs);',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
}

/** 启动计数脚本：每次实际启动向 marker 文件追加一行（真实启动计数）。 */
function writeMarkerScript(fixture: AcceptanceFixture): string {
  const script = join(fixture.root, `marker-${randomUUID().slice(0, 8)}.mjs`);
  writeFileSync(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.argv[2], 'launch\\n');",
      "process.stdout.write('marker-ok\\n');",
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

/** 挂起计数脚本：记录自身 pid、追加启动行后挂起（SIGTERM 可停；崩溃恢复样例）。 */
function writeHangCounterScript(fixture: AcceptanceFixture): string {
  const script = join(fixture.root, `hang-counter-${randomUUID().slice(0, 8)}.cjs`);
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[3], String(process.pid));",
      "fs.appendFileSync(process.argv[2], 'launch\\n');",
      "process.stdout.write('hang-counter-started\\n');",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
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

/** 经另一 CLI 轮询列表至操作实际进入 running（实际运行就绪信号），返回 operationId。 */
async function pollListedOperationRunning(
  fixture: AcceptanceFixture,
  dataRoot: string,
  projectId: string,
  budgetMs: number,
): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const list = await fixture.runDistCli(
      ['baseline', 'list', '--project', projectId, '--data-root', dataRoot, '--json'],
      { label: 'client-b-baseline-list' },
    );
    expect(list.exitCode, list.stderr).toBe(0);
    const records = (resultOf(list) as { records: Array<{ operationId: string; status: string }> }).records;
    if (records.length > 0) {
      const record = records[0]!;
      // 运行前的合法中间态只有 accepted；出现其他状态说明场景假设被破坏。
      expect(['accepted', 'running']).toContain(record.status);
      if (record.status === 'running') {
        return record.operationId;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`基线操作在 ${budgetMs}ms 内未进入 running（列表记录数：${records.length}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** 回执结果视图（`receipt get` 的结构化结果形状）。 */
interface CliReceiptView {
  readonly commandId: string;
  readonly operation: string;
  readonly status: string;
  readonly replayed: boolean;
  readonly requestDigest?: string;
  readonly issuedAt?: string;
  readonly completedAt?: string;
  readonly resultRef?: string;
  /** 仅 accepted 回执（baseline.run authorize）携带。 */
  readonly operationId?: string;
}

function receiptOf(result: DistCliResult): CliReceiptView {
  return resultOf(result) as unknown as CliReceiptView;
}

/** Host 负例响应断言：状态码 + 错误码（+ 操作身份）。 */
function expectRejected(
  response: LoopbackResponse,
  statusCode: number,
  code: string,
  operation?: string,
): void {
  expect(response.statusCode, response.bodyText).toBe(statusCode);
  const parsed = response.json() as { error?: Record<string, unknown> };
  expect(parsed.error, response.bodyText).toBeDefined();
  expect(parsed.error!.code, response.bodyText).toBe(code);
  if (operation !== undefined) {
    expect(parsed.error!.operation, response.bodyText).toBe(operation);
  }
}

/* ------------------------------------------------------------------ *
 * P02-FR2-CLIENT-EXIT：中断 CLI 的 wait/follow 观察
 * ------------------------------------------------------------------ */

describe('P02-FR2-CLIENT-EXIT 客户端退出/观察中断闭环', () => {
  it('SIGINT 中断 baseline run --wait：退出码 4 observation_interrupted、零 stop/cancel、Host 同实例存活、另一 CLI 查询原操作继续运行并正常收尾', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const headCommit = f.repos.headOf('withHead');
    const checkKey = 'p02-4-client-exit-wait';

    // CLI A：正式 init 注册受检仓库（首个应用命令自动启动 Host）。
    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '客户端退出等待观察项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);

    // Host 身份（发现文件事实；后续断言「退出观察不停止 Host」）。
    const discoveryBefore = readDiscoveryFile(root);
    const hostInstanceId = discoveryBefore.hostInstanceId as string;
    const hostPid = discoveryBefore.pid as number;
    expect(hostInstanceId).toMatch(UUID_V4_PATTERN);
    expect(f.liveHostPid()).toBe(hostPid);

    // 基线输入：延迟成功的确定性命令（延迟窗口内可中断观察、随后正常收尾）。
    const script = writeLateSuccessScript(f);
    const planFile = writePlanFile(f, [
      commandCheck(checkKey, [process.execPath, script, String(LATE_SUCCESS_DELAY_MS)]),
    ]);

    // CLI A：baseline run --confirm --wait（SIGINT 由 bin.ts 接入为仅中断观察）。
    const session = f.spawnDistCli({
      args: [
        'baseline', 'run', '--project', projectId, '--input', planFile,
        '--confirm', '--wait', '--data-root', root, '--json',
      ],
      label: 'client-a-baseline-wait',
    });
    await session.waitReady(15_000);
    session.releaseGo();
    const grandchild = await session.driver.waitMessage('dist_cli_grandchild', 15_000);
    const cliPid = grandchild.pid;
    expect(typeof cliPid).toBe('number');

    // 另一 CLI 查询同一 Host：取得 operationId 并等待实际运行就绪信号（running）。
    const operationId = await pollListedOperationRunning(f, root, projectId, 30_000);
    expect(operationId).toMatch(UUID_V4_PATTERN);

    // 中断观察：SIGINT 仅结束本次观察（第一次信号 → abort，不强制退出）。
    process.kill(cliPid as number, 'SIGINT');
    const interrupted = await session.waitResult(30_000);
    // 第五档退出码 4：观察中断。
    expect(interrupted.exitCode, interrupted.stderr).toBe(4);
    expect(interrupted.signal).toBeNull();
    const envelope = singleEnvelope(interrupted);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('baseline.run');
    expect(envelope.error?.code).toBe('observation_interrupted');
    expect(envelope.error?.details).toMatchObject({ operationId, reason: 'aborted' });
    // 实际退出核验（driver + 真实 dist CLI 进程消失）。
    await session.verifyStopped();

    // 退出观察未发送 stop/cancel：Host 同实例存活、发现文件不变。
    expect(f.liveHostPid()).toBe(hostPid);
    expect(readDiscoveryFile(root).hostInstanceId).toBe(hostInstanceId);
    const hostStatus = await f.runDistCli(['host', 'status', '--data-root', root, '--json'], {
      label: 'client-c-host-status',
    });
    expect(hostStatus.exitCode, hostStatus.stderr).toBe(0);
    const statusResult = resultOf(hostStatus);
    expect(statusResult.hostInstanceId).toBe(hostInstanceId);
    expect(statusResult.pid).toBe(hostPid);
    expect(statusResult.lifecycleState).toBe('ready');

    // 另一 CLI（新进程/新连接）查询原操作：仍在运行（未被中断观察取消）。
    const stillRunning = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', operationId, '--data-root', root, '--json'], {
          label: 'client-b-status-while-running',
        }),
      ),
    );
    expect(stillRunning.status).toBe('running');

    // 正常收尾：持久终态 completed/passed（中断观察不改变操作结局）。
    const terminal = await pollTerminalOperation(f, root, operationId, 60_000);
    expect(terminal.status).toBe('completed');
    expect(terminal.state).toBe('passed');
    expect(terminal.checks).toHaveLength(1);
    const check = terminal.checks[0]!;
    expect(check.checkKey).toBe(checkKey);
    expect(check.status).toBe('passed');
    expect(check.reasonCode).toBeNull();
    expect(check.exitCode).toBe(0);
    expect(check.output).not.toBeNull();
    const artifactId = check.output!.artifactId;
    expect(artifactId).toMatch(UUID_V4_PATTERN);
    expect(terminal.codeIdentity.headCommit).toBe(headCommit);
    expect(terminal.codeIdentity.hasUncommittedChanges).toBe(false);
    expect(terminal.codeIdentity.workingTreeDigest).toMatch(/^[0-9a-f]{64}$/);

    // 输出制品正文可校验（新进程/新连接查询）。
    const evidence = await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], {
      label: 'client-b-evidence',
    });
    const evidenceResult = resultOf(evidence) as { artifactId: string; byteSize: number; content: string };
    const expectedContent = '[stdout]late-ok\n';
    expect(evidenceResult.artifactId).toBe(artifactId);
    expect(evidenceResult.content).toBe(expectedContent);
    expect(evidenceResult.byteSize).toBe(expectedContent.length);
    const digest = artifactContentDigest(artifactId, evidenceResult.content);
    expect(digest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(check.output!.byteSize).toBe(digest.sizeBytes);

    // 零 stop/cancel 痕迹（只读探针）：回执恰 3（register/preview/run，无 cancel）；
    // 事件序列与正常完成一致（无 baseline.cancelled）。
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts()).toMatchObject({
        projects: 1,
        command_receipts: 3,
        artifacts: 3,
      });
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(1);
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

    // 证据保留（脱敏导出）。
    f.evidence.record('p02-4.fr2.client_exit.wait', {
      hostInstanceId,
      hostPid,
      operationId,
      cliExitCode: 4,
      errorCode: 'observation_interrupted',
      stopOrCancelSent: 'none',
      terminalStatus: terminal.status,
      terminalState: terminal.state,
      checkExitCode: 0,
      artifactId,
      artifactByteSize: digest.sizeBytes,
    });
    const document = exportScannedEvidence(
      {
        hostIdentity: extractHostIdentity(statusResult),
        operation: terminal,
        artifacts: [digest],
        notes: ['P02-FR2-CLIENT-EXIT (--wait)'],
      },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);
    expect(document).toContain(hostInstanceId);
    expect(document).toContain(String(hostPid));

    // 收尾：经产品命令受控停止 Host（夹具回收要求）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 180_000);

  it('SIGINT 中断 baseline run --follow：事件流观察同样以退出码 4 结束、操作继续并正常收尾', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const headCommit = f.repos.headOf('withHead');
    const checkKey = 'p02-4-client-exit-follow';

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '客户端退出跟随观察项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    const discoveryBefore = readDiscoveryFile(root);
    const hostInstanceId = discoveryBefore.hostInstanceId as string;
    const hostPid = discoveryBefore.pid as number;
    expect(f.liveHostPid()).toBe(hostPid);

    const script = writeLateSuccessScript(f);
    const planFile = writePlanFile(f, [
      commandCheck(checkKey, [process.execPath, script, String(LATE_SUCCESS_DELAY_MS)]),
    ]);

    // CLI A：baseline run --confirm --follow --json（NDJSON 记录流）。
    const session = f.spawnDistCli({
      args: [
        'baseline', 'run', '--project', projectId, '--input', planFile,
        '--confirm', '--follow', '--data-root', root, '--json',
      ],
      label: 'client-a-baseline-follow',
    });
    await session.waitReady(15_000);
    session.releaseGo();
    const grandchild = await session.driver.waitMessage('dist_cli_grandchild', 15_000);
    const cliPid = grandchild.pid;
    expect(typeof cliPid).toBe('number');

    const operationId = await pollListedOperationRunning(f, root, projectId, 30_000);

    process.kill(cliPid as number, 'SIGINT');
    const interrupted = await session.waitResult(30_000);
    expect(interrupted.exitCode, interrupted.stderr).toBe(4);
    expect(interrupted.signal).toBeNull();
    // NDJSON 记录流：首信封 accepted（含 operationId），末信封观察中断错误体。
    const envelopes = parseJsonEnvelopes(interrupted.stdout);
    expect(envelopes.length).toBeGreaterThanOrEqual(2);
    const first = envelopes[0]!;
    expect(first.ok).toBe(true);
    expect(first.command).toBe('baseline.run');
    const acceptedResult = first.result as { kind: string; operation: { operationId: string } };
    expect(acceptedResult.kind).toBe('accepted');
    expect(acceptedResult.operation.operationId).toBe(operationId);
    const last = envelopes[envelopes.length - 1]!;
    expect(last.ok).toBe(false);
    expect(last.command).toBe('baseline.run');
    expect(last.error?.code).toBe('observation_interrupted');
    expect(last.error?.details).toMatchObject({ operationId, reason: 'aborted' });
    // 中间事件信封（如有）只针对本操作。
    for (const middle of envelopes.slice(1, -1)) {
      expect(middle.ok).toBe(true);
      const event = middle.result as { kind: string; event: { payload: { operationId?: unknown } } };
      expect(event.kind).toBe('event');
      expect(event.event.payload.operationId).toBe(operationId);
    }
    await session.verifyStopped();

    // 退出观察未发送 stop/cancel：Host 同实例存活。
    expect(f.liveHostPid()).toBe(hostPid);
    expect(readDiscoveryFile(root).hostInstanceId).toBe(hostInstanceId);

    // 原操作继续并正常收尾（新进程/新连接查询）。
    const terminal = await pollTerminalOperation(f, root, operationId, 60_000);
    expect(terminal.status).toBe('completed');
    expect(terminal.state).toBe('passed');
    expect(terminal.checks[0]).toMatchObject({ checkKey, status: 'passed', exitCode: 0 });
    expect(terminal.codeIdentity.headCommit).toBe(headCommit);
    const artifactId = terminal.checks[0]!.output!.artifactId;
    const evidenceResult = resultOf(
      await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], {
        label: 'client-b-evidence',
      }),
    ) as { artifactId: string; byteSize: number; content: string };
    expect(evidenceResult.content).toBe('[stdout]late-ok\n');
    const digest = artifactContentDigest(artifactId, evidenceResult.content);

    // 零 stop/cancel 痕迹（只读探针）。
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.counts()).toMatchObject({ command_receipts: 3 });
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

    f.evidence.record('p02-4.fr2.client_exit.follow', {
      hostInstanceId,
      operationId,
      cliExitCode: 4,
      errorCode: 'observation_interrupted',
      envelopeCount: envelopes.length,
      stopOrCancelSent: 'none',
      terminalState: terminal.state,
      artifactByteSize: digest.sizeBytes,
    });
    const document = exportScannedEvidence(
      { operation: terminal, artifacts: [digest], notes: ['P02-FR2-CLIENT-EXIT (--follow)'] },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR1-RESTART-QUERY：显式停止三证据 + 重启后持久身份查询
 * ------------------------------------------------------------------ */

/** 全局配置初始值（政策段；生产 Host 能力目录为空，策略条目留空即合法）。 */
const GLOBAL_CREATE_PAYLOAD = {
  schemaVersion: 2,
  policies: {
    executionLimits: { maxConcurrentWorks: 2, workTimeoutMs: 600_000 },
    verification: { requireChecksBeforeDone: true },
  },
} as const;

/** 全局配置更新值（revision 递进后的当前值）。 */
const GLOBAL_UPDATE_PAYLOAD = {
  schemaVersion: 2,
  policies: {
    executionLimits: { maxConcurrentWorks: 4, workTimeoutMs: 300_000 },
    verification: { requireChecksBeforeDone: true },
  },
} as const;

/** 项目配置（覆盖 executionLimits 段；securityPolicy 为项目独有段）。 */
const PROJECT_PAYLOAD = {
  schemaVersion: 2,
  policies: {
    executionLimits: { maxConcurrentWorks: 1 },
    securityPolicy: { isolation: 'trusted_project' },
  },
} as const;

describe('P02-FR1-RESTART-QUERY Host 安全停止/重启与持久身份查询', () => {
  it('已完成基线后显式 host stop（三证据）→ 重启新实例：双新 CLI 读取持久身份一致、旧凭据拒绝、旧实例清理不删当前发现、回执可查询、原基线不重跑', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const canonicalRoot = realpathSync(root);
    const repoPath = f.repos.withHead;
    const headCommit = f.repos.headOf('withHead');
    const registerCommandId = randomUUID();
    const baselineCommandId = randomUUID();

    // --- 准备（全部经正式 CLI）：注册 + 配置（global create→update、project create）。 ---
    const init = await f.runDistCli(
      [
        'project', 'init', repoPath, '--confirm',
        '--name', '重启查询持久身份项目',
        '--description', 'P02-4 FR-1 重启后持久状态验收',
        '--label', 'p02-4-fr1', '--label', 'restart-query',
        '--command-id', registerCommandId,
        '--data-root', root, '--json',
      ],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const initResult = singleEnvelope(init).result as {
      registration: { projectId: string };
      preview: { repoIdentity: string };
    };
    const projectId = initResult.registration.projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);
    const repoIdentity = initResult.preview.repoIdentity;

    const inputDir = join(f.root, 'inputs');
    mkdirSync(inputDir, { recursive: true });
    const writeInput = (name: string, value: unknown): string => {
      const file = join(inputDir, `${name}-${randomUUID().slice(0, 8)}.json`);
      writeFileSync(file, JSON.stringify(value), 'utf8');
      return file;
    };

    const globalCreate = resultOf(
      await f.runDistCli(
        ['config', 'create', '--scope', 'global', '--input', writeInput('global-create', GLOBAL_CREATE_PAYLOAD), '--data-root', root, '--json'],
        { label: 'client-a-config-create' },
      ),
    ) as { result: { revision: number } };
    expect(globalCreate.result.revision).toBe(1);
    const globalUpdate = resultOf(
      await f.runDistCli(
        [
          'config', 'update', '--scope', 'global', '--revision', '1',
          '--input', writeInput('global-update', GLOBAL_UPDATE_PAYLOAD), '--data-root', root, '--json',
        ],
        { label: 'client-a-config-update' },
      ),
    ) as { result: { revision: number } };
    expect(globalUpdate.result.revision).toBe(2);
    const projectCreate = resultOf(
      await f.runDistCli(
        [
          'config', 'create', '--scope', 'project', '--project', projectId,
          '--input', writeInput('project-create', PROJECT_PAYLOAD), '--data-root', root, '--json',
        ],
        { label: 'client-a-config-project-create' },
      ),
    ) as { result: { revision: number } };
    expect(projectCreate.result.revision).toBe(1);

    // --- 计数成功基线（显式 commandId；每次实际启动追加一行）。 ---
    const markerScript = writeMarkerScript(f);
    const markerFile = join(f.root, `marker-${randomUUID().slice(0, 8)}.log`);
    const planFile = writePlanFile(f, [
      commandCheck('p02-4-restart-baseline', [process.execPath, markerScript, markerFile]),
    ]);
    const run = await f.runDistCli(
      [
        'baseline', 'run', '--project', projectId, '--input', planFile,
        '--confirm', '--command-id', baselineCommandId, '--data-root', root, '--json',
      ],
      { label: 'client-a-baseline-run' },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    const operationId = (resultOf(run) as { operationId: string }).operationId;
    expect(operationId).toMatch(UUID_V4_PATTERN);
    const terminalBefore = await pollTerminalOperation(f, root, operationId, 60_000);
    expect(terminalBefore.status).toBe('completed');
    expect(terminalBefore.state).toBe('passed');
    const artifactId = terminalBefore.checks[0]!.output!.artifactId;
    expect(markerLaunchCount(markerFile)).toBe(1);

    // --- 重启前持久状态快照（新进程/新连接；重启后逐字段比对）。 ---
    const projectBefore = resultOf(
      await f.runDistCli(['project', 'get', projectId, '--data-root', root, '--json'], { label: 'client-b-project-get' }),
    );
    const globalBefore = resultOf(
      await f.runDistCli(['config', 'get', '--scope', 'global', '--data-root', root, '--json'], { label: 'client-b-config-global' }),
    );
    const projectConfigBefore = resultOf(
      await f.runDistCli(['config', 'get', '--scope', 'project', '--project', projectId, '--data-root', root, '--json'], { label: 'client-b-config-project' }),
    );
    const statusBefore = extractOperationSnapshot(
      resultOf(
        await f.runDistCli(['baseline', 'status', operationId, '--data-root', root, '--json'], { label: 'client-b-baseline-status' }),
      ),
    );
    const evidenceBefore = resultOf(
      await f.runDistCli(['baseline', 'evidence', artifactId, '--data-root', root, '--json'], { label: 'client-b-baseline-evidence' }),
    );
    const receiptBefore = receiptOf(
      await f.runDistCli(['receipt', 'get', baselineCommandId, '--data-root', root, '--json'], { label: 'client-b-receipt' }),
    );
    expect(receiptBefore.commandId).toBe(baselineCommandId);
    expect(receiptBefore.status).toBe('accepted');
    expect(receiptBefore.operationId).toBe(operationId);
    const digestBefore = artifactContentDigest(
      artifactId,
      (evidenceBefore as { content: string }).content,
    );

    const discoveryBefore = readDiscoveryFile(root);
    const oldInstance = discoveryBefore.hostInstanceId as string;
    const oldPid = discoveryBefore.pid as number;
    const dataRootIdentity = discoveryBefore.dataRootIdentity as string;
    const oldToken = readHostToken(root);
    f.evidence.registerSecret(oldToken);
    expect(f.liveHostPid()).toBe(oldPid);

    const probeBefore = openDataRootStorageProbe(root);
    try {
      expect(probeBefore.counts()).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        global_settings: 1,
        project_settings: 1,
        command_receipts: 6,
        artifacts: 3,
        state_events: 8,
      });
      expect(probeBefore.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.global_created',
        'settings.global_updated',
        'settings.project_created',
        'baseline.authorized',
        'baseline.started',
        'baseline.check_completed',
        'baseline.completed',
      ]);
    } finally {
      probeBefore.close();
    }

    // --- 正式显式 host stop（三证据：进程退出/锁可获取/发现移除）。 ---
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    const stopResult = resultOf(stop) as {
      commandId: string;
      status: string;
      hostInstanceId: string;
      replayed: boolean;
      evidence: { processExit: string; lock: string; discovery: string };
    };
    expect(stopResult.status).toBe('stopped');
    expect(stopResult.hostInstanceId).toBe(oldInstance);
    expect(stopResult.replayed).toBe(false);
    expect(stopResult.evidence).toEqual({ processExit: 'confirmed', lock: 'acquirable', discovery: 'removed' });

    // 独立复核实际退出与锁释放（不依赖 CLI 自述）：pid 消失、发现/凭据删除、
    // writer.lock 保留、锁可获取、状态库保留。
    await waitFor(() => f.liveHostPid() === null, 10_000);
    expect(pidAlive(oldPid)).toBe(false);
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);
    expect(existsSync(join(root, 'host', 'auth.token'))).toBe(false);
    expect(existsSync(join(root, 'host', 'writer.lock'))).toBe(true);
    expect(existsSync(join(root, 'core.sqlite'))).toBe(true);
    const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
    lock.releaseAfterWritesClosed();

    // --- 重启（新 CLI 进程/新连接）：新 hostInstanceId。 ---
    const restart = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'client-c-host-restart',
    });
    expect(restart.exitCode, restart.stderr).toBe(0);
    const restartResult = resultOf(restart) as {
      outcome: string;
      hostInstanceId: string;
      dataRootIdentity: string;
      port: number;
      lifecycleState: string;
    };
    expect(restartResult.outcome).toBe('started');
    const newInstance = restartResult.hostInstanceId;
    expect(newInstance).toMatch(UUID_V4_PATTERN);
    expect(newInstance).not.toBe(oldInstance);
    expect(restartResult.dataRootIdentity).toBe(dataRootIdentity);
    expect(restartResult.lifecycleState).toBe('ready');
    const newPort = restartResult.port;
    const discoveryAfter = readDiscoveryFile(root);
    expect(discoveryAfter.hostInstanceId).toBe(newInstance);
    expect(discoveryAfter.pid).not.toBe(oldPid);
    expect(f.liveHostPid()).toBe(discoveryAfter.pid);
    const newToken = readHostToken(root);
    f.evidence.registerSecret(newToken);
    expect(newToken).not.toBe(oldToken);

    // --- 两个新 CLI（新进程/新连接）读取持久身份：与重启前及彼此逐字段一致。 ---
    const [projectD, projectE] = await f.raceDistClis([
      { args: ['project', 'get', projectId, '--data-root', root, '--json'], label: 'client-d-project-get' },
      { args: ['project', 'get', projectId, '--data-root', root, '--json'], label: 'client-e-project-get' },
    ]);
    const projectDResult = resultOf(projectD);
    expect(projectDResult).toEqual(projectBefore);
    expect(projectDResult).toEqual(resultOf(projectE));

    const [globalD, globalE] = await f.raceDistClis([
      { args: ['config', 'get', '--scope', 'global', '--data-root', root, '--json'], label: 'client-d-config-global' },
      { args: ['config', 'get', '--scope', 'global', '--data-root', root, '--json'], label: 'client-e-config-global' },
    ]);
    expect(resultOf(globalD)).toEqual(globalBefore);
    expect(resultOf(globalD)).toEqual(resultOf(globalE));

    const [projectConfigD, projectConfigE] = await f.raceDistClis([
      { args: ['config', 'get', '--scope', 'project', '--project', projectId, '--data-root', root, '--json'], label: 'client-d-config-project' },
      { args: ['config', 'get', '--scope', 'project', '--project', projectId, '--data-root', root, '--json'], label: 'client-e-config-project' },
    ]);
    expect(resultOf(projectConfigD)).toEqual(projectConfigBefore);
    expect(resultOf(projectConfigD)).toEqual(resultOf(projectConfigE));

    const [statusD, statusE] = await f.raceDistClis([
      { args: ['baseline', 'status', operationId, '--data-root', root, '--json'], label: 'client-d-baseline-status' },
      { args: ['baseline', 'status', operationId, '--data-root', root, '--json'], label: 'client-e-baseline-status' },
    ]);
    const statusDView = extractOperationSnapshot(resultOf(statusD));
    expect(statusDView).toEqual(statusBefore);
    expect(statusDView).toEqual(extractOperationSnapshot(resultOf(statusE)));
    // 基线结果/代码身份/输出制品引用逐字段保持（completed/passed、退出码 0、
    // headCommit、artifactId/byteSize）。
    expect(statusDView).toMatchObject({
      status: 'completed',
      state: 'passed',
      codeIdentity: { headCommit, hasUncommittedChanges: false },
    });
    expect(statusDView.checks[0]).toMatchObject({
      checkKey: 'p02-4-restart-baseline',
      status: 'passed',
      exitCode: 0,
      output: { artifactId, truncated: false },
    });

    const [evidenceD, evidenceE] = await f.raceDistClis([
      { args: ['baseline', 'evidence', artifactId, '--data-root', root, '--json'], label: 'client-d-baseline-evidence' },
      { args: ['baseline', 'evidence', artifactId, '--data-root', root, '--json'], label: 'client-e-baseline-evidence' },
    ]);
    const evidenceDResult = resultOf(evidenceD);
    expect(evidenceDResult).toEqual(evidenceBefore);
    expect(evidenceDResult).toEqual(resultOf(evidenceE));
    const digestD = artifactContentDigest(artifactId, (evidenceDResult as { content: string }).content);
    expect(digestD).toEqual(digestBefore);

    // 持久回执可查询（新进程/新连接）：原 accepted 回执身份不变。
    const [receiptD, receiptE] = await f.raceDistClis([
      { args: ['receipt', 'get', baselineCommandId, '--data-root', root, '--json'], label: 'client-d-receipt' },
      { args: ['receipt', 'get', baselineCommandId, '--data-root', root, '--json'], label: 'client-e-receipt' },
    ]);
    const receiptDView = receiptOf(receiptD);
    expect(receiptE.exitCode, receiptE.stderr).toBe(0);
    expect(receiptDView).toEqual(receiptOf(receiptE));
    expect(receiptDView).toMatchObject({
      commandId: baselineCommandId,
      status: 'accepted',
      replayed: false,
      operationId,
    });

    // baseline list：同一唯一操作（无重跑产生的新记录）。
    const listAfter = resultOf(
      await f.runDistCli(['baseline', 'list', '--project', projectId, '--data-root', root, '--json'], {
        label: 'client-d-baseline-list',
      }),
    ) as { records: Array<{ operationId: string; status: string; state: string }> };
    expect(listAfter.records).toHaveLength(1);
    expect(listAfter.records[0]).toMatchObject({ operationId, status: 'completed', state: 'passed' });

    // --- 旧 token / 旧实例对新 Host 明确拒绝（真实回环请求；对照新凭据可用）。 ---
    const handshakeBody = (hostInstanceId: string): Record<string, unknown> => ({
      schemaVersion: 5,
      protocolVersion: 1,
      hostInstanceId,
      dataRootIdentity,
    });
    const staleToken = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: oldToken,
      body: handshakeBody(newInstance),
    });
    expectRejected(staleToken, 401, 'unauthorized', 'host.handshake');
    const staleInstance = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: newToken,
      body: handshakeBody(oldInstance),
    });
    expectRejected(staleInstance, 409, 'instance_mismatch', 'host.handshake');
    const valid = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: newToken,
      body: handshakeBody(newInstance),
    });
    expect(valid.statusCode, valid.bodyText).toBe(200);
    for (const response of [staleToken, staleInstance, valid]) {
      expect(response.bodyText).not.toContain(oldToken);
      expect(response.bodyText).not.toContain(newToken);
    }

    // --- 旧实例清理不删除当前发现信息（按实例清理第二道防线）。 ---
    const staleCleanup = createHostFileStore({ canonicalRoot }).cleanupInstanceFiles(oldInstance);
    expect(staleCleanup).toEqual({
      outcome: 'skipped_instance_mismatch',
      deletedDiscovery: false,
      deletedAuthToken: false,
    });
    expect(readDiscoveryFile(root).hostInstanceId).toBe(newInstance);
    expect(existsSync(join(root, 'host', 'auth.token'))).toBe(true);
    expect(f.liveHostPid()).toBe(discoveryAfter.pid);

    // --- 原基线未自动重跑 + 持久状态不变（只读探针 + 真实启动计数）。 ---
    expect(markerLaunchCount(markerFile)).toBe(1);
    const probeAfter = openDataRootStorageProbe(root);
    try {
      expect(probeAfter.counts()).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        global_settings: 1,
        project_settings: 1,
        command_receipts: 6,
        artifacts: 3,
        state_events: 8,
      });
      expect(probeAfter.projectRow(projectId)?.display_name).toBe('重启查询持久身份项目');
      expect(probeAfter.settingsRow('global')?.revision).toBe(2);
      expect(probeAfter.settingsRow('project', projectId)?.revision).toBe(1);
      expect(probeAfter.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(1);
      expect(probeAfter.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(1);
      expect(probeAfter.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.global_created',
        'settings.global_updated',
        'settings.project_created',
        'baseline.authorized',
        'baseline.started',
        'baseline.check_completed',
        'baseline.completed',
      ]);
    } finally {
      probeAfter.close();
    }

    // --- 证据（脱敏）：前后实例、实际退出/锁状态、持久身份核对记录。 ---
    f.evidence.record('p02-4.fr1.restart_query', {
      oldInstance,
      newInstance,
      oldPid,
      newPid: discoveryAfter.pid,
      dataRootIdentity,
      stopEvidence: stopResult.evidence,
      stopStatus: stopResult.status,
      persistentIdentity: 'project/config/baseline/artifact/receipt:consistent',
      markerLaunches: markerLaunchCount(markerFile),
      rejected: { staleToken: '401 unauthorized', staleInstance: '409 instance_mismatch' },
      staleCleanupOutcome: staleCleanup.outcome,
    });
    const document = exportScannedEvidence(
      {
        repositories: [f.snapshotRepository(repoPath)],
        operation: statusDView,
        artifacts: [digestD],
        hostIdentity: {
          hostInstanceId: newInstance,
          dataRootIdentity,
          lifecycleState: restartResult.lifecycleState,
          pid: discoveryAfter.pid as number,
          listenAddress: '127.0.0.1',
          port: newPort,
          protocolVersion: 1,
        },
        notes: ['P02-FR1-RESTART-QUERY'],
      },
      [oldToken, newToken],
    );
    expect(document).toContain(newInstance);
    expect(document).toContain(headCommit);
    expect(document).toContain(operationId);

    // 收尾：受控停止新 Host。
    const stopAgain = await f.stopHost();
    expect(stopAgain.exitCode, stopAgain.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * 验收 4：崩溃恢复（复用前序停止/崩溃回归的 CLI 级复验）
 * ------------------------------------------------------------------ */

describe('P02-4 Host 崩溃恢复 CLI 级复验（前序真实活动停止/崩溃恢复回归补充）', () => {
  it('SIGKILL Host 后经正式 CLI 重启：受控进程 fail-closed 停止、恢复核验后原操作 interrupted/restart_recovery 不重跑、占用释放后新基线可继续', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '崩溃恢复复验项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    // 挂起计数检查：记录自身 pid、追加启动行后挂起（SIGTERM 可停）。
    const hangScript = writeHangCounterScript(f);
    const counterFile = join(f.root, `counter-${randomUUID().slice(0, 8)}.log`);
    const checkPidFile = join(f.root, `check-pid-${randomUUID().slice(0, 8)}.txt`);
    const planFile = writePlanFile(f, [
      commandCheck('p02-4-crash-recovery', [process.execPath, hangScript, counterFile, checkPidFile]),
    ]);
    const run = await f.runDistCli(
      ['baseline', 'run', '--project', projectId, '--input', planFile, '--confirm', '--data-root', root, '--json'],
      { label: 'client-a-baseline-run' },
    );
    const operationId = (resultOf(run) as { operationId: string }).operationId;

    // 实际运行就绪信号：受控进程已启动（计数 1 行 + pid 文件）、真实存活且操作 running。
    await waitFor(
      () => markerLaunchCount(counterFile) === 1 && existsSync(checkPidFile),
      30_000,
    );
    const crashedCheckPid = Number(readFileSync(checkPidFile, 'utf8').trim());
    expect(Number.isInteger(crashedCheckPid)).toBe(true);
    expect(pidAlive(crashedCheckPid)).toBe(true);
    await pollListedOperationRunning(f, root, projectId, 30_000);
    const hostPid = f.liveHostPid();
    expect(hostPid).not.toBeNull();
    // 崩溃现场占用保留（claim 存在）。
    const claimFile = join(repoPath, '.git', 'shiploop-baseline.claim');
    expect(existsSync(claimFile)).toBe(true);

    // 崩溃：SIGKILL Host（真实宿主进程死亡）。受监督进程 fail-closed：与 Host 的
    // IPC 断开即对受控进程组发出 SIGTERM（5s 升级 SIGKILL），不等待重启后补救——
    // 旧受控进程被真实停止，而非仅按记录推断。
    process.kill(hostPid as number, 'SIGKILL');
    await waitFor(() => f.liveHostPid() === null, 10_000);
    await waitFor(() => !pidAlive(crashedCheckPid), 15_000);
    // 崩溃后、重启前：占用仍保留（claim 未释放；停止尚未经 Host 核验）。
    expect(existsSync(claimFile)).toBe(true);

    // 重启（新 CLI 进程/新连接）：启动即恢复——对旧受控进程组做真实停止核验
    //（组不存在探测确认）后才标记 interrupted/restart_recovery 并释放占用。
    const restart = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'client-c-host-restart',
    });
    expect(restart.exitCode, restart.stderr).toBe(0);
    const restartResult = resultOf(restart) as { outcome: string; hostInstanceId: string };
    expect(restartResult.outcome).toBe('started');
    const newInstance = restartResult.hostInstanceId;
    expect(newInstance).toMatch(UUID_V4_PATTERN);

    // 原操作终态：interrupted/restart_recovery（不冒充通过）；检查 inconclusive。
    const interrupted = await pollTerminalOperation(f, root, operationId, 60_000);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.checks).toHaveLength(1);
    expect(interrupted.checks[0]).toMatchObject({
      status: 'inconclusive',
      reasonCode: 'restart_recovery',
    });

    // 旧受控进程停止核验完成（fail-closed 停止 + 重启恢复的组不存在探测；
    // 未确认则保持占用为 stop_unconfirmed，不会到达这里）。
    expect(markerLaunchCount(counterFile)).toBe(1);
    expect(existsSync(claimFile)).toBe(false);
    const listAfterCrash = resultOf(
      await f.runDistCli(['baseline', 'list', '--project', projectId, '--data-root', root, '--json'], {
        label: 'client-d-baseline-list',
      }),
    ) as { records: Array<{ operationId: string; status: string }> };
    expect(listAfterCrash.records).toHaveLength(1);
    expect(listAfterCrash.records[0]).toMatchObject({ operationId, status: 'interrupted' });

    // 占用释放后新基线可继续（fresh 授权运行成功样例）。
    const freshPlan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-crash-fresh' });
    const freshPlanFile = writePlanFile(f, freshPlan.checks);
    const freshRun = await f.runDistCli(
      [
        'baseline', 'run', '--project', projectId, '--input', freshPlanFile,
        '--confirm', '--data-root', root, '--json',
      ],
      { label: 'client-d-fresh-baseline-run' },
    );
    expect(freshRun.exitCode, freshRun.stderr).toBe(0);
    const freshOperationId = (resultOf(freshRun) as { operationId: string }).operationId;
    const freshTerminal = await pollTerminalOperation(f, root, freshOperationId, 60_000);
    expect(freshTerminal.status).toBe('completed');
    expect(freshTerminal.state).toBe('passed');
    expect(freshTerminal.checks[0]).toMatchObject({ status: 'passed', exitCode: 0 });

    // 证据（脱敏）。
    f.evidence.record('p02-4.crash_recovery', {
      newInstance,
      operationId,
      interruptedStatus: interrupted.status,
      checkReason: 'restart_recovery',
      oldCheckProcessStopped: 'verified',
      markerLaunches: markerLaunchCount(counterFile),
      claimReleased: true,
      freshOperationState: freshTerminal.state,
    });
    const document = exportScannedEvidence(
      {
        hostIdentity: extractHostIdentity(restartResult),
        operation: interrupted,
        notes: ['P02-4 崩溃恢复 CLI 级复验（验收 4）'],
      },
      [readHostToken(root)],
    );
    expect(document).toContain(operationId);
    expect(document).toContain(newInstance);

    // 收尾：受控停止 Host。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});
