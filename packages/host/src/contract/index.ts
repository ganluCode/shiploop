/**
 * F-002 P02-1 Host 生命周期契约公共面（纯模块桶文件）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md。
 * 本桶只聚合类型、冻结常量、身份/摘要纯函数与运行时校验：不导入
 * node:http/net/fs/child_process，import 本模块不监听端口、不读用户目录、
 * 不启动进程；不导出任何 HTTP/ORM/SDK 类型。
 *
 * F-003 起的存储、F-006 起的入口与 F-007 起的传输都只能依赖本公共面定义的
 * 协议形状，不得各自另立协议。
 */
export * from './constants.js';
export * from './errors.js';
export * from './identifiers.js';
export * from './lifecycle.js';
export * from './validation.js';
export * from './discovery.js';
export * from './handshake.js';
export * from './status.js';
export * from './stop.js';
