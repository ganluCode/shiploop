/**
 * F-003 确定性测试入口与临时资源夹具回归。
 *
 * 本套件不依赖 dist 构建产物，直接断言：
 * - npm test 经由 fail-closed 启动器调用本地精确版本 vitest（run 模式，无 watch、无兜底）；
 * - vitest 配置为确定性一次性运行，未启用 passWithNoTests / 覆盖率门槛 / 缓存依赖；
 * - 在真实子进程中验证：空测试集失败、注入失败断言失败、正常夹具通过、工具缺失报出工具身份；
 * - 临时沙箱夹具在系统临时目录中独立创建，中文 UTF-8 写入/读取一致，正常与异常路径均完成清理。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempSandbox, withTempSandbox } from './helpers/temp-sandbox.ts';

const requireFromTest = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinnedVitestVersion = '5.0.3';

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(prefix = 'shiploop-f003-'): string {
  const sandbox = createTempSandbox(prefix, { outside: [repoRoot, homedir()] });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8')) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf-8');
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  expect(value, `${label} must be an object`).toBeTypeOf('object');
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(child));
    } else {
      result.push(child);
    }
  }
  return result;
}

/** 从本地工作区安装解析真实 vitest 可执行文件（不允许回退到全局或 npx 下载）。 */
function resolveLocalVitestBin(): { bin: string; manifestPath: string; version: string } {
  const manifestPath = requireFromTest.resolve('vitest/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    name?: unknown;
    version?: unknown;
    bin?: unknown;
  };
  expect(manifest.name).toBe('vitest');
  expect(manifest.version).toBe(pinnedVitestVersion);
  const binTable = manifest.bin;
  let binRelative: unknown;
  if (typeof binTable === 'string') {
    binRelative = binTable;
  } else if (binTable && typeof binTable === 'object') {
    binRelative = (binTable as Record<string, unknown>).vitest;
  }
  expect(typeof binRelative, 'vitest package.json must declare bin.vitest').toBe('string');
  const bin = resolve(dirname(manifestPath), String(binRelative));
  expect(existsSync(bin), `vitest binary must exist: ${bin}`).toBe(true);
  return { bin, manifestPath, version: String(manifest.version) };
}

type RunResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const xdgConfig = join(root, 'xdg-config');
  const xdgData = join(root, 'xdg-data');
  const xdgCache = join(root, 'xdg-cache');
  const tempHome = join(root, 'tmp');
  for (const directory of [home, xdgConfig, xdgData, xdgCache, tempHome]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    TMPDIR: tempHome,
    FORCE_COLOR: '0',
    NODE_NO_WARNINGS: '1',
    CI: '1',
  };
}

/**
 * 在隔离沙箱中运行真实 vitest 子进程（非 mock），始终使用本仓库锁定的配置与二进制，
 * 但把 root 指向临时夹具目录。有限超时保证不留下常驻进程。
 */
function runVitestInSandbox(root: string, extraArgs: string[] = []): RunResult {
  const { bin } = resolveLocalVitestBin();
  const configPath = resolve(repoRoot, 'vitest.config.ts');
  const result = spawnSync(
    process.execPath,
    [bin, 'run', '--root', root, '--config', configPath, ...extraArgs],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: isolatedEnv(root),
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error !== undefined,
  };
}

describe('npm test entry (fail-closed launcher)', () => {
  const root = readJson('package.json');
  const scripts = asObject(root.scripts, 'package.json scripts');

  it('routes npm test through the local TypeScript launcher instead of a bare global binary', () => {
    expect(scripts.test).toBe('node scripts/run-tests.ts');
    expect(String(scripts.test)).not.toMatch(/\bnpx\b/);
    expect(String(scripts.test)).not.toContain('--watch');
    expect(String(scripts.test)).not.toContain('passWithNoTests');
  });

  it('launcher pins the local vitest identity and exact version, and always uses run mode', () => {
    const code = readText('scripts/run-tests.ts');
    expect(code).toContain("'vitest'");
    expect(code).toContain(`'${pinnedVitestVersion}'`);
    expect(code).toMatch(/(\$\{REQUIRED_TOOL\}|vitest)\/package\.json/);
    expect(code).toMatch(/spawnSync\s*\(/);
    expect(code).toMatch(/['"]run['"]/);
    expect(code).not.toContain('--watch');
    expect(code).not.toContain('--passWithNoTests');
    // 工具缺失或身份不符必须显式失败，而不是回退到 PATH 上的其他实现。
    expect(code).toMatch(/process\.exit\s*\(\s*1\s*\)/);
    // 禁止把 npx 作为子进程命令调用（散文式“不要使用 npx”的提示不算调用）。
    expect(code).not.toMatch(/['"`]npx['"`]/);
  });

  it('exits non-zero and names the missing tool with its required version when vitest is absent', () => {
    const root2 = newSandbox('shiploop-f003-no-tool-');
    // 前置条件：临时目录的任何祖先都不包含可被解析到的 vitest 安装。
    let ancestor = root2;
    while (true) {
      const parent = dirname(ancestor);
      expect(
        existsSync(join(ancestor, 'node_modules', 'vitest', 'package.json')),
        `fixture precondition violated: vitest reachable from ${ancestor}`,
      ).toBe(false);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
    const scriptsDir = join(root2, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'run-tests.ts'), readText('scripts/run-tests.ts'), 'utf-8');

    const result = spawnSync(process.execPath, [join(scriptsDir, 'run-tests.ts')], {
      cwd: root2,
      encoding: 'utf8',
      timeout: 15_000,
      env: isolatedEnv(root2),
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(output).toMatch(/vitest/);
    expect(output).toContain(pinnedVitestVersion);
  });
});

describe('vitest deterministic configuration', () => {
  it('uses the real checked-in config: one-shot run, no empty-suite fallback, no cache/coverage gates', async () => {
    const configUrl = pathToFileURL(resolve(repoRoot, 'vitest.config.ts')).href;
    const loaded = (await import(configUrl)) as {
      default?: { test?: Record<string, unknown> };
    };
    const options = asObject(loaded.default?.test, 'vitest config test options');

    expect(options.watch).toBe(false);
    expect(options.passWithNoTests).toBe(false);
    expect(options.cache).toBe(false);
    expect(options.pool).toBe('forks');
    expect(Array.isArray(options.include)).toBe(true);
    const include = options.include as unknown[];
    expect(include.some((pattern) => String(pattern).includes('test'))).toBe(true);

    const exclude = options.exclude as unknown;
    expect(Array.isArray(exclude)).toBe(true);
    const excludePatterns = (exclude as unknown[]).map(String);
    expect(excludePatterns.some((pattern) => pattern.includes('node_modules'))).toBe(true);
    expect(excludePatterns.some((pattern) => pattern.includes('dist'))).toBe(true);
    expect(excludePatterns.some((pattern) => pattern.includes('coverage'))).toBe(true);
    expect(excludePatterns.some((pattern) => pattern.includes('helpers'))).toBe(true);

    const sequence = asObject(options.sequence, 'sequence');
    expect(sequence.shuffle).toBe(false);
    expect(sequence.concurrent).toBe(false);
    expect(Number(options.testTimeout)).toBeGreaterThan(0);
    expect(Number(options.hookTimeout)).toBeGreaterThan(0);

    const coverage = asObject(options.coverage, 'coverage');
    expect(coverage.enabled).toBe(false);
  });

  it('config source does not opt into watch mode or passWithNoTests textually', () => {
    const code = readText('vitest.config.ts');
    expect(code).not.toMatch(/passWithNoTests\s*:\s*true/);
    expect(code).not.toMatch(/watch\s*:\s*true/);
  });

  it('tests can run without a prior build: no test imports workspace package dist entries', () => {
    const forbiddenHeads = ['shiploop-core', 'shiploop-host', 'shiploop-cli'];
    for (const file of listFiles(resolve(repoRoot, 'test'))) {
      if (!/\.(test|spec)\.[cm]?[jt]s$/.test(file)) {
        continue;
      }
      const code = readFileSync(file, 'utf-8');
      const stripped = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      const specifiers: string[] = [];
      const patterns = [
        /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
        /\bimport\s*['"]([^'"]+)['"]/g,
        /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];
      for (const pattern of patterns) {
        for (const match of stripped.matchAll(pattern)) {
          specifiers.push(match[1] as string);
        }
      }
      for (const specifier of specifiers) {
        for (const head of forbiddenHeads) {
          expect(specifier, `${file} must not depend on built ${head} dist before npm test`).not.toBe(head);
          expect(specifier).not.toBe(`${head}/`);
        }
      }
    }
  });
});

describe('real vitest subprocess fixtures (no mocks, one-shot, reaped)', () => {
  it('reports the pinned tool identity including the exact version', () => {
    const { bin } = resolveLocalVitestBin();
    const root2 = newSandbox('shiploop-f003-version-');
    const result = spawnSync(process.execPath, [bin, '--version'], {
      cwd: root2,
      encoding: 'utf8',
      timeout: 30_000,
      env: isolatedEnv(root2),
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(output).toMatch(/vitest\/\s*5\.0\.3/);
  });

  it('fails non-zero when the fixture tree contains no real test files', () => {
    const root2 = newSandbox('shiploop-f003-empty-');
    writeFileSync(join(root2, 'README.txt'), 'not a test file 不是测试文件\n', 'utf-8');
    const run = runVitestInSandbox(root2);
    expect(run.timedOut).toBe(false);
    expect(run.signal).toBeNull();
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/no test files found/i);
  });

  it('fails non-zero when an injected assertion fails, and names the offending case', () => {
    const root2 = newSandbox('shiploop-f003-failing-');
    const testDir = join(root2, 'test');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'intentional-failure.test.js'),
      [
        "import { test, expect } from 'vitest';",
        "test('intentional failure marker 故意失败探针', () => {",
        '  expect(1).toBe(2);',
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );
    const run = runVitestInSandbox(root2);
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.timedOut).toBe(false);
    expect(run.signal).toBeNull();
    expect(run.status).not.toBe(0);
    expect(output).toMatch(/intentional failure marker|故意失败探针|intentional-failure/);
  });

  it('passes non-zero-fixture positive control: real assertions in a temp project succeed', () => {
    const root2 = newSandbox('shiploop-f003-passing-');
    const testDir = join(root2, 'test');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'temp-project-passing.test.js'),
      [
        "import { test, expect } from 'vitest';",
        "test('temp project positive control 临时项目正向对照', () => {",
        "  expect('船舶循环'.length).toBe(4);",
        '  expect([1, 2, 3]).toEqual([1, 2, 3]);',
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );
    const run = runVitestInSandbox(root2);
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.timedOut).toBe(false);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(output).toMatch(/1\s+passed/);
  });
});

describe('system temp resource fixture and UTF-8 Chinese roundtrip', () => {
  it('creates independent fresh sandboxes outside the repo and user home', () => {
    const first = newSandbox('shiploop-f003-utf8-');
    const second = newSandbox('shiploop-f003-utf8-');
    expect(first).not.toBe(second);
    const realTmp = resolve(tmpdir());
    for (const sandbox of [first, second]) {
      expect(resolve(sandbox) + sep).toContain(realTmp + sep);
      expect(sandbox + sep).not.toContain(resolve(repoRoot) + sep);
      expect(sandbox + sep).not.toContain(resolve(homedir()) + sep);
      expect(existsSync(sandbox)).toBe(true);
    }
    rmSync(second, { recursive: true, force: true });
    expect(existsSync(second)).toBe(false);
  });

  it('round-trips Chinese UTF-8 content byte-for-byte without BOM or newline conversion', () => {
    const sandbox = newSandbox('shiploop-f003-utf8-');
    const nested = join(sandbox, 'nested', '中文目录');
    mkdirSync(nested, { recursive: true });
    const target = join(nested, '中文文件.txt');
    const content = [
      'ShipLoop 船舶循环：确定性测试夹具。',
      '层级：领域 → 应用 → 端口 → 适配器。',
      'Emoji 行：🚀 与 ✨ 占多字节。',
      '末行故意不留换行',
    ].join('\n');

    writeFileSync(target, content, 'utf-8');
    const textBack = readFileSync(target, 'utf-8');
    expect(textBack).toBe(content);

    const bytesBack = readFileSync(target);
    const expectedBytes = Buffer.from(content, 'utf-8');
    expect(Buffer.compare(bytesBack, expectedBytes)).toBe(0);
    expect(bytesBack[0]).not.toBe(0xef);
    expect(bytesBack[1]).not.toBe(0xbb);
    expect(bytesBack.length).toBeGreaterThan(content.length);
    expect(bytesBack.toString('utf-8')).toBe(content);
    expect(readFileSync(target, 'latin1')).not.toContain('\r\n');
  });

  it('cleans up resources on the normal completion path', () => {
    const sandbox = createTempSandbox('shiploop-f003-clean-', { outside: [repoRoot, homedir()] });
    trackedSandboxes.push(sandbox.path);
    const file = join(sandbox.path, 'normal.txt');
    writeFileSync(file, '正常路径 正常清理\n', 'utf-8');
    expect(existsSync(file)).toBe(true);
    sandbox.cleanup();
    expect(existsSync(sandbox.path)).toBe(false);
  });

  it('cleans up resources even when the exercised callback throws', () => {
    let observedRoot: string | undefined;
    const throwing = (): never => {
      throw new Error('故意抛出：夹具仍必须清理');
    };
    expect(() =>
      withTempSandbox(
        (root) => {
          observedRoot = root;
          writeFileSync(join(root, 'throwing.txt'), '异常路径 异常清理', 'utf-8');
          throwing();
        },
        { prefix: 'shiploop-f003-throw-', outside: [repoRoot, homedir()] },
      ),
    ).toThrow('故意抛出：夹具仍必须清理');
    expect(observedRoot).toBeTypeOf('string');
    expect(existsSync(observedRoot as string)).toBe(false);
  });

  it('leaves no files from this run behind after repeated fixture creation', () => {
    const roots: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const sandbox = createTempSandbox('shiploop-f003-repeat-', { outside: [repoRoot, homedir()] });
      roots.push(sandbox.path);
      writeFileSync(join(sandbox.path, `file-${index}.txt`), `第 ${index} 次运行`, 'utf-8');
      sandbox.cleanup();
    }
    expect(new Set(roots).size).toBe(3);
    for (const root of roots) {
      expect(existsSync(root)).toBe(false);
    }
  });
});
