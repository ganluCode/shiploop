/**
 * F-003 受保护 Host 文件存储公共面（桶文件）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §3.1–§3.3、§4.2、§5.2、§10.5。
 * 与 contract/ 的纯模块不同，本目录是 Host 的非契约基础设施区：允许使用
 * node:fs/node:crypto/node:path 的真实文件能力，但仍不导入 node:http/net/
 * child_process、不监听端口、不启动进程；import 本目录不做任何文件写入。
 */
export * from './layout.js';
export * from './canonical-root.js';
export * from './host-file-store.js';
