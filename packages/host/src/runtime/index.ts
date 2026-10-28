/**
 * F-006 runtime 面公共出口（纯 re-export；import 无副作用）。
 */
export { BIND_OVERRIDE_ENV_KEYS, startHost } from './host-startup.js';
export type { HostStartOptions, RunningHost } from './host-startup.js';
export {
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  createHostLifecycleServer,
} from './http-transport.js';
export type { HostActivityCounts, HostLifecycleContext } from './http-transport.js';
export { handleApplicationRequest, resolveAppRoute } from './app-transport.js';
export type {
  ApplicationOperation,
  ApplicationRequestInput,
  HostApplicationContext,
  ResolvedAppRoute,
} from './app-transport.js';
export {
  SSE_BATCH_LIMIT,
  SSE_DRAIN_WAIT_MS,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_MAX_BATCH_BYTES,
  SSE_MAX_PENDING_BYTES,
  SSE_POLL_INTERVAL_MS,
  createEventStreamHub,
} from './sse-transport.js';
export type {
  EventStreamHub,
  EventStreamHubOptions,
  EventStreamRequestInput,
  ReplayLowerBoundReader,
} from './sse-transport.js';
export {
  createHostStopController,
  createIdleActivityGate,
  wireHostSignalShutdown,
} from './host-stop.js';
export type {
  HostActivityCountsView,
  HostActivityGate,
  HostStopController,
  HostStopControllerDeps,
  QuiesceAwaitResult,
  QuiesceEntryResult,
  SignalShutdownCapable,
  SignalShutdownOutcome,
  StopRespond,
} from './host-stop.js';
export {
  HOST_START_ENTRY_USAGE,
  parseHostStartArgv,
  runHostStartEntry,
} from './start-entry.js';
export type {
  HostStartEntryIo,
  HostStartEntryOutcome,
  HostStartEntryOverrides,
  HostStartEntrySuccessResult,
  ParsedHostStartArgv,
} from './start-entry.js';
export { createMcpStdioConnection, createMcpStdioConnectionManager, startMcpStdioConnections, McpStdioError } from './mcp-stdio.js';
export type {
  McpStdioCloseResult, McpStdioConnection, McpStdioConnectionManager, McpStdioConnectionOptions,
  McpStdioConnectionState, McpStdioErrorCode, McpStdioManagerStartOptions, McpStdioProcessRegistration,
  McpStdioProcessRegistrar, McpStdioProcessInspector, McpStdioReady, McpStdioStopStatus,
} from './mcp-stdio.js';

export { createMcpStartupPlanParser, buildMcpStartupPlan, prepareMcpStartupPlan, parseMcpStartupPlan, resolveMcpStartupPlan,
  MCP_PI_TOOL_NAME_MAX_LENGTH, MCP_STARTUP_MAX_ARGV, MCP_STARTUP_MAX_ENVIRONMENT, MCP_STARTUP_MAX_SERVERS,
  MCP_STARTUP_MAX_TOOLS_PER_SERVER, MCP_STARTUP_PLAN_REASONS, MCP_STARTUP_PLAN_SCHEMA_VERSION, McpStartupPlanError,
} from './mcp-startup-plan.js';
export type {
  McpApprovedServerDefinition, McpResourceResolutionInput, McpStartupPlan, McpStartupPlanGap,
  McpStartupPlanInput, McpStartupPlanParserOptions, McpStartupPlanReason, McpStartupServerPlan,
  McpStartupToolMapping, McpTrustedResourceResolver,
} from './mcp-startup-plan.js';

export type { PiInferenceSource } from './pi-inference-preflight.js';
export { createPiGitAgentRuntimeAdapter } from './pi-git-agent-adapter.js';
export type { PiGitAgentRuntimeDriver, PiGitAgentRuntimeOptions } from './pi-git-agent-adapter.js';
export { createPiWorkRuntimeFactory } from './pi-work-runtime.js';
export {
  createPiAuthenticationCatalog,
  createPiEnvironmentAuthenticationSource,
  createPiLocalLoginAuthenticationSource,
  PI_AUTHENTICATION_MAX_FILE_BYTES,
  PI_AUTHENTICATION_MAX_KEY_BYTES,
} from './pi-authentication.js';
export type { PiWorkRuntimeOptions } from './pi-work-runtime.js';
export {
  PI_NATIVE_SESSION_FORMAT,
  PI_NATIVE_SESSION_FORMAT_VERSION,
  PI_RECOVERY_EVIDENCE_REF,
  PI_RUNTIME_RECOVERY_CAPABILITIES,
  PI_RUNTIME_RECOVERY_DESCRIPTOR,
  PI_ADAPTER_VERSION,
  PI_RUNTIME_CAPABILITIES,
  PI_RUNTIME_ID,
  PI_SDK_LICENSE,
  PI_SDK_VERSION,
  assertPiStartupCompatible,
  createPiRuntimeAdapter,
  createPiRuntimeDescriptor,
  createPiSdkSessionFactory,
} from './pi-adapter.js';
export type {
  PiCapabilityStatus,
  PiManagedRecoverySource,
  PiRecoverySourceManager,
  PiRecoveryWriterLease,
  PiRuntimeAdapterOptions,
  PiRuntimeCapabilities,
  PiRuntimeDescriptor,
  PiRuntimeRegistration,
  PiSession,
  PiSessionFactory,
  PiSessionFactoryOptions,
  PiSubmissionToolDefinition,
  PiTrustedAssembly,
  PiTrustedInputReader,
} from './pi-adapter.js';
export { validatePiSubmissionTools } from './pi-adapter.js';

export type { PiPreparedRecovery } from './pi-native-session.js';

export { createHostWorkToolAccess } from './work-tool-access.js';
export type { HostWorkToolAccess, HostWorkToolAuthentication } from './work-tool-access.js';
// P05-1 / F-006：规划候选受限提交的 Pi 自定义工具桥（可信装配注入）。
export { createPlanningCandidateSubmitTool, PLANNING_SUBMIT_TOOL_NAME } from './work-submission-tools.js';
export type { PlanningCandidateSubmitToolOptions } from './work-submission-tools.js';
