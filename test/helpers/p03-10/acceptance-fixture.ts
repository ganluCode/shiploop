/** Real P03 resources; all business writes go through the built CLI and Host. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnedProcessTree } from '../../../scripts/acceptance/owned-process-tree.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { validateWorkProcessIdentity } from '../../../packages/core/src/ports/work-resources.ts';
import type { CommandProcessIdentity } from '../../../packages/core/src/ports/command-process.ts';
import { assertNoCredentialShapesInText, redactSensitiveText } from '../../../scripts/acceptance/p02-report.ts';
import { createProcessSupervisor } from '../host/managed-child.ts';
import { createAcceptanceFixture, type AcceptanceFixture } from '../p02-4/acceptance-fixture.ts';
import { singleEnvelope } from '../p02-4/dist-cli-session.ts';
import { isInsideDirectory } from '../safe-cleanup.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const HOST_ENTRY = fileURLToPath(new URL('./dist-fake-host.mjs', import.meta.url));
const BRANCH = 'feat/2026-10-11-17-45-49_p03-9';
// Immutable ancestor survives clean clones that intentionally omit local branch refs.
const CUMULATIVE_COMMIT = '14386921209e98f6bfc49f2c93373aeacc0473a5';
const BASELINE = '0e76ad8d9ae7a9e03949c8af4bae8e7e236acd56';
const TABLES = ['projects', 'phases', 'features', 'tasks', 'approvals', 'execution_batches', 'runs', 'attempts',
  'sessions', 'workspace_leases', 'managed_workspaces', 'workspace_operations', 'git_operations',
  'verification_batches', 'check_results', 'artifacts', 'state_events', 'command_receipts', 'baseline_operations', 'baseline_occupancy', 'execution_stop_operations'] as const;
export type EvidenceTable = typeof TABLES[number];
const COLUMN = /^(id|.*_id|status|state|operation|operation_type|delivery_status|expected_head|execution_stage|event_type|runtime|kind|result_ref|diagnostic_ref|input_ref|execution_version|number|revision|process_identity|plan_digest|.*_commit|.*_tree|.*_digest|.*_at|lease_until|reason|first_passed_at)$/;
const DEFAULT_SCRIPT = { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'P03 isolated Fake model' }],
  result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null } };

export type P03Stage = 'allocated' | 'host-ready' | 'registered' | 'configured' | 'imported' | 'authorized';
const CHAIN_CHECK = {
  checkKey: 'chain', scope: 'task', kind: 'command', required: true,
  argv: [process.execPath, '-e', `
    const fs = require('node:fs');
    let count = 1;
    try {
      if (!fs.readFileSync('README.md', 'utf8').startsWith('chain-1\\n')) throw Error('missing chain-1');
      if (fs.existsSync('chain-2.txt')) {
        count++;
        if (fs.readFileSync('chain-2.txt', 'utf8') !== 'retained marker\\nrepaired\\n') throw Error('expected repaired chain-2');
        if (!fs.readFileSync('README.md', 'utf8').includes('chain-2-first\\nchain-2-repaired\\n')) throw Error('lost tracked rework');
      }
      if (fs.existsSync('chain-3.txt')) { count++; if (fs.readFileSync('chain-3.txt', 'utf8') !== 'chain-3\\n') throw Error('missing chain-3'); }
      console.log('PASS chain checks');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    console.log('SHIPLOOP_NODE_CHECK_RESULT=' + JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:count,targets:['chain']}));
  `], cwdRef: null, environmentRef: null, timeout: 5000, requirementRefs: ['F-003'],
};

export interface P03FixtureOptions {
  /** F-003 real verification, controlled Task commits and Feature delivery. */
  readonly threeTaskChain?: boolean;
  /** F-007: deterministic failure across the first attempt and both repairs. */
  readonly persistentCheckFailure?: boolean;
  /** Caller-owned evidence directory, outside the disposable resources. */
  readonly evidenceDir: string;
  readonly onStage?: (stage: P03Stage, fixture: P03Fixture) => void | Promise<void>;
  /** Narrowing-only cleanup fault injection; false can never turn failed real verification into success. */
  readonly confirmStopped?: () => boolean;
  readonly script?: unknown;
  readonly toolCommands?: Readonly<Record<string, unknown>>;
  readonly verificationCommand?: { readonly argv: readonly string[]; readonly timeout: number };
  readonly secrets?: readonly string[];
}
export interface P03Fixture {
  readonly root: string;
  readonly repoDir: string;
  readonly ids: { projectId?: string; phaseId?: string; featureId?: string; batchId?: string; runId?: string };
  input(name: string, value: unknown): string;
  saveEvidence(name: string, value: unknown): void;
  cli<T = Record<string, unknown>>(args: readonly string[]): Promise<T>;
  startExecution(): Promise<void>;
  replayExecutionStart(): Promise<void>;
  rows(table: EvidenceTable): Record<string, unknown>[];
  storageProbe: AcceptanceFixture['storageProbe'];
  spawnSample: AcceptanceFixture['spawnSample'];
  safeRemove: AcceptanceFixture['safeRemove'];
  teardown(): Promise<void>;
}

export async function withP03AcceptanceFixture<T>(options: P03FixtureOptions, body: (fixture: P03Fixture) => Promise<T>): Promise<T> {
  mkdirSync(options.evidenceDir, { recursive: true });
  const evidenceDir = realpathSync(options.evidenceDir);
  const check = options.persistentCheckFailure ? { ...CHAIN_CHECK,
    argv: [process.execPath, '-e', `
      console.error('P03_PERSISTENT_CHECK_FAILURE');
      console.log('SHIPLOOP_NODE_CHECK_RESULT=' + JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:1,targets:['chain']}));
      process.exitCode = 1;
    `], requirementRefs: ['F-007'],
  } : options.verificationCommand === undefined ? CHAIN_CHECK : {
    ...CHAIN_CHECK, argv: [...options.verificationCommand.argv], timeout: options.verificationCommand.timeout,
  };
  const resources = createAcceptanceFixture({ prefix: 'shiploop-p03-10-', dataRootName: 'p03', stepMs: 500,
    ...(options.secrets ? { extraSecrets: options.secrets } : {}) });
  const root = resources.root;
  const repoDir = resources.repos.withHead;
  const dataRoot = resources.dataRoot();
  const supervisor = createProcessSupervisor({ evidence: resources.evidence, defaultStop: { stepMs: 500 } });
  let tree: OwnedProcessTree | undefined;
  const samples: ReturnType<AcceptanceFixture['spawnSample']>[] = [];
  const sampleTrees: OwnedProcessTree[] = [];
  let hostStarted = false;
  let removed = false;
  const records: unknown[] = [];
  const groups = new Map<string, CommandProcessIdentity>();
  const cleanupAttempts: unknown[] = [];
  const processAdapter = createCommandProcessAdapter({ stopConfirmMs: 2000 });
  const sanitize = (value: unknown): string => redactSensitiveText(JSON.stringify(value)
    .replaceAll(root, '<sandbox>').replaceAll(evidenceDir, '<evidence>').replaceAll(REPO, '<source>/').replaceAll(process.execPath, '<node>'), [homedir(), ...(options.secrets ?? [])]);
  const save = (name: string, value: unknown) => {
    const text = sanitize(value);
    writeFileSync(join(evidenceDir, name), text + '\n');
  };
  const ids: P03Fixture['ids'] = {};
  const git = (args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 2000,
    env: { PATH: process.env.PATH, HOME: resources.homeDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  let metadata: unknown = { status: 'not_run' };
  let budgetPath = '';
  let startArgs: readonly string[] | undefined;
  const stage = async (name: P03Stage) => { records.push({ kind: 'stage', stage: name }); await options.onStage?.(name, fixture); };

  function rows(table: EvidenceTable): Record<string, unknown>[] {
    if (!TABLES.includes(table)) throw new TypeError('unapproved evidence table');
    const probe = resources.storageProbe();
    try {
      if (!probe.tableExists(table)) throw new Error(`missing prerequisite table: ${table}`);
      // Constant table allowlist; JSON bodies, config and auth material are never selected for export.
      const columns = probe.selectAll<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table])
        .map(row => row.name).filter(name => /^[a-z_]+$/.test(name) && COLUMN.test(name));
      if (columns.length === 0) throw new Error(`missing evidence columns: ${table}`);
      const selected = probe.selectAll(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid LIMIT 101`);
      if (table === 'workspace_leases' || table === 'baseline_occupancy') for (const row of selected) {
        if (typeof row.process_identity !== 'string') continue;
        const { schemaVersion, ...identity } = JSON.parse(row.process_identity);
        if (table === 'workspace_leases' && schemaVersion !== 2) throw new Error('unsupported process identity');
        const validated = validateWorkProcessIdentity(identity);
        groups.set(validated.launchId, validated);
      }
      if ((table === 'workspace_leases' || table === 'baseline_occupancy') && selected.length > 100) {
        throw new Error('owned process evidence exceeds export bound');
      }
      return selected;
    } finally { probe.close(); }
  }
  function exportEvidence() {
    let database: unknown = { readonly: true, status: 'not_run' };
    if (hostStarted) {
      const tables = Object.fromEntries(TABLES.map(table => {
        const result = rows(table);
        return [table, { rows: result.slice(0, 100), truncated: result.length > 100 }];
      }));
      database = { readonly: true, status: 'captured', consistency: 'live read-only observations; not a transactional backup', tables };
    }
    assertNoCredentialShapesInText(sanitize(records), 'CLI/input evidence');
    save('evidence.json', { schemaVersion: 1, metadata, ids, records,
      database, git: resources.snapshotRepository(repoDir), processes: resources.evidence.events(),
      processTree: tree?.diagnostic() ?? 'not_started', processGroups: [...groups.values()],
      samples: samples.map(sample => ({ pid: sample.pid, label: sample.label, stdout: sample.stdout, stderr: sample.stderr,
        stdoutBytes: sample.stdoutBytes, stderrBytes: sample.stderrBytes, outputOverflow: sample.outputOverflow })),
      usage: { source: 'fake', tokens: 'unknown', cache: 'unknown', cost: 'unknown' } });
  }
  const fixture: P03Fixture = {
    root, repoDir, ids,
    saveEvidence(name, value) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new TypeError('evidence path must be a local JSON filename');
      assertNoCredentialShapesInText(sanitize(value), 'scenario evidence');
      save(name, value);
    },
    input(name, value) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new TypeError('input path must be a local JSON filename');
      const path = join(root, name);
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new TypeError('input symlink rejected');
      writeFileSync(path, JSON.stringify(value));
      records.push({ kind: 'input', name, value });
      return path;
    },
    async cli<R = Record<string, unknown>>(args: readonly string[]): Promise<R> {
      const result = await resources.runDistCli([...args, '--data-root', dataRoot, '--json'], {
        cwd: root, childEnv: resources.childEnv(), requireInside: root,
        resultTimeoutMs: 30_000, stdoutLimitBytes: 65_536, stderrLimitBytes: 8192,
      });
      records.push({ kind: 'cli', args, ...result });
      if (result.outputOverflow || result.exitCode !== 0 || result.signal !== null) {
        const diagnosticPath = join(root, 'chain-delivery-error.json');
        if (existsSync(diagnosticPath)) fixture.saveEvidence('host-delivery-error.json', JSON.parse(readFileSync(diagnosticPath, 'utf8')));
        throw new Error(`built CLI failed: ${sanitize({ args, result })}`);
      }
      const envelope = singleEnvelope(result);
      if (!envelope.ok) throw new Error(`built CLI rejected: ${sanitize(envelope)}`);
      return envelope.result as R;
    },
    async startExecution() {
      const projectArgs = ['--project', ids.projectId!];
      const preview = await fixture.cli<{ status: string; previewDigest: string }>(['execution', 'preview', ids.featureId!, ...projectArgs, '--input', budgetPath]);
      if (preview.status !== 'ready') throw new Error(`prerequisite preview blocked: ${sanitize(preview)}`);
      startArgs = ['execution', 'start', ids.featureId!, ...projectArgs,
        '--input', budgetPath, '--preview-digest', preview.previewDigest, '--confirm', '--command-id', randomUUID()];
      const started = await fixture.cli<{ status: string; batchId: string; runId: string }>(startArgs);
      if (started.status !== 'accepted') throw new Error('execution authorization not accepted');
      ids.batchId = started.batchId;
      ids.runId = started.runId;
      await stage('authorized');
    },
    async replayExecutionStart() {
      if (!startArgs) throw new Error('execution has not been started');
      const replay = await fixture.cli<{ batchId: string; runId: string }>(startArgs);
      if (replay.batchId !== ids.batchId || replay.runId !== ids.runId) throw new Error('execution replay identity changed');
    },
    rows,
    storageProbe: () => resources.storageProbe(),
    spawnSample(key, spawnOptions) {
      const sample = resources.spawnSample(key, spawnOptions);
      samples.push(sample);
      sampleTrees.push(new OwnedProcessTree(sample.pid > 0 ? sample.pid : undefined));
      return sample;
    },
    safeRemove: target => resources.safeRemove(target),
    async teardown() {
      if (removed) return;
      const startedAt = Date.now();
      const failures: unknown[] = [];
      // Export while resources still exist; export failure also prevents deletion.
      try { exportEvidence(); } catch (error) { failures.push(error); }
      try { await supervisor.dispose(); } catch (error) { failures.push(error); }
      for (const session of resources.sessions) {
        try { await session.verifyStopped({ stepMs: 500 }); } catch (error) { failures.push(error); }
      }
      for (const sample of samples) {
        try { await sample.verifyStopped({ stepMs: 500 }); } catch (error) { failures.push(error); }
      }
      let processTreeStopped = true;
      for (const owned of [...(tree ? [tree] : []), ...sampleTrees]) {
        try { if (!await owned.finish(true)) processTreeStopped = false; }
        catch (error) { processTreeStopped = false; failures.push(error); }
      }
      if (!processTreeStopped || options.confirmStopped?.() === false) failures.push(new Error('owned process stop unconfirmed'));
      let processGroupsStopped = true;
      for (const identity of groups.values()) {
        try {
          const stopped = await processAdapter.recoverStop!(identity);
          if (!stopped.confirmed) processGroupsStopped = false;
        } catch (error) { processGroupsStopped = false; failures.push(error); }
      }
      if (!processGroupsStopped) failures.push(new Error('owned process group stop unconfirmed'));
      try { save('cleanup.json', { status: 'pending', resourcesRemoved: false, processTreeStopped, processGroupsStopped }); }
      catch (error) { failures.push(error); }
      if (failures.length === 0) {
        try { await resources.dispose(); removed = !existsSync(root); }
        catch (error) { failures.push(error); }
      }
      const result = { status: failures.length === 0 && removed ? 'passed' : 'failed', resourcesRemoved: removed,
        processTreeStopped, processGroupsStopped, processGroups: [...groups.values()], retainedRoot: removed ? null : root,
        diagnostic: tree?.diagnostic() ?? 'not_started', elapsedMs: Date.now() - startedAt,
        failures: failures.map(error => String(error)) };
      cleanupAttempts.push(result);
      try { save('cleanup.json', { ...result, attempts: cleanupAttempts }); }
      catch (error) { result.status = 'failed'; failures.push(error); }
      if (result.status === 'failed') {
        if (!removed) writeFileSync(join(root, 'p03-cleanup-failed.json'), sanitize(result));
        throw new AggregateError(failures, 'P03 cleanup failed; isolated resources retained');
      }
    },
  };
  let failure: unknown;
  let failed = false;
  let result!: T;
  try {
    if (isInsideDirectory(evidenceDir, root)) throw new Error('evidence must survive disposable resources');
    await stage('allocated');
    const head = git(['rev-parse', 'HEAD']);
    const cumulative = git(['rev-parse', CUMULATIVE_COMMIT]);
    git(['merge-base', '--is-ancestor', cumulative, head]);
    git(['merge-base', '--is-ancestor', BASELINE, head]);
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    metadata = { testedCommit: head, cumulativeBranch: BRANCH, cumulativeCommit: cumulative, p02Baseline: BASELINE,
      ancestorChecks: 'passed', dirty: git(['status', '--porcelain']).length > 0,
      tools: { node: process.version, npm: execFileSync('npm', ['--version'], {
        cwd: root, env: resources.childEnv(), encoding: 'utf8', timeout: 2000,
      }).trim(),
        git: git(['--version']), ...Object.fromEntries(['typescript', 'vitest', 'better-sqlite3', 'drizzle-orm'].map(name =>
          [name, lock.packages[`node_modules/${name}`]?.version ?? 'unknown'])) } };
    const host = supervisor.spawn({ scriptPath: HOST_ENTRY, config: { dataRoot, script: options.script ?? DEFAULT_SCRIPT,
      ...(options.threeTaskChain ? { chain: { root, check, persistentCheckFailure: options.persistentCheckFailure === true } } : {}),
      ...(options.toolCommands ? { toolCommands: options.toolCommands } : {}) }, cwd: root, env: resources.childEnv(),
      requireInside: root, label: 'p03-dist-fake-host', stderrLimitBytes: 8192 });
    tree = new OwnedProcessTree(host.pid);
    await host.waitReady(20_000);
    hostStarted = true;
    await stage('host-ready');
    const registered = await fixture.cli<{ result: { project: { id: string } } }>(['project', 'register', repoDir, '--name', 'P03 isolated acceptance']);
    ids.projectId = registered.result.project.id;
    await stage('registered');
    const project = ['--project', ids.projectId];
    const strategy = { runtime: 'fake', provider: 'fake-provider', model: 'fake-model' };
    await fixture.cli(['config', 'create', '--scope', 'global', '--input', fixture.input('config.json', {
      schemaVersion: 2, strategies: { defaultStrategy: strategy, modelMap: { low: strategy } },
      policies: { executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 60_000 }, verification: { requireChecksBeforeDone: true } },
    })]);
    if (options.threeTaskChain) await fixture.cli(['config', 'create', '--scope', 'project', ...project,
      '--input', fixture.input('project-config.json', { schemaVersion: 2, policies: {
        deliveryPolicy: { commitMode: 'task_and_feature',
          gitIdentity: { name: 'Confirmed User', email: 'confirmed@example.test', confirmed: true },
          deliveryActions: ['commit'] },
        verification: {
          requireChecksBeforeDone: true, checkDefinitions: [check], fullFallback: { checkRefs: ['chain'] },
        } } })]);
    await stage('configured');
    const baseline = await fixture.cli<{ state: string; checks: { output: { artifactId: string } }[] }>(['baseline', 'run', ...project,
      '--input', fixture.input('checks.json', { checks: [{ checkKey: 'requirements', kind: 'command',
        argv: [process.execPath, '-e', 'process.stdout.write("P03 isolated requirement")'], timeoutMs: 5000, required: true }] }), '--confirm', '--wait']);
    if (baseline.state !== 'passed') throw new Error('required baseline did not pass');
    const phase = await fixture.cli<{ result: { phase: { id: string } } }>(['phase', 'create', ...project, '--title', 'P03 acceptance']);
    ids.phaseId = phase.result.phase.id;
    const imported = await fixture.cli<{ result: { feature: { id: string; planDigest: string } } }>(['feature', 'import', ...project,
      '--phase', ids.phaseId, '--revision', '1', '--input', fixture.input('plan.json', { schemaVersion: 1,
        feature: { title: 'P03 fixture', description: 'Independent real resources', sourceRefs: [], labels: [] },
        tasks: (options.threeTaskChain ? ['chain-1', 'chain-2', 'chain-3'] : ['p03-task']).map((id, index, taskIds) => ({
          id, title: options.threeTaskChain ? `Fixture task ${index + 1}` : 'Fixture task', complexity: 'low',
          ...(index > 0 ? { dependsOn: [taskIds[index - 1]] } : {}),
          requirementsRefs: [{ artifactId: baseline.checks[0]!.output.artifactId }],
          acceptance: { criteria: [options.threeTaskChain
            ? 'Deterministic verification and controlled commit required' : 'Deterministic verification required'] },
        })) })]);
    ids.featureId = imported.result.feature.id;
    await fixture.cli(['feature', 'approve', ids.featureId, ...project, '--digest', imported.result.feature.planDigest, '--revision', '1']);
    for (const taskId of options.threeTaskChain ? ['chain-1', 'chain-2', 'chain-3'] : ['p03-task']) {
      const prepared = await fixture.cli<{ bindable: boolean }>(['task', 'prepare', taskId, ...project, '--feature', ids.featureId,
        '--input', fixture.input(`inputs-${taskId}.json`, { items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: baseline.checks[0]!.output.artifactId } }] })]);
      if (!prepared.bindable) throw new Error('required input not bindable');
    }
    const maxAttempts = options.threeTaskChain ? 4 : 2;
    const runTimeLimitMs = options.threeTaskChain ? 240_000 : 60_000;
    budgetPath = fixture.input('budget.json', { batch: { maxRuns: 2, maxTotalAttempts: maxAttempts, maxRuntimeStarts: maxAttempts,
      maxNoProgressRuns: 2, deadlineUtcMs: Date.now() + runTimeLimitMs },
      run: { maxAttemptsPerRun: maxAttempts, runTimeLimitMs } });
    await stage('imported');
    result = await body(fixture);
  } catch (error) { failure = error; failed = true; records.push({ kind: 'failure', message: String(error) }); }
  try { await fixture.teardown(); }
  catch (cleanup) { throw new AggregateError(failed ? [failure, cleanup] : [cleanup], 'P03 cleanup failed; inspect retained evidence'); }
  if (failed) throw failure;
  return result;
}
