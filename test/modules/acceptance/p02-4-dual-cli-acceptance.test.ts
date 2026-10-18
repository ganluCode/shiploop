/**
 * F-003 P02-4 双 CLI 竞争启动与共享持久项目状态的真实端到端验收场景。
 *
 * 对应 docs/p02-4-acceptance-contract.md §2.1 冻结的三个必需检查（全部 required）：
 * - `P02-FR1-UNIQUE-HOST`：在无残留 Host 的同一临时数据根上，两个真实 dist CLI
 *   经同步屏障竞争启动——恰一实际持锁 Host/唯一写入者、两客户端取得同一
 *   `hostInstanceId` 与 `dataRootIdentity`、实际监听 `127.0.0.1` 的随机端口、
 *   发现目录/文件权限符合 P02-1 契约（host/ 0700、discovery/auth.token/writer.lock
 *   0600）；
 * - `P02-FR1-SHARED-STATE`：CLI A 经正式 `project init --confirm` 注册临时仓库并
 *   经正式 CLI 写入配置（create/update）；CLI B 经 `project list/get/overview` 与
 *   `config get/effective` 查询取得相同 projectId、绑定、描述、标签、当前值、
 *   revision 与有效来源（双客户端并发读取逐字段一致）；
 * - `P02-FR1-BASELINE-OK`：经用户明确确认（`--confirm`）的基线输入运行确定性
 *   成功命令（复用 P02-3 exit-zero 样例）——双客户端查询同一 `operationId`、
 *   逐项检查结果、退出码 0、代码身份与可校验输出制品；`accepted` 回执只提供
 *   operationId，**不作为 passed 依据**，通过只以持久检查终态为准。
 *
 * F-003 验收 4（写操作只经产品公共入口）：本套件全部写入经真实
 * `packages/cli/dist/bin.js`（project init / config create / config update /
 * baseline run）；Git 仓库、SQLite 状态库、Host 进程与受监督命令进程均为真实
 * 临时资源；数据库只经 p02-2 只读探针核对（绝不预填/改写业务状态）；断言使用
 * 结构化信封的实际返回值与只读持久行，不以成功文本/日志替代。
 *
 * 运行前提：macOS（flock）；`beforeAll` 先 `npm run build` 保证 dist 与源码一致。
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME（复用 F-002
 * 隔离夹具；回收 fail-closed：停止未确认即保留资源与诊断）。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquireWriterLock, isHostProtocolError } from '../../../packages/host/src/index.ts';
import {
  artifactContentDigest,
  assertDistCliBuilt,
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

const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 随机端口核验区间：非特权端口（Host 以 listen(0) 由 OS 分配，CLI 不接受监听覆盖）。 */
const RANDOM_PORT_MIN = 1024;
const RANDOM_PORT_MAX = 65_535;

/* ------------------------------------------------------------------ *
 * 夹具与公共小工具
 * ------------------------------------------------------------------ */

const activeFixtures: AcceptanceFixture[] = [];

function useFixture(): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix: 'shiploop-p02-4-f003-', stepMs: 300 });
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

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** 独立推导数据根身份（契约 §3.3：lower_hex(sha256(utf8(canonicalRoot)))）。 */
function expectedDataRootIdentity(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot, 'utf8').digest('hex');
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

function resultOf(result: DistCliResult): Record<string, unknown> {
  const envelope = singleEnvelope(result);
  expect(envelope.ok, result.stderr).toBe(true);
  return envelope.result as Record<string, unknown>;
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
      { label: 'client-b-status-poll' },
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

/* ------------------------------------------------------------------ *
 * P02-FR1-UNIQUE-HOST：双 CLI 竞争唯一 Host
 * ------------------------------------------------------------------ */

describe('P02-FR1-UNIQUE-HOST 双 CLI 竞争启动唯一 Host', () => {
  it('同一临时数据根同步启动两个正式 CLI：唯一持锁 Host/写入者、同一实例与数据根身份、127.0.0.1 随机端口、发现目录/文件权限合规', async () => {
    const f = useFixture();
    const root = f.dataRoot();

    // 前置：无残留 Host（发现文件不存在或其中 pid 已不存活）。
    expect(f.liveHostPid()).toBeNull();

    // 两个真实 dist CLI 经同步屏障同点放行，竞争连接同一数据根。
    const results = await f.raceDistClis(
      [0, 1].map((index) => ({
        args: ['host', 'start', '--data-root', root, '--json'],
        label: `unique-host-cli-${index}`,
      })),
    );
    expect(results).toHaveLength(2);

    // 业务完成以实际退出码 + 结构化信封判定（不以成功文本判定）。
    const hostResults = results.map((result) => {
      expect(result.exitCode, result.stderr).toBe(0);
      const envelope = singleEnvelope(result);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('host.start');
      return envelope.result as Record<string, unknown>;
    });

    // 同一 hostInstanceId 与数据根身份（两客户端视角一致）。
    const instanceIds = new Set(hostResults.map((result) => result.hostInstanceId as string));
    const rootIdentities = new Set(hostResults.map((result) => result.dataRootIdentity as string));
    expect(instanceIds.size).toBe(1);
    expect(rootIdentities.size).toBe(1);
    const hostInstanceId = hostResults[0]!.hostInstanceId as string;
    const dataRootIdentity = hostResults[0]!.dataRootIdentity as string;
    expect(hostInstanceId).toMatch(UUID_V4_PATTERN);
    // 数据根身份独立复算（sha256(utf8(canonicalRoot))）。
    expect(dataRootIdentity).toBe(expectedDataRootIdentity(realpathSync(root)));

    // 启动路径语义（P02-1 冻结）：started = 经候选启动路径完成连接（竞争落选方
    // 回收自有候选后同样报 started；becameHost 不在 CLI 结果面）；already_running =
    // 第 1 步直接发现既有实例。全新根上至少一方必经启动路径。
    const outcomes = hostResults.map((result) => result.outcome as string).sort();
    expect(outcomes).toContain('started');
    for (const outcome of outcomes) {
      expect(['started', 'already_running']).toContain(outcome);
    }

    // 实际监听 127.0.0.1 的随机端口：两客户端看到同一端口，与发现文件一致。
    for (const result of hostResults) {
      expect(result.listenAddress).toBe('127.0.0.1');
      expect(result.port).toBeTypeOf('number');
      const port = result.port as number;
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(RANDOM_PORT_MIN);
      expect(port).toBeLessThanOrEqual(RANDOM_PORT_MAX);
    }
    expect(new Set(hostResults.map((result) => result.port as number)).size).toBe(1);
    const port = hostResults[0]!.port as number;

    // 发现文件（Host 写入的实例事实）与两客户端视角一致；pid 真实存活。
    const discovery = readDiscoveryFile(root);
    expect(discovery.hostInstanceId).toBe(hostInstanceId);
    expect(discovery.dataRootIdentity).toBe(dataRootIdentity);
    expect(discovery.listenAddress).toBe('127.0.0.1');
    expect(discovery.port).toBe(port);
    const hostPid = discovery.pid as number;
    expect(hostPid).toBeTypeOf('number');
    expect(pidAlive(hostPid)).toBe(true);
    expect(f.liveHostPid()).toBe(hostPid);

    // 唯一实际持锁 Host/写入者：非阻塞获锁必然失败（锁仍被唯一 Host 持有）。
    await expect(acquireWriterLock({ canonicalRoot: root, timeoutMs: 0 })).rejects.toSatisfy(
      (error: unknown) => isHostProtocolError(error, 'owner_unknown') || isHostProtocolError(error, 'owner_active'),
    );

    // 发现目录/文件权限符合 P02-1 契约。
    expect(fileMode(root)).toBe(0o700);
    expect(fileMode(join(root, 'host'))).toBe(0o700);
    expect(fileMode(join(root, 'host', 'discovery.json'))).toBe(0o600);
    expect(fileMode(join(root, 'host', 'auth.token'))).toBe(0o600);
    expect(fileMode(join(root, 'host', 'writer.lock'))).toBe(0o600);

    // 状态库由唯一写入者创建（根下恰一个 core.sqlite；只读探针可打开）。
    expect(existsSync(join(root, 'core.sqlite'))).toBe(true);
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts().projects).toBe(0);
    } finally {
      probe.close();
    }

    // 第三个真实 CLI 只读查询：同一实例（pid/lifecycleState）——CLI 退出后 Host 存活。
    const status = await f.runDistCli(['host', 'status', '--data-root', root, '--json'], {
      label: 'unique-host-status',
    });
    expect(status.exitCode, status.stderr).toBe(0);
    const statusResult = resultOf(status);
    expect(statusResult.hostInstanceId).toBe(hostInstanceId);
    expect(statusResult.dataRootIdentity).toBe(dataRootIdentity);
    expect(statusResult.pid).toBe(hostPid);
    expect(statusResult.lifecycleState).toBe('ready');

    // 证据保留：实例/数据根/监听/权限等实际返回值（脱敏导出）。
    f.evidence.record('p02-4.fr1.unique_host', {
      hostInstanceId,
      dataRootIdentity,
      listenAddress: '127.0.0.1',
      port,
      outcomes,
      hostPid,
      hostDirMode: '0700',
      discoveryFileMode: '0600',
      tokenFileMode: '0600',
      writerLockFileMode: '0600',
    });
    const identity = extractHostIdentity(statusResult);
    const document = exportScannedEvidence(
      { hostIdentity: identity, notes: ['P02-FR1-UNIQUE-HOST'] },
      root,
    );
    expect(document).toContain(hostInstanceId);
    expect(document).toContain(dataRootIdentity);

    // 收尾：经产品命令受控停止（三证据）；随后锁可获取、发现删除、writer.lock 保留。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);
    expect(existsSync(join(root, 'host', 'writer.lock'))).toBe(true);
    const lock = await acquireWriterLock({ canonicalRoot: root, timeoutMs: 5_000 });
    lock.releaseAfterWritesClosed();
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR1-SHARED-STATE：共享持久项目/配置状态
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

describe('P02-FR1-SHARED-STATE 共享持久项目/配置状态', () => {
  it('CLI A 经 init --confirm 注册并写入配置；CLI B 经列表/详情/overview/配置查询取得相同身份、当前值、revision 与有效来源', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const canonicalRepo = realpathSync(repoPath);
    const displayName = '双客户端共享项目';
    const description = 'P02-4 FR-1 共享持久项目/配置状态验收';
    const labels = ['p02-4-fr1', 'shared-state'];
    const sortedLabels = [...labels].sort();

    // --- CLI A：正式 init --confirm（静态预览 + 用户显式确认注册）。 ---
    const init = await f.runDistCli(
      [
        'project', 'init', repoPath, '--confirm',
        '--name', displayName,
        '--description', description,
        '--label', labels[0], '--label', labels[1],
        '--data-root', root, '--json',
      ],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const initEnvelope = singleEnvelope(init);
    expect(initEnvelope.ok).toBe(true);
    expect(initEnvelope.command).toBe('project.init');
    const initResult = initEnvelope.result as {
      preview: { canonicalPath: string; repoIdentity: string; headCommit: string | null };
      registration: { status: string; projectId: string };
    };
    expect(initResult.registration.status).toBe('registered');
    const projectId = initResult.registration.projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);
    expect(initResult.preview.canonicalPath).toBe(canonicalRepo);
    expect(initResult.preview.headCommit).toBe(f.repos.headOf('withHead'));
    const repoIdentity = initResult.preview.repoIdentity;
    expect(repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);

    // --- CLI B：project list（唯一记录：身份/描述/标签一致）。 ---
    const list = await f.runDistCli(['project', 'list', '--data-root', root, '--json'], {
      label: 'client-b-list',
    });
    expect(list.exitCode, list.stderr).toBe(0);
    const listResult = resultOf(list) as {
      records: Array<{ id: string; displayName: string; description: string; labels: string[]; revision: number }>;
    };
    expect(listResult.records).toHaveLength(1);
    expect(listResult.records[0]).toMatchObject({
      id: projectId,
      displayName,
      description,
      labels: sortedLabels,
      revision: 1,
    });

    // --- CLI B：project get（详情 + 仓库绑定）。 ---
    const get = await f.runDistCli(['project', 'get', projectId, '--data-root', root, '--json'], {
      label: 'client-b-get',
    });
    expect(get.exitCode, get.stderr).toBe(0);
    const detail = resultOf(get) as {
      project: { id: string; displayName: string; description: string; labels: string[]; status: string };
      binding: { projectId: string; canonicalPath: string; repoIdentity: string } | null;
    };
    expect(detail.project.id).toBe(projectId);
    expect(detail.project.displayName).toBe(displayName);
    expect(detail.project.description).toBe(description);
    expect(detail.project.labels).toEqual(sortedLabels);
    expect(detail.binding).not.toBeNull();
    expect(detail.binding!.projectId).toBe(projectId);
    expect(detail.binding!.canonicalPath).toBe(canonicalRepo);
    expect(detail.binding!.repoIdentity).toBe(repoIdentity);

    // --- CLI B：project overview（注册轴与配置存在性分离；写入前未配置）。 ---
    const overviewBefore = await f.runDistCli(
      ['project', 'overview', projectId, '--data-root', root, '--json'],
      { label: 'client-b-overview-before' },
    );
    expect(overviewBefore.exitCode, overviewBefore.stderr).toBe(0);
    const overview1 = resultOf(overviewBefore) as {
      project: { id: string; displayName: string; description: string; labels: string[] };
      binding: { canonicalPath: string } | null;
      registration: { status: string };
      settings: { configured: boolean };
      health: { status: string; reasonCode?: string };
    };
    expect(overview1.project.id).toBe(projectId);
    expect(overview1.project.displayName).toBe(displayName);
    expect(overview1.project.description).toBe(description);
    expect(overview1.project.labels).toEqual(sortedLabels);
    expect(overview1.binding!.canonicalPath).toBe(canonicalRepo);
    expect(overview1.registration.status).toBe('registered');
    expect(overview1.settings.configured).toBe(false);
    expect(overview1.health.status).toBe('not_run');

    // --- CLI A：配置经正式 CLI 确认/写入（global create → update；project create）。 ---
    const inputDir = join(f.root, 'inputs');
    mkdirSync(inputDir, { recursive: true });
    const writeInput = (name: string, value: unknown): string => {
      const file = join(inputDir, `${name}-${randomUUID().slice(0, 8)}.json`);
      writeFileSync(file, JSON.stringify(value), 'utf8');
      return file;
    };

    const globalCreate = await f.runDistCli(
      ['config', 'create', '--scope', 'global', '--input', writeInput('global-create', GLOBAL_CREATE_PAYLOAD), '--data-root', root, '--json'],
      { label: 'client-a-config-create' },
    );
    expect(globalCreate.exitCode, globalCreate.stderr).toBe(0);
    const globalCreateReceipt = resultOf(globalCreate) as {
      status: string;
      replayed: boolean;
      operation: string;
      result: { scope: { kind: string }; schemaVersion: number; revision: number; payload: unknown };
    };
    expect(globalCreateReceipt.status).toBe('completed');
    expect(globalCreateReceipt.replayed).toBe(false);
    expect(globalCreateReceipt.operation).toBe('settings.global.create');
    expect(globalCreateReceipt.result.revision).toBe(1);
    expect(globalCreateReceipt.result.payload).toEqual(GLOBAL_CREATE_PAYLOAD);

    const globalUpdate = await f.runDistCli(
      [
        'config', 'update', '--scope', 'global', '--revision', '1',
        '--input', writeInput('global-update', GLOBAL_UPDATE_PAYLOAD),
        '--data-root', root, '--json',
      ],
      { label: 'client-a-config-update' },
    );
    expect(globalUpdate.exitCode, globalUpdate.stderr).toBe(0);
    const globalUpdateReceipt = resultOf(globalUpdate) as {
      status: string;
      replayed: boolean;
      result: { revision: number; payload: unknown };
    };
    expect(globalUpdateReceipt.status).toBe('completed');
    expect(globalUpdateReceipt.result.revision).toBe(2);
    expect(globalUpdateReceipt.result.payload).toEqual(GLOBAL_UPDATE_PAYLOAD);

    const projectCreate = await f.runDistCli(
      [
        'config', 'create', '--scope', 'project', '--project', projectId,
        '--input', writeInput('project-create', PROJECT_PAYLOAD),
        '--data-root', root, '--json',
      ],
      { label: 'client-a-config-project-create' },
    );
    expect(projectCreate.exitCode, projectCreate.stderr).toBe(0);
    const projectCreateReceipt = resultOf(projectCreate) as {
      status: string;
      result: { scope: { kind: string }; revision: number; payload: unknown };
    };
    expect(projectCreateReceipt.status).toBe('completed');
    expect(projectCreateReceipt.result.scope).toEqual({ kind: 'project', projectId });
    expect(projectCreateReceipt.result.revision).toBe(1);
    expect(projectCreateReceipt.result.payload).toEqual(PROJECT_PAYLOAD);

    // --- 双客户端并发读取：当前值 + revision 逐字段一致。 ---
    const [globalA, globalB] = await f.raceDistClis([
      { args: ['config', 'get', '--scope', 'global', '--data-root', root, '--json'], label: 'client-a-config-get-global' },
      { args: ['config', 'get', '--scope', 'global', '--data-root', root, '--json'], label: 'client-b-config-get-global' },
    ]);
    expect(globalA.exitCode, globalA.stderr).toBe(0);
    expect(globalB.exitCode, globalB.stderr).toBe(0);
    const globalStateA = resultOf(globalA);
    const globalStateB = resultOf(globalB);
    expect(globalStateA).toEqual(globalStateB);
    expect(globalStateA).toEqual({
      scope: { kind: 'global' },
      schemaVersion: 2,
      revision: 2,
      payload: GLOBAL_UPDATE_PAYLOAD,
    });

    const [projectA, projectB] = await f.raceDistClis([
      { args: ['config', 'get', '--scope', 'project', '--project', projectId, '--data-root', root, '--json'], label: 'client-a-config-get-project' },
      { args: ['config', 'get', '--scope', 'project', '--project', projectId, '--data-root', root, '--json'], label: 'client-b-config-get-project' },
    ]);
    expect(projectA.exitCode, projectA.stderr).toBe(0);
    expect(projectB.exitCode, projectB.stderr).toBe(0);
    const projectStateA = resultOf(projectA);
    expect(projectStateA).toEqual(resultOf(projectB));
    expect(projectStateA).toEqual({
      scope: { kind: 'project', projectId },
      schemaVersion: 2,
      revision: 1,
      payload: PROJECT_PAYLOAD,
    });

    // --- 双客户端并发读取有效配置：来源（global_default/project_default）与 scopeRevision 一致。 ---
    const [effectiveA, effectiveB] = await f.raceDistClis([
      { args: ['config', 'effective', '--project', projectId, '--data-root', root, '--json'], label: 'client-a-config-effective' },
      { args: ['config', 'effective', '--project', projectId, '--data-root', root, '--json'], label: 'client-b-config-effective' },
    ]);
    expect(effectiveA.exitCode, effectiveA.stderr).toBe(0);
    expect(effectiveB.exitCode, effectiveB.stderr).toBe(0);
    const effectiveAView = resultOf(effectiveA) as {
      configured: boolean;
      schemaVersion: number;
      policies: {
        executionLimits?: { value: unknown; source: { kind: string; scopeRevision: number; sourceKey: string } };
        verification?: { value: unknown; source: { kind: string; scopeRevision: number; sourceKey: string } };
        securityPolicy?: { value: unknown; source: { kind: string; scopeRevision: number; sourceKey: string } };
      };
    };
    expect(effectiveAView).toEqual(resultOf(effectiveB));
    expect(effectiveAView.configured).toBe(false);
    expect(effectiveAView.schemaVersion).toBe(2);
    // executionLimits/securityPolicy：项目当前覆盖（project_default，scopeRevision=1）。
    expect(effectiveAView.policies.executionLimits).toEqual({
      value: PROJECT_PAYLOAD.policies.executionLimits,
      source: { kind: 'project_default', scopeRevision: 1, sourceKey: 'policies.executionLimits' },
    });
    expect(effectiveAView.policies.securityPolicy).toEqual({
      value: PROJECT_PAYLOAD.policies.securityPolicy,
      source: { kind: 'project_default', scopeRevision: 1, sourceKey: 'policies.securityPolicy' },
    });
    // verification：继承全局当前值（global_default，scopeRevision=2）。
    expect(effectiveAView.policies.verification).toEqual({
      value: GLOBAL_UPDATE_PAYLOAD.policies.verification,
      source: { kind: 'global_default', scopeRevision: 2, sourceKey: 'policies.verification' },
    });

    // --- CLI B：overview 再查（项目配置存在性随写入变化；注册/健康仍分轴）。 ---
    const overviewAfter = await f.runDistCli(
      ['project', 'overview', projectId, '--data-root', root, '--json'],
      { label: 'client-b-overview-after' },
    );
    expect(overviewAfter.exitCode, overviewAfter.stderr).toBe(0);
    const overview2 = resultOf(overviewAfter) as {
      settings: { configured: boolean; revision?: number; schemaVersion?: number };
      health: { status: string };
    };
    expect(overview2.settings).toEqual({ configured: true, revision: 1, schemaVersion: 2 });
    expect(overview2.health.status).toBe('not_run');

    // --- 只读 SQLite 探针核对持久状态（真实行；不预填/不改写）。 ---
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts()).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        global_settings: 1,
        project_settings: 1,
        command_receipts: 4,
      });
      const projectRow = probe.projectRow(projectId);
      expect(projectRow?.display_name).toBe(displayName);
      expect(projectRow?.description).toBe(description);
      expect(JSON.parse(String(projectRow?.labels))).toEqual(sortedLabels);
      expect(projectRow?.revision).toBe(1);
      const globalRow = probe.settingsRow('global');
      expect(globalRow?.revision).toBe(2);
      expect(globalRow?.schema_version).toBe(2);
      expect(JSON.parse(String(globalRow?.payload))).toEqual(GLOBAL_UPDATE_PAYLOAD);
      const projectSettingsRow = probe.settingsRow('project', projectId);
      expect(projectSettingsRow?.revision).toBe(1);
      expect(JSON.parse(String(projectSettingsRow?.payload))).toEqual(PROJECT_PAYLOAD);
      // 持久审计事件与写入序列一致（注册 → 全局配置创建/更新 → 项目配置创建）。
      expect(probe.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.global_created',
        'settings.global_updated',
        'settings.project_created',
      ]);
    } finally {
      probe.close();
    }

    // 证据保留：项目/配置身份与实际返回值（脱敏导出）。
    f.evidence.record('p02-4.fr1.shared_state', {
      projectId,
      canonicalRepo,
      displayName,
      description,
      labels: sortedLabels,
      globalRevision: 2,
      projectSettingsRevision: 1,
      effectiveSources: ['project_default:policies.executionLimits', 'global_default:policies.verification'],
    });
    const document = exportScannedEvidence(
      { repositories: [f.snapshotRepository(repoPath)], notes: ['P02-FR1-SHARED-STATE'] },
      root,
    );
    expect(document).toContain(canonicalRepo);
    expect(document).toContain(f.repos.headOf('withHead') as string);

    // 收尾：受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR1-BASELINE-OK：授权基线确定性成功命令
 * ------------------------------------------------------------------ */

describe('P02-FR1-BASELINE-OK 授权基线与双客户端查询', () => {
  it('用户确认的确定性成功命令：双客户端查询同一 operationId/检查/退出码 0/代码身份/输出制品；accepted 不作 passed 依据', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;
    const headCommit = f.repos.headOf('withHead');
    const checkKey = 'p02-4-dual-cli-success';

    // CLI A：正式 init 注册受检仓库。
    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '双客户端基线项目', '--data-root', root, '--json'],
      { label: 'client-a-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);

    // 基线输入：用户明确确认的确定性成功命令（复用 P02-3 exit-zero 样例）。
    const plan = f.scenario('baselineSuccess').plan({ checkKey });
    const planFile = join(f.root, `plan-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(planFile, JSON.stringify({ checks: plan.checks }), 'utf8');

    // CLI A：baseline run --confirm（不加 --wait：回执为 accepted + operationId）。
    const run = await f.runDistCli(
      [
        'baseline', 'run', '--project', projectId, '--input', planFile,
        '--confirm', '--data-root', root, '--json',
      ],
      { label: 'client-a-baseline-run' },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    const runEnvelope = singleEnvelope(run);
    expect(runEnvelope.ok).toBe(true);
    expect(runEnvelope.command).toBe('baseline.run');
    const runResult = runEnvelope.result as { operationId: string; status: string; state: string };
    // accepted 回执只提供 operationId：不得据此判 passed。
    expect(runResult.status).toBe('accepted');
    expect(runResult.state).toBe('accepted');
    const operationId = runResult.operationId;
    expect(operationId).toMatch(UUID_V4_PATTERN);

    // CLI B：轮询持久检查终态——passed 依据只来自这里。
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
    expect(check.output!.truncated).toBe(false);
    // 代码身份：与受检仓库真实 HEAD 一致、工作区干净。
    expect(terminal.codeIdentity.headCommit).toBe(headCommit);
    expect(terminal.codeIdentity.hasUncommittedChanges).toBe(false);
    expect(terminal.codeIdentity.workingTreeDigest).toMatch(/^[0-9a-f]{64}$/);

    // 双客户端并发查询同一 operationId：结构化快照逐字段一致。
    const [statusA, statusB] = await f.raceDistClis([
      { args: ['baseline', 'status', operationId, '--data-root', root, '--json'], label: 'client-a-baseline-status' },
      { args: ['baseline', 'status', operationId, '--data-root', root, '--json'], label: 'client-b-baseline-status' },
    ]);
    expect(statusA.exitCode, statusA.stderr).toBe(0);
    expect(statusB.exitCode, statusB.stderr).toBe(0);
    const snapshotA = extractOperationSnapshot(resultOf(statusA));
    const snapshotB = extractOperationSnapshot(resultOf(statusB));
    expect(snapshotA).toEqual(snapshotB);
    expect(snapshotA).toEqual(terminal);

    // 双客户端并发读取输出制品：正文/大小可校验且一致（确定性成功命令的带流标记输出）。
    const expectedArtifactContent = '[stdout]sample-ok\n';
    const [evidenceA, evidenceB] = await f.raceDistClis([
      { args: ['baseline', 'evidence', artifactId, '--data-root', root, '--json'], label: 'client-a-baseline-evidence' },
      { args: ['baseline', 'evidence', artifactId, '--data-root', root, '--json'], label: 'client-b-baseline-evidence' },
    ]);
    expect(evidenceA.exitCode, evidenceA.stderr).toBe(0);
    expect(evidenceB.exitCode, evidenceB.stderr).toBe(0);
    const evidenceResultA = resultOf(evidenceA) as { artifactId: string; byteSize: number; content: string };
    const evidenceResultB = resultOf(evidenceB) as { artifactId: string; byteSize: number; content: string };
    expect(evidenceResultA).toEqual(evidenceResultB);
    expect(evidenceResultA.artifactId).toBe(artifactId);
    expect(evidenceResultA.content).toBe(expectedArtifactContent);
    expect(evidenceResultA.byteSize).toBe(expectedArtifactContent.length);
    const digestA = artifactContentDigest(artifactId, evidenceResultA.content);
    const digestB = artifactContentDigest(artifactId, evidenceResultB.content);
    expect(digestA).toEqual(digestB);
    expect(digestA.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestA.sizeBytes).toBe(expectedArtifactContent.length);
    expect(check.output!.byteSize).toBe(digestA.sizeBytes);

    // CLI B：baseline list 同一 operationId（列表视图与终态一致）。
    const list = await f.runDistCli(
      ['baseline', 'list', '--project', projectId, '--data-root', root, '--json'],
      { label: 'client-b-baseline-list' },
    );
    expect(list.exitCode, list.stderr).toBe(0);
    const listResult = resultOf(list) as {
      projectId: string;
      records: Array<{ operationId: string; status: string; state: string }>;
    };
    expect(listResult.projectId).toBe(projectId);
    expect(listResult.records).toHaveLength(1);
    expect(listResult.records[0]).toMatchObject({ operationId, status: 'completed', state: 'passed' });

    // 只读 SQLite 探针核对真实持久行（绝不预填/改写）。
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts()).toMatchObject({
        projects: 1,
        repository_bindings: 1,
        // 单检查运行发布三类制品：检查输出 + 运行摘要 + 证据报告。
        artifacts: 3,
        // 注册 + preview + run（accepted）三条命令回执。
        command_receipts: 3,
      });
      // 制品按 kind 真实落库；检查输出引用的正是 baseline-output 制品。
      expect(
        probe
          .selectAll('SELECT kind, COUNT(*) AS n FROM artifacts GROUP BY kind ORDER BY kind ASC')
          .map((row) => `${String(row.kind)}:${String(row.n)}`),
      ).toEqual(['baseline-evidence:1', 'baseline-output:1', 'baseline-summary:1']);
      expect(
        probe.selectOne('SELECT kind FROM artifacts WHERE id = ?', [artifactId])?.kind,
      ).toBe('baseline-output');
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_authorizations')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(1);
      expect(probe.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(1);
      const operationRow = probe.selectOne(
        'SELECT id, project_id, status FROM baseline_operations WHERE id = ?',
        [operationId],
      );
      expect(operationRow).toMatchObject({ id: operationId, project_id: projectId, status: 'completed' });
      const checkRow = probe.selectOne(
        'SELECT status, exit_code FROM baseline_check_results WHERE operation_id = ? AND check_key = ?',
        [operationId, checkKey],
      );
      expect(checkRow).toMatchObject({ status: 'passed', exit_code: 0 });
      // 持久审计事件与执行序列一致。
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

    // 证据保留：操作/检查/制品身份与实际返回值（脱敏导出）。
    f.evidence.record('p02-4.fr1.baseline_ok', {
      projectId,
      operationId,
      checkKey,
      checkStatus: 'passed',
      exitCode: 0,
      headCommit,
      artifactId,
      artifactByteSize: digestA.sizeBytes,
      receiptStatus: 'accepted',
    });
    const document = exportScannedEvidence(
      { operation: terminal, artifacts: [digestA], notes: ['P02-FR1-BASELINE-OK'] },
      root,
    );
    expect(document).toContain(operationId);
    expect(document).toContain(artifactId);

    // 收尾：受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 240_000);
});
