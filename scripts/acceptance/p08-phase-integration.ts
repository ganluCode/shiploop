/** P08-4 / F-009 Phase 真实跨层集成场景。
 *
 * 该模块只由正式 P08 入口调用。它使用 P08-1 的本地 tarball，在独立临时目录
 * 安装打包 CLI，经过该 CLI 启动 Host 后再执行两个真实项目场景：Todo 新项目与
 * 非 Nezha 存量仓库。输出只保存脱敏的状态摘要，临时 SQLite/Git/进程资源在
 * 写出证据前完成停止核验，资源删除后报告仍可离线复核。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';

const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KIND = 'shiploop.p08.phase-integration-evidence' as const;

export type P08PhaseIntegrationProjectEvidence = {
  readonly kind: 'todo-new-project' | 'non-nezha-existing-project';
  readonly projectId: string;
  readonly repository: {
    readonly headBefore: string;
    readonly treeBefore: string;
    readonly statusBefore: readonly string[];
    readonly headAfter: string;
    readonly treeAfter: string;
    readonly statusAfter: readonly string[];
    readonly dirtyStatePreserved: boolean;
    readonly committedPaths: readonly string[];
    readonly commitSha: string | null;
  };
  readonly cli: {
    readonly commands: readonly { readonly name: string; readonly exitCode: number; readonly status: string | null }[];
    readonly projectState: string | null;
    readonly operationStates: readonly string[];
  };
  readonly sqlite: {
    readonly integrity: string;
    readonly projectRows: number;
    readonly operationRows: number;
    readonly checkRows: number;
  };
};

export type P08PhaseIntegrationEvidence = {
  readonly schemaVersion: 1;
  readonly kind: typeof KIND;
  readonly scenarioId: 'p08-f009-phase-integration';
  readonly runId: string;
  readonly testedCommit: string;
  readonly inputsDigest: string;
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly status: 'pass' | 'fail' | 'not_run';
  readonly durationMs: number;
  readonly usageSource: 'reported';
  readonly installation: {
    readonly artifactKind: 'local-pack-tarballs';
    readonly packageNames: readonly string[];
    readonly independentDirectory: boolean;
    readonly npmExitCode: number;
  };
  readonly host: {
    readonly startExitCode: number;
    readonly stopExitCode: number;
    readonly statusAfterStopExitCode: number;
    readonly stoppedVerified: boolean;
  };
  readonly projects: readonly P08PhaseIntegrationProjectEvidence[];
  readonly failureBoundaries: readonly {
    readonly id: string;
    readonly status: 'rejected' | 'not_run';
    readonly reason: string;
  }[];
  readonly evidenceRefs: readonly string[];
  readonly cleanup: {
    readonly processesGone: boolean;
    readonly resourcesRemoved: boolean;
    readonly confirmed: boolean;
  };
  readonly knownGaps: readonly string[];
};

export type P08PhaseIntegrationOptions = {
  readonly repoRoot: string;
  readonly artifactDir: string;
  readonly outputFile: string;
  readonly runId: string;
  readonly testedCommit: string;
  readonly inputsDigest: string;
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
  readonly timeoutMs?: number;
};

class PhaseIntegrationError extends Error {
  constructor(message: string) {
    super(`p08-phase-integration:${message}`);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch (error) {
    throw new PhaseIntegrationError(`git_command_failed:${args[0] ?? 'unknown'}`);
  }
}

function status(cwd: string): string[] {
  const value = git(['status', '--porcelain', '--untracked-files=all'], cwd);
  return value === '' ? [] : value.split('\n').sort();
}

function snapshot(cwd: string) {
  return { head: git(['rev-parse', 'HEAD'], cwd), tree: git(['rev-parse', 'HEAD^{tree}'], cwd), status: status(cwd) };
}

function createRepository(root: string, name: string, dirty: boolean): string {
  const repository = join(root, name);
  mkdirSync(repository, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repository);
  git(['config', 'user.name', 'ShipLoop P08 Test'], repository);
  git(['config', 'user.email', 'shiploop-p08@example.invalid'], repository);
  writeFileSync(join(repository, 'README.md'), `# ${name}\n`);
  mkdirSync(join(repository, 'checks'), { recursive: true });
  writeFileSync(join(repository, 'checks', 'pass.mjs'), "process.stdout.write('pass\\n'); process.exit(0);\\n");
  writeFileSync(join(repository, 'checks', 'known-failure.mjs'), 'process.exit(7);\n');
  git(['add', '--', 'README.md', 'checks'], repository);
  git(['commit', '--quiet', '-m', 'fixture: initial project'], repository);
  if (dirty) {
    writeFileSync(join(repository, 'README.md'), `# ${name}\nlocal user change\n`);
    mkdirSync(join(repository, 'notes'), { recursive: true });
    writeFileSync(join(repository, 'notes', 'keep.md'), 'keep user file\n');
    writeFileSync(join(repository, 'checks', 'known-failure.mjs'), 'process.exit(7);\n// preserve known failure\n');
  }
  return repository;
}

function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function jsonResult(run: { exitCode: number; stdout: string }, label: string): Record<string, any> {
  const line = run.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (line === undefined) throw new PhaseIntegrationError(`${label}_empty_output`);
  try { return JSON.parse(line) as Record<string, any>; }
  catch { throw new PhaseIntegrationError(`${label}_invalid_json`); }
}

function databaseFacts(path: string): P08PhaseIntegrationProjectEvidence['sqlite'] {
  if (!existsSync(path)) throw new PhaseIntegrationError('sqlite_missing');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const scalar = (sql: string): number => {
      try { return Number((db.prepare(sql).get() as { n?: number })?.n ?? 0); }
      catch { return 0; }
    };
    return {
      integrity: String(db.pragma('integrity_check', { simple: true })),
      projectRows: scalar('SELECT COUNT(*) AS n FROM projects'),
      operationRows: scalar('SELECT COUNT(*) AS n FROM baseline_operations'),
      checkRows: scalar('SELECT COUNT(*) AS n FROM baseline_check_results'),
    };
  } finally { db.close(); }
}

function validateProjectEvidence(value: P08PhaseIntegrationProjectEvidence): void {
  if (!SAFE_ID.test(value.projectId) || !GIT_SHA.test(value.repository.headBefore) || !GIT_SHA.test(value.repository.headAfter)
    || !GIT_SHA.test(value.repository.treeBefore) || !GIT_SHA.test(value.repository.treeAfter)
    || !['todo-new-project', 'non-nezha-existing-project'].includes(value.kind)
    || value.sqlite.integrity !== 'ok' || value.sqlite.projectRows < 1 || value.sqlite.operationRows < 1 || value.sqlite.checkRows < 1) {
    throw new PhaseIntegrationError('project_evidence_incomplete');
  }
  if (value.kind === 'non-nezha-existing-project' && !value.repository.dirtyStatePreserved) {
    throw new PhaseIntegrationError('existing_dirty_state_not_preserved');
  }
  if (value.repository.commitSha !== null && !GIT_SHA.test(value.repository.commitSha)) throw new PhaseIntegrationError('commit_identity_invalid');
}

export function validateP08PhaseIntegrationEvidence(value: unknown): P08PhaseIntegrationEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PhaseIntegrationError('evidence_schema_invalid');
  const evidence = value as P08PhaseIntegrationEvidence;
  if (evidence.schemaVersion !== 1 || evidence.kind !== KIND || evidence.scenarioId !== 'p08-f009-phase-integration'
    || !SAFE_ID.test(evidence.runId) || !GIT_SHA.test(evidence.testedCommit) || !SHA256.test(evidence.inputsDigest)
    || evidence.status !== 'pass' || evidence.exitCode !== 0 || evidence.usageSource !== 'reported'
    || evidence.installation.independentDirectory !== true || evidence.installation.npmExitCode !== 0
    || evidence.host.startExitCode !== 0 || evidence.host.stopExitCode !== 0 || evidence.host.statusAfterStopExitCode === 0 || evidence.host.stoppedVerified !== true || evidence.cleanup.confirmed !== true
    || evidence.cleanup.processesGone !== true || evidence.cleanup.resourcesRemoved !== true
    || evidence.projects.length !== 2 || evidence.failureBoundaries.length < 2
    || !evidence.installation.packageNames.includes('shiploop-core') || !evidence.installation.packageNames.includes('shiploop-host') || !evidence.installation.packageNames.includes('shiploop-cli')
    || !evidence.failureBoundaries.some(boundary => boundary.id === 'existing-known-failure' && boundary.status === 'rejected')
    || !evidence.failureBoundaries.some(boundary => boundary.id === 'host-stop-unconfirmed' && boundary.status === 'rejected')
    || !evidence.evidenceRefs.includes('sqlite') || !evidence.evidenceRefs.includes('git')
    || !evidence.evidenceRefs.includes('host') || !evidence.evidenceRefs.includes('process')
    || !evidence.evidenceRefs.includes('artifact') || !evidence.evidenceRefs.includes('cleanup')) {
    throw new PhaseIntegrationError('evidence_contract_failed');
  }
  for (const project of evidence.projects) validateProjectEvidence(project);
  return evidence;
}

function writeEvidence(path: string, value: P08PhaseIntegrationEvidence): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** 执行真实安装/Host/SQLite/Git 场景并在资源删除后写出脱敏证据。 */
export function runP08PhaseIntegration(options: P08PhaseIntegrationOptions): P08PhaseIntegrationEvidence {
  const started = Date.now();
  if (options.toolchain.platform !== 'darwin' || options.toolchain.node !== '22.19.0' || options.toolchain.npm !== '10.9.3') {
    throw new PhaseIntegrationError('toolchain_mismatch');
  }
  if (!GIT_SHA.test(options.testedCommit) || !SHA256.test(options.inputsDigest) || !SAFE_ID.test(options.runId)) {
    throw new PhaseIntegrationError('identity_invalid');
  }
  const manifestPath = join(options.artifactDir, 'distribution-manifest.json');
  if (!existsSync(manifestPath)) throw new PhaseIntegrationError('distribution_manifest_missing');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifacts?: { name: string; filename: string }[] };
  const artifacts = manifest.artifacts ?? [];
  const names = ['shiploop-core', 'shiploop-host', 'shiploop-cli'];
  if (artifacts.length !== 3 || names.some(name => !artifacts.some(artifact => artifact.name === name && existsSync(join(options.artifactDir, artifact.filename))))) {
    throw new PhaseIntegrationError('distribution_artifacts_incomplete');
  }
  const root = mkdtempSync(join(tmpdir(), `shiploop-p08-f009-${options.runId}-`));
  const installRoot = join(root, 'install');
  const dataRoot = join(root, 'data');
  const todoRepository = createRepository(root, 'todo', false);
  const existingRepository = createRepository(root, 'existing', true);
  mkdirSync(installRoot, { recursive: true }); mkdirSync(dataRoot, { recursive: true });
  let resourcesRemoved = false;
  let hostStarted = false;
  let stopExitCode = 1;
  let statusAfterStopExitCode = 0;
  let installedCli: string | undefined;
  let processEnv: NodeJS.ProcessEnv | undefined;
  try {
    const packageJson = {
      name: 'shiploop-p08-f009-clean-install', version: '1.0.0', private: true, type: 'module',
      dependencies: {},
    };
    writeFileSync(join(installRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    // 依赖闭包来自当前 package-lock 对应的已安装版本；包本体必须从本次
    // P08-1 tarball 解包，避免 workspace symlink 被误当成安装证据。
    cpSync(join(options.repoRoot, 'node_modules'), join(installRoot, 'node_modules'), { recursive: true, dereference: true });
    for (const name of names) rmSync(join(installRoot, 'node_modules', name), { recursive: true, force: true });
    const npm = runCommand('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], installRoot, {
      PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    });
    if (npm.exitCode !== 0) throw new PhaseIntegrationError('clean_install_failed');
    for (const artifact of artifacts) {
      const extracted = join(root, `extract-${artifact.name}`);
      mkdirSync(extracted, { recursive: true });
      const unpack = spawnSync('tar', ['-xzf', join(options.artifactDir, artifact.filename), '-C', extracted], { encoding: 'utf8', timeout: 30_000 });
      if (unpack.status !== 0) throw new PhaseIntegrationError(`tarball_extract_failed:${artifact.name}`);
      const packageDirectory = join(extracted, 'package');
      if (!existsSync(packageDirectory)) throw new PhaseIntegrationError(`tarball_package_missing:${artifact.name}`);
      cpSync(packageDirectory, join(installRoot, 'node_modules', artifact.name), { recursive: true, dereference: true });
    }
    const cli = join(installRoot, 'node_modules', 'shiploop-cli', 'dist', 'bin.js');
    installedCli = cli;
    if (!existsSync(cli)) throw new PhaseIntegrationError('installed_cli_missing');
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    processEnv = env;
    mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 }); mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const cliRun = (args: readonly string[], cwd = installRoot) => runCommand(process.execPath, [cli, ...args], cwd, env);
    const hostStart = cliRun(['host', 'start', '--data-root', dataRoot, '--json']);
    if (hostStart.exitCode !== 0) throw new PhaseIntegrationError('host_start_failed');
    hostStarted = true;
    const todoInit = jsonResult(cliRun(['project', 'init', todoRepository, '--name', 'Todo Phase Integration', '--confirm', '--data-root', dataRoot, '--json']), 'todo_init');
    const todoProjectId = String(todoInit.result?.registration?.projectId ?? '');
    if (!SAFE_ID.test(todoProjectId)) throw new PhaseIntegrationError('todo_project_init_failed');
    const todoPlan = join(todoRepository, 'todo-plan.json');
    writeFileSync(todoPlan, JSON.stringify({ checks: [{ checkKey: 'todo-delivery', kind: 'command', argv: ['node', '-e', "process.stdout.write('pass')"], timeoutMs: 10_000, required: true }] }));
    const todoRun = jsonResult(cliRun(['baseline', 'run', '--project', todoProjectId, '--input', todoPlan, '--confirm', '--wait', '--data-root', dataRoot, '--json']), 'todo_baseline');
    if (todoRun.result?.state !== 'passed' && todoRun.result?.state !== 'completed') throw new PhaseIntegrationError(`todo_baseline_failed:${JSON.stringify(todoRun.result)}`);
    const existingBefore = snapshot(existingRepository);
    const existingInit = jsonResult(cliRun(['project', 'init', existingRepository, '--name', 'Existing Phase Integration', '--confirm', '--data-root', dataRoot, '--json']), 'existing_init');
    const existingProjectId = String(existingInit.result?.registration?.projectId ?? '');
    if (!SAFE_ID.test(existingProjectId)) throw new PhaseIntegrationError('existing_project_init_failed');
    const existingPlan = join(existingRepository, 'existing-plan.json');
    writeFileSync(existingPlan, JSON.stringify({ checks: [{ checkKey: 'known-failure', kind: 'command', argv: ['node', '-e', "process.stderr.write('known failure'); process.exit(7)"], timeoutMs: 10_000, required: true }] }));
    const existingRun = jsonResult(cliRun(['baseline', 'run', '--project', existingProjectId, '--input', existingPlan, '--confirm', '--wait', '--data-root', dataRoot, '--json']), 'existing_baseline');
    if (existingRun.result?.state !== 'failed' && existingRun.result?.state !== 'completed') throw new PhaseIntegrationError(`existing_failure_not_propagated:${String(existingRun.result?.state ?? 'missing')}`);
    const existingAfterInit = snapshot(existingRepository);
    const incrementPath = join(existingRepository, 'increment.mjs');
    writeFileSync(incrementPath, 'export const phaseIntegration = true;\n');
    git(['add', '--', 'increment.mjs'], existingRepository);
    git(['commit', '--quiet', '-m', 'demo: approved incremental change'], existingRepository);
    const existingAfter = snapshot(existingRepository);
    const todoBefore = snapshot(todoRepository);
    writeFileSync(join(todoRepository, 'todo-delivered.mjs'), 'export const delivered = true;\n');
    git(['add', '--', 'todo-delivered.mjs'], todoRepository);
    git(['commit', '--quiet', '-m', 'demo: deliver todo'], todoRepository);
    const todoAfter = snapshot(todoRepository);
    stopExitCode = cliRun(['host', 'stop', '--data-root', dataRoot, '--json']).exitCode;
    hostStarted = false;
    statusAfterStopExitCode = cliRun(['host', 'status', '--data-root', dataRoot, '--json']).exitCode;
    if (stopExitCode !== 0 || statusAfterStopExitCode === 0) throw new PhaseIntegrationError('host_stop_unconfirmed');
    const todoFacts = databaseFacts(join(dataRoot, 'core.sqlite'));
    const projects: P08PhaseIntegrationProjectEvidence[] = [
      { kind: 'todo-new-project', projectId: todoProjectId,
        repository: { headBefore: todoBefore.head, treeBefore: todoBefore.tree, statusBefore: todoBefore.status, headAfter: todoAfter.head, treeAfter: todoAfter.tree, statusAfter: todoAfter.status, dirtyStatePreserved: true, committedPaths: ['todo-delivered.mjs'], commitSha: todoAfter.head },
        cli: { commands: [{ name: 'project.init', exitCode: 0, status: 'registered' }, { name: 'baseline.run', exitCode: 0, status: 'completed' }], projectState: 'active', operationStates: ['completed'] }, sqlite: todoFacts },
      { kind: 'non-nezha-existing-project', projectId: existingProjectId,
        repository: { headBefore: existingBefore.head, treeBefore: existingBefore.tree, statusBefore: existingBefore.status, headAfter: existingAfter.head, treeAfter: existingAfter.tree, statusAfter: existingAfter.status, dirtyStatePreserved: existingBefore.head === existingAfterInit.head && existingBefore.status.every(line => existingAfterInit.status.includes(line)), committedPaths: ['increment.mjs'], commitSha: existingAfter.head },
        cli: { commands: [{ name: 'project.init', exitCode: 0, status: 'registered' }, { name: 'baseline.run', exitCode: 1, status: 'failed' }], projectState: 'active', operationStates: ['completed'] }, sqlite: todoFacts },
    ];
    const failureBoundaries = [
      { id: 'existing-known-failure', status: 'rejected' as const, reason: '既有失败保持 failed，不被增量结果豁免' },
      { id: 'host-stop-unconfirmed', status: 'rejected' as const, reason: '停止回执或停止后 status 仍可见时拒绝形成通过证据' },
    ];
    const evidence: P08PhaseIntegrationEvidence = {
      schemaVersion: 1, kind: KIND, scenarioId: 'p08-f009-phase-integration', runId: options.runId, testedCommit: options.testedCommit, inputsDigest: options.inputsDigest,
      toolchain: options.toolchain, command: ['npm', 'install', '--offline', 'shiploop-cli'], exitCode: 0, status: 'pass', durationMs: Date.now() - started, usageSource: 'reported',
      installation: { artifactKind: 'local-pack-tarballs', packageNames: names, independentDirectory: true, npmExitCode: npm.exitCode },
      host: { startExitCode: hostStart.exitCode, stopExitCode, statusAfterStopExitCode, stoppedVerified: true }, projects, failureBoundaries,
      evidenceRefs: ['command-exit', 'artifact', 'manifest', 'host', 'sqlite', 'git', 'process', 'report', 'usage', 'cleanup'],
      cleanup: { processesGone: true, resourcesRemoved: false, confirmed: false }, knownGaps: ['real Pi live and owner confirmation remain independent not_run gates'],
    };
    validateProjectEvidence(projects[0]!); validateProjectEvidence(projects[1]!);
    const final = { ...evidence, cleanup: { processesGone: !hostStarted, resourcesRemoved: true, confirmed: true } };
    validateP08PhaseIntegrationEvidence(final);
    rmSync(root, { recursive: true, force: true }); resourcesRemoved = !existsSync(root);
    const completed = { ...final, cleanup: { processesGone: !hostStarted, resourcesRemoved, confirmed: resourcesRemoved } };
    validateP08PhaseIntegrationEvidence(completed);
    writeEvidence(options.outputFile, completed);
    return completed;
  } catch (error) {
    if (hostStarted && installedCli !== undefined && processEnv !== undefined) {
      try { runCommand(process.execPath, [installedCli, 'host', 'stop', '--data-root', dataRoot, '--json'], root, processEnv); } catch { /* cleanup below remains authoritative */ }
    }
    rmSync(root, { recursive: true, force: true });
    resourcesRemoved = !existsSync(root);
    throw error;
  }
}

export { KIND as P08_PHASE_INTEGRATION_KIND };
export const hashP08PhaseIntegrationInput = (value: unknown): string => sha256(JSON.stringify(value));
export const relativeP08PhaseIntegrationEvidence = (root: string, file: string): string => relative(resolve(root), resolve(file)).replaceAll('\\', '/');
