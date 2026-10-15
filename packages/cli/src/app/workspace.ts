/**
 * P03-5 / F-012 工作区状态展示与人工丢弃预览/确认 CLI 纯视图层。
 *
 * 纯函数模块（无 I/O）：把 HostClient 已线校验的工作区查询结果
 * （workspaces.list/get、workspace.operations.list/get）与丢弃预览/确认回执
 * 投影为 CLI 结构化视图：
 * - 派生分类只是只读投影，不改写权威事实、不产生第二套状态：
 *   - `preparing` 准备中；`prepared` 准备完成（ready，不是 Feature 交付）；
 *   - `retained` 保留（失败默认保留现场）；`quarantined` 隔离；
 *   - `cleanable` 可清理/清理待执行（cleanup_pending）；`cleaned` 实际已清理；
 *   - operation `pending` 不是最终结论；`failed`/`blocked` 是操作失败/受阻；
 * - 命令回执 `accepted` 只是已受理，`completed` 也不等于丢弃/清理操作成功：
 *   实际结果以 workspace operation 查询为准（视图保留 operation/回执/证据引用）；
 * - 不把 Runtime 结束、干净 status 或准备成功显示成 Feature 交付
 *   （completion.featureVerified/delivered 恒 false）；
 * - 预览是确认的授权依据：绑定摘要/HEAD/内容摘要/revision/有效期逐项展示；
 *   确认负载从预览文档派生，Feature 不一致在本地拒绝（不发确认请求）；
 * - 人类行只输出脱敏事实字段；不打印正文、凭据、秘密或绝对路径。
 */
import {
  validateWorkspaceDiscardPreviewWire,
} from 'shiploop-host';
import type {
  PublicWorkspaceOperationRecord,
  PublicWorkspaceRecord,
  WorkspaceDetailResult,
  WorkspaceDiscardPreview,
  WorkspaceDiscardPreviewBinding,
  WorkspaceListResult,
  WorkspaceOperationDetailResult,
  WorkspaceOperationListResult,
} from 'shiploop-host';
import { AppCliParseError } from './args.js';
import type { AppCliCommand, AppCliCommandId } from './args.js';

/* ------------------------------------------------------------------ *
 * 状态分类（只读投影）
 * ------------------------------------------------------------------ */

/** 工作区派生展示状态（只读投影；不落库、不是第二套状态）。 */
export type WorkspaceDisplayState =
  | 'preparing'
  | 'prepared'
  | 'retained'
  | 'quarantined'
  | 'cleanable'
  | 'cleaned';

/** 权威 status → 展示分类（一一映射，未知值 fail-closed）。 */
export function classifyWorkspaceState(
  status: PublicWorkspaceRecord['status'],
): WorkspaceDisplayState {
  switch (status) {
    case 'preparing':
      return 'preparing';
    case 'ready':
      return 'prepared';
    case 'retained':
      return 'retained';
    case 'quarantined':
      return 'quarantined';
    case 'cleanup_pending':
      return 'cleanable';
    case 'cleaned':
      return 'cleaned';
    default: {
      const exhaustive: never = status;
      throw new TypeError(`未覆盖的工作区状态：${String(exhaustive)}`);
    }
  }
}

/** operation 记录的派生分类（状态/阶段原样保留；pending 不是最终结论）。 */
export interface WorkspaceOperationClassification {
  /** 终态（succeeded/failed/blocked）；pending 为 false。 */
  readonly terminal: boolean;
  /** 操作失败（failed；保留原因与证据/错误引用）。 */
  readonly failed: boolean;
  /** 操作受阻（blocked；停止不确定等，现场已隔离）。 */
  readonly blocked: boolean;
  /** succeeded 只是该 operation 完成，不代表 Feature 交付或验收通过。 */
  readonly succeeded: boolean;
}

export function classifyWorkspaceOperation(
  record: PublicWorkspaceOperationRecord,
): WorkspaceOperationClassification {
  return {
    terminal: record.status !== 'pending',
    failed: record.status === 'failed',
    blocked: record.status === 'blocked',
    succeeded: record.status === 'succeeded',
  };
}

/* ------------------------------------------------------------------ *
 * 统一的不交付声明
 * ------------------------------------------------------------------ */

/** 工作区视图统一的不交付声明（准备/保留/清理/丢弃都不是 Feature 交付）。 */
export interface WorkspaceCompletionBoundary {
  readonly featureVerified: false;
  readonly delivered: false;
  readonly note: string;
}

export const WORKSPACE_COMPLETION_NOTE =
  '工作区状态是只读投影：accepted、准备完成、保留、可清理或实际已清理均不代表 Feature 交付；' +
  '可信项目模式不提供强 OS 隔离；失败默认保留现场；本阶段（P03-5）尚无完整 Runtime/提交闭环';

function completionBoundary(): WorkspaceCompletionBoundary {
  return { featureVerified: false, delivered: false, note: WORKSPACE_COMPLETION_NOTE };
}

/* ------------------------------------------------------------------ *
 * workspaces.list / workspaces.get 视图
 * ------------------------------------------------------------------ */

export interface WorkspaceListEntryView {
  readonly record: PublicWorkspaceRecord;
  readonly state: WorkspaceDisplayState;
}

export interface WorkspaceListView {
  readonly operation: 'workspaces.list';
  readonly records: readonly WorkspaceListEntryView[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly completion: WorkspaceCompletionBoundary;
}

export function buildWorkspaceListView(result: WorkspaceListResult): WorkspaceListView {
  return {
    operation: 'workspaces.list',
    records: result.records.map((record) => ({
      record,
      state: classifyWorkspaceState(record.status),
    })),
    nextCursor: result.nextCursor,
    limit: result.limit,
    completion: completionBoundary(),
  };
}

function workspaceSummaryLine(entry: WorkspaceListEntryView): string {
  const record = entry.record;
  return (
    `  workspace=${record.id} feature=${record.featureId} state=${entry.state} ` +
    `status=${record.status} revision=${record.revision} branch=${record.branch} ` +
    `base=${record.baseCommit} head=${record.headCommit ?? 'unknown'} ` +
    `codeDigest=${record.codeDigest ?? 'unknown'} run=${record.runId} attempt=${record.attemptId} ` +
    `updatedAt=${record.updatedAt}`
  );
}

export function formatWorkspaceListView(view: WorkspaceListView): string {
  const lines = [
    `shiploop workspace list: records=${view.records.length} ` +
      `nextCursor=${view.nextCursor ?? 'none'}`,
  ];
  for (const entry of view.records) {
    lines.push(workspaceSummaryLine(entry));
  }
  lines.push(`  （${WORKSPACE_COMPLETION_NOTE}）`, '');
  return lines.join('\n');
}

export interface WorkspaceDetailView {
  readonly operation: 'workspaces.get';
  readonly workspace: PublicWorkspaceRecord;
  readonly state: WorkspaceDisplayState;
  readonly preparationOperation: PublicWorkspaceOperationRecord | null;
  readonly latestOperation: PublicWorkspaceOperationRecord | null;
  readonly latestClassification: WorkspaceOperationClassification | null;
  readonly completion: WorkspaceCompletionBoundary;
}

export function buildWorkspaceDetailView(result: WorkspaceDetailResult): WorkspaceDetailView {
  return {
    operation: 'workspaces.get',
    workspace: result.workspace,
    state: classifyWorkspaceState(result.workspace.status),
    preparationOperation: result.preparationOperation,
    latestOperation: result.latestOperation,
    latestClassification:
      result.latestOperation === null ? null : classifyWorkspaceOperation(result.latestOperation),
    completion: completionBoundary(),
  };
}

function operationSummaryLine(record: PublicWorkspaceOperationRecord): string {
  const classification = classifyWorkspaceOperation(record);
  const marks: string[] = [];
  if (!classification.terminal) {
    marks.push('pending_not_outcome');
  }
  if (classification.failed) {
    marks.push('operation_failed');
  }
  if (classification.blocked) {
    marks.push('operation_blocked');
  }
  const markText = marks.length > 0 ? ` marks=${marks.join(',')}` : '';
  return (
    `  operation=${record.id} kind=${record.kind} stage=${record.executionStage} ` +
    `status=${record.status} revision=${record.revision} command=${record.commandId} ` +
    `receipt=${record.receipt.status} reason=${record.receipt.reason ?? 'none'} ` +
    `exit=${record.result?.exitCode ?? 'unknown'} ` +
    `evidence=${record.result === null ? 'none' : record.result.evidenceRefs.join(',') || 'none'} ` +
    `errorRef=${record.result?.errorRef ?? 'none'}${markText}`
  );
}

export function formatWorkspaceDetailView(view: WorkspaceDetailView): string {
  const record = view.workspace;
  const lines = [
    `shiploop workspace get: feature=${record.featureId} workspace=${record.id} ` +
      `state=${view.state} status=${record.status} revision=${record.revision}`,
    `  branch=${record.branch} base=${record.baseCommit} ` +
      `head=${record.headCommit ?? 'unknown'} codeDigest=${record.codeDigest ?? 'unknown'} ` +
      `binding=${record.repositoryBindingId}#${record.repositoryBindingRevision} ` +
      `run=${record.runId} attempt=${record.attemptId} ` +
      `createdAt=${record.createdAt} updatedAt=${record.updatedAt}`,
  ];
  if (view.preparationOperation !== null) {
    lines.push('  准备 operation：');
    lines.push(operationSummaryLine(view.preparationOperation));
  }
  if (view.latestOperation !== null && view.latestOperation.id !== view.preparationOperation?.id) {
    lines.push('  最新 operation：');
    lines.push(operationSummaryLine(view.latestOperation));
  }
  lines.push(`  （${WORKSPACE_COMPLETION_NOTE}）`, '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * workspace.operations.list / workspace.operations.get 视图
 * ------------------------------------------------------------------ */

export interface WorkspaceOperationEntryView {
  readonly record: PublicWorkspaceOperationRecord;
  readonly classification: WorkspaceOperationClassification;
}

export interface WorkspaceOperationListView {
  readonly operation: 'workspace.operations.list';
  readonly records: readonly WorkspaceOperationEntryView[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly completion: WorkspaceCompletionBoundary;
}

export function buildWorkspaceOperationListView(
  result: WorkspaceOperationListResult,
): WorkspaceOperationListView {
  return {
    operation: 'workspace.operations.list',
    records: result.records.map((record) => ({
      record,
      classification: classifyWorkspaceOperation(record),
    })),
    nextCursor: result.nextCursor,
    limit: result.limit,
    completion: completionBoundary(),
  };
}

export function formatWorkspaceOperationListView(view: WorkspaceOperationListView): string {
  const lines = [
    `shiploop workspace operations: records=${view.records.length} ` +
      `nextCursor=${view.nextCursor ?? 'none'}`,
  ];
  for (const entry of view.records) {
    lines.push(operationSummaryLine(entry.record));
  }
  lines.push(
    '  （pending 不是最终结论；succeeded 只是该 operation 完成，不代表 Feature 交付）',
    `  （${WORKSPACE_COMPLETION_NOTE}）`,
    '',
  );
  return lines.join('\n');
}

export interface WorkspaceOperationDetailView {
  readonly operation: 'workspace.operations.get';
  readonly record: PublicWorkspaceOperationRecord;
  readonly classification: WorkspaceOperationClassification;
  readonly completion: WorkspaceCompletionBoundary;
}

export function buildWorkspaceOperationDetailView(
  result: WorkspaceOperationDetailResult,
): WorkspaceOperationDetailView {
  return {
    operation: 'workspace.operations.get',
    record: result.operation,
    classification: classifyWorkspaceOperation(result.operation),
    completion: completionBoundary(),
  };
}

export function formatWorkspaceOperationDetailView(view: WorkspaceOperationDetailView): string {
  const record = view.record;
  const lines = [
    `shiploop workspace operation: operation=${record.id} kind=${record.kind} ` +
      `status=${record.status} stage=${record.executionStage}`,
    `  feature=${record.featureId} workspace=${record.workspaceId} run=${record.runId} ` +
      `attempt=${record.attemptId} revision=${record.revision}`,
    `  command=${record.commandId} principal=${record.principalId} ` +
      `receipt=${record.receipt.status} receiptCommand=${record.receipt.commandId} ` +
      `resultRef=${record.receipt.resultRef ?? 'none'} reason=${record.receipt.reason ?? 'none'}`,
    operationSummaryLine(record),
    `  createdAt=${record.createdAt} updatedAt=${record.updatedAt}`,
    '  （pending 不是最终结论；命令 completed 不等于该 operation 成功）',
    `  （${WORKSPACE_COMPLETION_NOTE}）`,
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * workspace.discard-preview / workspace.discard 视图
 * ------------------------------------------------------------------ */

/**
 * 丢弃预览视图：`preview` 是 HostClient 已线校验的原始预览文档（逐字节回喂
 * 即合法 --preview-file；不含绝对路径/内容正文）；state/expiresAt 为派生展示。
 */
export interface WorkspaceDiscardPreviewView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly preview: WorkspaceDiscardPreview;
  readonly state: WorkspaceDisplayState;
  readonly expiresAt: string;
  readonly notice: string;
  readonly completion: WorkspaceCompletionBoundary;
}

export const WORKSPACE_DISCARD_PREVIEW_NOTICE =
  '预览不是删除：确认必须显式 workspace discard <featureId> --preview-file <file> --confirm；' +
  '预览绑定当前 revision/HEAD/内容摘要且有有效期，过期或内容变化确认将被拒绝（零删除）；' +
  '丢弃范围固定为受管工作区目录与其 Git 登记（worktree_only），分支/源仓库/已提交成果/审计记录保留';

export function buildWorkspaceDiscardPreviewView(
  commandId: string,
  replayed: boolean,
  preview: WorkspaceDiscardPreview,
): WorkspaceDiscardPreviewView {
  return {
    commandId,
    replayed,
    preview,
    state: classifyWorkspaceState(preview.status),
    expiresAt: new Date(preview.expiresAtUtcMs).toISOString(),
    notice: WORKSPACE_DISCARD_PREVIEW_NOTICE,
    completion: completionBoundary(),
  };
}

export function formatWorkspaceDiscardPreviewView(view: WorkspaceDiscardPreviewView): string {
  const preview = view.preview;
  const blockers =
    preview.blockers.length === 0 ? 'none' : preview.blockers.join(',');
  return [
    `shiploop workspace discard-preview: command=${view.commandId} replayed=${view.replayed} ` +
      `feature=${preview.featureId} workspace=${preview.workspaceId} state=${view.state} ` +
      `status=${preview.status} revision=${preview.workspaceRevision}`,
    `  branch=${preview.branch} head=${preview.headCommit} ` +
      `tracked=${preview.contents.counts.tracked} untracked=${preview.contents.counts.untracked} ` +
      `ignored=${preview.contents.counts.ignored} bytes=${preview.contents.counts.bytes} ` +
      `truncated=${preview.contents.truncated} blockers=${blockers}`,
    `  previewDigest=${preview.previewDigest} expiresAt=${view.expiresAt} ` +
      `evidenceRef=${preview.evidenceRef} scope=${preview.scope} ` +
      `preserves=${preview.impact.preserves.join(',')}`,
    `  （${WORKSPACE_DISCARD_PREVIEW_NOTICE}）`,
    `  （${WORKSPACE_COMPLETION_NOTE}）`,
    '',
  ].join('\n');
}

/** 丢弃确认回执摘要（命令 completed ≠ 丢弃成功；实际结果经 operation 查询）。 */
export interface WorkspaceDiscardSubmitResult {
  readonly workspaceOperationId: string;
  readonly workspaceId: string;
  readonly previewDigest: string;
}

export interface WorkspaceDiscardSubmitView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly result: WorkspaceDiscardSubmitResult;
  readonly notice: string;
  readonly completion: WorkspaceCompletionBoundary;
}

export const WORKSPACE_DISCARD_SUBMIT_NOTICE =
  '确认命令已完成登记（completed 不等于丢弃成功）：实际删除结果以 ' +
  'workspace operation <workspaceOperationId> 与 workspace get <featureId> 为准；' +
  '失败/受阻会记录为 failed/blocked operation 并保留或隔离现场，绝不冒充成功';

export function buildWorkspaceDiscardSubmitView(
  commandId: string,
  replayed: boolean,
  result: WorkspaceDiscardSubmitResult,
): WorkspaceDiscardSubmitView {
  return {
    commandId,
    replayed,
    result,
    notice: WORKSPACE_DISCARD_SUBMIT_NOTICE,
    completion: completionBoundary(),
  };
}

export function formatWorkspaceDiscardSubmitView(view: WorkspaceDiscardSubmitView): string {
  return [
    `shiploop workspace discard: command=${view.commandId} replayed=${view.replayed} ` +
      `workspaceOperation=${view.result.workspaceOperationId} ` +
      `workspace=${view.result.workspaceId} previewDigest=${view.result.previewDigest}`,
    `  （${WORKSPACE_DISCARD_SUBMIT_NOTICE}）`,
    `  （${WORKSPACE_COMPLETION_NOTE}）`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 丢弃预览文档解析与确认负载派生（纯函数；文件读取在执行层）
 * ------------------------------------------------------------------ */

/** 输入守护上下文（与 baseline 输入校验同一错误口径）。 */
export interface WorkspaceInputContext {
  readonly command: AppCliCommand;
  readonly commandId?: AppCliCommandId | null;
  readonly json?: boolean;
}

function previewFileError(
  context: WorkspaceInputContext,
  reason: 'invalid_preview_file' | 'preview_feature_mismatch',
): AppCliParseError {
  return new AppCliParseError(
    'invalid_input',
    reason,
    {
      command: context.command,
      commandId: context.commandId ?? null,
      json: context.json ?? false,
    },
    'preview-file',
  );
}

/**
 * 解析 `--preview-file` 的 JSON 内容为丢弃预览（复用 Host 线校验器的同一冻结
 * 形状把关；任何形状/绑定字段违法在本地拒绝，不发确认请求）。
 */
export function parseWorkspaceDiscardPreviewDocument(
  payload: Record<string, unknown>,
  context: WorkspaceInputContext,
): WorkspaceDiscardPreview {
  try {
    return validateWorkspaceDiscardPreviewWire(payload, 'commands.submit');
  } catch {
    throw previewFileError(context, 'invalid_preview_file');
  }
}

/** 确认负载（workspace.discard payload， minus operationId/commandId/projectId）。 */
export interface WorkspaceDiscardConfirmPayload {
  readonly featureId: string;
  readonly workspaceId: string;
  readonly expectedWorkspaceRevision: number;
  readonly preview: WorkspaceDiscardPreviewBinding;
  readonly evidenceRefs: readonly string[];
}

/**
 * 从预览文档派生确认负载：Feature 必须一致（不一致在本地拒绝，不发确认请求）；
 * expectedWorkspaceRevision 绑定预览时的 workspace revision；证据引用只携带
 * 预览发布的不可变证据。
 */
export function buildWorkspaceDiscardConfirmPayload(
  preview: WorkspaceDiscardPreview,
  featureId: string,
  context: WorkspaceInputContext,
): WorkspaceDiscardConfirmPayload {
  if (preview.featureId !== featureId) {
    throw previewFileError(context, 'preview_feature_mismatch');
  }
  return {
    featureId: preview.featureId,
    workspaceId: preview.workspaceId,
    expectedWorkspaceRevision: preview.workspaceRevision,
    preview: {
      previewDigest: preview.previewDigest,
      headCommit: preview.headCommit,
      codeDigest: preview.codeDigest,
      ignoredDigest: preview.ignoredDigest,
      workspaceRevision: preview.workspaceRevision,
      expiresAtUtcMs: preview.expiresAtUtcMs,
    },
    evidenceRefs: [preview.evidenceRef],
  };
}
