/**
 * P07-4 / F-003 结果诊断 HostClient 契约测试（真实 loopback Host + 真实临时
 * SQLite/Git 项目；不调用模型、不启动 Runtime）。
 *
 * 覆盖：
 * - loopback HostClient 与 Core 查询返回值逐字节一致（四类父级定位）、查询只读；
 * - 键集分页（不重复、不遗漏）与游标跨父级/跨项目重放拒绝；
 * - 未认证、跨项目、坏输入、owner 身份不回退、新增操作不扩大受限 Work 工具授权；
 * - missing/corrupt 证据细分 issue、稳定引用与 null 保持经 Host 不变形；
 * - 未知协议/响应版本、嵌套未知字段、归属漂移 fail-closed。
 */
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BUDGET, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import {
  reportArtifact,
  reportAttempt,
  reportDatabaseSnapshot,
  reportOperation,
  reportSecondRun,
  reportSettlement,
  reportVerification,
} from '../../helpers/p03-10/report-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { APP_OPERATIONS } from '../../../packages/host/src/contract/errors.ts';
import { APPLICATION_QUERY_CAPABILITIES } from '../../../packages/host/src/contract/lifecycle.ts';
import { WORK_TOOL_OPERATION_SPECS } from 'shiploop-core/protocol';
import type { ResultDiagnosticsListResult } from 'shiploop-core/protocol';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';

const fixtures: BudgetFixture[] = [];
const hosts: Awaited<ReturnType<typeof openReportHost>>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.close();
});
async function fixture(tasks = 3) {
  const f = await openBudgetFixture(BUDGET, Array.from({ length: tasks }, (_, n) => ({ id: `t-${n + 1}`, title: `Task ${n + 1}`,
    acceptance: { criteria: ['result diagnostics'] }, dependsOn: [] })));
  fixtures.push(f);
  return f;
}
async function host(f: BudgetFixture, options?: Parameters<typeof openReportHost>[1]) {
  const h = await openReportHost(f, options);
  hosts.push(h);
  return h;
}

test('[case:wire-core-parity] loopback HostClient 结果诊断与 Core 返回值一致（Batch/Run/Attempt/Session 四类父级）且查询只读', async () => {
  const f = await fixture();
  // 公开纵向入口经产品执行服务产生状态（execution.start 命令）。
  const started = await f.start();
  const run = started.runId!;
  const first = reportAttempt(f, { id: 'a-par-1', runId: run, status: 'failed' });
  reportSettlement(f, first);
  const second = reportAttempt(f, { id: 'a-par-2', runId: run, number: 2, status: 'succeeded', previousAttemptId: first.id });
  reportVerification(f, first, 'verify-par', 'FeatureVerification.full', 'passed');
  reportArtifact(f, 'code-par-2');
  f.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run('code-par-2', second.id);
  reportOperation(f, run);
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  const selectors = [
    { batchId: started.batchId },
    { runId: run },
    { attemptId: first.id },
    { workSessionId: first.sessionId as string },
  ];
  for (const selector of selectors) {
    const expected = await h.app.queryService.listResultDiagnostics(f.owner, { projectId: f.projectId, ...selector });
    const result = await h.client.listResultDiagnostics(f.projectId, selector);
    expect(result).toEqual(expected);
  }
  const runPage = await h.client.listResultDiagnostics(f.projectId, { runId: run });
  const row = runPage.records.find(record => record.attemptId === first.id)!;
  expect(row).toBeDefined();
  // 三轴分别来自持久事实：Runtime 失败 ≠ Task 验收 ≠ Feature 交付。
  expect(row.runtime.attemptStatus).toBe('failed');
  expect(row.task.verification).toMatchObject({ batchId: 'verify-par', status: 'passed' });
  expect(row.feature.deliveryStatus).toBe('not_requested');
  expect(row.resultEvidenceRef).toBe(`${first.id}-result`);
  expect(row.gitOperationRefs.map(op => op.operationId)).toContain('op-report');
  const secondRow = runPage.records.find(record => record.attemptId === second.id)!;
  expect(secondRow.codeRef).toBe('code-par-2');
  expect(secondRow.rework).toEqual({ previousAttemptId: first.id });
  expect(runPage.usage.countedObservations).toBeGreaterThan(0);
  expect(runPage.eventWatermark).toEqual(expect.any(Number));
  const text = JSON.stringify(runPage);
  expect(text).not.toContain(f.box.dataRoot);
  expect(text).not.toContain(h.token);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:wire-pagination] 键集分页不重复不遗漏；游标跨父级/跨项目重放拒绝', async () => {
  const f = await fixture();
  const started = await f.start();
  const run = reportSecondRun(f, started.runId!);
  for (let n = 1; n <= 130; n++) {
    reportAttempt(f, { id: `a-pg-${String(n).padStart(3, '0')}`, number: n, runId: run, session: n <= 3, status: 'failed' });
  }
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: ResultDiagnosticsListResult = await h.client.listResultDiagnostics(f.projectId, { runId: run, limit: 50, ...(cursor === null ? {} : { cursor }) });
    expect(page.records.length).toBeLessThanOrEqual(50);
    seen.push(...page.records.map(record => record.attemptId));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < 10);
  expect(pages).toBe(3);
  expect(seen).toHaveLength(130);
  expect(new Set(seen).size).toBe(130);
  expect(seen[0]).toBe('a-pg-001');
  expect(seen[129]).toBe('a-pg-130');
  const firstPage = await h.client.listResultDiagnostics(f.projectId, { runId: run, limit: 50 });
  const cursorRefusal = { code: 'invalid_input', details: { field: 'cursor', reason: 'invalid_cursor' } };
  await expect(h.client.listResultDiagnostics(f.projectId, { batchId: started.batchId, cursor: firstPage.nextCursor as string }))
    .rejects.toMatchObject(cursorRefusal);
  await expect(h.client.listResultDiagnostics(f.projectId, { runId: run, cursor: 'plcur_v1_forged' }))
    .rejects.toMatchObject(cursorRefusal);
  await expect(h.client.listResultDiagnostics(randomUUID(), { runId: run, cursor: firstPage.nextCursor as string }))
    .rejects.toMatchObject(cursorRefusal);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:wire-auth-boundaries] 未认证/跨项目/坏输入/owner 不回退/不扩大受限 Work 工具授权', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  reportAttempt(f, { id: 'a-auth-p7', runId: run, status: 'failed' });
  const restricted = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [f.projectId] } });
  const h = await host(f, { principal: restricted });
  const before = reportDatabaseSnapshot(f);
  await expect(h.client.listResultDiagnostics(randomUUID(), { runId: run })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(h.app.queryService.listResultDiagnostics(f.owner, { projectId: randomUUID(), runId: run }))
    .rejects.toMatchObject({ code: 'not_found' });
  await expect(h.client.listResultDiagnostics(f.projectId, { runId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
  const noRead = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: { kind: 'all' } });
  await expect(h.app.queryService.listResultDiagnostics(noRead, { projectId: f.projectId, runId: run }))
    .rejects.toMatchObject({ code: 'forbidden' });
  // owner 身份不回退：装配主体非法即 internal，不静默降级为 owner。
  const invalidIdentityHost = await host(f, { principal: {} as BudgetFixture['owner'] });
  await expect(invalidIdentityHost.client.listResultDiagnostics(f.projectId, { runId: run }))
    .rejects.toMatchObject({ code: 'internal' });
  // 坏输入经真实路由拒绝（恰一父级、合法整数、白名单参数；坏输入用有效令牌
  // 才能观察 400，未认证单独断言 401）。
  for (const [suffix, status] of [
    ['', 400],
    [`&runId=${run}&batchId=${randomUUID()}`, 400],
    [`&runId=${run}&limit=abc`, 400],
    [`&runId=${run}&path=%2Fetc%2Fpasswd`, 400],
    [`&runId=${run}&principal=owner`, 400],
    ['&runId=..%2Fsecret', 400],
    [`&runId=${run}`, 200],
  ] as const) {
    const response = await loopbackRequest({ method: 'GET', port: h.port,
      path: `/v1/result-diagnostics?projectId=${f.projectId}${suffix}`,
      headers: { authorization: `Bearer ${h.token}` } });
    expect(response.statusCode, suffix).toBe(status);
    expect(response.bodyText).not.toContain(h.token);
    expect(response.bodyText).not.toContain(f.box.dataRoot);
  }
  // 未认证：无效令牌 401；Work 工具令牌只属于受限工具面，不被查询面接受。
  const unauthenticated = await loopbackRequest({ method: 'GET', port: h.port,
    path: `/v1/result-diagnostics?projectId=${f.projectId}&runId=${run}`,
    headers: { authorization: 'Bearer invalid-token' } });
  expect(unauthenticated.statusCode).toBe(401);
  const workToolToken = await loopbackRequest({ method: 'GET', port: h.port,
    path: `/v1/result-diagnostics?projectId=${f.projectId}&runId=${run}`,
    headers: { authorization: `Bearer ${'ab'.repeat(32)}` } });
  expect(workToolToken.statusCode).toBe(401);
  // 新增操作不自动扩大受限 Work 工具授权面。
  expect(Object.keys(WORK_TOOL_OPERATION_SPECS)).not.toContain('execution.result.diagnostics.list');
  expect(APP_OPERATIONS).toContain('execution.result.diagnostics.list');
  expect(APPLICATION_QUERY_CAPABILITIES).toContain('execution.result.diagnostics.list');
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:wire-missing-corrupt] missing/corrupt 证据细分 issue、稳定引用与 null 保持经 Host 不变形', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  const intact = reportAttempt(f, { id: 'a-ok-p7', runId: run, status: 'succeeded' });
  const settled = reportSettlement(f, intact);
  const lost = reportAttempt(f, { id: 'a-lost-p7', runId: run, number: 2, status: 'succeeded' });
  const lostRef = reportSettlement(f, lost);
  const h = await host(f);
  const baseline = await h.client.listResultDiagnostics(f.projectId, { runId: run });
  const okRow = baseline.records.find(row => row.attemptId === intact.id)!;
  expect(okRow.resultEvidenceRef).toBe(settled.artifactId);
  expect(okRow.issues.filter(issue => issue.startsWith('result_evidence_'))).toEqual([]);
  // 正文删除 → body_missing；篡改（同长度）→ body_corrupt；细分原因稳定引用。
  const path = join(f.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId: lostRef.artifactId }));
  writeFileSync(path, 'x'.repeat(lostRef.sizeBytes));
  const corrupt = await h.client.listResultDiagnostics(f.projectId, { runId: run });
  const corruptRow = corrupt.records.find(row => row.attemptId === lost.id)!;
  expect(corruptRow.issues).toContain('result_evidence_body_corrupt');
  expect(corruptRow.resultEvidenceRef).toBe(lostRef.artifactId);
  expect(corruptRow.usage.inputTokens).toBeNull();
  // 正文损坏不伪造结果：resultKnown=false；attempt 行持久 exit 保持原值不回退 null。
  expect(corruptRow.runtime.resultKnown).toBe(false);
  expect(corruptRow.runtime.exitCode).toBe(1);
  unlinkSync(path);
  const missing = await h.client.listResultDiagnostics(f.projectId, { runId: run });
  const missingRow = missing.records.find(row => row.attemptId === lost.id)!;
  expect(missingRow.issues).toContain('result_evidence_body_missing');
  expect(missingRow.resultEvidenceRef).toBe(lostRef.artifactId);
  // Session 行缺失显式为 session_missing，不伪造 Session。
  f.session.database.prepare('DELETE FROM sessions WHERE id = ?').run(intact.sessionId);
  const sessionless = await h.client.listResultDiagnostics(f.projectId, { runId: run });
  const sessionlessRow = sessionless.records.find(row => row.attemptId === intact.id)!;
  expect(sessionlessRow.issues).toContain('session_missing');
  expect(sessionlessRow.runtime.sessionStatus).toBeNull();
  expect(JSON.stringify(sessionless)).not.toContain(f.box.dataRoot);
  // 与 Core 一致：同一事实两条链路不漂移。
  expect(sessionless).toEqual(await h.app.queryService.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run }));
});

test('[case:wire-protocol-refusal] 未知协议/响应版本、嵌套未知字段与归属漂移 fail-closed', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  const attempt = reportAttempt(f, { id: 'a-proto-p7', runId: run, status: 'failed' });
  reportSettlement(f, attempt);
  const h = await host(f);
  const original = await h.client.listResultDiagnostics(f.projectId, { runId: run });
  const mutations: ((value: ResultDiagnosticsListResult) => void)[] = [
    value => { (value as unknown as Record<string, unknown>).unexpected = true; },
    value => { (value.records[0] as unknown as Record<string, unknown>).nativePath = '/private'; },
    value => { (value.records[0].usage as unknown as Record<string, unknown>).inputTokens = -1; },
    value => { (value.records[0].runtime as unknown as Record<string, unknown>).exitCode = 'zero'; },
    value => { (value.records[0].pendingActions as unknown as string[]).push('ship_everything'); },
    value => { (value as unknown as Record<string, unknown>).limit = 0; },
    value => { (value.records[0] as unknown as Record<string, unknown>).number = 0; },
    value => { delete (value.records[0] as unknown as Record<string, unknown>).runtime; },
    value => { (value.parentFacts as unknown as Record<string, unknown>).batchId = randomUUID(); },
    value => { (value as unknown as Record<string, unknown>).nextCursor = 'not-a-cursor'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    expect(() => validateAppQueryResponse('execution.result.diagnostics.list', value))
      .toThrowError(expect.objectContaining({ code: 'response_malformed' }));
  }
  expect(() => validateAppQueryResponse('execution.result.diagnostics.list', { ...original, schemaVersion: 999 }))
    .toThrowError(expect.objectContaining({ code: 'unsupported_schema_version' }));
  // 归属漂移：wire 层先拒绝 parent/parentFacts/行不一致（fail-closed）。
  const wrongParent = structuredClone(original);
  (wrongParent.parent as unknown as Record<string, unknown>).runId = randomUUID();
  const scoped = await host(f, { queries: q => ({ ...q, listResultDiagnostics: async () => wrongParent }) });
  await expect(scoped.client.listResultDiagnostics(f.projectId, { runId: run }))
    .rejects.toMatchObject({ code: 'response_malformed', details: { reason: 'result_diagnostics_scope_mismatch' } });
  // 响应内部自洽但整体指向另一 Run：wire 通过，客户端归属复核拒绝 scope_mismatch。
  const otherRun = randomUUID();
  const drifting = structuredClone(original);
  (drifting.parent as unknown as Record<string, unknown>).runId = otherRun;
  (drifting.parentFacts as unknown as Record<string, unknown>).runId = otherRun;
  for (const row of drifting.records) (row as unknown as Record<string, unknown>).runId = otherRun;
  const driftHost = await host(f, { queries: q => ({ ...q, listResultDiagnostics: async () => drifting }) });
  await expect(driftHost.client.listResultDiagnostics(f.projectId, { runId: run }))
    .rejects.toMatchObject({ code: 'response_malformed', details: { reason: 'scope_mismatch' } });
  const wrongVersionHost = await host(f, {
    queries: q => ({ ...q, listResultDiagnostics: async () => ({ ...original, schemaVersion: 999 }) as unknown as ResultDiagnosticsListResult }),
  });
  await expect(wrongVersionHost.client.listResultDiagnostics(f.projectId, { runId: run }))
    .rejects.toMatchObject({ code: 'unsupported_schema_version' });
  const oversized = await host(f, {
    queries: q => ({ ...q, listResultDiagnostics: async () => ({ ...original, issues: ['x'.repeat(16 * 1024 * 1024)] }) as unknown as ResultDiagnosticsListResult }),
  });
  await expect(oversized.client.listResultDiagnostics(f.projectId, { runId: run }))
    .rejects.toMatchObject({ code: 'internal', details: { reason: 'response_budget_exceeded' } });
});

test('[case:wire-query-entry] 结果诊断查询入口：Host 路由与 Core 操作同源', () => {
  expect(resolveAppRoute('/v1/result-diagnostics')).toEqual({ operation: 'execution.result.diagnostics.list', method: 'GET' });
  expect(resolveAppRoute('/v1/result-diagnostics/nested')).toBeUndefined();
  expect(resolveAppRoute('/v1/result-diagnostics/')).toBeUndefined();
});
