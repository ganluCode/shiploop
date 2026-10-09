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

  it('declares only the pinned adapter-layer storage dependencies (P01-2 F-001) in Core; Host 仅声明 F-006 工作区依赖; CLI 仅声明 F-011 工作区依赖', () => {
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
    } else if (dir === 'packages/host') {
      // F-006（契约 §13.4）：Host 启动装配经 Core 公共入口与 ./assembly 子路径
      // 使用 openCoreApplication/deriveDefaultDataRoot，版本随工作区固定；
      // 不引入任何第三方依赖。
      expect(pkg.dependencies).toEqual({ 'shiploop-core': '0.0.0' });
      expect(pkg.devDependencies ?? {}).toEqual({});
      expect(pkg.peerDependencies ?? {}).toEqual({});
      expect(pkg.optionalDependencies ?? {}).toEqual({});
    } else if (dir === 'packages/cli') {
      // F-011（契约 §13.4）：CLI 纯面层只经包名公共面依赖 Host 公共契约；
      // 不直连 Core，不引入任何第三方依赖。
      expect(pkg.dependencies).toEqual({ 'shiploop-host': '0.0.0' });
      expect(pkg.devDependencies ?? {}).toEqual({});
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
    const coreSrcRoot = resolve(repoRoot, 'packages/core/src');
    for (const { file, code } of adapters) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedSpecifiers) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      for (const specifier of specifiers) {
        const isAllowed = allowed.some((name) => specifierMatches(specifier, name));
        // F-004 起 adapters 可经相对路径引用本包 src 内的契约层（adapters→ports/domain
        // 的分层方向由 scripts/check-boundaries.ts 强制）；此处只要求相对导入解析后
        // 仍落在 packages/core/src 之内，不放宽任何厂商禁令。
        const isRelativeInsideSrc =
          (specifier.startsWith('./') || specifier.startsWith('../')) &&
          resolve(dirname(file), specifier).startsWith(coreSrcRoot + sep);
        const isBuiltin = specifier.startsWith('node:') || isRelativeInsideSrc;
        expect(
          isAllowed || isBuiltin,
          `${file} must only import node builtins, package-internal relative sources or the pinned storage stack`,
        ).toBe(true);
      }
    }
  });
});

describe('Host and CLI entry behaviour boundaries', () => {
  const skeletonBannedModules = [
    '@earendil-works/pi-coding-agent',
    'electron',
    'better-sqlite3',
    'drizzle-orm',
    'node:http',
    'node:https',
    'node:net',
  ];
  const skeletonBannedCalls = ['createServer', '.listen('];

  it('F-011 纯面层 + F-012 执行层：公共 barrel 零副作用；bin/execute 只经 shiploop-host 公共面做 I/O', () => {
    const allSources = readSourceTree('packages/cli/src');
    expect(allSources.length, 'packages/cli/src must contain the CLI surface').toBeGreaterThanOrEqual(6);
    // F-012 执行层文件：bin.ts（唯一 argv/env/exit 入口）、host/execute.ts
    // （生命周期 I/O 编排）与 app-execute.ts（F-015 应用命令 I/O 编排）。
    const isExecutionFile = (file: string): boolean =>
      file.endsWith(`${sep}bin.ts`) ||
      file.includes(`${sep}host${sep}execute.ts`) ||
      file.endsWith(`${sep}app-execute.ts`);
    const pureSources = allSources.filter(({ file }) => !isExecutionFile(file));
    expect(pureSources.length, '纯面层至少包含 index/host barrel/args/help/output').toBeGreaterThanOrEqual(5);
    for (const { file, code } of pureSources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of skeletonBannedModules) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      for (const banned of ['node:child_process', 'node:fs', 'node:os', 'node:path', 'node:timers', 'node:crypto']) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not directly import ${banned} (pure parse/help/output layer)`).toHaveLength(0);
      }
      // F-011 唯一外部包依赖是 shiploop-host 包名公共面（不引用内部子路径、不直连 core）。
      for (const specifier of specifiers) {
        if (specifier.startsWith('.')) {
          continue;
        }
        expect(specifier, `${file} may only depend on the shiploop-host public entry`).toBe('shiploop-host');
      }
      const codeWithoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of [...skeletonBannedCalls, 'process.argv', 'process.env', 'process.exit', 'console.']) {
        expect(codeWithoutComments, `${file} must not use ${token}`).not.toContain(token);
      }
    }
    // F-012 执行层同样只允许 shiploop-host 公共面，且不直接做 HTTP/spawn/文件系统。
    const executionSources = allSources.filter(({ file }) => isExecutionFile(file));
    expect(executionSources.map(({ file }) => file.split(sep).pop()).sort()).toEqual([
      'app-execute.ts',
      'bin.ts',
      'execute.ts',
    ]);
    for (const { file, code } of executionSources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of [...skeletonBannedModules, 'node:child_process', 'node:fs', 'node:net', 'shiploop-core']) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      for (const specifier of specifiers) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) {
          continue;
        }
        expect(specifier, `${file} may only depend on the shiploop-host public entry`).toBe('shiploop-host');
      }
    }
    // F-012：显式入口 bin.ts 存在（shebang），package.json bin 指向 dist/bin.js。
    const binFiles = listTsFiles('packages/cli/src').filter((file) => file.endsWith('bin.ts'));
    expect(binFiles).toHaveLength(1);
    const cliPkg = readJson('packages/cli/package.json');
    expect(cliPkg.bin).toEqual({ shiploop: './dist/bin.js' });
    expect(cliPkg.dependencies).toEqual({ 'shiploop-host': '0.0.0' });
    // 公共 barrel 不得 re-export 执行层（import 公共面不得装入 runHostCli）；
    // 只检查 import/export 语句，不禁注释对 F-012 边界的说明。
    const entryImportPattern = /(?:from|import)\s+['"][^'\"]*(?:execute|bin)\.js['"]/;
    expect(readText('packages/cli/src/index.ts')).not.toMatch(entryImportPattern);
    expect(readText('packages/cli/src/host/index.ts')).not.toMatch(entryImportPattern);
  });

  it('packages/host/src 非 runtime/client/launcher 面（contract/storage/locking）仍无网络/进程/ORM/厂商绑定', () => {
    const runtimeDir = resolve(repoRoot, 'packages/host/src/runtime');
    const clientDir = resolve(repoRoot, 'packages/host/src/client');
    const launcherDir = resolve(repoRoot, 'packages/host/src/launcher');
    const sources = readSourceTree('packages/host/src').filter(
      ({ file }) =>
        !file.startsWith(runtimeDir + sep) &&
        !file.startsWith(clientDir + sep) &&
        !file.startsWith(launcherDir + sep) &&
        file !== resolve(repoRoot, 'packages/host/src/start.ts'),
    );
    expect(sources.length, 'host 非 runtime 面扫描必须找到真实源码').toBeGreaterThan(0);
    for (const { file, code } of sources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of [...skeletonBannedModules, 'node:child_process', 'node:dgram', 'node:tls']) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned} at this stage`).toHaveLength(0);
      }
      const codeWithoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of skeletonBannedCalls) {
        expect(codeWithoutComments, `${file} must not use ${token} at this stage`).not.toContain(token);
      }
    }
  });

  it('F-006 runtime 面只允许 node:http 与 shiploop-core 公共入口，禁 ORM/厂商 SDK/其他网络与子进程', () => {
    const runtimeDir = resolve(repoRoot, 'packages/host/src/runtime');
    const sources = readSourceTree('packages/host/src').filter(({ file }) =>
      file.startsWith(runtimeDir + sep),
    );
    // runtime 面必须真实存在（startHost 装配 + 入口逻辑 + 桶文件）。
    expect(sources.length, 'packages/host/src/runtime 必须包含 F-006 启动装配源码').toBeGreaterThanOrEqual(3);
    const bannedInRuntime = [
      '@earendil-works/pi-coding-agent',
      'electron',
      'better-sqlite3',
      'drizzle-orm',
      'express',
      'fastify',
      'koa',
      'hono',
      'node:https',
      'node:net',
      'node:dgram',
      'node:tls',
      'node:child_process',
      'node:cluster',
      'node:worker_threads',
    ];
    for (const { file, code } of sources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedInRuntime) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      // argv 只属于显式入口 start.ts；runtime 模块不直接读 process.argv。
      const codeWithoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(codeWithoutComments, `${file} must not read process.argv directly`).not.toContain('process.argv');
    }
    // 显式执行入口存在且只经 runtime 公共面启动（契约 §13.1）。
    const startEntry = readText('packages/host/src/start.ts');
    expect(startEntry).toContain("from './runtime/index.js'");
    expect(startEntry).toContain('runHostStartEntry');
  });

  it('F-009 client 面只允许 node:http（回环请求）与 node:crypto，禁监听/文件系统/进程/argv', () => {
    const clientDir = resolve(repoRoot, 'packages/host/src/client');
    const sources = readSourceTree('packages/host/src').filter(({ file }) =>
      file.startsWith(clientDir + sep),
    );
    // client 面必须真实存在（HostClient + 传输原语 + 桶文件）。
    expect(sources.length, 'packages/host/src/client 必须包含 F-009 HostClient 源码').toBeGreaterThanOrEqual(3);
    const bannedInClient = [
      '@earendil-works/pi-coding-agent',
      'electron',
      'better-sqlite3',
      'drizzle-orm',
      'shiploop-core',
      'node:https',
      'node:net',
      'node:dgram',
      'node:tls',
      'node:fs',
      'node:child_process',
      'node:cluster',
      'node:worker_threads',
      'node:readline',
    ];
    for (const { file, code } of sources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedInClient) {
        // F-013 唯一例外是经过依赖闭包验证的纯协议入口，根/其他子路径仍拒绝。
        const offenders = specifiers.filter((specifier) =>
          specifierMatches(specifier, banned) && specifier !== 'shiploop-core/protocol');
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      // 客户端绝不监听端口、不读 argv/env（发现/凭据读取一律经 storage/）。
      const codeWithoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of skeletonBannedCalls) {
        expect(codeWithoutComments, `${file} must not use ${token}`).not.toContain(token);
      }
      expect(codeWithoutComments, `${file} must not read process.argv directly`).not.toContain('process.argv');
      expect(codeWithoutComments, `${file} must not read process.env directly`).not.toContain('process.env');
    }
  });

  it('F-010 launcher 面只允许 node:child_process/os/url/path/timers 与 shiploop-core 纯契约入口', () => {
    // launcher/ 是唯一允许 spawn 的面（§12.4 detached 独立 argv 后台候选）；
    // 不读文件系统（发现/凭据经 storage/）、不直连网络（连接经 client/）、
    // 不读 argv、不打开 SQLite（禁止 Core 装配子路径）。
    const launcherDir = resolve(repoRoot, 'packages/host/src/launcher');
    const sources = readSourceTree('packages/host/src').filter(({ file }) =>
      file.startsWith(launcherDir + sep),
    );
    expect(sources.length, 'packages/host/src/launcher 必须包含 F-010 启动器源码').toBeGreaterThanOrEqual(2);
    const bannedInLauncher = [
      '@earendil-works/pi-coding-agent',
      'electron',
      'better-sqlite3',
      'drizzle-orm',
      'express',
      'fastify',
      'koa',
      'hono',
      'shiploop-core/assembly',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      'node:tls',
      'node:fs',
      'node:cluster',
      'node:worker_threads',
      'node:readline',
      'node:crypto',
      'node:perf_hooks',
    ];
    for (const { file, code } of sources) {
      const specifiers = extractModuleSpecifiers(code);
      for (const banned of bannedInLauncher) {
        const offenders = specifiers.filter((specifier) => specifierMatches(specifier, banned));
        expect(offenders, `${file} must not import ${banned}`).toHaveLength(0);
      }
      const codeWithoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of skeletonBannedCalls) {
        expect(codeWithoutComments, `${file} must not use ${token}`).not.toContain(token);
      }
      expect(codeWithoutComments, `${file} must not read process.argv directly`).not.toContain('process.argv');
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
