# P02-2 应用命令、查询与事件接口交接（P02-2 → P02-3 及后续）

- 来源 Feature：P02-2（应用命令、回执、项目/配置查询、一致快照与 SSE 事件），实现范围与证据见
  [acceptance/evidence-p02-2/f018-regression-evidence.md](acceptance/evidence-p02-2/f018-regression-evidence.md)。
- 交接对象：P02-3（项目初始化/基线）及后续 Host/CLI/Runtime 任务。
- 协议依据：[p02-2-commands-events-contract.md](p02-2-commands-events-contract.md)（唯一契约）；
  操作说明 [p02-2-operations.md](p02-2-operations.md)；生命周期传输与锁仍以
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)、
  [p02-1-writer-lock.md](p02-1-writer-lock.md) 为准。
- 本文只交接**已实现并已有真实纵向回归**的公共面、端口与失败边界；未实现能力显式标注
  `not_run`，不代为实现，不提供虚假的整阶段 `accept:p02`。

## 1. 可复用公共面（P02-3 经此调用，无需直接写 SQLite）

Core 经 `shiploop-core/assembly` 的 `openCoreApplication` 装配，返回 `CoreApplication`：
`dataRoot`、`pathService`、`stateStore`、`artifactStore`、`artifactFileStore`、
`repositoryInspector`、`projectService`、`configurationService`、`commandReceiptStore`、
`commandService`、`commandReceiptsService`、`queryService`、`close()`。不暴露状态库会话/驱动句柄。

| 能力 | 入口 | 语义要点 |
|---|---|---|
| 可信主体 | `TrustedPrincipal`（`ports/authorization.ts`） | `principalId` + `capabilities: Set<AppCapability>` + `projectScope`（`all`/`allowlist`）；由可信装配显式传入，绝不来自请求数据 |
| 幂等命令 | `commandService.submit(principal, envelope)` | 单 `BEGIN IMMEDIATE`：重核回执/摘要/归属/CAS + 业务行 + 事件 + 完成回执；同步短事务，成功一律 `completed` |
| 回执/结果读取 | `commandReceiptsService`（`application/command-receipts-service.ts`） | 只按 `(principalId, commandId)` / `resultRef` 授权读取，不暴露数据库定位 |
| 授权查询 | `queryService`（`application/query-service.ts`） | 项目/配置查询、分页事件、快照、SSE 恢复解析；可见谓词在 SQL 前下推 |
| 原子命令端口 | `AtomicCommandStore` / `CommandTransaction`（`ports/atomic-commands.ts`） | 同步事务上下文只含应用数据，不含驱动/HTTP/SDK；回调不得 await 或做 Git/文件/网络 |
| 一致快照端口 | `ConsistentSnapshotStore`（`ports/queries.ts`） | 单 SQLite 读事务取得视图；写入要么整体可见（sequence 计入水位）要么整体不可见 |
| 持久事件端口 | `StateEventReadStore`（`ports/events.ts`） | 授权 scope 内分页读取与 `Last-Event-ID` → sequence 解析；不区分「不存在/越权」 |
| 纯协议 | `shiploop-core/protocol` | 校验器、摘要算法、协议常量；HostClient 复用，不加载 Core 根/应用/装配 |

Host 经 `shiploop-host` 包公共面导出：`connectToHost`、`probeDiscoveredHost`、
`ensureHostRunning`、`resolveConnectDataRoot`、`createHostLifecycleServer`、启动/停止控制器、锁与
受保护存储，以及 HostClient（P02-1 生命周期 + P02-2 应用方法）。

## 2. 可靠身份与授权（不得重建）

- 认证唯一来源仍是 P02-1 本机 Bearer 单令牌。生产装配在认证通过后把请求绑定到固定主体
  `principalId = "local-owner"`（全部 9 项能力、`projectScope.kind='all'`）；Host 传输层做认证与
  可信身份传递，Core 应用层只接收显式 `TrustedPrincipal`。
- 受限主体（`test-restricted:<uuid>` + 能力收窄 + 项目允许列表）**只由可信测试装配注入**；产品
  代码不存在经网络/argv/env/请求体创建或提权主体的入口。
- 授权检查在 **Core 应用层**：直接调用应用命令/查询服务（不经 HTTP）同样被拒绝；不可见/未知
  一律表现为 `forbidden`/`not_found`，不泄漏项目/路径/配置存在性；请求中的 `projectId`/`scope`/
  `actorId`/`principal` 只是目标选择或未知字段，**不扩大权限**。
- 历史回执重放与读取**重新核验当前身份与权限**：已有 `commandId` 不绕过授权；可见范围谓词先于
  分页/计数，全局事件（`project_id IS NULL`）不泄漏给项目级主体。

P02-3 复用该主体与授权端口即可；**不要**新造用户/配对系统或绕过 Core 在 Host/CLI 做授权判断。

## 3. 原子提交、幂等与回执（不得重建）

- 一次逻辑命令一个冻结信封：`commandId`（UUID v4）+ `scope` 三态（`registration`/`global`/
  `project`）+ `operation` + 可选 `expectedRevision` + `issuedAt`/`expiresAt` + 精确 payload 白名单。
- `requestDigest` 由**服务端**按规范化 JSON 重算；幂等键 = `(principalId, commandId)` + 摘要：
  同 ID 同摘要命中持久回执（`replayed:true`，零副作用）；同 ID 不同摘要 `conflict`
  （`idempotency_key_reuse`）；不同主体同 ID 互相独立。
- 业务写入、`state_events` 与完成回执在同一事务提交，写后注入失败整组回滚；**不存在
  「持久 accepted 但结果永不可知」**状态。Git/仓库检查、文件发布、网络与能力发现都在写事务之外，
  提交时只重核必要 revision。
- 超时/响应丢失先 `GET /v1/receipts/:commandId` 取回原结果，命中即零重发；回执未知才用**完全
  相同**的信封在有限预算内重发；`resultRef`（`v1.<43 base64url>`）为不透明结果引用，经授权
  `GET /v1/results/:resultRef` 解析，项目后续编辑不改变该次结果。
- P02-3 的命令应复用 `commandService.submit` 与上述幂等规则；新增 operation 必须进契约白名单，
  不得自造摘要/回执存储或绕过单事务边界。

## 4. 一致快照、事件与 SSE（不得重建）

- `queryService.getSnapshot` 经 `ConsistentSnapshotStore` 在单读事务内组装项目/全局状态、当前配置、
  有效配置来源与 `watermark`（`MAX(state_events.sequence)`，空库 `0`，附不透明 `cursor`）。
- 事件封套 `schemaVersion=1`：`eventId = state_events.id`（去重键）、`sequence`（持久全局游标，
  升序、至少一次投递）、`type`（白名单）、`scope`、`aggregate.revision`、`occurredAt`、脱敏 `payload`。
- 游标 `evcur_v1_<base64url>` 绑定数据根与 scope；非法/跨根/跨 scope → `invalid_input`，绝不当作
  从零读取；未来游标合法（等待）。游标低于可续读下界 → `snapshot_required`（建连前 409 或
  `event: error` 帧），必须重取快照。慢客户端缓冲超限 → `stream_overflow` 帧后结束该流，
  持久审计不丢、快客户端不阻塞。
- SSE（`GET /v1/events`）先补读水位之后已提交事件再持续推送；心跳 15 000 ms；恢复位置优先级
  `Last-Event-ID` → `?cursor=` → 缺省拒绝；每个 SSE 连接独立清理轮询/订阅/心跳，客户端断开不
  停止 Host；Host 重启后原持久游标可续读。
- P02-3 若需新事件类型/查询，应新增白名单项并同步契约与守护测试，不得从 logger 文本推断事件或
  自造内存事件源。

## 5. HTTP 路由与传输边界（P02-3 增量复用）

- 命令唯一入口 `POST /v1/commands`（信封内 `operation` 判别）；回执/结果 `GET /v1/receipts/:commandId`、
  `GET /v1/results/:resultRef`；项目 `GET /v1/projects`、`/projects/:projectId`、
  `/projects/:projectId/repository-binding`、`/projects/label-counts`；配置
  `/settings/global`、`/settings/global/export`、`/projects/:projectId/settings`、
  `.../settings/effective`、`.../settings/export`；`GET /v1/snapshot`；`GET /v1/events`。
- 未实现操作/表外路径（含 `/v1/files`、path/locator 形态）→ `unsupported`/`404`，**永不**返回文件
  内容；未知版本 `unsupported_schema_version`。体积/分页/超时/SSE 背压均为有限实施值（见契约
  §13），不可开放为可配置放宽项。
- Host/Origin 校验、无 CORS、无 3xx、`cache-control: no-store`、错误体脱敏全部沿用 P02-1；Host
  不直接写库、不跨包导入 Core 内部 SQLite 实现（`npm run check:boundaries` 强制）。

## 6. 迁移版本与事件种类（冻结事实）

- SQLite 迁移：v1 基础表、v2 `state_events`、P02-2 新增 **v3 `command_receipts`**（`(principal_id,
  command_id)` 唯一、`result_ref` 唯一、scope/status/completed/rejected/digest CHECK，`project_id`
  可空 + scope CHECK）。必须能从**空库**与 **P01 最新库（v2）**两条路径迁移；既有 projects/
  bindings/settings/events 与 sequence 不变；高版本/checksum 漂移继续拒写。
- P02-2 事件类型白名单：`project.registered`、`project.metadata_updated`、
  `settings.global_created`、`settings.project_created`、`settings.global_updated`、
  `settings.project_updated`。P01 直接服务首建不写创建事件；命令路径写创建事件（`§15.3` 边界），
  更新事件双方共用不重复。

## 7. 装配顺序与跨包边界

- 锁顺序不变量仍为：获锁**先于** `openCoreApplication`、SQLite 迁移与任何业务写入；Host 经包名与
  `./assembly` 取得 Core；CLI 只经 `shiploop-host` 公共面复用，不直连 Core、不打开 SQLite、
  不读认证文件。
- 单向依赖由 `scripts/check-boundaries.ts` 强制：Core 不反向依赖 Host/CLI；CLI 不导入 Host 启动
  入口或 Core 实现；契约区不导入 HTTP/ORM/Pi SDK。干净树（无 `dist`）由根 tsconfig paths、
  vitest alias 与测试加载器只映射包名公共入口到源码。

## 8. 待实现能力（P02-3 及后续，不得冒充）

- `project init` 完整流程：用户确认、基线/健康检查、Profile/技术栈推断、Skills、移动 rebind、
  失败基线记录与多 clone 归档（T15 未覆盖子集）。
- Work/Batch/Run/Attempt 调度与 DAG、Scheduler、Runner、Pi SDK 与真实模型执行、执行取消（含进程
  树强制终止）、审批流、通知投递/delivery 表。
- 托管 Chat、Web/Electron 配对与 CSRF、NAS/云端、强 OS 沙箱、其他平台锁与生命周期验收。
- 配置历史版本表、跨层策略编排；设计 09 T26 的「计划修改越过活动执行/过期审批」（无执行域）。
- `npm run accept:p02`（P02 阶段末项）。

## 9. 工程验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级验证为 `npm test`；工程检查编排为 `npm run verify`（锁文件预检 + `npm test` / `typecheck` /
  `build`，fail-closed），以编排退出码为通过依据；边界为 `npm run check:boundaries`。
- 建议 Harness 将本仓库 Feature 验证命令对齐 `npm run verify`；阶段验收 `npm run accept:p02`
  由阶段末项定义，本 Feature 不提供。
- 负向验收纪律：不得通过删除测试、降低门槛或扩大权限使任务通过；未运行项显式记 `not_run`。

## 10. 交接前置与安全边界

- 新增能力必须建立在已验收端口之上，继续遵守：输入运行时校验、破坏性操作走 CAS、终端状态不可
  覆盖、错误脱敏、`writer.lock` 永不删除、获锁先于写库、可见性先于分页、重放重核权限。
- 首版仅正式验收 macOS 且仅面向用户明确授权的可信本机单用户模式；发现文件中的本机 `token`
  不防所有同用户攻击，首版**不提供强 OS 沙箱**；要求强隔离的任务不得复用本假设。
