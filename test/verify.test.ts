/**
 * F-005 fail-closed `npm run verify` 工程检查编排回归。
 *
 * 本套件不依赖 dist 构建产物，覆盖：
 * - 接线与源码契约：scripts.verify 指向本地编排脚本（无 npx）；编排脚本真实串联
 *   锁文件预检 + npm test / npm run typecheck / npm run build，有限超时、NOT RUN 语义；
 * - 在系统临时目录构建**独立夹具工作区**（自带 package.json、锁文件、真实断言的有限
 *   测试集合、真实 tsc 类型检查、真实构建脚本），以真实子进程运行同一个生产
 *   scripts/verify.ts（--root 指向夹具），断言退出码与实际文件/检查结果，不 mock 子进程；
 * - 负向场景：缺锁文件（即使 node_modules 看似已装）、无测试文件、注入失败断言、
 *   注入类型错误、构建子命令非零、必需工具被删除、步骤超时（进程组收尾）、
 *   步骤进程信号死亡、清单缺少必需脚本——每个场景 verify 都必须非零退出；
 * - 递归规避：夹具的测试子命令是夹具本地的有限断言集合，绝不回跳本仓库的
 *   npm test / verify，因此在外层 `npm run verify` 内运行本套件不会递归。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const requireFromTest = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_SCRIPT = resolve(repoRoot, 'scripts/verify.ts');

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(prefix = 'shiploop-f005-'): string {
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

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const directories = ['home', 'xdg-config', 'xdg-data', 'xdg-cache', 'tmp'];
  for (const directory of directories) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    TMPDIR: join(root, 'tmp'),
    FORCE_COLOR: '0',
    NODE_NO_WARNINGS: '1',
    CI: '1',
  };
}

type RunResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  durationMs: number;
  outerError: boolean;
};

/** 以真实子进程运行生产 scripts/verify.ts（非 mock），--root 指向夹具工作区。 */
function runVerifyInSandbox(
  root: string,
  options: { extraArgs?: string[]; extraEnv?: Record<string, string>; timeoutMs?: number } = {},
): RunResult {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [VERIFY_SCRIPT, '--root', root, ...(options.extraArgs ?? [])],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 180_000,
      env: { ...isolatedEnv(root), ...(options.extraEnv ?? {}) },
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    durationMs: Date.now() - started,
    outerError: result.error !== undefined,
  };
}

/** 从本仓库工作区安装解析真实 TypeScript tsc 可执行文件，注入夹具的类型检查脚本。 */
function resolveTscBin(): string {
  const manifestPath = requireFromTest.resolve('typescript/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    name?: unknown;
    bin?: unknown;
  };
  expect(manifest.name).toBe('typescript');
  const binTable = manifest.bin;
  const binRelative =
    typeof binTable === 'string'
      ? binTable
      : binTable !== null && typeof binTable === 'object'
        ? (binTable as Record<string, unknown>).tsc
        : undefined;
  expect(typeof binRelative, 'typescript package.json must declare bin.tsc').toBe('string');
  const bin = resolve(dirname(manifestPath), String(binRelative));
  expect(existsSync(bin), `tsc binary must exist: ${bin}`).toBe(true);
  return bin;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/** 夹具入口：仅可擦除语法，Node 22 可直接按 .ts 导入，tsc 可严格检查。 */
const FIXTURE_ENTRY_TS = 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n';

/** 有限夹具测试集合：两个文件，均为真实断言（node:assert/strict），不回跳本仓库测试。 */
const DEFAULT_FIXTURE_TESTS: Record<string, string> = {
  'tests/greet.test.mjs':
    "import assert from 'node:assert/strict';\n" +
    "import { greet } from '../src/entry.ts';\n" +
    "assert.equal(greet('世界'), 'hello 世界');\n" +
    "assert.equal(greet(''), 'hello ');\n",
  'tests/utf8.test.mjs':
    "import assert from 'node:assert/strict';\n" +
    "const text = '中文内容🚢';\n" +
    "assert.ok(Buffer.byteLength(text, 'utf8') > text.length);\n" +
    "assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text);\n",
};

const FIXTURE_TEST_RUNNER = `import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDir = join(root, 'tests');
const files = existsSync(testsDir)
  ? readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).sort()
  : [];
if (files.length === 0) {
  console.error('fixture-tests: FAIL no fixture test files found in tests/*.test.mjs');
  process.exit(1);
}
let failed = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(join(testsDir, file)).href);
    console.log(\`fixture-tests: PASS \${file}\`);
  } catch (error) {
    failed += 1;
    console.error(\`fixture-tests: FAIL \${file}: \${(error && error.message) || error}\`);
  }
}
if (failed > 0) {
  console.error(\`fixture-tests: \${failed} failed\`);
  process.exit(1);
}
console.log(\`fixture-tests: \${files.length} passed\`);
`;

const FIXTURE_TYPECHECK_RUNNER = (tscBin: string): string => `import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(process.execPath, [${JSON.stringify(tscBin)}, '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
  timeout: 120000,
});
if (result.error) {
  console.error(\`fixture-typecheck: FAIL \${result.error.message}\`);
  process.exit(1);
}
if (result.signal) {
  console.error(\`fixture-typecheck: FAIL terminated by signal \${result.signal}\`);
  process.exit(1);
}
process.exit(result.status === 0 ? 0 : 1);
`;

const FIXTURE_BUILD_SCRIPT = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (existsSync(join(root, 'build-fail.marker'))) {
  console.error('fixture-build: FAIL build-fail.marker present');
  process.exit(1);
}
const source = readFileSync(join(root, 'src', 'entry.ts'), 'utf-8');
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'entry.js'), \`// built from src/entry.ts (\${source.length} bytes)\\nexport {};\\n\`);
console.log('fixture-build: wrote dist/entry.js');
`;

const HANGING_TEST_RUNNER =
  "console.log('fixture-tests: hanging forever');\nsetInterval(() => {}, 1000);\n";

const SIGNAL_TEST_RUNNER =
  "console.log('fixture-tests: terminating self with SIGTERM');\nprocess.kill(process.pid, 'SIGTERM');\n";

type FixtureOptions = {
  /** false 时不写 package-lock.json（缺锁文件场景）。 */
  lockfile?: boolean;
  /** true 时创建 dummy node_modules，模拟“依赖已安装”表象。 */
  simulateInstalledDeps?: boolean;
  /** null 表示不创建任何测试文件；缺省为两个真实断言文件。 */
  testFiles?: Record<string, string> | null;
  testRunnerKind?: 'default' | 'hang' | 'signal' | 'missing';
  /** 追加到 src/entry.ts 的内容（用于注入类型错误）。 */
  entryAppend?: string;
  buildFailMarker?: boolean;
  /** 从夹具清单中删除这些脚本（缺脚本场景）。 */
  omitScripts?: readonly string[];
};

/** 构建独立夹具工作区：真实锁文件、真实断言测试、真实 tsc、真实构建脚本。 */
function buildVerifyFixture(root: string, options: FixtureOptions = {}): void {
  const scripts: Record<string, string> = {
    test: 'node scripts/run-fixture-tests.mjs',
    typecheck: 'node scripts/run-fixture-typecheck.mjs',
    build: 'node scripts/build-fixture.mjs',
  };
  for (const name of options.omitScripts ?? []) {
    delete scripts[name];
  }
  writeJson(join(root, 'package.json'), {
    name: 'verify-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts,
  });
  if (options.lockfile !== false) {
    writeJson(join(root, 'package-lock.json'), {
      name: 'verify-fixture',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'verify-fixture', version: '0.0.0' } },
    });
  }
  writeText(join(root, 'src', 'entry.ts'), FIXTURE_ENTRY_TS + (options.entryAppend ?? ''));
  writeJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'es2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      types: [],
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  });

  const runnerKind = options.testRunnerKind ?? 'default';
  if (runnerKind === 'default') {
    writeText(join(root, 'scripts', 'run-fixture-tests.mjs'), FIXTURE_TEST_RUNNER);
  } else if (runnerKind === 'hang') {
    writeText(join(root, 'scripts', 'run-fixture-tests.mjs'), HANGING_TEST_RUNNER);
  } else if (runnerKind === 'signal') {
    writeText(join(root, 'scripts', 'run-fixture-tests.mjs'), SIGNAL_TEST_RUNNER);
  }
  // 'missing'：刻意不写测试运行器，模拟必需工具被删除。

  writeText(join(root, 'scripts', 'run-fixture-typecheck.mjs'), FIXTURE_TYPECHECK_RUNNER(resolveTscBin()));
  writeText(join(root, 'scripts', 'build-fixture.mjs'), FIXTURE_BUILD_SCRIPT);

  const testFiles = options.testFiles === undefined ? DEFAULT_FIXTURE_TESTS : options.testFiles;
  if (testFiles !== null) {
    for (const [relativePath, content] of Object.entries(testFiles)) {
      writeText(join(root, relativePath), content);
    }
  }

  if (options.buildFailMarker === true) {
    writeText(join(root, 'build-fail.marker'), 'injected build failure\n');
  }
  if (options.simulateInstalledDeps === true) {
    writeJson(join(root, 'node_modules', 'dummy-tool', 'package.json'), {
      name: 'dummy-tool',
      version: '0.0.0',
    });
  }
}

describe('verify wiring and source contract', () => {
  it('exposes npm run verify through the local orchestrator without npx', () => {
    const scripts = asObject(readJson('package.json').scripts, 'package.json scripts');
    expect(scripts.verify).toBe('node scripts/verify.ts');
    expect(String(scripts.verify)).not.toMatch(/\bnpx\b/);
    // 四个独立脚本保留各自入口。
    expect(scripts.test).toBe('node scripts/run-tests.ts');
    expect(scripts['check:boundaries']).toBe('node scripts/check-boundaries.ts');
    expect(String(scripts.build)).toContain('smoke-built-entries.ts');
    expect(existsSync(VERIFY_SCRIPT)).toBe(true);
    const tsconfig = readJson('tsconfig.json');
    expect(tsconfig.include as string[]).toContain('scripts/**/*.ts');
  });

  it('orchestrator chains lockfile precheck plus npm test / typecheck / build, fail-closed', () => {
    const code = readText('scripts/verify.ts');
    // 锁文件预检（先于任何子命令，不被 node_modules 掩盖）。
    expect(code).toContain('package-lock.json');
    expect(code).toContain('lockfileVersion');
    // 真实串联三个固定检查命令。
    expect(code).toContain("'test'");
    expect(code).toMatch(/'run',\s*'typecheck'/);
    expect(code).toMatch(/'run',\s*'build'/);
    // 有限超时（默认 600s，可经环境变量/参数覆盖供夹具验收）。
    expect(code).toMatch(/600_000|600000/);
    expect(code).toContain('SHIPLOOP_VERIFY_STEP_TIMEOUT_MS');
    expect(code).toContain('--step-timeout-ms');
    // 超时按进程组收尾，信号退出算失败。
    expect(code).toMatch(/detached\s*:\s*true/);
    expect(code).toContain('process.kill');
    expect(code).toContain('SIGKILL');
    // 未执行步骤明确标记 NOT RUN，不标为通过；非零即失败。
    expect(code).toContain('NOT RUN');
    expect(code).toMatch(/process\.exit|return 1/);
    // 禁止把 npx 作为子进程命令调用（散文式提示不算调用）。
    expect(code).not.toMatch(/['"`]npx['"`]/);
    expect(code).toContain('--root');
  });

  it('README documents all four engineering scripts and scopes verify as a dev-only check', () => {
    const readme = readText('README.md');
    for (const script of ['run-tests.ts', 'smoke-built-entries.ts', 'check-boundaries.ts', 'verify.ts']) {
      expect(readme, `README must document ${script}`).toContain(script);
    }
    expect(readme).toContain('npm run verify');
    expect(readme).toContain('开发工程检查');
    expect(readme).toMatch(/不是.*业务.*Verifier|非.*业务.*Verifier/);
    // 明确不提供本阶段之外的假验收命令。
    expect(readme).toMatch(/不提供[^\n]*accept:p01/);
    expect(readme).not.toContain('当前不存在该脚本');
  });
});

describe('verify on a real fixture workspace (positive, real subcommands)', () => {
  it('passes and runs real test / typecheck / build subcommands with visible exit codes', () => {
    const root = newSandbox('shiploop-f005-pass-');
    buildVerifyFixture(root);

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.status, `verify must pass on legal fixture:\n${result.output}`).toBe(0);
    // 可核对：每个检查命令与其退出码。
    expect(result.output).toContain('precheck package-lock.json OK');
    expect(result.output).toContain('[1/3] EXIT 0 npm test');
    expect(result.output).toContain('[2/3] EXIT 0 npm run typecheck');
    expect(result.output).toContain('[3/3] EXIT 0 npm run build');
    expect(result.output).toContain('PASS 3/3');
    // 证明真实子命令确实运行：夹具测试汇总与真实构建产物。
    expect(result.output).toContain('fixture-tests: 2 passed');
    const builtEntry = join(root, 'dist', 'entry.js');
    expect(existsSync(builtEntry)).toBe(true);
    expect(readFileSync(builtEntry, 'utf-8')).toContain('built from src/entry.ts');
  }, 180_000);
});

describe('verify negative scenarios (isolated fixture copies, real subcommands)', () => {
  it('fails at lockfile precheck even when dependencies appear installed', () => {
    const root = newSandbox('shiploop-f005-nolock-');
    buildVerifyFixture(root, { lockfile: false, simulateInstalledDeps: true });
    expect(existsSync(join(root, 'node_modules', 'dummy-tool', 'package.json'))).toBe(true);

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `missing lockfile must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('FAIL precheck');
    expect(result.output).toContain('package-lock.json');
    // 未运行的步骤绝不标为通过，且任何子命令都没有真正执行。
    expect(result.output).toContain('NOT RUN');
    expect(result.output).not.toContain('[1/3] EXIT 0');
    expect(result.output).not.toContain('fixture-tests:');
  }, 60_000);

  it('fails when the fixture has no real test files', () => {
    const root = newSandbox('shiploop-f005-notests-');
    buildVerifyFixture(root, { testFiles: null });

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `empty test set must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('no fixture test files');
    expect(result.output).toContain('[1/3] FAIL npm test');
    expect(result.output).toContain('NOT RUN');
    expect(result.output).toContain('npm run typecheck');
    expect(result.output).toContain('npm run build');
    // 后续步骤未执行：不产生构建产物。
    expect(existsSync(join(root, 'dist'))).toBe(false);
  }, 120_000);

  it('fails when an injected assertion fails, naming the offending fixture test', () => {
    const root = newSandbox('shiploop-f005-failassert-');
    buildVerifyFixture(root, {
      testFiles: {
        ...DEFAULT_FIXTURE_TESTS,
        'tests/injected-failure.test.mjs':
          "import assert from 'node:assert/strict';\nassert.equal(1, 2, '注入的失败断言');\n",
      },
    });

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `failing assertion must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('injected-failure.test.mjs');
    expect(result.output).toContain('注入的失败断言');
    expect(result.output).toContain('[1/3] FAIL npm test');
    expect(result.output).not.toContain('PASS 3/3');
  }, 120_000);

  it('fails on an injected TypeScript type error and does not run the build', () => {
    const root = newSandbox('shiploop-f005-typeerror-');
    buildVerifyFixture(root, {
      entryAppend: "export const injectedTypeError: number = 'not-a-number';\n",
    });

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `type error must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('[1/3] EXIT 0 npm test');
    expect(result.output).toContain('[2/3] FAIL npm run typecheck');
    expect(result.output).toContain('NOT RUN');
    expect(result.output).toContain('npm run build');
    expect(existsSync(join(root, 'dist'))).toBe(false);
  }, 180_000);

  it('fails when the build subcommand exits non-zero', () => {
    const root = newSandbox('shiploop-f005-buildfail-');
    buildVerifyFixture(root, { buildFailMarker: true });

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `failing build must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('[1/3] EXIT 0 npm test');
    expect(result.output).toContain('[2/3] EXIT 0 npm run typecheck');
    expect(result.output).toContain('[3/3] FAIL npm run build');
    expect(result.output).toContain('build-fail.marker');
    expect(result.output).not.toContain('PASS 3/3');
    expect(existsSync(join(root, 'dist', 'entry.js'))).toBe(false);
  }, 180_000);

  it('fails when a required tool is deleted, without npx recovery or skipping', () => {
    const root = newSandbox('shiploop-f005-notool-');
    buildVerifyFixture(root, { testRunnerKind: 'missing' });
    expect(existsSync(join(root, 'scripts', 'run-fixture-tests.mjs'))).toBe(false);

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `deleted tool must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('[1/3] FAIL npm test');
    expect(result.output).toContain('run-fixture-tests.mjs');
    // 没有任何经 npx 的临时下载/恢复行为。
    expect(result.output).not.toMatch(/\bnpx\b/);
    expect(result.output).not.toContain('PASS 3/3');
  }, 120_000);

  it('fails when a step exceeds the finite timeout and reaps the whole process group', () => {
    const root = newSandbox('shiploop-f005-timeout-');
    buildVerifyFixture(root, { testRunnerKind: 'hang' });

    const result = runVerifyInSandbox(root, {
      extraEnv: { SHIPLOOP_VERIFY_STEP_TIMEOUT_MS: '2000' },
      timeoutMs: 60_000,
    });
    expect(result.outerError, `verify itself must finish, not hang:\n${result.output}`).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.status, `timed-out step must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toMatch(/timed out after 2000\s?ms/);
    expect(result.output).toContain('[1/3] FAIL npm test');
    // 有限超时：整个 verify 必须在远小于默认 600s 的时间内结束。
    expect(result.durationMs).toBeLessThan(45_000);
    // 进程收尾：悬挂的夹具测试进程（含孙进程）不得残留。
    const pgrep = spawnSync('pgrep', ['-f', 'run-fixture-tests'], { encoding: 'utf8' });
    expect(
      pgrep.status,
      `hanging fixture process must be reaped, pgrep output: ${String(pgrep.stdout)}`,
    ).toBe(1);
  }, 90_000);

  it('fails when a step process dies by signal', () => {
    const root = newSandbox('shiploop-f005-signal-');
    buildVerifyFixture(root, { testRunnerKind: 'signal' });

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.status, `signal-terminated step must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('[1/3] FAIL npm test');
    expect(result.output).not.toContain('PASS 3/3');
  }, 120_000);

  it('fails closed when a required npm script is missing from the manifest', () => {
    const root = newSandbox('shiploop-f005-noscript-');
    buildVerifyFixture(root, { omitScripts: ['build'] });

    const result = runVerifyInSandbox(root);
    expect(result.outerError).toBe(false);
    expect(result.status, `missing script must fail verify:\n${result.output}`).toBe(1);
    expect(result.output).toContain('FAIL precheck');
    expect(result.output).toContain('build');
    expect(result.output).toContain('NOT RUN');
    expect(result.output).not.toContain('[1/3] EXIT 0');
  }, 60_000);
});
