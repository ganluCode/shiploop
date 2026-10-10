/**
 * F-005 P02-4 干净/脏仓库接入只读保持与未知脚本零执行的真实验收场景。
 *
 * 对应 docs/p02-4-acceptance-contract.md §2.1 冻结的必需检查 `P02-FR2-SOURCE-PRESERVED`
 * （约定测试入口 `test/p02-4-repo-preservation-acceptance.test.ts`），用 F-002 现有夹具
 * （真实 dist CLI + 真实 Git 仓库变体 + 证据快照 + 只读探针）补齐四条验收标准：
 * 1. 干净仓库与含 staged/unstaged/untracked 文件的仓库分别运行静态预览（无 --confirm）、
 *    确认注册（--confirm）与获准只读基线（P02-3 exit-zero 样例）——接入前后 HEAD、索引
 *    状态（`git diff --cached --name-status`）、Git 状态原文与全部样例文件字节摘要逐项
 *    一致；无自动 stash/reset/commit（stash 列表为空、HEAD 与提交数不变）；
 * 2. 含「只能写哨兵」的初始化/安装脚本（postinstall/prepare → evil-init.mjs）与既有
 *    AGENTS.md 的仓库：未经单独授权的 init/overview 不执行脚本、不安装依赖（无
 *    node_modules 等产物）、不覆盖文档（AGENTS.md/README.md 字节不变），哨兵与其它
 *    意外产物不存在（文件清单前后一致）；
 * 3. 取消注册确认（不加 --confirm）按前序契约返回 not_run 且项目/绑定未新增；只确认
 *    注册未确认基线时 overview 健康保持 not_run/no_baseline，实际命令启动次数为零
 *    （baseline 授权/操作/检查行数为零、无 baseline.* 事件、哨兵不存在）；
 * 4. 全部用例纳入 npm test（vitest 默认收集 test/）；以文件清单/摘要、HEAD、Git 状态与
 *    哨兵断言作为证据（脱敏导出）；只涉及本次临时仓库（F-002 隔离夹具沙箱），绝不以
 *    开发仓库演练 Git 破坏性操作。
 *
 * 纪律：写入只经真实 `packages/cli/dist/bin.js`（project init / project overview /
 * baseline run）；Git 仓库、SQLite 状态库、Host 进程与受监督命令进程均为真实临时资源；
 * 数据库只经 p02-2 只读探针核对（绝不预填/改写业务状态）；快照与状态读取用真实 git
 * 进程（隔离 HOME/配置），判定以结构化信封 + 前后快照逐字段一致为准。
 * 运行前提：macOS（flock）；`beforeAll` 先 `npm run build` 保证 dist 与源码一致。
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME（回收 fail-closed：
 * 停止未确认即保留资源与诊断）。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { git } from './helpers/git-repo.ts';
import {
  assertDistCliBuilt,
  createAcceptanceFixture,
  exportEvidenceDocument,
  extractOperationSnapshot,
  openDataRootStorageProbe,
  scanForCredentialShapes,
  singleEnvelope,
  type AcceptanceFixture,
  type DistCliResult,
  type EvidenceDocumentInput,
  type OperationSnapshot,
  type RepositorySnapshot,
} from './helpers/p02-4/index.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));

/* ------------------------------------------------------------------ *
 * 夹具与公共小工具
 * ------------------------------------------------------------------ */

const activeFixtures: AcceptanceFixture[] = [];

function useFixture(): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix: 'shiploop-p02-4-f005-', stepMs: 300 });
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

/** 导出脱敏证据文档：凭据形状扫描为空 + 真实 token 不出现（fail-closed）。 */
function exportScannedEvidence(input: EvidenceDocumentInput, dataRoot: string): string {
  const document = exportEvidenceDocument(input);
  expect(scanForCredentialShapes(JSON.parse(document))).toEqual([]);
  const token = readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8').trim();
  expect(document).not.toContain(token);
  return document;
}

/** 基线操作轮询：终态只来自持久检查状态（不以 accepted 回执判定）。 */
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
      { label: `f005-status-${operationId.slice(0, 8)}` },
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
 * 仓库前后状态快照（HEAD / 索引 / Git 状态 / 文件字节摘要 / 清单）
 * ------------------------------------------------------------------ */

interface RepoState {
  /** 仓库证据快照（HEAD、`status --porcelain` 原文、tracked/untracked 字节摘要）。 */
  readonly snapshot: RepositorySnapshot;
  /** 索引状态（`git diff --cached --name-status` 原文；staged 变更的直接证据）。 */
  readonly indexChanges: string;
  /** `git stash list` 原文（无自动 stash 时为空）。 */
  readonly stashList: string;
  /** HEAD 可达提交数（无自动 commit 时不变）。 */
  readonly commitCount: string;
  /** 工作区文件清单（相对路径，排除 .git；意外产物的直接证据）。 */
  readonly listing: readonly string[];
}

/** 工作区文件清单（递归、排除 .git 内部；排序保证确定可比）。 */
function listRepoFiles(repoDir: string): string[] {
  return readdirSync(repoDir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry !== '.git' && !entry.startsWith(`.git${sep}`) && !entry.startsWith('.git/'))
    .map((entry) => entry.split(sep).join('/'))
    .sort();
}

/** 只读捕获仓库前后状态（真实 git 进程 + 真实文件字节；绝不写仓库）。 */
function captureRepoState(fixture: AcceptanceFixture, repoPath: string): RepoState {
  const home = fixture.homeDir;
  return {
    snapshot: fixture.snapshotRepository(repoPath),
    indexChanges: git(['diff', '--cached', '--name-status'], repoPath, { home }),
    stashList: git(['stash', 'list'], repoPath, { home }),
    commitCount: git(['rev-list', '--count', 'HEAD'], repoPath, { home }).trim(),
    listing: listRepoFiles(realpathSync(repoPath)),
  };
}

/** 接入前后逐项一致：HEAD / 索引 / Git 状态 / 全部文件字节摘要 / 文件清单。 */
function expectRepoPreserved(before: RepoState, after: RepoState): void {
  expect(after.snapshot.headCommit).toBe(before.snapshot.headCommit);
  expect(after.indexChanges).toBe(before.indexChanges);
  expect(after.snapshot.statusPorcelain).toBe(before.snapshot.statusPorcelain);
  expect(after.snapshot.tracked).toEqual(before.snapshot.tracked);
  expect(after.snapshot.untracked).toEqual(before.snapshot.untracked);
  expect(after.snapshot.treeDigest).toBe(before.snapshot.treeDigest);
  expect(after.listing).toEqual(before.listing);
  // 无自动 stash/reset/commit。
  expect(after.stashList.trim()).toBe('');
  expect(after.commitCount).toBe(before.commitCount);
}

/** init/overview 结果里注册轴与健康轴的窄视图（type 字面量：可直接由信封 result 收窄）。 */
type OnboardingView = {
  readonly registration: { readonly status: string; readonly reason?: string; readonly projectId?: string };
  readonly health: { readonly status: string; readonly reasonCode?: string };
};

/* ------------------------------------------------------------------ *
 * P02-FR2-SOURCE-PRESERVED（验收 1/4）：干净/脏仓库接入只读保持
 * ------------------------------------------------------------------ */

describe('P02-FR2-SOURCE-PRESERVED 干净/脏仓库接入只读保持', () => {
  it('干净仓库与含 staged/unstaged/untracked 的仓库：预览→确认注册→获准只读基线前后 HEAD/索引/Git 状态/文件字节摘要一致', async () => {
    const f = useFixture();
    const root = f.dataRoot();

    // 脏仓库补齐 staged 变更：既有 dirty 变体已有 unstaged 修改 + untracked 文件，
    // 在其上追加一个真实 `git add` 的暂存新文件（三类变更齐备；只动本次临时仓库）。
    const stagedFile = join(f.repos.dirty, 'staged.txt');
    writeFileSync(stagedFile, 'staged for F-005 read-only acceptance\n', 'utf8');
    git(['add', 'staged.txt'], f.repos.dirty, { home: f.homeDir });
    const dirtyStatus = git(['status', '--porcelain'], f.repos.dirty, { home: f.homeDir });
    expect(dirtyStatus).toContain('A  staged.txt');
    expect(dirtyStatus).toContain(' M src/tracked.ts');
    expect(dirtyStatus).toContain('?? untracked.txt');

    const cases: ReadonlyArray<{ label: string; repoPath: string }> = [
      { label: 'clean', repoPath: f.repos.withHead },
      { label: 'dirty', repoPath: f.repos.dirty },
    ];
    const preserved: Array<{ label: string; before: RepoState; after: RepoState }> = [];

    for (const { label, repoPath } of cases) {
      const before = captureRepoState(f, repoPath);
      if (label === 'dirty') {
        expect(before.snapshot.statusPorcelain).toContain('A  staged.txt');
      } else {
        expect(before.snapshot.statusPorcelain.trim()).toBe('');
      }
      expect(before.snapshot.headCommit).not.toBeNull();

      // 1) 静态预览（无 --confirm）：只读展示事实，注册 not_run。
      const preview = await f.runDistCli(
        ['project', 'init', repoPath, '--data-root', root, '--json'],
        { label: `f005-${label}-preview` },
      );
      expect(preview.exitCode, preview.stderr).toBe(0);
      const previewResult = resultOf(preview) as OnboardingView & {
        preview: { headCommit: string | null; hasUncommittedChanges: boolean };
      };
      expect(previewResult.registration.status).toBe('not_run');
      expect(previewResult.registration.reason).toBe('non_interactive');
      expect(previewResult.health.status).toBe('not_run');
      expect(previewResult.preview.headCommit).toBe(before.snapshot.headCommit);

      // 2) 确认注册（显式 --confirm）。
      const init = await f.runDistCli(
        [
          'project', 'init', repoPath, '--confirm',
          '--name', `F-005 ${label} 只读接入`,
          '--data-root', root, '--json',
        ],
        { label: `f005-${label}-init` },
      );
      expect(init.exitCode, init.stderr).toBe(0);
      const initResult = resultOf(init) as OnboardingView;
      expect(initResult.registration.status).toBe('registered');
      const projectId = initResult.registration.projectId;
      expect(projectId).toBeTypeOf('string');

      // 3) 获准只读基线（确定性 exit-zero 样例：显式 --confirm 授权，不写仓库）。
      const checkKey = `f005-${label}-readonly`;
      const plan = f.scenario('baselineSuccess').plan({ checkKey });
      const planFile = join(f.root, `plan-${label}-${randomUUID().slice(0, 8)}.json`);
      writeFileSync(planFile, JSON.stringify({ checks: plan.checks }), 'utf8');
      const run = await f.runDistCli(
        [
          'baseline', 'run', '--project', projectId as string, '--input', planFile,
          '--confirm', '--data-root', root, '--json',
        ],
        { label: `f005-${label}-baseline-run` },
      );
      expect(run.exitCode, run.stderr).toBe(0);
      const runResult = resultOf(run) as { operationId: string; status: string };
      expect(runResult.status).toBe('accepted');
      const terminal = await pollTerminalOperation(f, root, runResult.operationId, 60_000);
      expect(terminal.status).toBe('completed');
      expect(terminal.state).toBe('passed');
      expect(terminal.checks).toHaveLength(1);
      expect(terminal.checks[0]).toMatchObject({ checkKey, status: 'passed', exitCode: 0 });

      // 接入前后逐项一致（HEAD/索引/Git 状态/全部样例文件字节摘要/清单/无 stash-commit）。
      const after = captureRepoState(f, repoPath);
      expectRepoPreserved(before, after);
      preserved.push({ label, before, after });
    }

    // 证据（验收 4）：文件清单/摘要、HEAD、状态与前后一致性结论（脱敏导出）。
    for (const entry of preserved) {
      f.evidence.record('p02-4.fr2.source_preserved', {
        label: entry.label,
        headCommit: entry.before.snapshot.headCommit,
        statusPorcelain: entry.before.snapshot.statusPorcelain,
        indexChanges: entry.before.indexChanges,
        fileDigests: [...entry.before.snapshot.tracked, ...entry.before.snapshot.untracked],
        listing: entry.before.listing,
        preserved: {
          head: true,
          index: true,
          gitStatus: true,
          fileDigests: true,
          listing: true,
          stashListEmpty: true,
          commitCountUnchanged: true,
        },
      });
    }
    const document = exportScannedEvidence(
      {
        repositories: preserved.map((entry) => entry.after.snapshot),
        notes: ['P02-FR2-SOURCE-PRESERVED', 'F-005 干净/脏仓库接入只读保持'],
      },
      root,
    );
    expect(document).toContain(String(preserved[0]!.before.snapshot.headCommit));
    expect(document).toContain('A  staged.txt');

    // 收尾：受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * P02-FR2-SOURCE-PRESERVED（验收 2/4）：未知脚本零执行
 * ------------------------------------------------------------------ */

describe('P02-FR2-SOURCE-PRESERVED 未知脚本零执行（init/overview 不执行仓库脚本）', () => {
  it('含初始化/安装哨兵脚本与既有 AGENTS.md 的仓库：未经单独授权的 init/overview 不执行脚本、不装依赖、不覆盖文档', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repo = f.repos.malicious;

    // 既有 AGENTS.md（接入前已存在的文档；断言不被覆盖）。
    const agentsPath = join(repo, 'AGENTS.md');
    const agentsContent = '# AGENTS\n\n既有仓库说明，接入不得覆盖。\n';
    writeFileSync(agentsPath, agentsContent, 'utf8');
    // 初始化/安装脚本在仓库内且只能写哨兵（postinstall/prepare → evil-init.mjs）。
    expect(existsSync(f.repos.maliciousScriptPath)).toBe(true);
    const packageJson = readFileSync(join(repo, 'package.json'), 'utf8');
    expect(packageJson).toContain('postinstall');
    expect(packageJson).toContain('prepare');

    const before = captureRepoState(f, repo);

    // 未经单独授权的 init/overview：静态预览 + 确认注册 + overview（无任何脚本授权）。
    const preview = await f.runDistCli(
      ['project', 'init', repo, '--data-root', root, '--json'],
      { label: 'f005-scripts-preview' },
    );
    expect(preview.exitCode, preview.stderr).toBe(0);
    const previewResult = resultOf(preview) as OnboardingView;
    expect(previewResult.registration.status).toBe('not_run');

    const init = await f.runDistCli(
      [
        'project', 'init', repo, '--confirm',
        '--name', 'F-005 哨兵脚本仓库',
        '--data-root', root, '--json',
      ],
      { label: 'f005-scripts-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const initResult = resultOf(init) as OnboardingView;
    expect(initResult.registration.status).toBe('registered');
    const projectId = initResult.registration.projectId;
    expect(projectId).toBeTypeOf('string');

    const overview = await f.runDistCli(
      ['project', 'overview', projectId as string, '--data-root', root, '--json'],
      { label: 'f005-scripts-overview' },
    );
    expect(overview.exitCode, overview.stderr).toBe(0);
    const overviewResult = resultOf(overview) as OnboardingView;
    expect(overviewResult.registration.status).toBe('registered');
    expect(overviewResult.health.status).toBe('not_run');
    expect(overviewResult.health.reasonCode).toBe('no_baseline');

    // 零执行/零安装/不覆盖文档/无意外产物（哨兵、node_modules、清单前后一致）。
    expect(existsSync(f.repos.maliciousSentinelPath)).toBe(false);
    expect(existsSync(join(repo, 'node_modules'))).toBe(false);
    expect(readFileSync(agentsPath, 'utf8')).toBe(agentsContent);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# malicious\n');
    const after = captureRepoState(f, repo);
    expectRepoPreserved(before, after);
    expect(after.listing).toContain('AGENTS.md');
    expect(after.listing).toContain('scripts/evil-init.mjs');
    expect(after.listing).not.toContain('MALICIOUS-INIT-RAN.txt');
    expect(after.listing).not.toContain('node_modules');

    // 证据（验收 4）：清单/摘要/HEAD/状态与哨兵断言（脱敏导出）。
    f.evidence.record('p02-4.fr2.script_zero_execution', {
      projectId,
      headCommit: before.snapshot.headCommit,
      statusPorcelain: before.snapshot.statusPorcelain,
      fileDigests: [...before.snapshot.tracked, ...before.snapshot.untracked],
      listing: before.listing,
      sentinelAbsent: true,
      nodeModulesAbsent: true,
      agentsMdUnchanged: true,
      readmeUnchanged: true,
    });
    const document = exportScannedEvidence(
      {
        repositories: [after.snapshot],
        notes: ['P02-FR2-SOURCE-PRESERVED', 'F-005 未知脚本零执行'],
      },
      root,
    );
    expect(document).toContain('scripts/evil-init.mjs');

    // 收尾：受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * F-005 验收 3：取消注册确认 not_run 与注册/健康分轴零启动
 * ------------------------------------------------------------------ */

describe('F-005 取消注册确认与注册/健康分轴零启动', () => {
  it('取消注册确认返回 not_run 且项目/绑定未新增；只确认注册未确认基线时健康未检查、实际命令启动次数为零', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const repo = f.repos.malicious;
    const before = captureRepoState(f, repo);

    // 取消注册确认（不加 --confirm）：按前序契约返回 not_run（reason=non_interactive）。
    const preview = await f.runDistCli(
      ['project', 'init', repo, '--data-root', root, '--json'],
      { label: 'f005-no-confirm-preview' },
    );
    expect(preview.exitCode, preview.stderr).toBe(0);
    const previewResult = resultOf(preview) as OnboardingView;
    expect(previewResult.registration).toMatchObject({ status: 'not_run', reason: 'non_interactive' });
    expect(previewResult.health.status).toBe('not_run');
    expect(previewResult.health.reasonCode).toBe('no_baseline');

    // 项目/绑定未新增；实际命令启动次数为零（只读持久核对）。
    const afterPreview = openDataRootStorageProbe(root);
    try {
      expect(afterPreview.readonly).toBe(true);
      expect(afterPreview.counts().projects).toBe(0);
      expect(afterPreview.counts().repository_bindings).toBe(0);
      expect(afterPreview.selectOne('SELECT COUNT(*) AS n FROM baseline_authorizations')?.n).toBe(0);
      expect(afterPreview.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(0);
      expect(afterPreview.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(0);
      expect(afterPreview.stateEvents()).toEqual([]);
    } finally {
      afterPreview.close();
    }

    // 只确认注册（未确认基线）。
    const init = await f.runDistCli(
      [
        'project', 'init', repo, '--confirm',
        '--name', 'F-005 仅注册不跑基线',
        '--data-root', root, '--json',
      ],
      { label: 'f005-no-confirm-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const initResult = resultOf(init) as OnboardingView;
    expect(initResult.registration.status).toBe('registered');
    const projectId = initResult.registration.projectId;
    expect(projectId).toBeTypeOf('string');

    const overview = await f.runDistCli(
      ['project', 'overview', projectId as string, '--data-root', root, '--json'],
      { label: 'f005-no-confirm-overview' },
    );
    expect(overview.exitCode, overview.stderr).toBe(0);
    const overviewResult = resultOf(overview) as OnboardingView;
    expect(overviewResult.registration.status).toBe('registered');
    // 健康保持未检查：注册与健康严格分轴，未跑基线不得冒充已检查。
    expect(overviewResult.health.status).toBe('not_run');
    expect(overviewResult.health.reasonCode).toBe('no_baseline');

    // 实际命令启动次数为零：无基线授权/操作/检查结果行，唯一持久事件是注册。
    const afterInit = openDataRootStorageProbe(root);
    try {
      expect(afterInit.readonly).toBe(true);
      expect(afterInit.counts().projects).toBe(1);
      expect(afterInit.counts().repository_bindings).toBe(1);
      expect(afterInit.selectOne('SELECT COUNT(*) AS n FROM baseline_authorizations')?.n).toBe(0);
      expect(afterInit.selectOne('SELECT COUNT(*) AS n FROM baseline_operations')?.n).toBe(0);
      expect(afterInit.selectOne('SELECT COUNT(*) AS n FROM baseline_check_results')?.n).toBe(0);
      expect(afterInit.stateEvents().map((event) => event.event_type)).toEqual(['project.registered']);
    } finally {
      afterInit.close();
    }

    // 哨兵/node_modules 不存在（仓库脚本零执行），源文件前后一致。
    expect(existsSync(f.repos.maliciousSentinelPath)).toBe(false);
    expect(existsSync(join(repo, 'node_modules'))).toBe(false);
    const after = captureRepoState(f, repo);
    expectRepoPreserved(before, after);

    // 证据（验收 4）：注册/健康状态、零启动计数与哨兵断言（脱敏导出）。
    f.evidence.record('p02-4.fr2.registration_cancelled', {
      previewRegistration: 'not_run',
      previewReason: 'non_interactive',
      projectId: projectId ?? null,
      health: { status: 'not_run', reasonCode: 'no_baseline' },
      zeroLaunches: {
        baselineAuthorizations: 0,
        baselineOperations: 0,
        baselineCheckResults: 0,
        sentinelAbsent: true,
        nodeModulesAbsent: true,
      },
      headCommit: before.snapshot.headCommit,
      statusPorcelain: before.snapshot.statusPorcelain,
      listing: before.listing,
    });
    const document = exportScannedEvidence(
      {
        repositories: [after.snapshot],
        notes: ['F-005 取消注册确认与注册/健康分轴零启动'],
      },
      root,
    );
    expect(document).toContain(String(before.snapshot.headCommit));

    // 收尾：受控停止（三证据）。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);
});
