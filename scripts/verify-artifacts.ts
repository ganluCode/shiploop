/**
 * P08-1 F-003 可审阅的制品完整性与兼容检查器（fail-closed 工程脚本）。
 *
 * 输入：本地 pack 输出目录（tarball + distribution-manifest.json）与仓库内的
 * 版本清单（distribution-compatibility.json、根/工作区 package.json、package-lock.json）。
 * 检查（任一身份或摘要不匹配即失败）：
 * 1. distribution-manifest   清单头、工具链、平台与制品集合完整性；
 * 2. commit-identity         制品清单 commit 与检查环境实际 commit 一致（漂移即失败）；
 * 3. artifact-identity       tarball 名称/版本/文件名/sha256/size/package.json 摘要/统一版本；
 * 4. tarball-file-digests    文件清单与逐文件 SHA-256 摘要重算比对；
 * 5. packaged-entries        main/types/exports/bin 入口存在、bin 可执行且带 shebang、
 *                            文件不越出 files 白名单、无开发目录；
 * 6. workspace-manifest-parity  tarball package.json 与工作区版本清单逐字段一致；
 * 7. dependency-closure      依赖闭包：registry spec（拒绝悬空 workspace/file/link）、
 *                            与工作区声明一致、可在 package-lock 闭包内解析、
 *                            发行代码裸导入必须已声明（未声明的开发依赖拒绝）；
 * 8. protocol-scope          Host 协议范围与真实代码常量一致；未知协议/握手/发现版本
 *                            拒绝（unknownVersionPolicy=reject，不猜测降级）；
 * 9. database-schema-scope   数据库 Schema 读写范围与实际迁移链一致；高版本拒绝；
 * 10. sensitive-content      凭据样式文件名/内容、token/key、开发机绝对路径，诊断脱敏；
 * 11. phase-integration-scope  Phase 集成项（真实安装/原生模块/Host 启动/兼容矩阵）
 *                            必须显式声明为 not_run，不折算为通过。
 *
 * 结构化结果：区分 passed/failed/not_run，包含实际 commit、工具版本、检查对象与
 * 证据引用（输入摘要）；命令退出码由逐项检查推导，不以“退出 0/包存在”文字代替核对。
 *
 * 不变量：检查过程只读（不写受检目录、不改仓库/数据库/发布权限/远端引用），
 * 不调用真实模型、npm publish 或外部 Webhook；库函数无副作用，CLI 仅写报告文件。
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TAR_BLOCK_SIZE = 512;
const MANIFEST_FILE = 'distribution-manifest.json';
const COMPATIBILITY_FILE = 'distribution-compatibility.json';
const SCAN_BYTE_LIMIT = 4 * 1024 * 1024;

export type WorkspacePackageSpec = { readonly id: string; readonly directory: string; readonly name: string };

export type CheckEnvironment = {
  /** 检查环境实际 Git commit（40 位十六进制）。 */
  readonly gitCommit: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly platform: string;
};

export type ExpectedProtocolScope = {
  /** 真实代码支持的线协议版本集合（Host 契约常量）。 */
  readonly supportedProtocolVersions: readonly number[];
  readonly currentWireSchemaVersion: number;
  readonly legacyHandshakeSchemaVersionsAccepted: readonly number[];
  readonly discoverySchemaVersions: readonly number[];
};

export type ExpectedDatabaseScope = {
  readonly engine: 'sqlite';
  /** 实际迁移链的最小/最大版本（writable 目标 = 最大版本）。 */
  readonly minMigrationVersion: number;
  readonly maxMigrationVersion: number;
};

export type ArtifactCheckStatus = 'passed' | 'failed';

export interface ArtifactCheck {
  /** 稳定检查 id（kebab-case）。 */
  readonly id: string;
  readonly title: string;
  readonly status: ArtifactCheckStatus;
  /** 本次核对的检查对象（逻辑标签，不含绝对路径）。 */
  readonly objects: readonly string[];
  /** 脱敏后的失败明细；passed 时为空数组。 */
  readonly problems: readonly string[];
}

export interface NotRunRecord {
  readonly id: string;
  readonly reason: string;
  readonly owner: 'phase-integration';
}

export interface EvidenceReference {
  readonly kind: 'distribution-manifest' | 'compatibility' | 'tarball' | 'checker';
  readonly label: string;
  readonly sha256: string;
}

export interface ArtifactVerificationReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.artifact-verification';
  readonly generatedAt: string;
  /** 仅当全部检查 passed 时为 true；not_run 不折算。 */
  readonly passed: boolean;
  readonly environment: CheckEnvironment;
  readonly inputs: {
    readonly distribution: string;
    readonly distributionManifest: { readonly label: string; readonly sha256: string } | null;
    readonly compatibility: { readonly label: string; readonly sha256: string } | null;
    readonly artifacts: readonly { readonly name: string; readonly version: string; readonly filename: string; readonly sha256: string | null }[];
  };
  readonly checks: readonly ArtifactCheck[];
  readonly notRun: readonly NotRunRecord[];
  readonly evidence: readonly EvidenceReference[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly notRun: number };
}

export interface VerifyArtifactsOptions {
  readonly repoRoot: string;
  readonly distributionDir: string;
  readonly packages: readonly WorkspacePackageSpec[];
  readonly environment: CheckEnvironment;
  readonly protocolScope: ExpectedProtocolScope;
  readonly databaseScope: ExpectedDatabaseScope;
  /** 报告中的分发目录逻辑标签（默认 'distribution'，不得写绝对路径）。 */
  readonly distributionLabel?: string;
}

type JsonObject = Record<string, unknown>;

type TarEntry = { path: string; data: Buffer; mode: number };

type TarAnalysis = {
  readonly files: readonly string[];
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly entries: ReadonlyMap<string, { readonly data: Buffer; readonly mode: number }>;
  readonly tarManifest: JsonObject | null;
};

type ArtifactState = {
  readonly spec: WorkspacePackageSpec;
  readonly record: JsonObject | null;
  readonly recordProblems: readonly string[];
  readonly tarballPath: string;
  readonly tarballExists: boolean;
  readonly actualSha256: string | null;
  readonly actualSize: number | null;
  readonly analysis: TarAnalysis | null;
  readonly analysisProblem: string | null;
};

function hashHex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 键排序后的规范 JSON（结构比较与键序无关）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sortedNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isInteger(item))) {
    return null;
  }
  return [...(value as number[])].sort((a, b) => a - b);
}

function sameNumberSet(declared: readonly number[], expected: readonly number[]): boolean {
  return JSON.stringify([...declared].sort((a, b) => a - b)) === JSON.stringify([...expected].sort((a, b) => a - b));
}

function normalizePackagePath(path: string): string {
  return path.replace(/^\.\//u, '');
}

function isUnsafeRelativePath(path: string): boolean {
  return isAbsolute(path) || path === '' || path.split(/[\\/]/u).includes('..');
}

function readTextOrProblem(path: string): { text: string | null; problem: string | null } {
  if (!existsSync(path)) {
    return { text: null, problem: `缺少文件：${basename(path)}` };
  }
  try {
    return { text: readFileSync(path, 'utf8'), problem: null };
  } catch (error) {
    return { text: null, problem: `无法读取 ${basename(path)}：${(error as Error).message}` };
  }
}

function parseJsonOrProblem(text: string | null, label: string): { value: JsonObject | null; problem: string | null } {
  if (text === null) {
    return { value: null, problem: null };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) {
      return { value: null, problem: `${label} 不是 JSON 对象` };
    }
    return { value: parsed, problem: null };
  } catch (error) {
    return { value: null, problem: `${label} 无法解析：${(error as Error).message}` };
  }
}

/** ---------- tar 解析（独立实现，与打包器互为交叉核对） ---------- */

function readOctal(buffer: Buffer, start: number, length: number): number {
  const text = buffer.subarray(start, start + length).toString('ascii').replaceAll('\0', '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '');
}

function parsePaxPath(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(0x0a, offset);
    if (end < 0) break;
    const record = data.subarray(offset, end).toString('utf8');
    const separator = record.indexOf(' ');
    if (separator >= 0 && record.slice(separator + 1).startsWith('path=')) {
      return record.slice(separator + 6);
    }
    offset = end + 1;
  }
  return undefined;
}

function parseTarEntries(buffer: Buffer): TarEntry[] {
  const tar = gunzipSync(buffer);
  const entries: TarEntry[] = [];
  let offset = 0;
  let paxPath: string | undefined;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('tarball 条目被截断');
    const type = readTarString(header, 156, 1) || '0';
    const name = paxPath ?? `${readTarString(header, 345, 155)}${readTarString(header, 0, 100)}`;
    paxPath = undefined;
    if (type === 'x' || type === 'g') {
      paxPath = parsePaxPath(tar.subarray(dataStart, dataEnd));
    } else if (type === '0') {
      const normalized = name.startsWith('package/') ? name.slice('package/'.length) : name;
      if (isUnsafeRelativePath(normalized)) throw new Error(`tarball 条目路径不安全：${normalized}`);
      entries.push({ path: normalized, data: Buffer.from(tar.subarray(dataStart, dataEnd)), mode: readOctal(header, 100, 8) });
    } else if (type !== '5') {
      throw new Error(`tarball 含不支持的非文件条目：${name}`);
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return entries;
}

function analyzeTarball(tarballPath: string): TarAnalysis {
  const entries = parseTarEntries(readFileSync(tarballPath));
  const entryMap = new Map(entries.map((entry) => [entry.path, { data: entry.data, mode: entry.mode }]));
  const fileDigests: Record<string, string> = {};
  for (const [path, entry] of entryMap) {
    fileDigests[path] = hashHex(entry.data);
  }
  const files = Object.keys(fileDigests).sort((a, b) => a.localeCompare(b));
  const packageEntry = entryMap.get('package.json');
  let tarManifest: JsonObject | null = null;
  if (packageEntry !== undefined) {
    const parsed: unknown = JSON.parse(packageEntry.data.toString('utf8'));
    if (!isObject(parsed)) throw new Error('tarball package.json 不是 JSON 对象');
    tarManifest = parsed;
  }
  return { files, fileDigests, entries: entryMap, tarManifest };
}

/** 供测试/证据工具使用的无校验 tarball 摘要（不做任何完整性判断）。 */
export function inspectTarball(tarballPath: string): {
  readonly size: number;
  readonly sha256: string;
  readonly files: readonly string[];
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly packageManifest: JsonObject | null;
} {
  const bytes = readFileSync(tarballPath);
  const analysis = analyzeTarball(tarballPath);
  return {
    size: bytes.byteLength,
    sha256: hashHex(bytes),
    files: analysis.files,
    fileDigests: analysis.fileDigests,
    packageManifest: analysis.tarManifest,
  };
}

/** ---------- 敏感内容与模块说明符扫描 ---------- */

const CREDENTIAL_FILE_NAME_PATTERN = /^(?:\.env(?:\.|$)|.*(?:credentials|secret|private-key|id_rsa).*)/iu;
const CREDENTIAL_CONTENT_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'token-literal', pattern: /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/u },
  { id: 'aws-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/u },
  { id: 'key-assignment', pattern: /\b(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"\n]{12,}['"]/iu },
];
const DEV_PATH_PATTERN = /\/(?:Users|home|private\/var\/folders|opt\/homebrew)\//u;
const LOCAL_SPEC_PATTERN = /(?:workspace|file|link):/u;

function scanSensitiveText(text: string): readonly string[] {
  const hits: string[] = [];
  for (const { id, pattern } of CREDENTIAL_CONTENT_PATTERNS) {
    if (pattern.test(text)) hits.push(id);
  }
  if (DEV_PATH_PATTERN.test(text)) hits.push('developer-absolute-path');
  return hits;
}

/** 提取真实模块说明符（逐行锚定 + 剔除注释；tsc 输出的 import/export 均为行首单行语句）。 */
function extractModuleSpecifiers(code: string): readonly string[] {
  const withoutComments = code.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');
  const specifiers: string[] = [];
  for (const line of withoutComments.split('\n')) {
    const staticMatch = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/u.exec(line);
    if (staticMatch !== null) {
      specifiers.push(staticMatch[1] as string);
      continue;
    }
    const sideEffect = /^\s*import\s*['"]([^'"]+)['"]/u.exec(line);
    if (sideEffect !== null) {
      specifiers.push(sideEffect[1] as string);
      continue;
    }
    for (const match of line.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      specifiers.push(match[1] as string);
    }
  }
  return specifiers;
}

function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0] as string;
}

function isBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:');
}

function collectExportTargets(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('./')) into.push(normalizePackagePath(value));
    return;
  }
  if (isObject(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) {
      collectExportTargets(child, into);
    }
  }
}

function manifestBinPaths(manifest: JsonObject): readonly string[] {
  const bin = manifest['bin'];
  if (typeof bin === 'string') return [normalizePackagePath(bin)];
  if (isObject(bin)) {
    return Object.values(bin).filter((value): value is string => typeof value === 'string').map(normalizePackagePath);
  }
  return [];
}

function isDeclaredFile(path: string, declared: readonly string[]): boolean {
  return declared.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

const PARITY_FIELDS = ['name', 'version', 'type', 'main', 'types', 'exports', 'bin', 'files', 'dependencies', 'engines', 'os'] as const;

/** ---------- 主检查流程 ---------- */

export function verifyArtifacts(options: VerifyArtifactsOptions): ArtifactVerificationReport {
  const repoRoot = resolve(options.repoRoot);
  const distributionDir = resolve(options.distributionDir);
  const label = options.distributionLabel ?? 'distribution';
  const expectedNames = options.packages.map((spec) => spec.name);

  const manifestRead = readTextOrProblem(join(distributionDir, MANIFEST_FILE));
  const manifestParsed = parseJsonOrProblem(manifestRead.text, MANIFEST_FILE);
  const manifest = manifestParsed.value;
  const compatibilityRead = readTextOrProblem(join(repoRoot, COMPATIBILITY_FILE));
  const compatibilityParsed = parseJsonOrProblem(compatibilityRead.text, COMPATIBILITY_FILE);
  const compatibility = compatibilityParsed.value;
  const rootManifestRead = readTextOrProblem(join(repoRoot, 'package.json'));
  const rootManifest = parseJsonOrProblem(rootManifestRead.text, 'package.json').value;
  const lockRead = readTextOrProblem(join(repoRoot, 'package-lock.json'));
  const lock = parseJsonOrProblem(lockRead.text, 'package-lock.json').value;
  const workspaceManifests = new Map<string, JsonObject>();
  const workspaceProblems: string[] = [];
  for (const spec of options.packages) {
    const read = readTextOrProblem(join(repoRoot, spec.directory, 'package.json'));
    const parsed = parseJsonOrProblem(read.text, `${spec.name} package.json`);
    if (parsed.value === null) {
      workspaceProblems.push(parsed.problem ?? read.problem ?? `${spec.name} 工作区清单缺失`);
    } else {
      workspaceManifests.set(spec.name, parsed.value);
    }
  }

  // 预载每个包的 manifest 记录与 tarball 实际内容。
  const artifacts: ArtifactState[] = options.packages.map((spec) => {
    const record = extractArtifactRecord(manifest, spec.name);
    const recordProblems: string[] = [];
    let filename = `${spec.name}-unknown.tgz`;
    if (record === null) {
      recordProblems.push(`清单缺少 ${spec.name} 的制品记录`);
    } else {
      const name = record['name'];
      const version = record['version'];
      if (typeof name !== 'string' || name !== spec.name) recordProblems.push(`${spec.name} 制品记录 name 不匹配：${JSON.stringify(name)}`);
      if (typeof version !== 'string' || version.length === 0) recordProblems.push(`${spec.name} 制品记录 version 缺失`);
      else filename = `${name ?? spec.name}-${version}.tgz`;
      if (typeof record['filename'] === 'string' && record['filename'] !== filename) {
        recordProblems.push(`${spec.name} 制品记录 filename 与名称/版本不符：${JSON.stringify(record['filename'])}`);
      }
    }
    const tarballPath = join(distributionDir, filename);
    let tarballExists = false;
    let actualSha256: string | null = null;
    let actualSize: number | null = null;
    let analysis: TarAnalysis | null = null;
    let analysisProblem: string | null = null;
    if (isUnsafeRelativePath(filename) || resolve(tarballPath).startsWith(`${distributionDir}${sep}`) === false) {
      recordProblems.push(`${spec.name} 制品记录 filename 不安全：${filename}`);
    } else if (existsSync(tarballPath)) {
      tarballExists = true;
      try {
        const bytes = readFileSync(tarballPath);
        actualSize = bytes.byteLength;
        actualSha256 = hashHex(bytes);
        analysis = analyzeTarball(tarballPath);
      } catch (error) {
        analysisProblem = `${spec.name} tarball 无法解析：${(error as Error).message}`;
      }
    } else {
      analysisProblem = `${spec.name} tarball 缺失：${filename}`;
    }
    return {
      spec,
      record: record === null ? null : record,
      recordProblems,
      tarballPath,
      tarballExists,
      actualSha256,
      actualSize,
      analysis,
      analysisProblem,
    };
  });

  const checks: ArtifactCheck[] = [];
  const check = (id: string, title: string, objects: readonly string[], problems: readonly string[]): void => {
    checks.push({ id, title, status: problems.length === 0 ? 'passed' : 'failed', objects, problems: [...problems] });
  };
  const artifactLabel = (artifact: ArtifactState): string => {
    const version = artifact.record?.['version'];
    return typeof version === 'string' ? `${artifact.spec.name}@${version}` : artifact.spec.name;
  };

  // 1. distribution-manifest
  {
    const problems: string[] = [];
    const objects = [`${label}/${MANIFEST_FILE}`];
    if (manifestRead.problem !== null) problems.push(manifestRead.problem);
    if (manifestParsed.problem !== null) problems.push(manifestParsed.problem);
    if (manifest !== null) {
      if (manifest['schemaVersion'] !== 1 || manifest['kind'] !== 'shiploop.local.distribution' || manifest['distributionMode'] !== 'local-pack-only') {
        problems.push('清单头（schemaVersion/kind/distributionMode）不是本地分发清单');
      }
      if (manifest['platform'] !== 'darwin') problems.push(`清单平台声明必须为 darwin，实际 ${JSON.stringify(manifest['platform'])}`);
      if (typeof manifest['gitCommit'] !== 'string' || !/^[0-9a-f]{40}$/u.test(manifest['gitCommit'])) {
        problems.push('清单 gitCommit 不是 40 位十六进制 SHA');
      }
      const toolchain = manifest['toolchain'];
      const engines = rootManifest?.['engines'];
      if (!isObject(toolchain)) {
        problems.push('清单缺少 toolchain 对象');
      } else {
        if (isObject(engines)) {
          if (toolchain['node'] !== engines['node']) problems.push(`清单 Node 版本与仓库 engines 不一致：${JSON.stringify(toolchain['node'])} vs ${JSON.stringify(engines['node'])}`);
          if (toolchain['npm'] !== engines['npm']) problems.push(`清单 npm 版本与仓库 engines 不一致：${JSON.stringify(toolchain['npm'])} vs ${JSON.stringify(engines['npm'])}`);
        } else {
          problems.push('仓库根 package.json 缺少 engines 声明');
        }
        if (toolchain['packageManager'] !== 'npm') problems.push(`清单 packageManager 必须为 npm，实际 ${JSON.stringify(toolchain['packageManager'])}`);
        if (lock !== null && toolchain['lockfileVersion'] !== lock['lockfileVersion']) {
          problems.push(`清单 lockfileVersion 与 package-lock 不一致：${JSON.stringify(toolchain['lockfileVersion'])} vs ${JSON.stringify(lock['lockfileVersion'])}`);
        }
      }
      if (!isObject(manifest['compatibility'])) problems.push('清单缺少 compatibility 对象');
      const listed = manifest['artifacts'];
      if (!Array.isArray(listed)) {
        problems.push('清单 artifacts 不是数组');
      } else {
        const names = listed.map((entry) => (isObject(entry) ? entry['name'] : null));
        const sorted = [...names].sort();
        if (JSON.stringify(sorted) !== JSON.stringify([...expectedNames].sort())) {
          problems.push(`清单制品集合与预期包集不一致：${JSON.stringify(sorted)}`);
        }
      }
    }
    check('distribution-manifest', '清单头/工具链/平台/制品集合', objects, problems);
  }

  // 2. commit-identity
  {
    const problems: string[] = [];
    const objects = ['manifest.gitCommit', `environment.gitCommit(${options.environment.gitCommit.slice(0, 12)})`];
    if (!/^[0-9a-f]{40}$/u.test(options.environment.gitCommit)) {
      problems.push('检查环境 gitCommit 不是 40 位十六进制 SHA');
    }
    const declared = manifest?.['gitCommit'];
    if (typeof declared !== 'string') {
      problems.push('清单未声明 gitCommit');
    } else if (declared !== options.environment.gitCommit) {
      problems.push(`制品清单 commit ${declared.slice(0, 12)} 与检查环境实际 commit 不一致（版本漂移，fail-closed）`);
    }
    check('commit-identity', '制品 commit 与检查环境一致', objects, problems);
  }

  const unifiedVersion = compatibility?.['unifiedVersion'];

  // 3. artifact-identity
  {
    const problems: string[] = [];
    const objects = artifacts.map((artifact) => `${label}/${artifact.spec.name}`);
    if (typeof unifiedVersion !== 'string' || unifiedVersion.length === 0) {
      problems.push('仓库兼容声明缺少 unifiedVersion，无法核对统一版本');
    }
    for (const artifact of artifacts) {
      problems.push(...artifact.recordProblems.map((entry) => entry.replace(artifact.spec.name, artifactLabel(artifact))));
      const record = artifact.record;
      if (record === null) continue;
      const name = record['name'];
      const version = record['version'];
      if (typeof name === 'string' && !expectedNames.includes(name)) {
        problems.push(`未知制品包名：${JSON.stringify(name)}`);
      }
      if (!artifact.tarballExists) {
        problems.push(`${artifactLabel(artifact)} tarball 文件缺失`);
        continue;
      }
      if (typeof record['sha256'] === 'string' && record['sha256'] !== artifact.actualSha256) {
        problems.push(`${artifactLabel(artifact)} tarball sha256 与清单不一致（疑似篡改）`);
      }
      if (typeof record['size'] === 'number' && record['size'] !== artifact.actualSize) {
        problems.push(`${artifactLabel(artifact)} tarball 字节数与清单不一致`);
      }
      if (artifact.analysis !== null && artifact.analysis.tarManifest !== null) {
        const tarName = artifact.analysis.tarManifest['name'];
        const tarVersion = artifact.analysis.tarManifest['version'];
        if (tarName !== name) problems.push(`${artifactLabel(artifact)} tarball package.json name 不匹配：${JSON.stringify(tarName)}`);
        if (tarVersion !== version) problems.push(`${artifactLabel(artifact)} tarball package.json version 不匹配：${JSON.stringify(tarVersion)}（版本漂移）`);
        if (typeof record['packageManifestSha256'] === 'string' && record['packageManifestSha256'] !== artifact.analysis.fileDigests['package.json']) {
          problems.push(`${artifactLabel(artifact)} tarball package.json 摘要与清单不一致`);
        }
      }
      if (typeof unifiedVersion === 'string' && version !== unifiedVersion) {
        problems.push(`${artifactLabel(artifact)} 版本与统一版本 ${unifiedVersion} 不一致（版本漂移）`);
      }
    }
    check('artifact-identity', 'tarball 身份/sha256/size/统一版本', objects, problems);
  }

  // 4. tarball-file-digests
  {
    const problems: string[] = [];
    const objects = artifacts.map((artifact) => `${label}/${artifact.spec.name}.tgz`);
    for (const artifact of artifacts) {
      const record = artifact.record;
      if (artifact.analysisProblem !== null) {
        problems.push(`${artifactLabel(artifact)} ${artifact.analysisProblem}，逐文件摘要无法核对`);
        continue;
      }
      if (record === null || artifact.analysis === null) continue;
      const analysis = artifact.analysis;
      const declaredFiles = record['files'];
      const declaredDigests = record['fileDigests'];
      if (!Array.isArray(declaredFiles) || declaredFiles.some((entry) => typeof entry !== 'string')) {
        problems.push(`${artifactLabel(artifact)} 清单 files 不是字符串数组`);
        continue;
      }
      if (!isObject(declaredDigests)) {
        problems.push(`${artifactLabel(artifact)} 清单 fileDigests 不是对象`);
        continue;
      }
      const declaredSorted = [...(declaredFiles as string[])].sort((a, b) => a.localeCompare(b));
      if (JSON.stringify(declaredSorted) !== JSON.stringify(analysis.files)) {
        const missing = analysis.files.filter((file) => !declaredSorted.includes(file));
        const extra = declaredSorted.filter((file) => !analysis.files.includes(file));
        if (missing.length > 0) problems.push(`${artifactLabel(artifact)} tarball 含清单未记录文件：${missing.slice(0, 5).join(', ')}`);
        if (extra.length > 0) problems.push(`${artifactLabel(artifact)} 清单声明的文件在 tarball 中缺失：${extra.slice(0, 5).join(', ')}`);
      }
      for (const [file, digest] of Object.entries(analysis.fileDigests)) {
        const declared = (declaredDigests as Record<string, unknown>)[file];
        if (declared !== digest) {
          problems.push(`${artifactLabel(artifact)} 文件摘要不匹配：${file}`);
        }
      }
      for (const file of Object.keys(declaredDigests)) {
        if (!(file in analysis.fileDigests)) {
          problems.push(`${artifactLabel(artifact)} 清单摘要引用了 tarball 中不存在的文件：${file}`);
        }
      }
    }
    check('tarball-file-digests', '文件清单与逐文件 SHA-256', objects, problems);
  }

  // 5. packaged-entries
  {
    const problems: string[] = [];
    const objects = artifacts.map((artifact) => `${artifact.spec.name}:main/types/exports/bin`);
    for (const artifact of artifacts) {
      if (artifact.analysisProblem !== null || artifact.analysis === null || artifact.analysis.tarManifest === null) {
        problems.push(`${artifactLabel(artifact)} 无法解析 tarball 内容，入口/exports/bin 无法核对`);
        continue;
      }
      const tarManifest = artifact.analysis.tarManifest;
      const entries = artifact.analysis.entries;
      const requireEntry = (entryPath: string, what: string): void => {
        if (!entries.has(entryPath)) problems.push(`${artifactLabel(artifact)} ${what}缺失：${entryPath}`);
      };
      for (const key of ['main', 'types'] as const) {
        const entry = tarManifest[key];
        if (typeof entry === 'string') requireEntry(normalizePackagePath(entry), `${key} 入口`);
      }
      if (tarManifest['exports'] !== undefined) {
        const targets: string[] = [];
        collectExportTargets(tarManifest['exports'], targets);
        if (targets.length === 0) problems.push(`${artifactLabel(artifact)} exports 未声明任何 ./dist 目标`);
        for (const target of targets) requireEntry(target, 'exports 目标');
      }
      const files = tarManifest['files'];
      if (!Array.isArray(files) || files.some((entry) => typeof entry !== 'string')) {
        problems.push(`${artifactLabel(artifact)} files 白名单不是字符串数组`);
      } else {
        for (const declared of files) {
          if (isUnsafeRelativePath(declared)) problems.push(`${artifactLabel(artifact)} files 含不安全路径：${declared}`);
        }
        for (const path of artifact.analysis.files) {
          if (path !== 'package.json' && !isDeclaredFile(path, files)) {
            problems.push(`${artifactLabel(artifact)} 文件越出 files 白名单：${path}`);
          }
          if (/^(?:src|test|node_modules|\.git)(?:\/|$)/u.test(path)) {
            problems.push(`${artifactLabel(artifact)} 含开发目录文件：${path}`);
          }
        }
      }
      for (const bin of manifestBinPaths(tarManifest)) {
        const entry = entries.get(bin);
        if (entry === undefined) {
          problems.push(`${artifactLabel(artifact)} CLI bin 缺失：${bin}`);
          continue;
        }
        if ((entry.mode & 0o111) === 0) problems.push(`${artifactLabel(artifact)} CLI bin 不可执行：${bin}`);
        if (!entry.data.subarray(0, 32).toString('utf8').startsWith('#!')) {
          problems.push(`${artifactLabel(artifact)} CLI bin 缺少 shebang：${bin}`);
        }
      }
    }
    check('packaged-entries', '入口/exports/bin 存在性与执行权限', objects, problems);
  }

  // 6. workspace-manifest-parity
  {
    const problems: string[] = [...workspaceProblems];
    const objects = options.packages.map((spec) => `${spec.directory}/package.json`);
    for (const artifact of artifacts) {
      const workspace = workspaceManifests.get(artifact.spec.name);
      if (workspace === undefined) continue;
      if (artifact.analysis?.tarManifest == null) {
        problems.push(`${artifactLabel(artifact)} 无法解析 tarball package.json，无法与工作区清单核对`);
        continue;
      }
      for (const field of PARITY_FIELDS) {
        const inTarball = stableStringify(artifact.analysis.tarManifest[field]);
        const inWorkspace = stableStringify(workspace[field]);
        if (inTarball !== inWorkspace) {
          problems.push(`${artifactLabel(artifact)} 字段 ${field} 与工作区清单不一致（tarball=${inTarball.slice(0, 120)}，workspace=${inWorkspace.slice(0, 120)}）`);
        }
      }
    }
    check('workspace-manifest-parity', 'tarball 清单与工作区版本清单一致', objects, problems);
  }

  // 7. dependency-closure
  {
    const problems: string[] = [];
    const objects = options.packages.map((spec) => `${spec.name}:dependencies`);
    const lockPackages = isObject(lock?.['packages']) ? (lock['packages'] as Record<string, unknown>) : null;
    if (lockPackages === null) problems.push('package-lock.json 缺少 packages 闭包，依赖无法解析');
    const rootDevDependencies = isObject(rootManifest?.['devDependencies']) ? (rootManifest['devDependencies'] as Record<string, unknown>) : {};
    const resolvesInLock = (name: string): boolean => {
      if (lockPackages === null) return false;
      if (lockPackages[`node_modules/${name}`] !== undefined) return true;
      return Object.values(lockPackages).some((entry) => isObject(entry) && entry['name'] === name);
    };
    for (const artifact of artifacts) {
      const tarManifest = artifact.analysis?.tarManifest ?? null;
      const workspace = workspaceManifests.get(artifact.spec.name);
      if (tarManifest === null) {
        problems.push(`${artifactLabel(artifact)} 无法解析 tarball package.json，依赖闭包无法核对`);
        continue;
      }
      for (const table of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const) {
        const deps = tarManifest[table];
        if (deps === undefined) continue;
        if (!isObject(deps)) {
          problems.push(`${artifactLabel(artifact)} ${table} 不是对象`);
          continue;
        }
        for (const [name, spec] of Object.entries(deps)) {
          if (typeof spec !== 'string') {
            problems.push(`${artifactLabel(artifact)} ${table}.${name} 不是字符串`);
            continue;
          }
          if (LOCAL_SPEC_PATTERN.test(spec) || isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../') || spec.includes('\0') || spec.includes('\n')) {
            problems.push(`${artifactLabel(artifact)} ${table}.${name} 使用悬空本地/工作区依赖规格：${spec}（独立安装无法解析）`);
          }
        }
      }
      if (workspace !== undefined && stableStringify(tarManifest['dependencies']) !== stableStringify(workspace['dependencies'])) {
        problems.push(`${artifactLabel(artifact)} dependencies 与工作区清单不一致（打包期注入/丢失依赖）`);
      }
      for (const name of Object.keys(isObject(tarManifest['dependencies']) ? (tarManifest['dependencies'] as Record<string, unknown>) : {})) {
        if (!resolvesInLock(name)) {
          problems.push(`${artifactLabel(artifact)} 运行依赖 ${name} 不在 package-lock 闭包内（悬空依赖）`);
        }
      }
      // 发行代码的裸导入必须已声明；开发依赖（如测试框架）不得进入发行制品。
      const declared = new Set(Object.keys(isObject(tarManifest['dependencies']) ? (tarManifest['dependencies'] as Record<string, unknown>) : {}));
      if (artifact.analysis !== null) {
        for (const [path, entry] of artifact.analysis.entries) {
          if (!/\.(?:js|mjs|cjs)$/u.test(path)) continue;
          const text = entry.data.toString('utf8');
          for (const specifier of extractModuleSpecifiers(text)) {
            if (specifier.startsWith('./') || specifier.startsWith('../') || isBuiltinSpecifier(specifier)) continue;
            const packageName = packageNameOfSpecifier(specifier);
            if (!declared.has(packageName)) {
              const devNote = packageName in rootDevDependencies ? '（开发依赖进入发行制品）' : '';
              problems.push(`${artifactLabel(artifact)} ${path} 导入未声明的运行依赖 ${packageName}${devNote}`);
            }
          }
        }
      }
    }
    check('dependency-closure', '依赖闭包/registry 规格/锁解析/未声明开发依赖', objects, problems);
  }

  // 8. protocol-scope
  {
    const problems: string[] = [];
    const objects = ['compatibility.hostProtocol', 'manifest.compatibility.hostProtocol'];
    const scope = options.protocolScope;
    const declared = compatibility?.['hostProtocol'];
    const manifestCompatibility = manifest?.['compatibility'];
    const manifestHost = isObject(manifestCompatibility) ? manifestCompatibility['hostProtocol'] : undefined;
    if (declared === undefined) problems.push('仓库兼容声明缺少 hostProtocol');
    if (!isObject(declared)) {
      problems.push('hostProtocol 声明不是对象');
    } else {
      if (manifestHost === undefined || !isObject(manifestHost)) {
        problems.push('清单 compatibility 缺少 hostProtocol');
      } else if (stableStringify(manifestHost) !== stableStringify(declared)) {
        problems.push('清单 hostProtocol 与仓库兼容声明不一致');
      }
      if (declared['unknownVersionPolicy'] !== 'reject') {
        problems.push(`unknownVersionPolicy 必须为 reject，实际 ${JSON.stringify(declared['unknownVersionPolicy'])}`);
      }
      const wire = sortedNumbers(declared['wireProtocolVersions']);
      if (wire === null) {
        problems.push('wireProtocolVersions 不是整数数组');
      } else {
        const unknown = wire.filter((version) => !scope.supportedProtocolVersions.includes(version));
        for (const version of unknown) {
          problems.push(`声明了不支持的线协议版本 ${version}（策略 reject，不猜测降级为支持）`);
        }
        if (!sameNumberSet(wire, scope.supportedProtocolVersions)) {
          problems.push(`wireProtocolVersions 与真实支持集合不一致：${JSON.stringify(wire)} vs ${JSON.stringify([...scope.supportedProtocolVersions])}`);
        }
      }
      if (declared['wireSchemaVersion'] !== scope.currentWireSchemaVersion) {
        problems.push(`wireSchemaVersion 与当前线 schema 不一致：${JSON.stringify(declared['wireSchemaVersion'])} vs ${scope.currentWireSchemaVersion}`);
      }
      const legacy = sortedNumbers(declared['legacyHandshakeSchemaVersionsAccepted']);
      if (legacy === null) {
        problems.push('legacyHandshakeSchemaVersionsAccepted 不是整数数组');
      } else {
        const unknown = legacy.filter((version) => !scope.legacyHandshakeSchemaVersionsAccepted.includes(version));
        for (const version of unknown) {
          problems.push(`声明了不接受的旧握手 schema 版本 ${version}（真实代码不接受，不得猜测降级）`);
        }
        if (!sameNumberSet(legacy, scope.legacyHandshakeSchemaVersionsAccepted)) {
          problems.push(`旧握手 schema 集合与真实接受集合不一致：${JSON.stringify(legacy)}`);
        }
      }
      const discovery = sortedNumbers(declared['discoverySchemaVersions']);
      if (discovery === null) {
        problems.push('discoverySchemaVersions 不是整数数组');
      } else if (!sameNumberSet(discovery, scope.discoverySchemaVersions)) {
        problems.push(`discoverySchemaVersions 与真实支持集合不一致：${JSON.stringify(discovery)}`);
      }
    }
    check('protocol-scope', 'Host 协议范围（wire/legacy/discovery/未知策略）', objects, problems);
  }

  // 9. database-schema-scope
  {
    const problems: string[] = [];
    const objects = ['compatibility.databaseSchema', 'manifest.compatibility.databaseSchema'];
    const scope = options.databaseScope;
    const declared = compatibility?.['databaseSchema'];
    const manifestCompatibility = manifest?.['compatibility'];
    const manifestDb = isObject(manifestCompatibility) ? manifestCompatibility['databaseSchema'] : undefined;
    if (!isObject(declared)) {
      problems.push('仓库兼容声明缺少 databaseSchema 对象');
    } else {
      if (manifestDb === undefined || !isObject(manifestDb)) {
        problems.push('清单 compatibility 缺少 databaseSchema');
      } else if (stableStringify(manifestDb) !== stableStringify(declared)) {
        problems.push('清单 databaseSchema 与仓库兼容声明不一致');
      }
      if (declared['engine'] !== scope.engine) {
        problems.push(`数据库引擎声明必须为 ${scope.engine}，实际 ${JSON.stringify(declared['engine'])}`);
      }
      if (declared['higherVersionPolicy'] !== 'reject') {
        problems.push(`higherVersionPolicy 必须为 reject，实际 ${JSON.stringify(declared['higherVersionPolicy'])}`);
      }
      const range = declared['readableAppliedVersions'];
      if (!isObject(range) || typeof range['min'] !== 'number' || typeof range['max'] !== 'number' || !Number.isInteger(range['min']) || !Number.isInteger(range['max'])) {
        problems.push('readableAppliedVersions 缺少整数 min/max');
      } else {
        if (range['min'] !== scope.minMigrationVersion || range['max'] !== scope.maxMigrationVersion) {
          problems.push(`可读迁移范围与实际迁移链不一致：声明 ${range['min']}..${range['max']}，实际迁移 ${scope.minMigrationVersion}..${scope.maxMigrationVersion}（高版本必须拒绝，不得声明超出）`);
        }
        if (range['min'] > range['max']) problems.push('readableAppliedVersions min 大于 max');
      }
      if (declared['writableTargetVersion'] !== scope.maxMigrationVersion) {
        problems.push(`writableTargetVersion 必须等于实际最大迁移版本 ${scope.maxMigrationVersion}，实际 ${JSON.stringify(declared['writableTargetVersion'])}`);
      }
    }
    check('database-schema-scope', '数据库 Schema 读写范围与迁移链一致', objects, problems);
  }

  // 10. sensitive-content
  {
    const problems: string[] = [];
    const objects = [...artifacts.map((artifact) => `${artifact.spec.name} 文件内容`), '清单/兼容声明文本'];
    for (const artifact of artifacts) {
      if (artifact.analysis === null) {
        if (artifact.analysisProblem !== null) problems.push(`${artifactLabel(artifact)} ${artifact.analysisProblem}，敏感内容无法扫描`);
        continue;
      }
      for (const [path, entry] of artifact.analysis.entries) {
        if (CREDENTIAL_FILE_NAME_PATTERN.test(path)) {
          problems.push(`${artifactLabel(artifact)} 含凭据样式文件名：${path}`);
        }
        if (entry.data.includes(0) || entry.data.byteLength > SCAN_BYTE_LIMIT) continue;
        const hits = scanSensitiveText(entry.data.toString('utf8'));
        if (hits.length > 0) {
          problems.push(`${artifactLabel(artifact)} ${path} 命中敏感内容（凭据/密钥/token/开发机路径，内容已脱敏）：${hits.join(',')}`);
        }
      }
    }
    for (const [textLabel, text] of [[`${label}/${MANIFEST_FILE}`, manifestRead.text], [COMPATIBILITY_FILE, compatibilityRead.text]] as const) {
      if (text === null) continue;
      if (DEV_PATH_PATTERN.test(text)) problems.push(`${textLabel} 含开发机绝对路径`);
      if (LOCAL_SPEC_PATTERN.test(text)) problems.push(`${textLabel} 含 workspace/file/link 本地依赖规格`);
    }
    check('sensitive-content', '凭据/token/开发机路径（脱敏诊断）', objects, problems);
  }

  // 11. phase-integration-scope 与 not_run 记录
  let notRun: NotRunRecord[] = [];
  {
    const problems: string[] = [];
    const objects = ['compatibility.phaseIntegration'];
    const phaseIntegration = compatibility?.['phaseIntegration'];
    if (!isObject(phaseIntegration)) {
      problems.push('仓库兼容声明缺少 phaseIntegration 对象（真实安装/Host 兼容矩阵等必须显式登记为 not_run）');
    } else {
      if (phaseIntegration['status'] !== 'not_run') {
        problems.push(`phaseIntegration.status 声明为 ${JSON.stringify(phaseIntegration['status'])}，离线完整性检查无法核验该声明，必须保持 not_run`);
      }
      const items = phaseIntegration['items'];
      if (!Array.isArray(items) || items.length === 0) {
        problems.push('phaseIntegration.items 缺失或为空');
      } else {
        const ids = new Set<string>();
        for (const item of items) {
          if (!isObject(item) || typeof item['id'] !== 'string' || item['id'].length === 0 || typeof item['note'] !== 'string') {
            problems.push('phaseIntegration.items 含无效条目（需要 id/note 字符串）');
            continue;
          }
          if (ids.has(item['id'])) problems.push(`phaseIntegration.items 重复 id：${item['id']}`);
          ids.add(item['id']);
        }
        notRun = items.filter(isObject).map((item) => ({
          id: String(item['id']),
          reason: String(item['note']),
          owner: 'phase-integration',
        }));
      }
    }
    check('phase-integration-scope', 'Phase 集成项显式 not_run 登记', objects, problems);
  }

  const passedCount = checks.filter((entry) => entry.status === 'passed').length;
  const failedCount = checks.length - passedCount;
  const evidence: EvidenceReference[] = [];
  const manifestText = manifestRead.text;
  if (manifestText !== null) {
    evidence.push({ kind: 'distribution-manifest', label: `${label}/${MANIFEST_FILE}`, sha256: hashHex(manifestText) });
  }
  if (compatibilityRead.text !== null) {
    evidence.push({ kind: 'compatibility', label: COMPATIBILITY_FILE, sha256: hashHex(compatibilityRead.text) });
  }
  for (const artifact of artifacts) {
    if (artifact.actualSha256 !== null) {
      const version = artifact.record?.['version'];
      evidence.push({
        kind: 'tarball',
        label: `${label}/${artifact.spec.name}@${typeof version === 'string' ? version : '?'}.tgz`,
        sha256: artifact.actualSha256,
      });
    }
  }
  try {
    evidence.push({ kind: 'checker', label: 'scripts/verify-artifacts.ts', sha256: hashHex(readFileSync(fileURLToPath(import.meta.url), 'utf8')) });
  } catch {
    // 检查器自身摘要缺失不影响制品核对结论。
  }

  return {
    schemaVersion: 1,
    kind: 'shiploop.artifact-verification',
    generatedAt: new Date().toISOString(),
    passed: failedCount === 0,
    environment: options.environment,
    inputs: {
      distribution: label,
      distributionManifest: manifestText === null ? null : { label: `${label}/${MANIFEST_FILE}`, sha256: hashHex(manifestText) },
      compatibility: compatibilityRead.text === null ? null : { label: COMPATIBILITY_FILE, sha256: hashHex(compatibilityRead.text) },
      artifacts: artifacts.map((artifact) => {
        const name = artifact.record?.['name'];
        const version = artifact.record?.['version'];
        return {
          name: typeof name === 'string' ? name : artifact.spec.name,
          version: typeof version === 'string' ? version : '?',
          filename: basename(artifact.tarballPath),
          sha256: artifact.actualSha256,
        };
      }),
    },
    checks,
    notRun,
    evidence,
    summary: { passed: passedCount, failed: failedCount, notRun: notRun.length },
  };
}

/** 人读摘要（Phase 报告引用报告 JSON，此文本仅用于控制台）。 */
export function renderReportText(report: ArtifactVerificationReport): string {
  const lines: string[] = [];
  lines.push(
    `verify-artifacts: passed=${report.summary.passed} failed=${report.summary.failed} not_run=${report.summary.notRun} => ${report.passed ? 'OK' : 'FAILED'}`,
  );
  for (const checkEntry of report.checks) {
    lines.push(`[${checkEntry.status === 'passed' ? 'PASS' : 'FAIL'}] ${checkEntry.id} — ${checkEntry.title}`);
    for (const problem of checkEntry.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  for (const item of report.notRun) {
    lines.push(`[NOT-RUN] ${item.id}: ${item.reason}`);
  }
  lines.push(
    `environment: commit=${report.environment.gitCommit} node=${report.environment.nodeVersion} npm=${report.environment.npmVersion} platform=${report.environment.platform}`,
  );
  return lines.join('\n');
}

function extractArtifactRecord(manifest: JsonObject | null, name: string): JsonObject | null {
  if (manifest === null || !Array.isArray(manifest['artifacts'])) return null;
  const matches = (manifest['artifacts'] as unknown[]).filter((entry) => isObject(entry) && entry['name'] === name);
  if (matches.length !== 1) return null;
  return matches[0] as JsonObject;
}

/** ---------- CLI ---------- */

function resolveNpmCli(): { command: string; prefix: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && npmExecPath.endsWith('.js') && existsSync(npmExecPath)) {
    return { command: process.execPath, prefix: [npmExecPath] };
  }
  const bundled = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  if (existsSync(bundled)) {
    return { command: process.execPath, prefix: [bundled] };
  }
  throw new Error('无法从 npm_execpath 或当前 Node 安装解析固定 npm CLI');
}

function cliFail(message: string): never {
  process.stderr.write(`verify-artifacts: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let input: string | undefined;
  let output: string | undefined;
  let repoRootArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input' && args[index + 1] !== undefined) {
      input = args[++index];
    } else if (arg === '--output' && args[index + 1] !== undefined) {
      output = args[++index];
    } else if (arg === '--repo-root' && args[index + 1] !== undefined) {
      repoRootArg = args[++index];
    } else {
      cliFail(`未知参数：${arg}（支持 --input/--output/--repo-root）`);
    }
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(repoRootArg ?? resolve(scriptDir, '..'));
  const distributionDir = resolve(repoRoot, input ?? 'artifacts/local-pack');
  const reportPath = resolve(output ?? join(distributionDir, 'artifact-verification.json'));
  const relativeLabel = relative(repoRoot, distributionDir);
  const label = relativeLabel !== '' && !relativeLabel.startsWith('..') && !isAbsolute(relativeLabel) ? relativeLabel.split(sep).join('/') : basename(distributionDir);

  if (process.platform !== 'darwin') cliFail('仅支持在声明平台 darwin 上检查');

  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    cliFail(`无法解析实际 Git commit：${git.stderr ?? git.error?.message ?? 'unknown'}`);
  }
  const npmCli = resolveNpmCli();
  const npmVersionResult = spawnSync(npmCli.command, [...npmCli.prefix, '--version'], { encoding: 'utf8', timeout: 60_000 });
  if (npmVersionResult.error || npmVersionResult.status !== 0) {
    cliFail(`无法解析实际 npm 版本：${npmVersionResult.stderr ?? npmVersionResult.error?.message ?? 'unknown'}`);
  }

  // 真实代码常量绑定：从构建产物加载（tarball 内的 dist 即由它构建），不复制数字，
  // 避免声明与实现漂移；用运行时字符串动态导入，不参与类型解析。
  const loadBuilt = async (relativePath: string): Promise<Record<string, unknown>> => {
    const target = join(repoRoot, relativePath);
    if (!existsSync(target)) {
      throw new Error(`缺少构建产物 ${relativePath}；请先运行 npm run build 再执行制品检查`);
    }
    return (await import(pathToFileURL(target).href)) as Record<string, unknown>;
  };
  const constants = await loadBuilt('packages/host/dist/contract/constants.js');
  const handshake = await loadBuilt('packages/host/dist/contract/handshake.js');
  const migrationsModule = await loadBuilt('packages/core/dist/adapters/sqlite/migrations.js');
  const { PACKAGES } = await import('./pack-local.ts');
  const supportedProtocolVersions = constants['SUPPORTED_PROTOCOL_VERSIONS'];
  const currentSchemaVersion = constants['CURRENT_SCHEMA_VERSION'];
  const discoverySchemaVersion = constants['DISCOVERY_SCHEMA_VERSION'];
  const legacyAccepted = handshake['LEGACY_HANDSHAKE_SCHEMA_VERSIONS_ACCEPTED'];
  const migrations = migrationsModule['SQLITE_MIGRATIONS'];
  if (
    !Array.isArray(supportedProtocolVersions) ||
    typeof currentSchemaVersion !== 'number' ||
    typeof discoverySchemaVersion !== 'number' ||
    !Array.isArray(legacyAccepted) ||
    !Array.isArray(migrations) ||
    migrations.length === 0 ||
    !(migrations as { version?: unknown }[]).every((migration) => typeof migration.version === 'number')
  ) {
    cliFail('构建产物缺少预期的协议/迁移常量导出，无法确定兼容范围');
  }
  const migrationVersions = (migrations as { version: number }[]).map((migration) => migration.version);

  const report = verifyArtifacts({
    repoRoot,
    distributionDir,
    distributionLabel: label,
    packages: PACKAGES,
    environment: {
      gitCommit: git.stdout.trim(),
      nodeVersion: process.versions.node,
      npmVersion: npmVersionResult.stdout.trim(),
      platform: process.platform,
    },
    protocolScope: {
      supportedProtocolVersions: [...(supportedProtocolVersions as number[])],
      currentWireSchemaVersion: currentSchemaVersion as number,
      legacyHandshakeSchemaVersionsAccepted: [...(legacyAccepted as number[])],
      discoverySchemaVersions: [discoverySchemaVersion as number],
    },
    databaseScope: {
      engine: 'sqlite',
      minMigrationVersion: Math.min(...migrationVersions),
      maxMigrationVersion: Math.max(...migrationVersions),
    },
  });

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${renderReportText(report)}\n`);
  process.stdout.write(`verify-artifacts: report ${reportPath}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(`verify-artifacts: ${(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(2);
  });
}
