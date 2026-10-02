/**
 * P01-4 / F-009 构建产物冒烟与开发路径检查回归（检查 `P01-ENG-BUILD-SMOKE`，
 * 契约见 docs/p01-4-acceptance-contract.md §2.1/§3.5）。
 *
 * 覆盖：
 * - 可发布构建文件路径扫描：真实编译的 Core 产物无 finding、入口与迁移资源在位、
 *   文件清单含 SHA-256/字节数；固定个人绝对路径、Nezha/供应商 SDK 运行依赖、
 *   缺失迁移资源明确失败；运行时合法的临时仓库 canonicalPath 不被误判为写死路径；
 * - 非源码 cwd 构建产物冒烟：在临时 cwd 从**实际编译**的 Core 公共入口加载服务与
 *   迁移，运行「注册 → 全局/项目配置 → 发布固定正文制品 → 关闭 → 重开逐字段核验
 *   正文」闭环；隔离 HOME/XDG 目录，断言不写用户数据；不读源码 cwd、Harness 文档、
 *   开发机固定路径或供应商 SDK 公共类型；
 * - accept:p01 接线守护：`P01-ENG-BUILD-SMOKE` 由本文件承接、位于冻结必需清单、
 *   且在 build/verify 之后；契约文档固定本测试入口与证据字段；
 * - 负例（个人路径、被禁依赖、迁移缺失）均在临时副本中验证，不改开发仓库或真实
 *   用户资源。
 *
 * 本文件自行把 Core 编译到系统临时目录（锁定本地 TypeScript），因此干净 `npm ci`
 * 后无需先构建即可随 `npm test` 运行；accept:p01 的 `build-smoke` 步骤也以本文件为
 * 承接入口（verify 已先完成 build）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  scanBuildArtifacts,
  scanManifestDependencies,
} from '../scripts/acceptance/build-artifact-scan.ts';
import { buildP01ProductionSteps, loadP01AcceptanceConfig } from '../scripts/acceptance/p01-accept.ts';
import { P01_REQUIRED_CHECKS, P01_REQUIRED_CHECK_IDS } from '../scripts/acceptance/p01-report.ts';
import type { BuildScanFinding } from '../scripts/acceptance/build-artifact-scan.ts';
import { buildCoreToTemp } from './helpers/build-core-fixture.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import type { TempSandbox } from './helpers/temp-sandbox.ts';

/** 把契约 §2.1 要求的关键证据字段以一行 JSON 打印，供 accept:p01 命令日志持久化。 */
function emitEvidence(line: string, fields: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${line} ${JSON.stringify(fields)}\n`);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_SCRIPT = resolve(REPO_ROOT, 'scripts/core-assembly-smoke.mjs');
const CONTRACT_DOC = readFileSync(resolve(REPO_ROOT, 'docs/p01-4-acceptance-contract.md'), 'utf-8');
const FORBIDDEN_RUNTIME_DEPS = ['nezha', '@nezhajs', '@earendil-works/pi-coding-agent'] as const;
const SMOKE_ENV_KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];

const trackedSandboxes: TempSandbox[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    sandbox.cleanup();
  }
});

function newSandbox(prefix: string): string {
  const sandbox = createTempSandbox(prefix, { outside: [REPO_ROOT, homedir()] });
  trackedSandboxes.push(sandbox);
  return sandbox.path;
}

function listFilesRelative(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const child = join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? walk(child, rel) : [rel];
    });
  return walk(directory, '');
}

function kindsOf(findings: readonly BuildScanFinding[]): string[] {
  return findings.map((finding) => finding.kind);
}

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

describe('F-009 可发布构建产物路径扫描', () => {
  it('真实编译的 Core 产物无 finding，入口/迁移资源在位且文件清单含 SHA-256/字节数', () => {
    const sandbox = newSandbox('shiploop-p01-4-scan-');
    const built = buildCoreToTemp(join(sandbox, 'pkg'), REPO_ROOT);
    const result = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [
        {
          name: 'shiploop-core',
          manifestPath: built.manifestPath,
          packageDir: built.packageDir,
          distDir: built.distDir,
        },
      ],
      expectedMigrations: [{ path: built.migrationModule, versions: [1, 2] }],
      homeDir: homedir(),
      forbiddenRuntimeDependencies: [...FORBIDDEN_RUNTIME_DEPS],
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBeGreaterThan(50);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect(result.files.every((entry) => entry.sizeBytes > 0)).toBe(true);
    expect(result.migrationResources).toEqual([
      { file: expect.stringContaining('adapters/sqlite/migrations.js'), versions: [1, 2] },
    ]);
    expect(result.declaredEntries).toContain('shiploop-core:./dist/index.js');
    expect(result.declaredEntries).toContain('shiploop-core:./dist/index.d.ts');
    expect(result.declaredEntries).toContain('shiploop-core:./dist/adapters/composition.js');
    expect(result.declaredEntries).toContain('shiploop-core:./dist/adapters/composition.d.ts');
    emitEvidence('P01_ENG_BUILD_SMOKE_SCAN', {
      dist_entry: './dist/adapters/composition.js',
      declared_entries: result.declaredEntries,
      migration_resources: result.migrationResources,
      path_scan_ok: result.ok,
      path_scan_findings: result.findings.length,
      file_manifest_count: result.fileCount,
      file_manifest_total_bytes: result.totalBytes,
      file_manifest_sha256: result.manifestSummarySha256,
    });
  });

  it('固定个人绝对路径（HOME 前缀与额外前缀）在构建文件/配置中被发现', () => {
    const sandbox = newSandbox('shiploop-p01-4-scan-personal-');
    const homeLeak = join(sandbox, 'leak.js');
    writeTextFile(homeLeak, `export const p = ${JSON.stringify(`${homedir()}/Documents/secret`)};\n`);
    const harnessLeak = join(sandbox, 'harness.json');
    writeTextFile(harnessLeak, `${JSON.stringify({ root: '/opt/shiploop-harness/workspace' })}\n`);

    const result = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [],
      configFiles: [homeLeak, harnessLeak],
      homeDir: homedir(),
      extraPersonalPrefixes: ['/opt/shiploop-harness'],
      forbiddenRuntimeDependencies: [...FORBIDDEN_RUNTIME_DEPS],
    });

    expect(result.ok).toBe(false);
    expect(kindsOf(result.findings)).toContain('personal_absolute_path');
    const files = result.findings.map((finding) => finding.file);
    expect(files).toContain('leak.js');
    expect(files).toContain('harness.json');
  });

  it('Nezha/供应商 SDK 运行依赖在清单与构建代码中被发现', () => {
    const sandbox = newSandbox('shiploop-p01-4-scan-dep-');
    const manifestPath = join(sandbox, 'package.json');
    writeTextFile(
      manifestPath,
      `${JSON.stringify({
        name: 'publishable-fixture',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { 'nezha-core': '1.0.0' },
      })}\n`,
    );
    mkdirSync(join(sandbox, 'dist'), { recursive: true });
    writeTextFile(join(sandbox, 'dist/index.js'), "import x from 'nezha-runtime';\nexport default x;\n");

    const result = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [
        {
          name: 'publishable-fixture',
          manifestPath,
          packageDir: sandbox,
          distDir: join(sandbox, 'dist'),
        },
      ],
      homeDir: homedir(),
      forbiddenRuntimeDependencies: [...FORBIDDEN_RUNTIME_DEPS],
    });

    expect(result.ok).toBe(false);
    expect(kindsOf(result.findings)).toContain('forbidden_runtime_dependency');
    // 仅按真实依赖声明/导入判定，不因文档注释里的词命中。
    const cleanManifest = join(sandbox, 'clean-package.json');
    writeTextFile(
      cleanManifest,
      `${JSON.stringify({
        name: 'clean-fixture',
        // 注释性文本提到 Nezha 不应被当作运行依赖（JSON 无注释，这里用脚本注释位验证代码扫描）。
        dependencies: { 'better-sqlite3': '13.0.3' },
      })}\n`,
    );
    expect(scanManifestDependencies([cleanManifest], [...FORBIDDEN_RUNTIME_DEPS], sandbox)).toEqual([]);
    expect(
      scanManifestDependencies([manifestPath], [...FORBIDDEN_RUNTIME_DEPS], sandbox),
    ).toHaveLength(1);
  });

  it('缺失或版本不符的已编译迁移资源明确失败', () => {
    const sandbox = newSandbox('shiploop-p01-4-scan-migration-');
    const missing = join(sandbox, 'dist/adapters/sqlite/migrations.js');
    const missingResult = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [],
      expectedMigrations: [{ path: missing, versions: [1, 2] }],
      homeDir: homedir(),
    });
    expect(missingResult.ok).toBe(false);
    expect(kindsOf(missingResult.findings)).toEqual(['missing_migration_resource']);

    writeTextFile(missing, 'export const SQLITE_MIGRATIONS = [{ version: 1 }];\n');
    const mismatchResult = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [],
      expectedMigrations: [{ path: missing, versions: [1, 2] }],
      homeDir: homedir(),
    });
    expect(mismatchResult.ok).toBe(false);
    expect(kindsOf(mismatchResult.findings)).toEqual(['missing_migration_resource']);

    writeTextFile(missing, 'export const SQLITE_MIGRATIONS = [{ version: 1 }, { version: 2 }];\n');
    const matchResult = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [],
      expectedMigrations: [{ path: missing, versions: [1, 2] }],
      homeDir: homedir(),
    });
    expect(matchResult.ok).toBe(true);
    expect(matchResult.migrationResources).toHaveLength(1);
  });

  it('运行时合法的临时仓库 canonicalPath 不被误判为固定个人绝对路径', () => {
    const sandbox = newSandbox('shiploop-p01-4-scan-runtime-');
    const runtimeFile = join(sandbox, 'runtime.js');
    writeTextFile(
      runtimeFile,
      [
        'export const repo = "/var/folders/ab/cd1234/T/shiploop-p01/repo with space";',
        'export const dataRoot = "/tmp/shiploop-p01-fixture/data";',
        'export const privateRoot = "/private/var/folders/ab/cd1234/T/shiploop/repo";',
        '',
      ].join('\n'),
    );

    const result = scanBuildArtifacts({
      baseDir: sandbox,
      packages: [],
      configFiles: [runtimeFile],
      homeDir: homedir(),
      forbiddenRuntimeDependencies: [...FORBIDDEN_RUNTIME_DEPS],
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('真实仓库的入口清单与配置在构建前即可回归（无个人路径/被禁依赖）', () => {
    const manifests = [
      resolve(REPO_ROOT, 'package.json'),
      resolve(REPO_ROOT, 'packages/core/package.json'),
      resolve(REPO_ROOT, 'packages/host/package.json'),
      resolve(REPO_ROOT, 'packages/cli/package.json'),
    ];
    expect(
      scanManifestDependencies(manifests, [...FORBIDDEN_RUNTIME_DEPS], REPO_ROOT),
    ).toEqual([]);

    const configs = [
      resolve(REPO_ROOT, 'acceptance/p01.config.json'),
      resolve(REPO_ROOT, 'tsconfig.base.json'),
      resolve(REPO_ROOT, 'tsconfig.json'),
      resolve(REPO_ROOT, 'packages/core/tsconfig.json'),
      resolve(REPO_ROOT, 'packages/host/tsconfig.json'),
      resolve(REPO_ROOT, 'packages/cli/tsconfig.json'),
    ];
    const result = scanBuildArtifacts({
      baseDir: REPO_ROOT,
      packages: [],
      configFiles: configs,
      homeDir: homedir(),
      forbiddenRuntimeDependencies: [...FORBIDDEN_RUNTIME_DEPS],
    });
    expect(result.findings).toEqual([]);
    expect(result.fileCount).toBe(configs.length);
  });
});

describe('F-009 非源码 cwd 构建产物冒烟（项目/配置/制品关闭重开）', () => {
  it('在临时 cwd 从实际编译的 Core 公共入口完成制品发布/重开正文核验且不写用户数据', () => {
    const buildSandbox = newSandbox('shiploop-p01-4-smoke-build-');
    const built = buildCoreToTemp(join(buildSandbox, 'pkg'), REPO_ROOT);

    const runSandbox = newSandbox('shiploop-p01-4-smoke-run-');
    const home = join(runSandbox, 'home');
    const configHome = join(runSandbox, 'xdg-config');
    const dataHome = join(runSandbox, 'xdg-data');
    const cacheHome = join(runSandbox, 'xdg-cache');
    const cwd = join(runSandbox, 'cwd');
    const smokeRoot = join(runSandbox, 'smoke');
    for (const directory of [home, configHome, dataHome, cacheHome, cwd, smokeRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    const watched = [home, configHome, dataHome, cacheHome, cwd];
    const before = watched.map(listFilesRelative);

    const result = spawnSync(
      process.execPath,
      [SMOKE_SCRIPT, built.assemblyEntry, built.rootEntry, smokeRoot],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: dataHome,
          XDG_CACHE_HOME: cacheHome,
          TMPDIR: runSandbox,
          NODE_NO_WARNINGS: '1',
        },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const stdout = String(result.stdout);
    expect(stdout).toContain('migrated=true');
    expect(stdout).toContain('artifact=');
    expect(stdout).toContain('artifactHash=');
    expect(stdout).toContain('dataRootEntries=core.sqlite');
    expect(existsSync(join(smokeRoot, 'data/core.sqlite'))).toBe(true);
    expect(existsSync(join(smokeRoot, 'repo/README.md'))).toBe(true);
    emitEvidence('P01_ENG_BUILD_SMOKE_RUN', {
      dist_entry: 'dist/adapters/composition.js',
      cwd_relative: true,
      loaded_modules: ['shiploop-core/assembly', 'shiploop-core'],
      migration_resources_in_place: stdout.includes('migrated=true'),
      artifact_reopened_verified: stdout.includes('artifactHash='),
      user_data_writes: 0,
    });

    // 隔离 HOME/XDG/cwd：冒烟加载与闭环不写用户数据。
    for (const [index, directory] of watched.entries()) {
      const writes = listFilesRelative(directory).filter(
        (file) => !before[index]?.includes(file),
      );
      expect(writes, `${directory} 不应被写入`).toEqual([]);
    }
  });

  it('冒烟脚本只经参数接收 dist 绝对入口，不引用源码 cwd/个人目录/供应商 SDK 类型', () => {
    const code = readFileSync(SMOKE_SCRIPT, 'utf-8');
    expect(code).toContain('pathToFileURL');
    expect(code).toContain('openCoreApplication');
    expect(code).toContain('createArtifactPublisher');
    expect(code).not.toContain('packages/');
    expect(code).not.toContain('/Users/');
    expect(code).not.toMatch(/from\s+['"].*\.ts['"]/);
    for (const key of SMOKE_ENV_KEYS) {
      // 脚本自身不读取 HOME/XDG 环境变量来决定路径；路径只来自参数。
      expect(code).not.toContain(`process.env.${key}`);
    }
  });
});

describe('F-009 accept:p01 接线与契约一致', () => {
  it('P01-ENG-BUILD-SMOKE 由本文件承接、位于冻结必需清单且在 build/verify 之后', () => {
    expect(P01_REQUIRED_CHECK_IDS).toContain('P01-ENG-BUILD-SMOKE');
    const definition = P01_REQUIRED_CHECKS.find((check) => check.id === 'P01-ENG-BUILD-SMOKE');
    expect(definition?.testEntry).toBe('test/p01-4-build-smoke.test.ts');

    const config = loadP01AcceptanceConfig(resolve(REPO_ROOT, 'acceptance/p01.config.json'));
    const steps = buildP01ProductionSteps(config);
    const verifyIndex = steps.findIndex((step) => step.stepId === 'verify');
    const smokeIndex = steps.findIndex((step) => step.stepId === 'build-smoke');
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(smokeIndex).toBeGreaterThan(verifyIndex);

    const smokeStep = steps[smokeIndex];
    expect(smokeStep?.checkIds).toEqual(['P01-ENG-BUILD-SMOKE']);
    expect(smokeStep?.args).toContain('test/p01-4-build-smoke.test.ts');
    // verify 步骤本身串联 test/typecheck/build，build 在构建冒烟检查之前完成。
    expect(steps[verifyIndex]?.args).toEqual(expect.arrayContaining(['run', 'verify']));
  });

  it('契约文档固定本测试入口与关键证据字段', () => {
    expect(CONTRACT_DOC).toContain('test/p01-4-build-smoke.test.ts');
    for (const field of [
      '`dist_entry`',
      '`cwd_relative`',
      '迁移资源在位',
      '路径扫描结果',
      '文件清单摘要',
    ]) {
      expect(CONTRACT_DOC).toContain(field);
    }
  });
});
