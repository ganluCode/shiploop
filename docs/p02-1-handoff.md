# P02-1 Host 生命周期接口交接（P02-1 → P02-2 及后续）

- 来源 Feature：P02-1（Host 单例发现与本机认证），实现范围与证据见
  [acceptance/p02-1-f014-report.md](acceptance/p02-1-f014-report.md)。
- 交接对象：P02-2 及后续 Host/CLI/Runtime 任务。
- 协议依据：[p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)（唯一契约）；
  锁实现与边界：[p02-1-writer-lock.md](p02-1-writer-lock.md)；多进程回归分支映射与
  `not_run` 记录：[acceptance/evidence-p02-1/f013-regression-evidence.md](acceptance/evidence-p02-1/f013-regression-evidence.md)。
- 本文只交接**已实现并已验收**的公共面、装配顺序与失败边界；未实现能力显式标注 `not_run`，
  不代为实现，不提供虚假的整阶段 `accept:p02`。

## 1. 可复用公共面

经 `shiploop-host` 包公共入口（`exports['.']`，构建产物 `dist/index.js`）导出：

| 能力 | 入口 | 语义要点 |
|---|---|---|
| 契约 | `src/contract/` | 发现/握手/status/stop 类型、冻结常量、身份与摘要纯函数、运行时校验、结构化错误；仅 `node:crypto`，import 无副作用 |
| 受保护存储 | `createHostFileStore` / `resolveCanonicalDataRoot` | 规范根 realpath 固定、`host/` 0700 与发现/凭据 0600、fail-closed 权限/符号链接核验、原子发布、按实例清理 |
| OS 锁 | `acquireWriterLock` / `openLockedWriter` | 实际写入进程直接持 macOS `flock` fd；`openLockedWriter` 先获锁再调用写入资源工厂；关闭失败保锁 |
| 启动装配 | `startHost` / `runHostStartEntry` / `startHost` 相关 | 获锁 → `openCoreApplication`（Schema 检查）→ `127.0.0.1:0` 监听 → 新实例/凭据 → 原子发现发布 |
| 传输面 | `createHostLifecycleServer` | `/v1/host/handshake|status|stop`、Bearer/Host/Origin 校验、16 KiB 上限、有界超时、无 CORS、脱敏错误 |
| 停止控制 | `host-stop` 控制器 / 窄活动门控端口 | §10.2 门控、§10.4 幂等矩阵、§10.5 关闭顺序、§10.7 信号收尾 |
| HostClient | `connectToHost` / `probeDiscoveredHost` | 读受保护发现/凭据 → 握手双向核验后才允许 status/stop；不跟重定向、`close()` 只释放本地资源 |
| 启动器 | `ensureHostRunning` | 先发现→握手，无实例才以独立 argv spawn detached 候选；预算内重新发现胜者、落选有界回收、owner 诊断 |
| CLI 执行层 | `runHostCli`（`packages/cli` 内） | 解析 → start 接启动器 / status、stop 接 HostClient；§10.6 三证据停止确认 |

Host 公共面允许 `node:http`（仅回环）与 `shiploop-core/assembly`；契约/存储模块不导入
`node:http/net/child_process`。CLI 只经包名 `shiploop-host` 公共面复用，不引用内部子路径、
不直连 Core、不打开 SQLite。

## 2. 锁持有要求与装配顺序

- 锁粒度：**每规范数据根一把** OS 排他锁，目标 `<root>/host/writer.lock`；`writer.lock` 永不因
  停止而删除/移动/替换。别名路径竞争同一把锁，不同规范根互不阻塞。
- 顺序不变量：获锁**先于** `openCoreApplication`、SQLite 迁移与任何业务写入；释锁在关闭写入之后。
  优先使用 `openLockedWriter(options, openWriter)`：先获锁，再在工厂内打开 Core/装配监听/发布。
- 实际写入者直接持 fd（FD_CLOEXEC），无辅助持锁进程；`SIGKILL`/崩溃由 OS 释锁，不存在
  「杀持锁者但写入者仍活」的接管窗口。不得把锁 fd 转交 worker/其他进程，也不得在业务写入未关闭时释放。
- 冲突诊断二选一：`owner_active`（锁被持有且发现通过校验并完成认证握手）与 `owner_unknown`
  （锁被持有但实例无法核验）。二者都不授予写入权；`owner_unknown` 不得删锁、按 PID 杀进程、
  绕过锁打开写库或启动第二个写入者。
- 这是**协作式 advisory** 边界，不防同用户恶意进程替换锁 inode 或绕过 API 直写 SQLite；
  只支持 macOS 本地数据根，共享 NAS / 其他平台另行验收。

## 3. 发现与线协议

- 发现 `schemaVersion=1`、线协议 `protocolVersion=1`，路由 `POST /v1/host/handshake`、
  `GET /v1/host/status`、`POST /v1/host/stop`；字段与冻结顺序见契约 §5、§7–§10。
- 数据根身份 `dataRootIdentity = lower_hex(sha256(utf8Bytes(canonicalRoot)))`（64 位小写 hex，非秘密）；
  Host 与 CLI 共用契约纯函数，禁止两边各写一份。
- 凭据只经受保护文件与 `Authorization: Bearer` 头传递；不进 URL/query、argv、env、日志、
  普通状态 JSON、错误或证据附件。
- 客户端握手通过前不发业务请求；任何握手失败不自动另起写入者。

## 4. 组合根与跨包边界

- Core 组合根为 `shiploop-core/assembly` 的 `openCoreApplication`；Host 经包名与 `./assembly`
  公共入口取得已装配 Core，不导入 Core 内部实现文件。
- 单向依赖由 `scripts/check-boundaries.ts`（`npm run check:boundaries`）强制：Core 不反向依赖
  Host/CLI；CLI 不导入 Host 启动入口或 Core 实现，不绕过 Host 直读 SQLite。
- 干净树（无 `dist`）：根 `tsconfig.json` 的 `paths`、`vitest.config.ts` 的精确 alias 与测试
  子进程加载器 `test/helpers/node-ts-loader/hooks.mjs` 三处只映射包名公共入口到源码；生产
  构建/运行仍解析 `dist` 产物，不新增内部子路径映射。

## 5. 待实现能力（本 Feature 未交付，不得冒充）

- 项目注册 / 配置 / 基线（onboarding）、`project`/`run`/`feature` 等后续命令与
  `/v1/...` 业务路由。
- SSE / 事件游标 / 快照重连、Work/Batch/Run/Attempt 调度、Scheduler、Runner、Pi SDK 与模型
  执行、执行取消（进程树强制终止）、Chat、Web/Electron 配对与 CSRF、通知。
- 通用命令回执体系与 `command_receipts` 持久化：本 Feature 的「幂等」仅指同一 Host 实例的
  stop 请求在进程生命期内的版本化去重，不跨重启保留回执。
- `npm run accept:p02`（P02 阶段末项）、Windows/WSL/Linux 锁与生命周期验收、强 OS 沙箱、
  通用/签名二进制分发：`not_run` / 未支持。

## 6. 工程验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级验证为 `npm test`；工程检查编排为 `npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed），以编排退出码为通过依据。
- 建议 Harness 将本仓库 Feature 验证命令对齐 `npm run verify`；阶段验收 `npm run accept:p02`
  由阶段末项定义，本 Feature 不提供。
- 负向验收纪律：不得通过删除测试、降低门槛或扩大权限使任务通过；未运行项显式记 `not_run`。

## 7. 交接前置与安全边界

- 新增能力必须建立在本 Feature 已验收端口之上，继续遵守：输入运行时校验、破坏性操作走 CAS、
  终端状态不可覆盖、错误脱敏、`writer.lock` 永不删除、获锁先于写库。
- 首版仅正式验收 macOS 且仅面向用户明确授权的可信本机单用户模式；发现文件中的本机 `token`
  不防所有同用户攻击；强隔离需求不得复用本假设。
