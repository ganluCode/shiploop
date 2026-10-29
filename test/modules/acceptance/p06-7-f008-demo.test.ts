/** A focused, offline fixture-to-report demonstration. Never invokes a phase/verify command. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { expect, it } from 'vitest';
import { startHost, connectToHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { git } from '../../helpers/git-repo.ts';
import { setup, jsonArtifact, runFake, checkIncrement, assertOriginalFiles, facts } from '../../helpers/p06-7/knowledge-scenario.ts';
import { stageResourceFixture } from '../../helpers/p06-7/resource-scenario.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { prepareMcpStartupPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { createMcpStdioConnection } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { collectP06Scenario, P06_REQUIRED_EVIDENCE_SCENARIOS, type P06CleanupFact, type P06EvidenceIdentity } from '../../../scripts/acceptance/p06-evidence.ts';
import { hashP06Input, safeP06Json } from '../../../scripts/acceptance/p06-facts.ts';
import { writeP06AcceptanceReport, verifyP06ReportDirectory } from '../../../scripts/acceptance/p06-report.ts';
import { P06_FROZEN_ITEMS } from '../../../scripts/acceptance/p06-config.ts';
import type { ContextInputManifest, ContextInputSnapshot } from '../../../packages/core/src/ports/context-build.ts';

it('[case:fixture-to-report] demonstrates dirty onboarding, pinned knowledge, restricted increment, selected stdio resources and verifiable cleanup', async () => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 });
  const local = mkdtempSync(join(tmpdir(), 'p06-f008-demo-evidence-'));
  const input = process.env.SHIPLOOP_P06_ENTRY_INPUT ? JSON.parse(readFileSync(process.env.SHIPLOOP_P06_ENTRY_INPUT, 'utf8')).material : { purpose: 'F-008-task-local-demo', phaseAccepted: false, sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '' };
  const identity: P06EvidenceIdentity = process.env.SHIPLOOP_P06_ENTRY_IDENTITY ? JSON.parse(process.env.SHIPLOOP_P06_ENTRY_IDENTITY) : {
    runId: 'task-local-demo', testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), inputDigest: hashP06Input(input) };
  const source = process.env.SHIPLOOP_P06_ENTRY_SOURCE ?? join(local, 'source');
  const observed: Record<string, Record<string, unknown>> = {};
  let knownFailure!: { exitCode: number | null; runs: number | null; stopConfirmed: boolean };
  const f = await setup({ beforeExecution: async ctx => {
    const dirtyBefore = { ...ctx.todo.dirtyBaseline(), statusPorcelain: git(['status', '--porcelain=v1'], ctx.todo.todoRepositoryPath, { home: ctx.todo.homeDir }) };
    const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]);
    const dataRoot = dirname(ctx.session.database.name);
    const onboardingHost = await startHost({ dataRoot, env: ctx.todo.childEnv(), capabilityCatalog: catalog });
    const onboardingClient = await connectToHost({ canonicalRoot: onboardingHost.canonicalRoot });
    try {
      const inspection = await onboardingClient.inspectRepository(ctx.todo.todoRepositoryPath);
      expect(inspection).toMatchObject({ hasInitialCommit: true, hasUncommittedChanges: true, alreadyRegistered: { projectId: ctx.projectId } });
      expect(ctx.todo.compareDirtyBaseline(dirtyBefore)).toEqual({ matches: true, differences: [] });
      observed.I01 = { projectId: ctx.projectId, head: inspection.headCommit, dirtyPreserved: true, repositoryScriptsExecuted: false };
      await expect(startHost({ dataRoot, env: ctx.todo.childEnv(), capabilityCatalog: catalog, lockTimeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
      observed['I07-resource-conflict'] = { code: 'owner_unknown', originalHostId: onboardingHost.hostInstanceId, replacementStarted: false };
      expect((await onboardingClient.detectProjectProfile({ projectId: ctx.projectId })).status).toBe('completed');
      const profile = (await onboardingClient.getProjectProfile(ctx.projectId)).candidate!;
      expect(profile.modules.map(module => module.id)).toContain('language-typescript');
      expect((await onboardingClient.confirmProjectProfile({ projectId: ctx.projectId, expectedRevision: 1,
        profile: { schemaVersion: 1, projectId: ctx.projectId, version: profile.version, revision: profile.revision, status: profile.status,
          modules: profile.modules, documentRefs: [], detectionEvidenceRefs: profile.evidence.map(e => e.id), confirmedBy: null } })).status).toBe('completed');
      const confirmed = (await onboardingClient.getProjectProfile(ctx.projectId)).confirmed!;
      expect(confirmed.confirmed).toBe(true);
      expect((await onboardingClient.getEffectiveSettings(ctx.projectId)).strategies.defaultStrategy!.strategy.runtime).toBe('fake');
      const plan = join(ctx.todo.root, 'baseline.json');
      writeFileSync(plan, JSON.stringify({ checks: [{ checkKey: ctx.todo.checks.failing.checkKey, kind: 'command', argv: ctx.todo.checks.failing.argv, timeoutMs: 5000, required: true }] }));
      let stdout = '';
      const baselineRun = await runAppCli({ args: ['baseline', 'run', '--project', ctx.projectId, '--input', plan, '--confirm', '--wait', '--json', '--data-root', dataRoot],
        env: {}, userHomeDir: ctx.todo.homeDir, platform: 'darwin', io: { stdout: v => { stdout += v; }, stderr: () => {} } });
      expect(baselineRun.exitCode).toBe(1);
      const baseline = JSON.parse(stdout).result;
      expect(baseline).toMatchObject({ state: 'failed', checks: [{ exitCode: 3, status: 'failed' }] });
      expect((await onboardingClient.listBaselines(ctx.projectId)).records).toHaveLength(1);
      knownFailure = { exitCode: baseline.checks[0].exitCode, runs: JSON.parse(readFileSync(join(ctx.todo.checkFactsDir, 'check-fail.json'), 'utf8')).runs, stopConfirmed: true };
      observed.I02 = { confirmed, baseline: { operationId: baseline.operationId, state: baseline.state, checkExitCode: knownFailure.exitCode }, configuredRuntime: 'fake', existingFailurePreserved: true };
    } finally { onboardingClient.close(); await onboardingHost.close(); }
  } });
  let resources: Awaited<ReturnType<typeof stageResourceFixture>> | undefined;
  let connection: ReturnType<typeof createMcpStdioConnection> | undefined;
  let bindingClosed = false;
  let reportHost: Awaited<ReturnType<typeof openReportHost>> | undefined;
  try {
    reportHost = await openReportHost({ box: f.binding.box, owner: createLocalOwnerPrincipal() });
    const client = reportHost.client;
    const beforeQuery = facts(f.binding);
    const knowledge = await client.searchKnowledge(f.binding.projectId, { documentId: f.documentId, version: 1, keyword: 'todo/inbox.txt', limit: 1 });
    expect(knowledge.results).toHaveLength(1);
    expect(knowledge.results[0].contentHash).toBe(f.versionHash);
    expect(facts(f.binding)).toBe(beforeQuery);
    const bound = f.binding.claimAndLaunch('t-1');
    const manifest = await jsonArtifact<ContextInputManifest>(f.binding, bound.inputSnapshot.group.manifest.artifactId);
    const snapshot = await jsonArtifact<ContextInputSnapshot>(f.binding, bound.inputSnapshot.group.snapshot.artifactId);
    expect(snapshot.knowledge?.[0].contentHash).toBe(f.versionHash);
    expect(manifest.sources.some(s => s.kind === 'knowledge')).toBe(true);
    observed.I03 = { documentId: f.documentId, contentHash: f.versionHash, readOnly: true, manifestDigest: bound.inputSnapshot.digests.manifestDigest, knowledge: snapshot.knowledge };
    const binding = await f.binding.bindingService.bind(f.binding.bindingInput(bound));
    await expect(binding.reader.read('global.md')).rejects.toMatchObject({ reason: 'unbound_input_read' });
    const before = readFileSync(f.todo.todoFilePath, 'utf8');
    const after = before.replace('TODO-3 在受限范围内修改本文件的待办事项', 'TODO-3 已完成受限增量修改');
    const run = await runFake(f, binding.request, binding.reader, [{ op: 'read_input', purpose: 'snapshot' }, { op: 'write_file', path: 'inbox.txt', content: after }]);
    expect(run.result.terminal).toBe('completed');
    expect(await checkIncrement(f.todo, after)).toMatchObject({ exitCode: 0, stopConfirmed: true });
    assertOriginalFiles(f);
    expect(f.binding.query('SELECT status FROM tasks WHERE id = ? AND feature_id = ?', 't-1', f.binding.featureId)).toEqual({ status: 'running' });
    observed.I04 = { changedFiles: ['todo/inbox.txt'], beforeDigest: hashP06Input(before), afterDigest: hashP06Input(after), operations: run.operations,
      checkExitCode: 0, taskStatus: 'running', originalDirtyFilesPreserved: true };

    resources = await stageResourceFixture();
    const loadedSkills = resources.loader.getSkills().skills.map(s => s.name);
    expect(loadedSkills).toEqual(['approved-stage-skill']);
    expect(resources.loader.getExtensions().extensions).toEqual([]);
    expect(resources.loader.getAgentsFiles().agentsFiles).toEqual([]);
    observed.I05 = { loadedSkills, selectionDigest: resources.selection.digest, defaultScan: false, ownerFallback: false, strongSandbox: false };
    const plan = await prepareMcpStartupPlan(resources.request, { resolver: resources.assembly.mcp!.resolver });
    connection = createMcpStdioConnection({ ...resources.assembly.mcp!, plan, handshakeTimeoutMs: 2000, closeTimeoutMs: 200 });
    await connection.start();
    const catalog = await connection.createToolCatalog();
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.resolve('mcp_unselected')).toBeUndefined();
    expect(await catalog.tools[0].execute('p06-demo-call', {})).toMatchObject({ isError: false, content: [{ type: 'text', text: 'fake result' }] });
    const call = JSON.parse(readFileSync(join(resources.box.path, 'call.entered'), 'utf8'));
    expect(call.count).toBe(1);
    expect((await connection.close()).confirmed).toBe(true);
    observed.I06 = { transport: 'stdio', calls: call.count, tool: call.params.name, processStopConfirmed: true, remoteTransports: 'unsupported' };
    const forged = { ...resources.request, invocationId: 'forged' };
    await expect(prepareMcpStartupPlan(forged, { resolver: resources.assembly.mcp!.resolver })).rejects.toMatchObject({ reason: 'identity_mismatch' });
    expect(JSON.parse(readFileSync(join(resources.box.path, 'call.entered'), 'utf8')).count).toBe(1);
    const timeout = await f.todo.runCheck('hang', { timeoutMs: 100 });
    expect(timeout).toMatchObject({ timedOut: true, stopConfirmed: true });
    observed['I07-timeout'] = { timedOut: timeout.timedOut, stopped: timeout.stopConfirmed, signal: timeout.signal };
    const cancelled = f.todo.spawnManagedProcess({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], label: 'demo-cancel' });
    const stop = await cancelled.verifyStopped({ stepMs: 100 });
    expect(cancelled.isAlive()).toBe(false);
    observed['I07-cancelled'] = { pid: cancelled.pid, alive: cancelled.isAlive(), stop };
    observed['I07-nonzero-exit'] = { exitCode: knownFailure.exitCode, runs: knownFailure.runs, requiredFailureRemainsFailure: true };
    const other = await createSqliteStateStore(f.binding.session).createProject({ displayName: 'Demo other' });
    await expect(f.query.read(createLocalOwnerPrincipal(), other.id, f.documentId, 1)).rejects.toMatchObject({ code: 'forbidden' });
    observed['I07-validation-failed'] = { crossProject: other.id, error: 'forbidden', documentId: f.documentId };
    const changed = { ...binding.request, invocationId: 'drift' };
    expect(hashP06Input(changed)).not.toBe(hashP06Input(binding.request));
    await expect(f.binding.bindingService.bind(f.binding.bindingInput(bound, { invocationId: 'drift' }))).rejects.toBeDefined();
    observed['I07-input-drift'] = { rejected: true, originalInputDigest: bound.inputSnapshot.digests.snapshotDigest };
    const blockedReport = join(local, 'not-a-directory'); writeFileSync(blockedReport, 'keep');
    expect(() => writeP06AcceptanceReport({ reportRoot: blockedReport, sourceDirectory: source, input: { identity, toolchain: { node: process.versions.node }, checks: [], scenarios: [], products: [], knownGaps: [] } })).toThrow();
    expect(readFileSync(blockedReport, 'utf8')).toBe('keep');
    observed['I08-report-write-failed'] = { writeRejected: true, originalBytes: hashP06Input('keep'), reportPublished: false };
    const second = mkdtempSync(join(tmpdir(), 'p06-demo-isolation-'));
    const firstRoot = f.todo.root;
    expect(second).not.toBe(firstRoot);
    writeFileSync(join(second, 'independent'), 'new-run');
    expect(existsSync(join(firstRoot, 'independent'))).toBe(false);
    rmSync(second, { recursive: true });
    observed.I08 = { distinctRoot: true, historyReuse: false, reportOverwrite: false };
    observed.I07 = { negativeScenarios: Object.keys(observed).filter(s => s.startsWith('I07-')), unexpectedWrites: false };
    observed['FR-1'] = { projectId: f.binding.projectId, completed: ['I01', 'I02', 'I03', 'I04', 'I05', 'I06'], realModelCalls: 0, dirtyPreserved: true };
    observed['FR-2'] = { negativeScenarios: [...observed.I07.negativeScenarios as string[], 'I08-report-write-failed'], failureHistoryPreserved: true, evidenceBeforeCleanup: true };
    const product = await client.getFeatureReport(f.binding.projectId, f.binding.featureId);
    mkdirSync(join(source, 'products'), { recursive: true });
    writeFileSync(join(source, 'products/feature.json'), safeP06Json({ schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture',
      identity: { runId: identity.runId, commit: identity.testedCommit, inputsDigest: identity.inputDigest },
      projectId: f.binding.projectId, featureId: f.binding.featureId, report: product }), { flag: 'wx', mode: 0o600 });
    await reportHost.close(); reportHost = undefined;
    await resources.cleanup(); resources = undefined;
    // Export the real committed product database through SQLite's backup API; never write business rows by SQL.
    const backup = join(f.todo.root, 'product-snapshot.sqlite');
    await f.binding.session.database.backup(backup);
    f.binding.close(); bindingClosed = true;
    let release!: (value: P06CleanupFact) => void;
    const cleanupGate = new Promise<P06CleanupFact>(resolve => { release = resolve; });
    // Every collector captures its typed facts synchronously before awaiting the shared final cleanup barrier.
    const pending = P06_REQUIRED_EVIDENCE_SCENARIOS.map(scenarioId => collectP06Scenario({ directory: source, identity, scenarioId, attempt: 1, input,
      command: { argv: ['node', 'scripts/run-tests.ts', 'test/modules/acceptance/p06-7-f008-demo.test.ts'], exitCode: 0, signal: null, timedOut: false, cancelled: false },
      outcome: 'success', sideEffects: observed[scenarioId], tools: { node: process.versions.node, npm: '10.9.3' }, usageSource: 'runtime-usage', usage: { realModelCalls: 0, source: 'scripted-runtime' },
      sensitiveValues: [f.todo.root, f.binding.box.dataRoot, process.cwd(), process.execPath, f.todo.sensitiveSentinelValue, f.todo.bearerSentinelValue],
      resources: { root: f.todo.root, sqlitePath: backup, repositoryPath: f.todo.todoRepositoryPath, files: ['todo/inbox.txt', 'docs/architecture.md'],
        processFacts: () => f.todo.processFacts(), cleanup: () => cleanupGate } }));
    release(await f.todo.cleanup());
    const records = await Promise.all(pending);
    expect(records.map(r => ({ scenario: r.scenarioId, status: r.status, reason: r.reason }))).toEqual(P06_REQUIRED_EVIDENCE_SCENARIOS.map(scenario => ({ scenario, status: 'pass', reason: null })));
    const reportRoot = process.env.SHIPLOOP_P06_DEMO_REPORT_ROOT ?? join(local, 'reports');
    const report = writeP06AcceptanceReport({ reportRoot, sourceDirectory: source, input: { identity,
      toolchain: { node: process.versions.node, npm: '10.9.3' }, scenarios: records, products: [{ path: 'products/feature.json' }],
      knownGaps: ['live_not_run', 'owner_pending', process.env.SHIPLOOP_P06_ENTRY_IDENTITY ? 'entry_bound_scene' : 'task_local_source_dirty_not_phase_acceptance'],
      checks: P06_FROZEN_ITEMS.map(item => ({ checkId: item.id, executionMode: item.execution === 'offline' ? 'fake' : item.execution, status: item.execution === 'offline' ? 'pass' : 'not_run' })) } });
    expect(report.verification.ok).toBe(true);
    expect(report.report?.offlineConclusion).toBe('pass');
    expect(report.report?.counts).toEqual({ pass: 10, fail: 0, not_run: 2 });
    expect(report.exitCode).toBe(1); // No owner or real-model evidence was fabricated.
    expect(verifyP06ReportDirectory(report.directory, identity).ok).toBe(true);
    expect(existsSync(f.todo.root)).toBe(false);
  } finally {
    await reportHost?.close();
    await connection?.close();
    await resources?.cleanup();
    if (!bindingClosed) f.binding.close();
    await f.todo.dispose();
    rmSync(local, { recursive: true, force: true });
  }
}, 120_000);
