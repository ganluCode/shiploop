/**
 * P06-7 / F-002 Todo 存量仓库验收夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 为 P06 阶段验收场景（I01～I08）提供一处集中持有的受控临时资源，全部由真实
 * 进程/文件构成（不 mock Git、SQLite 或进程）：
 *
 * - Todo 存量仓库（真实 git 进程创建）：已跟踪脏文件、暂存修改、未跟踪文件、
 *   预置项目文档、可复现失败检查（退出码 3）、可受限修改的 Todo 文件、
 *   恶意初始化脚本及哨兵（夹具从不执行仓库脚本）；
 * - 跨项目第二仓库（同沙箱、独立真实仓库，供资源范围与项目隔离负例）；
 * - 已选择/未选择 Skill/MCP 资源 manifest（本地 JSON，schemaVersion 1，无凭据）；
 * - 无凭据本地 stdio Fake MCP server（复用 helpers/mcp-stdio-fake-server.ts，
 *   文件屏障提供就绪/写入/退出事实）；
 * - 隔离 HOME/TMPDIR、规范数据根（生产 resolveCanonicalDataRoot）与真实 SQLite
 *   （WAL/FK + 夹具事实表）；
 * - 受管子进程（复用 p02-3/process-tools + host/managed-child 停止核验 +
 *   OwnedProcessTree 后代清理）；失败、超时、取消、部分初始化保留可核对事实，
 *   dispose 调用不代替停止证明；
 * - 脱敏证据日志（复用 host/evidence）：合成敏感哨兵（凭据值 + Bearer 形状）与
 *   开发机受保护路径（受测仓库根、真实 HOME）登记 fail-closed，绝不进入普通证据文本。
 *
 * 清理（fail-closed）：先核验自有进程停止（SIGTERM→SIGKILL 升级）与后代树收尾，
 * 再导出 SQLite/Git/进程事实、关闭 SQLite，最后只删除本次持有的临时根
 * （safeRemoveTempRoot；授权根=系统 tmpdir，受保护=开发仓库与真实 HOME）；
 * 任何未确认项聚合为 failed/unknown 状态并保留现场，绝不静默当作已清理。
 *
 * 安全约束：不读真实凭据、不联网（两仓库均不配置 remote）、不调用模型、
 * 不以手工改 SQLite 制造产品状态；夹具事实表只是夹具自有可核对事实。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCanonicalDataRoot } from '../../../packages/host/src/index.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { OwnedProcessTree } from '../../../scripts/acceptance/owned-process-tree.ts';
import type { EvidenceEvent, EvidenceLog } from '../host/evidence.ts';
import { createEvidenceLog } from '../host/evidence.ts';
import type { ProcessExitResult, StopConfirmationOptions } from '../host/managed-child.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from '../git-repo.ts';
import { createFakeMcpServerCommand, waitForFakeMcpFile, type FakeMcpServerOptions } from '../mcp-stdio-fake-server.ts';
import { spawnSampleProcess, type SampleProcess } from '../p02-3/process-tools.ts';
import { safeRemoveTempRoot } from '../safe-cleanup.ts';
import { createTempSandbox, type TempSandbox } from '../temp-sandbox.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_PREFIX = 'shiploop-p06-7-todo-';
const FACTS_TABLE = 'p067_todo_fixture_records';
const CAPTURE_LIMIT_BYTES = 65_536;

/* ------------------------------------------------------------------ *
 * 部分初始化注入：结构化失败事实
 * ------------------------------------------------------------------ */

/** stopAfter 在该阶段完成后抛出（该阶段已计入 prepared）。 */
export type TodoFixtureStage =
  | 'sandbox'
  | 'home'
  | 'data'
  | 'sqlite'
  | 'repo-init'
  | 'repo-commit'
  | 'dirty'
  | 'second-repo'
  | 'resources'
  | 'mcp-fake'
  | 'sentinels'
  | 'complete';

/** 部分初始化失败：保留已完成阶段事实；自有临时根已尽力清理。 */
export class TodoFixturePartialInitError extends Error {
  readonly kind = 'partial_init' as const;
  readonly stage: TodoFixtureStage;
  readonly prepared: readonly TodoFixtureStage[];
  readonly root: string;

  constructor(stage: TodoFixtureStage, prepared: readonly TodoFixtureStage[], root: string) {
    super(`Todo 夹具在阶段 ${stage} 后按要求中止（部分初始化）；已完成：${prepared.join(' -> ')}`);
    this.name = 'TodoFixturePartialInitError';
    this.stage = stage;
    this.prepared = prepared;
    this.root = root;
  }
}

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface TodoBrownfieldFixtureOptions {
  readonly prefix?: string;
  /** 停止核验升级步长（毫秒，默认 1000）。 */
  readonly stepMs?: number;
  /** 部分初始化注入：在指定阶段完成后抛出 TodoFixturePartialInitError。 */
  readonly stopAfter?: TodoFixtureStage;
}

export type TodoCheckKey = 'ok' | 'failing' | 'hang' | 'missingTool';

export interface TodoCheckDescriptor {
  readonly checkKey: string;
  readonly kind: 'pass' | 'fail' | 'hang' | 'missing_tool';
  readonly argv: readonly string[];
  readonly expectedExitCode: number | null;
}

export interface TodoCheckRunResult {
  readonly checkKey: string;
  readonly kind: TodoCheckDescriptor['kind'];
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stopConfirmed: boolean;
  readonly escalated: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnErrorCode: string | undefined;
  /** 事实文件路径（写入屏障）；无事实则为 null。 */
  readonly factPath: string | null;
  /** 事实文件中的累计运行次数。 */
  readonly runs: number | null;
}

export interface TodoManagedProcess extends SampleProcess {
  readonly owned: true;
}

export interface TodoFakeMcpServer {
  readonly dir: string;
  readonly process: TodoManagedProcess;
  readonly pidFile: string;
  readonly readyFile: string;
  readonly initializeFile: string;
  readonly toolsListFile: string;
  readonly exitFile: string;
  /** 写一行 JSON-RPC 请求/通知（stdin 必须为 pipe）。 */
  sendRpc(method: string, id: number | null, params?: unknown): void;
  /** 有界等待 exit.json 出现并解析 {pid, code}（退出屏障）。 */
  waitExitFact(timeoutMs?: number): Promise<{ pid: number; code: number }>;
}

export interface TodoGitFacts {
  readonly todoRepositoryName: string;
  readonly todoHead: string;
  readonly todoStatusPorcelain: string;
  readonly todoRemotes: readonly string[];
  readonly otherRepositoryName: string;
  readonly otherHead: string;
  readonly otherStatusPorcelain: string;
  readonly otherRemotes: readonly string[];
}

export interface TodoSqliteFacts {
  readonly journalMode: string;
  readonly foreignKeysEnabled: boolean;
  readonly open: boolean;
  readonly recordCount: number;
}

export interface TodoProcessIdentity {
  readonly pid: number;
  readonly label: string;
  readonly alive: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** 停止核验实际采用的升级步骤（ipc-close/SIGTERM/SIGKILL）。 */
  readonly stopEscalated: readonly string[];
}

export interface TodoProcessFacts {
  readonly owned: true;
  readonly spawned: number;
  readonly alive: number;
  readonly exited: number;
  readonly identities: readonly TodoProcessIdentity[];
  readonly trees: readonly ReturnType<OwnedProcessTree['snapshot']>[];
}

export interface TodoDirtyEntry {
  readonly path: string;
  readonly state: 'modified_unstaged' | 'modified_staged' | 'untracked' | 'clean_tracked';
  readonly worktreeDigest: string;
  readonly indexDigest: string | null;
}

export interface TodoDirtyBaseline {
  readonly head: string;
  readonly statusPorcelain: string;
  readonly entries: readonly TodoDirtyEntry[];
  readonly docs: readonly { readonly path: string; readonly digest: string }[];
  readonly todoFile: { readonly path: string; readonly digest: string };
  readonly knownFailure: { readonly checkKey: string; readonly expectedExitCode: number };
}

export interface TodoDirtyComparison {
  readonly matches: boolean;
  readonly differences: readonly string[];
}

export interface TodoCleanupFacts {
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown';
  readonly processStopped: boolean;
  readonly sqliteClosed: boolean;
  readonly factsExported: boolean;
  readonly resourcesRemoved: boolean;
  readonly retainedRoot: string | null;
  readonly reason?: string;
}

export interface TodoResourceManifest {
  readonly schemaVersion: number;
  readonly resources: readonly {
    readonly kind: string;
    readonly name: string;
    readonly transport: string | null;
    readonly credentialRef: string | null;
    readonly required: boolean;
    readonly [field: string]: unknown;
  }[];
}

export interface TodoSpawnOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
}

export interface TodoBrownfieldFixture {
  readonly root: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly dataRoot: string;
  readonly dataRootIdentity: string;
  readonly sqlitePath: string;
  readonly sqlite: SqliteStorageSession;
  readonly evidence: EvidenceLog;
  readonly todoRepositoryPath: string;
  readonly secondRepositoryPath: string;
  readonly dirtyTrackedFile: string;
  readonly stagedFile: string;
  readonly untrackedFile: string;
  readonly todoFilePath: string;
  readonly docsDir: string;
  readonly checks: Readonly<Record<TodoCheckKey, TodoCheckDescriptor>>;
  readonly checkFactsDir: string;
  readonly selectedResourceManifestPath: string;
  readonly unselectedResourceManifestPath: string;
  readonly mcpServerDir: string;
  readonly mcpServerCommand: { readonly executable: string; readonly argv: readonly string[] };
  readonly maliciousScriptPath: string;
  readonly maliciousSentinelPath: string;
  readonly sensitiveSentinelPath: string;
  readonly sensitiveSentinelValue: string;
  readonly bearerSentinelValue: string;
  /** 白名单 env（HOME/TMPDIR 指向沙箱）；不透传真实凭据环境。 */
  childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  readResourceManifest(which: 'selected' | 'unselected'): TodoResourceManifest;
  /** 受管子进程：登记身份/退出事实与后代树；dispose 前必须核验停止。 */
  spawnManagedProcess(options: TodoSpawnOptions): TodoManagedProcess;
  /** 启动无凭据本地 stdio Fake server 并等待就绪屏障。 */
  startFakeMcpServer(options?: FakeMcpServerOptions): Promise<TodoFakeMcpServer>;
  /** 真实执行检查 argv（仓库 cwd + 沙箱 env）；超时走停止核验升级。 */
  runCheck(key: TodoCheckKey, options?: { readonly timeoutMs?: number }): Promise<TodoCheckRunResult>;
  gitFacts(): TodoGitFacts;
  sqliteFacts(): TodoSqliteFacts;
  processFacts(): TodoProcessFacts;
  /** 脏状态基线快照（验收前）。 */
  dirtyBaseline(): TodoDirtyBaseline;
  /** 验收后逐项比较：脏文件、暂存、未跟踪、文档、Todo 文件、HEAD、已知失败。 */
  compareDirtyBaseline(baseline?: TodoDirtyBaseline): TodoDirtyComparison;
  /** 无绝对路径/无敏感内容的普通事实摘要（可直接进证据文本）。 */
  describeFacts(): Record<string, unknown>;
  /** 经脱敏 fail-closed 校验记录证据事件。 */
  recordEvidenceEvent(type: string, fields: Record<string, unknown>): EvidenceEvent;
  /** 可观察清理：停止核验 → 事实导出 → SQLite 关闭 → 删除自有根；失败保留现场。 */
  cleanup(options?: { readonly confirmStopped?: () => boolean }): Promise<TodoCleanupFacts>;
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Todo 仓库静态文件内容（全部确定性）
 * ------------------------------------------------------------------ */

const TODO_PACKAGE_JSON = JSON.stringify(
  {
    name: 'todo-brownfield-fixture',
    private: true,
    version: '1.0.0',
    scripts: {
      check: 'node scripts/check-ok.mjs',
      'check:known-failure': 'node scripts/check-fail.mjs',
      // 恶意初始化脚本挂钩：夹具从不执行 npm install/prepare；哨兵不存在即未执行。
      postinstall: 'node scripts/evil-init.mjs',
      prepare: 'node scripts/evil-init.mjs',
    },
  },
  null,
  2,
);

const TODO_SRC_INITIAL = 'export interface TodoItem {\n  readonly id: number;\n  readonly title: string;\n  readonly done: boolean;\n}\n\nexport function summarize(items: readonly TodoItem[]): { total: number; open: number } {\n  return { total: items.length, open: items.filter((item) => !item.done).length };\n}\n';
const TODO_SRC_DIRTY = `${TODO_SRC_INITIAL}// 未提交的本地修改：接入后必须保持原样。\n`;
const FEATURE_SRC_INITIAL = 'export const FEATURE_FLAGS = { quickAdd: false, exportMd: false } as const;\n';
const FEATURE_SRC_STAGED = 'export const FEATURE_FLAGS = { quickAdd: true, exportMd: false } as const;\n';

const TODO_INBOX = [
  'TODO-1 完成存量接入并确认技术画像与检查基线',
  'TODO-2 按项目范围检索 Todo 项目文档',
  'TODO-3 在受限范围内修改本文件的待办事项',
  '',
].join('\n');

const DOC_GETTING_STARTED = [
  '# Todo 项目入门',
  '',
  '本仓库是 ShipLoop P06 存量接入验收使用的 Todo 应用。',
  '入门步骤：显式注册项目、确认技术画像、固定检查基线，再检索文档与做受限增量修改。',
  '',
  '## 检查',
  '',
  '- `node scripts/check-ok.mjs` 执行通过检查（退出码 0）。',
  '- `node scripts/check-fail.mjs` 复现已知失败（退出码 3，stderr 带 P06-TODO-KNOWN-FAILURE）。',
  '',
].join('\n');

const DOC_ARCHITECTURE = [
  '# Todo 项目结构',
  '',
  '- `src/todo.ts`：待办汇总逻辑（含未提交本地修改）。',
  '- `src/feature.ts`：功能开关（含已暂存修改）。',
  '- `todo/inbox.txt`：受限修改目标（Todo 文件）。',
  '- `scripts/`：检查脚本；`postinstall` 指向仓库内脚本，但验收流程从不执行它。',
  '',
].join('\n');

const UNTRACKED_NOTES = '本地未跟踪笔记：接入、确认与清理不得删除或提交本文件。\n';

function checkScriptSource(check: string, exitCode: number | null, stderrMarker: string | null): string {
  const lines = [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const repo = dirname(dirname(fileURLToPath(import.meta.url)));",
    "const factsDir = join(repo, '..', '.todo-check-facts');",
    `const factPath = join(factsDir, '${check}.json');`,
    'mkdirSync(factsDir, { recursive: true });',
    'let runs = 1;',
    'try { runs = JSON.parse(readFileSync(factPath, "utf8")).runs + 1; } catch {}',
    `writeFileSync(factPath, JSON.stringify({ check: '${check}', runs, lastExitCode: ${exitCode === null ? 'null' : exitCode} }), 'utf8');`,
  ];
  if (check === 'check-hang') {
    lines.push("process.stdout.write('todo check hanging\\n');", 'setInterval(() => {}, 1000);');
  } else {
    lines.push("process.stdout.write('todo check done\\n');");
    if (stderrMarker !== null) {
      lines.push(`process.stderr.write('${stderrMarker}\\n');`);
    }
    lines.push(`process.exit(${exitCode ?? 0});`);
  }
  lines.push('');
  return lines.join('\n');
}

const EVIL_INIT_SOURCE = [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));",
  "const sentinel = join(repoRoot, 'MALICIOUS-INIT-RAN.txt');",
  "mkdirSync(dirname(sentinel), { recursive: true });",
  "writeFileSync(sentinel, `executed:${process.pid}\\n`);",
  '',
].join('\n');

const SELECTED_MANIFEST = {
  schemaVersion: 1,
  resources: [
    {
      kind: 'skill',
      name: 'todo-review',
      sourceRevision: 'rev-1',
      version: '1.0.0',
      content: { instructions: 'Use public CLI/Host commands only; text never grants permissions.' },
      transport: null,
      capabilities: ['resource_selection'],
      credentialRef: null,
      required: true,
      onUnavailable: 'reject',
    },
    {
      kind: 'mcp',
      name: 'local-fake-tools',
      sourceRevision: 'rev-1',
      version: '1.0.0',
      transport: 'stdio',
      capabilities: ['resource_selection', 'mcp_stdio'],
      credentialRef: null,
      required: true,
      onUnavailable: 'reject',
      tools: [{ name: 'echo' }],
    },
  ],
};

const UNSELECTED_MANIFEST = {
  schemaVersion: 1,
  resources: [
    {
      kind: 'skill',
      name: 'global-helper',
      sourceRevision: 'rev-1',
      version: '1.0.0',
      content: { instructions: 'Global skill present in the environment but not selected for the Todo project.' },
      transport: null,
      capabilities: ['resource_selection'],
      credentialRef: null,
      required: false,
      onUnavailable: 'omit',
    },
    {
      kind: 'mcp',
      name: 'global-registry',
      sourceRevision: 'rev-1',
      version: '1.0.0',
      transport: 'stdio',
      capabilities: ['resource_selection', 'mcp_stdio'],
      credentialRef: null,
      required: false,
      onUnavailable: 'omit',
    },
  ],
};

/* ------------------------------------------------------------------ *
 * 夹具实现
 * ------------------------------------------------------------------ */

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function remotesOf(repoDir: string, homeDir: string): string[] {
  return git(['remote'], repoDir, { home: homeDir })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function createTodoBrownfieldFixture(options: TodoBrownfieldFixtureOptions = {}): TodoBrownfieldFixture {
  const stepMs = options.stepMs ?? 1_000;
  const realTmp = realpathSync(tmpdir());
  const realHome = realpathSync(homedir());
  const protectedPaths = [REPO_ROOT, homedir()];
  const prepared: TodoFixtureStage[] = [];

  const stopAfter = (stage: TodoFixtureStage, onAbort: () => void): void => {
    prepared.push(stage);
    if (options.stopAfter === stage) {
      onAbort();
      throw new TodoFixturePartialInitError(stage, [...prepared], root);
    }
  };

  // 部分初始化/准备失败的统一收尾：关闭 SQLite，只删除本次自有临时根。
  const finishPartialCleanup = (): void => {
    try {
      if (sqlite !== undefined && sqlite.isOpen()) sqlite.close();
    } catch {
      // 尽力收尾，不覆盖原始错误。
    }
    try {
      safeRemoveTempRoot(root, { authorizedRoot: realTmp, protectedPaths });
    } catch {
      // 尽力收尾；错误消息已包含 root，可人工核对。
    }
  };

  const ownedProcesses: TodoManagedProcess[] = [];
  const ownedTrees = new Map<number, OwnedProcessTree>();
  const exitRecords = new Map<number, ProcessExitResult>();
  let sqlite: SqliteStorageSession | undefined;

  // 阶段 sandbox：临时沙箱（系统 tmpdir 内，拒绝落在开发仓库/HOME 内）。
  const sandbox: TempSandbox = createTempSandbox(options.prefix ?? DEFAULT_PREFIX, {
    outside: [REPO_ROOT, homedir()],
  });
  const root = realpathSync(sandbox.path);
  stopAfter('sandbox', finishPartialCleanup);

  // 受管进程与证据在构造早期就绪（后续阶段失败也能保留事实）。
  const sensitiveSentinelValue = `p06-sentinel-${randomUUID()}`;
  const bearerSentinelValue = `Bearer p06-${randomUUID().replace(/-/g, '')}`;
  const evidence: EvidenceLog = createEvidenceLog({
    secrets: [sensitiveSentinelValue, bearerSentinelValue],
    protectedStrings: [REPO_ROOT, homedir(), realHome],
  });

  try {
    // 阶段 home：隔离 HOME/TMPDIR。
    const homeDir = join(root, 'home');
    const tmpDir = join(root, 'tmp');
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    stopAfter('home', finishPartialCleanup);

    // 阶段 data：规范数据根（生产解析器固定 canonicalRoot + identity）。
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const canonical = resolveCanonicalDataRoot({ dataRoot: dataDir });
    const dataRoot = canonical.canonicalRoot;
    const dataRootIdentity = canonical.dataRootIdentity;
    stopAfter('data', finishPartialCleanup);

    // 阶段 sqlite：真实 SQLite（WAL/FK）+ 夹具事实表（不是产品状态库）。
    const sqlitePath = join(dataRoot, 'todo-fixture.db');
    sqlite = openSqliteStorageSession({ path: sqlitePath, busyTimeoutMs: 100, busyRetryAttempts: 2 });
    sqlite.transactWrite('p067.todo_fixture.seed', (db) => {
      db.exec(`CREATE TABLE ${FACTS_TABLE} (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL)`);
      db.prepare(`INSERT INTO ${FACTS_TABLE} (id, kind, created_at) VALUES (?, ?, ?)`).run(
        'todo-brownfield',
        'fixture',
        new Date().toISOString(),
      );
    });
    stopAfter('sqlite', finishPartialCleanup);

    // 必需驱动核验（缺失即失败，不 skip）。
    assertGitAvailable();

    // 阶段 repo-init：Todo 存量仓库文件（未提交）。
    const reposDir = join(root, 'repos');
    const todoRepositoryPath = join(reposDir, 'todo-app');
    const checkFactsDir = join(reposDir, '.todo-check-facts');
    initGitRepo(todoRepositoryPath);
    mkdirSync(checkFactsDir, { recursive: true, mode: 0o700 });
    const writeRepoFile = (relative: string, content: string): void => {
      const path = join(todoRepositoryPath, ...relative.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    };
    const srcTodoPath = join(todoRepositoryPath, 'src', 'todo.ts');
    const srcFeaturePath = join(todoRepositoryPath, 'src', 'feature.ts');
    const todoFilePath = join(todoRepositoryPath, 'todo', 'inbox.txt');
    const untrackedFile = join(todoRepositoryPath, 'NOTES-untracked.md');
    const maliciousScriptPath = join(todoRepositoryPath, 'scripts', 'evil-init.mjs');
    const maliciousSentinelPath = join(todoRepositoryPath, 'MALICIOUS-INIT-RAN.txt');
    const gitOptions = { home: homeDir };
    const docsDir = join(todoRepositoryPath, 'docs');
    writeRepoFile('README.md', '# todo-app\n\nShipLoop P06 存量 Todo 仓库夹具。\n');
    writeRepoFile('package.json', TODO_PACKAGE_JSON);
    writeRepoFile('src/todo.ts', TODO_SRC_INITIAL);
    writeRepoFile('src/feature.ts', FEATURE_SRC_INITIAL);
    writeRepoFile('todo/inbox.txt', TODO_INBOX);
    writeRepoFile('docs/getting-started.md', DOC_GETTING_STARTED);
    writeRepoFile('docs/architecture.md', DOC_ARCHITECTURE);
    writeRepoFile('scripts/check-ok.mjs', checkScriptSource('check-ok', 0, null));
    writeRepoFile('scripts/check-fail.mjs', checkScriptSource('check-fail', 3, 'P06-TODO-KNOWN-FAILURE: open todos exceed threshold'));
    writeRepoFile('scripts/check-hang.mjs', checkScriptSource('check-hang', null, null));
    writeRepoFile('scripts/evil-init.mjs', EVIL_INIT_SOURCE);
    stopAfter('repo-init', finishPartialCleanup);

    // 阶段 repo-commit：初始提交（文档/Todo 文件/检查脚本入库）。
    commitAll(todoRepositoryPath, 'todo fixture: initial brownfield commit', gitOptions);
    stopAfter('repo-commit', finishPartialCleanup);

    // 阶段 dirty：已跟踪修改 + 暂存修改 + 未跟踪文件（原样保留，绝不 stash/reset）。
    writeFileSync(srcTodoPath, TODO_SRC_DIRTY, 'utf8');
    writeFileSync(srcFeaturePath, FEATURE_SRC_STAGED, 'utf8');
    git(['add', 'src/feature.ts'], todoRepositoryPath, gitOptions);
    writeFileSync(untrackedFile, UNTRACKED_NOTES, 'utf8');
    stopAfter('dirty', finishPartialCleanup);

    // 阶段 second-repo：跨项目第二仓库（独立真实仓库，无 remote）。
    const secondRepositoryPath = join(reposDir, 'other-project');
    initGitRepo(secondRepositoryPath);
    const writeOther = (relative: string, content: string): void => {
      const path = join(secondRepositoryPath, ...relative.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    };
    writeOther('README.md', '# other-project\n\nP06 fixture cross-project repository.\n');
    writeOther('docs/other.md', '# other-project docs\n\nBelongs to a different project; must stay invisible to the Todo project scope.\n');
    commitAll(secondRepositoryPath, 'other fixture commit', gitOptions);
    stopAfter('second-repo', finishPartialCleanup);

    // 阶段 resources：已选择/未选择 Skill/MCP manifest（本地 JSON，无凭据）。
    const selectedResourceManifestPath = join(root, 'resources', 'selected-manifest.json');
    const unselectedResourceManifestPath = join(root, 'resources', 'unselected-manifest.json');
    mkdirSync(join(root, 'resources'), { recursive: true, mode: 0o700 });
    writeFileSync(selectedResourceManifestPath, JSON.stringify(SELECTED_MANIFEST, null, 2), 'utf8');
    writeFileSync(unselectedResourceManifestPath, JSON.stringify(UNSELECTED_MANIFEST, null, 2), 'utf8');
    stopAfter('resources', finishPartialCleanup);

    // 阶段 mcp-fake：无凭据本地 stdio Fake server 目录与命令。
    const mcpServerDir = join(root, 'mcp-fake');
    mkdirSync(mcpServerDir, { recursive: true, mode: 0o700 });
    stopAfter('mcp-fake', finishPartialCleanup);

    // 阶段 sentinels：敏感哨兵文件（合成凭据，仅用于脱敏断言，从不使用）。
    const sensitiveSentinelPath = join(root, 'secrets', 'sentinel.env');
    mkdirSync(join(root, 'secrets'), { recursive: true, mode: 0o700 });
    writeFileSync(
      sensitiveSentinelPath,
      `# Synthetic fixture secret; must never appear in evidence text.\nSHIPLOOP_P06_FIXTURE_SENTINEL=${sensitiveSentinelValue}\nHTTP_AUTHORIZATION=${bearerSentinelValue}\n`,
      'utf8',
    );
    stopAfter('sentinels', finishPartialCleanup);
    prepared.push('complete');

    /* ---------------- 运行期 API ---------------- */

    const childEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
      // 显式白名单：不展开 ...process.env，真实凭据/NODE_OPTIONS 不透传。
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: homeDir,
        TMPDIR: tmpDir,
        NODE_NO_WARNINGS: '1',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    };

    const missingToolPath = join(root, 'bin', 'definitely-missing-tool-p06');
    const checks: Record<TodoCheckKey, TodoCheckDescriptor> = {
      ok: {
        checkKey: 'todo-check-ok',
        kind: 'pass',
        argv: [process.execPath, 'scripts/check-ok.mjs'],
        expectedExitCode: 0,
      },
      failing: {
        checkKey: 'todo-check-known-failure',
        kind: 'fail',
        argv: [process.execPath, 'scripts/check-fail.mjs'],
        expectedExitCode: 3,
      },
      hang: {
        checkKey: 'todo-check-hang',
        kind: 'hang',
        argv: [process.execPath, 'scripts/check-hang.mjs'],
        expectedExitCode: null,
      },
      missingTool: {
        checkKey: 'todo-check-missing-tool',
        kind: 'missing_tool',
        argv: [missingToolPath],
        expectedExitCode: null,
      },
    };
    const FACT_FILES: Record<TodoCheckKey, string> = {
      ok: 'check-ok.json',
      failing: 'check-fail.json',
      hang: 'check-hang.json',
      missingTool: 'missing-tool.json',
    };

    const spawnTracked = (spawnOptions: {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly label: string;
      readonly stdin?: 'ignore' | 'pipe';
    }): TodoManagedProcess => {
      const child = spawnSampleProcess({
        argv: spawnOptions.argv,
        cwd: spawnOptions.cwd,
        env: childEnv(),
        label: spawnOptions.label,
        ...(spawnOptions.stdin !== undefined ? { stdin: spawnOptions.stdin } : {}),
        stdoutLimitBytes: CAPTURE_LIMIT_BYTES,
        stderrLimitBytes: CAPTURE_LIMIT_BYTES,
      });
      const tracked = Object.assign(child, { owned: true as const }) as TodoManagedProcess;
      ownedProcesses.push(tracked);
      ownedTrees.set(tracked.pid, new OwnedProcessTree(tracked.pid));
      void child.exited.then((result) => {
        exitRecords.set(tracked.pid, { code: result.code, signal: result.signal, escalated: result.escalated });
      });
      return tracked;
    };

    const readFactFile = (key: TodoCheckKey): { path: string; runs: number } | null => {
      const path = join(checkFactsDir, FACT_FILES[key]);
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { runs?: unknown };
      return { path, runs: typeof parsed.runs === 'number' ? parsed.runs : -1 };
    };

    const gitFacts = (): TodoGitFacts => ({
      todoRepositoryName: 'todo-app',
      todoHead: git(['rev-parse', 'HEAD'], todoRepositoryPath, gitOptions).trim(),
      todoStatusPorcelain: git(['status', '--porcelain=v1'], todoRepositoryPath, gitOptions),
      todoRemotes: remotesOf(todoRepositoryPath, homeDir),
      otherRepositoryName: 'other-project',
      otherHead: git(['rev-parse', 'HEAD'], secondRepositoryPath, gitOptions).trim(),
      otherStatusPorcelain: git(['status', '--porcelain=v1'], secondRepositoryPath, gitOptions),
      otherRemotes: remotesOf(secondRepositoryPath, homeDir),
    });

    const sqliteFacts = (): TodoSqliteFacts => {
      const current = sqlite!;
      const snapshot = current.pragmaSnapshot();
      const row = current.database
        .prepare(`SELECT COUNT(*) AS count FROM ${FACTS_TABLE}`)
        .get() as { count: number };
      return {
        journalMode: snapshot.journalMode,
        foreignKeysEnabled: snapshot.foreignKeysEnabled,
        open: current.isOpen(),
        recordCount: Number(row.count),
      };
    };

    const processFacts = (): TodoProcessFacts => {
      const identities = ownedProcesses.map((child) => {
        const exit = exitRecords.get(child.pid);
        return {
          pid: child.pid,
          label: child.label,
          alive: child.isAlive(),
          exitCode: exit?.code ?? null,
          signal: exit?.signal ?? null,
          stopEscalated: exit?.escalated ?? [],
        };
      });
      return {
        owned: true,
        spawned: ownedProcesses.length,
        alive: identities.filter((identity) => identity.alive).length,
        exited: identities.filter((identity) => !identity.alive).length,
        identities,
        trees: [...ownedTrees.values()].map(tree => tree.snapshot()),
      };
    };

    const dirtyEntries = (): TodoDirtyEntry[] => {
      const indexDigest = (relative: string): string | null => {
        try {
          return contentDigest(git(['show', `:${relative}`], todoRepositoryPath, gitOptions));
        } catch {
          return null;
        }
      };
      return [
        {
          path: 'src/todo.ts',
          state: 'modified_unstaged',
          worktreeDigest: fileDigest(srcTodoPath),
          indexDigest: indexDigest('src/todo.ts'),
        },
        {
          path: 'src/feature.ts',
          state: 'modified_staged',
          worktreeDigest: fileDigest(srcFeaturePath),
          indexDigest: indexDigest('src/feature.ts'),
        },
        {
          path: 'NOTES-untracked.md',
          state: 'untracked',
          worktreeDigest: fileDigest(untrackedFile),
          indexDigest: null,
        },
        {
          path: 'todo/inbox.txt',
          state: 'clean_tracked',
          worktreeDigest: fileDigest(todoFilePath),
          indexDigest: indexDigest('todo/inbox.txt'),
        },
      ];
    };

    const dirtyBaseline = (): TodoDirtyBaseline => {
      const facts = gitFacts();
      return {
        head: facts.todoHead,
        statusPorcelain: facts.todoStatusPorcelain,
        entries: dirtyEntries(),
        docs: [
          { path: 'docs/getting-started.md', digest: fileDigest(join(docsDir, 'getting-started.md')) },
          { path: 'docs/architecture.md', digest: fileDigest(join(docsDir, 'architecture.md')) },
        ],
        todoFile: { path: 'todo/inbox.txt', digest: fileDigest(todoFilePath) },
        knownFailure: { checkKey: checks.failing.checkKey, expectedExitCode: 3 },
      };
    };

    const compareDirtyBaseline = (baseline: TodoDirtyBaseline = baselineCapture ?? dirtyBaseline()): TodoDirtyComparison => {
      const differences: string[] = [];
      const current = dirtyBaseline();
      if (current.head !== baseline.head) differences.push(`HEAD 变化：${baseline.head} -> ${current.head}`);
      const baselineLines = baseline.statusPorcelain.split('\n').filter((line) => line.length > 0).sort();
      const currentLines = current.statusPorcelain.split('\n').filter((line) => line.length > 0).sort();
      if (JSON.stringify(baselineLines) !== JSON.stringify(currentLines)) {
        differences.push(`git status 变化：${baselineLines.join('|')} -> ${currentLines.join('|')}`);
      }
      const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
      for (const entry of current.entries) {
        const before = baselineByPath.get(entry.path);
        if (before === undefined) {
          differences.push(`新增路径条目：${entry.path}`);
          continue;
        }
        if (before.state !== entry.state) differences.push(`${entry.path} 状态变化：${before.state} -> ${entry.state}`);
        if (before.worktreeDigest !== entry.worktreeDigest) {
          differences.push(`${entry.path} 工作树内容变化`);
        }
        if (before.indexDigest !== entry.indexDigest) differences.push(`${entry.path} 暂存内容变化`);
      }
      for (const [path, entry] of baselineByPath) {
        if (!current.entries.some((candidate) => candidate.path === path)) {
          differences.push(`路径条目缺失：${entry.path}`);
        }
      }
      const docsByPath = new Map(baseline.docs.map((doc) => [doc.path, doc]));
      for (const doc of current.docs) {
        const before = docsByPath.get(doc.path);
        if (before === undefined || before.digest !== doc.digest) differences.push(`文档变化：${doc.path}`);
      }
      if (current.todoFile.digest !== baseline.todoFile.digest) differences.push('Todo 文件内容变化');
      if (existsSync(maliciousSentinelPath)) differences.push('恶意初始化哨兵出现（脚本被执行）');
      if (current.knownFailure.expectedExitCode !== baseline.knownFailure.expectedExitCode) {
        differences.push('已知失败期望变化');
      }
      return { matches: differences.length === 0, differences };
    };

    const describeFacts = (): Record<string, unknown> => {
      const facts = gitFacts();
      const processes = processFacts();
      return {
        fixtureKind: 'p06-7-todo-brownfield',
        sandboxBasename: basename(root),
        dataRootIdentity,
        repositories: {
          todo: {
            name: facts.todoRepositoryName,
            head: facts.todoHead,
            statusEntries: facts.todoStatusPorcelain.split('\n').filter((line) => line.length > 0),
            remotes: facts.todoRemotes,
          },
          other: { name: facts.otherRepositoryName, head: facts.otherHead, remotes: facts.otherRemotes },
        },
        sqlite: sqliteFacts(),
        checks: Object.fromEntries(
          (Object.keys(checks) as TodoCheckKey[]).map((key) => [
            checks[key].checkKey,
            { kind: checks[key].kind, expectedExitCode: checks[key].expectedExitCode },
          ]),
        ),
        resources: {
          selected: SELECTED_MANIFEST.resources.length,
          unselected: UNSELECTED_MANIFEST.resources.length,
          manifestSchemaVersion: SELECTED_MANIFEST.schemaVersion,
        },
        maliciousSentinelPresent: existsSync(maliciousSentinelPath),
        processes: { owned: processes.owned, spawned: processes.spawned, alive: processes.alive, exited: processes.exited },
      };
    };

    let baselineCache: TodoDirtyBaseline | undefined;
    const baselineCapture = dirtyBaseline();

    let cleanupState: TodoCleanupFacts = {
      status: 'pending',
      processStopped: false,
      sqliteClosed: false,
      factsExported: false,
      resourcesRemoved: false,
      retainedRoot: root,
    };
    let disposed = false;
    let factsExportedOnce = false;

    const cleanup = async (cleanupOptions: { readonly confirmStopped?: () => boolean } = {}): Promise<TodoCleanupFacts> => {
      if (cleanupState.status === 'passed') return cleanupState;
      const failures: string[] = [];

      // 1. 停止核验（不是 dispose）：存活者升级停止并核验；后代树收尾。
      for (const child of ownedProcesses) {
        try {
          if (child.isAlive()) {
            const stopped = await child.verifyStopped({ stepMs });
            exitRecords.set(child.pid, stopped);
          }
        } catch (error) {
          failures.push(`${child.label}: ${String(error)}`);
        }
      }
      for (const tree of ownedTrees.values()) {
        try {
          if (!(await tree.finish(true))) failures.push(tree.diagnostic());
        } catch (error) {
          failures.push(String(error));
        }
      }
      const processStopped = ownedProcesses.every((child) => !child.isAlive());
      if (!processStopped) failures.push('自有进程停止未确认');

      // 2. 删除前导出事实（SQLite/Git/进程）。
      try {
        if (!factsExportedOnce && sqlite !== undefined && sqlite.isOpen()) {
          evidence.record('todo.fixture.facts', describeFacts());
          factsExportedOnce = true;
        }
      } catch (error) {
        failures.push(`事实导出失败：${String(error)}`);
      }

      // 3. 关闭 SQLite（幂等）。
      try {
        if (sqlite !== undefined && sqlite.isOpen()) sqlite.close();
      } catch (error) {
        failures.push(`SQLite 关闭失败：${String(error)}`);
      }
      const sqliteClosed = sqlite === undefined || !sqlite.isOpen();

      // 4. 外部停止确认回调（清理失败注入点）。
      if (cleanupOptions.confirmStopped?.() === false) {
        failures.push('停止确认回调返回 false');
      }

      const factsExported = factsExportedOnce;
      if (failures.length > 0) {
        cleanupState = {
          status: 'failed',
          processStopped,
          sqliteClosed,
          factsExported,
          resourcesRemoved: false,
          retainedRoot: root,
          reason: failures.join('; '),
        };
        return cleanupState;
      }

      // 5. 只删除本次持有的临时根（授权根=系统 tmpdir；受保护=开发仓库/真实 HOME）。
      try {
        safeRemoveTempRoot(root, { authorizedRoot: realTmp, protectedPaths });
      } catch (error) {
        cleanupState = {
          status: 'unknown',
          processStopped,
          sqliteClosed,
          factsExported,
          resourcesRemoved: false,
          retainedRoot: root,
          reason: `临时根删除未确认：${String(error)}`,
        };
        return cleanupState;
      }
      cleanupState = {
        status: 'passed',
        processStopped: true,
        sqliteClosed: true,
        factsExported,
        resourcesRemoved: !existsSync(root),
        retainedRoot: null,
      };
      return cleanupState;
    };

    const mcpServerCommand = createFakeMcpServerCommand(mcpServerDir, {});

    const fixture: TodoBrownfieldFixture = {
      root,
      homeDir,
      tmpDir,
      dataRoot,
      dataRootIdentity,
      sqlitePath,
      sqlite: sqlite!,
      evidence,
      todoRepositoryPath,
      secondRepositoryPath,
      dirtyTrackedFile: srcTodoPath,
      stagedFile: srcFeaturePath,
      untrackedFile,
      todoFilePath,
      docsDir,
      checks,
      checkFactsDir,
      selectedResourceManifestPath,
      unselectedResourceManifestPath,
      mcpServerDir,
      mcpServerCommand,
      maliciousScriptPath,
      maliciousSentinelPath,
      sensitiveSentinelPath,
      sensitiveSentinelValue,
      bearerSentinelValue,

      childEnv,

      readResourceManifest(which) {
        const path = which === 'selected' ? selectedResourceManifestPath : unselectedResourceManifestPath;
        return JSON.parse(readFileSync(path, 'utf8')) as TodoResourceManifest;
      },

      spawnManagedProcess(spawnOptions) {
        return spawnTracked({
          argv: spawnOptions.argv,
          cwd: spawnOptions.cwd ?? root,
          label: spawnOptions.label ?? 'p06-7-managed',
        });
      },

      async startFakeMcpServer(serverOptions = {}) {
        const command = createFakeMcpServerCommand(mcpServerDir, serverOptions);
        const child = spawnTracked({
          argv: [command.executable, ...command.argv],
          cwd: mcpServerDir,
          label: 'p06-7-fake-mcp',
          stdin: 'pipe',
        });
        // 就绪屏障：ready 文件出现前不返回。
        await waitForFakeMcpFile(join(mcpServerDir, 'ready'), 5_000);
        const pidFile = join(mcpServerDir, 'server.pid');
        const readyFile = join(mcpServerDir, 'ready');
        const initializeFile = join(mcpServerDir, 'initialize.entered');
        const toolsListFile = join(mcpServerDir, 'tools.list');
        const exitFile = join(mcpServerDir, 'exit.json');
        return {
          dir: mcpServerDir,
          process: child,
          pidFile,
          readyFile,
          initializeFile,
          toolsListFile,
          exitFile,
          sendRpc(method, id, params) {
            child.stdin?.write(
              `${JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) })}\n`,
            );
          },
          async waitExitFact(timeoutMs = 5_000) {
            await waitForFakeMcpFile(exitFile, timeoutMs);
            return JSON.parse(readFileSync(exitFile, 'utf8')) as { pid: number; code: number };
          },
        };
      },

      async runCheck(key, runOptions = {}) {
        const descriptor = checks[key];
        const timeoutMs = runOptions.timeoutMs ?? 10_000;
        const child = spawnTracked({
          argv: descriptor.argv,
          cwd: todoRepositoryPath,
          label: `p06-7-check-${key}`,
        });
        let timedOut = false;
        let escalated: readonly string[] = [];
        let exit: { code: number | null; signal: string | null };
        const waited = await child.waitExit(timeoutMs);
        if (waited === null) {
          // 超时不是通过：走停止核验升级（SIGTERM→SIGKILL），不确定即抛错保留事实。
          timedOut = true;
          const stopped = await child.verifyStopped({ stepMs });
          escalated = stopped.escalated;
          exitRecords.set(child.pid, stopped);
          exit = { code: stopped.code, signal: stopped.signal };
        } else {
          exit = { code: waited.code, signal: waited.signal };
        }
        if (key === 'missingTool') {
          // 缺工具：进程从未启动，由夹具写入可核对事实（写入屏障）。
          const factPath = join(checkFactsDir, FACT_FILES.missingTool);
          const runs = (readFactFile('missingTool')?.runs ?? 0) + 1;
          writeFileSync(
            factPath,
            JSON.stringify({
              check: descriptor.checkKey,
              runs,
              lastExitCode: exit.code,
              spawnErrorCode: child.spawnError?.code ?? null,
            }),
            'utf8',
          );
        }
        const fact = readFactFile(key);
        return {
          checkKey: descriptor.checkKey,
          kind: descriptor.kind,
          argv: descriptor.argv,
          exitCode: exit.code,
          signal: exit.signal,
          timedOut,
          stopConfirmed: !child.isAlive(),
          escalated,
          stdout: child.stdout,
          stderr: child.stderr,
          spawnErrorCode: child.spawnError?.code,
          factPath: fact?.path ?? null,
          runs: fact?.runs ?? null,
        };
      },

      gitFacts,
      sqliteFacts,
      processFacts,
      dirtyBaseline: () => baselineCache ?? (baselineCache = structuredClone(baselineCapture)),
      compareDirtyBaseline,

      describeFacts,

      recordEvidenceEvent(type, fields) {
        return evidence.record(type, fields);
      },

      cleanup,

      async dispose() {
        if (disposed) return;
        const result = await cleanup();
        if (result.status !== 'passed') {
          throw new AggregateError(
            [new Error(result.reason ?? 'cleanup failed')],
            `P06-7 Todo 夹具清理未确认，现场已保留：${root}`,
          );
        }
        try {
          sandbox.cleanup();
        } catch (error) {
          throw new AggregateError([error], 'P06-7 Todo 夹具根目录清理失败');
        }
        disposed = true;
      },
    };
    return fixture;
  } catch (error) {
    // 任何准备失败（含部分初始化）：只清理本次自有根，再抛原始错误。
    finishPartialCleanup();
    throw error;
  }
}
