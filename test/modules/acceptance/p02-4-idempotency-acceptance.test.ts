/**
 * F-004 P02-4 重复 init、同命令重放与参数冲突的跨客户端真实验收场景。
 *
 * 对应 docs/p02-4-acceptance-contract.md §2.1 冻结的两个必需检查（全部 required）：
 * - `P02-FR2-DUPLICATE-INIT`：两个真实 dist CLI 对同规范路径及其真实路径别名
 *   （fixture symlink，realpath 后同一仓库）重复 init——得到同一 `projectId`；
 *   项目/绑定各只有一份；原名称、描述、标签和项目配置未被重复初始化覆盖
 *   （重复 init 以不同参数确认也不改写既有元数据、revision 不递增、无第二次
 *   注册事件）；
 * - `P02-FR2-COMMAND-CONFLICT`：经前序支持的显式 `--command-id` 入口重放相同
 *   注册/基线请求——返回原持久回执与结果身份（`replayed:true`、同
 *   `resultRef`/`operationId`/`completedAt`），以受检命令真实落盘计数（marker
 *   文件行数）、项目行数与相应事件证明未重复注册或运行基线；相同
 *   principal/commandId 携带不同业务参数得 `conflict`（`idempotency_key_reuse`）
 *   且项目、revision、检查记录、启动次数和源文件均未产生额外变更；原回执仍
 *   可经 `receipt get` 跨客户端查询。
 *
 * F-004 验收纪律：全部写入经真实 `packages/cli/dist/bin.js`（project init /
 * project register / config create / baseline run）；不新建通用回执系统、不手工
 * 改 SQLite（数据库只经 p02-2 只读探针核对）、不以换命令 ID 把重复执行伪装成
 * 幂等（重放/冲突全部用同一 commandId 重新提交）；判定以结构化信封 + 只读持久
 * 行 + 受检命令真实落盘标记为准，不以成功文本/日志替代。
 *
 * 运行前提：macOS（flock）；`beforeAll` 先 `npm run build` 保证 dist 与源码一致。
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME（复用 F-002
 * 隔离夹具；回收 fail-closed：停止未确认即保留资源与诊断）。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDistCliBuilt,
  createAcceptanceFixture,
  exportEvidenceDocument,
  extractOperationSnapshot,
  scanForCredentialShapes,
  singleEnvelope,
  type AcceptanceFixture,
  type DistCliResult,
  type EvidenceDocumentInput,
  type OperationSnapshot,
} from '../../helpers/p02-4/index.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* ------------------------------------------------------------------ *
 * 夹具与公共小工具
 * ------------------------------------------------------------------ */

const activeFixtures: AcceptanceFixture[] = [];

function useFixture(): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix: 'shiploop-p02-4-f004-', stepMs: 300 });
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

/** 导出脱敏证据文档：凭据形状扫描为空 + 真实 token 不出现（fail-closed）。 */
function exportScannedEvidence(input: EvidenceDocumentInput, dataRoot: string): string {
  const document = exportEvidenceDocument(input);
  expect(scanForCredentialShapes(JSON.parse(document))).toEqual([]);
  const token = readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8').trim();
  expect(document).not.toContain(token);
  return document;
}

/** 基线操作轮询：pass 依据只来自持久检查终态（不来自 accepted 回执）。 */
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
    const envelope = singleEnvelope(status);
    expect(envelope.ok, status.stderr).toBe(true);
    expect(envelope.command).toBe('baseline.status');
    const snapshot = extractOperationSnapshot(envelope.result as Record<string, unknown>);
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

/** 回执结果视图（`project register`/`receipt get` 的结构化结果形状）。 */
interface CliReceiptView {
  readonly commandId: string;
  readonly operation: string;
  readonly status: string;
  readonly replayed: boolean;
  readonly requestDigest?: string;
  readonly issuedAt?: string;
  readonly completedAt?: string;
  readonly resultRef?: string;
  readonly result?: Record<string, unknown>;
  /** 仅 accepted 回执（baseline.run authorize）携带。 */
  readonly operationId?: string;
}

function receiptOf(result: DistCliResult): CliReceiptView {
  return resultOf(result) as unknown as CliReceiptView;
}

/**
 * 受检命令真实落盘计数：marker 脚本每次被实际启动都向 marker 文件追加一行
 * （stdout 固定 `marker-ok`）。重放/冲突后行数不变即「实际启动次数」证据——
 * 不以回执/事件数量替代真实进程启动核对。
 */
const MARKER_SCRIPT_SOURCE = [
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync(process.argv[2], 'launch\\n');",
  "process.stdout.write('marker-ok\\n');",
  '',
].join('\n');

function markerLaunchCount(markerFile: string): number {
  try {
    return readFileSync(markerFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * P02-FR2-DUPLICATE-INIT：重复初始化与真实路径别名
 * ------------------------------------------------------------------ */

describe('P02-FR2-DUPLICATE-INIT 重复初始化与真实路径别名', () => {
  it('两个 CLI 对同规范路径及其真实路径别名重复 init：同一 projectId、项目/绑定各一份、原名称/描述/标签/配置未被覆盖', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const aliasPath = f.repos.alias;
    const canonicalRepo = realpathSync(repoPath);
    // 前置核验：别名是真实路径别名（realpath 与规范路径同一仓库），不是另一个仓库。
    expect(realpathSync(aliasPath)).toBe(canonicalRepo);

    const originalName = '重复初始化原始项目';
    const originalDescription = 'P02-4 FR-2 重复初始化验收：原始描述';
    // 提交顺序即持久顺序（normalizeLabels 只做 trim/小写/NFC/去重，不排序）。
    const originalLabels = ['p02-4-fr2', 'duplicate-init'];
    const overwriteName = '重复 init 参数不得覆盖原名称';
    const overwriteDescription = '重复 init 参数不得覆盖原描述';
    const overwriteLabel = 'must-not-apply';

    // --- CLI A：首次 init（规范路径）→ registered。 ---
    const firstInit = await f.runDistCli(
      [
        'project', 'init', repoPath, '--confirm',
        '--name', originalName,
        '--description', originalDescription,
        '--label', originalLabels[0], '--label', originalLabels[1],
        '--data-root', root, '--json',
      ],
      { label: 'client-a-init-canonical' },
    );
    expect(firstInit.exitCode, firstInit.stderr).toBe(0);
    const firstResult = resultOf(firstInit) as {
      preview: { canonicalPath: string; alreadyRegisteredProjectId: string | null };
      registration: { status: string; projectId: string };
    };
    expect(firstResult.registration.status).toBe('registered');
    const projectId = firstResult.registration.projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);
    expect(firstResult.preview.canonicalPath).toBe(canonicalRepo);
    expect(firstResult.preview.alreadyRegisteredProjectId).toBeNull();

    // --- CLI A：写入项目配置（重复 init 不得覆盖它）。 ---
    const inputDir = join(f.root, 'inputs');
    mkdirSync(inputDir, { recursive: true });
    const writeInput = (name: string, text: string, extension: string): string => {
      const file = join(inputDir, `${name}-${randomUUID().slice(0, 8)}.${extension}`);
      writeFileSync(file, text, 'utf8');
      return file;
    };
    const projectPayload = {
      schemaVersion: 2,
      policies: {
        executionLimits: { maxConcurrentWorks: 1 },
        securityPolicy: { isolation: 'trusted_project' },
      },
    };
    const configCreate = await f.runDistCli(
      [
        'config', 'create', '--scope', 'project', '--project', projectId,
        '--input', writeInput('project-create', JSON.stringify(projectPayload), 'json'),
        '--data-root', root, '--json',
      ],
      { label: 'client-a-config-create' },
    );
    expect(configCreate.exitCode, configCreate.stderr).toBe(0);
    const configReceipt = resultOf(configCreate) as {
      status: string;
      result: { scope: { kind: string }; revision: number; payload: unknown };
    };
    expect(configReceipt.status).toBe('completed');
    expect(configReceipt.result.scope).toEqual({ kind: 'project', projectId });
    expect(configReceipt.result.revision).toBe(1);

    // --- CLI B：重复 init（真实路径别名 + 完全不同的元数据参数）→ already_registered、同一 projectId。 ---
    const aliasInit = await f.runDistCli(
      [
        'project', 'init', aliasPath, '--confirm',
        '--name', overwriteName,
        '--description', overwriteDescription,
        '--label', overwriteLabel,
        '--data-root', root, '--json',
      ],
      { label: 'client-b-init-alias' },
    );
    expect(aliasInit.exitCode, aliasInit.stderr).toBe(0);
    const aliasResult = resultOf(aliasInit) as {
      preview: { canonicalPath: string; alreadyRegisteredProjectId: string | null };
      request: { displayName: string; description: string; labels: string[] };
      registration: { status: string; projectId: string };
    };
    expect(aliasResult.registration).toEqual({ status: 'already_registered', projectId });
    // 别名解析为同一规范路径（preview 如实展示）；inspect 已识别既有注册。
    expect(aliasResult.preview.canonicalPath).toBe(canonicalRepo);
    expect(aliasResult.preview.alreadyRegisteredProjectId).toBe(projectId);
    // 请求回显是本次请求参数（未生效）；持久元数据以下方查询/探针核对为准。
    expect(aliasResult.request.displayName).toBe(overwriteName);
    expect(aliasResult.request.labels).toEqual([overwriteLabel]);

    // --- CLI A：再次重复 init（规范路径 + 另一组不同参数）→ already_registered。 ---
    const repeatInit = await f.runDistCli(
      [
        'project', 'init', repoPath, '--confirm',
        '--name', `${overwriteName}-2`,
        '--data-root', root, '--json',
      ],
      { label: 'client-a-init-canonical-again' },
    );
    expect(repeatInit.exitCode, repeatInit.stderr).toBe(0);
    const repeatResult = resultOf(repeatInit) as {
      preview: { canonicalPath: string; alreadyRegisteredProjectId: string | null };
      registration: { status: string; projectId: string };
    };
    expect(repeatResult.registration).toEqual({ status: 'already_registered', projectId });
    expect(repeatResult.preview.canonicalPath).toBe(canonicalRepo);
    expect(repeatResult.preview.alreadyRegisteredProjectId).toBe(projectId);

    // --- 双客户端并发查询一致：唯一项目、原名称/描述/标签、revision 不递增。 ---
    const [listA, listB] = await f.raceDistClis([
      { args: ['project', 'list', '--data-root', root, '--json'], label: 'client-a-list' },
      { args: ['project', 'list', '--data-root', root, '--json'], label: 'client-b-list' },
    ]);
    expect(listA.exitCode, listA.stderr).toBe(0);
    expect(listB.exitCode, listB.stderr).toBe(0);
    const listResultA = resultOf(listA) as {
      records: Array<{
        id: string;
        displayName: string;
        description: string;
        labels: string[];
        revision: number;
      }>;
    };
    expect(listResultA).toEqual(resultOf(listB));
    expect(listResultA.records).toHaveLength(1);
    expect(listResultA.records[0]).toMatchObject({
      id: projectId,
      displayName: originalName,
      description: originalDescription,
      labels: originalLabels,
      revision: 1,
    });

    // --- CLI B：project get——唯一绑定记录的是规范路径（非别名拼写）。 ---
    const get = await f.runDistCli(
      ['project', 'get', projectId, '--data-root', root, '--json'],
      { label: 'client-b-get' },
    );
    expect(get.exitCode, get.stderr).toBe(0);
    const detail = resultOf(get) as {
      project: { id: string; displayName: string; description: string; labels: string[]; revision: number };
      binding: { projectId: string; canonicalPath: string } | null;
    };
    expect(detail.project).toMatchObject({
      id: projectId,
      displayName: originalName,
      description: originalDescription,
      labels: originalLabels,
      revision: 1,
    });
    expect(detail.binding).not.toBeNull();
    expect(detail.binding!.projectId).toBe(projectId);
    expect(detail.binding!.canonicalPath).toBe(canonicalRepo);

    // --- CLI B：config get——项目配置保持原值原 revision（未被重复 init 覆盖）。 ---
    const configGet = await f.runDistCli(
      ['config', 'get', '--scope', 'project', '--project', projectId, '--data-root', root, '--json'],
      { label: 'client-b-config-get' },
    );
    expect(configGet.exitCode, configGet.stderr).toBe(0);
    expect(resultOf(configGet)).toEqual({
      scope: { kind: 'project', projectId },
      schemaVersion: 2,
      revision: 1,
      payload: projectPayload,
    });

    // --- CLI B：overview——注册轴仍 registered、配置轴仍存在、健康轴不受影响。 ---
    const overview = await f.runDistCli(
      ['project', 'overview', projectId, '--data-root', root, '--json'],
      { label: 'client-b-overview' },
    );
    expect(overview.exitCode, overview.stderr).toBe(0);
    const overviewResult = resultOf(overview) as {
      registration: { status: string };
      settings: { configured: boolean; revision?: number; schemaVersion?: number };
      health: { status: string };
    };
    expect(overviewResult.registration.status).toBe('registered');
    expect(overviewResult.settings).toEqual({ configured: true, revision: 1, schemaVersion: 2 });
    expect(overviewResult.health.status).toBe('not_run');

    // --- 只读 SQLite 探针：项目/绑定各一份、元数据/配置未被覆盖、事件恰一次注册。 ---
    const probe = f.storageProbe();
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts()).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        project_settings: 1,
        state_events: 2,
        // 三次 register（首次 init + 两次重复 init）+ 一次 config create；
        // 重复 init 的 already_exists 不产生第二条回执（幂等键各不相同）。
        command_receipts: 4,
      });
      const projectRow = probe.projectRow(projectId);
      expect(projectRow?.display_name).toBe(originalName);
      expect(projectRow?.description).toBe(originalDescription);
      expect(JSON.parse(String(projectRow?.labels))).toEqual(originalLabels);
      expect(projectRow?.revision).toBe(1);
      const bindingRow = probe.selectOne(
        'SELECT project_id, canonical_path FROM repository_bindings WHERE project_id = ?',
        [projectId],
      );
      expect(bindingRow).toMatchObject({ project_id: projectId, canonical_path: canonicalRepo });
      const settingsRow = probe.settingsRow('project', projectId);
      expect(settingsRow?.revision).toBe(1);
      expect(settingsRow?.schema_version).toBe(2);
      expect(JSON.parse(String(settingsRow?.payload))).toEqual(projectPayload);
      // 持久审计事件与写入序列一致：重复 init 不追加第二条注册事件。
      expect(probe.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.project_created',
      ]);
    } finally {
      probe.close();
    }

    // 证据保留：两次返回 projectId、项目/绑定行数、元数据前后快照、别名 realpath。
    f.evidence.record('p02-4.fr2.duplicate_init', {
      projectId,
      canonicalRepo,
      aliasRealpathEqualsCanonical: true,
      initCalls: 3,
      registrationStatuses: ['registered', 'already_registered', 'already_registered'],
      projectRows: 1,
      bindingRows: 1,
      projectRevision: 1,
      projectSettingsRevision: 1,
      originalMetadataPreserved: true,
      registerEvents: 1,
      commandReceipts: 4,
    });
    const document = exportScannedEvidence(
      { repositories: [f.snapshotRepository(repoPath)], notes: ['P02-FR2-DUPLICATE-INIT'] },
      root,
    );
    expect(document).toContain(canonicalRepo);

    // 收尾：经产品命令受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR2-COMMAND-CONFLICT：显式 commandId 重放与参数冲突
 * ------------------------------------------------------------------ */

describe('P02-FR2-COMMAND-CONFLICT 显式 commandId 重放与参数冲突', () => {
  it('重放相同注册/基线请求返回原持久回执与结果身份、零重复副作用；异参数 conflict 且无额外变更、原回执仍可查询', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const canonicalRepo = realpathSync(repoPath);

    const registerName = '幂等重放注册项目';
    const conflictName = '同 commandId 异参数不得生效';

    // --- CLI A：注册（显式 commandId；前序支持的幂等入口）。 ---
    const registerCommandId = randomUUID();
    const registerArgs = [
      'project', 'register', repoPath,
      '--name', registerName,
      '--command-id', registerCommandId,
      '--data-root', root, '--json',
    ];
    const firstRegister = await f.runDistCli(registerArgs, { label: 'client-a-register' });
    expect(firstRegister.exitCode, firstRegister.stderr).toBe(0);
    const first = receiptOf(firstRegister);
    expect(first.status).toBe('completed');
    expect(first.replayed).toBe(false);
    expect(first.operation).toBe('project.register');
    const projectId = (first.result as { project: { id: string } }).project.id;
    expect(projectId).toMatch(UUID_V4_PATTERN);
    const registerResultRef = first.resultRef;
    const registerRequestDigest = first.requestDigest;
    expect(registerResultRef).toMatch(/^v1\./);
    expect(registerRequestDigest).toMatch(/^[0-9a-f]{64}$/);

    // --- CLI B：重放相同注册请求（同一 commandId、完全相同参数）→ 原持久回执与结果身份。 ---
    const replayRegister = await f.runDistCli(registerArgs, { label: 'client-b-register-replay' });
    expect(replayRegister.exitCode, replayRegister.stderr).toBe(0);
    const replay = receiptOf(replayRegister);
    expect(replay.status).toBe('completed');
    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(registerCommandId);
    expect(replay.resultRef).toBe(registerResultRef);
    expect(replay.requestDigest).toBe(registerRequestDigest);
    expect(replay.issuedAt).toBe(first.issuedAt);
    expect(replay.completedAt).toBe(first.completedAt);
    expect(replay.result).toEqual(first.result);

    // --- 基线准备：受检命令每次实际启动向 marker 文件追加一行（真实启动计数）。 ---
    // 源文件基线快照（注册后、任何基线活动前）：全程结束后比对不变。
    const sourceBefore = f.snapshotRepository(repoPath);
    const inputDir = join(f.root, 'inputs');
    mkdirSync(inputDir, { recursive: true });
    const writeInput = (name: string, text: string, extension: string): string => {
      const file = join(inputDir, `${name}-${randomUUID().slice(0, 8)}.${extension}`);
      writeFileSync(file, text, 'utf8');
      return file;
    };
    const markerScript = writeInput('marker-run', MARKER_SCRIPT_SOURCE, 'mjs');
    const markerFile = join(f.root, `marker-${randomUUID().slice(0, 8)}.log`);
    const markerCheck = {
      checkKey: 'p02-4-replay-marker',
      kind: 'command',
      argv: [process.execPath, markerScript, markerFile],
      timeoutMs: 60_000,
      required: true,
    };
    const planFile = writeInput('plan', JSON.stringify({ checks: [markerCheck] }), 'json');

    // --- CLI A：首次 baseline run（显式 commandId、不加 --wait：回执 accepted + operationId）。 ---
    const baselineCommandId = randomUUID();
    const runArgs = [
      'baseline', 'run',
      '--project', projectId,
      '--input', planFile,
      '--confirm',
      '--command-id', baselineCommandId,
      '--data-root', root, '--json',
    ];
    const firstRun = await f.runDistCli(runArgs, { label: 'client-a-baseline-run' });
    expect(firstRun.exitCode, firstRun.stderr).toBe(0);
    const firstRunResult = resultOf(firstRun) as { operationId: string; status: string; state: string };
    expect(firstRunResult.status).toBe('accepted');
    expect(firstRunResult.state).toBe('accepted');
    const operationId = firstRunResult.operationId;
    expect(operationId).toMatch(UUID_V4_PATTERN);

    // --- CLI B：轮询持久检查终态（passed 唯一依据；accepted 不作 passed 依据）。 ---
    const terminal = await pollTerminalOperation(f, root, operationId, 60_000);
    expect(terminal.status).toBe('completed');
    expect(terminal.state).toBe('passed');
    expect(terminal.checks).toHaveLength(1);
    expect(terminal.checks[0]).toMatchObject({ checkKey: 'p02-4-replay-marker', status: 'passed', exitCode: 0 });
    expect(terminal.checks[0]!.output?.artifactId).toMatch(UUID_V4_PATTERN);
    // 首次运行后：受检命令实际启动次数恰一次（真实落盘计数）。
    expect(markerLaunchCount(markerFile)).toBe(1);

    // --- CLI B：取 accepted 原持久回执（供重放/冲突后比对原回执身份不变）。 ---
    const originalBaselineReceipt = receiptOf(
      await f.runDistCli(
        ['receipt', 'get', baselineCommandId, '--data-root', root, '--json'],
        { label: 'client-b-receipt-baseline-original' },
      ),
    );
    expect(originalBaselineReceipt.status).toBe('accepted');
    expect(originalBaselineReceipt.operationId).toBe(operationId);
    expect(originalBaselineReceipt.replayed).toBe(false);

    // --- CLI B：重放相同基线请求（同一 commandId、同一输入）→ 同一 operationId、零重复副作用。 ---
    const replayRun = await f.runDistCli(runArgs, { label: 'client-b-baseline-replay' });
    expect(replayRun.exitCode, replayRun.stderr).toBe(0);
    const replayRunResult = resultOf(replayRun) as { operationId: string; status: string; state: string };
    expect(replayRunResult.status).toBe('accepted');
    expect(replayRunResult.operationId).toBe(operationId);
    // 重放后：实际启动次数不变（未重复运行基线）。
    expect(markerLaunchCount(markerFile)).toBe(1);

    // 重放零重复副作用（只读探针）：项目未重复注册、操作/授权/检查各恰一行。
    let probe = f.storageProbe();
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts()).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        // 注册 1 + 首次 run 的 preview/accepted 2 + 重放 run 的 preview 1。
        command_receipts: 4,
      });
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_authorizations')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(1);
      // 注册回执在重放后仍恰一行（幂等键 (principal, commandId) 未产生第二条）。
      expect(
        probe.selectOne('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id = ?', [
          registerCommandId,
        ])?.n,
      ).toBe(1);
      expect(
        probe.selectOne('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id = ?', [
          baselineCommandId,
        ])?.n,
      ).toBe(1);
      expect(
        probe.stateEvents().filter((event) => event.event_type === 'baseline.started'),
      ).toHaveLength(1);
    } finally {
      probe.close();
    }

    // --- 冲突（注册）：同 commandId 携带不同业务参数 → conflict（idempotency_key_reuse）。 ---
    const conflictRegister = await f.runDistCli(
      [
        'project', 'register', repoPath,
        '--name', conflictName,
        '--command-id', registerCommandId,
        '--data-root', root, '--json',
      ],
      { label: 'client-a-register-conflict' },
    );
    const registerConflict = failureEnvelopeOf(conflictRegister, 1, 'conflict');
    expect(registerConflict.command).toBe('project.register');
    expect(registerConflict.error.commandId).toBe(registerCommandId);
    // 客户端错误 details 额外携带 httpStatus；契约关键字段是 reason。
    expect(registerConflict.error.details).toMatchObject({ reason: 'idempotency_key_reuse' });

    // --- 冲突（基线）：同 commandId 携带不同检查计划 → conflict（idempotency_key_reuse）。 ---
    const conflictPlanFile = writeInput(
      'plan-conflict',
      JSON.stringify({
        checks: [
          {
            checkKey: 'p02-4-replay-conflict',
            kind: 'command',
            argv: [process.execPath, markerScript, markerFile],
            timeoutMs: 30_000,
            required: true,
          },
        ],
      }),
      'json',
    );
    const conflictRun = await f.runDistCli(
      [
        'baseline', 'run',
        '--project', projectId,
        '--input', conflictPlanFile,
        '--confirm',
        '--command-id', baselineCommandId,
        '--data-root', root, '--json',
      ],
      { label: 'client-b-baseline-conflict' },
    );
    const baselineConflict = failureEnvelopeOf(conflictRun, 1, 'conflict');
    expect(baselineConflict.command).toBe('baseline.run');
    expect(baselineConflict.error.commandId).toBe(baselineCommandId);
    expect(baselineConflict.error.details).toMatchObject({ reason: 'idempotency_key_reuse' });

    // --- 冲突后零额外变更：启动次数/检查记录/项目行数/revision/事件/源文件。 ---
    expect(markerLaunchCount(markerFile)).toBe(1);
    // 源文件摘要不变：注册→基线执行→重放→冲突全程 tracked/untracked/工作树摘要一致。
    expect(f.snapshotRepository(repoPath)).toEqual(sourceBefore);

    probe = f.storageProbe();
    try {
      expect(probe.readonly).toBe(true);
      const counts = probe.counts();
      expect(counts).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        state_events: 5,
        artifacts: 3,
        // 注册 1 + 首次 run 的 preview/accepted 2 + 重放 run 的 preview 1 +
        // 冲突 run 的 preview 1；冲突与重放本身不产生新回执。
        command_receipts: 5,
      });
      const projectRow = probe.projectRow(projectId);
      expect(projectRow?.display_name).toBe(registerName);
      expect(projectRow?.revision).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_authorizations')?.n).toBe(1);
      expect(
        probe.selectOne('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id = ?', [
          registerCommandId,
        ])?.n,
      ).toBe(1);
      expect(
        probe.selectOne('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id = ?', [
          baselineCommandId,
        ])?.n,
      ).toBe(1);
      // 事件序列与单次执行一致（重放/冲突不追加任何事件）。
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

    // --- 原回执仍可查询（跨客户端并发一致）：completed 注册回执身份逐字段不变。 ---
    const [receiptGetA, receiptGetB] = await f.raceDistClis([
      { args: ['receipt', 'get', registerCommandId, '--data-root', root, '--json'], label: 'client-a-receipt-register' },
      { args: ['receipt', 'get', registerCommandId, '--data-root', root, '--json'], label: 'client-b-receipt-register' },
    ]);
    expect(receiptGetA.exitCode, receiptGetA.stderr).toBe(0);
    expect(receiptGetB.exitCode, receiptGetB.stderr).toBe(0);
    const registerReceiptA = receiptOf(receiptGetA);
    expect(registerReceiptA).toEqual(receiptOf(receiptGetB));
    expect(registerReceiptA).toMatchObject({
      commandId: registerCommandId,
      operation: 'project.register',
      status: 'completed',
      replayed: false,
      resultRef: registerResultRef,
      requestDigest: registerRequestDigest,
      issuedAt: first.issuedAt,
      completedAt: first.completedAt,
    });

    // accepted 基线回执仍可查询：原持久回执逐字段不变（operationId 身份一致）。
    const baselineReceiptAfter = receiptOf(
      await f.runDistCli(
        ['receipt', 'get', baselineCommandId, '--data-root', root, '--json'],
        { label: 'client-a-receipt-baseline-after' },
      ),
    );
    expect(baselineReceiptAfter).toEqual(originalBaselineReceipt);
    expect(baselineReceiptAfter.operationId).toBe(operationId);

    // 证据保留：请求摘要/回执身份与副作用核对证据（脱敏导出）。
    f.evidence.record('p02-4.fr2.command_conflict', {
      registerCommandId,
      registerResultRef,
      registerRequestDigest,
      baselineCommandId,
      operationId,
      registerReplay: 'replayed:true-same-resultRef',
      baselineReplay: 'same-operationId',
      conflictCodes: ['project.register:idempotency_key_reuse', 'baseline.run:idempotency_key_reuse'],
      markerLaunchesAfterFirstRun: 1,
      markerLaunchesAfterReplay: 1,
      markerLaunchesAfterConflicts: 1,
      projectRows: 1,
      projectRevision: 1,
      baselineOperations: 1,
      baselineCheckResults: 1,
      baselineStartedEvents: 1,
      receiptRowsPerCommandId: 1,
      commandReceipts: 5,
      sourceTreeUnchanged: true,
    });
    const document = exportScannedEvidence(
      {
        operation: terminal,
        repositories: [f.snapshotRepository(repoPath)],
        notes: ['P02-FR2-COMMAND-CONFLICT'],
      },
      root,
    );
    expect(document).toContain(operationId);
    expect(document).toContain(canonicalRepo);

    // 收尾：经产品命令受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);
});
