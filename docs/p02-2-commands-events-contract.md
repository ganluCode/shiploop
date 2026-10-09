# P02-2 应用命令、查询与事件 — 接口契约

- 对应任务：F-001（核对 P01 放行基线与 P02-1 交付基线，冻结 P02-2 命令、查询、事件与
  CLI 的实施契约）。
- 文档状态：P02-2 实施前置契约（F-002 ~ F-020 的唯一协议依据，**不是**阶段验收报告，也不是
  已实现能力声明）。本文描述的 `/v1` 业务路由、回执表、事件封套、SSE 与 CLI 新命令在冻结时
  **尚不存在**；F-011 前任何请求必须继续按 P02-1 现状得到 `404 unknown_operation` 或
  `501 unsupported`。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收。
- 输入依据：PRD `p02-commands-events.md`（版本 0.2，2026-10-01，状态「待审阅的需求文档」，
  哈希见 §17）、共同执行约束 `execution-contract.md`（2026-10-01）、知识目录
  `architecture-redesign/`（开发查阅路径在 Harness，非本仓库内容、非运行时依赖）。
- 与既有契约的关系：Host 发现/认证/生命周期仍以
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md) 为唯一依据；本文只在其
  §17.1 第 4 项「未来项目命令路由与 SSE 在 P02-2 契约中定案」的预留位上定案，不修改 P02-1 的发现、
  锁、握手认证与 stop 语义。P01 应用服务语义以
  [p01-3-application-contract.md](p01-3-application-contract.md) 为准，本文只把既有服务接入
  命令面，不重定义其业务规则。
- 本文不静默改变领域语义；发现的编号与语义张力集中记录于 §15，并按 §15.5 请求核对。

---

## 1. 前序基线核验（开工核对）

### 1.1 分支与提交

- 实际执行分支：`feat/2026-10-04-23-19-52_p02-2`（worktree
  `shiploop-2026-10-04-23-19-52_p02-2`，主仓库 `shiploop` 的正式开发 worktree（`.git` 为 gitdir
  指针，指向主仓库 worktrees 目录），基线
  `feat/2026-10-04-23-19-52_p02-1-host`（`feature.yaml.metadata.base_branch`）。
- 开工时 HEAD（= P02-2 起点，完整 hash）：
  `7ae5f39bb3d30a82a37a592d938a8e3d933f8c02`（P02-1 F-014：操作说明、交付报告、交接与文档守护，
  **纯文档提交**，不改产品代码）。
- P02-1 **受测产品代码** commit：`8473f306d8bc825356eaa42defc3e512e22edbae`（F-013：整 Feature
  真实多进程集成回归）。`8473f30..7ae5f39` 只新增 README 索引行、操作说明、交接、F-014 报告与
  证据映射及一个文档守护测试，产品行为与受测代码一致；**不得把 F-014 文档 hash 当作受测产品
  commit**。
- 祖先核验（`git merge-base --is-ancestor`，均为真）：
  - P02-1 起点 `83091167ffd41494146f404fbc46861d3b976d13`（P02-1 F-001）为当前 HEAD 祖先；
  - 负责人 P01 放行基线 `5a43a042b98bf2317db7501547def93a4f08f2fa` 为祖先；
  - 负责人放行记录提交 `24dcb7da41f2cb080c6b01c94a4cb24bddb8e4d3` 为 `main` 当前 tip，亦为祖先；
  - `main..HEAD` 恰为 P02-1 的 14 个提交（F-001 ~ F-014），无夹带。
- 人工放行依据沿用 P02-1 契约 §1.2 的核对结论：存在负责人 ganlu 2026-10-05 明确阶段放行
  （「p01帮我修改一下，放行」），P02-1 在该放行行的 P01 基线上增量完成。F-001 不代签、不自动
  合并、不扩大放行范围；P02-2 没有新的人工签字需求，也不代替 P02 阶段验收。

### 1.2 P02-1 交付能力实际检查（非占位）

F-001 实际打开源码与测试逐项核对，下表入口与测试在开工时**已存在且被 `npm test` 收集**：

| 能力 | 实际入口（源码） | 关键测试（`test/`） |
|---|---|---|
| Host 生命周期协议冻结常量/身份摘要/错误 | `packages/host/src/contract/constants.ts`（`CURRENT_SCHEMA_VERSION=1`、`MAX_HTTP_BODY_BYTES=16384`、三路由）、`identifiers.ts`（`computeDataRootIdentity`、`stableCanonicalJson`、UUID/SHA256/ISO 校验）、`errors.ts`（§14 错误码表与 HTTP 映射）、`lifecycle.ts`（`CURRENT_HOST_CAPABILITIES`：`events:'unsupported'`、`projectCommands:'unsupported'`） | `host-lifecycle-contract.test.ts` |
| 受保护发现/凭据存储与 OS 锁 | `packages/host/src/storage/*`（0700/0600、fail-closed、原子发布、按实例清理）、`packages/host/src/locking/writer-lock.ts` + N-API 原生适配器（macOS `flock(LOCK_EX|LOCK_NB)`，实际写入进程持 fd） | `host-protected-storage.test.ts`、`host-writer-lock.test.ts` |
| Host 启动装配/传输面/停止控制 | `packages/host/src/runtime/host-startup.ts`（获锁→`openCoreApplication`→回环随机端口→原子发现）、`http-transport.ts`（Bearer timingSafeEqual、Host/Origin 校验、404/405/413 纪律）、`host-stop.ts`（quiesce/幂等矩阵/收尾）、`start.ts` 显式入口 | `host-startup.test.ts`、`host-http-transport.test.ts`、`host-stop-lifecycle.test.ts` |
| HostClient / 启动器 | `packages/host/src/client/host-client.ts`（`connectToHost`/`probeDiscoveredHost`：发现读取→握手双向核验后才 status/stop、不跟重定向、`close()` 只释放本地资源）、`launcher/host-launcher.ts`（`ensureHostRunning`：先发现后 spawn、owner 诊断、落选回收） | `host-client.test.ts`、`host-launcher.test.ts` |
| CLI 面层与执行层 | `packages/cli/src/host/args.ts`（`parseHostCliArgs` 纯解析，env 显式注入）、`output.ts`（0/1/2/3 四档退出码）、`execute.ts`（`runHostCli`，status/stop 不启动 Host，stop 三证据）、`bin.ts`（shebang 唯一显式入口；`package.json` `bin: {shiploop: ./dist/bin.js}`） | `host-cli-args.test.ts`、`host-cli-execute.test.ts` |
| Core 装配与 P01 应用服务 | `packages/core/src/adapters/composition.ts`（`openCoreApplication`：`stateStore`/`projectService`/`configurationService` 等窄端口 + 幂等 `close()`）；`application/project-service.ts`、`configuration-service.ts`、`effective-settings.ts`；迁移 v1 六表 + v2 `state_events`（`adapters/sqlite/migrations.ts`） | `core-assembly.test.ts`、`project-registration.test.ts`、`project-metadata-*.test.ts`、`project-tag-filter.test.ts`、`configuration-service.test.ts`、`settings-*.test.ts`、`sqlite-schema-migrations.test.ts` |
| P02-1 整 Feature 多进程回归 | 29 个真实子进程用例（竞争唯一持锁 Host、假服务、认证/监听负例、崩溃重发现、停止/重启/重开 Core 数据完好） | `p02-1-integration-regression.test.ts` |
| 测试夹具 | 屏障子进程、伪 HTTP 服务、隔离环境、脱敏证据、CLI/启动器驱动子进程 | `test/helpers/host/*`、`host-fixture-kit.test.ts` |

当前（开工时）线上行为事实：Host 只服务 `/v1/host/handshake|status|stop`；任何其他路径为
`404 unknown_operation`；握手 `capabilities.events` 与 `capabilities.projectCommands` 均为字面量
`'unsupported'`；CLI 只有 `shiploop host start|status|stop`。这些是 P02-2 的改造起点，后续
任务改变它们时必须同步更新本文与 §18 的文档守护测试（与 P02-1 的增量做法一致）。

### 1.3 环境、脚本与基线实测

| 项 | 值 | 来源 |
|---|---|---|
| Node / npm | `22.19.0` / `10.9.3`（engine-strict，实测 `node -v`/`npm -v` 一致） | 根 `package.json`、`.nvmrc`、`.node-version` |
| TypeScript / Vitest | `7.0.2` / `5.0.3`（精确锁定，run-tests 启动器校验身份与版本） | 根 `package.json` |
| SQLite 栈 | `better-sqlite3@13.0.3` + `drizzle-orm@0.45.3`（仅 `shiploop-core` 声明） | `packages/core/package.json` |
| 模块体系 | ESM（NodeNext，strict，`verbatimModuleSyntax`）；工作区单向依赖 `host → core`、`cli → host` | 各 `tsconfig.json`、`scripts/check-boundaries.ts` |
| 工程脚本 | `npm test`（`node scripts/run-tests.ts`）、`npm run typecheck`、`npm run check:boundaries`、`npm run build`、`npm run verify`、`npm run accept:p01`；**无** `accept:p02` | 根 `package.json` |

开工基线实测（本 worktree，`npm ci` 重建 47 包后）：

- `npm run verify`：**退出 0，PASS 3/3**（test 19.8s / typecheck 0.8s / build 2.4s）；
  **59 test files / 1332 tests passed**，无 skip；`npm run build` 的 dist 冒烟含 Host/CLI 真实
  纵向闭环。完整日志：Feature 工作区 `tool-logs/f001-baseline-verify.log`（Harness 路径，非仓库
  产物，不进入提交）。
- 环境：macOS 26.6.2（arm64，Darwin 25.6.0）。

**结论：P01 放行基线与 P02-1 交付（含受测产品代码与测试）均完整包含于当前分支，环境与脚本
无阻塞项；F-001 不补建任何前序 Feature，不代替人工签字。**

### 1.4 P02-2 复用而不重建的既有规则

全部沿用 P01/P02-1 已锁定规则，不另立第二套（实现任务必须复用，不得复制分叉）：

1. 稳定 ID（UUID v4，应用侧生成）、UTC 时间（应用侧毫秒，注入时钟）、`revision` CAS（初值 1）。
2. 标签规范化 `normalizeLabels`（trim → NFC → ASCII 小写 → 实体内去重）与上限
   （`LABEL_MAX_LENGTH=64`、`LABELS_MAX_COUNT=50`、名称 200、描述 10 000 码点）。
3. 项目列表分页（默认 50、上限 200、稳定 `id` 升序、键集游标）与标签 any/all 语义、绑定参数查询。
4. 配置 payload：`SETTINGS_SCHEMA_VERSION=2`、`validateSettingsPayload`、能力目录兼容复检、
   首次创建 insert-only、更新 `expectedRevision` 条件写入、`consistency.globalRevision` 由服务
   自行推导（调用方不得声明）、`mergeEffectiveSettings` 段级整体覆盖、
   `SETTINGS_EXPORT_FORMAT_VERSION=1` 白名单脱敏导出。
5. 仓库只读检查 `RepositoryInspector`（独立 argv、有限超时、不执行脚本/安装/commit、支持范围与
   `repoIdentity=gitdir-sha256:` 派生按 P01-3 契约 §4.2）。
6. 写事务纪律：`session.transactWrite`（`BEGIN IMMEDIATE`，同步短事务，拒绝 async 回调），
   事务内禁止文件/Git/网络/模型/凭据解析；busy 有限预算，超限 `StorageError(kind='busy')`。
7. Host 传输纪律（P02-1 §7.2）：Bearer-only、Host 头恰为回环字面量、Origin 必须缺席、
   不发 CORS、永不 3xx、`connection: close`、有界超时、错误体脱敏。
8. 发现/锁/单例/启动器/HostClient 规则全部不变；P02-2 只新增业务路由与客户端方法。

## 2. 范围与非目标

### 2.1 范围内（PRD FR-1、FR-2）

1. 版本化**命令信封**与持久**幂等回执**（`command_receipts`，迁移 v3）：注册、项目元数据编辑、
   全局/项目当前配置创建与 CAS 更新；可信 principal 授权；结构化公开错误。
2. 把 P01 已验收的注册/元数据/标签与当前配置服务经**同一原子提交边界**接入命令面，业务变更、
   `state_events` 与完成回执同事务。
3. 最小授权读取：项目/绑定/列表/标签计数、全局/项目当前值/有效值/脱敏导出、回执与结果引用
   解析。
4. 一致**快照水位**、持久 `state_events` 到公开事件封套的纯映射、版本化游标、授权 SSE 订阅、
   断线续读、`snapshot_required` 与有界背压。
5. Host `/v1` 业务路由装配、HostClient 命令/查询/SSE 能力（超时后查回执、有限重试）、CLI 新
   参数面与 `dist/bin.js` 纵向接线。
6. F-018 的真实 SQLite/HTTP/SSE/CLI 集成回归与 F-019/F-020 的操作说明、交接与交付报告。

### 2.2 明确不提供（unsupported，不得用占位冒充）

- **Work 执行域一切能力**：Run/Task/Attempt/Batch/Phase/Feature 的命令与查询、调度、认领、
  暂停/取消/重试、预算、`operations` 表与外部副作用恢复、Pi SDK/模型调用、执行取消（含进程树
  强制终止）、Runtime/Chat Session。
- **项目初始化确认流程（P02-3）**：`confirmProfile`、能力模块选择、技术栈推断、基线进程
  （`runBaseline`）、Skills、项目知识/Wiki、rebind/归档/删除。本次 `project.register` 只是
  P01-3 既有「仓库注册 + 元数据」用例的命令化；注册成功**不**表示基线健康或执行就绪。
- **Profile / 项目档案查询**、`project init` 交互式确认、仓库脚本执行、依赖安装。
- **Chat API**（设计 08 §7 全部候选：createSession/sendTurn/listMessages 等）、通知渠道与投递。
- **任意文件读取**：没有也不会新增按路径/locator 读取仓库或数据根文件的路由；`resultRef` 不是
  文件路径，只能经授权结果接口解析。制品（Artifacts）读取不在本 Feature。
- Web/Electron 配对、CSRF、远程控制、公网监听、多用户管理/用户建账/配对发 token；不新增
  accept 脚本（`accept:p02` 属阶段末项 P02-4）。
- **强 OS 沙箱**：首版仍是用户明确授权的可信本机项目模式，本契约不提供也不宣称强 OS 沙箱；
  要求强隔离的任务属后续独立里程碑。
- 不升级/替换 §1.3 的任何锁定版本，不新增第三方依赖（如需必须先修订本文）。

## 3. 版本空间与传输总则

### 3.1 四个互相独立的版本（禁止隐式联动）

| 版本 | 当前值 | 载体 | P02-2 变化 |
|---|---|---|---|
| 发现 `schemaVersion` | `1` | `discovery.json` | **不变**（P02-1 §5.1） |
| 线协议 `protocolVersion` | `1` | 握手/业务消息 | **不变**（HTTP 帧与路由前缀兼容） |
| 线消息 `schemaVersion` | **`2`（P02-2 起）** | 握手、host status/stop、命令信封、回执、查询响应、快照 | **显式升版**，见下 |
| 配置 payload `schemaVersion` | `2` | `SettingsPayload`（`SETTINGS_SCHEMA_VERSION`） | **不变**（与线消息版本恰好同值但语义独立） |

另有：事件封套自身的 `schemaVersion`（见 §9.1，初值 `1`）、导出格式版本
（`SETTINGS_EXPORT_FORMAT_VERSION=1`，不变）、SQLite 迁移版本（P02-2 新增 **v3**，§10）。

线消息 1 → 2 的定案（实施契约值，请求核对见 §15.4）：

- 升版原因：握手 `capabilities` 形状从「`events`/`projectCommands` 两字面量」演进为包含命令、
  查询、快照与 SSE 能力的结构化视图（§11.3）；P02-1 客户端对响应做精确键校验，同版本号改形状
  违反「未知字段一律拒绝」纪律，故显式升版而非静默变形。
- Host P02-2 只接受线消息 `schemaVersion=2` 的握手/命令/回执请求；`1` →
  `400 unsupported_schema_version`（不猜测降级）。响应体一律 `schemaVersion:2`。发现文件与
  `protocolVersion` 不变，发现/锁/凭据流程不受影响。
- Host 与 CLI 同仓库同版本发布；旧 P02-1 CLI 连接新 Host 会在握手得到明确
  `unsupported_schema_version`（退出码 3），不会得到畸形响应或错误业务结果。F-013 必须更新
  HostClient 与伪服务夹具的版本断言；P02-1 生命周期行为回归（T17/T23 等）在 v2 上继续成立。

### 3.2 路由总表（全部需要 Bearer 认证；前缀 `/v1`）

> 实施状态：全部路由（含 `GET /v1/events` SSE）均已接线：F-011 接线于
> `packages/host/src/runtime/app-transport.ts`（生命周期传输面委派），F-012 将
> `/v1/events` 接管为 `packages/host/src/runtime/sse-transport.ts` 的长连接事件流
> Hub；未装配 Hub 的传输面上下文在认证后仍返回 `501 unsupported`
> （`details.reason='events_unsupported'`，防御纵深，不伪称可用）。F-011 定案的
> HTTP 查询参数：`projects.list` 接受
> `limit`/`cursor`/`match`（any|all）/可重复 `label`；`snapshot.get` 接受
> `scope=project|global` 与 `projectId`（project 必填、global 禁止）；其余查询路由
> 不接受任何参数（未知/重复参数 400 invalid_input）。字面量路由
> `/v1/projects/label-counts` 优先于 `:projectId` 形态（冻结取舍）。quiescing/
> stopping/starting 状态下 POST /v1/commands 返回 `503 not_ready`
> （`details.reason='host_quiescing'`），业务状态不变；只读查询不受影响。

| 方法与路由 | operation | 说明 |
|---|---|---|
| `POST /v1/host/handshake`、`GET /v1/host/status`、`POST /v1/host/stop` | host.* | P02-1 既有，消息升 v2，语义不变 |
| `POST /v1/commands` | 见 §6 命令名 | 唯一命令入口；信封内 `operation` 判别 |
| `GET /v1/receipts/:commandId` | `receipts.get` | 读取**本 principal** 的持久回执 |
| `GET /v1/results/:resultRef` | `results.resolve` | 授权解析回执内稳定结果引用 |
| `GET /v1/projects` | `projects.list` | 可见项目列表（标签 any/all + 分页） |
| `GET /v1/projects/:projectId` | `projects.get` | 项目详情（含绑定，见 §7.2） |
| `GET /v1/projects/:projectId/repository-binding` | `projects.binding.get` | 仓库绑定单独读取 |
| `GET /v1/projects/label-counts` | `projects.labelCounts` | 可见范围内项目层标签计数 |
| `GET /v1/settings/global` | `settings.global.get` | 全局当前值 |
| `GET /v1/settings/global/export` | `settings.global.export` | 全局脱敏导出 |
| `GET /v1/projects/:projectId/settings` | `settings.project.get` | 项目当前值 |
| `GET /v1/projects/:projectId/settings/effective` | `settings.project.effective` | 有效配置与逐项来源 |
| `GET /v1/projects/:projectId/settings/export` | `settings.project.export` | 项目脱敏导出 |
| `GET /v1/snapshot` | `snapshot.get` | 一致读视图快照 + 事件水位（§8） |
| `GET /v1/events` | `events.subscribe` | `text/event-stream`（§9） |

纪律：

- 命令一律 POST、查询一律 GET、事件仅 SSE；其余方法 `405 method_not_allowed`（给允许方法）。
- 表外路径（含任何 `/v1/files`、`/v1/artifacts/.../content`、path/locator 形态参数）一律
  `404 unknown_operation`，**永不**返回文件内容；绝对路径、`..` 穿越、符号链接、伪造 resultRef
  均有负例测试（F-011/F-018）。
- 未知 `operation`（含 Work/Chat/Phase/Profile/Baseline 等设计 08 候选名）→ `501 unsupported`
  （`details.supportedOperations` 只列 §6 实际实现者），不猜默认实现。
- GET 查询参数串（含 `?`）上限 **8 192 字节**，超限 `400 invalid_input`；GET 不带体（P02-1 既有
  规则）。路径参数（projectId/commandId/resultRef/cursor 的路径形态）必须通过相应稳定 ID/令牌
  校验，非法值 `400 invalid_input` 且不做任何查询。
- `/v1/commands` 请求/响应体上限 **65 536 字节**（配置 v2 payload 可能大于生命周期消息；
  `413 request_too_large`）；`/v1/host/*` 保持 **16 384** 字节不变。查询响应体上限 **65 536 字节**。
  三个数值均为有限实施契约值（请求核对 §15.6），不得开放为可配置项。
- Host/Origin 校验、无 CORS、无 3xx、`cache-control: no-store`、`connection: close`、
  content-type 规则、错误体脱敏（不回显 token/原文/路径/堆栈）全部沿用 P02-1 §7.2。

## 4. 可信 principal 与授权映射

### 4.1 principal 从哪里来（唯一可信来源）

- P02-2 **不新建用户系统、配对系统或 token 管理面**。认证仍只有 P02-1 的本机 Bearer 单令牌。
- **生产装配**：Bearer 认证通过后，Host 把请求绑定到固定本机主体
  `principalId = "local-owner"`，能力为全部已实现能力、项目可见范围为「全部」。该绑定发生在
  Host 可信装配/传输层，Core 应用层只接收显式传入的 principal 结构，不从 HTTP 请求取身份。
- **受限主体仅用于测试**：F-004 夹具可经**可信测试装配**注入
  `principalId = "test-restricted:<uuid-v4>"` 与显式项目允许列表/能力收窄；产品代码不存在任何
  经网络/argv/env/请求体创建或提权主体的入口。生产 Host 不得提供把受限主体映射到真实令牌的
  配置。
- 请求信封/查询参数中的 `actorId`、`principal`、`principalId`、`capabilities`、`scope` 提权
  尝试：作为**未知字段拒绝**（`invalid_input`，定位到字段），永不覆盖绑定身份。principal 不出
  现在命令摘要输入与持久业务 payload 中；它只存在于回执表与授权判定。

### 4.2 principal 结构与能力清单（冻结）

```ts
type PrincipalScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'allowlist'; readonly projectIds: readonly string[] };

interface TrustedPrincipal {
  readonly principalId: string;            // 'local-owner' | 'test-restricted:<uuid>'
  readonly capabilities: ReadonlySet<AppCapability>;
  readonly projectScope: PrincipalScope;  // 查询/订阅前在 SQL 谓词收窄
}

type AppCapability =
  | 'project.register'
  | 'project.read'
  | 'project.metadata.write'
  | 'settings.global.read'
  | 'settings.global.write'
  | 'settings.project.read'
  | 'settings.project.write'
  | 'receipts.read'        // 仅本 principal 的回执/结果
  | 'events.read';         // 按可见范围订阅
```

`local-owner` 持有全部 9 项且 `projectScope.kind='all'`。受限主体的具体能力组合由测试显式构造
（如「只能读/改项目 A」「只有项目读没有全局能力」），没有产品级默认模板。

### 4.3 操作授权矩阵

| operation | 能力要求 | 范围/可见性规则 |
|---|---|---|
| `project.register` | `project.register` | 若 canonicalPath 已绑定到**不可见**项目 → `forbidden`（不返回既有项目，不泄漏存在性）；绑定到可见项目 → 正常 `already_exists` 复用 |
| `project.metadata.update` | `project.metadata.write` + 目标项目在可见范围 | 不可见/未知项目对调用方一律表现为 `forbidden`（不区分「不存在」，避免 projectId 探测） |
| `settings.global.create/update`、`settings.global.get/export`、全局快照、全局事件 | `settings.global.write` / `settings.global.read` | 仅全局能力；项目能力不蕴含全局能力 |
| `settings.project.create/update`、`settings.project.get/effective/export`、项目快照、项目事件 | `settings.project.write` / （`project.read` 或 `settings.project.read`） | 目标项目必须在可见范围；`effective` 读取全局当前值仅用于合并，不授予全局原文读取 |
| `projects.list`、`projects.get`、`projects.binding.get`、`projects.labelCounts` | `project.read` | **先按可见范围收窄再分页/计数**；禁止「全库分页后内存过滤」；标签计数只统计可见项目 |
| `receipts.get`、`results.resolve` | `receipts.read` | 只能读**本 principal** 的回执；他人/不可见实体的回执一律 `not_found`（不区分不存在与无权） |
| `events.subscribe` | `events.read` + 范围对应读能力 | 项目流要求该项目可见；全局流要求 `settings.global.read`；越权在发送任何事件正文前拒绝 |

不变量（F-005 必须逐条有直接应用服务层测试，不经 HTTP 也必须被拒绝）：

1. 授权检查在 **Core 应用层**，Host 只做认证与可信身份传递；直接调用应用命令服务同样拒绝。
2. 请求里的 `projectId` 只是目标选择，不扩大 `projectScope`；payload 内改 projectId/scope/
   actorId 被拒绝，失败时业务行、revision、事件均不变。
3. 历史回执重放与读取**重新核验当前身份与权限**；已有 commandId 不绕过授权。
4. 列表/计数/分页的可见谓词下推到 SQL；全局事件（`project_id IS NULL`）不泄漏给项目级主体。
5. 任何拒绝响应不回显不可见项目的名称、路径、配置或 repoIdentity。

## 5. 命令信封、摘要与回执

### 5.1 命令信封（线消息 schemaVersion=2）

```ts
type CommandScope =
  | { readonly kind: 'registration' }
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

interface CommandEnvelope<TPayload> {
  readonly schemaVersion: 2;
  readonly commandId: string;         // UUID v4，客户端生成（CLI 可显式传入）
  readonly operation: AppOperation;   // §6 白名单
  readonly scope: CommandScope;       // 唯一项目身份渠道；顶层不再有 projectId 字段
  readonly expectedRevision?: number; // 仅更新类命令必填（≥1 整数）；创建/注册必须缺席
  readonly issuedAt: string;          // ISO UTC（Z 结尾），必填
  readonly expiresAt?: string;        // ISO UTC；缺席见 §5.4 TTL
  readonly payload: TPayload;         // 按 operation 的精确白名单（§6），严格未知键拒绝
}
```

- 设计 08 §2 候选形为顶层 `projectId: string`；本契约改为 `scope` 三态以表达「注册前无项目」与
  「全局配置无项目」，依据与核对请求见 §15.1。顶层 `projectId`、`actorId` 等为未知键。
- 运行时校验为**纯模块**（F-002）：只暴露类型与纯校验/映射函数，不导入 HTTP/SSE/ORM/Pi SDK，
  import 无数据库、网络、文件、时钟副作用（时间窗口比较所需时钟由调用方注入）。
- 校验顺序（先失败先返回，与 P02-1 握手同原则）：传输层 → 信封严格结构与字段类型（400，
  定位到字段）→ 凭据（401）→ schema 版本（400）→ 操作能力（403/501）→ 过期（§5.4）→
  幂等核对与归属/CAS（§5.5、§4）→ 原子提交。

### 5.2 请求摘要 requestDigest（冻结算法）

```
canonical = stableCanonicalJson({
  schemaVersion: 2,
  operation,
  scope,                          // 服务端规范化后的三态对象
  expectedRevision: number|null,  // 缺席归一化为 null
  issuedAt,
  expiresAt: string|null,         // 缺席归一化为 null
  payload,                        // 该 operation 的完整规范化 payload
})
requestDigest = lower_hex(sha256(utf8Bytes(canonical)))
```

- 复用 P02-1 `stableCanonicalJson`（键按 UTF-16 码点递归升序、无空白、数组保序）；Host 与
  HostClient 共用同一实现，禁止两边各写一份。
- `commandId` **不进摘要**：它是幂等键本身，摘要只绑定请求内容，保证「同 ID 不同内容」可判别。
  键顺序不同的等价 JSON 摘要相同；任一业务参数、revision、时间字段不同则摘要不同。
- 认证秘密不进摘要输入；本 Feature 命令 payload 不含明文秘密（凭据只有引用字符串，
  `credentialRef`/`endpointRef` 原样在 payload 内参与摘要——引用不是秘密）。
- 摘要由**服务端重算**：信封不携带 digest（与 stop 的显式 digest 不同，业务命令由服务端归一化
  后计算，杜绝客户端填错/伪造分歧）。

### 5.3 回执形态

```ts
type ReceiptStatus = 'accepted' | 'completed' | 'rejected';

interface CommandReceipt {
  readonly schemaVersion: 2;
  readonly commandId: string;
  readonly principalId: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly status: ReceiptStatus;
  readonly result?: unknown;     // completed：有界业务结果（§6），序列化 ≤ 16 384 字节
  readonly resultRef?: string;   // completed：稳定结果引用（§5.6）
  readonly error?: PublicError;  // rejected：结构化公开错误（§5.7）
  readonly issuedAt: string;
  readonly completedAt: string;  // 提交时刻（ISO UTC）
  readonly replayed: boolean;    // 幂等重放取回为 true
}
```

- **P02-2 支持的命令全部为同步短事务命令，提交即完成：成功回执一律 `completed`，绝不返回
  `accepted`**；`accepted` 仅为前向兼容保留的枚举值，本 Feature 任何代码路径不得产生它，
  也不为不存在的异步操作伪造 `operationId`（不建 `operations` 表、不发 operationId）。
- 持久化的 rejected 回执只产生于**通过结构/认证/过期检查后、在原子提交内被业务前置条件拒绝**
  的情形（CAS 冲突、`stale_dependency`、注册到不可见项目的归属冲突）。结构非法、未认证、过期、
  未知操作/版本在写事务之前拒绝，**不写回执**（避免对每个畸形请求无限积行）。
- 回执响应的 HTTP 状态：completed → `200`；业务 rejected → 按 §5.7 错误码映射（409/403），
  响应体仍是同一 `CommandReceipt` 形状（`status:'rejected'`）；传输层拒绝（400/401/413/501）为
  P02-1 错误体形状，不是回执。
- 错误回执与成功回执一样按 `(principal_id, command_id)` 幂等；重放返回同一回执
  （`replayed:true`），不改写、不重新执行业务。

### 5.4 命令时效

- `issuedAt` 必填，真实日历时间且与服务端时钟偏差不超过 ±60 000 ms；`expiresAt` 若给出必须晚于
  `issuedAt`，且寿命不超过 **300 000 ms**。两个数值均为有限实施契约值（请求核对 §15.6）。
- `expiresAt` 缺席时，服务端按 `issuedAt + 60 000 ms` 判定有效期。
- **过期的新 commandId**：不启动任何业务变更，返回 `400 command_expired`，不写回执。
- **过期信封重放**（同 principal + commandId + 摘要且已有持久回执）：仍可经
  `POST /v1/commands` 取回原回执（授权重核），或经 `GET /v1/receipts/:commandId` 查询；过期不
  改变既有回执，也不重新执行。

### 5.5 幂等/冲突矩阵

| 情形（同 principal） | 响应 | 副作用 |
|---|---|---|
| 新 commandId + 摘要自洽 + 授权/CAS 通过 | `200 completed`（同事务：业务行 + 事件 + 回执） | 一次 |
| 同 commandId + 同摘要，回执已存在 | 原回执 `replayed:true`（completed 或 rejected） | 零；revision 不再增长、不重复写事件 |
| 同 commandId + **不同摘要** | `409 conflict`（`details.reason='idempotency_key_reuse'`） | 零；既有回执与业务对象不变 |
| 过期 + 新 commandId | `400 command_expired` | 零，无回执行 |
| 未认证/无能力/未知版本/非法结构/未知操作 | 401/403/400/501 | 零，无回执行 |
| 不同 principal 使用同一 commandId | 互相独立（各自回执行），互不可见 | 互不影响 |

命令重放核对、归属与 CAS 重核、业务写入、事件写入、完成回执写入必须在**同一个
`BEGIN IMMEDIATE` 短事务**内完成（F-007 的窄原子命令提交端口）：先在事务内重查既有回执/摘要、
可见性与 revision，再提交全部变更。禁止「先提交业务、后补存回执」；业务写入后注入事件/回执
失败必须整组回滚（无「持久 accepted 但结果永不可知」状态）。Git/仓库检查、文件发布、网络与
能力发现一律在写事务之外完成，提交时只重核必要的 revision。

**已实施切片（F-007/F-008/F-009）**：`CoreApplication.commandService.submit(principal, envelope)`
当前接入 `project.metadata.update`（F-007）、`project.register`（F-008）与
`settings.global.create/update`、`settings.project.create/update`（F-009）；Work/Chat/基线等
其余操作仍明确 unsupported。`ports/atomic-commands.ts` 的同步 `AtomicCommandStore`/
`CommandTransaction` 由 SQLite 同会话原语实现；P01 元数据 CAS/事件、注册 SQL、配置读写
SQL 与 F-006 回执 SQL 共用，不调用 Promise 服务、不嵌套事务。注册命令在写事务之外完成
只读仓库检查（RepositoryInspector），事务内写「项目 + 绑定 + `project.registered` 创建事件
+ completed 回执」；同 canonicalPath 命中返回 already_exists（不写事件、不覆盖元数据），
命中不可见项目按 forbidden 拒绝且不积回执。配置命令（F-009）在写事务之外完成能力目录
复检与一致性视图（全局当前配置快照，仅新命令）：全局有效配置即全局 payload 自身直接复检，
项目覆盖以「全局快照 + 新 payload」合并有效配置后按当前目录复检（继承条目随当前目录复检，
与 P01 ConfigurationService 同一纯函数）；推导出的 `consistency.globalRevision` 随写入在
同一事务内核对，不一致固化 rejected stale_dependency，不提交基于旧全局值的配置。创建成功
同事务写 `settings.*_created` 创建事件（仅命令路径，§15.3），更新复用 P01 既有 `*_updated`
写入不重复；重复创建（不同 commandId）固化 rejected already_exists，更新目标缺失按
not_found 抛出（不积回执）。P01 直接服务首建仍不写创建事件（§15.3 边界）。
过期新命令先在事务外拒绝；权威回执/摘要、授权、时效、项目与 CAS 在 BEGIN IMMEDIATE 内重核。
CAS rejected 在任何业务写入前决定；写后异常必须回滚，不折算为持久 rejected。
回调结束上下文失效，Promise 回调回滚并阻止 await 后写入；busy 仍使用既有有限预算。
真实竞争/故障/重开回归见 `test/atomic-commands.test.ts`、`test/command-register.test.ts` 与
`test/command-settings.test.ts`；Host /v1 路由接线由 F-011 完成（真实 HTTP 回归见
`test/host-app-routes.test.ts`），CLI 接线仍后序任务（F-014~F-017）。

### 5.6 resultRef 与结果读取

- completed 回执内嵌有界 `result`（序列化 ≤ 16 384 字节），同时携带不透明 `resultRef`：
  形态 `v1.` + 43 字符 base64url（32 字节密码学随机），由提交事务生成并在回执行建唯一索引；
  它**不是**数据库定位符、不是文件路径、不含 projectId/路径信息，关闭重开后稳定不变。
- `GET /v1/results/:resultRef`：按引用查回执行，核验调用 principal 是回执拥有者且目标实体当前
  仍在其可见范围（注册回执核验新建项目当前可见性），通过则返回该回执的固化结果（结果在提交时
  固化，项目后续被编辑不改变该次结果）；伪造/不可见/未知引用 → `404 not_found`，不区分不存在与
  无权。
- `GET /v1/receipts/:commandId`：只按本 principal 的回执唯一索引查找，不可见 → `404 not_found`。
- 两个读取端口都不接受任意路径参数、不读文件系统、不暴露 SQL/行 id。

### 5.7 公开错误码（在 P02-1 §14 表上扩展，映射唯一）

新增服务端码（旧码语义全部不变）：

| code | HTTP | 触发 |
|---|---|---|
| `forbidden` | 403 | 认证通过但 principal 能力/可见范围拒绝（含不可见项目统一表现） |
| `not_found` | 404 | 授权范围内实体/回执/结果引用不存在 |
| `command_expired` | 400 | 过期的新命令（`details.reason='command_expired'`） |
| `snapshot_required` | 409 | 事件游标低于可续读下界或要求重取快照（§9.4） |
| `corrupt_state` | 500 | 持久 JSON 未知版本/损坏（配置读取等）；明确不同于「未配置」，不降级为检查通过 |

`StorageError` 与仓库检查错误的公开映射（F-002 纯映射，保留 operation 与适用实体身份，details
只放 field/reason/expectedRevision/actualRevision 等脱敏键）：

| 内部失败 | 公开 code（HTTP） |
|---|---|
| `StorageError(validation)` 与输入形态类仓库检查错误 | `invalid_input`（400，字段定位） |
| 路径不存在/非目录类仓库检查错误 | `invalid_input`（400，`details.reason` 为受控仓库原因码；不回显路径） |
| Git 不可用/超时/IO/权限类仓库检查错误 | `resource_busy`（409）或 `internal`（500），按受控 reason 映射（F-002 表驱动定稿并测试） |
| `StorageError(not_found)` | `not_found`（404）；授权不可见统一折算为 `forbidden`（403） |
| `StorageError(conflict)`（CAS、唯一、`stale_dependency`、幂等键复用） | `conflict`（409，reason 区分） |
| `StorageError(ownership)` | `forbidden`（403） |
| `StorageError(busy)` | `resource_busy`（409，reason `storage_busy`） |
| `StorageError(corrupt/unsupported_version)` | `corrupt_state`（500，不回显原文） |
| 其他未预期异常 | `internal`（500，脱敏固定文案，无堆栈/路径/载荷原文） |

认证头、秘密、payload 原文、堆栈、绝对路径、stderr 原文永不进入错误体。

## 6. 支持的命令与 payload（冻结白名单）

公共结果记录统一使用 camelCase，时间字段为 ISO UTC 字符串（由 F-003 纯映射从 Core 的
UtcMs 记录转换）；project/binding/settings 记录字段集与 P01 端口记录一一对应，不新增业务字段。

| operation | scope | expectedRevision | payload 白名单 | 成功 `result` |
|---|---|---|---|---|
| `project.register` | registration | 缺席 | `{repositoryPath, displayName, description?, labels?}`（复用 `validateCreateProjectInput` 与 RepositoryInspector 规则） | `{status:'registered'\|'already_exists', project, binding}` |
| `project.metadata.update` | project | **必填** | `{displayName?, description?, labels?}`（至少一个；复用 `validateUpdateProjectInput`） | `{project}`（写后记录；事件 payload 仍只含 changedFields） |
| `settings.global.create` | global | 缺席 | `SettingsPayloadV2`（payload 本身，非 `{payload}` 包裹） | `{scope, schemaVersion, revision, payload}` |
| `settings.global.update` | global | 必填 | `SettingsPayloadV2` | 同上 |
| `settings.project.create` | project | 缺席 | `SettingsPayloadV2` | 同上 |
| `settings.project.update` | project | 必填 | `SettingsPayloadV2` | 同上 |

规则：

- 注册命令在写事务之外执行 P01 只读仓库检查（Git 身份/规范路径/脏状态只读核验），再经原子
  命令提交端口写「项目 + 绑定 + `project.registered` 事件 + completed 回执」；同 canonicalPath
  竞争仍恰有一个 `registered`，其余 `already_exists`，不增加项目/绑定/事件、不覆盖名称与标签；
  符号链接别名复用同项目；同 remote 不同 clone 分别注册。注册成功不表示基线健康。
- 元数据编辑沿用 P01 CAS 与 `project.metadata_updated` 事件；命令路径不产生第二条重复事件，
  不改 projectId、仓库绑定或配置。
- 配置命令复用 `ConfigurationService` 的全部既有规则：insert-only 首建、条件更新、能力目录复检、
  `stale_dependency`、段级覆盖。`consistency.globalRevision` 仍由应用读取推导，payload 中出现该
  键按未知字段拒绝。
- 创建/更新成功分别写 `settings.global_created`/`settings.project_created` 与既有
  `settings.global_updated`/`settings.project_updated` 事件（事件边界见 §9.2、张力见 §15.3）；
  命令路径不重复写 P01 已有的 `*_updated` 事件。
- 创建默认只影响当前配置：不重新应用已有 Task（没有 Task）、不声称策略可执行或模型已登录；
  未知 runtime/provider/model、明文秘密字段、非法政策仍按 P01 规则拒绝（`invalid_input`）。
- 未支持的 Task 执行策略接口（`updateTaskExecutionConfig` 等）、验证/基线命令返回 `unsupported`。

## 7. 查询与分页

> 实施状态：Core 应用层授权查询服务已于 F-010 落地（`application/query-service.ts`，
> 直接应用层测试覆盖，不经 HTTP）；Host 路由仍由 F-011 接线。

### 7.1 通用规则

- 所有查询经 §4 授权；可见范围谓词在 SQL 前下推，之后才分页/计数。
- 查询参数白名单（未知参数 → `400 invalid_input`）；项目查询 `limit` 为 1..200 整数
  （沿用默认 50/上限 200），`cursor` 为服务端签发的不透明键集游标（项目列表本期继续使用
  「上一页最后项目 id」形态，非法稳定 ID 拒绝）；事件页限制见 §9.3。
- 查询只读：不写 `state_events`、不创建任何行、不解析凭据、不执行脚本、不接受文件路径参数。
- 无配置是明确结果：`configured:false`，与损坏（`corrupt_state`）严格区分；缺对象返回
  `not_found` 或空页/`configured:false`（按 P01 查询语义），不降级成「已配置/检查通过」。

### 7.2 各查询响应（字段集冻结）

- `projects.list` → `{schemaVersion:2, scope:'project-list', records: Project[], nextCursor:string|null, limit:number}`。
- `projects.get` → `{project, binding}`（一次授权读取组装；无绑定时 `binding:null`，未知/不可见
  项目 `forbidden`）。
- `projects.binding.get` → `{binding}`。
- `projects.labelCounts` → `{labels: {label, projectCount}[]}`（仅可见项目去重计数）。
- `settings.global.get` / `settings.project.get` →
  `{scope, schemaVersion, revision, payload}`；缺失 `404 not_found`，损坏 `corrupt_state`。
- `settings.project.effective` → P01 `EffectiveSettings`（configured/schemaVersion/strategies/
  policies 与逐项 `global_default/project_default` 来源）；未知/不可见项目 `forbidden`。
- `settings.global.export` / `settings.project.export` → P01 `ExportedSettings`
  （`exportFormatVersion:1` 白名单投影；引用字符串原样、不解析、不含 executable/ready）。

## 8. 快照与水位

> 实施状态：一致读视图快照已于 F-010 落地（`ports/queries.ts` 的
> `ConsistentSnapshotStore` 窄端口 + `adapters/sqlite` 的 DEFERRED 读事务实现
> `readProjectSnapshotView`/`readGlobalSnapshotView`）；Host 路由仍由 F-011 接线。

`GET /v1/snapshot`（参数：`scope=project&projectId=<id>` 或 `scope=global`）：

- **同一 SQLite 一致读视图**内组装：项目 scope = project + binding + 项目当前配置（无则 null）+
  有效配置（含全局当前记录的 revision 作为来源依赖）+ watermark；全局 scope = 全局当前配置
  （无则 null）+ watermark。
- `watermark` = 该一致读视图内 `MAX(state_events.sequence)`（全局持久序列，空库为 `0`），
  与数据内容在同一读事务取得；禁止「多次独立读取后随手拼水位」。全局配置影响有效值时，其记录
  revision 与对应事件序列已包含在水位语义内（全局事件的 sequence 即全局序列的一部分）。
- 响应：`{schemaVersion:2, scope, ...内容..., watermark:{sequence:number, cursor:string}, readAt:string}`；
  `cursor` 是服务端按 §9.3 签发的不透明续读游标，绑定数据根身份与 scope。
- 并发正确性（F-010 必测）：快照边界与订阅建连之间、补读期间的写入，要么已在快照内且水位覆盖，
  要么严格落在水位之后；客户端从该水位补读并应用后，投影与最终持久状态一致，无业务缺口。
- 快照同样经 §4 授权（项目可见 / `settings.global.read`）；不返回凭据解析值与任意文件内容。

## 9. 公开事件封套、游标与 SSE

### 9.1 事件封套（event envelope schemaVersion=1）

```ts
interface PublicStateEvent {
  readonly schemaVersion: 1;             // 封套自身版本，独立于线消息/配置版本
  readonly eventId: string;              // = state_events.id（UUID），去重键
  readonly sequence: number;             // = state_events.sequence（持久全局游标）
  readonly type: string;                 // §9.2 白名单
  readonly scope: { readonly kind: 'project'|'global'; readonly projectId?: string };
  readonly aggregate: { readonly type: string; readonly id: string; readonly revision: number };
  readonly occurredAt: string;           // ISO UTC（由 occurred_at 毫秒转换）
  readonly payload: Record<string, unknown>; // 持久 payload 透传（已在写入侧脱敏白名单内）
}
```

- 纯映射（F-003）：从持久行列单向转换，不添加不存在的 Run/Task/Attempt 身份，不从 logger 文本
  推断事件；全局事件 `scope.kind='global'` 且无 projectId。模块 import 无数据库/网络/文件副作用。
- 事件按 `sequence` 升序；`aggregate.revision` 与事件封套 `schemaVersion` 语义不混用。

### 9.2 P02-2 事件类型白名单

| type | aggregate_type | project_id | payload 形状 | 何时写 |
|---|---|---|---|---|
| `project.registered` | `project` | 新项目 ID（非空） | `{"registered":true}` | 仅命令路径注册成功（F-008 已实施） |
| `project.metadata_updated` | `project` | 项目 ID | `{"changedFields":[...]}`（P01 既有） | P01 直接服务与命令路径共用，不重复 |
| `settings.global_created` | `global_settings` | NULL | `settingsChangeSummary`（键名/段名/schemaVersion） | 仅命令路径全局首建成功（F-009 已实施） |
| `settings.project_created` | `project_settings` | 项目 ID | 同上 | 仅命令路径项目首建成功（F-009 已实施） |
| `settings.global_updated` | `global_settings` | NULL | 同上（P01 既有） | P01 直接服务与命令路径共用，不重复 |
| `settings.project_updated` | `project_settings` | 项目 ID | 同上（P01 既有） | 同上 |

新增类型遵循 v2 迁移既有 CHECK：`project_id` 为空只允许 `aggregate_type='global_settings'`；
`project.registered` 在事务内拿到新项目 id 后写入（project_id 非空）。白名单外的 event_type
不得出现在 P02-2 流中；映射层遇到未知持久类型必须显式失败或跳过并计入受控诊断。
**F-003 定案（已实现并测试，见 `packages/core/src/ports/events.ts`）：一律显式失败**——
未知 event_type → `corrupt_state`（reason `unknown_event_type`）；行列结构损坏 →
`corrupt_event_row`；type/aggregate_type/project_id/aggregate_id 不一致 →
`event_scope_mismatch`；payload 非对象或出现形状外键/非法值 → `event_payload_violation`。
不静默跳过、不计数吞掉、不蒙混透传未知 payload 键（可能含值/秘密），**永不伪造**事件；
F-012 按 §9.4 以错误响应/`event: error` 帧呈现，不把坏行伪装成空流。

### 9.3 游标与分页

> 实施状态：持久事件分页读取已于 F-010 落地（`ports/events.ts` 的
> `StateEventReadStore` 窄端口 + `QueryService.listEvents` 授权分页）；
> SSE 持续订阅仍由 F-012 实现。

- 不透明字符串 `evcur_v1_<base64url>`，解码内容为
  `{"v":1,"seq":<number>,"root":<dataRootIdentity 前 16hex>,"sk":<scope 指纹 hex>}`，
  其中 `sk` 为 scope 指纹（project 含 projectId；global 为固定值）。客户端只保存/回传，不构造、
  不依赖解码内容。
- 游标与数据库持久 sequence 对应；空库初始水位 `seq=0`（由快照签发）。合法恢复游标：seq 为
  0..2^53-1 的安全整数、版本为 1、root 与当前数据根相同、scope 与订阅参数匹配。
- 非法：无法解码/未知版本/负数/小数/超过安全整数/root 不符/scope 不符 →
  `400 invalid_input`（`details.reason='invalid_cursor'`），**不得当作从零读取**。
- 未来游标（seq 大于当前水位）合法：连接后等待新事件，不立即报错。
- 其他项目造成的 sequence **空隙不是丢失**：授权过滤后流中序号可跳跃，客户端不得以连续性假设
  判缺口；只有 §9.4 的下界判定触发 snapshot_required。
- 事件补读分页：每批最多 **500 条**，默认 **100 条**（1..500），按 sequence 升序；非法 limit
  `400 invalid_input`。重开数据库后游标不重置。

### 9.4 SSE 订阅（`GET /v1/events`）

> 实施状态：F-012 已实施——Host SSE Hub（`packages/host/src/runtime/sse-transport.ts`）
> 经 Core `QueryService.resolveEventResume`/`readEventBatch` 实现恢复解析与轮询
> 补读（每批重新核验授权）；Last-Event-ID 解析经 `StateEventReadStore
> .findPersistedEventSequence` 窄端口；可续读下界经受控读取缝注入（生产恒 0）。
> 实施值（§15.6）：轮询唤醒 250 ms、drain 等待预算 2 000 ms。

- 入参：`scope=project&projectId=<id>` 或 `scope=global`。恢复位置三选一（优先级）：
  `Last-Event-ID` 头（值为 eventId，服务端在同一读视图映射到所属 sequence 与 scope）→
  `?cursor=` → 缺省（拒绝：必须先取快照，`400 invalid_input`，reason `cursor_required`）。
  要求 `Accept: text/event-stream`；仍需 Bearer 认证（CLI 用 http 客户端，不依赖浏览器 EventSource）。
- 语义：先在一致读视图补读水位之后已提交事件（升序、有界分页），再持续推送新事件；至少一次
  投递，客户端按 `eventId` 有界去重（缓存上限 512 个 id）；持久 `state_events` 是唯一来源，
  内存通知/日志只能唤醒读取，不充当事件正文。
- 帧格式：
  - 业务帧：`id: <eventId>\nevent: state-event\ndata: <PublicStateEvent 单行 JSON>\n\n`；
  - 心跳：无事件时每 **15 000 ms** 一行 `: ping\n\n`；
  - 建连前的快照指引：HTTP `409 snapshot_required`（JSON 错误体，
    `details:{reason:'cursor_beyond_replay_lower_bound', snapshotRoute:'/v1/snapshot'}`）；
    建连后才发现的下界问题以一帧 `event: error` +
    `data:{"code":"snapshot_required",...}` 后正常结束流。
- **可续读下界**：P02-2 不做事件清理/保留策略，持久序列自 1 起全保留，正常库下界为 `0`。
  游标低于「该 scope 现存最小可读 sequence 且无法补读」时才判 snapshot_required。本期触发路径：
  (a) 受控测试夹具注入的保留下界水位（F-004），F-012 用其验证过期分支，**不为测试删除或篡改
  持久审计行**；(b) 游标与数据根/scope 不匹配按 §9.3 判非法游标（400），不是 snapshot_required。
- 背压（有界，实施契约值，请求核对 §15.6）：单连接待发送缓冲上限 **1 048 576 字节**；单批最多
  **500 条**且序列化不超过 **262 144 字节**；慢客户端致缓冲超限，发送一帧
  `event: error` / `data:{"code":"stream_overflow","snapshotRoute":"/v1/snapshot"}` 后结束该流
  （要求重取快照/续读），**不丢持久审计**，也不阻塞快客户端。
- 生命周期：连接关闭只清理该连接的轮询/订阅/心跳；客户端断开不回滚或取消已提交命令、不停止
  Host；Host stop（quiescing）对新订阅返回 `503 not_ready`，在途流随 P02-1 §10.5 收尾关闭；
  Host 重启后可用原持久游标续读（游标不依赖内存状态）。
- 越权订阅在发送任何业务帧之前拒绝（403），不泄漏其他项目或全局事件正文。

## 10. SQLite 迁移 v3：`command_receipts`

- 由 F-006 新增为迁移 **v3**（接 v2 `state_events` 之后；F-006 已实施）；DDL 与 `schema.ts`
  Drizzle 定义同步，checksum 进 `schema_migrations`，漂移/高版本继续拒写（沿用 migrator 既有规则）。
- 必须从**空库**与 **P01 最新库（v2）**两条路径迁移成功；既有 projects/bindings/settings/events
  与 sequence 不变；迁移与 Drizzle Schema 一致性进真实 pragma 交叉核对测试。
- 表设计冻结（落库列名按既有 snake_case，应用层 camelCase 映射）：

```sql
CREATE TABLE command_receipts (
  id TEXT PRIMARY KEY NOT NULL,              -- 行 ID（UUID，应用侧生成）
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,       -- 回执自身计数（恒 1，保留共同字段约定）
  updated_at INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,                  -- 'registration' | 'global' | 'project'
  project_id TEXT,                           -- 仅 project scope 非空（依据 §15.1）
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL,              -- 64 小写 hex
  status TEXT NOT NULL,                      -- 'completed' | 'rejected'（不写 accepted）
  result_json TEXT,                          -- completed：有界结果 JSON（序列化 ≤ 16384 字节）
  result_ref TEXT,                           -- completed：不透明结果引用（唯一）
  error_code TEXT,                           -- rejected：公开错误码
  error_message TEXT,                        -- 脱敏固定文案
  error_details TEXT,                        -- JSON 对象（仅受控键）
  issued_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  CONSTRAINT command_receipts_project_fk
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_scope_check CHECK (
    (scope_kind = 'project' AND project_id IS NOT NULL) OR
    (scope_kind IN ('registration','global') AND project_id IS NULL)
  ),
  CONSTRAINT command_receipts_status_check CHECK (status IN ('completed','rejected')),
  CONSTRAINT command_receipts_completed_check CHECK (
    status <> 'completed' OR (result_json IS NOT NULL AND result_ref IS NOT NULL AND error_code IS NULL)
  ),
  CONSTRAINT command_receipts_rejected_check CHECK (
    status <> 'rejected' OR (error_code IS NOT NULL AND result_json IS NULL)
  ),
  CONSTRAINT command_receipts_digest_check
    CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')
);
-- (principal_id, command_id) 与 result_ref 唯一约束以 CREATE UNIQUE INDEX 落库（与
-- v1/v2 既有迁移同一表示：pragma index_list origin='c' 可与 Drizzle uniqueIndex 交叉
-- 核对）；语义与表级 UNIQUE 约束完全等价，唯一性与约束名不变。
CREATE UNIQUE INDEX command_receipts_principal_command_unique
  ON command_receipts (principal_id, command_id);
CREATE UNIQUE INDEX command_receipts_result_ref_unique
  ON command_receipts (result_ref);
CREATE INDEX command_receipts_principal_project_index
  ON command_receipts (principal_id, project_id);
```

- 不建 `operations` 表、不加 `operation_id` 列、不向 projects/settings/state_events 增加新结构；
  `project_id` 可空 + scope CHECK 是对设计 11 §9「必填 FK」的**显式偏离登记**（依据 §15.1，
  与 v2 `state_events` 同一先例），不得悄悄放宽为任意 scope 可空。
- 端口只暴露应用数据形态（F-006 窄端口），不泄漏 better-sqlite3/Drizzle 会话；唯一约束、CHECK、
  跨身份读取拒绝、关闭重开一致、有界 result_json 均有真实 SQLite 测试。

## 11. Host 装配、握手能力与 HostClient 扩展

### 11.1 装配

> 实施状态：F-011 已接线。`host-startup.ts` 在 `createHostLifecycleServer` 上装配
> `application` 上下文（固定绑定 `createLocalOwnerPrincipal()` + Core 窄服务
> commandService/queryService/commandReceiptsService）；Host 不直接写库、不跨包导入
> Core 内部 SQLite 实现（边界检查继续强制）。受限主体仅经测试装配（固定于该 server
> 实例，绝不来自请求数据）。

- Host 仅经 `shiploop-core/assembly` 的受控 `openCoreApplication` 取得 Core，并新增**可信应用装配
  层**把 §4 的 principal 传入 Core 命令/查询服务；Host 传输层不直接写库、不跨包导入 Core 内部
  SQLite 实现（边界检查继续强制）。
- 生产固定装配 `local-owner`；受限主体只在测试装配出现。Core 应用命令服务的授权检查不依赖
  HTTP 类型存在（接口只接收 `TrustedPrincipal` + 纯数据）。
- 公共 import 仍无启动副作用；dist 构建冒烟必须覆盖新增路由的装配失败不发布 ready。

### 11.2 HostClient（F-013）

- 复用 P02-1 发现/认证/双向核验，握手通过前不发业务请求；业务方法只访问 §3.2 正式路由，不打开
  SQLite、不直读业务文件；对响应也做运行时校验（畸形回执/事件、未知版本 → 协议错误）。
- **一次逻辑命令一个冻结信封**：每个命令生成/接收一个 commandId；超时或响应丢失时先以该
  principal 查回执（`GET /v1/receipts/:commandId`），在有限预算内仍未知才用**完全相同的信封**
  重发（不重新生成 issuedAt/expiresAt/payload/commandId）；连接失败不解释为业务拒绝或完成。
- 「Host 已提交但响应丢失」必须取回原 completed/resultRef 且数据库只有一次副作用；回执未知时
  明确结果不确定，不无限重试、不另起争写 Host 实例。
- 查询按分页参数请求；SSE 解析必须处理跨分块 UTF-8 与 SSE 帧、保留最后可恢复游标、按 eventId
  有界去重；`snapshot_required` 暴露为明确恢复分支，不偷偷从零重读。
- 连接/重试/响应大小有上限；不跟随重定向（不向新地址发 token）；`close()`、AbortSignal 与订阅
  中断只释放本地观察资源，不触发 stop/cancel。响应错误只信任白名单 code 与受控 details 键。

### 11.3 握手能力视图（schemaVersion=2 形状）

```json
{
  "schemaVersion": 2,
  "protocolVersion": 1,
  "capabilities": {
    "lifecycleRoutes": ["handshake", "status", "stop"],
    "stop": { "modes": ["graceful"], "idempotency": "commandId+requestDigest", "activityScope": "idle-only" },
    "application": {
      "commands": ["project.register", "project.metadata.update", "settings.global.create", "settings.global.update", "settings.project.create", "settings.project.update"],
      "queries": ["projects.list", "projects.get", "projects.binding.get", "projects.labelCounts", "settings.global.get", "settings.global.export", "settings.project.get", "settings.project.effective", "settings.project.export", "receipts.get", "results.resolve", "snapshot.get"],
      "events": { "transport": "sse", "route": "/v1/events", "scopes": ["project", "global"] }
    }
  }
}
```

只宣告本次真实实现的接口；未列出的能力请求即 `unsupported`。F-011 完成路由接线前，Host 不得宣告
对应能力（保持 P02-1 现状，或按实现进度增量更新本视图与守护测试）。

> 实施状态：F-011 起握手为线消息 schemaVersion=2 且 `application.commands`/
> `application.queries` 即上表清单（与路由接线一一对应）；F-012 起
> `application.events` 为上表 events 行的结构化 SSE 视图（未装配 SSE Hub 的
> 测试传输面仍在该路由返回 501，防御纵深）。客户端校验（`validateHandshakeResponse`）
> 对该视图做精确键与集合相等核验，任何伪称/缺键一律 `response_malformed`。

## 12. CLI 参数面与退出码（F-014 ~ F-017 冻结）

### 12.1 命令面

```text
shiploop host start|status|stop ...（P02-1 既有，参数/语义不变，线消息随 Host 升 v2）

shiploop project register <repository-path> --name <displayName>
        [--description <text>] [--label <l> ...] [--command-id <uuid>]
shiploop project list [--label <l> ...] [--match any|all] [--limit <int>] [--cursor <id>]
shiploop project get <projectId>
shiploop project edit <projectId> --revision <int>
        [--name <text>] [--description <text>] [--label <l> ...] [--command-id <uuid>]
shiploop project labels

shiploop config create --scope global --input <file>
shiploop config create --scope project --project <id> --input <file> [--command-id <uuid>]
shiploop config update --scope global --revision <int> --input <file> [--command-id <uuid>]
shiploop config update --scope project --project <id> --revision <int> --input <file> [--command-id <uuid>]
shiploop config get --scope global
shiploop config get --scope project --project <id>
shiploop config effective --project <id>
shiploop config export --scope global
shiploop config export --scope project --project <id>

shiploop receipt get <commandId>
shiploop events (--project <id> | --global) [--cursor <cursor>] [--snapshot-only] [--follow]
```

- 所有命令共用 `--data-root <abs>`、`--json` 与 P02-1 相同的有限超时参数；仅 Host 命令可启动
  Host，业务命令经 `ensureHostRunning` 连接或受控启动同一单例（CLI 自身不打开 SQLite）。
- 本版 `project register` **不是** P02-3 的完整 `project init`：没有确认流程、基线、Profile、技术栈
  推断与 Skills 参数，帮助文本必须写明。
- `--input <file>` 只是**本次请求的输入**（配置 v2 JSON）：文件内容不得指定 Core 数据库路径、
  resultRef/结果读取路径或提权主体；CLI 不监听文件变化、不做覆盖式配置。
- 写命令可显式传 `--command-id <uuid v4>`；省略时由 HostClient 生成一次并冻结。重复提交用同一
  信封（先查回执）。
- `events` 默认行为：先取授权快照与水位，再持续跟随（`--follow` 为默认；`--snapshot-only` 只取
  快照与补读一页后退出）；支持显式 `--cursor` 恢复；`snapshot_required` 时重新取快照并在 JSON 流
  中输出明确记录，不默默丢历史。

### 12.2 解析纪律与输出

- 参数解析保持纯函数（env 显式注入），解析失败前**不**发现 Host、不联网、不启动进程；未知参数、
  缺值、非法 projectId/revision/limit/cursor、global/project scope 冲突（如 `--scope global` 带
  `--project`，或 project 缺 `--project`）、非法输入 JSON、给不支持能力的参数 → 退出码 2。
- 监听地址覆盖零容忍参数/env 规则不变。
- `--json` 时 stdout 只含可解析结构化结果/失败信封（沿用 P02-1 `{ok,command,result|error}` 信封，
  命令名扩展为 `project.register` 等）；人类诊断到 stderr；持续观察的 JSON 模式输出记录流（NDJSON），
  不混入普通日志。错误保留 commandId 以便查回执。
- accepted（本版本不应出现）与观察中断**不得**显示为 completed。

### 12.3 退出码（在 P02-1 四档上扩展第五档）

| 退出码 | 类别 | 情形 |
|---|---|---|
| 0 | 成功 | 命令 completed；查询/快照成功；`--snapshot-only` 正常结束 |
| 1 | 业务拒绝/操作失败 | `forbidden`、`conflict`、`not_ready`、`resource_busy`、`unsupported`、`unsupported_platform`、`corrupt_state`、服务端 `internal`、`stop_not_confirmed` 等（细分只看 error.code） |
| 2 | 输入错误 | 参数/输入 JSON/非法 ID 与分页/scope 冲突/监听覆盖/本地不安全发现（P02-1 既有） |
| 3 | 连接/协议错误 | `host_not_found`、不可达、超时、重定向、`protocol_incompatible`、`unsupported_schema_version`、`response_malformed`、`start_timeout`（P02-1 既有） |
| **4** | **观察中断（P02-2 新增）** | `events` 跟随中被 Ctrl+C/Abort/观察超时中断，或收到 `stream_overflow` 结束：只表示**本次观察**结束，命令未被取消、Host 未停止；JSON 记录 error.code=`observation_interrupted`/`stream_overflow` 与最后游标 |

第五档是对设计 08 §4「建议 0/1/2/3，最终码表在 CLI 实现前定案」预留位的定案（请求核对
§15.6）；P02-1 四档码值与归类不变。帮助文本必须说明：观察中断不停止 Host、不取消已提交命令，
  停止 Host 仍只有显式 `host stop`。

## 13. 资源上限与预算总表（有限默认值，非用户可配）

| 项 | 值 |
|---|---|
| `/v1/host/*` 请求/响应体 | 16 384 B（不变） |
| `/v1/commands` 请求/响应体、查询响应体 | 65 536 B |
| GET 查询串 | 8 192 B |
| 回执内嵌 `result` 序列化 | ≤ 16 384 B |
| 事件补读每批 | 默认 100，最大 500 条；序列化 ≤ 262 144 B |
| 单 SSE 连接待发送缓冲 | 1 048 576 B（超限 stream_overflow 结束该流） |
| eventId 去重缓存 | 512 个/连接 |
| SSE 心跳间隔 | 15 000 ms |
| 命令 issuedAt 时钟偏差 | ±60 000 ms；默认 TTL 60 000 ms；expiresAt 最大寿命 300 000 ms |
| 客户端命令/查询预算 | 连接 2 000 ms；请求整体 10 000 ms（回执轮询次数有上限，沿用 §11.2 有限重试） |
| 服务端 headers/request timeout | 5 000 / 15 000 ms（不变；request timeout 覆盖业务短事务） |
| 项目列表分页 | 默认 50，上限 200（P01 常量，不变） |
| 标签/名称/描述上限 | 64 / 50 个；200；10 000 码点（P01 常量，不变） |

数值为首版有限默认值；实现可凭测试依据调整并回写本文，不得改无界，不得开放为监听/安全放宽配置。

## 14. 需求与测试编号映射

### 14.1 FR 分支

| 需求 | 正常分支 | 关键失败分支 |
|---|---|---|
| FR-1 命令与回执 | 注册/元数据/配置命令经授权原子提交，completed 回执含 result/resultRef | 重复命令复用、不同摘要 conflict、过期新命令、跨项目/跨 principal 拒绝、actorId 提权、未知版本/操作、事务注入失败整组回滚、响应丢失后查回执 |
| FR-2 查询与事件 | 授权快照 + 水位后续读，SSE 持续投递并可断线续读 | 游标非法/过期（snapshot_required）/scope 不符、越权订阅、补读期间写入无缺口、慢客户端 stream_overflow 不丢审计、任意路径/伪造 resultRef 拒绝、无配置/损坏区分 |

### 14.2 阶段验收索引（PRD §3.3：T10 基础、T15 基础、T17、T23、T26 命令幂等）

| 编号 | 本 Feature 认领子集 | 不覆盖 |
|---|---|---|
| T10 | 项目隔离与凭据脱敏子集：principal 授权矩阵、跨项目/全局越权拒绝、错误/导出/证据不含秘密与路径、不可信 payload 字段拒绝 | 审批、运行时凭据注入 |
| T15 | 注册子集：同路径/符号链接幂等、同 remote 不同 clone 分别注册、注册竞争唯一对象（均经命令路径） | init 中断恢复/移动 rebind/已有失败基线/多 clone 归档（P02-3/R2） |
| T17 | 沿用 P02-1 完整覆盖；新增业务路由不绕过握手认证与单例 Host | — |
| T23 | 沿用 P02-1 完整覆盖；业务路由同样不开放 CORS/公网/地址覆盖 | — |
| T26（命令幂等） | **完整认领命令幂等语义**：(principal,commandId) 唯一、摘要复用/冲突、回执持久化、超时查回执、响应丢失一次副作用 | 设计 09 T26 的「计划修改越过活动执行/过期审批」（无执行域） |
| 设计 09 T26（配置 CAS） | 经命令路径再覆盖：insert-only、expectedRevision、stale_dependency、配置竞争（P01-4 已有服务级子集） | 配置历史版本表、跨层策略编排 |
| T03/T12 相关 | state_events 与业务同事务、持久游标、事件重连/去重（T12 的事件子集） | 通知投递/delivery 表、外部渠道 |

### 14.3 T26 编号不一致记录（沿用 P02-1 §15.4 结论，按行为映射）

- P02-2 PRD §3.3 与 P02-1 PRD 同样写「T26命令幂等」；设计 09 §2 的 T26 原文为「当前配置 CAS 冲突、
  计划修改禁止越过活动执行、过期审批失效」，其重复请求语义另由 T03 承载；设计 08 §2/12 §4 独立规定
  命令幂等（commandId + 请求摘要 + 持久回执）。
- 本 Feature 两者都涉及：命令幂等依据设计 08/12（见 §5），配置 CAS 依据 P01 服务与设计 09 T26
  的配置子集（见 §6）。编号冲突为文档问题，按**具体行为**建立上表映射；不据此增减任何行为。
- P02-1 已就同一不一致请求核对，尚无负责人变更结论；本 Feature 继续携带该核对请求（§15.5）。

## 15. 设计差异登记与待核对项

### 15.1 注册前无 projectId：信封 scope 与回执项目外键（张力，请求核对）

- 事实：设计 08 §2 候选信封为顶层必填 `projectId: string`；设计 11 §9 `command_receipts.project_id`
  标为必填项目 FK；设计 03 §3 同表列名含 principal_id/command_id/request_digest。但
  `project.register` 执行前项目尚不存在（正是该命令创建项目），全局配置命令也没有适用项目。
- 契约决定（实施依据）：(a) 信封以 §5.1 的 `scope` 三态（registration/global/project）替代顶层
  projectId；(b) 迁移 v3 的 `command_receipts.project_id` **可空**并加
  `command_receipts_scope_check`：仅 registration/global 允许 NULL，project scope 必填且有项目 FK
  （ON DELETE RESTRICT）。这与 v2 `state_events.project_id` 可空（P01-3 已登记的同一先例）同构，
  不使用虚构项目 ID，不放宽其他 scope 的外键。
- 注册回执的结果体内含新项目 ID；注册事件 `project.registered` 在同事务内以新项目 id 写
  project_id（非空）。
- **请求核对**：若设计原意要求注册也有先存项目外壳或全局命令另有归属表，F-006/F-008 实现前需
  负责人给出依据；确认前按本节冻结行为实施，不静默改领域语义。

### 15.2 全局配置与全局事件的授权范围（张力，请求核对）

- 事实：P01-3 只有数据层 scope 校验，无 principal 概念；设计 08 要求 actor/principal 由认证上下文
  绑定、项目授权在 Core；全局配置/全局事件（project_id 为 NULL）的可见范围未逐字规定。
- 契约决定：§4.3 把全局读写与全局事件单列为独立能力（`settings.global.read/write`），项目能力不
  蕴含全局能力；项目级主体订阅事件流不收到 `project_id IS NULL` 行；`effective` 查询允许在服务端
  合并中读取全局值但不向项目主体返回全局原文。生产 `local-owner` 持全部能力。
- **请求核对**：若未来要求「项目主体可读全局脱敏默认值」等更细粒度能力，应新增显式能力位，不靠
  隐式放宽。

### 15.3 P01 首次创建不写事件与命令路径创建事件的衔接（张力，请求核对）

- 事实：P01-3 明确首次创建（项目、全局/项目配置）为 insert-only 且**不写** state_events（只有
  `*_updated` 事件）；PRD FR-1/FR-2 要求「业务状态与 state_events 同事务」，F-008/F-009 验收要求
  命令路径补齐 `project.registered` 与 `settings.*_created` 创建事件。
- 契约决定：**创建事件只在新命令提交路径写入**（原子命令提交端口，§5.5）；P01 直接应用服务方法
  （`createProjectWithRepositoryBinding`、`createGlobalSettings`、`createProjectSettings` 等）保持
  P01 语义不变，以保留前序业务语义回归（P01-3/P01-4 测试不改）。更新类事件双方共用同一
  `*_updated` 写入，命令路径不重复写。两条路径的边界由 F-008/F-009 的测试固定
  （F-008 已固定项目注册边界：`test/command-register.test.ts` 断言 P01 直接服务注册零事件、
  命令路径恰一条 `project.registered`；F-009 已固定配置边界：
  `test/command-settings.test.ts` 断言 P01 直接服务首建零事件、命令路径恰一条
  `settings.global_created`/`settings.project_created`，且更新事件双方不重复写）。
- **请求核对**：若要求直接服务路径也补创建事件，应作为对 P01 契约的显式变更（同步 P01 测试与
  文档），不在本 Feature 静默修改。

### 15.4 线消息 schemaVersion 升 v2 与能力形状（实施契约值，请求核对）

见 §3.1：发现/线协议版本不动，握手及全部消息升 schemaVersion=2，capabilities 以 §11.3 结构化
视图替代两个 unsupported 字面量。风险是旧 P02-1 CLI 与新 Host 不兼容；以明确的
unsupported_schema_version 失败替代畸形响应，且 Host/CLI 同仓同版发布。若负责人要求保持 v1 外加
字段，需在 F-011 前修订本文及 F-013 兼容策略。

### 15.5 携带的既有核对请求

- P02-1 §15.4 的 T26 编号语义（§14.3）。
- P01-3 §9 已登记但未见负责人逐条结论的实施值（元数据上限、仓库检查范围与 repoIdentity、政策段
  合并粒度、stale_dependency、脱敏导出 Schema 等）：P02-2 原样沿用，不重新解释。

### 15.6 本契约新增的实施值（设计未给定数值，请求核对）

命令/查询体积上限 65 536 B、查询串 8 192 B、result 有界 16 384 B、事件批次 100/500 与 262 144 B、
SSE 缓冲 1 048 576 B、心跳 15 000 ms、SSE 轮询唤醒 250 ms、SSE drain 等待预算 2 000 ms、
去重缓存 512、命令时钟偏差 ±60 000 ms、默认 TTL 60 000 ms、
最大寿命 300 000 ms、CLI 退出码 4（观察中断）、resultRef 形态、游标形态与 `local-owner`
principalId 字面量。调整须有测试依据并回写本文，不得改无界或变为可配置放宽项。

## 16. 对后续任务的契约约束（摘要）

| 任务 | 必须遵守 |
|---|---|
| F-002 | §3 版本、§5.1 信封/§5.3 回执形状、§5.7 错误映射；纯契约模块无 I/O 副作用；表驱动校验 |
| F-003 | §9 事件封套/白名单/游标纯映射与校验；不推断 Run/Task 身份；UTC/ISO 转换 |
| F-004 | 受限 principal 只由可信测试装配绑定；真实临时 SQLite/Git/HTTP/SSE；故障注入点在业务写后事件/回执写前 |
| F-005 | §4 全部；授权在 Core 应用层；可见范围先于分页；重放/历史回执重核权限 |
| F-006 | §10 迁移 v3 与窄回执端口；(principal,commandId) 唯一；resultRef 授权解析；空库/v2 库迁移 |
| F-007 | §5.5 单 BEGIN IMMEDIATE 原子提交；注入回滚；过期不启动业务；busy 有限预算 |
| F-008 | §6 注册/元数据命令复用 P01 校验与只读检查；§15.1/§15.3 边界；不实现 init/基线/rebind |
| F-009 | §6 配置命令复用 P01 Schema/能力目录/stale_dependency；创建事件只在命令路径 |
| F-010 | §7/§8 一致读视图、授权过滤先于分页、快照水位、损坏/未配置区分 |
| F-011 | §3.2 路由与 §11 装配；能力只宣告真实接口；任意路径读取负例；不跨包导入内部 SQLite |
| F-012 | §9.4 SSE 全部；持久事件为唯一来源；背压/清理/重启续读；越权不发正文 |
| F-013 | §11.2 HostClient；冻结信封、超时先查回执、有限重发；响应运行时校验 |
| F-014 | §12 CLI 参数面/解析纪律/帮助；不新增基线/Run/模型参数 |
| F-015/F-016 | dist CLI 真实临时仓库/数据根纵向接线；CLI 不打开 SQLite、不读认证文件 |
| F-017 | §9/§12.3 快照+SSE 观察、snapshot_required 重载、Ctrl+C 仅退出观察（退出码 4） |
| F-018 | §14 全覆盖真实集成回归；verify 全 0；不把 P02-4 的 accept:p02 列为已通过 |
| F-019 | 操作说明只用 dist 实际入口与本文参数；unsupported/观察语义写明 |
| F-020 | 报告引用受测 commit 与本文；FR 证据逐项；not_run 不折算 |

任何任务发现本文与实际需求/设计冲突，记录依据并请求核对，不擅自改协议或领域语义。

## 17. 输入文档版本

Feature 输入在 Harness（非本仓库内容、非运行时依赖），以 SHA-256 固化：

| 文档 | 版本/日期 | SHA-256 |
|---|---|---|
| `features/2026-10-04-23-19-52_p02-2/input/p02-commands-events.md`（本 Feature PRD） | v0.2，2026-10-01 | `bb655fc04fd2b53805fcec35f814537c6ee371ffa351def1d026d30136ab00b3` |
| 同目录 `execution-contract.md` | 2026-10-01 | `89dcd2b28202fb9a27ed551be35ac7bc92819f70867ad7698450d9b6e5d8e069` |
| `core-design/08-host-api-and-cli.md` | 2026-09-24 草案 | `507e23617a2fd1b1865eab17208512e115dd816c8eb6c8c0f8110e1ef7bd4163` |
| `core-design/12-end-to-end-flows.md` | 2026-09-28 | `14acd09fc64ed3933b6f021e398f6b98a7211cfec68442f50f7c35cf9750f4d9` |
| `core-design/03-storage-and-transactions.md` | 2026-09-24 草案（含 S2 记录） | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/11-database-model.md` | 草案 | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |
| `core-design/06-project-and-context.md` | 草案 | `ea9ef3e50e9f9ea5423ca673e41f6d3397996fd774c543b268316397d00c1394` |
| `08-migration-roadmap.md` | 2026-10-01 更新 | P02-1 已核对（见 p02-1 契约 §17.2） |

## 18. 复核

- 基线：§1.3（`npm ci` 退出 0；`npm run verify` 退出 0，PASS 3/3；59 files / 1332 tests）。
- 本文引用的冻结事实（基线 hash、版本、路由、能力、错误码、scope/事件白名单、非目标）由
  `test/docs-p02-2-commands-events-contract.test.ts` 交叉核对；实现任务改变「当前事实」（如
  F-006 加迁移 v3、F-011 接路由）时必须同步更新该守护与本文，不得让文档另立一套。
- 本文是实施前置契约，不声明任何 P02-2 能力已实现；未运行项与未验收平台在 F-020 报告记 not_run。


