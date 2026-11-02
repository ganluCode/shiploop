/**
 * P08-4 / F-005 P08 干净安装与本地 pack 产物的阶段检查接线（fail-closed）。
 *
 * 为 P08 阶段入口的 `p08-installation` 步骤提供安装产物检查：
 * - 在**独立临时目录**读取 P08-1 交付的本地 tarball（复制进一次性 staging 后
 *   只按 staging 内的字节核对），逐包核对包名、版本、文件摘要、bin/exports、
 *   main/types 入口、Node/npm 引擎、平台与依赖闭包；
 * - 以冻结期望范围核对 release manifest（`shiploop.p08.release-manifest`）与
 *   distribution manifest（`shiploop.local.distribution`）声明的协议与 Schema
 *   范围；未知/更高版本策略必须是 reject；
 * - fail-closed：缺少必要产物、workspace/file/link/绝对路径依赖、未构建入口、
 *   闭包缺口、协议或 Schema 越界、Nezha 运行时依赖、Harness 路径引用、个人
 *   绝对路径或疑似凭据，任一命中即整体 failed；
 * - 干净产物证据只来自 staging 内的 tarball 字节：当前开发目录 node_modules
 *   或源码入口的存在不构成通过依据（artifactDir 落在 node_modules 内时直接
 *   失败），报告不含开发机绝对路径；
 * - 记录安装前置、实际工具版本（注入 probe 或实际进程探测）、制品清单、逐项
 *   检查结果与清理状态；真实独立目录 npm 安装、better-sqlite3 原生加载、
 *   Host 启动与 CLI 操作是 Phase 集成事实，登记为 not_run 边界，不折算为通过。
 *
 * 本模块不执行 npm publish/install、git push、模型请求、远端写操作或用户仓库
 * 清理；失败时按调用方提供的 diagnostics 目录保留脱敏、create-once 诊断。
 * 仅使用可擦除 TypeScript 语法；import 本模块无副作用。
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import { parseTarball, validatePackageManifest, type TarEntry } from '../pack-local.ts';
import { p08SanitizeDiagnosticText, validateP08InstallManifest, type P08InstallManifestSummary } from './p08-identity.ts';
import { resolveNpmCli } from './p08-todo-install-smoke.ts';

export const P08_INSTALL_CHECK_SCHEMA_VERSION = 1;
export const P08_INSTALL_CHECK_KIND = 'shiploop.p08.install-check';
export const P08_INSTALL_DISTRIBUTION_MANIFEST_FILE = 'distribution-manifest.json';
export const P08_INSTALL_TARBALL_SUFFIX = '.tgz';

/** 检查 id（稳定顺序即报告展示顺序）。 */
export const P08_INSTALL_CHECK_IDS = [
  'install-preconditions',
  'artifact-manifest',
  'package-identity',
  'file-digests',
  'entries-built',
  'dependency-closure',
  'runtime-isolation',
  'compatibility-scope',
  'content-hygiene',
  'clean-product-evidence',
] as const;
export type P08InstallCheckId = (typeof P08_INSTALL_CHECK_IDS)[number];

/** 显式 not_run 边界（owner=phase-integration），不折算为通过。 */
export const P08_INSTALL_CHECK_NOT_RUN = [
  { id: 'real-install-independent-directory', owner: 'phase-integration', reason: '独立干净目录经本地 tarball 的真实 npm 安装由 Phase 集成执行' },
  { id: 'native-better-sqlite3-loading', owner: 'phase-integration', reason: '安装产物中 better-sqlite3 原生模块的构建与加载由 Phase 集成执行' },
  { id: 'host-startup-packed-artifact', owner: 'phase-integration', reason: '打包产物 Host 真实启动与生命周期由 Phase 集成执行' },
  { id: 'cli-operations-packed-artifact', owner: 'phase-integration', reason: '打包 CLI 的真实命令操作与回执由 Phase 集成执行' },
] as const;

export class P08InstallCheckError extends Error {
  public readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? `p08-install-check: ${code}` : `p08-install-check: ${code}: ${detail}`);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * 输入类型
 * ------------------------------------------------------------------ */

export interface P08InstallExpectedHostProtocol {
  readonly wireProtocolVersions: readonly number[];
  readonly wireSchemaVersion: number;
  readonly legacyHandshakeSchemaVersionsAccepted?: readonly number[];
  readonly discoverySchemaVersions: readonly number[];
  readonly unknownVersionPolicy: string;
}

export interface P08InstallExpectedDatabaseSchema {
  readonly engine: string;
  readonly readableAppliedVersions: { readonly min: number; readonly max: number };
  readonly writableTargetVersion: number;
  readonly higherVersionPolicy: string;
}

export interface P08InstallExpectedScope {
  readonly packages: readonly { readonly name: string; readonly version: string }[];
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
  readonly hostProtocol: P08InstallExpectedHostProtocol;
  readonly databaseSchema: P08InstallExpectedDatabaseSchema;
}

export interface P08InstallToolchainProbeResult {
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly platform: string;
}

type JsonObject = Record<string, unknown>;

export interface P08InstallCheckFinding {
  readonly check: P08InstallCheckId;
  readonly code: string;
  /** 包名或清单内相对文件名；不包含绝对路径。 */
  readonly target: string | null;
  /** 已脱敏诊断（不含开发机绝对路径或凭据）。 */
  readonly detail: string;
}

export interface P08InstallCheckArtifact {
  readonly name: string;
  readonly version: string | null;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly packageManifestSha256: string | null;
  readonly fileCount: number | null;
  readonly bin: readonly string[];
  readonly exportSubpaths: readonly string[];
  readonly dependencies: Readonly<Record<string, string>> | null;
  readonly engines: { readonly node: string; readonly npm: string } | null;
  readonly os: readonly string[] | null;
}

export interface P08InstallCheckReport {
  readonly schemaVersion: typeof P08_INSTALL_CHECK_SCHEMA_VERSION;
  readonly kind: typeof P08_INSTALL_CHECK_KIND;
  readonly status: 'passed' | 'failed';
  readonly identity: { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string } | null;
  readonly environment: {
    readonly nodeVersion: string | null;
    readonly npmVersion: string | null;
    readonly platform: string | null;
    readonly probe: 'injected' | 'process';
  };
  readonly preconditions: {
    readonly artifactSourceFiles: readonly string[];
    readonly releaseManifest: { readonly feature: string | null; readonly distributionMode: string | null; readonly published: boolean | null; readonly toolchainMatch: boolean | null } | null;
    /** 通过证据只来自 staging 内 tarball 字节；开发目录事实不参与判定。 */
    readonly evidenceSource: 'staged-tarball-bytes';
  };
  readonly checks: readonly { readonly id: P08InstallCheckId; readonly status: 'pass' | 'fail' | 'not_run'; readonly reason: string | null; readonly findingCodes: readonly string[] }[];
  readonly findings: readonly P08InstallCheckFinding[];
  readonly artifacts: readonly P08InstallCheckArtifact[];
  readonly inputsDigest: string;
  readonly cleanup: { readonly status: 'completed' | 'failed' | 'skipped'; readonly detail: string };
  readonly notRunBoundary: readonly { readonly id: string; readonly owner: string; readonly reason: string }[];
}

export interface P08InstallCheckRunResult {
  readonly report: P08InstallCheckReport;
  /** 已写诊断文件名（仅 basename，create-once）；未提供目录或未失败时为 null。 */
  readonly diagnosticsFile: string | null;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOCAL_SPEC_PATTERN = /^(?:workspace|file|link):/u;
const DEV_DIRECTORY_PATTERN = /^(?:src|test|node_modules|\.git)(?:\/|$)/u;
const NEZHA_NAME_PATTERN = /nezha/iu;
const NEZHA_MODULE_REFERENCE_PATTERN = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"][^'"]*nezha/iu;
const HARNESS_PATH_PATTERN = /shiploop-harness/iu;
const PERSONAL_PATH_PATTERN = /\/(?:Users|home)\/[A-Za-z0-9._-]+|\/private\/var\/folders\/|\/opt\/homebrew\/|[A-Za-z]:\\/u;
const CREDENTIAL_PATTERNS = [
  /\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/u,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\n]{12,}['"]/iu,
];
const CREDENTIAL_FILE_NAME_PATTERN = /^(?:\.env(?:\.|$)|.*(?:credentials|secret|private-key).*)/iu;

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEquals(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length || !leftKeys.every(key => key in right)) return false;
    return leftKeys.every(key => deepEquals(left[key], right[key]));
  }
  return false;
}

/** './dist/index.js' → 'dist/index.js'；拒绝绝对路径与 `..` 段。 */
function normalizePackageEntryPath(value: string): string | null {
  if (value === '' || value === '.') return null;
  if (isAbsolute(value) || value.split(/[\\/]/u).includes('..')) return null;
  const normalized = value.replace(/^\.\//u, '').split(/[\\/]/u).join('/');
  return normalized === '' ? null : normalized;
}

function readTextEntry(entry: TarEntry): string | null {
  if (entry.data.includes(0)) return null;
  return entry.data.toString('utf8');
}

/* ------------------------------------------------------------------ *
 * 期望范围加载（入口用真实仓库配置；测试可注入）
 * ------------------------------------------------------------------ */

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string')) {
    throw new P08InstallCheckError('expected_scope_invalid', `${label} 必须是非空字符串数组`);
  }
  return value as readonly string[];
}

function requireNumberArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0)) {
    throw new P08InstallCheckError('expected_scope_invalid', `${label} 必须是非空正整数数组`);
  }
  return value as readonly number[];
}

/**
 * 从仓库 `distribution-compatibility.json` 加载期望范围（包名/版本、工具链、
 * 平台、协议与 Schema）。结构或策略不满足冻结契约（local-pack-only、单平台
 * darwin、版本策略必须 reject）时抛出，不猜测降级。
 */
export function loadP08InstallExpectedScope(repoRoot: string): P08InstallExpectedScope {
  let record: JsonObject;
  try {
    record = JSON.parse(readFileSync(join(repoRoot, 'distribution-compatibility.json'), 'utf8')) as JsonObject;
  } catch (error) {
    throw new P08InstallCheckError('expected_scope_invalid', `无法读取 distribution-compatibility.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (record.distributionMode !== 'local-pack-only' || record.published !== false) {
    throw new P08InstallCheckError('expected_scope_invalid', '期望范围必须来自 local-pack-only 且未发布的兼容配置');
  }
  if (!isPlainObject(record.packages)) throw new P08InstallCheckError('expected_scope_invalid', 'packages 表缺失');
  const unifiedVersion = typeof record.unifiedVersion === 'string' ? record.unifiedVersion : null;
  if (unifiedVersion === null) throw new P08InstallCheckError('expected_scope_invalid', 'unifiedVersion 缺失');
  const packages: { name: string; version: string }[] = [];
  for (const key of ['core', 'host', 'cli'] as const) {
    const entry = record.packages[key];
    if (!isPlainObject(entry) || typeof entry.name !== 'string') {
      throw new P08InstallCheckError('expected_scope_invalid', `packages.${key} 缺失`);
    }
    packages.push({ name: entry.name, version: unifiedVersion });
  }
  const platforms = requireStringArray(record.platforms, 'platforms');
  if (platforms.length !== 1 || platforms[0] !== 'darwin') {
    throw new P08InstallCheckError('expected_scope_invalid', '一期期望范围只允许 darwin 单平台');
  }
  if (!isPlainObject(record.toolchain) || typeof record.toolchain.node !== 'string' || typeof record.toolchain.npm !== 'string') {
    throw new P08InstallCheckError('expected_scope_invalid', 'toolchain 缺失');
  }
  if (!isPlainObject(record.hostProtocol)) throw new P08InstallCheckError('expected_scope_invalid', 'hostProtocol 缺失');
  if (!isPlainObject(record.databaseSchema)) throw new P08InstallCheckError('expected_scope_invalid', 'databaseSchema 缺失');
  const readable = isPlainObject(record.databaseSchema.readableAppliedVersions) ? record.databaseSchema.readableAppliedVersions : null;
  if (readable === null || typeof readable.min !== 'number' || typeof readable.max !== 'number' || readable.min < 1 || readable.max < readable.min) {
    throw new P08InstallCheckError('expected_scope_invalid', 'databaseSchema.readableAppliedVersions 非法');
  }
  const writableTarget = record.databaseSchema.writableTargetVersion;
  if (typeof writableTarget !== 'number' || writableTarget < readable.min || writableTarget > readable.max) {
    throw new P08InstallCheckError('expected_scope_invalid', 'databaseSchema.writableTargetVersion 必须落在可读范围内');
  }
  return {
    packages,
    toolchain: { node: record.toolchain.node, npm: record.toolchain.npm, platform: platforms[0] as string },
    hostProtocol: {
      wireProtocolVersions: requireNumberArray(record.hostProtocol.wireProtocolVersions, 'hostProtocol.wireProtocolVersions'),
      wireSchemaVersion: record.hostProtocol.wireSchemaVersion as number,
      legacyHandshakeSchemaVersionsAccepted: record.hostProtocol.legacyHandshakeSchemaVersionsAccepted === undefined
        ? undefined
        : requireNumberArray(record.hostProtocol.legacyHandshakeSchemaVersionsAccepted, 'hostProtocol.legacyHandshakeSchemaVersionsAccepted'),
      discoverySchemaVersions: requireNumberArray(record.hostProtocol.discoverySchemaVersions, 'hostProtocol.discoverySchemaVersions'),
      unknownVersionPolicy: record.hostProtocol.unknownVersionPolicy as string,
    },
    databaseSchema: {
      engine: record.databaseSchema.engine as string,
      readableAppliedVersions: { min: readable.min, max: readable.max },
      writableTargetVersion: writableTarget,
      higherVersionPolicy: record.databaseSchema.higherVersionPolicy as string,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 默认工具链探测（实际进程事实；测试注入替代）
 * ------------------------------------------------------------------ */

function processToolchainProbe(): P08InstallToolchainProbeResult {
  const npmCli = resolveNpmCli();
  const result = spawnSync(npmCli.command, [...npmCli.prefix, '--version'], { encoding: 'utf8', timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new P08InstallCheckError('toolchain_probe_failed', '无法通过实际进程解析 npm 版本');
  }
  return { nodeVersion: process.versions.node, npmVersion: result.stdout.trim(), platform: process.platform };
}

/* ------------------------------------------------------------------ *
 * 检查器
 * ------------------------------------------------------------------ */

interface StagedArtifact {
  readonly record: JsonObject;
  readonly filename: string;
  readonly bytes: Buffer | null;
  readonly sha256: string | null;
  readonly entries: readonly TarEntry[] | null;
  readonly manifestObject: JsonObject | null;
}

class CheckCollector {
  public readonly findings: P08InstallCheckFinding[] = [];
  private readonly checkFindings = new Map<P08InstallCheckId, string[]>();
  private readonly skipped = new Map<P08InstallCheckId, string>();
  private readonly sanitize: (text: string) => string;

  constructor(sanitize: (text: string) => string) {
    this.sanitize = sanitize;
  }

  public add(check: P08InstallCheckId, code: string, target: string | null, detail: string): void {
    this.findings.push({ check, code, target, detail: this.sanitize(detail) });
    const codes = this.checkFindings.get(check) ?? [];
    codes.push(code);
    this.checkFindings.set(check, codes);
  }

  public skip(check: P08InstallCheckId, reason: string): void {
    if (!this.skipped.has(check)) this.skipped.set(check, reason);
  }

  private hasFindings(check: P08InstallCheckId): boolean {
    return (this.checkFindings.get(check)?.length ?? 0) > 0;
  }

  public build(): P08InstallCheckReport['checks'] {
    return P08_INSTALL_CHECK_IDS.map(id => {
      if (this.hasFindings(id)) {
        return { id, status: 'fail' as const, reason: null, findingCodes: [...(this.checkFindings.get(id) ?? [])] };
      }
      const reason = this.skipped.get(id);
      return { id, status: reason === undefined ? ('pass' as const) : ('not_run' as const), reason: reason ?? null, findingCodes: [] };
    });
  }
}

function collectExportTargets(value: unknown, targets: string[]): void {
  if (typeof value === 'string') {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, targets);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) collectExportTargets(entry, targets);
  }
}

function manifestString(manifest: JsonObject, key: string): string | null {
  const value = manifest[key];
  return typeof value === 'string' ? value : null;
}

/** 对 staged 内成功解析的 tarball 执行逐包内容检查。 */
function inspectStagedArtifact(
  checks: CheckCollector,
  artifact: StagedArtifact,
  entries: readonly TarEntry[],
  manifest: JsonObject,
  expected: P08InstallExpectedScope,
  stagedVersions: ReadonlyMap<string, string>,
): void {
  const name = manifestString(manifest, 'name') ?? '<unknown>';
  const version = manifestString(manifest, 'version');
  const expectedPackage = expected.packages.find(pkg => pkg.name === name);
  if (expectedPackage === undefined || version !== expectedPackage.version) {
    checks.add('package-identity', 'identity_mismatch', name, `tarball 身份 ${name}@${version ?? '<null>'} 不在期望包集合内`);
  }
  if (manifest.private !== true) {
    checks.add('package-identity', 'not_private', name, '包清单未声明 private: true');
  }
  try {
    validatePackageManifest(manifest);
  } catch (error) {
    checks.add('package-identity', 'package_manifest_invalid', name,
      `包清单结构校验失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* 文件摘要：tarball 实际内容与 distribution manifest 逐项核对。 */
  if (isPlainObject(artifact.record.fileDigests)) {
    const declared = artifact.record.fileDigests;
    const actual: Record<string, string> = {};
    for (const entry of entries) actual[entry.path] = sha256Hex(entry.data);
    const declaredKeys = Object.keys(declared).sort();
    const actualKeys = Object.keys(actual).sort();
    if (JSON.stringify(declaredKeys) !== JSON.stringify(actualKeys)) {
      checks.add('file-digests', 'file_set_mismatch', name, 'tarball 文件集合与 distribution manifest fileDigests 键集不一致');
    }
    for (const key of declaredKeys) {
      if (declared[key] !== actual[key]) {
        checks.add('file-digests', 'file_digest_mismatch', `${name}:${key}`, '包内文件 sha256 与 distribution manifest 声明不一致');
      }
    }
  } else {
    checks.add('file-digests', 'file_set_mismatch', name, 'distribution manifest 缺少该包的 fileDigests');
  }

  /* 入口已构建：main/types/exports/bin 存在且可执行；无开发目录与未声明文件。 */
  const entryMap = new Map(entries.map(entry => [entry.path, entry]));
  const declaredFiles = Array.isArray(manifest.files) ? manifest.files.filter((file): file is string => typeof file === 'string') : [];
  const isDeclared = (path: string): boolean => path === 'package.json'
    || /^(?:README|LICENSE|LICENCE|CHANGELOG)/iu.test(path)
    || declaredFiles.some(declared => path === declared || path.startsWith(`${declared}/`));
  for (const path of entryMap.keys()) {
    if (DEV_DIRECTORY_PATTERN.test(path)) {
      checks.add('entries-built', 'dev_directory_in_package', `${name}:${path}`, 'tarball 含开发目录文件');
    } else if (!isDeclared(path)) {
      checks.add('entries-built', 'undeclared_file', `${name}:${path}`, 'tarball 文件不在 package.json files 声明内');
    }
  }
  const requireEntry = (rawPath: string, label: string): void => {
    const normalized = normalizePackageEntryPath(rawPath);
    if (normalized === null) {
      checks.add('entries-built', 'unbuilt_entry', `${name}:${label}`, `入口路径非法: ${rawPath}`);
    } else if (!entryMap.has(normalized)) {
      checks.add('entries-built', 'unbuilt_entry', `${name}:${normalized}`, '声明的入口在 tarball 中缺失（未构建）');
    }
  };
  for (const key of ['main', 'types'] as const) {
    const entry = manifestString(manifest, key);
    if (entry !== null) requireEntry(entry, key);
  }
  const exportTargets: string[] = [];
  if (manifest.exports !== undefined) collectExportTargets(manifest.exports, exportTargets);
  for (const target of exportTargets) requireEntry(target, 'exports');
  const binPaths = typeof manifest.bin === 'string' ? [manifest.bin]
    : isPlainObject(manifest.bin) ? Object.values(manifest.bin).filter((value): value is string => typeof value === 'string')
    : [];
  for (const binPath of binPaths) {
    const normalized = normalizePackageEntryPath(binPath);
    if (normalized === null) {
      checks.add('entries-built', 'unbuilt_entry', `${name}:${binPath}`, 'bin 路径非法');
      continue;
    }
    const entry = entryMap.get(normalized);
    if (entry === undefined) {
      checks.add('entries-built', 'unbuilt_entry', `${name}:${normalized}`, 'bin 入口在 tarball 中缺失（未构建）');
      continue;
    }
    if ((entry.mode & 0o111) === 0) {
      checks.add('entries-built', 'bin_not_executable', `${name}:${normalized}`, 'bin 入口缺少可执行位');
    }
    if (!entry.data.subarray(0, 32).toString('utf8').startsWith('#!')) {
      checks.add('entries-built', 'bin_missing_shebang', `${name}:${normalized}`, 'bin 入口缺少 shebang');
    }
  }

  /* 依赖闭包：本地路径 spec、registry 精确版本与内部闭包解析。 */
  const dependencies: Record<string, string> = {};
  for (const tableName of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const table = manifest[tableName];
    if (!isPlainObject(table)) continue;
    for (const [dependencyName, spec] of Object.entries(table)) {
      if (typeof spec !== 'string') continue;
      dependencies[dependencyName] = spec;
      if (LOCAL_SPEC_PATTERN.test(spec) || isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../')) {
        checks.add('dependency-closure', 'local_path_dependency', `${name}:${dependencyName}`,
          `运行时依赖使用本地路径或 workspace spec: ${spec}`);
      }
      if (!EXACT_VERSION_PATTERN.test(spec)) {
        checks.add('dependency-closure', 'non_registry_spec', `${name}:${dependencyName}`, `依赖版本必须是精确 registry 版本: ${spec}`);
      }
      if (NEZHA_NAME_PATTERN.test(dependencyName)) {
        checks.add('runtime-isolation', 'nezha_runtime_dependency', `${name}:${dependencyName}`, '运行时依赖命中 Nezha，安装产物不得依赖开发编排工具');
      }
    }
  }
  for (const [dependencyName, spec] of Object.entries(dependencies)) {
    if (!expected.packages.some(pkg => pkg.name === dependencyName)) continue;
    if (stagedVersions.get(dependencyName) !== spec) {
      checks.add('dependency-closure', 'closure_unresolved', `${name}:${dependencyName}`,
        `内部依赖 ${dependencyName}@${spec} 无法在制品集合内解析（实际 ${stagedVersions.get(dependencyName) ?? '<缺失>'}）`);
    }
  }

  /* 引擎与平台范围（声明时必须与冻结期望一致）。 */
  if (isPlainObject(manifest.engines)) {
    if (manifestString(manifest.engines, 'node') !== null && manifest.engines.node !== expected.toolchain.node) {
      checks.add('compatibility-scope', 'toolchain_scope_mismatch', `${name}:engines.node`, `包引擎 node ${String(manifest.engines.node)} 与冻结期望 ${expected.toolchain.node} 不一致`);
    }
    if (manifestString(manifest.engines, 'npm') !== null && manifest.engines.npm !== expected.toolchain.npm) {
      checks.add('compatibility-scope', 'toolchain_scope_mismatch', `${name}:engines.npm`, `包引擎 npm ${String(manifest.engines.npm)} 与冻结期望 ${expected.toolchain.npm} 不一致`);
    }
  }
  if (Array.isArray(manifest.os)) {
    const platforms = manifest.os.filter((value): value is string => typeof value === 'string');
    if (platforms.length !== 1 || platforms[0] !== expected.toolchain.platform) {
      checks.add('compatibility-scope', 'platform_scope_mismatch', `${name}:os`, `包平台 ${JSON.stringify(platforms)} 与冻结期望 [${expected.toolchain.platform}] 不一致`);
    }
  }

  /* 内容卫生：Nezha 模块引用、Harness 路径、个人绝对路径与疑似凭据。 */
  for (const entry of entries) {
    if (CREDENTIAL_FILE_NAME_PATTERN.test(entry.path)) {
      checks.add('content-hygiene', 'suspected_credential', `${name}:${entry.path}`, '凭据样式文件名');
      continue;
    }
    const text = readTextEntry(entry);
    if (text === null) continue;
    if (NEZHA_MODULE_REFERENCE_PATTERN.test(text)) {
      checks.add('runtime-isolation', 'nezha_import_reference', `${name}:${entry.path}`, '包内容引用 Nezha 模块');
    }
    if (HARNESS_PATH_PATTERN.test(text)) {
      checks.add('runtime-isolation', 'harness_path_reference', `${name}:${entry.path}`, '包内容引用 Harness 路径');
    }
    if (PERSONAL_PATH_PATTERN.test(text)) {
      checks.add('content-hygiene', 'personal_absolute_path', `${name}:${entry.path}`, '包内容含个人绝对路径');
    }
    if (CREDENTIAL_PATTERNS.some(pattern => pattern.test(text))) {
      checks.add('content-hygiene', 'suspected_credential', `${name}:${entry.path}`, '包内容含疑似凭据');
    }
  }
}

/** 比较声明范围与冻结期望：协议、Schema 与拒绝策略必须一致。 */
function compareCompatibilityScope(
  checks: CheckCollector,
  label: string,
  declared: unknown,
  expected: P08InstallExpectedScope,
): void {
  const scope = isPlainObject(declared) ? declared : null;
  if (scope === null || !isPlainObject(scope.hostProtocol) || !isPlainObject(scope.databaseSchema)) {
    checks.add('compatibility-scope', 'protocol_out_of_scope', label, 'compatibility 缺少 hostProtocol/databaseSchema');
    return;
  }
  const expectedProtocol: JsonObject = {
    wireProtocolVersions: expected.hostProtocol.wireProtocolVersions,
    wireSchemaVersion: expected.hostProtocol.wireSchemaVersion,
    discoverySchemaVersions: expected.hostProtocol.discoverySchemaVersions,
    unknownVersionPolicy: expected.hostProtocol.unknownVersionPolicy,
    ...(expected.hostProtocol.legacyHandshakeSchemaVersionsAccepted === undefined
      ? {}
      : { legacyHandshakeSchemaVersionsAccepted: expected.hostProtocol.legacyHandshakeSchemaVersionsAccepted }),
  };
  if (scope.hostProtocol.unknownVersionPolicy !== undefined && scope.hostProtocol.unknownVersionPolicy !== 'reject') {
    checks.add('compatibility-scope', 'reject_policy_missing', label, '未知协议版本策略必须是 reject');
  }
  if (!deepEquals(scope.hostProtocol, expectedProtocol)) {
    checks.add('compatibility-scope', 'protocol_out_of_scope', label, '声明的 hostProtocol 范围与冻结期望不一致');
  }
  const expectedDatabase: JsonObject = {
    engine: expected.databaseSchema.engine,
    readableAppliedVersions: expected.databaseSchema.readableAppliedVersions,
    writableTargetVersion: expected.databaseSchema.writableTargetVersion,
    higherVersionPolicy: expected.databaseSchema.higherVersionPolicy,
  };
  if (scope.databaseSchema.higherVersionPolicy !== undefined && scope.databaseSchema.higherVersionPolicy !== 'reject') {
    checks.add('compatibility-scope', 'reject_policy_missing', label, '更高 Schema 版本策略必须是 reject');
  }
  if (!deepEquals(scope.databaseSchema, expectedDatabase)) {
    checks.add('compatibility-scope', 'schema_out_of_scope', label, '声明的 databaseSchema 范围与冻结期望不一致');
  }
}

/**
 * 执行安装产物检查。返回结构化报告（status=failed 表示 fail-closed 拒绝）；
 * 编程性输入错误（非绝对路径、期望范围缺失等）抛出 P08InstallCheckError。
 */
export function runP08InstallProductCheck(options: {
  readonly artifactDir: string;
  /** P08-1 交付的 release manifest 原始记录（本模块重新做结构校验）。 */
  readonly releaseManifest: unknown;
  readonly expected: P08InstallExpectedScope;
  readonly toolchainProbe?: () => P08InstallToolchainProbeResult;
  /** 失败诊断写入目录（create-once，不覆盖任何已有文件）。 */
  readonly diagnostics?: { readonly dir: string };
  /** 可选运行身份绑定（入口提供 runId/testedCommit）。 */
  readonly identity?: { readonly runId: string; readonly testedCommit: string };
}): P08InstallCheckRunResult {
  if (!isPlainObject(options) || typeof options.artifactDir !== 'string' || options.artifactDir === '') {
    throw new P08InstallCheckError('invalid_input', 'artifactDir 必须是非空字符串');
  }
  if (!isAbsolute(options.artifactDir)) {
    throw new P08InstallCheckError('invalid_input', 'artifactDir 必须是绝对路径');
  }
  if (!isPlainObject(options.expected)) {
    throw new P08InstallCheckError('invalid_input', 'expected 期望范围缺失');
  }

  const sensitiveValues = [options.artifactDir, tmpdir()];
  const sanitize = (text: string): string => p08SanitizeDiagnosticText(text, sensitiveValues);
  const checks = new CheckCollector(sanitize);
  const artifactDir = options.artifactDir;

  /* 1. 安装前置：目录、distribution manifest、release manifest、工具链。 */
  let dirValid = false;
  if (existsSync(artifactDir) && statSync(artifactDir).isDirectory()) {
    dirValid = true;
  } else {
    checks.add('install-preconditions', 'artifact_dir_invalid', null, '产物目录不存在或不是目录');
  }
  let distributionManifest: JsonObject | null = null;
  const manifestPath = join(artifactDir, P08_INSTALL_DISTRIBUTION_MANIFEST_FILE);
  if (dirValid && !existsSync(manifestPath)) {
    checks.add('install-preconditions', 'distribution_manifest_missing', P08_INSTALL_DISTRIBUTION_MANIFEST_FILE, '缺少 distribution-manifest.json');
  } else if (dirValid) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!isPlainObject(parsed)) throw new Error('顶层不是对象');
      distributionManifest = parsed;
    } catch (error) {
      checks.add('install-preconditions', 'distribution_manifest_invalid', P08_INSTALL_DISTRIBUTION_MANIFEST_FILE,
        `distribution-manifest.json 无法解析: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let releaseSummary: P08InstallManifestSummary | null = null;
  const releaseRecord = isPlainObject(options.releaseManifest) ? options.releaseManifest : null;
  try {
    releaseSummary = validateP08InstallManifest(options.releaseManifest);
  } catch (error) {
    checks.add('install-preconditions', 'release_manifest_invalid', null,
      `release manifest 校验失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  let environment: P08InstallCheckReport['environment'] = { nodeVersion: null, npmVersion: null, platform: null, probe: 'injected' };
  const probe = options.toolchainProbe ?? processToolchainProbe;
  try {
    const result = probe();
    environment = { nodeVersion: result.nodeVersion, npmVersion: result.npmVersion, platform: result.platform, probe: options.toolchainProbe === undefined ? 'process' : 'injected' };
    if (result.nodeVersion !== options.expected.toolchain.node || result.npmVersion !== options.expected.toolchain.npm) {
      checks.add('install-preconditions', 'toolchain_mismatch', null,
        `实际工具链 node=${result.nodeVersion} npm=${result.npmVersion} 与冻结期望 node=${options.expected.toolchain.node} npm=${options.expected.toolchain.npm} 不一致`);
    }
    if (result.platform !== options.expected.toolchain.platform) {
      checks.add('install-preconditions', 'toolchain_mismatch', null, `实际平台 ${result.platform} 与冻结期望 ${options.expected.toolchain.platform} 不一致`);
    }
  } catch (error) {
    checks.add('install-preconditions', 'toolchain_probe_failed', null,
      `工具链探测失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (distributionManifest !== null) {
    const toolchain = distributionManifest.toolchain;
    if (distributionManifest.schemaVersion !== 1 || distributionManifest.kind !== 'shiploop.local.distribution'
      || distributionManifest.distributionMode !== 'local-pack-only') {
      checks.add('install-preconditions', 'distribution_manifest_invalid', P08_INSTALL_DISTRIBUTION_MANIFEST_FILE, 'distribution manifest 头部字段非法');
    } else if (!isPlainObject(toolchain) || toolchain.node !== options.expected.toolchain.node
      || toolchain.npm !== options.expected.toolchain.npm || toolchain.packageManager !== 'npm') {
      checks.add('install-preconditions', 'distribution_manifest_invalid', P08_INSTALL_DISTRIBUTION_MANIFEST_FILE, 'distribution manifest 工具链与冻结期望不一致');
    } else if (distributionManifest.platform !== options.expected.toolchain.platform) {
      checks.add('install-preconditions', 'distribution_manifest_invalid', P08_INSTALL_DISTRIBUTION_MANIFEST_FILE, 'distribution manifest 平台与冻结期望不一致');
    }
  }

  /* 2. 独立临时目录 staging：复制清单声明的 tarball，之后只读 staging 字节。 */
  const stagingDir = mkdtempSync(join(tmpdir(), 'p08-install-check-'));
  sensitiveValues.push(stagingDir);
  const sourceFiles: string[] = [P08_INSTALL_DISTRIBUTION_MANIFEST_FILE];
  let manifestArtifacts: JsonObject[] = [];
  if (distributionManifest !== null) {
    manifestArtifacts = Array.isArray(distributionManifest.artifacts) ? distributionManifest.artifacts.filter(isPlainObject) : [];
    if (!Array.isArray(distributionManifest.artifacts)) {
      checks.add('artifact-manifest', 'package_set_mismatch', null, 'distribution manifest artifacts 必须是数组');
    }
  } else {
    for (const id of ['artifact-manifest', 'package-identity', 'file-digests', 'entries-built', 'dependency-closure', 'runtime-isolation', 'content-hygiene'] as const satisfies readonly P08InstallCheckId[]) {
      checks.skip(id, '缺少可解析的 distribution manifest');
    }
  }
  const expectedNames = options.expected.packages.map(pkg => pkg.name).sort();
  const manifestNames = manifestArtifacts.map(record => (typeof record.name === 'string' ? record.name : null)).sort();
  if (distributionManifest !== null && JSON.stringify(manifestNames) !== JSON.stringify(expectedNames)) {
    checks.add('artifact-manifest', 'package_set_mismatch', null, 'distribution manifest 制品集合与期望包集合不一致');
  }
  if (releaseSummary !== null && releaseRecord !== null && Array.isArray(releaseRecord.packages)) {
    const releasePackages = releaseRecord.packages.filter(isPlainObject);
    const releaseNames = releasePackages.map(pkg => (typeof pkg.name === 'string' ? pkg.name : null)).sort();
    if (JSON.stringify(releaseNames) !== JSON.stringify(expectedNames)) {
      checks.add('artifact-manifest', 'package_set_mismatch', 'release-manifest', 'release manifest 包集合与期望包集合不一致');
    }
    for (const pkg of releasePackages) {
      const name = typeof pkg.name === 'string' ? pkg.name : null;
      const expectedPackage = name === null ? undefined : options.expected.packages.find(entry => entry.name === name);
      if (expectedPackage !== undefined && pkg.version !== expectedPackage.version) {
        checks.add('artifact-manifest', 'package_set_mismatch', `release-manifest:${name}`, `版本 ${String(pkg.version)} 与期望 ${expectedPackage.version} 不一致`);
      }
      if (pkg.private !== true) {
        checks.add('package-identity', 'not_private', name, 'release manifest 未声明 private');
      }
    }
  }

  const staged: StagedArtifact[] = [];
  for (const record of manifestArtifacts) {
    const name = typeof record.name === 'string' ? record.name : '<unknown>';
    const version = typeof record.version === 'string' ? record.version : null;
    const filename = typeof record.filename === 'string' ? record.filename : `${name}-${version ?? 'unknown'}${P08_INSTALL_TARBALL_SUFFIX}`;
    if (version !== null && filename !== `${name}-${version}${P08_INSTALL_TARBALL_SUFFIX}`) {
      checks.add('artifact-manifest', 'filename_mismatch', filename, `制品文件名与 ${name}@${version} 身份不一致`);
    }
    sourceFiles.push(filename);
    const sourcePath = join(artifactDir, filename);
    const stagedPath = join(stagingDir, filename);
    if (!dirValid || !existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink()) {
      checks.add('artifact-manifest', 'missing_artifact', filename, '必需 tarball 缺失或不是常规文件');
      staged.push({ record, filename, bytes: null, sha256: null, entries: null, manifestObject: null });
      continue;
    }
    try {
      copyFileSync(sourcePath, stagedPath);
    } catch (error) {
      checks.add('clean-product-evidence', 'staging_failed', filename, `复制到独立 staging 失败: ${error instanceof Error ? error.message : String(error)}`);
      staged.push({ record, filename, bytes: null, sha256: null, entries: null, manifestObject: null });
      continue;
    }
    const bytes = readFileSync(stagedPath);
    const sha256 = sha256Hex(bytes);
    if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256) || record.sha256 !== sha256) {
      checks.add('artifact-manifest', 'artifact_digest_mismatch', filename, 'tarball sha256 与 distribution manifest 声明不一致');
    }
    if (typeof record.size !== 'number' || record.size !== bytes.byteLength) {
      checks.add('artifact-manifest', 'artifact_digest_mismatch', filename, 'tarball 字节数与 distribution manifest 声明不一致');
    }
    let entries: readonly TarEntry[] | null = null;
    let manifestObject: JsonObject | null = null;
    try {
      entries = parseTarball(bytes);
      const packageEntry = entries.find(entry => entry.path === 'package.json');
      if (packageEntry === undefined) throw new Error('tarball 缺少 package.json');
      const parsedManifest: unknown = JSON.parse(packageEntry.data.toString('utf8'));
      if (!isPlainObject(parsedManifest)) throw new Error('package.json 顶层不是对象');
      manifestObject = parsedManifest;
    } catch (error) {
      checks.add('file-digests', 'tarball_unparsable', filename, `tarball 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    staged.push({ record, filename, bytes, sha256, entries, manifestObject });
  }

  /* 3. 逐包内容检查（只针对 staging 内成功解析的 tarball）。 */
  const parsedArtifacts = staged.filter(artifact => artifact.entries !== null && artifact.manifestObject !== null);
  const stagedVersions = new Map<string, string>();
  for (const artifact of parsedArtifacts) {
    const manifest = artifact.manifestObject as JsonObject;
    const name = manifestString(manifest, 'name');
    const version = manifestString(manifest, 'version');
    if (name !== null && version !== null) stagedVersions.set(name, version);
  }
  for (const artifact of parsedArtifacts) {
    inspectStagedArtifact(checks, artifact, artifact.entries as readonly TarEntry[], artifact.manifestObject as JsonObject, options.expected, stagedVersions);
  }

  /* 4. 兼容边界：release manifest 与 distribution manifest 的声明范围。 */
  if (releaseSummary !== null && releaseRecord !== null) {
    compareCompatibilityScope(checks, 'release-manifest', releaseRecord.compatibility, options.expected);
  }
  if (distributionManifest !== null) {
    compareCompatibilityScope(checks, P08_INSTALL_DISTRIBUTION_MANIFEST_FILE, distributionManifest.compatibility, options.expected);
  }

  /* 5. 干净产物证据边界：开发目录捷径不得作为通过依据。 */
  if (artifactDir.split(sep).includes('node_modules')) {
    checks.add('clean-product-evidence', 'dev_workspace_input', null, '产物目录位于 node_modules 内，不能作为干净安装产物来源');
  }

  /* 6. 清理自有 staging 并汇总。 */
  let cleanup: P08InstallCheckReport['cleanup'] = { status: 'completed', detail: '独立 staging 已删除' };
  try {
    rmSync(stagingDir, { recursive: true, force: true });
    if (existsSync(stagingDir)) {
      cleanup = { status: 'failed', detail: '独立 staging 目录仍存在' };
    }
  } catch (error) {
    cleanup = { status: 'failed', detail: sanitize(`staging 清理失败: ${error instanceof Error ? error.message : String(error)}`) };
  }

  const inputsDigest = sha256Hex(JSON.stringify({
    distributionManifest: distributionManifest === null ? null : sha256Hex(readFileSync(manifestPath, 'utf8')),
    tarballs: staged.map(artifact => ({ name: typeof artifact.record.name === 'string' ? artifact.record.name : null, sha256: artifact.sha256 })),
    releaseManifest: sha256Hex(JSON.stringify(options.releaseManifest)),
    expected: options.expected,
  }));
  const report: P08InstallCheckReport = {
    schemaVersion: P08_INSTALL_CHECK_SCHEMA_VERSION,
    kind: P08_INSTALL_CHECK_KIND,
    status: checks.findings.length > 0 ? 'failed' : 'passed',
    identity: options.identity === undefined ? null : { runId: options.identity.runId, testedCommit: options.identity.testedCommit, inputsDigest },
    environment,
    preconditions: {
      artifactSourceFiles: [...sourceFiles].sort(),
      releaseManifest: releaseSummary === null ? null : {
        feature: releaseRecord !== null && typeof releaseRecord.feature === 'string' ? releaseRecord.feature : null,
        distributionMode: releaseSummary.distributionMode,
        published: releaseSummary.published,
        toolchainMatch: releaseSummary.toolchain.node === options.expected.toolchain.node
          && releaseSummary.toolchain.npm === options.expected.toolchain.npm
          && releaseSummary.toolchain.platform === options.expected.toolchain.platform,
      },
      evidenceSource: 'staged-tarball-bytes',
    },
    checks: checks.build(),
    findings: checks.findings,
    artifacts: staged.map(artifact => {
      const manifest = artifact.manifestObject;
      const exportTargets: string[] = [];
      if (manifest !== null && manifest.exports !== undefined) collectExportTargets(manifest.exports, exportTargets);
      const binNames = manifest === null ? []
        : typeof manifest.bin === 'string' ? [manifest.bin]
        : isPlainObject(manifest.bin) ? Object.keys(manifest.bin)
        : [];
      const dependencies: Record<string, string> = {};
      if (manifest !== null) {
        for (const tableName of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
          const table = manifest[tableName];
          if (isPlainObject(table)) {
            for (const [key, value] of Object.entries(table)) {
              if (typeof value === 'string') dependencies[key] = value;
            }
          }
        }
      }
      const engines = manifest !== null && isPlainObject(manifest.engines) ? manifest.engines : null;
      return {
        name: manifestString(manifest ?? {}, 'name') ?? (typeof artifact.record.name === 'string' ? artifact.record.name : basename(artifact.filename)),
        version: manifest === null ? null : manifestString(manifest, 'version'),
        filename: artifact.filename,
        sizeBytes: artifact.bytes?.byteLength ?? 0,
        sha256: artifact.sha256 ?? '',
        packageManifestSha256: artifact.entries !== null
          ? sha256Hex(artifact.entries.find(entry => entry.path === 'package.json')?.data ?? '')
          : null,
        fileCount: artifact.entries?.length ?? null,
        bin: binNames,
        exportSubpaths: exportTargets,
        dependencies: manifest === null ? null : dependencies,
        engines: engines !== null && typeof engines.node === 'string' && typeof engines.npm === 'string'
          ? { node: engines.node, npm: engines.npm }
          : null,
        os: manifest !== null && Array.isArray(manifest.os)
          ? manifest.os.filter((value): value is string => typeof value === 'string')
          : null,
      };
    }).sort((left, right) => left.name.localeCompare(right.name)),
    inputsDigest,
    cleanup,
    notRunBoundary: P08_INSTALL_CHECK_NOT_RUN.map(item => ({ ...item })),
  };

  let diagnosticsFile: string | null = null;
  if (report.status === 'failed' && options.diagnostics !== undefined) {
    mkdirSync(options.diagnostics.dir, { recursive: true });
    const safeRunId = (options.identity?.runId ?? 'no-run-id').replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 64);
    diagnosticsFile = `install-check-${safeRunId}-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(join(options.diagnostics.dir, diagnosticsFile), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  return { report, diagnosticsFile };
}
