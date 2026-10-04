# shiploop-host 源码

Host 未来承担：生命周期、单例认证、传输（本地 HTTP+SSE）、Runner 子进程监督入口。详见设计 `core-design/08-host-api-and-cli.md`。

- 允许：依赖 `shiploop-core` 的公共入口（经包名），在装配入口连接 Core 应用服务与适配器。
- 禁止：当前阶段监听端口、启动模型或常驻进程、写用户数据；反向要求 Core 依赖 Host；以空壳项目/调度/存储/Runtime 服务宣称业务已实现。
- 当前阶段（P02-1 / F-003）：公共入口 `index.ts` 导出两个无副作用的面——
  - `contract/`（F-002）：生命周期协议类型/常量/纯校验，仅依赖 node:crypto；
  - `storage/`（F-003）：规范根解析与受保护文件存储（0700/0600、fail-closed、
    原子发布、按实例清理），仅用 node:fs/crypto/path，不监听端口、不启动进程。
  OS 锁、启动入口与网络接口从后续任务（F-004/F-006 起）实现。

单向依赖规则见仓库根 `README.md`。
