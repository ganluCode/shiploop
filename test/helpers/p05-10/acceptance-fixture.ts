import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FakeRuntimeHandle } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createFakeRuntime } from '../../../packages/core/src/adapters/fake-runtime.ts';
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox, type TempSandbox } from '../temp-sandbox.ts';
import { spawnSampleProcess, type SampleProcess, type SampleProcessExit } from '../p02-3/process-tools.ts';
import { safeRemoveTempRoot } from '../safe-cleanup.ts';
import { OwnedProcessTree } from '../../../scripts/acceptance/owned-process-tree.ts';
import {
  evidenceFileDigest,
  hashP0510Input,
  validateP0510ScenarioEvidence,
  writeP0510EvidenceFile,
  P0510EvidenceError,
  type P0510CleanupFacts,
  type P0510EvidenceRef,
  type P0510GitFacts,
  type P0510ProcessFacts,
  type P0510ScenarioEvidence,
  type P0510SqliteFacts,
  type P0510UsageSource,
} from './scenario-evidence.ts';

const REPO_ROOT = resolve(new URL('../../../', import.meta.url).pathname);
const DEFAULT_SCRIPT = {
  schemaVersion: 1,
  steps: [{ op: 'message', role: 'assistant', text: 'P05 offline FakeRuntime' }],
  result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
} as const;

export interface P0510FixtureOptions {
  readonly prefix?: string;
  readonly evidenceDir?: string;
  readonly script?: unknown;
}

export interface P0510SpawnOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
}

export interface P0510Process extends SampleProcess {
  readonly owned: true;
}

export interface P0510FakeRun {
  readonly result: RuntimeExecutionResult;
  readonly events: readonly unknown[];
  readonly usageSource: 'runtime-usage';
  readonly network: 'denied';
  readonly handle: FakeRuntimeHandle;
}

export interface P0510EvidenceInput {
  readonly input: unknown;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly status?: 'pass' | 'fail' | 'not_run';
  readonly durationMs?: number;
  readonly stateSnapshot?: Readonly<Record<string, unknown>>;
  readonly usageSource?: P0510UsageSource;
  readonly evidenceRefs?: readonly P0510EvidenceRef[];
  readonly notRunReason?: string;
}

export interface P0510CleanupOptions {
  readonly confirmStopped?: () => boolean;
}

export interface P0510Scenario {
  readonly id: string;
  readonly root: string;
  readonly projectDirectory: string;
  readonly dataRoot: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly gitRepositoryPath: string;
  readonly sqlitePath: string;
  readonly sqlite: SqliteStorageSession;
  readonly fakeRuntime: ReturnType<typeof createFakeRuntime>;
  createRuntimeRequest(overrides?: Record<string, unknown>): RuntimeExecutionRequest;
  runFakeRuntime(options?: { readonly script?: unknown; readonly request?: RuntimeExecutionRequest }): Promise<P0510FakeRun>;
  spawnProcess(options: P0510SpawnOptions): P0510Process;
  processFacts(): P0510ProcessFacts;
  sqliteFacts(): P0510SqliteFacts;
  gitFacts(): P0510GitFacts;
  recordEvidence(input: P0510EvidenceInput): P0510ScenarioEvidence;
  writeEvidence(evidence: P0510ScenarioEvidence): string;
  cleanup(options?: P0510CleanupOptions): Promise<P0510CleanupFacts>;
}

export interface P0510AcceptanceFixture {
  readonly root: string;
  readonly evidenceDir: string;
  readonly testedCommit: string;
  readonly scenarios: readonly P0510Scenario[];
  createScenario(id: string, options?: { readonly script?: unknown }): P0510Scenario;
  dispose(): Promise<void>;
}

type TrackedProcess = P0510Process & { readonly treeFinished: { value: boolean } };

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

function createGitRepository(path: string, id: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  git(['init', '--quiet', '-b', 'main'], path);
  git(['config', 'user.name', 'P05 Fixture'], path);
  git(['config', 'user.email', 'p05-fixture@example.test'], path);
  writeFileSync(join(path, 'README.md'), `P05 fixture ${id}\n`, 'utf8');
  git(['add', 'README.md'], path);
  git(['commit', '--quiet', '-m', `fixture: ${id}`], path);
}

function canonicalFileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inputRef(projectId: string, purpose: string) {
  return { projectId, artifactId: `artifact-${purpose}`, kind: 'execution-input' as const, purpose,
    version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'application/json', origin: { kind: 'artifact' as const } };
}

function requestFor(id: string, workspaceRoot: string, overrides: Record<string, unknown> = {}): RuntimeExecutionRequest {
  return {
    schemaVersion: 1, projectId: `project-${id}`, featureId: `feature-${id}`, sessionId: `session-${id}`,
    executionVersion: 1, owner: { principalId: `principal-${id}`, hostInstanceId: `host-${id}` },
    identity: { purpose: 'work', runId: `run-${id}`, taskId: `task-${id}`, attemptId: `attempt-${id}` },
    invocationId: `invocation-${id}`, strategy: { runtime: 'fake', provider: 'fake-provider', model: 'fake-model' },
    prompt: inputRef(`project-${id}`, 'prompt'), inputManifest: inputRef(`project-${id}`, 'manifest'),
    cwd: { root: 'workspace', relativePath: '.' }, permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 }, recovery: { mode: 'new' },
    ...overrides,
  } as RuntimeExecutionRequest;
}

export function createP05AcceptanceFixture(options: P0510FixtureOptions = {}): P0510AcceptanceFixture {
  const sandbox: TempSandbox = createTempSandbox(options.prefix ?? 'shiploop-p05-10-', { outside: [REPO_ROOT] });
  const root = realpathSync(sandbox.path);
  const evidenceDir = resolve(options.evidenceDir ?? join(tmpdir(), `shiploop-p05-evidence-${randomUUID()}-`));
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const testedCommit = git(['rev-parse', 'HEAD'], REPO_ROOT);
  const scenarios: P0510Scenario[] = [];
  let disposed = false;

  const createScenario = (id: string, scenarioOptions: { readonly script?: unknown } = {}): P0510Scenario => {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new TypeError('P05 场景 id 必须是小写字母、数字、下划线或短横线');
    if (scenarios.some(scenario => scenario.id === id)) throw new Error(`P05 场景 id 重复：${id}`);
    const scenarioRoot = join(root, 'scenarios', id);
    const projectDirectory = join(scenarioRoot, 'project');
    const dataRoot = join(scenarioRoot, 'data');
    const homeDir = join(scenarioRoot, 'home');
    const tmpDir = join(scenarioRoot, 'tmp');
    const gitRepositoryPath = join(scenarioRoot, 'git');
    for (const path of [projectDirectory, dataRoot, homeDir, tmpDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    createGitRepository(gitRepositoryPath, id);
    writeFileSync(join(projectDirectory, 'scenario.json'), JSON.stringify({ scenarioId: id, testedCommit }), 'utf8');
    const sqlitePath = join(dataRoot, 'state.db');
    const sqlite = openSqliteStorageSession({ path: sqlitePath, busyTimeoutMs: 100, busyRetryAttempts: 2 });
    sqlite.transactWrite('p05.fixture.seed', db => {
      db.exec('CREATE TABLE p05_fixture_records (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, status TEXT NOT NULL)');
      db.prepare('INSERT INTO p05_fixture_records (id, scenario_id, status) VALUES (?, ?, ?)').run(`${id}-record`, id, 'created');
    });
    const initialScript = scenarioOptions.script ?? options.script ?? DEFAULT_SCRIPT;
    const processes: TrackedProcess[] = [];
    const exits = new Map<number, SampleProcessExit>();
    const processTrees = new Map<number, OwnedProcessTree>();

    let cleanupState: P0510CleanupFacts = { status: 'pending', resourcesRemoved: false, processStopped: false, filesChecked: false, retainedRoot: scenarioRoot };
    let sqliteCache: P0510SqliteFacts | undefined;
    let gitCache: P0510GitFacts | undefined;
    let processCache: P0510ProcessFacts | undefined;
    let latestInput: unknown;
    let scenarioRefDigest = canonicalFileDigest(join(projectDirectory, 'scenario.json'));
    let closed = false;
    const childEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDir, TMPDIR: tmpDir, NODE_NO_WARNINGS: '1' });
    const runtimeAssembly = (script: unknown) => createFakeRuntime({ script, workspaceRoots: { workspace: projectDirectory }, providers: [{ providerId: 'fake-provider', models: ['fake-model'] }], nowUtcMs: () => Date.parse('2026-10-23T00:00:00Z') });
    let fakeRuntime = runtimeAssembly(initialScript);

    const scenario: P0510Scenario = {
      id, root: scenarioRoot, projectDirectory, dataRoot, homeDir, tmpDir, gitRepositoryPath, sqlitePath, sqlite,
      get fakeRuntime() { return fakeRuntime; },
      createRuntimeRequest: overrides => requestFor(id, projectDirectory, overrides),
      async runFakeRuntime(runOptions = {}): Promise<P0510FakeRun> {
        const assembly = runOptions.script === undefined ? fakeRuntime : runtimeAssembly(runOptions.script);
        const request = runOptions.request ?? requestFor(id, projectDirectory);
        const handle = await assembly.adapter.start(request) as FakeRuntimeHandle;
        const events: unknown[] = [];
        for await (const event of handle.events) events.push(event);
        const result = await handle.result as RuntimeExecutionResult;
        return { result, events, usageSource: 'runtime-usage', network: 'denied', handle };
      },
      spawnProcess(processOptions): P0510Process {
        const child = spawnSampleProcess({ argv: processOptions.argv, cwd: processOptions.cwd ?? projectDirectory, env: childEnv(), label: processOptions.label ?? `p05-${id}` });
        const tracked = Object.assign(child, { owned: true as const, treeFinished: { value: false } }) as TrackedProcess;
        void child.exited.then(result => { exits.set(child.pid, result); });
        processTrees.set(child.pid, new OwnedProcessTree(child.pid));
        processes.push(tracked);
        return tracked;
      },
      processFacts(): P0510ProcessFacts {
        if (processCache) return processCache;
        const identities = processes.map(process_ => {
          const exit = exits.get(process_.pid);
          return { pid: process_.pid, label: process_.label, exitCode: exit?.code ?? (process_.isAlive() ? null : null), signal: exit?.signal ?? null, owned: true as const };
        });
        return { owned: true, spawned: processes.length, exited: processes.filter(process_ => !process_.isAlive()).length, alive: processes.filter(process_ => process_.isAlive()).length, identities };
      },
      sqliteFacts(): P0510SqliteFacts {
        if (sqliteCache) return sqliteCache;
        const snapshot = sqlite.pragmaSnapshot();
        const row = sqlite.database.prepare('SELECT COUNT(*) AS count FROM p05_fixture_records').get() as { count: number };
        const recordCount = Number(row.count);
        sqliteCache = { path: sqlitePath, journalMode: snapshot.journalMode, foreignKeysEnabled: snapshot.foreignKeysEnabled, open: sqlite.isOpen(), recordCount };
        return sqliteCache;
      },
      gitFacts(): P0510GitFacts {
        if (gitCache) return gitCache;
        gitCache = { repositoryPath: gitRepositoryPath, head: git(['rev-parse', 'HEAD'], gitRepositoryPath), tree: git(['rev-parse', 'HEAD^{tree}'], gitRepositoryPath), status: git(['status', '--porcelain=v1'], gitRepositoryPath) };
        return gitCache;
      },
      recordEvidence(record): P0510ScenarioEvidence {
        latestInput = record.input;
        const refs = record.evidenceRefs ?? [{ name: 'scenario.json', digest: scenarioRefDigest }];
        const evidence: P0510ScenarioEvidence = {
          schemaVersion: 1, scenarioId: id, inputDigest: hashP0510Input(record.input), testedCommit,
          command: [...record.command], exitCode: record.exitCode, status: record.status ?? 'pass', durationMs: record.durationMs ?? 0,
          stateSnapshot: { scenarioId: id, ...record.stateSnapshot }, sqlite: scenario.sqliteFacts(), git: scenario.gitFacts(), process: scenario.processFacts(),
          usageSource: record.usageSource ?? 'command-output', evidenceRefs: refs, cleanup: cleanupState,
          ...(record.notRunReason === undefined ? {} : { notRunReason: record.notRunReason }),
        };
        return validateP0510ScenarioEvidence(evidence, { scenarioId: id, input: record.input, testedCommit });
      },
      writeEvidence(evidence): string {
        for (const ref of evidence.evidenceRefs) {
          const target = join(projectDirectory, ref.name);
          if (existsSync(target)) {
            if (canonicalFileDigest(target) !== ref.digest) throw new P0510EvidenceError('hash_mismatch', `证据引用哈希不匹配：${ref.name}`);
          } else if (!(ref.name === 'scenario.json' && ref.digest === scenarioRefDigest)) {
            throw new P0510EvidenceError('hash_mismatch', `证据引用现场缺失：${ref.name}`);
          }
        }
        return writeP0510EvidenceFile(evidenceDir, evidence, { scenarioId: id, input: latestInput, testedCommit });
      },
      async cleanup(cleanupOptions = {}): Promise<P0510CleanupFacts> {
        if (cleanupState.status === 'passed' && cleanupState.resourcesRemoved) return cleanupState;
        const failures: string[] = [];
        for (const process_ of processes) {
          try { if (process_.isAlive()) await process_.verifyStopped({ stepMs: 10 }); } catch (error) { failures.push(String(error)); }
        }
        for (const tree of processTrees.values()) {
          try { if (!await tree.finish(true)) failures.push(tree.diagnostic()); } catch (error) { failures.push(String(error)); }
        }
        const processStopped = processes.every(process_ => !process_.isAlive());
        if (!processStopped) failures.push('自有进程停止未确认');
        if (cleanupOptions.confirmStopped?.() === false) failures.push('停止确认回调返回 false');
        try { if (!closed) { sqliteCache = scenario.sqliteFacts(); gitCache = scenario.gitFacts(); sqlite.close(); closed = true; } } catch (error) { failures.push(String(error)); }
        processCache = scenario.processFacts();
        const filesChecked = existsSync(scenarioRoot) && existsSync(projectDirectory) && existsSync(dataRoot) && existsSync(gitRepositoryPath);
        if (!filesChecked) failures.push('场景资源快照缺失');
        if (failures.length > 0) {
          cleanupState = { status: 'failed', resourcesRemoved: false, processStopped, filesChecked, retainedRoot: scenarioRoot, reason: failures.join('; ') };
          return cleanupState;
        }
        try {
          safeRemoveTempRoot(scenarioRoot, { authorizedRoot: root, protectedPaths: [REPO_ROOT, homedir()] });
        } catch (error) {
          cleanupState = { status: 'unknown', resourcesRemoved: false, processStopped, filesChecked, retainedRoot: scenarioRoot, reason: String(error) };
          return cleanupState;
        }
        cleanupState = { status: 'passed', resourcesRemoved: !existsSync(scenarioRoot), processStopped: true, filesChecked: true, retainedRoot: null };
        return cleanupState;
      },
    };
    scenarios.push(scenario);
    return scenario;
  };

  return {
    root, evidenceDir, testedCommit, scenarios, createScenario,
    async dispose(): Promise<void> {
      if (disposed) return;
      const failures: unknown[] = [];
      for (const scenario of scenarios) {
        try { const result = await scenario.cleanup(); if (result.status !== 'passed') failures.push(new Error(`${scenario.id}: ${result.reason ?? 'cleanup failed'}`)); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'P05 夹具清理失败，现场已保留');
      try { sandbox.cleanup(); } catch (error) { throw new AggregateError([error], 'P05 夹具根目录清理失败'); }
      disposed = true;
    },
  };
}

export { evidenceFileDigest, hashP0510Input, validateP0510ScenarioEvidence, writeP0510EvidenceFile } from './scenario-evidence.ts';
export type {
  P0510CleanupFacts, P0510EvidenceErrorKind, P0510EvidenceRef, P0510GitFacts, P0510ProcessFacts,
  P0510ScenarioEvidence, P0510SqliteFacts, P0510UsageSource,
} from './scenario-evidence.ts';
export { P0510EvidenceError } from './scenario-evidence.ts';
export type { P0510AcceptanceFixture as P05AcceptanceFixture };
