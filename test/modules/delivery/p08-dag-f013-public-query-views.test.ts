/**
 * P08 / F-013：DAG 公共查询展示上下文、结构化错误与通知投影的线协议/CLI 单元验证。
 *
 * 覆盖（纯契约层，不触库；真实 SQLite 投影见 p08-dag-f013-delivery-context.test.ts）：
 * - features.delivery.get 公开结果同时携带稳定层级编码/名称/branchName、
 *   冻结起点 SHA、直接前置交付 SHA、集成身份/状态/证据、merge order 与
 *   后继阻塞原因；UUID 保留用于精确追踪；
 * - Host wire 校验接受新字段并拒绝越权形状（未知键/坏编码/路径泄漏）；
 * - integration.plan.get 携带 successor/predecessor 展示上下文；
 * - git.operations.get / git.repairs.get 可选 featureDisplay（未装配缺省）；
 * - CLI 人类行输出展示编码与 DAG 事实，并输出真实换行（修复历史 '\\n' 缺陷）；
 * - 通知订阅覆盖 integration pending/succeeded/failed/manual hold 与修复结果，
 *   摘要只含冻结身份与受控状态/原因，不复制 payload 原文/路径/凭据。
 */
import { describe, expect, it } from 'vitest';
import { buildFeatureDeliveryDetailResult, type FeatureDeliveryView } from '../../../packages/core/src/ports/feature-delivery-query.ts';
import { buildIntegrationPlanQueryResult, type IntegrationPlanQueryView } from '../../../packages/core/src/ports/integration-plan-query.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/index.ts';
import { validateGitOperationDetailResultWire, validateGitAgentRepairQueryResultWire } from '../../../packages/host/src/client/app-wire.ts';
import {
  buildFeatureDeliveryView,
  formatFeatureDeliveryView,
  buildIntegrationPlanCliView,
  formatIntegrationPlanView,
  buildGitOperationDetailView,
  formatGitOperationDetailView,
  buildGitAgentRepairView,
  formatGitAgentRepairView,
} from '../../../packages/cli/src/app/delivery.ts';
import {
  NOTIFICATION_SUBSCRIPTION_EVENT_TYPES,
  deriveNotificationSummary,
} from '../../../packages/core/src/ports/notification-delivery.ts';
import { INTEGRATION_PLAN_STATUS_EVENT_TYPE, GIT_REPAIR_STATUS_EVENT_TYPE } from '../../../packages/core/src/ports/events.ts';
import type { PublicStateEvent } from '../../../packages/core/src/ports/events.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_D = 'd'.repeat(40);
const DIGEST = 'e'.repeat(64);
const ISO = '2026-11-10T00:00:00.000Z';
const PROJECT = '00000000-0000-4000-8000-0000000000f1';

function deliveryView(): FeatureDeliveryView {
  return {
    feature: {
      projectId: PROJECT,
      featureId: 'feature-c',
      status: 'completed',
      deliveryStatus: 'succeeded',
      planStatus: 'approved',
      planDigest: DIGEST,
      revision: 7,
      updatedAtUtcMs: 1,
      title: 'C 集成收尾',
      branchName: 'feat/p07/f03-c-closeout',
      phaseId: 'phase-1',
      phaseTitle: 'P07 修复',
      displayCode: 'P07-F03',
      phaseDisplayCode: 'P07',
    },
    tasks: [
      { taskId: 'T001', status: 'passed', manualBlock: false, firstPassedAtUtcMs: 1, latestAttemptId: null },
    ],
    run: null,
    batch: null,
    verification: null,
    gitOperation: null,
    approvalItems: [],
    approvalItemsTruncated: false,
    dag: {
      frozenBaseCommit: SHA_D,
      predecessors: [
        { featureId: 'feature-a', displayCode: 'P07-F01', title: 'A 基线', commitSha: SHA_A, evidenceId: 'evidence-a', evidenceDigest: DIGEST },
        { featureId: 'feature-b', displayCode: 'P07-F02', title: 'B 并行', commitSha: SHA_B, evidenceId: null, evidenceDigest: null },
      ],
      integrations: [
        { integrationId: 'integration-1', status: 'integration_passed', inputDigest: DIGEST, targetBaseline: SHA_D, mergeOrder: ['feature-a', 'feature-b'], commitSha: SHA_D, evidenceId: 'evidence-i' },
      ],
      successors: [
        { featureId: 'feature-e', displayCode: 'P07-F04', title: 'E 后继', integrationId: 'integration-2', status: 'blocked', blockReasons: ['ancestor_not_verified'] },
      ],
    },
  };
}

describe('P08 F-013 public query display context', () => {
  it('[case:f013-feature-delivery-dag-projection] carries codes, branch, frozen base, predecessor deliveries and successor blockers', () => {
    const result = buildFeatureDeliveryDetailResult(deliveryView());
    expect(result.feature).toMatchObject({
      featureId: 'feature-c', displayCode: 'P07-F03', title: 'C 集成收尾',
      branchName: 'feat/p07/f03-c-closeout', phaseDisplayCode: 'P07', phaseTitle: 'P07 修复',
    });
    expect(result.dag.frozenBaseCommit).toBe(SHA_D);
    expect(result.dag.predecessors.map(p => [p.displayCode, p.commitSha])).toEqual([
      ['P07-F01', SHA_A], ['P07-F02', SHA_B],
    ]);
    expect(result.dag.integrations[0]).toMatchObject({ integrationId: 'integration-1', status: 'integration_passed', mergeOrder: ['feature-a', 'feature-b'] });
    expect(result.dag.successors[0]).toMatchObject({ featureId: 'feature-e', status: 'blocked', blockReasons: ['ancestor_not_verified'] });
  });

  it('[case:f013-feature-delivery-wire] validates the frozen field set and rejects leaked or malformed display fields', () => {
    const result = buildFeatureDeliveryDetailResult(deliveryView());
    expect(() => validateAppQueryResponse('features.delivery.get', result)).not.toThrow();
    expect(validateAppQueryResponse('features.delivery.get', result).feature.displayCode).toBe('P07-F03');
    expect(() => validateAppQueryResponse('features.delivery.get', { ...result, worktreePath: '/private/worktree' })).toThrow();
    expect(() => validateAppQueryResponse('features.delivery.get', {
      ...result,
      feature: { ...result.feature, displayCode: '/Users/leak' },
    })).toThrow();
    expect(() => validateAppQueryResponse('features.delivery.get', {
      ...result,
      dag: { ...result.dag, predecessors: [{ ...result.dag.predecessors[0]!, canonicalPath: '/private/repo' }] },
    })).toThrow();
    expect(() => validateAppQueryResponse('features.delivery.get', {
      ...result,
      dag: { ...result.dag, frozenBaseCommit: 'not-a-sha' },
    })).toThrow();
  });

  it('[case:f013-feature-delivery-cli] prints codes, branch and DAG facts with real newlines', () => {
    const text = formatFeatureDeliveryView(buildFeatureDeliveryView(buildFeatureDeliveryDetailResult(deliveryView())));
    expect(text).toContain('code=P07-F03');
    expect(text).toContain('branch=feat/p07/f03-c-closeout');
    expect(text).toContain('frozenBase=');
    expect(text).toContain('predecessor P07-F01 A 基线');
    expect(text).toContain('mergeOrder=feature-a,feature-b');
    expect(text).toContain('successor P07-F04 E 后继');
    expect(text).toContain('blockReasons=ancestor_not_verified');
    expect(text).not.toContain('\\n');
    expect(text.split('\n').length).toBeGreaterThan(6);
  });

  it('[case:f013-integration-plan-display] exposes successor/predecessor display contexts on the wire', () => {
    const view: IntegrationPlanQueryView = {
      plan: {
        schemaVersion: 1,
        integrationId: 'integration-1',
        projectId: PROJECT,
        phaseId: 'phase-1',
        batchId: 'batch-1',
        successorFeatureId: 'feature-c',
        targetBaseline: SHA_D,
        mode: 'merge_multiple_predecessors',
        status: 'dependency_passed',
        inputDigest: DIGEST,
        mergeOrder: ['feature-a', 'feature-b'],
        verificationScope: ['typecheck'],
        strategySummary: { conflictPolicy: 'deterministic-only' },
        coverage: { approvedInputCount: 2, coveredInputCount: 2, complete: true, missingInputIds: [] },
        blockReasons: [],
        staleReasons: [],
        revision: 2,
        createdAtUtcMs: 1,
        updatedAtUtcMs: 2,
        frozenAtUtcMs: 2,
      },
      predecessors: [
        { featureId: 'feature-a', dependencyPassed: true, commitSha: SHA_A, evidenceId: 'evidence-a', evidenceDigest: DIGEST, coveredInputIds: ['input-a'], ancestorVerified: true },
      ],
      integrationResult: null,
      display: {
        successor: {
          featureId: 'feature-c', displayCode: 'P07-F03', title: 'C 集成收尾',
          branchName: 'feat/p07/f03-c-closeout', phaseId: 'phase-1', phaseDisplayCode: 'P07', phaseTitle: 'P07 修复',
        },
        predecessors: [{ featureId: 'feature-a', displayCode: 'P07-F01', title: 'A 基线' }],
      },
    };
    const result = buildIntegrationPlanQueryResult(view);
    expect(result.display?.successor.displayCode).toBe('P07-F03');
    expect(() => validateAppQueryResponse('integration.plan.get', result)).not.toThrow();
    const cli = formatIntegrationPlanView(buildIntegrationPlanCliView(result));
    expect(cli).toContain('successor P07-F03 C 集成收尾 branch=feat/p07/f03-c-closeout');
    expect(cli).toContain('predecessor P07-F01 A 基线 (feature-a)');
    expect(cli.split('\n').length).toBeGreaterThan(5);
    expect(() => validateAppQueryResponse('integration.plan.get', {
      ...result,
      display: { successor: { ...result.display!.successor, worktreePath: '/private/wt' }, predecessors: [] },
    })).toThrow();
  });

  it('[case:f013-git-operation-repair-display] accepts optional featureDisplay and keeps redaction invariants', () => {
    const display = {
      featureId: 'feature-c', displayCode: 'P07-F03', title: 'C 集成收尾', branchName: 'feat/p07/f03-c-closeout',
      phaseId: 'phase-1', phaseDisplayCode: 'P07', phaseTitle: 'P07 修复',
    };
    const operation = {
      operationId: 'operation-1', projectId: PROJECT, featureId: 'feature-c', runId: 'run-1',
      attemptId: null, executionVersion: 1, operationType: 'feature_final_commit', intentDigest: DIGEST,
      repositoryBindingId: 'binding-1', repoIdentity: 'repo-1', expectedHead: SHA_A,
      candidateTree: SHA_A, codeDigest: DIGEST, actualCommit: SHA_A,
      actualTree: SHA_A, actualParent: SHA_A, verificationRefs: [], approvalRefs: [], message: 'commit',
      gitIdentity: { name: 'Test User', email: 'test@example.test', confirmed: true },
      deliveryPolicyDigest: DIGEST, runtimeSource: null, status: 'succeeded', exitCode: 0,
      durationMs: 1, reasonCode: null, deliveryStatus: 'succeeded', receipt: {
        schemaVersion: 1, operationId: 'operation-1', status: 'succeeded', intentDigest: DIGEST,
        expectedHead: SHA_A, candidateTree: SHA_A, actualCommit: SHA_A, actualTree: SHA_A,
        exitCode: 0, durationMs: 1, reasonCode: null, integrationResult: null, recoveryState: null,
        workspacePreserved: false, deliveryStatus: 'succeeded', recordedAtUtcMs: 1,
      }, settledAt: ISO,
      revision: 1, createdAt: ISO, updatedAt: ISO, integration: null, featureDisplay: display,
    };
    const detail = validateGitOperationDetailResultWire({ operation });
    expect(detail.operation.featureDisplay?.displayCode).toBe('P07-F03');
    expect(formatGitOperationDetailView(buildGitOperationDetailView(detail))).toContain('featureDisplay code=P07-F03');
    // 未装配展示读取：字段缺省不阻塞既有投影。
    const bare = { ...operation, featureDisplay: undefined };
    expect(() => validateGitOperationDetailResultWire({ operation: bare })).not.toThrow();
    expect(() => validateGitOperationDetailResultWire({
      operation: { ...operation, featureDisplay: { ...display, branchName: '/Users/leak' } },
    })).toThrow();

    const repair = {
      repairId: 'repair-1', projectId: PROJECT, featureId: 'feature-c', parentBatchId: 'batch-1',
      sourceOperationId: 'operation-1', runId: 'run-1', authorizationDigest: DIGEST, authorizationVersion: 1,
      blockedReason: null, source: { failureKind: 'conflict', evidenceId: 'evidence-1', inputDigest: DIGEST },
      target: { repoIdentity: 'repo-1', baselineCommitSha: SHA_A }, workspaceId: 'workspace-1',
      conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'], intentId: 'intent-1',
      verificationStrategyId: 'verify-1', budget: { remainingAttempts: 1, remainingTokens: 10, remainingRuntimeMs: 100, deadline: ISO },
      attempts: [], sourceOperation: null, candidateOperation: null, featureDisplay: display,
    };
    const repairDetail = validateGitAgentRepairQueryResultWire({ schemaVersion: 5, repair }, 'git.repairs.get');
    expect(formatGitAgentRepairView(buildGitAgentRepairView(repairDetail as never)).toString()).toContain('featureDisplay=P07-F03 C 集成收尾');
    expect(() => validateGitAgentRepairQueryResultWire({
      schemaVersion: 5, repair: { ...repair, featureDisplay: { ...display, title: '' } },
    }, 'git.repairs.get')).toThrow();
  });

  it('[case:f013-phase-graph-display-code] accepts optional stable codes on graph records', () => {
    const phase = {
      id: 'phase-1', projectId: PROJECT, title: 'P07 修复', description: null, labels: [],
      status: 'open', revision: 1, createdAt: ISO, updatedAt: ISO, displayCode: 'P07',
    };
    const feature = {
      id: 'feature-c', projectId: PROJECT, phaseId: 'phase-1', title: 'C', description: null, labels: [],
      status: 'draft', planStatus: 'draft', planDigest: null, sourceRefs: [], revision: 1,
      createdAt: ISO, updatedAt: ISO, branchName: 'feat/p07/f03-c', displayCode: 'P07-F03',
    };
    const graph = {
      schemaVersion: 5, scope: 'phase-graph', phase,
      features: [feature], dependencies: [],
      readiness: [{
        featureId: 'feature-c', dependencyCompleted: true, dependencyCompletion: 'complete',
        integrationReady: false, dependencyIntegrationReady: false, ready: false, reason: 'integration_not_ready',
        blockers: ['no_tasks', 'plan_not_approved', 'integration_not_ready'], dependencyStaleReasons: [], dependencyBlockReasons: [],
      }],
      readyFeatureIds: [], executableFeatureIds: [], nextCursor: null, limit: 50,
    };
    const result = validateAppQueryResponse('phases.graph.get', graph);
    expect(result.phase.displayCode).toBe('P07');
    expect(result.features[0]!.displayCode).toBe('P07-F03');
    expect(() => validateAppQueryResponse('phases.graph.get', {
      ...graph, phase: { ...phase, displayCode: '/Users/leak' },
    })).toThrow();
  });
});

describe('P08 F-013 integration and repair notifications', () => {
  function event(type: string, aggregateId: string, payload: Record<string, unknown>): PublicStateEvent {
    return {
      schemaVersion: 2, eventId: '00000000-0004-4000-8000-00000000000e', sequence: 9, type: type as never,
      scope: { kind: 'project', projectId: PROJECT },
      aggregate: { type: 'integration_plan', id: aggregateId, revision: 3 },
      occurredAt: ISO, payload,
    } as never as PublicStateEvent;
  }

  it('[case:f013-notification-subscription] subscribes integration and repair status events', () => {
    expect(NOTIFICATION_SUBSCRIPTION_EVENT_TYPES).toContain(INTEGRATION_PLAN_STATUS_EVENT_TYPE);
    expect(NOTIFICATION_SUBSCRIPTION_EVENT_TYPES).toContain(GIT_REPAIR_STATUS_EVENT_TYPE);
  });

  it('[case:f013-integration-summary] derives bounded summaries without payload bodies or paths', () => {
    for (const [status, blockReasons] of [
      ['dependency_passed', []], ['integration_passed', []], ['stale', []], ['blocked', ['ancestor_not_verified', 'integration_evidence_incomplete']],
    ] as const) {
      const summary = deriveNotificationSummary(event(INTEGRATION_PLAN_STATUS_EVENT_TYPE, 'integration-1', {
        schemaVersion: 1, integrationId: 'integration-1', successorFeatureId: 'feature-c',
        status, blockReasons, staleReasons: [],
      }));
      expect(summary).toMatchObject({ kind: 'integration_status', integrationId: 'integration-1', successorFeatureId: 'feature-c', status });
      const text = JSON.stringify(summary);
      expect(text).not.toContain('/private');
      expect(text).not.toContain('token');
    }
  });

  it('[case:f013-repair-summary] covers requested, blocked and approved repair outcomes', () => {
    for (const [status, reason] of [
      ['requested', null], ['blocked', 'budget_exhausted'], ['attempt_modified', null], ['attempt_failed', 'candidate_invalid'],
    ] as const) {
      const summary = deriveNotificationSummary({
        ...event(GIT_REPAIR_STATUS_EVENT_TYPE, 'repair-1', {
          schemaVersion: 1, repairId: 'repair-1', featureId: 'feature-c', status, reason,
        }),
        aggregate: { type: 'git_repair', id: 'repair-1', revision: 1 },
      });
      expect(summary).toMatchObject({ kind: 'git_repair_status', repairId: 'repair-1', featureId: 'feature-c', status, reason });
    }
  });
});
