# P02-2 F-018 集成回归证据（脱敏）

- 任务：F-018 补齐 P02-2 的真实 SQLite/HTTP/SSE/CLI 集成回归（契约
  `docs/p02-2-commands-events-contract.md` §14 映射；证据只含非秘密的计数、
  状态、事件 sequence、进程退出与命令退出码）。
- 受测入口：生产 Host 装配 `startHost`（`packages/host/src/runtime/`）、
  生产 CLI 执行层 `runAppCli`/`runHostCli`（dist/bin.js 同一路径，经测试加载器
  hooks 以 TS 源码启动 detached Host 子进程）、`shiploop-core` 装配入口
  `openCoreApplication`。
- 新增回归套件：`test/modules/commands/p02-2-integration-regression.test.ts`（6 项）；复用
  F-004 夹具（临时沙箱、真实 Git 仓库 A/B、同步屏障、SSE 原始客户端、只读
  存储探针）与 P02-1 隔离环境夹具。
- 运行边界：macOS（flock）、真实临时数据根（沙箱内独立 home/tmp/data，不读
  写真实 HOME 或用户项目）、真实 Node 子进程、真实回环 HTTP/SSE；不调用
  模型；全部凭据为秘密，Authorization 头与 token 正文不进任何证据。
- 本文档不记录开发机绝对路径与真实凭据；未运行项显式记 `not_run`。

## 1. §14.1 FR 分支 → 测试映射

### FR-1 命令与回执

| 分支 | 覆盖用例 |
|---|---|
| 正常：注册/元数据/配置命令经授权原子提交，completed 回执含 result/resultRef | `test/modules/host/host-app-routes.test.ts`「注册命令 200 completed」「元数据 CAS 更新 200」「全局/项目配置创建与 CAS 更新经 HTTP」；`test/modules/host/host-client-application.test.ts`「注册 → completed/resultRef → resolveResult/getReceipt → 重放零副作用 → 查询与持久状态一致」 |
| 重复命令复用（同 principal/commandId/摘要） | `test/modules/commands/p02-2-integration-regression.test.ts`「同 principal/commandId/摘要并发注册」（真实 HTTP 两路屏障竞争：恰一个项目/一条事件/一行回执，双方同一稳定回执）；「Host 关闭重启后复用原回执」；`test/modules/commands/atomic-commands.test.ts`「同 ID/规范摘要竞争只更新一次」（进程内屏障）；`test/modules/commands/command-register.test.ts`/`test/modules/commands/command-settings.test.ts`（跨进程竞争子进程） |
| 不同摘要 conflict | `test/modules/commands/p02-2-integration-regression.test.ts`「同 commandId/摘要并发 CAS…不同摘要并发恰一方 conflict」（恰一方 200、另一方 409，失败方零副作用）；`test/modules/host/host-app-routes.test.ts`「同 commandId 不同参数 → 409 conflict」；`test/modules/commands/atomic-commands.test.ts`「同 ID 异摘要 conflict，原回执/业务/事件不被覆盖」 |
| 过期新命令 | `test/modules/commands/p02-2-integration-regression.test.ts` 拒绝矩阵（command_expired 不积回执）；`test/modules/host/host-app-routes.test.ts`「过期新命令 400 command_expired 不积回执…历史回执仍可重放读取」；`test/modules/commands/atomic-commands.test.ts` 过期/等锁期间过期用例 |
| 跨项目/跨 principal 拒绝 | `test/modules/host/host-app-routes.test.ts`「受限主体：跨项目读写/全局配置/他人回执/全局快照全部拒绝，列表先收窄」（真实 HTTP 传输面）；`test/modules/commands/atomic-commands.test.ts`「重放重核当前能力/范围」「跨操作复用 ID 仍先核验原回执的注册项目可见性」；`test/modules/authorization/authorization-contract.test.ts`（应用服务直调拒绝矩阵） |
| actorId 提权 | `test/modules/commands/p02-2-integration-regression.test.ts` 拒绝矩阵（payload actorId/principal 400 invalid_input）；`test/modules/cli/app-cli-config-execute.test.ts`（顶层提权键 exit 2）；`test/modules/host/host-app-routes.test.ts` 信封校验用例 |
| 未知版本/操作 | `test/modules/host/host-app-routes.test.ts`「信封校验顺序：结构 400 先于凭据；版本/未知操作 400/501」；`test/modules/commands/commands-contract.test.ts`（表驱动未知 Schema/操作） |
| 事务注入失败整组回滚 | `test/modules/commands/p02-2-fixture-kit.test.ts`「state_events 写入处确定性失败…整组回滚」「command_receipts 注入点真实中止回执写入」；`test/modules/commands/atomic-commands.test.ts`「业务 rejected 的回执写失败也回滚」；`test/modules/storage/sqlite/sqlite-cas-and-atomicity.test.ts` |
| 响应丢失后查回执 | `test/modules/host/host-client-application.test.ts`「真实 Host 已提交但响应丢失：客户端取回原 completed/resultRef，数据库只有一次副作用」（真实 Host + 丢弃代理）；「响应丢失 → 先查回执」「回执未知才重发」「预算耗尽仍未知 → outcome_unknown」（真实 HTTP 可编排对端） |
| Host 重启/关闭重开后复用原回执 | `test/modules/commands/p02-2-integration-regression.test.ts`「Host 关闭重启后复用原回执」（重放 replayed:true、同 resultRef、计数不变）；「双 CLI 同一数据根…停止/重启后业务可查」（CLI 级跨重启重放零副作用）；`test/modules/commands/command-receipts-store.test.ts`（关闭重开内容相同） |

### FR-2 查询与事件

| 分支 | 覆盖用例 |
|---|---|
| 正常：授权快照 + 水位后续读，SSE 持续投递 | `test/modules/events/snapshot-and-events.test.ts`（一致读视图水位）；`test/modules/host/host-app-routes.test.ts`「快照：项目/全局 scope 同一读视图内容 + 水位游标」；`test/modules/host/host-sse-events.test.ts`「快照水位游标恢复」「建连后新事件持续推送」 |
| 快照与订阅之间/补读期间写入无缺口 | `test/modules/host/host-sse-events.test.ts`「建连后新事件持续推送；快照与建连之间的写入不漏」「补读期间继续写入不漏：小批量跨多批补读 + 并发写入」；`test/modules/cli/app-cli-events-observe.test.ts`「显式游标恢复：建连前写入的事件按序补读」（CLI 级） |
| 断线/Host 重启期间写入后续读 | `test/modules/commands/p02-2-integration-regression.test.ts`「live 投递 → 断线期间写入 → Host 重启 → 新实例写入 → 原游标补读无缺口」（与持久 state_events 逐行一致）；`test/modules/host/host-sse-events.test.ts`「断线重连（Last-Event-ID 优先）」「真实 startHost：信号收尾在预算内结束 SSE；重启后原持久游标可续读」 |
| 游标非法/过期（snapshot_required）/scope 不符 | `test/modules/host/host-sse-events.test.ts`「缺恢复位置 400」「未知/跨项目 Last-Event-ID 400」「保留下界夹具：建连前 409 snapshot_required」；`test/modules/cli/app-cli-events-scripted.test.ts`（CLI 侧重载/恢复分支，真实 HTTP 可编排对端） |
| 越权订阅 | `test/modules/host/host-sse-events.test.ts`「受限主体：跨项目/全局越权订阅 403 且不发正文」「缺 events.read 能力 403」；`test/modules/host/host-app-routes.test.ts` 受限主体快照 scope 用例 |
| 慢客户端 stream_overflow 不丢审计、不阻塞快客户端 | `test/modules/host/host-sse-events.test.ts`「慢客户端真实背压：stream_overflow 帧后结束该流；持久审计完整，快客户端不受阻」；`test/modules/commands/p02-2-fixture-kit.test.ts`「暂停消费使服务端写出出现真实背压」 |
| 任意路径/伪造 resultRef 拒绝 | `test/modules/commands/p02-2-integration-regression.test.ts` 拒绝矩阵（真实 Host 上穿越形态 400/404 且无文件内容）；`test/modules/host/host-app-routes.test.ts`「未知回执 404；非法 commandId/伪 resultRef/路径形态 400；表外文件路由 404」；`test/modules/host/host-client-application.test.ts`「resolveResult 非法 resultRef 本地拒绝」 |
| 无配置/损坏区分 | `test/modules/events/snapshot-and-events.test.ts` 与 `test/modules/configuration/settings-query-service.test.ts`（configured:false/corrupt_state）；`test/modules/host/host-app-routes.test.ts`「无配置明确 null/404」 |
| 双 CLI 唯一 Host、CLI 退出/观察中断不停 Host、停止/重启后查询 | `test/modules/commands/p02-2-integration-regression.test.ts`「双 CLI 同一数据根」；`test/modules/cli/app-cli-events-observe.test.ts`「follow：实时投递；Abort（Ctrl+C 语义）只结束本次观察（exit 4），Host 与已提交命令不受影响」；P02-1 单例/认证/T23 回归保留于 `test/modules/host/p02-1-integration-regression.test.ts`（本 Feature 未改动其语义，verify 内持续通过） |

## 2. §14.2 阶段验收编号子集声明（只认领已覆盖子集）

| 编号 | 本次（F-018 后）覆盖结论 |
|---|---|
| T10 | 项目隔离与凭据脱敏子集：受限主体跨项目/全局越权拒绝（HTTP/SSE/应用服务三层）、actorId 提权拒绝、错误/导出/stderr/证据不含秘密与绝对路径（本套件断言 stderr 无 64 位十六进制 token 形状）；审批与运行时凭据注入 not_run |
| T15 | 注册子集：同路径/符号链接幂等与同 remote 不同 clone 分别注册（`test/modules/commands/command-register.test.ts`）、注册竞争唯一对象（本套件真实 HTTP 屏障 + 跨进程竞争子进程）；init 中断恢复/移动 rebind/失败基线/多 clone 归档 not_run（P02-3/R2） |
| T17 | 沿用 P02-1 完整覆盖（`test/modules/host/p02-1-integration-regression.test.ts` 在 verify 中持续通过）；本套件新增业务路由不经握手旁路：双 CLI 均经发现+认证接入唯一实例 |
| T23 | 沿用 P02-1 完整覆盖；本套件与 F-011/F-012 套件均未新增监听地址/CORS 面，dist 冒烟持续断言 bind override 拒绝 |
| T26（命令幂等） | 完整认领命令幂等语义：本套件真实 HTTP 并发/重启/CLI 跨重启重放 + F-013 响应丢失用例 + F-006/F-007 持久与原子套件；设计 09 T26 的「计划修改越过活动执行/过期审批」not_run（无执行域） |
| 设计 09 T26（配置 CAS） | 经命令路径覆盖：insert-only、expectedRevision、stale_dependency、全局依赖竞争（`test/modules/commands/command-settings.test.ts`、`test/modules/host/host-app-routes.test.ts` 配置纵向）；配置历史版本表 not_run |
| T03/T12 相关 | state_events 与业务同事务、持久游标、断线/重启重连与 eventId 去重（本套件 C 组 + F-012/F-013/F-017 套件）；通知投递/delivery 表与外部渠道 not_run |

## 3. not_run（显式记录，不折算通过）

- 非 macOS 平台（Windows/WSL/Linux）验收。
- project init 用户确认流程、基线进程与健康检查、Skills、Pi SDK 与真实模型
  执行、Work/Batch/Run/Attempt 调度、审批流。
- 托管 Chat、Web/Electron 客户端、NAS/云端部署、强 OS 沙箱。
- 整阶段 `accept:p02`（阶段末项，本 Feature 不声明）。
- 真实 Pi runtime session（本 Feature 全程未调用 LLM）。

## 4. 本次运行证据（2026-10-09，macOS，Node 22.19.0 / npm 10.9.3，vitest 5.0.3）

| 项目 | 命令 | 结果 |
|---|---|---|
| 新增套件 | `npm test -- test/modules/commands/p02-2-integration-regression.test.ts` | 退出 0；6/6 通过（约 5s；含真实 HTTP 竞争、Host 重启、SSE 续读、双 CLI 停止/重启、拒绝矩阵） |
| 全量测试 | `npm test`（verify 第 1 步） | 退出 0；80 个测试文件 / 2171 用例全部通过（21.8s） |
| 类型检查 | `npm run typecheck`（verify 第 2 步） | 退出 0（0.4s） |
| 构建 + dist 冒烟 | `npm run build`（verify 第 3 步） | 退出 0（6.1s；dist 冒烟含 host 生命周期、CLI project/config/receipt 纵切、bind override 拒绝） |
| 质量门 | `npm run verify` | 退出 0，PASS 3/3 |
| 边界检查 | `npm run check:boundaries` | 退出 0；85 个生产源文件 0 diagnostics |
| 差异检查 | `git diff --check` | 退出 0 |

- 完整日志保存在 Harness 对应 Feature 的 `tool-logs/`（f018-verify-*.log、
  f018-focused.log、 f018-boundaries.log）；本文件不复制日志正文。
- 进程/连接清理：新增套件每个用例在 finally/afterEach 关闭 SSE 连接、
  停止 Host（host stop 三证据或装配级 close）并核验临时沙箱删除；双 CLI
  用例核验 Host 实例身份与重启后实例更换。
