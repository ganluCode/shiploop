/**
 * P03-8 / F-011 Feature 交付 CLI 纯面层：分轴结果/Git 操作查询与显式审批/收尾
 * 命令的参数解析、状态展示折算、退出码纪律与帮助边界（无 I/O）。
 *
 * 验收面（.dag_context.json F-011）：
 * 1. 参数解析与非交互确认复用当前模板：缺 --confirm 或输入非法在任何 I/O 之前
 *    拒绝（不推进收尾）；审批绑定当前计划/代码摘要；伪造主体/凭据/ Git 身份
 *    参数在解析层即未知参数；
 * 2. 状态折算：所有 Task 通过但最终失败、等待批准、no_change 与待核对
 *    （pending/unknown）绝不显示为 completed/已提交；保留 Feature/Run/
 *    operation 与证据引用；
 * 3. 帮助说明明确审批不自动运行、失败现场保留、只支持获准最终提交、不提供
 *    P03-9 新 Run 收尾重试控制；开发机绝对路径不进入生产源码。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppCliParseError, parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import {
  buildFeatureDeliveryView,
  buildFeatureFinalApprovalView,
  buildFeatureFinalizeView,
  buildGitOperationDetailView,
  buildGitOperationListView,
  formatFeatureDeliveryView,
  formatFeatureFinalApprovalView,
  formatFeatureFinalizeView,
  formatGitOperationDetailView,
  formatGitOperationListView,
  gitOperationCommitted,
} from '../../../packages/cli/src/app/delivery.ts';
import { getAppCliHelp } from '../../../packages/cli/src/app/help.ts';
import type {
  FeatureDeliveryCommandResult,
  FeatureDeliveryDetailResult,
  GitOperationDetailResult,
  GitOperationListResult,
  PublicGitOperationRecord,
} from '../../../packages/host/src/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'ab'.repeat(32);
const DIGEST_2 = 'cd'.repeat(32);
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
const ISO = '2026-10-18T00:00:00.000Z';

function parseError(args: readonly string[]): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error).toBeInstanceOf(AppCliParseError);
    return error as AppCliParseError;
  }
  throw new Error(`预期解析失败：${args.join(' ')}`);
}

/* ------------------------------------------------------------------ *
 * 线形状夹具（HostClient 已线校验的公开投影；逐字段构造，不走 I/O）
 * ------------------------------------------------------------------ */

function gitRecord(overrides: Partial<PublicGitOperationRecord>): PublicGitOperationRecord {
  return {
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    featureId: 'f-1',
    runId: RUN_ID,
    attemptId: null,
    executionVersion: 1,
    operationType: 'feature_final_commit',
    intentDigest: DIGEST,
    repositoryBindingId: 'binding-1',
    repoIdentity: 'repo-identity-1',
    expectedHead: HEAD,
    candidateTree: TREE,
    codeDigest: DIGEST_2,
    actualCommit: null,
    actualTree: null,
    actualParent: null,
    verificationRefs: [{ kind: 'verification_batch', id: 'vb-1', digest: DIGEST }],
    approvalRefs: [],
    message: 'delivery',
    gitIdentity: { name: 'Configured Git User', email: 'git@example.test', confirmed: true },
    deliveryPolicyDigest: DIGEST,
    runtimeSource: null,
    status: 'pending',
    exitCode: null,
    durationMs: null,
    reasonCode: null,
    deliveryStatus: null,
    receipt: null,
    settledAt: null,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function deliveryResult(
  overrides: {
    readonly tasksAllPassed?: boolean;
    readonly verificationStatus?: 'none' | 'running' | 'passed' | 'failed' | 'error' | 'inconclusive';
    readonly approvalStatus?: 'none' | 'pending' | 'approved' | 'rejected' | 'blocked' | 'stale';
    readonly deliveryStatus?: 'not_requested' | 'pending' | 'succeeded' | 'failed';
    readonly operation?: PublicGitOperationRecord | null;
    readonly outcome: FeatureDeliveryDetailResult['outcome']['status'];
    readonly stage?: FeatureDeliveryDetailResult['outcome']['executionStage'];
    readonly nextStep?: FeatureDeliveryDetailResult['outcome']['nextStep'];
  },
): FeatureDeliveryDetailResult {
  const allPassed = overrides.tasksAllPassed ?? true;
  return {
    schemaVersion: 5,
    scope: 'feature-delivery',
    feature: {
      featureId: 'f-1',
      status: 'running',
      deliveryStatus: overrides.deliveryStatus ?? 'not_requested',
      planStatus: 'approved',
      planDigest: DIGEST,
      revision: 3,
      updatedAt: ISO,
    },
    run: { id: RUN_ID, batchId: BATCH_ID, status: 'running', reason: null, startedAt: ISO, endedAt: null },
    axes: {
      tasks: {
        total: 2,
        passed: allPassed ? 2 : 1,
        allPassed,
        records: [
          { taskId: 't-1', status: 'passed', effectivePassed: true, manualBlock: false, firstPassedAt: ISO, latestAttemptId: null },
          { taskId: 't-2', status: allPassed ? 'passed' : 'running', effectivePassed: allPassed, manualBlock: false, firstPassedAt: allPassed ? ISO : null, latestAttemptId: null },
        ],
      },
      verification: { status: overrides.verificationStatus ?? 'failed', batch: null },
      approval: { status: overrides.approvalStatus ?? 'none', reason: null, items: [], itemsTruncated: false },
      delivery: { status: overrides.deliveryStatus ?? 'not_requested', operation: overrides.operation ?? null },
    },
    outcome: {
      status: overrides.outcome,
      executionStage: overrides.stage ?? (overrides.outcome === 'completed' ? null : 'feature_verification'),
      reason: `reason_${overrides.outcome}`,
      nextStep: overrides.nextStep ?? 'none',
      identities: {
        featureId: 'f-1',
        runId: RUN_ID,
        batchId: BATCH_ID,
        verificationBatchId: null,
        gitOperationId: overrides.operation?.operationId ?? null,
      },
    },
  };
}

function finalizeResult(
  outcome: FeatureDeliveryCommandResult['outcome'],
  deliveryStatus: FeatureDeliveryCommandResult['deliveryStatus'],
): FeatureDeliveryCommandResult {
  return {
    featureId: 'f-1',
    runId: RUN_ID,
    batchId: BATCH_ID,
    gitOperationId: OPERATION_ID,
    outcome,
    reason: `reason_${outcome}`,
    deliveryStatus,
    runtimeCalled: false,
    executionStarted: false,
  };
}

/* ------------------------------------------------------------------ *
 * 1. 新命令参数映射（纯解析，无 I/O）
 * ------------------------------------------------------------------ */

describe('F-011 新命令参数映射（纯解析，无 I/O）', () => {
  it('feature delivery / git operations / git operation 映射冻结查询参数', () => {
    const delivery = parseAppCliArgs(['feature', 'delivery', 'f-1', '--project', PROJECT_ID, '--json'], {});
    expect(delivery).toMatchObject({
      kind: 'command',
      command: 'feature',
      commandId: 'feature.delivery',
      projectId: PROJECT_ID,
      featureId: 'f-1',
      json: true,
    });

    const list = parseAppCliArgs(
      ['git', 'operations', '--project', PROJECT_ID, '--feature', 'f-1', '--limit', '20', '--cursor', 'plcur_v1_x'],
      {},
    );
    expect(list).toMatchObject({
      kind: 'command',
      command: 'git',
      commandId: 'git.operations',
      projectId: PROJECT_ID,
      featureId: 'f-1',
      limit: 20,
      cursor: 'plcur_v1_x',
    });
    expect(list).not.toHaveProperty('runId');

    const byRun = parseAppCliArgs(['git', 'operations', '--project', PROJECT_ID, '--run', RUN_ID], {});
    expect(byRun).toMatchObject({ commandId: 'git.operations', runId: RUN_ID });
    expect(byRun).not.toHaveProperty('featureId');

    const detail = parseAppCliArgs(['git', 'operation', OPERATION_ID, '--project', PROJECT_ID], {});
    expect(detail).toMatchObject({
      kind: 'command',
      command: 'git',
      commandId: 'git.operation',
      projectId: PROJECT_ID,
      operationId: OPERATION_ID,
    });
  });

  it('feature final-approve 绑定当前计划/代码摘要且必须 --confirm', () => {
    const parsed = parseAppCliArgs(
      [
        'feature', 'final-approve', 'f-1', '--project', PROJECT_ID,
        '--task', 't-1', '--item', 'item-1',
        '--digest', DIGEST, '--code-digest', DIGEST_2, '--revision', '2',
        '--reason', '复核通过', '--artifact', `art-1:${DIGEST}`, '--confirm',
        '--command-id', COMMAND_ID, '--json',
      ],
      {},
    );
    expect(parsed).toMatchObject({
      kind: 'command',
      command: 'feature',
      commandId: 'feature.final-approve',
      operation: 'task.approval.approve',
      projectId: PROJECT_ID,
      featureId: 'f-1',
      taskId: 't-1',
      itemId: 'item-1',
      planDigest: DIGEST,
      codeDigest: DIGEST_2,
      revision: 2,
      confirm: true,
      artifactRefs: [`art-1:${DIGEST}`],
      explicitCommandId: COMMAND_ID,
    });
  });

  it('feature finalize 映射显式收尾身份且必须 --confirm', () => {
    const parsed = parseAppCliArgs(
      [
        'feature', 'finalize', 'f-1', '--project', PROJECT_ID,
        '--run', RUN_ID, '--batch', BATCH_ID, '--operation', OPERATION_ID,
        '--revision', '3', '--confirm', '--command-id', COMMAND_ID,
      ],
      {},
    );
    expect(parsed).toMatchObject({
      kind: 'command',
      command: 'feature',
      commandId: 'feature.finalize',
      operation: 'feature.verification.continue',
      projectId: PROJECT_ID,
      featureId: 'f-1',
      runId: RUN_ID,
      batchId: BATCH_ID,
      operationId: OPERATION_ID,
      revision: 3,
      confirm: true,
      explicitCommandId: COMMAND_ID,
    });
  });
});

describe('F-011 缺确认/非法输入在连接前拒绝（不推进收尾）', () => {
  it('final-approve / finalize 缺 --confirm 本地拒绝（confirmation_required）', () => {
    for (const args of [
      ['feature', 'final-approve', 'f-1', '--project', PROJECT_ID, '--task', 't-1', '--item', 'i-1', '--digest', DIGEST, '--code-digest', DIGEST_2, '--revision', '1'],
      ['feature', 'finalize', 'f-1', '--project', PROJECT_ID, '--run', RUN_ID, '--batch', BATCH_ID, '--operation', OPERATION_ID, '--revision', '1'],
    ]) {
      const error = parseError(args);
      expect(error.reason).toBe('confirmation_required');
      expect(error.code).toBe('invalid_input');
    }
  });

  it('摘要/revision/Run/Batch/operation 身份非法在连接前拒绝', () => {
    expect(parseError(['feature', 'final-approve', 'f-1', '--project', PROJECT_ID, '--task', 't-1', '--item', 'i-1', '--digest', 'zz', '--code-digest', DIGEST_2, '--revision', '1', '--confirm']).reason).toBe('invalid_plan_digest');
    expect(parseError(['feature', 'final-approve', 'f-1', '--project', PROJECT_ID, '--task', 't-1', '--item', 'i-1', '--digest', DIGEST, '--code-digest', 'short', '--revision', '1', '--confirm']).reason).toBe('invalid_digest');
    expect(parseError(['feature', 'final-approve', 'f-1', '--project', PROJECT_ID, '--task', 't-1', '--item', 'i-1', '--digest', DIGEST, '--code-digest', DIGEST_2, '--revision', '0', '--confirm']).reason).toBe('invalid_revision');
    expect(parseError(['feature', 'finalize', 'f-1', '--project', PROJECT_ID, '--run', 'not-run', '--batch', BATCH_ID, '--operation', OPERATION_ID, '--revision', '1', '--confirm']).reason).toBe('invalid_run_id');
    expect(parseError(['feature', 'finalize', 'f-1', '--project', PROJECT_ID, '--run', RUN_ID, '--batch', 'not-batch', '--operation', OPERATION_ID, '--revision', '1', '--confirm']).reason).toBe('invalid_batch_id');
    expect(parseError(['feature', 'finalize', 'f-1', '--project', PROJECT_ID, '--run', RUN_ID, '--batch', BATCH_ID, '--operation', 'not-op', '--revision', '1', '--confirm']).reason).toBe('invalid_operation_id');
    expect(parseError(['git', 'operation', 'not-an-uuid', '--project', PROJECT_ID]).reason).toBe('invalid_operation_id');
  });

  it('git operations 父级缺失或同现本地拒绝；缺 --project 拒绝', () => {
    expect(parseError(['git', 'operations', '--project', PROJECT_ID]).reason).toBe('missing_required_option');
    expect(parseError(['git', 'operations', '--project', PROJECT_ID, '--feature', 'f-1', '--run', RUN_ID]).reason).toBe('conflicting_options');
    expect(parseError(['git', 'operations', '--feature', 'f-1']).reason).toBe('missing_required_option');
    expect(parseError(['feature', 'finalize', 'f-1', '--run', RUN_ID, '--batch', BATCH_ID, '--operation', OPERATION_ID, '--revision', '1', '--confirm']).reason).toBe('missing_required_option');
  });

  it('伪造主体/凭据/Git 身份参数在解析层即未知参数', () => {
    for (const flag of ['--actor', '--principal-id', '--decision-actor', '--token', '--password', '--git-name', '--git-email']) {
      const error = parseError([
        'feature', 'final-approve', 'f-1', '--project', PROJECT_ID, '--task', 't-1', '--item', 'i-1',
        '--digest', DIGEST, '--code-digest', DIGEST_2, '--revision', '1', '--confirm', flag, 'x',
      ]);
      expect(error.reason, flag).toBe('unknown_argument');
    }
    const finalizeForgery = parseError([
      'feature', 'finalize', 'f-1', '--project', PROJECT_ID, '--run', RUN_ID, '--batch', BATCH_ID,
      '--operation', OPERATION_ID, '--revision', '1', '--confirm', '--git-identity', 'x',
    ]);
    expect(finalizeForgery.reason).toBe('unknown_argument');
  });
});

/* ------------------------------------------------------------------ *
 * 2. 状态折算：非完成绝不显示为 completed/已提交
 * ------------------------------------------------------------------ */

describe('F-011 Feature 分轴结果视图折算', () => {
  it('completed 恒等于 outcome.status；最终失败/等待批准/待核对/no_change 都不是 completed', () => {
    const completed = buildFeatureDeliveryView(deliveryResult({ outcome: 'completed', deliveryStatus: 'succeeded' }));
    expect(completed.completed).toBe(true);

    for (const outcome of [
      'in_progress',
      'tasks_failed',
      'final_verification_failed',
      'awaiting_approval',
      'delivery_uncertain',
      'delivery_failed',
      'committed_but_blocked',
      'evidence_incomplete',
    ] as const) {
      const view = buildFeatureDeliveryView(deliveryResult({ outcome }));
      expect(view.completed, outcome).toBe(false);
      const human = formatFeatureDeliveryView(view);
      expect(human, outcome).toContain('completed=false');
      expect(human, outcome).not.toContain('交付完成');
    }
  });

  it('所有 Task 通过但最终失败保留分轴与身份，不冒充交付', () => {
    const view = buildFeatureDeliveryView(
      deliveryResult({ outcome: 'final_verification_failed', stage: 'feature_verification', nextStep: 'rework_authorization' }),
    );
    expect(view.axes.tasks.allPassed).toBe(true);
    expect(view.completed).toBe(false);
    const human = formatFeatureDeliveryView(view);
    expect(human).toContain('outcome=final_verification_failed');
    expect(human).toContain('passed=2/2');
    expect(human).toContain('verification');
    expect(human).toContain('approval');
    expect(human).toContain('delivery');
    expect(human).toContain(RUN_ID);
    expect(human).toContain(BATCH_ID);
    expect(human).toContain('nextStep=rework_authorization');
    expect(human).not.toContain('交付完成');
  });

  it('等待批准与待核对明确展示，completed=false', () => {
    const awaiting = buildFeatureDeliveryView(
      deliveryResult({ outcome: 'awaiting_approval', stage: 'final_approval', approvalStatus: 'pending', nextStep: 'feature_approval_decision' }),
    );
    expect(awaiting.completed).toBe(false);
    expect(formatFeatureDeliveryView(awaiting)).toContain('outcome=awaiting_approval');

    const uncertain = buildFeatureDeliveryView(
      deliveryResult({
        outcome: 'delivery_uncertain',
        stage: 'git_delivery',
        deliveryStatus: 'pending',
        operation: gitRecord({ status: 'unknown', deliveryStatus: 'pending' }),
        nextStep: 'git_operation_reconcile',
      }),
    );
    expect(uncertain.completed).toBe(false);
    const human = formatFeatureDeliveryView(uncertain);
    expect(human).toContain('outcome=delivery_uncertain');
    expect(human).toContain('status=pending');
  });
});

describe('F-011 Git 操作视图折算', () => {
  it('pending/unknown/no_change/failed 都不是已提交；succeeded 需核对 parent 与 deliveryStatus', () => {
    expect(gitOperationCommitted(gitRecord({ status: 'pending' }))).toBe(false);
    expect(gitOperationCommitted(gitRecord({ status: 'unknown', deliveryStatus: 'pending' }))).toBe(false);
    expect(gitOperationCommitted(gitRecord({ status: 'no_change', deliveryStatus: 'succeeded' }))).toBe(false);
    expect(gitOperationCommitted(gitRecord({ status: 'failed', deliveryStatus: 'failed', reasonCode: 'hook_modified_source' }))).toBe(false);
    expect(gitOperationCommitted(gitRecord({ status: 'succeeded', deliveryStatus: 'succeeded', actualCommit: COMMIT, actualParent: null }))).toBe(false);
    expect(gitOperationCommitted(gitRecord({ status: 'succeeded', deliveryStatus: 'succeeded', actualCommit: COMMIT, actualParent: HEAD }))).toBe(true);
  });

  it('列表与详情保留 Feature/Run/operation 与证据引用；待核对不显示为成功', () => {
    const pendingRecord = gitRecord({ status: 'pending' });
    const list = buildGitOperationListView({
      schemaVersion: 5,
      scope: 'git-operation-list',
      records: [pendingRecord],
      nextCursor: null,
      limit: 100,
    } as unknown as GitOperationListResult);
    expect(list.records).toHaveLength(1);
    expect(list.records[0]?.committed).toBe(false);
    const listHuman = formatGitOperationListView(list);
    expect(listHuman).toContain(OPERATION_ID);
    expect(listHuman).toContain('status=pending');
    expect(listHuman).not.toContain('committed=true');

    const detail = buildGitOperationDetailView({ operation: pendingRecord } as unknown as GitOperationDetailResult);
    expect(detail.record.operationId).toBe(OPERATION_ID);
    expect(detail.record.committed).toBe(false);
    const detailHuman = formatGitOperationDetailView(detail);
    expect(detailHuman).toContain('feature=f-1');
    expect(detailHuman).toContain(`run=${RUN_ID}`);
    expect(detailHuman).toContain('verification_batch:vb-1');
    expect(detailHuman).toContain('receipt=none');
    expect(detailHuman).not.toContain('committed=true');
  });
});

describe('F-011 显式审批与收尾结果视图', () => {
  it('final-approve completed 回执：决定绑定摘要，批准不自动运行', () => {
    const view = buildFeatureFinalApprovalView(COMMAND_ID, false, {
      taskId: 't-1',
      item: {
        id: 'item-1', projectId: PROJECT_ID, featureId: 'f-1', taskId: 't-1', revision: 2,
        kind: 'approval', description: 'final review', responsibleParty: 'owner',
        planDigest: DIGEST, codeDigest: DIGEST_2, artifactRefs: [],
        status: 'approved', createdBy: 'local-owner', decision: 'approve',
        decisionActor: 'local-owner', decisionReason: '复核通过', decisionCodeDigest: DIGEST_2,
        decisionArtifactRefs: [], decidedAtUtcMs: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1,
      },
      decision: 'approve',
      executionStarted: false,
      runtimeCalled: false,
    });
    expect(view.item.status).toBe('approved');
    expect(view.item.planDigest).toBe(DIGEST);
    const human = formatFeatureFinalApprovalView(view);
    expect(human).toContain('feature final-approve');
    expect(human).toContain('status=approved');
    expect(human).toContain('不自动运行');
  });

  it('finalize completed 回执：等待批准/失败/部分完成都不是交付成功', () => {
    for (const [outcome, deliveryStatus] of [
      ['awaiting_approval', 'not_requested'],
      ['failed', 'failed'],
      ['partial', 'failed'],
    ] as const) {
      const view = buildFeatureFinalizeView(COMMAND_ID, false, finalizeResult(outcome, deliveryStatus));
      expect(view.delivered, outcome).toBe(false);
      const human = formatFeatureFinalizeView(view);
      expect(human, outcome).toContain('delivered=false');
      expect(human, outcome).not.toContain('交付完成');
    }
    const done = buildFeatureFinalizeView(COMMAND_ID, true, finalizeResult('completed', 'succeeded'));
    expect(done.delivered).toBe(true);
    expect(done.replayed).toBe(true);
    const human = formatFeatureFinalizeView(done);
    expect(human).toContain('delivered=true');
    expect(human).toContain(OPERATION_ID);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 帮助与范围说明
 * ------------------------------------------------------------------ */

describe('F-011 帮助与范围说明', () => {
  it('帮助明确审批不自动运行、失败现场保留、只支持获准最终提交、无 P03-9 新 Run 重试', () => {
    for (const scope of ['feature', 'feature.final-approve', 'feature.finalize', 'feature.delivery', 'git', 'git.operations', 'git.operation'] as const) {
      const help = getAppCliHelp(scope);
      expect(help.length, scope).toBeGreaterThan(20);
      expect(help.endsWith('\n'), scope).toBe(true);
    }
    const finalizeHelp = getAppCliHelp('feature.finalize');
    expect(finalizeHelp).toContain('--confirm');
    expect(finalizeHelp).toContain('不自动');
    expect(finalizeHelp).toContain('保留现场');
    expect(finalizeHelp).toContain('获准');
    expect(getAppCliHelp('feature.final-approve')).toContain('不自动运行');
    expect(getAppCliHelp('feature')).toContain('final-approve');
    expect(getAppCliHelp('feature')).toContain('finalize');
    expect(getAppCliHelp('feature')).toContain('delivery');
    // 不添加 P03-9 新 Run 收尾重试控制：帮助不出现新 Run 重试入口。
    for (const scope of ['feature.finalize', 'feature.delivery', 'git'] as const) {
      expect(getAppCliHelp(scope)).not.toContain('--retry-batch');
    }
  });

  it('生产源码与帮助不含开发机绝对路径', () => {
    const cliSrc = join(repoRoot, 'packages/cli/src');
    const stack: string[] = [cliSrc];
    const files: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current)) {
        const absolute = join(current, entry);
        if (statSync(absolute).isDirectory()) stack.push(absolute);
        else if (entry.endsWith('.ts')) files.push(absolute);
      }
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\/Users\//);
    }
  });
});
