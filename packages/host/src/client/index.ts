/**
 * F-009 client 面公共出口（纯 re-export；import 无副作用）。
 *
 * client/ 是 Host 的非契约基础设施面：允许 node:http（仅 127.0.0.1 回环）
 * 与 node:crypto；禁止文件系统（发现/凭据读取一律经 storage/）、网络其他
 * 模块、进程/线程模块与 argv。
 */
export { connectToHost, probeDiscoveredHost } from './host-client.js';
export type {
  ConnectHostClientOptions,
  HostClient,
  HostClientStopOptions,
  HostClientTimeouts,
  ProbeDiscoveredHostOptions,
} from './host-client.js';
export { mapErrorResponse, requestLoopbackJson } from './http-json.js';
export type { LoopbackJsonRequestOptions, LoopbackJsonResponse } from './http-json.js';
