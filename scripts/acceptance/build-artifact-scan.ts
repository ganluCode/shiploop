/**
 * P01-4 / F-009 可发布构建产物路径与资源扫描（开发验收工具，非 ShipLoop 业务能力，
 * 不进 packages/，不提供 Host/CLI 业务接口）。
 *
 * 作用：对**实际构建产物**（dist 文件、包清单声明的入口、依赖清单与配置）执行
 * fail-closed 检查，发现以下问题即返回 `ok=false` 并给出结构化 finding：
 * - `personal_absolute_path`：构建文件/清单/配置中出现固定个人绝对路径
 *   （调用方 HOME 前缀或通用 `/<Users|home>/<user>/` 形态）；
 * - `forbidden_runtime_dependency`：包清单依赖或构建代码的模块说明符引用被禁运行
 *   依赖（Nezha、供应商 SDK 等）；只按真实依赖/导入判定，不因文档注释里的词命中；
 * - `missing_declared_entry`：包清单 `main`/`types`/`exports` 声明的产物入口不存在；
 * - `missing_migration_resource`：期望的已编译迁移模块缺失或版本与期望不一致。
 *
 * 不变量：
 * - 只读文件系统（readFile/readdir/stat），不写任何文件、不修改受检仓库；
 * - 只按真实构建产物与清单判定，不以“文档里提到 Nezha”之类文本命中；
 * - 运行时合法的临时仓库/数据根 canonicalPath（如 `/var/folders/...`、`/tmp/...`）
 *   **不**被当作固定个人绝对路径——扫描目标只包含构建文件、入口、依赖清单与配置，
 *   不把运行时输出误判为写死路径；
 * - 输出路径为相对 `baseDir` 的逻辑路径（POSIX），文件清单附 SHA-256 与字节数；
 * - 仅使用 Node 内置模块，import 本模块无副作用。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export type BuildScanFindingKind =
  | 'personal_absolute_path'
  | 'forbidden_runtime_dependency'
  | 'missing_declared_entry'
  | 'missing_migration_resource';

export interface BuildScanFinding {
  readonly kind: BuildScanFindingKind;
  /** 相对 baseDir 的逻辑路径（POSIX）；文件系统之外的目标用清单相对路径。 */
  readonly file: string;
  /** 脱敏诊断：只含类别、命中位置与摘要，不回显整段内容。 */
  readonly detail: string;
}

export interface BuildScanFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** 待检查的可发布包：清单 + 包根 + 构建产物目录。 */
export interface BuildScanPackage {
  readonly name: string;
  /** 包清单绝对路径（package.json）。 */
  readonly manifestPath: string;
  /** 包根绝对路径（清单内相对入口以此为基准）。 */
  readonly packageDir: string;
  /** 构建产物目录绝对路径。 */
  readonly distDir: string;
}

/** 期望存在的已编译迁移模块（绝对路径）与其迁移版本（严格递增）。 */
export interface BuildScanExpectedMigration {
  readonly path: string;
  readonly versions: readonly number[];
}

export interface BuildArtifactScanOptions {
  /** 报告相对路径的基准目录（绝对路径）。 */
  readonly baseDir: string;
  readonly packages: readonly BuildScanPackage[];
  /** 额外整体扫描的文件（配置等绝对路径；缺失即 missing_declared_entry）。 */
  readonly configFiles?: readonly string[];
  readonly expectedMigrations?: readonly BuildScanExpectedMigration[];
  /** 调用方 HOME；其路径前缀命中即视为固定个人绝对路径。 */
  readonly homeDir: string;
  /** 额外固定个人绝对路径前缀（如 Harness 目录）。 */
  readonly extraPersonalPrefixes?: readonly string[];
  /** 禁止作为运行依赖/导入出现的包名（精确或子路径/scope 前缀）。 */
  readonly forbiddenRuntimeDependencies?: readonly string[];
}

export interface BuildScanResult {
  readonly ok: boolean;
  readonly findings: readonly BuildScanFinding[];
  readonly files: readonly BuildScanFileEntry[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly manifestSummarySha256: string;
  readonly migrationResources: readonly {
    readonly file: string;
    readonly versions: readonly number[];
  }[];
  readonly declaredEntries: readonly string[];
}

const SCANNABLE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.d.ts',
  '.ts',
  '.mts',
  '.cts',
  '.json',
  '.map',
] as const;

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function toLogicalPath(baseDir: string, absolutePath: string): string {
  const rel = relative(resolve(baseDir), resolve(absolutePath));
  if (rel.length === 0) {
    return '.';
  }
  if (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..') {
    return rel.split(sep).join('/');
  }
  // 受检目标在 baseDir 之外（如系统临时构建目录）：只报告 basename，避免
  // 把调用方的绝对路径写进证据。
  return `<external>/${basename(absolutePath)}`;
}

function isScannableFile(fileName: string): boolean {
  return SCANNABLE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

function listFilesRecursive(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const stats = statSync(directory);
  if (!stats.isDirectory()) {
    return [directory];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(child);
    }
    if (!entry.isFile()) {
      return []; // 不跟随符号链接或特殊文件。
    }
    return [child];
  });
}

/** 提取真实模块说明符（先剔除注释，避免“禁止导入 X”注释误判）。 */
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

function isForbiddenDependency(specifier: string, forbidden: readonly string[]): boolean {
  const lower = specifier.toLowerCase();
  return forbidden.some((name) => {
    const target = name.toLowerCase();
    // 精确名、scope/子路径、以及带连字符/点分后缀的变体（如 nezha-core、
    // @nezha/runtime）均视为同一被禁运行依赖；只按真实依赖/导入判定。
    return lower === target || lower.includes(target);
  });
}

function detectPersonalAbsolutePath(
  text: string,
  homeDir: string,
  extraPrefixes: readonly string[],
): string | null {
  for (const raw of [homeDir, ...extraPrefixes]) {
    const prefix = raw.replace(/[/\\]+$/, '');
    if (prefix.length === 0) {
      continue;
    }
    if (text.includes(`${prefix}/`) || text.includes(`${prefix}\\`)) {
      return prefix;
    }
  }
  const generic = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//.exec(text);
  return generic === null ? null : generic[0];
}

function extractMigrationVersions(code: string): number[] | null {
  const declarationIndex = code.indexOf('SQLITE_MIGRATIONS');
  const region = declarationIndex >= 0 ? code.slice(declarationIndex) : code;
  const versions = [...region.matchAll(/version:\s*(\d+)/g)].map((match) => Number(match[1]));
  return versions.length === 0 ? null : versions;
}

interface PackageManifestShape {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly types?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly optionalDependencies?: unknown;
}

function collectDeclaredEntries(manifest: PackageManifestShape): string[] {
  const targets: string[] = [];
  const pushTarget = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('./')) {
      targets.push(value);
    }
  };
  pushTarget(manifest.main);
  pushTarget(manifest.types);
  if (manifest.exports !== null && typeof manifest.exports === 'object') {
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        pushTarget(value);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) {
          walk(nested);
        }
      }
    };
    walk(manifest.exports);
  }
  return targets;
}

function collectDependencyNames(manifest: PackageManifestShape): string[] {
  const names: string[] = [];
  for (const section of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ]) {
    if (section !== null && typeof section === 'object') {
      names.push(...Object.keys(section));
    }
  }
  return names;
}

/**
 * 只检查包清单的运行依赖声明是否引用了被禁依赖（不要求 dist 存在）。
 * 用于构建前的快速回归与后续包清单漂移防护。
 */
export function scanManifestDependencies(
  manifestPaths: readonly string[],
  forbiddenRuntimeDependencies: readonly string[],
  baseDir?: string,
): BuildScanFinding[] {
  const reportedBase = baseDir === undefined ? undefined : resolve(baseDir);
  const findings: BuildScanFinding[] = [];
  for (const manifestPath of manifestPaths) {
    const file =
      reportedBase === undefined
        ? basename(manifestPath)
        : toLogicalPath(reportedBase, manifestPath);
    if (!existsSync(manifestPath)) {
      findings.push({ kind: 'missing_declared_entry', file, detail: '等待检查的包清单不存在' });
      continue;
    }
    let manifest: PackageManifestShape;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackageManifestShape;
    } catch (error) {
      findings.push({
        kind: 'missing_declared_entry',
        file,
        detail: `包清单无法解析：${(error as Error).message}`,
      });
      continue;
    }
    for (const dependency of collectDependencyNames(manifest)) {
      if (isForbiddenDependency(dependency, forbiddenRuntimeDependencies)) {
        findings.push({
          kind: 'forbidden_runtime_dependency',
          file,
          detail: `声明了被禁运行依赖（name SHA-256 ${sha256Hex(dependency).slice(0, 12)}）`,
        });
      }
    }
  }
  return findings;
}

/**
 * 扫描可发布构建产物、入口、依赖清单与配置。返回结构化结果；`ok` 仅当没有任何
 * finding。manifestSummarySha256 覆盖文件清单（路径 + SHA-256），供证据引用。
 */
export function scanBuildArtifacts(options: BuildArtifactScanOptions): BuildScanResult {
  const baseDir = resolve(options.baseDir);
  const forbidden = options.forbiddenRuntimeDependencies ?? ['nezha', '@nezhajs'];
  const extraPrefixes = options.extraPersonalPrefixes ?? [];
  const findings: BuildScanFinding[] = [];
  const fileEntries = new Map<string, BuildScanFileEntry>();
  const declaredEntrySet = new Set<string>();
  const migrationResources: { file: string; versions: readonly number[] }[] = [];

  const recordFinding = (kind: BuildScanFindingKind, file: string, detail: string): void => {
    findings.push({ kind, file, detail });
  };

  const scanFileContent = (absolutePath: string): void => {
    if (fileEntries.has(absolutePath)) {
      return;
    }
    const content = readFileSync(absolutePath);
    fileEntries.set(absolutePath, {
      path: toLogicalPath(baseDir, absolutePath),
      sha256: sha256Hex(content),
      sizeBytes: content.byteLength,
    });
    if (!isScannableFile(absolutePath)) {
      return;
    }
    const text = content.toString('utf-8');
    const personal = detectPersonalAbsolutePath(text, options.homeDir, extraPrefixes);
    if (personal !== null) {
      recordFinding(
        'personal_absolute_path',
        toLogicalPath(baseDir, absolutePath),
        `固定个人绝对路径前缀命中（${sha256Hex(personal).slice(0, 12)}）`,
      );
    }
    for (const specifier of extractModuleSpecifiers(text)) {
      if (isForbiddenDependency(specifier, forbidden)) {
        recordFinding(
          'forbidden_runtime_dependency',
          toLogicalPath(baseDir, absolutePath),
          `构建代码导入了被禁运行依赖（specifier SHA-256 ${sha256Hex(specifier).slice(0, 12)}）`,
        );
        break;
      }
    }
  };

  for (const pkg of options.packages) {
    if (!existsSync(pkg.manifestPath)) {
      recordFinding(
        'missing_declared_entry',
        toLogicalPath(baseDir, pkg.manifestPath),
        `包 ${pkg.name} 的清单不存在`,
      );
      continue;
    }
    scanFileContent(pkg.manifestPath);

    let manifest: PackageManifestShape;
    try {
      manifest = JSON.parse(readFileSync(pkg.manifestPath, 'utf-8')) as PackageManifestShape;
    } catch (error) {
      recordFinding(
        'missing_declared_entry',
        toLogicalPath(baseDir, pkg.manifestPath),
        `包 ${pkg.name} 清单无法解析：${(error as Error).message}`,
      );
      continue;
    }

    for (const dependency of collectDependencyNames(manifest)) {
      if (isForbiddenDependency(dependency, forbidden)) {
        recordFinding(
          'forbidden_runtime_dependency',
          toLogicalPath(baseDir, pkg.manifestPath),
          `包 ${pkg.name} 声明了被禁运行依赖（name SHA-256 ${sha256Hex(dependency).slice(0, 12)}）`,
        );
      }
    }

    for (const entry of collectDeclaredEntries(manifest)) {
      declaredEntrySet.add(`${pkg.name}:${entry}`);
      const entryPath = resolve(pkg.packageDir, entry);
      if (!existsSync(entryPath)) {
        recordFinding(
          'missing_declared_entry',
          toLogicalPath(baseDir, entryPath),
          `包 ${pkg.name} 声明的入口不存在：${entry}`,
        );
      } else {
        scanFileContent(entryPath);
      }
    }

    for (const file of listFilesRecursive(pkg.distDir)) {
      scanFileContent(file);
    }
  }

  for (const configFile of options.configFiles ?? []) {
    if (!existsSync(configFile)) {
      recordFinding(
        'missing_declared_entry',
        toLogicalPath(baseDir, configFile),
        '必需配置文件不存在',
      );
      continue;
    }
    scanFileContent(configFile);
  }

  for (const migration of options.expectedMigrations ?? []) {
    const logical = toLogicalPath(baseDir, migration.path);
    if (!existsSync(migration.path)) {
      recordFinding('missing_migration_resource', logical, '已编译迁移模块缺失');
      continue;
    }
    scanFileContent(migration.path);
    const versions = extractMigrationVersions(readFileSync(migration.path, 'utf-8'));
    if (versions === null) {
      recordFinding('missing_migration_resource', logical, '迁移模块未声明任何版本');
      continue;
    }
    const expected = migration.versions;
    const matches =
      versions.length === expected.length && versions.every((value, index) => value === expected[index]);
    if (!matches) {
      recordFinding(
        'missing_migration_resource',
        logical,
        `迁移版本与期望不一致（实际 ${versions.length} 项，期望 ${expected.length} 项）`,
      );
      continue;
    }
    migrationResources.push({ file: logical, versions: [...versions] });
  }

  const files = [...fileEntries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const totalBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const manifestSummarySha256 = sha256Hex(
    files.map((entry) => `${entry.path}\t${entry.sha256}\t${entry.sizeBytes}`).join('\n'),
  );

  return {
    ok: findings.length === 0,
    findings,
    files,
    fileCount: files.length,
    totalBytes,
    manifestSummarySha256,
    migrationResources,
    declaredEntries: [...declaredEntrySet].sort(),
  };
}
