/**
 * npm test 的 fail-closed 启动器（F-003；工程检查脚本，非 ShipLoop 业务 Verifier）。
 *
 * 行为：
 * 1. 只从本仓库工作区安装解析 vitest（createRequire 从本脚本位置向上查找），
 *    不使用 PATH 全局 vitest，不通过 npx 临时下载；
 * 2. 校验工具身份与精确版本（name=vitest、version=5.0.3），缺失或版本不符即非零退出，
 *    并在输出中给出工具名、要求版本与修复命令；
 * 3. 默认按轻量、常规、重量组顺序运行 Vitest（每组继承配置并发）；
 *    显式文件/case 调用保持透传，--stage 可单独重测某组；
 * 4. 传播退出码；信号退出、超时或进程错误一律非零。各组共享总预算。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const REQUIRED_TOOL = 'vitest';
const REQUIRED_VERSION = '5.0.3';
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/**
 * 运行预算（毫秒）：默认 600_000；长时间验收（如 p02-clean-replay 完整复跑）可经
 * SHIPLOOP_TEST_RUN_TIMEOUT_MS 显式拉长（1_000..86_400_000，规范整数；非法即
 * fail-closed 非零退出）。默认行为不变。
 */
function resolveRunTimeoutMs(): number {
  const raw = process.env.SHIPLOOP_TEST_RUN_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_RUN_TIMEOUT_MS;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    fail(`SHIPLOOP_TEST_RUN_TIMEOUT_MS must be a positive integer (milliseconds), got "${raw}".`);
  }
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < 1_000 || ms > 86_400_000) {
    fail(`SHIPLOOP_TEST_RUN_TIMEOUT_MS out of range (1000..86400000 ms), got "${raw}".`);
  }
  return ms;
}

function fail(message: string): never {
  process.stderr.write(`run-tests: FAIL ${message}\n`);
  process.exit(1);
}

type ToolManifest = {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
};

const requireFromHere = createRequire(import.meta.url);

let manifestPath: string;
try {
  manifestPath = requireFromHere.resolve(`${REQUIRED_TOOL}/package.json`);
} catch (error) {
  fail(
    `required test tool "${REQUIRED_TOOL}"@${REQUIRED_VERSION} is not installed locally ` +
      `(module resolution from ${scriptDir} failed: ${(error as Error).message}). ` +
      `Install pinned tooling with "npm ci" and do not replace it with a global or npx copy.`,
  );
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ToolManifest;
if (manifest.name !== REQUIRED_TOOL) {
  fail(
    `test tool identity mismatch at ${manifestPath}: expected package name "${REQUIRED_TOOL}", ` +
      `found "${String(manifest.name)}". Refusing to run an unverified test tool.`,
  );
}
if (manifest.version !== REQUIRED_VERSION) {
  fail(
    `test tool version mismatch at ${manifestPath}: required "${REQUIRED_TOOL}"@${REQUIRED_VERSION}, ` +
      `found "${String(manifest.version)}". Restore pinned tooling with "npm ci".`,
  );
}

let binRelative: unknown;
if (typeof manifest.bin === 'string') {
  binRelative = manifest.bin;
} else if (manifest.bin !== null && typeof manifest.bin === 'object') {
  binRelative = (manifest.bin as Record<string, unknown>)[REQUIRED_TOOL];
}
if (typeof binRelative !== 'string' || binRelative.length === 0) {
  fail(`${REQUIRED_TOOL}@${REQUIRED_VERSION} package manifest does not declare a usable bin entry.`);
}

const binaryPath = resolve(dirname(manifestPath), binRelative);
if (!existsSync(binaryPath)) {
  fail(`resolved ${REQUIRED_TOOL}@${REQUIRED_VERSION} but its executable is missing: ${binaryPath}`);
}

process.stdout.write(
  `run-tests: using local ${REQUIRED_TOOL}@${REQUIRED_VERSION} (${binaryPath}) in run mode\n`,
);

const passthroughArgs = process.argv.slice(2);
// 显式文件/case 调用保持原语义；默认全量才按轻重分组，不能把分组文件列表
// 伪装成用户显式点名（clean-replay 等测试依赖这个区别）。
const stageIndex = passthroughArgs.indexOf('--stage');
let stage = 'all';
if (stageIndex !== -1) {
  stage = passthroughArgs[stageIndex + 1] ?? '';
  if (!['all', 'light', 'standard', 'heavy'].includes(stage)
    || passthroughArgs.lastIndexOf('--stage') !== stageIndex) fail('invalid --stage (all/light/standard/heavy)');
  passthroughArgs.splice(stageIndex, 2);
}
const listIndex = passthroughArgs.indexOf('--list-stages');
const list = listIndex !== -1;
if (list) passthroughArgs.splice(listIndex, 1);
let reportPath: string | undefined;
const reportIndex = passthroughArgs.indexOf('--stage-report');
if (reportIndex !== -1) {
  const value = passthroughArgs[reportIndex + 1];
  if (!value || value.startsWith('-')) fail('--stage-report requires a file path');
  reportPath = resolve(value);
  if (existsSync(reportPath)) fail(`refusing to overwrite stage report: ${reportPath}`);
  passthroughArgs.splice(reportIndex, 2);
}
const grouped = stageIndex !== -1 || list || passthroughArgs.length === 0;
const timeoutMs = resolveRunTimeoutMs();
if (!grouped) {
  if (reportPath) fail('--stage-report requires --stage for a filtered invocation');
  const explicitFilters = passthroughArgs.filter((arg) => !arg.startsWith('-'));
  const result = spawnSync(process.execPath, [binaryPath, 'run', ...passthroughArgs], {
    cwd: repoRoot, stdio: 'inherit',
    env: { ...process.env, SHIPLOOP_TEST_EXPLICIT_FILTERS: JSON.stringify(explicitFilters) },
    timeout: timeoutMs,
  });
  if (result.error) fail(`failed to execute ${REQUIRED_TOOL}: ${result.error.message}`);
  if (result.signal) fail(`${REQUIRED_TOOL} was terminated by signal ${result.signal}`);
  process.exit(result.status ?? 1);
} else {
  // Dynamic import preserves the missing-tool diagnostic in standalone launcher fixtures.
  const { loadTestStages, executeTestStages } = await import('./test-stages.ts');
  try {
    if (passthroughArgs.length) fail('--stage cannot be combined with Vitest filters/options; use a focused invocation instead');
    const plans = loadTestStages(repoRoot);
    const selected = plans.filter(plan => stage === 'all' || plan.stage === stage);
    if (list) {
      process.stdout.write(`${JSON.stringify({ scope: stage, plans: selected }, null, 2)}\n`);
      process.exit(0);
    }
    if (!selected.some(plan => plan.files.length)) fail('selected stage contains no tests');
    const outcomes = executeTestStages(selected, timeoutMs, (plan, remainingMs) => {
      process.stdout.write(`run-tests: RUN ${plan.stage} (${plan.files.length} files, maxWorkers=4, remaining=${remainingMs}ms)\n`);
      // Exclude the complement as well: Vitest positional filters are substring matches.
      const excluded = plans.flatMap(other => other.stage === plan.stage ? [] : other.files)
        .flatMap(file => ['--exclude', file]);
      const result = spawnSync(process.execPath, [binaryPath, 'run', ...plan.files, ...excluded], {
        cwd: repoRoot, stdio: 'inherit', timeout: remainingMs,
        env: { ...process.env, SHIPLOOP_TEST_EXPLICIT_FILTERS: '[]' },
      });
      process.stdout.write(`run-tests: END ${plan.stage} exit=${result.status} signal=${result.signal ?? 'none'}\n`);
      return result;
    });
    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true });
      const temp = `${reportPath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ schemaVersion: 1, scope: stage, fullSuiteRequested: stage === 'all',
        passed: outcomes.every(row => row.status === 'pass'), outcomes }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      // Publish without replacing another run's report, even if it appeared while tests ran.
      try { linkSync(temp, reportPath); }
      finally { unlinkSync(temp); }
    }
    for (const row of outcomes) process.stdout.write(`run-tests: ${row.status.toUpperCase()} ${row.stage} (${row.durationMs}ms)${row.error ? ` ${row.error}` : ''}\n`);
    process.exit(outcomes.every(row => row.status === 'pass') ? 0 : 1);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}
