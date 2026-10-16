/**
 * F-012 干净快照连续复跑（P02-ENG-CLEAN-REPLAY）：复用 `clean-snapshot-replay.ts`
 * 的共享积木（createCleanSnapshot / sanitizeEvidenceText / 有界子进程 / 安全清理）
 * 与 `p02-report.ts` / `build-artifact-scan.ts` 的既有验收积木，在受控临时干净源码
 * 快照中 `npm ci` / `npm run build` 后：
 *  - `public-import-smoke`：以 `p02-clean-replay-import-probe.mjs` 在进程/网络护栏
 *    下 import 三个包的公共入口，断言无进程/网络副作用、不写隔离 HOME/XDG/TMPDIR；
 *  - `dist-smoke`：从**非源码 cwd** 以隔离的数据根/HOME/TMPDIR/Git 仓库真实运行
 *    快照内构建出的正式 CLI/Host（唯一 Host 启动→项目注册→状态查询→停止三证据）；
 *  - 在该环境**连续两次**真实执行 `npm run accept:p02`（均须退出 0），核验两次
 *    run-id/报告目录/临时资源独立、第二次不复用上次项目/数据库/发现文件、逐项结果
 *    与证据 hash/size 可整目录重验、第一份证据未被第二次覆盖；
 *  - 结束后核验自有 Host/基线进程已退出、无占锁/发现文件/哨兵残留与继续写入，
 *    并复用构建路径/依赖扫描确认运行产物不依赖 Harness、Nezha 或个人绝对路径。
 * 这只是构建入口验收，不提前实现 P08 安装发布。
 *
 * 本模块同时提供两种运行形态：
 *  - `runP02CleanReplay`：进程内一次执行全部阶段（vitest 完整复跑形态使用）；
 *  - CLI 分阶段形态（`--phase prepare|accept-1|accept-2|finalize|all`）：阶段状态
 *    持久化在证据目录 `state.json` 跨进程续跑，长验收可按阶段拆分为多次调用
 *    （finalize 导出证据后删除状态文件）。
 *
 * 安全边界：显式 argv 子进程（不经 Shell 拼接）、有界超时只杀自有进程组；只删除
 * 本次持有的授权临时根；证据文本统一脱敏为 <SNAPSHOT-ROOT>/<REPO-ROOT>/<TMPDIR>/
 * <HOME> 逻辑位置后先导出再清理；不导出环境变量、凭据或原始秘密；不调用模型、
 * 不执行 npm 发布。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanBuildArtifacts,
  type BuildScanFinding,
} from './build-artifact-scan.ts';
import {
  assertSafeTempRoot,
  createCleanSnapshot,
  killTrackedProcessGroups,
  resolveNpm,
  runBounded,
  runNpm,
  sanitizeEvidenceText,
  sha256Hex,
  type BoundedResult,
  type CleanSnapshot,
  type SanitizeReplacements,
} from './clean-snapshot-replay.ts';
import { verifyP02ReportDirectory } from './p02-report.ts';
import { loadP02AcceptanceConfig } from './p02-config.ts';

/* ------------------------------------------------------------------ *
 * 冻结契约（test/p02-4-clean-replay.test.ts 逐项守护）
 * ------------------------------------------------------------------ */

/** P02-ENG-CLEAN-REPLAY 的承接测试入口（与 p02-report.ts/acceptance/p02.config.json 一致）。 */
export const P02_CLEAN_REPLAY_ENTRY = 'test/p02-4-clean-replay.test.ts';

/** 证据输出目录（相对受测仓库根；P01 evidence-p01-4 同约定）。 */
export const P02_CLEAN_REPLAY_OUT_DIR = 'docs/acceptance/evidence-p02-4-clean-replay';

/** 复跑深度护栏环境变量：≥1 表示嵌套 accept:p02 内的同名场景步骤，禁止递归复跑。 */
export const P02_REPLAY_DEPTH_ENV = 'SHIPLOOP_CLEAN_REPLAY_DEPTH';

export type P02ReplayStep = {
  /** 稳定步骤 ID（亦用于日志与证据文件名）。 */
  readonly id: string;
  readonly label: string;
  /** 传给当前 npm 的参数；自定义步骤为空数组（由驱动按 id 承载）。 */
  readonly npmArgs: readonly string[];
  readonly timeoutMs: number;
  /** 是否为 accept:p02 运行（需要解析报告、重验证据并记录运行独立性）。 */
  readonly isAcceptRun: boolean;
};

/** 冻结的复跑步骤与顺序：npm ci/build → public import 冒烟 → 非源码 cwd dist 冒烟 → 连续两次 accept:p02。 */
export const P02_REPLAY_STEPS: readonly P02ReplayStep[] = [
  { id: 'npm-ci', label: 'npm ci', npmArgs: ['ci'], timeoutMs: 600_000, isAcceptRun: false },
  {
    id: 'build',
    label: 'npm run build',
    npmArgs: ['run', 'build'],
    timeoutMs: 600_000,
    isAcceptRun: false,
  },
  {
    id: 'public-import-smoke',
    label: '公共入口 import 无进程/网络副作用冒烟',
    npmArgs: [],
    timeoutMs: 60_000,
    isAcceptRun: false,
  },
  {
    id: 'dist-smoke',
    label: '正式 CLI/Host 非源码 cwd 冒烟（隔离 HOME/数据根/TMPDIR/Git 仓库）',
    npmArgs: [],
    timeoutMs: 180_000,
    isAcceptRun: false,
  },
  {
    id: 'accept-p02-1',
    label: 'npm run accept:p02（第 1 次）',
    npmArgs: ['run', 'accept:p02'],
    timeoutMs: 1_800_000,
    isAcceptRun: true,
  },
  {
    id: 'accept-p02-2',
    label: 'npm run accept:p02（第 2 次，验证不复用上次项目/数据库/发现文件）',
    npmArgs: ['run', 'accept:p02'],
    timeoutMs: 1_800_000,
    isAcceptRun: true,
  },
];

function mustStep(id: string): P02ReplayStep {
  const step = P02_REPLAY_STEPS.find((entry) => entry.id === id);
  if (step === undefined) {
    throw new Error(`未知复跑步骤：${id}`);
  }
  return step;
}

/** 复跑深度解析（fail-closed）：仅接受规范非负整数字符串；未设置为 0。 */
export function parseReplayDepth(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!/^(0|[1-9][0-9]{0,2})$/.test(value)) {
    throw new Error(`复跑深度非法（只接受 0..999 的规范整数）：${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 10);
}

/** 构造子进程环境并注入复跑深度护栏（其余键原样保留）。 */
export function replayChildEnv(env: NodeJS.ProcessEnv, depth: number): NodeJS.ProcessEnv {
  if (!Number.isInteger(depth) || depth < 0 || depth > 999) {
    throw new Error(`复跑深度非法：${String(depth)}`);
  }
  return { ...env, [P02_REPLAY_DEPTH_ENV]: String(depth) };
}

export interface P02AcceptReportSummary {
  readonly runDir: string;
  readonly conclusion: string;
  readonly pass: number;
  readonly fail: number;
  readonly notRun: number;
}

const P02_REPORT_LINE =
  /^accept:p02: REPORT (.+?)（conclusion=(\w+)，pass=(\d+) fail=(\d+) not_run=(\d+)）/m;

/** 从 accept:p02 标准输出严格按前缀解析最终 REPORT 行；非报告输出返回 null。 */
export function parseP02AcceptReportSummary(stdout: string): P02AcceptReportSummary | null {
  const match = P02_REPORT_LINE.exec(stdout);
  if (match === null) {
    return null;
  }
  return {
    runDir: match[1] as string,
    conclusion: match[2] as string,
    pass: Number.parseInt(match[3] as string, 10),
    fail: Number.parseInt(match[4] as string, 10),
    notRun: Number.parseInt(match[5] as string, 10),
  };
}

/* ------------------------------------------------------------------ *
 * 对外结果结构
 * ------------------------------------------------------------------ */

export interface P02ReplayStepRecord {
  readonly id: string;
  readonly label: string;
  readonly npmArgs: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly logPath: string;
}

export interface P02SmokeCommandRecord {
  readonly label: string;
  readonly argv: readonly string[];
  /** 逻辑 cwd。 */
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface P02CleanReplaySmoke {
  readonly cwdLogical: string;
  readonly homeLogical: string;
  readonly dataRootLogical: string;
  readonly repoLogical: string;
  readonly commands: readonly P02SmokeCommandRecord[];
  readonly cliEntryLogical: string;
  readonly listenAddress: string;
  readonly port: number;
  readonly startedOutcome: string;
  readonly hostInstanceId: string;
  readonly statusInstanceId: string;
  readonly registrationStatus: string;
  readonly projectId: string;
  readonly stopEvidence: {
    readonly processExit: string;
    readonly lock: string;
    readonly discovery: string;
  };
}

export interface P02CleanReplayAcceptRun {
  readonly stepId: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly runId: string;
  readonly conclusion: string;
  readonly counts: { readonly pass: number; readonly fail: number; readonly notRun: number };
  readonly checkStatuses: readonly { readonly id: string; readonly status: string }[];
  readonly runDirLogical: string;
  readonly reportVerified: boolean;
  readonly reportProblems: readonly string[];
  readonly evidenceDigests: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
  readonly tempRootLogical: string;
}

export interface P02CleanReplayIndependence {
  readonly distinctRunIds: boolean;
  readonly distinctRunDirs: boolean;
  readonly distinctTempRoots: boolean;
  readonly noCrossRunIdReference: boolean;
  readonly firstEvidenceUnchanged: boolean;
}

export interface P02CleanReplayCleanup {
  readonly processesRemaining: readonly number[];
  readonly discoveryFilesRemaining: readonly string[];
  readonly sentinelsRemaining: readonly string[];
  /** 信息字段：窗口内未被写入的静态守卫哨兵（设计上保留不变，非残留风险）。 */
  readonly sentinelStaticLeftovers: readonly string[];
  readonly continuedWrites: readonly string[];
  readonly observationWindowMs: number;
  readonly tempRootRemoved: boolean;
}

export interface P02CleanReplayBuildScan {
  readonly ok: boolean;
  readonly findings: readonly BuildScanFinding[];
  readonly fileCount: number;
}

export interface P02CleanReplayOutcome {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly commit: string;
  readonly branch: string;
  readonly steps: readonly P02ReplayStepRecord[];
  readonly smoke: P02CleanReplaySmoke;
  readonly acceptRuns: readonly P02CleanReplayAcceptRun[];
  readonly independence: P02CleanReplayIndependence;
  readonly cleanup: P02CleanReplayCleanup;
  readonly evidencePaths: readonly string[];
  readonly evidenceLeakHits: readonly string[];
  readonly buildScan: P02CleanReplayBuildScan;
}

export interface P02CleanReplayOptions {
  /** 受测仓库根（绝对路径；必须工作树 clean 且代码已提交）。 */
  readonly root: string;
  readonly log?: (message: string) => void;
}

/* ------------------------------------------------------------------ *
 * 内部状态（可 JSON 持久化，支撑 CLI 分阶段续跑）
 * ------------------------------------------------------------------ */

interface CommandState {
  readonly label: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

interface SmokeState {
  readonly cwd: string;
  readonly home: string;
  readonly dataRoot: string;
  readonly repo: string;
  readonly cliEntry: string;
  readonly commands: readonly CommandState[];
  readonly listenAddress: string;
  readonly port: number;
  readonly startedOutcome: string;
  readonly hostInstanceId: string;
  readonly statusInstanceId: string;
  readonly registrationStatus: string;
  readonly projectId: string;
  readonly stopEvidence: { readonly processExit: string; readonly lock: string; readonly discovery: string };
  readonly hostPid: number | null;
}

interface DigestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

interface AcceptRunState {
  readonly stepId: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly runId: string;
  readonly conclusion: string;
  readonly counts: { readonly pass: number; readonly fail: number; readonly notRun: number };
  readonly checkStatuses: readonly { readonly id: string; readonly status: string }[];
  readonly runDir: string;
  readonly reportVerified: boolean;
  readonly reportProblems: readonly string[];
  readonly evidenceDigests: readonly DigestEntry[];
  readonly tempRoot: string;
  /** 运行输出与报告/摘要原文（用于跨 run-id 引用核验；含真实路径，只存状态文件）。 */
  readonly text: string;
  /** 第一份证据完整性基线：报告目录与导出副本的逐文件摘要。 */
  readonly treeDigests: Readonly<Record<string, string>>;
}

interface ReplayState {
  readonly version: 1;
  readonly root: string;
  readonly outDir: string;
  readonly tempPrefix: string;
  commit: string;
  branch: string;
  tempRoot: string | null;
  snapshotRoot: string | null;
  replacements: SanitizeReplacements | null;
  steps: P02ReplayStepRecord[];
  smoke: SmokeState | null;
  acceptRuns: AcceptRunState[];
  trackedPids: number[];
  problems: string[];
}

const STATE_FILE = 'state.json';
const TEMP_PREFIX = 'shiploop-p02-clean-';
const OBSERVATION_WINDOW_MS = 2_000;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  'nezha',
  '@nezhajs',
  '@earendil-works/pi-coding-agent',
  'electron',
  'express',
  'fastify',
  'koa',
  'hono',
] as const;
export function replayMigrationVersions(snapshotRoot: string): readonly number[] {
  return loadP02AcceptanceConfig(join(snapshotRoot, 'acceptance/p02.config.json')).schemaVersions.sqliteMigrations;
}

/** Only verified report command logs; their sanitized copies are diagnostics, not original hash evidence. */
export function replayCommandLogs(runDir: string, paths: readonly string[]): { path: string; content: string }[] {
  return paths.filter((path) => path.startsWith('evidence/commands/')).map((path) => {
    if (!/^evidence\/commands\/[a-z0-9-]+\.log$/.test(path)) throw new Error('Invalid replay command log path');
    return { path, content: readFileSync(join(runDir, path), 'utf8') };
  });
}

export function replayAcceptanceEnv(source: NodeJS.ProcessEnv, isolated: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return replayChildEnv({
    ...isolated,
    SHIPLOOP_VERIFY_STEP_TIMEOUT_MS: source.SHIPLOOP_VERIFY_STEP_TIMEOUT_MS ?? '1200000',
    SHIPLOOP_TEST_RUN_TIMEOUT_MS: source.SHIPLOOP_TEST_RUN_TIMEOUT_MS ?? '1200000',
  }, 1);
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function listFilesUnder(directory: string, skip?: (absolute: string) => boolean): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (skip?.(child) === true) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  walk(directory);
  return out;
}

/** 树索引：相对路径 → 大小/修改时间指纹（用于写入差异观察）。 */
export function treeIndex(roots: readonly string[], statFile: (path: string) => { size: number; mtimeMs: number } = statSync): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    for (const file of listFilesUnder(root)) {
      try {
        const stat = statFile(file);
        index.set(toPosix(file), `${stat.size}:${stat.mtimeMs}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return index;
}

function treeDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) {
      changed.push(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      changed.push(path);
    }
  }
  return changed.sort();
}

function digestFileAt(absolute: string): DigestEntry {
  const bytes = readFileSync(absolute);
  return { path: absolute, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
}

function treeDigestsUnder(directory: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const file of listFilesUnder(directory)) {
    const digest = digestFileAt(file);
    digests[toPosix(relative(directory, file))] = `${digest.sha256}:${digest.sizeBytes}`;
  }
  return digests;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 取 stdout 最后一行可解析的 JSON 信封（CLI --json 输出）。 */
function parseJsonEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index] as string);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非信封行继续向前找。
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });
}

/* ------------------------------------------------------------------ *
 * 运行上下文与阶段实现
 * ------------------------------------------------------------------ */

interface ReplayContext {
  readonly state: ReplayState;
  readonly log: (message: string) => void;
}

function createContext(options: P02CleanReplayOptions): ReplayContext {
  const root = resolve(options.root);
  return {
    state: {
      version: 1,
      root,
      outDir: resolve(root, P02_CLEAN_REPLAY_OUT_DIR),
      tempPrefix: TEMP_PREFIX,
      commit: '',
      branch: '',
      tempRoot: null,
      snapshotRoot: null,
      replacements: null,
      steps: [],
      smoke: null,
      acceptRuns: [],
      trackedPids: [],
      problems: [],
    },
    log:
      options.log ??
      ((message: string): void => {
        process.stdout.write(`${message}\n`);
      }),
  };
}

function statePath(ctx: ReplayContext): string {
  return join(ctx.state.outDir, STATE_FILE);
}

function saveState(ctx: ReplayContext): void {
  mkdirSync(ctx.state.outDir, { recursive: true });
  writeFileSync(statePath(ctx), `${JSON.stringify(ctx.state, null, 2)}\n`, 'utf-8');
}

function loadContext(options: P02CleanReplayOptions): ReplayContext {
  const ctx = createContext(options);
  const path = statePath(ctx);
  if (!existsSync(path)) {
    throw new Error(`缺少阶段状态文件：${path}（请先运行 --phase prepare）`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReplayState;
  if (parsed.version !== 1 || parsed.root !== ctx.state.root) {
    throw new Error('阶段状态文件与当前仓库根不匹配，拒绝续跑');
  }
  return { state: parsed, log: ctx.log };
}

function sanitize(ctx: ReplayContext, text: string): string {
  const replacements = ctx.state.replacements;
  if (replacements === null) {
    return text;
  }
  return sanitizeEvidenceText(text, replacements);
}

function writeEvidence(ctx: ReplayContext, relativePath: string, rawText: string): void {
  const absolute = join(ctx.state.outDir, ...relativePath.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, sanitize(ctx, rawText), 'utf-8');
}

function writeStepLog(
  ctx: ReplayContext,
  step: P02ReplayStep,
  result: BoundedResult,
  header: string,
): string {
  const logPath = `logs/${step.id}.log`;
  writeEvidence(
    ctx,
    logPath,
    `$ ${header}\nexit=${String(result.code)} signal=${String(result.signal)} durationMs=${result.durationMs}${result.message === null ? '' : ` message=${result.message}`}\n\n${result.stdout}${result.stderr}`,
  );
  return logPath;
}

function recordStep(
  ctx: ReplayContext,
  step: P02ReplayStep,
  result: BoundedResult,
  logPath: string,
): void {
  ctx.state.steps.push({
    id: step.id,
    label: step.label,
    npmArgs: [...step.npmArgs],
    exitCode: result.code,
    durationMs: result.durationMs,
    timedOut: result.kind === 'timeout',
    logPath,
  });
  if (result.kind !== 'exit' || result.code !== 0) {
    ctx.state.problems.push(
      `步骤 ${step.id} 未正常退出：${result.kind} code=${String(result.code)} signal=${String(result.signal)} ${result.message ?? ''}`.trim(),
    );
    ctx.log(`p02-clean-replay: FAIL ${step.label}`);
  } else {
    ctx.log(`p02-clean-replay: EXIT 0 ${step.label} (${(result.durationMs / 1000).toFixed(1)}s)`);
  }
}

/** 状态文件之外的导出文件（证据清单）。 */
function evidenceFileList(ctx: ReplayContext): string[] {
  return listFilesUnder(ctx.state.outDir)
    .map((file) => toPosix(relative(ctx.state.outDir, file)))
    .filter((path) => path !== STATE_FILE)
    .sort();
}

/** 运行时残留扫描范围：临时根下除源码快照（repo/）之外的全部目录。 */
function runtimeAreas(ctx: ReplayContext): string[] {
  const tempRoot = ctx.state.tempRoot;
  const snapshotRoot = ctx.state.snapshotRoot;
  if (tempRoot === null) {
    return [];
  }
  return readdirSync(tempRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(tempRoot, entry.name))
    .filter((dir) => snapshotRoot === null || resolve(dir) !== resolve(snapshotRoot));
}

const SENTINEL_PATTERN = /sentinel|malicious-init-ran/i;

function isDiscoveryFile(file: string): boolean {
  return basename(file) === 'discovery.json';
}

function readDiscoveryPid(file: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown };
    const pid = parsed.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function collectDiscoveryPids(ctx: ReplayContext): number[] {
  const pids: number[] = [];
  for (const area of runtimeAreas(ctx)) {
    for (const file of listFilesUnder(area)) {
      if (isDiscoveryFile(file)) {
        const pid = readDiscoveryPid(file);
        if (pid !== null) {
          pids.push(pid);
        }
      }
    }
  }
  return pids;
}

/* ------------------------------------------------------------------ *
 * 阶段 1：干净快照 + npm ci/build + 两个冒烟步骤
 * ------------------------------------------------------------------ */

async function runPublicImportSmoke(ctx: ReplayContext): Promise<void> {
  const step = mustStep('public-import-smoke');
  const tempRoot = ctx.state.tempRoot as string;
  const snapshotRoot = ctx.state.snapshotRoot as string;
  const probeDir = join(tempRoot, 'probe');
  const probeEnvDirs = [
    join(probeDir, 'home'),
    join(probeDir, 'tmp'),
    join(probeDir, 'xdg-config'),
    join(probeDir, 'xdg-data'),
    join(probeDir, 'xdg-cache'),
  ];
  for (const dir of probeEnvDirs) {
    mkdirSync(dir, { recursive: true });
  }
  // 环境拼写契约（与真实用户环境一致）：HOME 用 realpath 规范拼写；TMPDIR 保留
  // 创建时的自然拼写（macOS /var 别名）；不得混用，否则跨拼写受保护串比对会失配。
  const probeEnvReal = probeEnvDirs.map((dir) => realpathSync(dir));
  const probeScript = join(snapshotRoot, 'scripts/acceptance/p02-clean-replay-import-probe.mjs');
  const entries = ['packages/core/dist/index.js', 'packages/host/dist/index.js', 'packages/cli/dist/index.js'].map(
    (entry) => join(snapshotRoot, ...entry.split('/')),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: probeEnvReal[0] as string,
    TMPDIR: probeEnvDirs[1] as string,
    NODE_NO_WARNINGS: '1',
    XDG_CONFIG_HOME: probeEnvReal[2] as string,
    XDG_DATA_HOME: probeEnvReal[3] as string,
    XDG_CACHE_HOME: probeEnvReal[4] as string,
  };
  const before = treeIndex(probeEnvDirs);
  const result = await runBounded(
    process.execPath,
    [probeScript, ...entries],
    probeDir,
    step.timeoutMs,
    env,
  );
  const after = treeIndex(probeEnvDirs);
  const writes = treeDiff(before, after);
  const logPath = writeStepLog(ctx, step, result, `node ${basename(probeScript)} <3 public entries>`);
  recordStep(ctx, step, result, logPath);
  if (writes.length > 0) {
    ctx.state.problems.push(
      `public import 冒烟写入了隔离 HOME/XDG/TMPDIR：${writes.slice(0, 5).join(', ')}`,
    );
  }
}

async function runDistSmoke(ctx: ReplayContext): Promise<void> {
  const step = mustStep('dist-smoke');
  const tempRoot = ctx.state.tempRoot as string;
  const snapshotRoot = ctx.state.snapshotRoot as string;
  const smokeRoot = join(tempRoot, 'smoke');
  const smokeCwd = join(smokeRoot, 'cwd');
  const smokeHome = join(smokeRoot, 'home');
  const smokeTmp = join(smokeRoot, 'tmp');
  const dataRoot = join(smokeRoot, 'data');
  const repoDir = join(smokeRoot, 'repo');
  for (const dir of [smokeCwd, smokeHome, smokeTmp, dataRoot, repoDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: realpathSync(smokeHome),
    TMPDIR: smokeTmp,
    NODE_NO_WARNINGS: '1',
  };
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const commands: CommandState[] = [];
  const runCommand = async (
    label: string,
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    commandEnv: NodeJS.ProcessEnv,
  ): Promise<BoundedResult> => {
    const result = await runBounded(command, args, cwd, timeoutMs, commandEnv);
    commands.push({
      label,
      argv: [command, ...args],
      cwd,
      exitCode: result.code,
      durationMs: result.durationMs,
      timedOut: result.kind === 'timeout',
    });
    writeEvidence(
      ctx,
      `logs/dist-smoke-${label}.log`,
      `$ ${command} ${args.join(' ')}\ncwd=${cwd}\nexit=${String(result.code)} signal=${String(result.signal)}${result.message === null ? '' : ` message=${result.message}`}\n\n${result.stdout}${result.stderr}`,
    );
    return result;
  };

  // 隔离 Git 仓库（不触碰受测开发仓库）。
  const init = await runCommand('git-init', 'git', ['init', '--quiet', '--initial-branch=main'], repoDir, 60_000, gitEnv);
  let ok = init.kind === 'exit' && init.code === 0;
  if (ok) {
    writeFileSync(join(repoDir, 'README.md'), '# shiploop clean-replay smoke\n', 'utf-8');
    const add = await runCommand('git-add', 'git', ['add', '-A'], repoDir, 60_000, gitEnv);
    ok = add.kind === 'exit' && add.code === 0;
    if (ok) {
      const commit = await runCommand(
        'git-commit',
        'git',
        [
          '-c',
          'user.name=shiploop-clean-replay',
          '-c',
          'user.email=clean-replay@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'smoke init',
        ],
        repoDir,
        60_000,
        gitEnv,
      );
      ok = commit.kind === 'exit' && commit.code === 0;
    }
  }

  const cliEntry = join(snapshotRoot, 'packages/cli/dist/bin.js');
  let startEnvelope: Record<string, unknown> | null = null;
  let registerEnvelope: Record<string, unknown> | null = null;
  let statusEnvelope: Record<string, unknown> | null = null;
  let stopEnvelope: Record<string, unknown> | null = null;

  if (ok) {
    const start = await runCommand(
      'host-start',
      process.execPath,
      [cliEntry, 'host', 'start', '--data-root', dataRoot, '--json'],
      smokeCwd,
      step.timeoutMs,
      env,
    );
    startEnvelope = parseJsonEnvelope(start.stdout);
    ok = start.kind === 'exit' && start.code === 0 && startEnvelope !== null;

    if (ok) {
      const register = await runCommand(
        'project-register',
        process.execPath,
        [cliEntry, 'project', 'register', repoDir, '--name', 'clean-replay smoke', '--data-root', dataRoot, '--json'],
        smokeCwd,
        step.timeoutMs,
        env,
      );
      registerEnvelope = parseJsonEnvelope(register.stdout);
      ok = register.kind === 'exit' && register.code === 0 && registerEnvelope !== null;
    }
    if (ok) {
      const status = await runCommand(
        'host-status',
        process.execPath,
        [cliEntry, 'host', 'status', '--data-root', dataRoot, '--json'],
        smokeCwd,
        step.timeoutMs,
        env,
      );
      statusEnvelope = parseJsonEnvelope(status.stdout);
      ok = status.kind === 'exit' && status.code === 0 && statusEnvelope !== null;
    }
    if (ok) {
      const stop = await runCommand(
        'host-stop',
        process.execPath,
        [cliEntry, 'host', 'stop', '--data-root', dataRoot, '--json'],
        smokeCwd,
        step.timeoutMs,
        env,
      );
      stopEnvelope = parseJsonEnvelope(stop.stdout);
      ok = stop.kind === 'exit' && stop.code === 0 && stopEnvelope !== null;
    }
  }

  // 冒烟步骤记录（步骤退出码：任一命令失败即非零）。
  const exitCode = ok ? 0 : 1;
  const anyTimeout = commands.some((command) => command.timedOut);
  const durationMs = commands.reduce((total, command) => total + command.durationMs, 0);
  ctx.state.steps.push({
    id: step.id,
    label: step.label,
    npmArgs: [...step.npmArgs],
    exitCode,
    durationMs,
    timedOut: anyTimeout,
    logPath: 'logs/dist-smoke-*.log',
  });

  // 记录 Host pid（用于结束后进程退出核验）。
  let hostPid: number | null = null;
  for (const file of listFilesUnder(dataRoot)) {
    if (isDiscoveryFile(file)) {
      hostPid = readDiscoveryPid(file);
    }
  }
  if (hostPid !== null) {
    ctx.state.trackedPids.push(hostPid);
  }

  const startResult = asRecord(startEnvelope === null ? undefined : startEnvelope.result);
  const registerReceipt = asRecord(registerEnvelope === null ? undefined : registerEnvelope.result);
  const registerResult = asRecord(registerReceipt.result);
  const statusResult = asRecord(statusEnvelope === null ? undefined : statusEnvelope.result);
  const stopResult = asRecord(stopEnvelope === null ? undefined : stopEnvelope.result);
  const stopEvidence = asRecord(stopResult.evidence);

  ctx.state.smoke = {
    cwd: smokeCwd,
    home: smokeHome,
    dataRoot,
    repo: repoDir,
    cliEntry,
    commands,
    listenAddress: String(startResult.listenAddress ?? ''),
    port: typeof startResult.port === 'number' ? startResult.port : 0,
    startedOutcome: String(startResult.outcome ?? ''),
    hostInstanceId: String(startResult.hostInstanceId ?? ''),
    statusInstanceId: String(statusResult.hostInstanceId ?? ''),
    registrationStatus: String(registerResult.status ?? ''),
    projectId: String(asRecord(registerResult.project).id ?? ''),
    stopEvidence: {
      processExit: String(stopEvidence.processExit ?? ''),
      lock: String(stopEvidence.lock ?? ''),
      discovery: String(stopEvidence.discovery ?? ''),
    },
    hostPid,
  };

  if (!ok) {
    ctx.state.problems.push('dist-smoke：正式 CLI/Host 冒烟命令未全部成功或信封不可解析');
    ctx.log(`p02-clean-replay: FAIL ${step.label}`);
    return;
  }

  // 信封语义核验（fail-closed：不以「命令已运行」代替结果）。
  const expectations: readonly (readonly [string, unknown, unknown])[] = [
    ['host.start 信封', startEnvelope?.ok, true],
    ['host.start 命令', startEnvelope?.command, 'host.start'],
    ['project.register 信封', registerEnvelope?.ok, true],
    ['project.register 命令', registerEnvelope?.command, 'project.register'],
    ['host.status 信封', statusEnvelope?.ok, true],
    ['host.stop 信封', stopEnvelope?.ok, true],
    ['启动结果', ctx.state.smoke.startedOutcome, 'started'],
    ['监听地址', ctx.state.smoke.listenAddress, '127.0.0.1'],
    ['注册状态', ctx.state.smoke.registrationStatus, 'registered'],
    ['停止证据 processExit', ctx.state.smoke.stopEvidence.processExit, 'confirmed'],
    ['停止证据 lock', ctx.state.smoke.stopEvidence.lock, 'acquirable'],
    ['停止证据 discovery', ctx.state.smoke.stopEvidence.discovery, 'removed'],
  ];
  for (const [label, actual, expected] of expectations) {
    if (actual !== expected) {
      ctx.state.problems.push(`dist-smoke ${label} 不符：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
    }
  }
  if (ctx.state.smoke.hostInstanceId === '' || ctx.state.smoke.projectId === '') {
    ctx.state.problems.push('dist-smoke：hostInstanceId/projectId 为空');
  }
  if (ctx.state.smoke.statusInstanceId !== ctx.state.smoke.hostInstanceId) {
    ctx.state.problems.push('dist-smoke：host status 实例与启动实例不一致');
  }
  if (!(ctx.state.smoke.port > 0)) {
    ctx.state.problems.push('dist-smoke：端口非法');
  }
  if (ctx.state.problems.length === 0) {
    ctx.log(`p02-clean-replay: EXIT 0 ${step.label} (host ${ctx.state.smoke.hostInstanceId})`);
  } else {
    ctx.log(`p02-clean-replay: FAIL ${step.label}`);
  }
}

async function phasePrepare(ctx: ReplayContext): Promise<void> {
  const log = ctx.log;
  const npm = resolveNpm();
  const snapshot: CleanSnapshot = await createCleanSnapshot({
    root: ctx.state.root,
    tempPrefix: ctx.state.tempPrefix,
    log,
    ignorePorcelainPrefixes: [P02_CLEAN_REPLAY_OUT_DIR],
  });
  ctx.state.tempRoot = snapshot.tempRoot;
  ctx.state.snapshotRoot = snapshot.snapshotRoot;
  ctx.state.commit = snapshot.commit;
  ctx.state.branch = snapshot.branch;
  const tempRootReal = realpathSync(snapshot.tempRoot);
  ctx.state.replacements = {
    ...snapshot.replacements,
    extra: [
      ...(snapshot.replacements.extra ?? []),
      [snapshot.tempRoot, '<TMPDIR>'],
      [tempRootReal, '<TMPDIR>'],
    ],
  };
  log(`p02-clean-replay: 干净快照 ${snapshot.snapshotRoot}（commit ${snapshot.commit}）`);

  for (const stepId of ['npm-ci', 'build'] as const) {
    const step = mustStep(stepId);
    log(`p02-clean-replay: RUN ${step.label}`);
    const result = await runNpm(npm, step.npmArgs, ctx.state.snapshotRoot as string, step.timeoutMs, process.env);
    const logPath = writeStepLog(ctx, step, result, `npm ${step.npmArgs.join(' ')}`);
    recordStep(ctx, step, result, logPath);
    if (result.kind !== 'exit' || result.code !== 0) {
      return;
    }
  }

  await runPublicImportSmoke(ctx);
  if (ctx.state.problems.length > 0) {
    return;
  }
  await runDistSmoke(ctx);
}

/* ------------------------------------------------------------------ *
 * 阶段 2/3：连续 accept:p02 运行
 * ------------------------------------------------------------------ */

async function phaseAccept(ctx: ReplayContext, index: 1 | 2): Promise<void> {
  const log = ctx.log;
  const step = mustStep(`accept-p02-${index}`);
  const tempRoot = ctx.state.tempRoot;
  const snapshotRoot = ctx.state.snapshotRoot;
  if (tempRoot === null || snapshotRoot === null) {
    ctx.state.problems.push('阶段状态缺少干净快照（请先运行 --phase prepare）');
    return;
  }
  const runTempRoot = join(tempRoot, `accept-${index}`);
  const homeDir = join(runTempRoot, 'home');
  const tmpDir = join(runTempRoot, 'tmp');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  // 每次运行独立的 HOME/TMPDIR + 复跑深度护栏（嵌套同名场景不递归复跑）。
  // 拼写契约同冒烟：HOME=realpath，TMPDIR=创建时自然拼写（与真实用户环境一致）。
  const env = replayAcceptanceEnv(process.env,
    {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: realpathSync(homeDir),
      TMPDIR: tmpDir,
      NODE_NO_WARNINGS: '1',
    },
  );
  log(`p02-clean-replay: RUN ${step.label}`);
  const result = await runNpm(resolveNpm(), step.npmArgs, snapshotRoot, step.timeoutMs, env);
  const logPath = writeStepLog(ctx, step, result, `npm ${step.npmArgs.join(' ')}`);
  recordStep(ctx, step, result, logPath);

  const summary = parseP02AcceptReportSummary(result.stdout);
  if (summary === null) {
    ctx.state.problems.push(`步骤 ${step.id}：无法从输出解析 accept:p02 REPORT 行`);
    return;
  }
  // 报告根/报告目录均按 realpath 对比（macOS /var → /private/var 别名）。
  const runDir = realpathSync(resolve(summary.runDir));
  const runId = basename(runDir);
  const reportRoot = realpathSync(join(snapshotRoot, 'artifacts/acceptance/p02'));
  if (!runDir.startsWith(reportRoot + '/')) {
    ctx.state.problems.push(`步骤 ${step.id}：报告目录不在快照报告根下：${runDir}`);
    return;
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    ctx.state.problems.push(`步骤 ${step.id}：run-id 形态非法：${runId}`);
    return;
  }

  const verification = verifyP02ReportDirectory(runDir);
  const reportPath = join(runDir, 'report.json');
  if (!existsSync(reportPath)) {
    ctx.state.problems.push(`步骤 ${step.id}：缺少 ${reportPath}`);
    return;
  }
  const rawReport = readFileSync(reportPath, 'utf-8');
  const report = asRecord(JSON.parse(rawReport));
  const counts = asRecord(report.counts);
  const checks = Array.isArray(report.checks) ? (report.checks as unknown[]) : [];
  const checkStatuses = checks.map((entry) => {
    const record = asRecord(entry);
    return { id: String(record.id ?? ''), status: String(record.status ?? '') };
  });
  const runCounts = {
    pass: typeof counts.pass === 'number' ? counts.pass : -1,
    fail: typeof counts.fail === 'number' ? counts.fail : -1,
    notRun: typeof counts.not_run === 'number' ? counts.not_run : -1,
  };
  const conclusion = String(report.conclusion ?? '');

  if (String(report.runId ?? '') !== runId) {
    ctx.state.problems.push(`步骤 ${step.id}：report.runId 与报告目录不一致`);
  }
  if (conclusion !== summary.conclusion) {
    ctx.state.problems.push(`步骤 ${step.id}：REPORT 行与 report.json 结论不一致`);
  }
  if (
    runCounts.pass !== summary.pass ||
    runCounts.fail !== summary.fail ||
    runCounts.notRun !== summary.notRun
  ) {
    ctx.state.problems.push(`步骤 ${step.id}：REPORT 行与 report.json 计数不一致`);
  }

  // 证据 hash/size 逐项重算（与清单/整目录重验交叉）。
  const evidenceEntries = Array.isArray(report.evidence) ? (report.evidence as unknown[]) : [];
  const evidenceDigests: DigestEntry[] = [];
  for (const raw of evidenceEntries) {
    const entry = asRecord(raw);
    const relPath = String(entry.path ?? '');
    const absolute = join(runDir, ...relPath.split('/'));
    if (!existsSync(absolute)) {
      ctx.state.problems.push(`步骤 ${step.id}：证据缺失 ${relPath}`);
      continue;
    }
    const digest = digestFileAt(absolute);
    evidenceDigests.push({ path: relPath, sha256: digest.sha256, sizeBytes: digest.sizeBytes });
    if (digest.sha256 !== entry.sha256 || digest.sizeBytes !== entry.sizeBytes) {
      ctx.state.problems.push(`步骤 ${step.id}：证据 hash/size 与清单不符 ${relPath}`);
    }
  }
  if (!verification.ok) {
    for (const problem of verification.problems) {
      ctx.state.problems.push(`步骤 ${step.id} 报告重验：${problem}`);
    }
  }

  // 报告目录与摘要导出到证据目录（脱敏；第一份证据不被第二次覆盖）。
  const exportDir = `accept-runs/${step.id}`;
  const summaryPath = join(runDir, 'summary.md');
  writeEvidence(ctx, `${exportDir}/report.json`, rawReport);
  if (verification.ok) {
    for (const entry of replayCommandLogs(runDir, evidenceEntries.map((raw) => String(asRecord(raw).path ?? '')))) {
      writeEvidence(ctx, `${exportDir}/diagnostics/${entry.path}`, entry.content);
    }
  }
  if (existsSync(summaryPath)) {
    writeEvidence(ctx, `${exportDir}/summary.md`, readFileSync(summaryPath, 'utf-8'));
  }
  writeEvidence(ctx, `${exportDir}/evidence-digests.json`, `${JSON.stringify(evidenceDigests, null, 2)}\n`);
  const exportedDigests = treeDigestsUnder(join(ctx.state.outDir, ...exportDir.split('/')));

  const rawSummary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf-8') : '';
  ctx.state.acceptRuns.push({
    stepId: step.id,
    exitCode: result.code,
    timedOut: result.kind === 'timeout',
    runId,
    conclusion,
    counts: runCounts,
    checkStatuses,
    runDir,
    reportVerified: verification.ok,
    reportProblems: [...verification.problems],
    evidenceDigests,
    tempRoot: runTempRoot,
    text: `${result.stdout}\n${result.stderr}\n${rawReport}\n${rawSummary}`,
    treeDigests: {
      ...prefixKeys(treeDigestsUnder(runDir), 'run-dir:'),
      ...prefixKeys(exportedDigests, 'export:'),
    },
  });
  ctx.state.trackedPids.push(...collectDiscoveryPids(ctx));
  log(
    `p02-clean-replay: ${step.id} run=${runId} conclusion=${conclusion} pass=${runCounts.pass} fail=${runCounts.fail} not_run=${runCounts.notRun}`,
  );
}

function prefixKeys(record: Readonly<Record<string, string>>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[`${prefix}${key}`] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 阶段 4：清理核验、构建扫描、独立性核验、证据导出与收尾
 * ------------------------------------------------------------------ */

function emptySmoke(): P02CleanReplaySmoke {
  return {
    cwdLogical: '',
    homeLogical: '',
    dataRootLogical: '',
    repoLogical: '',
    commands: [],
    cliEntryLogical: '',
    listenAddress: '',
    port: 0,
    startedOutcome: '',
    hostInstanceId: '',
    statusInstanceId: '',
    registrationStatus: '',
    projectId: '',
    stopEvidence: { processExit: '', lock: '', discovery: '' },
  };
}

async function phaseFinalize(ctx: ReplayContext): Promise<P02CleanReplayOutcome> {
  const state = ctx.state;
  const log = ctx.log;

  /* ---- 清理核验（进程/发现文件/哨兵/继续写入） ---- */
  // 发现文件：结束后不得残留（各次运行/冒烟的 Host 发现信息随停止删除）。
  // 哨兵：验收语义是「无哨兵继续写入」——静态守卫哨兵（如 P01-4 夹具的根外哨兵，
  // 设计上必须保持不变、业务清理绝不能触碰）不是残留风险；哨兵残留仅指观察
  // 窗口内仍被写入/新增的哨兵文件。静态守卫清单另作信息字段保留可审计。
  const discoveryRemaining: string[] = [];
  const sentinelStaticLeftovers: string[] = [];
  for (const area of runtimeAreas(ctx)) {
    for (const file of listFilesUnder(area)) {
      const name = basename(file);
      if (isDiscoveryFile(file)) {
        discoveryRemaining.push(toPosix(file));
      }
      if (SENTINEL_PATTERN.test(name)) {
        sentinelStaticLeftovers.push(toPosix(file));
      }
    }
  }
  const candidatePids = new Set<number>(state.trackedPids);
  for (const file of discoveryRemaining) {
    const pid = readDiscoveryPid(file);
    if (pid !== null) {
      candidatePids.add(pid);
    }
  }
  const processesRemaining = [...candidatePids].filter((pid) => pidAlive(pid)).sort((a, b) => a - b);
  if (processesRemaining.length > 0) {
    state.problems.push(`仍有自有进程存活：${processesRemaining.join(', ')}`);
    for (const pid of processesRemaining) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出或不可信号；保留 processesRemaining 证据。
      }
    }
  }
  if (discoveryRemaining.length > 0) {
    state.problems.push(`仍有发现文件残留：${discoveryRemaining.slice(0, 5).join(', ')}`);
  }

  // 观察窗口：结束后无任何继续写入（占锁/哨兵继续写入的最终核验）。
  const watchRoots = [...runtimeAreas(ctx)];
  const snapshotArtifacts =
    state.snapshotRoot === null ? null : join(state.snapshotRoot, 'artifacts');
  if (snapshotArtifacts !== null && existsSync(snapshotArtifacts)) {
    watchRoots.push(snapshotArtifacts);
  }
  const before = treeIndex(watchRoots);
  await sleep(OBSERVATION_WINDOW_MS);
  const after = treeIndex(watchRoots);
  const changedPaths = treeDiff(before, after);
  const continuedWrites = changedPaths.map((path) => sanitize(ctx, path));
  // 哨兵继续写入 = 观察窗口内新增/变化的哨兵文件（活跃哨兵写入者未退出的直接证据）。
  const sentinelsRemaining = changedPaths
    .filter((path) => SENTINEL_PATTERN.test(basename(path)))
    .map((path) => sanitize(ctx, path));
  if (continuedWrites.length > 0) {
    state.problems.push(`观察窗口内仍有文件写入：${continuedWrites.slice(0, 5).join(', ')}`);
  }
  if (sentinelsRemaining.length > 0) {
    state.problems.push(`哨兵仍在继续写入：${sentinelsRemaining.slice(0, 5).join(', ')}`);
  }

  /* ---- 构建路径/依赖扫描（复用 build-artifact-scan.ts） ---- */
  let buildScan: P02CleanReplayBuildScan = { ok: false, findings: [], fileCount: 0 };
  if (state.snapshotRoot !== null) {
    const snapshotRoot = state.snapshotRoot;
    const packageDir = (name: string): string => join(snapshotRoot, 'packages', name);
    const scan = scanBuildArtifacts({
      baseDir: snapshotRoot,
      packages: ['core', 'host', 'cli'].map((name) => ({
        name: `shiploop-${name}`,
        manifestPath: join(packageDir(name), 'package.json'),
        packageDir: packageDir(name),
        distDir: join(packageDir(name), 'dist'),
      })),
      configFiles: [join(snapshotRoot, 'acceptance/p02.config.json')],
      expectedMigrations: [
        {
          path: join(packageDir('core'), 'dist/adapters/sqlite/migrations.js'),
          versions: replayMigrationVersions(snapshotRoot),
        },
      ],
      homeDir: homedir(),
      forbiddenRuntimeDependencies: [...FORBIDDEN_RUNTIME_DEPENDENCIES],
    });
    buildScan = { ok: scan.ok, findings: scan.findings, fileCount: scan.fileCount };
    writeEvidence(
      ctx,
      'build-scan.json',
      `${JSON.stringify(
        {
          ok: scan.ok,
          findings: scan.findings,
          fileCount: scan.fileCount,
          totalBytes: scan.totalBytes,
          declaredEntries: scan.declaredEntries,
          migrationResources: scan.migrationResources,
          manifestSummarySha256: scan.manifestSummarySha256,
        },
        null,
        2,
      )}\n`,
    );
    if (!scan.ok) {
      for (const finding of scan.findings) {
        state.problems.push(`构建扫描 finding（${finding.kind}）：${finding.file} ${finding.detail}`);
      }
    }
    if (scan.fileCount === 0) {
      state.problems.push('构建扫描未发现任何构建产物');
    }
  } else {
    state.problems.push('缺少干净快照，无法执行构建扫描');
  }

  /* ---- 运行独立性核验 ---- */
  const [run1, run2] = state.acceptRuns;
  let independence: P02CleanReplayIndependence = {
    distinctRunIds: false,
    distinctRunDirs: false,
    distinctTempRoots: false,
    noCrossRunIdReference: false,
    firstEvidenceUnchanged: false,
  };
  if (run1 !== undefined && run2 !== undefined) {
    const distinctRunIds = run1.runId !== run2.runId;
    const distinctRunDirs = run1.runDir !== run2.runDir;
    const distinctTempRoots = run1.tempRoot !== run2.tempRoot;
    const noCrossRunIdReference =
      !run2.text.includes(run1.runId) && !run1.text.includes(run2.runId);
    const runDirNow = treeDigestsUnder(run1.runDir);
    const exportNow = treeDigestsUnder(join(state.outDir, 'accept-runs', run1.stepId));
    const now = {
      ...prefixKeys(runDirNow, 'run-dir:'),
      ...prefixKeys(exportNow, 'export:'),
    };
    const firstEvidenceUnchanged =
      Object.keys(run1.treeDigests).length > 0 &&
      Object.keys(now).length === Object.keys(run1.treeDigests).length &&
      Object.entries(run1.treeDigests).every(([key, value]) => now[key] === value);
    independence = {
      distinctRunIds,
      distinctRunDirs,
      distinctTempRoots,
      noCrossRunIdReference,
      firstEvidenceUnchanged,
    };
    if (!distinctRunIds) state.problems.push('两次 accept:p02 run-id 相同');
    if (!distinctRunDirs) state.problems.push('两次 accept:p02 报告目录相同');
    if (!distinctTempRoots) state.problems.push('两次 accept:p02 临时资源相同');
    if (!noCrossRunIdReference) state.problems.push('两次运行输出互相引用对方 run-id');
    if (!firstEvidenceUnchanged) state.problems.push('第一份证据被第二次运行改动或覆盖');
    for (const run of state.acceptRuns) {
      if (!run.reportVerified) {
        state.problems.push(`${run.stepId} 报告重验未通过`);
      }
    }
  } else {
    state.problems.push('未取得两次独立的 accept:p02 运行');
  }

  /* ---- 组装结果（逻辑位置） ---- */
  const smokeState = state.smoke;
  const smoke: P02CleanReplaySmoke =
    smokeState === null
      ? emptySmoke()
      : {
          cwdLogical: sanitize(ctx, smokeState.cwd),
          homeLogical: sanitize(ctx, smokeState.home),
          dataRootLogical: sanitize(ctx, smokeState.dataRoot),
          repoLogical: sanitize(ctx, smokeState.repo),
          commands: smokeState.commands.map((command) => ({
            label: command.label,
            argv: command.argv.map((arg) => sanitize(ctx, arg)),
            cwd: sanitize(ctx, command.cwd),
            exitCode: command.exitCode,
            durationMs: command.durationMs,
            timedOut: command.timedOut,
          })),
          cliEntryLogical: sanitize(ctx, smokeState.cliEntry),
          listenAddress: smokeState.listenAddress,
          port: smokeState.port,
          startedOutcome: smokeState.startedOutcome,
          hostInstanceId: smokeState.hostInstanceId,
          statusInstanceId: smokeState.statusInstanceId,
          registrationStatus: smokeState.registrationStatus,
          projectId: smokeState.projectId,
          stopEvidence: smokeState.stopEvidence,
        };
  const acceptRuns: P02CleanReplayAcceptRun[] = state.acceptRuns.map((run) => ({
    stepId: run.stepId,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    runId: run.runId,
    conclusion: run.conclusion,
    counts: run.counts,
    checkStatuses: run.checkStatuses,
    runDirLogical: sanitize(ctx, run.runDir),
    reportVerified: run.reportVerified,
    reportProblems: [...run.reportProblems],
    evidenceDigests: run.evidenceDigests.map((digest) => ({ ...digest })),
    tempRootLogical: sanitize(ctx, run.tempRoot),
  }));

  writeEvidence(ctx, 'smoke.json', `${JSON.stringify(smoke, null, 2)}\n`);
  writeEvidence(
    ctx,
    'cleanup.json',
    `${JSON.stringify(
      {
        processesRemaining,
        discoveryFilesRemaining: discoveryRemaining.map((path) => sanitize(ctx, path)),
        sentinelsRemaining,
        sentinelStaticLeftovers: sentinelStaticLeftovers.map((path) => sanitize(ctx, path)),
        continuedWrites,
        observationWindowMs: OBSERVATION_WINDOW_MS,
      },
      null,
      2,
    )}\n`,
  );
  writeEvidence(ctx, 'independence.json', `${JSON.stringify(independence, null, 2)}\n`);

  /* ---- 删除本次持有的授权临时根（报告/摘要/摘要副本已在运行阶段先导出） ---- */
  let tempRootRemoved = false;
  if (state.tempRoot !== null) {
    try {
      assertSafeTempRoot(state.tempRoot, state.tempPrefix);
      rmSync(state.tempRoot, { recursive: true, force: true });
      tempRootRemoved = !existsSync(state.tempRoot);
      if (!tempRootRemoved) {
        state.problems.push('临时根删除后仍存在');
      }
      log(`p02-clean-replay: 已清理临时根 ${sanitize(ctx, state.tempRoot)}`);
    } catch (error) {
      state.problems.push(`临时根清理失败：${(error as Error).message}`);
    }
  } else {
    tempRootRemoved = true;
  }

  /* ---- 证据导出与泄漏扫描（含 outcome.json 本体；脱敏后写入） ---- */
  const leakPatterns: readonly (readonly [string, RegExp])[] = [
    ['个人用户目录', /(^|[\s"'=:(\[]|[^A-Za-z0-9])\/(?:Users|home)\/[A-Za-z0-9._-]+/],
    ['macOS 私有临时目录', /(^|[\s"'=:(\[]|[^A-Za-z0-9])\/private\/var\//],
    ['系统临时目录', /(^|[\s"'=:(\[]|[^A-Za-z0-9])\/var\/folders\//],
    ['Harness 路径', /shiploop-harness/],
    ['Nezha 仓库路径', /\/nezha\//i],
  ];
  const scanEvidence = (): string[] => {
    const hits: string[] = [];
    for (const relPath of evidenceFileList(ctx)) {
      const text = readFileSync(join(state.outDir, ...relPath.split('/')), 'utf-8');
      for (const [label, pattern] of leakPatterns) {
        if (pattern.test(text)) {
          hits.push(`${relPath}:${label}`);
        }
      }
    }
    return hits;
  };
  const buildOutcome = (leakHits: readonly string[]): P02CleanReplayOutcome => ({
    ok: state.problems.length === 0,
    problems: [...state.problems],
    commit: state.commit,
    branch: state.branch,
    steps: state.steps.map((step) => ({ ...step, npmArgs: [...step.npmArgs] })),
    smoke,
    acceptRuns,
    independence,
    cleanup: {
      processesRemaining,
      discoveryFilesRemaining: discoveryRemaining.map((path) => sanitize(ctx, path)),
      sentinelsRemaining,
      sentinelStaticLeftovers: sentinelStaticLeftovers.map((path) => sanitize(ctx, path)),
      continuedWrites,
      observationWindowMs: OBSERVATION_WINDOW_MS,
      tempRootRemoved,
    },
    evidencePaths: evidenceFileList(ctx),
    evidenceLeakHits: [...leakHits],
    buildScan,
  });

  writeEvidence(ctx, 'outcome.json', `${JSON.stringify(buildOutcome([]), null, 2)}\n`);
  const evidenceLeakHits = scanEvidence();
  if (evidenceLeakHits.length > 0) {
    state.problems.push(`证据含未脱敏路径/依赖：${evidenceLeakHits.slice(0, 5).join(', ')}`);
  }
  const finalOutcome = buildOutcome(evidenceLeakHits);
  writeEvidence(ctx, 'outcome.json', `${JSON.stringify(finalOutcome, null, 2)}\n`);
  rmSync(statePath(ctx), { force: true });
  return finalOutcome;
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 进程内执行完整干净快照连续复跑（不抛错：失败以 problems/ok 表达）。 */
export async function runP02CleanReplay(
  options: P02CleanReplayOptions,
): Promise<P02CleanReplayOutcome> {
  const ctx = createContext(options);
  try {
    await phasePrepare(ctx);
    if (ctx.state.problems.length === 0) {
      await phaseAccept(ctx, 1);
    }
    if (ctx.state.problems.length === 0) {
      await phaseAccept(ctx, 2);
    }
    return await phaseFinalize(ctx);
  } catch (error) {
    ctx.state.problems.push(`复跑异常中断：${(error as Error).message}`);
    killTrackedProcessGroups();
    ctx.log(`p02-clean-replay: FAIL ${(error as Error).message}`);
    try {
      return await phaseFinalize(ctx);
    } catch (finalizeError) {
      ctx.state.problems.push(`收尾异常：${(finalizeError as Error).message}`);
      return {
        ok: false,
        problems: [...ctx.state.problems],
        commit: ctx.state.commit,
        branch: ctx.state.branch,
        steps: ctx.state.steps.map((step) => ({ ...step, npmArgs: [...step.npmArgs] })),
        smoke: emptySmoke(),
        acceptRuns: [],
        independence: {
          distinctRunIds: false,
          distinctRunDirs: false,
          distinctTempRoots: false,
          noCrossRunIdReference: false,
          firstEvidenceUnchanged: false,
        },
        cleanup: {
          processesRemaining: [],
          discoveryFilesRemaining: [],
          sentinelsRemaining: [],
          sentinelStaticLeftovers: [],
          continuedWrites: [],
          observationWindowMs: OBSERVATION_WINDOW_MS,
          tempRootRemoved: false,
        },
        evidencePaths: [],
        evidenceLeakHits: [],
        buildScan: { ok: false, findings: [], fileCount: 0 },
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * CLI（分阶段续跑，供长验收按阶段拆分调用）
 * ------------------------------------------------------------------ */

function printUsage(): void {
  process.stdout.write(
    'usage: node scripts/acceptance/p02-clean-replay.ts [--root <dir>] [--phase <phase>]\n' +
      '  --root <dir>    受测仓库根（默认：本脚本所在仓库；要求工作树 clean 且已提交）\n' +
      '  --phase <phase> prepare | accept-1 | accept-2 | finalize | all（默认 all）\n' +
      `  证据输出目录固定为 ${P02_CLEAN_REPLAY_OUT_DIR}（相对仓库根）。\n`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  let root = resolve(scriptDir, '..', '..');
  let phase = 'all';
  const rest = argv.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--root' && index + 1 < rest.length) {
      root = resolve(rest[index + 1] as string);
      index += 1;
    } else if (arg === '--phase' && index + 1 < rest.length) {
      phase = rest[index + 1] as string;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return 0;
    } else {
      process.stderr.write(`p02-clean-replay: unknown argument "${arg}"\n`);
      printUsage();
      return 2;
    }
  }
  const phases = new Set(['prepare', 'accept-1', 'accept-2', 'finalize', 'all']);
  if (!phases.has(phase)) {
    process.stderr.write(`p02-clean-replay: unknown phase "${phase}"\n`);
    printUsage();
    return 2;
  }

  try {
    if (phase === 'all') {
      const outcome = await runP02CleanReplay({ root });
      process.stdout.write(
        `p02-clean-replay: ${outcome.ok ? 'PASS' : 'FAIL'} commit=${outcome.commit} ` +
          `steps=${outcome.steps.length} runs=${outcome.acceptRuns.length} problems=${outcome.problems.length}\n`,
      );
      for (const problem of outcome.problems) {
        process.stdout.write(`p02-clean-replay: PROBLEM ${problem}\n`);
      }
      return outcome.ok ? 0 : 1;
    }
    const ctx = phase === 'prepare' ? createContext({ root }) : loadContext({ root });
    if (phase === 'prepare') {
      await phasePrepare(ctx);
    } else if (phase === 'accept-1') {
      await phaseAccept(ctx, 1);
    } else if (phase === 'accept-2') {
      await phaseAccept(ctx, 2);
    }
    if (phase !== 'finalize') {
      saveState(ctx);
      for (const problem of ctx.state.problems) {
        process.stdout.write(`p02-clean-replay: PROBLEM ${problem}\n`);
      }
      const failed = ctx.state.problems.length > 0;
      process.stdout.write(`p02-clean-replay: ${failed ? 'FAIL' : 'OK'} phase=${phase}\n`);
      return failed ? 1 : 0;
    }
    const outcome = await phaseFinalize(ctx);
    process.stdout.write(
      `p02-clean-replay: ${outcome.ok ? 'PASS' : 'FAIL'} commit=${outcome.commit} ` +
        `steps=${outcome.steps.length} runs=${outcome.acceptRuns.length} problems=${outcome.problems.length}\n`,
    );
    for (const problem of outcome.problems) {
      process.stdout.write(`p02-clean-replay: PROBLEM ${problem}\n`);
    }
    return outcome.ok ? 0 : 1;
  } catch (error) {
    killTrackedProcessGroups();
    process.stderr.write(`p02-clean-replay: FAIL ${(error as Error).message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`p02-clean-replay: FAIL unexpected error: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
