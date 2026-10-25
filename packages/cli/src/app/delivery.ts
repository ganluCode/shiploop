/**
 * P03-8 / F-011 Feature 交付 CLI 纯视图层。
 *
 * 纯函数模块（无 I/O）：把 HostClient 已线校验的查询/命令结果投影为 CLI
 * 结构化视图与人类行：
 * - features.delivery.get 分轴结果：Task/最终检查/人工审批/交付分轴分别展示，
 *   保留 Feature/Run/operation 与证据引用；`completed` 恒等于
 *   outcome.status==='completed'——所有 Task 通过但最终失败、等待批准、
 *   no_change 与待核对（pending/unknown）绝不显示为 completed；
 * - git.operations.list/get：意图（提交边界/预期 HEAD/tree/证据引用）与实际
 *   事实（parent/commit/tree/回执）分列；`committed` 要求 succeeded +
 *   deliveryStatus=succeeded + 已核对 parent，待核对/无变更不是已提交；
 * - feature final-approve（task.approval.approve）：决定绑定当前计划/代码
 *   摘要；批准不自动运行最终检查或提交；
 * - feature finalize（feature.verification.continue）：命令 completed 只表示
 *   收尾请求已处理；`delivered` 恒等于 outcome=completed 且
 *   deliveryStatus=succeeded，outcome 非 completed 明确未交付；
 * - 人类行只输出脱敏事实字段；不打印正文、凭据或开发机路径。
 */
import type {
  FeatureDeliveryCommandResult,
  FeatureDeliveryDetailResult,
  GitOperationDetailResult,
  GitOperationListResult,
  GitAgentRepairListResult,
  GitAgentRepairDetailResult,
  IntegrationPlanQueryResult,
  IntegrationStartCommandResult,
  IntegrationReconcileCommandResult,
  PublicGitOperationRecord,
  TaskApprovalDecisionResult,
} from 'shiploop-host';

export interface IntegrationPlanCliView {
  readonly scope: 'integration-plan';
  readonly integration: IntegrationPlanQueryResult['integration'];
  readonly predecessors: IntegrationPlanQueryResult['predecessors'];
  readonly integrationResult: IntegrationPlanQueryResult['integrationResult'];
  readonly outcome: IntegrationPlanQueryResult['outcome'];
  readonly completed: boolean;
  readonly note: string;
}

export function buildIntegrationPlanCliView(result: IntegrationPlanQueryResult): IntegrationPlanCliView {
  const completed = result.outcome.status === 'integration_passed';
  return {
    scope: 'integration-plan',
    integration: result.integration,
    predecessors: result.predecessors,
    integrationResult: result.integrationResult,
    outcome: result.outcome,
    completed,
    note: completed
      ? '固定集成 commit 与组合验证证据已完成'
      : `集成计划未完成（${result.outcome.status}）；按 nextStep=${result.outcome.nextStep} 核对或等待，不自动重跑编码`,
  };
}

export function formatIntegrationPlanView(view: IntegrationPlanCliView): string {
  const plan = view.integration;
  const lines = [
    `shiploop integration plan: ${plan.integrationId} status=${plan.status} completed=${String(view.completed)}`,
    `  project=${plan.projectId} phase=${plan.phaseId} batch=${plan.batchId} successorFeature=${plan.successorFeatureId}`,
    `  targetBaseline=${plan.targetBaseline} inputDigest=${plan.inputDigest}`,
    `  mode=${plan.mode} mergeOrder=${plan.mergeOrder.join(',')} verificationScope=${plan.verificationScope.join(',')}`,
    `  coverage=${plan.coverage.coveredInputCount}/${plan.coverage.approvedInputCount} complete=${String(plan.coverage.complete)}`,
  ];
  for (const predecessor of view.predecessors) {
    lines.push(`  predecessor ${predecessor.featureId} dependencyPassed=${String(predecessor.dependencyPassed)} commit=${String(predecessor.commitSha)} ancestorVerified=${String(predecessor.ancestorVerified)}`);
  }
  lines.push(`  outcome=${view.outcome.status} nextStep=${view.outcome.nextStep} reason=${view.outcome.reason}`);
  if (view.outcome.blockReasons.length > 0) lines.push(`  blockReasons=${view.outcome.blockReasons.join(',')}`);
  if (view.outcome.staleReasons.length > 0) lines.push(`  staleReasons=${view.outcome.staleReasons.join(',')}`);
  if (view.integrationResult !== null) lines.push(`  result commit=${String(view.integrationResult.commitSha)} tree=${String(view.integrationResult.treeSha)} operationStatus=${String(view.integrationResult.operationStatus)}`);
  lines.push(`  （${view.note}）`);
  return `${lines.join('\\n')}\\n`;
}


export type IntegrationCliState = 'pending' | 'blocked' | 'unknown' | 'matched' | 'failed';

export interface IntegrationReconcileCliView {
  readonly state: IntegrationCliState;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly gitOperationId: string;
  readonly reason: string;
  readonly deliveryStatus: IntegrationReconcileCommandResult['deliveryStatus'];
  readonly canStartSuccessor: boolean;
}

export function buildIntegrationReconcileCliView(
  result: IntegrationReconcileCommandResult,
): IntegrationReconcileCliView {
  const state: IntegrationCliState = result.outcome === 'matched'
    ? 'matched'
    : result.outcome === 'blocked'
      ? 'blocked'
      : result.outcome === 'unknown'
        ? 'unknown'
        : 'pending';
  return {
    state,
    featureId: result.featureId,
    runId: result.runId,
    batchId: result.batchId,
    gitOperationId: result.gitOperationId,
    reason: result.reason,
    deliveryStatus: result.deliveryStatus,
    canStartSuccessor: state === 'matched' && result.deliveryStatus === 'succeeded',
  };
}

export function buildIntegrationStartCliView(result: IntegrationStartCommandResult): IntegrationReconcileCliView {
  const state: IntegrationCliState = result.outcome === 'blocked' ? 'blocked' : result.outcome === 'unknown' ? 'unknown' : 'pending';
  return { state, featureId: result.featureId, runId: result.runId, batchId: result.batchId, gitOperationId: result.gitOperationId,
    reason: result.reason ?? result.outcome, deliveryStatus: null, canStartSuccessor: false };
}

export function formatIntegrationReconcileView(view: IntegrationReconcileCliView): string {
  return [
    `shiploop integration reconcile: state=${view.state} matched=${String(view.state === 'matched')}`,
    `  feature=${view.featureId} run=${view.runId} batch=${view.batchId} operation=${view.gitOperationId}`,
    `  deliveryStatus=${String(view.deliveryStatus)} successorStart=${String(view.canStartSuccessor)}`,
    `  reason=${view.reason}`,
  ].join('\\n') + '\\n';
}



/** Feature 分轴结果 CLI 视图：公开投影逐轴保留 + 派生 completed 不变量。 */
export interface FeatureDeliveryCliView {
  readonly scope: 'feature-delivery';
  readonly feature: FeatureDeliveryDetailResult['feature'];
  readonly run: FeatureDeliveryDetailResult['run'];
  readonly axes: FeatureDeliveryDetailResult['axes'];
  readonly outcome: FeatureDeliveryDetailResult['outcome'];
  /**
   * completed 恒等于 outcome.status==='completed'：所有 Task 通过但最终失败、
   * 等待批准、no_change、待核对或证据不全恒为 false。
   */
  readonly completed: boolean;
  readonly note: string;
}

export function buildFeatureDeliveryView(result: FeatureDeliveryDetailResult): FeatureDeliveryCliView {
  const completed = result.outcome.status === 'completed';
  return {
    scope: 'feature-delivery',
    feature: result.feature,
    run: result.run,
    axes: result.axes,
    outcome: result.outcome,
    completed,
    note: completed
      ? '全部必需 Task、最终检查、人工批准与获准提交均完成'
      : `未交付（outcome=${result.outcome.status}）：不显示为 completed；按 nextStep 显式处理，不自动重跑编码`,
  };
}

export function formatFeatureDeliveryView(view: FeatureDeliveryCliView): string {
  const lines: string[] = [];
  lines.push(
    `shiploop feature delivery: ${view.feature.featureId} ` +
      `outcome=${view.outcome.status} completed=${String(view.completed)}`,
  );
  lines.push(
    `  feature status=${view.feature.status} deliveryStatus=${view.feature.deliveryStatus} ` +
      `planStatus=${view.feature.planStatus} revision=${view.feature.revision}`,
  );
  if (view.run !== null) {
    lines.push(
      `  run ${view.run.id} status=${view.run.status} batch=${view.run.batchId}` +
        `${view.run.reason !== null ? ` reason=${view.run.reason}` : ''}`,
    );
  } else {
    lines.push('  run none');
  }
  const tasks = view.axes.tasks;
  lines.push(
    `  tasks passed=${tasks.passed}/${tasks.total} allPassed=${String(tasks.allPassed)}` +
      `${tasks.allPassed && !view.completed ? '（所有 Task passed 不等于交付）' : ''}`,
  );
  for (const record of tasks.records) {
    lines.push(
      `    - ${record.taskId} status=${record.status} effectivePassed=${String(record.effectivePassed)}` +
        `${record.manualBlock ? ' manualBlock=true' : ''}` +
        `${record.latestAttemptId !== null ? ` latestAttempt=${record.latestAttemptId}` : ''}`,
    );
  }
  const verification = view.axes.verification;
  lines.push(
    `  verification status=${verification.status} batch=${verification.batch?.id ?? 'none'}`,
  );
  const approval = view.axes.approval;
  lines.push(
    `  approval status=${approval.status}` +
      `${approval.reason !== null ? ` reason=${approval.reason}` : ''}` +
      ` items=${approval.items.length}${approval.itemsTruncated ? '（truncated）' : ''}`,
  );
  const delivery = view.axes.delivery;
  if (delivery.operation !== null) {
    lines.push(
      `  delivery status=${delivery.status} operation=${delivery.operation.operationId} ` +
        `operationStatus=${delivery.operation.status}` +
        `${delivery.operation.reasonCode !== null ? ` reasonCode=${delivery.operation.reasonCode}` : ''}`,
    );
  } else {
    lines.push(`  delivery status=${delivery.status} operation=none`);
  }
  lines.push(
    `  outcome reason=${view.outcome.reason} stage=${String(view.outcome.executionStage)} ` +
      `nextStep=${view.outcome.nextStep}`,
  );
  const identities = view.outcome.identities;
  lines.push(
    `  identities run=${String(identities.runId)} batch=${String(identities.batchId)} ` +
      `verificationBatch=${String(identities.verificationBatchId)} ` +
      `gitOperation=${String(identities.gitOperationId)}`,
  );
  lines.push(`  （${view.note}）`);
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * Git 操作视图（git.operations.list / git.operations.get）
 * ------------------------------------------------------------------ */

/**
 * 单条 Git 操作展示投影：意图边界 + 实际事实 + 回执在场性。
 * `committed` 要求 succeeded + deliveryStatus=succeeded + 已核对 parent 与
 * 实际 commit；pending（回执缺失）、unknown（待核对）、no_change（无变更）
 * 与 failed 恒为 false——绝不把待核对/无变更显示为已提交。
 */
export interface GitOperationRecordView {
  readonly operationId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly status: PublicGitOperationRecord['status'];
  readonly deliveryStatus: PublicGitOperationRecord['deliveryStatus'];
  readonly reasonCode: string | null;
  readonly expectedHead: string;
  readonly candidateTree: string;
  readonly actualCommit: string | null;
  readonly actualParent: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly settledAt: string | null;
  readonly verificationRefs: PublicGitOperationRecord['verificationRefs'];
  readonly approvalRefs: PublicGitOperationRecord['approvalRefs'];
  readonly receiptRecorded: boolean;
  readonly committed: boolean;
}

export function gitOperationCommitted(record: PublicGitOperationRecord): boolean {
  return (
    record.status === 'succeeded' &&
    record.deliveryStatus === 'succeeded' &&
    record.actualCommit !== null &&
    record.actualParent !== null
  );
}

export function buildGitOperationRecordView(record: PublicGitOperationRecord): GitOperationRecordView {
  return {
    operationId: record.operationId,
    featureId: record.featureId,
    runId: record.runId,
    status: record.status,
    deliveryStatus: record.deliveryStatus,
    reasonCode: record.reasonCode,
    expectedHead: record.expectedHead,
    candidateTree: record.candidateTree,
    actualCommit: record.actualCommit,
    actualParent: record.actualParent,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    settledAt: record.settledAt,
    verificationRefs: record.verificationRefs,
    approvalRefs: record.approvalRefs,
    receiptRecorded: record.receipt !== null,
    committed: gitOperationCommitted(record),
  };
}

export interface GitAgentRepairCliView {
  readonly scope: 'git-repair';
  readonly repair: GitAgentRepairListResult['records'][number];
  readonly completed: boolean;
}

export function buildGitAgentRepairView(result: GitAgentRepairDetailResult): GitAgentRepairCliView {
  const repair = result.repair;
  const completed = repair.candidateOperation?.status === 'succeeded' && repair.candidateOperation.deliveryStatus === 'succeeded';
  return { scope: 'git-repair', repair, completed };
}

export interface GitAgentRepairListCliView {
  readonly scope: 'git-repair-list';
  readonly records: GitAgentRepairListResult['records'];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export function buildGitAgentRepairListView(result: GitAgentRepairListResult): GitAgentRepairListCliView {
  return { scope: 'git-repair-list', records: result.records, nextCursor: result.nextCursor, limit: result.limit };
}

export function formatGitAgentRepairListView(view: GitAgentRepairListCliView): string {
  const lines = [`shiploop git repairs: ${view.records.length} record(s)`];
  for (const repair of view.records) lines.push(`  - ${repair.repairId} run=${String(repair.runId)} blocked=${String(repair.blockedReason)} attempts=${repair.attempts.length} candidate=${repair.candidateOperation?.status ?? 'none'}`);
  lines.push(`  nextCursor=${view.nextCursor ?? 'none'}`);
  return `${lines.join('\\n')}\\n`;
}

export function formatGitAgentRepairView(view: GitAgentRepairCliView): string {
  const repair = view.repair;
  const latest = repair.attempts.at(-1);
  return [
    `shiploop git repair: ${repair.repairId} completed=${String(view.completed)}`,
    `  project=${repair.projectId} feature=${repair.featureId} run=${String(repair.runId)} sourceOperation=${repair.sourceOperationId}`,
    `  blocked=${String(repair.blockedReason)} failureKind=${repair.source.failureKind} inputDigest=${repair.source.inputDigest}`,
    `  attempts=${repair.attempts.length} latestStatus=${latest?.status ?? 'none'} tokens=${String(latest?.consumedTokens ?? null)} runtimeMs=${String(latest?.runtimeMs ?? null)}`,
    `  candidate=${repair.candidateOperation?.status ?? 'none'} deliveryStatus=${String(repair.candidateOperation?.deliveryStatus ?? null)}（候选/模型完成不等于交付完成）`,
  ].join('\\n') + '\\n';
}
export interface GitOperationListCliView {
  readonly scope: 'git-operation-list';
  readonly records: readonly GitOperationRecordView[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export function buildGitOperationListView(result: GitOperationListResult): GitOperationListCliView {
  return {
    scope: 'git-operation-list',
    records: result.records.map(buildGitOperationRecordView),
    nextCursor: result.nextCursor,
    limit: result.limit,
  };
}

function shortOid(oid: string | null): string {
  return oid === null ? 'none' : oid.slice(0, 8);
}

function formatGitOperationLine(record: GitOperationRecordView): string {
  return (
    `  - ${record.operationId} status=${record.status} ` +
    `deliveryStatus=${String(record.deliveryStatus)} committed=${String(record.committed)} ` +
    `expectedHead=${shortOid(record.expectedHead)} actualCommit=${shortOid(record.actualCommit)}` +
    `${record.reasonCode !== null ? ` reasonCode=${record.reasonCode}` : ''}` +
    `${record.receiptRecorded ? '' : ' receipt=none'}`
  );
}

export function formatGitOperationListView(view: GitOperationListCliView): string {
  const lines = [
    `shiploop git operations: ${view.records.length} record(s)（意图/实际提交/回执只读投影；` +
      'pending/unknown 待核对与 no_change 均不是已提交）',
  ];
  for (const record of view.records) {
    lines.push(formatGitOperationLine(record));
  }
  if (view.nextCursor !== null) {
    lines.push(`  nextCursor=${view.nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 单条 Git 操作详情视图：完整意图 + 实际事实 + 回执在场性 + 证据引用。 */
export interface GitOperationDetailCliView {
  readonly record: GitOperationRecordView;
  readonly intentDigest: string;
  readonly codeDigest: string;
  readonly deliveryPolicyDigest: string;
  readonly message: string;
  readonly gitIdentity: PublicGitOperationRecord['gitIdentity'];
}

export function buildGitOperationDetailView(result: GitOperationDetailResult): GitOperationDetailCliView {
  return {
    record: buildGitOperationRecordView(result.operation),
    intentDigest: result.operation.intentDigest,
    codeDigest: result.operation.codeDigest,
    deliveryPolicyDigest: result.operation.deliveryPolicyDigest,
    message: result.operation.message,
    gitIdentity: result.operation.gitIdentity,
  };
}

export function formatGitOperationDetailView(view: GitOperationDetailCliView): string {
  const record = view.record;
  const lines = [
    `shiploop git operation: ${record.operationId} status=${record.status} ` +
      `committed=${String(record.committed)}（待核对/无变更不显示为已提交）`,
    `  feature=${record.featureId} run=${record.runId}`,
    `  expectedHead=${record.expectedHead} candidateTree=${record.candidateTree}`,
    `  actualCommit=${String(record.actualCommit)} actualParent=${String(record.actualParent)}`,
    `  deliveryStatus=${String(record.deliveryStatus)} reasonCode=${String(record.reasonCode)} ` +
      `exitCode=${String(record.exitCode)} durationMs=${String(record.durationMs)}`,
    `  receipt=${record.receiptRecorded ? 'recorded' : 'none'} settledAt=${String(record.settledAt)}`,
    `  intentDigest=${view.intentDigest} codeDigest=${view.codeDigest} ` +
      `deliveryPolicyDigest=${view.deliveryPolicyDigest}`,
    `  gitIdentity=${view.gitIdentity.name} <${view.gitIdentity.email}> confirmed=${String(view.gitIdentity.confirmed)}`,
  ];
  const refs = (refs: readonly { kind: string; id: string; digest: string }[]): string =>
    refs.length === 0 ? 'none' : refs.map((ref) => `${ref.kind}:${ref.id}`).join(',');
  lines.push(`  verificationRefs=${refs(record.verificationRefs)}`);
  lines.push(`  approvalRefs=${refs(record.approvalRefs)}`);
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * feature final-approve 结果视图（task.approval.approve 既有授权命令）
 * ------------------------------------------------------------------ */

/** 最终审批 CLI 视图：决定绑定当前计划/代码摘要；批准不自动运行。 */
export interface FeatureFinalApprovalCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly task: { readonly id: string };
  readonly item: {
    readonly id: string;
    readonly status: string;
    readonly planDigest: string;
    readonly codeDigest: string | null;
  };
  readonly decision: 'approve';
  readonly runtimeCalled: false;
  readonly executionStarted: false;
  readonly note: string;
}

export const FEATURE_FINAL_APPROVAL_NOTE =
  '决定只记录事项事实并绑定当前计划/代码摘要；批准不自动运行最终检查或提交、不调用 Runtime';

export function buildFeatureFinalApprovalView(
  commandId: string,
  replayed: boolean,
  result: TaskApprovalDecisionResult,
): FeatureFinalApprovalCliView {
  return {
    commandId,
    replayed,
    task: { id: result.taskId },
    item: {
      id: result.item.id,
      status: result.item.status,
      planDigest: result.item.planDigest,
      codeDigest: result.item.codeDigest,
    },
    decision: 'approve',
    runtimeCalled: result.runtimeCalled,
    executionStarted: result.executionStarted,
    note: FEATURE_FINAL_APPROVAL_NOTE,
  };
}

export function formatFeatureFinalApprovalView(view: FeatureFinalApprovalCliView): string {
  return (
    `shiploop feature final-approve: completed task=${view.task.id} item=${view.item.id} ` +
    `status=${view.item.status}${view.replayed ? '（replayed）' : ''}（${view.note}）\n`
  );
}

/* ------------------------------------------------------------------ *
 * feature finalize 结果视图（feature.verification.continue 既有授权命令）
 * ------------------------------------------------------------------ */

/**
 * 显式收尾 CLI 视图：命令 completed 只表示收尾请求已处理；
 * `delivered` 恒等于 outcome=completed 且 deliveryStatus=succeeded——
 * 等待批准/失败/部分完成都不是交付成功。
 */
export interface FeatureFinalizeCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly gitOperationId: string;
  readonly outcome: FeatureDeliveryCommandResult['outcome'];
  readonly reason: string;
  readonly deliveryStatus: FeatureDeliveryCommandResult['deliveryStatus'];
  readonly delivered: boolean;
  readonly runtimeCalled: false;
  readonly executionStarted: false;
  readonly note: string;
}

export function buildFeatureFinalizeView(
  commandId: string,
  replayed: boolean,
  result: FeatureDeliveryCommandResult,
): FeatureFinalizeCliView {
  const delivered = result.outcome === 'completed' && result.deliveryStatus === 'succeeded';
  return {
    commandId,
    replayed,
    featureId: result.featureId,
    runId: result.runId,
    batchId: result.batchId,
    gitOperationId: result.gitOperationId,
    outcome: result.outcome,
    reason: result.reason,
    deliveryStatus: result.deliveryStatus,
    delivered,
    runtimeCalled: result.runtimeCalled,
    executionStarted: result.executionStarted,
    note: delivered
      ? '最终检查/批准/获准提交均完成，交付成功'
      : '命令 completed 只表示收尾请求已处理；未交付——以 feature delivery 查询的分轴结果与 nextStep 为准',
  };
}

export function formatFeatureFinalizeView(view: FeatureFinalizeCliView): string {
  return (
    `shiploop feature finalize: completed feature=${view.featureId} run=${view.runId} ` +
    `outcome=${view.outcome} deliveryStatus=${view.deliveryStatus} ` +
    `delivered=${String(view.delivered)} gitOperation=${view.gitOperationId} ` +
    `reason=${view.reason}${view.replayed ? '（replayed）' : ''}（${view.note}）\n`
  );
}
