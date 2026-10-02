/**
 * P01-4 / F-009 构建产物夹具：把 `packages/core` 真实编译到调用方提供的临时目录，
 * 供「非源码 cwd 加载公共入口/迁移」与「可发布构建文件路径扫描」使用。
 *
 * 保证：
 * - 只读取受测仓库源码并在临时目录产出 dist（不写受测仓库、不触碰真实用户资源）；
 * - 临时包根包含：复制的 `package.json`（保持 `type: module`）、指向受测源码的
 *   `src` 软链、指向工作区 `node_modules` 的软链，以及继承受测基础配置的临时
 *   `tsconfig.json`。这样 sourcemap 的 `sources` 保持仓库内相对路径，不会因为
 *   输出目录在仓库之外而把开发机绝对路径写进产物（也不复制依赖、不下载）；
 * - 使用仓库内锁定的本地 TypeScript 编译器（createRequire 解析），不使用 PATH 上
 *   的全局 tsc；缺失即显式失败，不 skip。
 *
 * 本文件不是测试用例（不匹配 *.test.*），由 vitest 配置排除。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export interface BuiltCoreFixture {
  /** 临时包根（含 package.json、src/node_modules 软链、临时 tsconfig 与 dist）。 */
  readonly packageDir: string;
  readonly manifestPath: string;
  readonly distDir: string;
  readonly assemblyEntry: string;
  readonly rootEntry: string;
  readonly migrationModule: string;
}

const BUILD_TIMEOUT_MS = 180_000;

function resolveLocalTypescriptBin(repoRoot: string): string {
  const requireFromRepo = createRequire(resolve(repoRoot, 'package.json'));
  const manifestPath = requireFromRepo.resolve('typescript/package.json');
  return resolve(dirname(manifestPath), 'bin/tsc');
}

/**
 * 在 `root` 下把 Core 编译到 `root/dist`，返回可加载的入口路径。
 * 编译失败、产物缺失或本地编译器缺失一律抛出（不静默跳过）。
 */
export function buildCoreToTemp(root: string, repoRoot: string): BuiltCoreFixture {
  const packageDir = resolve(root);
  const manifestPath = resolve(packageDir, 'package.json');
  const distDir = resolve(packageDir, 'dist');
  const srcDir = resolve(repoRoot, 'packages/core/src');
  const tsconfigPath = resolve(packageDir, 'tsconfig.json');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(resolve(repoRoot, 'packages/core/package.json'), manifestPath);
  // 临时项目：rootDir=src、outDir=dist，其余继承受测基础配置；不启用 composite
  // 以免写入 tsbuildinfo。src/node_modules 以软链指向真实受测资源。
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        $schema: 'https://json.schemastore.org/tsconfig',
        extends: resolve(repoRoot, 'tsconfig.base.json'),
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const links: readonly (readonly [string, string])[] = [
    [resolve(packageDir, 'node_modules'), resolve(repoRoot, 'node_modules')],
    [resolve(packageDir, 'src'), srcDir],
  ];
  for (const [linkPath, target] of links) {
    if (!existsSync(linkPath)) {
      symlinkSync(target, linkPath, 'dir');
    }
  }

  const tscBin = resolveLocalTypescriptBin(repoRoot);
  if (!existsSync(tscBin)) {
    throw new Error(`本地 TypeScript 编译器缺失：${tscBin}`);
  }
  execFileSync(process.execPath, [tscBin, '-p', tsconfigPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    stdio: 'pipe',
  });

  const fixture: BuiltCoreFixture = {
    packageDir,
    manifestPath,
    distDir,
    assemblyEntry: resolve(distDir, 'adapters/composition.js'),
    rootEntry: resolve(distDir, 'index.js'),
    migrationModule: resolve(distDir, 'adapters/sqlite/migrations.js'),
  };
  const required: readonly (readonly [string, string])[] = [
    ['assembly', fixture.assemblyEntry],
    ['root', fixture.rootEntry],
    ['migration', fixture.migrationModule],
  ];
  for (const [label, path] of required) {
    if (!existsSync(path)) {
      throw new Error(`构建产物缺失（${label}）：${path}`);
    }
  }
  return fixture;
}
