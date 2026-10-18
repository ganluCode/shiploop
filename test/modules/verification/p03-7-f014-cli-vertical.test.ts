/**
 * P03-7 / F-014 CLI 纵向（runAppCli → HostClient → Host → Core，真实 SQLite/Git/
 * worktree/制品 + 显式 FakeRuntime 测试装配）。
 *
 * 验收面（.dag_context.json F-014 第 1/2 条）：
 * 1. CLI 经 HostClient 调用已有应用能力完成检查定义/模块策略确认（config
 *    policies.verification）、添加阻塞、批准/拒绝/解除与显式验证继续，返回稳定
 *    结构化回执与业务状态；参数校验拒绝客户端伪造主体与明文凭据；
 * 2. 状态查询分别展示机器结论、人审待处理与有效 Task 状态；错误/等待批准/
 *    not_run/额度耗尽不打印为通过，退出码遵循既有命令约定。
 *
 * 同时断言执行边界：批准/解除/继续均不调用 Runtime（runtime_starts 与编码
 * 调用计数不变）。不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { startFakeHost } from '../../../packages/host/src/testing.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import {
  openBindingFixture,
  type BindingFixture,
} from '../../helpers/p03-6/input-binding-fixture.ts';
import {
  seedApprovalWaitingVerification,
  type SeededApprovalWaitingState,
} from '../../helpers/p03-7/approval-continue-seed.ts';

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () => createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);
const CODE_DIGEST = 'cd'.repeat(32);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;

afterEach(async () => {
  const running = host;
  host = undefined;
  if (running !== undefined) {
    await running.close();
  }
  fixture?.close();
  fixture = undefined;
});

interface CliOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: { ok: boolean; command: string | null; result?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } };
}

async function runApp(args: readonly string[]): Promise<CliOutcome> {
  let stdout = '';
  let stderr = '';
  const io: AppCliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const result = await runAppCli({
    args: [...args, '--data-root', fixture!.box.dataRoot],
    env: {},
    io,
    userHomeDir: fixture!.box.homeDir,
  });
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    envelope: (result.envelope ?? JSON.parse(stdout || '{"ok":false}')) as CliOutcome['envelope'],
  };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.exitCode, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  expect(outcome.envelope.ok).toBe(true);
  expect(outcome.envelope.command).toBe(command);
  return outcome.envelope.result as Record<string, unknown>;
}

async function openCase(): Promise<{ projectId: string; runId: string }> {
  fixture = await openBindingFixture();
  host = await startFakeHost({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: catalog(),
    env: {},
    fake: {
      providers,
      /* tool_command 步骤产生真实 OS 进程身份：停止证据（整组缺席普查）可证明，
       * 使受信验证收尾能按契约释放/保留占用。 */
      commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'probe' },
          { op: 'message', role: 'assistant', text: 'F-014' },
        ],
      },
    },
  });
  return { projectId: fixture.projectId, runId: fixture.runId };
}

const VERIFICATION_POLICY = {
  requireChecksBeforeDone: true,
  checkDefinitions: [
    {
      checkKey: 'unit-core',
      scope: 'module',
      kind: 'command',
      argv: ['npm', 'test', '--', 'packages/core'],
      cwdRef: 'packages/core',
      environmentRef: 'ci-safe',
      timeout: 120_000,
      required: true,
      requirementRefs: ['req-core'],
    },
  ],
  modules: [
    {
      moduleKey: 'core',
      allowedTargets: ['packages/core'],
      impactScope: ['packages/core'],
      sharedHighRiskFiles: ['package.json'],
    },
  ],
  fullFallback: { checkRefs: ['unit-core'] },
};

describe('F-014 检查定义/模块策略确认与输入守护', () => {
  it('config 通道保存确认政策并回显业务状态；伪造主体/明文凭据被拒绝', async () => {
    const { projectId } = await openCase();
    const inputPath = join(fixture!.box.root, 'check-policy.json');
    writeFileSync(
      inputPath,
      JSON.stringify({ schemaVersion: 2, policies: { verification: VERIFICATION_POLICY } }),
      'utf8',
    );
    const created = await runApp([
      'config', 'create', '--scope', 'project', '--project', projectId, '--input', inputPath, '--json',
    ]);
    const createdResult = okResult(created, 'config.create');
    expect(createdResult).toMatchObject({ status: 'completed' });

    /* 业务状态：确认后的检查定义/模块策略经查询面回显。 */
    const current = okResult(
      await runApp(['config', 'get', '--scope', 'project', '--project', projectId, '--json']),
      'config.get',
    );
    expect(JSON.stringify(current)).toContain('unit-core');
    expect(JSON.stringify(current)).toContain('"moduleKey":"core"');

    /* 伪造主体与明文凭据字段在连接 Host 之前以退出码 2 拒绝。 */
    for (const forbidden of [
      { principalId: 'forged-principal' },
      { decisionActor: 'forged-actor' },
      { credentials: 'plaintext-secret' },
    ]) {
      const badPath = join(fixture!.box.root, `bad-${randomUUID()}.json`);
      writeFileSync(
        badPath,
        JSON.stringify({
          schemaVersion: 2,
          policies: { verification: { ...VERIFICATION_POLICY, ...forbidden } },
        }),
        'utf8',
      );
      const rejected = await runApp([
        'config', 'create', '--scope', 'project', '--project', projectId, '--input', badPath, '--json',
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.envelope.ok).toBe(false);
      expect(rejected.stdout).not.toContain('forged');
      expect(rejected.stdout).not.toContain('plaintext-secret');
    }
  }, 30_000);
});

describe('F-014 人审事项命令与状态三分区', () => {
  it('block/unblock/approve（越权）返回结构化回执；状态不把非通过折算为通过', async () => {
    const { projectId } = await openCase();
    const db = fixture!.session.database;
    const feature = db.prepare('SELECT plan_digest FROM features WHERE id = ?').get(fixture!.featureId) as {
      plan_digest: string;
    };

    /* 未执行前：机器 none → not_run，绝不 passed。 */
    const before = okResult(await runApp(['task', 'status', 't-1', '--project', projectId, '--json']), 'task.status');
    expect(before).toMatchObject({
      commandId: 'task.status',
      display: 'not_run',
      passed: false,
      machine: { status: 'none' },
      task: { taskId: 't-1', effectivePassed: false },
    });

    /* 添加阻塞：结构化回执（事项事实 + 执行边界）。 */
    const blocked = okResult(
      await runApp([
        'task', 'block', 't-1', '--project', projectId, '--digest', feature.plan_digest,
        '--revision', '1', '--description', '交付前人工复核', '--party', 'owner',
        '--code-digest', CODE_DIGEST, '--json',
      ]),
      'task.block',
    ) as {
      task: { manualBlock: boolean; revision: number };
      item: { id: string; revision: number; kind: string; responsibleParty: string };
      execution: { started: boolean; runtimeCalled: boolean };
    };
    expect(blocked.task.manualBlock).toBe(true);
    expect(blocked.item.kind).toBe('block');
    expect(blocked.execution).toMatchObject({ started: false, runtimeCalled: false });

    /* 阻塞后：等待人审 → waiting_approval，不打印为通过。 */
    const waiting = okResult(await runApp(['task', 'status', 't-1', '--project', projectId, '--json']), 'task.status');
    expect(waiting).toMatchObject({ display: 'waiting_approval', passed: false, pendingApprovalCount: 1 });
    expect(JSON.stringify(waiting.task)).toContain('"manualBlock":true');

    const startsBefore = (
      db.prepare('SELECT COALESCE(SUM(runtime_starts), 0) AS n FROM execution_batches').get() as { n: number }
    ).n;

    /* 越权主体：responsibleParty 不匹配的事项决定被拒绝（不泄漏内容）。 */
    const foreignItem = `item-${randomUUID()}`;
    db.prepare(
      `INSERT INTO task_approval_items
        (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
         responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
       VALUES (?, ?, ?, ?, 't-1', 1, ?, 'approval', '他方复核', 'reviewer-a', ?, ?, '[]', 'pending', 'local-owner', '[]')`,
    ).run(foreignItem, Date.now(), projectId, fixture!.featureId, Date.now(), feature.plan_digest, CODE_DIGEST);
    const forbidden = await runApp([
      'task', 'approve', 't-1', foreignItem, '--project', projectId, '--digest', feature.plan_digest,
      '--code-digest', CODE_DIGEST, '--revision', '1', '--json',
    ]);
    expect(forbidden.exitCode).toBe(1);
    expect(forbidden.envelope.ok).toBe(false);
    expect(forbidden.envelope.error?.code).toBe('forbidden');

    /* 过期/漂移摘要：已授权事项上 codeDigest 不匹配 → conflict，不产生决定。 */
    const stale = await runApp([
      'task', 'approve', 't-1', blocked.item.id, '--project', projectId, '--digest', feature.plan_digest,
      '--code-digest', 'ab'.repeat(32), '--revision', String(blocked.item.revision), '--json',
    ]);
    expect(stale.exitCode).toBe(1);
    expect(stale.envelope.error?.code).toBe('conflict');

    /* 解除阻塞（item CAS）→ manualBlock 清除；仍不启动执行。 */
    const unblocked = okResult(
      await runApp([
        'task', 'unblock', 't-1', blocked.item.id, '--project', projectId, '--digest', feature.plan_digest,
        '--code-digest', CODE_DIGEST, '--revision', String(blocked.item.revision), '--reason', '复核通过', '--json',
      ]),
      'task.unblock',
    ) as { decision: string; item: { status: string }; execution: { runtimeCalled: boolean } };
    expect(unblocked.decision).toBe('unblock');
    expect(unblocked.item.status).toBe('unblocked');
    expect(unblocked.execution.runtimeCalled).toBe(false);

    const startsAfter = (
      db.prepare('SELECT COALESCE(SUM(runtime_starts), 0) AS n FROM execution_batches').get() as { n: number }
    ).n;
    expect(startsAfter).toBe(startsBefore);

    /* 状态仍非通过（尚无机器批次 + 残留 pending 事项）。 */
    const after = okResult(await runApp(['task', 'status', 't-1', '--project', projectId, '--json']), 'task.status');
    expect(after.passed).toBe(false);
    expect(['not_run', 'waiting_approval']).toContain(after.display);
  }, 30_000);
});

describe('F-014 显式验证继续（复用有效机器证据，零新增编码调用）', () => {
  it('批准 → 继续 → 重复继续回执；机器绿等待批准不折算为通过', async () => {
    const { projectId } = await openCase();
    await host!.core.workExecution.scan();
    await expect
      .poll(() => fixture!.query('SELECT status FROM attempts') as { status: string } | undefined, {
        timeout: 20_000,
      })
      .toMatchObject({ status: 'verifying' });
    /* FakeRuntime 执行完毕后停止调度器计时扫描：避免后台调度诊断覆写 Run 暂停
     * 原因（run_control_blocked）与验证收尾的受信状态竞争（与 F-012 继续测试
     * 同一无调度环境；执行已结束、无活动 Attempt）。 */
    await expect
      .poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 20_000 })
      .toEqual([]);
    const closed = await host!.core.workExecution.close();
    expect(closed.closed).toBe(true);

    const seeded: SeededApprovalWaitingState = await seedApprovalWaitingVerification({
      fixture: fixture!,
      completion: host!.core.taskVerificationCompletion,
    });
    const db = fixture!.session.database;

    /* 机器 passed 但人审未决：waiting_approval，绝不 passed。 */
    const waiting = okResult(await runApp(['task', 'status', 't-1', '--project', projectId, '--json']), 'task.status');
    expect(waiting).toMatchObject({ display: 'waiting_approval', passed: false });
    expect(waiting.machine).toMatchObject({ status: 'passed' });

    const codeBefore = (
      db.prepare('SELECT code_attempts_used AS n FROM tasks WHERE id = ?').get('t-1') as { n: number }
    ).n;

    /* 批准（事项 CAS）：completed + 零 Runtime 调用。 */
    const approveCommandId = randomUUID();
    const approved = okResult(
      await runApp([
        'task', 'approve', 't-1', seeded.approvalItemId!, '--project', projectId, '--digest', seeded.planDigest,
        '--code-digest', seeded.codeDigest, '--revision', String(seeded.approvalItemRevision!),
        '--command-id', approveCommandId, '--json',
      ]),
      'task.approve',
    ) as { decision: string; execution: { runtimeCalled: boolean; started: boolean }; replayed: boolean };
    expect(approved.decision).toBe('approve');
    expect(approved.execution).toMatchObject({ runtimeCalled: false, started: false });
    expect(approved.replayed).toBe(false);

    /* 同 commandId 重放：同一回执（replayed），不重复副作用。 */
    const replayed = okResult(
      await runApp([
        'task', 'approve', 't-1', seeded.approvalItemId!, '--project', projectId, '--digest', seeded.planDigest,
        '--code-digest', seeded.codeDigest, '--revision', String(seeded.approvalItemRevision!),
        '--command-id', approveCommandId, '--json',
      ]),
      'task.approve',
    ) as { replayed: boolean };
    expect(replayed.replayed).toBe(true);

    /* 显式验证继续：复用有效证据，零新增编码调用。 */
    const stateBeforeContinue = fixture!.query(
      `SELECT a.status AS attempt_status, a.execution_stage AS stage, t.status AS task_status,
              r.status AS run_status, r.reason AS run_reason,
              (SELECT COUNT(*) AS leases FROM workspace_leases WHERE state = 'held') AS leases
         FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN runs r ON r.id = a.run_id WHERE a.id = ?`,
      seeded.attemptId,
    );
    const continueCommandId = randomUUID();
    const continued = okResult(
      await runApp([
        'task', 'continue', 't-1', '--project', projectId, '--attempt', seeded.attemptId,
        '--batch', seeded.batchId, '--code-digest', seeded.codeDigest,
        '--observation', seeded.observationDigest, '--revision', String(seeded.taskRevision),
        '--command-id', continueCommandId, '--json',
      ]),
      'task.continue',
    ) as {
      display: string;
      disposition: string;
      runtimeCalled: boolean;
      execution: { runtimeCalled: boolean; started: boolean };
    };
    expect(continued.display, `${JSON.stringify(continued)} state=${JSON.stringify(stateBeforeContinue)}`).toBe('completed');
    expect(continued.disposition, JSON.stringify(continued)).toBe('applied');
    expect(continued.execution).toMatchObject({ runtimeCalled: false, started: false });

    const codeAfter = (
      db.prepare('SELECT code_attempts_used AS n FROM tasks WHERE id = ?').get('t-1') as { n: number }
    ).n;
    expect(codeAfter).toBe(codeBefore);
    const startsAfter = (
      db.prepare('SELECT COALESCE(SUM(runtime_starts), 0) AS n FROM execution_batches').get() as { n: number }
    ).n;
    expect(startsAfter).toBe(seeded.runtimeStarts);

    /* 重复继续：同 commandId 重放原回执；不同 commandId 由状态栅栏拒绝。 */
    const continueReplay = okResult(
      await runApp([
        'task', 'continue', 't-1', '--project', projectId, '--attempt', seeded.attemptId,
        '--batch', seeded.batchId, '--code-digest', seeded.codeDigest,
        '--observation', seeded.observationDigest, '--revision', String(seeded.taskRevision),
        '--command-id', continueCommandId, '--json',
      ]),
      'task.continue',
    ) as { replayed: boolean };
    expect(continueReplay.replayed).toBe(true);

    const duplicate = await runApp([
      'task', 'continue', 't-1', '--project', projectId, '--attempt', seeded.attemptId,
      '--batch', seeded.batchId, '--code-digest', seeded.codeDigest,
      '--observation', seeded.observationDigest, '--revision', String(seeded.taskRevision),
      '--command-id', randomUUID(), '--json',
    ]);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.envelope.ok).toBe(false);
    expect(duplicate.envelope.error?.code).toBe('conflict');

    /* 过期观察摘要：拒绝复用（要求重验）。 */
    const staleObservation = await runApp([
      'task', 'continue', 't-1', '--project', projectId, '--attempt', seeded.attemptId,
      '--batch', seeded.batchId, '--code-digest', seeded.codeDigest,
      '--observation', 'ab'.repeat(32), '--revision', String(seeded.taskRevision),
      '--command-id', randomUUID(), '--json',
    ]);
    expect(staleObservation.exitCode).toBe(1);
    expect(['conflict', 'not_found']).toContain(staleObservation.envelope.error?.code);

    /* 完成后状态：机器 passed + 有效 Task passed → 才是 passed。 */
    const final = okResult(await runApp(['task', 'status', 't-1', '--project', projectId, '--json']), 'task.status');
    expect(final).toMatchObject({ display: 'passed', passed: true });
    expect(final.task).toMatchObject({ status: 'passed', effectivePassed: true });
  }, 40_000);
});
