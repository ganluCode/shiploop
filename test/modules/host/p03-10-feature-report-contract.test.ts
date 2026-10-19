import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { reportAttempt, reportSettlement, reportSecondRun, reportDatabaseSnapshot, reportArtifact, reportVerification, reportOperation, HASH } from '../../helpers/p03-10/report-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import type { FeatureExecutionReport } from '../../../packages/core/src/application/feature-execution-report.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';


const fixtures: BudgetFixture[] = [];
const hosts: Awaited<ReturnType<typeof openReportHost>>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.close();
});
async function fixture() {
  const f = await openBudgetFixture(BUDGET, [1, 2, 3].map(n => ({ id: `t-${n}`, title: `Task ${n}`,
    acceptance: { criteria: ['report visibility'] }, dependsOn: [] })));
  fixtures.push(f);
  return f;
}
async function host(f: BudgetFixture, options?: Parameters<typeof openReportHost>[1]) {
  const h = await openReportHost(f, options);
  hosts.push(h);
  return h;
}

test('[case:complete-history-wire] HostClient returns every page, failure/cancel/approval history and verified evidence without writes', async () => {
  const f = await fixture();
  const runId = (await f.start()).runId!;
  const next = reportSecondRun(f, runId);
  const first = reportAttempt(f, { id: 'a-001', runId });
  const ref = reportSettlement(f, first);
  for (let n = 2; n <= 130; n++) reportAttempt(f, { id: `a-${String(n).padStart(3, '0')}`,
    number: n, runId: next, session: false, status: n === 130 ? 'cancelled' : 'failed', previousAttemptId: n === 2 ? first.id : undefined });
  reportVerification(f, first, 'verify-final');
  reportOperation(f, next);
  f.session.database.prepare(`INSERT INTO task_approval_items (id, created_at, updated_at, project_id, feature_id, task_id,
    kind, description, responsible_party, plan_digest, artifact_refs, created_by)
    VALUES ('human-wait', ?, ?, ?, ?, 't-2', 'block', 'owner decision required', 'owner', ?, '[]', 'owner')`)
    .run(NOW, NOW, f.projectId, f.featureId, HASH);
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  const expected = await h.app.queryService.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  const report = await h.client.getFeatureReport(f.projectId, f.featureId);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeGreaterThan(65_536);
  expect(report).toEqual(expected);
  expect(report.tasks[0].attempts).toHaveLength(130);
  expect(report.tasks[0].cumulative.byStatus).toMatchObject({ failed: 129, cancelled: 1 });
  expect(report.axes.approval.items[0].id).toBe('human-wait');
  expect(report.completeness).toBe('partial');
  expect(report.tasks[0].attempts[0].evidence.some(e => e.artifactId === ref.artifactId)).toBe(true);
  const body = await h.client.readWorkSessionEvidence(f.projectId, first.id, ref.artifactId);
  expect(JSON.parse(body.content.toString()).kind).toBe('runtime-settlement');
  expect(JSON.stringify(report)).not.toContain(f.box.dataRoot);
  expect(JSON.stringify(report)).not.toContain(h.token);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:report-auth-boundaries] Core and Host reject cross-project, invalid identity, injected principal and out-of-scope evidence', async () => {
  const f = await fixture();
  const a = reportAttempt(f, { id: 'a-auth', runId: (await f.start()).runId! });
  const foreign = reportArtifact(f, 'outside', 'sessions/someone-else/private.json', { private: true });
  const restricted = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [f.projectId] } });
  const h = await host(f, { principal: restricted });
  const q = h.app.queryService;
  const input = { projectId: f.projectId, featureId: f.featureId };
  const before = reportDatabaseSnapshot(f);
  await expect(q.getFeatureReport({}, input)).rejects.toThrow(TypeError);
  const invalidIdentityHost = await host(f, { principal: {} as BudgetFixture['owner'] });
  await expect(invalidIdentityHost.client.getFeatureReport(f.projectId, f.featureId)).rejects.toMatchObject({ code: 'internal' });
  const noRead = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: { kind: 'all' } });
  await expect(q.getFeatureReport(noRead, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(h.client.getFeatureReport(randomUUID(), f.featureId)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(q.getFeatureReport(f.owner, { projectId: randomUUID(), featureId: f.featureId })).rejects.toMatchObject({ code: 'not_found' });
  await expect(h.client.getFeatureReport(f.projectId, 'missing')).rejects.toMatchObject({ code: 'not_found' });
  await expect(h.client.getFeatureReport(f.projectId, '../secret')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(h.client.readWorkSessionEvidence(f.projectId, a.id, foreign.artifactId)).rejects.toMatchObject({ code: 'not_found' });
  await expect(q.readWorkSessionEvidence(restricted, { projectId: f.projectId, attemptId: a.id, artifactId: foreign.artifactId })).rejects.toMatchObject({ code: 'not_found' });
  for (const [suffix, token, status] of [
    ['', 'invalid-token', 401], ['&principal=owner', h.token, 400], ['&path=%2Fetc%2Fpasswd', h.token, 400],
    ['', h.token, 200],
  ] as const) {
    const response = await loopbackRequest({ method: 'GET', port: h.port, path: `/v1/features/${f.featureId}/report?projectId=${f.projectId}${suffix}`,
      headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(status);
    if (status !== 200) expect(response.json()).toHaveProperty('error.code');
    expect(response.bodyText).not.toContain(h.token);
    expect(response.bodyText).not.toContain(f.box.dataRoot);
  }
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:report-snapshot-http] status changes while reading verified content cannot mix report snapshots', async () => {
  const f = await fixture();
  const a = reportAttempt(f, { id: 'a-snapshot', runId: (await f.start()).runId! });
  reportSettlement(f, a);
  let changed = false;
  const h = await host(f, { queries: q => ({ ...q, getFeatureReport(principal, input) {
    const pending = q.getFeatureReport(principal, input);
    if (!changed) {
      changed = true;
      f.session.database.prepare("UPDATE attempts SET status = 'cancelled' WHERE id = ?").run(a.id);
      f.session.database.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 't-1'").run();
    }
    return pending;
  } }) });
  const captured = await h.client.getFeatureReport(f.projectId, f.featureId);
  expect(captured.tasks[0].attempts[0].status).toBe('failed');
  expect(captured.tasks[0].current.status).not.toBe('cancelled');
  const next = await h.client.getFeatureReport(f.projectId, f.featureId);
  expect(next.tasks[0].attempts[0].status).toBe('cancelled');
  expect(next.tasks[0].current.status).toBe('cancelled');
  expect(captured.completeness).toBe('partial');
  expect(captured.consistency.mode).toBe('single-read-transaction');
});

test('[case:report-missing-history] missing historical Session and Artifact remain explicit partial data', async () => {
  const f = await fixture();
  const a = reportAttempt(f, { id: 'a-missing', runId: (await f.start()).runId! });
  f.session.database.prepare('DELETE FROM sessions WHERE id = ?').run(a.sessionId);
  const missingArtifactId = `${a.id}-manifest`;
  f.session.database.prepare('DELETE FROM artifacts WHERE id = ?').run(missingArtifactId);
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  const expected = await h.app.queryService.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  const report = await h.client.getFeatureReport(f.projectId, f.featureId);
  expect(report).toEqual(expected);
  expect(report.completeness).toBe('partial');
  expect(report.tasks[0].attempts[0].issues).toContain('session_missing');
  expect(report.tasks[0].attempts[0].evidence).toContainEqual({ artifactId: missingArtifactId, artifact: null, availability: 'missing' });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:report-protocol-refusal] response versions, nested unknown fields, inconsistent history and oversize replies fail closed', async () => {
  const f = await fixture();
  const a = reportAttempt(f, { id: 'a-protocol', runId: (await f.start()).runId! });
  reportVerification(f, a, 'verify-final');
  const h = await host(f);
  const original = await h.client.getFeatureReport(f.projectId, f.featureId);
  const mutations: ((report: FeatureExecutionReport) => void)[] = [
    r => { (r as any).unexpected = true; },
    r => { (r.tasks[0].attempts[0] as any).nativePath = '/private'; },
    r => { (r.tasks[0].attempts[0].usage as any).inputTokens = -1; },
    r => { (r.counts as any).attempts = 0; },
    r => { (r.timing as any).cumulativeSessionMs = 0; },
    r => { (r.tasks[0].attempts[0] as any).taskId = 'another-task'; },
    r => { (r as any).completeness = 'complete'; },
    r => { (r.sessions[0] as any).parentSessionId = 'missing'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    expect(() => validateAppQueryResponse('features.report.get', value)).toThrowError(expect.objectContaining({ code: 'response_malformed' }));
  }
  expect(() => validateAppQueryResponse('features.report.get', { ...original, schemaVersion: 999 }))
    .toThrowError(expect.objectContaining({ code: 'unsupported_schema_version' }));
  const foreignProject = randomUUID();
  const wrongScope = structuredClone(original);
  for (const task of wrongScope.tasks) {
    for (const attempt of task.attempts) (attempt as any).projectId = foreignProject;
    if (task.latestAttempt !== null) (task.latestAttempt as any).projectId = foreignProject;
  }
  const scoped = await host(f, { queries: q => ({ ...q, getFeatureReport: async () => wrongScope }) });
  await expect(scoped.client.getFeatureReport(f.projectId, f.featureId)).rejects.toMatchObject({ code: 'response_malformed', details: { reason: 'scope_mismatch' } });
  const wrongVerification = { ...original, verifications: original.verifications.map(v => ({ ...v, projectId: foreignProject })) };
  const verificationHost = await host(f, { queries: q => ({ ...q, getFeatureReport: async () => wrongVerification }) });
  await expect(verificationHost.client.getFeatureReport(f.projectId, f.featureId)).rejects.toMatchObject({ code: 'response_malformed', details: { reason: 'scope_mismatch' } });
  const malformed = await host(f, { queries: q => ({ ...q, getFeatureReport: async () => ({ ...original, schemaVersion: 999 } as unknown as FeatureExecutionReport) }) });
  await expect(malformed.client.getFeatureReport(f.projectId, f.featureId)).rejects.toMatchObject({ code: 'unsupported_schema_version' });
  const oversized = await host(f, { queries: q => ({ ...q, getFeatureReport: async () => ({ ...original, issues: ['x'.repeat(16 * 1024 * 1024)] }) }) });
  await expect(oversized.client.getFeatureReport(f.projectId, f.featureId)).rejects.toMatchObject({ code: 'internal', details: { reason: 'response_budget_exceeded' } });
});


test('[case:report-query-entry] complete reports use the existing authenticated Feature query and CLI parser', () => {
  const projectId = 'e205effe-b062-4592-962d-88ed7a0cb267';
  expect(resolveAppRoute('/v1/features/feature-1/report')).toEqual({
    operation: 'features.report.get', method: 'GET', pathParam: { name: 'featureId', value: 'feature-1' },
  });
  expect(parseAppCliArgs(['feature', 'report', 'feature-1', '--project', projectId, '--json'])).toMatchObject({
    commandId: 'feature.report', featureId: 'feature-1', projectId, json: true,
  });
});
