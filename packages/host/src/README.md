# shiploop-host 源码

Host 未来承担：生命周期、单例认证、传输（本地 HTTP+SSE）、Runner 子进程监督入口。详见设计 `core-design/08-host-api-and-cli.md`。

- 允许：依赖 `shiploop-core` 的公共入口（经包名），在装配入口连接 Core 应用服务与适配器。
- 禁止：当前阶段监听端口、启动模型或常驻进程、写用户数据；反向要求 Core 依赖 Host；以空壳项目/调度/存储/Runtime 服务宣称业务已实现。
- 当前阶段（P02-1 / F-010）：公共入口 `index.ts` 导出六个无副作用的面——
  - `contract/`（F-002）：生命周期协议类型/常量/纯校验，仅依赖 node:crypto；
  - `storage/`（F-003）：规范根解析与受保护文件存储（0700/0600、fail-closed、
    原子发布、按实例清理），仅用 node:fs/crypto/path，不监听端口、不启动进程。
  - `locking/`（F-004）：真实 macOS flock、实际写入进程直接持 fd、有界获取、
    可信认证探测端口与获锁后打开/关闭失败保锁；无辅助进程，显式调用才加载原生模块。
  - `runtime/`（F-006/F-007/F-008）：startHost 启动装配（获锁 → openCoreApplication/Schema →
    127.0.0.1:0 监听并核验套接字 → 新实例/凭据 → 原子发现发布 → ready；失败逆序
    关闭并释锁）与受控 argv 入口逻辑（runHostStartEntry/parseHostStartArgv）；
    http-transport.ts（F-007）为真实生命周期传输面：握手/status 认证路由
    （Bearer timingSafeEqual、Host/Origin 校验、16 KiB 上限、有界 headers/request
    超时、connection: close、无 CORS、脱敏错误）；host-stop.ts（F-008）为停止
    控制器：§10.2 窄活动门控（生产恒空闲）、§10.4 幂等矩阵、§10.5 收尾顺序与
    §10.7 SIGTERM/SIGINT 安全收尾（wireHostSignalShutdown 由 start.ts 装配）。
    允许 node:http 与 shiploop-core 公共入口（包名 + ./assembly，host 包已声明
    工作区依赖）；监听覆盖（选项/env/argv）零容忍；import 仍无副作用。
    显式启动入口 `start.ts` → dist/start.js（node …/dist/start.js --data-root <abs>）。
    不装配 Pi/模型执行。原生工具与装配前提见
  [写入锁决定](../../../docs/p02-1-writer-lock.md)。
  - `client/`（F-009）：CLI 可复用 HostClient（connectToHost/probeDiscoveredHost）。
    受保护发现/凭据读取（经 storage/）→ 握手双向核验（协议/实例/数据根/能力）
    通过后才允许 status/stop；不跟随 3xx、错误按契约 §14 精确分类、close() 只
    释放本地观察资源。允许 node:http（仅回环）与 node:crypto；禁止文件系统、
    其他网络/进程/线程模块与 argv/env。
  - `launcher/`（F-010）：连接或启动编排（ensureHostRunning，契约 §12.4）。
    先经 client/ 发现→握手，有效实例直接连接；无实例/失效发现才以独立 argv
    （无 shell）spawn detached 正式 Host 入口候选（默认 dist/start.js），预算内
    轮询重新发现胜者；落选/失败候选有界回收核验（SIGTERM→SIGKILL，只针对自有
    spawn 句柄 pid），锁所有者诊断经 F-004 ownerProbe + probeDiscoveredHost
    （获锁即释、不开 Core）。允许 node:child_process/os/url/path/timers 与
    shiploop-core 纯契约入口；禁止文件系统、网络直连、argv 与
    shiploop-core/assembly（不打开 SQLite）。

单向依赖规则见仓库根 `README.md`。
