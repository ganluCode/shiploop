/**
 * P03-7 / F-014 人审事项、显式验证继续与 Task 状态 CLI 纯视图层。
 *
 * 纯函数模块（无 I/O）：
 * - 输入守护：检查定义/模块策略确认（config policies 段）与产物引用参数在任何
 *   I/O 之前拒绝客户端伪造主体（principalId/decisionActor 等）与明文凭据字段；
 *   checkDefinitions 的 `scope` 是检查范围词汇（task/module/project），不是
 *   授权 scope，服务端 settings Schema 仍是唯一权威；
 * - 结果视图：把 HostClient 已线校验的 completed 回执结果投影为稳定结构化
 *   CLI 输出（事项事实、决定绑定、验证继续的复用结论与执行边界）；
 * - 状态视图：机器结论、人审待处理、有效 Task 状态三分区展示；错误、等待
 *   批准、not_run 与额度耗尽绝不折算为通过（passed 仅在机器 passed 且有效
 *   Task passed 时成立）；
 * - 人类行：脱敏事实字段；不打印正文、凭据或开发机路径。
 */
import { AppCliParseError } from './args.js';
import type { AppCliCommand, AppCliCommandId, AppCliParseReason } from './args.js';
import { isClientIdentityFieldToken, rejectSecretInputFields } from './baseline.js';
import type { BaselineInputContext } from './baseline.js';
import type {
  TaskApprovalBlockResult,
  TaskApprovalDecisionResult,
  TaskVerificationContinueResult,
} from 'shiploop-host';

/** 输入守护上下文（与 baseline 输入校验同一错误口径）。 */
export interface ApprovalsInputContext {
  readonly command: AppCliCommand;
  readonly commandId?: AppCliCommandId | null;
  readonly json?: boolean;
}

function failInput(
  context: ApprovalsInputContext,
  reason: AppCliParseReason,
  field: string,
): never {
  throw new AppCliParseError(
    'invalid_input',
    reason,
    {
      command: context.command,
      commandId: context.commandId ?? null,
      json: context.json ?? false,
    },
    field,
  );
}

function baselineContext(context: ApprovalsInputContext): BaselineInputContext {
  return {
    command: context.command,
    ...(context.commandId !== undefined ? { commandId: context.commandId } : {}),
    ...(context.json !== undefined ? { json: context.json } : {}),
  };
}

/**
 * 检查定义/模块策略确认输入守护（config policies 段递归扫描键名）：
 * - 明文凭据/环境值字段（token/secret/credentials/env...）一律定位拒绝；
 * - 客户端伪造主体字段（principalId/decisionActor/actor/capabilities...）
 *   一律定位拒绝；`scope` 例外——检查定义的作用域词汇（task/module/project），
 *   服务端 settings Schema 对其取值做唯一权威校验。
 */
export function scanConfigPolicyInputFields(
  value: unknown,
  context: ApprovalsInputContext,
  field = 'policies',
): void {
  rejectSecretInputFields(value, field, baselineContext(context));
  scanIdentityKeys(value, field, context);
}

function scanIdentityKeys(
  value: unknown,
  field: string,
  context: ApprovalsInputContext,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanIdentityKeys(item, `${field}[${index}]`, context);
    });
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const childField = field.length > 0 ? `${field}.${key}` : key;
    const token = key.toLowerCase().replaceAll(/[_-]/g, '');
    if (token !== 'scope' && isClientIdentityFieldToken(token)) {
      failInput(context, 'input_identity_field_rejected', childField);
    }
    scanIdentityKeys((value as Record<string, unknown>)[key], childField, context);
  }
}

/** CLI `--artifact <artifactId[:contentHash]>` 参数解析后的产物摘要引用。 */
export interface ArtifactRefView {
  readonly artifactId: string;
  readonly contentHash: string | null;
}

/**
 * 复用 `--artifact` 参数解析：`<artifactId>` 或 `<artifactId>:<64 位 hex>`；
 * 形态非法、重复引用在连接 Host 之前拒绝（不携带伪造引用进入请求体）。
 */
export function parseArtifactRefValues(
  values: readonly string[],
  context: ApprovalsInputContext,
): readonly ArtifactRefView[] {
  const seen = new Set<string>();
  return values.map((raw) => {
    const separator = raw.indexOf(':');
    const artifactId = separator === -1 ? raw : raw.slice(0, separator);
    const hash = separator === -1 ? null : raw.slice(separator + 1);
    if (artifactId.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactId)) {
      failInput(context, 'invalid_artifact_ref', 'artifact');
    }
    if (seen.has(artifactId)) {
      failInput(context, 'duplicate_artifact_ref', 'artifact');
    }
    seen.add(artifactId);
    if (hash !== null && !/^[0-9a-f]{64}$/.test(hash)) {
      failInput(context, 'invalid_artifact_ref', 'artifact');
    }
    return { artifactId, contentHash: hash };
  });
}

/* ------------------------------------------------------------------ *
 * 执行边界视图（决定/继续绝不启动执行、绝不调用 Runtime）
 * ------------------------------------------------------------------ */

export interface ApprovalExecutionBoundaryView {
  readonly started: false;
  readonly runtimeCalled: false;
  readonly capability: 'unknown';
  readonly runnable: false;
}

export const APPROVAL_EXECUTION_BOUNDARY_VIEW: ApprovalExecutionBoundaryView = Object.freeze({
  started: false,
  runtimeCalled: false,
  capability: 'unknown',
  runnable: false,
});

/* ------------------------------------------------------------------ *
 * task block 结果视图（添加阻塞/必需审批事项）
 * ------------------------------------------------------------------ */

export interface ApprovalItemCliView {
  readonly id: string;
  readonly kind: 'block' | 'approval';
  readonly status: string;
  readonly description: string;
  readonly responsibleParty: string;
  readonly planDigest: string;
  readonly codeDigest: string | null;
  readonly revision: number;
  readonly decision: string | null;
  readonly decisionActor: string | null;
}

export interface TaskApprovalBlockCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly task: {
    readonly id: string;
    readonly revision: number;
    readonly manualBlock: true;
  };
  readonly item: ApprovalItemCliView;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
  readonly execution: ApprovalExecutionBoundaryView;
}

function itemView(result: TaskApprovalBlockResult | TaskApprovalDecisionResult): ApprovalItemCliView {
  return {
    id: result.item.id,
    kind: result.item.kind,
    status: result.item.status,
    description: result.item.description,
    responsibleParty: result.item.responsibleParty,
    planDigest: result.item.planDigest,
    codeDigest: result.item.codeDigest,
    revision: result.item.revision,
    decision: result.item.decision,
    decisionActor: result.item.decisionActor,
  };
}

export function buildTaskApprovalBlockView(
  commandId: string,
  replayed: boolean,
  result: TaskApprovalBlockResult,
): TaskApprovalBlockCliView {
  return {
    commandId,
    replayed,
    task: { id: result.taskId, revision: result.revision, manualBlock: true },
    item: itemView(result),
    planDigest: result.planDigest,
    checkPolicyDigest: result.checkPolicyDigest,
    execution: APPROVAL_EXECUTION_BOUNDARY_VIEW,
  };
}

export function formatTaskApprovalBlockView(view: TaskApprovalBlockCliView): string {
  return (
    `shiploop task block: completed task=${view.task.id} revision=${view.task.revision} ` +
    `manualBlock=true item=${view.item.id} kind=${view.item.kind} ` +
    `responsibleParty=${view.item.responsibleParty}${view.replayed ? '（replayed）' : ''}` +
    '（仅登记事项；未启动执行、未调用 Runtime）\n'
  );
}

/* ------------------------------------------------------------------ *
 * task approve/reject/unblock 结果视图（事项决定）
 * ------------------------------------------------------------------ */

export interface TaskApprovalDecisionCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly task: { readonly id: string };
  readonly item: ApprovalItemCliView;
  readonly decision: 'approve' | 'reject' | 'unblock';
  readonly execution: ApprovalExecutionBoundaryView;
}

export function buildTaskApprovalDecisionView(
  commandId: string,
  replayed: boolean,
  result: TaskApprovalDecisionResult,
): TaskApprovalDecisionCliView {
  return {
    commandId,
    replayed,
    task: { id: result.taskId },
    item: itemView(result),
    decision: result.decision,
    execution: APPROVAL_EXECUTION_BOUNDARY_VIEW,
  };
}

export function formatTaskApprovalDecisionView(view: TaskApprovalDecisionCliView): string {
  return (
    `shiploop task ${view.decision}: completed task=${view.task.id} item=${view.item.id} ` +
    `status=${view.item.status}${view.replayed ? '（replayed）' : ''}` +
    '（决定只记录事项事实；批准/解除不启动执行、不调用 Runtime）\n'
  );
}

/* ------------------------------------------------------------------ *
 * task continue 结果视图（显式验证继续；复用有效机器证据）
 * ------------------------------------------------------------------ */

/** 继续结果的展示结论：未装配执行器明确 unsupported，不冒充通过。 */
export type VerificationContinueDisplay =
  | 'completed'
  | 'waiting_approval'
  | 'unsupported'
  | 'waiting_recording'
  | 'execution_uncertain'
  | 'ignored';

export function verificationContinueDisplay(
  waitingFor: TaskVerificationContinueResult['waitingFor'],
  disposition: TaskVerificationContinueResult['disposition'],
): VerificationContinueDisplay {
  if (disposition === 'ignored') return 'ignored';
  switch (waitingFor) {
    case null:
      return 'completed';
    case 'approval':
      return 'waiting_approval';
    case 'verification_not_assembled':
      // 未装配语言执行器：明确 unsupported，绝不折算为通过。
      return 'unsupported';
    case 'recording_required':
      return 'waiting_recording';
    case 'execution_uncertain':
      return 'execution_uncertain';
  }
}

export interface TaskVerificationContinueCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly task: { readonly id: string };
  readonly attemptId: string;
  readonly verificationBatchId: string;
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly status: string | null;
  readonly waitingFor: TaskVerificationContinueResult['waitingFor'];
  readonly reason: string | null;
  readonly display: VerificationContinueDisplay;
  readonly evidenceReused: boolean;
  readonly execution: ApprovalExecutionBoundaryView;
}

export function buildTaskVerificationContinueView(
  commandId: string,
  replayed: boolean,
  result: TaskVerificationContinueResult,
): TaskVerificationContinueCliView {
  return {
    commandId,
    replayed,
    task: { id: result.taskId },
    attemptId: result.attemptId,
    verificationBatchId: result.verificationBatchId,
    disposition: result.disposition,
    status: result.status,
    waitingFor: result.waitingFor,
    reason: result.reason,
    display: verificationContinueDisplay(result.waitingFor, result.disposition),
    evidenceReused: true,
    execution: APPROVAL_EXECUTION_BOUNDARY_VIEW,
  };
}

export function formatTaskVerificationContinueView(view: TaskVerificationContinueCliView): string {
  return (
    `shiploop task continue: completed task=${view.task.id} attempt=${view.attemptId} ` +
    `batch=${view.verificationBatchId} disposition=${view.disposition} display=${view.display}` +
    `${view.replayed ? '（replayed）' : ''}` +
    '（复用已保存机器证据；零新增编码调用、未启动执行）\n'
  );
}

/* ------------------------------------------------------------------ *
 * task status 结果视图（机器结论 / 人审待处理 / 有效 Task 状态三分区）
 * ------------------------------------------------------------------ */

/** 机器结论投影（只反映持久机器事实）。 */
export interface TaskMachineStatusView {
  readonly status: string;
  readonly reason: string;
  readonly outcome: string | null;
  readonly attemptId: string | null;
  readonly batchId: string | null;
  readonly codeDigest: string | null;
  readonly observationDigest: string | null;
}

/** 有效 Task 状态投影（passed 恒等于 status === 'passed'）。 */
export interface TaskEffectiveStateView {
  readonly taskId: string;
  readonly featureId: string;
  readonly status: string;
  readonly effectivePassed: boolean;
  readonly manualBlock: boolean;
  readonly executionVersion: number;
}

export interface TaskPendingApprovalView {
  readonly id: string;
  readonly kind: 'block' | 'approval';
  readonly description: string;
  readonly responsibleParty: string;
  readonly planDigest: string;
  readonly codeDigest: string | null;
}

export type TaskDisplayState =
  | 'passed'
  | 'waiting_approval'
  | 'exhausted'
  | 'not_run'
  | 'error'
  | 'failed'
  | 'running'
  | 'inconclusive';

export interface TaskCodeEligibilityView {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

/** 状态查询输入（HostClient 三个只读查询的结构化投影；线校验由 HostClient 完成）。 */
export interface TaskStatusInputs {
  readonly verification: {
    readonly task: {
      readonly taskId: string;
      readonly featureId: string;
      readonly status: string;
      readonly executionVersion: number;
      readonly manualBlock: boolean;
      readonly effectivePassed: boolean;
    };
    readonly machine: {
      readonly status: string;
      readonly reason: string;
      readonly outcome: string | null;
      readonly attemptId: string | null;
      readonly batchId: string | null;
      readonly codeDigest: string | null;
      readonly observationDigest: string | null;
    };
  };
  readonly approvals: {
    readonly records: readonly {
      readonly id: string;
      readonly kind: 'block' | 'approval';
      readonly status: string;
      readonly description: string;
      readonly responsibleParty: string;
      readonly planDigest: string;
      readonly codeDigest: string | null;
    }[];
  };
  readonly rework: {
    readonly summary: {
      readonly codeEligibility: TaskCodeEligibilityView;
    };
  };
}

/**
 * 展示状态推导（不变量：只有机器 passed 且有效 Task passed 才是 passed）。
 * 优先级：通过 → 等待批准（含机器绿但人审未决）→ 额度耗尽 → not_run →
 * 机器错误/失败/运行中 → 不确定。错误、等待批准、not_run 与额度耗尽绝不
 * 打印为通过。
 */
export function deriveTaskDisplayState(input: {
  readonly machineStatus: string;
  readonly effectivePassed: boolean;
  readonly pendingApprovalCount: number;
  readonly codeRemaining: number;
}): TaskDisplayState {
  if (input.effectivePassed && input.machineStatus === 'passed') return 'passed';
  if (input.pendingApprovalCount > 0) return 'waiting_approval';
  if (input.codeRemaining === 0) return 'exhausted';
  switch (input.machineStatus) {
    case 'passed':
      // 机器绿色但有效 Task 未通过且无待决事项：仍不是通过。
      return 'waiting_approval';
    case 'none':
      return 'not_run';
    case 'error':
      return 'error';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    default:
      return 'inconclusive';
  }
}

export interface TaskStatusCliView {
  readonly commandId: string;
  readonly machine: TaskMachineStatusView;
  readonly pendingApprovals: readonly TaskPendingApprovalView[];
  readonly pendingApprovalCount: number;
  readonly task: TaskEffectiveStateView;
  readonly codeEligibility: TaskCodeEligibilityView;
  readonly display: TaskDisplayState;
  /** 有效通过断言：恒等于 display === 'passed'；绝不以机器绿色折算。 */
  readonly passed: boolean;
}

export function buildTaskStatusView(commandId: string, input: TaskStatusInputs): TaskStatusCliView {
  const pending = input.approvals.records
    .filter((record) => record.status === 'pending')
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      description: record.description,
      responsibleParty: record.responsibleParty,
      planDigest: record.planDigest,
      codeDigest: record.codeDigest,
    }));
  const display = deriveTaskDisplayState({
    machineStatus: input.verification.machine.status,
    effectivePassed: input.verification.task.effectivePassed,
    pendingApprovalCount: pending.length,
    codeRemaining: input.rework.summary.codeEligibility.remaining,
  });
  const view: TaskStatusCliView = {
    commandId,
    machine: {
      status: input.verification.machine.status,
      reason: input.verification.machine.reason,
      outcome: input.verification.machine.outcome,
      attemptId: input.verification.machine.attemptId,
      batchId: input.verification.machine.batchId,
      codeDigest: input.verification.machine.codeDigest,
      observationDigest: input.verification.machine.observationDigest,
    },
    pendingApprovals: pending,
    pendingApprovalCount: pending.length,
    task: {
      taskId: input.verification.task.taskId,
      featureId: input.verification.task.featureId,
      status: input.verification.task.status,
      effectivePassed: input.verification.task.effectivePassed,
      manualBlock: input.verification.task.manualBlock,
      executionVersion: input.verification.task.executionVersion,
    },
    codeEligibility: { ...input.rework.summary.codeEligibility },
    display,
    passed: display === 'passed',
  };
  // 折算不变量：passed ⇔ 机器 passed 且有效 Task passed。
  if (view.passed !== (view.machine.status === 'passed' && view.task.effectivePassed)) {
    throw new TypeError('task status 折算违反 passed 不变量');
  }
  return view;
}

export function formatTaskStatusView(view: TaskStatusCliView): string {
  const lines = [
    `shiploop task status: task=${view.task.taskId} feature=${view.task.featureId} display=${view.display}`,
    `  machine: status=${view.machine.status} reason=${view.machine.reason} ` +
      `outcome=${String(view.machine.outcome)} batch=${String(view.machine.batchId)}`,
    `  pending approvals: ${view.pendingApprovalCount}` +
      (view.pendingApprovalCount > 0
        ? `（${view.pendingApprovals.map((item) => `${item.id}/${item.kind}/${item.responsibleParty}`).join(', ')}）`
        : ''),
    `  task: status=${view.task.status} effectivePassed=${view.task.effectivePassed} ` +
      `manualBlock=${view.task.manualBlock} revision-scope=executionVersion:${view.task.executionVersion}`,
    `  code eligibility: used=${view.codeEligibility.used} limit=${view.codeEligibility.limit} ` +
      `remaining=${view.codeEligibility.remaining}`,
  ];
  if (view.display !== 'passed') {
    lines.push('  （机器结论、等待批准、not_run 与额度耗尽均不折算为通过）');
  }
  return `${lines.join('\n')}\n`;
}
