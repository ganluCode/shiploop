/**
 * P03-7 / F-014 CLI 正式构建入口（`npm run build` 产物 packages/cli/dist/bin.js）
 * 验收：同 commandId 重放、过期摘要、越权主体与重复继续的回执；批准命令返回后
 * Runtime 调用次数不变；显式继续复用有效证据时零新增编码调用；帮助与范围说明。
 *
 * 验收面（.dag_context.json F-014 第 3/4 条）：
 * - 从正式构建入口提交人审决定/显式验证继续：幂等重放返回原回执（replayed），
 *   过期/漂移摘要 conflict、越权责任主体 forbidden、重复继续由状态栅栏拒绝；
 * - 批准/解除/继续均不调用 Runtime（execution_batches.runtime_starts 与
 *   code_attempts_used 计数不变，回执携带 runtimeCalled=false）；
 * - 帮助区分可信项目与强沙箱、Task 局部验证与 P03-8 Feature 全量交付；未装配
 *   语言执行器明确 unsupported。
 *
 * 显式 Fake 测试 Host + 真实 SQLite/Git/worktree/制品；不读真实凭据、不调用
 * 模型、不修改开发仓库或用户 HOME（沙箱 HOME/TMPDIR）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFakeHost } from '../packages/host/src/testing.ts';
import type { RunningHost } from '../packages/host/src/runtime/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import {
  openBindingFixture,
  type BindingFixture,
} from './helpers/p03-6/input-binding-fixture.ts';
import {
  seedApprovalWaitingVerification,
  type SeededApprovalWaitingState,
} from './helpers/p03-7/approval-continue-seed.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');
const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () => createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  expect(existsSync(CLI_BIN)).toBe(true);
}, 570_000);

afterEach(async () => {
  const running = host;
  host = undefined;
  if (running !== undefined) {
    await running.close();
  }
  fixture?.close();
  fixture = undefined;
});

afterAll(() => {
  fixture?.close();
  fixture = undefined;
});

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 经正式构建入口执行 CLI（沙箱 HOME/TMPDIR；不继承开发机 SHIPLOOP_* 覆盖）。 */
function runBuiltCli(args: readonly string[]): Promise<CliOutcome> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: fixture!.box.homeDir,
    TMPDIR: fixture!.box.root,
  };
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, '--data-root', fixture!.box.dataRoot],
      { cwd: fixture!.box.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
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
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function envelope(outcome: CliOutcome): EnvelopeShape {
  return JSON.parse(outcome.stdout) as EnvelopeShape;
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  const parsed = envelope(outcome);
  expect(parsed.ok).toBe(true);
  expect(parsed.command).toBe(command);
  return parsed.result as Record<string, unknown>;
}

async function openSeededCase(): Promise<SeededApprovalWaitingState> {
  fixture = await openBindingFixture();
  host = await startFakeHost({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: catalog(),
    env: {},
    fake: {
      providers,
      commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'probe' },
          { op: 'message', role: 'assistant', text: 'F-014 built' },
        ],
      },
    },
  });
  await host.core.workExecution.scan();
  await expect
    .poll(() => fixture!.query('SELECT status FROM attempts') as { status: string } | undefined, {
      timeout: 20_000,
    })
    .toMatchObject({ status: 'verifying' });
  await expect
    .poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 20_000 })
    .toEqual([]);
  const closed = await host.core.workExecution.close();
  expect(closed.closed).toBe(true);
  return seedApprovalWaitingVerification({
    fixture,
    completion: host.core.taskVerificationCompletion,
    responsibleParty: 'owner',
  });
}

describe('F-014 正式构建入口：回执重放/过期摘要/越权主体/重复继续', () => {
  it('批准与显式继续经 dist/bin.js 返回稳定回执，Runtime/编码调用计数不变', async () => {
    const seeded = await openSeededCase();
    const db = fixture!.session.database;
    const startsBefore = (
      db.prepare('SELECT COALESCE(SUM(runtime_starts), 0) AS n FROM execution_batches').get() as { n: number }
    ).n;
    const codeBefore = (
      db.prepare('SELECT code_attempts_used AS n FROM tasks WHERE id = ?').get('t-1') as { n: number }
    ).n;

    /* 同 commandId 重放：先提交、后以同一信封重放返回原回执（replayed）。 */
    const approveCommandId = randomUUID();
    const approveArgs = [
      'task', 'approve', 't-1', seeded.approvalItemId, '--project', fixture!.projectId,
      '--digest', seeded.planDigest, '--code-digest', seeded.codeDigest,
      '--revision', String(seeded.approvalItemRevision), '--command-id', approveCommandId, '--json',
    ];
    const approved = okResult(await runBuiltCli(approveArgs), 'task.approve') as {
      replayed: boolean;
      decision: string;
      execution: { runtimeCalled: boolean; started: boolean };
    };
    expect(approved).toMatchObject({
      replayed: false,
      decision: 'approve',
      execution: { runtimeCalled: false, started: false },
    });
    const replayed = okResult(await runBuiltCli(approveArgs), 'task.approve') as {
      replayed: boolean;
    };
    expect(replayed.replayed).toBe(true);

    /* 批准命令返回后 Runtime 调用次数不变。 */
    const startsAfterApprove = (
      db.prepare('SELECT COALESCE(SUM(runtime_starts), 0) AS n FROM execution_batches').get() as { n: number }
    ).n;
    expect(startsAfterApprove).toBe(startsBefore);

    /* 显式验证继续：复用有效证据（零新增编码调用）。 */
    const continueCommandId = randomUUID();
    const continueArgs = [
      'task', 'continue', 't-1', '--project', fixture!.projectId,
      '--attempt', seeded.attemptId, '--batch', seeded.batchId,
      '--code-digest', seeded.codeDigest, '--observation', seeded.observationDigest,
      '--revision', String(seeded.taskRevision), '--command-id', continueCommandId, '--json',
    ];
    const continued = okResult(await runBuiltCli(continueArgs), 'task.continue') as {
      display: string;
      evidenceReused: boolean;
      execution: { runtimeCalled: boolean; started: boolean };
    };
    expect(continued.display).toBe('completed');
    expect(continued.evidenceReused).toBe(true);
    expect(continued.execution).toMatchObject({ runtimeCalled: false, started: false });

    /* 显式继续复用有效证据时零新增编码调用：代码额度与 Runtime 启动计数不变。 */
    const codeAfter = (
      db.prepare('SELECT code_attempts_used AS n FROM tasks WHERE id = ?').get('t-1') as { n: number }
    ).n;
    const startsAfter = (
      db.prepare('SELECT COALESCE(SUM(runtime_starts), 0) AS n FROM execution_batches').get() as { n: number }
    ).n;
    expect(codeAfter).toBe(codeBefore);
    expect(startsAfter).toBe(startsBefore);

    /* 重复继续：同 commandId 重放原回执；不同 commandId 由状态栅栏拒绝。 */
    const continueReplay = okResult(await runBuiltCli(continueArgs), 'task.continue') as {
      replayed: boolean;
    };
    expect(continueReplay.replayed).toBe(true);
    const duplicate = await runBuiltCli([
      'task', 'continue', 't-1', '--project', fixture!.projectId,
      '--attempt', seeded.attemptId, '--batch', seeded.batchId,
      '--code-digest', seeded.codeDigest, '--observation', seeded.observationDigest,
      '--revision', String(seeded.taskRevision), '--command-id', randomUUID(), '--json',
    ]);
    expect(duplicate.status).toBe(1);
    expect(envelope(duplicate).error?.code).toBe('conflict');

    /* 过期/漂移摘要：已授权责任主体的待决事项上 codeDigest 不匹配 → conflict。 */
    const staleItem = `item-${randomUUID()}`;
    const seedItem = (itemId: string, responsibleParty: string): void => {
      db.prepare(
        `INSERT INTO task_approval_items
          (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
           responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
         VALUES (?, ?, ?, ?, 't-1', 1, ?, 'approval', '他方复核', ?, ?, ?, '[]', 'pending', 'local-owner', '[]')`,
      ).run(
        itemId,
        Date.now(),
        fixture!.projectId,
        fixture!.featureId,
        Date.now(),
        responsibleParty,
        seeded.planDigest,
        seeded.codeDigest,
      );
    };
    seedItem(staleItem, 'owner');
    const stale = await runBuiltCli([
      'task', 'approve', 't-1', staleItem, '--project', fixture!.projectId,
      '--digest', seeded.planDigest, '--code-digest', 'ab'.repeat(32),
      '--revision', '1', '--json',
    ]);
    expect(stale.status).toBe(1);
    expect(envelope(stale).error?.code).toBe('conflict');

    /* 越权主体：responsibleParty 不匹配的事项决定 → forbidden。 */
    const foreignItem = `item-${randomUUID()}`;
    seedItem(foreignItem, 'reviewer-a');
    const forbidden = await runBuiltCli([
      'task', 'approve', 't-1', foreignItem, '--project', fixture!.projectId,
      '--digest', seeded.planDigest, '--code-digest', seeded.codeDigest,
      '--revision', '1', '--json',
    ]);
    expect(forbidden.status).toBe(1);
    expect(envelope(forbidden).error?.code).toBe('forbidden');
  }, 120_000);
});

describe('F-014 正式构建入口：帮助与范围说明', () => {
  it('帮助区分可信项目/强沙箱、Task 局部验证/P03-8 全量交付；未装配执行器 unsupported', async () => {
    fixture = await openBindingFixture();
    for (const subcommand of ['status', 'block', 'continue']) {
      const help = await runBuiltCli(['task', subcommand, '--help']);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('可信项目模式');
      expect(help.stdout).toContain('强 OS 沙箱');
      expect(help.stdout).toContain('P03-8 Feature 全量交付');
      expect(help.stdout).toContain('unsupported');
      expect(help.stdout).not.toContain('/Users/');
    }
  }, 60_000);
});
