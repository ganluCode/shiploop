/**
 * P03-10 / F-006 执行报告文本视图与人工操作提示（CLI 纯视图层）。
 *
 * 契约要点（来自 F-006 验收标准）：
 * - 文本视图从同一结构化报告投影生成完整且稳定排序的 Task 表与 Attempt 历史，
 *   区分最新状态、累计次数和各 Run；不追加历史报告内容；
 * - 单独列出最终检查、批准/阻塞原因、要求的交付状态、证据引用和下一步显式操作；
 *   未批准但机器全绿时显示等待，不显示已通过或建议绕过批准；
 * - unknown/partial、Fake 合成指标、累计 Session 时间与墙钟时间清晰标识；
 *   不生成真实模型分组收益、加权缓存率、余额或节省额度结论；
 * - 重复生成不重复行或计数；生成器为纯函数，不修改业务状态。
 */
import { afterEach, expect, test } from 'vitest';
import {
  HASH,
  reportAttempt,
  reportDatabaseSnapshot,
  reportOperation,
  reportQueries,
  reportSecondRun,
  reportSettlement,
  reportVerification,
} from '../../helpers/p03-10/report-fixture.ts';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import {
  buildFeatureReportTextView,
  formatFeatureReportTextView,
} from '../../../packages/cli/src/app/report.ts';
import type { FeatureExecutionReport } from '../../../packages/core/src/application/feature-execution-report.ts';

const fixtures: BudgetFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function fixture() {
  const f = await openBudgetFixture(BUDGET, [1, 2, 3].map((n) => ({
    id: `t-${n}`, title: `Task ${n}`, acceptance: { criteria: ['report text view'] }, dependsOn: [],
  })));
  fixtures.push(f);
  return f;
}
async function readReport(f: BudgetFixture): Promise<FeatureExecutionReport> {
  return await reportQueries(f).getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
}
function render(report: FeatureExecutionReport) {
  const view = buildFeatureReportTextView(report);
  return { view, text: formatFeatureReportTextView(view) };
}
function insertApprovalItem(f: BudgetFixture, options: {
  id: string; kind: 'block' | 'approval'; description: string; planDigest?: string;
}) {
  f.session.database.prepare(`INSERT INTO task_approval_items (id, created_at, updated_at, project_id, feature_id, task_id,
    kind, description, responsible_party, plan_digest, artifact_refs, created_by)
    VALUES (?, ?, ?, ?, ?, 't-1', ?, ?, 'owner', ?, '[]', 'owner')`)
    .run(options.id, NOW, NOW, f.projectId, f.featureId, options.kind, options.description,
      options.planDigest ?? HASH);
}
function taskPlanDigest(f: BudgetFixture): string {
  return f.session.database.prepare<[string], { plan_digest: string }>(
    'SELECT plan_digest FROM features WHERE id = ?').get(f.featureId)!.plan_digest;
}

test('[case:text-task-attempt-table] 三项以上 Task、失败后成功、取消与缺历史字段生成稳定 Task 表与 Attempt 历史', async () => {
  const f = await fixture();
  const run1 = (await f.start()).runId!;
  const run2 = reportSecondRun(f, run1);
  const first = reportAttempt(f, { id: 'a-fail', runId: run1, number: 1, status: 'failed' });
  reportSettlement(f, first);
  reportAttempt(f, { id: 'a-win', runId: run2, number: 2, status: 'succeeded', previousAttemptId: first.id });
  reportAttempt(f, { id: 'a-cancel', taskId: 't-2', runId: run1, status: 'cancelled', session: false });
  reportAttempt(f, { id: 'a-open', taskId: 't-3', runId: run2, status: 'interrupted', end: null });
  f.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-1'").run();
  reportVerification(f, first, 'verify-final');
  reportOperation(f, run2);
  const report = await readReport(f);
  const { view, text } = render(report);

  // Task 表：完整、稳定排序，区分最新状态与累计次数。
  expect(view.taskRows.map((row) => row.taskId)).toEqual(['t-1', 't-2', 't-3']);
  const t1 = view.taskRows[0]!;
  expect(t1.status).toBe('passed');
  expect(t1.latest).toMatchObject({ id: 'a-win', number: 2, status: 'succeeded' });
  expect(t1.cumulative.attempts).toBe(2);
  expect(t1.cumulative.reworks).toBe(1);
  expect(t1.cumulative.byStatus).toMatchObject({ failed: 1, succeeded: 1 });
  expect(t1.attemptIds).toEqual(['a-fail', 'a-win']);
  expect(view.taskRows[1]!.cumulative.byStatus.cancelled).toBe(1);

  // Attempt 历史：稳定排序 + 各 Run 归属 + 缺失历史字段显式 unknown。
  const lines = text.split('\n');
  const attemptLines = lines.filter((line) => line.startsWith('- #'));
  expect(attemptLines).toHaveLength(report.counts.attempts);
  const failLine = lines.findIndex((line) => line.startsWith('- #1 a-fail run=' + run1));
  const winLine = lines.findIndex((line) => line.startsWith('- #2 a-win run=' + run2));
  expect(failLine).toBeGreaterThanOrEqual(0);
  expect(failLine).toBeLessThan(winLine);
  expect(text).toContain('- #1 a-cancel');
  expect(text).toContain('status=cancelled');
  expect(text).toContain('exitCode=unknown');
  expect(text).toContain('usage basis=unknown inputTokens=unknown outputTokens=unknown costMicros=unknown');
  expect(view.attemptRows.find((a) => a.id === 'a-cancel')).toMatchObject({ completeness: 'partial' });

  // 各 Run 独立列示，计数不混并。
  expect(view.runRows.map((run) => run.id).sort()).toEqual([run1, run2].sort());
  expect(view.runRows.flatMap((run) => run.attemptIds).sort()).toEqual(['a-cancel', 'a-fail', 'a-open', 'a-win']);
  for (const run of view.runRows) {
    expect(text).toContain(`- run ${run.id} batch=${run.batchId} status=${run.status}`);
  }

  // 最终检查、证据引用段落独立成段。
  expect(text).toContain('## 最终检查');
  expect(text).toContain('verify-final');
  expect(text).toContain('check tests');
  expect(text).toContain('## 证据引用');
  expect(text).toContain(`- ${first.snapshot.artifactId} availability=ready`);
});

test('[case:text-approval-waiting] 未批准但机器全绿显示等待，不显示已通过或建议绕过批准', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  const done = reportAttempt(f, { id: 'a-done', runId: run, status: 'succeeded' });
  reportVerification(f, done, 'verify-final', 'FeatureVerification.full', 'passed');
  f.session.database.prepare("UPDATE tasks SET status = 'passed'").run();
  insertApprovalItem(f, { id: 'approval-1', kind: 'approval', description: 'manual decision', planDigest: taskPlanDigest(f) });
  const report = await readReport(f);
  expect(report.axes.tasks.allPassed).toBe(true);
  expect(report.axes.verification.status).toBe('passed');
  expect(report.axes.approval.status).toBe('pending');
  const { view, text } = render(report);

  // 机器全绿 + 未批准：显示等待，不判定通过。
  expect(view.approval.machineAllGreen).toBe(true);
  expect(view.approval.waiting).toBe(true);
  expect(view.approval.status).not.toBe('approved');
  expect(text).toContain('waiting=true');
  expect(text).toContain('保持等待');
  expect(text).not.toContain('已通过');
  expect(text).not.toContain('绕过');

  // 批准/阻塞原因、要求的交付状态、证据引用与下一步显式操作单独列出。
  expect(text).toContain('## 人工批准/阻塞');
  expect(text).toContain('reason=approval_pending');
  expect(text).toContain('manual decision');
  expect(text).toContain('## 要求的交付状态');
  expect(text).toContain(`requiredStatus=${report.feature.deliveryStatus}`);
  expect(text).toContain('## 证据引用');
  expect(text).toContain('## 下一步显式操作');
  expect(text).toContain(`nextStep=${report.outcome.nextStep}`);
  expect(view.nextActions.length).toBeGreaterThan(0);
  for (const action of view.nextActions) {
    expect(action.automatic).toBe(false);
    expect(text).toContain(`${action.action}：`);
    expect(text).toContain('automatic=false');
  }
  // 最终检查与人工批准分列；机器结果行不冒充批准。
  expect(text).toContain('## 最终检查');
  expect(text).toContain('机器结果不构成人工批准');
});

test('[case:text-metrics-timing] unknown/partial、Fake 合成指标、累计 Session 时间与墙钟时间清晰标识', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  const settled = reportAttempt(f, { id: 'a-fake', runId: run, number: 1, status: 'failed' });
  reportSettlement(f, settled);
  reportAttempt(f, { id: 'a-open', taskId: 't-2', runId: run, status: 'interrupted', end: null });
  const report = await readReport(f);
  const { view, text } = render(report);

  // Fake 合成指标与未知值明确标识，不以 0 冒充。
  expect(text).toContain('basis=fake-synthetic');
  expect(text).toContain('outputTokens=unknown');
  expect(text).toContain('cacheRead=unknown cacheWrite=unknown');
  expect(text).not.toContain('outputTokens=0');
  expect(view.attemptRows.find((a) => a.id === 'a-fake')?.usage.basis).toBe('fake-synthetic');

  // 累计 Session 时间与墙钟时间分列；边界缺失为 unknown。
  expect(text).toContain('cumulativeSessionMs=');
  expect(text).toContain('累计 Session 时间');
  expect(text).toContain('wallClockMs=unknown');
  expect(text).toContain('（墙钟时间');
  expect(text).toContain('timingCompleteness=partial');
  expect(view.timing.completeness).toBe('partial');

  // 不生成加权缓存率、收益、余额或节省额度结论。
  expect(text).toContain('不计算加权缓存率');
  expect(text).toContain('不生成真实模型分组收益、余额或节省额度结论');
  expect(text).not.toMatch(/缓存率[=＝]\s*\d/);
  expect(text).not.toMatch(/节省[=＝]\s*\d/);
  expect(text).not.toMatch(/余额[=＝]\s*\d/);

  // partial 与 issue 明确显示。
  expect(text).toContain('completeness=partial');
  expect(text).toContain('cache_unknown');
});

test('[case:text-repeat-read-only] 重复生成不重复行或计数，不追加旧报告内容，生成器不修改业务状态', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  reportAttempt(f, { id: 'a-fail', runId: run, number: 1, status: 'failed' });
  const win = reportAttempt(f, { id: 'a-win', runId: run, number: 2, status: 'succeeded', previousAttemptId: 'a-fail' });
  reportAttempt(f, { id: 'a-cancel', taskId: 't-2', runId: run, status: 'cancelled', session: false });
  void win;
  const report = await readReport(f);
  const before = reportDatabaseSnapshot(f);

  const rendered = render(report);
  const second = render(report);
  const third = render(report);
  expect(second.text).toBe(rendered.text);
  expect(third.text).toBe(rendered.text);
  const attemptLines = rendered.text.split('\n').filter((line) => line.startsWith('- #'));
  expect(attemptLines).toHaveLength(report.counts.attempts);
  expect(new Set(attemptLines).size).toBe(attemptLines.length);

  // 不直接追加旧报告内容：另一份报告的文本只含其自身身份。
  const other = await fixture();
  reportAttempt(other, { id: 'b-only', runId: (await other.start()).runId!, status: 'failed' });
  const otherText = render(await readReport(other)).text;
  expect(otherText).toContain('b-only');
  expect(otherText).not.toContain('a-fail');
  expect(otherText).not.toContain('a-win');
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});
