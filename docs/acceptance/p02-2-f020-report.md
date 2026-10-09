# P02-2 Feature 交付报告（F-020：应用命令、查询与事件）

- 验收日期：2026-10-09
- 验收平台：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）
- 受测代码 commit：`98cf080394e1d9f848c06ecbcca65c28c1b3c7b7`（分支
  `feat/2026-10-04-23-19-52_p02-2`，F-019 操作说明/交接 + 文档守护提交；本报告作为 F-020
  纯文档提交在其后，不改变受测代码）。
  - 产品代码集成回归 commit：`9d92977`（F-018 真实 SQLite/HTTP/SSE/CLI 集成回归）。
  - P02-1 交付基线：受测产品代码 `8473f306d8bc825356eaa42defc3e512e22edbae`（F-013），
    文档收尾 `7ae5f39bb3d30a82a37a592d938a8e3d933f8c02`（F-014）；P02-2 起点即 `7ae5f39…`。
- 工具版本：Node `22.19.0` / npm `10.9.3` / TypeScript `7.0.2` / Vitest `5.0.3` /
  better-sqlite3 `13.0.3` / drizzle-orm `0.45.3` / @types/node `22.20.4`（全部精确锁定）。
- 范围界定：本报告是 **P02-2 应用命令、回执、项目/配置查询、一致快照与 SSE 事件**的 Feature
  交付报告，**不是** P02 阶段验收，也不提供 `npm run accept:p02`。结论均来自真实命令退出码与
  可核对证据；不以 Nezha/Harness 的 `completed` 状态代替代码验收，不把未运行项折算为通过。

## 1. 输入需求与已核对契约摘要

- PRD：`features/2026-10-04-23-19-52_p02-2/input/p02-commands-events.md` v0.2（2026-10-01，
  「待审阅的需求文档」），SHA-256 `bb655fc0…b3`；共同执行约束
  `input/execution-contract.md`（2026-10-01），SHA-256 `89dcd2b2…69`。
- 需求 **FR-1 命令与回执**（幂等命令、摘要冲突、归属授权）与 **FR-2 查询与事件**（同事务
  state_events、至少一次投递按 ID 去重、快照水位断线续读）；验收标准 §3.3 的 5 条（含
  `npm run verify` 全通过、not_run 不折算、记录受测 commit）。
- 实施前置契约：[p02-2-commands-events-contract.md](../p02-2-commands-events-contract.md)
  （F-001 定案，F-002 ~ F-020 唯一协议依据）：版本/schemaVersion、命令信封与三态 scope、
  回执三态与错误码映射、授权矩阵、迁移 v3 `command_receipts`、事件封套/白名单/游标、
  `/v1` 路由、SSE 与背压、CLI 参数与五档退出码、§14 FR/T 编号映射、§15 设计差异登记与
  §15.5 携带的核对请求、§17 输入文档哈希。
- 沿用前序唯一依据：Host 发现/认证/生命周期以
  [p02-1-host-lifecycle-contract.md](../p02-1-host-lifecycle-contract.md)、
  [p02-1-writer-lock.md](../p02-1-writer-lock.md) 为准；P01 应用/配置语义以
  [p01-3-application-contract.md](../p01-3-application-contract.md)、
  [p01-4-acceptance-contract.md](../p01-4-acceptance-contract.md) 为准。P02-2 只把既有服务
  接入命令面，不重定义 P01 业务规则。
- 编号不一致：PRD §3.3 的「T26 命令幂等」与设计 09 §2 的 T26（配置 CAS/计划/审批）编号
  不一致，按**具体行为**映射（契约 §14.3），P02-2 完整认领命令幂等语义并携带 P02-1 §15.4
  核对请求；未获负责人变更结论前不改领域语义。

## 2. 实现范围（F-001 ~ F-019）

- **F-001**（`522a621`）：核对 P01/P02-1 放行基线与既有入口，冻结 P02-2 命令/查询/事件/CLI
  实施契约（纯文档 + 守护，84 断言）。
- **F-002**（`e369b44`）：Core 命令信封/回执/公开错误/已支持 payload 运行时校验（纯契约，
  110 表驱动用例）。
- **F-003**（`e916720`）：持久 `state_events` → 公开事件封套纯映射与游标解析校验（108 用例）。
- **F-004**（`17e2d63`）：命令竞争/事务故障/受限 principal/SSE 重连测试夹具（31 用例，无产品
  代码改动）。
- **F-005**（`55ab761`）：Core 应用层可信 principal 授权矩阵与可见谓词下推（72 用例）。
- **F-006**（`7e4ba1e`）：迁移 v3 `command_receipts`、稳定请求摘要、授权回执/结果读取。
- **F-007**（`0c10a53`）：幂等命令与 StateStore 短事务边界（业务 + 事件 + 完成回执原子提交）。
- **F-008**（`f653363`）：仓库注册/元数据/标签接入幂等命令 + `project.registered` 创建事件。
- **F-009**（`057cf56`）：全局/项目配置创建与 CAS 更新接入幂等命令（保留 P01 语义）。
- **F-010**（`8611871`）：授权项目/配置查询、分页事件读取、同一读视图快照水位。
- **F-011**（`0233122`）：Host `/v1` 命令/回执/查询/快照路由装配与有界 body 拒绝。
- **F-012**（`3deec4e`）：持久 `state_events` 驱动授权 SSE、断线续读、`snapshot_required`、
  有界背压。
- **F-013**（`97072b6`）：HostClient 应用协议与 SSE（冻结信封、超时先查回执、有限重试、
  响应运行时校验）。
- **F-014**（`d4a438a`）：CLI project/config/receipt/events 参数面、JSON 与帮助（纯解析）。
- **F-015**（`90b1767`）：项目注册/列表/详情/元数据/标签 CLI 经 HostClient 与 dist 入口。
- **F-016**（`eab24ee`）：全局/项目配置与回执 CLI 经 HostClient，含脱敏导出。
- **F-017**（`eff0c26`）：CLI 快照 + SSE 观察、恢复游标、`snapshot_required` 重载、Ctrl+C
  仅退出观察（退出码 4）。
- **F-018**（`9d92977`）：整 Feature 真实 SQLite/HTTP/SSE/CLI 集成回归与脱敏证据映射
  （新增 `test/p02-2-integration-regression.test.ts` 6 项 + 契约 §14 注记 + 证据文档 + 守护）。
- **F-019**（`98cf080`）：[p02-2-operations.md](../p02-2-operations.md)、
  [p02-2-handoff.md](../p02-2-handoff.md)、README 索引与文档守护
  `test/docs-p02-2-operations.test.ts`（3 项）。
- **F-020**（本报告）：交付报告、FR 覆盖索引与脱敏证据核对。

## 3. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| TypeScript | `7.0.2`（精确锁定） |
| 测试运行器 | Vitest `5.0.3`（精确锁定，经本地 fail-closed 启动器） |
| better-sqlite3 / drizzle-orm | `13.0.3` / `0.45.3`（精确锁定，Core 适配层） |
| @types/node | `22.20.4` |
| OS 锁 | 自编译 N-API 适配器直接调用 macOS `flock`（需 `/usr/bin/clang`、macOS SDK、Node 头文件） |

## 4. 正向验收（真实命令与退出码）

在受测 commit `98cf080`（工作区干净）上，按 P01 锁定工具链执行：

| # | 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | `npm test`（verify 第 1 步） | 0 | **81 files / 2174 tests 全部通过**（22.6s；0 失败） | `tool-logs/f020-verify.log` |
| 2 | `npm run typecheck`（verify 第 2 步） | 0 | 无诊断（0.4s） | `tool-logs/f020-verify.log` |
| 3 | `npm run build`（verify 第 3 步） | 0 | 三包 `tsc -b` + `prepare-cli-bin` + dist 冒烟全过（6.0s） | `tool-logs/f020-verify.log` |
| 4 | `npm run verify` | 0 | 预检 OK，`PASS 3/3` | `tool-logs/f020-verify.log` |
| 5 | `npm run check:boundaries` | 0 | **85 个生产源文件，0 diagnostics** | `tool-logs/f020-boundaries.log` |
| 6 | `git diff --check` | 0 | 无空白/冲突标记 | 会话命令输出 |

- dist 冒烟覆盖：`shiploop-core/assembly` 迁移资源 in-place（versions 1,2,3）且重开核验、
  `shiploop-core`/`shiploop-host`/`shiploop-cli` 公共入口无副作用加载、host 生命周期
  （loopback 端口、SIGKILL 后新实例/新 token、bind override 拒绝）、CLI
  `host start/status/stop` 与 project/config/receipt 纵向冒烟（同实例、CLI 退出后 Host 存活、
  证据化 stopped、配置幂等/CAS/无配置、退出码 0/1/2/3、无 token 泄漏）。
- 计数：通过 81 文件 / 2174 用例；失败 0；verify 步骤 3/3 通过、0 失败、0 not_run；
  边界 85 文件 0 诊断。`not_run` 项见 §7，不计入通过。

## 5. FR 覆盖索引（逐项引用用例与证据）

索引来源：契约 §14.1/§14.2、F-018 证据
[evidence-p02-2/f018-regression-evidence.md](evidence-p02-2/f018-regression-evidence.md) §1，
以及本报告 §4 的真实运行退出码。每一项均指向实际测试文件；缺少证据的分支显式记 `not_run`，
不折算通过。

### 5.1 FR-1 命令与回执

| 分支 | 用例（`test/`） | 证据 |
|---|---|---|
| 正常：注册/元数据/配置经授权原子提交，completed 含 result/resultRef | `host-app-routes.test.ts`、`host-client-application.test.ts` | f018 证据 §1 FR-1；f020-verify.log |
| 重复命令复用（同 principal/commandId/摘要） | `p02-2-integration-regression.test.ts`（真实 HTTP 屏障竞争、Host 重启复用）、`atomic-commands.test.ts`、`command-register.test.ts`、`command-settings.test.ts` | f018 证据 §1 FR-1 |
| 不同摘要 conflict（`idempotency_key_reuse`） | `p02-2-integration-regression.test.ts`、`host-app-routes.test.ts`、`atomic-commands.test.ts` | f018 证据 §1 FR-1 |
| 过期新命令（`command_expired`，历史回执仍可读） | `p02-2-integration-regression.test.ts` 拒绝矩阵、`host-app-routes.test.ts`、`atomic-commands.test.ts` | f018 证据 §1 FR-1 |
| 跨项目/跨 principal 拒绝 | `host-app-routes.test.ts`、`atomic-commands.test.ts`、`authorization-contract.test.ts` | f018 证据 §1 FR-1 |
| actorId/scope/principal 提权拒绝 | `p02-2-integration-regression.test.ts`、`app-cli-config-execute.test.ts`、`host-app-routes.test.ts` | f018 证据 §1 FR-1 |
| 未知 Schema 版本/未知操作 | `host-app-routes.test.ts`、`commands-contract.test.ts` | f018 证据 §1 FR-1 |
| 事务注入失败整组回滚 | `p02-2-fixture-kit.test.ts`、`atomic-commands.test.ts`、`sqlite-cas-and-atomicity.test.ts` | f018 证据 §1 FR-1 |
| 响应丢失后查回执（一次副作用） | `host-client-application.test.ts`（真实 Host + 丢弃代理） | f018 证据 §1 FR-1 |
| Host 关闭/重启后复用原回执 | `p02-2-integration-regression.test.ts`、`command-receipts-store.test.ts` | f018 证据 §1 FR-1 |

### 5.2 FR-2 查询与事件

| 分支 | 用例（`test/`） | 证据 |
|---|---|---|
| 正常：授权快照 + 水位后续读、SSE 持续投递 | `snapshot-and-events.test.ts`、`host-app-routes.test.ts`、`host-sse-events.test.ts` | f018 证据 §1 FR-2 |
| 快照与建连之间 / 补读期间写入无缺口 | `host-sse-events.test.ts`、`app-cli-events-observe.test.ts` | f018 证据 §1 FR-2 |
| 断线 / Host 重启期间写入后续读（与持久逐行一致） | `p02-2-integration-regression.test.ts`、`host-sse-events.test.ts` | f018 证据 §1 FR-2 |
| 游标非法/过期（`snapshot_required`）/scope 不符 | `host-sse-events.test.ts`、`app-cli-events-scripted.test.ts` | f018 证据 §1 FR-2 |
| 越权订阅（403 且不发正文） | `host-sse-events.test.ts`、`host-app-routes.test.ts` | f018 证据 §1 FR-2 |
| 慢客户端 `stream_overflow` 不丢审计、不阻塞快客户端 | `host-sse-events.test.ts`、`p02-2-fixture-kit.test.ts` | f018 证据 §1 FR-2 |
| 任意路径/伪造 resultRef 拒绝 | `p02-2-integration-regression.test.ts`、`host-app-routes.test.ts`、`host-client-application.test.ts` | f018 证据 §1 FR-2 |
| 无配置/损坏持久 JSON 区分 | `snapshot-and-events.test.ts`、`settings-query-service.test.ts`、`host-app-routes.test.ts` | f018 证据 §1 FR-2 |

### 5.3 验收要求类别 → 证据（PRD §3.3 / F-020 验收）

| 类别 | 覆盖用例与证据 |
|---|---|
| 重复/冲突命令 | `p02-2-integration-regression.test.ts`（并发注册恰一个对象/事件/回执；不同摘要恰一方 409 且失败方零副作用）、`atomic-commands.test.ts`、`host-client-application.test.ts`；f018 证据 §1 |
| 授权拒绝 | `authorization-contract.test.ts`（应用服务直调矩阵）、`host-app-routes.test.ts`（HTTP 受限主体）、`host-sse-events.test.ts`（订阅越权）、`app-cli-config-execute.test.ts`（顶层提权键 exit 2）；f018 证据 §1、§2 T10 |
| JSON/版本/过期错误 | `commands-contract.test.ts`、`host-app-routes.test.ts`（结构 400 先于凭据；版本/未知操作 400/501）、`p02-2-integration-regression.test.ts` 拒绝矩阵；f018 证据 §1 |
| 事务回滚 | `p02-2-fixture-kit.test.ts`（业务写后事件/回执注入失败整组回滚）、`atomic-commands.test.ts`（rejected 回执写失败也回滚）、`sqlite-cas-and-atomicity.test.ts`；f018 证据 §1 |
| 快照竞态 | `snapshot-and-events.test.ts`（一致读视图水位）、`host-app-routes.test.ts`、`host-sse-events.test.ts`（建连/补读期间写入不漏）、`p02-2-integration-regression.test.ts`；f018 证据 §1 |
| 重连/背压 | `host-sse-events.test.ts`（Last-Event-ID 重连、真实背压 `stream_overflow`、持久审计完整、快客户端不受阻）、`app-cli-events-observe.test.ts`、`app-cli-events-scripted.test.ts`、`p02-2-integration-regression.test.ts`；f018 证据 §1 |
| 任意路径拒绝 | `p02-2-integration-regression.test.ts`（穿越形态 400/404 无文件内容）、`host-app-routes.test.ts`（表外文件路由 404、伪 resultRef 400）、`host-client-application.test.ts`（本地拒绝非法 resultRef）；f018 证据 §1 |
| dist CLI 用例 | `app-cli-args.test.ts`、`app-cli-execute.test.ts`、`app-cli-config-execute.test.ts`、`app-cli-events-observe.test.ts`、`app-cli-events-scripted.test.ts`、`host-cli-execute.test.ts`、`p02-2-integration-regression.test.ts`（双 CLI 同一数据根、停止/重启后查询）、`docs-p02-2-operations.test.ts`（dist 入口纵向）、`typescript-build.test.ts` + `npm run build` dist 冒烟；f020-verify.log、f019-focused.log |

### 5.4 阶段验收编号子集（只认领已覆盖子集）

| 编号 | 本次覆盖结论 | not_run |
|---|---|---|
| T10 | 项目隔离与凭据脱敏子集（HTTP/SSE/应用服务三层越权拒绝、actorId 提权拒绝、stderr/证据无 64hex token 形状） | 审批、运行时凭据注入 |
| T15 | 注册子集（同路径/符号链接幂等、同 remote 不同 clone 分别注册、注册竞争唯一对象） | init 中断恢复/移动 rebind/失败基线/多 clone 归档（P02-3/R2） |
| T17 | 沿用 P02-1 完整覆盖；业务路由不绕过握手认证与单例 Host | — |
| T23 | 沿用 P02-1 完整覆盖；未新增监听地址/CORS 面，dist 冒烟持续断言 bind override 拒绝 | — |
| T26（命令幂等） | 完整认领命令幂等语义（(principal,commandId) 唯一、摘要复用/冲突、回执持久化、超时查回执、响应丢失一次副作用） | 设计 09 T26「计划修改越过活动执行/过期审批」（无执行域） |
| 设计 09 T26（配置 CAS） | 经命令路径覆盖 insert-only/expectedRevision/stale_dependency/全局依赖竞争 | 配置历史版本表、跨层策略编排 |
| T03/T12 相关 | `state_events` 与业务同事务、持久游标、事件重连/去重 | 通知投递/delivery 表、外部渠道 |

## 6. 脱敏证据核对

- 证据文档 [evidence-p02-2/f018-regression-evidence.md](evidence-p02-2/f018-regression-evidence.md)
  只含非秘密的计数、状态、事件 sequence、进程退出与命令退出码；复核确认**不含**真实凭据、
  `Authorization` 头、64 位十六进制 token 形状、开发机绝对路径或用户文件正文。
- 文档守护测试 `test/docs-p02-2-operations.test.ts` 与
  `test/docs-p02-2-commands-events-contract.test.ts` 在 `npm test` 内断言操作说明/交接/证据
  文档不含开发机绝对路径、Bearer 样例、64hex 凭据样例，并核验命令、参数、路由、事件白名单
  与套件文件存在。
- 构建产物 public import 无副作用，descriptor 扫描 `path_scan_findings=0`、`user_data_writes=0`；
  测试仅操作临时沙箱内独立 home/tmp/data（不读写真实 HOME 或用户项目），全部凭据为秘密。
- 完整原始日志保存在 Harness Feature 工作区的 `tool-logs/`（`f020-verify.log`、
  `f020-boundaries.log`，以及 F-018/F-019 的 `f018-*.log`、`f019-*.log`），日志正文不复制进
  仓库，本报告与证据文档均不含开发机绝对路径。
- 临时资源/进程清理：各集成用例在 `finally`/`afterEach` 关闭 SSE 连接、停止 Host（三证据或
  装配级 `close`）并核验临时沙箱删除；本报告运行的 verify/build 冒烟为有限时长子进程，
  执行后无残留 vitest/verify/Host 进程。

## 7. 已知缺口与 not_run（显式记录，不折算通过）

| 项目 | 状态 |
|---|---|
| Windows / WSL / Linux 平台验收 | not_run（macOS 是唯一正式验收平台） |
| 强 OS 沙箱 / 隔离执行 | 未支持（用户明确授权的可信本机单用户模式） |
| `project init` 完整流程：用户确认、基线/健康检查、Profile/技术栈推断、Skills、移动 rebind、失败基线、多 clone 归档 | not_run（P02-3 / R2） |
| Work/Batch/Run/Attempt 调度、Scheduler、Runner、执行取消（进程树终止）、审批流、通知投递 | not_run |
| Pi SDK 与真实模型执行、真实 Pi runtime session | not_run（本 Feature 全程未调用 LLM） |
| 托管 Chat、Web/Electron 配对与 CSRF、NAS/云端 | not_run |
| 配置历史版本表、跨层策略编排；设计 09 T26「计划修改越过活动执行/过期审批」 | not_run（无执行域） |
| T10/T15/T17/T23/T26 **完整**验收 | not_run（仅认领子集，见 §5.4） |
| `npm run accept:p02`（P02 阶段末项） | not_run（本 Feature 不提供整阶段通过脚本） |
| 真实断电/磁盘满生产链路演练 | not_run（本轮为确定性故障注入） |

## 8. Harness 验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级开发内循环为 `npm test`；工程检查编排为 `npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed），以编排退出码为通过依据；边界检查为
  `npm run check:boundaries`。
- 建议 Harness 将本仓库 Feature 验证命令对齐 `npm run verify`；阶段验收
  `npm run accept:p02` 属 P02 阶段末项，不由本 Feature 提供。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；负向验收纪律（不得删测试、降低门槛、
  扩大权限或跳过必测行为来恢复）记录于操作说明与交接文档。

## 9. 结论

P02-2 在 macOS（arm64，Node 22.19.0 / npm 10.9.3）上交付应用命令与回执、项目/配置授权查询、
一致快照与持久事件 SSE：幂等命令（冻结信封 + 服务端摘要 + `(principal,commandId)` 唯一 +
单 `BEGIN IMMEDIATE` 原子提交）、授权回执/结果读取、迁移 v3 `command_receipts`、`/v1` 业务
路由、HostClient 应用协议、dist CLI 项目/配置/回执/事件命令与观察流程，均由真实
SQLite/HTTP/SSE/CLI 回归覆盖。受测 commit `98cf080` 的 `npm run verify`（`PASS 3/3`：
81 files / 2174 tests、typecheck、build + dist 冒烟）、`npm run check:boundaries`
（85 文件 0 诊断）、`git diff --check` 真实退出码全部为 0；FR-1/FR-2 的正常与关键失败分支、
阶段验收编号子集与 not_run 逐项记录于 §5/~§7。本结论仅限 P02-2 的应用命令、查询与事件子集，
不声称 `project init`、基线、Pi/Work 执行、跨平台、强沙箱或整个 P02 已验收；`accept:p02` 留给
P02 阶段末项。
