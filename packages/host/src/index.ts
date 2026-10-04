/**
 * ShipLoop Host 公共入口（构建产物）。
 *
 * 阶段边界：
 * - P01-1：本文件为无副作用骨架；
 * - F-002（P02-1）：导出 Host 生命周期契约公共面（`./contract`）：发现/握手/
 *   status/stop 的类型、冻结常量、身份与摘要纯函数、运行时校验和结构化错误。
 *   契约模块只使用 node:crypto 的确定性哈希，不导入 node:http/net/fs/
 *   child_process，也不依赖 ORM/Pi SDK；加载本模块仍不监听端口、不读用户
 *   目录、不启动进程；
 * - Host 启动入口（获锁、Core 装配、回环监听、发现发布、认证路由）由 F-003
 *   起的后续任务在非契约区实现，本文件不预置占位。
 */
export * from './contract/index.js';
