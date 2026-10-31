/**
 * F-015/F-016/F-017/F-010 应用命令 CLI 纵向执行层（契约 §12.1/§12.2/§12.3、
 * §5.5/§5.7、§6、§7、§8/§9.4）。
 *
 * 与 F-014 纯面层的边界（`app/` 目录保持纯函数、无 I/O）：
 * - 本模块允许 I/O：经 `shiploop-host` 公共面 `ensureHostRunning` 连接或受控
 *   启动同一单例 Host，再经 HostClient 提交命令/执行查询；不直连 shiploop-core、
 *   不打开 SQLite、不读认证文件（凭据只由 Host 存储/客户端面读取）；
 * - 解析仍由纯面层 `parseAppCliArgs` 完成；解析失败在任何 I/O 之前返回退出码 2；
 * - 写命令复用 HostClient 的冻结信封与「超时先查回执」；显式 `--command-id`
 *   先查该身份下的既有回执并以其 `issuedAt` 重建同一信封，使相同参数的重复
 *   提交命中服务端摘要重放（返回原回执），不同参数则得到 conflict；
 * - 输出纪律：`--json` 时 stdout 只输出一个信封 JSON；人类诊断走 stderr；
 *   任何输出都不含 token、Authorization 头或堆栈。
 *
 * import 本模块即把 Host 启动编排装入图（有 I/O 能力），但不读 argv/env、
 * 不访问网络、不 spawn——只有 `runAppCli` 显式调用才执行。
 * `packages/cli/src/index.ts` 公共入口不 re-export 本模块（显式入口 bin.ts 专用）。
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import {
  ensureHostRunning,
  isHostProtocolError,
  isPlainObject,
  HostProtocolError,
  MAX_APP_BODY_BYTES,
  SNAPSHOT_ROUTE,
  validateExecutionInputPrepareResultWire,
  type ExecutionInputPrepareResult,
  type ExecutionPreviewResult,
  type FeatureDeliveryCommandResult,
  type FeaturePlanDecideResult,
  type HostClient,
  type HostClientTimeouts,
  type HostEventSubscription,
  type SubmitCommandInput,
  type SubscribeEventsInput,
  type TaskApprovalBlockResult,
  type TaskApprovalDecisionResult,
  type TaskStrategyUpdateResult,
  type TaskVerificationContinueResult,
} from 'shiploop-host';
import { AppCliParseError, parseAppCliArgs, parseAppInputJson } from './app/args.js';
import {
  buildExecutionBudgetView,
  buildExecutionPreviewView,
  buildExecutionReviseView,
  buildExecutionStartView,
  formatExecutionBudgetView,
  formatExecutionPreviewView,
  formatExecutionReviseView,
  formatExecutionStartView,
  parseExecutionBudgetDocument,
} from './app/execution.js';
import type { ExecutionBudgetWire } from './app/execution.js';
import {
  buildExecutionAttemptsView,
  buildExecutionDiagnosticsView,
  buildExecutionDispatchView,
  buildExecutionScheduleView,
  formatExecutionAttemptsView,
  formatExecutionDiagnosticsView,
  formatExecutionDispatchView,
  formatExecutionScheduleView,
} from './app/schedule.js';
import {
  buildAttemptCancelView,
  buildWorkSessionDetailView,
  buildWorkSessionEvidenceView,
  buildWorkSessionListView,
  formatAttemptCancelView,
  formatWorkSessionDetailView,
  formatWorkSessionEvidenceView,
  formatWorkSessionListView,
} from './app/work-session.js';
import {
  buildWorkRecordingBodyView,
  buildWorkRecordingListView,
  formatWorkRecordingBodyView,
  formatWorkRecordingListView,
} from './app/work-recording.js';
import type { WorkRecordingParent } from './app/work-recording.js';
import {
  buildExecutionControlCommandView,
  buildExecutionControlQueryView,
  buildExecutionResourceQueryView,
  buildExecutionRecoveryCliView,
  buildExecutionRetryFinalView,
  formatExecutionResourceQueryView,

  formatExecutionControlCommandView,
  formatExecutionControlQueryView,
  formatExecutionRecoveryCliView,
  formatExecutionRetryFinalView,
} from './app/run-control.js';
import type { ExecutionControlOperation } from './app/run-control.js';
import {
  buildWorkspaceDiscardConfirmPayload,
  buildWorkspaceDiscardPreviewView,
  buildWorkspaceDiscardSubmitView,
  buildWorkspaceDetailView,
  buildWorkspaceListView,
  buildWorkspaceOperationDetailView,
  buildWorkspaceOperationListView,
  formatWorkspaceDiscardPreviewView,
  formatWorkspaceDiscardSubmitView,
  formatWorkspaceDetailView,
  formatWorkspaceListView,
  formatWorkspaceOperationDetailView,
  formatWorkspaceOperationListView,
  parseWorkspaceDiscardPreviewDocument,
} from './app/workspace.js';
import type {
  WorkspaceDiscardConfirmPayload,
  WorkspaceDiscardSubmitResult,
} from './app/workspace.js';
import {
  buildExecutionInputView,
  buildFeaturePlanDecisionView,
  buildTaskStrategyEditView,
  formatExecutionInputView,
  formatFeaturePlanDecisionView,
  formatTaskStrategyEditView,
  parsePrepareItemsPayload,
  scanStrategyInputFields,
} from './app/decisions.js';
import {
  buildPlanningCandidateView,
  buildPlanningClientInput,
  buildPlanningContextDetailView,
  buildPlanningContextListView,
  buildPlanningDecisionView,
  buildPlanningStartView,
  formatPlanningCandidateView,
  formatPlanningContextDetailView,
  formatPlanningContextListView,
  formatPlanningDecisionView,
  formatPlanningStartView,
  parsePlanningStartInput,
} from './app/planning.js';
import type { PlanningStartInputDocument } from './app/planning.js';
import {
  buildIntegrationPlanCliView,
  formatIntegrationPlanView,
  buildBatchDeliveryView,
  formatBatchDeliveryView,
  buildBatchObservationView,
  formatBatchObservationView,
  buildBatchDeliveryCommandView,
  formatBatchDeliveryCommandView,
  buildFeatureDeliveryView,
  buildFeatureFinalApprovalView,
  buildFeatureFinalizeView,
  buildGitOperationDetailView,
  buildGitOperationListView,
  buildGitAgentRepairListView,
  buildGitAgentRepairView,
  formatFeatureDeliveryView,
  formatFeatureFinalApprovalView,
  formatFeatureFinalizeView,
  formatGitOperationDetailView,
  formatGitOperationListView,
  formatGitAgentRepairListView,
  formatGitAgentRepairView,
} from './app/delivery.js';
import { buildFeatureReportTextView, formatFeatureReportTextView } from './app/report.js';
import {
  buildTaskApprovalBlockView,
  buildTaskApprovalDecisionView,
  buildTaskStatusView,
  buildTaskVerificationContinueView,
  formatTaskApprovalBlockView,
  formatTaskApprovalDecisionView,
  formatTaskStatusView,
  formatTaskVerificationContinueView,
  parseArtifactRefValues,
  scanConfigPolicyInputFields,
} from './app/approvals.js';
import type {
  ParsedTaskApprovalBlock,
  ParsedTaskApprovalDecision,
  ParsedTaskStatus,
  ParsedTaskVerificationContinue,
} from './app/args.js';
import {
  BASELINE_INPUT_TIMEOUT_MAX_MS,
  baselineCliExitCode,
  buildBaselineCommandResult,
  buildBaselineEvidenceResult,
  buildBaselineListResult,
  buildBaselineOperationResult,
  buildBaselinePreviewResult,
  buildBaselineRunConfirmationNotice,
  formatBaselineCommandResult,
  formatBaselineEvidenceResult,
  formatBaselineListResult,
  formatBaselineOperationResult,
  formatBaselineComparison,
  formatBaselinePreview,
  parseBaselineCheckPlanText,
} from './app/baseline.js';
import type {
  BaselineAuthorizationView,
  BaselineCheckPlanView,
  BaselineOperationResultView,
  BaselineOperationStatusView,
  BaselinePreviewWireView,
} from './app/baseline.js';
import type {
  AppCliCommandId,
  ParsedAppCliCommand,
  ParsedBaselineCancel,
  ParsedBaselinePreview,
  ParsedBaselineRun,
  ParsedConfigCreate,
  ParsedConfigUpdate,
  ParsedEventsObserve,
  ParsedKnowledgeCommand,
  ParsedKnowledgeSearch,
  ParsedKnowledgeRead,
  ParsedPlanningStart,
  ParsedPlanningList,
  ParsedPlanningGet,
  ParsedPlanningDecision,
  ParsedFeatureImport,
  ParsedFeatureRevise,
  ParsedPlanLabels,
  ParsedProjectInit,
  ParsedProjectOverview,
  ParsedProjectRepositoryMovePreview,
  ParsedProjectRepositoryMoveConfirm,
  ParsedProjectProfileCommand,
  ParsedReceiptGet,
  ParsedTaskPrepare,
  ParsedTaskStrategy,
  ParsedPhaseDeliveryApprove,
} from './app/args.js';
import type {
  WorkspaceDiscardPreview,
} from 'shiploop-host';
import {
  createOfflineBackupVerificationService,
  createOfflineRestoreService,
} from 'shiploop-host';
import { CLI_EXIT_REJECTED } from './host/output.js';
import { formatTaskStrategyReapplicationPreview, formatTaskStrategyReapplicationResult } from './app/task-strategy-reapplication.js';
import type { TaskStrategyReapplicationInput, TaskStrategyReapplicationResult } from 'shiploop-host';
import { getAppCliHelp } from './app/help.js';
import {
  formatKnowledgeReadText,
  formatKnowledgeSearchText,
} from './app/knowledge.js';
import {
  buildInitCliResult,
  buildInitConfirmationNotice,
  composeAppCliStreams,
  formatInitCliResult,
  formatInitPreview,
  formatOverviewResult,
  resolveInitConfirmation,
} from './app/onboarding.js';
import type {
  InitRegistrationOutcome,
  InitRequestView,
  ProjectOverviewView,
} from './app/onboarding.js';
import {
  formatRepositoryMoveConfirmation,
  formatRepositoryMovePreview,
  parseRepositoryMovePreviewDocument,
} from './app/repository-move.js';
import type { BrownfieldMovePreview } from './app/repository-move.js';

import {
  buildAppCliFailureEnvelope,
  buildAppCliSuccessEnvelope,
  CLI_EXIT_OBSERVATION_INTERRUPTED,
  exitCodeForAppErrorCode,
  exitCodeForReceiptStatus,
  formatAppCliParseError,
} from './app/output.js';
import type { AppCliFailureEnvelope, AppCliSuccessEnvelope } from './app/output.js';
import { CLI_EXIT_OK } from './host/output.js';
import type { CliExitCode } from './host/output.js';

export type { AppCliFailureEnvelope, AppCliSuccessEnvelope } from './app/output.js';

/** 输出端口：bin.ts 接 process.stdout/stderr；测试收集为字符串。 */
export interface AppCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** 受信测试注入：启动器装配覆盖（干净树用 TS 入口；生产默认 dist/start.js）。 */
export interface AppCliLaunchOverrides {
  readonly entryArgv?: readonly string[];
  readonly nodeExecutable?: string;
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
  readonly onCandidateSpawned?: (pid: number | undefined) => void;
  readonly pollIntervalMs?: number;
}

export interface RunAppCliOptions {
  /** process.argv.slice(2) 形态；不直接读 process.argv。 */
  readonly args: readonly string[];
  /** 显式注入的环境（bin.ts 传 process.env）；监听覆盖在此解析。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 工作目录注入（bin.ts 传 process.cwd()）：project init 相对路径解析基准。 */
  readonly cwd?: string;
  readonly io: AppCliIo;
  /** 平台注入口（默认 process.platform）；非 darwin 在任何 I/O 前拒绝。 */
  readonly platform?: string;
  /** 用户目录注入口（默认 os.homedir()）；仅用于省略 --data-root 时推导默认根。 */
  readonly userHomeDir?: string;
  /** HostClient 有限预算覆盖（受信装配/测试注入；绝非 argv/env）。 */
  readonly timeouts?: HostClientTimeouts;
  /** 启动器覆盖（entryArgv/子进程 env 等）。 */
  readonly launch?: AppCliLaunchOverrides;
  /**
   * F-017 观察中断信号（bin.ts 把 SIGINT 接入；测试注入 AbortController）。
   * 仅 events 观察命令消费：中断只结束本次观察（退出码 4），不停止 Host、
   * 不取消已提交命令。
   */
  readonly signal?: AbortSignal;
  /** F-017 观察预算覆盖（受信装配/测试注入；绝非 argv/env；全部有界）。 */
  readonly observe?: EventsObserveBudgets;
  /** F-016 基线等待/跟随观察预算覆盖（受信装配/测试注入；绝非 argv/env；全部有界）。 */
  readonly baselineObserve?: BaselineObserveBudgets;
}

export type AppCliRunKind = 'success' | 'failure' | 'help';

export interface AppCliRunResult {
  readonly exitCode: CliExitCode;
  readonly kind: AppCliRunKind;
  /** 失败且命令不可识别时为 null；帮助为 null。 */
  readonly command: AppCliCommandId | null;
  /** --json 时即打印到 stdout 的信封；非 JSON/帮助时为 undefined。 */
  readonly envelope?: AppCliSuccessEnvelope<unknown> | AppCliFailureEnvelope;
}

const SUPPORTED_PLATFORM = 'darwin';

/** 命令操作/回执的窄类型（避免 CLI 直接依赖 Core 协议类型）。 */
type CommandReceipt = Awaited<ReturnType<HostClient['submitCommand']>>;
type AcceptedReceipt = Extract<CommandReceipt, { status: 'accepted' }>;
type BackupQueryResult = Awaited<ReturnType<HostClient['getBackup']>>;
type BackupOperationResult = Awaited<ReturnType<HostClient['getBackupOperation']>>;
type CompletedReceipt = Extract<CommandReceipt, { status: 'completed' }>;
type ProjectDetailResult = Awaited<ReturnType<HostClient['getProject']>>;
type ProjectListResult = Awaited<ReturnType<HostClient['listProjects']>>;
type ProjectLabelCountsResult = Awaited<ReturnType<HostClient['countProjectLabels']>>;
type ProjectInspectionResult = Awaited<ReturnType<HostClient['inspectRepository']>>;
type ProjectOverviewResult = Awaited<ReturnType<HostClient['getProjectOverview']>>;
type RepositoryMovePreviewResult = Awaited<ReturnType<HostClient['previewRepositoryMove']>>;
type ProjectProfileQueryResult = Awaited<ReturnType<HostClient['getProjectProfile']>>;
type ProjectProfileMatchQueryResult = Awaited<ReturnType<HostClient['matchProjectProfile']>>;
type SettingsStateResult = Awaited<ReturnType<HostClient['getGlobalSettings']>>;
type EffectiveSettingsResult = Awaited<ReturnType<HostClient['getEffectiveSettings']>>;
type ExportedSettingsResult = Awaited<ReturnType<HostClient['exportGlobalSettings']>>;
type PhaseListResult = Awaited<ReturnType<HostClient['listPhases']>>;
type PhaseDetailResult = Awaited<ReturnType<HostClient['getPhase']>>;
type FeatureListResult = Awaited<ReturnType<HostClient['listFeatures']>>;
type FeatureDetailResult = Awaited<ReturnType<HostClient['getFeature']>>;
type TaskListResult = Awaited<ReturnType<HostClient['listTasks']>>;
type TaskDetailResult = Awaited<ReturnType<HostClient['getTask']>>;
type RunListResult = Awaited<ReturnType<HostClient['listRuns']>>;
type EntityLabelCountsResult = Awaited<ReturnType<HostClient['getLabelCounts']>>;

type ParsedPlanningCommand = Extract<ParsedAppCliCommand, { command: 'planning' }>;

/** 计划命令（phase/feature/task）的解析形态（F-010）。 */
type ParsedPlanCommand = Extract<ParsedAppCliCommand, { command: 'phase' | 'feature' | 'task' | 'integration' }>;

/** P03-3 / F-012 执行授权命令（execution preview/start/budget/revise）的解析形态。 */
type ParsedExecutionCommand = Extract<ParsedAppCliCommand, { command: 'execution' }>;

/** 基线子命令（preview/run/list/status/cancel/evidence）的解析形态。 */
type ParsedBaselineCommand = Extract<ParsedAppCliCommand, { command: 'baseline' }>;

/** 配置命令（create/update/get/effective/export）的解析形态。 */
type ParsedConfigCommand = Extract<ParsedAppCliCommand, { command: 'config' }>;
/** 携带 scope 的配置命令子集（effective 无 scope）。 */
type ScopedConfigCommand = Extract<ParsedConfigCommand, { scope: 'global' | 'project' }>;

/** 根来源二选一：显式 --data-root 优先，省略时才用注入用户目录推导默认根。 */
function rootSource(
  dataRoot: string | undefined,
  userHomeDir: string | undefined,
): { dataRoot?: string } | { userHomeDir?: string } {
  if (dataRoot !== undefined) {
    return { dataRoot };
  }
  return userHomeDir !== undefined ? { userHomeDir } : {};
}

interface FailureResult {
  readonly exitCode: CliExitCode;
  readonly command: AppCliCommandId | null;
  readonly code: string;
  readonly message: string;
  readonly commandId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 失败输出：JSON 信封到 stdout（--json）；人类诊断始终到 stderr。 */
function emitFailure(io: AppCliIo, json: boolean, failure: FailureResult): AppCliRunResult {
  const envelope = buildAppCliFailureEnvelope(failure.command, failure.code, failure.message, {
    ...(failure.commandId !== undefined ? { commandId: failure.commandId } : {}),
    ...(failure.details !== undefined ? { details: failure.details } : {}),
  });
  if (json) {
    io.stdout(`${JSON.stringify(envelope)}\n`);
  }
  io.stderr(`shiploop: ${failure.code}: ${failure.message}\n`);
  return {
    exitCode: failure.exitCode,
    kind: 'failure',
    command: failure.command,
    ...(json ? { envelope } : {}),
  };
}

/**
 * 协议/传输错误 → §12.3 失败结果。提交类命令携带显式 --command-id 时保留
 * 该 commandId（契约 §12.2：错误保留 commandId 以便查回执）。
 */
function protocolFailure(
  command: AppCliCommandId,
  error: HostProtocolError,
  submissionCommandId?: string,
): FailureResult {
  return {
    exitCode: exitCodeForAppErrorCode(error.code),
    command,
    code: error.code,
    message: error.message ?? 'Host 协议错误（已脱敏）',
    ...(submissionCommandId !== undefined ? { commandId: submissionCommandId } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}

/** 命令意图携带的显式 --command-id（提交类命令才有；供错误信封保留）。 */
function explicitCommandIdOf(command: ParsedAppCliCommand): string | undefined {
  return (command as { explicitCommandId?: string }).explicitCommandId;
}

/** 解析失败统一出口（退出码 2）：JSON 信封到 stdout（--json），诊断到 stderr。 */
function emitParseFailure(
  io: AppCliIo,
  error: AppCliParseError,
  jsonFlag: boolean,
): AppCliRunResult {
  const details: Record<string, unknown> = { reason: error.reason };
  if (error.field !== undefined) {
    details.field = error.field;
  }
  const json = error.json || jsonFlag;
  const envelope = json
    ? buildAppCliFailureEnvelope(error.commandId, error.code, error.message, { details })
    : undefined;
  if (envelope !== undefined) {
    io.stdout(`${JSON.stringify(envelope)}\n`);
  }
  io.stderr(formatAppCliParseError(error));
  return {
    exitCode: 2,
    kind: 'failure',
    command: error.commandId,
    ...(envelope !== undefined ? { envelope } : {}),
  };
}

/** 成功输出：--json 信封到 stdout；否则人类行到 stdout。 */
function emitSuccess(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  result: unknown,
  human: string,
): AppCliRunResult {
  const commandId = command.commandId;
  if (command.json) {
    const envelope = buildAppCliSuccessEnvelope(commandId, result);
    io.stdout(`${JSON.stringify(envelope)}\n`);
    return { exitCode: CLI_EXIT_OK, kind: 'success', command: commandId, envelope };
  }
  io.stdout(human);
  return { exitCode: CLI_EXIT_OK, kind: 'success', command: commandId };
}

/* ------------------------------------------------------------------ *
 * 人类可读行（脱敏；不含凭据/堆栈）
 * ------------------------------------------------------------------ */

function projectRegisteredHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as
    | { status?: string; project?: { id?: string; revision?: number; displayName?: string } }
    | undefined;
  const project = result?.project ?? {};
  const status = result?.status ?? receipt.status;
  return (
    `shiploop project register: ${status} project=${String(project.id)} ` +
    `name=${String(project.displayName)} revision=${String(project.revision)}\n`
  );
}

function projectEditedHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as { project?: { id?: string; revision?: number } } | undefined;
  const project = result?.project ?? {};
  return (
    `shiploop project edit: updated project=${String(project.id)} ` +
    `revision=${String(project.revision)}${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function projectListHumanLine(result: ProjectListResult): string {
  const lines = [`shiploop project list: ${result.records.length} project(s)`];
  for (const record of result.records) {
    const labels = record.labels.length > 0 ? ` [${record.labels.join(',')}]` : '';
    lines.push(`  - ${record.id} ${record.displayName} r${record.revision}${labels}`);
  }
  if (result.nextCursor !== null) {
    lines.push(`  nextCursor=${result.nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

function projectDetailHumanLine(detail: ProjectDetailResult): string {
  const binding = detail.binding;
  const bindingText = binding === null ? 'none' : binding.canonicalPath;
  return (
    `shiploop project get: ${detail.project.id} name=${detail.project.displayName} ` +
    `revision=${detail.project.revision} binding=${bindingText}\n`
  );
}

function projectLabelsHumanLine(result: ProjectLabelCountsResult): string {
  const summary =
    result.labels.length === 0
      ? '（无标签）'
      : result.labels.map((entry) => `${entry.label}=${entry.projectCount}`).join(' ');
  return `shiploop project labels: ${summary}\n`;
}

/* ------------------------------------------------------------------ *
 * 配置与回执人类可读行（脱敏；只输出 scope/revision/来源，不打印 payload 值）
 * ------------------------------------------------------------------ */

function scopeText(scope: unknown): string {
  if (scope !== null && typeof scope === 'object') {
    const candidate = scope as { kind?: unknown; projectId?: unknown };
    if (candidate.kind === 'project' && typeof candidate.projectId === 'string') {
      return `project:${candidate.projectId}`;
    }
    if (candidate.kind === 'global') {
      return 'global';
    }
  }
  return 'unknown';
}

function settingsWriteHumanLine(verb: 'create' | 'update', receipt: CompletedReceipt): string {
  const state = receipt.result as
    | { scope?: unknown; revision?: unknown; schemaVersion?: unknown }
    | undefined;
  return (
    `shiploop config ${verb}: ${receipt.status} scope=${scopeText(state?.scope)} ` +
    `schemaVersion=${String(state?.schemaVersion)} revision=${String(state?.revision)}` +
    `${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function settingsCurrentHumanLine(state: SettingsStateResult): string {
  return (
    `shiploop config get: scope=${scopeText(state.scope)} ` +
    `schemaVersion=${String(state.schemaVersion)} revision=${String(state.revision)}\n`
  );
}

function effectiveSettingsHumanLine(effective: EffectiveSettingsResult): string {
  const strategies = effective.strategies as
    | { defaultStrategy?: unknown; modelMap?: Record<string, unknown>; purposeStrategies?: Record<string, unknown>; agentOverrides?: Record<string, unknown> }
    | undefined;
  const hasDefault = strategies?.defaultStrategy !== undefined;
  const modelCount = Object.keys(strategies?.modelMap ?? {}).length;
  const purposeCount = Object.keys(strategies?.purposeStrategies ?? {}).length;
  const policyCount = Object.keys(effective.policies ?? {}).length;
  return (
    `shiploop config effective: configured=${String(effective.configured)} ` +
    `defaultStrategy=${String(hasDefault)} modelMap=${modelCount} ` +
    `purposeStrategies=${purposeCount} policies=${policyCount}\n`
  );
}

function exportedSettingsHumanLine(exported: ExportedSettingsResult): string {
  const current = exported.current as { revision?: unknown } | undefined;
  return (
    `shiploop config export: scope=${exported.scope} ` +
    `format=${String(exported.exportFormatVersion)} revision=${String(current?.revision)}\n`
  );
}

function receiptHumanLine(receipt: CommandReceipt): string {
  const reference = receipt.status === 'completed' ? ` resultRef=${receipt.resultRef}` : '';
  return (
    `shiploop receipt get: ${receipt.status} commandId=${receipt.commandId} ` +
    `operation=${receipt.operation}${reference}\n`
  );
}

/* ------------------------------------------------------------------ *
 * 计划命令人类可读行（F-010；脱敏事实字段，不宣称审批/通过/运行）
 * ------------------------------------------------------------------ */

function phaseCreatedHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as
    | { phase?: { id?: unknown; revision?: unknown; status?: unknown } }
    | undefined;
  const phase = result?.phase ?? {};
  return (
    `shiploop phase create: ${receipt.status} phase=${String(phase.id)} ` +
    `revision=${String(phase.revision)} status=${String(phase.status)}` +
    `${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function featureImportedHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as
    | {
        feature?: { id?: unknown; revision?: unknown; planStatus?: unknown; planDigest?: unknown };
        tasks?: readonly { id: string }[];
        validation?: { taskCount?: unknown };
      }
    | undefined;
  const feature = result?.feature ?? {};
  return (
    `shiploop feature import: ${receipt.status} feature=${String(feature.id)} ` +
    `revision=${String(feature.revision)} planStatus=${String(feature.planStatus)} ` +
    `planDigest=${String(feature.planDigest)} tasks=${result?.validation?.taskCount ?? result?.tasks?.length ?? 0}` +
    `${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function featureRevisedHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as
    | {
        feature?: { id?: unknown; revision?: unknown; planStatus?: unknown; planDigest?: unknown };
        memberChanges?: { keptTaskCount?: unknown; createdTaskCount?: unknown; removedTaskCount?: unknown };
      }
    | undefined;
  const feature = result?.feature ?? {};
  const changes = result?.memberChanges ?? {};
  return (
    `shiploop feature revise: ${receipt.status} feature=${String(feature.id)} ` +
    `revision=${String(feature.revision)} planStatus=${String(feature.planStatus)} ` +
    `planDigest=${String(feature.planDigest)} ` +
    `kept=${String(changes.keptTaskCount)} created=${String(changes.createdTaskCount)} ` +
    `removed=${String(changes.removedTaskCount)}${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function planLabelsHumanLine(commandId: AppCliCommandId, receipt: CompletedReceipt): string {
  const result = receipt.result as
    | { entityType?: unknown; id?: unknown; revision?: unknown; labels?: readonly string[] }
    | undefined;
  return (
    `shiploop ${commandId}: ${receipt.status} ${String(result?.entityType)}=${String(result?.id)} ` +
    `revision=${String(result?.revision)} labels=${result?.labels?.length ?? 0}` +
    `${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function planListHumanLine(
  noun: 'phase' | 'feature' | 'task',
  result: { records: readonly { id: string }[]; nextCursor: string | null },
): string {
  const lines = [`shiploop ${noun} list: ${result.records.length} ${noun}(s)`];
  for (const record of result.records) {
    lines.push(`  - ${record.id}`);
  }
  if (result.nextCursor !== null) {
    lines.push(`  nextCursor=${result.nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

/** P06-6 / F-007：Run 列表人类可读行（只列持久元数据身份与状态）。 */
function runListHumanLine(
  result: { records: readonly { id: string; status: string }[]; nextCursor: string | null },
): string {
  const lines = [`shiploop execution runs: ${result.records.length} run(s)`];
  for (const record of result.records) {
    lines.push(`  - ${record.id} status=${record.status}`);
  }
  if (result.nextCursor !== null) {
    lines.push(`  nextCursor=${result.nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

/** P06-6 / F-007：四层实体标签计数人类可读行（entity + 去重计数）。 */
function entityLabelCountsHumanLine(
  result: { entity: string; labels: readonly { label: string; count: number }[] },
): string {
  const summary =
    result.labels.length === 0
      ? '（无标签）'
      : result.labels.map((entry) => `${entry.label}=${entry.count}`).join(' ');
  return `shiploop project labels (${result.entity}): ${summary}\n`;
}

function phaseDetailHumanLine(detail: PhaseDetailResult): string {
  return (
    `shiploop phase get: ${detail.phase.id} project=${detail.phase.projectId} ` +
    `revision=${detail.phase.revision} status=${detail.phase.status}\n`
  );
}

function featureDetailHumanLine(detail: FeatureDetailResult): string {
  return (
    `shiploop feature get: ${detail.feature.id} revision=${detail.feature.revision} ` +
    `planStatus=${detail.feature.planStatus} tasks=${detail.tasks.length} ` +
    `planDigest=${String(detail.feature.planDigest)}\n`
  );
}

function taskDetailHumanLine(detail: TaskDetailResult): string {
  return (
    `shiploop task get: ${detail.task.id} feature=${detail.task.featureId} ` +
    `revision=${detail.task.revision} status=${detail.task.status} ` +
    `criteria=${detail.task.acceptance.criteria.length}\n`
  );
}

function profileQueryHumanLine(result: ProjectProfileQueryResult): string {
  const lines = [`shiploop project profile get: project=${result.projectId}`];
  const records = [
    ['candidate', result.candidate],
    ['confirmed', result.confirmed],
  ] as const;
  for (const [label, record] of records) {
    if (record === null) {
      lines.push(`  ${label}: none`);
      continue;
    }
    lines.push(
      `  ${label}: status=${record.status} confirmed=${String(record.confirmed)} ` +
        `version=${record.version} storeRevision=${record.storeRevision} digest=${record.profileDigest}`,
    );
    lines.push(`    modules: ${record.modules.length === 0 ? 'none' : record.modules.map((module) => `${module.id}(${module.version})`).join(', ')}`);
    lines.push(`    evidence: ${record.evidence.length === 0 ? 'none' : record.evidence.map((evidence) => `${evidence.id}:${evidence.status}/${evidence.confirmed ? 'confirmed' : 'unconfirmed'} source=${evidence.source} ${evidence.summary}`).join(' | ')}`);
    const unconfirmed = record.evidence.filter((evidence) => !evidence.confirmed || evidence.status !== 'confirmed');
    if (unconfirmed.length > 0) {
      lines.push(`    unconfirmed: ${unconfirmed.map((evidence) => evidence.id).join(', ')}`);
    }
  }
  lines.push(`  capability-modules: ${result.modules.length === 0 ? 'none' : result.modules.map((module) => `${module.id}@${module.version} status=${module.status} digest=${module.digest}`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

function profileMatchHumanLine(result: ProjectProfileMatchQueryResult): string {
  const match = result.match;
  const modules = match.modules.length === 0 ? 'none' : match.modules.map((module) => `${module.id}@${module.version} (${module.reason})`).join(', ');
  const missing = match.missing.length === 0 ? 'none' : match.missing.join(', ');
  return `shiploop project profile match: project=${result.projectId} status=${match.status} profileVersion=${String(match.profileVersion)} modules=${modules} missing=${missing}${match.reason === undefined ? '' : ` reason=${match.reason}`}\n`;
}

function profileWriteHumanLine(action: 'confirm' | 'modify' | 'reject', receipt: CompletedReceipt): string {
  const result = receipt.result as { profile?: { version?: unknown; status?: unknown; projectId?: unknown }; profileDigest?: unknown } | undefined;
  return `shiploop project profile ${action}: status=${String(result?.profile?.status ?? receipt.status)} project=${String(result?.profile?.projectId)} version=${String(result?.profile?.version)} digest=${String(result?.profileDigest)}${receipt.replayed ? '（replayed）' : ''}\n`;
}

/* ------------------------------------------------------------------ *
 * 写命令：显式 commandId 先查回执、以原 issuedAt 重建同一信封
 * ------------------------------------------------------------------ */

/**
 * 显式 `--command-id` 的重复语义（契约 §5.5「重复提交用同一信封（先查回执）」）：
 * 先按本 principal 查该 commandId 的既有回执；命中则以原 `issuedAt` 作为本次
 * 信封时间（expiresAt 恒缺席），服务端重算摘要后：
 * - 相同参数 → 同摘要 → 重放原回执（replayed:true）；
 * - 不同参数 → 摘要不同 → conflict（idempotency_key_reuse）。
 * 未命中则返回 undefined，由 HostClient 生成一次 issuedAt 并冻结。
 */
async function replayIssuedAt(
  client: HostClient,
  commandId: string | undefined,
): Promise<string | undefined> {
  if (commandId === undefined) {
    return undefined;
  }
  try {
    const receipt = await client.getReceipt(commandId);
    return receipt.issuedAt;
  } catch (error) {
    if (isHostProtocolError(error, 'not_found')) {
      return undefined;
    }
    throw error;
  }
}

async function submitCommandAndEmit(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  client: HostClient,
  input: SubmitCommandInput,
): Promise<AppCliRunResult> {
  const receipt = await client.submitCommand(input);
  return emitCommandReceipt(io, command, receipt);
}

/**
 * 命令回执 → §12.3 输出（写命令共用）：rejected 是业务拒绝（退出码 1，保留
 * commandId 可查回执）；accepted 对同步计划/配置命令属协议异常（fail-closed）；
 * completed 才是成功（退出码 0）。
 */
function emitCommandReceipt(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  receipt: CommandReceipt,
): AppCliRunResult {
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  if (receipt.status === 'accepted') {
    // F-008 起 Host 可产生 accepted（baseline.run authorize）；除基线外的 CLI
    // 命令面全部为同步命令，accepted 属协议异常（fail-closed，不折算成功/失败）。
    throw new Error('unexpected_accepted_receipt');
  }
  return emitSuccess(io, command, receipt, writeCommandHumanLine(command.commandId, receipt));
}

/**
 * P03-2 / F-008 决策/策略/固定输入命令的 completed 回执 → CLI 结构化视图
 * （拒绝/accepted 语义与 emitCommandReceipt 同一约定）。
 */
function emitDomainReceipt<View>(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  receipt: CommandReceipt,
  build: (commandId: string, replayed: boolean, result: unknown) => View,
  format: (view: View) => string,
): AppCliRunResult {
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  if (receipt.status === 'accepted') {
    throw new Error('unexpected_accepted_receipt');
  }
  const view = build(receipt.commandId, receipt.replayed, receipt.result);
  return emitSuccess(io, command, view, format(view));
}

function emitPlanningStartReceipt(
  io: AppCliIo,
  command: ParsedPlanningStart,
  receipt: CommandReceipt,
): AppCliRunResult {
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'), command: command.commandId,
      code: receipt.error.code, message: receipt.error.message, commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  if (receipt.status !== 'accepted' || receipt.operation !== 'planning.start' || receipt.schemaVersion !== 7) {
    throw new HostProtocolError('response_malformed', 'commands.submit', undefined, { details: { reason: 'planning_start_receipt_invalid' } });
  }
  const view = buildPlanningStartView(receipt);
  return emitSuccess(io, command, view, formatPlanningStartView(view));
}

/** P05-1 / F-013：一次性规划 CLI（启动、上下文审阅、候选正文与人工决定）。 */
async function executePlanningCommand(
  io: AppCliIo,
  command: ParsedPlanningCommand,
  client: HostClient,
  planningInput: PlanningStartInputDocument | undefined,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'planning.start': {
      if (planningInput === undefined) throw new TypeError('planning.start 缺少已校验输入');
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.startPlanning(
        buildPlanningClientInput(command, planningInput),
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitPlanningStartReceipt(io, command, receipt);
    }
    case 'planning.list': {
      const result = await client.listPlanningContexts(command.projectId, {
        ...(command.featureId !== undefined ? { featureId: command.featureId } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildPlanningContextListView(result);
      return emitSuccess(io, command, view, formatPlanningContextListView(view));
    }
    case 'planning.get': {
      const result = await client.getPlanningContext(command.projectId, command.candidateId);
      const view = buildPlanningContextDetailView(result);
      return emitSuccess(io, command, view, formatPlanningContextDetailView(view));
    }
    case 'planning.candidate': {
      const result = await client.getPlanningCandidate(command.projectId, command.candidateId);
      const view = buildPlanningCandidateView(result);
      return emitSuccess(io, command, view, formatPlanningCandidateView(view));
    }
    case 'planning.approve':
    case 'planning.reject': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const decision = command.commandId === 'planning.approve' ? 'approve' : 'reject';
      const receipt = await client.decidePlanningCandidate({
        projectId: command.projectId,
        candidateId: command.candidateId,
        candidateDigest: command.candidateDigest,
        decision,
        reason: command.reason ?? null,
        expectedRevision: command.revision,
      }, envelopeIdentityOptions(command.explicitCommandId, issuedAt));
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) => buildPlanningDecisionView(commandId, replayed, decision, result),
        formatPlanningDecisionView,
      );
    }
  }
}


function writeCommandHumanLine(commandId: AppCliCommandId, receipt: CompletedReceipt): string {
  switch (commandId) {
    case 'project.register':
      return projectRegisteredHumanLine(receipt);
    case 'project.edit':
      return projectEditedHumanLine(receipt);
    case 'config.create':
      return settingsWriteHumanLine('create', receipt);
    case 'config.update':
      return settingsWriteHumanLine('update', receipt);
    case 'phase.create':
      return phaseCreatedHumanLine(receipt);
    case 'feature.import':
      return featureImportedHumanLine(receipt);
    case 'feature.revise':
      return featureRevisedHumanLine(receipt);
    case 'phase.labels':
    case 'feature.labels':
    case 'task.labels':
      return planLabelsHumanLine(commandId, receipt);
    default:
      return `shiploop ${commandId}: ${receipt.status}\n`;
  }
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-006 静态接入纵向（先预览后确认；§12.1/§12.2/§12.3）
 * ------------------------------------------------------------------ */

/** init/overview 结果输出：--json 信封到 stdout、提示进 stderr；人类模式结果文本到 stdout。 */
function emitOnboardingResult(
  io: AppCliIo,
  command: ParsedProjectInit | ParsedProjectOverview,
  result: unknown,
  humanText: string,
  notices: readonly string[],
): AppCliRunResult {
  const streams = composeAppCliStreams({
    json: command.json,
    command: command.commandId,
    result,
    humanText,
    notices,
  });
  io.stdout(streams.stdout);
  io.stderr(streams.stderr);
  return {
    exitCode: CLI_EXIT_OK,
    kind: 'success',
    command: command.commandId,
    ...(command.json ? { envelope: buildAppCliSuccessEnvelope(command.commandId, result) } : {}),
  };
}

/** init 注册结果映射：既有 project.register 回执业务状态 → 注册轴结果。 */
function initRegistrationOutcome(receipt: CompletedReceipt): InitRegistrationOutcome {
  const business = receipt.result as
    | { status?: string; project?: { id?: unknown } }
    | undefined;
  const projectId = business?.project?.id;
  if (business?.status === 'already_exists' && typeof projectId === 'string') {
    return { status: 'already_registered', projectId };
  }
  if (typeof projectId !== 'string') {
    throw new HostProtocolError('response_malformed', 'commands.submit', '注册回执缺少项目身份');
  }
  return { status: 'registered', projectId };
}

async function executeProjectInit(
  io: AppCliIo,
  command: ParsedProjectInit,
  client: HostClient,
): Promise<AppCliRunResult> {
  // 1) 静态预览：只读 projects.inspect（不执行脚本/不安装依赖/不运行基线）。
  const inspection: ProjectInspectionResult = await client.inspectRepository(command.repositoryPath);
  const request: InitRequestView = {
    repositoryPath: command.repositoryPath,
    displayName: command.displayName ?? null,
    description: command.description ?? null,
    labels: [...command.labels],
  };
  const previewText = formatInitPreview(request, inspection);
  // 2) 确认：CLI 非交互，唯一确认入口是显式 --confirm（§12.1）；取消/缺席 → not_run。
  const decision = resolveInitConfirmation({
    confirmFlag: command.confirm,
    interactive: false,
    answer: null,
  });
  if (decision.outcome === 'not_run') {
    const result = buildInitCliResult(request, inspection, {
      status: 'not_run',
      reason: decision.reason,
    });
    return emitOnboardingResult(
      io,
      command,
      result,
      `${previewText}${formatInitCliResult(result)}`,
      [buildInitConfirmationNotice()],
    );
  }
  // 3) 确认注册：经既有 project.register 幂等命令（显式 --command-id 先查回执
  //    并以原 issuedAt 重建同一信封；响应丢失沿用 HostClient 先查回执再重试）。
  const payload: Record<string, unknown> = {
    repositoryPath: command.repositoryPath,
    displayName: command.displayName,
  };
  if (command.description !== undefined) {
    payload.description = command.description;
  }
  if (command.labels.length > 0) {
    payload.labels = [...command.labels];
  }
  const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
  const receipt = await client.submitCommand({
    operation: 'project.register',
    scope: { kind: 'registration' },
    payload,
    ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  });
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  if (receipt.status === 'accepted') {
    // F-008 起 Host 可产生 accepted（baseline.run authorize）；当前 CLI 命令面
    // 全部为同步命令，accepted 属协议异常（fail-closed，不折算成功/失败）。
    throw new Error('unexpected_accepted_receipt');
  }
  const result = buildInitCliResult(request, inspection, initRegistrationOutcome(receipt));
  return emitOnboardingResult(
    io,
    command,
    result,
    `${previewText}${formatInitCliResult(result)}`,
    [],
  );
}

async function executeProjectRepositoryMovePreview(
  io: AppCliIo,
  command: ParsedProjectRepositoryMovePreview,
  client: HostClient,
): Promise<AppCliRunResult> {
  const preview: RepositoryMovePreviewResult = await client.previewRepositoryMove({
    projectId: command.projectId,
    repositoryPath: command.repositoryPath,
  });
  return emitSuccess(io, command, preview, formatRepositoryMovePreview(preview));
}

async function executeProjectRepositoryMoveConfirm(
  io: AppCliIo,
  command: ParsedProjectRepositoryMoveConfirm,
  client: HostClient,
  preview: BrownfieldMovePreview,
): Promise<AppCliRunResult> {
  const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
  const receipt = await client.confirmRepositoryMove({
    projectId: command.projectId,
    preview,
    decision: 'confirm',
    ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
  }, envelopeIdentityOptions(command.explicitCommandId, issuedAt));
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  if (receipt.status === 'accepted') {
    throw new Error('unexpected_accepted_repository_move_receipt');
  }
  return emitSuccess(io, command, receipt, formatRepositoryMoveConfirmation(receipt));
}

/* ------------------------------------------------------------------ *
 * 项目移动接线（显式 projectId + 预览摘要确认；不使用全局当前项目）
 * ------------------------------------------------------------------ */

async function executeProjectOverview(
  io: AppCliIo,
  command: ParsedProjectOverview,
  client: HostClient,
): Promise<AppCliRunResult> {
  const overview: ProjectOverviewResult = await client.getProjectOverview(command.projectId);
  const view: ProjectOverviewView = {
    project: {
      id: overview.project.id,
      displayName: overview.project.displayName,
      description: overview.project.description,
      labels: [...overview.project.labels],
    },
    binding: overview.binding === null ? null : {
      id: overview.binding.id,
      canonicalPath: overview.binding.canonicalPath,
      repoIdentity: overview.binding.repoIdentity,
      revision: overview.binding.revision,
      bindingRevision: overview.binding.bindingRevision,
    },
    registration: overview.registration,
    settings: overview.settings,
    health: overview.health,
    readAt: overview.readAt,
  };
  return emitOnboardingResult(io, command, view, formatOverviewResult(view), []);
}

/* ------------------------------------------------------------------ *
 * 命令分发
 * ------------------------------------------------------------------ */

async function executeProjectProfile(
  io: AppCliIo,
  command: ParsedProjectProfileCommand,
  client: HostClient,
  profilePayload?: Record<string, unknown>,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'project.profile-get': {
      const result = await client.getProjectProfile(command.projectId);
      return emitSuccess(io, command, result, profileQueryHumanLine(result));
    }
    case 'project.profile-match': {
      const result = await client.matchProjectProfile(command.projectId, {
        ...(command.directory !== undefined ? { directory: command.directory } : {}),
        ...(command.requiredModuleIds.length > 0 ? { requiredModuleIds: command.requiredModuleIds } : {}),
        ...(command.languages.length > 0 ? { languages: command.languages } : {}),
        ...(command.frameworks.length > 0 ? { frameworks: command.frameworks } : {}),
        ...(command.scope.length > 0 ? { scope: command.scope } : {}),
      });
      if (result.match.status === 'not_ready') {
        return emitFailure(io, command.json, {
          exitCode: 1,
          command: command.commandId,
          code: 'not_ready',
          message: `Profile 尚未满足任务模块要求${result.match.reason === undefined ? '' : `：${result.match.reason}`}`,
          details: { match: result.match },
        });
      }
      return emitSuccess(io, command, result, profileMatchHumanLine(result));
    }
    case 'project.profile-detect': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.detectProjectProfile({ projectId: command.projectId,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}) },
      envelopeIdentityOptions(command.explicitCommandId, issuedAt));
      return emitCommandReceipt(io, command, receipt);
    }
    case 'project.profile-confirm':
    case 'project.profile-modify':
    case 'project.profile-reject': {
      if (command.commandId !== 'project.profile-reject' && profilePayload === undefined) {
        throw new TypeError('Profile 写入命令缺少已校验输入');
      }
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = command.commandId === 'project.profile-confirm'
        ? await client.confirmProjectProfile({ projectId: command.projectId, expectedRevision: command.revision, profile: profilePayload, ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}) }, envelopeIdentityOptions(command.explicitCommandId, issuedAt))
        : command.commandId === 'project.profile-modify'
          ? await client.modifyProjectProfile({ projectId: command.projectId, expectedRevision: command.revision, profile: profilePayload, ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}) }, envelopeIdentityOptions(command.explicitCommandId, issuedAt))
          : await client.rejectProjectProfile({ projectId: command.projectId, expectedRevision: command.revision, ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}) }, envelopeIdentityOptions(command.explicitCommandId, issuedAt));
      if (receipt.status === 'rejected') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForReceiptStatus('rejected'),
          command: command.commandId,
          code: receipt.error.code,
          message: receipt.error.message,
          commandId: receipt.commandId,
          ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
        });
      }
      if (receipt.status === 'accepted') {
        throw new Error('unexpected_accepted_profile_receipt');
      }
      const action = command.commandId === 'project.profile-confirm' ? 'confirm' : command.commandId === 'project.profile-modify' ? 'modify' : 'reject';
      return emitSuccess(io, command, receipt, profileWriteHumanLine(action, receipt));
    }
  }
}

function resourceConfigurationView(result: Awaited<ReturnType<HostClient['listProjectResources']>>) {
  return { schemaVersion: result.schemaVersion, projectId: result.projectId, revision: result.revision, digest: result.digest,
    resources: result.resources.map(resource => ({ id: resource.id, kind: resource.kind, name: resource.name,
      sourceRef: resource.sourceRef, sourceRevision: resource.sourceRevision, version: resource.version,
      contentDigest: resource.contentDigest, candidateDigest: resource.candidateDigest, transport: resource.transport,
      capabilities: resource.capabilities, credentialConfigured: resource.credentialRef !== null,
      required: resource.required, onUnavailable: resource.onUnavailable, enabled: resource.enabled, status: resource.status })) };
}

function formatArchiveBlockers(blockers: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(blockers)) {
    if (typeof value === 'number' && value > 0) lines.push(`  阻塞 ${key}=${value}`);
  }
  if (lines.length === 0) lines.push('  无活动执行阻塞');
  return lines.join('\n');
}

function formatDeletePreviewView(projectId: string, page: unknown): string {
  const preview = page as {
    projectStatus?: string; projectRevision?: number; previewDigest?: string; expiresAtUtcMs?: number;
    summary?: { objects?: { total?: number; deletions?: number; retainedMinimal?: number };
      references?: Record<string, unknown>; retained?: readonly { kind?: string; id?: string; reasons?: readonly string[] }[];
      activity?: Record<string, unknown> };
    pagination?: { complete?: boolean; nextCursor?: string | null };
  };
  const summary = preview.summary ?? {};
  const lines = [
    `shiploop project delete-preview: project=${projectId} status=${String(preview.projectStatus)} revision=${String(preview.projectRevision)}`,
    `  previewDigest=${String(preview.previewDigest)} expiresAtMs=${String(preview.expiresAtUtcMs)}`,
    `  objects total=${Number(summary.objects?.total ?? 0)} deletions=${Number(summary.objects?.deletions ?? 0)} retainedMinimal=${Number(summary.objects?.retainedMinimal ?? 0)}`,
  ];
  for (const [key, value] of Object.entries(summary.activity ?? {})) {
    if (typeof value === 'number' && value > 0) lines.push(`  阻塞 ${key}=${value}`);
  }
  for (const item of summary.retained ?? []) {
    lines.push(`  保留 ${String(item.kind)} ${String(item.id)}${(item.reasons ?? []).length === 0 ? '' : ` reasons=${(item.reasons ?? []).join(',')}`}`);
  }
  if (summary.references !== undefined) {
    for (const [key, value] of Object.entries(summary.references)) {
      if (typeof value === 'number' && value > 0) lines.push(`  引用 ${key}=${value}`);
    }
  }
  if (preview.pagination?.complete === false) {
    lines.push(`  清单未完；续页：--cursor ${String(preview.pagination.nextCursor)}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function executeRetentionCommand(
  io: AppCliIo,
  command: ParsedRetentionCommand,
  client: HostClient,
): Promise<AppCliRunResult> {
  if (command.commandId === 'retention.evaluation') {
    const report = await client.getRetentionEvaluation();
    const view = { ...report };
    const lines = [`shiploop retention evaluation: policy=${report.policy.status} disk=${report.disk.status}` +
      ` thresholds=${report.thresholds.status} cleanable=${report.cleanable.status} referencedRetained=${report.referencedRetained.status}`];
    for (const trigger of report.thresholds.triggers) {
      lines.push(`  trigger ${trigger.kind}: ${trigger.assessment}${trigger.observedValue === undefined ? '' : ` observed=${trigger.observedValue}`} configured=${trigger.configuredValue}`);
    }
    for (const component of report.cleanable.components) {
      lines.push(`  cleanable ${component.kind}: ${component.status}${component.bytes === undefined ? '' : ` bytes=${component.bytes}`}`);
    }
    for (const component of report.referencedRetained.components) {
      lines.push(`  retained ${component.kind}: ${component.status}${component.bytes === undefined ? '' : ` bytes=${component.bytes}`}`);
    }
    lines.push('');
    return emitSuccess(io, command, view, lines.join('\n'));
  }
  const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
  const receipt = await client.submitRetentionCleanup(
    { ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
      ...(issuedAt !== undefined ? { issuedAt } : {}) },
    envelopeIdentityOptions(command.explicitCommandId, issuedAt),
  );
  return emitDomainReceipt(io, command, receipt, (commandId, replayed, result) => ({ commandId, replayed, summary: result }),
    view => {
      const summary = view.summary as { status?: string; itemsDeleted?: number; bytesDeleted?: number; candidateCount?: number; retainedCount?: number; skippedCount?: number; reasons?: readonly string[] };
      const lines = [`shiploop retention cleanup: ${String(summary.status)} items=${Number(summary.itemsDeleted ?? 0)} bytes=${Number(summary.bytesDeleted ?? 0)}` +
        ` candidates=${Number(summary.candidateCount ?? 0)} retained=${Number(summary.retainedCount ?? 0)} skipped=${Number(summary.skippedCount ?? 0)}${view.replayed ? '（replayed）' : ''}`];
      if (summary.reasons !== undefined && summary.reasons.length > 0) {
        lines.push(`  reasons=${summary.reasons.join(',')}`);
      }
      lines.push('');
      return lines.join('\n');
    });
}

async function executeProjectCommand(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  client: HostClient,
  profilePayload?: Record<string, unknown>,
  repositoryMovePreview?: BrownfieldMovePreview,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'project.resource-source-register':
    case 'project.resource-source-remove': {
      const result = await client.configureProjectResourceSource({ projectId: command.projectId, sourceId: command.sourceId,
        action: command.commandId === 'project.resource-source-register' ? 'register' : 'remove', expectedRevision: command.revision,
        ...(command.manifestPath === undefined ? {} : { manifestPath: command.manifestPath }) });
      return emitSuccess(io, command, result, `${JSON.stringify(result)}\n`);
    }
    case 'project.resource-list': {
      const result = resourceConfigurationView(await client.listProjectResources(command.projectId));
      return emitSuccess(io, command, result, `${JSON.stringify(result, null, 2)}\n`);
    }
    case 'project.resource-discover':
    case 'project.resource-preview': {
      const result = command.commandId === 'project.resource-discover'
        ? await client.discoverProjectResourceCandidates(command.projectId, command.sourceIds)
        : await client.previewProjectResourceCandidates(command.projectId, command.sourceIds, command.selectedResourceIds);
      const view = { schemaVersion: result.schemaVersion, projectId: result.projectId, configurationChanged: result.configurationChanged,
        ...('sources' in result ? { sources: result.sources.map(source => ({ sourceId: source.sourceId, sourceDigest: source.sourceDigest, status: source.status, candidateIds: source.candidateIds, error: source.error === null ? null : { reason: source.error.reason } })) } :
          { entries: result.entries.map(entry => ({ sourceId: entry.sourceId, candidateId: entry.candidateId, name: entry.name, status: entry.status, reason: entry.reason })) }),
        candidates: result.candidates.map(candidate => ({ id: candidate.id, sourceRef: candidate.sourceRef, digest: candidate.digest,
          kind: candidate.kind, name: candidate.name, version: candidate.version, availability: candidate.availability })),
        rejected: result.rejected.map(item => ({ sourceId: item.sourceId, reason: item.reason })) };
      return emitSuccess(io, command, view, `${JSON.stringify(view, null, 2)}\n`);
    }
    case 'project.resource-import':
    case 'project.resource-enable':
    case 'project.resource-disable':
    case 'project.resource-revoke': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const options = envelopeIdentityOptions(command.explicitCommandId, issuedAt);
      const base = { projectId: command.projectId, expectedRevision: command.revision, commandId: command.explicitCommandId };
      const receipt = command.commandId === 'project.resource-import'
        ? await client.importProjectResource({ ...base, sourceId: command.sourceId, sourceDigest: command.sourceDigest, candidateId: command.candidateId, candidateDigest: command.candidateDigest }, options)
        : command.commandId === 'project.resource-enable'
          ? await client.enableProjectResource({ ...base, resourceId: command.resourceId }, options)
          : command.commandId === 'project.resource-disable'
            ? await client.disableProjectResource({ ...base, resourceId: command.resourceId }, options)
            : await client.revokeProjectResource({ ...base, resourceId: command.resourceId }, options);
      if (receipt.status !== 'completed') return emitCommandReceipt(io, command, receipt);
      const result = receipt.result as { configuration: Awaited<ReturnType<HostClient['listProjectResources']>>; resourceLoaded: boolean; runtimeExecuted: boolean; appliesTo: string };
      const view = { ...receipt, result: { configuration: resourceConfigurationView(result.configuration), resourceLoaded: result.resourceLoaded, runtimeExecuted: result.runtimeExecuted, appliesTo: result.appliesTo } };
      return emitSuccess(io, command, view, `shiploop ${command.commandId}: commandId=${receipt.commandId} status=${receipt.status} revision=${result.configuration.revision}${receipt.replayed ? ' replayed=true' : ''}\n`);
    }
    case 'project.init': {
      return executeProjectInit(io, command, client);
    }
    case 'project.overview': {
      return executeProjectOverview(io, command, client);
    }
    case 'project.repository-move-preview': {
      return executeProjectRepositoryMovePreview(io, command, client);
    }
    case 'project.repository-move-confirm': {
      return executeProjectRepositoryMoveConfirm(io, command, client, repositoryMovePreview as BrownfieldMovePreview);
    }
    case 'project.profile-detect':
    case 'project.profile-get':
    case 'project.profile-match':
    case 'project.profile-confirm':
    case 'project.profile-modify':
    case 'project.profile-reject':
      return executeProjectProfile(io, command, client, profilePayload);
    case 'project.register': {
      const payload: Record<string, unknown> = {
        repositoryPath: command.repositoryPath,
        displayName: command.displayName,
      };
      if (command.description !== undefined) {
        payload.description = command.description;
      }
      if (command.labels.length > 0) {
        payload.labels = [...command.labels];
      }
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'project.edit': {
      const payload: Record<string, unknown> = {};
      if (command.displayName !== undefined) {
        payload.displayName = command.displayName;
      }
      if (command.description !== undefined) {
        payload.description = command.description;
      }
      if (command.labels !== undefined) {
        payload.labels = [...command.labels];
      }
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: command.projectId },
        expectedRevision: command.revision,
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'project.archive':
    case 'project.restore': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const isArchive = command.commandId === 'project.archive';
      const receipt = isArchive
        ? await client.submitProjectArchive(
          { projectId: command.projectId, expectedRevision: command.revision,
            ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
            ...(issuedAt !== undefined ? { issuedAt } : {}) },
          envelopeIdentityOptions(command.explicitCommandId, issuedAt),
        )
        : await client.submitProjectRestore(
          { projectId: command.projectId, expectedRevision: command.revision,
            ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
            ...(issuedAt !== undefined ? { issuedAt } : {}) },
          envelopeIdentityOptions(command.explicitCommandId, issuedAt),
        );
      return emitDomainReceipt(io, command, receipt, (commandId, replayed, result) => {
        const lifecycle = result as {
          status?: string; settled?: boolean; blockers?: Record<string, unknown>;
          project?: { id?: string; revision?: number; status?: string };
        };
        return { commandId, replayed, status: lifecycle.status, settled: lifecycle.settled,
          ...(lifecycle.project === undefined ? {} : {
            project: { id: lifecycle.project.id, revision: lifecycle.project.revision, status: lifecycle.project.status },
          }),
          ...(lifecycle.blockers === undefined ? {} : { blockers: lifecycle.blockers }) };
      }, view => {
        const lines = [`shiploop ${command.commandId}: ${String(view.status)} project=${command.projectId}` +
          `${view.settled === true ? '' : '（未收尾，稍后复查状态）'}${view.replayed ? '（replayed）' : ''}`];
        if (view.blockers !== undefined) {
          lines.push(formatArchiveBlockers(view.blockers));
        }
        lines.push('');
        return lines.join('\n');
      });
    }
    case 'project.delete-preview': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.submitProjectDeletePreview(
        { projectId: command.projectId,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
          ...(issuedAt !== undefined ? { issuedAt } : {}) },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(io, command, receipt, (commandId, replayed, result) => ({ commandId, replayed, page: result }),
        view => formatDeletePreviewView(command.projectId, view.page));
    }
    case 'project.delete-confirm': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.submitProjectDeleteConfirm(
        { projectId: command.projectId, expectedRevision: command.revision, previewDigest: command.previewDigest,
          expiresAtUtcMs: command.expiresAtUtcMs,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
          ...(issuedAt !== undefined ? { issuedAt } : {}) },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      if (receipt.status === 'rejected') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForReceiptStatus('rejected'),
          command: command.commandId,
          code: receipt.error.code,
          message: receipt.error.message,
          commandId: receipt.commandId,
          ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
        });
      }
      if (receipt.status !== 'accepted') {
        throw new HostProtocolError('response_malformed', 'commands.submit', undefined, {
          details: { reason: 'project_delete_confirm_receipt_invalid' },
        });
      }
      const view = { commandId: receipt.commandId, status: 'accepted' as const, replayed: receipt.replayed === true, operationId: receipt.operationId };
      const human = `shiploop project delete-confirm: accepted project=${command.projectId} operation=${receipt.operationId}` +
        `${receipt.replayed === true ? '（replayed）' : ''}\n` +
        `accepted ≠ 已删除；完成状态：shiploop project delete-operation ${receipt.operationId}\n`;
      return emitSuccess(io, command, view, human);
    }
    case 'project.delete-operation': {
      const result = await client.getProjectDeleteOperation(command.operationId);
      const view = { operation: result.operation, schemaVersion: result.schemaVersion, operationId: result.operationId,
        projectId: result.projectId, status: result.status, failedStep: result.failedStep, steps: result.steps, fence: result.fence };
      const lines = [`shiploop project delete-operation: ${result.status} operation=${result.operationId} project=${result.projectId} fence=${result.fence}`];
      if (result.failedStep !== null) lines.push(`  failedStep=${result.failedStep}`);
      for (const step of result.steps) lines.push(`  step ${step.step}: ${step.status}`);
      lines.push('');
      return emitSuccess(io, command, view, lines.join('\n'));
    }
    case 'project.list': {
      const result = await client.listProjects({
        ...(command.labels.length > 0 ? { labels: [...command.labels] } : {}),
        match: command.match,
        ...(command.status === undefined ? {} : { status: command.status }),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      return emitSuccess(io, command, result, projectListHumanLine(result));
    }
    case 'project.get': {
      const result = await client.getProject(command.projectId);
      return emitSuccess(io, command, result, projectDetailHumanLine(result));
    }
    case 'project.labels': {
      // P06-6 / F-007：--entity 进入四层计数模式；无参保持项目层计数旧形态。
      if (command.entity === undefined) {
        const result = await client.countProjectLabels();
        return emitSuccess(io, command, result, projectLabelsHumanLine(result));
      }
      const result = await client.getLabelCounts({
        entity: command.entity,
        projectId: command.projectId as string,
        ...(command.phaseId !== undefined ? { phaseId: command.phaseId } : {}),
        ...(command.featureId !== undefined ? { featureId: command.featureId } : {}),
        ...(command.batchId !== undefined ? { batchId: command.batchId } : {}),
        ...(command.labels !== undefined ? { labels: [...command.labels] } : {}),
        ...(command.match !== undefined ? { match: command.match } : {}),
      });
      return emitSuccess(io, command, result, entityLabelCountsHumanLine(result));
    }
    default:
      return emitFailure(io, command.json, {
        exitCode: 1,
        command: command.commandId,
        code: 'unsupported',
        message: '该命令由后续任务实现',
      });
  }
}

/* ------------------------------------------------------------------ *
 * 配置命令（F-016）
 * ------------------------------------------------------------------ */

/** 配置命令 scope 映射（project 分支的 projectId 已由纯解析层校验）。 */
function configScope(
  command: ScopedConfigCommand,
): { kind: 'global' } | { kind: 'project'; projectId: string } {
  if (command.scope === 'global') {
    return { kind: 'global' };
  }
  return { kind: 'project', projectId: command.projectId as string };
}

/**
 * 读取 `--input <file>` 文本并解析为 JSON 普通对象。文件读取是显式命令输入
 * （不是结果读取，不接受任意 Core 数据库/结果路径）；缺失/不可读/畸形 JSON
 * 一律在连接 Host 之前以退出码 2 拒绝。
 */
function readConfigInputPayload(
  command: ParsedConfigCreate | ParsedConfigUpdate,
): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(command.inputFile, 'utf8');
  } catch {
    throw new AppCliParseError(
      'invalid_input',
      'invalid_input_file',
      { command: command.command, commandId: command.commandId, json: command.json },
      'input',
    );
  }
  return parseAppInputJson(text, { commandId: command.commandId, json: command.json });
}

function readProfileInputPayload(
  command: Extract<ParsedAppCliCommand, { commandId: 'project.profile-confirm' | 'project.profile-modify' }>,
): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(command.inputFile, 'utf8');
  } catch {
    throw new AppCliParseError(
      'invalid_input',
      'invalid_input_file',
      { command: command.command, commandId: command.commandId, json: command.json },
      'input',
    );
  }
  return parseAppInputJson(text, { commandId: command.commandId, json: command.json });
}

/**
 * 读取 `baseline preview/run` 的 `--input <file>` 检查计划并做纯面层校验（argv
 * 无损；畸形 JSON/Schema/空命令/非法超时等在连接 Host 之前以退出码 2 拒绝，
 * 不发现 Host、不启动进程、不提取凭据、不追加安装命令）。
 */
function readBaselinePlanInput(
  command: ParsedBaselinePreview | ParsedBaselineRun,
): BaselineCheckPlanView {
  let text: string;
  try {
    text = readFileSync(command.inputFile, 'utf8');
  } catch {
    throw new AppCliParseError(
      'invalid_input',
      'invalid_input_file',
      { command: command.command, commandId: command.commandId, json: command.json },
      'input',
    );
  }
  return parseBaselineCheckPlanText(text, {
    commandId: command.commandId,
    json: command.json,
  });
}

async function executeConfigCommand(
  io: AppCliIo,
  command: ParsedConfigCommand,
  client: HostClient,
  payload: Record<string, unknown>,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'config.create': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: command.operation,
        scope: configScope(command),
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'config.update': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: command.operation,
        scope: configScope(command),
        expectedRevision: command.revision,
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'config.get': {
      const result =
        command.scope === 'global'
          ? await client.getGlobalSettings()
          : await client.getProjectSettings(command.projectId as string);
      return emitSuccess(io, command, result, settingsCurrentHumanLine(result));
    }
    case 'config.effective': {
      const result = await client.getEffectiveSettings(command.projectId);
      return emitSuccess(io, command, result, effectiveSettingsHumanLine(result));
    }
    case 'config.export': {
      const result =
        command.scope === 'global'
          ? await client.exportGlobalSettings()
          : await client.exportProjectSettings(command.projectId as string);
      return emitSuccess(io, command, result, exportedSettingsHumanLine(result));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 计划命令（P03-1 / F-010）
 * ------------------------------------------------------------------ */

/** 携带 `--input <file>` 的解析命令（计划/策略/固定输入清单共用同一受控读取）。 */
interface InputFileCommand {
  readonly command: ParsedAppCliCommand['command'];
  readonly commandId: AppCliCommandId;
  readonly json: boolean;
  readonly inputFile: string;
}

/**
 * 计划 `--input <file>` 的有界 UTF-8 受控读取：上限与 Host 应用请求体同一
 * 常量（MAX_APP_BODY_BYTES，不另立数值）；严格 UTF-8 解码（非法字节拒绝）；
 * 只读取文本并解析为 JSON 普通对象，绝不执行文件内容；缺失/不可读/超限/
 * 非法编码/畸形 JSON 一律在连接 Host 之前以退出码 2 拒绝，错误不回显文件内容。
 */
function readPlanInputPayload(command: InputFileCommand): Record<string, unknown> {
  const state = {
    command: command.command,
    commandId: command.commandId,
    json: command.json,
  };
  let handle: number | undefined;
  try {
    handle = openSync(command.inputFile, 'r');
    const buffer = Buffer.alloc(MAX_APP_BODY_BYTES + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_APP_BODY_BYTES) {
      throw new AppCliParseError('invalid_input', 'input_file_too_large', state, 'input');
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new AppCliParseError('invalid_input', 'input_file_encoding', state, 'input');
    }
    return parseAppInputJson(text, { commandId: command.commandId, json: command.json });
  } catch (error) {
    if (error instanceof AppCliParseError) {
      throw error;
    }
    throw new AppCliParseError('invalid_input', 'invalid_input_file', state, 'input');
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // 关闭失败不改变读取结论（句柄随进程退出回收）。
      }
    }
  }
}

/** 显式 --command-id 的信封身份选项（重放以原 issuedAt 重建同一信封）。 */
function envelopeIdentityOptions(
  explicitCommandId: string | undefined,
  issuedAt: string | undefined,
): { commandId?: string; issuedAt?: string } {
  return {
    ...(explicitCommandId !== undefined ? { commandId: explicitCommandId } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  };
}

/** 计划命令的受控输入（全部在连接 Host 之前读取/校验）。 */
interface PlanCommandInputs {
  readonly planPayload?: Record<string, unknown>;
  readonly strategyPayload?: Record<string, unknown>;
  readonly prepareItems?: readonly unknown[];
}

/**
 * 执行一条计划命令意图：全部经 HostClient 公共方法（计划命令 + 查询 +
 * P03-2 决策/策略/固定输入），不打开状态库、不读取凭据、不运行模型；
 * 输入文件已在连接前受控读取。
 */
async function executePlanCommand(
  io: AppCliIo,
  command: ParsedPlanCommand,
  client: HostClient,
  inputs: PlanCommandInputs,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'phase.update':
    case 'phase.close':
    case 'phase.reopen':
    case 'phase.archive': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const identity = envelopeIdentityOptions(command.explicitCommandId, issuedAt);
      const input = { projectId: command.projectId, phaseId: command.phaseId, expectedRevision: command.revision };
      const receipt = command.commandId === 'phase.update'
        ? await client.updatePhaseMetadata({ ...input,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.labels !== undefined ? { labels: command.labels } : {}) }, identity)
        : command.commandId === 'phase.close' ? await client.closePhase(input, identity)
          : command.commandId === 'phase.reopen' ? await client.reopenPhase(input, identity)
            : await client.archivePhase(input, identity);
      return emitCommandReceipt(io, command, receipt);
    }
    case 'feature.move': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.moveFeaturePhase({ projectId: command.projectId, featureId: command.featureId,
        sourcePhaseId: command.sourcePhaseId, targetPhaseId: command.targetPhaseId,
        sourcePhaseRevision: command.sourcePhaseRevision, targetPhaseRevision: command.targetPhaseRevision,
        expectedRevision: command.revision }, envelopeIdentityOptions(command.explicitCommandId, issuedAt));
      return emitCommandReceipt(io, command, receipt);
    }
    case 'feature.dependencies': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.updateFeatureDag({ projectId: command.projectId, phaseId: command.phaseId,
        expectedRevision: command.revision,
        edges: inputs.planPayload?.edges as Parameters<HostClient['updateFeatureDag']>[0]['edges'],
      }, envelopeIdentityOptions(command.explicitCommandId, issuedAt));
      return emitCommandReceipt(io, command, receipt);
    }
    case 'phase.graph': {
      const result = await client.getPhaseGraph(command.projectId, command.phaseId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const text = [
        `shiploop phase graph: ${result.phase.id} status=${result.phase.status} revision=${result.phase.revision}`,
        ...result.readiness.map(item => `${item.featureId}: dependency=${item.dependencyCompletion} integration=${item.integrationReady} dependencyIntegration=${item.dependencyIntegrationReady} ready=${item.ready} blockers=${item.blockers.join(",") || "none"}`),
        `nextCursor=${result.nextCursor ?? "none"}`,
        '候选只表示依赖与计划条件；执行需另行授权。',
      ].join('\n') + '\n';
      return emitSuccess(io, command, result, text);
    }
    case 'phase.create': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.createPhase(
        {
          projectId: command.projectId,
          title: command.title,
          description: command.description ?? null,
          labels: command.labels,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitCommandReceipt(io, command, receipt);
    }
    case 'feature.import': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.importFeaturePlan(
        {
          projectId: command.projectId,
          phaseId: command.phaseId,
          expectedRevision: command.revision,
          plan: inputs.planPayload,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitCommandReceipt(io, command, receipt);
    }
    case 'feature.revise': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.reviseFeaturePlan(
        {
          projectId: command.projectId,
          featureId: command.featureId,
          expectedRevision: command.revision,
          plan: inputs.planPayload,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitCommandReceipt(io, command, receipt);
    }
    case 'phase.delivery-approve': {
      const phaseCommand = command as ParsedPhaseDeliveryApprove;
      const issuedAt = await replayIssuedAt(client, phaseCommand.explicitCommandId);
      const receipt = await client.approvePhaseDelivery(
        {
          projectId: phaseCommand.projectId,
          phaseId: phaseCommand.phaseId,
          batchId: phaseCommand.batchId,
          expectedRevision: phaseCommand.revision,
          candidateId: phaseCommand.candidateId,
          expectedCandidateRevision: phaseCommand.candidateRevision,
        },
        envelopeIdentityOptions(phaseCommand.explicitCommandId, issuedAt),
      );
      if (receipt.status !== 'completed') return emitCommandReceipt(io, command, receipt);
      const view = buildBatchDeliveryCommandView(receipt.commandId, receipt.replayed, 'phase.delivery.approve', receipt.result as Record<string, unknown>);
      return emitSuccess(io, command, receipt.result, formatBatchDeliveryCommandView(view));
    }
    case 'phase.labels':
    case 'feature.labels':
    case 'task.labels': {
      const labels: ParsedPlanLabels = command;
      const issuedAt = await replayIssuedAt(client, labels.explicitCommandId);
      const receipt = await client.updatePlanLabels(
        {
          projectId: labels.projectId,
          entityType: labels.entityType,
          id: labels.id,
          expectedRevision: labels.revision,
          labels: labels.labels,
        },
        envelopeIdentityOptions(labels.explicitCommandId, issuedAt),
      );
      return emitCommandReceipt(io, command, receipt);
    }
    case 'phase.list': {
      const result = await client.listPhases(command.projectId, {
        ...(command.labels !== undefined ? { labels: [...command.labels] } : {}),
        ...(command.match !== undefined ? { match: command.match } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      return emitSuccess(io, command, result, planListHumanLine('phase', result));
    }
    case 'phase.get': {
      const result = await client.getPhase(command.phaseId);
      return emitSuccess(io, command, result, phaseDetailHumanLine(result));
    }
    case 'feature.list': {
      const result = await client.listFeatures(command.projectId, command.phaseId, {
        ...(command.labels !== undefined ? { labels: [...command.labels] } : {}),
        ...(command.match !== undefined ? { match: command.match } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      return emitSuccess(io, command, result, planListHumanLine('feature', result));
    }
    case 'feature.get': {
      const result = await client.getFeature(command.featureId);
      return emitSuccess(io, command, result, featureDetailHumanLine(result));
    }
    case 'task.list': {
      const result = await client.listTasks(command.projectId, command.featureId, {
        ...(command.labels !== undefined ? { labels: [...command.labels] } : {}),
        ...(command.match !== undefined ? { match: command.match } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      return emitSuccess(io, command, result, planListHumanLine('task', result));
    }
    case 'task.get': {
      const result = await client.getTask(command.taskId);
      return emitSuccess(io, command, result, taskDetailHumanLine(result));
    }
    case 'feature.approve':
    case 'feature.reject': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.decideFeaturePlan(
        {
          projectId: command.projectId,
          featureId: command.featureId,
          planDigest: command.planDigest,
          decision: command.commandId === 'feature.approve' ? 'approve' : 'reject',
          reason: command.reason ?? null,
          expectedRevision: command.revision,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildFeaturePlanDecisionView(commandId, replayed, result as FeaturePlanDecideResult),
        formatFeaturePlanDecisionView,
      );
    }
    /* P03-8 / F-011：Feature 分轴结果查询与最终审批/显式收尾命令（全部经
     * HostClient 公共面；completed 回执结果经冻结字段集线校验器复核后投影）。 */
    case 'integration.plan': {
      const result = await client.getIntegrationPlan(command.projectId, command.integrationId);
      const view = buildIntegrationPlanCliView(result);
      return emitSuccess(io, command, view, formatIntegrationPlanView(view));
    }
    case 'feature.report': {
      const result = await client.getFeatureReport(command.projectId, command.featureId);
      // F-006：文本输出为可审阅文本视图（同一报告投影重新生成，不倾倒 JSON）。
      return emitSuccess(io, command, result, formatFeatureReportTextView(buildFeatureReportTextView(result)));
    }
    case 'feature.delivery': {
      const result = await client.getFeatureDelivery(command.projectId, command.featureId);
      const view = buildFeatureDeliveryView(result);
      return emitSuccess(io, command, view, formatFeatureDeliveryView(view));
    }
    case 'feature.final-approve': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.submitTaskApprovalDecision(
        {
          projectId: command.projectId,
          taskId: command.taskId,
          itemId: command.itemId,
          planDigest: command.planDigest,
          codeDigest: command.codeDigest,
          decision: 'approve',
          expectedRevision: command.revision,
          artifactRefs: parseArtifactRefValues(command.artifactRefs, {
            command: command.command,
            commandId: command.commandId,
            json: command.json,
          }),
          reason: command.reason ?? null,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildFeatureFinalApprovalView(commandId, replayed, result as TaskApprovalDecisionResult),
        formatFeatureFinalApprovalView,
      );
    }
    case 'feature.finalize': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.continueFeatureVerification(
        {
          projectId: command.projectId,
          featureId: command.featureId,
          runId: command.runId,
          batchId: command.batchId,
          operationId: command.operationId,
          expectedRevision: command.revision,
          ...(command.explicitCommandId !== undefined
            ? { commandId: command.explicitCommandId }
            : {}),
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildFeatureFinalizeView(commandId, replayed, result as FeatureDeliveryCommandResult),
        formatFeatureFinalizeView,
      );
    }
    case 'task.strategy-reapply-preview': {
      const result = await client.previewTaskStrategyReapplication(command.projectId, command.taskIds);
      return emitSuccess(io, command, result, formatTaskStrategyReapplicationPreview(result));
    }
    case 'task.strategy-reapply': {
      if (inputs.strategyPayload === undefined) throw new TypeError('task.strategy-reapply 缺少已校验输入');
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.reapplyTaskStrategy({
        ...inputs.strategyPayload,
        projectId: command.projectId,
        confirmed: command.confirm,
      } as TaskStrategyReapplicationInput, envelopeIdentityOptions(command.explicitCommandId, issuedAt));
      if (receipt.status === 'rejected') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForReceiptStatus('rejected'), command: command.commandId,
          code: receipt.error.code, message: receipt.error.message, commandId: receipt.commandId,
          ...(receipt.error.details === undefined ? {} : { details: receipt.error.details }),
        });
      }
      if (receipt.status !== 'completed') throw new Error('unexpected_accepted_receipt');
      return emitSuccess(io, command, receipt, formatTaskStrategyReapplicationResult(
        receipt.commandId, receipt.replayed, receipt.result as unknown as TaskStrategyReapplicationResult,
      ));
    }
    case 'task.strategy': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.updateTaskStrategy(
        {
          projectId: command.projectId,
          taskId: command.taskId,
          executionConfig: inputs.strategyPayload as Record<string, unknown>,
          expectedRevision: command.revision,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildTaskStrategyEditView(commandId, replayed, result as TaskStrategyUpdateResult),
        formatTaskStrategyEditView,
      );
    }
    case 'task.prepare': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.prepareExecutionInput(
        {
          projectId: command.projectId,
          featureId: command.featureId,
          taskId: command.taskId,
          items: inputs.prepareItems ?? [],
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildExecutionInputView(commandId, replayed, result as ExecutionInputPrepareResult),
        (view) => formatExecutionInputView(view, 'task.prepare'),
      );
    }
    case 'task.inputs': {
      // 固定输入查看：沿用既有回执查询流程（不新增查询面、不读正文）。
      const receipt = await client.getReceipt(command.targetCommandId);
      if (receipt.status === 'rejected') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForReceiptStatus('rejected'),
          command: command.commandId,
          code: receipt.error.code,
          message: receipt.error.message,
          commandId: receipt.commandId,
          ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
        });
      }
      if (receipt.status !== 'completed') {
        throw new Error('unexpected_accepted_receipt');
      }
      if (receipt.operation !== 'execution.input.prepare') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForAppErrorCode('invalid_input'),
          command: command.commandId,
          code: 'invalid_input',
          message: '回执不是执行输入准备结果（不折算固定输入）',
          commandId: receipt.commandId,
          details: { reason: 'receipt_operation_mismatch' },
        });
      }
      const prepared = validateExecutionInputPrepareResultWire(receipt.result);
      const view = buildExecutionInputView(receipt.commandId, receipt.replayed, prepared);
      return emitSuccess(io, command, view, formatExecutionInputView(view, 'task.inputs'));
    }
    /* P03-7 / F-014：人审事项/显式验证继续命令与 Task 状态查询（全部经
     * HostClient 公共面；决定/继续的回执结果经冻结字段集线校验器复核后投影）。 */
    case 'task.status': {
      const verification = await client.getTaskVerification(command.projectId, command.taskId);
      const approvals = await client.listTaskApprovalItems(command.projectId, command.taskId, {
        limit: 200,
      });
      const rework = await client.listTaskReworkChain(command.projectId, command.taskId, {
        limit: 1,
      });
      const view = buildTaskStatusView(command.commandId, {
        verification,
        approvals,
        rework,
      });
      return emitSuccess(io, command, view, formatTaskStatusView(view));
    }
    case 'task.block': {
      const block: ParsedTaskApprovalBlock = command;
      const issuedAt = await replayIssuedAt(client, block.explicitCommandId);
      const receipt = await client.submitTaskApprovalBlock(
        {
          projectId: block.projectId,
          taskId: block.taskId,
          planDigest: block.planDigest,
          expectedRevision: block.revision,
          ...(block.kindOption !== undefined ? { kind: block.kindOption } : {}),
          ...(block.description !== undefined ? { description: block.description } : {}),
          ...(block.responsibleParty !== undefined
            ? { responsibleParty: block.responsibleParty }
            : {}),
          ...(block.codeDigest !== undefined ? { codeDigest: block.codeDigest } : {}),
          artifactRefs: parseArtifactRefValues(block.artifactRefs, {
            command: block.command,
            commandId: block.commandId,
            json: block.json,
          }),
        },
        envelopeIdentityOptions(block.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildTaskApprovalBlockView(commandId, replayed, result as TaskApprovalBlockResult),
        formatTaskApprovalBlockView,
      );
    }
    case 'task.approve':
    case 'task.reject':
    case 'task.unblock': {
      const decision: ParsedTaskApprovalDecision = command;
      const issuedAt = await replayIssuedAt(client, decision.explicitCommandId);
      const receipt = await client.submitTaskApprovalDecision(
        {
          projectId: decision.projectId,
          taskId: decision.taskId,
          itemId: decision.itemId,
          planDigest: decision.planDigest,
          codeDigest: decision.codeDigest,
          decision: decision.operation.slice('task.approval.'.length) as
            | 'approve'
            | 'reject'
            | 'unblock',
          expectedRevision: decision.revision,
          artifactRefs: parseArtifactRefValues(decision.artifactRefs, {
            command: decision.command,
            commandId: decision.commandId,
            json: decision.json,
          }),
          reason: decision.reason ?? null,
        },
        envelopeIdentityOptions(decision.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildTaskApprovalDecisionView(commandId, replayed, result as TaskApprovalDecisionResult),
        formatTaskApprovalDecisionView,
      );
    }
    case 'task.continue': {
      const continuation: ParsedTaskVerificationContinue = command;
      const issuedAt = await replayIssuedAt(client, continuation.explicitCommandId);
      const receipt = await client.continueTaskVerification(
        {
          projectId: continuation.projectId,
          taskId: continuation.taskId,
          attemptId: continuation.attemptId,
          verificationBatchId: continuation.verificationBatchId,
          codeDigest: continuation.codeDigest,
          observationDigest: continuation.observationDigest,
          expectedRevision: continuation.revision,
        },
        envelopeIdentityOptions(continuation.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildTaskVerificationContinueView(
            commandId,
            replayed,
            result as TaskVerificationContinueResult,
          ),
        formatTaskVerificationContinueView,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * P03-3 / F-012 执行授权命令（execution preview/start/budget/revise）
 *
 * 全部经既有 HostClient 公共面：预览/启动/修订走冻结信封与回执（显式
 * --command-id 先查回执重放）；预算查询走授权只读查询。CLI 不打开状态库、
 * 不读取凭据、不运行模型；accepted 只是提交成功（退出码 0），结构化输出
 * 明确未执行/未验收，不被描述为 Feature 已验收通过；本面不实现
 * wait/cancel/resume。
 * ------------------------------------------------------------------ */

/** execution.start 的 accepted 回执（Work accepted v6：真实 Batch/Run 关联）。 */
type WorkAcceptedReceipt = Extract<CommandReceipt, { batchId: string }>;

/**
 * execution.start 回执 → §12.3 输出：
 * - rejected：业务拒绝（preview_stale/budget_exhausted/… 稳定原因）→ 退出码 1；
 * - accepted：执行授权提交成功（真实 Batch/Run 创建）→ 退出码 0（提交成功）；
 *   输出 completion.featureVerified=false 并注明未执行/未验收；
 * - completed：execution.start 不产生 completed 回执（fail-closed）。
 */
function emitExecutionStartReceipt(
  io: AppCliIo,
  command: ParsedExecutionCommand & { commandId: 'execution.start' },
  receipt: CommandReceipt,
  fixedFeatureIds?: readonly string[],
): AppCliRunResult {
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  if (receipt.status !== 'accepted' || !('batchId' in receipt)) {
    throw new Error('unexpected_completed_receipt');
  }
  const accepted = receipt as WorkAcceptedReceipt;
  const view = buildExecutionStartView(
    {
      commandId: accepted.commandId,
      replayed: accepted.replayed,
      featureIds: fixedFeatureIds ?? command.featureIds,
      previewDigest: command.previewDigest ?? null,
      retryBatchId: command.retryBatchId ?? null,
    },
    { operationId: accepted.operationId, batchId: accepted.batchId, runId: accepted.runId },
  );
  return emitSuccess(io, command, view, formatExecutionStartView(view));
}

/** 执行一条执行授权命令意图（预览/启动/预算查询/预算修订）。 */
async function executeExecutionCommand(
  io: AppCliIo,
  command: ParsedExecutionCommand,
  client: HostClient,
  inputs: { readonly budget?: ExecutionBudgetWire },
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'execution.preview': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.previewExecution(
        {
          projectId: command.projectId,
          ...(command.phaseId !== undefined ? { phaseId: command.phaseId } : { featureIds: command.featureIds }),
          budget: inputs.budget,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildExecutionPreviewView(commandId, replayed, result as ExecutionPreviewResult),
        formatExecutionPreviewView,
      );
    }
    case 'execution.start': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      let featureIds = command.featureIds;
      if (command.phaseId !== undefined) {
        if (command.retryBatchId !== undefined || inputs.budget === undefined) {
          throw new HostProtocolError('invalid_input', 'commands.submit', 'Phase 启动缺少可用于固定范围展开的预算', {
            details: { reason: 'phase_scope_requires_fresh_budget' },
          });
        }
        // Phase 启动先读取一次只读预览，由 Host/Core 解析依赖闭包；随后把服务端
        // 返回的固定成员 ID 集合提交给 execution.start。CLI 不自行计算 DAG。
        const expansion = await client.previewExecution(
          { projectId: command.projectId, phaseId: command.phaseId, budget: inputs.budget },
        );
        if (expansion.status === 'rejected') {
          return emitFailure(io, command.json, {
            exitCode: exitCodeForReceiptStatus('rejected'),
            command: command.commandId,
            code: expansion.error.code,
            message: expansion.error.message,
            commandId: expansion.commandId,
            ...(expansion.error.details !== undefined ? { details: expansion.error.details } : {}),
          });
        }
        if (expansion.status !== 'completed') {
          throw new HostProtocolError('response_malformed', 'commands.submit', 'Phase 预览未返回完整结果', {
            details: { reason: 'phase_scope_preview_incomplete' },
          });
        }
        const expanded = expansion.result as ExecutionPreviewResult;
        if (expanded.status !== 'ready' || !('memberFeatureIds' in expanded.scope)) {
          return emitFailure(io, command.json, {
            exitCode: 1,
            command: command.commandId,
            code: 'conflict',
            message: 'Phase 当前范围不可启动，预览未形成固定 Feature 成员',
            commandId: expansion.commandId,
            details: { reason: expanded.status === 'blocked' ? 'blocked' : expanded.noWorkReason ?? 'preview_stale' },
          });
        }
        featureIds = expanded.scope.memberFeatureIds;
      }
      const receipt =
        command.retryBatchId !== undefined
          ? await client.startExecution(
              {
                projectId: command.projectId,
                featureIds,
                retryBatchId: command.retryBatchId,
              },
              envelopeIdentityOptions(command.explicitCommandId, issuedAt),
            )
          : await client.startExecution(
              {
                projectId: command.projectId,
                featureIds,
                budget: inputs.budget,
                previewDigest: command.previewDigest as string,
              },
              envelopeIdentityOptions(command.explicitCommandId, issuedAt),
            );
      return emitExecutionStartReceipt(io, command, receipt, featureIds);
    }
    case 'execution.budget': {
      const status = await client.getExecutionBudgetStatus(command.projectId, command.batchId);
      const revisions = await client.listBatchBudgetRevisions(command.projectId, command.batchId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildExecutionBudgetView(status, revisions);
      return emitSuccess(io, command, view, formatExecutionBudgetView(view));
    }
    case 'execution.revise': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.reviseExecutionBudget(
        {
          projectId: command.projectId,
          batchId: command.batchId,
          expectedRevision: command.revision,
          budget: inputs.budget,
          reason: command.reason,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) => buildExecutionReviseView(commandId, replayed, result),
        formatExecutionReviseView,
      );
    }
    case 'execution.batch-delivery': {
      const result = await client.getBatchDelivery(command.projectId, command.batchId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildBatchDeliveryView(result);
      return emitSuccess(io, command, result, formatBatchDeliveryView(view));
    }
    case 'execution.batch-observe': {
      const result = await client.observeBatch(command.projectId, command.batchId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildBatchObservationView(result);
      return emitSuccess(io, command, result, formatBatchObservationView(view));
    }
    case 'execution.finalize': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.finalizeBatch(
        {
          projectId: command.projectId,
          phaseId: command.phaseId,
          batchId: command.batchId,
          expectedRevision: command.revision,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      if (receipt.status !== 'completed') return emitCommandReceipt(io, command, receipt);
      const view = buildBatchDeliveryCommandView(receipt.commandId, receipt.replayed, 'execution.batch.finalize', receipt.result as Record<string, unknown>);
      return emitSuccess(io, command, receipt.result, formatBatchDeliveryCommandView(view));
    }
    /* ------------------------------------------------------------ *
     * P03-4 / F-009 调度诊断与 Attempt 审计只读查询
     *（只经 HostClient 授权只读查询：不认领、不扣额、不启动 Runtime）
     * ------------------------------------------------------------ */
    case 'execution.schedule': {
      const result = await client.getRunScheduleStatus(command.projectId, command.runId);
      const view = buildExecutionScheduleView(result);
      return emitSuccess(io, command, view, formatExecutionScheduleView(view));
    }
    case 'execution.attempts': {
      const result = await client.listExecutionAttempts(command.projectId, command.taskId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildExecutionAttemptsView(result);
      return emitSuccess(io, command, view, formatExecutionAttemptsView(view));
    }
    // P06-6 / F-007：Run 持久元数据标签列表（runs.list 只读查询；不触达
    // 执行/配置快照，不打开状态库）。
    case 'execution.runs': {
      const result = await client.listRuns(command.projectId, {
        ...(command.featureId !== undefined ? { featureId: command.featureId } : {}),
        ...(command.batchId !== undefined ? { batchId: command.batchId } : {}),
        ...(command.labels.length > 0 ? { labels: [...command.labels] } : {}),
        match: command.match,
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      return emitSuccess(io, command, result, runListHumanLine(result));
    }
    case 'execution.diagnostics': {
      const result = await client.listAttemptDiagnostics(command.projectId, command.attemptId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildExecutionDiagnosticsView(result);
      return emitSuccess(io, command, view, formatExecutionDiagnosticsView(view));
    }
    /* ------------------------------------------------------------ *
     * P04-9 / F-009 派发队列与执行槽位只读查询
     *（只经 HostClient 授权只读查询：不认领、不扣额、不启动 Runtime）
     * ------------------------------------------------------------ */
    case 'execution.dispatch': {
      const result = await client.listExecutionDispatchQueue(command.projectId, {
        ...(command.batchId !== undefined ? { batchId: command.batchId } : {}),
        ...(command.featureId !== undefined ? { featureId: command.featureId } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildExecutionDispatchView(result);
      return emitSuccess(io, command, view, formatExecutionDispatchView(view));
    }
    /* ------------------------------------------------------------ *
     * P03-6 / F-013 Work Session 状态/证据与取消接受结构化输出
     *（只经 HostClient 公共契约；查询只读零副作用，取消必须解析层 --confirm）
     * ------------------------------------------------------------ */
    case 'execution.sessions': {
      const result = await client.listWorkSessions(command.projectId, {
        ...(command.runId !== undefined ? { runId: command.runId } : { taskId: command.taskId }),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildWorkSessionListView(
        result,
        command.runId !== undefined ? { runId: command.runId } : { taskId: command.taskId as string },
      );
      return emitSuccess(io, command, view, formatWorkSessionListView(view));
    }
    case 'execution.session': {
      const result = await client.getWorkSession(command.projectId, command.attemptId);
      const view = buildWorkSessionDetailView(result);
      return emitSuccess(io, command, view, formatWorkSessionDetailView(view));
    }
    case 'execution.session-evidence': {
      const result = await client.readWorkSessionEvidence(
        command.projectId,
        command.attemptId,
        command.artifactId,
      );
      const view = buildWorkSessionEvidenceView(result);
      return emitSuccess(io, command, view, formatWorkSessionEvidenceView(view));
    }
    /* ------------------------------------------------------------ *
     * P04-5 / F-007 Work 公开记录索引/正文结构化输出（只读；投影只消费
     * wire 已脱敏的结构化结果，不被 logger 文本驱动；覆盖度不折算验收）
     * ------------------------------------------------------------ */
    case 'execution.recordings': {
      const parent: WorkRecordingParent = command.runId !== undefined
        ? { runId: command.runId }
        : command.attemptId !== undefined
          ? { attemptId: command.attemptId }
          : { sessionId: command.sessionId as string };
      const result = await client.listWorkRecordings(command.projectId, {
        ...parent,
        recordType: command.recordType,
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildWorkRecordingListView(result, parent);
      return emitSuccess(io, command, view, formatWorkRecordingListView(view));
    }
    case 'execution.recording-body': {
      const parent: WorkRecordingParent = command.runId !== undefined
        ? { runId: command.runId }
        : command.attemptId !== undefined
          ? { attemptId: command.attemptId }
          : { sessionId: command.sessionId as string };
      const result = await client.readWorkRecordingBody(command.projectId, {
        ...parent,
        artifactId: command.artifactId,
      });
      const view = buildWorkRecordingBodyView(result);
      return emitSuccess(io, command, view, formatWorkRecordingBodyView(view));
    }
    case 'execution.cancel': {
      /* P03-9 / F-015：无 positional + --run/--batch 形态映射 Run/Batch 级
       * execution.cancel（持久停止 operation）；既有 Attempt 形态不变。 */
      if (command.operation === 'execution.cancel') {
        const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
        const receipt = await client.cancelExecution(
          {
            projectId: command.projectId,
            ...(command.targetKind === 'run'
              ? { runId: command.targetId }
              : { batchId: command.targetId }),
            expectedRevision: command.expectedRevision,
            ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
          },
          envelopeIdentityOptions(command.explicitCommandId, issuedAt),
        );
        return emitControlCommandReceipt(io, command, 'execution.cancel', receipt);
      }
      // 取消响应丢失沿用回执查询与原信封（同一 --command-id 重放命中服务端摘要
      // 重放返回原回执），不额外启动工作、不更换命令身份。
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.cancelAttempt(
        {
          projectId: command.projectId,
          attemptId: command.attemptId,
          ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildAttemptCancelView(commandId, replayed, result, {
            projectId: command.projectId,
            attemptId: command.attemptId,
          }),
        formatAttemptCancelView,
      );
    }
    /* ------------------------------------------------------------ *
     * P03-9 / F-015 Run/Batch 控制、retryFinal 与恢复诊断入口
     * （只经 HostClient 公共面：不打开 SQLite、不读取业务文件；
     * completed 只代表控制事务落地，输出不宣称已暂停/停止/完成）
     * ------------------------------------------------------------ */
    case 'execution.pause': {
      const receipt = await controlCommand(
        client,
        command,
        (input, options) => client.pauseExecution(input, options),
      );
      return emitControlCommandReceipt(io, command, 'execution.pause', receipt);
    }
    case 'execution.resume': {
      const receipt = await controlCommand(
        client,
        command,
        (input, options) => client.resumeExecution(input, options),
      );
      return emitControlCommandReceipt(io, command, 'execution.resume', receipt);
    }
    case 'execution.retry-final': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.retryFinalExecution(
        {
          projectId: command.projectId,
          featureId: command.featureId,
          historicalRunId: command.historicalRunId,
          workKey: command.workKey,
          ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      if (receipt.status === 'completed') {
        const view = buildExecutionRetryFinalView(
          receipt.commandId,
          receipt.replayed,
          receipt.result as never,
        );
        return emitSuccess(io, command, view, formatExecutionRetryFinalView(view));
      }
      return emitControlFailure(io, command, receipt);
    }
    case 'execution.control': {
      const result = await client.getRunControl(command.projectId, command.runId);
      const view = buildExecutionControlQueryView(result);
      return emitSuccess(io, command, view, formatExecutionControlQueryView(view));
    }
    case 'execution.batch-control': {
      const result = await client.getBatchControl(command.projectId, command.batchId);
      const view = buildExecutionControlQueryView(result);
      return emitSuccess(io, command, view, formatExecutionControlQueryView(view));
    }
    case 'execution.resources': {
      const result = await client.listExecutionResources(command.projectId, {
        ...(command.batchId === undefined ? {} : { batchId: command.batchId }),
        ...(command.featureId === undefined ? {} : { featureId: command.featureId }),
        ...(command.limit === undefined ? {} : { limit: command.limit }),
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
      });
      const view = buildExecutionResourceQueryView(result);
      return emitSuccess(io, command, view, formatExecutionResourceQueryView(view));
    }
    case 'execution.recovery': {
      const result = await client.getRunRecovery(command.projectId, command.runId);
      const view = buildExecutionRecoveryCliView(result);
      return emitSuccess(io, command, view, formatExecutionRecoveryCliView(view));
    }
  }
}

/** Run/Batch 控制命令（pause/cancel/resume）的 HostClient 输入组装与提交。 */
async function controlCommand(
  client: HostClient,
  command: Extract<ParsedExecutionCommand, { targetKind: 'run' | 'batch' }>,
  submit: (
    input: Parameters<HostClient['pauseExecution']>[0],
    options: ReturnType<typeof envelopeIdentityOptions>,
  ) => Promise<CommandReceipt>,
): Promise<CommandReceipt> {
  const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
  return submit(
    {
      projectId: command.projectId,
      ...(command.targetKind === 'run'
        ? { runId: command.targetId }
        : { batchId: command.targetId }),
      expectedRevision: command.expectedRevision,
      ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
    },
    envelopeIdentityOptions(command.explicitCommandId, issuedAt),
  );
}

/**
 * 控制命令 completed 回执输出（P03-9 / F-015）：rejected 是业务拒绝（退出码 1，
 * 保留 commandId 可查回执）；completed 投影为结构化视图，输出不宣称已暂停/
 * 已停止/已验收。
 */
function emitControlCommandReceipt(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  operation: ExecutionControlOperation,
  receipt: CommandReceipt,
): AppCliRunResult {
  if (receipt.status !== 'completed') {
    return emitControlFailure(io, command, receipt);
  }
  const view = buildExecutionControlCommandView(
    receipt.commandId,
    receipt.replayed,
    operation,
    receipt.result as unknown as Parameters<typeof buildExecutionControlCommandView>[3],
  );
  return emitSuccess(io, command, view, formatExecutionControlCommandView(view));
}

/** 控制命令 rejected 回执输出（与 emitDomainReceipt 同一失败语义）。 */
function emitControlFailure(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  receipt: CommandReceipt,
): AppCliRunResult {
  if (receipt.status !== 'rejected') {
    // 控制命令均为同步 completed；accepted 属协议异常（fail-closed）。
    throw new Error('unexpected_accepted_receipt');
  }
  return emitFailure(io, command.json, {
    exitCode: exitCodeForReceiptStatus('rejected'),
    command: command.commandId,
    code: receipt.error.code,
    message: receipt.error.message,
    commandId: receipt.commandId,
    ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * P03-5 / F-012 工作区状态展示与人工丢弃预览/确认
 *
 * 只经 HostClient 公共方法：状态查询只读零副作用；丢弃预览/确认复用冻结信封、
 * 显式命令身份与「超时先查回执」纪律（响应丢失不更换 commandId、不产生重复
 * 副作用）；CLI 不打开 SQLite、不读写代码工作目录、不直接调用 Git。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * P03-8 / F-011 Git 意图/实际提交/操作回执只读查询
 *
 * 全部经既有 HostClient 公共面：CLI 不打开状态库、不直接执行 Git；
 * pending（回执缺失）与 unknown（待核对）不显示为成功。
 * ------------------------------------------------------------------ */

type ParsedGitCommand = Extract<ParsedAppCliCommand, { command: 'git' }>;
type ParsedBackupCommand = Extract<ParsedAppCliCommand, { command: 'backup' }>;
type ParsedRetentionCommand = Extract<ParsedAppCliCommand, { command: 'retention' }>;
type ParsedRestoreCommand = Extract<ParsedAppCliCommand, { command: 'restore' }>;

async function executeGitCommand(
  io: AppCliIo,
  command: ParsedGitCommand,
  client: HostClient,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'git.operations': {
      const result = await client.listGitOperations(
        command.projectId,
        command.featureId !== undefined
          ? { featureId: command.featureId }
          : { runId: command.runId as string },
        {
          ...(command.limit !== undefined ? { limit: command.limit } : {}),
          ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
        },
      );
      const view = buildGitOperationListView(result);
      return emitSuccess(io, command, view, formatGitOperationListView(view));
    }
    case 'git.repairs': {
      const result = await client.listGitAgentRepairs(command.projectId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildGitAgentRepairListView(result);
      return emitSuccess(io, command, view, formatGitAgentRepairListView(view));
    }
    case 'git.repair': {
      const result = await client.getGitAgentRepair(command.projectId, command.repairId);
      const view = buildGitAgentRepairView(result);
      return emitSuccess(io, command, view, formatGitAgentRepairView(view));
    }
    case 'git.operation': {
      const result = await client.getGitOperation(command.projectId, command.operationId);
      const view = buildGitOperationDetailView(result);
      return emitSuccess(io, command, view, formatGitOperationDetailView(view));
    }
  }
}

type ParsedWorkspaceCommand = Extract<ParsedAppCliCommand, { command: 'workspace' }>;

interface WorkspaceCommandInputs {
  readonly discardPayload?: WorkspaceDiscardConfirmPayload;
}

/* ------------------------------------------------------------------ *
 * P07-3 / F-014：备份 owner 命令与隔离恢复维护入口
 * ------------------------------------------------------------------ */

function buildBackupCreateAcceptedView(
  commandId: string,
  replayed: boolean,
  receipt: AcceptedReceipt,
  backupId: string,
): Record<string, unknown> {
  return {
    commandId,
    replayed,
    status: 'accepted',
    operationId: receipt.operationId,
    backupId,
    note: '备份导出已受理；完成状态经 backup operation <operationId> 查询持久结果，不重复导出。',
  };
}

async function executeBackupCommand(
  io: AppCliIo,
  command: ParsedBackupCommand,
  client: HostClient,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'backup.create': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.submitDataBackupCreate(
        {
          backupId: command.backupId,
          ...(command.target === 'default' ? {} : { target: command.target }),
          ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
          ...(issuedAt !== undefined ? { issuedAt } : {}),
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      if (receipt.status === 'rejected') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForReceiptStatus('rejected'),
          command: command.commandId,
          code: receipt.error.code,
          message: receipt.error.message,
          commandId: receipt.commandId,
          ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
        });
      }
      if (receipt.status !== 'accepted') {
        throw new HostProtocolError('response_malformed', 'commands.submit', undefined, {
          details: { reason: 'backup_create_receipt_invalid' },
        });
      }
      const view = buildBackupCreateAcceptedView(receipt.commandId, receipt.replayed === true, receipt, command.backupId);
      const human = `shiploop backup create: accepted backup=${command.backupId} operation=${receipt.operationId}` +
        `${receipt.replayed === true ? '（replayed）' : ''}\n完成状态：shiploop backup operation ${receipt.operationId}\n`;
      return emitSuccess(io, command, view, human);
    }
    case 'backup.verify': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.submitDataBackupVerify(
        {
          backupId: command.backupId,
          manifestDigest: command.manifestDigest,
          ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
          ...(issuedAt !== undefined ? { issuedAt } : {}),
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      if (receipt.status === 'rejected') {
        return emitFailure(io, command.json, {
          exitCode: exitCodeForReceiptStatus('rejected'),
          command: command.commandId,
          code: receipt.error.code,
          message: receipt.error.message,
          commandId: receipt.commandId,
          ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
        });
      }
      if (receipt.status !== 'completed') {
        throw new HostProtocolError('response_malformed', 'commands.submit', undefined, {
          details: { reason: 'backup_verify_receipt_invalid' },
        });
      }
      const report = receipt.result as { status?: string };
      if (report.status !== 'complete') {
        // 核验未通过不是命令失败折算：如实输出同一报告并以非成功退出码结束。
        return emitFailure(io, command.json, {
          exitCode: CLI_EXIT_REJECTED,
          command: command.commandId,
          code: `backup_verification_${String(report.status)}`,
          message: '备份核验未通过（报告见 details.report；不修改任何数据）',
          commandId: receipt.commandId,
          details: { report: receipt.result },
        });
      }
      const view = { commandId: receipt.commandId, replayed: receipt.replayed === true, report: receipt.result };
      const human = `shiploop backup verify: complete backup=${command.backupId}` +
        `${receipt.replayed === true ? '（replayed）' : ''}\n`;
      return emitSuccess(io, command, view, human);
    }
    case 'backup.get': {
      const result: BackupQueryResult = await client.getBackup(command.backupId);
      return emitSuccess(io, command, result, formatBackupFactsView(command.commandId, result));
    }
    case 'backup.operation': {
      const result: BackupOperationResult = await client.getBackupOperation(command.operationId);
      return emitSuccess(io, command, result, formatBackupOperationView(command.commandId, result));
    }
    default:
      throw new TypeError('未知备份子命令');
  }
}

function formatBackupFactsView(commandId: string, result: BackupQueryResult): string {
  if (result.status === 'complete') {
    const summary = result.manifestSummary!;
    return [
      `shiploop ${commandId}: complete backup=${result.backupId} manifestDigest=${result.manifestDigest}`,
      `  schema=v${summary.schemaVersion} package=v${summary.packageVersion} createdAt=${summary.createdAtUtc}`,
      `  projects=${summary.projectCount} files=${summary.fileCount} native=${summary.nativeRecordCount} external=${summary.externalDependencyCount}`,
      '',
    ].join('\n');
  }
  const report = result.report;
  const reasons = report === undefined ? '' : ` reasons=${report.reasons.join(',')}`;
  return `shiploop ${commandId}: ${result.status} backup=${result.backupId}${reasons}\n`;
}

function formatBackupOperationView(commandId: string, result: BackupOperationResult): string {
  const lines = [
    `shiploop ${commandId}: ${result.status} operation=${result.operationId} backup=${result.backupId} kind=${result.kind}`,
  ];
  if (result.manifestDigest !== undefined) lines.push(`  manifestDigest=${result.manifestDigest}`);
  if (result.reason !== undefined) lines.push(`  reason=${result.reason}`);
  if (result.report !== undefined) {
    lines.push(`  report: status=${result.report.status} projects=${result.report.scannedProjects}` +
      ` artifacts=${result.report.scannedArtifacts} files=${result.report.copiedFiles}` +
      ` bytes=${result.report.totalBytes} durationMs=${result.report.durationMs}` +
      `${result.report.reasons.length === 0 ? '' : ` reasons=${result.report.reasons.join(',')}`}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 离线维护入口错误 → 受控失败信封（不回显堆栈/绝对路径；reason 受控映射）。 */
function restoreFailureOf(error: unknown): { code: string; message: string } {
  if (error !== null && typeof error === 'object' && typeof (error as { reason?: unknown }).reason === 'string') {
    const reason = (error as { reason: string }).reason;
    return { code: `restore_${reason}`, message: `隔离恢复维护入口拒绝（${reason}）` };
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /data\.restore: ([A-Za-z0-9_.:-]+)/.exec(message);
  if (match !== null) {
    return { code: `restore_${match[1]}`, message: `隔离恢复维护入口拒绝（${match[1]}）` };
  }
  return { code: 'restore_failed', message: '隔离恢复维护入口执行失败（已脱敏）' };
}

function readRestoreConfirmationDocument(
  command: Extract<ParsedRestoreCommand, { commandId: 'restore.confirm' }>,
): Record<string, unknown> {
  const state = { command: command.command, commandId: command.commandId, json: command.json };
  let handle: number | undefined;
  try {
    handle = openSync(command.confirmationFile, 'r');
    const buffer = Buffer.alloc(MAX_APP_BODY_BYTES + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_APP_BODY_BYTES) {
      throw new AppCliParseError('invalid_input', 'input_file_too_large', state, 'confirmation-file');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return parseAppInputJson(text, { commandId: command.commandId, json: command.json });
  } catch (error) {
    if (error instanceof AppCliParseError) throw error;
    throw new AppCliParseError('invalid_input', 'invalid_input_file', state, 'confirmation-file');
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle); } catch { /* 关闭失败不改变读取结论 */ }
    }
  }
}

/** P07-3 / F-014：核验→确认→隔离恢复的离线维护入口（不发现/启动 Host）。 */
async function executeRestoreCommand(
  io: AppCliIo,
  command: ParsedRestoreCommand,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'restore.verify': {
      const verification = createOfflineBackupVerificationService({ dataRoot: command.dataRoot });
      let report: Awaited<ReturnType<typeof verification.verify>>;
      try {
        report = await verification.verify({
          packagePath: command.packagePath,
          ...(command.expectedBackupId === undefined ? {} : { expectedBackupId: command.expectedBackupId }),
        });
      } catch (error) {
        const failure = restoreFailureOf(error);
        return emitFailure(io, command.json, {
          exitCode: CLI_EXIT_REJECTED,
          command: command.commandId,
          code: failure.code,
          message: failure.message,
        });
      }
      if (report.status !== 'complete') {
        return emitFailure(io, command.json, {
          exitCode: CLI_EXIT_REJECTED,
          command: command.commandId,
          code: `backup_verification_${report.status}`,
          message: '备份核验未通过（报告见 details.report；不修改任何数据）',
          details: { report },
        });
      }
      return emitSuccess(io, command, report, `shiploop restore verify: complete backup=${String(report.backupId)}\n`);
    }
    case 'restore.prepare': {
      const service = createOfflineRestoreService({ dataRoot: command.dataRoot });
      let preview: Awaited<ReturnType<typeof service.prepare>>;
      try {
        preview = await service.prepare({ operationId: command.operationId, packagePath: command.packagePath });
      } catch (error) {
        const failure = restoreFailureOf(error);
        return emitFailure(io, command.json, {
          exitCode: CLI_EXIT_REJECTED,
          command: command.commandId,
          code: failure.code,
          message: failure.message,
        });
      }
      const human = [
        `shiploop restore prepare: prepared operation=${preview.operationId} backup=${preview.backupId}`,
        `  targetDataRootId=${preview.confirmation.targetDataRootId}`,
        `  manifestDigest=${preview.confirmation.manifestDigest}`,
        `  verificationDigest=${preview.confirmation.verificationDigest}`,
        '确认文档已输出（--json 读取 result.confirmation）；审阅后执行 restore confirm。',
        '',
      ].join('\n');
      return emitSuccess(io, command, preview, human);
    }
    case 'restore.confirm': {
      const confirmation = readRestoreConfirmationDocument(command);
      const service = createOfflineRestoreService({ dataRoot: command.dataRoot });
      let receipt: Awaited<ReturnType<typeof service.confirm>>;
      try {
        receipt = await service.confirm({ operationId: command.operationId, confirmation });
      } catch (error) {
        const failure = restoreFailureOf(error);
        return emitFailure(io, command.json, {
          exitCode: CLI_EXIT_REJECTED,
          command: command.commandId,
          code: failure.code,
          message: failure.message,
        });
      }
      const human = [
        `shiploop restore confirm: ${receipt.status} operation=${receipt.operationId} backup=${receipt.backupId}`,
        `  execution=${receipt.execution} cleanup=${receipt.cleanup}`,
        '目标进入恢复隔离；重新核验外部事实前不自动启动 Host 或恢复执行。',
        '',
      ].join('\n');
      return emitSuccess(io, command, receipt, human);
    }
    default:
      throw new TypeError('未知恢复子命令');
  }
}

async function executeWorkspaceCommand(
  io: AppCliIo,
  command: ParsedWorkspaceCommand,
  client: HostClient,
  inputs: WorkspaceCommandInputs,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'workspace.list': {
      const result = await client.listWorkspaces(command.projectId, {
        ...(command.featureId !== undefined ? { featureId: command.featureId } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildWorkspaceListView(result);
      return emitSuccess(io, command, view, formatWorkspaceListView(view));
    }
    case 'workspace.get': {
      const result = await client.getWorkspace(command.projectId, command.featureId);
      const view = buildWorkspaceDetailView(result);
      return emitSuccess(io, command, view, formatWorkspaceDetailView(view));
    }
    case 'workspace.operations': {
      const result = await client.listWorkspaceOperations(command.projectId, {
        ...(command.featureId !== undefined ? { featureId: command.featureId } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const view = buildWorkspaceOperationListView(result);
      return emitSuccess(io, command, view, formatWorkspaceOperationListView(view));
    }
    case 'workspace.operation': {
      const result = await client.getWorkspaceOperation(command.projectId, command.operationId);
      const view = buildWorkspaceOperationDetailView(result);
      return emitSuccess(io, command, view, formatWorkspaceOperationDetailView(view));
    }
    case 'workspace.discard-preview': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const receipt = await client.previewWorkspaceDiscard(
        {
          projectId: command.projectId,
          featureId: command.featureId,
          ...(command.explicitCommandId !== undefined
            ? { commandId: command.explicitCommandId }
            : {}),
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (commandId, replayed, result) =>
          buildWorkspaceDiscardPreviewView(commandId, replayed, result as WorkspaceDiscardPreview),
        formatWorkspaceDiscardPreviewView,
      );
    }
    case 'workspace.discard': {
      const payload = inputs.discardPayload;
      if (payload === undefined) {
        // 装配错误：预览负载必须在连接前派生（缺确认/缺文件已在解析层拒绝）。
        throw new TypeError('workspace.discard 缺少预览确认负载');
      }
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      // 命令身份与 operation 身份同源：一次逻辑命令一个丢弃 operation，显式
      // --command-id 重放以同一信封命中服务端幂等锚点（不更换 commandId）。
      const commandId = command.explicitCommandId ?? randomUUID();
      const receipt = await client.confirmWorkspaceDiscard(
        {
          projectId: command.projectId,
          featureId: payload.featureId,
          workspaceId: payload.workspaceId,
          operationId: commandId,
          expectedWorkspaceRevision: payload.expectedWorkspaceRevision,
          preview: payload.preview,
          evidenceRefs: payload.evidenceRefs,
          commandId,
        },
        envelopeIdentityOptions(command.explicitCommandId, issuedAt),
      );
      return emitDomainReceipt(
        io,
        command,
        receipt,
        (receiptCommandId, replayed, result) =>
          buildWorkspaceDiscardSubmitView(
            receiptCommandId,
            replayed,
            result as WorkspaceDiscardSubmitResult,
          ),
        formatWorkspaceDiscardSubmitView,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 事件观察（F-017；契约 §8/§9.4/§12.1/§12.2/§12.3）
 *
 * 流程：默认先取授权快照与水位，再从水位之后订阅（--follow 为默认）；显式
 * --cursor 为恢复语义（跳过初始快照，snapshot-only 除外——它总是先取快照做
 * 授权核验与水位记录，显式游标仅决定补读起点）。snapshot_required（建连前 409
 * 或建连后 error 帧）明确输出记录并重取快照恢复，不默默丢历史事件；重载预算
 * 有界（连续无事件交付的重载超过上限即终止）。stream_overflow 与 Ctrl+C/Abort
 * 中断以第五档退出码 4 结束：只表示本次观察结束，Host 未停止、命令未取消。
 * JSON 观察模式输出 NDJSON 记录流（每行一个 {ok,command,result|error} 信封），
 * 不混入普通日志；人类模式快照/事件行走 stdout，诊断走 stderr。
 * ------------------------------------------------------------------ */

/** 观察预算覆盖（受信装配/测试注入；绝非 argv/env；全部有界）。 */
export interface EventsObserveBudgets {
  /** snapshot-only 补读静默窗口（默认 750ms，> Host SSE 轮询 250ms；允许 100..10 000）。 */
  readonly quietMs?: number;
  /** snapshot-only 单次补读总预算（默认 10 000；允许 ≤120 000 且 ≥ quietMs）。 */
  readonly drainBudgetMs?: number;
  /** 连续 snapshot_required 重载上限（无事件交付间隔；默认 3；允许 1..10）。 */
  readonly maxSnapshotReloads?: number;
}

const OBSERVE_QUIET_DEFAULT_MS = 750;
const OBSERVE_DRAIN_DEFAULT_MS = 10_000;
const OBSERVE_RELOAD_DEFAULT_MAX = 3;

interface ResolvedEventsObserveBudgets {
  readonly quietMs: number;
  readonly drainBudgetMs: number;
  readonly maxSnapshotReloads: number;
}

/** 校验观察预算覆盖（全部有界；非法注入以 invalid_input 拒绝，零 I/O）。 */
function resolveObserveBudgets(
  input: EventsObserveBudgets | undefined,
): ResolvedEventsObserveBudgets {
  const invalid = (reason: string, field: string): never => {
    throw new HostProtocolError('invalid_input', 'events.subscribe', '观察预算覆盖未通过校验', {
      details: { reason, field },
    });
  };
  if (input === undefined) {
    return {
      quietMs: OBSERVE_QUIET_DEFAULT_MS,
      drainBudgetMs: OBSERVE_DRAIN_DEFAULT_MS,
      maxSnapshotReloads: OBSERVE_RELOAD_DEFAULT_MAX,
    };
  }
  if (!isPlainObject(input)) {
    throw new HostProtocolError('invalid_input', 'events.subscribe', '观察预算覆盖未通过校验', {
      details: { reason: 'invalid_observe_budgets', field: 'observe' },
    });
  }
  const raw: Record<string, unknown> = input;
  for (const key of Object.keys(raw)) {
    if (key !== 'quietMs' && key !== 'drainBudgetMs' && key !== 'maxSnapshotReloads') {
      invalid('unknown_option_key', `observe.${key}`);
    }
  }
  const quietMsRaw: unknown = raw.quietMs;
  if (
    quietMsRaw !== undefined &&
    (typeof quietMsRaw !== 'number' ||
      !Number.isSafeInteger(quietMsRaw) ||
      quietMsRaw < 100 ||
      quietMsRaw > 10_000)
  ) {
    invalid('invalid_quiet_ms', 'observe.quietMs');
  }
  const quietMs = (quietMsRaw as number | undefined) ?? OBSERVE_QUIET_DEFAULT_MS;
  const drainBudgetMsRaw: unknown = raw.drainBudgetMs;
  if (
    drainBudgetMsRaw !== undefined &&
    (typeof drainBudgetMsRaw !== 'number' ||
      !Number.isSafeInteger(drainBudgetMsRaw) ||
      drainBudgetMsRaw < quietMs ||
      drainBudgetMsRaw > 120_000)
  ) {
    invalid('invalid_drain_budget_ms', 'observe.drainBudgetMs');
  }
  const drainBudgetMs = (drainBudgetMsRaw as number | undefined) ?? OBSERVE_DRAIN_DEFAULT_MS;
  const maxSnapshotReloadsRaw: unknown = raw.maxSnapshotReloads;
  if (
    maxSnapshotReloadsRaw !== undefined &&
    (typeof maxSnapshotReloadsRaw !== 'number' ||
      !Number.isSafeInteger(maxSnapshotReloadsRaw) ||
      maxSnapshotReloadsRaw < 1 ||
      maxSnapshotReloadsRaw > 10)
  ) {
    invalid('invalid_max_snapshot_reloads', 'observe.maxSnapshotReloads');
  }
  const maxSnapshotReloads =
    (maxSnapshotReloadsRaw as number | undefined) ?? OBSERVE_RELOAD_DEFAULT_MAX;
  if (drainBudgetMs < quietMs) {
    invalid('invalid_drain_budget_ms', 'observe.drainBudgetMs');
  }
  return { quietMs, drainBudgetMs, maxSnapshotReloads };
}

type EventsScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

function eventsScope(command: ParsedEventsObserve): EventsScope {
  if (command.scope === 'global') {
    return { kind: 'global' };
  }
  return { kind: 'project', projectId: command.projectId as string };
}

/** HostClient 运行时校验后的快照/事件线类型（CLI 不复核持久语义）。 */
type ObservedSnapshot = Awaited<ReturnType<HostClient['getSnapshot']>>;
type ObservedEvent = Parameters<SubscribeEventsInput['onEvent']>[0];

function snapshotHumanLine(snapshot: ObservedSnapshot): string {
  return (
    `shiploop events: snapshot scope=${scopeText(snapshot.scope)} ` +
    `watermark=${snapshot.watermark.sequence} readAt=${snapshot.readAt}\n`
  );
}

function eventHumanLine(event: ObservedEvent): string {
  return `shiploop events: event seq=${event.sequence} type=${event.type} id=${event.eventId}\n`;
}

/**
 * 观察记录输出：JSON 模式为 NDJSON 成功记录（{ok:true,command,result:{kind,...}}）；
 * 人类模式输出人类行（notice 类走 stderr，保持 stdout 是干净记录流）。
 */
function emitObserveRecord(
  io: AppCliIo,
  command: ParsedEventsObserve,
  kind: string,
  body: Record<string, unknown>,
  human: string,
  humanToStderr = false,
): void {
  if (command.json) {
    io.stdout(
      `${JSON.stringify(buildAppCliSuccessEnvelope(command.commandId, { kind, ...body }))}\n`,
    );
    return;
  }
  if (humanToStderr) {
    io.stderr(human);
    return;
  }
  io.stdout(human);
}

/**
 * Abort（Ctrl+C/用户中断）形态错误：HostClient 对带信号操作以
 * `unreachable(aborted)` 拒绝（app-client `abortedError`）。
 * 观察被用户中断不是连接失败：不得误报为 unreachable（exit 3）。
 */
function isAbortShapedError(error: unknown): boolean {
  return (
    (isHostProtocolError(error, 'unreachable') &&
      (error.details as Record<string, unknown> | undefined)?.reason === 'aborted') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function executeEventsCommand(
  io: AppCliIo,
  command: ParsedEventsObserve,
  client: HostClient,
  signal: AbortSignal | undefined,
  budgets: ResolvedEventsObserveBudgets,
): Promise<AppCliRunResult> {
  const scope = eventsScope(command);
  let eventsObserved = 0;
  let lastEventId: string | undefined;
  /** 连续 snapshot_required 重载计数；每次成功交付事件后复位。 */
  let reloads = 0;
  let armQuiet: (() => void) | undefined;

  const onEvent = (event: ObservedEvent): void => {
    eventsObserved += 1;
    reloads = 0;
    lastEventId = event.eventId;
    emitObserveRecord(io, command, 'event', { event }, eventHumanLine(event));
    armQuiet?.();
  };

  // 异步信号读取（封装为函数调用，避免 TS 将 await 后的信号状态误判为编译期常量）。
  const userAborted = (): boolean => signal?.aborted === true;

  const takeSnapshot = async (): Promise<ObservedSnapshot> => {
    const snapshot = await client.getSnapshot(scope);
    emitObserveRecord(io, command, 'snapshot', { snapshot }, snapshotHumanLine(snapshot));
    return snapshot;
  };

  let cursor: string;
  if (command.snapshotOnly || command.cursor === undefined) {
    const snapshot = await takeSnapshot();
    cursor = command.cursor ?? snapshot.watermark.cursor;
  } else {
    cursor = command.cursor;
  }

  /** 终态记录的「最后游标」细节：当前续读游标 + 最后投递事件 ID（若有）。 */
  const resumeDetails = (): Record<string, unknown> => ({
    cursor,
    ...(lastEventId !== undefined ? { lastEventId } : {}),
  });

  const interruptedResult = (): AppCliRunResult =>
    emitFailure(io, command.json, {
      exitCode: CLI_EXIT_OBSERVATION_INTERRUPTED,
      command: command.commandId,
      code: 'observation_interrupted',
      message: '观察已中断：仅结束本次观察，Host 未停止、已提交命令不受影响',
      details: resumeDetails(),
    });

  /**
   * snapshot_required 恢复分支（§9.4/§12.1）：明确输出记录并重取快照，以新水位
   * 游标续读；连续重载（无事件交付间隔）超过有限预算即终止，不无限循环。
   */
  const reloadFromSnapshot = async (
    snapshotRoute: string,
  ): Promise<'reload' | AppCliRunResult> => {
    reloads += 1;
    if (reloads > budgets.maxSnapshotReloads) {
      return emitFailure(io, command.json, {
        exitCode: exitCodeForAppErrorCode('snapshot_required'),
        command: command.commandId,
        code: 'snapshot_required',
        message: '游标低于可续读下界，重取快照后仍无法续读（重载预算耗尽）',
        details: { ...resumeDetails(), snapshotRoute },
      });
    }
    emitObserveRecord(
      io,
      command,
      'snapshot_required',
      { snapshotRoute },
      'shiploop: snapshot_required: 游标过期或低于可续读下界，重取快照恢复（不丢历史事件）\n',
      true,
    );
    const snapshot = await takeSnapshot();
    cursor = snapshot.watermark.cursor;
    return 'reload';
  };

  for (;;) {
    if (userAborted()) {
      return interruptedResult();
    }
    let subscription: HostEventSubscription;
    try {
      subscription = await client.subscribeEvents({
        scope,
        cursor,
        onEvent,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      // 建连前 409 snapshot_required（§9.4）：同一恢复分支。
      if (isHostProtocolError(error, 'snapshot_required')) {
        const details = error.details as Record<string, unknown> | undefined;
        const route =
          typeof details?.snapshotRoute === 'string' ? details.snapshotRoute : SNAPSHOT_ROUTE;
        const reload = await reloadFromSnapshot(route);
        if (reload !== 'reload') {
          return reload;
        }
        continue;
      }
      // Ctrl+C/Abort（含建连窗口）：只结束本次观察（§12.3 第五档 exit 4 +
      // observation_interrupted），不得误报为连接失败（unreachable exit 3）。
      if (userAborted() || isAbortShapedError(error)) {
        return interruptedResult();
      }
      throw error;
    }

    // snapshot-only：补读一页后退出——静默窗口（无新事件达 quietMs）或补读总预算
    // 耗尽即自行关闭订阅（自关闭不视为中断）；事件到达重置静默窗口。
    let selfClosed: boolean = false;
    let quietTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    if (command.snapshotOnly) {
      const closeSelf = (): void => {
        selfClosed = true;
        subscription.close();
      };
      armQuiet = () => {
        if (quietTimer !== undefined) {
          clearTimeout(quietTimer);
        }
        quietTimer = setTimeout(closeSelf, budgets.quietMs);
      };
      armQuiet();
      drainTimer = setTimeout(closeSelf, budgets.drainBudgetMs);
    }

    const end = await subscription.ended;

    // 结束即清理全部本地定时器/句柄（订阅本身由 HostClient 幂等收尾）。
    if (quietTimer !== undefined) {
      clearTimeout(quietTimer);
    }
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
    }
    armQuiet = undefined;
    lastEventId = subscription.lastEventId() ?? lastEventId;

    if (end.kind === 'aborted') {
      if (command.snapshotOnly && selfClosed && !userAborted()) {
        // 补读完成：观察到事件时重取受影响实体（快照），投影与 Core 当前状态一致。
        if (eventsObserved > 0) {
          await takeSnapshot();
        }
        emitObserveRecord(
          io,
          command,
          'observation_end',
          { reason: 'snapshot_only', eventsObserved },
          `shiploop events: 补读完成（snapshot-only），共 ${eventsObserved} 条事件\n`,
        );
        return { exitCode: CLI_EXIT_OK, kind: 'success', command: command.commandId };
      }
      // Ctrl+C/Abort/观察超时：只结束本次观察（§12.3 第五档），Host 未停止。
      return interruptedResult();
    }
    if (end.kind === 'stream_overflow') {
      // §9.4 背压终止：明确记录 snapshotRoute 与最后游标，不默默续读。
      return emitFailure(io, command.json, {
        exitCode: CLI_EXIT_OBSERVATION_INTERRUPTED,
        command: command.commandId,
        code: 'stream_overflow',
        message: '观察流超出缓冲上限结束：重取快照后可继续续读（持久审计未丢失）',
        details: { ...resumeDetails(), snapshotRoute: end.snapshotRoute },
      });
    }
    if (end.kind === 'snapshot_required') {
      const reload = await reloadFromSnapshot(end.snapshotRoute);
      if (reload !== 'reload') {
        return reload;
      }
      continue;
    }
    // protocol_error：重连预算耗尽按连接失败归类，其余按响应畸形归类（exit 3）。
    const code = end.reason === 'reconnect_budget_exhausted' ? 'unreachable' : 'response_malformed';
    return emitFailure(io, command.json, {
      exitCode: exitCodeForAppErrorCode(code),
      command: command.commandId,
      code,
      message: '事件流因连接/协议问题结束（Host 与已提交命令状态未变）',
      details: { ...resumeDetails(), reason: end.reason },
    });
  }
}

/* ------------------------------------------------------------------ *
 * 基线命令（F-016；契约 §6/§7/§8/§12.1/§12.2/§12.3）
 *
 * 接线纪律：
 * - preview 先行（只读）：展示本次实际范围（无 HEAD/脏工作区原样）并取得
 *   previewDigest，run 的授权绑定该完整输入摘要（argv/cwd/环境/timeout/政策/
 *   代码身份任一实质变化即失效 → preview_stale/conflict）；
 * - 决策只由 --confirm/--decline 显式给出（解析层冻结互斥必居其一）；decline
 *   持久记录 not_run（显式展示，不折算成功）；authorize → accepted + 真实
 *   operationId（同事务持久操作行）；
 * - --wait 有界轮询终态；--follow 经 SSE 观察 baseline.* 事件（记录流）并
 *   等待终态；Ctrl+C/观察预算耗尽只结束本次观察（退出码 4，
 *   observation_interrupted），操作未被取消、Host 未停止；取消必须显式
 *   `baseline cancel`（回执状态驱动展示，绝不提前声称进程已停）；
 * - 显式 --command-id 先查回执并以原 issuedAt 重建同一信封：相同参数重放
 *   原回执（沿用原操作），不同参数 conflict。
 * ------------------------------------------------------------------ */

/** 基线等待/跟随观察预算覆盖（受信装配/测试注入；绝非 argv/env；全部有界）。 */
export interface BaselineObserveBudgets {
  /** 轮询终态间隔（默认 250ms；允许 50..5 000）。 */
  readonly pollIntervalMs?: number;
  /** 观察总预算（缺省 = Σ检查 timeoutMs + 30 000ms 收尾余量，契约 §13；允许 100..86 400 000）。 */
  readonly totalBudgetMs?: number;
}

const BASELINE_POLL_DEFAULT_MS = 250;
const BASELINE_WAIT_GRACE_MS = 30_000;
const BASELINE_TOTAL_BUDGET_MAX_MS = 86_400_000;

interface ResolvedBaselineObserveBudgets {
  readonly pollIntervalMs: number;
  readonly totalBudgetMs: number | undefined;
}

/** 校验观察预算覆盖（全部有界；非法注入以 invalid_input 拒绝，零 I/O）。 */
function resolveBaselineObserveBudgets(
  input: BaselineObserveBudgets | undefined,
): ResolvedBaselineObserveBudgets {
  const invalid = (reason: string, field: string): never => {
    throw new HostProtocolError('invalid_input', 'commands.submit', '基线观察预算覆盖未通过校验', {
      details: { reason, field },
    });
  };
  if (input === undefined) {
    return { pollIntervalMs: BASELINE_POLL_DEFAULT_MS, totalBudgetMs: undefined };
  }
  if (!isPlainObject(input)) {
    invalid('invalid_baseline_observe_budgets', 'baselineObserve');
  }
  const raw: Record<string, unknown> = { ...input };
  for (const key of Object.keys(raw)) {
    if (key !== 'pollIntervalMs' && key !== 'totalBudgetMs') {
      invalid('unknown_option_key', `baselineObserve.${key}`);
    }
  }
  const pollRaw: unknown = raw.pollIntervalMs;
  if (
    pollRaw !== undefined &&
    (typeof pollRaw !== 'number' || !Number.isSafeInteger(pollRaw) || pollRaw < 50 || pollRaw > 5_000)
  ) {
    invalid('invalid_poll_interval_ms', 'baselineObserve.pollIntervalMs');
  }
  const totalRaw: unknown = raw.totalBudgetMs;
  if (
    totalRaw !== undefined &&
    (typeof totalRaw !== 'number' ||
      !Number.isSafeInteger(totalRaw) ||
      totalRaw < 100 ||
      totalRaw > BASELINE_TOTAL_BUDGET_MAX_MS)
  ) {
    invalid('invalid_total_budget_ms', 'baselineObserve.totalBudgetMs');
  }
  return {
    pollIntervalMs: (pollRaw as number | undefined) ?? BASELINE_POLL_DEFAULT_MS,
    totalBudgetMs: totalRaw as number | undefined,
  };
}

/** 检查计划视图 → 线形状（字段一一对应；省略字段不产生 undefined 键）。 */
function baselineWirePlan(plan: BaselineCheckPlanView): Record<string, unknown> {
  return {
    checks: plan.checks.map((check) => ({
      checkKey: check.checkKey,
      kind: check.kind,
      argv: [...check.argv],
      timeoutMs: check.timeoutMs,
      required: check.required,
      ...(check.cwdRef !== undefined ? { cwdRef: check.cwdRef } : {}),
      ...(check.environmentRef !== undefined ? { environmentRef: check.environmentRef } : {}),
    })),
  };
}

/** 观察总预算（契约 §13：≤ 检查数 × 单检查 timeout + 30s 收尾余量）。 */
function baselineWaitBudgetMs(
  plan: BaselineCheckPlanView,
  budgets: ResolvedBaselineObserveBudgets | undefined,
): number {
  if (budgets?.totalBudgetMs !== undefined) {
    return budgets.totalBudgetMs;
  }
  const checksBudget = plan.checks.reduce((sum, check) => sum + check.timeoutMs, 0);
  return Math.min(
    checksBudget + BASELINE_WAIT_GRACE_MS,
    BASELINE_INPUT_TIMEOUT_MAX_MS * plan.checks.length + BASELINE_WAIT_GRACE_MS,
  );
}

/** 终态判定（accepted/running/cancelling 为在途；其余为终态）。 */
function isTerminalBaselineStatus(status: BaselineOperationStatusView): boolean {
  return (
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'not_run'
  );
}

/** run/cancel 回执 result 的窄视图（HostClient 已做线形状校验）。 */
interface BaselineCommandResultWire {
  readonly operationId: string;
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
}

type BaselineDetailResult = Awaited<ReturnType<HostClient['getBaseline']>>;
type BaselineAcceptedReceipt = Extract<CommandReceipt, { status: 'accepted' }>;

/**
 * 基线结果输出：--json 信封/记录到 stdout，提示到 stderr；人类文本到 stdout。
 * exitCode 非 0 时（如 --wait 非全 passed）仍输出成功信封（结果内含状态轴）。
 */
function emitBaselineStreams(
  io: AppCliIo,
  command: ParsedBaselineCommand,
  result: unknown,
  humanText: string,
  notices: readonly string[],
  exitCode: CliExitCode,
): AppCliRunResult {
  const streams = composeAppCliStreams({
    json: command.json,
    command: command.commandId,
    result,
    humanText,
    notices,
  });
  io.stdout(streams.stdout);
  io.stderr(streams.stderr);
  return {
    exitCode,
    kind: exitCode === CLI_EXIT_OK ? 'success' : 'failure',
    command: command.commandId,
    ...(command.json ? { envelope: buildAppCliSuccessEnvelope(command.commandId, result) } : {}),
  };
}

/** 业务拒绝回执 → §12.3 失败输出（保留 commandId 供查回执）。 */
function baselineReceiptFailure(
  io: AppCliIo,
  command: ParsedBaselineCommand,
  receipt: Extract<CommandReceipt, { status: 'rejected' }>,
): AppCliRunResult {
  return emitFailure(io, command.json, {
    exitCode: exitCodeForReceiptStatus('rejected'),
    command: command.commandId,
    code: receipt.error.code,
    message: receipt.error.message,
    commandId: receipt.commandId,
    ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
  });
}

function baselineAuthorizationViewOf(
  authorization: NonNullable<BaselineDetailResult['authorization']>,
): BaselineAuthorizationView {
  return {
    projectId: authorization.projectId,
    repositoryBindingId: authorization.repositoryBindingId,
    ...(authorization.repositoryBindingRevision === undefined ? {} : { repositoryBindingRevision: authorization.repositoryBindingRevision }),
    codeIdentity: authorization.codeIdentity,
    ...(authorization.dirtyScope === undefined ? {} : { dirtyScope: authorization.dirtyScope }),
    ...(authorization.environmentIdentity === undefined ? {} : { environmentIdentity: authorization.environmentIdentity }),
    ...(authorization.missingFields === undefined ? {} : { missingFields: authorization.missingFields }),
    policyRevision: authorization.policyRevision,
    planDigest: authorization.planDigest,
    plan: {
      checks: authorization.plan.checks.map(check => ({
        checkKey: check.checkKey,
        kind: check.kind,
        argv: [...check.argv],
        ...(check.cwdRef === null || check.cwdRef === undefined ? {} : { cwdRef: check.cwdRef }),
        ...(check.environmentRef === null || check.environmentRef === undefined ? {} : { environmentRef: check.environmentRef }),
        timeoutMs: check.timeoutMs,
        required: check.required,
      })),
    },
  };
}

function operationResultOf(detail: BaselineDetailResult): BaselineOperationResultView {
  return buildBaselineOperationResult(
    detail.operation,
    detail.checks,
    detail.authorization === null ? null : detail.authorization.codeIdentity,
    detail.authorization === null ? null : baselineAuthorizationViewOf(detail.authorization),
  );
}

async function executeBaselinePreview(
  io: AppCliIo,
  command: ParsedBaselinePreview,
  client: HostClient,
  plan: BaselineCheckPlanView,
): Promise<AppCliRunResult> {
  const receipt = await client.previewBaseline({
    projectId: command.projectId,
    plan: baselineWirePlan(plan),
  });
  if (receipt.status === 'rejected') {
    return baselineReceiptFailure(io, command, receipt);
  }
  if (receipt.status !== 'completed') {
    throw new Error('unexpected_accepted_receipt');
  }
  const preview = buildBaselinePreviewResult(
    command.projectId,
    receipt.result as BaselinePreviewWireView,
  );
  return emitBaselineStreams(
    io,
    command,
    preview,
    formatBaselinePreview(preview),
    [],
    CLI_EXIT_OK,
  );
}

async function executeBaselineRun(
  io: AppCliIo,
  command: ParsedBaselineRun,
  client: HostClient,
  plan: BaselineCheckPlanView,
  budgets: ResolvedBaselineObserveBudgets | undefined,
  signal: AbortSignal | undefined,
): Promise<AppCliRunResult> {
  const planValue = baselineWirePlan(plan);
  // 1) 预览（只读）：展示本次实际范围并取得 previewDigest（授权绑定完整输入摘要）。
  const previewReceipt = await client.previewBaseline({
    projectId: command.projectId,
    plan: planValue,
  });
  if (previewReceipt.status === 'rejected') {
    return baselineReceiptFailure(io, command, previewReceipt);
  }
  if (previewReceipt.status !== 'completed') {
    throw new Error('unexpected_accepted_receipt');
  }
  const preview = buildBaselinePreviewResult(
    command.projectId,
    previewReceipt.result as BaselinePreviewWireView,
  );
  const previewText = formatBaselinePreview(preview);
  const notice = buildBaselineRunConfirmationNotice();

  // 2) 显式决策提交（--confirm/--decline 由解析层冻结互斥必居其一）。
  const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
  const receipt = await client.runBaseline({
    projectId: command.projectId,
    decision: command.decision,
    plan: planValue,
    previewDigest: preview.previewDigest,
    ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
  }, issuedAt !== undefined ? { issuedAt } : undefined);
  if (receipt.status === 'rejected') {
    return baselineReceiptFailure(io, command, receipt);
  }
  if (receipt.status === 'completed') {
    // decline → 持久 not_run（显式展示，不折算成功；退出码 0）。
    const result = buildBaselineCommandResult(receipt.result as BaselineCommandResultWire);
    return emitBaselineStreams(
      io,
      command,
      result,
      `${previewText}${formatBaselineCommandResult(result)}`,
      [notice],
      baselineCliExitCode({ command: 'run', decision: command.decision, state: result.state }),
    );
  }

  // accepted：真实 operationId（同事务持久操作行；默认返回后退出）。
  const accepted = buildBaselineCommandResult({
    operationId: (receipt as BaselineAcceptedReceipt).operationId,
    status: 'accepted',
  });
  if (!command.wait && !command.follow) {
    return emitBaselineStreams(
      io,
      command,
      accepted,
      `${previewText}${formatBaselineCommandResult(accepted)}`,
      [notice],
      baselineCliExitCode({ command: 'run', decision: command.decision, state: accepted.state }),
    );
  }

  // 3) 有界观察（--wait 轮询终态；--follow 另经 SSE 观察 baseline.* 事件记录流）。
  return observeBaselineOperation(
    io,
    command,
    client,
    plan,
    { previewText, notice, accepted },
    budgets,
    signal,
  );
}

async function observeBaselineOperation(
  io: AppCliIo,
  command: ParsedBaselineRun,
  client: HostClient,
  plan: BaselineCheckPlanView,
  head: {
    readonly previewText: string;
    readonly notice: string;
    readonly accepted: ReturnType<typeof buildBaselineCommandResult>;
  },
  budgets: ResolvedBaselineObserveBudgets | undefined,
  signal: AbortSignal | undefined,
): Promise<AppCliRunResult> {
  const operationId = head.accepted.operationId;
  const pollIntervalMs = budgets?.pollIntervalMs ?? BASELINE_POLL_DEFAULT_MS;
  const deadline = Date.now() + baselineWaitBudgetMs(plan, budgets);
  const userAborted = (): boolean => signal?.aborted === true;
  let lastEventId: string | undefined;

  /** 观察中断（第五档退出码 4）：只结束本次观察，操作未被取消、Host 未停止。 */
  const interrupted = (reason: string): AppCliRunResult =>
    emitFailure(io, command.json, {
      exitCode: CLI_EXIT_OBSERVATION_INTERRUPTED,
      command: command.commandId,
      code: 'observation_interrupted',
      message:
        '观察已中断：仅结束本次观察，操作仍可能运行（未取消）；' +
        '可用 `shiploop baseline status <operationId>` 查询，或 `shiploop baseline cancel <operationId> --confirm` 显式取消。',
      details: {
        operationId,
        reason,
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      },
    });

  if (command.follow) {
    if (command.json) {
      io.stdout(
        `${JSON.stringify(
          buildAppCliSuccessEnvelope(command.commandId, {
            kind: 'accepted',
            operation: head.accepted,
          }),
        )}\n`,
      );
    } else {
      io.stdout(`${head.previewText}${formatBaselineCommandResult(head.accepted)}`);
    }
  }

  let subscription: HostEventSubscription | undefined;
  if (command.follow && !userAborted()) {
    try {
      const snapshot = await client.getSnapshot({ kind: 'project', projectId: command.projectId });
      subscription = await client.subscribeEvents({
        scope: { kind: 'project', projectId: command.projectId },
        cursor: snapshot.watermark.cursor,
        onEvent: (event) => {
          if (!event.type.startsWith('baseline.')) {
            return;
          }
          const target = (event.payload as { operationId?: unknown }).operationId;
          if (target !== operationId) {
            return;
          }
          lastEventId = event.eventId;
          if (command.json) {
            io.stdout(
              `${JSON.stringify(
                buildAppCliSuccessEnvelope(command.commandId, { kind: 'event', event }),
              )}\n`,
            );
          } else {
            io.stdout(`shiploop baseline run: event type=${event.type} seq=${event.sequence}\n`);
          }
        },
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      subscription = undefined;
      if (userAborted()) {
        return interrupted('aborted');
      }
      if (!isHostProtocolError(error)) {
        throw error;
      }
      // 事件观察建连失败不阻断等待：退回纯轮询（仍为有界观察）。
    }
  }

  try {
    for (;;) {
      if (userAborted()) {
        return interrupted('aborted');
      }
      let detail: BaselineDetailResult;
      try {
        detail = await client.getBaseline(operationId);
      } catch (error) {
        if (userAborted()) {
          return interrupted('aborted');
        }
        throw error;
      }
      if (isTerminalBaselineStatus(detail.operation.status)) {
        const result = operationResultOf(detail);
        const exitCode = baselineCliExitCode({
          command: 'run',
          decision: command.decision,
          state: result.state,
          waited: true,
        });
        if (command.follow) {
          if (command.json) {
            io.stdout(
              `${JSON.stringify(
                buildAppCliSuccessEnvelope(command.commandId, { kind: 'operation', operation: result }),
              )}\n`,
            );
          } else {
            io.stdout(formatBaselineOperationResult(result));
          }
          return {
            exitCode,
            kind: exitCode === CLI_EXIT_OK ? 'success' : 'failure',
            command: command.commandId,
          };
        }
        return emitBaselineStreams(
          io,
          command,
          result,
          `${head.previewText}${formatBaselineOperationResult(result)}`,
          [head.notice],
          exitCode,
        );
      }
      if (Date.now() + pollIntervalMs > deadline) {
        return interrupted('observation_budget_exhausted');
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs));
    }
  } finally {
    subscription?.close();
  }
}

async function executeBaselineCancel(
  io: AppCliIo,
  command: ParsedBaselineCancel,
  client: HostClient,
): Promise<AppCliRunResult> {
  // 取消是唯一停止途径且必须显式：项目 scope 经 baselines.get 的授权摘要解析
  //（不直接操作数据库/制品路径）。
  const detail = await client.getBaseline(command.operationId);
  const projectId = detail.authorization?.projectId;
  if (projectId === undefined) {
    // 拒绝授权记录（无授权行、从未启动进程）：无项目 scope 可提交取消命令；
    // 终态幂等回答来自 baselines.get，绝不声称有任何进程被停止。
    if (!isTerminalBaselineStatus(detail.operation.status)) {
      return emitFailure(io, command.json, {
        exitCode: 1,
        command: command.commandId,
        code: 'unsupported',
        message: '该操作缺少授权行且仍在途，无法确定取消所属项目（请以 baseline status 查询）',
        details: { reason: 'authorization_missing', operationId: command.operationId },
      });
    }
    const current = buildBaselineCommandResult({
      operationId: detail.operation.operationId,
      status: detail.operation.status,
      ...(detail.operation.reasonCode !== undefined ? { reasonCode: detail.operation.reasonCode } : {}),
    });
    return emitBaselineStreams(
      io,
      command,
      current,
      `${formatBaselineCommandResult(current)}（该操作从未启动进程；终态来自 baselines.get，未提交取消命令）`,
      [],
      baselineCliExitCode({ command: 'cancel', state: current.state }),
    );
  }
  const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
  const receipt = await client.cancelBaseline(projectId, command.operationId, {
    ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  });
  if (receipt.status === 'rejected') {
    return baselineReceiptFailure(io, command, receipt);
  }
  if (receipt.status !== 'completed') {
    throw new Error('unexpected_accepted_receipt');
  }
  // 回执状态驱动展示：cancelling 保持「活动」，绝不提前声称进程已停。
  const result = buildBaselineCommandResult(receipt.result as BaselineCommandResultWire);
  return emitBaselineStreams(
    io,
    command,
    result,
    formatBaselineCommandResult(result),
    [],
    baselineCliExitCode({ command: 'cancel', state: result.state }),
  );
}

async function executeBaselineCommand(
  io: AppCliIo,
  command: ParsedBaselineCommand,
  client: HostClient,
  plan: BaselineCheckPlanView | undefined,
  budgets: ResolvedBaselineObserveBudgets | undefined,
  signal: AbortSignal | undefined,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'baseline.preview':
    case 'baseline.run': {
      if (plan === undefined) {
        return emitFailure(io, command.json, {
          exitCode: 2,
          command: command.commandId,
          code: 'invalid_input',
          message: '缺少已校验的检查计划输入',
        });
      }
      if (command.commandId === 'baseline.preview') {
        return executeBaselinePreview(io, command, client, plan);
      }
      return executeBaselineRun(io, command, client, plan, budgets, signal);
    }
    case 'baseline.list': {
      const page = await client.listBaselines(command.projectId, {
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const result = buildBaselineListResult({
        projectId: page.projectId,
        records: page.records,
        nextCursor: page.nextCursor,
        limit: page.limit,
      });
      return emitBaselineStreams(
        io,
        command,
        result,
        formatBaselineListResult(result),
        [],
        CLI_EXIT_OK,
      );
    }
    case 'baseline.status': {
      const detail = await client.getBaseline(command.operationId);
      const result = operationResultOf(detail);
      return emitBaselineStreams(
        io,
        command,
        result,
        formatBaselineOperationResult(result),
        [],
        CLI_EXIT_OK,
      );
    }
    case 'baseline.compare': {
      const result = await client.compareBaselines(command.previousOperationId, command.currentOperationId);
      return emitBaselineStreams(
        io,
        command,
        result,
        formatBaselineComparison(result),
        [],
        CLI_EXIT_OK,
      );
    }
    case 'baseline.cancel':
      return executeBaselineCancel(io, command, client);
    case 'baseline.evidence': {
      const content = await client.readArtifactContent(command.artifactId);
      const result = buildBaselineEvidenceResult(content.artifactId, content.content);
      return emitBaselineStreams(
        io,
        command,
        result,
        formatBaselineEvidenceResult(result),
        [],
        CLI_EXIT_OK,
      );
    }
  }
}

async function executeKnowledgeCommand(
  io: AppCliIo,
  command: ParsedKnowledgeCommand,
  client: HostClient,
): Promise<AppCliRunResult> {
  if (command.commandId === 'knowledge.read') {
    const result = await client.readKnowledge(command.projectId, {
      documentId: command.documentId,
      ...(command.version !== undefined ? { version: command.version } : {}),
      ...(command.maxReadBytes !== undefined ? { maxReadBytes: command.maxReadBytes } : {}),
    });
    return emitSuccess(io, command, result, formatKnowledgeReadText(result));
  }

  const result = await client.searchKnowledge(command.projectId, {
    ...(command.documentId !== undefined ? { documentId: command.documentId } : {}),
    ...(command.version !== undefined ? { version: command.version } : {}),
    ...(command.keyword !== undefined ? { keyword: command.keyword } : {}),
    ...(command.title !== undefined ? { title: command.title } : {}),
    ...(command.path !== undefined ? { path: command.path } : {}),
    ...(command.limit !== undefined ? { limit: command.limit } : {}),
    ...(command.snippetMaxChars !== undefined ? { snippetMaxChars: command.snippetMaxChars } : {}),
    ...(command.maxReadBytes !== undefined ? { maxReadBytes: command.maxReadBytes } : {}),
    ...(command.maxCandidates !== undefined ? { maxCandidates: command.maxCandidates } : {}),
  });
  const diagnostic = result.diagnostics[0];
  if (diagnostic !== undefined) {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: diagnostic.code,
      message: diagnostic.reason,
      details: { query: result.query, budget: result.budget, diagnostics: result.diagnostics },
    });
  }
  if (result.results.length === 0) {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'no_results',
      message: '知识查询没有结果',
      details: { query: result.query, budget: result.budget, diagnostics: result.diagnostics },
    });
  }
  return emitSuccess(io, command, result, formatKnowledgeSearchText(result));
}

/* ------------------------------------------------------------------ *
 * 回执读取（F-016）
 * ------------------------------------------------------------------ */

async function executeReceiptCommand(
  io: AppCliIo,
  command: ParsedReceiptGet,
  client: HostClient,
): Promise<AppCliRunResult> {
  const receipt = await client.getReceipt(command.targetCommandId);
  if (receipt.status === 'rejected') {
    // 回执固化的是原命令的业务拒绝；按 §12.3 退出码 1 展示，不重发副作用。
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  return emitSuccess(io, command, receipt, receiptHumanLine(receipt));
}

/**
 * 执行一条应用命令 CLI 意图。解析（纯）→ 平台门禁 → 配置输入文件读取 →
 * 连接/启动 Host → 命令编排 → §12.3 信封/退出码。返回退出码与（JSON 模式）
 * 信封；调用方（bin.ts）据此退出。
 *
 * F-015 接线 project.* ，F-016 接线 config.* 与 receipt.get，F-017 接线 events
 * 观察（快照 + SSE 跟随、snapshot_required 重载、观察中断退出码 4）。
 */
export async function runAppCli(options: RunAppCliOptions): Promise<AppCliRunResult> {
  if (
    options === null ||
    typeof options !== 'object' ||
    options.io === null ||
    typeof options.io !== 'object'
  ) {
    // 入口装配错误：无可用 io 时无法走正常输出；直接抛出，由 bin.ts 兜底。
    throw new HostProtocolError('internal', 'commands.submit', 'CLI 执行选项未通过校验');
  }
  const io = options.io;
  const jsonFlag = Array.isArray(options.args) && options.args.includes('--json');

  let parsed;
  try {
    parsed = parseAppCliArgs(options.args, options.env ?? {}, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  } catch (error) {
    if (error instanceof AppCliParseError) {
      return emitParseFailure(io, error, jsonFlag);
    }
    return emitFailure(io, jsonFlag, {
      exitCode: 2,
      command: null,
      code: 'invalid_input',
      message: '参数解析失败',
    });
  }

  if (parsed.kind === 'help') {
    io.stdout(getAppCliHelp(parsed.scope));
    return { exitCode: CLI_EXIT_OK, kind: 'help', command: null };
  }

  const command: ParsedAppCliCommand = parsed;
  const platform = options.platform ?? process.platform;
  if (platform !== SUPPORTED_PLATFORM) {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'unsupported_platform',
      message: '当前平台不受支持（首版仅正式支持 macOS）',
      details: { reason: 'platform_not_darwin' },
    });
  }

  // P02-3 / F-006：确认注册（--confirm）最终经既有 project.register 命令提交，
  // 该命令要求 displayName（唯一注册通道，不发明默认名）；缺 --name 属输入
  // 错误（退出码 2），在发现 Host/联网之前拒绝，与解析失败同一纪律。
  if (command.commandId === 'project.init' && command.confirm && command.displayName === undefined) {
    return emitFailure(io, command.json, {
      exitCode: 2,
      command: command.commandId,
      code: 'invalid_input',
      message: '确认注册必须提供 --name（project.register 要求 displayName）',
      details: { reason: 'name_required_for_registration', field: 'displayName' },
    });
  }

  // P07-3 / F-014：隔离恢复维护入口完全离线（持有目标数据根 writer 锁的独立
  // 入口）——在任何 Host 发现/启动之前分派，绝不经 HTTP 替换运行中 Host 数据库。
  if (command.command === 'restore') {
    return await executeRestoreCommand(io, command);
  }

  // F-015/F-016/F-017 范围：project.*、config.*、receipt.get、baseline.* 与 events
  // 观察全部经 HostClient 接线；未知顶层命令已在纯解析层拒绝，不会到达这里。
  // events 观察预算覆盖（受信装配/测试注入）在连接 Host 之前校验：非法注入
  // 以 invalid_input（退出码 2）拒绝，零发现/零网络副作用。
  let observeBudgets: ResolvedEventsObserveBudgets | undefined;
  if (command.command === 'events') {
    try {
      observeBudgets = resolveObserveBudgets(options.observe);
    } catch (error) {
      if (isHostProtocolError(error)) {
        return emitFailure(io, command.json, protocolFailure(command.commandId, error));
      }
      throw error;
    }
  }

  // 配置输入文件在连接 Host 之前读取/解析：缺失/畸形 JSON 以退出码 2 拒绝，
  // 不发现 Host、不联网、不启动进程（与纯解析失败同一纪律）。
  let configPayload: Record<string, unknown> | undefined;
  if (command.commandId === 'config.create' || command.commandId === 'config.update') {
    try {
      configPayload = readConfigInputPayload(command);
      // P03-7 / F-014：检查定义/模块策略确认的参数守护——policies 段拒绝客户端
      // 伪造主体与明文凭据字段（不进入请求体；服务端 Schema 仍是唯一权威）。
      if (configPayload.policies !== undefined) {
        scanConfigPolicyInputFields(configPayload.policies, {
          command: command.command,
          commandId: command.commandId,
          json: command.json,
        });
      }
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '输入文件读取失败',
      });
    }
  }

  // F-016：baseline.* 与 HostClient 接线（preview/run/list/status/cancel/evidence）。
  // 输入计划先于任何 I/O 校验（畸形 JSON/Schema 以退出码 2 拒绝，不发现 Host、
  // 不启动进程）；--wait/--follow 的观察预算覆盖同样在连接前校验（全部有界）。
  let baselinePlan: BaselineCheckPlanView | undefined;
  let baselineBudgets: ResolvedBaselineObserveBudgets | undefined;
  if (command.command === 'baseline') {
    if (command.commandId === 'baseline.preview' || command.commandId === 'baseline.run') {
      try {
        baselinePlan = readBaselinePlanInput(command);
      } catch (error) {
        if (error instanceof AppCliParseError) {
          return emitParseFailure(io, error, jsonFlag);
        }
        return emitFailure(io, command.json, {
          exitCode: 2,
          command: command.commandId,
          code: 'invalid_input',
          message: '输入文件读取或校验失败',
        });
      }
    }
    if (command.commandId === 'baseline.run' && (command.wait || command.follow)) {
      try {
        baselineBudgets = resolveBaselineObserveBudgets(options.baselineObserve);
      } catch (error) {
        if (isHostProtocolError(error)) {
          return emitFailure(io, command.json, protocolFailure(command.commandId, error));
        }
        throw error;
      }
    }
  }

  // F-010：计划文件（feature import/revise 的 --input）在连接 Host 之前有界
  // UTF-8 受控读取：超限/非法编码/畸形 JSON 以退出码 2 拒绝，不发现 Host、
  // 不执行文件内容、不把开发机路径写成产品运行依赖。F-008：策略副本与固定
  // 输入清单同一读取纪律，秘密/身份字段在同一阶段拒绝（不进入请求体）。
  let planPayload: Record<string, unknown> | undefined;
  let strategyPayload: Record<string, unknown> | undefined;
  let prepareItems: readonly unknown[] | undefined;
  if (command.commandId === 'feature.import' || command.commandId === 'feature.revise' || command.commandId === 'feature.dependencies') {
    try {
      planPayload = readPlanInputPayload(command);
      if (command.commandId === 'feature.dependencies' &&
          (Object.keys(planPayload).some(key => key !== 'edges') || !Array.isArray(planPayload.edges))) {
        throw new AppCliParseError('invalid_input', 'invalid_input_file', command, 'input');
      }
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '输入文件读取或校验失败',
      });
    }
  }
  if (command.commandId === 'task.strategy' || command.commandId === 'task.strategy-reapply') {
    try {
      strategyPayload = readPlanInputPayload(command);
      if (command.commandId === 'task.strategy') {
        scanStrategyInputFields(strategyPayload, {
          command: command.command,
          commandId: command.commandId,
          json: command.json,
        });
      } else {
        const keys = ['previewDigest', 'globalSettingsRevision', 'projectSettingsRevision', 'selectedTaskIds', 'expectedTaskRevisions'];
        if (Object.keys(strategyPayload).length !== keys.length || keys.some(key => !Object.hasOwn(strategyPayload!, key))) {
          throw new AppCliParseError('invalid_input', 'invalid_input_file', command, 'input');
        }
      }
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '输入文件读取或校验失败',
      });
    }
  }
  const prepareInputFile = command.commandId === 'task.prepare' ? command.inputFile : undefined;
  if (prepareInputFile !== undefined) {
    try {
      const itemsPayload = readPlanInputPayload({
        command: 'task',
        commandId: 'task.prepare',
        json: command.json,
        inputFile: prepareInputFile,
      });
      prepareItems = parsePrepareItemsPayload(itemsPayload, {
        command: command.command,
        commandId: command.commandId,
        json: command.json,
      });
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '输入文件读取或校验失败',
      });
    }
  }

  let planningInput: PlanningStartInputDocument | undefined;
  if (command.commandId === 'planning.start') {
    try {
      const input = readPlanInputPayload(command);
      planningInput = parsePlanningStartInput(input, {
        commandId: command.commandId,
        json: command.json,
      });
    } catch (error) {
      if (error instanceof AppCliParseError) return emitParseFailure(io, error, jsonFlag);
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '规划输入文件读取或校验失败',
      });
    }
  }

  // P03-3 / F-012：执行预算文档（execution preview/start/revise 的 --input）在连接
  // Host 之前读取/校验：缺少预算、非法日期/整数、有效并发大于一、未知键与形态
  // 错误以退出码 2 拒绝（输入错误不发启动请求）。
  let executionBudget: ExecutionBudgetWire | undefined;
  const executionBudgetFile =
    command.commandId === 'execution.preview' || command.commandId === 'execution.revise'
      ? command.inputFile
      : command.commandId === 'execution.start' && command.retryBatchId === undefined
        ? command.inputFile
        : undefined;
  if (executionBudgetFile !== undefined) {
    try {
      executionBudget = parseExecutionBudgetDocument(
        readPlanInputPayload({
          command: 'execution',
          commandId: command.commandId,
          json: command.json,
          inputFile: executionBudgetFile,
        }),
        { command: command.command, commandId: command.commandId, json: command.json },
      );
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '输入文件读取或校验失败',
      });
    }
  }

  // P03-5 / F-012：workspace.discard 的 --preview-file 在连接 Host 之前受控读取
  // 并本地核验预览形状与 Feature 一致性（缺确认已在解析层拒绝；伪造/畸形预览
  // 以退出码 2 拒绝，不发现 Host、不联网）。服务端仍重算 previewDigest 复核。
  let workspaceDiscardPayload: WorkspaceDiscardConfirmPayload | undefined;
  if (command.commandId === 'workspace.discard') {
    try {
      const document = parseWorkspaceDiscardPreviewDocument(
        readPlanInputPayload({
          command: 'workspace',
          commandId: 'workspace.discard',
          json: command.json,
          inputFile: command.previewFile,
        }),
        { command: 'workspace', commandId: 'workspace.discard', json: command.json },
      );
      workspaceDiscardPayload = buildWorkspaceDiscardConfirmPayload(document, command.featureId, {
        command: 'workspace',
        commandId: 'workspace.discard',
        json: command.json,
      });
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '预览文件读取或校验失败',
      });
    }
  }

  let repositoryMovePreview: BrownfieldMovePreview | undefined;
  if (command.commandId === 'project.repository-move-confirm') {
    try {
      const payload = readPlanInputPayload({
        command: command.command,
        commandId: command.commandId,
        json: command.json,
        inputFile: command.previewFile,
      });
      repositoryMovePreview = parseRepositoryMovePreviewDocument(payload, {
        command: command.command,
        commandId: command.commandId,
        json: command.json,
      }, command.projectId);
      let targetCanonicalPath: string;
      try {
        targetCanonicalPath = realpathSync(command.repositoryPath);
      } catch {
        throw new AppCliParseError('invalid_input', 'invalid_repository_path', {
          command: command.command,
          commandId: command.commandId,
          json: command.json,
        }, 'repositoryPath');
      }
      if (targetCanonicalPath !== repositoryMovePreview.newRepository.canonicalPath) {
        throw new AppCliParseError('invalid_input', 'invalid_preview_file', {
          command: command.command,
          commandId: command.commandId,
          json: command.json,
        }, 'preview-file');
      }
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '移动预览文件读取或校验失败',
      });
    }
  }

  let profilePayload: Record<string, unknown> | undefined;
  if (command.commandId === 'project.profile-confirm' || command.commandId === 'project.profile-modify') {
    try {
      profilePayload = readProfileInputPayload(command);
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: 'Profile 输入文件读取失败',
      });
    }
  }

  // Profile 查询和写入均经 HostClient；CLI 不打开 SQLite、不读取业务文件。
  // Profile 确认不隐式授权基线、审批、验收或预算变更。

  // P03-5 / F-012：workspace.discard 确认在服务端包含 Git 删除与整组停止证明
  //（固有有界等待，实测约 13s），默认 10s 单请求预算会无谓落入响应丢失路径；
  // 本命令使用受界放大预算（仍有限：60s 单请求 / 120s 总预算），显式注入逐字段优先。
  const commandTimeouts: HostClientTimeouts | undefined =
    command.commandId === 'workspace.discard'
      ? { appRequestMs: 60_000, submitBudgetMs: 120_000, ...(options.timeouts ?? {}) }
      : options.timeouts;

  let client: HostClient;
  try {
    const ensured = await ensureHostRunning({
      ...rootSource(command.dataRoot, options.userHomeDir),
      platform,
      startBudgetMs: command.startTimeoutMs,
      ...(commandTimeouts !== undefined ? { timeouts: commandTimeouts } : {}),
      ...(options.launch?.entryArgv !== undefined ? { entryArgv: options.launch.entryArgv } : {}),
      ...(options.launch?.nodeExecutable !== undefined
        ? { nodeExecutable: options.launch.nodeExecutable }
        : {}),
      ...(options.launch?.childEnv !== undefined ? { childEnv: options.launch.childEnv } : {}),
      ...(options.launch?.onCandidateSpawned !== undefined
        ? { onCandidateSpawned: options.launch.onCandidateSpawned }
        : {}),
      ...(options.launch?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.launch.pollIntervalMs }
        : {}),
    });
    client = ensured.client;
  } catch (error) {
    if (isHostProtocolError(error)) {
      return emitFailure(io, command.json, protocolFailure(command.commandId, error));
    }
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'internal',
      message: '连接 Host 时发生未预期错误（已脱敏）',
    });
  }

  try {
    if (command.command === 'knowledge') {
      return await executeKnowledgeCommand(io, command, client);
    }
    if (command.command === 'baseline') {
      return await executeBaselineCommand(io, command, client, baselinePlan, baselineBudgets, options.signal);
    }
    if (command.command === 'config') {
      return await executeConfigCommand(io, command, client, configPayload as Record<string, unknown>);
    }
    if (command.command === 'receipt') {
      return await executeReceiptCommand(io, command, client);
    }
    if (command.command === 'events') {
      return await executeEventsCommand(
        io,
        command,
        client,
        options.signal,
        observeBudgets as ResolvedEventsObserveBudgets,
      );
    }
    if (command.command === 'planning') {
      return await executePlanningCommand(io, command, client, planningInput);
    }
    if (command.command === 'phase' || command.command === 'feature' || command.command === 'task' || command.command === 'integration') {
      return await executePlanCommand(io, command, client, {
        ...(planPayload !== undefined ? { planPayload } : {}),
        ...(strategyPayload !== undefined ? { strategyPayload } : {}),
        ...(prepareItems !== undefined ? { prepareItems } : {}),
      });
    }
    if (command.command === 'execution') {
      return await executeExecutionCommand(io, command, client, {
        ...(executionBudget !== undefined ? { budget: executionBudget } : {}),
      });
    }
    if (command.command === 'workspace') {
      return await executeWorkspaceCommand(io, command, client, {
        ...(workspaceDiscardPayload !== undefined ? { discardPayload: workspaceDiscardPayload } : {}),
      });
    }
    if (command.command === 'git') {
      return await executeGitCommand(io, command, client);
    }
    if (command.command === 'backup') {
      return await executeBackupCommand(io, command, client);
    }
    if (command.command === 'retention') {
      return await executeRetentionCommand(io, command, client);
    }
    return await executeProjectCommand(io, command, client, profilePayload, repositoryMovePreview);
  } catch (error) {
    if (isHostProtocolError(error)) {
      return emitFailure(
        io,
        command.json,
        protocolFailure(command.commandId, error, explicitCommandIdOf(command)),
      );
    }
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'internal',
      message: '执行命令时发生未预期错误（已脱敏）',
    });
  } finally {
    client.close();
  }
}
