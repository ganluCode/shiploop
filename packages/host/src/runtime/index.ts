/**
 * F-006 runtime 面公共出口（纯 re-export；import 无副作用）。
 */
export { startHost } from './host-startup.js';
export type { HostStartOptions, RunningHost } from './host-startup.js';
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
