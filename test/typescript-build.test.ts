import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = ['packages/core', 'packages/host', 'packages/cli'] as const;
const coreLayerDirs = ['domain', 'application', 'ports', 'adapters'] as const;

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8')) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf-8');
}

function listTsFiles(dir: string): string[] {
  const absoluteDir = resolve(repoRoot, dir);
  if (!existsSync(absoluteDir)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    if (entry === 'node_modules' || entry === 'dist') {
      continue;
    }
    const absoluteEntry = join(absoluteDir, entry);
    if (statSync(absoluteEntry).isDirectory()) {
      const relative = resolve(dir, entry);
      result.push(...listTsFiles(relative));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      result.push(absoluteEntry);
    }
  }
  return result;
}

function readSourceTree(dir: string): { file: string; code: string }[] {
  return listTsFiles(dir).map((file) => ({ file, code: readFileSync(file, 'utf-8') }));
}

/**
 * 提取源码中真实出现的模块说明符（静态 import/export from、副作用 import、
 * 字面量 dynamic import 与 require）。先剔除注释，使“禁止导入 X”的文档注释不会被误判。
 * 这是 F-004 分层依赖检查器的最小前身，当前只服务于入口边界断言。
 */
function extractModuleSpecifiers(code: string): string[] {
  const withoutComments = code
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/^\s*\/\/.*$/gm, '');
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      specifiers.push(match[1] as string);
    }
  }
  return specifiers;
}

function specifierMatches(specifier: string, banned: string): boolean {
  return specifier === banned || specifier.startsWith(`${banned}/`);
}

function asObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  return value as Record<string, unknown>;
}

describe('TypeScript strict toolchain', () => {
  const root = readJson('package.json');
  const scripts = asObject(root.scripts);

  it('provides typecheck and build scripts at the workspace root', () => {
    expect(scripts.typecheck).toBeTypeOf('string');
    expect(String(scripts.typecheck)).toMatch(/tsc/);
    expect(scripts.build).toBeTypeOf('string');
    expect(String(scripts.build)).toMatch(/tsc/);
  });

  it('build runs the built-entry smoke check after compilation', () => {
    expect(String(scripts.build)).toMatch(/scripts\/smoke-built-entries\.ts/);
  });

  it('pins typescript and node types to exact dev dependency versions', () => {
    const devDependencies = asObject(root.devDependencies);
    const typescriptVersion = String(devDependencies.typescript);
    const nodeTypesVersion = String(devDependencies['@types/node']);
    expect(typescriptVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(nodeTypesVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('enables strict mode with NodeNext module resolution in the base config', () => {
    const baseConfig = readJson('tsconfig.base.json');
    const options = asObject(baseConfig.compilerOptions);
    expect(options.strict).toBe(true);
    expect(options.module).toBe('NodeNext');
    expect(options.moduleResolution).toBe('NodeNext');
  });

  it('covers TypeScript tests, engineering scripts and package sources in the root typecheck config', () => {
    const config = readJson('tsconfig.json');
    const include = config.include;
    expect(Array.isArray(include)).toBe(true);
    const globs = include as string[];
    expect(globs).toContain('test/**/*.ts');
    expect(globs).toContain('scripts/**/*.ts');
    for (const dir of packageDirs) {
      expect(globs).toContain(`${dir}/src/**/*.ts`);
    }
    const options = asObject(config.compilerOptions);
    expect(options.noEmit).toBe(true);
  });
});

describe.each(packageDirs)('package build contract: %s', (dir) => {
  const pkg = readJson(`${dir}/package.json`);
  const tsconfig = readJson(`${dir}/tsconfig.json`);

  it('compiles src into dist with declarations via a composite per-package tsconfig', () => {
    expect(tsconfig.extends).toBe('../../tsconfig.base.json');
    const options = asObject(tsconfig.compilerOptions);
    expect(options.rootDir).toBe('src');
    expect(options.outDir).toBe('dist');
    expect(options.composite).toBe(true);
    expect(tsconfig.include).toEqual(['src/**/*.ts']);
  });

  it('points package entry and exports at resolvable dist artifacts', () => {
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    const exportsValue = asObject(pkg.exports)['.'];
    const rootExport = asObject(exportsValue);
    expect(rootExport.types).toBe('./dist/index.d.ts');
    expect(rootExport.default).toBe('./dist/index.js');
    expect(asObject(pkg.files)).toContain('dist');
  });

  it('has a TypeScript public entry source under src', () => {
    expect(existsSync(resolve(repoRoot, dir, 'src/index.ts'))).toBe(true);
  });

  it('declares only the pinned adapter-layer storage dependencies (P01-2 F-001) in Core, none in Host/CLI', () => {
    const pinned = {
      'better-sqlite3': '13.0.3',
      'drizzle-orm': '0.45.3',
    };
    const pinnedDev = {
      '@types/better-sqlite3': '9.6.0',
    };
    if (dir === 'packages/core') {
      expect(pkg.dependencies).toEqual(pinned);
      expect(pkg.devDependencies).toEqual(pinnedDev);
      expect(pkg.peerDependencies ?? {}).toEqual({});
      expect(pkg.optionalDependencies ?? {}).toEqual({});
    } else {
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const value = pkg[key];
        if (value !== undefined) {
          expect(Object.keys(asObject(value)), `${key} must stay empty until actually used`).toHaveLength(0);
        }
      }
    }
  });
});

describe('Core layer boundaries', () => {
  it.each(coreLayerDirs)('documents the ownership and import rules of src/%s', (layer) => {
    const readmePath = `packages/core/src/${layer}/README.md`;
    expect(existsSync(resolve(repoRoot, readmePath)), `${readmePath} is missing`).toBe(true);
    const readme = readText(readmePath);
    expect(readme).toMatch(/允许/);
    expect(readme).toMatch(/禁止/);
  });

  it('keeps the Core contract zone free of vendor SDKs, HTTP and infrastructure drivers', () => {
    const bannedSpecifiers = [
      '@earendil-works/pi-coding-agent',
      'electron',
      'better-sqlite3',
      'drizzle-orm',
      'express',
      'fastify',
      'koa',
      'hono',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
    ];
    // 与 scripts/check-boundaries.ts 的规则一致：禁令覆盖契约区（domain/application/ports/公共入口）；
    // adapters 层允许且仅允许已声明的固定版本驱动/ORM（better-sqlite3、drizzle-orm）。
    const contractZone = readSourceTree('packages/core/src').filter(
      ({ file }) => !file.startsWith(resolve(repoRoot, 'packages/core/src/adapters') + sep),
    );
    expect(
      contractZone.length,
      'contract zone scan must find real sources (domain/application/ports/entry)',
    ).toBeGreaterThan(0);
    for (const { file, code } of contractZone) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedSpecifiers) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
    }
  });

  it('keeps the Core adapters layer free of every vendor module except the pinned storage stack', () => {
    const allowed = ['better-sqlite3', 'drizzle-orm'];
    const bannedSpecifiers = [
      '@earendil-works/pi-coding-agent',
      'electron',
      'express',
      'fastify',
      'koa',
      'hono',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
    ];
    const adapters = readSourceTree('packages/core/src/adapters');
    for (const { file, code } of adapters) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedSpecifiers) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      for (const specifier of specifiers) {
        const isAllowed = allowed.some((name) => specifierMatches(specifier, name));
        const isBuiltin = specifier.startsWith('node:') || specifier.startsWith('./');
        expect(
          isAllowed || isBuiltin,
          `${file} must only import node builtins, relative sources or the pinned storage stack`,
        ).toBe(true);
      }
    }
  });
});

describe('Host and CLI entry behaviour at the skeleton stage', () => {
  const bannedModules = [
    '@earendil-works/pi-coding-agent',
    'electron',
    'better-sqlite3',
    'drizzle-orm',
    'node:http',
    'node:https',
    'node:net',
  ];
  const bannedCalls = ['createServer', '.listen('];

  it.each(['packages/host/src', 'packages/cli/src'] as const)('%s contains no server, model or storage startup code', (dir) => {
    const sources = readSourceTree(dir);
    expect(sources.length, `${dir} must contain at least one TypeScript source file`).toBeGreaterThan(0);
    for (const { file, code } of sources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedModules) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned} at this stage`).toHaveLength(0);
      }
      const codeWithoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of bannedCalls) {
        expect(codeWithoutComments, `${file} must not use ${token} at this stage`).not.toContain(token);
      }
    }
  });
});

describe('built-entry smoke check', () => {
  it('exists as TypeScript engineering script with subprocess, timeout and isolated environment checks', () => {
    const scriptPath = 'scripts/smoke-built-entries.ts';
    expect(existsSync(resolve(repoRoot, scriptPath))).toBe(true);
    const code = readText(scriptPath);
    expect(code).toMatch(/spawn/);
    expect(code).toMatch(/timeout|TIMEOUT/i);
    expect(code).toContain('XDG_CONFIG_HOME');
    expect(code).toContain('packages/core');
    expect(code).toContain('packages/host');
    expect(code).toContain('packages/cli');
  });
});

describe('engineering documentation', () => {
  const readme = readText('README.md');

  it('defines the one-way package dependency direction', () => {
    expect(readme).toContain('单向依赖');
    expect(readme).toContain('Host 可依赖 Core 公共入口');
    expect(readme).toContain('Core 不反向依赖');
    expect(readme).toContain('不导入 Host 启动入口');
  });
});
