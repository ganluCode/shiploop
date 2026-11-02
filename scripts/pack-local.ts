/**
 * P08-1 F-002 本地可重复打包入口。
 *
 * 该脚本只生成本地 tarball，不执行 npm publish。它先用提交的锁文件和固定
 * Node/npm 校验工作区，再按 Core → Host → CLI 的依赖顺序构建、隔离 staging、
 * npm pack，并对 tar 内容重新核验后才写入脱敏制品清单。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGES = [
  { id: 'core', directory: 'packages/core', name: 'shiploop-core' },
  { id: 'host', directory: 'packages/host', name: 'shiploop-host' },
  { id: 'cli', directory: 'packages/cli', name: 'shiploop-cli' },
] as const;

const EXPECTED_NODE = '22.19.0';
const EXPECTED_NPM = '10.9.3';
const MANIFEST_FILE = 'distribution-manifest.json';
const TAR_BLOCK_SIZE = 512;

type JsonObject = Record<string, unknown>;

type PackageManifest = JsonObject & {
  name: string;
  version: string;
  files: string[];
  main?: string;
  types?: string;
  bin?: string | Record<string, string>;
};

type TarEntry = {
  path: string;
  data: Buffer;
  mode: number;
};

export type ArtifactRecord = {
  name: string;
  version: string;
  filename: string;
  size: number;
  sha256: string;
  packageManifestSha256: string;
  files: string[];
  fileDigests: Record<string, string>;
};

export type DistributionManifest = {
  schemaVersion: 1;
  kind: 'shiploop.local.distribution';
  distributionMode: 'local-pack-only';
  gitCommit: string;
  platform: string;
  toolchain: { node: string; npm: string; packageManager: 'npm'; lockfileVersion: number };
  compatibility: JsonObject;
  artifacts: ArtifactRecord[];
};

type PackInput = {
  gitCommit: string;
  nodeVersion: string;
  npmVersion: string;
  platform: string;
  lockfileVersion: number;
  compatibility: JsonObject;
  artifacts: ArtifactRecord[];
};

function fail(message: string): never {
  throw new Error(`pack-local: ${message}`);
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonObject;
}

function asManifest(value: unknown): PackageManifest {
  const object = asObject(value, 'package manifest');
  if (typeof object.name !== 'string' || object.name.length === 0) {
    fail('package manifest name is missing');
  }
  if (typeof object.version !== 'string' || object.version.length === 0) {
    fail(`package ${object.name} version is missing`);
  }
  if (!Array.isArray(object.files) || object.files.length === 0 || object.files.some((file) => typeof file !== 'string')) {
    fail(`package ${object.name} must declare a non-empty files array`);
  }
  return object as PackageManifest;
}

function readJson(path: string): JsonObject {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('pack-local:')) {
      throw error;
    }
    fail(`cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureSafeRelativePath(path: string, label: string): void {
  if (isAbsolute(path) || path === '' || path.split(/[\\/]/u).includes('..')) {
    fail(`${label} contains an unsafe path: ${path}`);
  }
}

function resolveInside(root: string, child: string, label: string): string {
  ensureSafeRelativePath(child, label);
  const result = resolve(root, child);
  const rootWithSeparator = resolve(root) + sep;
  if (result !== resolve(root) && !result.startsWith(rootWithSeparator)) {
    fail(`${label} escapes its staging root: ${child}`);
  }
  return result;
}

function validateDependencyTables(manifest: JsonObject): void {
  for (const tableName of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    const table = manifest[tableName];
    if (table === undefined) continue;
    const dependencies = asObject(table, `${tableName}`);
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string') {
        fail(`${tableName}.${name} must be a string`);
      }
      if (/^(?:workspace|file|link):/u.test(value) || isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
        fail(`runtime dependency ${name} uses an unsupported local path or workspace spec: ${value}`);
      }
      if (value.includes('\0') || value.includes('\n')) {
        fail(`dependency ${name} contains an invalid version specifier`);
      }
    }
  }
}

/** 校验包清单结构及所有依赖均为可独立解析的版本/registry spec。 */
export function validatePackageManifest(value: unknown): PackageManifest {
  const manifest = asManifest(value);
  validateDependencyTables(manifest);
  for (const declared of manifest.files) {
    ensureSafeRelativePath(declared, `${manifest.name}.files`);
  }
  for (const key of ['main', 'types']) {
    const entry = manifest[key];
    if (entry !== undefined && typeof entry !== 'string') {
      fail(`${manifest.name}.${key} must be a string`);
    }
  }
  if (manifest.bin !== undefined && typeof manifest.bin !== 'string' && (manifest.bin === null || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin))) {
    fail(`${manifest.name}.bin must be a string or object`);
  }
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) {
    if (typeof bin !== 'string') fail(`${manifest.name}.bin contains a non-string path`);
    ensureSafeRelativePath(bin, `${manifest.name}.bin`);
  }
  return manifest;
}

function copyTree(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    fail(`symbolic link is not allowed in package staging: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      if (entry === '.tsbuildinfo' || entry.endsWith('.tsbuildinfo')) continue;
      copyTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!sourceStat.isFile()) fail(`package staging source is not a regular file: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, sourceStat.mode & 0o777);
}

function normalizePackagePath(path: string): string {
  return path.replace(/^\.\//u, '');
}

function entryPaths(manifest: PackageManifest): string[] {
  const paths = [manifest.main, manifest.types]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizePackagePath);
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  return [...paths, ...bins.map(normalizePackagePath)];
}

function validateSourceEntries(sourceDir: string, manifest: PackageManifest): void {
  for (const entry of entryPaths(manifest)) {
    const path = resolveInside(sourceDir, entry, `${manifest.name} entry`);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      fail(`${manifest.name} build entry is missing: ${entry}`);
    }
  }
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) {
    const path = resolveInside(sourceDir, bin, `${manifest.name}.bin`);
    if ((statSync(path).mode & 0o111) === 0) {
      fail(`${manifest.name} CLI bin is not executable: ${bin}`);
    }
  }
}

/** 将 package.json 的 files 白名单复制到隔离 staging；不复制源码、node_modules 或链接。 */
export function stagePackage(sourceDirInput: string, stageDirInput: string): void {
  const sourceDir = resolve(sourceDirInput);
  const stageDir = resolve(stageDirInput);
  const manifestPath = join(sourceDir, 'package.json');
  if (!existsSync(manifestPath)) fail(`package.json is missing: ${manifestPath}`);
  const manifest = validatePackageManifest(readJson(manifestPath));
  validateSourceEntries(sourceDir, manifest);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const declared of manifest.files) {
    const source = resolveInside(sourceDir, declared, `${manifest.name}.files`);
    if (!existsSync(source)) fail(`${manifest.name} declared file set is missing: ${declared}`);
    copyTree(source, resolveInside(stageDir, declared, `${manifest.name}.files`));
  }
}

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

function parseTarball(buffer: Buffer): TarEntry[] {
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
    if (dataEnd > tar.length) fail('tarball contains a truncated entry');
    const type = readTarString(header, 156, 1) || '0';
    const name = paxPath ?? `${readTarString(header, 345, 155)}${readTarString(header, 0, 100)}`;
    paxPath = undefined;
    if (type === 'x' || type === 'g') {
      paxPath = parsePaxPath(tar.subarray(dataStart, dataEnd));
    } else if (type === '0') {
      const normalized = name.startsWith('package/') ? name.slice('package/'.length) : name;
      ensureSafeRelativePath(normalized, 'tar entry');
      entries.push({ path: normalized, data: Buffer.from(tar.subarray(dataStart, dataEnd)), mode: readOctal(header, 100, 8) });
    } else if (type !== '5') {
      fail(`tarball contains unsupported non-file entry: ${name}`);
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return entries;
}

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function scanForSecrets(path: string, data: Buffer): void {
  if (/^(?:\.env(?:\.|$)|.*(?:credentials|secret|private-key).*)/iu.test(path)) {
    fail(`tarball contains a credential-like file name: ${path}`);
  }
  if (data.includes(0)) return;
  const text = data.toString('utf8');
  const suspicious = [
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/u,
    /\b(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"\n]{12,}['"]/iu,
    /\/(?:Users|home|private\/var\/folders|opt\/homebrew)\//u,
  ];
  if (suspicious.some((pattern) => pattern.test(text))) {
    fail(`tarball contains a suspected credential or developer absolute path: ${path}`);
  }
}

function packageBinEntries(manifest: PackageManifest): string[] {
  return (typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})).map(normalizePackagePath);
}

function ensurePackagedEntries(manifest: PackageManifest, entries: Map<string, TarEntry>): void {
  for (const entry of entryPaths(manifest)) {
    if (!entries.has(entry)) fail(`${manifest.name} packaged entry is missing: ${entry}`);
  }
  for (const bin of packageBinEntries(manifest)) {
    const entry = entries.get(bin);
    if (entry === undefined || (entry.mode & 0o111) === 0) {
      fail(`${manifest.name} CLI bin is not executable in tarball: ${bin}`);
    }
    if (entry.data.toString('utf8', 0, 32).startsWith('#!') === false) {
      fail(`${manifest.name} CLI bin is missing a shebang: ${bin}`);
    }
  }
}

function isDeclaredFile(path: string, declared: string): boolean {
  return path === declared || path.startsWith(`${declared}/`);
}

/** 从实际 gzip tar 内容生成包摘要，并重新执行包内安全门禁。 */
export function createArtifactRecord(tarballPathInput: string, expectedName: string, expectedVersion: string): ArtifactRecord {
  const tarballPath = resolve(tarballPathInput);
  if (!existsSync(tarballPath)) fail(`tarball is missing: ${tarballPath}`);
  const tarball = readFileSync(tarballPath);
  const entries = parseTarball(tarball);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
  const packageEntry = entryMap.get('package.json');
  if (packageEntry === undefined) fail('tarball package.json is missing');
  const manifest = validatePackageManifest(JSON.parse(packageEntry.data.toString('utf8')));
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    fail(`tarball identity mismatch: expected ${expectedName}@${expectedVersion}, found ${manifest.name}@${manifest.version}`);
  }
  ensurePackagedEntries(manifest, entryMap);
  for (const [path, entry] of entryMap) {
    if (path !== 'package.json' && !manifest.files.some((declared) => isDeclaredFile(path, declared))) {
      fail(`${manifest.name} tarball file is outside package.json files: ${path}`);
    }
    if (/^(?:src|test|node_modules|\.git)(?:\/|$)/u.test(path)) {
      fail(`${manifest.name} tarball contains a development directory: ${path}`);
    }
    scanForSecrets(path, entry.data);
  }
  const fileDigests = Object.fromEntries([...entryMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => [path, hash(entry.data)]));
  return {
    name: manifest.name,
    version: manifest.version,
    filename: relative(dirname(tarballPath), tarballPath),
    size: tarball.byteLength,
    sha256: hash(tarball),
    packageManifestSha256: fileDigests['package.json'] as string,
    files: Object.keys(fileDigests),
    fileDigests,
  };
}

function resolveNpm(): { command: string; prefix: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && npmExecPath.endsWith('.js') && existsSync(npmExecPath)) {
    return { command: process.execPath, prefix: [npmExecPath] };
  }
  const bundledNpm = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  if (existsSync(bundledNpm)) {
    return { command: process.execPath, prefix: [bundledNpm] };
  }
  fail('cannot resolve the pinned npm CLI from npm_execpath or the current Node installation');
}

function runNpm(cwd: string, args: string[], inherit = false): string {
  const npm = resolveNpm();
  const result = spawnSync(npm.command, [...npm.prefix, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: 600_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.slice(-4000);
    fail(`npm ${args.join(' ')} failed (status=${String(result.status)}, signal=${String(result.signal)}): ${detail}`);
  }
  return `${result.stdout ?? ''}`;
}

/** 在已隔离 staging 上调用固定 npm pack，返回实际生成的单个 tarball。 */
export function packStagedPackage(stageDirInput: string, outputDirInput: string): string {
  const stageDir = resolve(stageDirInput);
  const outputDir = resolve(outputDirInput);
  mkdirSync(outputDir, { recursive: true });
  const output = runNpm(stageDir, ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDir]);
  let records: unknown;
  try {
    records = JSON.parse(output);
  } catch (error) {
    fail(`npm pack returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(records) || records.length !== 1) fail('npm pack must produce exactly one package record');
  const record = asObject(records[0], 'npm pack record');
  if (typeof record.filename !== 'string' || record.filename.includes('/') || record.filename.includes('\\')) {
    fail('npm pack returned an unsafe filename');
  }
  const tarball = join(outputDir, record.filename);
  if (!existsSync(tarball)) fail(`npm pack did not create ${record.filename}`);
  return tarball;
}

export function createDistributionManifest(input: PackInput): DistributionManifest {
  if (!/^[0-9a-f]{40}$/u.test(input.gitCommit)) fail('Git commit must be a full 40-character SHA');
  if (input.nodeVersion !== EXPECTED_NODE || input.npmVersion !== EXPECTED_NPM) fail('toolchain version does not match the locked Node/npm versions');
  if (input.platform !== 'darwin') fail('only the declared macOS platform can be packed');
  if (input.lockfileVersion !== 3) fail('package-lock.json must use lockfileVersion 3');
  if (input.artifacts.length !== PACKAGES.length) fail('distribution manifest must contain Core, Host and CLI artifacts');
  const names = input.artifacts.map((artifact) => artifact.name).sort();
  const expected = PACKAGES.map((pkg) => pkg.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('distribution manifest package set is incomplete or duplicated');
  return {
    schemaVersion: 1,
    kind: 'shiploop.local.distribution',
    distributionMode: 'local-pack-only',
    gitCommit: input.gitCommit,
    platform: input.platform,
    toolchain: { node: input.nodeVersion, npm: input.npmVersion, packageManager: 'npm', lockfileVersion: input.lockfileVersion },
    compatibility: JSON.parse(JSON.stringify(input.compatibility)) as JsonObject,
    artifacts: input.artifacts.map((artifact) => ({ ...artifact, files: [...artifact.files], fileDigests: { ...artifact.fileDigests } })),
  };
}

function assertNoAbsoluteStrings(value: unknown): void {
  if (typeof value === 'string') {
    if (/\/(?:Users|home|private\/var\/folders|opt\/homebrew)\//u.test(value) || /(?:workspace|file|link):/u.test(value)) {
      fail('distribution manifest contains a developer path or workspace dependency');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoAbsoluteStrings);
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(assertNoAbsoluteStrings);
  }
}

/** 对写出的清单和每一个 tarball 重新核对身份、摘要及文件清单。 */
export function validateDistributionManifest(manifest: unknown, outputDirInput: string): void {
  const object = asObject(manifest, 'distribution manifest') as Partial<DistributionManifest>;
  if (object.schemaVersion !== 1 || object.kind !== 'shiploop.local.distribution' || object.distributionMode !== 'local-pack-only') {
    fail('distribution manifest header is invalid');
  }
  if (typeof object.gitCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(object.gitCommit)) fail('distribution manifest Git identity is invalid');
  const toolchain = asObject(object.toolchain, 'distribution toolchain');
  if (toolchain.node !== EXPECTED_NODE || toolchain.npm !== EXPECTED_NPM || toolchain.packageManager !== 'npm' || toolchain.lockfileVersion !== 3) {
    fail('distribution manifest toolchain is invalid');
  }
  if (object.platform !== 'darwin') fail('distribution manifest platform is invalid');
  if (!Array.isArray(object.artifacts) || object.artifacts.length !== PACKAGES.length) fail('distribution manifest artifact list is incomplete');
  assertNoAbsoluteStrings(object);
  const outputDir = resolve(outputDirInput);
  const artifacts = object.artifacts as ArtifactRecord[];
  for (const artifact of artifacts) {
    if (!PACKAGES.some((pkg) => pkg.name === artifact.name)) fail(`unknown artifact package: ${artifact.name}`);
    if (typeof artifact.filename !== 'string' || artifact.filename !== `${artifact.name}-${artifact.version}.tgz`) {
      fail(`artifact filename does not match package identity: ${artifact.filename}`);
    }
    const tarball = resolveInside(outputDir, artifact.filename, 'artifact filename');
    const actual = createArtifactRecord(tarball, artifact.name, artifact.version);
    if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size || actual.packageManifestSha256 !== artifact.packageManifestSha256) {
      fail(`artifact digest mismatch for ${artifact.name}`);
    }
    if (JSON.stringify(actual.files) !== JSON.stringify(artifact.files) || JSON.stringify(actual.fileDigests) !== JSON.stringify(artifact.fileDigests)) {
      fail(`artifact file manifest mismatch for ${artifact.name}`);
    }
  }
}

function gitCommit(root: string): string {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`cannot resolve Git commit: ${result.stderr ?? result.error?.message ?? 'unknown error'}`);
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail('Git returned an invalid commit SHA');
  return commit;
}

function npmVersion(root: string): string {
  return runNpm(root, ['--version']).trim();
}

function loadCompatibility(root: string): JsonObject {
  const compatibility = readJson(join(root, 'distribution-compatibility.json'));
  if (compatibility.distributionMode !== 'local-pack-only') fail('distribution compatibility does not permit local packaging');
  return {
    hostProtocol: compatibility.hostProtocol,
    databaseSchema: compatibility.databaseSchema,
  };
}

export async function runLocalPack(rootInput: string, outputInput?: string): Promise<string> {
  const root = resolve(rootInput);
  const output = resolve(outputInput ?? join(root, 'artifacts/local-pack'));
  if (process.platform !== 'darwin') fail('local packaging is supported only on macOS');
  if (process.versions.node !== EXPECTED_NODE) fail(`Node ${EXPECTED_NODE} is required; found ${process.versions.node}`);
  const rootManifest = readJson(join(root, 'package.json'));
  const lock = readJson(join(root, 'package-lock.json'));
  if (lock.lockfileVersion !== 3 || lock.name !== rootManifest.name || lock.version !== rootManifest.version) {
    fail('package-lock.json is missing, invalid, or does not match the root package.json');
  }
  const npm = npmVersion(root);
  if (npm !== EXPECTED_NPM) fail(`npm ${EXPECTED_NPM} is required; found ${npm}`);
  const commit = gitCommit(root);
  const compatibility = loadCompatibility(root);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  try {
    runNpm(root, ['ci'], true);
    runNpm(root, ['run', 'build'], true);
    const staging = mkdtempSync(join(output, '.staging-'));
    const artifacts: ArtifactRecord[] = [];
    try {
      for (const pkg of PACKAGES) {
        const stage = join(staging, pkg.id);
        stagePackage(join(root, pkg.directory), stage);
        const tarball = packStagedPackage(stage, output);
        artifacts.push(createArtifactRecord(tarball, pkg.name, rootManifest.version as string));
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const manifest = createDistributionManifest({
      gitCommit: commit,
      nodeVersion: EXPECTED_NODE,
      npmVersion: EXPECTED_NPM,
      platform: process.platform,
      lockfileVersion: lock.lockfileVersion as number,
      compatibility,
      artifacts,
    });
    const manifestPath = join(output, MANIFEST_FILE);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    validateDistributionManifest(manifest, output);
    return manifestPath;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output' && args[index + 1]) {
      output = resolve(root, args[index + 1] as string);
      index += 1;
    } else {
      fail(`unknown argument: ${args[index]}`);
    }
  }
  const manifestPath = await runLocalPack(root, output);
  process.stdout.write(`pack-local: ok ${manifestPath}\n`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(`pack-local: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
