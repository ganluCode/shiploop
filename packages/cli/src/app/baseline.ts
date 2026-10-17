/**
 * F-015 基线 CLI 纯面层：输入文件/argv 校验、独立授权、查询/取消对象与结果格式化
 * （契约 §6.1/§6.2、§7.4/§7.5/§7.6、§8、§12.1/§12.2/§12.3）。
 *
 * 纯函数模块（与 `app/args.ts` 同一纪律）：
 * - 不读 argv/env、不读文件（`--input` 文件读取属执行层）、不发现 Host、
 *   不联网、不启动进程、不打印；
 * - 命令输入无损表达 argv：JSON 字符串数组原样保留（含空格/中文/特殊字符），
 *   绝不把用户字符串重新拼接为 shell 命令行，不解析 shell、不自动追加安装
 *   命令、不从配置/仓库文本提取凭据（秘密/环境值/身份字段一律拒绝进入请求）；
 * - 独立授权：`baseline run` 的 `--confirm`/`--decline` 与注册确认严格分开，
 *   确认注册不隐含确认基线；非交互必须显式批准本次请求，EOF/拒绝不默认执行；
 * - 结果格式化区分 accepted、活动、passed、failed、not_run、timeout、
 *   cancelled 与停止未确认；not_run/非 passed 检查绝不折算成功；
 *   保留 operationId 与结果引用（输出制品 artifactId/byteSize/truncated）；
 * - 退出码/输出路由与前序码表一致（§12.3 五档 0~4）。
 *
 * 输入视图与 §6/§7.4/§7.5/§7.6 线形状兼容（结构化窄类型，纯面层不导入 Core；
 * Core 在执行前仍做权威深校验）。
 */
import { isUuidV4 } from 'shiploop-host';
import { AppCliParseError, parseAppInputJson } from './args.js';
import type { AppCliCommand, AppCliCommandId, AppCliParseReason } from './args.js';
import { buildAppCliSuccessEnvelope } from './output.js';
import type { AppCliSuccessEnvelope } from './output.js';
import { CLI_EXIT_OK, CLI_EXIT_REJECTED } from '../host/output.js';
import type { CliExitCode } from '../host/output.js';

/* ------------------------------------------------------------------ *
 * 输入上下文与错误（受控 reason/field；绝不回显用户值）
 * ------------------------------------------------------------------ */

export interface BaselineInputContext {
  /** 所属命令组（省略即 baseline；F-008 决策/策略/固定输入复用同一守护）。 */
  readonly command?: AppCliCommand;
  readonly commandId?: AppCliCommandId | null;
  readonly json?: boolean;
}

function failInput(
  reason: AppCliParseReason,
  field: string,
  context: BaselineInputContext,
): never {
  throw new AppCliParseError(
    'invalid_input',
    reason,
    {
      command: context.command ?? 'baseline',
      commandId: context.commandId ?? null,
      json: context.json ?? false,
    },
    field,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/* ------------------------------------------------------------------ *
 * §6.1 检查计划输入（argv 无损）
 * ------------------------------------------------------------------ */

/** 检查计划逐项输入（argv 字符串数组原样保留；省略字段不产生 undefined 值键）。 */
export interface BaselineCheckInputView {
  readonly checkKey: string;
  readonly kind: 'command';
  readonly argv: readonly string[];
  readonly cwdRef?: string;
  readonly environmentRef?: string;
  readonly timeoutMs: number;
  readonly required: boolean;
}

/** `--input <file>` 的检查计划 JSON（仅此形状；不接受数据库/结果/身份字段）。 */
export interface BaselineCheckPlanView {
  readonly checks: readonly BaselineCheckInputView[];
}

/** §13 有限上限（与 Core 同一口径；不开放为配置）。 */
export const BASELINE_INPUT_CHECKS_MIN = 1;
export const BASELINE_INPUT_CHECKS_MAX = 64;
export const BASELINE_INPUT_TIMEOUT_MIN_MS = 1;
export const BASELINE_INPUT_TIMEOUT_MAX_MS = 3_600_000;

const CHECK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENVIRONMENT_REF_MAX_LENGTH = 256;
const PLAN_KEYS = ['checks'] as const;
const CHECK_KEYS = [
  'checkKey',
  'kind',
  'argv',
  'cwdRef',
  'environmentRef',
  'timeoutMs',
  'required',
] as const;
const CANCEL_KEYS = ['operationId'] as const;

/** 明文秘密/环境值字段名（规范化后精确匹配）：秘密不得进入请求体。 */
const SECRET_FIELD_TOKENS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'pin',
  'apikey',
  'apitoken',
  'accesskey',
  'secretkey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'privatekey',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'bearer',
  'env',
  'environment',
  'envvars',
  'environmentvariables',
]);

/** 客户端不得提供的身份/权限/可见范围字段（可信身份只由 Host 装配注入）。 */
const CLIENT_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'actorid',
  'actor',
  'decisionactor',
  'decisionactorid',
  'principal',
  'principalid',
  'capabilities',
  'capability',
  'scope',
  'projectscope',
  'permissions',
  'roles',
]);

function normalizeKeyToken(key: string): string {
  return key.toLowerCase().replaceAll(/[_-]/g, '');
}

/** 明文秘密/环境值字段判定（规范化 token 精确匹配）。 */
function isSecretFieldToken(token: string): boolean {
  return SECRET_FIELD_TOKENS.has(token);
}

/** 客户端伪造主体/权限字段判定（可信身份只由 Host 装配注入）。 */
export function isClientIdentityFieldToken(token: string): boolean {
  return CLIENT_IDENTITY_FIELDS.has(token);
}

/** 递归扫描键名：明文秘密/环境值字段一律定位拒绝（只看键名，不读值）。 */
export function rejectSecretInputFields(
  value: unknown,
  field: string,
  context: BaselineInputContext,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rejectSecretInputFields(item, `${field}[${index}]`, context);
    });
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const childField = field.length > 0 ? `${field}.${key}` : key;
    if (isSecretFieldToken(normalizeKeyToken(key))) {
      failInput('input_secret_field_rejected', childField, context);
    }
    rejectSecretInputFields(value[key], childField, context);
  }
}

/** 递归扫描键名：秘密/环境值字段与身份字段一律定位拒绝（只看键名，不读值）。 */
export function rejectForbiddenFields(
  value: unknown,
  field: string,
  context: BaselineInputContext,
): void {
  rejectSecretInputFields(value, field, context);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rejectForbiddenFields(item, `${field}[${index}]`, context);
    });
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const childField = field.length > 0 ? `${field}.${key}` : key;
    if (isClientIdentityFieldToken(normalizeKeyToken(key))) {
      failInput('input_identity_field_rejected', childField, context);
    }
    rejectForbiddenFields(value[key], childField, context);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPrefix: string,
  context: BaselineInputContext,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      failInput('unknown_input_field', `${fieldPrefix}${key}`, context);
    }
  }
}

function requireOwn(
  value: Record<string, unknown>,
  key: string,
  field: string,
  reason: AppCliParseReason,
  context: BaselineInputContext,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    failInput(reason, field, context);
  }
  return value[key];
}

function validateArgv(
  value: unknown,
  field: string,
  context: BaselineInputContext,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    failInput('empty_command', field, context);
  }
  const argv: string[] = [];
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (typeof item !== 'string' || item.includes('\0')) {
      failInput('invalid_argv', itemField, context);
    }
    if (item.trim().length === 0) {
      failInput('empty_command', itemField, context);
    }
    argv.push(item);
  }
  return argv;
}

function validateCwdRef(
  value: unknown,
  field: string,
  context: BaselineInputContext,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    failInput('invalid_cwd_ref', field, context);
  }
  if (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\')
  ) {
    failInput('invalid_cwd_ref', field, context);
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      failInput('invalid_cwd_ref', field, context);
    }
  }
  return value;
}

function validateEnvironmentRef(
  value: unknown,
  field: string,
  context: BaselineInputContext,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ENVIRONMENT_REF_MAX_LENGTH ||
    /[\0-\x1f\x7f]/.test(value)
  ) {
    failInput('invalid_environment_ref', field, context);
  }
  return value;
}

function validateTimeoutMs(
  value: unknown,
  field: string,
  context: BaselineInputContext,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < BASELINE_INPUT_TIMEOUT_MIN_MS ||
    value > BASELINE_INPUT_TIMEOUT_MAX_MS
  ) {
    failInput('invalid_check_timeout', field, context);
  }
  return value;
}

/**
 * 校验 `--input` 检查计划 JSON 普通对象（纯函数）：
 * - 精确键集（未知字段即拒绝；不接受数据库路径、resultRef/结果读取路径或
 *   提权主体字段）；秘密/环境值/身份字段先行拒绝；
 * - argv 无损：每项字符串原样保留（空格/中文/特殊字符不变形），空命令拒绝；
 * - 与 Core §6.1 同一口径（数量 1..64、timeoutMs 1..3600000、checkKey 稳定
 *   且唯一）；非法输入以 invalid_input 定位拒绝，绝不回显用户值。
 */
export function validateBaselineCheckPlanObject(
  value: unknown,
  context: BaselineInputContext = {},
): BaselineCheckPlanView {
  if (!isPlainObject(value)) {
    failInput('invalid_check_plan', 'plan', context);
  }
  rejectForbiddenFields(value, '', context);
  exactKeys(value, PLAN_KEYS, '', context);

  const rawChecks = requireOwn(value, 'checks', 'checks', 'invalid_check_plan', context);
  if (!Array.isArray(rawChecks)) {
    failInput('invalid_check_plan', 'checks', context);
  }
  if (rawChecks.length < BASELINE_INPUT_CHECKS_MIN || rawChecks.length > BASELINE_INPUT_CHECKS_MAX) {
    failInput('invalid_check_plan', 'checks', context);
  }

  const checks: BaselineCheckInputView[] = [];
  const seenCheckKeys = new Set<string>();
  for (const [index, item] of rawChecks.entries()) {
    const field = `checks[${index}]`;
    if (!isPlainObject(item)) {
      failInput('invalid_check_plan', field, context);
    }
    rejectForbiddenFields(item, field, context);
    exactKeys(item, CHECK_KEYS, `${field}.`, context);

    const checkKey = requireOwn(item, 'checkKey', `${field}.checkKey`, 'invalid_check_key', context);
    if (typeof checkKey !== 'string' || !CHECK_KEY_PATTERN.test(checkKey)) {
      failInput('invalid_check_key', `${field}.checkKey`, context);
    }
    if (seenCheckKeys.has(checkKey)) {
      failInput('duplicate_check_key', `${field}.checkKey`, context);
    }
    seenCheckKeys.add(checkKey);

    const kind = requireOwn(item, 'kind', `${field}.kind`, 'invalid_check_kind', context);
    if (kind !== 'command') {
      failInput('invalid_check_kind', `${field}.kind`, context);
    }

    const argv = validateArgv(
      requireOwn(item, 'argv', `${field}.argv`, 'empty_command', context),
      `${field}.argv`,
      context,
    );

    const timeoutMs = validateTimeoutMs(
      requireOwn(item, 'timeoutMs', `${field}.timeoutMs`, 'invalid_check_timeout', context),
      `${field}.timeoutMs`,
      context,
    );

    const required = requireOwn(item, 'required', `${field}.required`, 'invalid_required', context);
    if (typeof required !== 'boolean') {
      failInput('invalid_required', `${field}.required`, context);
    }

    const check: {
      checkKey: string;
      kind: 'command';
      argv: readonly string[];
      cwdRef?: string;
      environmentRef?: string;
      timeoutMs: number;
      required: boolean;
    } = { checkKey, kind: 'command', argv, timeoutMs, required };
    if (item.cwdRef !== undefined) {
      check.cwdRef = validateCwdRef(item.cwdRef, `${field}.cwdRef`, context);
    }
    if (item.environmentRef !== undefined) {
      check.environmentRef = validateEnvironmentRef(
        item.environmentRef,
        `${field}.environmentRef`,
        context,
      );
    }
    checks.push(check);
  }
  return { checks };
}

/**
 * `--input <file>` 文本 → 已校验检查计划（纯函数；文件读取属执行层）。
 * 畸形 JSON/非对象由 `parseAppInputJson` 以 invalid_input_json 拒绝，
 * Schema/计划错误由 `validateBaselineCheckPlanObject` 定位拒绝。
 */
export function parseBaselineCheckPlanText(
  text: string,
  context: BaselineInputContext = {},
): BaselineCheckPlanView {
  const object = parseAppInputJson(text, {
    commandId: context.commandId ?? null,
    json: context.json ?? false,
  });
  return validateBaselineCheckPlanObject(object, context);
}

/* ------------------------------------------------------------------ *
 * §6 取消对象（唯一取消途径的请求对象校验）
 * ------------------------------------------------------------------ */

export interface BaselineCancelObjectView {
  readonly operationId: string;
}

/**
 * `baseline.cancel` 请求对象：`{operationId}`（UUID v4 操作身份）。
 * 精确键集 + 秘密/身份字段拒绝；未知/缺失/非法 ID 一律 invalid_input。
 */
export function validateBaselineCancelObject(
  value: unknown,
  context: BaselineInputContext = {},
): BaselineCancelObjectView {
  if (!isPlainObject(value)) {
    failInput('invalid_input_json', 'payload', context);
  }
  rejectForbiddenFields(value, '', context);
  exactKeys(value, CANCEL_KEYS, '', context);
  const operationId = requireOwn(
    value,
    'operationId',
    'operationId',
    'invalid_operation_id',
    context,
  );
  if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
    failInput('invalid_operation_id', 'operationId', context);
  }
  return { operationId };
}

/* ------------------------------------------------------------------ *
 * §12.1 独立授权（与注册确认严格分开）
 * ------------------------------------------------------------------ */

export type BaselineNotRunReason =
  | 'non_interactive'
  | 'no_input'
  | 'declined'
  | 'confirm_flag_required'
  | 'conflicting_flags';

export type BaselineAuthorizationOutcome =
  | {
      readonly outcome: 'authorize';
      readonly source: 'explicit_flag';
      readonly scope: 'baseline.run';
    }
  | { readonly outcome: 'decline'; readonly source: 'explicit_flag' }
  | { readonly outcome: 'not_run'; readonly reason: BaselineNotRunReason };

export interface BaselineAuthorizationInput {
  /** `--confirm`：显式非交互授权（只覆盖预览展示的这一次基线请求）。 */
  readonly confirmFlag: boolean;
  /** `--decline`：显式拒绝（记录 not_run）。与 confirmFlag 互斥。 */
  readonly declineFlag: boolean;
  /** 交互会话（TTY）标记；只用于区分取消原因，不构成授权。 */
  readonly interactive: boolean;
  /** 交互确认应答原文；null/undefined 表示无输入（EOF）。 */
  readonly answer?: string | null;
}

/**
 * 基线授权决策（纯函数）：
 * - 只有显式 `--confirm` 才 authorize，且授权范围仅限预览展示的这一次基线请求；
 * - `--decline` 显式拒绝（记录 not_run）；两旗同现 → 不默认执行；
 * - 非交互/无输入（EOF）/明确拒绝绝不默认执行；交互肯定应答也必须回到显式
 *   `--confirm`（确认入口唯一）；确认注册不隐含确认基线。
 */
export function resolveBaselineAuthorization(
  input: BaselineAuthorizationInput,
): BaselineAuthorizationOutcome {
  if (input.confirmFlag && input.declineFlag) {
    return { outcome: 'not_run', reason: 'conflicting_flags' };
  }
  if (input.confirmFlag) {
    return { outcome: 'authorize', source: 'explicit_flag', scope: 'baseline.run' };
  }
  if (input.declineFlag) {
    return { outcome: 'decline', source: 'explicit_flag' };
  }
  if (!input.interactive) {
    return { outcome: 'not_run', reason: 'non_interactive' };
  }
  const answer = input.answer ?? '';
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) {
    return { outcome: 'not_run', reason: 'no_input' };
  }
  if (normalized === 'y' || normalized === 'yes') {
    return { outcome: 'not_run', reason: 'confirm_flag_required' };
  }
  return { outcome: 'not_run', reason: 'declined' };
}

/** 授权决策 → Core §6 决策：authorize/decline（not_run 一律拒绝授权）。 */
export function toBaselineDecision(
  outcome: BaselineAuthorizationOutcome,
): 'authorize' | 'decline' {
  return outcome.outcome === 'authorize' ? 'authorize' : 'decline';
}

/** 基线授权文案：与注册确认分开；未显式批准不执行、拒绝/EOF 不默认执行。 */
export function buildBaselineRunConfirmationNotice(): string {
  return [
    '基线授权确认（与注册确认严格分开）：',
    '  --confirm 是显式非交互授权，只覆盖预览展示的这一次基线请求（argv/cwd/环境/timeout/政策/代码身份绑定 previewDigest）。',
    '  --decline 显式拒绝：记录 not_run（未执行），绝不伪装成功。',
    '  确认注册（project init --confirm）不隐含确认基线：基线必须自带独立确认。',
    '  非交互必须显式批准该请求；无输入（EOF）或拒绝绝不默认执行。',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * §7.4/§7.5/§7.6 结果视图（与线形状兼容的结构化窄类型）
 * ------------------------------------------------------------------ */

export type BaselineOperationStatusView =
  | 'accepted'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'not_run';

export type BaselineCheckStatusView = 'passed' | 'failed' | 'error' | 'inconclusive' | 'not_run';

export interface BaselineCheckCountsView {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly error: number;
  readonly inconclusive: number;
  readonly notRun: number;
}

export interface BaselineCheckOutputRefView {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly truncated: boolean;
}

export interface BaselineCheckResultView {
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeoutMs: number;
  readonly required: boolean;
  readonly status: BaselineCheckStatusView;
  readonly reasonCode?: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: BaselineCheckOutputRefView | null;
  readonly tail: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
}

export interface BaselineOperationView {
  readonly operationId: string;
  readonly kind: 'baseline';
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly summary: BaselineCheckCountsView;
}

export interface BaselineCodeIdentityView {
  readonly headCommit: string | null;
  readonly workingTreeDigest: string;
  readonly hasUncommittedChanges: boolean;
}

export interface BaselinePreviewWorkspaceView {
  readonly excludedDirNames: readonly string[];
  readonly fileCount: number;
}

export interface BaselinePreviewCheckView {
  readonly checkKey: string;
  readonly kind: 'command';
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly cwd: string;
  readonly environmentRef: string | null;
  readonly allowedVariables: readonly string[];
  readonly timeoutMs: number;
  readonly required: boolean;
}

export interface BaselinePreviewWarningView {
  readonly code: string;
  readonly checkKey?: string;
}

/** baseline.preview 回执 result 的窄视图。 */
export interface BaselinePreviewWireView {
  readonly previewDigest: string;
  readonly policyRevision: string;
  readonly codeIdentity: BaselineCodeIdentityView;
  readonly workspace: BaselinePreviewWorkspaceView;
  readonly checks: readonly BaselinePreviewCheckView[];
  readonly warnings: readonly BaselinePreviewWarningView[];
}

/** baseline preview 的结构化结果（含项目身份）。 */
export interface BaselinePreviewResultView extends BaselinePreviewWireView {
  readonly projectId: string;
}

/** 逐项检查的结构化输出（保留结果引用与耗时；tail 只在详情中携带）。 */
export interface BaselineCheckOutcomeView {
  readonly checkKey: string;
  readonly status: BaselineCheckStatusView;
  readonly reasonCode?: string;
  readonly required: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly output: BaselineCheckOutputRefView | null;
}

/** baseline run/cancel 命令回执结果（含展示状态）。 */
export interface BaselineCommandResultView {
  readonly operationId: string;
  readonly state: BaselineDisplayState;
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
}

/** baseline status / run --wait 终态结果（含授权摘要的代码身份；拒绝记录为 null）。 */
export interface BaselineOperationResultView {
  readonly operationId: string;
  readonly state: BaselineDisplayState;
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
  readonly codeIdentity: BaselineCodeIdentityView | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly summary: BaselineCheckCountsView;
  readonly checks: readonly BaselineCheckOutcomeView[];
}

export interface BaselineListEntryView {
  readonly operationId: string;
  readonly state: BaselineDisplayState;
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly summary: BaselineCheckCountsView;
}

/** baseline list 分页结果（稳定键集；cursor 不透明）。 */
export interface BaselineListResultView {
  readonly projectId: string;
  readonly records: readonly BaselineListEntryView[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** baseline evidence 结果（正文原样；引用信息保留）。 */
export interface BaselineEvidenceResultView {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly content: string;
}

/* ------------------------------------------------------------------ *
 * §8 展示状态分类（accepted/活动/passed/failed/not_run/timeout/cancelled/停止未确认）
 * ------------------------------------------------------------------ */

/**
 * 基线展示状态：把操作状态轴、检查状态轴与原因轴归一为可区分的八个状态。
 * `timeout`/`stop_unconfirmed` 取消资格原因优先于一般失败；
 * `not_run`/非 passed 检查绝不折算成功。
 */
export type BaselineDisplayState =
  | 'accepted'
  | 'active'
  | 'passed'
  | 'failed'
  | 'not_run'
  | 'timeout'
  | 'cancelled'
  | 'stop_unconfirmed';

const STATE_LABELS: Readonly<Record<BaselineDisplayState, string>> = Object.freeze({
  accepted: 'accepted（已受理；操作已创建，尚未活动）',
  active: 'active（活动：执行/取消进行中）',
  passed: 'passed（通过：操作 completed 且全部必需检查 passed）',
  failed: 'failed（失败：操作失败/中断或必需检查非 passed）',
  not_run: 'not_run（未执行：拒绝授权或未启动；不折算成功）',
  timeout: 'timeout（超时）',
  cancelled: 'cancelled（已取消）',
  stop_unconfirmed: 'stop_unconfirmed（停止未确认）',
});

/** 人类可读状态标签（含受控说明；不含任何用户输入）。 */
export function describeBaselineState(state: BaselineDisplayState): string {
  return STATE_LABELS[state];
}

function allRequiredChecksPassed(checks: readonly BaselineCheckResultView[]): boolean {
  return checks.filter((check) => check.required).every((check) => check.status === 'passed');
}

function allChecksPassedBySummary(summary: BaselineCheckCountsView): boolean {
  return (
    summary.total > 0 &&
    summary.passed === summary.total &&
    summary.failed === 0 &&
    summary.error === 0 &&
    summary.inconclusive === 0 &&
    summary.notRun === 0
  );
}

/**
 * 状态分类（纯函数）：
 * - 活动（running/cancelling）与 accepted 保真展示，不冒充完成；
 * - 停止未确认 > 超时 > 取消（原因码首因保留；任一层出现即生效）；
 * - `passed` 只在操作 completed 且全部必需检查 passed 时成立（有明细按必需项
 *   判定；仅有摘要时任何非 passed 检查都不折算成功）；无检查证据的 completed
 *   不折算 passed；
 * - 其余终态（failed/interrupted/必需检查非 passed）一律 failed。
 */
export function classifyBaselineState(input: {
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
  readonly summary?: BaselineCheckCountsView;
  readonly checks?: readonly BaselineCheckResultView[];
}): BaselineDisplayState {
  const { status, reasonCode, summary, checks } = input;
  const reasonCodes: string[] = [];
  if (reasonCode !== undefined) {
    reasonCodes.push(reasonCode);
  }
  for (const check of checks ?? []) {
    if (check.reasonCode !== undefined) {
      reasonCodes.push(check.reasonCode);
    }
  }
  const hasReason = (code: string): boolean => reasonCodes.includes(code);

  if (status === 'accepted') {
    return 'accepted';
  }
  if (status === 'running' || status === 'cancelling') {
    return 'active';
  }
  if (status === 'not_run') {
    return 'not_run';
  }
  if (hasReason('stop_unconfirmed')) {
    return 'stop_unconfirmed';
  }
  if (hasReason('timed_out') || (checks ?? []).some((check) => check.timedOut)) {
    return 'timeout';
  }
  if (status === 'cancelled' || hasReason('cancelled')) {
    return 'cancelled';
  }
  if (status === 'completed') {
    if (checks !== undefined) {
      return allRequiredChecksPassed(checks) ? 'passed' : 'failed';
    }
    if (summary !== undefined) {
      return allChecksPassedBySummary(summary) ? 'passed' : 'failed';
    }
    return 'failed';
  }
  return 'failed';
}

/* ------------------------------------------------------------------ *
 * 结果构建与格式化（保留 operationId/结果引用；argv 不拼接 shell）
 * ------------------------------------------------------------------ */

function checkOutcome(check: BaselineCheckResultView): BaselineCheckOutcomeView {
  return {
    checkKey: check.checkKey,
    status: check.status,
    ...(check.reasonCode !== undefined ? { reasonCode: check.reasonCode } : {}),
    required: check.required,
    timedOut: check.timedOut,
    exitCode: check.exitCode,
    signal: check.signal,
    durationMs: check.durationMs,
    output: check.output === null ? null : { ...check.output },
  };
}

/** baseline preview 结构化结果（项目/argv/cwd/环境引用/timeout/政策/代码范围俱全）。 */
export function buildBaselinePreviewResult(
  projectId: string,
  preview: BaselinePreviewWireView,
): BaselinePreviewResultView {
  return {
    projectId,
    previewDigest: preview.previewDigest,
    policyRevision: preview.policyRevision,
    codeIdentity: { ...preview.codeIdentity },
    workspace: {
      excludedDirNames: [...preview.workspace.excludedDirNames],
      fileCount: preview.workspace.fileCount,
    },
    checks: preview.checks.map((check) => ({
      checkKey: check.checkKey,
      kind: check.kind,
      argv: [...check.argv],
      cwdRef: check.cwdRef,
      cwd: check.cwd,
      environmentRef: check.environmentRef,
      allowedVariables: [...check.allowedVariables],
      timeoutMs: check.timeoutMs,
      required: check.required,
    })),
    warnings: preview.warnings.map((warning) => ({
      code: warning.code,
      ...(warning.checkKey !== undefined ? { checkKey: warning.checkKey } : {}),
    })),
  };
}

/** baseline run/cancel 回执结果（{operationId,status,reasonCode?} → 展示状态）。 */
export function buildBaselineCommandResult(wire: {
  readonly operationId: string;
  readonly status: BaselineOperationStatusView;
  readonly reasonCode?: string;
}): BaselineCommandResultView {
  return {
    operationId: wire.operationId,
    state: classifyBaselineState({
      status: wire.status,
      ...(wire.reasonCode !== undefined ? { reasonCode: wire.reasonCode } : {}),
    }),
    status: wire.status,
    ...(wire.reasonCode !== undefined ? { reasonCode: wire.reasonCode } : {}),
  };
}

/** baseline status / run --wait 终态结果（逐项检查保留结果引用/耗时；携带代码身份）。 */
export function buildBaselineOperationResult(
  operation: BaselineOperationView,
  checks: readonly BaselineCheckResultView[],
  codeIdentity?: BaselineCodeIdentityView | null,
): BaselineOperationResultView {
  return {
    operationId: operation.operationId,
    state: classifyBaselineState({
      status: operation.status,
      ...(operation.reasonCode !== undefined ? { reasonCode: operation.reasonCode } : {}),
      summary: operation.summary,
      checks,
    }),
    status: operation.status,
    ...(operation.reasonCode !== undefined ? { reasonCode: operation.reasonCode } : {}),
    codeIdentity:
      codeIdentity === undefined || codeIdentity === null ? null : { ...codeIdentity },
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    endedAt: operation.endedAt,
    summary: { ...operation.summary },
    checks: checks.map(checkOutcome),
  };
}

/** baseline list 分页结果（每条记录带展示状态；摘要不折算 not_run）。 */
export function buildBaselineListResult(input: {
  readonly projectId: string;
  readonly records: readonly BaselineOperationView[];
  readonly nextCursor: string | null;
  readonly limit: number;
}): BaselineListResultView {
  return {
    projectId: input.projectId,
    records: input.records.map((record) => ({
      operationId: record.operationId,
      state: classifyBaselineState({
        status: record.status,
        ...(record.reasonCode !== undefined ? { reasonCode: record.reasonCode } : {}),
        summary: record.summary,
      }),
      status: record.status,
      ...(record.reasonCode !== undefined ? { reasonCode: record.reasonCode } : {}),
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      summary: { ...record.summary },
    })),
    nextCursor: input.nextCursor,
    limit: input.limit,
  };
}

/** baseline evidence 结果（正文原样保留；引用信息保留）。 */
export function buildBaselineEvidenceResult(
  artifactId: string,
  content: string,
): BaselineEvidenceResultView {
  return {
    artifactId,
    byteSize: content.length,
    content,
  };
}

/** argv 的无损展示：JSON 数组原样序列化，绝不拼接为 shell 命令行。 */
export function formatArgvLossless(argv: readonly string[]): string {
  return JSON.stringify([...argv]);
}

function describeCodeIdentity(identity: BaselineCodeIdentityView): string {
  const head =
    identity.headCommit === null
      ? 'null（无 HEAD；不猜测分支、不自动提交）'
      : identity.headCommit;
  const dirty = identity.hasUncommittedChanges
    ? '有未提交改动（原样保留，不 stash/reset）'
    : '干净';
  return `HEAD=${head} 工作区=${dirty} workingTreeDigest=${identity.workingTreeDigest}`;
}

/**
 * baseline preview 人类预览：明确项目、argv、cwd、环境引用、timeout、政策
 * （policyRevision/required）及脏/无 HEAD 代码范围；argv 原样展示为 JSON 数组。
 */
export function formatBaselinePreview(view: BaselinePreviewResultView): string {
  const lines: string[] = [
    'baseline preview 预览（只读事实；不执行检查命令、不安装依赖）：',
    `  项目：${view.projectId}`,
    `  代码范围：${describeCodeIdentity(view.codeIdentity)}`,
    `  工作区摘要：fileCount=${view.workspace.fileCount} excludedDirNames=${JSON.stringify([...view.workspace.excludedDirNames])}`,
    `  政策：policyRevision=${view.policyRevision}`,
    `  预览摘要：previewDigest=${view.previewDigest}（授权绑定完整输入摘要；argv/cwd/环境/timeout/政策/代码身份任一实质变化即失效）`,
    '  检查（argv 原样 JSON 数组；不拼接 shell、不追加安装命令）：',
  ];
  for (const check of view.checks) {
    const cwdRef = check.cwdRef === null ? '（仓库根）' : check.cwdRef;
    const environmentRef =
      check.environmentRef === null
        ? '（最小环境：PATH）'
        : `${check.environmentRef}（非敏感变量名：${JSON.stringify([...check.allowedVariables])}）`;
    lines.push(
      `    - ${check.checkKey}（kind=${check.kind} required=${String(check.required)} timeoutMs=${check.timeoutMs}）`,
      `      argv=${formatArgvLossless(check.argv)}`,
      `      cwdRef=${cwdRef} cwd=${check.cwd}`,
      `      environmentRef=${environmentRef}`,
    );
  }
  if (view.warnings.length > 0) {
    lines.push('  警告：');
    for (const warning of view.warnings) {
      const target = warning.checkKey === undefined ? '' : `（checkKey=${warning.checkKey}）`;
      lines.push(`    - ${warning.code}${target}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** run/cancel 回执结果的人类摘要（状态区分展示；保留 operationId）。 */
export function formatBaselineCommandResult(result: BaselineCommandResultView): string {
  const reason = result.reasonCode === undefined ? '' : ` reason=${result.reasonCode}`;
  return [
    'baseline 命令结果：',
    `  operationId=${result.operationId}`,
    `  状态：${describeBaselineState(result.state)}（status=${result.status}${reason}）`,
    '',
  ].join('\n');
}

function formatCheckOutcome(check: BaselineCheckOutcomeView): string {
  const reason = check.reasonCode === undefined ? '' : ` reason=${check.reasonCode}`;
  const required = check.required ? '必需' : '可选';
  const exit = check.exitCode === null ? 'exitCode=null' : `exitCode=${check.exitCode}`;
  const signal = check.signal === null ? '' : ` signal=${check.signal}`;
  const timedOut = check.timedOut ? ' timedOut=true' : '';
  const duration =
    check.durationMs === null ? 'durationMs=null' : `durationMs=${check.durationMs}`;
  const output =
    check.output === null
      ? 'output=（无）'
      : `output.artifactId=${check.output.artifactId} byteSize=${check.output.byteSize} truncated=${String(check.output.truncated)}`;
  return `    - ${check.checkKey}（${required}）status=${check.status}${reason} ${exit}${signal}${timedOut} ${duration} ${output}`;
}

/** status/--wait 终态的人类摘要（逐项退出码/耗时/结果引用、代码身份；not_run 显式展示）。 */
export function formatBaselineOperationResult(result: BaselineOperationResultView): string {
  const reason = result.reasonCode === undefined ? '' : ` reason=${result.reasonCode}`;
  const counts = result.summary;
  const lines = [
    'baseline 操作结果：',
    `  operationId=${result.operationId}`,
    `  状态：${describeBaselineState(result.state)}（status=${result.status}${reason}）`,
    `  时间：createdAt=${result.createdAt} startedAt=${result.startedAt ?? '（未启动）'} endedAt=${result.endedAt ?? '（未结束）'}`,
    result.codeIdentity === null
      ? '  代码身份：（无授权行；拒绝记录未执行任何检查）'
      : `  代码身份：${describeCodeIdentity(result.codeIdentity)}`,
    `  检查计数：total=${counts.total} passed=${counts.passed} failed=${counts.failed} error=${counts.error} inconclusive=${counts.inconclusive} notRun=${counts.notRun}（not_run 不折算成功）`,
    '  检查明细：',
  ];
  for (const check of result.checks) {
    lines.push(formatCheckOutcome(check));
  }
  lines.push('');
  return lines.join('\n');
}

/** baseline list 人类摘要（分页与状态区分；不折算 not_run）。 */
export function formatBaselineListResult(result: BaselineListResultView): string {
  const lines = [
    'baseline 历史列表：',
    `  项目：${result.projectId}`,
    `  limit=${result.limit} nextCursor=${result.nextCursor === null ? '（无）' : result.nextCursor}`,
  ];
  if (result.records.length === 0) {
    lines.push('  （无记录）');
  }
  for (const record of result.records) {
    const reason = record.reasonCode === undefined ? '' : ` reason=${record.reasonCode}`;
    const counts = record.summary;
    lines.push(
      `  - operationId=${record.operationId} 状态=${describeBaselineState(record.state)}（status=${record.status}${reason}）`,
      `    created=${record.createdAt} ended=${record.endedAt ?? '（未结束）'} counts=passed:${counts.passed}/failed:${counts.failed}/error:${counts.error}/inconclusive:${counts.inconclusive}/notRun:${counts.notRun}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** baseline evidence 人类输出：证据正文原样（不改写、不追加）。 */
export function formatBaselineEvidenceResult(result: BaselineEvidenceResultView): string {
  return result.content;
}

/* ------------------------------------------------------------------ *
 * §12.3 退出码与输出路由（前序五档码表 0~4）
 * ------------------------------------------------------------------ */

export type BaselineCliCommandKind =
  | 'preview'
  | 'run'
  | 'list'
  | 'status'
  | 'cancel'
  | 'evidence';

/**
 * §12.3 退出码：
 * - 查询（preview/list/status/evidence）与 cancel 成功 → 0；
 * - `baseline run` 返回 accepted（未等待）→ 0；`--decline` 记录 not_run → 0；
 * - `baseline run --wait` 仅当操作 completed 且全部必需检查 passed → 0，
 *   其余终态（failed/cancelled/interrupted/必需检查非 passed/not_run）→ 1；
 *   not_run 不折算成功检查。
 */
export function baselineCliExitCode(input: {
  readonly command: BaselineCliCommandKind;
  readonly decision?: 'authorize' | 'decline';
  readonly state?: BaselineDisplayState;
  readonly waited?: boolean;
}): CliExitCode {
  if (input.command !== 'run') {
    return CLI_EXIT_OK;
  }
  if (input.decision === 'decline') {
    return CLI_EXIT_OK;
  }
  if (input.waited !== true) {
    return CLI_EXIT_OK;
  }
  return input.state === 'passed' ? CLI_EXIT_OK : CLI_EXIT_REJECTED;
}

/**
 * 基线结果 JSON 信封：`{ok:true,command,result}`（stdout 只有可解析结构化结果；
 * 提示与诊断由调用方送 stderr）。命令身份按 §12.2 扩展为 baseline.*。
 */
export function buildBaselineSuccessEnvelope<Result>(
  command: Extract<
    AppCliCommandId,
    'baseline.preview' | 'baseline.run' | 'baseline.list' | 'baseline.status' | 'baseline.cancel' | 'baseline.evidence'
  >,
  result: Result,
): AppCliSuccessEnvelope<Result> {
  return buildAppCliSuccessEnvelope(command, result);
}
