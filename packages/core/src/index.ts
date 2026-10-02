/**
 * ShipLoop Core 公共入口。
 *
 * 阶段边界（P01-2）：导出最小 StateStore / ArtifactStore 窄契约、制品文件
 * 窄契约（F-010）、制品流式发布用例（F-011，application 层编排，仅依赖 ports）、
 * 配置 Payload 限定 Schema、运行时校验器与结构化错误。这些是纯契约
 * （类型、常量、纯校验函数）与无副作用的用例装配，不含任何持久化或 I/O 实现；
 * SQLite/文件适配器自 F-003 起在 adapters 层实现并不得反向进入本契约面。
 *
 * 不变量：
 * - 不导入、不重导出 Pi SDK、Electron、HTTP 框架、better-sqlite3 或 Drizzle；
 * - 不反向依赖 shiploop-host / shiploop-cli；
 * - 加载本模块没有副作用：不监听端口、不启动进程、不写用户数据。
 */
export * from './ports/errors.js';
export * from './ports/validation.js';
export * from './ports/settings-schema.js';
export * from './ports/runtime-capabilities.js';
export * from './ports/state-store.js';
export * from './ports/artifact-store.js';
export * from './ports/artifact-files.js';
export * from './ports/path-service.js';
export * from './ports/repository-inspector.js';
export * from './ports/migrations.js';
export * from './application/artifact-publish.js';
export * from './application/artifact-verify.js';
export * from './application/project-service.js';
export * from './application/configuration-service.js';
export * from './application/effective-settings.js';
