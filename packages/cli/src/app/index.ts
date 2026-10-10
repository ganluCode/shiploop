/**
 * F-014 应用命令 CLI 纯面层公共出口（参数解析/帮助/JSON 信封/退出码）。
 * 纯 re-export；import 无副作用，不解析 argv、不联网、不读文件、不启动进程。
 * 业务命令的 HostClient/正式 dist 接线属 F-015/F-016/F-017，不经本桶导出。
 */
export {
  APP_CLI_COMMANDS,
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  parseAppCliArgs,
  parseAppInputJson,
} from './args.js';
export type {
  AppCliCommand,
  AppCliCommandId,
  AppCliParseErrorCode,
  AppCliParseReason,
  AppCommandOperation,
  AppHelpScope,
  ParsedAppCli,
  ParsedAppCliCommand,
  ParsedAppCliHelp,
  ParsedConfigCreate,
  ParsedConfigEffective,
  ParsedConfigExport,
  ParsedConfigGet,
  ParsedConfigUpdate,
  ParsedEventsObserve,
  ParsedProjectEdit,
  ParsedProjectGet,
  ParsedProjectInit,
  ParsedProjectLabels,
  ParsedProjectList,
  ParsedProjectOverview,
  ParsedProjectRegister,
  ParsedReceiptGet,
} from './args.js';
export { getAppCliHelp } from './help.js';
export {
  buildInitCliResult,
  buildInitConfirmationNotice,
  composeAppCliStreams,
  describeHeadFact,
  describeHealthStatus,
  describeWorktreeFact,
  formatInitCliResult,
  formatInitPreview,
  formatOverviewResult,
  initCliExitCode,
  resolveInitConfirmation,
} from './onboarding.js';
export type {
  AppCliStreamOutput,
  InitCliResult,
  InitConfirmationDecision,
  InitConfirmationInput,
  InitNotRunReason,
  InitRegistrationOutcome,
  InitRequestView,
  InspectedRepositoryView,
  ProjectHealthView,
  ProjectOverviewView,
  RepositoryFactView,
} from './onboarding.js';
export {
  CLI_EXIT_OBSERVATION_INTERRUPTED,
  buildAppCliFailureEnvelope,
  buildAppCliSuccessEnvelope,
  exitCodeForAppErrorCode,
  exitCodeForReceiptStatus,
  formatAppCliParseError,
} from './output.js';
export type { AppCliFailureEnvelope, AppCliSuccessEnvelope } from './output.js';
