import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { HASH, reportAttempt, reportSettlement, reportSecondRun, reportDatabaseSnapshot, reportVerification, reportOperation } from '../../helpers/p03-10/report-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import type { FeatureExecutionReport } from '../../../packages/core/src/application/feature-execution-report.ts';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const cliBin = resolve(root, 'packages/cli/dist/bin.js');
const fixtures: BudgetFixture[] = [];
const hosts: Awaited<ReturnType<typeof openReportHost>>[] = [];
beforeAll(async () => {
  const built = await exec('npm', ['run', 'build'], { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(built.stdout);
  process.stderr.write(built.stderr);
}, 65_000);
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.close();
});
async function fixture() {
  const f = await openBudgetFixture(BUDGET, [1, 2, 3].map(n => ({ id: `t-${n}`, title: `Task ${n}`,
    acceptance: { criteria: ['historical evidence'] }, dependsOn: [] })));
  fixtures.push(f);
  return f;
}
async function host(f: BudgetFixture, options?: Parameters<typeof openReportHost>[1]) {
  const h = await openReportHost(f, options);
  hosts.push(h);
  return h;
}
async function cli(f: BudgetFixture, args: string[]) {
  try {
    const result = await exec(process.execPath, [cliBin, ...args, '--data-root', f.box.dataRoot], {
      cwd: f.box.repoDirA, env: { PATH: process.env.PATH, HOME: f.box.homeDir },
      timeout: 15_000, maxBuffer: 20 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (typeof e.code !== 'number' || e.killed) throw error;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code };
  }
}

test('[case:built-report-parity] built CLI preserves complete Core history, evidence references, manual waiting and partial in JSON/text', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  const next = reportSecondRun(f, run);
  const first = reportAttempt(f, { id: randomUUID(), runId: run });
  const evidence = reportSettlement(f, first);
  for (let n = 2; n <= 130; n++) reportAttempt(f, { id: `a-${String(n).padStart(3, '0')}`, runId: next,
    number: n, session: false, status: n === 130 ? 'cancelled' : 'failed' });
  reportAttempt(f, { id: 'a-interrupted', runId: next, taskId: 't-3', status: 'interrupted', session: false });
  reportVerification(f, first, 'verify-final');
  reportOperation(f, next);
  for (let n = 0; n < 130; n++) f.session.database.prepare(`INSERT INTO task_approval_items (id, created_at, updated_at, project_id, feature_id, task_id,
    kind, description, responsible_party, plan_digest, artifact_refs, created_by)
    VALUES (?, ?, ?, ?, ?, 't-2', 'block', 'manual decision', 'owner', ?, '[]', 'owner')`)
    .run(`approval-${String(n).padStart(3, '0')}`, NOW, NOW, f.projectId, f.featureId, HASH);
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  const expected = await h.app.queryService.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  const args = ['feature', 'report', f.featureId, '--project', f.projectId];
  const json = await cli(f, [...args, '--json']);
  expect(json.exitCode, json.stderr).toBe(0);
  const envelope = JSON.parse(json.stdout);
  expect(envelope).toEqual({ ok: true, command: 'feature.report', result: expected });
  expect(envelope.result.tasks[0].attempts).toHaveLength(130);
  expect(envelope.result.tasks[0].cumulative.byStatus).toMatchObject({ failed: 129, cancelled: 1 });
  expect(envelope.result.axes.approval.items).toHaveLength(130);
  expect(envelope.result.axes.approval.itemsTruncated).toBe(false);
  expect(envelope.result.completeness).toBe('partial');
  expect(envelope.result.feature.status).not.toBe('completed');
  expect(envelope.result.tasks[1].current.status).not.toBe('passed');
  const text = await cli(f, args);
  expect(text.exitCode, text.stderr).toBe(0);
  expect(text.stdout).toContain('completeness=partial');
  expect(text.stdout).toContain('cache_unknown');
  expect(text.stdout).toContain('manual decision');
  expect(text.stdout).toContain(first.id);
  expect(text.stdout).toContain('a-130');
  const read = await cli(f, ['execution', 'session-evidence', first.id, '--project', f.projectId, '--artifact', evidence.artifactId, '--json']);
  expect(read.exitCode, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout).result.artifact.artifactId).toBe(evidence.artifactId);
  for (const out of [json, text, read]) {
    expect(out.stdout + out.stderr).not.toContain(f.box.dataRoot);
    expect(out.stdout + out.stderr).not.toContain(h.token);
  }
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:built-report-errors] built CLI emits structured authorization, version and size errors and leaves all state untouched', async () => {
  const f = await fixture();
  reportAttempt(f, { id: 'a-error', runId: (await f.start()).runId! });
  const good = await host(f);
  const report = await good.app.queryService.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  const denied = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: { kind: 'all' } });
  const variants = [
    { principal: denied, code: 'forbidden' },
    { value: { ...report, schemaVersion: 999 }, code: 'unsupported_schema_version' },
    { value: { ...report, issues: ['x'.repeat(16 * 1024 * 1024)] }, code: 'internal' },
    { value: { ...report, counts: { ...report.counts, attempts: 0 } }, code: 'response_malformed' },
  ];
  const before = reportDatabaseSnapshot(f);
  for (const variant of variants) {
    const h = await host(f, 'principal' in variant ? { principal: variant.principal } : {
      queries: q => ({ ...q, getFeatureReport: async () => variant.value as FeatureExecutionReport }),
    });
    const output = await cli(f, ['feature', 'report', f.featureId, '--project', f.projectId, '--json']);
    expect(output.exitCode).not.toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, command: 'feature.report', error: { code: variant.code } });
    expect(output.stdout + output.stderr).not.toContain(f.box.dataRoot);
    expect(output.stdout + output.stderr).not.toContain(h.token);
  }
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});
