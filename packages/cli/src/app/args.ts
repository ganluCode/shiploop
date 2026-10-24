/**
 * F-014 应用命令 CLI 纯参数解析（契约 §12.1/§12.2）。
 *
 * 纪律：
 * - 同步纯函数：不读 process.argv / process.env（env/cwd 必须显式注入）、不读
 *   文件、不发现 Host、不访问网络、不启动进程、不生成 commandId；解析失败
 *   即 AppCliParseError，调用方保证解析成功前不做任何 I/O；
 * - 只识别契约白名单的 project/config/receipt/events/baseline 命令，不新增
 *   Run/Work、模型、Profile、Skills 参数（未知即 unknown_argument）；P02-3
 *   （F-005）按契约 §12.1 增补 project init/overview 子命令；F-015 按契约
 *   §12.1/§12.2 增补 baseline preview/run/list/status/cancel/evidence 子命令；
 *   P03-3 / F-012 增补执行授权 execution preview/start/budget/revise 子命令
 *   （单 Feature 显式授权 + 预算查询/修订；不新增 wait/cancel/resume）；
 *   P03-4 / F-009 增补 execution schedule/attempts/diagnostics 只读诊断子命令
 *   （Run 调度原因/Task 就绪视图、Attempt 归属与通知诊断审计；只读不认领）；
 *   P03-5 / F-012 增补 workspace list/get/operations/operation 只读状态子命令
 *   与 discard-preview/discard 人工丢弃预览确认子命令（破坏性确认缺 --confirm
 *   或 --preview-file 在解析层本地拒绝，不隐式预览后自动同意）；
 *   P03-6 / F-013 增补 execution sessions/session/session-evidence/cancel
 *   子命令（实际 Host 公共契约 execution.sessions.list/execution.session.get/
 *   execution.session.evidence.get/execution.attempt.cancel 的参数映射；
 *   取消必须 --confirm 显式确认，不猜测草案命令）；
 * P05-1 / F-013 增补 planning start/list/get/candidate/approve/reject 子命令；规划输入文件
 *   在连接前有界读取，规划 Run 的取消/恢复沿用 execution.cancel/pause/resume，
 *   不自动批准、不自动开始编码；
 * - 监听地址覆盖零容忍：--bind/--host/--address/--port/--listen* 与
 *   SHIPLOOP_HOST_* env 覆盖一律 bind_address_override_rejected；
 * - 错误只携带 code/reason/参数名/命令身份，绝不回显参数值；
 * - 本模块是纯面层，文件读取与 HostClient 接线属 F-015/F-016/F-017。
 */
import { BIND_OVERRIDE_ENV_KEYS, isUuidV4 } from 'shiploop-host';
import {
  CLI_START_TIMEOUT_DEFAULT_MS,
  CLI_START_TIMEOUT_MAX_MS,
  CLI_START_TIMEOUT_MIN_MS,
} from '../host/args.js';

export const APP_CLI_COMMANDS = [
  'project',
  'config',
  'receipt',
  'events',
  'baseline',
  'phase',
  'feature',
  'task',
  'planning',
  'execution',
  'workspace',
  'git',
] as const;
export type AppCliCommand = (typeof APP_CLI_COMMANDS)[number];

/** 应用命令身份（点分 CLI 路径；用于 JSON 信封 command 字段）。 */
export type AppCliCommandId =
  | 'project.init'
  | 'project.overview'
  | 'project.register'
  | 'project.list'
  | 'project.get'
  | 'project.edit'
  | 'project.labels'
  | 'config.create'
  | 'config.update'
  | 'config.get'
  | 'config.effective'
  | 'config.export'
  | 'receipt.get'
  | 'events.observe'
  | 'baseline.preview'
  | 'baseline.run'
  | 'baseline.list'
  | 'baseline.status'
  | 'baseline.cancel'
  | 'baseline.evidence'
  | 'phase.create'
  | 'phase.update'
  | 'phase.close'
  | 'phase.reopen'
  | 'phase.archive'
  | 'phase.graph'
  | 'feature.move'
  | 'feature.dependencies'
  | 'phase.list'
  | 'phase.get'
  | 'phase.labels'
  | 'feature.import'
  | 'feature.list'
  | 'feature.get'
  | 'feature.revise'
  | 'feature.labels'
  | 'feature.approve'
  | 'feature.reject'
  | 'feature.delivery'
  | 'feature.report'
  | 'feature.final-approve'
  | 'feature.finalize'
  | 'task.list'
  | 'task.get'
  | 'task.labels'
  | 'task.strategy'
  | 'task.prepare'
  | 'task.inputs'
  | 'task.status'
  | 'task.block'
  | 'task.approve'
  | 'task.reject'
  | 'task.unblock'
  | 'task.continue'
  | 'planning.start'
  | 'planning.list'
  | 'planning.get'
  | 'planning.candidate'
  | 'planning.approve'
  | 'planning.reject'
  | 'execution.preview'
  | 'execution.start'
  | 'execution.budget'
  | 'execution.revise'
  | 'execution.schedule'
  | 'execution.attempts'
  | 'execution.diagnostics'
  | 'execution.dispatch'
  | 'execution.sessions'
  | 'execution.session'
  | 'execution.session-evidence'
  | 'execution.recordings'
  | 'execution.recording-body'
  | 'execution.cancel'
  | 'execution.pause'
  | 'execution.resume'
  | 'execution.retry-final'
  | 'execution.control'
  | 'execution.batch-control'
  | 'execution.recovery'
  | 'workspace.list'
  | 'workspace.get'
  | 'workspace.operations'
  | 'workspace.operation'
  | 'workspace.discard-preview'
  | 'workspace.discard'
  | 'git.operations'
  | 'git.operation';

export const APP_CLI_COMMAND_IDS: readonly AppCliCommandId[] = Object.freeze([
  'project.init',
  'project.overview',
  'project.register',
  'project.list',
  'project.get',
  'project.edit',
  'project.labels',
  'config.create',
  'config.update',
  'config.get',
  'config.effective',
  'config.export',
  'receipt.get',
  'events.observe',
  'baseline.preview',
  'baseline.run',
  'baseline.list',
  'baseline.status',
  'baseline.cancel',
  'baseline.evidence',
  'phase.create',
  'phase.update',
  'phase.close',
  'phase.reopen',
  'phase.archive',
  'phase.graph',
  'feature.move',
  'feature.dependencies',
  'phase.list',
  'phase.get',
  'phase.labels',
  'feature.import',
  'feature.list',
  'feature.get',
  'feature.revise',
  'feature.labels',
  'feature.approve',
  'feature.reject',
  'feature.delivery',
  'feature.report',
  'feature.final-approve',
  'feature.finalize',
  'task.list',
  'task.get',
  'task.labels',
  'task.strategy',
  'task.prepare',
  'task.inputs',
  'task.status',
  'task.block',
  'task.approve',
  'task.reject',
  'task.unblock',
  'task.continue',
  'planning.start',
  'planning.list',
  'planning.get',
  'planning.candidate',
  'planning.approve',
  'planning.reject',
  'execution.preview',
  'execution.start',
  'execution.budget',
  'execution.revise',
  'execution.schedule',
  'execution.attempts',
  'execution.diagnostics',
  'execution.dispatch',
  'execution.sessions',
  'execution.session',
  'execution.session-evidence',
  'execution.recordings',
  'execution.recording-body',
  'execution.cancel',
  'workspace.list',
  'workspace.get',
  'workspace.operations',
  'workspace.operation',
  'workspace.discard-preview',
  'workspace.discard',
  'git.operations',
  'git.operation',
]);

/** 命令对应的 Core 操作身份（F-015/F-016 组装命令信封时使用）。 */
export type AppCommandOperation =
  | 'project.register'
  | 'project.metadata.update'
  | 'settings.global.create'
  | 'settings.global.update'
  | 'settings.project.create'
  | 'settings.project.update'
  | 'baseline.preview'
  | 'baseline.run'
  | 'baseline.cancel'
  | 'phase.create'
  | 'feature.plan.import'
  | 'plan.labels.update'
  | 'feature.plan.revise'
  | 'feature.plan.decide'
  | 'task.strategy.update'
  | 'planning.start'
  | 'planning.candidate.decide'
  | 'execution.input.prepare'
  | 'execution.preview'
  | 'execution.start'
  | 'execution.pause'
  | 'execution.cancel'
  | 'execution.resume'
  | 'execution.retryFinal'
  | 'execution.budget.revise'
  | 'workspace.discard'
  | 'workspace.discard.preview';

export type AppHelpScope = AppCliCommand | AppCliCommandId;

export type AppCliParseErrorCode = 'invalid_input' | 'bind_address_override_rejected';

export type AppCliParseReason =
  | 'invalid_argv_type'
  | 'missing_command'
  | 'unknown_command'
  | 'missing_subcommand'
  | 'unknown_subcommand'
  | 'unknown_argument'
  | 'unexpected_positional'
  | 'missing_value'
  | 'duplicate_option'
  | 'bool_flag_takes_no_value'
  | 'data_root_empty'
  | 'data_root_not_absolute'
  | 'data_root_is_filesystem_root'
  | 'data_root_contains_nul'
  | 'invalid_integer'
  | 'integer_out_of_range'
  | 'option_not_allowed_for_command'
  | 'listen_override_argument_rejected'
  | 'listen_override_env_rejected'
  | 'invalid_project_id'
  | 'invalid_revision'
  | 'invalid_limit'
  | 'invalid_match'
  | 'invalid_cursor'
  | 'invalid_command_id'
  | 'invalid_input_file'
  | 'invalid_repository_path'
  | 'repository_path_requires_cwd'
  | 'invalid_name'
  | 'invalid_description'
  | 'empty_label'
  | 'invalid_label'
  | 'too_many_labels'
  | 'missing_positional'
  | 'too_many_positionals'
  | 'missing_required_option'
  | 'invalid_scope'
  | 'scope_conflict'
  | 'project_required_for_scope'
  | 'conflicting_options'
  | 'invalid_input_json'
  | 'invalid_operation_id'
  | 'invalid_artifact_id'
  | 'invalid_baseline_limit'
  | 'invalid_check_plan'
  | 'empty_command'
  | 'invalid_argv'
  | 'invalid_check_key'
  | 'duplicate_check_key'
  | 'invalid_check_kind'
  | 'invalid_check_timeout'
  | 'invalid_required'
  | 'invalid_cwd_ref'
  | 'invalid_environment_ref'
  | 'unknown_input_field'
  | 'input_secret_field_rejected'
  | 'input_identity_field_rejected'
  | 'invalid_planning_input'
  | 'invalid_title'
  | 'invalid_plan_id'
  | 'invalid_plan_digest'
  | 'invalid_reason'
  | 'input_items_invalid'
  | 'input_file_too_large'
  | 'input_file_encoding'
  | 'missing_budget'
  | 'invalid_budget'
  | 'invalid_budget_date'
  | 'invalid_preview_digest'
  | 'invalid_batch_id'
  | 'invalid_run_id'
  | 'invalid_attempt_id'
  | 'invalid_session_id'
  | 'invalid_record_type'
  | 'concurrency_not_supported'
  | 'confirmation_required'
  | 'invalid_preview_file'
  | 'preview_feature_mismatch'
  | 'invalid_digest'
  | 'invalid_artifact_ref'
  | 'duplicate_artifact_ref'
  | 'missing_control_target'
  | 'invalid_work_key';

const REASON_MESSAGE: Readonly<Record<AppCliParseReason, string>> = Object.freeze({
  invalid_argv_type: 'argv 必须是字符串数组',
  missing_command: '缺少命令；本版本提供 project/config/receipt/events/baseline/phase/feature/task/planning/execution',
  unknown_command: '未知顶层命令；本版本仅提供 project/config/receipt/events/baseline/phase/feature/task/planning/execution',
  missing_subcommand: '命令缺少子命令',
  unknown_subcommand: '未知子命令',
  unknown_argument: '未知参数',
  unexpected_positional: '不接受位置参数',
  missing_value: '参数缺少值',
  duplicate_option: '参数重复出现',
  bool_flag_takes_no_value: '布尔开关不接受值',
  data_root_empty: '数据根不能为空',
  data_root_not_absolute: '数据根必须是 POSIX 绝对路径',
  data_root_is_filesystem_root: '数据根不能是文件系统根 /',
  data_root_contains_nul: '数据根不能包含 NUL 字符',
  invalid_integer: '参数必须是非负十进制整数',
  integer_out_of_range: '参数超出允许区间',
  option_not_allowed_for_command: '该参数不适用于当前命令',
  listen_override_argument_rejected: '拒绝监听地址覆盖参数：Host 只监听 127.0.0.1',
  listen_override_env_rejected: '拒绝监听地址覆盖环境变量：Host 只监听 127.0.0.1',
  invalid_project_id: 'projectId 必须是 UUID v4',
  invalid_revision: 'revision 必须是 ≥ 1 的整数',
  invalid_limit: 'limit 必须是 1..200 的整数',
  invalid_match: 'match 只能是 any 或 all',
  invalid_cursor: 'cursor 必须是非空字符串',
  invalid_command_id: 'commandId 必须是 UUID v4',
  invalid_input_file: 'input 必须是非空文件路径',
  invalid_repository_path: '仓库路径必须是非空字符串',
  repository_path_requires_cwd: '相对仓库路径需要以绝对 cwd 为基准解析为绝对输入',
  invalid_name: 'name 不能为空',
  invalid_description: 'description 不合法',
  empty_label: 'label 不能为空',
  invalid_label: 'label 不合法',
  too_many_labels: 'label 数量超出上限',
  missing_positional: '缺少位置参数',
  too_many_positionals: '位置参数过多',
  missing_required_option: '缺少必填参数',
  invalid_scope: 'scope 只能是 global 或 project',
  scope_conflict: '不能同时指定互斥的 scope 参数',
  project_required_for_scope: 'scope=project 时必须提供 --project',
  conflicting_options: '参数组合冲突',
  invalid_input_json: '输入 JSON 不是合法对象',
  invalid_operation_id: 'operationId 必须是 UUID v4',
  invalid_artifact_id: 'artifactId 必须是稳定 ID（字母数字开头，仅含 [A-Za-z0-9._-]）',
  invalid_baseline_limit: 'limit 必须是 1..100 的整数',
  invalid_check_plan: '检查计划不合法',
  empty_command: '检查命令不能为空（argv 必须为非空字符串数组）',
  invalid_argv: 'argv 参数必须是非空字符串且不含 NUL',
  invalid_check_key: 'checkKey 必须匹配 ^[a-z0-9][a-z0-9_-]{0,63}$',
  duplicate_check_key: 'checkKey 必须唯一',
  invalid_check_kind: "kind 必须是 'command'",
  invalid_check_timeout: 'timeoutMs 必须是 1..3600000 的整数毫秒',
  invalid_required: 'required 必须是布尔值',
  invalid_cwd_ref: 'cwdRef 必须是仓库内 POSIX 相对路径',
  invalid_environment_ref: 'environmentRef 必须是非空环境引用（只含引用名，不携带值）',
  unknown_input_field: '输入包含未知字段（Schema 不接受前向宽容字段）',
  input_secret_field_rejected: '输入不允许携带明文秘密或环境值字段',
  input_identity_field_rejected: '输入不允许携带身份/权限/可见范围字段',
  invalid_planning_input: '规划输入文件不合法（字段缺失、未知字段或超出边界）',
  invalid_title: 'title 不能为空且不能为空白',
  invalid_plan_id: '计划实体 ID 必须是稳定 ID（字母数字开头，仅含 [A-Za-z0-9._-]）',
  invalid_plan_digest: '计划摘要必须是 64 位小写十六进制',
  invalid_reason: '决策原因不合法（不允许 NUL；长度不超过 2000 字符）',
  input_items_invalid: '必需输入清单必须是数组',
  input_file_too_large: '输入文件超过大小上限',
  input_file_encoding: '输入文件必须是合法 UTF-8 文本',
  missing_budget: '缺少完整有限预算（--input 或预算字段缺失）',
  invalid_budget: '执行预算形态不合法（未知键或结构错误）',
  invalid_budget_date: '预算日期不合法（deadlineUtcMs 须为 epoch 毫秒整数或 ISO-8601 UTC 日期）',
  invalid_preview_digest: 'previewDigest 必须是 64 位小写十六进制',
  invalid_batch_id: 'batchId 必须是 UUID v4',
  invalid_run_id: 'runId 必须是 UUID v4',
  invalid_attempt_id: 'attemptId 必须是 UUID v4',
  invalid_session_id: 'sessionId 必须是稳定 ID',
  invalid_record_type: 'recordType 只能是 messages 或 manifests',
  concurrency_not_supported: '有效并发大于一：本版本只支持单并发执行',
  confirmation_required: '破坏性操作必须明确确认（--confirm）',
  invalid_preview_file: '丢弃预览文件不是合法的工作区丢弃预览（形状或绑定字段不合法）',
  preview_feature_mismatch: '丢弃预览文件的 Feature 与命令目标 Feature 不一致',
  invalid_digest: '摘要必须是 64 位小写十六进制',
  invalid_artifact_ref: '产物引用必须是 <artifactId> 或 <artifactId>:<sha256>',
  duplicate_artifact_ref: '不得重复引用同一产物',
  missing_control_target: '必须恰指定 --run 或 --batch 之一',
  invalid_work_key: 'workKey 必须是非空且不超过 256 字符的字符串',
});

interface ParseState {
  command: AppCliCommand | null;
  commandId: AppCliCommandId | null;
  json: boolean;
  /** 显式注入的解析基准（相对仓库路径 → 绝对输入）；不读 process。 */
  cwd: string | undefined;
  readonly seen: Set<string>;
}

/**
 * 应用命令参数解析失败。code 决定退出码（两类都映射 2）；reason/field 是受控
 * 诊断；command/commandId/json 用于输出路由；任何用户提供的值都不进入本错误。
 */
export class AppCliParseError extends Error {
  readonly code: AppCliParseErrorCode;
  readonly reason: AppCliParseReason;
  readonly field: string | undefined;
  readonly command: AppCliCommand | null;
  readonly commandId: AppCliCommandId | null;
  readonly json: boolean;

  constructor(
    code: AppCliParseErrorCode,
    reason: AppCliParseReason,
    state: { command: AppCliCommand | null; commandId: AppCliCommandId | null; json: boolean },
    field?: string,
  ) {
    super(REASON_MESSAGE[reason]);
    this.name = 'AppCliParseError';
    this.code = code;
    this.reason = reason;
    this.field = field;
    this.command = state.command;
    this.commandId = state.commandId;
    this.json = state.json;
  }
}

interface AppCommandSpec {
  readonly command: AppCliCommand;
  readonly commandId: AppCliCommandId;
  readonly valueFlags: readonly string[];
  readonly boolFlags: readonly string[];
  readonly repeatableFlags: readonly string[];
  readonly minPositionals: number;
  readonly maxPositionals: number;
  readonly positionalFields: readonly string[];
}

const SPECS: Readonly<Record<AppCliCommandId, AppCommandSpec>> = Object.freeze({
  'project.init': {
    command: 'project',
    commandId: 'project.init',
    valueFlags: ['--name', '--description', '--label', '--command-id'],
    boolFlags: ['--confirm'],
    repeatableFlags: ['--label'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['repositoryPath'],
  },
  'project.overview': {
    command: 'project',
    commandId: 'project.overview',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['projectId'],
  },
  'project.register': {
    command: 'project',
    commandId: 'project.register',
    valueFlags: ['--name', '--description', '--label', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['repositoryPath'],
  },
  'project.list': {
    command: 'project',
    commandId: 'project.list',
    valueFlags: ['--label', '--match', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'project.get': {
    command: 'project',
    commandId: 'project.get',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['projectId'],
  },
  'project.edit': {
    command: 'project',
    commandId: 'project.edit',
    valueFlags: ['--revision', '--name', '--description', '--label', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['projectId'],
  },
  'project.labels': {
    command: 'project',
    commandId: 'project.labels',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'config.create': {
    command: 'config',
    commandId: 'config.create',
    valueFlags: ['--scope', '--project', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'config.update': {
    command: 'config',
    commandId: 'config.update',
    valueFlags: ['--scope', '--revision', '--project', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'config.get': {
    command: 'config',
    commandId: 'config.get',
    valueFlags: ['--scope', '--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'config.effective': {
    command: 'config',
    commandId: 'config.effective',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'config.export': {
    command: 'config',
    commandId: 'config.export',
    valueFlags: ['--scope', '--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'receipt.get': {
    command: 'receipt',
    commandId: 'receipt.get',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['commandId'],
  },
  'events.observe': {
    command: 'events',
    commandId: 'events.observe',
    valueFlags: ['--project', '--cursor'],
    boolFlags: ['--global', '--snapshot-only', '--follow'],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'baseline.preview': {
    command: 'baseline',
    commandId: 'baseline.preview',
    valueFlags: ['--project', '--input'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'baseline.run': {
    command: 'baseline',
    commandId: 'baseline.run',
    valueFlags: ['--project', '--input', '--command-id'],
    boolFlags: ['--confirm', '--decline', '--wait', '--follow'],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'baseline.list': {
    command: 'baseline',
    commandId: 'baseline.list',
    valueFlags: ['--project', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'baseline.status': {
    command: 'baseline',
    commandId: 'baseline.status',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['operationId'],
  },
  'baseline.cancel': {
    command: 'baseline',
    commandId: 'baseline.cancel',
    valueFlags: ['--command-id'],
    boolFlags: ['--confirm'],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['operationId'],
  },
  'baseline.evidence': {
    command: 'baseline',
    commandId: 'baseline.evidence',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['artifactId'],
  },
  'planning.start': {
    command: 'planning', commandId: 'planning.start',
    valueFlags: ['--project', '--phase', '--revision', '--input', '--command-id'],
    boolFlags: [], repeatableFlags: [], minPositionals: 1, maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'planning.list': {
    command: 'planning', commandId: 'planning.list',
    valueFlags: ['--project', '--feature', '--limit', '--cursor'],
    boolFlags: [], repeatableFlags: [], minPositionals: 0, maxPositionals: 0,
    positionalFields: [],
  },
  'planning.get': {
    command: 'planning', commandId: 'planning.get',
    valueFlags: ['--project'], boolFlags: [], repeatableFlags: [], minPositionals: 1, maxPositionals: 1,
    positionalFields: ['candidateId'],
  },
  'planning.candidate': {
    command: 'planning', commandId: 'planning.candidate',
    valueFlags: ['--project'], boolFlags: [], repeatableFlags: [], minPositionals: 1, maxPositionals: 1,
    positionalFields: ['candidateId'],
  },
  'planning.approve': {
    command: 'planning', commandId: 'planning.approve',
    valueFlags: ['--project', '--digest', '--revision', '--reason', '--command-id'],
    boolFlags: [], repeatableFlags: [], minPositionals: 1, maxPositionals: 1,
    positionalFields: ['candidateId'],
  },
  'planning.reject': {
    command: 'planning', commandId: 'planning.reject',
    valueFlags: ['--project', '--digest', '--revision', '--reason', '--command-id'],
    boolFlags: [], repeatableFlags: [], minPositionals: 1, maxPositionals: 1,
    positionalFields: ['candidateId'],
  },
  'phase.create': {
    command: 'phase',
    commandId: 'phase.create',
    valueFlags: ['--project', '--title', '--description', '--label', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'phase.update': {
    command: 'phase', commandId: 'phase.update',
    valueFlags: ["--project","--revision","--title","--description","--label","--command-id"],
    boolFlags: ["--clear-description","--clear-labels"], repeatableFlags: ["--label"],
    minPositionals: 1, maxPositionals: 1, positionalFields: ["phaseId"],
  },
  'phase.close': {
    command: 'phase', commandId: 'phase.close',
    valueFlags: ["--project","--revision","--command-id"],
    boolFlags: [], repeatableFlags: [],
    minPositionals: 1, maxPositionals: 1, positionalFields: ["phaseId"],
  },
  'phase.reopen': {
    command: 'phase', commandId: 'phase.reopen',
    valueFlags: ["--project","--revision","--command-id"],
    boolFlags: [], repeatableFlags: [],
    minPositionals: 1, maxPositionals: 1, positionalFields: ["phaseId"],
  },
  'phase.archive': {
    command: 'phase', commandId: 'phase.archive',
    valueFlags: ["--project","--revision","--command-id"],
    boolFlags: [], repeatableFlags: [],
    minPositionals: 1, maxPositionals: 1, positionalFields: ["phaseId"],
  },
  'phase.graph': {
    command: 'phase', commandId: 'phase.graph',
    valueFlags: ["--project","--limit","--cursor"],
    boolFlags: [], repeatableFlags: [],
    minPositionals: 1, maxPositionals: 1, positionalFields: ["phaseId"],
  },
  'feature.move': {
    command: 'feature', commandId: 'feature.move',
    valueFlags: ["--project","--revision","--from-phase","--to-phase","--source-revision","--target-revision","--command-id"],
    boolFlags: [], repeatableFlags: [],
    minPositionals: 1, maxPositionals: 1, positionalFields: ["featureId"],
  },
  'feature.dependencies': {
    command: 'feature', commandId: 'feature.dependencies',
    valueFlags: ["--project","--phase","--revision","--input","--command-id"],
    boolFlags: [], repeatableFlags: [],
    minPositionals: 0, maxPositionals: 0, positionalFields: [],
  },
  'phase.list': {
    command: 'phase',
    commandId: 'phase.list',
    valueFlags: ['--project', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'phase.get': {
    command: 'phase',
    commandId: 'phase.get',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['phaseId'],
  },
  'phase.labels': {
    command: 'phase',
    commandId: 'phase.labels',
    valueFlags: ['--project', '--revision', '--label', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['phaseId'],
  },
  'feature.import': {
    command: 'feature',
    commandId: 'feature.import',
    valueFlags: ['--project', '--phase', '--revision', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'feature.list': {
    command: 'feature',
    commandId: 'feature.list',
    valueFlags: ['--project', '--phase', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'feature.get': {
    command: 'feature',
    commandId: 'feature.get',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'feature.revise': {
    command: 'feature',
    commandId: 'feature.revise',
    valueFlags: ['--project', '--revision', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'feature.labels': {
    command: 'feature',
    commandId: 'feature.labels',
    valueFlags: ['--project', '--revision', '--label', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'task.list': {
    command: 'task',
    commandId: 'task.list',
    valueFlags: ['--project', '--feature', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'task.get': {
    command: 'task',
    commandId: 'task.get',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'task.labels': {
    command: 'task',
    commandId: 'task.labels',
    valueFlags: ['--project', '--revision', '--label', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--label'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'feature.approve': {
    command: 'feature',
    commandId: 'feature.approve',
    valueFlags: ['--project', '--digest', '--revision', '--reason', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'feature.reject': {
    command: 'feature',
    commandId: 'feature.reject',
    valueFlags: ['--project', '--digest', '--revision', '--reason', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  /* P03-8 / F-011：Feature 分轴结果查询与最终审批/显式收尾命令（审批绑定
   * 当前摘要；final-approve/finalize 缺 --confirm 在解析层拒绝；身份与
   * 凭据不接受客户端参数；产物引用可重复）。 */
  'feature.report': {
    command: 'feature', commandId: 'feature.report', valueFlags: ['--project'],
    boolFlags: [], repeatableFlags: [], minPositionals: 1, maxPositionals: 1, positionalFields: ['featureId'],
  },
  'feature.delivery': {
    command: 'feature',
    commandId: 'feature.delivery',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'feature.final-approve': {
    command: 'feature',
    commandId: 'feature.final-approve',
    valueFlags: [
      '--project',
      '--task',
      '--item',
      '--digest',
      '--code-digest',
      '--revision',
      '--reason',
      '--artifact',
      '--command-id',
    ],
    boolFlags: ['--confirm'],
    repeatableFlags: ['--artifact'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'feature.finalize': {
    command: 'feature',
    commandId: 'feature.finalize',
    valueFlags: ['--project', '--run', '--batch', '--operation', '--revision', '--command-id'],
    boolFlags: ['--confirm'],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'task.strategy': {
    command: 'task',
    commandId: 'task.strategy',
    valueFlags: ['--project', '--revision', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'task.prepare': {
    command: 'task',
    commandId: 'task.prepare',
    valueFlags: ['--project', '--feature', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'task.inputs': {
    command: 'task',
    commandId: 'task.inputs',
    valueFlags: [],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['commandId'],
  },
  /* P03-7 / F-014：人审事项/显式验证继续命令与 Task 状态查询（身份与凭据
   * 不接受客户端参数；产物引用可重复）。 */
  'task.status': {
    command: 'task',
    commandId: 'task.status',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'task.block': {
    command: 'task',
    commandId: 'task.block',
    valueFlags: [
      '--project',
      '--digest',
      '--revision',
      '--kind',
      '--description',
      '--party',
      '--code-digest',
      '--artifact',
      '--command-id',
    ],
    boolFlags: [],
    repeatableFlags: ['--artifact'],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'task.approve': {
    command: 'task',
    commandId: 'task.approve',
    valueFlags: ['--project', '--digest', '--code-digest', '--revision', '--reason', '--artifact', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--artifact'],
    minPositionals: 2,
    maxPositionals: 2,
    positionalFields: ['taskId', 'itemId'],
  },
  'task.reject': {
    command: 'task',
    commandId: 'task.reject',
    valueFlags: ['--project', '--digest', '--code-digest', '--revision', '--reason', '--artifact', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--artifact'],
    minPositionals: 2,
    maxPositionals: 2,
    positionalFields: ['taskId', 'itemId'],
  },
  'task.unblock': {
    command: 'task',
    commandId: 'task.unblock',
    valueFlags: ['--project', '--digest', '--code-digest', '--revision', '--reason', '--artifact', '--command-id'],
    boolFlags: [],
    repeatableFlags: ['--artifact'],
    minPositionals: 2,
    maxPositionals: 2,
    positionalFields: ['taskId', 'itemId'],
  },
  'task.continue': {
    command: 'task',
    commandId: 'task.continue',
    valueFlags: [
      '--project',
      '--attempt',
      '--batch',
      '--code-digest',
      '--observation',
      '--revision',
      '--command-id',
    ],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'execution.preview': {
    command: 'execution',
    commandId: 'execution.preview',
    valueFlags: ['--project', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'execution.start': {
    command: 'execution',
    commandId: 'execution.start',
    valueFlags: ['--project', '--input', '--preview-digest', '--retry-batch', '--command-id'],
    boolFlags: ['--confirm'],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'execution.budget': {
    command: 'execution',
    commandId: 'execution.budget',
    valueFlags: ['--project', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['batchId'],
  },
  'execution.revise': {
    command: 'execution',
    commandId: 'execution.revise',
    valueFlags: ['--project', '--revision', '--reason', '--input', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['batchId'],
  },
  'execution.schedule': {
    command: 'execution',
    commandId: 'execution.schedule',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['runId'],
  },
  'execution.attempts': {
    command: 'execution',
    commandId: 'execution.attempts',
    valueFlags: ['--project', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['taskId'],
  },
  'execution.diagnostics': {
    command: 'execution',
    commandId: 'execution.diagnostics',
    valueFlags: ['--project', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['attemptId'],
  },
  /* P04-9 / F-009 派发队列与执行槽位只读查询：只接受项目与既有分页；
   * 无位置参数，也不接受 owner/version/capacity 或释放槽位等写意图。 */
  'execution.dispatch': {
    command: 'execution',
    commandId: 'execution.dispatch',
    valueFlags: ['--project', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  /* P03-6 / F-013 Work Session 状态/证据查询与 Attempt 取消（实际 Host 公共
   * 契约的参数映射；sessions 的父级 Run/Task 二选一，取消必须 --confirm）。 */
  'execution.sessions': {
    command: 'execution',
    commandId: 'execution.sessions',
    valueFlags: ['--project', '--run', '--task', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'execution.session': {
    command: 'execution',
    commandId: 'execution.session',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['attemptId'],
  },
  'execution.session-evidence': {
    command: 'execution',
    commandId: 'execution.session-evidence',
    valueFlags: ['--project', '--artifact'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['attemptId'],
  },
  /* P04-5 / F-007 Work 公开记录索引/正文查询（实际 Host 公共契约
   * execution.recording.list / execution.recording.body.get 的参数映射；
   * 父级 Run/Attempt/Session 三选一，recordType 只接受 messages|manifests）。 */
  'execution.recordings': {
    command: 'execution',
    commandId: 'execution.recordings',
    valueFlags: ['--project', '--run', '--attempt', '--session', '--record-type', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'execution.recording-body': {
    command: 'execution',
    commandId: 'execution.recording-body',
    valueFlags: ['--project', '--run', '--attempt', '--session', '--artifact'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'execution.cancel': {
    command: 'execution',
    commandId: 'execution.cancel',
    valueFlags: ['--project', '--command-id', '--run', '--batch', '--revision'],
    boolFlags: ['--confirm'],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 1,
    positionalFields: ['attemptId'],
  },
  /* P03-9 / F-015 Run/Batch 控制与 retryFinal/恢复诊断（实际 Host 公共契约
   * execution.pause/execution.resume/execution.retryFinal 与
   * execution.run|batch.control.get、execution.run.recovery.get 的参数映射；
   * 恢复模式 auto/new/required 由 Task 策略/输入快照决定，不设注入参数）。 */
  'execution.pause': {
    command: 'execution',
    commandId: 'execution.pause',
    valueFlags: ['--project', '--run', '--batch', '--revision', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'execution.resume': {
    command: 'execution',
    commandId: 'execution.resume',
    valueFlags: ['--project', '--run', '--batch', '--revision', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'execution.retry-final': {
    command: 'execution',
    commandId: 'execution.retry-final',
    valueFlags: ['--project', '--historical-run', '--work-key', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'execution.control': {
    command: 'execution',
    commandId: 'execution.control',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['runId'],
  },
  'execution.batch-control': {
    command: 'execution',
    commandId: 'execution.batch-control',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['batchId'],
  },
  'execution.recovery': {
    command: 'execution',
    commandId: 'execution.recovery',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['runId'],
  },
  /* P03-5 / F-012 工作区状态展示与人工丢弃预览/确认（沿用既有参数解析与
   * 命令身份纪律；不新增草案命令）。 */
  'workspace.list': {
    command: 'workspace',
    commandId: 'workspace.list',
    valueFlags: ['--project', '--feature', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'workspace.get': {
    command: 'workspace',
    commandId: 'workspace.get',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'workspace.operations': {
    command: 'workspace',
    commandId: 'workspace.operations',
    valueFlags: ['--project', '--feature', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'workspace.operation': {
    command: 'workspace',
    commandId: 'workspace.operation',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['operationId'],
  },
  'workspace.discard-preview': {
    command: 'workspace',
    commandId: 'workspace.discard-preview',
    valueFlags: ['--project', '--command-id'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  'workspace.discard': {
    command: 'workspace',
    commandId: 'workspace.discard',
    valueFlags: ['--project', '--preview-file', '--command-id'],
    boolFlags: ['--confirm'],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['featureId'],
  },
  /* P03-8 / F-011：Git 意图/实际提交/操作回执只读查询（父级 Feature/Run
   * 二选一；分页同计划列表；不执行任何 Git）。 */
  'git.operations': {
    command: 'git',
    commandId: 'git.operations',
    valueFlags: ['--project', '--feature', '--run', '--limit', '--cursor'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
    positionalFields: [],
  },
  'git.operation': {
    command: 'git',
    commandId: 'git.operation',
    valueFlags: ['--project'],
    boolFlags: [],
    repeatableFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalFields: ['operationId'],
  },
});

const SUBCOMMAND_TO_ID: Readonly<Record<AppCliCommand, Readonly<Record<string, AppCliCommandId>>>> =
  Object.freeze({
    project: {
      init: 'project.init',
      overview: 'project.overview',
      register: 'project.register',
      list: 'project.list',
      get: 'project.get',
      edit: 'project.edit',
      labels: 'project.labels',
    },
    config: {
      create: 'config.create',
      update: 'config.update',
      get: 'config.get',
      effective: 'config.effective',
      export: 'config.export',
    },
    receipt: { get: 'receipt.get' },
    events: { observe: 'events.observe' },
    baseline: {
      preview: 'baseline.preview',
      run: 'baseline.run',
      list: 'baseline.list',
      status: 'baseline.status',
      cancel: 'baseline.cancel',
      evidence: 'baseline.evidence',
    },
    phase: {
      create: 'phase.create',
      update: 'phase.update', close: 'phase.close', reopen: 'phase.reopen', archive: 'phase.archive', graph: 'phase.graph',
      list: 'phase.list',
      get: 'phase.get',
      labels: 'phase.labels',
    },
    feature: {
      import: 'feature.import',
      move: 'feature.move', dependencies: 'feature.dependencies',
      list: 'feature.list',
      get: 'feature.get',
      revise: 'feature.revise',
      labels: 'feature.labels',
      approve: 'feature.approve',
      reject: 'feature.reject',
      delivery: 'feature.delivery',
      report: 'feature.report',
      'final-approve': 'feature.final-approve',
      finalize: 'feature.finalize',
    },
    task: {
      list: 'task.list',
      get: 'task.get',
      labels: 'task.labels',
      strategy: 'task.strategy',
      prepare: 'task.prepare',
      inputs: 'task.inputs',
      status: 'task.status',
      block: 'task.block',
      approve: 'task.approve',
      reject: 'task.reject',
      unblock: 'task.unblock',
      continue: 'task.continue',
    },
    planning: {
      start: 'planning.start', list: 'planning.list', get: 'planning.get', candidate: 'planning.candidate',
      approve: 'planning.approve', reject: 'planning.reject',
    },
    execution: {
      preview: 'execution.preview',
      start: 'execution.start',
      budget: 'execution.budget',
      revise: 'execution.revise',
      schedule: 'execution.schedule',
      attempts: 'execution.attempts',
      diagnostics: 'execution.diagnostics',
      dispatch: 'execution.dispatch',
      sessions: 'execution.sessions',
      session: 'execution.session',
      'session-evidence': 'execution.session-evidence',
      recordings: 'execution.recordings',
      'recording-body': 'execution.recording-body',
      cancel: 'execution.cancel',
      pause: 'execution.pause',
      resume: 'execution.resume',
      'retry-final': 'execution.retry-final',
      control: 'execution.control',
      'batch-control': 'execution.batch-control',
      recovery: 'execution.recovery',
    },
    workspace: {
      list: 'workspace.list',
      get: 'workspace.get',
      operations: 'workspace.operations',
      operation: 'workspace.operation',
      'discard-preview': 'workspace.discard-preview',
      discard: 'workspace.discard',
    },
    git: {
      operations: 'git.operations',
      operation: 'git.operation',
    },
  });

const COMMON_VALUE_FLAGS = ['--data-root', '--start-timeout-ms'] as const;
const COMMON_BOOL_FLAGS = ['--json'] as const;

const LISTEN_OVERRIDE_PREFIXES = [
  '--bind',
  '--host',
  '--hostname',
  '--address',
  '--port',
  '--listen',
] as const;

function isListenOverrideArgument(argument: string): boolean {
  return LISTEN_OVERRIDE_PREFIXES.some(
    (prefix) =>
      argument === prefix ||
      argument.startsWith(`${prefix}=`) ||
      argument.startsWith(`${prefix}-`),
  );
}

function isHelpToken(argument: string): boolean {
  return argument === '--help' || argument === '-h';
}

function fieldOf(flag: string): string {
  return flag.startsWith('--') ? flag.slice(2) : flag;
}

function fail(
  state: ParseState,
  reason: AppCliParseReason,
  field?: string,
): never {
  throw new AppCliParseError('invalid_input', reason, state, field);
}

function rejectOverrideArgument(state: ParseState): never {
  throw new AppCliParseError(
    'bind_address_override_rejected',
    'listen_override_argument_rejected',
    state,
  );
}

function rejectOverrideEnv(state: ParseState, name: string): never {
  throw new AppCliParseError(
    'bind_address_override_rejected',
    'listen_override_env_rejected',
    state,
    name,
  );
}

function assertNoEnvOverride(
  state: ParseState,
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const name of BIND_OVERRIDE_ENV_KEYS) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) {
      rejectOverrideEnv(state, name);
    }
  }
}

interface ScanResult {
  readonly options: Map<string, string[]>;
  readonly bools: Set<string>;
  readonly positionals: string[];
  readonly help: boolean;
}

function scanOptions(
  tokens: readonly string[],
  spec: AppCommandSpec,
  state: ParseState,
): ScanResult {
  const valueFlags = new Set<string>([...COMMON_VALUE_FLAGS, ...spec.valueFlags]);
  const boolFlags = new Set<string>([...COMMON_BOOL_FLAGS, ...spec.boolFlags]);
  const repeatable = new Set<string>(spec.repeatableFlags);
  const options = new Map<string, string[]>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  let help = false;
  let passthrough = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (isHelpToken(token)) {
      help = true;
      continue;
    }
    if (token.startsWith('--help=')) {
      fail(state, 'bool_flag_takes_no_value', 'help');
    }
    if (isListenOverrideArgument(token)) {
      rejectOverrideArgument(state);
    }

    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      const hasEqualsValue = equalsIndex >= 0;

      if (boolFlags.has(name)) {
        if (hasEqualsValue) {
          fail(state, 'bool_flag_takes_no_value', fieldOf(name));
        }
        if (state.seen.has(name)) {
          fail(state, 'duplicate_option', fieldOf(name));
        }
        state.seen.add(name);
        bools.add(name);
        continue;
      }

      if (valueFlags.has(name)) {
        if (state.seen.has(name) && !repeatable.has(name)) {
          fail(state, 'duplicate_option', fieldOf(name));
        }
        let value: string;
        if (hasEqualsValue) {
          value = token.slice(equalsIndex + 1);
        } else {
          const next = tokens[index + 1];
          if (next === undefined || next.startsWith('-')) {
            fail(state, 'missing_value', fieldOf(name));
          }
          value = next;
          index += 1;
        }
        state.seen.add(name);
        const existing = options.get(name);
        if (existing === undefined) {
          options.set(name, [value]);
        } else {
          existing.push(value);
        }
        continue;
      }

      fail(state, 'unknown_argument', fieldOf(name));
    }

    if (token.startsWith('-')) {
      fail(state, 'unknown_argument', token);
    }
    positionals.push(token);
  }

  return { options, bools, positionals, help };
}

function takeOption(scan: ScanResult, name: string): string | undefined {
  return scan.options.get(name)?.[0];
}

/** Unicode 码点计数（与 core ports/validation 的长度上限同一口径）。 */
function codePointLength(value: string): number {
  return [...value].length;
}

/** 元数据上限（镜像 core ports/validation.ts 同名值；Host 公共面未导出常量）。 */
const PROJECT_DISPLAY_NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 10_000;
const LABEL_MAX_LENGTH = 64;
const LABELS_MAX_COUNT = 50;
/** 基线操作列表分页上限（契约 §13：默认 20、上限 100）。 */
const BASELINE_LIST_LIMIT_MAX = 100;
/**
 * 计划层级列表分页上限（镜像 core ports/queries 的 PLAN_LIST_MAX_LIMIT=200；
 * Host 公共面未导出常量，不另立数值）。
 */
const PLAN_LIST_LIMIT_MAX = 200;
/** 稳定制品 ID（与 HostClient/核心校验同一口径）。 */
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function takeLabels(scan: ScanResult, state: ParseState): readonly string[] {
  const labels = scan.options.get('--label') ?? [];
  const normalizedKeys = new Set<string>();
  for (const label of labels) {
    if (label.trim().length === 0) {
      fail(state, 'empty_label', 'label');
    }
    if (label.includes('\0')) {
      fail(state, 'invalid_label', 'label');
    }
    // 与 core 唯一标签规则同口径：trim → NFC → ASCII 小写后判长度/去重计数。
    const normalized = label
      .trim()
      .normalize('NFC')
      .replaceAll(/[A-Z]/g, (char) => char.toLowerCase());
    if (codePointLength(normalized) > LABEL_MAX_LENGTH) {
      fail(state, 'invalid_label', 'label');
    }
    normalizedKeys.add(normalized);
  }
  if (normalizedKeys.size > LABELS_MAX_COUNT) {
    fail(state, 'too_many_labels', 'labels');
  }
  return labels;
}

function assertPositionals(scan: ScanResult, spec: AppCommandSpec, state: ParseState): void {
  if (scan.positionals.length < spec.minPositionals) {
    fail(state, 'missing_positional', spec.positionalFields[0] ?? 'positional');
  }
  if (scan.positionals.length > spec.maxPositionals) {
    fail(state, 'too_many_positionals');
  }
}

function resolveDataRoot(scan: ScanResult, state: ParseState): string | undefined {
  const raw = takeOption(scan, '--data-root');
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    fail(state, 'data_root_empty', 'data-root');
  }
  if (raw.includes('\0')) {
    fail(state, 'data_root_contains_nul', 'data-root');
  }
  if (!raw.startsWith('/')) {
    fail(state, 'data_root_not_absolute', 'data-root');
  }
  if (raw === '/') {
    fail(state, 'data_root_is_filesystem_root', 'data-root');
  }
  return raw;
}

function parseUnsignedInteger(raw: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

function resolveStartTimeout(scan: ScanResult, state: ParseState): number {
  const raw = takeOption(scan, '--start-timeout-ms');
  if (raw === undefined) {
    return CLI_START_TIMEOUT_DEFAULT_MS;
  }
  const value = parseUnsignedInteger(raw);
  if (value === undefined) {
    fail(state, 'invalid_integer', 'start-timeout-ms');
  }
  if (value < CLI_START_TIMEOUT_MIN_MS || value > CLI_START_TIMEOUT_MAX_MS) {
    fail(state, 'integer_out_of_range', 'start-timeout-ms');
  }
  return value;
}

function requireOption(scan: ScanResult, name: string, state: ParseState, field: string): string {
  const value = takeOption(scan, name);
  if (value === undefined) {
    fail(state, 'missing_required_option', field);
  }
  return value;
}

function requireProjectId(raw: string, state: ParseState, field = 'project'): string {
  if (!isUuidV4(raw)) {
    fail(state, 'invalid_project_id', field);
  }
  return raw;
}

function requireOperationId(raw: string, state: ParseState): string {
  if (!isUuidV4(raw)) {
    fail(state, 'invalid_operation_id', 'operationId');
  }
  return raw;
}

function requireArtifactId(raw: string, state: ParseState): string {
  if (!ARTIFACT_ID_PATTERN.test(raw)) {
    fail(state, 'invalid_artifact_id', 'artifactId');
  }
  return raw;
}

function requireRevision(scan: ScanResult, state: ParseState): number {
  const raw = requireOption(scan, '--revision', state, 'revision');
  const value = parseUnsignedInteger(raw);
  if (value === undefined || value < 1) {
    fail(state, 'invalid_revision', 'revision');
  }
  return value;
}

function optionalCommandId(scan: ScanResult, state: ParseState): string | undefined {
  const raw = takeOption(scan, '--command-id');
  if (raw === undefined) {
    return undefined;
  }
  if (!isUuidV4(raw)) {
    fail(state, 'invalid_command_id', 'command-id');
  }
  return raw;
}

/** 计划摘要（64 位小写 hex；审批绑定身份，不是 CAS 依据）。 */
function requirePlanDigest(scan: ScanResult, state: ParseState): string {
  const raw = requireOption(scan, '--digest', state, 'digest');
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    fail(state, 'invalid_plan_digest', 'digest');
  }
  return raw;
}

/** 通用 SHA-256 摘要选项（64 位小写 hex；用于代码/观察摘要身份）。 */
function requireSha256Option(scan: ScanResult, name: string, state: ParseState, field: string): string {
  const raw = requireOption(scan, name, state, field);
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    fail(state, 'invalid_digest', field);
  }
  return raw;
}

/** 可选 SHA-256 摘要选项（省略即不携带；存在则必须合法）。 */
function optionalSha256Option(scan: ScanResult, name: string, state: ParseState, field: string): string | undefined {
  const raw = takeOption(scan, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    fail(state, 'invalid_digest', field);
  }
  return raw;
}

/** 可选决策原因：不允许 NUL、≤2000 字符（深度语义由服务端复核）。 */
function optionalReason(scan: ScanResult, state: ParseState): string | undefined {
  const raw = takeOption(scan, '--reason');
  if (raw === undefined) {
    return undefined;
  }
  if (raw.includes('\0') || codePointLength(raw) > 2000) {
    fail(state, 'invalid_reason', 'reason');
  }
  return raw;
}

function requireInputFile(scan: ScanResult, state: ParseState): string {
  const raw = requireOption(scan, '--input', state, 'input');
  if (raw.length === 0 || raw.includes('\0')) {
    fail(state, 'invalid_input_file', 'input');
  }
  return raw;
}

/** 计划实体稳定 ID（Phase/Feature/Task；与 HostClient 形态把关同一口径）。 */
function requirePlanId(raw: string, state: ParseState, field: string): string {
  if (!ARTIFACT_ID_PATTERN.test(raw)) {
    fail(state, 'invalid_plan_id', field);
  }
  return raw;
}

/** 计划实体 ID 选项（--phase/--feature）；形态把关不回显值。 */
function requirePlanIdOption(scan: ScanResult, name: string, state: ParseState, field: string): string {
  return requirePlanId(requireOption(scan, name, state, field), state, field);
}

/** Phase 标题：必填非空（深度语义由 Core 单一权威复核）。 */
function resolvePlanTitle(scan: ScanResult, state: ParseState): string {
  const raw = requireOption(scan, '--title', state, 'title');
  if (
    raw.trim().length === 0 ||
    raw.includes('\0') ||
    codePointLength(raw) > PROJECT_DISPLAY_NAME_MAX_LENGTH
  ) {
    fail(state, 'invalid_title', 'title');
  }
  return raw;
}

/** P03-5 / F-012 工作区列表分页：limit 1..500、cursor 非空不透明（深校验由 Core 复核）。 */
function optionalWorkspaceListPage(
  scan: ScanResult,
  state: ParseState,
): { limit?: number; cursor?: string } {
  const limitRaw = takeOption(scan, '--limit');
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const value = parseUnsignedInteger(limitRaw);
    if (value === undefined || value < 1 || value > 500) {
      fail(state, 'invalid_limit', 'limit');
    }
    limit = value;
  }
  const cursor = takeOption(scan, '--cursor');
  if (cursor !== undefined && (cursor.length === 0 || cursor.includes('\0'))) {
    fail(state, 'invalid_cursor', 'cursor');
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** 计划层级列表分页：limit 1..200、cursor 非空不透明（深校验由 Core 复核）。 */
function optionalPlanListPage(
  scan: ScanResult,
  state: ParseState,
): { limit?: number; cursor?: string } {
  const limitRaw = takeOption(scan, '--limit');
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const value = parseUnsignedInteger(limitRaw);
    if (value === undefined || value < 1 || value > PLAN_LIST_LIMIT_MAX) {
      fail(state, 'invalid_limit', 'limit');
    }
    limit = value;
  }
  const cursor = takeOption(scan, '--cursor');
  if (cursor !== undefined && (cursor.length === 0 || cursor.includes('\0'))) {
    fail(state, 'invalid_cursor', 'cursor');
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

/** POSIX 路径规范化（纯字符串运算；不读环境、不读文件系统）。 */
function normalizeAbsolutePath(value: string): string {
  const stack: string[] = [];
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

/**
 * init 仓库路径：相对路径按显式注入的 cwd 解析为绝对输入（契约 §12.2：解析
 * 先于任何 I/O）；无法解析（无合法 cwd）时定位拒绝，不回显路径值。
 */
function resolveRepositoryPath(
  raw: string,
  state: ParseState,
): { repositoryPathInput: string; repositoryPath: string } {
  if (raw.length === 0 || raw.includes('\0')) {
    fail(state, 'invalid_repository_path', 'repositoryPath');
  }
  if (isAbsolutePath(raw)) {
    return { repositoryPathInput: raw, repositoryPath: normalizeAbsolutePath(raw) };
  }
  const cwd = state.cwd;
  if (
    cwd === undefined ||
    cwd.length === 0 ||
    !isAbsolutePath(cwd) ||
    cwd.includes('\0')
  ) {
    fail(state, 'repository_path_requires_cwd', 'repositoryPath');
  }
  return {
    repositoryPathInput: raw,
    repositoryPath: normalizeAbsolutePath(`${cwd}/${raw}`),
  };
}

function resolveInitName(scan: ScanResult, state: ParseState): string | undefined {
  const raw = takeOption(scan, '--name');
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0 || raw.includes('\0') || codePointLength(raw) > PROJECT_DISPLAY_NAME_MAX_LENGTH) {
    fail(state, 'invalid_name', 'name');
  }
  return raw;
}

function resolveInitDescription(scan: ScanResult, state: ParseState): string | undefined {
  const raw = takeOption(scan, '--description');
  if (raw === undefined) {
    return undefined;
  }
  if (raw.includes('\0') || codePointLength(raw) > DESCRIPTION_MAX_LENGTH) {
    fail(state, 'invalid_description', 'description');
  }
  return raw;
}

function resolveScope(
  scan: ScanResult,
  state: ParseState,
): { scope: 'global'; projectId?: undefined } | { scope: 'project'; projectId: string } {
  const raw = requireOption(scan, '--scope', state, 'scope');
  const projectRaw = takeOption(scan, '--project');
  if (raw !== 'global' && raw !== 'project') {
    fail(state, 'invalid_scope', 'scope');
  }
  if (raw === 'global') {
    if (projectRaw !== undefined) {
      fail(state, 'scope_conflict', 'project');
    }
    return { scope: 'global' };
  }
  if (projectRaw === undefined) {
    fail(state, 'project_required_for_scope', 'project');
  }
  return { scope: 'project', projectId: requireProjectId(projectRaw, state) };
}

function baseResult(
  state: ParseState,
  scan: ScanResult,
): {
  kind: 'command';
  command: AppCliCommand;
  commandId: AppCliCommandId;
  json: boolean;
  startTimeoutMs: number;
  dataRoot?: string;
} {
  const dataRoot = resolveDataRoot(scan, state);
  return {
    kind: 'command',
    command: state.command as AppCliCommand,
    commandId: state.commandId as AppCliCommandId,
    json: scan.bools.has('--json'),
    startTimeoutMs: resolveStartTimeout(scan, state),
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  };
}

// ---- 各命令的已解析形态（F-015/F-016/F-017 消费） ----

/**
 * `project init`（契约 §12.1）：静态预览 + 显式确认后才注册。
 * repositoryPath 已是绝对输入（相对路径按注入 cwd 解析）；confirm 是唯一
 * 注册确认入口（显式非交互授权，只覆盖展示的实际请求）。
 */
export interface ParsedProjectInit {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.init';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  /** 用户原样输入的仓库路径。 */
  readonly repositoryPathInput: string;
  /** 解析后的绝对路径（送给 Host/Core 的唯一路径输入）。 */
  readonly repositoryPath: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly labels: readonly string[];
  readonly confirm: boolean;
  readonly explicitCommandId?: string;
}

/** `project overview <projectId>`（契约 §12.1）：注册状态与健康状态分开查询。 */
export interface ParsedProjectOverview {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.overview';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
}

export interface ParsedProjectRegister {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.register';
  readonly operation: 'project.register';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly repositoryPath: string;
  readonly displayName: string;
  readonly description?: string;
  readonly labels: readonly string[];
  readonly explicitCommandId?: string;
}

export interface ParsedProjectList {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly labels: readonly string[];
  readonly match: 'any' | 'all';
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ParsedProjectGet {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
}

export interface ParsedProjectEdit {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.edit';
  readonly operation: 'project.metadata.update';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly revision: number;
  readonly displayName?: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly explicitCommandId?: string;
}

export interface ParsedProjectLabels {
  readonly kind: 'command';
  readonly command: 'project';
  readonly commandId: 'project.labels';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
}

export interface ParsedConfigCreate {
  readonly kind: 'command';
  readonly command: 'config';
  readonly commandId: 'config.create';
  readonly operation: 'settings.global.create' | 'settings.project.create';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

export interface ParsedConfigUpdate {
  readonly kind: 'command';
  readonly command: 'config';
  readonly commandId: 'config.update';
  readonly operation: 'settings.global.update' | 'settings.project.update';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
  readonly revision: number;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

export interface ParsedConfigGet {
  readonly kind: 'command';
  readonly command: 'config';
  readonly commandId: 'config.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
}

export interface ParsedConfigEffective {
  readonly kind: 'command';
  readonly command: 'config';
  readonly commandId: 'config.effective';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
}

export interface ParsedConfigExport {
  readonly kind: 'command';
  readonly command: 'config';
  readonly commandId: 'config.export';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
}

export interface ParsedReceiptGet {
  readonly kind: 'command';
  readonly command: 'receipt';
  readonly commandId: 'receipt.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly targetCommandId: string;
}

export interface ParsedEventsObserve {
  readonly kind: 'command';
  readonly command: 'events';
  readonly commandId: 'events.observe';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
  readonly cursor?: string;
  readonly snapshotOnly: boolean;
  readonly follow: boolean;
}

/**
 * `baseline preview --project <id> --input <file>`（契约 §12.1）：只读预览。
 * `--input` 是本次请求的检查计划 JSON 路径；文件内容校验在纯面层
 * `parseBaselineCheckPlanText`（F-015），解析失败在任何 I/O 之前拒绝。
 */
export interface ParsedBaselinePreview {
  readonly kind: 'command';
  readonly command: 'baseline';
  readonly commandId: 'baseline.preview';
  readonly operation: 'baseline.preview';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly inputFile: string;
}

/**
 * `baseline run --project <id> --input <file> (--confirm | --decline)`（§12.1）：
 * 独立授权入口——`--confirm`/`--decline` 互斥且必居其一（同时或缺席均退出 2），
 * 与 `project init --confirm` 的注册确认严格分开（确认注册不隐含确认基线）。
 */
export interface ParsedBaselineRun {
  readonly kind: 'command';
  readonly command: 'baseline';
  readonly commandId: 'baseline.run';
  readonly operation: 'baseline.run';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly inputFile: string;
  /** --confirm → authorize；--decline → decline（记录 not_run）。 */
  readonly decision: 'authorize' | 'decline';
  readonly wait: boolean;
  readonly follow: boolean;
  readonly explicitCommandId?: string;
}

/** `baseline list --project <id> [--limit <int>] [--cursor <id>]`（§7.4 分页）。 */
export interface ParsedBaselineList {
  readonly kind: 'command';
  readonly command: 'baseline';
  readonly commandId: 'baseline.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `baseline status <operationId>`（§7.5 操作详情）。 */
export interface ParsedBaselineStatus {
  readonly kind: 'command';
  readonly command: 'baseline';
  readonly commandId: 'baseline.status';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly operationId: string;
}

/** `baseline cancel <operationId> --confirm`（唯一取消途径；必须显式）。 */
export interface ParsedBaselineCancel {
  readonly kind: 'command';
  readonly command: 'baseline';
  readonly commandId: 'baseline.cancel';
  readonly operation: 'baseline.cancel';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly operationId: string;
  readonly explicitCommandId?: string;
}

/** `baseline evidence <artifactId>`（§7.6 证据内容读取）。 */
export interface ParsedBaselineEvidence {
  readonly kind: 'command';
  readonly command: 'baseline';
  readonly commandId: 'baseline.evidence';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly artifactId: string;
}

/* ---- P03-1 / F-010 计划命令（phase/feature/task） ---- */

/** `phase create --project <id> --title <t> [...]`：建立 open Phase。 */
interface ParsedGraphCommandBase {
  readonly kind: 'command';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly explicitCommandId?: string;
}
export interface ParsedPhaseMutation extends ParsedGraphCommandBase {
  readonly command: 'phase';
  readonly commandId: 'phase.update' | 'phase.close' | 'phase.reopen' | 'phase.archive';
  readonly phaseId: string;
  readonly revision: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
}
export interface ParsedPhaseGraph extends ParsedGraphCommandBase {
  readonly command: 'phase';
  readonly commandId: 'phase.graph';
  readonly phaseId: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ParsedFeatureMove extends ParsedGraphCommandBase {
  readonly command: 'feature';
  readonly commandId: 'feature.move';
  readonly featureId: string;
  readonly revision: number;
  readonly sourcePhaseId: string;
  readonly targetPhaseId: string;
  readonly sourcePhaseRevision: number;
  readonly targetPhaseRevision: number;
}
export interface ParsedFeatureDependencies extends ParsedGraphCommandBase {
  readonly command: 'feature';
  readonly commandId: 'feature.dependencies';
  readonly phaseId: string;
  readonly revision: number;
  readonly inputFile: string;
}
export interface ParsedPhaseCreate {
  readonly kind: 'command';
  readonly command: 'phase';
  readonly commandId: 'phase.create';
  readonly operation: 'phase.create';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly labels: readonly string[];
  readonly explicitCommandId?: string;
}

/** `phase list --project <id> [--limit <int>] [--cursor <c>]`：层级分页。 */
export interface ParsedPhaseList {
  readonly kind: 'command';
  readonly command: 'phase';
  readonly commandId: 'phase.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `phase get <phaseId>`：Phase 详情。 */
export interface ParsedPhaseGet {
  readonly kind: 'command';
  readonly command: 'phase';
  readonly commandId: 'phase.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly phaseId: string;
}

/**
 * 计划实体纯标签编辑（phase/feature/task labels）：`--revision` 是目标实体
 * 自身 revision 的唯一 CAS 入口；`--label` 可重复，省略即清空（整体替换）。
 */
export interface ParsedPlanLabels {
  readonly kind: 'command';
  readonly command: 'phase' | 'feature' | 'task';
  readonly commandId: 'phase.labels' | 'feature.labels' | 'task.labels';
  readonly operation: 'plan.labels.update';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly entityType: 'phase' | 'feature' | 'task';
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly labels: readonly string[];
  readonly explicitCommandId?: string;
}

/**
 * `feature import --project <id> --phase <id> --revision <int> --input <file>`：
 * 单 Feature 草稿计划导入（`--revision` 是 Phase 聚合 CAS；`--input` 是本次
 * 请求的计划 JSON，有界 UTF-8 受控读取，不执行文件内容）。
 */
export interface ParsedFeatureImport {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.import';
  readonly operation: 'feature.plan.import';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly revision: number;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

/** `feature list --project <id> --phase <id> [...]`：Phase 内 Feature 分页。 */
export interface ParsedFeatureList {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `feature get <featureId>`：Feature 详情与完整同 Feature Task DAG。 */
export interface ParsedFeatureGet {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly featureId: string;
}

/**
 * `feature revise <featureId> --project <id> --revision <int> --input <file>`：
 * 未执行草稿的实质计划修订（`--revision` 是 Feature 聚合 CAS）。
 */
export interface ParsedFeatureRevise {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.revise';
  readonly operation: 'feature.plan.revise';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly revision: number;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

/** `task list --project <id> --feature <id> [...]`：Feature 内 Task 分页。 */
export interface ParsedTaskList {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `task get <taskId>`：Task 详情（验收/引用/策略副本与来源）。 */
export interface ParsedTaskGet {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly taskId: string;
}

/**
 * P03-2 / F-008 计划批准/拒绝（feature.plan.decide）：`--digest` 是提交时
 * 绑定的当前计划摘要（64 位小写 hex，审批绑定身份不是 CAS 依据），
 * `--revision` 是 Feature 聚合 expectedRevision（唯一 CAS 入口）；decision 由
 * 子命令给定（approve/reject），不接受请求侧身份/状态字段。
 */
export interface ParsedFeatureDecision {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.approve' | 'feature.reject';
  readonly operation: 'feature.plan.decide';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly revision: number;
  readonly reason?: string;
  readonly explicitCommandId?: string;
}

/**
 * `task strategy <taskId> --project <id> --revision <int> --input <file>`：
 * 完整策略副本 CAS 编辑（task.strategy.update；来源由服务端定值 task_edit，
 * 不接受请求声明）；`--input` 是完整 executionConfig JSON（有界受控读取）。
 */
export interface ParsedTaskStrategy {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.strategy';
  readonly operation: 'task.strategy.update';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

/**
 * `task prepare <taskId> --project <id> --feature <id> --input <file>`：
 * 固定输入制品组准备（execution.input.prepare；创建类不携带 expectedRevision）；
 * `--input` 是 `{items: [...]}` 必需输入采集清单（必填——缺失必需输入必须
 * 显式声明，空清单由服务端明确拒绝）。
 */
export interface ParsedTaskPrepare {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.prepare';
  readonly operation: 'execution.input.prepare';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

/**
 * `task inputs <commandId>`：固定输入查看——沿用既有回执查询流程（receipts.get）
 * 读取 execution.input.prepare 制品组身份（version/hash/用途），不新增查询面、
 * 不读任何正文。
 */
export interface ParsedTaskInputs {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.inputs';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly targetCommandId: string;
}

/** `task status <taskId> --project <id>`：机器结论/人审待处理/有效 Task 状态三分区只读展示。 */
export interface ParsedTaskStatus {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.status';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly taskId: string;
}

/**
 * P03-7 / F-014 添加阻塞/必需审批事项（task.approval.block）：`--digest` 绑定
 * 当前计划摘要，`--revision` 为 Task 自身 expectedRevision；`--party` 是业务
 * 责任主体名（不是认证身份）；`--artifact` 可重复（<artifactId[:sha256]>）。
 * 不接受任何主体/凭据参数（伪造主体/明文凭据在解析层就是未知参数）。
 */
export interface ParsedTaskApprovalBlock {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.block';
  readonly operation: 'task.approval.block';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly planDigest: string;
  readonly revision: number;
  readonly kindOption?: 'block' | 'approval';
  readonly description?: string;
  readonly responsibleParty?: string;
  readonly codeDigest?: string;
  readonly artifactRefs: readonly string[];
  readonly explicitCommandId?: string;
}

/**
 * P03-7 / F-014 事项决定（task.approval.approve/reject/unblock）：决定由子命令
 * 给定并绑定 planDigest/codeDigest/产物摘要；decisionActor 等身份不接受参数。
 */
export interface ParsedTaskApprovalDecision {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.approve' | 'task.reject' | 'task.unblock';
  readonly operation:
    | 'task.approval.approve'
    | 'task.approval.reject'
    | 'task.approval.unblock';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly itemId: string;
  readonly planDigest: string;
  readonly codeDigest: string;
  readonly revision: number;
  readonly reason?: string;
  readonly artifactRefs: readonly string[];
  readonly explicitCommandId?: string;
}

/**
 * P03-7 / F-014 显式验证继续（task.verification.continue）：只携带目标与已
 * 保存机器证据身份（批次/代码/观察摘要）；漂移由服务端 fail-closed 拒绝。
 */
export interface ParsedTaskVerificationContinue {
  readonly kind: 'command';
  readonly command: 'task';
  readonly commandId: 'task.continue';
  readonly operation: 'task.verification.continue';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly verificationBatchId: string;
  readonly codeDigest: string;
  readonly observationDigest: string;
  readonly revision: number;
  readonly explicitCommandId?: string;
}

/**
 * P03-3 / F-012 执行预览（execution.preview；只读授权预览）：固定单 Feature +
 * 完整有限预算（`--input` 预算文档，参数映射见 app/execution.ts）；预览不是
 * 授权，不创建执行实体。
 */
export interface ParsedExecutionPreview {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.preview';
  readonly operation: 'execution.preview';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

/**
 * 显式执行启动（execution.start）：新授权形态需要 `--input` 完整有限预算 +
 * `--preview-digest`（用户确认的预览摘要）+ `--confirm` 明确确认；同父 Batch
 * 显式重试形态只携带 `--retry-batch`（与预算/预览摘要互斥，同现即冲突参数）。
 * 缺失确认/缺少预算/冲突参数在任何 I/O 之前拒绝（不发启动请求）。
 */
export interface ParsedExecutionStart {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.start';
  readonly operation: 'execution.start';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly confirm: true;
  readonly inputFile?: string;
  readonly previewDigest?: string;
  readonly retryBatchId?: string;
  readonly explicitCommandId?: string;
}

/** Batch 预算状态 + 修订历史只读查询（execution.budget；不扣预算不唤醒执行）。 */
export interface ParsedExecutionBudget {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.budget';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * P03-4 / F-009 Run 调度诊断只读查询（execution.schedule；经 HostClient
 * execution.run.schedule）：派生就绪评估 + 逐任务阻塞原因 + 占用审计，
 * 不认领、不扣额、不唤醒执行。
 */
export interface ParsedExecutionSchedule {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.schedule';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly runId: string;
}

/** P03-4 / F-009 Task 的 Attempt 审计分页查询（execution.attempts）。 */
export interface ParsedExecutionAttempts {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.attempts';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** P03-4 / F-009 Attempt 迟到/越权通知诊断审计分页查询（execution.diagnostics）。 */
export interface ParsedExecutionDiagnostics {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.diagnostics';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * P04-9 / F-009 派发队列与执行槽位只读查询（execution.dispatch；经 HostClient
 * execution.dispatch.list）：项目有界分页 + 槽位摘要，不认领、不扣额、
 * 不唤醒执行、不释放或改写槽位。
 */
export interface ParsedExecutionDispatch {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.dispatch';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * P03-6 / F-013 Work Session 列表（execution.sessions.list）：父级 Run/Task
 * 二选一（--run/--task，同现或缺失均本地拒绝）；有界分页同计划列表。
 */
export interface ParsedExecutionSessions {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.sessions';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** P03-6 / F-013 Work Session 详情（execution.session.get；含 Runtime 结果/停止证据）。 */
export interface ParsedExecutionSession {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.session';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly attemptId: string;
}

/** P03-6 / F-013 诊断证据正文（execution.session.evidence.get；只按稳定身份取成员制品）。 */
export interface ParsedExecutionSessionEvidence {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.session-evidence';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly artifactId: string;
}

/**
 * P04-5 / F-007 Work 公开记录索引（execution.recording.list）：父级
 * Run/Attempt/Session 三选一；recordType 只接受 messages|manifests；
 * 有界分页同计划列表。
 */
export interface ParsedExecutionRecordings {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.recordings';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly recordType: 'messages' | 'manifests';
  readonly limit?: number;
  readonly cursor?: string;
}

/** P04-5 / F-007 记录正文（execution.recording.body.get；成员身份由 Host/Core 核验）。 */
export interface ParsedExecutionRecordingBody {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.recording-body';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly artifactId: string;
}

/**
 * P03-6 / F-013 Attempt 显式取消（execution.attempt.cancel）：缺 --confirm 在
 * 任何 I/O 之前本地拒绝；`--command-id` 复用原信封幂等重放（响应丢失先查回执，
 * 不更换命令身份、不额外启动工作）。
 */
export interface ParsedExecutionCancel {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.cancel';
  readonly operation: 'execution.attempt.cancel';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly confirm: true;
  readonly explicitCommandId?: string;
}

/** P03-9 / F-015 Run/Batch 级控制目标（pause/cancel/resume 同一目标形态）。 */
export interface ParsedExecutionControlTarget {
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
  readonly expectedRevision: number;
}

/**
 * P03-9 / F-015 Run/Batch 级取消（Host 操作 execution.cancel）：创建持久停止
 * operation；与 Attempt 取消共用 `execution cancel` 子命令路径，以目标形态区分：
 * 无 positional + --run/--batch + --revision + --confirm。
 */
export interface ParsedExecutionTargetCancel extends ParsedExecutionControlTarget {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.cancel';
  readonly operation: 'execution.cancel';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly confirm: true;
  readonly explicitCommandId?: string;
}

/** P03-9 / F-015 Run/Batch 级暂停（execution.pause）：登记暂停意图，非终态。 */
export interface ParsedExecutionPause extends ParsedExecutionControlTarget {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.pause';
  readonly operation: 'execution.pause';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly explicitCommandId?: string;
}

/**
 * P03-9 / F-015 工作流显式继续（execution.resume）：payload 只携带目标与
 * revision CAS；恢复模式 auto/new/required 由 Task 策略/输入快照决定，不经
 * 命令注入（工作流 resume ≠ Runtime/SDK 原生续接）。
 */
export interface ParsedExecutionResume extends ParsedExecutionControlTarget {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.resume';
  readonly operation: 'execution.resume';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly explicitCommandId?: string;
}

/**
 * P03-9 / F-015 仅收尾重试（execution.retryFinal）：显式指定历史终态 Run、
 * 同 Feature 与其 workKey；预算/新 Run 身份/scope 由服务端根据持久证据计算。
 */
export interface ParsedExecutionRetryFinal {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.retry-final';
  readonly operation: 'execution.retryFinal';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly historicalRunId: string;
  readonly workKey: string;
  readonly explicitCommandId?: string;
}

/** P03-9 / F-015 Run 控制诊断（execution.run.control.get；只读）。 */
export interface ParsedExecutionControl {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.control';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly runId: string;
}

/** P03-9 / F-015 Batch 控制诊断（execution.batch.control.get；只读）。 */
export interface ParsedExecutionBatchControl {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.batch-control';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly batchId: string;
}

/** P03-9 / F-015 Run 恢复诊断（execution.run.recovery.get；只读）。 */
export interface ParsedExecutionRecovery {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.recovery';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly runId: string;
}

/**
 * P03-5 / F-012 工作区列表（workspaces.list）：项目内受管工作区键集分页
 *（只读；`--feature` 可选过滤；limit 默认 100、上限 500，cursor 为 wscur_v1_
 * 不透明游标）。
 */
export interface ParsedWorkspaceList {
  readonly kind: 'command';
  readonly command: 'workspace';
  readonly commandId: 'workspace.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `workspace get <featureId>`：工作区详情（准备/保留/复用/隔离/清理原因）。 */
export interface ParsedWorkspaceGet {
  readonly kind: 'command';
  readonly command: 'workspace';
  readonly commandId: 'workspace.get';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
}

/** 工作区 operation 审计分页（workspace.operations.list；只读）。 */
export interface ParsedWorkspaceOperations {
  readonly kind: 'command';
  readonly command: 'workspace';
  readonly commandId: 'workspace.operations';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `workspace operation <operationId>`：单次 operation 详情与当前回执投影。 */
export interface ParsedWorkspaceOperationGet {
  readonly kind: 'command';
  readonly command: 'workspace';
  readonly commandId: 'workspace.operation';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly operationId: string;
}

/**
 * 人工丢弃只读预览（workspace.discard.preview）：预览不是删除，completed 回执
 * 携带绑定摘要/有界内容清单/不可逆影响与证据引用；确认必须另行显式
 * `workspace discard --preview-file <file> --confirm`。
 */
export interface ParsedWorkspaceDiscardPreview {
  readonly kind: 'command';
  readonly command: 'workspace';
  readonly commandId: 'workspace.discard-preview';
  readonly operation: 'workspace.discard.preview';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly explicitCommandId?: string;
}

/**
 * 人工确认丢弃（workspace.discard）：`--preview-file` 是本次确认的丢弃预览
 * JSON（有界受控读取；预览摘要绑定在任何 I/O 前本地核验），`--confirm` 是
 * 显式非交互确认——缺确认或缺预览摘要在连接 Host 之前拒绝，不隐式预览后
 * 自动同意。
 */
export interface ParsedWorkspaceDiscard {
  readonly kind: 'command';
  readonly command: 'workspace';
  readonly commandId: 'workspace.discard';
  readonly operation: 'workspace.discard';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly previewFile: string;
  readonly confirm: true;
  readonly explicitCommandId?: string;
}

/**
 * 预算显式修订（execution.budget.revise）：`--revision` 是目标 Batch 当前
 * budget_revision（唯一 CAS 入口），`--reason` 必填；`--input` 是完整有限预算。
 */
export interface ParsedExecutionRevise {
  readonly kind: 'command';
  readonly command: 'execution';
  readonly commandId: 'execution.revise';
  readonly operation: 'execution.budget.revise';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly revision: number;
  readonly reason: string;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

/**
 * P03-8 / F-011 Feature 分轴结果只读查询（features.delivery.get）：Task/最终
 * 检查/人工审批/交付分轴与总体 outcome；纯查询，不推进任何收尾。
 */
export interface ParsedFeatureDelivery {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.delivery' | 'feature.report';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
}

/**
 * P03-8 / F-011 Feature 最终审批（task.approval.approve 既有授权命令）：决定
 * 绑定当前计划/代码摘要（`--digest`/`--code-digest` 必填），`--revision` 是
 * 事项 expectedRevision；必须 `--confirm` 明确确认，缺确认在任何 I/O 之前
 * 拒绝。批准不自动运行最终检查或提交。
 */
export interface ParsedFeatureFinalApprove {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.final-approve';
  readonly operation: 'task.approval.approve';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly itemId: string;
  readonly planDigest: string;
  readonly codeDigest: string;
  readonly revision: number;
  readonly confirm: true;
  readonly reason?: string;
  readonly artifactRefs: readonly string[];
  readonly explicitCommandId?: string;
}

/**
 * P03-8 / F-011 显式收尾请求（feature.verification.continue 既有授权命令）：
 * `--revision` 是 Feature 聚合 expectedRevision；`--operation` 是 UUID v4 的
 * Git 操作身份；必须 `--confirm` 明确确认。命令 completed 只表示收尾请求已
 * 处理，是否交付以 outcome/deliveryStatus 与 feature delivery 查询为准。
 */
export interface ParsedFeatureFinalize {
  readonly kind: 'command';
  readonly command: 'feature';
  readonly commandId: 'feature.finalize';
  readonly operation: 'feature.verification.continue';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly operationId: string;
  readonly revision: number;
  readonly confirm: true;
  readonly explicitCommandId?: string;
}

/**
 * P03-8 / F-011 Git 操作分页查询（git.operations.list）：父级 Feature/Run
 * 二选一（同现或缺失均本地拒绝）；有界分页同计划列表。只读，不执行 Git。
 */
export interface ParsedGitOperations {
  readonly kind: 'command';
  readonly command: 'git';
  readonly commandId: 'git.operations';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId?: string;
  readonly runId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** P03-8 / F-011 单条 Git 操作详情（git.operations.get；意图 + 实际事实 + 回执投影）。 */
export interface ParsedGitOperationGet {
  readonly kind: 'command';
  readonly command: 'git';
  readonly commandId: 'git.operation';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly operationId: string;
}

export interface ParsedPlanningStart {
  readonly kind: 'command';
  readonly command: 'planning';
  readonly commandId: 'planning.start';
  readonly operation: 'planning.start';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly revision: number;
  readonly inputFile: string;
  readonly explicitCommandId?: string;
}

export interface ParsedPlanningList {
  readonly kind: 'command';
  readonly command: 'planning';
  readonly commandId: 'planning.list';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly featureId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ParsedPlanningGet {
  readonly kind: 'command';
  readonly command: 'planning';
  readonly commandId: 'planning.get' | 'planning.candidate';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly candidateId: string;
}

export interface ParsedPlanningDecision {
  readonly kind: 'command';
  readonly command: 'planning';
  readonly commandId: 'planning.approve' | 'planning.reject';
  readonly operation: 'planning.candidate.decide';
  readonly json: boolean;
  readonly startTimeoutMs: number;
  readonly dataRoot?: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly revision: number;
  readonly reason?: string;
  readonly explicitCommandId?: string;
}

export type ParsedAppCliCommand =
  | ParsedPlanningStart
  | ParsedPlanningList
  | ParsedPlanningGet
  | ParsedPlanningDecision
  | ParsedProjectInit
  | ParsedProjectOverview
  | ParsedProjectRegister
  | ParsedProjectList
  | ParsedProjectGet
  | ParsedProjectEdit
  | ParsedProjectLabels
  | ParsedConfigCreate
  | ParsedConfigUpdate
  | ParsedConfigGet
  | ParsedConfigEffective
  | ParsedConfigExport
  | ParsedReceiptGet
  | ParsedEventsObserve
  | ParsedBaselinePreview
  | ParsedBaselineRun
  | ParsedBaselineList
  | ParsedBaselineStatus
  | ParsedBaselineCancel
  | ParsedBaselineEvidence
  | ParsedPhaseCreate
  | ParsedPhaseMutation
  | ParsedPhaseGraph
  | ParsedFeatureMove
  | ParsedFeatureDependencies
  | ParsedPhaseList
  | ParsedPhaseGet
  | ParsedPlanLabels
  | ParsedFeatureImport
  | ParsedFeatureList
  | ParsedFeatureGet
  | ParsedFeatureRevise
  | ParsedFeatureDecision
  | ParsedTaskList
  | ParsedTaskGet
  | ParsedTaskStrategy
  | ParsedTaskPrepare
  | ParsedTaskInputs
  | ParsedTaskStatus
  | ParsedTaskApprovalBlock
  | ParsedTaskApprovalDecision
  | ParsedTaskVerificationContinue
  | ParsedExecutionPreview
  | ParsedExecutionStart
  | ParsedExecutionBudget
  | ParsedExecutionRevise
  | ParsedExecutionSchedule
  | ParsedExecutionAttempts
  | ParsedExecutionDiagnostics
  | ParsedExecutionDispatch
  | ParsedExecutionSessions
  | ParsedExecutionSession
  | ParsedExecutionSessionEvidence
  | ParsedExecutionRecordings
  | ParsedExecutionRecordingBody
  | ParsedExecutionCancel
  | ParsedExecutionTargetCancel
  | ParsedExecutionPause
  | ParsedExecutionResume
  | ParsedExecutionRetryFinal
  | ParsedExecutionControl
  | ParsedExecutionBatchControl
  | ParsedExecutionRecovery
  | ParsedWorkspaceList
  | ParsedWorkspaceGet
  | ParsedWorkspaceOperations
  | ParsedWorkspaceOperationGet
  | ParsedWorkspaceDiscardPreview
  | ParsedWorkspaceDiscard
  | ParsedFeatureDelivery
  | ParsedFeatureFinalApprove
  | ParsedFeatureFinalize
  | ParsedGitOperations
  | ParsedGitOperationGet;

export interface ParsedAppCliHelp {
  readonly kind: 'help';
  readonly scope: AppHelpScope;
}

export type ParsedAppCli = ParsedAppCliCommand | ParsedAppCliHelp;

function buildProject(scan: ScanResult, state: ParseState, spec: AppCommandSpec): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  switch (spec.commandId) {
    case 'project.init': {
      const { repositoryPathInput, repositoryPath } = resolveRepositoryPath(
        scan.positionals[0] as string,
        state,
      );
      const displayName = resolveInitName(scan, state);
      const description = resolveInitDescription(scan, state);
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'project',
        commandId: 'project.init',
        repositoryPathInput,
        repositoryPath,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        labels: takeLabels(scan, state),
        confirm: scan.bools.has('--confirm'),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'project.overview': {
      return {
        ...base,
        command: 'project',
        commandId: 'project.overview',
        projectId: requireProjectId(scan.positionals[0] as string, state),
      };
    }
    case 'project.register': {
      const repositoryPath = scan.positionals[0] as string;
      if (repositoryPath.length === 0 || repositoryPath.includes('\0')) {
        fail(state, 'invalid_repository_path', 'repositoryPath');
      }
      const displayName = requireOption(scan, '--name', state, 'name');
      if (displayName.length === 0) {
        fail(state, 'invalid_name', 'name');
      }
      const description = takeOption(scan, '--description');
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'project',
        commandId: 'project.register',
        operation: 'project.register',
        repositoryPath,
        displayName,
        ...(description !== undefined ? { description } : {}),
        labels: takeLabels(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'project.list': {
      const matchRaw = takeOption(scan, '--match');
      const match = matchRaw ?? 'any';
      if (match !== 'any' && match !== 'all') {
        fail(state, 'invalid_match', 'match');
      }
      const limitRaw = takeOption(scan, '--limit');
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        const value = parseUnsignedInteger(limitRaw);
        if (value === undefined || value < 1 || value > 200) {
          fail(state, 'invalid_limit', 'limit');
        }
        limit = value;
      }
      const cursor = takeOption(scan, '--cursor');
      if (cursor !== undefined && (cursor.length === 0 || cursor.includes('\0'))) {
        fail(state, 'invalid_cursor', 'cursor');
      }
      return {
        ...base,
        command: 'project',
        commandId: 'project.list',
        labels: takeLabels(scan, state),
        match,
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      };
    }
    case 'project.get': {
      return {
        ...base,
        command: 'project',
        commandId: 'project.get',
        projectId: requireProjectId(scan.positionals[0] as string, state),
      };
    }
    case 'project.edit': {
      const displayName = takeOption(scan, '--name');
      if (displayName !== undefined && displayName.length === 0) {
        fail(state, 'invalid_name', 'name');
      }
      const description = takeOption(scan, '--description');
      const labelsRaw = scan.options.get('--label');
      const labels =
        labelsRaw === undefined ? undefined : takeLabels(scan, state);
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'project',
        commandId: 'project.edit',
        operation: 'project.metadata.update',
        projectId: requireProjectId(scan.positionals[0] as string, state),
        revision: requireRevision(scan, state),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'project.labels': {
      return { ...base, command: 'project', commandId: 'project.labels' };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

function buildConfig(scan: ScanResult, state: ParseState, spec: AppCommandSpec): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  switch (spec.commandId) {
    case 'config.create': {
      const { scope, projectId } = resolveScope(scan, state);
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'config',
        commandId: 'config.create',
        operation: scope === 'global' ? 'settings.global.create' : 'settings.project.create',
        scope,
        ...(projectId !== undefined ? { projectId } : {}),
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'config.update': {
      const revision = requireRevision(scan, state);
      const { scope, projectId } = resolveScope(scan, state);
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'config',
        commandId: 'config.update',
        operation: scope === 'global' ? 'settings.global.update' : 'settings.project.update',
        scope,
        ...(projectId !== undefined ? { projectId } : {}),
        revision,
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'config.get': {
      const { scope, projectId } = resolveScope(scan, state);
      return {
        ...base,
        command: 'config',
        commandId: 'config.get',
        scope,
        ...(projectId !== undefined ? { projectId } : {}),
      };
    }
    case 'config.effective': {
      const projectId = requireProjectId(
        requireOption(scan, '--project', state, 'project'),
        state,
      );
      return { ...base, command: 'config', commandId: 'config.effective', projectId };
    }
    case 'config.export': {
      const { scope, projectId } = resolveScope(scan, state);
      return {
        ...base,
        command: 'config',
        commandId: 'config.export',
        scope,
        ...(projectId !== undefined ? { projectId } : {}),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

function buildReceipt(scan: ScanResult, state: ParseState, spec: AppCommandSpec): ParsedReceiptGet {
  assertPositionals(scan, spec, state);
  const targetCommandId = scan.positionals[0] as string;
  if (!isUuidV4(targetCommandId)) {
    fail(state, 'invalid_command_id', 'commandId');
  }
  const base = baseResult(state, scan);
  return { ...base, command: 'receipt', commandId: 'receipt.get', targetCommandId };
}

function buildEvents(scan: ScanResult, state: ParseState, spec: AppCommandSpec): ParsedEventsObserve {
  assertPositionals(scan, spec, state);
  const global = scan.bools.has('--global');
  const projectRaw = takeOption(scan, '--project');
  if (global && projectRaw !== undefined) {
    fail(state, 'scope_conflict', 'project');
  }
  if (!global && projectRaw === undefined) {
    fail(state, 'missing_required_option', 'scope');
  }
  const snapshotOnly = scan.bools.has('--snapshot-only');
  const followFlag = scan.bools.has('--follow');
  if (snapshotOnly && followFlag) {
    fail(state, 'conflicting_options');
  }
  const cursor = takeOption(scan, '--cursor');
  if (cursor !== undefined && (cursor.length === 0 || cursor.includes('\0'))) {
    fail(state, 'invalid_cursor', 'cursor');
  }
  const base = baseResult(state, scan);
  if (global) {
    return {
      ...base,
      command: 'events',
      commandId: 'events.observe',
      scope: 'global',
      snapshotOnly,
      follow: !snapshotOnly,
      ...(cursor !== undefined ? { cursor } : {}),
    };
  }
  return {
    ...base,
    command: 'events',
    commandId: 'events.observe',
    scope: 'project',
    projectId: requireProjectId(projectRaw as string, state),
    snapshotOnly,
    follow: !snapshotOnly,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/**
 * 基线子命令（契约 §12.1/§12.2）：预览/确认/启动/状态/历史分页/显式取消/证据。
 * 决策参数（--confirm/--decline）与注册确认严格分开：`project init --confirm`
 * 不隐含任何基线授权，基线运行必须自带显式决策（互斥且必居其一）。
 */
function buildBaseline(scan: ScanResult, state: ParseState, spec: AppCommandSpec): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  switch (spec.commandId) {
    case 'baseline.preview': {
      const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
      return {
        ...base,
        command: 'baseline',
        commandId: 'baseline.preview',
        operation: 'baseline.preview',
        projectId,
        inputFile: requireInputFile(scan, state),
      };
    }
    case 'baseline.run': {
      const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
      const inputFile = requireInputFile(scan, state);
      const confirm = scan.bools.has('--confirm');
      const decline = scan.bools.has('--decline');
      if (confirm && decline) {
        fail(state, 'conflicting_options', 'decision');
      }
      if (!confirm && !decline) {
        fail(state, 'missing_required_option', 'decision');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'baseline',
        commandId: 'baseline.run',
        operation: 'baseline.run',
        projectId,
        inputFile,
        decision: confirm ? 'authorize' : 'decline',
        wait: scan.bools.has('--wait'),
        follow: scan.bools.has('--follow'),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'baseline.list': {
      const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
      const limitRaw = takeOption(scan, '--limit');
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        const value = parseUnsignedInteger(limitRaw);
        if (value === undefined || value < 1 || value > BASELINE_LIST_LIMIT_MAX) {
          fail(state, 'invalid_baseline_limit', 'limit');
        }
        limit = value;
      }
      const cursor = takeOption(scan, '--cursor');
      if (cursor !== undefined && (cursor.length === 0 || cursor.includes('\0'))) {
        fail(state, 'invalid_cursor', 'cursor');
      }
      return {
        ...base,
        command: 'baseline',
        commandId: 'baseline.list',
        projectId,
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      };
    }
    case 'baseline.status': {
      return {
        ...base,
        command: 'baseline',
        commandId: 'baseline.status',
        operationId: requireOperationId(scan.positionals[0] as string, state),
      };
    }
    case 'baseline.cancel': {
      const operationId = requireOperationId(scan.positionals[0] as string, state);
      if (!scan.bools.has('--confirm')) {
        fail(state, 'missing_required_option', 'confirm');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'baseline',
        commandId: 'baseline.cancel',
        operation: 'baseline.cancel',
        operationId,
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'baseline.evidence': {
      return {
        ...base,
        command: 'baseline',
        commandId: 'baseline.evidence',
        artifactId: requireArtifactId(scan.positionals[0] as string, state),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

/** 计划实体标签子命令的目标实体类型（由命令身份前缀派生，不另设参数）。 */
function planLabelsEntityType(
  commandId: 'phase.labels' | 'feature.labels' | 'task.labels',
): 'phase' | 'feature' | 'task' {
  return commandId.split('.')[0] as 'phase' | 'feature' | 'task';
}

/** 执行批次稳定身份（UUID v4；服务端派发的 Batch 身份，不接受任意字符串）。 */
function requireBatchId(raw: string, state: ParseState): string {
  if (!isUuidV4(raw)) {
    fail(state, 'invalid_batch_id', 'batchId');
  }
  return raw;
}

/** Run 稳定身份（UUID v4；服务端派发，P03-4 / F-009 调度诊断查询目标）。 */
function requireRunId(raw: string, state: ParseState): string {
  if (!isUuidV4(raw)) {
    fail(state, 'invalid_run_id', 'runId');
  }
  return raw;
}

/** Attempt 稳定身份（UUID v4；服务端派发，P03-4 / F-009 诊断审计查询目标）。 */
function requireAttemptId(raw: string, state: ParseState): string {
  if (!isUuidV4(raw)) {
    fail(state, 'invalid_attempt_id', 'attemptId');
  }
  return raw;
}

/** Session 稳定身份（P04-5 / F-007 公开记录父级；稳定 ID 模式，不是任意路径）。 */
function requireSessionId(raw: string, state: ParseState): string {
  if (!ARTIFACT_ID_PATTERN.test(raw)) {
    fail(state, 'invalid_session_id', 'sessionId');
  }
  return raw;
}

/** 执行预算文件（缺失即缺少预算；形态校验在 app/execution.ts 纯层）。 */
function requireBudgetFile(scan: ScanResult, state: ParseState): string {
  const raw = takeOption(scan, '--input');
  if (raw === undefined) {
    fail(state, 'missing_budget', 'input');
  }
  if (raw.length === 0 || raw.includes('\0')) {
    fail(state, 'invalid_input_file', 'input');
  }
  return raw;
}

/** 用户确认的预览摘要（64 位小写 hex；启动授权的身份依据，不是命令幂等身份）。 */
function requirePreviewDigest(scan: ScanResult, state: ParseState): string {
  const raw = requireOption(scan, '--preview-digest', state, 'preview-digest');
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    fail(state, 'invalid_preview_digest', 'preview-digest');
  }
  return raw;
}

/** 预算修订理由（必填非空；不允许 NUL、≤2000 码点；深度语义由服务端复核）。 */
function requireReason(scan: ScanResult, state: ParseState): string {
  const raw = requireOption(scan, '--reason', state, 'reason');
  if (raw.trim().length === 0 || raw.includes('\0') || codePointLength(raw) > 2000) {
    fail(state, 'invalid_reason', 'reason');
  }
  return raw;
}

/**
 * P03-3 / F-012 执行授权命令（execution preview/start/budget/revise）：固定单
 * Feature 显式授权、完整有限预算参数映射、预算查询与显式修订；不实现本 Feature
 * 之外的 wait/cancel/resume；`task prepare` 不经本面升级为授权。
 */
function buildExecution(
  scan: ScanResult,
  state: ParseState,
  spec: AppCommandSpec,
): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  switch (spec.commandId) {
    case 'execution.preview': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.preview',
        operation: 'execution.preview',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        inputFile: requireBudgetFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'execution.start': {
      const explicitCommandId = optionalCommandId(scan, state);
      // 明确确认先于一切：缺 --confirm 即输入错误（不发启动请求）。
      if (!scan.bools.has('--confirm')) {
        fail(state, 'confirmation_required', 'confirm');
      }
      const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
      const featureId = requirePlanId(scan.positionals[0] as string, state, 'featureId');
      const retryBatchId = takeOption(scan, '--retry-batch');
      if (retryBatchId !== undefined) {
        // 重试形态与新授权形态互斥（冲突参数拒绝，不发启动请求）。
        if (scan.options.has('--input') || scan.options.has('--preview-digest')) {
          fail(state, 'conflicting_options');
        }
        return {
          ...base,
          command: 'execution',
          commandId: 'execution.start',
          operation: 'execution.start',
          projectId,
          featureId,
          retryBatchId: requireBatchId(retryBatchId, state),
          confirm: true,
          ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
        };
      }
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.start',
        operation: 'execution.start',
        projectId,
        featureId,
        inputFile: requireBudgetFile(scan, state),
        previewDigest: requirePreviewDigest(scan, state),
        confirm: true,
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'execution.budget': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.budget',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        batchId: requireBatchId(scan.positionals[0] as string, state),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'execution.revise': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.revise',
        operation: 'execution.budget.revise',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        batchId: requireBatchId(scan.positionals[0] as string, state),
        revision: requireRevision(scan, state),
        reason: requireReason(scan, state),
        inputFile: requireBudgetFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'execution.schedule': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.schedule',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        runId: requireRunId(scan.positionals[0] as string, state),
      };
    }
    case 'execution.attempts': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.attempts',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'execution.diagnostics': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.diagnostics',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        attemptId: requireAttemptId(scan.positionals[0] as string, state),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'execution.dispatch': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.dispatch',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'execution.sessions': {
      // 父级 Run/Task 二选一（实际 Host 契约的 xor 选择器；缺失/同现均本地拒绝）。
      const runRaw = takeOption(scan, '--run');
      const taskRaw = takeOption(scan, '--task');
      if (runRaw === undefined && taskRaw === undefined) {
        fail(state, 'missing_required_option', 'parent');
      }
      if (runRaw !== undefined && taskRaw !== undefined) {
        fail(state, 'conflicting_options');
      }
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.sessions',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...(runRaw !== undefined
          ? { runId: requireRunId(runRaw, state) }
          : { taskId: requirePlanId(taskRaw as string, state, 'taskId') }),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'execution.session': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.session',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        attemptId: requireAttemptId(scan.positionals[0] as string, state),
      };
    }
    case 'execution.session-evidence': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.session-evidence',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        attemptId: requireAttemptId(scan.positionals[0] as string, state),
        artifactId: requireArtifactId(requireOption(scan, '--artifact', state, 'artifactId'), state),
      };
    }
    case 'execution.recordings': {
      // 父级 Run/Attempt/Session 三选一（实际 Host 契约的 xor 选择器）。
      const runRaw = takeOption(scan, '--run');
      const attemptRaw = takeOption(scan, '--attempt');
      const sessionRaw = takeOption(scan, '--session');
      if (runRaw === undefined && attemptRaw === undefined && sessionRaw === undefined) {
        fail(state, 'missing_required_option', 'parent');
      }
      if ([runRaw, attemptRaw, sessionRaw].filter(value => value !== undefined).length > 1) {
        fail(state, 'conflicting_options');
      }
      const recordTypeRaw = takeOption(scan, '--record-type');
      if (recordTypeRaw === undefined) {
        fail(state, 'missing_required_option', 'recordType');
      }
      if (recordTypeRaw !== 'messages' && recordTypeRaw !== 'manifests') {
        fail(state, 'invalid_record_type', 'recordType');
      }
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.recordings',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...(runRaw !== undefined
          ? { runId: requireRunId(runRaw, state) }
          : attemptRaw !== undefined
            ? { attemptId: requireAttemptId(attemptRaw, state) }
            : { sessionId: requireSessionId(sessionRaw as string, state) }),
        recordType: recordTypeRaw,
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'execution.recording-body': {
      const runRaw = takeOption(scan, '--run');
      const attemptRaw = takeOption(scan, '--attempt');
      const sessionRaw = takeOption(scan, '--session');
      if (runRaw === undefined && attemptRaw === undefined && sessionRaw === undefined) {
        fail(state, 'missing_required_option', 'parent');
      }
      if ([runRaw, attemptRaw, sessionRaw].filter(value => value !== undefined).length > 1) {
        fail(state, 'conflicting_options');
      }
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.recording-body',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...(runRaw !== undefined
          ? { runId: requireRunId(runRaw, state) }
          : attemptRaw !== undefined
            ? { attemptId: requireAttemptId(attemptRaw, state) }
            : { sessionId: requireSessionId(sessionRaw as string, state) }),
        artifactId: requireArtifactId(requireOption(scan, '--artifact', state, 'artifactId'), state),
      };
    }
    case 'execution.cancel': {
      // 明确取消确认先于一切：缺 --confirm 即输入错误（不发取消请求）。
      if (!scan.bools.has('--confirm')) {
        fail(state, 'confirmation_required', 'confirm');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      /* P03-9 / F-015：无 positional + --run/--batch 形态映射 Run/Batch 级
       * execution.cancel（持久停止 operation）；既有 positional 形态不变。 */
      const cancelRunId = takeOption(scan, '--run');
      const cancelBatchId = takeOption(scan, '--batch');
      if (cancelRunId !== undefined || cancelBatchId !== undefined) {
        if (scan.positionals.length > 0 || scan.options.has('--revision') === false) {
          fail(state, scan.positionals.length > 0 ? 'conflicting_options' : 'missing_required_option',
            scan.positionals.length > 0 ? 'attemptId' : 'revision');
        }
        if (cancelRunId !== undefined && cancelBatchId !== undefined) {
          fail(state, 'conflicting_options');
        }
        return {
          ...base,
          command: 'execution',
          commandId: 'execution.cancel',
          operation: 'execution.cancel',
          projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
          ...(cancelRunId !== undefined
            ? { targetKind: 'run' as const, targetId: requireRunId(cancelRunId, state) }
            : { targetKind: 'batch' as const, targetId: requireBatchId(cancelBatchId as string, state) }),
          expectedRevision: requireRevision(scan, state),
          confirm: true,
          ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
        };
      }
      if (scan.options.has('--revision') || scan.positionals.length === 0) {
        // Attempt 形态不接受 Run/Batch 控制参数；缺失目标同样在此拒绝。
        fail(state, scan.options.has('--revision') ? 'conflicting_options' : 'missing_positional',
          scan.options.has('--revision') ? 'revision' : 'attemptId');
      }
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.cancel',
        operation: 'execution.attempt.cancel',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        attemptId: requireAttemptId(scan.positionals[0] as string, state),
        confirm: true,
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'execution.pause':
    case 'execution.resume': {
      const runId = takeOption(scan, '--run');
      const batchId = takeOption(scan, '--batch');
      if (runId !== undefined && batchId !== undefined) {
        fail(state, 'conflicting_options');
      }
      if (runId === undefined && batchId === undefined) {
        fail(state, 'missing_control_target');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      const shared = {
        ...base,
        command: 'execution' as const,
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...(runId !== undefined
          ? { targetKind: 'run' as const, targetId: requireRunId(runId, state) }
          : { targetKind: 'batch' as const, targetId: requireBatchId(batchId as string, state) }),
        expectedRevision: requireRevision(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
      return spec.commandId === 'execution.pause'
        ? { ...shared, commandId: 'execution.pause', operation: 'execution.pause' }
        : { ...shared, commandId: 'execution.resume', operation: 'execution.resume' };
    }
    case 'execution.retry-final': {
      const explicitCommandId = optionalCommandId(scan, state);
      const workKey = requireOption(scan, '--work-key', state, 'workKey');
      if (workKey.length === 0 || workKey.length > 256) {
        fail(state, 'invalid_work_key', 'workKey');
      }
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.retry-final',
        operation: 'execution.retryFinal',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        historicalRunId: requireRunId(requireOption(scan, '--historical-run', state, 'historicalRunId'), state),
        workKey,
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'execution.control': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.control',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        runId: requireRunId(scan.positionals[0] as string, state),
      };
    }
    case 'execution.batch-control': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.batch-control',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        batchId: requireBatchId(scan.positionals[0] as string, state),
      };
    }
    case 'execution.recovery': {
      return {
        ...base,
        command: 'execution',
        commandId: 'execution.recovery',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        runId: requireRunId(scan.positionals[0] as string, state),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

/**
 * 工作区命令（P03-5 / F-012）：状态查询与人工丢弃预览/确认。
 * 解析层零 I/O：`--preview-file` 的有界读取与预览绑定核验在执行层、连接
 * Host 之前完成；缺 `--confirm` 或缺 `--preview-file` 在解析层本地拒绝
 *（破坏性操作不隐式预览后自动同意）。
 */
function buildWorkspace(
  scan: ScanResult,
  state: ParseState,
  spec: AppCommandSpec,
): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
  switch (spec.commandId) {
    case 'workspace.list': {
      const featureId = takeOption(scan, '--feature');
      return {
        ...base,
        command: 'workspace',
        commandId: 'workspace.list',
        projectId,
        ...(featureId !== undefined
          ? { featureId: requirePlanId(featureId, state, 'feature') }
          : {}),
        ...optionalWorkspaceListPage(scan, state),
      };
    }
    case 'workspace.get': {
      return {
        ...base,
        command: 'workspace',
        commandId: 'workspace.get',
        projectId,
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
      };
    }
    case 'workspace.operations': {
      const featureId = takeOption(scan, '--feature');
      return {
        ...base,
        command: 'workspace',
        commandId: 'workspace.operations',
        projectId,
        ...(featureId !== undefined
          ? { featureId: requirePlanId(featureId, state, 'feature') }
          : {}),
        ...optionalWorkspaceListPage(scan, state),
      };
    }
    case 'workspace.operation': {
      return {
        ...base,
        command: 'workspace',
        commandId: 'workspace.operation',
        projectId,
        operationId: requireOperationId(scan.positionals[0] as string, state),
      };
    }
    case 'workspace.discard-preview': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'workspace',
        commandId: 'workspace.discard-preview',
        operation: 'workspace.discard.preview',
        projectId,
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'workspace.discard': {
      // 破坏性操作：缺明确确认或缺预览摘要文件在解析层本地拒绝（零 I/O）。
      if (!scan.bools.has('--confirm')) {
        fail(state, 'confirmation_required', 'confirm');
      }
      const previewFile = requireOption(scan, '--preview-file', state, 'preview-file');
      if (previewFile.length === 0 || previewFile.includes('\0')) {
        fail(state, 'invalid_input_file', 'preview-file');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'workspace',
        commandId: 'workspace.discard',
        operation: 'workspace.discard',
        projectId,
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        previewFile,
        confirm: true,
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

function buildPlanning(
  scan: ScanResult,
  state: ParseState,
  spec: AppCommandSpec,
): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  switch (spec.commandId) {
    case 'planning.start': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'planning', commandId: 'planning.start', operation: 'planning.start',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        phaseId: requirePlanIdOption(scan, '--phase', state, 'phaseId'),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        revision: requireRevision(scan, state),
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'planning.list': {
      const featureRaw = takeOption(scan, '--feature');
      return {
        ...base,
        command: 'planning', commandId: 'planning.list',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...(featureRaw !== undefined ? { featureId: requirePlanId(featureRaw, state, 'featureId') } : {}),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'planning.get':
    case 'planning.candidate':
      return {
        ...base,
        command: 'planning', commandId: spec.commandId,
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        candidateId: requirePlanId(scan.positionals[0] as string, state, 'candidateId'),
      };
    case 'planning.approve':
    case 'planning.reject': {
      const explicitCommandId = optionalCommandId(scan, state);
      const reason = optionalReason(scan, state);
      return {
        ...base,
        command: 'planning', commandId: spec.commandId, operation: 'planning.candidate.decide',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        candidateId: requirePlanId(scan.positionals[0] as string, state, 'candidateId'),
        candidateDigest: requirePlanDigest(scan, state),
        revision: requireRevision(scan, state),
        ...(reason !== undefined ? { reason } : {}),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

/**
 * 计划命令（P03-1 / F-010）：Phase 建立、单 Feature 计划导入、层级/DAG 查询、
 * 草稿修订与纯标签编辑。expectedRevision（`--revision`）是唯一 CAS 入口；
 * `--input` 计划文件的有界读取在执行层（解析层零 I/O）。
 */
function buildPlanEntity(
  scan: ScanResult,
  state: ParseState,
  spec: AppCommandSpec,
): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  switch (spec.commandId) {
    case 'phase.update':
    case 'phase.close':
    case 'phase.reopen':
    case 'phase.archive': {
      const explicitCommandId = optionalCommandId(scan, state);
      const title = scan.options.has('--title') ? resolvePlanTitle(scan, state) : undefined;
      const description = resolveInitDescription(scan, state);
      if ((description !== undefined && scan.bools.has('--clear-description')) ||
          (scan.options.has('--label') && scan.bools.has('--clear-labels'))) fail(state, 'conflicting_options');
      const labels = scan.options.has('--label') || scan.bools.has('--clear-labels') ? takeLabels(scan, state) : undefined;
      if (spec.commandId === 'phase.update' && title === undefined && description === undefined &&
          !scan.bools.has('--clear-description') && labels === undefined) fail(state, 'missing_required_option', 'metadata');
      return {
        ...base, command: 'phase', commandId: spec.commandId,
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        phaseId: requirePlanId(scan.positionals[0] as string, state, 'phaseId'), revision: requireRevision(scan, state),
        ...(title !== undefined ? { title } : {}),
        ...(scan.bools.has('--clear-description') ? { description: null } : description !== undefined ? { description } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'phase.graph':
      return { ...base, command: 'phase', commandId: 'phase.graph',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        phaseId: requirePlanId(scan.positionals[0] as string, state, 'phaseId'), ...optionalPlanListPage(scan, state) };
    case 'feature.move': {
      const positiveRevision = (flag: string) => {
        const raw = requireOption(scan, flag, state, flag.slice(2));
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(state, 'invalid_revision', flag.slice(2));
        return Number(raw);
      };
      const explicitCommandId = optionalCommandId(scan, state);
      return { ...base, command: 'feature', commandId: 'feature.move',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'), revision: requireRevision(scan, state),
        sourcePhaseId: requirePlanIdOption(scan, '--from-phase', state, 'sourcePhaseId'),
        targetPhaseId: requirePlanIdOption(scan, '--to-phase', state, 'targetPhaseId'),
        sourcePhaseRevision: positiveRevision('--source-revision'), targetPhaseRevision: positiveRevision('--target-revision'),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}) };
    }
    case 'feature.dependencies': {
      const explicitCommandId = optionalCommandId(scan, state);
      return { ...base, command: 'feature', commandId: 'feature.dependencies',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        phaseId: requirePlanIdOption(scan, '--phase', state, 'phaseId'), revision: requireRevision(scan, state),
        inputFile: requireInputFile(scan, state), ...(explicitCommandId !== undefined ? { explicitCommandId } : {}) };
    }
    case 'phase.create': {
      const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
      const title = resolvePlanTitle(scan, state);
      const description = resolveInitDescription(scan, state);
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'phase',
        commandId: 'phase.create',
        operation: 'phase.create',
        projectId,
        title,
        labels: takeLabels(scan, state),
        ...(description !== undefined ? { description } : {}),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'phase.list': {
      return {
        ...base,
        command: 'phase',
        commandId: 'phase.list',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'phase.get': {
      return {
        ...base,
        command: 'phase',
        commandId: 'phase.get',
        phaseId: requirePlanId(scan.positionals[0] as string, state, 'phaseId'),
      };
    }
    case 'phase.labels':
    case 'feature.labels':
    case 'task.labels': {
      const entityType = planLabelsEntityType(spec.commandId);
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: entityType,
        commandId: spec.commandId,
        operation: 'plan.labels.update',
        entityType,
        id: requirePlanId(scan.positionals[0] as string, state, 'id'),
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        revision: requireRevision(scan, state),
        labels: takeLabels(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'feature.import': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'feature',
        commandId: 'feature.import',
        operation: 'feature.plan.import',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        phaseId: requirePlanIdOption(scan, '--phase', state, 'phaseId'),
        revision: requireRevision(scan, state),
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'feature.list': {
      return {
        ...base,
        command: 'feature',
        commandId: 'feature.list',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        phaseId: requirePlanIdOption(scan, '--phase', state, 'phaseId'),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'feature.get': {
      return {
        ...base,
        command: 'feature',
        commandId: 'feature.get',
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
      };
    }
    case 'feature.revise': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'feature',
        commandId: 'feature.revise',
        operation: 'feature.plan.revise',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        revision: requireRevision(scan, state),
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'feature.report':
    case 'feature.delivery': {
      return {
        ...base,
        command: 'feature',
        commandId: spec.commandId as 'feature.delivery' | 'feature.report',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
      };
    }
    case 'feature.final-approve': {
      // 明确确认先于一切：缺 --confirm 即输入错误（不推进收尾）。
      if (!scan.bools.has('--confirm')) {
        fail(state, 'confirmation_required', 'confirm');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      const reason = optionalReason(scan, state);
      return {
        ...base,
        command: 'feature',
        commandId: 'feature.final-approve',
        operation: 'task.approval.approve',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        taskId: requirePlanId(requireOption(scan, '--task', state, 'task'), state, 'task'),
        itemId: requirePlanId(requireOption(scan, '--item', state, 'item'), state, 'item'),
        planDigest: requirePlanDigest(scan, state),
        codeDigest: requireSha256Option(scan, '--code-digest', state, 'code-digest'),
        revision: requireRevision(scan, state),
        confirm: true,
        ...(reason !== undefined ? { reason } : {}),
        artifactRefs: [...(scan.options.get('--artifact') ?? [])],
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'feature.finalize': {
      // 明确确认先于一切：缺 --confirm 即输入错误（不推进收尾）。
      if (!scan.bools.has('--confirm')) {
        fail(state, 'confirmation_required', 'confirm');
      }
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'feature',
        commandId: 'feature.finalize',
        operation: 'feature.verification.continue',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        runId: requireRunId(requireOption(scan, '--run', state, 'run'), state),
        batchId: requireBatchId(requireOption(scan, '--batch', state, 'batch'), state),
        operationId: requireOperationId(requireOption(scan, '--operation', state, 'operation'), state),
        revision: requireRevision(scan, state),
        confirm: true,
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'task.list': {
      return {
        ...base,
        command: 'task',
        commandId: 'task.list',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanIdOption(scan, '--feature', state, 'featureId'),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'task.get': {
      return {
        ...base,
        command: 'task',
        commandId: 'task.get',
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
      };
    }
    case 'feature.approve':
    case 'feature.reject': {
      const explicitCommandId = optionalCommandId(scan, state);
      const reason = optionalReason(scan, state);
      return {
        ...base,
        command: 'feature',
        commandId: spec.commandId,
        operation: 'feature.plan.decide',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanId(scan.positionals[0] as string, state, 'featureId'),
        planDigest: requirePlanDigest(scan, state),
        revision: requireRevision(scan, state),
        ...(reason !== undefined ? { reason } : {}),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'task.strategy': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'task',
        commandId: 'task.strategy',
        operation: 'task.strategy.update',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
        revision: requireRevision(scan, state),
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'task.prepare': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'task',
        commandId: 'task.prepare',
        operation: 'execution.input.prepare',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        featureId: requirePlanIdOption(scan, '--feature', state, 'featureId'),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
        inputFile: requireInputFile(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'task.inputs': {
      const targetCommandId = scan.positionals[0] as string;
      if (!isUuidV4(targetCommandId)) {
        fail(state, 'invalid_command_id', 'commandId');
      }
      return { ...base, command: 'task', commandId: 'task.inputs', targetCommandId };
    }
    case 'task.status': {
      return {
        ...base,
        command: 'task',
        commandId: 'task.status',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
      };
    }
    case 'task.block': {
      const explicitCommandId = optionalCommandId(scan, state);
      const kindOption = takeOption(scan, '--kind');
      if (kindOption !== undefined && kindOption !== 'block' && kindOption !== 'approval') {
        fail(state, 'unknown_input_field', 'kind');
      }
      const description = takeOption(scan, '--description');
      if (description !== undefined && (description.trim().length === 0 || description.includes('\0') || codePointLength(description) > 4096)) {
        fail(state, 'invalid_description', 'description');
      }
      const responsibleParty = takeOption(scan, '--party');
      if (responsibleParty !== undefined && (responsibleParty.trim().length === 0 || responsibleParty.includes('\0') || codePointLength(responsibleParty) > 256)) {
        fail(state, 'invalid_name', 'party');
      }
      const blockCodeDigest = optionalSha256Option(scan, '--code-digest', state, 'code-digest');
      return {
        ...base,
        command: 'task',
        commandId: 'task.block',
        operation: 'task.approval.block',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
        planDigest: requirePlanDigest(scan, state),
        revision: requireRevision(scan, state),
        ...(kindOption !== undefined ? { kindOption: kindOption as 'block' | 'approval' } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(responsibleParty !== undefined ? { responsibleParty } : {}),
        ...(blockCodeDigest !== undefined ? { codeDigest: blockCodeDigest } : {}),
        artifactRefs: [...(scan.options.get('--artifact') ?? [])],
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'task.approve':
    case 'task.reject':
    case 'task.unblock': {
      const explicitCommandId = optionalCommandId(scan, state);
      const reason = optionalReason(scan, state);
      return {
        ...base,
        command: 'task',
        commandId: spec.commandId,
        operation: `task.approval.${spec.commandId.slice('task.'.length)}` as
          | 'task.approval.approve'
          | 'task.approval.reject'
          | 'task.approval.unblock',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
        itemId: requirePlanId(scan.positionals[1] as string, state, 'itemId'),
        planDigest: requirePlanDigest(scan, state),
        codeDigest: requireSha256Option(scan, '--code-digest', state, 'code-digest'),
        revision: requireRevision(scan, state),
        ...(reason !== undefined ? { reason } : {}),
        artifactRefs: [...(scan.options.get('--artifact') ?? [])],
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    case 'task.continue': {
      const explicitCommandId = optionalCommandId(scan, state);
      return {
        ...base,
        command: 'task',
        commandId: 'task.continue',
        operation: 'task.verification.continue',
        projectId: requireProjectId(requireOption(scan, '--project', state, 'project'), state),
        taskId: requirePlanId(scan.positionals[0] as string, state, 'taskId'),
        attemptId: requireAttemptId(requireOption(scan, '--attempt', state, 'attempt'), state),
        verificationBatchId: requirePlanId(requireOption(scan, '--batch', state, 'batch'), state, 'batch'),
        codeDigest: requireSha256Option(scan, '--code-digest', state, 'code-digest'),
        observationDigest: requireSha256Option(scan, '--observation', state, 'observation'),
        revision: requireRevision(scan, state),
        ...(explicitCommandId !== undefined ? { explicitCommandId } : {}),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

/**
 * Git 操作查询命令（P03-8 / F-011）：意图/实际提交/操作回执只读查询。
 * 解析层零 I/O；CLI 不打开状态库、不直接执行 Git。
 */
function buildGit(
  scan: ScanResult,
  state: ParseState,
  spec: AppCommandSpec,
): ParsedAppCliCommand {
  assertPositionals(scan, spec, state);
  const base = baseResult(state, scan);
  const projectId = requireProjectId(requireOption(scan, '--project', state, 'project'), state);
  switch (spec.commandId) {
    case 'git.operations': {
      // 父级 Feature/Run 二选一（实际 Host 契约的 xor 选择器；缺失/同现均本地拒绝）。
      const featureRaw = takeOption(scan, '--feature');
      const runRaw = takeOption(scan, '--run');
      if (featureRaw === undefined && runRaw === undefined) {
        fail(state, 'missing_required_option', 'parent');
      }
      if (featureRaw !== undefined && runRaw !== undefined) {
        fail(state, 'conflicting_options');
      }
      return {
        ...base,
        command: 'git',
        commandId: 'git.operations',
        projectId,
        ...(featureRaw !== undefined
          ? { featureId: requirePlanId(featureRaw, state, 'feature') }
          : { runId: requireRunId(runRaw as string, state) }),
        ...optionalPlanListPage(scan, state),
      };
    }
    case 'git.operation': {
      return {
        ...base,
        command: 'git',
        commandId: 'git.operation',
        projectId,
        operationId: requireOperationId(scan.positionals[0] as string, state),
      };
    }
    default:
      fail(state, 'unknown_subcommand');
  }
}

/**
 * 纯解析受控 argv（process.argv.slice(2) 形态）、显式注入的 env 与可选 cwd
 * （相对仓库路径 → 绝对输入的解析基准）。
 * 返回命令意图或帮助意图；非法输入抛 AppCliParseError（退出码 2），全程无 I/O。
 */
export function parseAppCliArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  options: { readonly cwd?: string } = {},
): ParsedAppCli {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new AppCliParseError('invalid_input', 'invalid_argv_type', {
      command: null,
      commandId: null,
      json: false,
    });
  }

  const state: ParseState = {
    command: null,
    commandId: null,
    json: args.includes('--json'),
    cwd: options.cwd,
    seen: new Set<string>(),
  };

  if (args.length === 0) {
    fail(state, 'missing_command');
  }

  const first = args[0] as string;
  if (first.startsWith('-') || !(APP_CLI_COMMANDS as readonly string[]).includes(first)) {
    fail(state, 'unknown_command');
  }
  state.command = first as AppCliCommand;

  if (state.command === 'events') {
    state.commandId = 'events.observe';
    const spec = SPECS['events.observe'];
    const scan = scanOptions(args.slice(1), spec, state);
    if (scan.help) {
      return { kind: 'help', scope: 'events' };
    }
    assertNoEnvOverride(state, env);
    return buildEvents(scan, state, spec);
  }

  const second = args[1];
  if (second === undefined) {
    fail(state, 'missing_subcommand');
  }
  if (isHelpToken(second)) {
    return { kind: 'help', scope: state.command };
  }
  if (second.startsWith('-')) {
    fail(state, 'missing_subcommand');
  }
  const commandId = SUBCOMMAND_TO_ID[state.command][second];
  if (commandId === undefined) {
    fail(state, 'unknown_subcommand', second);
  }
  state.commandId = commandId;
  const spec = SPECS[commandId];
  const scan = scanOptions(args.slice(2), spec, state);
  if (scan.help) {
    return { kind: 'help', scope: commandId };
  }
  assertNoEnvOverride(state, env);

  switch (spec.command) {
    case 'project':
      return buildProject(scan, state, spec);
    case 'config':
      return buildConfig(scan, state, spec);
    case 'receipt':
      return buildReceipt(scan, state, spec);
    case 'baseline':
      return buildBaseline(scan, state, spec);
    case 'phase':
    case 'feature':
    case 'task':
      return buildPlanEntity(scan, state, spec);
    case 'planning':
      return buildPlanning(scan, state, spec);
    case 'execution':
      return buildExecution(scan, state, spec);
    case 'workspace':
      return buildWorkspace(scan, state, spec);
    case 'git':
      return buildGit(scan, state, spec);
    default:
      fail(state, 'unknown_subcommand');
  }
}

/**
 * 解析 `--input <file>` 的文本内容为 JSON 普通对象（纯函数，不做文件 I/O；
 * 文件读取在执行层）。畸形 JSON、数组、null、标量一律 invalid_input_json。
 */
export function parseAppInputJson(
  text: string,
  context: { commandId?: AppCliCommandId | null; json?: boolean } = {},
): Record<string, unknown> {
  const state: ParseState = {
    command: null,
    commandId: context.commandId ?? null,
    json: context.json ?? false,
    cwd: undefined,
    seen: new Set<string>(),
  };
  if (typeof text !== 'string') {
    fail(state, 'invalid_input_json');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(state, 'invalid_input_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(state, 'invalid_input_json');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(state, 'invalid_input_json');
  }
  return value as Record<string, unknown>;
}
