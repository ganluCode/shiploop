/**
 * P07-4 / F-003 构建产物冒烟：真实 Host 查询验证结果诊断接线（dist/bin.js +
 * 真实 loopback Host + 真实临时 SQLite/Git 项目；不调用模型、不启动 Runtime）。
 *
 * 覆盖：
 * - 公开纵向正常路径状态经产品执行服务（execution.start 命令）产生；查询覆盖
 *   补充行由 report-fixture 登记（查询内容/负例夹具，不冒充公开入口）；
 * - 构建 CLI 从 Batch/Run 定位 Attempt、检查、代码、记录引用与交付结果，
 *   JSON 信封保留 null/缺口/三轴，文本展示停止原因与需授权用户处理的动作；
 * - 继续读取下一页（--cursor）与指定证据（execution session-evidence）；
 * - JSON stdout 仅含结构化结果，退出码沿用现有码表，输出不泄露数据根、
 *   凭据、原生定位路径或非公开错误正文；查询前后业务行不变。
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { BUDGET, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import {
  reportAttempt,
  reportDatabaseSnapshot,
  reportOperation,
  reportSettlement,
  reportVerification,
} from '../../helpers/p03-10/report-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';

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
    acceptance: { criteria: ['result diagnostics'] }, dependsOn: [] })));
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

test('[case:built-result-parity] 构建 CLI 经真实 Host 查询结果诊断：JSON 保留三轴/null/缺口，文本展示停止原因与动作', async () => {
  const f = await fixture();
  // 公开纵向状态：产品执行服务产生（execution.start 命令）。
  const started = await f.start();
  const run = started.runId!;
  // 查询内容/负例夹具（不冒充公开入口）：失败 Attempt、检查、代码、记录与停止事实。
  const failed = reportAttempt(f, { id: randomUUID(), runId: run, status: 'failed' });
  const evidence = reportSettlement(f, failed);
  reportVerification(f, failed, 'verify-built', 'FeatureVerification.full', 'passed');
  reportOperation(f, run);
  f.session.database.prepare(`UPDATE runs SET reason = 'user_cancel' WHERE id = ?`).run(run);
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  const expected = await h.app.queryService.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run });
  const base = ['execution', 'result-diagnostics', '--project', f.projectId, '--run', run];
  const json = await cli(f, [...base, '--json']);
  expect(json.exitCode, json.stderr).toBe(0);
  const envelope = JSON.parse(json.stdout);
  expect(envelope).toEqual({ ok: true, command: 'execution.result-diagnostics', result: expected });
  expect(envelope.result.parent).toEqual({ kind: 'run', runId: run });
  expect(envelope.result.records.map((row: { attemptId: string }) => row.attemptId)).toContain(failed.id);
  const row = envelope.result.records.find((item: { attemptId: string }) => item.attemptId === failed.id);
  // JSON 保留 null、缺口和各结果轴。
  expect(row.runtime.attemptStatus).toBe('failed');
  expect(row.task.verification).toMatchObject({ batchId: 'verify-built', status: 'passed' });
  expect(row.feature.deliveryStatus).toBe('not_requested');
  expect(row.resultEvidenceRef).toBe(evidence.artifactId);
  expect(row.usage.outputTokens).toBeNull();
  expect(Array.isArray(row.blockReasons)).toBe(true);
  expect(Array.isArray(row.issues)).toBe(true);
  // 文本清楚展示停止原因和需授权用户处理的动作。
  const text = await cli(f, base);
  expect(text.exitCode, text.stderr).toBe(0);
  expect(text.stdout).toContain('run:user_cancel');
  expect(text.stdout).toContain('actions=');
  expect(text.stdout).toContain('rework_task');
  expect(text.stdout).toContain('runtime: status=failed');
  expect(text.stdout).toContain('task: status=');
  expect(text.stdout).toContain('feature: status=');
  expect(text.stdout).toContain('verify-built');
  // Batch 父级定位与继续读取下一页。
  const batch = await cli(f, ['execution', 'result-diagnostics', '--project', f.projectId,
    '--batch', started.batchId, '--limit', '1', '--json']);
  expect(batch.exitCode, batch.stderr).toBe(0);
  const batchPage = JSON.parse(batch.stdout).result;
  expect(batchPage.parent).toEqual({ kind: 'batch', batchId: started.batchId });
  expect(batchPage.records).toHaveLength(1);
  if (batchPage.nextCursor !== null) {
    const next = await cli(f, ['execution', 'result-diagnostics', '--project', f.projectId,
      '--batch', started.batchId, '--limit', '1', '--cursor', batchPage.nextCursor, '--json']);
    expect(next.exitCode, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout).result.records[0].attemptId).not.toBe(batchPage.records[0].attemptId);
  }
  // 指定证据继续读取（复用既有 session-evidence 公共契约）。
  const read = await cli(f, ['execution', 'session-evidence', failed.id, '--project', f.projectId,
    '--artifact', evidence.artifactId, '--json']);
  expect(read.exitCode, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout).result.artifact.artifactId).toBe(evidence.artifactId);
  for (const out of [json, text, batch, read]) {
    expect(out.stdout + out.stderr).not.toContain(f.box.dataRoot);
    expect(out.stdout + out.stderr).not.toContain(h.token);
    expect(out.stdout + out.stderr).not.toContain('runtime-settlement.json');
  }
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:built-result-errors] 构建 CLI 结构化错误与退出码沿用现有码表，且不泄露敏感信息', async () => {
  const f = await fixture();
  const run = (await f.start()).runId!;
  reportAttempt(f, { id: 'a-built-err', runId: run, status: 'failed' });
  const h = await host(f);
  const before = reportDatabaseSnapshot(f);
  // 缺失/冲突父级：本地解析拒绝（退出码 2，结构化 invalid_input）。
  for (const args of [
    ['execution', 'result-diagnostics', '--project', f.projectId],
    ['execution', 'result-diagnostics', '--project', f.projectId, '--run', run, '--batch', randomUUID()],
    ['execution', 'result-diagnostics', '--project', f.projectId, '--run', run, '--limit', '999'],
    ['execution', 'result-diagnostics', '--project', f.projectId, '--run', '../secret'],
  ]) {
    const out = await cli(f, [...args, '--json']);
    expect(out.exitCode, out.stderr).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('invalid_input');
    expect(out.stdout + out.stderr).not.toContain(f.box.dataRoot);
    expect(out.stdout + out.stderr).not.toContain(h.token);
  }
  // 跨项目授权拒绝与不存在目标折叠：沿用现有错误码与退出码。
  const restricted = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } });
  await host(f, { principal: restricted });
  const denied = await cli(f, ['execution', 'result-diagnostics', '--project', f.projectId, '--run', run, '--json']);
  expect(denied.exitCode).not.toBe(0);
  expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  await host(f);
  const missing = await cli(f, ['execution', 'result-diagnostics', '--project', f.projectId, '--run', randomUUID(), '--json']);
  expect(missing.exitCode).not.toBe(0);
  expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  for (const out of [denied, missing]) {
    expect(out.stdout + out.stderr).not.toContain(f.box.dataRoot);
    expect(out.stdout + out.stderr).not.toContain(h.token);
    // 非公开错误正文不回传（错误信封只有稳定 code/details）。
    expect(out.stdout + out.stderr).not.toContain('SELECT');
  }
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});
