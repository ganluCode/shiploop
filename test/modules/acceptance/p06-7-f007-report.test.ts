import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTodoBrownfieldFixture } from '../../helpers/p06-7/todo-fixture.ts';
import { collectP06Scenario, hashP06Input } from '../../../scripts/acceptance/p06-evidence.ts';
import { P06_FROZEN_ITEMS } from '../../../scripts/acceptance/p06-config.ts';
import { writeP06AcceptanceReport, verifyP06ReportDirectory, type P06ReportInput } from '../../../scripts/acceptance/p06-report.ts';

it('[case:real-scene-report] retains a verified real Todo scene and blocks missing scenarios, product and independent gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p06-f007-'));
  const fixture = createTodoBrownfieldFixture({ stepMs: 100 });
  try {
    const material = { purpose: 'report-regression', phaseAccepted: false };
    const identity = { runId: 'real-scene', testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), inputDigest: hashP06Input(material) };
    const command = await fixture.runCheck('ok');
    const record = await collectP06Scenario({ directory: join(root, 'source'), identity, scenarioId: 'I01', attempt: 1, input: material,
      command: { argv: command.argv, exitCode: command.exitCode, signal: command.signal, timedOut: command.timedOut, cancelled: false },
      outcome: 'success', sideEffects: { dirty: fixture.compareDirtyBaseline() }, tools: { node: process.versions.node }, usageSource: 'command-output',
      sensitiveValues: [process.execPath, process.cwd(), fixture.sensitiveSentinelValue, fixture.bearerSentinelValue],
      resources: { root: fixture.root, sqlitePath: fixture.sqlitePath, repositoryPath: fixture.todoRepositoryPath,
        files: ['todo/inbox.txt'], processFacts: () => fixture.processFacts(), cleanup: () => fixture.cleanup() } });
    expect(record.status).toBe('pass');
    const input: P06ReportInput = { identity, toolchain: { node: process.versions.node, npm: '10.9.3' }, scenarios: [record], products: [], knownGaps: [],
      checks: P06_FROZEN_ITEMS.filter(i => i.group !== 'deferred').map(i => ({ checkId: i.id, executionMode: i.execution === 'offline' ? 'fake' : i.execution, status: i.execution === 'offline' ? 'pass' : 'not_run' })) };
    const result = writeP06AcceptanceReport({ reportRoot: join(root, 'reports'), sourceDirectory: join(root, 'source'), input });
    expect(result.exitCode).toBe(1);
    expect(result.verification.ok).toBe(true);
    expect(result.report?.checks.find(c => c.checkId.includes('I01'))?.status).toBe('pass');
    expect(result.report?.counts).toEqual({ pass: 1, fail: 0, not_run: 11 });
    expect(result.report?.blockingIssues).toContain('missing_product_report');
    expect(verifyP06ReportDirectory(result.directory, identity).ok).toBe(true);
    expect(() => writeP06AcceptanceReport({ reportRoot: join(root, 'reports'), sourceDirectory: join(root, 'source'), input })).toThrow();
    const summaryPath = join(result.directory, 'summary.md');
    const summary = readFileSync(summaryPath, 'utf8');
    writeFileSync(summaryPath, `${summary}tampered\n`);
    expect(verifyP06ReportDirectory(result.directory, identity).ok).toBe(false);
    writeFileSync(summaryPath, summary);
    expect(verifyP06ReportDirectory(result.directory, identity).ok).toBe(true);
    rmSync(join(root, 'source'), { recursive: true });
    expect(verifyP06ReportDirectory(result.directory, identity).ok).toBe(true);
  } finally { await fixture.dispose(); rmSync(root, { recursive: true, force: true }); }
});

it('[case:real-product-report] accepts an actual queued Core/Host product report only when its run identity matches', async () => {
  const f = await openBudgetFixture(BUDGET);
  let host: Awaited<ReturnType<typeof openReportHost>> | undefined;
  const root = mkdtempSync(join(tmpdir(), 'p06-f007-product-'));
  try {
    await f.start();
    host = await openReportHost(f);
    const material = { purpose: 'product-report', phaseAccepted: false };
    const identity = { runId: 'real-product', testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), inputDigest: hashP06Input(material) };
    const report = await host.client.getFeatureReport(f.projectId, f.featureId);
    const envelope = { schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture', identity: {
      runId: identity.runId, commit: identity.testedCommit, inputsDigest: identity.inputDigest,
    }, projectId: f.projectId, featureId: f.featureId, report };
    const source = join(root, 'source');
    mkdirSync(join(source, 'products'), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, 'products/feature.json'), `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const checks = P06_FROZEN_ITEMS.filter(i => i.group !== 'deferred').map(i => ({
      checkId: i.id, status: 'not_run' as const, executionMode: i.execution === 'offline' ? 'fake' as const : i.execution as 'live' | 'manual', reason: 'scene_not_run',
    }));
    const result = writeP06AcceptanceReport({ reportRoot: join(root, 'reports'), sourceDirectory: source,
      input: { identity, toolchain: { node: process.versions.node, npm: '10.9.3' }, scenarios: [], products: [{ path: 'products/feature.json' }], checks, knownGaps: [] } });
    expect(result.verification.ok).toBe(true);
    expect(result.report?.productReports).toHaveLength(1);
    expect(result.report?.blockingIssues).toContain('P06-FR1-OFFLINE-CLOSURE:missing_scenarios:I01,I02,I03,I04,I05,I06,FR-1');
    expect(result.report?.conclusion).toBe('fail');
    expect(verifyP06ReportDirectory(result.directory, identity).ok).toBe(true);
  } finally {
    await host?.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
