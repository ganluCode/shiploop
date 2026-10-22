/**
 * P04-9 / F-009 派发队列与执行槽位 CLI 正式构建入口验收
 * （`packages/cli/dist/bin.js`，与生产同一入口 + 真实临时 Host + 真实 SQLite）。
 *
 * 验收面（.dag_context.json F-009 第 4 条）：
 * - 有界构建 CLI（`tsc -b` + 显式入口准备，不跑全仓/阶段脚本）后，从正式入口
 *   读取同一数据根的派发/槽位投影：结构化 JSON 与人类文本都展示槽位占用、
 *   派发事实与可理解阻塞原因，并声明 Runtime 返回不等于验证通过；
 * - 关键错误：非法项目 ID 退出码 2；跨项目空页只给布尔占用摘要；
 * - 重复查询零副作用（持久表逐字节一致）。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME（沙箱 HOME/TMPDIR）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openSlotFixture, type SlotFixture } from '../../helpers/p04-9/slot-fixture.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');

let fixture: SlotFixture | undefined;
let host: RunningHost | undefined;
let projectIdB = '';
let slotId = '';
let tablesBefore: Record<string, unknown[]> | undefined;

function db() {
  return fixture!.box.session.database;
}

function factsSnapshot(): Record<string, unknown[]> {
  const tables = [
    'runs',
    'run_dispatch_claims',
    'execution_slot_claims',
    'run_dispatch_intents',
    'attempts',
    'tasks',
    'workspace_leases',
    'execution_batches',
    'runtime_start_reservations',
    'task_attempt_reservations',
    'state_events',
  ];
  return Object.fromEntries(
    tables.map((table) => [table, db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown[]]),
  );
}

/** 有界构建：同一 tsc 工程引用 + 显式入口准备；不执行全仓验收/阶段脚本。 */
beforeAll(async () => {
  execFileSync('npx', ['tsc', '-b', 'packages/core/tsconfig.json', 'packages/host/tsconfig.json', 'packages/cli/tsconfig.json'], {
    cwd: repoRoot,
    timeout: 240_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  execFileSync(process.execPath, [resolve(repoRoot, 'scripts/prepare-cli-bin.ts')], {
    cwd: repoRoot,
    timeout: 60_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  expect(existsSync(CLI_BIN)).toBe(true);

  fixture = await openSlotFixture();
  const projectId = fixture.projectId;
  fixture.box.session.transactWrite('fixture.f009.built.resetClaims', () => {
    db().prepare('DELETE FROM run_dispatch_claims WHERE project_id = ?').run(projectId);
  });
  const registeredB = await fixture.box.submit('project.register', {
    repositoryPath: fixture.box.box.repoDirB,
    displayName: 'F-009 Built Repo B',
    description: null,
    labels: [],
  }, { scope: { kind: 'registration' } });
  if (registeredB.status !== 'completed') {
    throw new Error(`夹具项目 B 注册失败：${JSON.stringify(registeredB)}`);
  }
  projectIdB = (registeredB.result as { project: { id: string } }).project.id;

  host = await startHost({
    dataRoot: fixture.box.box.dataRoot,
    capabilityCatalog: fixture.box.box.capabilityCatalog,
    env: {},
  });
  const insertClaim = db().prepare(
    'INSERT INTO run_dispatch_claims (id, created_at, project_id, revision, updated_at, feature_id, run_id, ' +
      'claim_version, origin, owner_id, host_instance_id, acquired_at, lease_until, state) ' +
      "VALUES (?, ?, ?, 1, ?, ?, ?, 1, 'dispatch', ?, ?, ?, ?, 'held')",
  );
  fixture.box.session.transactWrite('fixture.f009.built.dispatch', () => {
    insertClaim.run(
      fixture!.claimA, NOW, projectId, NOW, fixture!.runA.featureId, fixture!.runA.runId,
      'owner-a', 'host-a', NOW, NOW + 60_000,
    );
    insertClaim.run(
      fixture!.claimB, NOW, projectId, NOW, fixture!.runB.featureId, fixture!.runB.runId,
      'owner-b', 'host-b', NOW, NOW + 60_000,
    );
  });
  slotId = randomUUID();
  db().prepare(
    'INSERT INTO execution_slot_claims (id, created_at, project_id, revision, updated_at, slot_index, ' +
      'feature_id, run_id, claim_id, claim_version, owner_id, host_instance_id, acquired_at, lease_until, ' +
      "state, reason, released_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, 1, 'owner-a', 'host-a', ?, ?, 'held', NULL, NULL)",
  ).run(
    slotId, NOW, projectId, NOW, fixture.runA.featureId, fixture.runA.runId,
    fixture.claimA, NOW, NOW + 60_000,
  );
  tablesBefore = factsSnapshot();
}, 300_000);

afterAll(async () => {
  const running = host;
  host = undefined;
  const active = fixture;
  fixture = undefined;
  if (active !== undefined) {
    try {
      active.box.session.transactWrite('fixture.f009.built.cleanup', () => {
        db().prepare('DELETE FROM execution_slot_claims WHERE project_id = ?').run(active.projectId);
        db().prepare('DELETE FROM run_dispatch_claims WHERE project_id = ?').run(active.projectId);
      });
    } catch {
      // 数据库可能已关闭；清理失败不掩盖主测试结果。
    }
  }
  if (running !== undefined) {
    await running.close();
  }
  if (active !== undefined) {
    active.close();
  }
});

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 经正式构建入口执行 CLI（沙箱 HOME/TMPDIR；不继承开发机 SHIPLOOP_* 覆盖）。 */
function runBuiltCli(args: readonly string[]): Promise<CliOutcome> {
  const active = fixture;
  if (active === undefined) {
    throw new Error('fixture 未就绪');
  }
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: active.box.box.homeDir,
    TMPDIR: active.box.box.root,
  };
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, '--data-root', active.box.box.dataRoot],
      { cwd: active.box.box.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('built CLI timeout');
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        rejectSpawn(failure);
        return;
      }
      resolveSpawn({ status, stdout, stderr });
    });
  });
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
}

describe('F-009 派发查询正式构建 CLI（dist/bin.js + 临时 Host）', () => {
  it('结构化输出展示槽位占用、派发事实与等待/隔离原因', async () => {
    const active = fixture;
    if (active === undefined) {
      throw new Error('fixture 未就绪');
    }
    const outcome = await runBuiltCli([
      'execution', 'dispatch', '--project', active.projectId, '--json',
    ]);
    expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('execution.dispatch');
    const result = envelope.result as Record<string, unknown>;
    expect(result.operation).toBe('execution.dispatch.list');
    expect(result.slots).toMatchObject({
      capacity: 1,
      activeCount: 1,
      availableCount: 0,
      projectActiveCount: 1,
      otherProjectActive: false,
    });
    const records = result.records as readonly {
      record: Record<string, unknown>;
      waitCategory: string;
      blockingExplanation: string | null;
    }[];
    expect(records).toHaveLength(2);
    const recordA = records.find((entry) => entry.record.runId === active.runA.runId);
    const recordB = records.find((entry) => entry.record.runId === active.runB.runId);
    expect(recordA?.record).toMatchObject({
      state: 'claimed',
      claim: { claimId: active.claimA, ownerId: 'owner-a', state: 'held' },
      slot: { slotId, slotIndex: 1, state: 'held' },
    });
    expect(recordB?.record).toMatchObject({
      state: 'blocked',
      blockingReason: 'slot_ownership_missing',
      slot: null,
    });
    expect(recordB?.waitCategory).toBe('isolation');
    expect(recordB?.blockingExplanation).toContain('缺少可核对槽位归属');
    expect(result.completion).toMatchObject({ featureVerified: false, delivered: false });
  });

  it('文本输出包含槽位占用、占槽者、可理解原因与不验收边界', async () => {
    const active = fixture;
    if (active === undefined) {
      throw new Error('fixture 未就绪');
    }
    const outcome = await runBuiltCli([
      'execution', 'dispatch', '--project', active.projectId,
    ]);
    expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(outcome.stdout).toContain('execution dispatch');
    expect(outcome.stdout).toContain('capacity=1');
    expect(outcome.stdout).toContain(`run=${active.runA.runId}`);
    expect(outcome.stdout).toContain(`claim=${active.claimA}`);
    expect(outcome.stdout).toContain(`slot=${slotId}`);
    expect(outcome.stdout).toContain('blocking=slot_ownership_missing');
    expect(outcome.stdout).toContain('缺少可核对槽位归属');
    expect(outcome.stdout).toContain('不代表验证通过');
    // 不泄漏本机路径与数据根。
    expect(outcome.stdout).not.toContain(active.box.box.dataRoot);
    expect(outcome.stdout).not.toContain(active.box.box.root);
  });

  it('关键错误与跨项目摘要：非法项目 ID 退出码 2；跨项目空页只给布尔摘要', async () => {
    const active = fixture;
    if (active === undefined) {
      throw new Error('fixture 未就绪');
    }
    const badId = await runBuiltCli([
      'execution', 'dispatch', '--project', 'not-a-uuid', '--json',
    ]);
    expect(badId.status).toBe(2);
    const badIdEnvelope = JSON.parse(badId.stdout) as EnvelopeShape;
    expect(badIdEnvelope.error?.code).toBe('invalid_input');
    expect(badIdEnvelope.error?.details?.reason).toBe('invalid_project_id');

    const other = await runBuiltCli([
      'execution', 'dispatch', '--project', projectIdB, '--json',
    ]);
    expect(other.status, `${other.stdout}\n${other.stderr}`).toBe(0);
    const otherResult = (JSON.parse(other.stdout) as EnvelopeShape).result as Record<string, unknown>;
    expect(otherResult.records).toEqual([]);
    expect(otherResult.slots).toMatchObject({ otherProjectActive: true, projectActiveCount: 0 });
    const serialized = JSON.stringify(otherResult);
    expect(serialized).not.toContain(active.projectId);
    expect(serialized).not.toContain(active.runA.runId);
    expect(serialized).not.toContain(active.claimA);
    expect(serialized).not.toContain('owner-a');
    expect(serialized).not.toContain('host-a');
  });

  it('重复查询零副作用（持久表逐字节一致）', async () => {
    const active = fixture;
    if (active === undefined || tablesBefore === undefined) {
      throw new Error('fixture 未就绪');
    }
    for (let round = 0; round < 2; round += 1) {
      const outcome = await runBuiltCli([
        'execution', 'dispatch', '--project', active.projectId, '--json',
      ]);
      expect(outcome.status).toBe(0);
    }
    expect(factsSnapshot()).toEqual(tablesBefore);
  });
});
