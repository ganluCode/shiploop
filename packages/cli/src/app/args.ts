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

export const APP_CLI_COMMANDS = ['project', 'config', 'receipt', 'events', 'baseline'] as const;
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
  | 'baseline.evidence';

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
  | 'baseline.cancel';

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
  | 'input_identity_field_rejected';

const REASON_MESSAGE: Readonly<Record<AppCliParseReason, string>> = Object.freeze({
  invalid_argv_type: 'argv 必须是字符串数组',
  missing_command: '缺少命令；本版本提供 project/config/receipt/events/baseline',
  unknown_command: '未知顶层命令；本版本仅提供 project/config/receipt/events/baseline',
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

function requireInputFile(scan: ScanResult, state: ParseState): string {
  const raw = requireOption(scan, '--input', state, 'input');
  if (raw.length === 0 || raw.includes('\0')) {
    fail(state, 'invalid_input_file', 'input');
  }
  return raw;
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

export type ParsedAppCliCommand =
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
  | ParsedBaselineEvidence;

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
