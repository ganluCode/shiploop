# shiploop-host 源码

Host 未来承担：生命周期、单例认证、传输（本地 HTTP+SSE）、Runner 子进程监督入口。详见设计 `core-design/08-host-api-and-cli.md`。

- 允许：依赖 `shiploop-core` 的公共入口（经包名），在装配入口连接 Core 应用服务与适配器。
- 禁止：当前阶段监听端口、启动模型或常驻进程、写用户数据；反向要求 Core 依赖 Host；以空壳项目/调度/存储/Runtime 服务宣称业务已实现。
- 当前阶段（P02-1 / F-006）：公共入口 `index.ts` 导出四个无副作用的面——
  - `contract/`（F-002）：生命周期协议类型/常量/纯校验，仅依赖 node:crypto；
  - `storage/`（F-003）：规范根解析与受保护文件存储（0700/0600、fail-closed、
    原子发布、按实例清理），仅用 node:fs/crypto/path，不监听端口、不启动进程。
  - `locking/`（F-004）：真实 macOS flock、实际写入进程直接持 fd、有界获取、
    可信认证探测端口与获锁后打开/关闭失败保锁；无辅助进程，显式调用才加载原生模块。
  - `runtime/`（F-006）：startHost 启动装配（获锁 → openCoreApplication/Schema →
    127.0.0.1:0 监听并核验套接字 → 新实例/凭据 → 原子发现发布 → ready；失败逆序
    关闭并释锁）与受控 argv 入口逻辑（runHostStartEntry/parseHostStartArgv）。
    允许 node:http 与 shiploop-core 公共入口（包名 + ./assembly，host 包已声明
    工作区依赖）；监听覆盖（选项/env/argv）零容忍；import 仍无副作用。
    显式启动入口 `start.ts` → dist/start.js（node …/dist/start.js --data-root <abs>）。
    HTTP 认证路由（握手/status/stop）留给 F-007/F-008；F-006 监听器为 404 占位
    传输面，不装配 Pi/模型执行。原生工具与装配前提见
  [写入锁决定](../../../docs/p02-1-writer-lock.md)。

单向依赖规则见仓库根 `README.md`。
