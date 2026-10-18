/**
 * P03-8 / F-011 Feature 交付 CLI 纵向（runAppCli → HostClient → Host → Core，
 * 真实 SQLite + 显式注入的 delivery 适配器替身；命令只经过 Host）。
 *
 * 验收面（.dag_context.json F-011）：
 * - feature delivery / git operations / git operation 经 HostClient 查询：分轴
 *   分别显示，保留 Feature/Run/operation 与证据引用；未完成 outcome、pending
 *   意图绝不显示为 completed/已提交；
 * - feature final-approve / feature finalize 经既有授权命令通道提交：审批绑定
 *   当前摘要；缺 --confirm 在任何 I/O 之前退出码 2（零副作用）；finalize 先
 *   awaiting_approval、批准后 completed（delivered=true 只在 outcome=completed
 *   且 deliveryStatus=succeeded）；业务拒绝（陈旧 revision）退出码 1；未装配
 *   delivery 能力明确 unsupported；
 * - CLI 不打开状态库、不直接执行 Git（真实仓库 HEAD 全程不变；Git 副作用只
 *   来自 Host 可信装配注入的替身）。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { startHost, type RunningHost } from '../../../packages/host/src/index.ts';
import { openBudgetFixture, NOW, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import type { FeatureDeliveryDependencies } from '../../../packages/core/src/application/feature-delivery-commands.ts';

const CODE = 'ab'.repeat(32);

/* ------------------------------------------------------------------ *
 * 夹具：预算夹具 + 终态 Task/运行中 Feature + 显式注入的 delivery 替身
 * ------------------------------------------------------------------ */

interface DeliveryCase {
  readonly box: BudgetFixture;
  readonly ids: { readonly projectId: string; readonly batchId: string; readonly runId: string; readonly taskId: string };
  readonly dependencies: FeatureDeliveryDependencies;
  readonly commit: ReturnType<typeof vi.fn>;
  readonly reconcile: ReturnType<typeof vi.fn>;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly operationId: string;
  readonly featureRevision: () => number;
  readonly registerIntent: () => void;
}

const boxes: BudgetFixture[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const box of boxes.splice(0)) box.close();
});

async function openCase(options: { readonly registerIntent?: boolean } = {}): Promise<DeliveryCase> {
  const box = await openBudgetFixture();
  boxes.push(box);
  const ids = await box.start();
  const db = box.session.database;
  db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
  db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(box.featureId);
  db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
  db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
  const operationId = randomUUID();
  const featureRevision = () =>
    (db.prepare('SELECT revision FROM features WHERE id = ?').get(box.featureId) as { revision: number }).revision;
  const intent = () => ({
    projectId: box.projectId,
    featureId: box.featureId,
    runId: ids.runId,
    operationId,
    codeDigest: CODE,
  });
  const registerIntent = () =>
    box.services.atomic.transact('f011.intent', transaction => {
      const binding = db
        .prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?')
        .get(box.projectId) as { id: string; repo_identity: string };
      return transaction.registerGitOperation({
        ...intent(),
        attemptId: null,
        executionVersion: 1,
        operationType: 'feature_final_commit',
        repositoryBindingId: binding.id,
        repoIdentity: binding.repo_identity,
        worktreePath: box.box.repoDirA,
        expectedHead: box.box.gitHead('A'),
        candidateTree: 'b'.repeat(40),
        verificationRefs: [{ kind: 'verification_batch', id: 'full-check', digest: CODE }],
        approvalRefs: [],
        message: 'delivery',
        gitIdentity: { name: 'Configured Git User', email: 'git@example.test', confirmed: true },
        deliveryPolicyDigest: 'cd'.repeat(32),
        runtimeSource: null,
        ownerId: 'core-owner',
        hostInstanceId: 'host',
        expectedFeatureRevision: featureRevision(),
      }).operation;
    });
  const commit = vi.fn(async () => {
    registerIntent();
    return box.services.atomic.transact('f011.commit', t =>
      t.finalizeGitOperation({
        projectId: box.projectId,
        operationId,
        expectedRevision: 1,
        status: 'succeeded',
        actualCommit: 'c'.repeat(40),
        actualTree: 'b'.repeat(40),
        exitCode: 0,
        durationMs: 1,
        reasonCode: null,
        deliveryStatus: 'succeeded',
        settledAtUtcMs: NOW,
      }).operation,
    );
  });
  const reconcile = vi.fn(async () => ({
    outcome: 'not_executed' as const,
    reasonCode: 'commit_not_observed',
    operation: box.services.atomic.transact('f011.read', t => t.getGitOperation(box.projectId, operationId)),
  }));
  const verify = vi.fn(async () => ({ passed: true, reason: 'full_verification_passed' }));
  const dependencies: FeatureDeliveryDependencies = {
    readIntent: intent,
    verify,
    commit: { commit },
    reconciliation: { reconcile },
  };
  if (options.registerIntent === true) registerIntent();
  return { box, ids, dependencies, commit, reconcile, verify, operationId, featureRevision, registerIntent };
}

async function startDeliveryHost(c: DeliveryCase, withFactory = true): Promise<RunningHost> {
  const host = await startHost({
    dataRoot: c.box.box.dataRoot,
    capabilityCatalog: c.box.box.capabilityCatalog,
    env: {},
    ...(withFactory ? { featureDeliveryFactory: () => c.dependencies } : {}),
  });
  hosts.push(host);
  return host;
}

interface CliOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: {
    ok: boolean;
    command: string | null;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

async function runApp(c: DeliveryCase, args: readonly string[]): Promise<CliOutcome> {
  let stdout = '';
  let stderr = '';
  const io: AppCliIo = {
    stdout: text => {
      stdout += text;
    },
    stderr: text => {
      stderr += text;
    },
  };
  const result = await runAppCli({
    args: [...args, '--data-root', c.box.box.dataRoot],
    env: {},
    io,
    userHomeDir: c.box.box.homeDir,
  });
  const envelope = result.envelope ?? (args.includes('--json') ? JSON.parse(stdout || '{"ok":false}') : undefined);
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    envelope: (envelope ?? { ok: result.exitCode === 0, command: null }) as CliOutcome['envelope'],
  };
}

function insertApprovalItem(c: DeliveryCase): { id: string; revision: number } {
  const db = c.box.session.database;
  const planDigest = (
    db.prepare('SELECT plan_digest FROM features WHERE id = ?').get(c.box.featureId) as { plan_digest: string }
  ).plan_digest;
  const item = c.box.services.atomic.transact('f011.approval-item', t =>
    t.insertTaskApprovalItem({
      projectId: c.box.projectId,
      featureId: c.box.featureId,
      taskId: c.ids.taskId,
      kind: 'approval',
      description: 'final review',
      responsibleParty: 'owner',
      planDigest,
      codeDigest: CODE,
      artifactRefs: [],
      createdBy: c.box.owner.principalId,
    }).record,
  );
  return { id: item.id, revision: item.revision };
}

function planDigestOf(c: DeliveryCase): string {
  return (
    c.box.session.database
      .prepare('SELECT plan_digest FROM features WHERE id = ?')
      .get(c.box.featureId) as { plan_digest: string }
  ).plan_digest;
}

/* ------------------------------------------------------------------ *
 * 查询：分轴结果与 Git 操作
 * ------------------------------------------------------------------ */

describe('F-011 Feature 分轴结果与 Git 操作查询（真实 Host）', () => {
  it('feature delivery 分轴分别显示且未完成 outcome 不是 completed；重复查询零副作用', async () => {
    const c = await openCase({ registerIntent: true });
    await startDeliveryHost(c);
    const before = c.box.snapshot();

    const json = await runApp(c, ['feature', 'delivery', c.box.featureId, '--project', c.box.projectId, '--json']);
    expect(json.exitCode, `${json.stdout}\n${json.stderr}`).toBe(0);
    expect(json.envelope.ok).toBe(true);
    expect(json.envelope.command).toBe('feature.delivery');
    const result = json.envelope.result as {
      completed: boolean;
      outcome: { status: string; identities: { featureId: string; gitOperationId: string | null } };
      axes: {
        tasks: { total: number; passed: number; allPassed: boolean };
        verification: { status: string };
        approval: { status: string };
        delivery: { status: string; operation: { operationId: string; status: string } | null };
      };
    };
    // 所有 Task passed 但交付未完成：绝不显示为 completed。
    expect(result.axes.tasks.allPassed).toBe(true);
    expect(result.outcome.status).not.toBe('completed');
    expect(result.completed).toBe(false);
    expect(result.outcome.identities.featureId).toBe(c.box.featureId);
    expect(result.outcome.identities.gitOperationId).toBe(c.operationId);
    expect(result.axes.delivery.operation?.operationId).toBe(c.operationId);
    expect(result.axes.delivery.operation?.status).toBe('pending');

    const human = await runApp(c, ['feature', 'delivery', c.box.featureId, '--project', c.box.projectId]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('completed=false');
    expect(human.stdout).toContain('tasks passed=1/1');
    expect(human.stdout).toContain('verification');
    expect(human.stdout).toContain('approval');
    expect(human.stdout).toContain('delivery');
    expect(human.stdout).not.toContain('交付完成');

    expect(c.box.snapshot()).toEqual(before);
  });

  it('git operations/operation 显示意图与回执在场性；pending 不是已提交', async () => {
    const c = await openCase({ registerIntent: true });
    await startDeliveryHost(c);

    const list = await runApp(c, ['git', 'operations', '--project', c.box.projectId, '--feature', c.box.featureId, '--json']);
    expect(list.exitCode, `${list.stdout}\n${list.stderr}`).toBe(0);
    expect(list.envelope.command).toBe('git.operations');
    const records = (list.envelope.result as { records: Record<string, unknown>[] }).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operationId: c.operationId,
      status: 'pending',
      deliveryStatus: null,
      committed: false,
      receiptRecorded: false,
    });

    const byRun = await runApp(c, ['git', 'operations', '--project', c.box.projectId, '--run', c.ids.runId, '--json']);
    expect(byRun.exitCode).toBe(0);
    expect((byRun.envelope.result as { records: unknown[] }).records).toHaveLength(1);

    const detail = await runApp(c, ['git', 'operation', c.operationId, '--project', c.box.projectId, '--json']);
    expect(detail.exitCode).toBe(0);
    expect(detail.envelope.command).toBe('git.operation');
    const record = (detail.envelope.result as { record: Record<string, unknown> }).record;
    expect(record).toMatchObject({ operationId: c.operationId, committed: false, status: 'pending' });

    const human = await runApp(c, ['git', 'operation', c.operationId, '--project', c.box.projectId]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`run=${c.ids.runId}`);
    expect(human.stdout).toContain('receipt=none');
    expect(human.stdout).toContain('verification_batch:full-check');
    expect(human.stdout).not.toContain('committed=true');
  });

  it('不存在的 operation 折叠 not_found（退出码 1）；非法 operationId 退出码 2', async () => {
    const c = await openCase();
    await startDeliveryHost(c);
    const missing = await runApp(c, ['git', 'operation', randomUUID(), '--project', c.box.projectId, '--json']);
    expect(missing.exitCode).toBe(1);
    expect(missing.envelope.ok).toBe(false);
    expect(missing.envelope.error?.code).toBe('not_found');

    const invalid = await runApp(c, ['git', 'operation', 'not-an-uuid', '--project', c.box.projectId, '--json']);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.envelope.error?.code).toBe('invalid_input');
  });
});

/* ------------------------------------------------------------------ *
 * 最终审批与显式收尾
 * ------------------------------------------------------------------ */

describe('F-011 最终审批与显式收尾命令', () => {
  it('缺 --confirm 在连接前退出码 2（零副作用，不推进收尾）', async () => {
    const c = await openCase();
    await startDeliveryHost(c);
    const before = c.box.snapshot();

    const approve = await runApp(c, [
      'feature', 'final-approve', c.box.featureId, '--project', c.box.projectId,
      '--task', c.ids.taskId, '--item', 'item-1', '--digest', CODE, '--code-digest', CODE,
      '--revision', '1', '--json',
    ]);
    expect(approve.exitCode).toBe(2);
    expect(approve.envelope.ok).toBe(false);
    expect(approve.envelope.error?.code).toBe('invalid_input');
    expect(approve.envelope.error?.details?.reason).toBe('confirmation_required');

    const finalize = await runApp(c, [
      'feature', 'finalize', c.box.featureId, '--project', c.box.projectId,
      '--run', c.ids.runId, '--batch', c.ids.batchId, '--operation', c.operationId,
      '--revision', String(c.featureRevision()), '--json',
    ]);
    expect(finalize.exitCode).toBe(2);
    expect(finalize.envelope.error?.details?.reason).toBe('confirmation_required');

    expect(c.box.snapshot()).toEqual(before);
    expect(c.verify).not.toHaveBeenCalled();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it('final-approve 绑定当前摘要；finalize 先等待批准、批准后完成交付；真实 Git 不变', async () => {
    const c = await openCase();
    await startDeliveryHost(c);
    const headBefore = c.box.box.gitHead('A');

    // 未批准时显式收尾：completed 回执但 outcome=awaiting_approval（不是交付成功）。
    const waiting = await runApp(c, [
      'feature', 'finalize', c.box.featureId, '--project', c.box.projectId,
      '--run', c.ids.runId, '--batch', c.ids.batchId, '--operation', c.operationId,
      '--revision', String(c.featureRevision()), '--confirm', '--json',
    ]);
    expect(waiting.exitCode, `${waiting.stdout}\n${waiting.stderr}`).toBe(0);
    expect(waiting.envelope.command).toBe('feature.finalize');
    expect(waiting.envelope.result).toMatchObject({
      outcome: 'awaiting_approval',
      delivered: false,
      runtimeCalled: false,
      executionStarted: false,
    });
    expect(c.commit).not.toHaveBeenCalled();

    // CLI 最终审批：批准绑定当前计划/代码摘要，不自动运行提交。
    const item = insertApprovalItem(c);
    const approve = await runApp(c, [
      'feature', 'final-approve', c.box.featureId, '--project', c.box.projectId,
      '--task', c.ids.taskId, '--item', item.id,
      '--digest', planDigestOf(c), '--code-digest', CODE,
      '--revision', String(item.revision), '--confirm', '--json',
    ]);
    expect(approve.exitCode, `${approve.stdout}\n${approve.stderr}`).toBe(0);
    expect(approve.envelope.command).toBe('feature.final-approve');
    expect(approve.envelope.result).toMatchObject({
      decision: 'approve',
      item: { id: item.id, status: 'approved' },
      runtimeCalled: false,
      executionStarted: false,
    });
    expect(c.commit).not.toHaveBeenCalled();

    // 批准后再次显式收尾：完成交付（真实 Git 副作用只来自 Host 注入替身）。
    const done = await runApp(c, [
      'feature', 'finalize', c.box.featureId, '--project', c.box.projectId,
      '--run', c.ids.runId, '--batch', c.ids.batchId, '--operation', c.operationId,
      '--revision', String(c.featureRevision()), '--confirm', '--json',
    ]);
    expect(done.exitCode, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.envelope.result).toMatchObject({
      outcome: 'completed',
      deliveryStatus: 'succeeded',
      delivered: true,
      gitOperationId: c.operationId,
    });
    expect(c.verify).toHaveBeenCalledTimes(2);
    expect(c.commit).toHaveBeenCalledTimes(1);
    expect(c.box.box.gitHead('A')).toBe(headBefore);

    // 交付后分轴查询：提交轴显示已核对记录（succeeded + actualParent）。
    const delivery = await runApp(c, ['feature', 'delivery', c.box.featureId, '--project', c.box.projectId, '--json']);
    expect(delivery.exitCode).toBe(0);
    const axes = (delivery.envelope.result as { axes: { delivery: { status: string; operation: { status: string; actualParent: string | null } | null } } }).axes;
    expect(axes.delivery.status).toBe('succeeded');
    expect(axes.delivery.operation?.status).toBe('succeeded');
    expect(axes.delivery.operation?.actualParent).toBe(headBefore);
  });

  it('final-approve 人类行输出：决定绑定摘要，批准不自动运行', async () => {
    const c = await openCase();
    await startDeliveryHost(c);
    const item = insertApprovalItem(c);
    const approveHuman = await runApp(c, [
      'feature', 'final-approve', c.box.featureId, '--project', c.box.projectId,
      '--task', c.ids.taskId, '--item', item.id,
      '--digest', planDigestOf(c), '--code-digest', CODE,
      '--revision', String(item.revision), '--confirm',
    ]);
    expect(approveHuman.exitCode, `${approveHuman.stdout}\n${approveHuman.stderr}`).toBe(0);
    expect(approveHuman.stdout).toContain('feature final-approve');
    expect(approveHuman.stdout).toContain('status=approved');
    expect(approveHuman.stdout).toContain('不自动运行');
  });

  it('陈旧 Feature revision 的 finalize 业务拒绝（退出码 1，保留 commandId）', async () => {
    const c = await openCase();
    await startDeliveryHost(c);
    const rejected = await runApp(c, [
      'feature', 'finalize', c.box.featureId, '--project', c.box.projectId,
      '--run', c.ids.runId, '--batch', c.ids.batchId, '--operation', c.operationId,
      '--revision', String(c.featureRevision() + 1), '--confirm', '--json',
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.envelope.ok).toBe(false);
    expect(rejected.envelope.command).toBe('feature.finalize');
    expect(rejected.envelope.error?.code).toBe('conflict');
    expect(typeof rejected.envelope.error?.details?.reason).toBe('string');
    expect(c.verify).not.toHaveBeenCalled();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it('未装配 delivery 能力的 Host 明确 unsupported（退出码 1）', async () => {
    const c = await openCase();
    await startDeliveryHost(c, false);
    const outcome = await runApp(c, [
      'feature', 'finalize', c.box.featureId, '--project', c.box.projectId,
      '--run', c.ids.runId, '--batch', c.ids.batchId, '--operation', c.operationId,
      '--revision', String(c.featureRevision()), '--confirm', '--json',
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.envelope.ok).toBe(false);
    expect(outcome.envelope.error?.code).toBe('unsupported');
  });
});
