/**
 * F-006 runtime 面公共出口（纯 re-export；import 无副作用）。
 */
export { startHost } from './host-startup.js';
export type { HostStartOptions, RunningHost } from './host-startup.js';
export {
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  createHostLifecycleServer,
} from './http-transport.js';
export type { HostActivityCounts, HostLifecycleContext } from './http-transport.js';
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
