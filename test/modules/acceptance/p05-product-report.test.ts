import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { reportDatabaseSnapshot } from '../../helpers/p03-10/report-fixture.ts';
import { validateP05ProductCapture, writeP05ProductCapture } from '../../../scripts/acceptance/p05-product-evidence.ts';

it('captures an actual Core/Host queued Feature report without runtime or model calls', async () => {
  const f = await openBudgetFixture(BUDGET);
  let host: Awaited<ReturnType<typeof openReportHost>> | undefined;
  try {
    await f.start();
    host = await openReportHost(f);
    const before = reportDatabaseSnapshot(f);
    const report = await host.client.getFeatureReport(f.projectId, f.featureId);
    expect(report).toEqual(await host.app.queryService.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId }));
    expect(reportDatabaseSnapshot(f)).toEqual(before);
    expect(report.runs.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(f.box.dataRoot);
    expect(JSON.stringify(report)).not.toContain(host.token);
    const identity = { runId: 'unit-product', commit: 'a'.repeat(40), inputsDigest: 'b'.repeat(64) };
    const envelope = { schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture', identity,
      projectId: f.projectId, featureId: f.featureId, report };
    expect(validateP05ProductCapture(envelope, identity).featureId).toBe(f.featureId);
    expect(() => validateP05ProductCapture(envelope, { ...identity, runId: 'other' })).toThrow('身份');
    expect(() => validateP05ProductCapture(envelope, { ...identity, commit: 'c'.repeat(40) })).toThrow('身份');
    expect(() => validateP05ProductCapture(envelope, { ...identity, inputsDigest: 'c'.repeat(64) })).toThrow('身份');
    expect(() => validateP05ProductCapture({ ...envelope, featureId: 'other' }, identity)).toThrow('无效');
    expect(() => validateP05ProductCapture({ ...envelope, report: {} }, identity)).toThrow('无效');
    const directory = process.env.SHIPLOOP_P05_PRODUCT_REPORT_DIR;
    const boundIdentity = process.env.SHIPLOOP_P05_REPORT_IDENTITY;
    if (directory || boundIdentity) {
      if (!directory || !boundIdentity) throw new Error('Product capture requires both directory and identity');
      const actualIdentity = JSON.parse(boundIdentity);
      writeP05ProductCapture(join(directory, 'feature-report.json'), { ...envelope, identity: actualIdentity }, actualIdentity);
    }
  } finally {
    await host?.close();
    await f.close();
  }
});
