# shiploop-host 源码

Host 未来承担：生命周期、单例认证、传输（本地 HTTP+SSE）、Runner 子进程监督入口。详见设计 `core-design/08-host-api-and-cli.md`。

- 允许：依赖 `shiploop-core` 的公共入口（经包名），在装配入口连接 Core 应用服务与适配器。
- 禁止：当前阶段监听端口、启动模型或常驻进程、写用户数据；反向要求 Core 依赖 Host；以空壳项目/调度/存储/Runtime 服务宣称业务已实现。
- 当前阶段（P01-1 / F-002）只有无副作用的构建入口 `index.ts`，网络接口与认证从后续 Feature 开始。

单向依赖规则见仓库根 `README.md`。
