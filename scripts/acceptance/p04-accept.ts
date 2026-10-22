/**
 * P04-8 F-008: 人工独立执行的阶段入口。普通 Task 测试只注入 runProcess，
 * 不执行本阶段门禁。复用 F-003 顺序步骤器和 F-007 报告聚合器。
 * 离线命令退出 0 也不签署 Phase 通过；live/manual 仍由独立证据放行。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadP04AcceptanceConfig, loadP04Checklist, validateP04AcceptanceConfig,
  P04_ACCEPT_CONFIG_PATH, P04_ACCEPT_MAX_TIMEOUT_MS, P04_ACCEPT_MIN_TIMEOUT_MS,
  type P04AcceptanceConfig,
} from './p04-config.ts';
import { assertValidRunId, generateP04RunId, verifyP04ReportDirectory } from './p04-report.ts';
import { aggregateP04IntegrationReport, loadP04StepRunEvidence } from './p04-integration-report.ts';
import { runP04StepSequence, type P04StepRecord, type P04StepSpec } from './p04-steps.ts';
import { runBoundedProcess } from './p02-accept.ts';

export const P04_ACCEPT_USAGE = 'usage: accept:p04 [--run-id <id>] [--report-dir <root>] ' +
  '[--expected-commit <sha>] [--step-timeout-ms <ms>] [--overall-timeout-ms <ms>] [--observe] [--help]';
const ENTRY_PATH = 'acceptance/p04.entry.json';
const ENTRY = {
  schemaVersion: 1,
  stepOrder: ['engineering-gate', 'p04-integration'],
  testIndexRoot: 'test/index/phases/P04/features',
  engineeringGate: ['scripts/verify.ts', '--step-timeout-ms', '{stepMs}'],
  integrationRunner: 'scripts/run-tests.ts',
};
const HEX40 = /^[0-9a-f]{40}$/;
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function fail(text: string): never { throw new Error(`accept:p04: ${text}`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
function budget(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < P04_ACCEPT_MIN_TIMEOUT_MS || value > P04_ACCEPT_MAX_TIMEOUT_MS) fail(`${label} 必须是有限毫秒预算`);
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

export interface P04AcceptanceOptions {
  readonly repoRoot: string;
  readonly config?: P04AcceptanceConfig;
  readonly runId?: string;
  readonly reportRoot?: string;
  readonly expectedCommit?: string;
  readonly stepTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly observe?: boolean;
  readonly runProcess?: typeof runBoundedProcess;
  /** 只读 Git/工具版本探测；控制器测试可注入，CLI 不暴露此入口。 */
  readonly exec?: (command: string, args: readonly string[]) => string;
  readonly log?: (text: string) => void;
}
export interface P04AcceptanceResult {
  readonly runId: string;
  readonly stepRunDir: string;
  readonly runDir: string | null;
  readonly exitCode: number;
  readonly reportWritten: boolean;
  readonly phaseAccepted: false;
  readonly steps: readonly P04StepRecord[];
  readonly problems: readonly string[];
}

function collectTests(repoRoot: string): { files: string[]; inputs: string[] } {
  const files = new Set<string>();
  const inputs: string[] = [];
  for (let number = 1; number <= 8; number++) {
    const directory = join(repoRoot, ENTRY.testIndexRoot, `P04-${number}`, 'tasks');
    assertNoSymlink(directory);
    const indexes = readdirSync(directory).filter(name => /^F-\d+\.json$/.test(name)).sort();
    if (indexes.length === 0) fail(`空测试索引：P04-${number}`);
    for (const name of indexes) {
      const file = relative(repoRoot, join(directory, name));
      const raw = readJson(repoFile(repoRoot, file)) as { schema_version?: unknown; projects?: { id?: unknown; tests?: { file?: unknown; all?: unknown; cases?: unknown }[] }[] };
      if (raw.schema_version !== 2 || !Array.isArray(raw.projects) || raw.projects.length === 0) fail(`无效 v2 索引：${file}`);
      inputs.push(file);
      for (const project of raw.projects) {
        if (project.id !== 'shiploop' || !Array.isArray(project.tests) || project.tests.length === 0) fail(`无效项目或空测试索引：${file}`);
        for (const test of project.tests) {
          if (typeof test.file !== 'string' || !/^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(?:ts|js)$/.test(test.file) || test.file.split('/').includes('..')) fail(`无效测试路径：${file}`);
          if (test.all !== true && (!Array.isArray(test.cases) || test.cases.length === 0 || !test.cases.every(id => typeof id === 'string' && id.length > 0))) fail(`缺少显式测试选择：${file}`);
          repoFile(repoRoot, test.file);
          // Phase 独立执行完整文件；Task 的 case 选择不削减阶段集成范围。
          files.add(test.file);
        }
      }
    }
  }
  if (files.size === 0) fail('空测试选择不得退化为全仓测试');
  return { files: [...files].sort(), inputs };
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
export async function runP04Acceptance(options: P04AcceptanceOptions): Promise<P04AcceptanceResult> {
  const started = Date.now();
  const repoRoot = realpathSync(options.repoRoot);
  const config = validateP04AcceptanceConfig(options.config ?? loadP04AcceptanceConfig(join(repoRoot, P04_ACCEPT_CONFIG_PATH)));
  const checklist = loadP04Checklist(repoFile(repoRoot, config.checklist));
  if (canonical(readJson(repoFile(repoRoot, ENTRY_PATH))) !== canonical(ENTRY)) fail('阶段步骤配置无效或与冻结接口不匹配');
  const manifest = readJson(repoFile(repoRoot, 'package.json')) as { scripts?: Record<string, string> };
  if (manifest.scripts?.verify !== 'node scripts/verify.ts' || manifest.scripts?.test !== 'node scripts/run-tests.ts' || manifest.scripts?.['accept:p04'] !== 'node scripts/acceptance/p04-accept.ts') fail('工程门禁/阶段入口接口不匹配');
  for (const script of ['verify', 'test', 'typecheck', 'build']) {
    const command = manifest.scripts?.[script];
    if (!command || /accept:p04|p04-accept\.ts/.test(command)) fail(`门禁缺失或递归：${script}`);
  }
  const stepTimeoutMs = budget(options.stepTimeoutMs ?? config.timeouts.stepMs, 'step-timeout-ms');
  const overallTimeoutMs = budget(options.overallTimeoutMs ?? config.timeouts.overallMs, 'overall-timeout-ms');
  if (overallTimeoutMs < stepTimeoutMs) fail('总预算不得小于单步预算');
  if (options.observe && !options.runId) fail('--observe 必须指定 --run-id');
  const runId = assertValidRunId(options.runId ?? generateP04RunId(new Date()));
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
  const tests = collectTests(repoRoot);
  const contractFiles = [ENTRY_PATH, P04_ACCEPT_CONFIG_PATH, config.checklist, 'package.json', config.toolchain.lockfile,
    'scripts/acceptance/p04-accept.ts', 'scripts/acceptance/p04-steps.ts', 'scripts/acceptance/p04-integration-report.ts',
    'scripts/acceptance/p04-config.ts', 'scripts/acceptance/p04-report.ts', 'scripts/verify.ts', ENTRY.integrationRunner,
    ...tests.inputs, ...tests.files];
  const inputsDigest = digest(canonical({ repoRoot, config, stepTimeoutMs, overallTimeoutMs,
    files: contractFiles.map(file => [file, digest(readFileSync(repoFile(repoRoot, file)))]) }));
  const identity = { runId, commit, inputsDigest };
  const resultPath = join(workDir, 'entry-result.json');

  if (options.observe) {
    const evidence = loadP04StepRunEvidence(stepRunDir);
    if (canonical(evidence.identity) !== canonical(identity)) fail('拒绝观察不匹配的 commit/资源输入');
    const recorded = readJson(resultPath) as { identity: unknown; result: P04AcceptanceResult; reportHash: string | null };
    if (canonical(recorded.identity) !== canonical(identity)) fail('入口结果身份不匹配');
    if (canonical(recorded.result.steps.map(({ fromVerifiedEvidence: _, ...record }) => record)) !== canonical(evidence.records.map(({ fromVerifiedEvidence: _, ...record }) => record))) fail('入口结果与步骤证据不匹配');
    if (recorded.result.reportWritten) {
      const verification = verifyP04ReportDirectory(reportDir, checklist);
      if (!verification.ok || digest(readFileSync(join(reportDir, 'report.json'))) !== recorded.reportHash) fail(`报告证据损坏：${verification.problems.join('; ')}`);
    }
    return { ...recorded.result, exitCode: 1, phaseAccepted: false };
  }

  // 报告已存在或运行目录非空均先拒绝；原子 mkdir 防止两个入口竞争同一运行。
  if (existsSync(workDir) || existsSync(reportDir)) fail('运行/报告目录已存在，拒绝复用旧成功；使用 --observe 只读核验');
  mkdirSync(dirname(workDir), { recursive: true });
  mkdirSync(workDir);
  options.log?.(`accept:p04: run-id=${runId} step-run=${stepRunDir} report=${reportDir}`);
  const resources = join(workDir, 'resources');
  const env = isolatedEnv(resources, repoRoot, stepTimeoutMs);
  const steps: P04StepSpec[] = ENTRY.stepOrder.map(id => ({ id, command: process.execPath, cwd: repoRoot,
    args: id === 'engineering-gate'
      ? ENTRY.engineeringGate.map(arg => arg === '{stepMs}' ? String(stepTimeoutMs) : arg)
      : [ENTRY.integrationRunner, ...tests.files],
  }));
  const sanitize = (text: string): string => text.replaceAll(repoRoot, '<repo>').replaceAll(reportRoot, '<reports>')
    .replaceAll(homedir(), '<home>').replace(/\bBearer\s+\S+/gi, '[REDACTED:bearer]');
  const sequence = await runP04StepSequence(steps, {
    evidenceDir: stepRunDir, identity, stepTimeoutMs, overallTimeoutMs,
    maxOutputBytes: config.maxCommandOutputBytes, env, redact: sanitize, log: options.log,
    runProcess: async (command, args, processOptions) => {
      if (exec('git', ['rev-parse', 'HEAD']) !== commit || exec('git', ['status', '--porcelain']) !== '') fail('受测代码在步骤间变化');
      const remaining = overallTimeoutMs - (Date.now() - started);
      if (remaining <= 0) fail('阶段总预算耗尽');
      return (options.runProcess ?? runBoundedProcess)(command, args, { ...processOptions, timeoutMs: Math.min(processOptions.timeoutMs, remaining) });
    },
  });
  const problems = [...sequence.problems];
  let cleaned = false;
  if (sequence.stopConfirmed) {
    try { rmSync(resources, { recursive: true }); cleaned = !existsSync(resources); }
    catch (error) { problems.push(`资源清理失败：${message(error)}`); }
  }
  let drift = false;
  try { drift = exec('git', ['rev-parse', 'HEAD']) !== commit || exec('git', ['status', '--porcelain']) !== ''; }
  catch { drift = true; }
  if (drift) problems.push('受测 commit/工作树在执行期间变化');
  const aggregation = aggregateP04IntegrationReport({
    repoRoot, config, checklist, runId, reportRoot: join(reportRoot, 'reports'), stepRunDir, exec,
    cleanup: { confirmed: cleaned, processesGone: sequence.stopConfirmed, notes: ['仅回收本次入口创建的 resources；停止不确定保留现场。'] },
    bindings: [
      { checkId: 'P04-FR1-FAILURE-MATRIX', stepIds: ['p04-integration'] },
      { checkId: 'P04-FR2-BOUNDED-ENTRY', stepIds: [...ENTRY.stepOrder], extraEvidence: [{ name: 'entry-steps.json', category: 'artifact',
        content: JSON.stringify({ identity, steps: sequence.steps, problems: sequence.problems }) + '\n' }] },
    ],
    knownLimitations: ['命令退出记录不替代逐项 SQLite/进程快照或产品 Feature 报告；缺少的证据保留缺口。',
      '本入口只编排离线执行；live not_run、人工 pending，不签署 P04 Phase 通过。'],
    openIssues: drift ? [{ id: 'P04-CODE-DRIFT', summary: '受测代码身份变化', blocking: true }] : [],
    sensitiveValues: [resources], log: options.log,
  });
  problems.push(...aggregation.problems, ...(aggregation.written?.problems ?? []));
  if (Date.now() - started > overallTimeoutMs) problems.push('阶段总预算耗尽（包括准备与报告时间）');
  const result: P04AcceptanceResult = { runId, stepRunDir, runDir: aggregation.written?.runDir ?? null,
    // 沿用阶段聚合器的 fail-closed 语义；离线命令全绿不能覆盖 live/manual pending。
    exitCode: aggregation.exitCode === 0 && sequence.exitCode === 0 && !drift && problems.length === 0 ? 0 : 1,
    reportWritten: aggregation.reportWritten, phaseAccepted: false, steps: sequence.steps, problems };
  const content = JSON.stringify({ identity, result, reportHash: aggregation.written === null ? null : digest(readFileSync(aggregation.written.reportPath)) }, null, 2) + '\n';
  writeFileSync(resultPath, content, { flag: 'wx' });
  if (readFileSync(resultPath, 'utf8') !== content) fail('入口结果写回失败');
  return result;
}

export function resolveP04Args(argv: readonly string[]): Omit<P04AcceptanceOptions, 'repoRoot'> & { help?: boolean } {
  const result: { runId?: string; reportRoot?: string; expectedCommit?: string; stepTimeoutMs?: number; overallTimeoutMs?: number; observe?: boolean; help?: boolean } = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (seen.has(arg)) fail(`重复参数：${arg}`);
    seen.add(arg);
    if (arg === '--help') { result.help = true; continue; }
    if (arg === '--observe') { result.observe = true; continue; }
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
    const invocation = resolveP04Args(process.argv.slice(2));
    if (invocation.help) process.stdout.write(`${P04_ACCEPT_USAGE}\n`);
    else {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      await runP04Acceptance({ repoRoot, ...invocation, log: text => process.stdout.write(`${text}\n`) }).then(result => {
        process.stdout.write(`accept:p04: report=${result.runDir ?? 'not_written'} Phase=pending/not_run exit=${result.exitCode}\n`);
        for (const problem of result.problems) process.stderr.write(`accept:p04: ${problem}\n`);
        process.exitCode = result.exitCode;
      });
    }
  } catch (error) { process.stderr.write(`${message(error)}\n`); process.exitCode = 1; }
}
