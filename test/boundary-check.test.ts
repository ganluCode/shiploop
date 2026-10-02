/**
 * F-004 工作区与 Core 分层依赖检查回归。
 *
 * 本套件不依赖 dist 构建产物，覆盖：
 * - 检查器以真实子进程在当前仓库返回 0，且明确声明源码扫描范围（packages/某包/src）；
 * - 临时夹具中的正反用例（in-process 调用 runBoundaryCheck，非 mock）：
 *   合法单向依赖通过；Core→Host/CLI 反向引用、Host↔CLI 循环、跨包内部导入、
 *   相对路径/路径别名逃逸、Core 契约区绑定基础设施、Core 分层方向违规均被拒绝，
 *   诊断包含违规文件与目标模块；合法 adapters 引用不被误拒；
 * - 静态 import、export from、type-only 导入、字面量 dynamic import/require 全部覆盖；
 *   无法解析的生产导入明确报错；故意违规的夹具文件不被当作生产源码；
 * - 注释与字符串字面量中的“导入”文本不会触发误判。
 *
 * 注意：本文件中的夹具源码一律经 sideEffectImport/importFrom 等辅助函数拼装，
 * 不出现字面量 `import '<工作区包名>'`，以满足 F-003 对测试文件的静态扫描约束。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempSandbox, withTempSandbox } from './helpers/temp-sandbox.ts';
import { runBoundaryCheck } from '../scripts/check-boundaries.ts';
import type { BoundaryCheckResult, BoundaryDiagnostic } from '../scripts/check-boundaries.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PKG_CORE = 'shiploop-core';
const PKG_HOST = 'shiploop-host';
const PKG_CLI = 'shiploop-cli';
const PI_SDK = '@earendil-works/pi-coding-agent';

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(prefix = 'shiploop-f004-'): string {
  const sandbox = createTempSandbox(prefix, { outside: [repoRoot, homedir()] });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8')) as Record<string, unknown>;
}

/** 生成夹具源码中的导入语句；保持本测试文件不含字面量工作区包导入。 */
const quote = (value: string): string => JSON.stringify(value);
const sideEffectImport = (specifier: string): string => `import ${quote(specifier)};\n`;
const importFrom = (specifier: string): string =>
  `import { marker } from ${quote(specifier)};\nexport { marker };\n`;
const typeImportFrom = (specifier: string): string =>
  `import type { Marker } from ${quote(specifier)};\nexport type { Marker };\n`;
const exportFrom = (specifier: string): string => `export * from ${quote(specifier)};\n`;
const dynamicImport = (specifier: string): string =>
  `export async function load(): Promise<unknown> {\n  return import(${quote(specifier)});\n}\n`;
const requireCall = (specifier: string): string =>
  `export function load(): unknown {\n  return require(${quote(specifier)});\n}\n`;

type FixturePackage = {
  dir: string;
  name: string;
  deps?: Record<string, string>;
  importsField?: Record<string, unknown>;
  tsconfig?: Record<string, unknown>;
  files?: Record<string, string>;
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function buildWorkspaceFixture(root: string, packages: FixturePackage[]): void {
  writeJson(join(root, 'package.json'), {
    name: 'boundary-fixture-root',
    version: '0.0.0',
    private: true,
    type: 'module',
    workspaces: packages.map((pkg) => pkg.dir),
  });
  for (const pkg of packages) {
    const manifest: Record<string, unknown> = {
      name: pkg.name,
      version: '0.0.0',
      private: true,
      type: 'module',
    };
    if (pkg.deps) {
      manifest.dependencies = pkg.deps;
    }
    if (pkg.importsField) {
      manifest.imports = pkg.importsField;
    }
    writeJson(join(root, pkg.dir, 'package.json'), manifest);
    if (pkg.tsconfig) {
      writeJson(join(root, pkg.dir, 'tsconfig.json'), pkg.tsconfig);
    }
    for (const [relativePath, content] of Object.entries(pkg.files ?? {})) {
      const target = join(root, pkg.dir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    }
  }
}

/** 合法基线：Host→Core 公共入口、CLI→Host 公共入口（清单与源码同时声明）。 */
function baselinePackages(): FixturePackage[] {
  return [
    { dir: 'packages/core', name: PKG_CORE, files: { 'src/index.ts': 'export {};\n' } },
    {
      dir: 'packages/host',
      name: PKG_HOST,
      deps: { [PKG_CORE]: '0.0.0' },
      files: { 'src/index.ts': importFrom(PKG_CORE) },
    },
    {
      dir: 'packages/cli',
      name: PKG_CLI,
      deps: { [PKG_HOST]: '0.0.0' },
      files: { 'src/index.ts': importFrom(PKG_HOST) },
    },
  ];
}

function checkFixture(
  mutate?: (packages: FixturePackage[], root: string) => void,
): BoundaryCheckResult {
  return withTempSandbox(
    (root) => {
      const packages = baselinePackages();
      mutate?.(packages, root);
      buildWorkspaceFixture(root, packages);
      return runBoundaryCheck(root);
    },
    { prefix: 'shiploop-f004-', outside: [repoRoot, homedir()] },
  );
}

function expectDiagnostic(
  result: BoundaryCheckResult,
  rule: string,
  options: { filePart?: string; specifier?: string } = {},
): BoundaryDiagnostic {
  const match = result.diagnostics.find(
    (diagnostic) =>
      diagnostic.rule === rule &&
      (options.filePart === undefined || diagnostic.file.includes(options.filePart)) &&
      (options.specifier === undefined || diagnostic.specifier === options.specifier),
  );
  expect(
    match,
    `expected diagnostic rule=${rule} file~${String(options.filePart)} specifier=${String(
      options.specifier,
    )}; actual diagnostics: ${JSON.stringify(result.diagnostics, null, 2)}`,
  ).toBeDefined();
  return match as BoundaryDiagnostic;
}

function expectClean(result: BoundaryCheckResult): void {
  expect(
    result.diagnostics,
    `expected no diagnostics, got: ${JSON.stringify(result.diagnostics, null, 2)}`,
  ).toEqual([]);
  expect(result.ok).toBe(true);
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

describe('checker wiring and real repository execution', () => {
  it('exposes a pinned npm script and keeps the checker inside the typecheck scope', () => {
    const root = readJson('package.json');
    const scripts = root.scripts as Record<string, unknown>;
    expect(scripts['check:boundaries']).toBe('node scripts/check-boundaries.ts');
    expect(String(scripts['check:boundaries'])).not.toMatch(/\bnpx\b/);
    expect(existsSync(resolve(repoRoot, 'scripts/check-boundaries.ts'))).toBe(true);
    const tsconfig = readJson('tsconfig.json');
    expect(tsconfig.include as string[]).toContain('scripts/**/*.ts');
  });

  it('passes on the real repository in a real subprocess and declares its scan scope', () => {
    const sandbox = newSandbox('shiploop-f004-real-');
    const result = spawnSync(process.execPath, ['scripts/check-boundaries.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: isolatedEnv(sandbox),
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `real repo boundary check must pass:\n${output}`).toBe(0);
    expect(output).toMatch(/PASS/);
    for (const dir of ['packages/core/src', 'packages/host/src', 'packages/cli/src']) {
      expect(output).toContain(dir);
    }
  });
});

describe('positive fixtures: legal one-way dependencies are accepted', () => {
  it('accepts the baseline Host→Core and CLI→Host public-entry dependencies', () => {
    const result = checkFixture();
    expectClean(result);
    expect(result.scope.map((entry) => entry.packageName).sort()).toEqual(
      [PKG_CLI, PKG_CORE, PKG_HOST].sort(),
    );
    for (const entry of result.scope) {
      expect(entry.srcDir.endsWith(join('src'))).toBe(true);
      expect(entry.files.length).toBeGreaterThan(0);
    }
  });

  it('does not falsely reject legal adapter references (ports types, declared vendor, builtins)', () => {
    const result = checkFixture((packages) => {
      const core = packages[0] as FixturePackage;
      core.deps = { 'better-sqlite3': '12.4.1' };
      core.files = {
        'src/index.ts': 'export {};\n',
        'src/ports/store.ts': 'export interface Store {\n  readonly id: string;\n}\n',
        'src/adapters/repo.ts':
          sideEffectImport('better-sqlite3') +
          sideEffectImport('node:fs') +
          importFrom('../ports/store.js'),
      };
    });
    expectClean(result);
  });

  it('accepts declared package imports aliases and tsconfig paths aliases that stay inside src', () => {
    const result = checkFixture((packages) => {
      const core = packages[0] as FixturePackage;
      core.importsField = { '#internal/*': './src/*' };
      core.tsconfig = {
        compilerOptions: { paths: { '@core/*': ['./src/*'] } },
      };
      core.files = {
        'src/index.ts': 'export {};\n',
        'src/domain/rules.ts': 'export const rule = 1;\n',
        'src/ports/store.ts': 'export interface Store {\n  readonly id: string;\n}\n',
        'src/application/usecase.ts':
          sideEffectImport('#internal/ports/store.js') + sideEffectImport('@core/domain/rules.js'),
      };
    });
    expectClean(result);
  });
});

describe('workspace direction rules (negative fixtures rejected)', () => {
  it('rejects Core importing Host (reverse dependency) and names file and target module', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport(PKG_HOST) };
    });
    expect(result.ok).toBe(false);
    const diagnostic = expectDiagnostic(result, 'reverse-dependency', {
      filePart: join('packages/core/src/index.ts'),
      specifier: PKG_HOST,
    });
    expect(diagnostic.line).toBeGreaterThan(0);
  });

  it('rejects Core importing CLI (reverse dependency)', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport(PKG_CLI) };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'reverse-dependency', {
      filePart: join('packages/core/src/index.ts'),
      specifier: PKG_CLI,
    });
  });

  it('rejects CLI importing Core directly (CLI must go through Host)', () => {
    const result = checkFixture((packages) => {
      (packages[2] as FixturePackage).files = {
        'src/index.ts': importFrom(PKG_HOST) + sideEffectImport(PKG_CORE),
      };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'reverse-dependency', {
      filePart: join('packages/cli/src/index.ts'),
      specifier: PKG_CORE,
    });
  });

  it('rejects a package referencing itself by its own package name', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport(PKG_CORE) };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'self-package-reference', {
      filePart: join('packages/core/src/index.ts'),
      specifier: PKG_CORE,
    });
  });

  it('rejects a Host↔CLI circular reference and reports both the direction violation and the cycle', () => {
    const result = checkFixture((packages) => {
      const host = packages[1] as FixturePackage;
      host.deps = { [PKG_CORE]: '0.0.0', [PKG_CLI]: '0.0.0' };
      host.files = { 'src/index.ts': importFrom(PKG_CORE) + sideEffectImport(PKG_CLI) };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'reverse-dependency', {
      filePart: join('packages/host/src/index.ts'),
      specifier: PKG_CLI,
    });
    const cycle = expectDiagnostic(result, 'dependency-cycle');
    expect(cycle.detail).toContain(PKG_HOST);
    expect(cycle.detail).toContain(PKG_CLI);
  });
});

describe('cross-package internal imports (negative fixtures rejected)', () => {
  it('rejects subpath imports into another workspace package', () => {
    const internalSpecifier = `${PKG_CORE}/src/domain/rules.js`;
    const result = checkFixture((packages) => {
      (packages[1] as FixturePackage).files = {
        'src/index.ts': importFrom(PKG_CORE) + sideEffectImport(internalSpecifier),
      };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'cross-package-internal', {
      filePart: join('packages/host/src/index.ts'),
      specifier: internalSpecifier,
    });
  });

  it('rejects relative-path imports that escape the package src root into another package', () => {
    const escapeSpecifier = '../../host/src/index.js';
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport(escapeSpecifier) };
    });
    expect(result.ok).toBe(false);
    const diagnostic = expectDiagnostic(result, 'relative-escape', {
      filePart: join('packages/core/src/index.ts'),
      specifier: escapeSpecifier,
    });
    expect(diagnostic.detail).toContain(`packages${sep}host`);
  });
});

describe('Core contract zone infrastructure bans (negative fixtures rejected)', () => {
  const contractFiles = [
    ['src/domain/rules.ts', 'domain'],
    ['src/application/service.ts', 'application'],
    ['src/ports/store.ts', 'ports'],
    ['src/index.ts', '公共入口'],
  ] as const;
  const infraModules = [PI_SDK, 'electron', 'better-sqlite3', 'drizzle-orm', 'express', 'node:http', 'node:net', 'http'] as const;
  const cases = contractFiles.flatMap(([file, label]) =>
    infraModules.map((specifier) => ({ file, label, specifier })),
  );

  it.each(cases)('rejects $label ($file) importing $specifier', ({ file, specifier }) => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { [file]: sideEffectImport(specifier) };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'core-contract-infra', {
      filePart: join('packages/core', file),
      specifier,
    });
  });

  it('rejects re-exporting infrastructure modules from the public entry (export from)', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': exportFrom('better-sqlite3') };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'core-contract-infra', {
      filePart: join('packages/core/src/index.ts'),
      specifier: 'better-sqlite3',
    });
  });

  it('rejects the public entry and application layer importing Core adapters implementations', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = {
        'src/index.ts': sideEffectImport('./adapters/sqlite.js'),
        'src/application/service.ts': sideEffectImport('../adapters/sqlite.js'),
        'src/adapters/sqlite.ts': 'export const adapter = 1;\n',
      };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'core-layer-direction', {
      filePart: join('packages/core/src/index.ts'),
    });
    expectDiagnostic(result, 'core-layer-direction', {
      filePart: join('packages/core/src/application/service.ts'),
    });
  });

  it('rejects domain importing ports/application and ports importing application', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = {
        'src/index.ts': 'export {};\n',
        'src/domain/rules.ts': sideEffectImport('../ports/store.js'),
        'src/domain/policy.ts': sideEffectImport('../application/service.js'),
        'src/ports/store.ts': sideEffectImport('../application/service.js'),
        'src/application/service.ts': 'export const service = 1;\n',
      };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'core-layer-direction', {
      filePart: join('packages/core/src/domain/rules.ts'),
    });
    expectDiagnostic(result, 'core-layer-direction', {
      filePart: join('packages/core/src/domain/policy.ts'),
    });
    expectDiagnostic(result, 'core-layer-direction', {
      filePart: join('packages/core/src/ports/store.ts'),
    });
  });
});

describe('all import forms are covered (static, export-from, type-only, dynamic, require)', () => {
  const forms = [
    ['static import', (specifier: string) => importFrom(specifier)],
    ['side-effect import', (specifier: string) => sideEffectImport(specifier)],
    ['type-only import', (specifier: string) => typeImportFrom(specifier)],
    ['export from', (specifier: string) => exportFrom(specifier)],
    ['literal dynamic import', (specifier: string) => dynamicImport(specifier)],
    ['literal require', (specifier: string) => requireCall(specifier)],
  ] as const;

  it.each(forms)('rejects Core→Host via %s', (_label, makeSource) => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': makeSource(PKG_HOST) };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'reverse-dependency', {
      filePart: join('packages/core/src/index.ts'),
      specifier: PKG_HOST,
    });
  });

  it('rejects non-literal dynamic import in production sources as unanalyzable', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = {
        'src/index.ts':
          'export async function load(name: string): Promise<unknown> {\n  return import(name);\n}\n',
      };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'non-literal-import', {
      filePart: join('packages/core/src/index.ts'),
    });
  });
});

describe('declared path aliases and resolution failures', () => {
  it('rejects a package imports alias that escapes the package src root', () => {
    const result = checkFixture((packages) => {
      const core = packages[0] as FixturePackage;
      core.importsField = { '#escape': './../host/src/index.js' };
      core.files = { 'src/index.ts': sideEffectImport('#escape') };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'alias-escape', {
      filePart: join('packages/core/src/index.ts'),
      specifier: '#escape',
    });
  });

  it('rejects a tsconfig paths alias that maps into another package', () => {
    const result = checkFixture((packages) => {
      const core = packages[0] as FixturePackage;
      core.tsconfig = { compilerOptions: { paths: { '@host/*': ['../host/src/*'] } } };
      core.files = { 'src/index.ts': sideEffectImport('@host/index.js') };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'alias-escape', {
      filePart: join('packages/core/src/index.ts'),
      specifier: '@host/index.js',
    });
  });

  it('reports an error for an undeclared #-alias instead of defaulting to legal', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport('#ghost') };
    });
    expect(result.ok).toBe(false);
    const diagnostic = expectDiagnostic(result, 'unresolved-import', {
      filePart: join('packages/core/src/index.ts'),
      specifier: '#ghost',
    });
    expect(diagnostic.severity).toBe('error');
  });

  it('reports an error for an unresolvable cross-package reference instead of defaulting to legal', () => {
    const result = checkFixture((packages) => {
      (packages[1] as FixturePackage).files = {
        'src/index.ts': importFrom(PKG_CORE) + sideEffectImport('shiploop-ghost'),
      };
    });
    expect(result.ok).toBe(false);
    const diagnostic = expectDiagnostic(result, 'unresolved-import', {
      filePart: join('packages/host/src/index.ts'),
      specifier: 'shiploop-ghost',
    });
    expect(diagnostic.severity).toBe('error');
  });

  it('reports an error for a relative import whose target file does not exist', () => {
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport('./missing.js') };
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, 'unresolved-import', {
      filePart: join('packages/core/src/index.ts'),
      specifier: './missing.js',
    });
  });
});

describe('scan scope and false-positive robustness', () => {
  it('does not mistake deliberately violating fixture files outside packages/*/src for production sources', () => {
    const result = checkFixture((_packages, root) => {
      for (const relativePath of ['test/fixtures/evil.ts', 'scripts/evil.ts']) {
        const target = join(root, relativePath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, sideEffectImport(PKG_HOST), 'utf-8');
      }
    });
    expectClean(result);
    for (const entry of result.scope) {
      for (const file of entry.files) {
        expect(file).toContain(`${join('src')}${sep}`);
      }
    }
  });

  it('ignores import-like text inside comments and string literals', () => {
    const commentedOut =
      `// ${sideEffectImport(PKG_HOST)}` +
      `/* ${sideEffectImport('better-sqlite3')}*/\n` +
      `const disguised = ${quote(sideEffectImport(PKG_HOST))};\n` +
      'export {};\n';
    const result = checkFixture((packages) => {
      (packages[0] as FixturePackage).files = { 'src/index.ts': commentedOut };
    });
    expectClean(result);
  });
});

describe('checker CLI negative execution (real subprocess)', () => {
  it('exits 1 on a violating fixture tree and the diagnostic names the file and target module', () => {
    const sandbox = newSandbox('shiploop-f004-cli-');
    const packages = baselinePackages();
    (packages[0] as FixturePackage).files = { 'src/index.ts': sideEffectImport(PKG_HOST) };
    buildWorkspaceFixture(sandbox, packages);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, 'scripts/check-boundaries.ts'), '--root', sandbox],
      {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 60_000,
        env: isolatedEnv(sandbox),
      },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `violating fixture must be rejected:\n${output}`).toBe(1);
    expect(output).toContain('reverse-dependency');
    expect(output).toContain(join('packages', 'core', 'src', 'index.ts'));
    expect(output).toContain(PKG_HOST);
  });
});
