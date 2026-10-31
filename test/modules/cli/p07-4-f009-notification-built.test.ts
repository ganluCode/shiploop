/**
 * P07-4 / F-009 构建产物冒烟：真实 Host 查询验证通知 CLI 接线（dist/bin.js +
 * 真实 loopback Host + 真实临时 SQLite 项目；不调用模型、不启动 Runtime）。
 *
 * 覆盖：
 * - 构建 CLI 的 notifications list/get：JSON 信封与 Core 查询结果逐字节一致
 *  （保留 null/未知字段），文本展示五类发送状态与 UTC 时间/次数；
 * - --cursor 翻页与实体/状态筛选；结构化错误（not_found）沿用退出码表；
 * - stdout 只含结构化结果（不泄漏数据根/凭据）；查询前后业务行不变。
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { createSqliteNotificationDeliveryStore } from '../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const cliBin = resolve(root, 'packages/cli/dist/bin.js');
const fixtures: BudgetFixture[] = [];
const hosts: Awaited<ReturnType<typeof openReportHost>>[] = [];
beforeAll(async () => {
  const built = await exec('npm', ['run', 'build'], { cwd: root, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(built.stdout);
  process.stderr.write(built.stderr);
}, 95_000);
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.close();
});

function seed(f: BudgetFixture, sequence: number, suffix: string, status: 'pending' | 'delivered') {
  const eventId = randomUUID();
  f.session.database.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(eventId, NOW, NOW, f.projectId, sequence, 'task.terminal', 'task', `task-${suffix}`,
    JSON.stringify({ schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: `attempt-${suffix}`, runId: `run-${suffix}`, resultRef: null }), NOW);
  const store = createSqliteNotificationDeliveryStore({ session: f.session, nowUtcMs: () => NOW });
  const delivery = store.createDelivery({ eventId, channelId: 'local-results',
    summary: { schemaVersion: 1, kind: 'task_terminal', taskId: `task-${suffix}`, status: 'passed', resultCategory: 'passed', attemptId: `attempt-${suffix}`, runId: `run-${suffix}`, resultRef: null } }).delivery;
  if (status === 'delivered') {
    const claimed = store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-cli', limit: 10 }).deliveries.find(d => d.deliveryId === delivery.deliveryId)!;
    store.recordDeliveryResult({ deliveryId: delivery.deliveryId, claimGeneration: claimed.claimGeneration, attempt: 1, outcome: 'succeeded', receipt: { channelId: 'local-results', deliveryId: delivery.deliveryId, attempt: 1 } });
  }
  return delivery;
}

async function cli(f: BudgetFixture, args: string[]) {
  try {
    const result = await exec(process.execPath, [cliBin, ...args, '--data-root', f.box.dataRoot], {
      cwd: f.box.repoDirA, env: { PATH: process.env.PATH, HOME: f.box.homeDir },
      timeout: 20_000, maxBuffer: 20 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
    return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function snapshotAll(f: BudgetFixture): Record<string, unknown[]> {
  const tables = f.session.database.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, f.session.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

test('[case:cli-built-json-parity] 构建 CLI JSON 与 Core 一致；文本展示状态；分页；查询前后存储不变', async () => {
  const f = await openBudgetFixture(BUDGET, [{ id: 't-1', title: 'Task 1', acceptance: { criteria: ['notifications'] }, dependsOn: [] }]);
  fixtures.push(f);
  const base = Number(f.session.database.prepare<[], { m: unknown }>('SELECT COALESCE(MAX(sequence), 0) AS m FROM state_events').get()!.m);
  const pending = seed(f, base + 1, 'one', 'pending');
  const delivered = seed(f, base + 2, 'two', 'delivered');
  const h = await openReportHost(f);
  hosts.push(h);
  const before = snapshotAll(f);

  const expected = await h.app.queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 200 });
  const jsonRun = await cli(f, ['notifications', 'list', '--project', f.projectId, '--limit', '200', '--json']);
  expect(jsonRun.exitCode, jsonRun.stderr).toBe(0);
  const envelope = JSON.parse(jsonRun.stdout) as { ok: boolean; command: string; result: typeof expected };
  expect(envelope).toEqual({ ok: true, command: 'notifications.list', result: expected });
  expect(jsonRun.stdout).not.toContain(f.box.dataRoot);
  expect(jsonRun.stderr).toBe('');

  // 文本展示：五类状态中已覆盖 pending/delivered；UTC 时间与次数可见。
  const textRun = await cli(f, ['notifications', 'list', '--project', f.projectId, '--task', 'task-two']);
  expect(textRun.exitCode).toBe(0);
  expect(textRun.stdout).toContain('status=delivered（已发送）');
  expect(textRun.stdout).toContain('attempts=1');
  expect(textRun.stdout).toContain('receipt={"attempt":1,"channelId":"local-results"');
  expect(textRun.stdout).toContain('entity=task:task-two');

  // 分页：--cursor 翻页不重复不遗漏。
  const firstPage = await cli(f, ['notifications', 'list', '--project', f.projectId, '--limit', '1', '--json']);
  const firstEnvelope = JSON.parse(firstPage.stdout) as { result: { records: { deliveryId: string }[]; nextCursor: string | null } };
  expect(firstEnvelope.result.records).toHaveLength(1);
  expect(firstEnvelope.result.nextCursor).toMatch(/^plcur_v1_/);
  const secondPage = await cli(f, ['notifications', 'list', '--project', f.projectId, '--limit', '1', '--cursor', firstEnvelope.result.nextCursor as string, '--json']);
  const secondEnvelope = JSON.parse(secondPage.stdout) as { result: { records: { deliveryId: string }[]; nextCursor: string | null } };
  expect(secondEnvelope.result.records).toHaveLength(1);
  expect(secondEnvelope.result.nextCursor).toBeNull();
  expect([firstEnvelope.result.records[0]!.deliveryId, secondEnvelope.result.records[0]!.deliveryId].sort())
    .toEqual([pending.deliveryId, delivered.deliveryId].sort());

  // 详情 JSON 与 Core 一致（执行审计链保留）。
  const expectedDetail = await h.app.queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: delivered.deliveryId });
  const detailRun = await cli(f, ['notifications', 'get', delivered.deliveryId, '--project', f.projectId, '--json']);
  expect(detailRun.exitCode, detailRun.stderr).toBe(0);
  expect(JSON.parse(detailRun.stdout)).toEqual({ ok: true, command: 'notifications.get', result: expectedDetail });

  // 结构化错误：不存在 delivery → 退出码 1 + not_found；本地输入错误 → 退出码 2。
  const missing = await cli(f, ['notifications', 'get', 'delivery-none', '--project', f.projectId, '--json']);
  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  const invalid = await cli(f, ['notifications', 'list', '--project', f.projectId, '--task', 'a', '--run', 'b', '--json']);
  expect(invalid.exitCode).toBe(2);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(missing.stdout + missing.stderr + invalid.stdout + invalid.stderr).not.toContain(f.box.dataRoot);
  expect(missing.stdout + missing.stderr + invalid.stdout + invalid.stderr).not.toContain(h.token);

  expect(snapshotAll(f)).toEqual(before);
});
