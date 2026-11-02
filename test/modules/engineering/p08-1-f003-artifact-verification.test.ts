/**
 * P08-1 / F-003 制品完整性与兼容检查器验收（本地夹具 + 真实 CLI 子进程）。
 *
 * 覆盖（F-003 验收点，全部为真实文件/真实 npm pack 产物断言，非 mock）：
 * - 正向清单：三包 fixture 分发通过全部检查，结构化结果包含实际 commit、
 *   工具版本、检查对象摘要与证据引用；not_run 只保留 Phase 集成项，不被折算为通过；
 * - 篡改 tarball：替换 tarball 内容后 sha256/身份检查失败；
 * - 缺文件：tarball 缺少清单声明的 dist 入口时入口检查失败；
 * - 版本漂移：manifest 记录版本或统一版本与 tarball 不一致时失败；
 * - 未知兼容版本：wire 协议版本超出真实支持集合、Schema 读上限高于实际迁移、
 *   manifest 与仓库兼容声明不一致均失败，不猜测降级为支持；
 * - 敏感信息负例：token/key/开发机路径内容命中失败且诊断信息脱敏；
 * - 依赖闭包负例：workspace: 悬空依赖、发行代码未声明开发依赖、锁外依赖失败；
 * - 只读性与 CLI 语义：检查不修改受检目录；CLI 退出码与报告 passed 一致，
 *   失败报告同样落盘且不含开发机绝对路径。
 *
 * 真实安装后跨包运行、原生模块加载、打包 Host 启动与已有 Host 兼容矩阵
 * 属于 Phase 集成，not_run 边界与 distribution-compatibility.json 一致。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import {
  CURRENT_SCHEMA_VERSION,
  DISCOVERY_SCHEMA_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../packages/host/src/contract/constants.ts';
import { LEGACY_HANDSHAKE_SCHEMA_VERSIONS_ACCEPTED } from '../../../packages/host/src/contract/handshake.ts';
import {
  createArtifactRecord,
  createDistributionManifest,
  PACKAGES,
  packStagedPackage,
  stagePackage,
} from '../../../scripts/pack-local.ts';
import {
  inspectTarball,
  verifyArtifacts,
  type ArtifactCheck,
  type ArtifactVerificationReport,
} from '../../../scripts/verify-artifacts.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ENVIRONMENT = {
  gitCommit: FIXTURE_COMMIT,
  nodeVersion: process.versions.node,
  npmVersion: '10.9.3',
  platform: 'darwin',
};
const PROTOCOL_SCOPE = {
  supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
  currentWireSchemaVersion: CURRENT_SCHEMA_VERSION,
  legacyHandshakeSchemaVersionsAccepted: [...LEGACY_HANDSHAKE_SCHEMA_VERSIONS_ACCEPTED],
  discoverySchemaVersions: [DISCOVERY_SCHEMA_VERSION],
};
const DATABASE_SCOPE = {
  engine: 'sqlite' as const,
  minMigrationVersion: SQLITE_MIGRATIONS[0]!.version,
  maxMigrationVersion: SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]!.version,
};
const PHASE_INTEGRATION_IDS = [
  'real-install-independent-directory',
  'native-module-loading',
  'host-startup-packed-artifact',
  'existing-host-compatibility-matrix',
];
/** 与 scripts/verify-artifacts.ts 的检查集合保持一致（正向用例断言数量与全部通过）。 */
const EXPECTED_CHECK_COUNT = 11;

function sandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function directoryDigests(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      const label = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child, label);
      } else {
        result[label] = sha256Hex(readFileSync(child));
      }
    }
  };
  walk(dir, '');
  return result;
}

function fixtureCompatibility(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'shiploop.distribution.compatibility',
    distributionMode: 'local-pack-only',
    published: false,
    packages: {
      root: { name: 'shiploop-fixture', path: '.' },
      core: { name: 'shiploop-core', path: 'packages/core' },
      host: { name: 'shiploop-host', path: 'packages/host' },
      cli: { name: 'shiploop-cli', path: 'packages/cli' },
    },
    unifiedVersion: '0.0.0',
    platforms: ['darwin'],
    toolchain: { node: '22.19.0', npm: '10.9.3' },
    hostProtocol: {
      wireProtocolVersions: [...PROTOCOL_SCOPE.supportedProtocolVersions],
      wireSchemaVersion: PROTOCOL_SCOPE.currentWireSchemaVersion,
      legacyHandshakeSchemaVersionsAccepted: [...PROTOCOL_SCOPE.legacyHandshakeSchemaVersionsAccepted],
      discoverySchemaVersions: [...PROTOCOL_SCOPE.discoverySchemaVersions],
      unknownVersionPolicy: 'reject',
    },
    databaseSchema: {
      engine: 'sqlite',
      readableAppliedVersions: { min: DATABASE_SCOPE.minMigrationVersion, max: DATABASE_SCOPE.maxMigrationVersion },
      writableTargetVersion: DATABASE_SCOPE.maxMigrationVersion,
      higherVersionPolicy: 'reject',
    },
    releaseBlockers: {
      ownerConfirmation: 'pending',
      items: { license: { status: 'pending', note: 'fixture' } },
    },
    phaseIntegration: {
      status: 'not_run',
      items: PHASE_INTEGRATION_IDS.map((id) => ({ id, note: `fixture pending: ${id}` })),
    },
  };
}

function fixtureWorkspaceManifest(id: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: `shiploop-${id}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    description: `ShipLoop fixture ${id}`,
    engines: { node: '22.19.0', npm: '10.9.3' },
    os: ['darwin'],
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    },
    files: ['dist'],
  };
  if (id === 'core') {
    base['dependencies'] = {};
  } else if (id === 'host') {
    base['dependencies'] = { 'shiploop-core': '0.0.0' };
  } else {
    base['dependencies'] = { 'shiploop-host': '0.0.0' };
    base['bin'] = { shiploop: './dist/bin.js' };
  }
  return base;
}

function writeWorkspaceSources(repoRoot: string): void {
  for (const spec of PACKAGES) {
    const dir = join(repoRoot, spec.directory);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeJson(join(dir, 'package.json'), fixtureWorkspaceManifest(spec.id));
    writeFileSync(join(dir, 'dist/index.js'), `export const fixture = '${spec.id}';\n`, 'utf8');
    writeFileSync(join(dir, 'dist/index.d.ts'), 'export declare const fixture: string;\n', 'utf8');
    if (spec.id === 'cli') {
      writeFileSync(join(dir, 'dist/bin.js'), '#!/usr/bin/env node\nprocess.exitCode = 0;\n', 'utf8');
      chmodSync(join(dir, 'dist/bin.js'), 0o755);
    }
  }
}

function writeFixtureRepo(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true });
  writeJson(join(repoRoot, 'package.json'), {
    name: 'shiploop-fixture',
    version: '0.0.0',
    private: true,
    engines: { node: '22.19.0', npm: '10.9.3' },
    devDependencies: { vitest: '5.0.3', typescript: '7.0.2' },
  });
  writeJson(join(repoRoot, 'package-lock.json'), {
    lockfileVersion: 3,
    name: 'shiploop-fixture',
    version: '0.0.0',
    requires: true,
    packages: {
      '': { name: 'shiploop-fixture', version: '0.0.0' },
      'packages/core': { name: 'shiploop-core', version: '0.0.0' },
      'packages/host': { name: 'shiploop-host', version: '0.0.0' },
      'packages/cli': { name: 'shiploop-cli', version: '0.0.0' },
      'node_modules/shiploop-core': { resolved: 'packages/core', link: true },
      'node_modules/shiploop-host': { resolved: 'packages/host', link: true },
      'node_modules/shiploop-cli': { resolved: 'packages/cli', link: true },
    },
  });
  writeJson(join(repoRoot, 'distribution-compatibility.json'), fixtureCompatibility());
  writeWorkspaceSources(repoRoot);
}

type Fixture = { repoRoot: string; distributionDir: string };

function buildSharedFixture(root: string): Fixture {
  const repoRoot = join(root, 'repo');
  const distributionDir = join(root, 'distribution');
  writeFixtureRepo(repoRoot);
  const artifacts: ReturnType<typeof createArtifactRecord>[] = [];
  for (const spec of PACKAGES) {
    const stage = join(root, `stage-${spec.id}`);
    stagePackage(join(repoRoot, spec.directory), stage);
    const tarball = packStagedPackage(stage, distributionDir);
    artifacts.push(createArtifactRecord(tarball, spec.name, '0.0.0'));
  }
  const compatibility = fixtureCompatibility();
  const manifest = createDistributionManifest({
    gitCommit: FIXTURE_COMMIT,
    nodeVersion: '22.19.0',
    npmVersion: '10.9.3',
    platform: 'darwin',
    lockfileVersion: 3,
    compatibility: {
      hostProtocol: compatibility['hostProtocol'],
      databaseSchema: compatibility['databaseSchema'],
    },
    artifacts,
  });
  writeJson(join(distributionDir, 'distribution-manifest.json'), manifest);
  return { repoRoot, distributionDir };
}

let shared: Fixture;

function cloneFixture(root: string): Fixture {
  const repoRoot = join(root, 'repo');
  const distributionDir = join(root, 'distribution');
  cpSync(shared.repoRoot, repoRoot, { recursive: true });
  cpSync(shared.distributionDir, distributionDir, { recursive: true });
  return { repoRoot, distributionDir };
}

function verify(fixture: Fixture): ArtifactVerificationReport {
  return verifyArtifacts({
    repoRoot: fixture.repoRoot,
    distributionDir: fixture.distributionDir,
    packages: PACKAGES,
    environment: ENVIRONMENT,
    protocolScope: PROTOCOL_SCOPE,
    databaseScope: DATABASE_SCOPE,
  });
}

function checkById(report: ArtifactVerificationReport, id: string): ArtifactCheck {
  const check = report.checks.find((entry) => entry.id === id);
  if (check === undefined) {
    throw new Error(`check not found in report: ${id}`);
  }
  return check;
}

function readManifest(distributionDir: string): Record<string, unknown> {
  return readJson(join(distributionDir, 'distribution-manifest.json'));
}

function writeManifest(distributionDir: string, manifest: Record<string, unknown>): void {
  writeJson(join(distributionDir, 'distribution-manifest.json'), manifest);
}

function readCompatibility(repoRoot: string): Record<string, unknown> {
  return readJson(join(repoRoot, 'distribution-compatibility.json'));
}

function writeCompatibility(repoRoot: string, compatibility: Record<string, unknown>): void {
  writeJson(join(repoRoot, 'distribution-compatibility.json'), compatibility);
}

/** 用 tarball 实际内容构造 manifest 记录（绕过 createArtifactRecord 的入口校验，用于负例）。 */
function craftRecordFromTarball(tarball: string, name: string, version: string): Record<string, unknown> {
  const summary = inspectTarball(tarball);
  return {
    name,
    version,
    filename: `${name}-${version}.tgz`,
    size: summary.size,
    sha256: summary.sha256,
    packageManifestSha256: summary.fileDigests['package.json'],
    files: summary.files,
    fileDigests: summary.fileDigests,
  };
}

function replaceArtifact(fixture: Fixture, record: Record<string, unknown>): void {
  const manifest = readManifest(fixture.distributionDir);
  const artifacts = manifest['artifacts'] as Record<string, unknown>[];
  const name = record['name'];
  for (let index = 0; index < artifacts.length; index += 1) {
    if (artifacts[index]!['name'] === name) {
      artifacts[index] = record;
    }
  }
  writeManifest(fixture.distributionDir, manifest);
}

/** 手工构造 staging（不走 stagePackage 的入口校验），pack 后替换指定包的 tarball，返回 tarball 路径。 */
function packHandcraftedStage(fixture: Fixture, specId: string, mutate: (stage: string) => void): string {
  const stage = join(fixture.repoRoot, '..', `handcrafted-${specId}`);
  cpSync(join(fixture.repoRoot, `packages/${specId}`), stage, { recursive: true });
  mutate(stage);
  return packStagedPackage(stage, fixture.distributionDir);
}

beforeAll(() => {
  shared = buildSharedFixture(sandbox('shiploop-f003-shared-'));
});

describe('P08-1 / F-003 制品完整性与兼容检查', () => {
  it('[case:positive-full] 正向清单全部通过，not_run 只保留 Phase 集成且结果可脱敏引用', () => {
    const fixture = cloneFixture(sandbox('shiploop-f003-positive-'));
    const before = directoryDigests(fixture.distributionDir);
    const repoBefore = directoryDigests(fixture.repoRoot);

    const report = verify(fixture);

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(EXPECTED_CHECK_COUNT);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.summary).toEqual({ passed: EXPECTED_CHECK_COUNT, failed: 0, notRun: PHASE_INTEGRATION_IDS.length });
    expect(report.notRun.map((item) => item.id)).toEqual(PHASE_INTEGRATION_IDS);
    expect(report.notRun.every((item) => item.owner === 'phase-integration')).toBe(true);
    expect(report.environment).toEqual(ENVIRONMENT);
    expect(report.inputs.artifacts).toHaveLength(PACKAGES.length);
    for (const artifact of report.inputs.artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.filename).toBe(`${artifact.name}-${artifact.version}.tgz`);
    }
    expect(report.evidence.some((item) => item.kind === 'distribution-manifest' && /^[0-9a-f]{64}$/u.test(item.sha256))).toBe(true);
    expect(report.evidence.filter((item) => item.kind === 'tarball')).toHaveLength(PACKAGES.length);
    // 报告本身不得携带开发机绝对路径（可作为 Phase 报告证据直接引用）。
    expect(JSON.stringify(report)).not.toContain('/Users/');
    expect(JSON.stringify(report)).not.toContain('/opt/homebrew');
    // 检查是只读的：受检分发目录与仓库清单前后逐字节一致。
    expect(directoryDigests(fixture.distributionDir)).toEqual(before);
    expect(directoryDigests(fixture.repoRoot)).toEqual(repoBefore);
  });

  it('[case:tampered-tarball] 篡改 tarball 内容后身份与摘要检查失败', () => {
    const fixture = cloneFixture(sandbox('shiploop-f003-tamper-'));
    const tarball = packHandcraftedStage(fixture, 'core', (stage) => {
      writeFileSync(join(stage, 'dist/index.js'), 'export const fixture = "tampered";\n', 'utf8');
    });
    expect(tarball.endsWith('shiploop-core-0.0.0.tgz')).toBe(true);

    const report = verify(fixture);

    expect(report.passed).toBe(false);
    const identity = checkById(report, 'artifact-identity');
    expect(identity.status).toBe('failed');
    expect(identity.problems.join('\n')).toMatch(/sha256|摘要/u);
    const digests = checkById(report, 'tarball-file-digests');
    expect(digests.status).toBe('failed');
    expect(report.summary.failed).toBeGreaterThanOrEqual(1);
    expect(report.summary.passed).toBe(EXPECTED_CHECK_COUNT - report.summary.failed);
  });

  it('[case:missing-dist-file] tarball 缺少声明的 dist 入口时入口检查失败', () => {
    const fixture = cloneFixture(sandbox('shiploop-f003-missing-'));
    const tarball = packHandcraftedStage(fixture, 'core', (stage) => {
      // staging 删除 main 声明的 dist/index.js，package.json 声明保持不变。
      rmSync(join(stage, 'dist/index.js'), { force: true });
    });

    replaceArtifact(fixture, craftRecordFromTarball(tarball, 'shiploop-core', '0.0.0'));

    const report = verify(fixture);

    expect(report.passed).toBe(false);
    const entries = checkById(report, 'packaged-entries');
    expect(entries.status).toBe('failed');
    expect(entries.problems.join('\n')).toMatch(/dist\/index\.js|入口/u);
    // 摘要与身份记录与实际 tarball 一致（记录由 inspectTarball 生成），失败聚焦在缺失入口。
    expect(checkById(report, 'tarball-file-digests').status).toBe('passed');
    expect(checkById(report, 'artifact-identity').status).toBe('passed');
  });

  it('[case:version-drift] manifest 记录版本与统一版本漂移均失败', () => {
    const fixture = cloneFixture(sandbox('shiploop-f003-drift-'));
    const manifest = readManifest(fixture.distributionDir);
    const artifacts = manifest['artifacts'] as Record<string, unknown>[];
    artifacts[0]!['version'] = '0.0.1';
    writeManifest(fixture.distributionDir, manifest);

    const driftRecord = verify(fixture);
    expect(driftRecord.passed).toBe(false);
    const identity = checkById(driftRecord, 'artifact-identity');
    expect(identity.status).toBe('failed');
    expect(identity.problems.join('\n')).toMatch(/version|版本/u);

    const fixtureTwo = cloneFixture(sandbox('shiploop-f003-unified-'));
    const compatibility = readCompatibility(fixtureTwo.repoRoot);
    compatibility['unifiedVersion'] = '0.0.1';
    writeCompatibility(fixtureTwo.repoRoot, compatibility);

    const unifiedDrift = verify(fixtureTwo);
    expect(unifiedDrift.passed).toBe(false);
    expect(checkById(unifiedDrift, 'artifact-identity').status).toBe('failed');
    expect(checkById(unifiedDrift, 'artifact-identity').problems.join('\n')).toMatch(/统一版本|unified/u);
  });

  it('[case:unknown-compat-version] 未知协议版本、高 Schema 版本与声明不一致均拒绝且不降级', () => {
    const unknownProtocol = cloneFixture(sandbox('shiploop-f003-protocol-'));
    const compatibility = readCompatibility(unknownProtocol.repoRoot);
    const hostProtocol = compatibility['hostProtocol'] as Record<string, unknown>;
    hostProtocol['wireProtocolVersions'] = [...PROTOCOL_SCOPE.supportedProtocolVersions, 99];
    writeCompatibility(unknownProtocol.repoRoot, compatibility);
    const manifest = readManifest(unknownProtocol.distributionDir);
    const manifestCompatibility = manifest['compatibility'] as Record<string, unknown>;
    manifestCompatibility['hostProtocol'] = JSON.parse(JSON.stringify(hostProtocol));
    writeManifest(unknownProtocol.distributionDir, manifest);

    const protocolReport = verify(unknownProtocol);
    expect(protocolReport.passed).toBe(false);
    const protocolScope = checkById(protocolReport, 'protocol-scope');
    expect(protocolScope.status).toBe('failed');
    expect(protocolScope.problems.join('\n')).toMatch(/99/u);
    expect(protocolScope.problems.join('\n')).toMatch(/reject|拒绝|不.*降级/u);

    const highSchema = cloneFixture(sandbox('shiploop-f003-schema-'));
    const schemaCompatibility = readCompatibility(highSchema.repoRoot);
    const databaseSchema = schemaCompatibility['databaseSchema'] as Record<string, unknown>;
    const range = databaseSchema['readableAppliedVersions'] as Record<string, unknown>;
    range['max'] = DATABASE_SCOPE.maxMigrationVersion + 35;
    databaseSchema['writableTargetVersion'] = DATABASE_SCOPE.maxMigrationVersion + 35;
    writeCompatibility(highSchema.repoRoot, schemaCompatibility);
    const schemaManifest = readManifest(highSchema.distributionDir);
    const schemaManifestCompatibility = schemaManifest['compatibility'] as Record<string, unknown>;
    schemaManifestCompatibility['databaseSchema'] = JSON.parse(JSON.stringify(databaseSchema));
    writeManifest(highSchema.distributionDir, schemaManifest);

    const schemaReport = verify(highSchema);
    expect(schemaReport.passed).toBe(false);
    const databaseScope = checkById(schemaReport, 'database-schema-scope');
    expect(databaseScope.status).toBe('failed');
    expect(databaseScope.problems.join('\n')).toMatch(/迁移|migration/u);

    const mismatch = cloneFixture(sandbox('shiploop-f003-mismatch-'));
    const mismatchManifest = readManifest(mismatch.distributionDir);
    const mismatchCompatibility = mismatchManifest['compatibility'] as Record<string, unknown>;
    const mismatchHost = mismatchCompatibility['hostProtocol'] as Record<string, unknown>;
    mismatchHost['wireSchemaVersion'] = CURRENT_SCHEMA_VERSION + 10;
    writeManifest(mismatch.distributionDir, mismatchManifest);

    const mismatchReport = verify(mismatch);
    expect(mismatchReport.passed).toBe(false);
    expect(checkById(mismatchReport, 'protocol-scope').status).toBe('failed');
    expect(checkById(mismatchReport, 'protocol-scope').problems.join('\n')).toMatch(/不一致/u);
  });

  it('[case:sensitive-content] token/密钥与开发机路径内容命中失败且诊断脱敏', () => {
    const fixture = cloneFixture(sandbox('shiploop-f003-secret-'));
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const tarball = packHandcraftedStage(fixture, 'host', (stage) => {
      writeFileSync(
        join(stage, 'dist/creds.js'),
        `export const apiKey = "${secret}";\nexport const home = "/Users/dev/shiploop";\n`,
        'utf8',
      );
    });
    replaceArtifact(fixture, craftRecordFromTarball(tarball, 'shiploop-host', '0.0.0'));

    const report = verify(fixture);

    expect(report.passed).toBe(false);
    const sensitive = checkById(report, 'sensitive-content');
    expect(sensitive.status).toBe('failed');
    expect(sensitive.problems.join('\n')).toMatch(/creds\.js/u);
    expect(sensitive.problems.join('\n')).toMatch(/凭据|credential|密钥|token|路径/u);
    // 诊断不得回显命中的敏感内容本身。
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain('/Users/dev');
  });

  it('[case:dependency-closure] 悬空 workspace 依赖、未声明开发依赖与锁外依赖失败', () => {
    const dangling = cloneFixture(sandbox('shiploop-f003-dangling-'));
    const danglingTarball = packHandcraftedStage(dangling, 'host', (stage) => {
      const staging = readJson(join(stage, 'package.json'));
      staging['dependencies'] = { 'shiploop-core': 'workspace:*' };
      writeJson(join(stage, 'package.json'), staging);
      const workspace = readJson(join(dangling.repoRoot, 'packages/host/package.json'));
      workspace['dependencies'] = { 'shiploop-core': 'workspace:*' };
      writeJson(join(dangling.repoRoot, 'packages/host/package.json'), workspace);
    });
    replaceArtifact(dangling, craftRecordFromTarball(danglingTarball, 'shiploop-host', '0.0.0'));
    const danglingReport = verify(dangling);
    expect(danglingReport.passed).toBe(false);
    const danglingCheck = checkById(danglingReport, 'dependency-closure');
    expect(danglingCheck.status).toBe('failed');
    expect(danglingCheck.problems.join('\n')).toMatch(/workspace|悬空|本地路径/u);

    const devLeak = cloneFixture(sandbox('shiploop-f003-devleak-'));
    const devTarball = packHandcraftedStage(devLeak, 'host', (stage) => {
      writeFileSync(join(stage, 'dist/runtime.js'), "import { describe } from 'vitest';\nexport const t = describe;\n", 'utf8');
    });
    replaceArtifact(devLeak, craftRecordFromTarball(devTarball, 'shiploop-host', '0.0.0'));
    const devReport = verify(devLeak);
    expect(devReport.passed).toBe(false);
    const devCheck = checkById(devReport, 'dependency-closure');
    expect(devCheck.status).toBe('failed');
    expect(devCheck.problems.join('\n')).toMatch(/vitest/u);
    expect(devCheck.problems.join('\n')).toMatch(/未声明|开发依赖/u);

    const unlocked = cloneFixture(sandbox('shiploop-f003-unlocked-'));
    const unlockedTarball = packHandcraftedStage(unlocked, 'host', (stage) => {
      const staging = readJson(join(stage, 'package.json'));
      staging['dependencies'] = { 'shiploop-core': '0.0.0', 'left-pad': '1.0.0' };
      writeJson(join(stage, 'package.json'), staging);
      const workspace = readJson(join(unlocked.repoRoot, 'packages/host/package.json'));
      workspace['dependencies'] = { 'shiploop-core': '0.0.0', 'left-pad': '1.0.0' };
      writeJson(join(unlocked.repoRoot, 'packages/host/package.json'), workspace);
    });
    replaceArtifact(unlocked, craftRecordFromTarball(unlockedTarball, 'shiploop-host', '0.0.0'));
    const unlockedReport = verify(unlocked);
    expect(unlockedReport.passed).toBe(false);
    const unlockedCheck = checkById(unlockedReport, 'dependency-closure');
    expect(unlockedCheck.status).toBe('failed');
    expect(unlockedCheck.problems.join('\n')).toMatch(/left-pad|锁|lock/u);
  });

  it('[case:cli-report-and-exit] CLI 退出码与报告一致，失败报告落盘且保持脱敏', () => {
    const root = sandbox('shiploop-f003-cli-');
    const fixture = cloneFixture(root);
    // CLI 从 repoRoot 的构建产物加载真实常量；fixture 用与真实常量一致的导出模拟。
    const hostContractDir = join(fixture.repoRoot, 'packages/host/dist/contract');
    mkdirSync(hostContractDir, { recursive: true });
    writeFileSync(
      join(hostContractDir, 'constants.js'),
      `export const SUPPORTED_PROTOCOL_VERSIONS = ${JSON.stringify(PROTOCOL_SCOPE.supportedProtocolVersions)};\n` +
        `export const CURRENT_SCHEMA_VERSION = ${PROTOCOL_SCOPE.currentWireSchemaVersion};\n` +
        `export const DISCOVERY_SCHEMA_VERSION = ${PROTOCOL_SCOPE.discoverySchemaVersions[0]};\n`,
      'utf8',
    );
    writeFileSync(
      join(hostContractDir, 'handshake.js'),
      `export const LEGACY_HANDSHAKE_SCHEMA_VERSIONS_ACCEPTED = ${JSON.stringify(PROTOCOL_SCOPE.legacyHandshakeSchemaVersionsAccepted)};\n`,
      'utf8',
    );
    const migrationDir = join(fixture.repoRoot, 'packages/core/dist/adapters/sqlite');
    mkdirSync(migrationDir, { recursive: true });
    const migrationList = Array.from(
      { length: DATABASE_SCOPE.maxMigrationVersion - DATABASE_SCOPE.minMigrationVersion + 1 },
      (_, index) => ({ version: DATABASE_SCOPE.minMigrationVersion + index }),
    );
    writeFileSync(join(migrationDir, 'migrations.js'), `export const SQLITE_MIGRATIONS = ${JSON.stringify(migrationList)};\n`, 'utf8');
    const git = (args: string[]) =>
      spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], {
        cwd: fixture.repoRoot,
        encoding: 'utf8',
      });
    expect(git(['init', '-q']).status).toBe(0);
    expect(git(['add', '-A']).status).toBe(0);
    expect(git(['commit', '-q', '-m', 'fixture']).status).toBe(0);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.repoRoot, encoding: 'utf8' });
    expect(head.status).toBe(0);
    const commit = head.stdout.trim();

    const manifest = readManifest(fixture.distributionDir);
    manifest['gitCommit'] = commit;
    writeManifest(fixture.distributionDir, manifest);

    const script = join(repoRoot, 'scripts/verify-artifacts.ts');
    const reportPath = join(root, 'artifact-verification.json');
    const run = () =>
      spawnSync(
        process.execPath,
        [script, '--repo-root', fixture.repoRoot, '--input', fixture.distributionDir, '--output', reportPath],
        { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
      );

    const ok = run();
    expect(ok.status).toBe(0);
    const okReport = readJson(reportPath);
    expect(okReport['passed']).toBe(true);
    expect(okReport['environment']).toMatchObject({ gitCommit: commit, platform: 'darwin' });
    expect((okReport['notRun'] as unknown[]).map((item) => (item as { id: string }).id)).toEqual(PHASE_INTEGRATION_IDS);

    const tamperedStage = join(root, 'cli-tampered');
    cpSync(join(fixture.repoRoot, 'packages/core'), tamperedStage, { recursive: true });
    writeFileSync(join(tamperedStage, 'dist/index.js'), 'export const fixture = "cli-tampered";\n', 'utf8');
    packStagedPackage(tamperedStage, fixture.distributionDir);

    const failed = run();
    expect(failed.status).toBe(1);
    const failedReport = readJson(reportPath);
    expect(failedReport['passed']).toBe(false);
    expect(JSON.stringify(failedReport)).not.toContain('/Users/');
    expect(JSON.stringify(failedReport)).toContain('distribution');
  }, 180_000);

  it('[case:report-shape] 结构化结果区分 passed/failed/not_run 并绑定检查对象', () => {
    const fixture = cloneFixture(sandbox('shiploop-f003-shape-'));
    const report = verify(fixture);

    const statuses = report.checks.map((check) => check.status);
    expect(new Set(statuses)).toEqual(new Set(['passed']));
    for (const check of report.checks) {
      expect(check.id).toMatch(/^[a-z-]+$/u);
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.problems).toEqual([]);
      expect(check.objects.length).toBeGreaterThan(0);
    }
    // not_run 项不属于 checks，也不能被 summary 计为通过。
    expect(report.summary.notRun).toBe(PHASE_INTEGRATION_IDS.length);
    expect(report.summary.passed + report.summary.failed).toBe(report.checks.length);
    // 分发目录在仓库外时，报告使用逻辑标签而非绝对路径。
    expect(relative(fixture.repoRoot, fixture.distributionDir)).toContain('..');
    expect(report.inputs.distribution.length).toBeGreaterThan(0);
    expect(JSON.stringify(report.inputs.distribution)).not.toContain('/Users/');
  });
});
