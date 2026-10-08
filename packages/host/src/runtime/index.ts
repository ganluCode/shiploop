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
