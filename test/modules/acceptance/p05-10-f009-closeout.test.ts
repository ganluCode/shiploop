import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
import { createSqliteFeatureDagStore } from '../../../packages/core/src/adapters/sqlite/feature-dag-store.ts';
import { createFeatureDagService } from '../../../packages/core/src/ports/feature-dag.ts';
import { createBatchLeafFinalizationService, type BatchFinalizationBatchSnapshot, type BatchFinalizationLeafEvidence } from '../../../packages/core/src/application/batch-leaf-finalization.ts';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import type { RunRecord } from '../../../packages/core/src/ports/execution-store.ts';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { createRealInputs, digest, git, openIntegrationFixture } from '../../helpers/p05-7-integration-vertical.ts';
import { createP05AcceptanceFixture } from '../../helpers/p05-10/index.ts';
import { loadP05Checklist } from '../../../scripts/acceptance/p05-config.ts';
import { aggregateP05IntegrationReport, type P05IntegrationCheckBinding } from '../../../scripts/acceptance/p05-integration-report.ts';
import { runP05StepSequence, type P05StepSpec } from '../../../scripts/acceptance/p05-steps.ts';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const NOW = 1_900_000_200_000;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

type BudgetFixture = Awaited<ReturnType<typeof openBudgetFixture>>;
type BudgetReceipt = Awaited<ReturnType<BudgetFixture['submit']>>;

function acceptedBatch(receipt: BudgetReceipt): { batchId: string } {
  expect(receipt.status, JSON.stringify(receipt)).toBe('accepted');
  if (receipt.status !== 'accepted' || !('batchId' in receipt)) throw new Error(`expected accepted Batch: ${JSON.stringify(receipt)}`);
  return { batchId: receipt.batchId };
}

async function addApprovedFeature(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, title: string): Promise<string> {
  const phase = fixture.session.database.prepare<[string], { revision: number }>('SELECT revision FROM phases WHERE id = ?').get('phase-1');
  if (!phase) throw new Error('phase fixture missing');
  const imported = await fixture.submit('feature.plan.import', {
    phaseId: 'phase-1',
    plan: { schemaVersion: 1, feature: { title, description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: `${title}-task`, title, acceptance: { criteria: ['P05-10 F-009'] }, dependsOn: [] }] },
  }, { scope: fixture.scope, expectedRevision: phase.revision });
  expect(imported.status).toBe('completed');
  if (imported.status !== 'completed') throw new Error('feature import failed');
  const featureId = (imported.result as { feature: { id: string } }).feature.id;
  const row = fixture.session.database.prepare<[string], { plan_digest: string; revision: number }>(
    'SELECT plan_digest, revision FROM features WHERE id = ?',
  ).get(featureId);
  if (!row) throw new Error('feature row missing');
  const approved = await fixture.submit('feature.plan.decide', {
    featureId, planDigest: row.plan_digest, decision: 'approve', reason: 'F-009 phase composition',
  }, { scope: fixture.scope, expectedRevision: row.revision });
  expect(approved.status).toBe('completed');
  return featureId;
}

function addDependency(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, featureId: string, dependsOnId: string, id: string): void {
  fixture.session.database.prepare(
    'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) ' +
      "VALUES (?, ?, ?, 1, ?, 'phase-1', ?, ?, NULL)",
  ).run(id, NOW, fixture.projectId, NOW, featureId, dependsOnId);
}

function previewMembers(preview: Awaited<ReturnType<Awaited<ReturnType<typeof openBudgetFixture>>['services']['preview']['previewExecution']>>): readonly string[] {
  if (!('memberFeatureIds' in preview.scope)) throw new Error('expected fixed Batch scope');
  return preview.scope.memberFeatureIds;
}

function runRecord(id: string, featureId: string): RunRecord {
  return {
    id, createdAtUtcMs: NOW, projectId: 'project-1', revision: 1, updatedAtUtcMs: NOW,
    batchId: 'batch-f009', featureId, purpose: 'execute', labels: [], inputSnapshot: {}, configSnapshot: {}, status: 'queued',
    scopeDigest: 'a'.repeat(64), workKey: `work-${id}`, dispatchOrdinal: 1, maxAttemptsPerRun: 1,
    runTimeLimitMs: 60_000, attemptsCreated: 0, reason: null, startedAtUtcMs: null, endedAtUtcMs: null,
    pauseRequestedAtUtcMs: null,
  };
}

function cleanupWorktree(repo: string, path: string): void {
  if (!existsSync(path)) return;
  try { git(repo, 'worktree', 'remove', '--force', path); } catch { rmSync(path, { recursive: true, force: true }); }
}

function leaf(featureId: string, commitSha: string, inputId: string, inputDigest: string, repoIdentity: string): BatchFinalizationLeafEvidence {
  return {
    featureId, featureStatus: 'completed', deliveryStatus: 'succeeded', revision: 4, commitSha, repoIdentity,
    coveredInputs: [{ inputId, digest: inputDigest }], evidenceId: `f009-${featureId}`, evidenceDigest: sha256(featureId),
    evidenceFresh: true, commitExists: true, branchHead: commitSha,
  };
}

const PASS: P02BoundedRunOutcome = {
  kind: 'exit', exitCode: 0, signal: null, durationMs: 3, timedOut: false, stdout: '', stderr: '',
  stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, spawnError: null, stoppedVerified: true,
};

function fakeExec(commit: string): (command: string, args: readonly string[]) => string {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'git rev-parse HEAD') return commit;
    if (key === 'git rev-parse HEAD^{tree}') return 'd'.repeat(40);
    if (key === 'git status --porcelain') return '';
    if (key === 'git branch --show-current') return 'feat/p05/acceptance';
    if (key === 'git --version') return 'git version 2.50.0';
    if (key === 'npm --version') return '10.9.3';
    if (key === 'node --version') return process.version;
    if (key === 'sqlite3 --version') throw new Error('sqlite3 CLI unavailable');
    throw new Error(`unexpected probe: ${key}`);
  };
}

describe('P05-10 F-009 phase composition and delivery baseline', { timeout: 120_000 }, () => {
  it('[case:f009-offline-composition] closes planning, fixed Batch, A/B concurrency, C integration, leaf delivery and append Batch in temporary resources', async () => {
    const fixture = await openBudgetFixture({
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 5, maxTotalAttempts: 5, maxRuntimeStarts: 5 },
    });
    try {
      const featureA = fixture.featureId;
      const featureB = await addApprovedFeature(fixture, 'f009-feature-b');
      const featureC = await addApprovedFeature(fixture, 'f009-feature-c');
      addDependency(fixture, featureC, featureA, 'f009-edge-c-a');
      addDependency(fixture, featureC, featureB, 'f009-edge-c-b');

      const dag = createFeatureDagService({ store: createSqliteFeatureDagStore(fixture.session) });
      expect(dag.evaluate(fixture.projectId, 'phase-1').readiness.find(item => item.featureId === featureC)).toMatchObject({
        ready: false, reason: 'dependency_pending', dependencyIntegrationReady: false,
      });
      fixture.session.database.prepare("UPDATE features SET status = 'completed' WHERE id IN (?, ?)").run(featureA, featureB);
      expect(dag.evaluate(fixture.projectId, 'phase-1').readiness.find(item => item.featureId === featureC)).toMatchObject({
        ready: false, reason: 'integration_not_ready', dependencyCompletion: 'complete',
      });

      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [featureA, featureB], budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('ready');
      const firstMembers = previewMembers(preview);
      const first = acceptedBatch(await fixture.submit('execution.start', {
        featureIds: firstMembers, budget: { ...fixture.budget }, previewDigest: preview.previewDigest,
      }, { scope: fixture.scope }));
      expect(firstMembers).toEqual([featureA, featureB].sort());

      const candidates = [runRecord('run-a', featureA), runRecord('run-b', featureB)];
      let active = 0;
      let maximum = 0;
      let release!: () => void;
      const bothEntered = new Promise<void>(resolvePromise => { release = resolvePromise; });
      const scheduler = createWorkScheduler({
        store: {
          listActiveRuns: () => ({ runs: candidates.map(candidate => ({ projectId: candidate.projectId, runId: candidate.id })), hasMore: false, nextCursor: null }),
          listBatchCandidates: () => ({ candidates: [], hasMore: false, nextCursor: null }),
          recordRunReason: () => undefined,
          isFinalVerificationHandoffClaimed: () => false,
          recordFinalVerificationHandoff: () => false,
          readRun: (_projectId, runId) => candidates.find(candidate => candidate.id === runId)!,
        },
        dag: { evaluate: (projectId: string, runId: string) => ({ projectId, runId, featureId: candidates.find(candidate => candidate.id === runId)!.featureId,
          reason: 'ready' as const, diagnostic: null, readyTaskIds: ['task-1'], tasks: [], handoff: null }) },
        claims: { claimTask: () => ({ replayed: false, receipt: {} }) as never },
        featureConcurrency: () => 2,
        prepareClaim: async ({ candidate }) => {
          active += 1;
          maximum = Math.max(maximum, active);
          if (active === 2) release();
          await bothEntered;
          active -= 1;
          return { projectId: candidate.run.projectId, runId: candidate.run.id, taskId: 'task-1' };
        },
        consumeClaim: async () => undefined,
      });
      await scheduler.scan();
      await scheduler.close();
      expect(maximum).toBe(2);

      fixture.session.database.prepare("UPDATE runs SET status = 'failed', reason = 'f009-close-first-batch' WHERE batch_id = ?").run(first.batchId);
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'failed', reason = 'f009-close-first-batch' WHERE id = ?").run(first.batchId);
      const featureD = await addApprovedFeature(fixture, 'f009-feature-d');
      const appendPreview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [featureA, featureB, featureD],
        budget: { ...fixture.budget, batch: { ...fixture.budget.batch, maxRuns: 6, maxTotalAttempts: 6, maxRuntimeStarts: 6 } },
      });
      expect(appendPreview.status).toBe('ready');
      const second = acceptedBatch(await fixture.submit('execution.start', {
        featureIds: previewMembers(appendPreview),
        budget: { ...fixture.budget, batch: { ...fixture.budget.batch, maxRuns: 6, maxTotalAttempts: 6, maxRuntimeStarts: 6 } },
        previewDigest: appendPreview.previewDigest,
      }, { scope: fixture.scope }));
      expect(second.batchId).not.toBe(first.batchId);
      expect(fixture.session.database.prepare<[string], { scope_snapshot: string }>('SELECT scope_snapshot FROM execution_batches WHERE id = ?').get(first.batchId)).toBeDefined();
      expect(fixture.session.database.prepare<[string], { feature_id: string }>('SELECT feature_id FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal').all(second.batchId)).toEqual(
        expect.arrayContaining([{ feature_id: featureA }, { feature_id: featureB }, { feature_id: featureD }]),
      );
    } finally {
      fixture.close();
    }

    const integration = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(integration);
      let mergedHead: string | undefined;

      integration.box.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(integration.plan.runId);
      integration.box.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(integration.plan.batchId);
      const candidates = createSqliteBatchFinalizationCandidateStore(integration.box.session, { nowUtcMs: () => NOW });
      const batch: BatchFinalizationBatchSnapshot = {
        schemaVersion: 1, projectId: integration.box.projectId, phaseId: 'phase-1', batchId: integration.plan.batchId,
        revision: 3, status: 'succeeded', approved: true, featureIds: ['predecessor-a', 'predecessor-b'], dependencies: [],
        targetBaseline: real.base, approvedInputs: real.inputs, verificationScope: ['combined-tests'],
        strategySummary: { mode: 'deterministic', mergeOrder: ['predecessor-a', 'predecessor-b'] },
      };
      const finalization = createBatchLeafFinalizationService({
        batches: { read: () => batch },
        leaves: { read: (_project, featureId) => featureId === 'predecessor-a'
          ? leaf(featureId, real!.shas[0]!, 'input-a', digest('a'), integration.plan.target.repoIdentity)
          : leaf(featureId, real!.shas[1]!, 'input-b', digest('b'), integration.plan.target.repoIdentity) },
        candidates,
        integrate: async candidate => {
          integration.box.session.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(integration.plan.runId);
          integration.box.session.database.prepare("UPDATE execution_batches SET status = 'running' WHERE id = ?").run(integration.plan.batchId);
          const merged = await integration.service(createIntegrationGitWorkspace({
            confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
          })).start(integration.request);
          expect(merged.outcome).toBe('pending_verification');
          expect(readFileSync(join(real!.path, 'a.txt'), 'utf8')).toBe('a\n');
          expect(readFileSync(join(real!.path, 'b.txt'), 'utf8')).toBe('b\n');
          mergedHead = git(real!.path, 'rev-parse', 'HEAD');
          expect(mergedHead).toMatch(/^[0-9a-f]{40}$/);
          integration.box.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(integration.plan.runId);
          integration.box.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(integration.plan.batchId);
          return { status: 'succeeded' as const, commitSha: mergedHead, treeSha: git(real!.path, 'rev-parse', 'HEAD^{tree}'), evidenceId: 'f009-integration', evidenceDigest: sha256('f009-integration'), workspacePreserved: true };
        },
        verify: async (_candidate, result) => ({ status: result.commitSha === mergedHead ? 'passed' as const : 'failed' as const, evidenceId: 'f009-verification', evidenceDigest: sha256('f009-verification') }),
      });
      const delivered = await finalization.run({ projectId: integration.box.projectId, batchId: integration.plan.batchId, commandId: 'f009-leaf-delivery' });
      expect(delivered.status, JSON.stringify(delivered)).toBe('ready_for_phase_approval');
      expect(delivered.candidate?.leaves.map(item => item.commitSha)).toEqual(real.shas);
      expect(delivered.candidate?.integration?.commitSha).toBe(mergedHead);
      expect(delivered.candidate?.verification?.status).toBe('passed');
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      integration.close();
    }
  });

  it('[case:f009-report-binds-evidence-and-keeps-gates-pending] writes a replayable report with SHA, toolchain, commands and explicit live/manual not_run state', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'shiploop-p05-f009-report-'));
    const stepRunDir = join(parent, 'step-run');
    const reportRoot = join(parent, 'reports');
    const scenarioRoot = join(parent, 'scenarios');
    const commit = 'a'.repeat(40);
    try {
      const sequence = await runP05StepSequence([
        { id: 'trusted-index', command: process.execPath, args: ['-e', 'process.stdout.write("trusted")'], cwd: ROOT },
        { id: 'cross-layer', command: process.execPath, args: ['-e', 'process.stdout.write("smoke")'], cwd: ROOT },
      ] as readonly P05StepSpec[], {
        evidenceDir: stepRunDir,
        identity: { runId: 'p05-f009-report', commit, inputsDigest: 'b'.repeat(64) },
        stepTimeoutMs: 5_000, overallTimeoutMs: 30_000, maxOutputBytes: 4_096,
        runProcess: async () => PASS,
      });
      expect(sequence.exitCode).toBe(0);
      const checklist = loadP05Checklist(join(ROOT, 'acceptance/p05.checklist.json'));
      mkdirSync(scenarioRoot, { recursive: true });
      const categories = [...new Set(checklist.items.flatMap(item => item.evidence))];
      for (const category of categories) writeFileSync(join(scenarioRoot, `${category}.json`), JSON.stringify({
        schemaVersion: 1, offline: true, live: 'not_run', observations: [{ scenarioId: 'I01' }, { scenarioId: 'I02' }, { scenarioId: 'I03' }, { scenarioId: 'I04' }, { scenarioId: 'I05' }, { scenarioId: 'I06' }, { scenarioId: 'I07' }, { scenarioId: 'I08' }, { scenarioId: 'I09' }],
      }) + '\n');
      const bindings: P05IntegrationCheckBinding[] = checklist.items.filter(item => item.group !== 'deferred' && item.execution === 'offline').map(item => ({
        checkId: item.id, stepIds: ['trusted-index', 'cross-layer'],
        scenarios: item.evidence.map(category => ({ file: `${category}.json`, category, scenarioIds: [...item.scenarioIds] })),
      }));
      const result = aggregateP05IntegrationReport({
        repoRoot: ROOT, runId: 'p05-f009-report', reportRoot, checklist, stepRunDir, scenarioRoot, bindings,
        cleanup: { confirmed: true, processesGone: true },
        knownLimitations: ['full historical regression not_run', 'live GitAgent not_run', 'manual owner gate pending'],
        exec: fakeExec(commit), now: () => new Date('2026-10-23T00:00:00.000Z'),
      });
      expect(result.reportWritten).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.toolDelivery.status).toBe('pass');
      expect(result.phaseGate.accepted).toBe(false);
      expect(result.phaseGate.pending.some(item => item.kind === 'live' && item.display === 'not_run')).toBe(true);
      expect(result.phaseGate.pending.some(item => item.kind === 'manual' && item.display === 'pending')).toBe(true);
      expect(result.written?.report.git.commit).toBe(commit);
      expect(result.written?.report.commands.every(command => command.exitCode === 0)).toBe(true);
      expect(result.written?.report.plan.checklistDigestSha256).toBe(sha256(readFileSync(join(ROOT, 'acceptance/p05.checklist.json'), 'utf8')));
      const reportText = readFileSync(join(result.written!.runDir, 'report.json'), 'utf8');
      expect(reportText).toContain('full historical regression not_run');
      expect(reportText).not.toContain(ROOT);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('[case:f009-fixture-captures-side-effects-before-cleanup] records FakeRuntime, SQLite, Git and owned-process facts from temporary resources', async () => {
    const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f009-evidence-' });
    const scenario = fixture.createScenario('phase-closeout');
    try {
      const run = await scenario.runFakeRuntime({ script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'phase-output.txt', content: 'f009\n' }] } });
      expect(run.result.terminal).toBe('completed');
      expect(readFileSync(join(scenario.projectDirectory, 'phase-output.txt'), 'utf8')).toBe('f009\n');
      const child = scenario.spawnProcess({ argv: [process.execPath, '-e', 'process.exit(0)'], label: 'f009-owned' });
      expect((await child.exited).code).toBe(0);
      const beforeCleanup = { sqlite: scenario.sqliteFacts(), git: scenario.gitFacts(), process: scenario.processFacts() };
      expect(beforeCleanup.sqlite.open).toBe(true);
      expect(beforeCleanup.git.status).toBe('');
      const cleanup = await scenario.cleanup();
      expect(cleanup.status).toBe('passed');
      const evidence = scenario.recordEvidence({
        input: { flow: 'p05-f009', windows: ['resource', 'replay', 'late-result', 'input-drift', 'git-conflict', 'budget'] },
        command: ['node', 'scripts/run-tests.ts', 'test/modules/acceptance/p05-10-f009-closeout.test.ts'],
        exitCode: 0, stateSnapshot: { beforeCleanup, sideEffect: 'phase-output.txt', cleanup }, usageSource: run.usageSource,
      });
      const path = scenario.writeEvidence(evidence);
      expect(existsSync(path)).toBe(true);
      expect(evidence.testedCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(evidence.cleanup.status).toBe('passed');
    } finally {
      await fixture.dispose();
    }
  });
});
