/**
 * ShipLoop Core 公共入口。
 *
 * 阶段边界（P01-1 / F-002）：本文件只确立构建产物与分层边界。
 * 领域状态机、应用服务、端口与适配器均在后续 Feature 实现，
 * 此处不提供项目、调度、存储或 Runtime 的占位服务，也不导出空壳类型。
 *
 * 不变量：
 * - 不导入、不重导出 Pi SDK、Electron、HTTP 框架、better-sqlite3 或 Drizzle；
 * - 不反向依赖 shiploop-host / shiploop-cli；
 * - 加载本模块没有副作用：不监听端口、不启动进程、不写用户数据。
 */
export {};
