/**
 * P08-4 / F-005 干净安装与本地 pack 产物的阶段检查接线（unit，确定性）。
 *
 * 覆盖验收映射：
 * - 产物清单：三包 tarball + distribution manifest 完整性与身份（缺件 fail-closed）；
 * - 身份摘要：tarball/包清单 sha256 与 distribution manifest 逐项核对（篡改失败）；
 * - 兼容边界：release manifest / distribution manifest 的协议与 Schema 范围
 *   必须与冻结期望一致，未知/更高版本策略必须 reject；
 * - 路径/凭据扫描：产物内容中的个人绝对路径、Harness 路径、Nezha 引用与
 *   疑似凭据 fail-closed；
 * - 失败映射：每类输入错误映射到稳定检查 id 与 code，整体状态 fail-closed，
 *   诊断脱敏保留；真实独立目录安装、better-sqlite3 加载、Host 启动与 CLI
 *   操作登记为 phase-integration not_run，不折算为通过。
 *
 * 夹具使用纯 Node tar 写入器构建真实 tgz（无 npm 子进程、无网络、无模型），
 * 全部在临时目录执行并清理。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createDistributionManifest } from '../../../scripts/pack-local.ts';
import {
  P08_INSTALL_CHECK_IDS,
  P08_INSTALL_CHECK_NOT_RUN,
  loadP08InstallExpectedScope,
  runP08InstallProductCheck,
  type P08InstallCheckReport,
} from '../../../scripts/acceptance/p08-install-check.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VERSION = '0.0.0';
const TOOLCHAIN_PROBE = () => ({ nodeVersion: '22.19.0', npmVersion: '10.9.3', platform: 'darwin' });
const EXPECTED = loadP08InstallExpectedScope(REPO_ROOT);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

/* -------------------------- 纯 Node tar 写入器 -------------------------- */

interface FixtureFile {
  readonly path: string;
  readonly data: string;
  readonly mode?: number;
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

function buildTarball(files: readonly FixtureFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data, 'utf8');
    blocks.push(tarHeader(file.path, data.byteLength, file.mode ?? 0o644));
    blocks.push(data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

/* ------------------------------ 三包夹具 ------------------------------ */

function packageJson(name: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({ name, version: VERSION, private: true, type: 'module', files: ['dist'], ...extra }, null, 2)}\n`;
}

interface PackageFixture {
  readonly name: string;
  readonly files: readonly FixtureFile[];
}

function corePackage(): PackageFixture {
  return {
    name: 'shiploop-core',
    files: [
      { path: 'package.json', data: packageJson('shiploop-core', {
        main: './dist/index.js', types: './dist/index.d.ts',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './protocol': { types: './dist/protocol.d.ts', default: './dist/protocol.js' },
        },
        engines: { node: '22.19.0', npm: '10.9.3' }, os: ['darwin'],
        dependencies: { 'better-sqlite3': '13.0.3', 'drizzle-orm': '0.45.3' },
      }) },
      { path: 'dist/index.js', data: 'export const value = 1;\n' },
      { path: 'dist/index.d.ts', data: 'export declare const value: number;\n' },
      { path: 'dist/protocol.js', data: 'export const wireSchemaVersion = 6;\n' },
      { path: 'dist/protocol.d.ts', data: 'export declare const wireSchemaVersion: number;\n' },
    ],
  };
}

function hostPackage(): PackageFixture {
  return {
    name: 'shiploop-host',
    files: [
      { path: 'package.json', data: packageJson('shiploop-host', {
        main: './dist/index.js', types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        engines: { node: '22.19.0', npm: '10.9.3' }, os: ['darwin'],
        dependencies: { 'shiploop-core': VERSION, '@earendil-works/chord': '1.0.4' },
      }) },
      { path: 'dist/index.js', data: 'export const host = true;\n' },
      { path: 'dist/index.d.ts', data: 'export declare const host: boolean;\n' },
    ],
  };
}

function cliPackage(): PackageFixture {
  return {
    name: 'shiploop-cli',
    files: [
      { path: 'package.json', data: packageJson('shiploop-cli', {
        main: './dist/index.js', types: './dist/index.d.ts',
        bin: { shiploop: './dist/bin.js' },
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        engines: { node: '22.19.0', npm: '10.9.3' }, os: ['darwin'],
        dependencies: { 'shiploop-host': VERSION },
      }) },
      { path: 'dist/index.js', data: 'export const cli = true;\n' },
      { path: 'dist/index.d.ts', data: 'export declare const cli: boolean;\n' },
      { path: 'dist/bin.js', data: '#!/usr/bin/env node\nimport { cli } from "./index.js";\n', mode: 0o755 },
    ],
  };
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function artifactRecord(pkg: PackageFixture, tarball: Buffer) {
  const fileDigests: Record<string, string> = {};
  for (const file of pkg.files) fileDigests[file.path] = sha256Hex(file.data);
  return {
    name: pkg.name, version: VERSION, filename: `${pkg.name}-${VERSION}.tgz`,
    size: tarball.byteLength, sha256: sha256Hex(tarball),
    packageManifestSha256: fileDigests['package.json'] as string,
    files: Object.keys(fileDigests), fileDigests,
  };
}

type Json = Record<string, unknown>;

interface FixtureOptions {
  /** 按包名改写夹具文件集（如替换依赖、删入口、注入可疑内容）。 */
  readonly mutatePackage?: (name: string, files: readonly FixtureFile[]) => readonly FixtureFile[];
  /** 写盘前改写 distribution manifest（如改制品摘要）。 */
  readonly mutateManifest?: (manifest: Json) => void;
  /** 写盘后删除指定包的 tarball。 */
  readonly omitTarball?: string;
  /** 改写 release manifest 传参。 */
  readonly releaseManifestTransform?: (manifest: Json) => void;
}

function buildFixture(options: FixtureOptions = {}): { readonly artifactDir: string; readonly releaseManifest: Json } {
  const root = tempRoot('p08-f005-install-');
  const artifactDir = join(root, 'local-pack');
  mkdirSync(artifactDir, { recursive: true });
  const packages = [corePackage(), hostPackage(), cliPackage()];
  const artifacts = packages.map(pkg => {
    const files = options.mutatePackage?.(pkg.name, pkg.files) ?? pkg.files;
    const tarball = buildTarball(files);
    writeFileSync(join(artifactDir, `${pkg.name}-${VERSION}.tgz`), tarball);
    return artifactRecord({ name: pkg.name, files }, tarball);
  });
  const manifest = createDistributionManifest({
    gitCommit: 'a'.repeat(40), nodeVersion: '22.19.0', npmVersion: '10.9.3',
    platform: 'darwin', lockfileVersion: 3,
    compatibility: { hostProtocol: EXPECTED.hostProtocol, databaseSchema: EXPECTED.databaseSchema },
    artifacts,
  }) as unknown as Json;
  options.mutateManifest?.(manifest);
  writeFileSync(join(artifactDir, 'distribution-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.omitTarball !== undefined) {
    rmSync(join(artifactDir, `${options.omitTarball}-${VERSION}.tgz`), { force: true });
  }
  const releaseManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'acceptance/p08-1.release-manifest.json'), 'utf8')) as Json;
  options.releaseManifestTransform?.(releaseManifest);
  return { artifactDir, releaseManifest };
}

function run(artifactDir: string, releaseManifest: Json, extra: { readonly toolchainProbe?: () => { nodeVersion: string; npmVersion: string; platform: string } } = {}): P08InstallCheckReport {
  return runP08InstallProductCheck({
    artifactDir, releaseManifest, expected: EXPECTED,
    toolchainProbe: extra.toolchainProbe ?? TOOLCHAIN_PROBE,
  }).report;
}

function checkStatus(report: { readonly checks: readonly { readonly id: string; readonly status: string }[] }, id: string): string {
  return report.checks.find(check => check.id === id)?.status ?? 'missing';
}

function codes(report: { readonly findings: readonly { readonly check: string; readonly code: string }[] }, check: string): string[] {
  return report.findings.filter(finding => finding.check === check).map(finding => finding.code);
}

describe('P08-4 F-005 干净安装与本地 pack 产物检查', () => {
  it('[case:p08-f005-clean-product-pass] 三包夹具在独立临时目录全部通过并记录边界 not_run', () => {
    const fixture = buildFixture();
    const report = run(fixture.artifactDir, fixture.releaseManifest);

    expect(report.status).toBe('passed');
    expect(report.checks.map(check => check.id)).toEqual([...P08_INSTALL_CHECK_IDS]);
    expect(report.checks.every(check => check.status === 'pass')).toBe(true);
    expect(report.artifacts.map(artifact => artifact.name)).toEqual(['shiploop-cli', 'shiploop-core', 'shiploop-host']);
    expect(report.artifacts.find(artifact => artifact.name === 'shiploop-cli')?.bin).toEqual(['shiploop']);
    expect(report.environment).toMatchObject({ nodeVersion: '22.19.0', npmVersion: '10.9.3', platform: 'darwin', probe: 'injected' });
    expect(report.preconditions.evidenceSource).toBe('staged-tarball-bytes');
    expect(report.cleanup.status).toBe('completed');
    expect(report.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.notRunBoundary.map(item => item.id)).toEqual(P08_INSTALL_CHECK_NOT_RUN.map(item => item.id));
    expect(report.notRunBoundary.every(item => item.owner === 'phase-integration')).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain(fixture.artifactDir);
  });

  it('[case:p08-f005-missing-artifact-fail-closed] 缺少 tarball 或 manifest 时 fail-closed 并保留脱敏诊断', () => {
    const fixture = buildFixture({ omitTarball: 'shiploop-host' });
    const report = run(fixture.artifactDir, fixture.releaseManifest);
    expect(report.status).toBe('failed');
    expect(checkStatus(report, 'artifact-manifest')).toBe('fail');
    expect(codes(report, 'artifact-manifest')).toContain('missing_artifact');
    // 可解析子集的摘要照常核对；内部闭包因缺件真实无法解析。
    expect(checkStatus(report, 'file-digests')).toBe('pass');
    expect(codes(report, 'dependency-closure')).toContain('closure_unresolved');
    expect(report.cleanup.status).toBe('completed');

    const diagnosticsRoot = join(tempRoot('p08-f005-diag-'), 'diagnostics');
    const failedAgain = runP08InstallProductCheck({
      artifactDir: fixture.artifactDir, releaseManifest: fixture.releaseManifest, expected: EXPECTED,
      toolchainProbe: TOOLCHAIN_PROBE,
      diagnostics: { dir: diagnosticsRoot },
      identity: { runId: 'p08-run-1', testedCommit: 'a'.repeat(40) },
    });
    expect(failedAgain.report.status).toBe('failed');
    expect(failedAgain.diagnosticsFile).not.toBeNull();
    const files = readdirSync(diagnosticsRoot);
    expect(files.length).toBe(1);
    const diagnostic = readFileSync(join(diagnosticsRoot, files[0] as string), 'utf8');
    expect(diagnostic).toContain('"status": "failed"');
    expect(diagnostic).not.toContain('/Users/');
    expect(diagnostic).not.toContain(tmpdir());

    const noManifest = buildFixture({ omitTarball: 'shiploop-cli' });
    rmSync(join(noManifest.artifactDir, 'distribution-manifest.json'), { force: true });
    const manifestMissing = run(noManifest.artifactDir, noManifest.releaseManifest);
    expect(manifestMissing.status).toBe('failed');
    expect(codes(manifestMissing, 'install-preconditions')).toContain('distribution_manifest_missing');
    expect(checkStatus(manifestMissing, 'artifact-manifest')).toBe('not_run');
  });

  it('[case:p08-f005-digest-mismatch] 篡改 tarball 字节或包内文件摘要时失败关闭', () => {
    const tampered = buildFixture();
    const tarballPath = join(tampered.artifactDir, `shiploop-core-${VERSION}.tgz`);
    writeFileSync(tarballPath, Buffer.concat([readFileSync(tarballPath), Buffer.from('\n')]));
    const tamperReport = run(tampered.artifactDir, tampered.releaseManifest);
    expect(tamperReport.status).toBe('failed');
    expect(codes(tamperReport, 'artifact-manifest')).toContain('artifact_digest_mismatch');

    // 制品整体摘要改一致、包内文件摘要过期：file-digests 独立失败。
    const stale = buildFixture();
    const coreFiles = corePackage().files.map(file => file.path === 'dist/index.js'
      ? { ...file, data: 'export const value = 2;\n' }
      : file);
    const rebuilt = buildTarball(coreFiles);
    writeFileSync(join(stale.artifactDir, `shiploop-core-${VERSION}.tgz`), rebuilt);
    const manifestPath = join(stale.artifactDir, 'distribution-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Json;
    const coreArtifact = (manifest.artifacts as Json[]).find(artifact => artifact.name === 'shiploop-core')!;
    coreArtifact.sha256 = sha256Hex(rebuilt);
    coreArtifact.size = rebuilt.byteLength;
    // fileDigests 保留旧值 → file-digests 必须独立失败。
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const staleReport = run(stale.artifactDir, stale.releaseManifest);
    expect(staleReport.status).toBe('failed');
    expect(codes(staleReport, 'file-digests')).toContain('file_digest_mismatch');
    expect(codes(staleReport, 'artifact-manifest')).not.toContain('artifact_digest_mismatch');
  });

  it('[case:p08-f005-local-path-dependency] workspace/绝对路径依赖与闭包缺口失败关闭', () => {
    const workspaceDep = buildFixture({
      mutatePackage: (name, files) => name === 'shiploop-host'
        ? files.map(file => file.path === 'package.json'
          ? { ...file, data: file.data.replace('"shiploop-core": "0.0.0"', '"shiploop-core": "workspace:*"') }
          : file)
        : files,
    });
    const workspaceReport = run(workspaceDep.artifactDir, workspaceDep.releaseManifest);
    expect(workspaceReport.status).toBe('failed');
    expect(codes(workspaceReport, 'dependency-closure')).toContain('local_path_dependency');

    const closureGap = buildFixture({
      mutatePackage: (name, files) => name === 'shiploop-cli'
        ? files.map(file => file.path === 'package.json'
          ? { ...file, data: file.data.replace('"shiploop-host": "0.0.0"', '"shiploop-host": "9.9.9"') }
          : file)
        : files,
    });
    const closureReport = run(closureGap.artifactDir, closureGap.releaseManifest);
    expect(closureReport.status).toBe('failed');
    expect(codes(closureReport, 'dependency-closure')).toContain('closure_unresolved');
  });

  it('[case:p08-f005-unbuilt-entry] 声明的 bin/exports 入口缺失时失败关闭', () => {
    const fixture = buildFixture({
      mutatePackage: (name, files) => name === 'shiploop-cli'
        ? files.filter(file => file.path !== 'dist/bin.js' && file.path !== 'dist/index.js')
        : files,
    });
    const report = run(fixture.artifactDir, fixture.releaseManifest);
    expect(report.status).toBe('failed');
    expect(checkStatus(report, 'entries-built')).toBe('fail');
    const entryCodes = codes(report, 'entries-built');
    expect(entryCodes).toContain('unbuilt_entry');
    expect(entryCodes.filter(code => code === 'unbuilt_entry').length).toBeGreaterThanOrEqual(2);
  });

  it('[case:p08-f005-compat-out-of-scope] 协议/Schema 范围越界与缺失拒绝策略失败关闭', () => {
    const protocolDrift = buildFixture({
      releaseManifestTransform: manifest => {
        const compatibility = manifest.compatibility as Json;
        const hostProtocol = compatibility.hostProtocol as Json;
        hostProtocol.wireSchemaVersion = 99;
      },
    });
    const protocolReport = run(protocolDrift.artifactDir, protocolDrift.releaseManifest);
    expect(protocolReport.status).toBe('failed');
    expect(codes(protocolReport, 'compatibility-scope')).toContain('protocol_out_of_scope');

    const noReject = buildFixture({
      releaseManifestTransform: manifest => {
        const compatibility = manifest.compatibility as Json;
        (compatibility.hostProtocol as Json).unknownVersionPolicy = 'allow';
      },
    });
    const policyReport = run(noReject.artifactDir, noReject.releaseManifest);
    expect(policyReport.status).toBe('failed');
    expect(codes(policyReport, 'compatibility-scope')).toContain('reject_policy_missing');
  });

  it('[case:p08-f005-nezha-credential-scan] Nezha 运行时依赖、Harness 路径与疑似凭据失败关闭', () => {
    const fixture = buildFixture({
      mutatePackage: (name, files) => {
        if (name === 'shiploop-host') {
          return files.map(file => file.path === 'package.json'
            ? { ...file, data: file.data.replace('"@earendil-works/chord": "1.0.4"', '"@earendil-works/chord": "1.0.4", "nezha-orchestrator": "1.0.0"') }
            : file);
        }
        if (name === 'shiploop-core') {
          return [
            ...files,
            { path: 'dist/legacy.js', data: 'import { spawn } from "nezha/rpc";\n' },
            { path: 'dist/notes.txt', data: 'token=sk-AbCdEfGhIjKlMnOpQrStUv\npath=/Users/dev/project/secret\n' },
          ];
        }
        return files;
      },
    });
    const report = run(fixture.artifactDir, fixture.releaseManifest);
    expect(report.status).toBe('failed');
    expect(codes(report, 'runtime-isolation')).toContain('nezha_runtime_dependency');
    expect(codes(report, 'runtime-isolation')).toContain('nezha_import_reference');
    expect(codes(report, 'content-hygiene')).toContain('suspected_credential');
    expect(codes(report, 'content-hygiene')).toContain('personal_absolute_path');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('/Users/dev/project/secret');
    expect(serialized).not.toContain('sk-AbCdEfGhIjKlMnOpQrStUv');
  });

  it('[case:p08-f005-toolchain-and-dev-dir-guards] 工具链漂移与开发目录捷径失败关闭且报告脱敏', () => {
    const fixture = buildFixture();
    const drift = run(fixture.artifactDir, fixture.releaseManifest, {
      toolchainProbe: () => ({ nodeVersion: '23.0.0', npmVersion: '10.9.3', platform: 'darwin' }),
    });
    expect(drift.status).toBe('failed');
    expect(codes(drift, 'install-preconditions')).toContain('toolchain_mismatch');
    expect(drift.environment.nodeVersion).toBe('23.0.0');

    const devDir = join(tempRoot('p08-f005-devdir-'), 'node_modules', 'shiploop');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(devDir, 'distribution-manifest.json'), readFileSync(join(fixture.artifactDir, 'distribution-manifest.json')));
    for (const name of ['shiploop-core', 'shiploop-host', 'shiploop-cli']) {
      writeFileSync(join(devDir, `${name}-${VERSION}.tgz`), readFileSync(join(fixture.artifactDir, `${name}-${VERSION}.tgz`)));
    }
    const shortcut = run(devDir, fixture.releaseManifest);
    expect(shortcut.status).toBe('failed');
    expect(codes(shortcut, 'clean-product-evidence')).toContain('dev_workspace_input');
    expect(JSON.stringify(shortcut)).not.toContain('node_modules/shiploop');
  });
});
