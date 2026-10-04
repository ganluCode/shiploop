/**
 * ShipLoop Host 公共入口（构建产物）。
 *
 * 阶段边界：
 * - P01-1：本文件为无副作用骨架；
 * - F-002（P02-1）：导出 Host 生命周期契约公共面（`./contract`）：发现/握手/
 *   status/stop 的类型、冻结常量、身份与摘要纯函数、运行时校验和结构化错误。
 *   契约模块只使用 node:crypto 的确定性哈希，不导入 node:http/net/fs/
 *   child_process，也不依赖 ORM/Pi SDK；
 * - F-003（P02-1）：导出受保护文件存储（`./storage`）：规范数据根解析、
 *   host/ 0700 目录与 0600 发现/凭据文件、原子发现发布、按实例清理。存储
 *   模块允许使用 node:fs/node:crypto/node:path，但不导入 node:http/net/
 *   child_process，不监听端口、不启动进程；
 * - F-004（P02-1）：导出 locking/，实际写入进程直接持 macOS flock fd；
 *   显式调用才加载原生适配器与获锁，关闭写入与清理失败保锁；无辅助进程。
 * - F-006（P02-1）：导出 runtime/ 启动装配（startHost）与受控 argv 入口逻辑
 *   （runHostStartEntry/parseHostStartArgv）：获锁 → 打开 Core（Schema 检查）→
 *   127.0.0.1:0 监听 → 新实例/凭据 → 原子发现发布；监听覆盖（选项/env/argv）
 *   零容忍。runtime 面允许 node:http 与 shiploop-core 公共入口（含
 *   ./assembly），但 import 本模块仍不监听端口、不读用户目录、不启动进程、
 *   不写文件；显式执行入口为 dist/start.js（见 src/start.ts）。
 *   HTTP 生命周期路由（handshake/status/stop）留给 F-007/F-008；F-006 监听器
 *   为占位传输面（任何请求一律 404 unknown_operation）。
 * - 三个面加载本模块仍不监听端口、不读用户目录、不启动进程、不写文件；
 */
export * from './contract/index.js';
export * from './storage/index.js';
export * from './locking/index.js';
export * from './runtime/index.js';
