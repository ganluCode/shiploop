import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createTodoBrownfieldFixture, type TodoBrownfieldFixture } from '../../helpers/p06-7/todo-fixture.ts';
import { collectP06Scenario, verifyP06Scenario, hashP06Input, reconcileP06Evidence, P06_REQUIRED_EVIDENCE_SCENARIOS,
  type P06ScenarioOptions, type P06ScenarioRecord } from '../../../scripts/acceptance/p06-evidence.ts';
import { hashP06Bytes, captureP06Sqlite } from '../../../scripts/acceptance/p06-facts.ts';

const input = { fixture: 'todo', purpose: 'evidence-layer-regression', phaseAccepted: false,
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 };
const identity = { runId: `p06-f006-${randomUUID()}`, testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), inputDigest: hashP06Input(input) };

function options(fixture: TodoBrownfieldFixture, directory: string, overrides: Partial<P06ScenarioOptions> = {}): P06ScenarioOptions {
  return {
    directory, identity, scenarioId: 'I01', attempt: 1, input,
    command: { argv: ['node', 'scripts/check-ok.mjs'], exitCode: 0, signal: null, timedOut: false, cancelled: false },
    outcome: 'success', sideEffects: { ...fixture.compareDirtyBaseline() },
    tools: { node: process.versions.node, git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() }, usageSource: 'command-output',
    resources: { root: fixture.root, sqlitePath: fixture.sqlitePath, repositoryPath: fixture.todoRepositoryPath,
      files: ['todo/inbox.txt', 'NOTES-untracked.md'], processFacts: () => fixture.processFacts(), cleanup: () => fixture.cleanup() },
    sensitiveValues: [process.execPath, process.cwd(), fixture.sensitiveSentinelValue, fixture.bearerSentinelValue], ...overrides,
  };
}
async function environment(work: (fixture: TodoBrownfieldFixture, directory: string) => Promise<void>) {
  const fixture = createTodoBrownfieldFixture({ stepMs: 100 });
  const reportRoot = mkdtempSync(join(tmpdir(), 'p06-f006-report-'));
  try { await work(fixture, join(reportRoot, identity.runId)); }
  finally { await fixture.dispose(); rmSync(reportRoot, { recursive: true, force: true }); }
}
function replaceEvidence(directory: string, record: P06ScenarioRecord, category: string, mutate: (body: any) => void): P06ScenarioRecord {
  const ref = record.evidenceRefs.find(r => r.category === category)!;
  const path = join(directory, ref.path);
  const body = JSON.parse(readFileSync(path, 'utf8'));
  mutate(body);
  const bytes = JSON.stringify(body);
  writeFileSync(path, bytes);
  const changed = { ...record, evidenceRefs: record.evidenceRefs.map(r => r !== ref ? r : { ...r, sha256: hashP06Bytes(bytes), sizeBytes: Buffer.byteLength(bytes) }) };
  writeFileSync(join(directory, `${record.scenarioId}-a${record.attempt}/result.json`), JSON.stringify(changed));
  return changed;
}

it('[case:export-before-cleanup] exports real SQLite, Git, files and process facts before removing owned resources', async () => {
  await environment(async (fixture, directory) => {
    const app = await openCoreApplication({ dataRoot: fixture.dataRoot, capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'test', models: ['test'] }] },
    ]) });
    try {
      const registered = await app.projectService.registerRepository({ repositoryPath: fixture.todoRepositoryPath, displayName: 'P06 evidence project' });
      const databasePath = app.pathService.databaseFilePath();
      const result = await fixture.runCheck('ok');
      expect(result.exitCode).toBe(0);
      const before = captureP06Sqlite(databasePath, []);
      await expect(app.projectService.updateProjectMetadata(registered.project.id, { expectedRevision: registered.project.revision + 1,
        displayName: 'must not be saved' })).rejects.toMatchObject({ kind: 'conflict' });
      expect(captureP06Sqlite(databasePath, [])).toEqual(before);
      const settings = options(fixture, directory, {
        command: { argv: result.argv, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: false },
      });
      const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, sqlitePath: databasePath, cleanup: async () => {
        expect(captureP06Sqlite(databasePath, [])).toEqual(before);
        expect(fixture.compareDirtyBaseline()).toEqual({ matches: true, differences: [] });
        // All seven pre-deletion exports have already reached the report directory.
        for (const category of ['sqlite', 'git', 'process', 'artifact', 'command-exit', 'usage', 'manifest']) {
          expect(existsSync(join(directory, `I01-a1/${category}.json`))).toBe(true);
        }
        app.close();
        return fixture.cleanup();
      } } });
      expect(record.status).toBe('pass');
      expect(existsSync(fixture.root)).toBe(false);
      expect(verifyP06Scenario(directory, record, identity)).toEqual({ ok: true, problems: [] });
      const sqlite = record.evidenceRefs.find(ref => ref.category === 'sqlite')!;
      const sqliteBody = JSON.parse(readFileSync(join(directory, sqlite.path), 'utf8')).facts;
      expect(sqliteBody.integrity).toBe('ok');
      expect(sqliteBody.tables.find((table: { name: string }) => table.name === 'projects').rows).toEqual([
        expect.objectContaining({ id: registered.project.id, display_name: 'P06 evidence project' }),
      ]);
      const git = record.evidenceRefs.find(ref => ref.category === 'git')!;
      expect(JSON.parse(readFileSync(join(directory, git.path), 'utf8')).facts).toMatchObject({ head: fixture.dirtyBaseline().head,
        diff: expect.stringContaining('src/todo.ts'), stagedDiff: expect.stringContaining('src/feature.ts') });
      expect(record.cleanup).toMatchObject({ status: 'passed', resourcesRemoved: true, factsExported: true });
      for (const ref of record.evidenceRefs) {
        const bytes = readFileSync(join(directory, ref.path));
        expect(ref.sha256).toBe(hashP06Bytes(bytes)); expect(ref.sizeBytes).toBe(bytes.length);
      }
      const aggregate = reconcileP06Evidence(directory, identity, [record]);
      expect(aggregate.status).toBe('fail');
      expect(aggregate.checks).toHaveLength(P06_REQUIRED_EVIDENCE_SCENARIOS.length);
      expect(aggregate.checks.find(c => c.scenarioId === 'I01')?.status).toBe('pass');
      expect(aggregate.checks.filter(c => c.scenarioId !== 'I01').every(c => c.status === 'not_run')).toBe(true);
      expect(aggregate.checks.find(c => c.scenarioId === 'FR-1')?.attempts[0]).toMatchObject({
        scenarioId: 'FR-1', testedCommit: identity.testedCommit, inputDigest: identity.inputDigest,
        command: [], exitCode: null, status: 'not_run', evidenceRefs: [], usageSource: 'not_run', cleanup: { status: 'pending' },
      });
      const proofRoot = process.env.SHIPLOOP_P06_F006_EVIDENCE_DIR;
      if (proofRoot) {
        mkdirSync(proofRoot, { recursive: true, mode: 0o700 });
        const destination = join(proofRoot, identity.runId);
        mkdirSync(destination, { mode: 0o700 });
        cpSync(directory, destination, { recursive: true, force: false, errorOnExist: true });
        writeFileSync(join(destination, 'regression-input.json'), JSON.stringify(input, null, 2), { flag: 'wx', mode: 0o600 });
        writeFileSync(join(destination, 'reconciliation.json'), JSON.stringify(aggregate, null, 2), { flag: 'wx', mode: 0o600 });
        expect(verifyP06Scenario(destination, record, identity).ok).toBe(true);
      }
    } finally { app.close(); }
  });
});

it('[case:missing-corrupt-identity] missing, corrupt, duplicate and foreign evidence fails even with recomputed hashes', async () => {
  await environment(async (fixture, directory) => {
    const record = await collectP06Scenario(options(fixture, directory));
    expect(verifyP06Scenario(directory, record, { ...identity, runId: 'another-run' }).ok).toBe(false);
    expect(verifyP06Scenario(directory, { ...record, evidenceRefs: record.evidenceRefs.slice(1) }, identity).ok).toBe(false);
    expect(verifyP06Scenario(directory, { ...record, evidenceRefs: [...record.evidenceRefs, record.evidenceRefs[0]!] }, identity).ok).toBe(false);
    expect(() => reconcileP06Evidence(directory, identity, [record, record])).toThrow('duplicate');
    const corrupted = replaceEvidence(directory, record, 'sqlite', body => { body.facts.tables[0].count += 1; });
    expect(verifyP06Scenario(directory, corrupted, identity).problems).toContain('sqlite_facts_corrupt');
    const repaired = replaceEvidence(directory, corrupted, 'sqlite', body => { body.facts.tables[0].count -= 1; });
    const foreign = replaceEvidence(directory, repaired, 'git', body => { body.runId = 'another-run'; });
    expect(verifyP06Scenario(directory, foreign, identity).problems).toContain('identity_mismatch');
    const ref = record.evidenceRefs.find(r => r.category === 'artifact')!;
    writeFileSync(join(directory, ref.path), '{}');
    expect(verifyP06Scenario(directory, record, identity).ok).toBe(false);
    rmSync(join(directory, ref.path));
    expect(verifyP06Scenario(directory, record, identity).ok).toBe(false);
  });
});

it('[case:failure-and-retry] nonzero exits and successful retry keep both immutable attempts; another run remains intact', async () => {
  await environment(async (fixture, directory) => {
    const first = await fixture.runCheck('failing');
    const result = await collectP06Scenario(options(fixture, directory, { scenarioId: 'I07-nonzero-exit',
      command: { argv: first.argv, exitCode: first.exitCode, signal: first.signal, timedOut: first.timedOut, cancelled: false },
      sideEffects: { dirty: fixture.compareDirtyBaseline(), runs: first.runs },
    }));
    expect(result).toMatchObject({ status: 'fail', outcome: 'nonzero_exit', exitCode: 3, reason: 'nonzero_exit', sideEffects: { runs: 1 } });
    expect(verifyP06Scenario(directory, result, identity).ok).toBe(true);
    const original = readFileSync(join(directory, 'I07-nonzero-exit-a1/result.json'));
    const retry = createTodoBrownfieldFixture({ stepMs: 100 });
    const other = createTodoBrownfieldFixture({ stepMs: 100 });
    try {
      const second = await retry.runCheck('ok');
      const retried = await collectP06Scenario(options(retry, directory, { scenarioId: 'I07-nonzero-exit', attempt: 2,
        command: { argv: second.argv, exitCode: second.exitCode, signal: second.signal, timedOut: false, cancelled: false } }));
      expect(retried.status).toBe('pass');
      expect(readFileSync(join(directory, 'I07-nonzero-exit-a1/result.json'))).toEqual(original);
      expect(reconcileP06Evidence(directory, identity, [result, retried], ['I07-nonzero-exit']).status).toBe('fail');
      expect(other.compareDirtyBaseline()).toEqual({ matches: true, differences: [] });
      expect(existsSync(other.sqlitePath)).toBe(true);
      const duplicate = createTodoBrownfieldFixture({ stepMs: 100 });
      try {
        await expect(collectP06Scenario(options(duplicate, directory, { scenarioId: 'I07-nonzero-exit' }))).rejects.toThrow();
        expect(existsSync(duplicate.root)).toBe(true);
      } finally { await duplicate.dispose(); }
    } finally { await retry.dispose(); await other.dispose(); }
  });
});

it('[case:timeout-and-cancel] real timeout and explicit SIGTERM cancellation retain command and owned descendant facts', async () => {
  for (const kind of ['timeout', 'cancelled'] as const) await environment(async (fixture, directory) => {
    const server = await fixture.startFakeMcpServer({ spawnChild: true });
    // Observe ancestry while the parent lives, retaining child identity across parent exit.
    fixture.processFacts();
    let command: P06ScenarioOptions['command'];
    if (kind === 'timeout') {
      const result = await fixture.runCheck('hang', { timeoutMs: 250 });
      command = { argv: result.argv, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: false };
    } else {
      server.process.kill('SIGTERM');
      const exit = await server.process.exited;
      command = { argv: [fixture.mcpServerCommand.executable, ...fixture.mcpServerCommand.argv], exitCode: exit.code, signal: exit.signal, timedOut: false, cancelled: true };
    }
    const record = await collectP06Scenario(options(fixture, directory, { scenarioId: `I07-${kind}`, command }));
    expect(record).toMatchObject({ status: 'fail', outcome: kind, exitCode: command.exitCode, reason: kind });
    if (kind === 'timeout') expect(record.exitCode).toBeNull();
    // The fake server handles SIGTERM with exit 0. Cancellation must still remain failed.
    if (kind === 'cancelled') expect(record.exitCode).toBe(0);
    expect(record.cleanup.status).toBe('passed');
    expect(verifyP06Scenario(directory, record, identity).ok).toBe(true);
    const ref = record.evidenceRefs.find(r => r.category === 'process')!;
    const facts = JSON.parse(readFileSync(join(directory, ref.path), 'utf8')).facts;
    expect(facts.descendantsChecked).toBe(true);
    expect(facts.observed.length).toBeGreaterThanOrEqual(2);
  });
});

for (const outcome of ['validation_failed', 'resource_conflict', 'input_drift'] as const) {
  it(`[case:${outcome}] exit zero cannot erase the structured ${outcome} rejection and side effects`, async () => {
    await environment(async (fixture, directory) => {
      const run = await fixture.runCheck('ok');
      const stateBefore = fixture.compareDirtyBaseline();
      const record = await collectP06Scenario(options(fixture, directory, {
        scenarioId: `I07-${outcome.replaceAll('_', '-')}`, outcome, reason: `observed_${outcome}`,
        command: { argv: run.argv, exitCode: run.exitCode, signal: run.signal, timedOut: false, cancelled: false },
        sideEffects: { rejected: true, before: stateBefore, after: fixture.compareDirtyBaseline() },
      }));
      expect(record).toMatchObject({ status: 'fail', outcome, exitCode: 0, reason: `observed_${outcome}`, sideEffects: { rejected: true } });
      expect(verifyP06Scenario(directory, record, identity).ok).toBe(true);
    });
  });
}

it('[case:cleanup-uncertain] cleanup rejection retains resources and cannot pass; retry uses a new identity', async () => {
  await environment(async (fixture, directory) => {
    const settings = options(fixture, directory);
    const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, cleanup: () => fixture.cleanup({ confirmStopped: () => false }) } });
    expect(record).toMatchObject({ status: 'fail', outcome: 'cleanup_uncertain', cleanup: { resourcesRemoved: false, status: 'failed' } });
    expect(existsSync(fixture.root)).toBe(true);
    expect(verifyP06Scenario(directory, { ...record, status: 'pass' }, identity).ok).toBe(false);
    expect((await fixture.cleanup()).status).toBe('passed');
    expect(record.status).toBe('fail');
  });
});

it('[case:capture-failure-retains-root] corrupt SQLite and file escape prevent cleanup and preserve the original resource', async () => {
  await environment(async (fixture, directory) => {
    const settings = options(fixture, directory);
    const broken = join(fixture.root, 'broken.sqlite');
    writeFileSync(broken, 'this is not a sqlite database');
    const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, sqlitePath: broken } });
    expect(record).toMatchObject({ status: 'fail', outcome: 'capture_failed', cleanup: { status: 'pending' } });
    expect(existsSync(fixture.root)).toBe(true);
    expect(fixture.sqliteFacts().recordCount).toBe(1);
    expect(verifyP06Scenario(directory, record, identity).ok).toBe(true);
  });
  await environment(async (fixture, directory) => {
    symlinkSync(process.execPath, join(fixture.todoRepositoryPath, 'escape'));
    try {
      const settings = options(fixture, directory);
      const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, files: ['escape'] } });
      expect(record).toMatchObject({ status: 'fail', outcome: 'capture_failed', reason: 'resource_symlink' });
      expect(existsSync(fixture.root)).toBe(true);
    } finally { rmSync(join(fixture.todoRepositoryPath, 'escape')); }
  });
});

it('[case:redaction-and-scan] scans input and evidence, recomputes sanitized file hashes and blocks unregistered secrets before write', async () => {
  await environment(async (fixture, directory) => {
    writeFileSync(join(fixture.todoRepositoryPath, 'todo/inbox.txt'), `${fixture.sensitiveSentinelValue}\nBearer ${fixture.bearerSentinelValue}\n`);
    const record = await collectP06Scenario(options(fixture, directory, { sideEffects: { value: fixture.sensitiveSentinelValue } }));
    expect(record.status).toBe('pass');
    for (const ref of record.evidenceRefs) {
      const text = readFileSync(join(directory, ref.path), 'utf8');
      expect(text).not.toContain(fixture.sensitiveSentinelValue);
      expect(text).not.toContain(fixture.bearerSentinelValue);
      expect(text).not.toContain(process.execPath);
    }
    const ref = record.evidenceRefs.find(r => r.category === 'artifact')!;
    const file = JSON.parse(readFileSync(join(directory, ref.path), 'utf8')).facts.files[0];
    expect(file.redacted).toBe(true);
    expect(file.sha256).toBe(hashP06Bytes(file.content));
    expect(file.sizeBytes).toBe(Buffer.byteLength(file.content));
    expect(verifyP06Scenario(directory, record, identity).ok).toBe(true);
  });
  for (const unsafe of ['Bearer unregistered-secret-value', '/Users/synthetic-user/private/file', 'C:\\Users\\synthetic-user\\private.txt', 'token=unregistered-secret-value']) {
    await environment(async (fixture, directory) => {
      await expect(collectP06Scenario(options(fixture, directory, { sideEffects: { unsafe } }))).rejects.toThrow('sensitive_content');
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(fixture.root)).toBe(true);
    });
  }
});

it('[case:typed-category-integrity] every category rejects malformed facts even after an attacker recomputes outer hashes', async () => {
  await environment(async (fixture, directory) => {
    const record = await collectP06Scenario(options(fixture, directory));
    const mutations: Record<string, (body: any) => void> = {
      sqlite: body => { body.facts.tables[0].digest = '0'.repeat(64); },
      git: body => { body.facts.head = 'unknown'; },
      process: body => { body.facts.trees = [{ rootPid: 123, scanConfirmed: false, identities: [] }]; },
      artifact: body => { body.facts.files[0].content += 'corrupt'; },
      'command-exit': body => { body.facts.signal = 'SIGTERM'; },
      usage: body => { body.facts.source = 'not_run'; },
      manifest: body => { body.facts.capturedBeforeDeletion = false; },
      cleanup: body => { body.facts.processStopped = false; },
    };
    for (const [category, mutate] of Object.entries(mutations)) {
      const ref = record.evidenceRefs.find(r => r.category === category)!;
      const original = readFileSync(join(directory, ref.path));
      const corrupted = replaceEvidence(directory, record, category, mutate);
      try { expect(verifyP06Scenario(directory, corrupted, identity).ok, category).toBe(false); }
      finally {
        writeFileSync(join(directory, ref.path), original);
        writeFileSync(join(directory, 'I01-a1/result.json'), JSON.stringify(record));
      }
    }
    const ref = record.evidenceRefs.find(r => r.category === 'git')!;
    const original = readFileSync(join(directory, ref.path));
    const target = join(directory, 'detached.json');
    writeFileSync(target, original);
    rmSync(join(directory, ref.path));
    symlinkSync(target, join(directory, ref.path));
    expect(verifyP06Scenario(directory, record, identity).problems).toContain('evidence_symlink');
  });
});

it('[case:cleanup-claim-check] a cleanup callback cannot manufacture success while resources or processes still exist', async () => {
  await environment(async (fixture, directory) => {
    const server = await fixture.startFakeMcpServer({ spawnChild: true });
    const settings = options(fixture, directory);
    const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, cleanup: async () => ({
      status: 'passed', processStopped: true, sqliteClosed: true, factsExported: true, resourcesRemoved: true, retainedRoot: null,
    }) } });
    expect(record).toMatchObject({ status: 'fail', outcome: 'cleanup_uncertain', cleanup: { processStopped: false, resourcesRemoved: false } });
    expect(server.process.isAlive()).toBe(true);
  });
});

it('[case:failure-history] collection and publication faults append to the original command failure', async () => {
  await environment(async (fixture, directory) => {
    const run = await fixture.runCheck('failing');
    const settings = options(fixture, directory, { command: { argv: run.argv, exitCode: run.exitCode, signal: run.signal, timedOut: false, cancelled: false } });
    const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, files: ['missing-file'] } });
    expect(record).toMatchObject({ outcome: 'nonzero_exit', reason: 'nonzero_exit', status: 'fail', cleanup: { status: 'pending' } });
    expect(record.failures.map(f => f.kind)).toEqual(['nonzero_exit', 'capture_failed']);
    const summary = reconcileP06Evidence(directory, identity, [record], ['I01', 'I02']);
    expect(summary.checks[1]).toMatchObject({ status: 'not_run', reason: 'halted_by_prior_failure', attempts: [{ command: [], exitCode: null, usageSource: 'not_run' }] });
  });
});

it('[case:callback-error-safety] arbitrary callback errors never become report text or scanner diagnostics', async () => {
  await environment(async (fixture, directory) => {
    const settings = options(fixture, directory);
    const message = 'synthetic_unregistered_private_value';
    const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, cleanup: async () => { throw new Error(message); } } });
    expect(record).toMatchObject({ status: 'fail', outcome: 'cleanup_uncertain', reason: 'evidence_operation_failed' });
    expect(JSON.stringify(record)).not.toContain(message);
    expect(readFileSync(join(directory, 'I01-a1/result.json'), 'utf8')).not.toContain(message);
    expect(existsSync(fixture.root)).toBe(true);
  });
});

it('[case:publication-failure] final report write failure keeps exported facts and nonzero cause without overwriting earlier evidence', async () => {
  await environment(async (fixture, directory) => {
    const run = await fixture.runCheck('failing');
    const settings = options(fixture, directory, { scenarioId: 'I08-report-write-failed',
      command: { argv: run.argv, exitCode: run.exitCode, signal: run.signal, timedOut: false, cancelled: false } });
    const record = await collectP06Scenario({ ...settings, resources: { ...settings.resources, cleanup: async () => {
      mkdirSync(join(directory, 'I08-report-write-failed-a1/result.json'));
      return fixture.cleanup();
    } } });
    expect(record).toMatchObject({ status: 'fail', outcome: 'nonzero_exit', reason: 'nonzero_exit', publicationError: 'report_write_failed' });
    expect(record.evidenceRefs).toHaveLength(8);
    expect(verifyP06Scenario(directory, record, identity).ok).toBe(false);
    expect(reconcileP06Evidence(directory, identity, [record], ['I08-report-write-failed']).status).toBe('fail');
  });
});
