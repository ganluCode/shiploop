/**
 * F-011 CLI 纯参数解析（契约 §13.1/§13.2）。
 *
 * 纪律：
 * - 同步纯函数：不读 process.argv / process.env（env 必须显式注入，F-012
 *   传 process.env）、不读发现、不访问网络、不启动 Host、不生成 stop
 *   commandId（省略时由执行层生成）；解析失败即 HostCliParseError，
 *   F-012 保证在解析成功前不做任何 I/O；
 * - 只识别 host start/status/stop 三个生命周期子命令，没有 project/run；
 * - 监听地址覆盖零容忍：--bind/--host/--address/--port/--listen* 参数与
 *   SHIPLOOP_HOST_* env 覆盖一律 bind_address_override_rejected（退出码 2），
 *   参数检测先于未知参数，覆盖值不进入错误信息；
 * - 错误只携带 code/reason/参数名与尽力识别的 command/json 路由标记，
 *   绝不回显参数值。
 */
import { BIND_OVERRIDE_ENV_KEYS, DEFAULT_START_BUDGET_MS, isUuidV4 } from 'shiploop-host';

export const HOST_CLI_SUBCOMMANDS = ['start', 'status', 'stop'] as const;
export type HostCliSubcommand = (typeof HOST_CLI_SUBCOMMANDS)[number];
export type HostCliCommandId = `host.${HostCliSubcommand}`;

export type HelpScope = 'top' | 'host' | HostCliSubcommand;

export interface ParsedHostCliHelp {
  readonly kind: 'help';
  readonly scope: HelpScope;
}

interface ParsedCommandBase {
  readonly command: HostCliSubcommand;
  readonly commandId: HostCliCommandId;
  readonly json: boolean;
  readonly dataRoot?: string;
}

export interface ParsedStartCliCommand extends ParsedCommandBase {
  readonly kind: 'command';
  readonly command: 'start';
  readonly commandId: 'host.start';
  readonly startTimeoutMs: number;
}

export interface ParsedStatusCliCommand extends ParsedCommandBase {
  readonly kind: 'command';
  readonly command: 'status';
  readonly commandId: 'host.status';
}

export interface ParsedStopCliCommand extends ParsedCommandBase {
  readonly kind: 'command';
  readonly command: 'stop';
  readonly commandId: 'host.stop';
  readonly stopCommandId?: string;
  readonly confirmTimeoutMs: number;
}

export type ParsedHostCliCommand =
  | ParsedStartCliCommand
  | ParsedStatusCliCommand
  | ParsedStopCliCommand;

export type ParsedHostCli = ParsedHostCliCommand | ParsedHostCliHelp;

/** §13.2 start 预算（默认复用启动器库常量，CLI 区间 1000..60000）。 */
export const CLI_START_TIMEOUT_DEFAULT_MS = DEFAULT_START_BUDGET_MS;
export const CLI_START_TIMEOUT_MIN_MS = 1_000;
export const CLI_START_TIMEOUT_MAX_MS = 60_000;

/** §13.2 confirm 预算：等待进程退出/释锁/发现移除证据。 */
export const CLI_CONFIRM_TIMEOUT_DEFAULT_MS = 10_000;
export const CLI_CONFIRM_TIMEOUT_MIN_MS = 0;
export const CLI_CONFIRM_TIMEOUT_MAX_MS = 30_000;

export type HostCliParseErrorCode = 'invalid_input' | 'bind_address_override_rejected';

/** 受控原因码（可进 details.reason）；新增原因只追加不改写。 */
export type HostCliParseReason =
  | 'invalid_argv_type'
  | 'missing_command'
  | 'unknown_command'
  | 'missing_subcommand'
  | 'unknown_subcommand'
  | 'host_level_option'
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
  | 'invalid_stop_command_id'
  | 'option_not_allowed_for_command'
  | 'listen_override_argument_rejected'
  | 'listen_override_env_rejected';

const REASON_MESSAGE: Readonly<Record<HostCliParseReason, string>> = Object.freeze({
  invalid_argv_type: 'argv 必须是字符串数组',
  missing_command: '缺少命令；本版本仅提供 shiploop host start/status/stop',
  unknown_command: '未知顶层命令；本版本仅提供 host 生命周期命令',
  missing_subcommand: 'host 缺少子命令（start/status/stop）',
  unknown_subcommand: '未知 host 子命令（仅支持 start/status/stop）',
  host_level_option: '选项必须位于 host 子命令之后',
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
  invalid_stop_command_id: 'stop-command-id 必须是 UUID v4',
  option_not_allowed_for_command: '该参数不适用于当前子命令',
  listen_override_argument_rejected: '拒绝监听地址覆盖参数：Host 只监听 127.0.0.1',
  listen_override_env_rejected: '拒绝监听地址覆盖环境变量：Host 只监听 127.0.0.1',
});

/**
 * 参数解析失败。code 决定 §13.3 退出码（两类都映射 2）；reason/field 是
 * 受控诊断；command/json 为尽力识别（用于 F-012 的 stdout/stderr 路由），
 * 任何用户提供的值都不进入本错误。
 */
export class HostCliParseError extends Error {
  readonly code: HostCliParseErrorCode;
  readonly reason: HostCliParseReason;
  readonly field: string | undefined;
  readonly command: HostCliSubcommand | null;
  readonly json: boolean;

  constructor(
    code: HostCliParseErrorCode,
    reason: HostCliParseReason,
    state: ParseState,
    field?: string,
  ) {
    super(REASON_MESSAGE[reason]);
    this.name = 'HostCliParseError';
    this.code = code;
    this.reason = reason;
    this.field = field;
    this.command = state.command;
    this.json = state.json;
  }
}

/** 与 Host 启动入口相同的 argv 覆盖检测形态（六个前缀的 exact/=/连字符变体）。 */
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

type ValueField = 'dataRoot' | 'startTimeoutMs' | 'stopCommandId' | 'confirmTimeoutMs';

const VALUE_LONG_FLAGS: Readonly<Record<string, ValueField>> = Object.freeze({
  '--data-root': 'dataRoot',
  '--start-timeout-ms': 'startTimeoutMs',
  '--stop-command-id': 'stopCommandId',
  '--confirm-timeout-ms': 'confirmTimeoutMs',
});

const FIELD_ALLOWED_COMMANDS: Readonly<Record<ValueField, readonly HostCliSubcommand[]>> =
  Object.freeze({
    dataRoot: HOST_CLI_SUBCOMMANDS,
    startTimeoutMs: ['start'],
    stopCommandId: ['stop'],
    confirmTimeoutMs: ['stop'],
  });

interface ParseState {
  command: HostCliSubcommand | null;
  json: boolean;
  readonly seen: Set<string>;
  dataRoot: string | undefined;
  startTimeoutMs: number | undefined;
  stopCommandId: string | undefined;
  confirmTimeoutMs: number | undefined;
}

function isHelpToken(argument: string): boolean {
  return argument === '--help' || argument === '-h';
}

function parseNonNegativeInteger(raw: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

function validateValue(
  state: ParseState,
  field: ValueField,
  raw: string,
): string | number {
  switch (field) {
    case 'dataRoot': {
      if (raw.length === 0) {
        throw new HostCliParseError('invalid_input', 'data_root_empty', state, field);
      }
      if (raw.includes('\0')) {
        throw new HostCliParseError('invalid_input', 'data_root_contains_nul', state, field);
      }
      if (!raw.startsWith('/')) {
        throw new HostCliParseError('invalid_input', 'data_root_not_absolute', state, field);
      }
      if (raw === '/') {
        throw new HostCliParseError(
          'invalid_input',
          'data_root_is_filesystem_root',
          state,
          field,
        );
      }
      return raw;
    }
    case 'stopCommandId': {
      if (!isUuidV4(raw)) {
        throw new HostCliParseError('invalid_input', 'invalid_stop_command_id', state, field);
      }
      return raw;
    }
    case 'startTimeoutMs': {
      const value = parseNonNegativeInteger(raw);
      if (value === undefined) {
        throw new HostCliParseError('invalid_input', 'invalid_integer', state, field);
      }
      if (value < CLI_START_TIMEOUT_MIN_MS || value > CLI_START_TIMEOUT_MAX_MS) {
        throw new HostCliParseError('invalid_input', 'integer_out_of_range', state, field);
      }
      return value;
    }
    case 'confirmTimeoutMs': {
      const value = parseNonNegativeInteger(raw);
      if (value === undefined) {
        throw new HostCliParseError('invalid_input', 'invalid_integer', state, field);
      }
      if (value < CLI_CONFIRM_TIMEOUT_MIN_MS || value > CLI_CONFIRM_TIMEOUT_MAX_MS) {
        throw new HostCliParseError('invalid_input', 'integer_out_of_range', state, field);
      }
      return value;
    }
  }
}

function rejectOverrideArgument(state: ParseState): never {
  throw new HostCliParseError(
    'bind_address_override_rejected',
    'listen_override_argument_rejected',
    state,
  );
}

function rejectOverrideEnv(state: ParseState, name: string): never {
  throw new HostCliParseError(
    'bind_address_override_rejected',
    'listen_override_env_rejected',
    state,
    name,
  );
}

/** 解析已选定子命令后的选项序列；返回遇到 --help 的信号。 */
function parseCommandOptions(args: readonly string[], state: ParseState): boolean {
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;

    if (isHelpToken(argument)) {
      help = true;
      continue;
    }
    if (argument.startsWith('--help=')) {
      throw new HostCliParseError('invalid_input', 'bool_flag_takes_no_value', state, 'help');
    }
    // 监听覆盖检测先于任何其他参数识别（安全 fail-closed）。
    if (isListenOverrideArgument(argument)) {
      rejectOverrideArgument(state);
    }

    if (argument === '--json') {
      if (state.seen.has('json')) {
        throw new HostCliParseError('invalid_input', 'duplicate_option', state, 'json');
      }
      state.seen.add('json');
      state.json = true;
      continue;
    }
    if (argument.startsWith('--json=')) {
      throw new HostCliParseError('invalid_input', 'bool_flag_takes_no_value', state, 'json');
    }

    const equalsIndex = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    const field = VALUE_LONG_FLAGS[name];

    if (field !== undefined) {
      const command = state.command as HostCliSubcommand;
      if (!FIELD_ALLOWED_COMMANDS[field].includes(command)) {
        throw new HostCliParseError(
          'invalid_input',
          'option_not_allowed_for_command',
          state,
          field,
        );
      }
      if (state.seen.has(field)) {
        throw new HostCliParseError('invalid_input', 'duplicate_option', state, field);
      }
      let raw: string;
      if (equalsIndex >= 0) {
        raw = argument.slice(equalsIndex + 1);
      } else {
        const next = args[index + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new HostCliParseError('invalid_input', 'missing_value', state, field);
        }
        raw = next;
        index += 1;
      }
      const validated = validateValue(state, field, raw);
      state.seen.add(field);
      if (field === 'dataRoot') {
        state.dataRoot = validated as string;
      } else if (field === 'startTimeoutMs') {
        state.startTimeoutMs = validated as number;
      } else if (field === 'stopCommandId') {
        state.stopCommandId = validated as string;
      } else {
        state.confirmTimeoutMs = validated as number;
      }
      continue;
    }

    if (argument === '--' || !argument.startsWith('-')) {
      throw new HostCliParseError('invalid_input', 'unexpected_positional', state);
    }
    throw new HostCliParseError('invalid_input', 'unknown_argument', state);
  }
  return help;
}

function assertNoEnvOverride(state: ParseState, env: Readonly<Record<string, string | undefined>>): void {
  for (const name of BIND_OVERRIDE_ENV_KEYS) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) {
      rejectOverrideEnv(state, name);
    }
  }
}

function buildCommand(state: ParseState): ParsedHostCliCommand {
  const command = state.command as HostCliSubcommand;
  if (command === 'start') {
    return {
      kind: 'command',
      command,
      commandId: 'host.start',
      json: state.json,
      ...(state.dataRoot !== undefined ? { dataRoot: state.dataRoot } : {}),
      startTimeoutMs: state.startTimeoutMs ?? CLI_START_TIMEOUT_DEFAULT_MS,
    };
  }
  if (command === 'status') {
    return {
      kind: 'command',
      command,
      commandId: 'host.status',
      json: state.json,
      ...(state.dataRoot !== undefined ? { dataRoot: state.dataRoot } : {}),
    };
  }
  return {
    kind: 'command',
    command,
    commandId: 'host.stop',
    json: state.json,
    ...(state.dataRoot !== undefined ? { dataRoot: state.dataRoot } : {}),
    ...(state.stopCommandId !== undefined ? { stopCommandId: state.stopCommandId } : {}),
    confirmTimeoutMs: state.confirmTimeoutMs ?? CLI_CONFIRM_TIMEOUT_DEFAULT_MS,
  };
}

/**
 * 纯解析受控 argv（process.argv.slice(2) 形态）与显式注入的 env。
 * 返回命令意图或帮助意图；非法输入抛 HostCliParseError（退出码 2），
 * 全程无 I/O。帮助短路于 env 检查，但不短路其他参数的严格校验。
 */
export function parseHostCliArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): ParsedHostCli {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new HostCliParseError('invalid_input', 'invalid_argv_type', {
      command: null,
      json: false,
      seen: new Set<string>(),
      dataRoot: undefined,
      startTimeoutMs: undefined,
      stopCommandId: undefined,
      confirmTimeoutMs: undefined,
    });
  }

  const state: ParseState = {
    command: null,
    json: args.includes('--json'),
    seen: new Set<string>(),
    dataRoot: undefined,
    startTimeoutMs: undefined,
    stopCommandId: undefined,
    confirmTimeoutMs: undefined,
  };

  if (args.length === 0) {
    throw new HostCliParseError('invalid_input', 'missing_command', state);
  }

  // shiploop --help / -h（只允许帮助标记；夹带其他 token 按未知命令处理）。
  if (args.every((argument) => isHelpToken(argument))) {
    return { kind: 'help', scope: 'top' };
  }

  const first = args[0] as string;
  if (first !== 'host') {
    throw new HostCliParseError('invalid_input', 'unknown_command', state);
  }

  const rest = args.slice(1);
  if (rest.length === 0) {
    throw new HostCliParseError('invalid_input', 'missing_subcommand', state);
  }

  let hostHelp = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (isHelpToken(argument)) {
      hostHelp = true;
      continue;
    }
    if (argument.startsWith('--help=')) {
      throw new HostCliParseError('invalid_input', 'bool_flag_takes_no_value', state, 'help');
    }
    if (isListenOverrideArgument(argument)) {
      rejectOverrideArgument(state);
    }
    if (state.command === null) {
      if (argument.startsWith('-')) {
        throw new HostCliParseError('invalid_input', 'host_level_option', state);
      }
      if (!HOST_CLI_SUBCOMMANDS.includes(argument as HostCliSubcommand)) {
        throw new HostCliParseError('invalid_input', 'unknown_subcommand', state);
      }
      state.command = argument as HostCliSubcommand;
      const commandHelp = parseCommandOptions(rest.slice(index + 1), state);
      if (hostHelp || commandHelp) {
        return { kind: 'help', scope: state.command };
      }
      assertNoEnvOverride(state, env);
      return buildCommand(state);
    }
  }

  if (hostHelp) {
    return { kind: 'help', scope: 'host' };
  }
  throw new HostCliParseError('invalid_input', 'missing_subcommand', state);
}
