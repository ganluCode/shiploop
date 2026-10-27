/**
 * P05 阶段入口：普通 Task 测试只注入 runProcess，不执行本阶段门禁。步骤器、报告聚合器和报告脱敏分别复用同一套验收工具边界；离线命令退出 0 也不签署 Phase 通过。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadP05AcceptanceConfig, loadP05Checklist, validateP05AcceptanceConfig,
  P05_ACCEPT_CONFIG_PATH, P05_ACCEPT_MAX_TIMEOUT_MS, P05_ACCEPT_MIN_TIMEOUT_MS,
  type P05AcceptanceConfig,
  type P05Checklist,
} from './p05-config.ts';
import { assertValidRunId, generateP05RunId, verifyP05ReportDirectory } from './p05-report.ts';
import { aggregateP05IntegrationReport, loadP05StepRunEvidence } from './p05-integration-report.ts';
import type { P05IntegrationCheckBinding } from './p05-integration-report.ts';
import { runP05StepSequence, type P05StepRecord, type P05StepSpec } from './p05-steps.ts';
import { runBoundedProcess } from './p02-accept.ts';
import { selectP05TestScope } from './p05-test-scope.ts';
import { loadP05ProductCapture } from './p05-product-evidence.ts';

export const P05_ACCEPT_USAGE = 'usage: accept:p05 [--run-id <id>] [--report-dir <root>] ' +
  '[--expected-commit <sha>] [--step-timeout-ms <ms>] [--overall-timeout-ms <ms>] [--full-regression] [--observe] [--help]';
const ENTRY_PATH = 'acceptance/p05.entry.json';
const ENTRY = {
  schemaVersion: 1,
  phase: 'P05',
  stepOrder: ['p05-trusted-index', 'p05-affected-regression', 'p05-cross-layer-smoke', 'p05-manual-gate'],
  trustedIndexRoot: 'test/index/phases/P05/features',
  requiredFeatures: ['P05-1', 'P05-2', 'P05-3', 'P05-4', 'P05-5', 'P05-6', 'P05-7', 'P05-8', 'P05-9'],
  defaultExecution: { mode: 'offline', network: 'denied', llmCalls: false, fullRegression: false },
  explicitOptions: { fullRegression: '--full-regression', live: '--live-authorized', manual: '--manual-record' },
  evidence: {
    requiredFields: ['scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'evidenceRefs', 'usageSource', 'cleanup'],
    statuses: ['pass', 'fail', 'not_run'],
    notRunCountsAsPassed: false,
  },
};
const P05_PHASE_SCENARIO_FILES = Object.freeze([
  'test/modules/acceptance/p05-10-f002-fixture.test.ts',
  'test/modules/acceptance/p05-10-f003-normal-flow.test.ts',
  'test/modules/acceptance/p05-10-f004-fault-matrix.test.ts',
  'test/modules/acceptance/p05-10-f005-git-integration.test.ts',
  'test/modules/acceptance/p05-10-f006-combined-faults.test.ts',
  'test/modules/acceptance/p05-10-f007-phase-entry.test.ts',
  'test/modules/acceptance/p05-10-f008-closeout.test.ts',
  'test/modules/acceptance/p05-10-f009-closeout.test.ts',
] as const);
const TASK_INDEX_PATTERN = /^F-\d{3}\.json$/;
const TASK_ID_PATTERN = /^F-\d{3}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function fail(text: string): never { throw new Error(`accept:p05: ${text}`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
/** Only this invocation's two output directories may create untracked files. */
function sourceChanges(status: string, repoRoot: string, ownedOutputs: readonly string[]): string {
  if (!status.trim()) return '';
  const owned = ownedOutputs.map(path => relative(repoRoot, path).replaceAll('\\', '/'))
    .filter(path => path && path !== '.' && path !== '..' && !path.startsWith('../') && !isAbsolute(path));
  return status.split(/\r?\n/).filter(line => line.trim()).filter(line => {
    const match = /^\?\? (.+)$/.exec(line);
    let file = match?.[1];
    if (file?.startsWith('"')) {
      try { file = JSON.parse(file) as string; } catch { return true; }
    }
    return file === undefined || !owned.some(path => file === path || file.startsWith(`${path}/`));
  }).join('\n');
}
function budget(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < P05_ACCEPT_MIN_TIMEOUT_MS || value > P05_ACCEPT_MAX_TIMEOUT_MS) fail(`${label} 必须是有限毫秒预算`);
  return value;
}
/** 拒绝符号链接目录（包括祖先），以免报告和清理越过声明目录。 */
function assertNoSymlink(path: string): void {
  let cursor = resolve(path);
  for (;;) {
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (stat?.isSymbolicLink()) fail(`拒绝符号链接路径：${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function repoFile(repoRoot: string, path: string): string {
  const full = resolve(repoRoot, path);
  if (relative(repoRoot, full).startsWith('..')) fail(`入口越界：${path}`);
  if (!existsSync(full) || !lstatSync(full).isFile() || realpathSync(full) !== full) fail(`入口缺失或符号链接：${path}`);
  return full;
}
function repoDir(repoRoot: string, path: string): string {
  const full = resolve(repoRoot, path);
  if (relative(repoRoot, full).startsWith('..')) fail(`入口越界：${path}`);
  if (!existsSync(full) || !lstatSync(full).isDirectory()) fail(`入口目录缺失：${path}`);
  assertNoSymlink(full);
  return full;
}

export interface P05AcceptanceOptions {
  readonly repoRoot: string;
  readonly config?: P05AcceptanceConfig;
  readonly runId?: string;
  readonly reportRoot?: string;
  readonly expectedCommit?: string;
  readonly stepTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly observe?: boolean;
  readonly fullRegression?: boolean;
  readonly runProcess?: typeof runBoundedProcess;
  /** 只读 Git/工具版本探测；控制器测试可注入，CLI 不暴露此入口。 */
  readonly exec?: (command: string, args: readonly string[]) => string;
  readonly log?: (text: string) => void;
}
export interface P05AcceptanceResult {
  readonly runId: string;
  readonly stepRunDir: string;
  readonly runDir: string | null;
  readonly exitCode: number;
  readonly reportWritten: boolean;
  readonly phaseAccepted: false;
  readonly steps: readonly P05StepRecord[];
  readonly problems: readonly string[];
}

export interface P05FeatureTestSelection {
  readonly feature: string;
  /** Feature 合集声明（P05-9 必需；其他历史 Feature 可缺）。 */
  readonly manifests: string[];
  /** 该 Feature 的 Task 索引（仓库相对路径）。 */
  readonly indexes: string[];
  /** 该 Feature 实际引用的测试文件（已去重、排序）。 */
  readonly files: string[];
}

export interface P05TrustedTestSelection {
  /** 全部 Feature 去重后的可信合集；默认执行范围另由影响策略选择。 */
  readonly files: string[];
  /** 参与身份摘要的索引/声明文件。 */
  readonly inputs: string[];
  readonly features: P05FeatureTestSelection[];
}

function assertFeatureManifest(
  repoRoot: string,
  featureRoot: string,
  feature: string,
  indexIds: readonly string[],
): string[] {
  const manifestPath = join(featureRoot, 'feature.json');
  if (!existsSync(manifestPath)) {
    fail(`缺少 Feature 索引声明：${feature}/feature.json`);
  }
  const file = relative(repoRoot, manifestPath);
  const raw = readJson(repoFile(repoRoot, file)) as {
    schema_version?: unknown; kind?: unknown; phase?: unknown; feature?: unknown;
    tasks?: { task_id?: unknown; index?: unknown }[];
  };
  if (raw.schema_version !== 1 || raw.kind !== 'feature' || raw.phase !== 'P05' || raw.feature !== feature) {
    fail(`无效 Feature 索引声明：${file}`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) fail(`Feature 索引声明缺少 Task：${file}`);
  const declared: string[] = [];
  for (const task of raw.tasks) {
    const taskId = task?.task_id;
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) fail(`Feature 索引 Task ID 非法：${file}`);
    const expected = `${ENTRY.trustedIndexRoot}/${feature}/tasks/${taskId}.json`;
    if (task.index !== expected) fail(`Feature 索引位置非法：${file} -> ${String(task.index)}`);
    if (declared.includes(taskId)) fail(`Feature 索引含重复 Task：${file} -> ${taskId}`);
    declared.push(taskId);
  }
  if (canonical([...declared].sort()) !== canonical([...indexIds].sort())) {
    fail(`Feature 索引与 Task 索引不一致（缺失或多余）：${file}`);
  }
  return [file];
}

/** P05-10 阶段场景是独立的显式覆盖面，不混入 P05-1～P05-9 可信索引合集。 */
export function collectP05PhaseScenarioTests(repoRoot: string): string[] {
  for (const file of P05_PHASE_SCENARIO_FILES) repoFile(repoRoot, file);
  return [...P05_PHASE_SCENARIO_FILES];
}

/**
 * 发现并校验 Phase 可信测试索引合集：
 * - Feature 集合必须与冻结入口声明完全一致（缺 P05-9 或多出未登记 Feature 即失败）；
 * - 每个 Feature 的 Task 索引必须是 v2、项目 shiploop、显式 `all`/`cases`、路径在
 *   `test/modules` 下的 `.test.(ts|js)` 且真实存在；
 * - P05-9 必须有 feature.json 并逐项对应磁盘上的 Task 索引；
 * - 补充检查的 Task 映射必须引用 P05-9 已登记 Task，报告映射不能指向不存在的工作；
 * - 测试文件按路径去重后再交给 Phase 执行。
 */
export function collectP05TrustedTests(repoRoot: string): P05TrustedTestSelection {
  const featureRoot = repoDir(repoRoot, ENTRY.trustedIndexRoot);
  const discovered = readdirSync(featureRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'P05-10' && /^P05-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  if (canonical(discovered) !== canonical([...ENTRY.requiredFeatures].sort())) {
    fail(`阶段入口 Feature 集合不匹配：期望 ${ENTRY.requiredFeatures.join(',')}，发现 ${discovered.join(',') || '<empty>'}`);
  }
  const files = new Set<string>();
  const inputs: string[] = [];
  const features: P05FeatureTestSelection[] = [];
  for (const feature of ENTRY.requiredFeatures) {
    const directory = repoDir(repoRoot, `${ENTRY.trustedIndexRoot}/${feature}/tasks`);
    const indexes = readdirSync(directory).filter(name => TASK_INDEX_PATTERN.test(name)).sort();
    if (indexes.length === 0) fail(`空测试索引：${feature}`);
    const manifests = assertFeatureManifest(repoRoot, join(featureRoot, feature), feature, indexes.map(name => name.replace(/\.json$/, '')));
    inputs.push(...manifests);
    const featureFiles = new Set<string>();
    for (const name of indexes) {
      const file = relative(repoRoot, join(directory, name));
      const raw = readJson(repoFile(repoRoot, file)) as {
        schema_version?: unknown; task_id?: unknown;
        projects?: { id?: unknown; tests?: { file?: unknown; all?: unknown; cases?: unknown }[] }[];
      };
      if (raw.schema_version !== 2 || !Array.isArray(raw.projects) || raw.projects.length === 0) fail(`无效 v2 索引：${file}`);
      const expectedTaskId = name.replace(/\.json$/, '');
      if (raw.task_id !== undefined && raw.task_id !== expectedTaskId) fail(`索引 task_id 与文件名不一致：${file}`);
      inputs.push(file);
      for (const project of raw.projects) {
        if (project.id !== 'shiploop' || !Array.isArray(project.tests) || project.tests.length === 0) fail(`无效项目或空测试索引：${file}`);
        for (const test of project.tests) {
          if (typeof test.file !== 'string' || !/^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(?:ts|js)$/.test(test.file) || test.file.split('/').includes('..')) fail(`无效测试路径：${file}`);
          if (test.all !== true && (!Array.isArray(test.cases) || test.cases.length === 0 || !test.cases.every(id => typeof id === 'string' && id.length > 0))) fail(`缺少显式测试选择：${file}`);
          repoFile(repoRoot, test.file);
          // Phase 独立执行完整文件；Task 的 case 选择不削减阶段集成范围。
          featureFiles.add(test.file);
          files.add(test.file);
        }
      }
    }
    features.push({ feature, manifests,
      indexes: indexes.map(name => `${ENTRY.trustedIndexRoot}/${feature}/tasks/${name}`),
      files: [...featureFiles].sort() });
  }
  if (files.size === 0) fail('空测试选择不得退化为全仓测试');
  return { files: [...files].sort(), inputs, features };
}

function offlineBindings(checklist: P05Checklist, steps: readonly string[]): P05IntegrationCheckBinding[] {
  return checklist.items
    .filter(item => item.execution === 'offline')
    .map(item => ({ checkId: item.id, stepIds: steps }));
}

function isolatedEnv(resources: string, repoRoot: string, timeoutMs: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    HOME: join(resources, 'home'), TMPDIR: join(resources, 'tmp'),
    XDG_CONFIG_HOME: join(resources, 'config'), XDG_CACHE_HOME: join(resources, 'cache'),
    PI_CODING_AGENT_DIR: join(resources, 'pi'), npm_config_cache: join(resources, 'npm-cache'),
    npm_config_userconfig: join(resources, 'npm-user.conf'), npm_config_globalconfig: join(resources, 'npm-global.conf'),
    npm_config_prefix: repoRoot, npm_config_offline: 'true', NO_COLOR: '1',
    SHIPLOOP_FAKE_PROVIDER: 'fake-provider', SHIPLOOP_FAKE_MODEL: 'fake-model',
    SHIPLOOP_TEST_RUN_TIMEOUT_MS: String(timeoutMs),
  });
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PI_CODING_AGENT_DIR', 'npm_config_cache']) mkdirSync(env[key]!, { recursive: true });
  writeFileSync(env.npm_config_userconfig!, '');
  writeFileSync(env.npm_config_globalconfig!, '');
  return env;
}

/** 一次显式运行；observe 仅核验证据和报告，绝不调用步骤执行器。 */
export async function runP05Acceptance(options: P05AcceptanceOptions): Promise<P05AcceptanceResult> {
  const started = Date.now();
  const repoRoot = realpathSync(options.repoRoot);
  const config = validateP05AcceptanceConfig(options.config ?? loadP05AcceptanceConfig(join(repoRoot, P05_ACCEPT_CONFIG_PATH)));
  const checklist = loadP05Checklist(repoFile(repoRoot, config.checklist));
  if (canonical(readJson(repoFile(repoRoot, ENTRY_PATH))) !== canonical(ENTRY)) fail('阶段步骤配置无效或与冻结接口不匹配');
  const manifest = readJson(repoFile(repoRoot, 'package.json')) as { scripts?: Record<string, string> };
  if (manifest.scripts?.verify !== 'node scripts/verify.ts' || manifest.scripts?.test !== 'node scripts/run-tests.ts' || manifest.scripts?.['accept:p05'] !== 'node scripts/acceptance/p05-accept.ts') fail('工程门禁/阶段入口接口不匹配');
  for (const script of ['verify', 'test', 'typecheck', 'build']) {
    const command = manifest.scripts?.[script];
    if (!command || /accept:p05|p05-accept\.ts/.test(command)) fail(`门禁缺失或递归：${script}`);
  }
  const stepTimeoutMs = budget(options.stepTimeoutMs ?? config.timeouts.stepMs, 'step-timeout-ms');
  const overallTimeoutMs = budget(options.overallTimeoutMs ?? config.timeouts.overallMs, 'overall-timeout-ms');
  if (overallTimeoutMs < stepTimeoutMs) fail('总预算不得小于单步预算');
  if (options.observe && !options.runId) fail('--observe 必须指定 --run-id');
  const runId = assertValidRunId(options.runId ?? generateP05RunId(new Date()));
  let reportRoot = resolve(repoRoot, options.reportRoot ?? config.reportRoot);
  // macOS 的 /var、/tmp 是系统别名；先固定声明根的真实位置，再保护其子目录。
  if (existsSync(reportRoot) && lstatSync(reportRoot).isSymbolicLink()) fail('报告根不能是符号链接');
  const suffix: string[] = [];
  let ancestor = reportRoot;
  while (!existsSync(ancestor)) { suffix.unshift(relative(dirname(ancestor), ancestor)); ancestor = dirname(ancestor); }
  reportRoot = join(realpathSync(ancestor), ...suffix);
  assertNoSymlink(reportRoot);
  const workDir = join(reportRoot, 'runs', runId);
  const stepRunDir = join(workDir, 'step-run');
  const reportDir = join(reportRoot, 'reports', runId);
  assertNoSymlink(workDir);
  assertNoSymlink(reportDir);
  const probeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|npm_|npm_config_|NPM_CONFIG_)/i.test(key) && key !== 'NODE_OPTIONS' && key !== 'INIT_CWD'));
  const exec = options.exec ?? ((command: string, args: readonly string[]) => execFileSync(command === 'node' ? process.execPath : command,
    [...args], { cwd: repoRoot, env: probeEnv, encoding: 'utf8', timeout: 10_000 }).trim());
  const commit = exec('git', ['rev-parse', 'HEAD']);
  if (!HEX40.test(commit)) fail('无法核验代码 commit');
  if (options.expectedCommit !== undefined && options.expectedCommit !== commit) fail('前置 commit 不匹配');
  // commit 身份不能冒充未提交的代码；测试可注入只读探测，不改变真实仓库。
  if (exec('git', ['status', '--porcelain']) !== '') fail('阶段受测代码必须已提交，工作树非空');
  if (exec('node', ['--version']).replace(/^v/, '') !== config.toolchain.node || exec('npm', ['--version']) !== config.toolchain.npm) fail('Node/npm 工具版本不匹配');
  const tests = collectP05TrustedTests(repoRoot);
  const phaseScenarioFiles = collectP05PhaseScenarioTests(repoRoot);
  const fullRegression = options.fullRegression === true;
  const scope = selectP05TestScope(tests.files, fullRegression);
  const productTest = 'test/modules/acceptance/p05-product-report.test.ts';
  const phaseEvidenceTest = 'test/modules/acceptance/p05-phase-evidence.test.ts';
  const contractFiles = [ENTRY_PATH, P05_ACCEPT_CONFIG_PATH, config.checklist, 'package.json', config.toolchain.lockfile,
    'scripts/acceptance/p05-accept.ts', 'scripts/acceptance/p05-steps.ts', 'scripts/acceptance/p05-integration-report.ts',
    'scripts/acceptance/p05-config.ts', 'scripts/acceptance/p05-report.ts', 'scripts/verify.ts', 'scripts/run-tests.ts',
    'scripts/acceptance/p05-test-scope.ts', 'scripts/acceptance/p05-product-evidence.ts', productTest, phaseEvidenceTest,
    ...tests.inputs, ...tests.files, ...phaseScenarioFiles];
  const inputsDigest = digest(canonical({ repoRoot, config, stepTimeoutMs, overallTimeoutMs, fullRegression, scope,
    files: contractFiles.map(file => [file, digest(readFileSync(repoFile(repoRoot, file)))]) }));
  const identity = { runId, commit, inputsDigest };
  const resultPath = join(workDir, 'entry-result.json');
  const sourceDrift = () => sourceChanges(exec('git', ['status', '--porcelain', '--untracked-files=all']),
    repoRoot, [workDir, reportDir]);
  const reportExec = (command: string, args: readonly string[]): string =>
    command === 'git' && args[0] === 'status' && args.includes('--porcelain') ? sourceDrift() : exec(command, args);

  if (options.observe) {
    const evidence = loadP05StepRunEvidence(stepRunDir);
    if (canonical(evidence.identity) !== canonical(identity)) fail('拒绝观察不匹配的 commit/资源输入');
    const recorded = readJson(resultPath) as { identity: unknown; result: P05AcceptanceResult; reportHash: string | null };
    if (canonical(recorded.identity) !== canonical(identity)) fail('入口结果身份不匹配');
    if (canonical(recorded.result.steps.map(({ fromVerifiedEvidence: _, ...record }) => record)) !== canonical(evidence.records.map(({ fromVerifiedEvidence: _, ...record }) => record))) fail('入口结果与步骤证据不匹配');
    if (recorded.result.reportWritten) {
      const verification = verifyP05ReportDirectory(reportDir, checklist);
      if (!verification.ok || digest(readFileSync(join(reportDir, 'report.json'))) !== recorded.reportHash) fail(`报告证据损坏：${verification.problems.join('; ')}`);
    }
    return { ...recorded.result, exitCode: 1, phaseAccepted: false };
  }

  // 报告已存在或运行目录非空均先拒绝；原子 mkdir 防止两个入口竞争同一运行。
  if (existsSync(workDir) || existsSync(reportDir)) fail('运行/报告目录已存在，拒绝复用旧成功；使用 --observe 只读核验');
  mkdirSync(dirname(workDir), { recursive: true });
  mkdirSync(workDir);
  options.log?.(`accept:p05: run-id=${runId} step-run=${stepRunDir} report=${reportDir}`);
  const resources = join(workDir, 'resources');
  const env = isolatedEnv(resources, repoRoot, stepTimeoutMs);
  const productDir = join(resources, 'product-reports');
  mkdirSync(productDir, { recursive: true });
  const scenarioDir = join(workDir, 'scenario-evidence');
  mkdirSync(scenarioDir, { recursive: true });
  const scopeContent = JSON.stringify({ identity, ...scope }, null, 2) + '\n';
  writeFileSync(join(workDir, 'test-scope.json'), scopeContent, { flag: 'wx' });
  const stepFiles = {
    'p05-trusted-index': scope.selected,
    // P05-10 的阶段场景是显式覆盖面；此前这里筛选 tests.files 中的 P05 文件，
    // 导致它们在第二步被重复执行。
    'p05-affected-regression': phaseScenarioFiles,
    'p05-cross-layer-smoke': ['test/modules/acceptance/p05-acceptance-contract.test.ts', productTest, phaseEvidenceTest],
    'p05-manual-gate': [],
  } as const;
  const steps: P05StepSpec[] = ENTRY.stepOrder.map(id => {
    const useFullRegression = fullRegression && id === 'p05-affected-regression';
    return {
      id,
      command: useFullRegression ? 'npm' : process.execPath,
      cwd: repoRoot,
      args: useFullRegression
        ? ['test']
        : id === 'p05-manual-gate'
          ? ['-e', 'process.exit(0)']
          : ['scripts/run-tests.ts', ...(stepFiles[id as keyof typeof stepFiles] ?? [])],
    };
  });
  const sanitize = (text: string): string => text.replaceAll(process.execPath, '<node>').replaceAll(repoRoot, '<repo>').replaceAll(reportRoot, '<reports>')
    .replaceAll(homedir(), '<home>').replace(/\bBearer\s+\S+/gi, '[REDACTED:bearer]');
  const sequence = await runP05StepSequence(steps, {
    evidenceDir: stepRunDir, identity, stepTimeoutMs, overallTimeoutMs,
    maxOutputBytes: config.maxCommandOutputBytes, env, redact: sanitize, log: options.log,
    runProcess: async (command, args, processOptions) => {
      if (exec('git', ['rev-parse', 'HEAD']) !== commit || sourceDrift() !== '') fail('受测代码在步骤间变化');
      const remaining = overallTimeoutMs - (Date.now() - started);
      if (remaining <= 0) fail('阶段总预算耗尽');
      // Only the dedicated exporter receives the run-bound output destination.
      const productEnv = args.includes(productTest) || args.includes(phaseEvidenceTest) ? {
        ...processOptions.env, SHIPLOOP_P05_PRODUCT_REPORT_DIR: productDir,
        SHIPLOOP_P05_REPORT_IDENTITY: JSON.stringify(identity),
        SHIPLOOP_P05_SCENARIO_ROOT: scenarioDir,
      } : processOptions.env;
      return (options.runProcess ?? runBoundedProcess)(command, args, { ...processOptions, env: productEnv,
        timeoutMs: Math.min(processOptions.timeoutMs, remaining) });
    },
  });
  const problems = [...sequence.problems];
  const productReports: { featureId: string; label: string; command: string; content: string }[] = [];
  try {
    const smoke = sequence.steps.find(step => step.stepId === 'p05-cross-layer-smoke');
    if (smoke?.status !== 'pass') throw new Error('产品报告导出步骤未通过');
    const captured = loadP05ProductCapture(join(productDir, 'feature-report.json'), identity);
    productReports.push({ ...captured, label: 'Core/Host 临时项目排队状态报告（离线，不代表真实模型执行完成）',
      command: `node scripts/run-tests.ts test/modules/acceptance/p05-acceptance-contract.test.ts ${productTest}` });
  } catch (error) { problems.push(`产品报告证据缺失或无效：${message(error)}`); }
  const scenarioBindings = checklist.items
    .filter(item => item.execution === 'offline')
    .map(item => ({
      checkId: item.id,
      scenarios: item.evidence.map(category => ({ file: `phase-evidence-${category}.json`, category, scenarioIds: [...item.scenarioIds] })),
    }));
  let cleaned = false;
  if (sequence.stopConfirmed) {
    try { rmSync(resources, { recursive: true }); cleaned = !existsSync(resources); }
    catch (error) { problems.push(`资源清理失败：${message(error)}`); }
  }
  let drift = false;
  try { drift = exec('git', ['rev-parse', 'HEAD']) !== commit || sourceDrift() !== ''; }
  catch { drift = true; }
  if (drift) problems.push('受测 commit/工作树在执行期间变化');
  const aggregation = aggregateP05IntegrationReport({
    repoRoot, config, checklist, runId, reportRoot: join(reportRoot, 'reports'), stepRunDir, exec: reportExec,
    cleanup: { confirmed: cleaned, processesGone: sequence.stopConfirmed, notes: ['仅回收本次入口创建的 resources；停止不确定保留现场。'] },
    bindings: offlineBindings(checklist, ENTRY.stepOrder.filter(id => id !== 'p05-manual-gate')).map(binding => ({
      ...binding, ...(scenarioBindings.find(item => item.checkId === binding.checkId) ?? {}),
      extraEvidence: [{ name: 'test-scope.json', category: 'report' as const, content: scopeContent }],
    })),
    scenarioRoot: scenarioDir,
    productReports,
    knownLimitations: [
      fullRegression
        ? '已显式请求全仓历史回归；其结果仍不能替代 live 和负责人确认。'
        : `默认阶段范围：可信索引中 ${scope.selected.length} 个 P05/必要底层测试文件；${scope.deferred.length} 个历史文件 not_run，详见 test-scope.json。`,
      '产品报告来自临时项目真实 Core/Host 查询，状态为 queued；仅证明查询与报告导出链路，不替代 Runtime 执行完成证据。',
      'live not_run、人工 pending，不签署 P05 Phase 通过。',
    ],
    openIssues: drift ? [{ id: 'P05-CODE-DRIFT', summary: '受测代码身份变化', blocking: true }] : [],
    sensitiveValues: [resources], log: options.log,
  });
  problems.push(...aggregation.problems, ...(aggregation.written?.problems ?? []));
  if (Date.now() - started > overallTimeoutMs) problems.push('阶段总预算耗尽（包括准备与报告时间）');
  const result: P05AcceptanceResult = { runId, stepRunDir, runDir: aggregation.written?.runDir ?? null,
    // 沿用阶段聚合器的 fail-closed 语义；离线命令全绿不能覆盖 live/manual pending。
    exitCode: aggregation.exitCode === 0 && sequence.exitCode === 0 && !drift && problems.length === 0 ? 0 : 1,
    reportWritten: aggregation.reportWritten, phaseAccepted: false, steps: sequence.steps, problems };
  const content = JSON.stringify({ identity, result, reportHash: aggregation.written === null ? null : digest(readFileSync(aggregation.written.reportPath)) }, null, 2) + '\n';
  writeFileSync(resultPath, content, { flag: 'wx' });
  if (readFileSync(resultPath, 'utf8') !== content) fail('入口结果写回失败');
  return result;
}

export function resolveP05Args(argv: readonly string[]): Omit<P05AcceptanceOptions, 'repoRoot'> & { help?: boolean } {
  const result: { runId?: string; reportRoot?: string; expectedCommit?: string; stepTimeoutMs?: number; overallTimeoutMs?: number; observe?: boolean; fullRegression?: boolean; help?: boolean } = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (seen.has(arg)) fail(`重复参数：${arg}`);
    seen.add(arg);
    if (arg === '--help') { result.help = true; continue; }
    if (arg === '--observe') { result.observe = true; continue; }
    if (arg === '--full-regression') { result.fullRegression = true; continue; }
    if (!['--run-id', '--report-dir', '--expected-commit', '--step-timeout-ms', '--overall-timeout-ms'].includes(arg)) fail(`未知参数：${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--') || value.includes('\0')) fail(`参数缺少值：${arg}`);
    if (arg === '--run-id') result.runId = assertValidRunId(value);
    else if (arg === '--report-dir') result.reportRoot = value;
    else if (arg === '--expected-commit') { if (!HEX40.test(value)) fail('expected-commit 必须是完整 SHA'); result.expectedCommit = value; }
    else {
      if (!/^[1-9]\d*$/.test(value)) fail('超时参数必须是正整数');
      const ms = budget(Number(value), arg);
      if (arg === '--step-timeout-ms') result.stepTimeoutMs = ms;
      else result.overallTimeoutMs = ms;
    }
  }
  if (result.observe && !result.runId) fail('--observe 必须指定 --run-id');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = resolveP05Args(process.argv.slice(2));
    if (invocation.help) process.stdout.write(`${P05_ACCEPT_USAGE}\n`);
    else {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      await runP05Acceptance({ repoRoot, ...invocation, log: text => process.stdout.write(`${text}\n`) }).then(result => {
        process.stdout.write(`accept:p05: report=${result.runDir ?? 'not_written'} Phase=pending/not_run exit=${result.exitCode}\n`);
        for (const problem of result.problems) process.stderr.write(`accept:p05: ${problem}\n`);
        process.exitCode = result.exitCode;
      });
    }
  } catch (error) { process.stderr.write(`${message(error)}\n`); process.exitCode = 1; }
}
