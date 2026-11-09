/**
 * P08-2 F-007 守护测试：从干净安装目录启动打包 CLI 的 Todo 演示安装冒烟。
 *
 * 用真实临时沙箱 + 真实 npm pack/--offline install + 真实子进程验证检查器：
 * 干净安装目录只用打包 tarball 即可启动 CLI 并访问最小稳定协议；安装目录链接
 * 不得逃逸；隔离数据根与最小回执、结构化拒绝、凭据/绝对路径边界、协议漂移与
 * 源码模式一致性逐项 fail-closed；真实 registry 安装、原生模块矩阵、Git/SQLite
 * 业务流、跨进程组合与 live 交付保持 not_run，不折算为安装验收通过。
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGES, createArtifactRecord, createDistributionManifest } from '../../../scripts/pack-local.ts';
import {
  TODO_INSTALL_SMOKE_NOT_RUN,
  createProcessTodoInstallSmokePorts,
  renderTodoInstallSmokeText,
  resolveNpmCli,
  runTodoInstallSmoke,
  TodoInstallSmokeError,
  validateTodoInstallSmokeReport,
  verifyNoEscapingLinks,
  type TodoInstallSmokeEnvironment,
} from '../../../scripts/acceptance/p08-todo-install-smoke.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_BIN = join(REPO_ROOT, 'test/helpers/p08-2/todo-fixture-pack-cli.mjs');
const FIXTURE_NAME_TO_DIR: Record<string, string> = {
  'shiploop-core': 'core',
  'shiploop-host': 'host',
  'shiploop-cli': 'cli',
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

interface FixtureDistribution {
  readonly distributionDir: string;
  readonly sourceCliBin: string;
  readonly sourceCliDir: string;
}

const smokeEnvironment = (() => {
  let cached: TodoInstallSmokeEnvironment | undefined;
  return (): TodoInstallSmokeEnvironment => {
    cached ??= createProcessTodoInstallSmokePorts({ repoRoot: REPO_ROOT }).environment;
    return cached;
  };
})();

/** 构建三包夹具 tarball + 分发清单；“源码模式”基线即打包前的 cli dist。 */
function buildFixtureDistribution(options?: { readonly cliFault?: string; readonly sourceFault?: string }): FixtureDistribution {
  const root = tempRoot('shiploop-f007-dist-');
  const outputDir = join(root, 'local-pack');
  mkdirSync(outputDir, { recursive: true });
  const sourceCliDir = join(root, 'packages-cli');
  const artifacts = [];
  for (const pkg of PACKAGES) {
    const dir = join(root, FIXTURE_NAME_TO_DIR[pkg.name] ?? pkg.id);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    const dependencies =
      pkg.name === 'shiploop-cli' ? { 'shiploop-host': '0.0.0' }
      : pkg.name === 'shiploop-host' ? { 'shiploop-core': '0.0.0' }
      : {};
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: pkg.name,
        version: '0.0.0',
        type: 'module',
        files: ['dist'],
        ...(pkg.name === 'shiploop-cli' ? { bin: { shiploop: './dist/bin.js' } } : {}),
        dependencies,
      }),
    );
    copyFileSync(FIXTURE_BIN, join(dir, 'dist/bin.js'));
    chmodSync(join(dir, 'dist/bin.js'), 0o755);
    if (pkg.name === 'shiploop-cli') {
      if (options?.cliFault !== undefined) {
        writeFileSync(join(dir, 'dist/fault.json'), `${JSON.stringify({ fault: options.cliFault })}\n`);
      }
      mkdirSync(sourceCliDir, { recursive: true });
      mkdirSync(join(sourceCliDir, 'dist'), { recursive: true });
      copyFileSync(FIXTURE_BIN, join(sourceCliDir, 'dist/bin.js'));
      chmodSync(join(sourceCliDir, 'dist/bin.js'), 0o755);
      if (options?.sourceFault !== undefined) {
        writeFileSync(join(sourceCliDir, 'dist/fault.json'), `${JSON.stringify({ fault: options.sourceFault })}\n`);
      }
    }
    const npmCli = resolveNpmCli();
    const pack = spawnSync(
      npmCli.command,
      [...npmCli.prefix, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', outputDir],
      { cwd: dir, encoding: 'utf8', timeout: 60_000 },
    );
    if (pack.status !== 0) throw new Error(`fixture npm pack failed: ${pack.stderr}`);
    const record = JSON.parse(pack.stdout)[0] as { filename: string };
    artifacts.push(createArtifactRecord(join(outputDir, record.filename), pkg.name, '0.0.0'));
  }
  const environment = smokeEnvironment();
  const manifest = createDistributionManifest({
    gitCommit: environment.gitCommit,
    nodeVersion: environment.nodeVersion,
    npmVersion: environment.npmVersion,
    platform: environment.platform,
    lockfileVersion: 3,
    compatibility: {
      hostProtocol: { wireSchemaVersion: 6, wireProtocolVersions: [1] },
      databaseSchema: { readableAppliedVersions: { min: 1, max: 64 }, writableTargetVersion: 64 },
    },
    artifacts,
  });
  writeFileSync(join(outputDir, 'distribution-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { distributionDir: outputDir, sourceCliBin: join(sourceCliDir, 'dist/bin.js'), sourceCliDir };
}

const compatibility = {
  label: 'distribution-compatibility.json',
  sha256: 'a'.repeat(64),
  scope: {
    hostProtocol: { wireProtocolVersions: [1], wireSchemaVersion: 6, discoverySchemaVersions: [1] },
    databaseSchema: { engine: 'sqlite', writableTargetVersion: 64 },
  },
};

const EXPECTED_CHECK_IDS = [
  'distribution-inputs',
  'compatibility-declared',
  'clean-install-offline',
  'packaged-entry-startable',
  'runtime-dependency-inventory',
  'isolated-data-root',
  'minimal-command-receipt',
  'protocol-scope-consistent',
  'protocol-consistency-with-source',
  'secret-handling',
  'output-hygiene',
  'report-hygiene',
];

function smokePorts() {
  return createProcessTodoInstallSmokePorts({ repoRoot: REPO_ROOT });
}

describe('P08-2 F-007 干净安装目录启动打包 CLI 冒烟', () => {
  it('[case:p08-2-f007-clean-install-smoke] 夹具三包在干净安装目录离线安装并跑通最小协议', async () => {
    const fixture = buildFixtureDistribution();
    const report = await runTodoInstallSmoke({
      distributionDir: fixture.distributionDir,
      sourceCliBin: fixture.sourceCliBin,
      compatibility,
      ports: smokePorts(),
    });

    expect(report.checks.map((check) => check.id)).toEqual(EXPECTED_CHECK_IDS);
    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({ passed: EXPECTED_CHECK_IDS.length, failed: 0, notRun: TODO_INSTALL_SMOKE_NOT_RUN.length });
    for (const check of report.checks) {
      expect(check.status, `${check.id}: ${check.problems.join('; ')}`).toBe('passed');
    }
    // 干净安装：只有三个工作区包，安装 argv 不含 registry/源码引用，产物入口可用。
    expect(report.install).toMatchObject({
      mode: 'offline-local-tarballs',
      installDirLabel: 'clean-install',
      npmExitCode: 0,
      binLinkPresent: true,
      entry: { present: true, shebang: true, executable: true },
    });
    expect(report.install.runtimeDependencies).toHaveLength(3);
    expect(report.install.runtimeDependencies.every((dep) => dep.kind === 'workspace' && dep.version === '0.0.0')).toBe(true);
    // 最小稳定协议：start/status/拒绝/stop 回执形状与源码模式一致。
    expect(report.runs.installMode?.protocol).toMatchObject({
      startProtocolVersion: 1,
      startLifecycleState: 'ready',
      startOutcome: 'started',
      refusalErrorCode: 'host_not_found',
      stopStatus: 'stopped',
      discoverySchemaVersion: 1,
      discoveryProtocolVersion: 1,
    });
    expect(report.runs.sourceMode?.protocol.startProtocolVersion).toBe(1);
    expect(report.runs.consistency).toEqual({ consistent: true, differences: [] });
    // 数据根隔离与凭据事实只记形状，不记内容。
    expect(report.runs.installMode?.dataRoot).toMatchObject({
      label: 'install-mode-data-root',
      discoveryPresentAfterStart: true,
      tokenFile: { present: true, hex64: true, mode: '600' },
      discoveryRemovedAfterStop: true,
    });
    // 协议摘要进入报告（声明 vs 实测）。
    expect(report.protocol.declared).toMatchObject({ wireProtocolVersions: [1], wireSchemaVersion: 6, discoverySchemaVersions: [1] });
    // not_run 边界显式登记，不折算为通过。
    expect(report.notRun.map((item) => item.id)).toEqual(TODO_INSTALL_SMOKE_NOT_RUN.map((item) => item.id));
    expect(report.notRun.every((item) => item.owner === 'phase-integration')).toBe(true);
    // 报告可复核且脱敏：无绝对路径材料。
    expect(validateTodoInstallSmokeReport(report)).toBe(report);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain(tmpdir());
    expect(renderTodoInstallSmokeText(report)).toContain('todo-install-smoke: passed=');
  });

  it('[case:p08-2-f007-fail-closed-inputs] 分发清单缺失/篡改与兼容声明缺失阻断验收宣称', async () => {
    const missing = buildFixtureDistribution();
    rmSync(join(missing.distributionDir, 'distribution-manifest.json'));
    await expect(
      runTodoInstallSmoke({ distributionDir: missing.distributionDir, sourceCliBin: missing.sourceCliBin, compatibility, ports: smokePorts() }),
    ).rejects.toThrow(TodoInstallSmokeError);

    const tampered = buildFixtureDistribution();
    writeFileSync(join(tampered.distributionDir, 'shiploop-core-0.0.0.tgz'), 'tampered bytes\n');
    const tamperedReport = await runTodoInstallSmoke({
      distributionDir: tampered.distributionDir,
      sourceCliBin: tampered.sourceCliBin,
      compatibility,
      ports: smokePorts(),
    });
    expect(tamperedReport.passed).toBe(false);
    const failed = tamperedReport.checks.filter((check) => check.status === 'failed').map((check) => check.id);
    expect(failed).toContain('distribution-inputs');
    expect(failed).toContain('packaged-entry-startable');
    expect(tamperedReport.summary.failed).toBeGreaterThan(0);
    expect(() => validateTodoInstallSmokeReport({ ...tamperedReport, passed: true })).toThrow();

    const noCompat = buildFixtureDistribution();
    const noCompatReport = await runTodoInstallSmoke({
      distributionDir: noCompat.distributionDir,
      sourceCliBin: noCompat.sourceCliBin,
      compatibility: null,
      ports: smokePorts(),
    });
    expect(noCompatReport.passed).toBe(false);
    expect(noCompatReport.checks.filter((check) => check.status === 'failed').map((check) => check.id)).toEqual(
      expect.arrayContaining(['compatibility-declared', 'protocol-scope-consistent']),
    );
    expect(noCompatReport.protocol.declared).toBe(null);
  });

  it('[case:p08-2-f007-secret-and-path-boundary] token 外泄与绝对路径输出被抓住且报告不携带材料', async () => {
    const leaking = buildFixtureDistribution({ cliFault: 'leak-token' });
    const leakingReport = await runTodoInstallSmoke({
      distributionDir: leaking.distributionDir,
      sourceCliBin: leaking.sourceCliBin,
      compatibility,
      ports: smokePorts(),
    });
    expect(leakingReport.passed).toBe(false);
    const failedIds = leakingReport.checks.filter((check) => check.status === 'failed').map((check) => check.id);
    expect(failedIds).toContain('secret-handling');
    expect(failedIds).not.toContain('output-hygiene');

    const pathLeaking = buildFixtureDistribution({ cliFault: 'absolute-path' });
    const pathReport = await runTodoInstallSmoke({
      distributionDir: pathLeaking.distributionDir,
      sourceCliBin: pathLeaking.sourceCliBin,
      compatibility,
      ports: smokePorts(),
    });
    expect(pathReport.passed).toBe(false);
    const pathFailed = pathReport.checks.filter((check) => check.status === 'failed').map((check) => check.id);
    expect(pathFailed).toContain('output-hygiene');
    expect(pathFailed).not.toContain('secret-handling');
    // 报告本身永不携带被泄漏的材料。
    expect(JSON.stringify(pathReport)).not.toContain('/Users/');
    expect(JSON.stringify(pathReport)).not.toMatch(/\/private\/var\/folders\//);
  });

  it('[case:p08-2-f007-protocol-drift] 打包模式协议漂移与源码模式不一致分别阻断', async () => {
    const installDrift = buildFixtureDistribution({ cliFault: 'protocol-drift' });
    const driftReport = await runTodoInstallSmoke({
      distributionDir: installDrift.distributionDir,
      sourceCliBin: installDrift.sourceCliBin,
      compatibility,
      ports: smokePorts(),
    });
    expect(driftReport.passed).toBe(false);
    expect(driftReport.checks.filter((check) => check.status === 'failed').map((check) => check.id)).toEqual(
      expect.arrayContaining(['protocol-scope-consistent', 'protocol-consistency-with-source']),
    );
    expect(driftReport.runs.installMode?.protocol.startProtocolVersion).toBe(2);

    const sourceDrift = buildFixtureDistribution({ sourceFault: 'protocol-drift' });
    const sourceReport = await runTodoInstallSmoke({
      distributionDir: sourceDrift.distributionDir,
      sourceCliBin: sourceDrift.sourceCliBin,
      compatibility,
      ports: smokePorts(),
    });
    expect(sourceReport.passed).toBe(false);
    expect(sourceReport.runs.consistency?.consistent).toBe(false);
    expect(sourceReport.runs.consistency?.differences.length).toBeGreaterThan(0);
  });

  it('[case:p08-2-f007-escaping-link-rejected] 安装目录符号链接逃逸被拒绝，内部链接允许', () => {
    const root = tempRoot('shiploop-f007-links-');
    const installDir = join(root, 'install');
    mkdirSync(join(installDir, 'node_modules/shiploop-cli/dist'), { recursive: true });
    mkdirSync(join(installDir, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(installDir, 'node_modules/shiploop-cli/dist/bin.js'), '#!/usr/bin/env node\n');
    symlinkSync('../shiploop-cli/dist/bin.js', join(installDir, 'node_modules/.bin/shiploop'));
    expect(verifyNoEscapingLinks(installDir)).toEqual([]);

    symlinkSync(REPO_ROOT, join(installDir, 'node_modules/shiploop-cli/src-link'));
    const problems = verifyNoEscapingLinks(installDir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('src-link');
    expect(problems[0]).not.toContain('/Users/');
  });

  it('[case:p08-2-f007-index-registration] F-007 索引、阶段清单与文档登记完整', () => {
    const indexPath = 'test/index/phases/P08/features/P08-2/tasks/F-007.json';
    expect(existsSync(join(REPO_ROOT, indexPath))).toBe(true);
    const index = JSON.parse(readFileSync(join(REPO_ROOT, indexPath), 'utf8')) as {
      schema_version: number;
      task_id: string;
      projects: { tests: { file: string; all: boolean; level: string }[] }[];
    };
    expect(index.schema_version).toBe(2);
    expect(index.task_id).toBe('F-007');
    const files = index.projects[0]!.tests.map((entry) => entry.file);
    expect(files).toContain('test/modules/acceptance/p08-2-f007-todo-install-smoke.test.ts');
    expect(files).toContain('test/modules/acceptance/p08-2-f006-todo-live-report.test.ts');
    expect(index.projects[0]!.tests.every((entry) => entry.level === 'unit' && entry.all)).toBe(true);

    const stages = JSON.parse(readFileSync(join(REPO_ROOT, 'test/stages.json'), 'utf8')) as { light: string[] };
    expect(stages.light).toContain('test/modules/acceptance/p08-2-f007-todo-install-smoke.test.ts');

    const featureIndex = JSON.parse(readFileSync(join(REPO_ROOT, 'test/index/phases/P08/features/P08-2/feature.json'), 'utf8')) as {
      tasks: { task_id: string }[];
    };
    expect(featureIndex.tasks.map((entry) => entry.task_id)).toContain('F-007');

    const readme = readFileSync(join(REPO_ROOT, 'test/README.md'), 'utf8');
    expect(readme).toContain('index/phases/P08/features/P08-2/tasks/F-007.json');
    expect(readFileSync(join(REPO_ROOT, 'docs/phases/p08/p08-2-todo-install-smoke.md'), 'utf8')).toContain('F-007');
  });
});
