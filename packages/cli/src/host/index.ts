/**
 * F-011 Host 生命周期 CLI 纯面层公共出口（参数解析/帮助/JSON 信封/退出码）。
 * 纯 re-export；import 无副作用，不解析 argv、不联网、不启动进程。
 * 显式可执行入口（bin.ts → dist/bin.js）与 HostClient/启动器接线属 F-012。
 */
export {
  CLI_CONFIRM_TIMEOUT_DEFAULT_MS,
  CLI_CONFIRM_TIMEOUT_MAX_MS,
  CLI_CONFIRM_TIMEOUT_MIN_MS,
  CLI_START_TIMEOUT_DEFAULT_MS,
  CLI_START_TIMEOUT_MAX_MS,
  CLI_START_TIMEOUT_MIN_MS,
  HOST_CLI_SUBCOMMANDS,
  HostCliParseError,
  parseHostCliArgs,
} from './args.js';
export type {
  HelpScope,
  HostCliCommandId,
  HostCliParseErrorCode,
  HostCliParseReason,
  HostCliSubcommand,
  ParsedHostCli,
  ParsedHostCliCommand,
  ParsedHostCliHelp,
  ParsedStartCliCommand,
  ParsedStatusCliCommand,
  ParsedStopCliCommand,
} from './args.js';
export { getHostCliHelp } from './help.js';
export {
  CLI_EXIT_CONNECTION,
  CLI_EXIT_INPUT,
  CLI_EXIT_OK,
  CLI_EXIT_REJECTED,
  buildHostCliFailureEnvelope,
  buildHostCliSuccessEnvelope,
  exitCodeForHostErrorCode,
  formatHostCliParseError,
} from './output.js';
export type {
  CliExitCode,
  HostCliFailureEnvelope,
  HostCliSuccessEnvelope,
} from './output.js';
