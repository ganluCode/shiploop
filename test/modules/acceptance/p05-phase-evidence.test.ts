import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createP05AcceptanceFixture, type P0510ScenarioEvidence } from '../../helpers/p05-10/index.ts';

const SCENARIOS = ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09'] as const;
const CATEGORIES = ['command-exit', 'sqlite', 'git', 'process', 'artifact', 'report', 'manifest', 'sha', 'usage', 'cleanup'] as const;

it('exports real offline P05 scenario facts for the phase report aggregator', async () => {
  const ownedRoot = process.env.SHIPLOOP_P05_SCENARIO_ROOT === undefined;
  const root = process.env.SHIPLOOP_P05_SCENARIO_ROOT ?? mkdtempSync(join(tmpdir(), 'shiploop-p05-phase-evidence-test-'));
  const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-phase-evidence-', evidenceDir: root });
  const observations: Record<string, unknown>[] = [];
  try {
    for (const scenarioId of SCENARIOS) {
      const scenario = fixture.createScenario(scenarioId.toLowerCase());
      const runtime = await scenario.runFakeRuntime();
      const child = scenario.spawnProcess({ argv: [process.execPath, '-e', 'process.exit(0)'], label: `p05-${scenarioId}` });
      await expect(child.waitExit(2_000)).resolves.toMatchObject({ code: 0, signal: null });
      const beforeCleanup = { sqlite: scenario.sqliteFacts(), git: scenario.gitFacts(), process: scenario.processFacts() };
      const cleanup = await scenario.cleanup();
      expect(cleanup.status).toBe('passed');
      const evidence = scenario.recordEvidence({
        input: { phase: 'P05', scenarioId },
        command: ['node', 'scripts/run-tests.ts', 'test/modules/acceptance/p05-phase-evidence.test.ts'],
        exitCode: 0,
        status: 'pass',
        stateSnapshot: { beforeCleanup, runtime: runtime.result.terminal, cleanup },
        usageSource: runtime.usageSource,
      });
      const evidencePath = scenario.writeEvidence(evidence);
      expect(existsSync(evidencePath)).toBe(true);
      observations.push({
        scenarioId,
        status: evidence.status,
        inputDigest: evidence.inputDigest,
        testedCommit: evidence.testedCommit,
        command: evidence.command,
        exitCode: evidence.exitCode,
        sqlite: { journalMode: evidence.sqlite.journalMode, foreignKeysEnabled: evidence.sqlite.foreignKeysEnabled, recordCount: evidence.sqlite.recordCount, openBeforeCleanup: beforeCleanup.sqlite.open },
        git: { head: evidence.git.head, tree: evidence.git.tree, clean: evidence.git.status === '' },
        process: { owned: evidence.process.owned, spawned: evidence.process.spawned, exited: evidence.process.exited, aliveAfterCleanup: evidence.cleanup.processStopped ? 0 : evidence.process.alive },
        artifact: { refs: evidence.evidenceRefs.length, source: 'temporary-project' },
        sha: { commit: evidence.testedCommit, input: evidence.inputDigest },
        usage: { source: evidence.usageSource },
        cleanup: { status: evidence.cleanup.status, resourcesRemoved: evidence.cleanup.resourcesRemoved, processStopped: evidence.cleanup.processStopped, filesChecked: evidence.cleanup.filesChecked },
      });
    }
  } finally {
    await fixture.dispose();
  }
  expect(observations).toHaveLength(SCENARIOS.length);
  const base = { schemaVersion: 1, offline: true, live: 'not_run', observations };
  for (const category of CATEGORIES) {
    writeFileSync(join(root, `phase-evidence-${category}.json`), JSON.stringify({ ...base, category }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const summary = JSON.stringify({ schemaVersion: 1, source: 'p05-phase-evidence.test.ts', categories: CATEGORIES, scenarios: observations.map(row => row.scenarioId) }, null, 2) + '\n';
  writeFileSync(join(root, 'phase-evidence-index.json'), summary, { flag: 'wx', mode: 0o600 });
  expect(JSON.parse(readFileSync(join(root, 'phase-evidence-index.json'), 'utf8')).scenarios).toEqual([...SCENARIOS]);
  if (ownedRoot) rmSync(root, { recursive: true, force: true });
});
