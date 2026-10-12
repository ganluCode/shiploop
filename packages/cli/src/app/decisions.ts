/**
 * P03-2 / F-008 计划决策、Task 策略编辑与固定输入 CLI 纯视图层。
 *
 * 纯函数模块（无 I/O）：
 * - 输入守护：策略副本与固定输入清单的键名扫描（秘密/身份字段在任何 I/O
 *   之前定位拒绝；复用 baseline.ts 的秘密/身份字段词汇表，不另立第二套）；
 * - 结果视图：把 HostClient 已线校验的 completed 回执结果投影为 CLI 结构化
 *   输出（实际计划身份、当前审批状态、Task 策略与来源、输入制品组
 *   version/hash/用途），并附执行边界视图——批准/拒绝/准备均不启动执行，
 *   未知执行能力不显示为可运行；
 * - 人类行：脱敏事实字段；不打印正文、凭据或开发机路径。
 */
import { AppCliParseError } from './args.js';
import type { AppCliCommand, AppCliCommandId, AppCliParseReason } from './args.js';
import { rejectForbiddenFields } from './baseline.js';
import type {
  ExecutionInputGroupBodyRefWire,
  ExecutionInputPrepareResult,
  ExecutionInputRefWire,
  FeaturePlanDecideResult,
  TaskStrategyUpdateResult,
} from 'shiploop-host';

/** 输入守护上下文（与 baseline 输入校验同一错误口径；command 标注所属命令组）。 */
export interface DecisionsInputContext {
  readonly command: AppCliCommand;
  readonly commandId?: AppCliCommandId | null;
  readonly json?: boolean;
}

function scanContext(context: DecisionsInputContext): {
  command: AppCliCommand;
  commandId?: AppCliCommandId | null;
  json?: boolean;
} {
  return {
    command: context.command,
    ...(context.commandId !== undefined ? { commandId: context.commandId } : {}),
    ...(context.json !== undefined ? { json: context.json } : {}),
  };
}

function failInput(
  context: DecisionsInputContext,
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

/**
 * 策略副本输入守护：递归扫描键名（只看键名不读值）；秘密/环境值与身份字段
 * 一律定位拒绝。深度策略语义由服务端单一权威校验，CLI 不复制配置 Schema。
 */
export function scanStrategyInputFields(
  value: Record<string, unknown>,
  context: DecisionsInputContext,
): void {
  rejectForbiddenFields(value, 'executionConfig', scanContext(context));
}

/**
 * 固定输入清单输入守护：文件只接受 `{items: [...]}` 形态（未知键拒绝）；
 * items 内仍拒绝秘密/身份字段；逐项来源深校验由服务端单一权威完成。
 */
export function parsePrepareItemsPayload(
  value: Record<string, unknown>,
  context: DecisionsInputContext,
): readonly unknown[] {
  for (const key of Object.keys(value)) {
    if (key !== 'items') {
      failInput(context, 'unknown_input_field', key);
    }
  }
  const items = value.items;
  if (!Array.isArray(items)) {
    failInput(context, 'input_items_invalid', 'items');
  }
  rejectForbiddenFields(items, 'items', scanContext(context));
  return items as readonly unknown[];
}

/* ------------------------------------------------------------------ *
 * 执行边界视图（不宣称执行可用）
 * ------------------------------------------------------------------ */

/** 执行边界：命令不启动执行；未知执行能力不显示为可运行。 */
export interface ExecutionBoundaryView {
  readonly started: false;
  readonly capability: 'unknown';
  readonly runnable: false;
}

export const EXECUTION_BOUNDARY_VIEW: ExecutionBoundaryView = Object.freeze({
  started: false,
  capability: 'unknown',
  runnable: false,
});

/* ------------------------------------------------------------------ *
 * feature.approve / feature.reject 结果视图
 * ------------------------------------------------------------------ */

/** 当前审批状态（服务端权威决定的脱敏投影）。 */
export interface FeaturePlanApprovalView {
  readonly decisionId: string;
  readonly status: string;
  readonly current: boolean;
  readonly subjectDigest: string;
  readonly checkPolicyDigest: string | null;
  readonly reason: string | null;
  readonly decidedAt: string | null;
  readonly decisionActor: string | null;
}

/** 计划决策 CLI 结果：实际计划身份 + 当前审批状态 + 未启动执行。 */
export interface FeaturePlanDecisionCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly feature: {
    readonly id: string;
    readonly revision: number;
    readonly planStatus: string;
    /** 实际计划身份（已决策计划恒为 64 位 hex；未固化计划可为 null）。 */
    readonly planDigest: string | null;
  };
  readonly decision: 'approve' | 'reject';
  readonly approval: FeaturePlanApprovalView;
  readonly execution: ExecutionBoundaryView;
}

export function buildFeaturePlanDecisionView(
  commandId: string,
  replayed: boolean,
  result: FeaturePlanDecideResult,
): FeaturePlanDecisionCliView {
  return {
    commandId,
    replayed,
    feature: {
      id: result.feature.id,
      revision: result.feature.revision,
      planStatus: result.feature.planStatus,
      planDigest: result.feature.planDigest,
    },
    decision: result.decision,
    approval: {
      decisionId: result.approval.id,
      status: result.approval.status,
      current: result.approval.current,
      subjectDigest: result.approval.subjectDigest,
      checkPolicyDigest: result.approval.checkPolicyDigest,
      reason: result.approval.reason,
      decidedAt: result.approval.decidedAt,
      decisionActor: result.approval.decisionActor,
    },
    execution: EXECUTION_BOUNDARY_VIEW,
  };
}

export function formatFeaturePlanDecisionView(view: FeaturePlanDecisionCliView): string {
  const verb = view.decision === 'approve' ? 'approve' : 'reject';
  const notice =
    view.decision === 'approve'
      ? '（未启动执行；批准只确认现有计划，不重新应用默认策略，未知执行能力不显示为可运行）'
      : '（未启动执行；拒绝不删除计划，未知执行能力不显示为可运行）';
  return (
    `shiploop feature ${verb}: completed feature=${view.feature.id} ` +
    `revision=${view.feature.revision} planStatus=${view.feature.planStatus} ` +
    `planDigest=${view.feature.planDigest} decision=${view.decision} ` +
    `approval=${view.approval.status}${view.replayed ? '（replayed）' : ''}${notice}\n`
  );
}

/* ------------------------------------------------------------------ *
 * task.strategy 结果视图
 * ------------------------------------------------------------------ */

/** Task 策略副本与来源（编辑事实；来源由服务端定值）。 */
export interface TaskStrategyEditCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly task: {
    readonly id: string;
    readonly featureId: string;
    readonly revision: number;
    readonly status: string;
  };
  readonly strategy: {
    readonly executionConfig: Record<string, unknown>;
    readonly configSource: string;
    readonly configSourceKey: string | null;
  };
  readonly execution: ExecutionBoundaryView;
}

export function buildTaskStrategyEditView(
  commandId: string,
  replayed: boolean,
  result: TaskStrategyUpdateResult,
): TaskStrategyEditCliView {
  return {
    commandId,
    replayed,
    task: {
      id: result.task.id,
      featureId: result.task.featureId,
      revision: result.task.revision,
      status: result.task.status,
    },
    strategy: {
      executionConfig: { ...result.task.executionConfig },
      configSource: result.task.configSource,
      configSourceKey: result.task.configSourceKey,
    },
    execution: EXECUTION_BOUNDARY_VIEW,
  };
}

export function formatTaskStrategyEditView(view: TaskStrategyEditCliView): string {
  return (
    `shiploop task strategy: completed task=${view.task.id} feature=${view.task.featureId} ` +
    `revision=${view.task.revision} source=${view.strategy.configSource} ` +
    `sourceKey=${String(view.strategy.configSourceKey)}` +
    `${view.replayed ? '（replayed）' : ''}（完整策略副本整体替换；未启动执行）\n`
  );
}

/* ------------------------------------------------------------------ *
 * task.prepare / task.inputs 固定输入结果视图
 * ------------------------------------------------------------------ */

/** 制品组单正文身份（用途 + 版本 + hash；正文永不内联）。 */
export interface ExecutionInputGroupPartView {
  readonly purpose: 'snapshot' | 'manifest' | 'prompt';
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
}

/** 必需输入引用（用途 + 版本 + hash；来源只有逻辑身份）。 */
export interface ExecutionInputRefView {
  readonly purpose: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
  readonly origin: ExecutionInputRefWire['origin'];
}

/** 固定输入制品组 CLI 结果（可绑定输入身份；未启动执行）。 */
export interface ExecutionInputCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly schemaVersion: number;
  readonly bindable: true;
  readonly preparedAt: string;
  readonly group: readonly ExecutionInputGroupPartView[];
  readonly requiredInputs: readonly ExecutionInputRefView[];
  readonly digests: ExecutionInputPrepareResult['digests'];
  readonly approval: {
    readonly planDigest: string;
    readonly checkPolicyDigest: string;
    readonly decisionId: string | null;
    readonly featureRevision: number;
  };
  readonly taskRevision: number;
  readonly promptBytes: number;
  readonly tokenEstimate: ExecutionInputPrepareResult['tokenEstimate'];
  readonly execution: ExecutionBoundaryView;
}

function groupPart(
  purpose: ExecutionInputGroupPartView['purpose'],
  ref: ExecutionInputGroupBodyRefWire,
): ExecutionInputGroupPartView {
  return {
    purpose,
    artifactId: ref.artifactId,
    version: ref.version,
    contentHash: ref.contentHash,
    sizeBytes: ref.sizeBytes,
    locator: ref.locator,
    mediaType: ref.mediaType,
  };
}

function refView(ref: ExecutionInputRefWire): ExecutionInputRefView {
  return {
    purpose: ref.purpose,
    artifactId: ref.artifactId,
    version: ref.version,
    contentHash: ref.contentHash,
    sizeBytes: ref.sizeBytes,
    locator: ref.locator,
    mediaType: ref.mediaType,
    origin: ref.origin,
  };
}

export function buildExecutionInputView(
  commandId: string,
  replayed: boolean,
  result: ExecutionInputPrepareResult,
): ExecutionInputCliView {
  return {
    commandId,
    replayed,
    schemaVersion: result.schemaVersion,
    bindable: true,
    preparedAt: result.preparedAt,
    group: [
      groupPart('snapshot', result.group.snapshot),
      groupPart('manifest', result.group.manifest),
      groupPart('prompt', result.group.prompt),
    ],
    requiredInputs: result.requiredInputs.map(refView),
    digests: { ...result.digests },
    approval: { ...result.approval },
    taskRevision: result.taskRevision,
    promptBytes: result.promptBytes,
    tokenEstimate: { ...result.tokenEstimate },
    execution: EXECUTION_BOUNDARY_VIEW,
  };
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function formatExecutionInputView(
  view: ExecutionInputCliView,
  command: 'task.prepare' | 'task.inputs',
): string {
  const parts = view.group
    .map((part) => `${part.purpose}=v${part.version}:${shortHash(part.contentHash)}`)
    .join(' ');
  const head =
    command === 'task.prepare'
      ? `shiploop task prepare: completed commandId=${view.commandId}`
      : `shiploop task inputs: commandId=${view.commandId}`;
  return (
    `${head} taskRevision=${view.taskRevision} bindable=${String(view.bindable)} ${parts} ` +
    `inputs=${view.requiredInputs.length} planDigest=${view.approval.planDigest}` +
    `${view.replayed ? '（replayed）' : ''}（固定输入制品组；未启动执行，未知执行能力不显示为可运行）\n`
  );
}
