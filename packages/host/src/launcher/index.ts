/**
 * F-010 launcher 面公共出口（纯 re-export；import 无副作用）。
 *
 * launcher/ 是 Host 的非契约基础设施面：允许 node:child_process（detached
 * 独立 argv spawn）、node:os（默认根推导的用户目录缺省）、node:url（默认
 * 入口路径计算）、node:path（形态校验）与 node:timers/promises（有界轮询）；
 * 禁止文件系统（发现/凭据读取一律经 storage/）、网络（连接一律经 client/）、
 * argv，不打开 SQLite（不引用 Core 装配入口）。
 */
export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_START_BUDGET_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_START_BUDGET_MS,
  MIN_POLL_INTERVAL_MS,
  MIN_START_BUDGET_MS,
  ensureHostRunning,
  resolveConnectDataRoot,
} from './host-launcher.js';
export type {
  CandidateExitInfo,
  EnsureHostOptions,
  EnsureHostResult,
  EnsuredHostCandidate,
  ResolveConnectRootOptions,
} from './host-launcher.js';
