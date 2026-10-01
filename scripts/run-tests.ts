/**
 * npm test 的 fail-closed 启动器（F-003；工程检查脚本，非 ShipLoop 业务 Verifier）。
 *
 * 行为：
 * 1. 只从本仓库工作区安装解析 vitest（createRequire 从本脚本位置向上查找），
 *    不使用 PATH 全局 vitest，不通过 npx 临时下载；
 * 2. 校验工具身份与精确版本（name=vitest、version=5.0.3），缺失或版本不符即非零退出，
 *    并在输出中给出工具名、要求版本与修复命令；
 * 3. 以 run（一次性、非 watch）模式 spawn 真实 vitest，透传额外参数，原样继承 stdio；
 * 4. 传播退出码；信号退出、超时或进程错误一律非零。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const REQUIRED_TOOL = 'vitest';
const REQUIRED_VERSION = '5.0.3';
const RUN_TIMEOUT_MS = 600_000;

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
const result = spawnSync(process.execPath, [binaryPath, 'run', ...passthroughArgs], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  timeout: RUN_TIMEOUT_MS,
});

if (result.error) {
  fail(`failed to execute ${REQUIRED_TOOL}: ${result.error.message}`);
}
if (result.signal) {
  fail(`${REQUIRED_TOOL} was terminated by signal ${result.signal}`);
}
process.exit(result.status ?? 1);
