# shiploop-cli 源码

CLI 未来承担：参数解析、结构化输出、Host 客户端。详见设计 `core-design/08-host-api-and-cli.md`。

- 允许：仅在实际需要时依赖 `shiploop-host` 的公共客户端/契约（经包名）；经 HostClient 调用命令、查询与事件。
- 禁止：导入 Host 启动入口或 Host/Core 的内部实现文件；绕过 Host 直读 SQLite；当前阶段解析 argv、监听端口、启动模型或常驻进程、写用户数据。
- 当前阶段（P01-1 / F-002）只有无副作用的构建入口 `index.ts`，CLI 命令与 bin 从后续 Feature 开始。

单向依赖规则见仓库根 `README.md`。
