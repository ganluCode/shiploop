/**
 * 构建产物入口冒烟检查（fail-closed 工程脚本，非 ShipLoop 业务 Verifier）。
 *
 * 对 core / host / cli 三个包逐一：
 * 1. 校验 package.json 的 exports['.'] 指向 dist 下真实存在的 JS 与 .d.ts 产物；
 * 2. 在独立 Node 子进程中加载构建后的入口，要求 5 秒内以退出码 0 结束
 *    （监听端口或常驻进程会触发超时并判失败）；
 * 3. 将 HOME 与 XDG 数据/配置/缓存目录及 cwd 重定向到系统临时目录下的独立沙箱，
 *    断言加载前后这些目录没有任何文件写入。
 *
 * 该脚本本身为 TypeScript，由根 tsconfig.json 覆盖类型检查；
 * 仅使用可擦除语法，直接以 Node 22 的原生 TypeScript 支持运行。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = ['packages/core', 'packages/host', 'packages/cli'] as const;
const LOAD_TIMEOUT_MS = 5000;

type PackageExports = {
  '.': { types?: unknown; default?: unknown };
};

type PackageManifest = {
  name?: unknown;
  exports?: PackageExports;
};

function fail(message: string): never {
  process.stderr.write(`smoke-built-entries: FAIL ${message}\n`);
  process.exit(1);
}

function listFilesRelative(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const child = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? walk(child, relative) : [relative];
    });
  return walk(directory, '');
}

for (const packageDir of packageDirs) {
  const packageRoot = resolve(repoRoot, packageDir);
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
  ) as PackageManifest;
  const name = typeof manifest.name === 'string' ? manifest.name : packageDir;
  const rootExport = manifest.exports?.['.'];

  if (typeof rootExport?.default !== 'string' || !rootExport.default.startsWith('./dist/')) {
    fail(`${name}: exports['.'].default must point at a ./dist/*.js artifact`);
  }
  if (typeof rootExport.types !== 'string' || !rootExport.types.startsWith('./dist/')) {
    fail(`${name}: exports['.'].types must point at a ./dist/*.d.ts artifact`);
  }

  const jsEntry = resolve(packageRoot, rootExport.default);
  const declarationEntry = resolve(packageRoot, rootExport.types);
  if (!existsSync(jsEntry)) {
    fail(`${name}: built entry missing: ${rootExport.default}`);
  }
  if (!existsSync(declarationEntry)) {
    fail(`${name}: declaration file missing: ${rootExport.types}`);
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'shiploop-smoke-'));
  try {
    const home = join(sandbox, 'home');
    const configHome = join(sandbox, 'xdg-config');
    const dataHome = join(sandbox, 'xdg-data');
    const cacheHome = join(sandbox, 'xdg-cache');
    const cwd = join(sandbox, 'cwd');
    for (const directory of [home, configHome, dataHome, cacheHome, cwd]) {
      mkdirSync(directory, { recursive: true });
    }
    const watchedDirectories = [home, configHome, dataHome, cacheHome, cwd];
    const before = watchedDirectories.map(listFilesRelative);

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [jsEntry], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        TMPDIR: sandbox,
        NODE_NO_WARNINGS: '1',
      },
      encoding: 'utf8',
      timeout: LOAD_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;

    if (result.error) {
      fail(`${name}: subprocess error or timeout after ${LOAD_TIMEOUT_MS}ms: ${result.error.message}`);
    }
    if (result.signal) {
      fail(`${name}: subprocess killed by signal ${result.signal}`);
    }
    if (result.status !== 0) {
      fail(`${name}: exit code ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }

    const after = watchedDirectories.map(listFilesRelative);
    for (let index = 0; index < watchedDirectories.length; index += 1) {
      const writes = after[index]?.filter((file) => !before[index]?.includes(file)) ?? [];
      if (writes.length > 0) {
        fail(`${name}: entry wrote user data files: ${writes.join(', ')}`);
      }
    }

    console.log(
      `ok ${name}: loaded ${rootExport.default} (exit=0, ${durationMs}ms, no side effects)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
