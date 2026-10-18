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

  P02-2（契约 docs/p02-2-commands-events-contract.md）：
  - 线消息 schemaVersion 升 2（§3.1：握手/stop/status/命令/查询响应；发现
    schemaVersion=1 与 protocolVersion=1 不联动）；握手 capabilities 为 §11.3
    结构化视图（application.commands/queries 为真实接线清单，F-012 起
    application.events 为 {transport:'sse', route:'/v1/events',
    scopes:['project','global']} 冻结结构化视图），客户端校验对伪称/缺键零容忍。
  - F-011 `runtime/app-transport.ts`：§3.2 应用路由（POST /v1/commands、
    GET /v1/receipts/:commandId、/v1/results/:resultRef、项目/配置/快照查询），
    由 http-transport 在同一监听上委派；未装配 SSE Hub 的传输面上下文对
    /v1/events 保持认证后 501（防御纵深，不伪称可用）。命令体积
    上限 65 536 B（/v1/host/* 仍 16 384）、查询串 8 192 B、查询响应 65 536 B
    （超限 500 不泄漏业务内容）；信封结构 400 先于凭据、版本/未知操作 400/501
    在凭据之后；quiescing 拒绝新变更（503 not_ready）；Host 只传递可信装配
    固定绑定的 principal（生产恒 local-owner），授权全部在 Core 应用层。
    `runtime/http-primitives.ts` 为两个传输面共用底层原语（有界读体/响应/
    Bearer timingSafeEqual 与 RouteReject 控制流拒绝）。
  - F-012 `runtime/sse-transport.ts`：§9.4 `GET /v1/events` SSE 订阅 Hub
    （createEventStreamHub）——唯一事件来源是持久 state_events（每批经 Core
    QueryService.resolveEventResume/readEventBatch，轮询仅唤醒读取；每批重新
    核验当前授权，越权在发送任何帧之前 403）；恢复位置优先级
    Last-Event-ID → ?cursor= → 缺省 400 cursor_required；建连前游标低于
    可续读下界 409 snapshot_required（受控读取缝注入，生产恒 0），建连后以
    event: error 帧 + 正常结束呈现；背压预算（§13/§15.6）：待发缓冲
    1 048 576 B、单批 500 条/262 144 B、drain 等待 2 000 ms，超限发一帧
    stream_overflow 后结束该流（不丢持久审计、不阻塞快客户端）；心跳
    15 000 ms；连接关闭只清理本连接定时器/登记，客户端断开不回滚命令、
    不停止 Host；closeAll 接入 §10.5 收尾与装配拆卸，重启后原持久游标可
    续读；建连后解除 requestTimeout，响应仍 no-store/connection: close，
    不发 CORS/3xx。真实回环 HTTP/SSE 回归见 test/modules/host/host-sse-events.test.ts。

单向依赖规则见仓库根 `README.md`。
