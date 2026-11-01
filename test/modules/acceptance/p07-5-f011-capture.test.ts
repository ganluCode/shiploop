import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { collectP07Scenario, hashP07Bytes, hashP07Input, verifyP07Scenario } from '../../../scripts/acceptance/p07-evidence.ts';
import { observeP07Entry, observeP07Native, observeP07Product, publishP07EntryCapture, setP07ActiveCapture, type P07ActiveCapture } from '../../helpers/p07-5/entry-observation.ts';
import { openBudgetFixture, BUDGET } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';

it('[case:p07-entry-real-capture] preserves readonly SQLite/Git/artifact snapshots and a real product response after fixture cleanup', async () => {
  const output = mkdtempSync(join(tmpdir(), 'p07-capture-local-'));
  const identity = { runId: 'capture-local', testedCommit: 'a'.repeat(40), inputDigest: hashP07Input('local capture') };
  const capture: P07ActiveCapture = { file: 'test/modules/lifecycle/p07-5-f007-backup-recovery.test.ts', title: 'actual snapshot survives cleanup', observations: [], products: [] };
  const fixture = await openBudgetFixture(BUDGET);
  let host: Awaited<ReturnType<typeof openReportHost>> | undefined;
  let closed = false;
  try {
    vi.stubEnv('SHIPLOOP_P07_ENTRY_SOURCE', output); setP07ActiveCapture(capture);
    await fixture.start();
    host = await openReportHost(fixture);
    const report = await host.client.getFeatureReport(fixture.projectId, fixture.featureId);
    observeP07Product({ projectId: fixture.projectId, featureId: fixture.featureId, report });
    const before = fixture.snapshot();
    observeP07Entry(fixture.box.root, fixture.box.dbPath, { repo: fixture.box.repoDirA });
    expect(fixture.snapshot()).toEqual(before);
    expect(capture.observations).toHaveLength(1);
    const observation = capture.observations[0];
    expect(observation.facts.sqlite?.tables.find(table => table.name === 'runs')?.rows).toHaveLength(1);
    expect(observation.facts.git?.repositories[0].head).toMatch(/^[a-f0-9]{40}$/);
    expect(capture.products).toHaveLength(1);
    await host.close(); host = undefined; fixture.close(); closed = true;
    const file = publishP07EntryCapture(output, identity, capture, { passed: true, assertions: 5 });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(fixture.box.root);
    const saved = JSON.parse(text);
    expect(saved).toMatchObject({ identity, passed: true, observations: [{ removed: true }] });
    expect(() => publishP07EntryCapture(output, identity, capture, { passed: true, assertions: 5 })).toThrow();
    const record = await collectP07Scenario({ directory: join(output, 'collected'), identity,
      checkId: 'P07-T16-BACKUP-RESTORE-CONSISTENCY', attempt: 1, expectation: 'success',
      command: { label: 'snapshot-local-test', argv: ['node', 'scripts/run-tests.ts', 'test/modules/acceptance/p07-5-f011-capture.test.ts'],
        exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1, escalated: [], stopConfirmed: true },
      positiveAssertions: ['readonly snapshot and product response remain verifiable after cleanup'], facts: observation.facts,
      usage: { source: 'command-output', tools: { node: process.versions.node } },
      cleanup: { status: 'passed', processStopped: true, factsExported: true, sqliteClosed: true, resourcesRemoved: true, retainedRoot: null } });
    expect(record.status).toBe('pass');
    expect(verifyP07Scenario(join(output, 'collected'), record, identity).ok).toBe(true);
  } finally {
    setP07ActiveCapture(undefined); vi.unstubAllEnvs(); await host?.close(); if (!closed) fixture.close();
    rmSync(output, { recursive: true, force: true });
  }
});

it('[case:p07-entry-native-and-unconfirmed] hashes actual native bytes, records retained roots and performs no export outside an active entry', () => {
  const output = mkdtempSync(join(tmpdir(), 'p07-capture-output-'));
  const root = mkdtempSync(join(tmpdir(), 'p07-native-local-'));
  const capture: P07ActiveCapture = { file: 'test/modules/runtime/recovery/p07-5-f006-native-single-writer.test.ts', title: 'native bytes', observations: [], products: [] };
  try {
    writeFileSync(join(root, 'session.jsonl'), '{"type":"session"}\n');
    setP07ActiveCapture(undefined); observeP07Native(root);
    expect(capture.observations).toHaveLength(0);
    vi.stubEnv('SHIPLOOP_P07_ENTRY_SOURCE', output); setP07ActiveCapture(capture); observeP07Native(root);
    expect(capture.observations[0].facts.artifact?.artifacts[0]).toMatchObject({ contentHash: hashP07Bytes(readFileSync(join(root, 'session.jsonl'))) });
    const file = publishP07EntryCapture(output, { runId: 'local' }, capture, { passed: false, assertions: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ passed: false, observations: [{ removed: false }] });
    expect(existsSync(root)).toBe(true);
  } finally { setP07ActiveCapture(undefined); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});
