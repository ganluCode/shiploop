# P02-3 项目初始化与获准基线检查 — 接口契约

- 对应任务：F-001（核对 P01 放行基线、P02-1 生命周期与 P02-2 命令/查询/事件交付基线，
  冻结 P02-3 静态接入、基线授权、受监督进程与 CLI 的实施契约）。
- 文档状态：P02-3 实施前置契约（F-002 ~ F-020 的唯一协议依据，**不是**阶段验收报告，也不是
  已实现能力声明）。本文描述的 `project init/overview`、`projects.inspect`、基线
  `preview/run/cancel` 命令、`baselines.*` 查询、`artifacts.get` 证据读取与基线 CLI 在冻结时
  **尚不存在**；F-014 前任何请求必须继续按 P02-2 现状得到 `404 unknown_operation` 或
  `501 unsupported`。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收。
- 输入依据：PRD `p02-onboarding.md`（版本 0.2，2026-10-01，状态「待审阅的需求文档」，哈希见
  §17）、共同执行约束 `execution-contract.md`（2026-10-01）、知识目录 `architecture-redesign/`
  （开发查阅路径在 Harness，非本仓库内容、非运行时依赖）。
- 与既有契约的关系：Host 发现/认证/生命周期仍以
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)、
  [p02-1-writer-lock.md](p02-1-writer-lock.md) 为唯一依据；命令信封/回执/幂等/查询/事件/SSE 仍以
  [p02-2-commands-events-contract.md](p02-2-commands-events-contract.md) 为唯一依据。本文只在其
  预留位上定案（P02-2 §5.3 的 `accepted`/`operationId` 前向兼容位、§2.2 明确留给 P02-3 的
  `confirmProfile`/`runBaseline`/`project init` 位），不修改 P02-1/P02-2 的既有语义。P01 应用
  服务语义以 [p01-3-application-contract.md](p01-3-application-contract.md) 为准。
- 本文不静默改变领域语义；发现的编号与语义张力集中记录于 §15，并按 §15.10 请求核对。

---

## 1. 前序基线核验（开工核对）

### 1.1 分支与提交

- 实际执行分支：`feat/2026-10-04-23-19-52_p02-3`（worktree
  `shiploop-2026-10-04-23-19-52_p02-3`，主仓库 `shiploop` 的正式开发 worktree（`.git` 为 gitdir
  指针，指向主仓库 worktrees 目录），基线
  `feat/2026-10-04-23-19-52_p02-2`（`feature.yaml.metadata.base_branch`）。
- 开工时 HEAD（= P02-3 起点，完整 hash）：
  `3caca4892423fb33c2ea423edfd426c146314793`（P02-2 F-020：交付报告、FR 覆盖索引与脱敏证据核对，
  **纯文档提交**，不改产品代码）。
- P02-2 **受测产品代码** commit：`98cf080394e1d9f848c06ecbcca65c28c1b3c7b7`（F-019：操作说明与
  P02-3 接口交接）。P02-2 产品代码集成回归 commit：`9d92977047555afc547705446c952fbf43bf08a4`
  （F-018）。P02-2 最后一个产品代码 commit：`eff0c2634b8eb04c27082a5727471f06fd35ff9d`（F-017：
  events 观察 CLI 纵链）。`98cf080..3caca48` 只新增操作说明、交接、交付报告与文档守护，产品行为
  与受测代码一致；**不得把 F-019/F-020 文档 hash 当作受测产品 commit**。
- P02-1 **受测产品代码** commit：`8473f306d8bc825356eaa42defc3e512e22edbae`（F-013：整 Feature
  多进程集成回归）；P02-1 文档收尾 commit：`7ae5f39bb3d30a82a37a592d938a8e3d933f8c02`（F-014，
  纯文档，是 P02-2 的起点）。
- 祖先核验（`git merge-base --is-ancestor`，均为真）：
  - P01 负责人放行基线 `5a43a042b98bf2317db7501547def93a4f08f2fa` 为当前 HEAD 祖先；
  - 负责人放行记录提交 `24dcb7da41f2cb080c6b01c94a4cb24bddb8e4d3` 为 `main` 当前 tip，亦为祖先；
  - P02-1 起点 `83091167ffd41494146f404fbc46861d3b976d13`、P02-1 受测产品 commit
    `8473f30`、P02-2 起点 `7ae5f39` 均为祖先；
  - `main..HEAD` 恰为 P02-1 的 14 个提交（F-001 ~ F-014）+ P02-2 的 20 个提交（F-001 ~ F-020），
    共 34 个，无夹带。
- 人工放行依据沿用 P02-2 契约 §1.1 的核对结论：存在负责人 ganlu 2026-10-05 明确阶段放行
  （「p01帮我修改一下，放行」），P02-1/P02-2 在该放行行的 P01 基线上增量完成。F-001 不代签、
  不自动合并、不扩大放行范围；P02-3 没有新的人工签字需求，也不代替 P02 阶段验收
  （`accept:p02` 属阶段末项 P02-4）。

### 1.2 P02-1 / P02-2 交付能力实际检查（非占位）

F-001 实际打开源码与测试逐项核对，下表入口与测试在开工时**已存在且被 `npm test` 收集**：

| 能力 | 实际入口（源码） | 关键测试（`test/`） |
|---|---|---|
| 线消息/发现/协议版本与路由常量 | `packages/host/src/contract/constants.ts`（`CURRENT_SCHEMA_VERSION=2`、`CURRENT_PROTOCOL_VERSION=1`、`DISCOVERY_SCHEMA_VERSION=1`、`MAX_APP_BODY_BYTES=65_536`、`MAX_QUERY_STRING_BYTES=8_192`、`/v1/commands`、`/v1/receipts/`、`/v1/results/`、`/v1/projects`、`/v1/settings/*`、`/v1/snapshot`、`/v1/events`） | `host-lifecycle-contract.test.ts`、`docs-p02-2-commands-events-contract.test.ts` |
| 命令信封/摘要/回执/错误映射 | `packages/core/src/ports/commands.ts`（`WIRE_MESSAGE_SCHEMA_VERSION=2`、9 项 `APP_CAPABILITIES`、6 个 `COMMAND_OPERATIONS`、`COMMAND_OPERATION_SPECS`、时效常量、`PUBLIC_ERROR_CODES` 与 HTTP 映射、`validateCommandEnvelope`、`mapStorageError`/`mapRepositoryInspectionError`/`mapToPublicError`） | `command-envelope.test.ts`、`command-register.test.ts`、`command-settings.test.ts` |
| 原子命令提交与幂等回执 | `packages/core/src/ports/atomic-commands.ts`（同步 `AtomicCommandStore`/`CommandTransaction`）、`application/command-service.ts`（`submit`，单 `BEGIN IMMEDIATE`）、`application/command-receipts-service.ts`、`adapters/sqlite` 回执端口 | `atomic-commands.test.ts`、`command-receipts.test.ts` |
| 授权查询/快照/事件/SSE 恢复 | `packages/core/src/application/query-service.ts`（`resolveEventResume`/`readEventBatch`）、`ports/queries.ts`（`ConsistentSnapshotStore`）、`ports/events.ts`（`StateEventReadStore`、`findPersistedEventSequence`）、`packages/host/src/runtime/sse-transport.ts`（`SSE_MAX_PENDING_BYTES`/心跳/批次） | `query-service.test.ts`、`state-events-*.test.ts`、`host-sse-transport.test.ts` |
| 只读仓库检查 | `packages/core/src/ports/repository-inspector.ts`（`RepositoryInspector.inspect`、`RepositoryInspection`、`deriveRepoIdentity`、`repoIdentity=gitdir-sha256:`、有限超时/输出、`RepositoryInspectionError` 种类） | `repository-inspector.test.ts` |
| 项目服务与制品存储 | `packages/core/src/application/project-service.ts`（`registerRepository`/`getProject`/`getRepositoryBinding`/`updateProjectMetadata`/`listProjects`/`countProjectLabels`）、`ports/artifact-store.ts`（`registerArtifact`/`getArtifact`/`transitionArtifact`/`listArtifacts`、`ArtifactStatus`、`ARTIFACT_LIST_DEFAULT_LIMIT=64`/`MAX=256`） | `project-registration.test.ts`、`artifact-store.test.ts` |
| Core 装配 | `packages/core/src/adapters/composition.ts`（`openCoreApplication`：`repositoryInspector`/`projectService`/`configurationService`/`commandService`/`commandReceiptsService`/`queryService`/`artifactStore`/`artifactFileStore`/`stateStore`/`pathService`/`close`） | `core-assembly.test.ts` |
| Host 装配/传输/HostClient | `packages/host/src/runtime/host-startup.ts`（`createLocalOwnerPrincipal`、`createEventStreamHub`）、`runtime/app-transport.ts`、`runtime/http-transport.ts`、`client/app-client.ts`（`HostClientApplication`：命令/回执/结果/项目/配置/快照/事件订阅）、`contract/lifecycle.ts`（`ApplicationCapabilityView`/`EventsCapabilityView`/`CURRENT_HOST_CAPABILITIES`） | `host-app-routes.test.ts`、`host-startup.test.ts`、`app-client.test.ts` |
| CLI 面层与执行层 | `packages/cli/src/app/args.ts`（`APP_CLI_COMMANDS=['project','config','receipt','events']`、`APP_CLI_COMMAND_IDS` 12 项）、`app/output.ts`、`app-execute.ts`（`executeEventsCommand`）、`bin.ts` | `app-cli-args.test.ts`、`app-cli-*.test.ts` |
| P02-2 整 Feature 集成回归 | 真实 SQLite/HTTP/SSE/CLI 端到端回归 + 脱敏证据 | `p02-2-integration-regression.test.ts`、`docs/acceptance/evidence-p02-2/f018-regression-evidence.md` |

当前（开工时）线上行为事实：线消息 `schemaVersion=2`；SQLite 迁移止于 **v3**（`command_receipts`）；
握手 `capabilities.application` 为 P02-2 §11.3 的 commands/queries/events 结构化视图；CLI 顶层命令为
`host`（P02-1）+ `project`/`config`/`receipt`/`events`（P02-2）。这些是 P02-3 的改造起点，后续任务
改变它们时必须同步更新本文与 §18 的文档守护测试（与 P02-1/P02-2 的增量做法一致）。

### 1.3 环境、脚本与基线实测

| 项 | 值 | 来源 |
|---|---|---|
| Node / npm | `22.19.0` / `10.9.3`（engine-strict，实测 `node -v`/`npm -v` 一致） | 根 `package.json`、`.nvmrc`、`.node-version` |
| TypeScript / Vitest | `7.0.2` / `5.0.3`（精确锁定，run-tests 启动器校验身份与版本） | 根 `package.json` |
| SQLite 栈 | `better-sqlite3@13.0.3` + `drizzle-orm@0.45.3`（仅 `shiploop-core` 声明） | `packages/core/package.json` |
| 模块体系 | ESM（NodeNext，strict，`verbatimModuleSyntax`）；工作区单向依赖 `host → core`、`cli → host` | 各 `tsconfig.json`、`scripts/check-boundaries.ts` |
| 工程脚本 | `npm test`（`node scripts/run-tests.ts`）、`npm run typecheck`、`npm run check:boundaries`、`npm run build`、`npm run verify`、`npm run accept:p01`；**无** `accept:p02` | 根 `package.json` |

开工基线实测（本 worktree）：

- `npm run verify`：**退出 0，PASS 3/3**（test / typecheck / build，fail-closed）；81 test files /
  **2174 tests passed**，无 skip；`npm run build` 的 dist 冒烟含 Host/CLI 真实纵向闭环。完整日志：
  Feature 工作区 `tool-logs/f001-baseline-verify.log`（Harness 路径，非仓库产物，不进入提交）。
- 迁移版本实测 `[1, 2, 3]`；`file_manifest_count` 161；环境：macOS 26.6.2（arm64，Darwin 25.6.0）。

**结论：P01 放行基线、P02-1 生命周期与 P02-2 命令/查询/事件交付（含受测产品代码与测试）均完整
包含于当前分支，环境与脚本无阻塞项；F-001 不补建任何前序 Feature，不代替人工签字。**

### 1.4 P02-3 复用而不重建的既有规则

全部沿用 P01/P02-1/P02-2 已锁定规则，不另立第二套（实现任务必须复用，不得复制分叉）：

1. 稳定 ID（UUID v4，应用侧生成）、UTC 时间（应用侧毫秒，注入时钟）、`revision` CAS（初值 1）。
2. 命令信封三态 `scope`（registration/global/project）、`requestDigest` 由服务端按
   `stableCanonicalJson` 重算、`(principalId, commandId)` 幂等键、`resultRef`（`v1.<43 base64url>`）、
   单 `BEGIN IMMEDIATE` 原子提交（业务行 + 事件 + 回执同事务）。
3. 可信主体 `TrustedPrincipal`（`principalId` + `capabilities` + `projectScope`）只由 Host 可信
   装配注入；授权检查在 **Core 应用层**；请求中的 `projectId`/`scope`/`actorId` 只是目标选择，
   不扩大权限。
4. 只读仓库检查 `RepositoryInspector`（独立 argv、有限超时、不执行脚本/安装/commit、
   `repoIdentity=gitdir-sha256:` 派生按 P01-3 契约 §4.2）。
5. 制品存储 `ArtifactStore`（`pending`/`ready`/`failed`、`ARTIFACT_LIST_DEFAULT_LIMIT=64`/`MAX=256`、
   内容哈希核对、`ArtifactCorruptionKind`）。
6. 配置 payload `SETTINGS_SCHEMA_VERSION=2`（`validateSettingsPayload`、能力目录复检、
   `stale_dependency`、`SETTINGS_EXPORT_FORMAT_VERSION=1` 脱敏导出）——**注意：现有配置 Schema
   不含检查命令定义**（§15.2）。
7. 一致快照/持久事件/SSE 游标与背压、`snapshot_required`/`stream_overflow` 语义（P02-2 §8/§9）。
8. Host 传输纪律（P02-1 §7.2）：Bearer-only、Host 头恰为回环字面量、Origin 必须缺席、不发 CORS、
   永不 3xx、`connection: close`、有界超时、错误体脱敏。
9. 写事务纪律：`session.transactWrite`（`BEGIN IMMEDIATE`，同步短事务，拒绝 async 回调），事务内
   禁止文件/Git/网络/模型/凭据解析/长检查；busy 有限预算。
10. 发现/锁/单例/启动器/HostClient 规则全部不变；P02-3 只新增业务路由、命令与客户端方法。
    跨包共享校验只经 `shiploop-core/protocol` 纯协议子路径。

## 2. 范围与非目标

### 2.1 范围内（PRD FR-1、FR-2）

1. **FR-1 静态接入**：只读仓库检查（规范路径/HEAD/脏状态）的授权查询面
   （`projects.inspect`）；`project init` 的先预览后确认注册流程；注册状态与健康状态**分开**
   展示（`projects.overview`）。注册复用 P02-2 既有 `project.register` 命令，不新增注册语义。
2. **FR-2 基线检查**：用户明确授权后才运行的**受监督子进程**基线检查；记录不可变的
   **授权摘要**（argv/cwd/环境引用/timeout/检查政策/代码身份）；取消与超时**确认进程停止后**
   才收尾；每项检查的退出码、输出制品、耗时、代码身份与基线摘要可查询。
3. 基线命令 `preview`/`run`/`cancel` 与查询 `baselines.list`/`baselines.get`、证据读取
   `artifacts.get`；异步基线操作的 `accepted` 回执 + `operationId`（P02-2 §5.3 前向兼容位首次启用）。
4. **三轴状态分离**：操作状态（operation status）、检查业务状态（check status）、原因码
   （reason code）互相独立；检查业务状态遵守 `passed`/`failed`/`error`/`inconclusive`/`not_run`
   语义（§8）。
5. 最小操作 **Skill 两个**：`project init` 与 `project overview`，只经正式 CLI 读取状态或提交
   用户明确确认（§12.4）。
6. Host `/v1` 基线路由装配、HostClient 基线方法、基线 CLI 参数面与 `dist/bin.js` 纵向接线；
   F-018 的真实 Git/SQLite/进程/Host/CLI 端到端回归与 F-019/F-020 的操作说明、交接与交付报告。

### 2.2 明确不提供（unsupported，不得用占位冒充）

- **Profile 与复杂技术栈推断**：`confirmProfile`、能力模块选择、语言/框架检测、项目知识/Wiki、
  `ProjectProfile`/`capability_modules` 表、AGENTS.md 覆盖。P02-3 的静态扫描只读 HEAD/脏状态与
  规范路径，不做技术栈推断。
- **Work/Pi 执行域**：Run/Task/Attempt/Batch/Phase/Feature 的命令与查询、调度、认领、Pi SDK/模型
  调用、Runtime/Chat Session、通知投递/delivery 表。
- **模型请求**：无任何模型/provider/凭据解析调用；普通测试不调用真实模型。
- **rebind / 隔离副本 / worktree 建设**：移动仓库 rebind、多 clone 归档、从已确认 commit 创建隔离
  副本/worktree。P02-3 基线只针对**当前工作区**（§15.3），不创建隔离副本。
- **强 OS 沙箱**：首版仍是用户明确授权的可信本机项目模式，本契约不提供也不宣称强 OS 沙箱；
  要求强隔离的任务属后续独立里程碑。
- **任意文件读取**：除 §3.2 新增的**受控证据读取** `GET /v1/artifacts/:artifactId/content`
  （有界、授权、脱敏、仅限本 Feature 发布的检查输出制品）外，不新增按路径/locator 读取仓库或
  数据根文件的任何路由；该证据路由不得扩展为通用文件读取（§15.7）。
- Web/Electron 配对、CSRF、远程控制、公网监听、多用户管理/用户建账/配对发 token；不新增
  accept 脚本（`accept:p02` 属阶段末项 P02-4）。
- 不升级/替换 §1.3 的任何锁定版本，不新增第三方依赖（如需必须先修订本文）。

## 3. 版本空间与传输总则

### 3.1 四个互相独立的版本（禁止隐式联动）

| 版本 | 当前值 | P02-3 变化 | 载体 |
|---|---|---|---|
| 发现 `schemaVersion` | `1` | **不变**（P02-1 §5.1） | `discovery.json` |
| 线协议 `protocolVersion` | `1` | **不变**（HTTP 帧与路由前缀兼容） | 握手/业务消息 |
| 线消息 `schemaVersion` | **`2` → `3`（P02-3 起）** | **显式升版**，见下 | 握手、host status/stop、命令信封、回执、查询响应、快照 |
| 配置 payload `schemaVersion` | `2` | **不变**（与线消息版本独立） | `SettingsPayload`（`SETTINGS_SCHEMA_VERSION`） |

另有：事件封套自身的 `schemaVersion`（初值 `1`，**不变**）、导出格式版本
（`SETTINGS_EXPORT_FORMAT_VERSION=1`，不变）、SQLite 迁移版本（P02-3 新增 **v4**，§10）。

线消息 2 → 3 的定案（实施契约值，请求核对见 §15.5）：

- 升版原因：握手 `capabilities.application.commands`/`queries` 增加基线命令与查询（§11.3），
  P02-2 客户端 `validateHandshakeResponse` 对该视图做**精确键与集合相等**核验，同版本号改集合
  违反「未知字段/集合一律拒绝」纪律，故显式升版而非静默变形（与 P02-1→P02-2 升 v2 同一理由）。
- Host P02-3 只接受线消息 `schemaVersion=3` 的握手/命令/回执请求；`2` 或 `1` →
  `400 unsupported_schema_version`（不猜测降级）。响应体一律 `schemaVersion:3`。发现文件与
  `protocolVersion` 不变，发现/锁/凭据流程不受影响。
- Host 与 CLI 同仓库同版本发布；旧 P02-2 CLI 连接新 Host 会在握手得到明确
  `unsupported_schema_version`（退出码 3），不会得到畸形响应或错误业务结果。
  **实施状态（F-006）**：首个能力集合变更（握手 queries 新增 `projects.inspect`/
  `projects.overview`）随 F-006 落地，线消息 2 → 3 的切换、HostClient 与伪服务夹具的
  版本断言更新由 F-006 完成（F-014 接线基线路由时在同一 v3 内扩张集合）；P02-1/P02-2
  生命周期与业务回归在 v3 上继续成立。

### 3.2 路由总表（全部需要 Bearer 认证；前缀 `/v1`）

> 实施状态：F-001 冻结时本表全部为**目标契约**；**F-006 已接线** `projects.inspect`/
> `projects.overview`（含握手能力宣告与 HostClient 方法）；基线路由（`baseline.*`/
> `baselines.*`/`artifacts.get`）仍由 F-014 接线，接线前不宣告对应能力。P02-2 既有路由见
> [p02-2-commands-events-contract.md](p02-2-commands-events-contract.md) §3.2，本文不重复其语义。

| 方法与路由 | operation | 说明 |
|---|---|---|
| `GET /v1/projects/inspect?path=<abs>` | `projects.inspect` | 注册前只读仓库检查（规范路径/HEAD/脏状态），§7.2 |
| `GET /v1/projects/:projectId/overview` | `projects.overview` | 注册状态与健康状态**分开**的概览，§7.3 |
| `POST /v1/commands`（`baseline.preview`） | `baseline.preview` | 只读解析检查计划并绑定代码身份，返回 `previewDigest`（§5/§6） |
| `POST /v1/commands`（`baseline.run`） | `baseline.run` | 授权/拒绝 → `accepted` 回执 + `operationId`，或 `not_run`（§6） |
| `POST /v1/commands`（`baseline.cancel`） | `baseline.cancel` | 取消在途基线操作并确认进程停止（§6） |
| `GET /v1/projects/:projectId/baselines?limit&cursor` | `baselines.list` | 项目基线操作分页（§7.4） |
| `GET /v1/baselines/:operationId` | `baselines.get` | 单次基线操作 + 逐项检查结果（§7.5） |
| `GET /v1/artifacts/:artifactId/content` | `artifacts.get` | 受控证据读取（有界、授权、脱敏），§7.6 |

纪律（在 P02-2 §3.2 之上增量）：

- 命令一律 POST、查询一律 GET、事件仅 SSE；其余方法 `405 method_not_allowed`（给允许方法）。
- **`projects.inspect` 的 `path` 是唯一例外**：它是**仓库根绝对路径**（与 `project.register`
  payload 的 `repositoryPath` 同一输入类别），经 `RepositoryInspector` 校验（绝对路径、存在、
  是目录、是 Git 仓库），响应只含仓库元数据（规范路径/repoIdentity/HEAD/脏标记/是否已注册），
  **永不**返回文件内容。它不是通用文件读取路由；`/v1/files`、`/v1/artifacts/*/content`（除上表
  受控证据路由外）等 path/locator 形态一律 `404 unknown_operation`。此例外登记为张力 §15.1。
- 未知 `operation`（含设计 08 §2 的 Profile/Work/Phase/Chat 候选名）→ `501 unsupported`
  （`details.supportedOperations` 只列实际实现者），不猜默认实现。
- GET 查询参数串（含 `?`）上限 **8 192 字节**，超限 `400 invalid_input`；`POST /v1/commands`
  请求/响应体上限 **65 536 字节**（`413 request_too_large`）；查询响应体上限 **65 536 字节**；
  `/v1/host/*` 保持 **16 384** 字节。证据内容响应另见 §13（有界流式）。
- Host/Origin 校验、无 CORS、无 3xx、`cache-control: no-store`、`connection: close`、
  content-type 规则、错误体脱敏（不回显 token/原文/路径/堆栈）全部沿用 P02-1 §7.2。
- 业务状态与 P02-1 的 quiesce 交互：`quiescing`/`stopping`/`starting` 下 `POST /v1/commands`
  返回 `503 not_ready`；只读查询不受影响（P02-2 §3.2）。

## 4. 可信 principal 与授权映射

### 4.1 principal 从哪里来（唯一可信来源）

- P02-3 **不新建用户系统、配对系统或 token 管理面**。认证仍只有 P02-1 的本机 Bearer 单令牌。
- **生产装配**：Bearer 认证通过后，Host 把请求绑定到固定本机主体
  `principalId = "local-owner"`，能力为全部已实现能力、项目可见范围为「全部」。
- **受限主体仅用于测试**：经**可信测试装配**注入 `principalId = "test-restricted:<uuid-v4>"` 与
  显式项目允许列表/能力收窄；产品代码不存在任何经网络/argv/env/请求体创建或提权主体的入口。
- 请求信封/查询参数中的 `actorId`、`principal`、`principalId`、`capabilities`、`scope` 提权尝试：
  作为**未知字段拒绝**（`invalid_input`，定位到字段），永不覆盖绑定身份。principal 不出现在命令
  摘要输入与持久业务 payload 中；它只存在于授权记录与回执表。

### 4.2 principal 结构与能力清单（在 P02-2 九项上扩展）

```ts
type AppCapability =
  | 'project.register'
  | 'project.read'
  | 'project.metadata.write'
  | 'settings.global.read'
  | 'settings.global.write'
  | 'settings.project.read'
  | 'settings.project.write'
  | 'receipts.read'
  | 'events.read'
  | 'baseline.read'   // P02-3 新增：读取项目概览/基线操作/检查结果
  | 'baseline.run';   // P02-3 新增：预览、授权、运行、取消基线检查
```

`local-owner` 持有全部 11 项且 `projectScope.kind='all'`。受限主体的具体能力组合由测试显式构造
（如「只能读项目 A 的基线、不能运行」「有 `baseline.read` 无 `baseline.run`」），无产品级默认模板。

- **`projects.inspect`（注册前）不引入新能力位**：它要求 `project.register` 能力（注册候选仓库的
  能力天然蕴含对其只读检查的能力），不要求项目可见范围（尚无 projectId）。依据与核对请求见 §15.1。
- `projects.overview`、`baselines.list`、`baselines.get`、`artifacts.get` 要求 `baseline.read`
  + 目标项目可见（`artifacts.get` 还要求该制品属于可见项目的本次基线操作）。
- `baseline.preview`/`run`/`cancel` 要求 `baseline.run` + 目标项目可见。

### 4.3 操作授权矩阵

| operation | 能力要求 | 范围/可见性规则 |
|---|---|---|
| `projects.inspect` | `project.register` | 无项目范围约束（注册前）；若 canonicalPath 已绑定到**不可见**项目 → `forbidden`（不泄漏存在性）；绑定到可见项目 → 正常返回 `alreadyRegistered` |
| `projects.overview` | `baseline.read` | 目标项目必须在可见范围；不可见/未知一律 `forbidden` |
| `baseline.preview` / `baseline.run` / `baseline.cancel` | `baseline.run` + 目标项目可见 | 不可见/未知项目一律 `forbidden`；`cancel` 还要求操作归属该可见项目 |
| `baselines.list` | `baseline.read` | **先按可见范围收窄再分页**；只列可见项目的操作 |
| `baselines.get` | `baseline.read` | 按 `operationId` 查，核验其项目可见；不可见/未知 → `not_found`（不区分不存在与无权） |
| `artifacts.get` | `baseline.read` | 只读**本项目本次基线操作发布**的检查输出制品；越权/未知/非本 Feature 制品 → `not_found` |

不变量（F-005/F-008 必须逐条有直接应用服务层测试，不经 HTTP 也必须被拒绝）：

1. 授权检查在 **Core 应用层**，Host 只做认证与可信身份传递；直接调用应用命令服务同样拒绝。
2. 请求里的 `projectId` 只是目标选择，不扩大 `projectScope`；payload 内改 projectId/scope/
   actorId 被拒绝，失败时业务行、revision、事件均不变。
3. 历史回执重放与读取**重新核验当前身份与权限**；已有 commandId 不绕过授权。
4. 列表/分页的可见谓词下推到 SQL；不可见项目的操作与制品不出现在任何结果。
5. 任何拒绝响应不回显不可见项目的名称、路径、配置或 repoIdentity。

## 5. 命令信封、摘要与回执（在 P02-2 之上扩展）

### 5.1 命令信封（线消息 schemaVersion=3）

信封**形状不变**，仅线消息版本升 3；`scope` 仍为三态（registration/global/project）。基线命令
一律 `scope.kind='project'` 且 `projectId` 必填；`project.register`（注册）仍为 `registration`。

```ts
interface CommandEnvelope<TPayload> {
  readonly schemaVersion: 3;          // P02-2 为 2；形状不变
  readonly commandId: string;         // UUID v4，客户端生成（CLI 可显式传入）
  readonly operation: AppOperation;   // §6 白名单（P02-2 六个 + P02-3 三个）
  readonly scope: CommandScope;
  readonly expectedRevision?: number; // 仅更新类命令必填；创建/注册必须缺席
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly payload: TPayload;
}
```

- 运行时校验为**纯模块**（F-002）：只暴露类型与纯校验/映射函数，不导入 HTTP/SSE/ORM/Pi SDK，
  import 无数据库、网络、文件、时钟、进程副作用。
- 校验顺序（先失败先返回）：传输层 → 信封严格结构与字段类型（400）→ 凭据（401）→ schema 版本
  （400）→ 操作能力（403/501）→ 过期（§5.4）→ 幂等核对与归属/CAS（§5.5、§4）→ 原子提交。

### 5.2 请求摘要 requestDigest（冻结算法）

```
canonical = stableCanonicalJson({
  schemaVersion: 3,
  operation,
  scope,
  expectedRevision: number|null,
  issuedAt,
  expiresAt: string|null,
  payload,
})
requestDigest = lower_hex(sha256(utf8Bytes(canonical)))
```

- 复用 P01 `stableCanonicalJson`；Host 与 HostClient 共用同一实现。`commandId` 不进摘要。
- 摘要由**服务端重算**：信封不携带 digest（业务命令由服务端归一化后计算）。
- 基线命令 payload（含检查计划 argv/cwd/environmentRef/timeout/required）全部参与摘要；
  检查计划内的命令原文属于**请求内容**，不是认证秘密，但**不得**在错误体/日志/事件 payload 中回显。

### 5.3 回执形态（`accepted` 首次启用）

```ts
type ReceiptStatus = 'accepted' | 'completed' | 'rejected';

interface CommandReceipt {
  readonly schemaVersion: 3;
  readonly commandId: string;
  readonly principalId: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly status: ReceiptStatus;
  readonly operationId?: string;   // accepted：异步基线操作的稳定身份（§6 baseline.run）
  readonly result?: unknown;       // completed：有界业务结果，序列化 ≤ 16 384 字节
  readonly resultRef?: string;     // completed：稳定结果引用（§5.6）
  readonly error?: PublicError;    // rejected：结构化公开错误（§5.7）
  readonly issuedAt: string;
  readonly completedAt: string;
  readonly replayed: boolean;
}
```

- **P02-2 的六个命令仍全部为同步短事务命令，成功回执一律 `completed`，绝不返回 `accepted`**。
  P02-3 **新增**的 `baseline.run` 在授权通过时返回 **`accepted`**（异步受监督执行），并携带
  `operationId`；`baseline.preview`/`baseline.cancel` 与其拒绝路径、`baseline.run` 的拒绝/`not_run`
  路径仍为 `completed` 或 `rejected`。这是 P02-2 §5.3 前向兼容位的**首次启用**（§15.6）。
- **`accepted` 不表示结果永不可知**：`operationId` 指向持久 `baseline_operations` 行（§10），
  其终态（含逐项检查结果）始终可经 `GET /v1/baselines/:operationId` 查询；`accepted` 回执本身
  在提交事务内与操作行一起持久化，不存在「持久 accepted 但无操作行」。
- 持久化的 rejected 回执只产生于**通过结构/认证/过期检查后、在原子提交内被业务前置条件拒绝**
  的情形（`preview_stale`、授权/CAS 冲突、目标缺失）。结构非法、未认证、过期、未知操作/版本在
  写事务之前拒绝，**不写回执**。
- 回执 HTTP 状态：completed → `200`；accepted → `202`；业务 rejected → 按 §5.7 映射（409/403）。
- 错误回执与成功回执一样按 `(principal_id, command_id)` 幂等；重放返回同一回执（`replayed:true`）。

### 5.4 命令时效

- `issuedAt` 必填，真实日历时间且与服务端时钟偏差不超过 ±60 000 ms；`expiresAt` 若给出必须晚于
  `issuedAt`，且寿命不超过 **300 000 ms**。`expiresAt` 缺席时按 `issuedAt + 60 000 ms` 判定。
- **过期的新 commandId**：不启动任何业务变更，返回 `400 command_expired`，不写回执。
- **过期信封重放**：仍可经 `POST /v1/commands` 或 `GET /v1/receipts/:commandId` 取回原回执
  （授权重核）；过期不改变既有回执，也不重新执行。
- `baseline.run` 的**异步执行**不受命令 `expiresAt` 约束：过期只影响**命令提交**窗口，不影响
  已 `accepted` 操作的执行与查询（操作自身另有 §13 的执行预算）。

### 5.5 幂等/冲突矩阵（在 P02-2 §5.5 之上扩展）

| 情形（同 principal） | 响应 | 副作用 |
|---|---|---|
| 新 commandId + 摘要自洽 + 授权/CAS 通过（同步命令） | `200 completed`（同事务：业务行 + 事件 + 回执） | 一次 |
| 新 commandId + 摘要自洽 + 授权通过（`baseline.run` authorize） | `202 accepted` + `operationId`（同事务：授权行 + 操作行 + 回执） | 一次 |
| 同 commandId + 同摘要，回执已存在 | 原回执 `replayed:true`（含 accepted 原 `operationId`） | 零；**不重复创建操作/不重复执行** |
| 同 commandId + **不同摘要** | `409 conflict`（`details.reason='idempotency_key_reuse'`） | 零 |
| `baseline.run` authorize + previewDigest 过期（代码身份变化） | `409 conflict`（`details.reason='preview_stale'`） | 零；不建授权/操作行 |
| 过期 + 新 commandId | `400 command_expired` | 零 |
| 未认证/无能力/未知版本/非法结构/未知操作 | 401/403/400/501 | 零 |
| 不同 principal 使用同一 commandId | 互相独立 | 互不影响 |

- 命令重放核对、归属与 CAS 重核、业务写入、事件写入、完成/accepted 回执写入必须在**同一个
  `BEGIN IMMEDIATE` 短事务**内完成。禁止「先提交业务、后补存回执」；业务写入后注入事件/回执
  失败必须整组回滚。
- **`baseline.run` 的执行阶段在写事务之外**：提交事务内只做「重核授权/CAS + 写授权行 + 操作行
  （`accepted`）+ 事件 + accepted 回执」，**不**启动子进程；子进程由 F-012 的编排器在事务提交后
  启动。子进程输出采集、制品发布、逐项结果写回均为**独立后续事务**（§8.4）。
- `baseline.run` 的幂等键仍是 `(principalId, commandId)`：重放返回同一 `operationId` 与当前
  操作进度（`replayed:true`），**不**第二次启动进程。

### 5.6 resultRef 与结果读取

- 沿用 P02-2 §5.6：completed 回执内嵌有界 `result`（≤ 16 384 字节）+ 不透明 `resultRef`
  （`v1.` + 43 base64url）。`baseline.run` 的 `accepted` 回执**不带** `resultRef`（结果尚未产生），
  以 `operationId` 作为后续查询入口；操作终态的结果可另经 `baselines.get` 读取。
- `GET /v1/receipts/:commandId`、`GET /v1/results/:resultRef` 语义不变（按本 principal 授权）。

### 5.7 公开错误码（在 P02-2 §5.7 表上扩展，映射唯一）

新增/复用的服务端码（旧码语义全部不变）：

| code | HTTP | 触发 |
|---|---|---|
| `forbidden` | 403 | 能力/可见范围拒绝（含不可见项目统一表现） |
| `not_found` | 404 | 授权范围内操作/制品/回执不存在 |
| `conflict` | 409 | CAS、`preview_stale`、`idempotency_key_reuse`、唯一冲突 |
| `resource_busy` | 409 | `baseline_in_progress`（单并发占用）、`storage_busy`、`quiesce_not_confirmed` |
| `invalid_input` | 400 | 检查计划非法（argv 非数组/含 shell 元字符/超时越界/cwd 越界/未知键）、`path` 非法 |
| `not_ready` | 503 | Host quiescing/stopping/starting |
| `corrupt_state` | 500 | 持久 JSON 未知版本/损坏；明确不同于「未配置/未运行」 |
| `internal` | 500 | 其他未预期异常（脱敏固定文案，无堆栈/路径/载荷原文） |

`RepositoryInspectionError`、`StorageError`、进程启动错误到公开码的映射沿用 P02-2 §5.7 表；
新增受控 reason：`missing_command`、`unknown_script`、`spawn_failed`、`permission_denied`、
`invalid_check_plan`、`path_outside_repository`。认证头、秘密、payload 原文、堆栈、绝对路径、
stderr 原文永不进入错误体。

## 6. 支持的命令与 payload（冻结白名单）

公共结果记录统一 camelCase，时间字段为 ISO UTC 字符串。P02-2 六个命令的 payload/结果**不变**，
此处只列 P02-3 新增的三个命令。

| operation | scope | expectedRevision | payload 白名单 | 回执 |
|---|---|---|---|---|
| `baseline.preview` | project | 缺席（只读） | `{plan}`（§6.1） | `completed`：`{previewDigest, codeIdentity, checks, warnings}` |
| `baseline.run` | project | 必填 | `{decision:'authorize'\|'decline', plan, previewDigest}` | authorize → `accepted` `{operationId}`；decline → `completed` `{operationId, status:'not_run', reasonCode:'authorization_rejected'}`；stale → `rejected preview_stale` |
| `baseline.cancel` | project | 缺席 | `{operationId}` | `completed`：`{operationId, status, reasonCode?}`（进程已确认停止） |

### 6.1 检查计划 payload（独立授权输入，§15.2）

```ts
interface BaselineCheckPlan {
  readonly checks: readonly BaselineCheck[];   // 1..N，项目内 checkKey 唯一
}
interface BaselineCheck {
  readonly checkKey: string;        // 稳定标识（^[a-z0-9][a-z0-9_-]{0,63}$），项目内唯一
  readonly kind: 'command';         // P02-3 仅 command；schema/human 留后续
  readonly argv: readonly string[]; // 非空字符串数组，禁止 shell 拼接（无 shell 元字符解释）
  readonly cwdRef?: string;         // 相对仓库根的子目录（省略=仓库根）；必须落在仓库内
  readonly environmentRef?: string; // 环境允许列表引用（省略=最小默认环境）；不携带秘密值
  readonly timeoutMs: number;       // 1..3 600 000（§13）
  readonly required: boolean;       // 是否必需（影响健康判定）
}
```

规则：

- **检查命令来自独立授权输入**（`--input <file>` 的 JSON），**不来自**现有 `SettingsPayload`
  （`SETTINGS_SCHEMA_VERSION=2` 不含检查命令定义）。这是本 Feature 的关键张力（§15.2）。
- `argv` 必须是数组，**不使用 shell**；拒绝含 shell 拼接意图的输入（如单个含 `&&`/`|`/`;` 的
  字符串视为普通参数，不解释为控制符，但契约要求 CLI/校验层提示用户改用数组）。
- `cwdRef` 必须是仓库内相对子目录；`..` 越界、绝对路径、符号链接逃逸 → `invalid_input`
  （reason `path_outside_repository`）。
- `environmentRef` 是**允许列表引用**，不含值；进程环境为最小集合（PATH + 声明的允许列表），
  **不继承**整个 Host 环境（设计 06 §3）。
- `timeoutMs` 越界 → `invalid_input`（reason `invalid_check_plan`）。
- 计划整体规范化后计算 `planDigest`（§6.2 的授权摘要一部分）。

### 6.2 授权摘要（immutable authorization，FR-2「记录授权内容」）

`baseline.run`（authorize）在提交事务内写入**不可变** `baseline_authorizations` 行，绑定：

- `projectId` + `repositoryBindingId`（目标项目与绑定）；
- **代码身份** `codeIdentity = { headCommit: string|null, workingTreeDigest: string, hasUncommittedChanges: boolean }`；
- `policyRevision`（= 规范化检查计划的 `planDigest`，§13）；
- 规范化检查计划 `plan`（argv/cwdRef/environmentRef/timeoutMs/required）；
- `authorizedBy`（principalId）+ `authorizedAt`（ISO UTC）。

该行**只增不改**（insert-only，无 update 路径）；后续 `baseline.run` 重跑必须携带与当前代码身份
一致的 `previewDigest`，否则 `preview_stale`。

### 6.3 代码摘要范围（代码身份，§15.3）

- `codeIdentity.headCommit` = 当前 HEAD 完整 hash；**无初始 commit 时为 `null`**（不猜 main）。
- `codeIdentity.workingTreeDigest` = 对**当前工作区**受管内容的确定性摘要：覆盖仓库根下**已跟踪
  与未跟踪**的源文件与必要配置，**排除**已声明构建输出与工具目录（至少 `.git`、`node_modules`、
  `dist`、`build`、`.cache`）；算法与排除表由 F-002 纯函数冻结并测试。
- `codeIdentity.hasUncommittedChanges` = `RepositoryInspector` 的脏标记。
- **基线针对当前工作区**（不创建隔离副本，§15.3）：`hasUncommittedChanges=true` 时仍可运行，
  但授权摘要必须记录该事实（`uncommitted:true`），CLI 与 `overview` 明确展示。
- 执行**前**记录代码身份，执行**后**复核；若源码在运行期间变化 → 该操作终态 reason
  `source_changed`，受影响检查 `inconclusive`（§8.3）。

### 6.4 环境引用（environmentRef）

- 最小默认环境：`PATH`（继承） + 声明的允许列表变量名；不含 Host 的其余环境、不含凭据值。
- `environmentRef` 为不透明引用字符串（与 P02-2 的 `credentialRef`/`endpointRef` 同类别，原样
  参与摘要）；P02-3 只支持最小默认环境与显式允许列表，**不**解析凭据、**不**注入秘密。

## 7. 查询与分页

### 7.1 通用规则

- 所有查询经 §4 授权；可见范围谓词在 SQL 前下推，之后才分页/计数。
- 查询参数白名单（未知参数 → `400 invalid_input`）；`limit` 为 1..100 整数，`cursor` 为服务端
  签发的不透明键集游标（本期沿用「上一页最后 `operationId`」形态，非法稳定 ID 拒绝）。
- 查询只读：不写 `state_events`、不创建任何行、不解析凭据、不执行脚本、**不接受文件路径参数**
  （`projects.inspect` 的 `path` 是仓库根、经仓库检查校验，是唯一例外，§3.2/§15.1）。

### 7.2 `projects.inspect`（注册前只读检查）

- 入参：`path`（仓库根绝对路径）。经 `RepositoryInspector.inspect` 校验。
- 响应：`{schemaVersion:3, canonicalPath, repoIdentity, headCommit:string|null,
  hasInitialCommit:boolean, hasUncommittedChanges:boolean,
  alreadyRegistered:{projectId}|null, readAt}`。
- 已绑定到**不可见**项目 → `forbidden`；已绑定到可见项目 → `alreadyRegistered.projectId`（不报错）。
- **永不**返回文件内容、不执行脚本/安装/commit、不写任何行。

### 7.3 `projects.overview`（注册状态与健康状态分开）

- 响应：`{schemaVersion:3, project:{projectId, displayName, ...}, binding:{...}|null,
  registration:{status:'registered'|'not_registered'}, health:{status, lastBaselineOperationId|null,
  lastCompletedAt|null, reasonCode?}, readAt}`。
- `registration.status` 与 `health.status` **严格分开**：注册成功不代表基线健康（P02-2 §2.2 同原则）。
- `health.status` 由最近一次**终态**基线操作派生（§8.2）；无基线操作时 `health.status='not_run'`
  （`reasonCode='no_baseline'`），**不是** `passed`。
- 未知/不可见项目 → `forbidden`。

### 7.4 `baselines.list`

- 响应：`{schemaVersion:3, projectId, records: BaselineOperationSummary[], nextCursor:string|null, limit}`。
- `BaselineOperationSummary` = `{operationId, kind, status, reasonCode?, createdAt, startedAt|null,
  endedAt|null, summary:{total, passed, failed, error, inconclusive, notRun}}`。
- 按 `operationId` 升序（稳定键集，沿用 P02-2 项目列表的 id 升序纪律）；默认 limit 20、上限 100。

### 7.5 `baselines.get`

- 响应：`{schemaVersion:3, operation: BaselineOperationSummary, authorization: AuthorizationSummary|null,
  checks: CheckResult[]}`。
- `CheckResult` = `{checkKey, argv, cwdRef, environmentRef, timeoutMs, required, status, reasonCode?,
  exitCode:number|null, signal:string|null, timedOut:boolean, output:{artifactId, byteSize,
  truncated:boolean}|null, tail:string|null, startedAt|null, endedAt|null, durationMs|null}`。
- 未知/不可见/非本项目 → `not_found`。

### 7.6 `artifacts.get`（受控证据读取）

- 入参：`artifactId`（路径参数）。只允许读取**本项目本次基线操作发布**的检查输出制品。
- 响应：有界流式内容（`text/plain; charset=utf-8`），响应体上限见 §13；**脱敏**（已发布的制品
  在发布时已脱敏，读取不二次解析）。
- 越权/未知/非本 Feature 制品 → `not_found`；**不得**扩展为通用文件读取（§15.7）。

## 8. 三轴状态模型（operation / check / reason）

### 8.1 三轴分离（冻结）

| 轴 | 取值 | 说明 |
|---|---|---|
| **操作状态** operation status | `accepted` \| `running` \| `cancelling` \| `completed` \| `cancelled` \| `failed` \| `interrupted` \| `not_run` | 基线操作（`baseline_operations`）的生命周期；`accepted`/`running`/`cancelling` 为**非终态**，其余为终态 |
| **检查业务状态** check status | `passed` \| `failed` \| `error` \| `inconclusive` \| `not_run` | 单项检查（`baseline_check_results`）的业务判定（设计 07 §1 语义） |
| **原因码** reason code | 见 §8.3 | 受控枚举，解释**为何**得到该状态；与状态正交 |

**操作状态与检查状态不混用**：`completed` 表示「操作执行完成」，其**逐项检查**可能是 `passed`
或 `failed`/`error`/`inconclusive`；`not_run` 操作表示「未执行任何检查」（授权被拒/空计划）。
`failed` 操作表示「执行域失败」（无法确认进程停止/内部错误），不表示「检查失败」。

### 8.2 健康判定（派生，非独立状态）

- `health.status = 'healthy'` 当且仅当：最近一次终态操作 `completed`，且**所有 `required` 检查**
  均为 `passed`，且无 `source_changed`/`evidence_incomplete`/`output_overflow` 原因。
- 任一 `required` 检查非 `passed` → `health.status='unhealthy'`（附 reason）。
- 无终态操作 / 操作 `not_run` → `health.status='not_run'`。
- `error`/`inconclusive` 的必需检查 → `health.status='unhealthy'` 且 reason 指向具体原因，
  **不得**折算为 `healthy` 或 `passed`（PRD §3.3 第 4 项：`not_run` 不可折算通过）。

### 8.3 状态映射表（冻结；§15.4 请求核对）

| 情形 | operation status | check status | reason code |
|---|---|---|---|
| 全部必需检查退出 0 且证据完整、代码未变 | `completed` | `passed` | — |
| 非零退出码 | `completed` | `failed` | — （`exitCode` 记录） |
| 缺命令（`argv[0]` 不可解析，spawn ENOENT） | `completed` | `error` | `missing_command` |
| 未知脚本（计划引用的脚本不在项目内） | `completed` | `error` | `unknown_script` |
| 其他 spawn 失败 | `completed` | `error` | `spawn_failed` |
| 权限拒绝（EACCES/EPERM） | `completed` | `error` | `permission_denied` |
| 超时（达 `timeoutMs`） | `completed` | `inconclusive` | `timed_out` |
| 启动后取消（进程已确认停止） | `cancelled` | `inconclusive` | `cancelled` |
| **停止未确认**（无法确认进程树停止） | `failed` | `inconclusive` | `stop_unconfirmed` |
| 运行期间源码变化 | `completed` | `inconclusive` | `source_changed` |
| 证据缺口（制品未就绪/哈希不符） | `completed` | `inconclusive` | `evidence_incomplete` |
| 输出溢出（超有界上限） | `completed` | `inconclusive` | `output_overflow` |
| 授权被拒（`decision:'decline'`） | `not_run` | `not_run` | `authorization_rejected` |
| 启动前取消 | `cancelled` | `not_run` | `cancelled` |
| 空检查集 | `not_run` | （无） | `empty_check_set` |
| Host 重启后发现未收尾 | `interrupted` | `inconclusive` | `restart_recovery` |
| 单并发占用冲突（另一操作在途） | （`baseline.run` 提交前拒绝） | — | `baseline_in_progress`（`resource_busy`） |

- **`failed`/`error`/`inconclusive`/`not_run` 永不伪装 `passed`**（设计 11 §7）。
- 失败检查**不撤销项目注册**（PRD FR-2 边界）：注册状态与健康状态独立（§8.2）。

### 8.4 结果写回与收尾

- 每项检查的终态、退出码、信号、超时标记、输出制品引用、耗时、原因码在**独立事务**内写回
  `baseline_check_results`；操作终态在**全部检查收尾且进程确认停止后**写回 `baseline_operations`。
- 写回与收尾失败 → 操作保持非终态并记受控 reason，**不**伪装完成；占用保留（§9）。
- 收尾后发布 `baseline.*` 事件（§9）。

## 9. 公开事件与迁移

### 9.1 事件封套与游标

- 沿用 P02-2 §9 的封套（`schemaVersion=1` 不变）、游标（`evcur_v1_`）、SSE 与背压语义，不改动。

### 9.2 P02-3 事件类型白名单（新增）

| type | aggregate_type | project_id | payload 形状 | 何时写 |
|---|---|---|---|---|
| `baseline.authorized` | `project` | 项目 ID | `{operationId, planDigest, checkCount}` | `baseline.run`（authorize）提交事务内 |
| `baseline.started` | `project` | 项目 ID | `{operationId}` | 子进程启动后（F-012） |
| `baseline.check_completed` | `project` | 项目 ID | `{operationId, checkKey, status, reasonCode?}` | 每项检查终态写回时 |
| `baseline.completed` | `project` | 项目 ID | `{operationId, status, reasonCode?, summary}` | 操作终态收尾时 |
| `baseline.cancelled` | `project` | 项目 ID | `{operationId, reasonCode?}` | 取消收尾时 |

- 新增类型遵循 v2 迁移既有 CHECK：`project_id` 非空、`aggregate_type='project'`。
- 白名单外的 event_type 不得出现在 P02-3 流中；映射层遇未知持久类型**显式失败**（沿用 P02-2
  §9.2 F-003 定案：`corrupt_state`/`unknown_event_type`），不静默跳过、不伪造事件。
- 事件 payload 只含受控脱敏键；**不含** argv 原文、stderr 原文、路径或秘密（§13）。

### 9.3 迁移 v4 与事件白名单扩展

- v2 `state_events` 的 event_type CHECK 白名单**随 v4 扩展**（新增上表类型）；既有行不变。
  从**空库**与**P02-2 最新库（v3）**两条路径迁移成功；既有 projects/bindings/settings/events/
  command_receipts 与 sequence 不变。

## 10. SQLite 迁移 v4：基线与操作

- 由 F-007 新增为迁移 **v4**（接 v3 `command_receipts` 之后）；DDL 与 `schema.ts` Drizzle 定义
  同步，checksum 进 `schema_migrations`，漂移/高版本继续拒写（沿用 migrator 既有规则）。
- 必须从**空库**与 **P02-2 最新库（v3）**两条路径迁移成功；迁移与 Drizzle Schema 一致性进真实
  pragma 交叉核对测试。
- 表设计冻结（落库列名 snake_case，应用层 camelCase 映射）。命名与设计 11 §2/§7 的
  `onboarding_operations`/`project_baselines`/`check_*` 通用验证表的**关系与偏离**见 §15.8：

```sql
-- 不可变授权（insert-only，无 update 路径）
CREATE TABLE baseline_authorizations (
  id TEXT PRIMARY KEY NOT NULL,              -- UUID，应用侧生成
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL,
  head_commit TEXT,                          -- 无初始 commit 时为 NULL
  working_tree_digest TEXT NOT NULL,         -- 64 小写 hex
  has_uncommitted_changes INTEGER NOT NULL,  -- 0/1
  policy_revision TEXT NOT NULL,             -- = plan_digest
  plan_digest TEXT NOT NULL,                 -- 64 小写 hex
  plan_json TEXT NOT NULL,                   -- 规范化检查计划 JSON
  authorized_by TEXT NOT NULL,               -- principalId
  authorized_at INTEGER NOT NULL,
  CONSTRAINT baseline_authorizations_project_fk
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_authorizations_binding_fk
    FOREIGN KEY (repository_binding_id) REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_authorizations_digest_check
    CHECK (length(working_tree_digest) = 64 AND length(plan_digest) = 64)
);

-- 基线操作生命周期（非终态可更新；终态不可覆盖）
CREATE TABLE baseline_operations (
  id TEXT PRIMARY KEY NOT NULL,              -- = operationId（UUID）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,       -- CAS
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- 'baseline'（P02-3）；预留 'init'
  authorization_id TEXT,                     -- decline/空集为 NULL
  status TEXT NOT NULL,                      -- §8.1 操作状态
  reason_code TEXT,                          -- §8.3 受控 reason
  started_at INTEGER,
  ended_at INTEGER,
  CONSTRAINT baseline_operations_project_fk
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_operations_authorization_fk
    FOREIGN KEY (authorization_id) REFERENCES baseline_authorizations (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_operations_status_check CHECK (
    status IN ('accepted','running','cancelling','completed','cancelled','failed','interrupted','not_run')
  )
);
CREATE INDEX baseline_operations_project_index
  ON baseline_operations (project_id, id);

-- 逐项检查结果
CREATE TABLE baseline_check_results (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  check_key TEXT NOT NULL,
  argv_json TEXT NOT NULL,                   -- 命令数组（脱敏展示用；发布制品另存）
  cwd_ref TEXT,
  environment_ref TEXT,
  timeout_ms INTEGER NOT NULL,
  required INTEGER NOT NULL,                 -- 0/1
  status TEXT NOT NULL,                      -- §8.1 检查状态
  reason_code TEXT,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0,      -- 0/1
  output_artifact_id TEXT,                   -- 输出制品（nullable）
  started_at INTEGER,
  ended_at INTEGER,
  CONSTRAINT baseline_check_results_project_fk
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_check_results_operation_fk
    FOREIGN KEY (operation_id) REFERENCES baseline_operations (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_check_results_status_check CHECK (
    status IN ('passed','failed','error','inconclusive','not_run')
  )
);
CREATE UNIQUE INDEX baseline_check_results_operation_check_unique
  ON baseline_check_results (operation_id, check_key);

-- 全局单并发占用（单行；确保同一时刻至多一个在途基线操作）
CREATE TABLE baseline_occupancy (
  id TEXT PRIMARY KEY NOT NULL,              -- 固定字面量行（如 'global'）
  holder_operation_id TEXT,                  -- 当前持有者（nullable=空闲）
  acquired_at INTEGER,
  heartbeat_at INTEGER,
  CONSTRAINT baseline_occupancy_holder_fk
    FOREIGN KEY (holder_operation_id) REFERENCES baseline_operations (id) ON DELETE RESTRICT
);
```

- 不向 projects/repository_bindings/settings/state_events/command_receipts 增加新结构（除 §9.3 的
  event_type 白名单扩展）；输出正文存受控文件（复用 P02-2 `artifacts` 表与 `ArtifactStore`），
  不把大输出写进 SQLite。
- 端口只暴露应用数据形态（F-007 窄端口），不泄漏 better-sqlite3/Drizzle 会话；唯一约束、CHECK、
  跨身份读取拒绝、关闭重开一致、有界 plan_json 均有真实 SQLite 测试。

## 11. Host 装配、握手能力与 HostClient 扩展

### 11.1 装配

- Host 仅经 `shiploop-core/assembly` 的受控 `openCoreApplication` 取得 Core，并新增**可信应用装配
  层**把 §4 的 principal 传入 Core 命令/查询服务；Host 传输层不直接写库、不跨包导入 Core 内部
  SQLite 实现（边界检查继续强制）。
- 生产固定装配 `local-owner`；受限主体只在测试装配出现。
- 基线**受监督进程适配器**（F-009/F-010）为 Host 侧装配端口：以 argv 直接 spawn（**不经 shell**）、
  独立进程组、最小环境、可取消/超时/升级终止；适配器实现属 Host（进程监督是 Host 职责），
  授权与状态机属 Core 应用层。**Core 不直接 spawn 进程**（保持 Core 无进程/网络副作用纪律）。
- 公共 import 仍无启动副作用；dist 构建冒烟必须覆盖新增路由的装配失败不发布 ready。

### 11.2 HostClient（F-006/F-014 扩展）

- 复用 P02-1 发现/认证/双向核验；业务方法只访问 §3.2 正式路由，不打开 SQLite、不直读业务文件；
  对响应做运行时校验（畸形回执/事件、未知版本 → 协议错误）。
- 新增方法：`inspectRepository(path)`、`getProjectOverview(projectId)`、`previewBaseline(projectId,
  plan, commandId?)`、`runBaseline(projectId, decision, plan, previewDigest, expectedRevision,
  commandId?)`、`cancelBaseline(projectId, operationId, commandId?)`、`listBaselines(projectId,
  limit?, cursor?)`、`getBaseline(operationId)`、`readArtifactContent(artifactId)`。
- `runBaseline` 的 `accepted` 回执：超时或响应丢失时先以该 principal 查回执
  （`GET /v1/receipts/:commandId`），在有限预算内仍未知才用**完全相同的信封**重发；连接失败
  不解释为业务拒绝或完成。`accepted` 后**不**自动轮询终态（由 CLI `--wait`/`--follow` 显式驱动）。
- 证据内容读取有界（流式上限 §13），不跟随重定向、不向新地址发 token；`close()`/AbortSignal 只
  释放本地观察资源，**不触发 cancel/stop**。

### 11.3 握手能力视图（schemaVersion=3 形状）

```json
{
  "schemaVersion": 3,
  "protocolVersion": 1,
  "capabilities": {
    "lifecycleRoutes": ["handshake", "status", "stop"],
    "stop": { "modes": ["graceful"], "idempotency": "commandId+requestDigest", "activityScope": "idle-only" },
    "application": {
      "commands": ["project.register", "project.metadata.update", "settings.global.create", "settings.global.update", "settings.project.create", "settings.project.update", "baseline.preview", "baseline.run", "baseline.cancel"],
      "queries": ["projects.list", "projects.get", "projects.binding.get", "projects.labelCounts", "projects.inspect", "projects.overview", "settings.global.get", "settings.global.export", "settings.project.get", "settings.project.effective", "settings.project.export", "receipts.get", "results.resolve", "snapshot.get", "baselines.list", "baselines.get", "artifacts.get"],
      "events": { "transport": "sse", "route": "/v1/events", "scopes": ["project", "global"] }
    }
  }
}
```

只宣告本次真实实现的接口；未列出的能力请求即 `unsupported`。F-006/F-014 完成路由接线前，Host
不得宣告对应能力。客户端校验对视图做精确键与集合相等核验，任何伪称/缺键一律 `response_malformed`。

## 12. CLI 参数面与退出码（F-005/F-015/F-016 冻结）

### 12.1 命令面

```text
shiploop host start|status|stop ...                          （P02-1 既有，线消息随 Host 升 v3）
shiploop project register|list|get|edit|labels ...           （P02-2 既有，语义不变）

shiploop project init <repository-path> [--name <displayName>]
        [--description <text>] [--label <l> ...] [--confirm] [--command-id <uuid>]
shiploop project overview <projectId>

shiploop baseline preview --project <id> --input <file>
shiploop baseline run --project <id> --input <file> (--confirm | --decline)
        [--wait] [--follow] [--command-id <uuid>]
shiploop baseline list --project <id> [--limit <int>] [--cursor <id>]
shiploop baseline status <operationId>
shiploop baseline cancel <operationId> --confirm
shiploop baseline evidence <artifactId>
```

- 所有命令共用 `--data-root <abs>`、`--json` 与 P02-1 相同的有限超时参数；业务命令经
  `ensureHostRunning` 连接或受控启动同一单例（CLI 自身不打开 SQLite）。
- **确认入口**：
  - `project init` **无 `--confirm`** = 只做静态预览（调用 `projects.inspect`，打印规范路径/HEAD/
    脏状态/是否会注册），**不注册**、**不执行脚本**，退出码 0。
  - `project init --confirm` = 静态预览后经既有 `project.register` 命令注册，打印 projectId 与
    注册状态；健康状态显示为 `not_run`（尚无基线）。
  - `baseline run --confirm` = 授权并运行（`decision:'authorize'`）；`--decline` = 记录 `not_run`
    （`decision:'decline'`）；两者**互斥且必居其一**，否则退出码 2。
- `--input <file>` 只是**本次请求的输入**（检查计划 JSON）：文件内容不得指定 Core 数据库路径、
  resultRef/结果读取路径或提权主体；CLI 不监听文件变化。
- 写命令可显式传 `--command-id <uuid v4>`；省略时由 HostClient 生成一次并冻结。重复提交用同一
  信封（先查回执）。
- `baseline run` 默认（无 `--wait`/`--follow`）返回 `operationId` 后退出（退出码 0，`accepted`）；
  `--wait` 等待终态（退出码见 §12.3）；`--follow` 经 SSE 观察 `baseline.*` 事件，断开观察不取消
  操作（Ctrl+C 退出码 4，语义同 P02-2 `events`）。

### 12.2 解析纪律与输出

- 参数解析保持纯函数（env 显式注入），解析失败前**不**发现 Host、不联网、不启动进程；未知参数、
  缺值、非法 projectId/limit/cursor、`--confirm` 与 `--decline` 同时或缺席、非法输入 JSON →
  退出码 2。
- `--json` 时 stdout 只含可解析结构化结果/失败信封（沿用 P02-1 `{ok,command,result|error}` 信封，
  命令名扩展为 `project.init`/`baseline.run` 等）；人类诊断到 stderr；`--follow` 的 JSON 模式输出
  记录流（NDJSON），不混入普通日志。错误保留 commandId 以便查回执。
- `accepted` 与观察中断**不得**显示为 completed；`not_run` 必须显式展示（不折算为 passed）。

### 12.3 退出码（沿用 P02-1/P02-2 五档，值不变）

| 退出码 | 类别 | 基线/接入相关情形 |
|---|---|---|
| 0 | 成功 | `project init` 预览或注册成功；`project overview`/`baseline preview`/`list`/`status`/`evidence` 查询成功；`baseline run` 返回 `accepted`；`baseline run --decline` 记录 `not_run`；`baseline run --wait` 且操作 `completed` 且全部必需检查 `passed` |
| 1 | 业务拒绝/操作失败 | `forbidden`/`conflict`/`not_ready`/`resource_busy`/`unsupported`/`corrupt_state`/`internal`；`baseline run --wait` 的操作非「completed 且全 required passed」（`failed`/`cancelled`/`interrupted`/有必需检查非 passed）；`preview_stale`；`stop_unconfirmed` |
| 2 | 输入错误 | 参数/输入 JSON/非法 ID 与分页/`--confirm`↔`--decline` 冲突或缺席/非法检查计划/本地不安全发现（P02-1 既有） |
| 3 | 连接/协议错误 | `host_not_found`、不可达、超时、重定向、`protocol_incompatible`、`unsupported_schema_version`、`response_malformed`、`start_timeout`（P02-1 既有） |
| 4 | 观察中断（P02-2 新增） | `baseline run --follow`/`--wait` 被 Ctrl+C/Abort/观察超时中断：只表示**本次观察**结束，操作未被取消、Host 未停止；JSON 记录 error.code=`observation_interrupted` 与最后游标/operationId |

- 细分只看 error.code；帮助文本必须说明：观察中断不停止 Host、不取消已提交操作；取消基线必须
  显式 `baseline cancel`。

### 12.4 最小操作 Skill（两个）

- `project init` Skill 与 `project overview` Skill，**只调用正式 CLI**（`shiploop project init`/
  `shiploop project overview`），**不**直接操作 SQLite/`task_list.json`、**不**持有绕过人审的通用
  权限（设计 08 §5）。
- 每份 Skill 写前置条件、输入、命令、结构化结果解释与权限提醒；模型输出**不能**替代用户确认
  （注册需 `--confirm`，基线需 `--confirm`）。
- Skill **不**新增基线取消/运行能力（取消/运行由用户显式 CLI 命令完成）。

## 13. 资源上限与预算总表（有限默认值，非用户可配）

| 项 | 值 |
|---|---|
| `/v1/host/*` 请求/响应体 | 16 384 B（不变） |
| `/v1/commands` 请求/响应体、查询响应体 | 65 536 B |
| GET 查询串 | 8 192 B |
| 回执内嵌 `result` 序列化 | ≤ 16 384 B |
| 基线检查计划 `checks` 数量 | 1..64（`invalid_check_plan` 越界） |
| 单检查 `timeoutMs` | 1..3 600 000 ms（默认 600 000） |
| 单检查输出采集上限（stdout+stderr 合并） | 8 388 608 B（8 MiB；超限 → `output_overflow`，`inconclusive`） |
| 单检查内联 `tail`（`baselines.get`） | ≤ 16 384 B（截断，`truncated:true`） |
| 证据内容响应体（`artifacts.get`） | ≤ 8 388 608 B（有界流式） |
| 单次基线操作总预算 | ≤ 检查数 × 单检查 timeout + 30 000 ms 收尾余量 |
| 取消：SIGTERM→等待→SIGKILL 升级窗口 | 5 000 ms（graceful）；升级后确认停止预算 5 000 ms |
| 单并发占用 | 全局 1（`baseline_occupancy`；第二个在途 → `resource_busy baseline_in_progress`） |
| 基线操作列表分页 | 默认 20，上限 100 |
| 命令 issuedAt 时钟偏差 | ±60 000 ms；默认 TTL 60 000 ms；expiresAt 最大寿命 300 000 ms（不变） |
| 服务端 headers/request timeout | 5 000 / 15 000 ms（不变） |
| 项目列表分页 | 默认 50，上限 200（P01 常量，不变） |

数值为首版有限默认值；实现可凭测试依据调整并回写本文，不得改无界，不得开放为监听/安全放宽配置。

## 14. 需求与测试编号映射

### 14.1 FR 分支

| 需求 | 正常分支 | 关键失败分支 |
|---|---|---|
| FR-1 静态接入 | `projects.inspect` 只读预览 HEAD/脏状态；`project init --confirm` 经命令路径注册；`projects.overview` 注册与健康分开 | 非 Git/不存在路径拒绝、已注册可见复用/不可见 forbidden、脏工作区原样保留不 stash/reset、无 HEAD 明确确认（不猜 main）、取消确认 → not_run |
| FR-2 基线检查 | 授权 → 受监督进程 → 逐项结果 + 输出制品 + 代码身份；取消/超时确认停止后收尾 | 缺命令/未知脚本/权限拒绝（`error`）、超时/取消/停止未确认/源变化/证据缺口/输出溢出（`inconclusive`）、被拒授权（`not_run`）、失败不撤销注册、单并发占用冲突 |

### 14.2 阶段验收索引（PRD §3.3：T10 基础、T15 基础、T17、T23、T26 命令幂等）

| 编号 | 本 Feature 认领子集 | 不覆盖 |
|---|---|---|
| T10 | 项目隔离与凭据脱敏子集：`projects.inspect`/`overview`/基线查询/证据读取的授权矩阵、跨项目越权拒绝、错误/证据/事件不含秘密与路径、不可信 payload 字段拒绝 | 审批、运行时凭据注入 |
| T15 | **init 子集（本 Feature 主要认领）**：init 重复（同规范路径）、无 HEAD/脏工作区、缺命令/未知脚本、被拒授权、失败不撤销注册 | 移动 rebind、多 clone 归档、删除边界（R2） |
| T17 | 沿用 P02-1/P02-2 完整覆盖；基线路由不绕过握手认证与单例 Host | — |
| T23 | 沿用 P02-1/P02-2 完整覆盖；基线路由同样不开放 CORS/公网/地址覆盖 | — |
| T26（命令幂等） | 基线命令沿用 `(principal,commandId)` 唯一、摘要复用/冲突、回执持久化、超时查回执、`accepted` 不重复启动进程 | 设计 09 T26 的「计划修改越过活动执行/过期审批」（无执行域） |
| 设计 09 T26（配置 CAS） | 经命令路径再覆盖（P02-2 已认领）；基线 `expectedRevision`/`preview_stale` 复用同一 CAS 纪律 | 配置历史版本表、跨层策略编排 |

### 14.3 T26 编号不一致记录（沿用 P02-1/P02-2 §14.3 结论，按行为映射）

- PRD §3.3 与 P02-1/P02-2 PRD 同样写「T26命令幂等」；设计 09 §2 的 T26 原文为「当前配置 CAS 冲突、
  计划修改禁止越过活动执行、过期审批失效」。本 Feature 两者都涉及（命令幂等依据设计 08/12，
  配置/基线 CAS 依据设计 09 T26 的 CAS 子集），按**具体行为**建立上表映射；编号冲突为文档问题，
  不据此增减任何行为。P02-1 已就同一不一致请求核对，尚无负责人变更结论；本 Feature 继续携带该
  核对请求（§15.10）。

## 15. 设计差异登记与待核对项

### 15.1 注册前 inspect 的身份与权限范围（张力，请求核对）

- 事实：设计 08 §2 把 `inspectRepository` 列为项目候选命令；P02-2 §2.2/§3.2 明确「不新增按路径/
  locator 读取文件的路由」，且查询不接受文件路径参数。`projects.inspect` 需要在项目存在**之前**
  读取一个仓库根路径，且此时无 projectId 可供 `projectScope` 收窄。
- 契约决定：(a) `projects.inspect` 是**只读 GET 查询**，`path` 是**仓库根绝对路径**（与
  `project.register` 的 `repositoryPath` 同一输入类别），经 `RepositoryInspector` 校验，响应只含
  仓库元数据、**永不**返回文件内容；(b) 授权要求 `project.register` 能力（不新增能力位），
  **不**要求项目可见范围（尚无项目）；(c) 若 canonicalPath 已绑定到**不可见**项目 → `forbidden`
  （与注册一致，不泄漏存在性）；绑定到可见项目 → 返回 `alreadyRegistered`。
- **请求核对**：若要求 inspect 使用独立能力位（如 `project.inspect`）或要求路径参数也走 POST，
  F-004/F-006 实现前需负责人给出依据；确认前按本节冻结行为实施，不静默改领域语义。

### 15.2 现有配置 Schema 不含检查命令时的独立授权输入（张力，请求核对）

- 事实：现有 `SettingsPayload`（`SETTINGS_SCHEMA_VERSION=2`）含 `strategies`/`policies`，**不含**
  检查命令定义（argv/cwd/timeout/required）；设计 06 §1 流程要求「用户确认命令、权限」后
  「授权执行基线」；设计 11 §7 的 `check_definitions` 是**独立**的检查定义表。
- 契约决定：(a) 基线检查命令来自**独立授权输入**（`baseline.preview`/`baseline.run` 的 payload
  `plan`，经 `--input <file>` 提供），**不**从现有配置 Schema 读取，也**不**在本 Feature 扩展
  `SettingsPayload` 去容纳检查命令；(b) 授权内容经 §6.2 的不可变 `baseline_authorizations` 记录；
  (c) `check_definitions`（设计 11）的**通用、可 CAS 更新**形态留给后续「验证/执行」Feature，
  P02-3 用基线作用域的表（§10/§15.8）。
- **请求核对**：若要求把检查命令纳入项目配置 Schema（新增 `SETTINGS_SCHEMA_VERSION=3` 字段），
  或要求复用设计 11 `check_definitions` 的 CAS 形态，F-007/F-008 实现前需负责人给出依据；确认前
  按本节冻结行为实施。

### 15.3 无 HEAD/脏工作区采用明确确认的当前工作区基线（张力，请求核对）

- 事实：设计 06 §1「已有脏工作区不自动 stash/reset。基线可选择当前工作区或已确认 commit 的隔离
  副本，必须记录范围差异……无初始 commit 需提示用户确认如何建立基线，不直接猜 main 分支」；
  P02-3 范围**不含**隔离副本/worktree 建设（§2.2）。
- 契约决定：(a) P02-3 基线**只针对当前工作区**（`workingTreeDigest` 覆盖已跟踪+未跟踪源文件，
  排除构建输出，§6.3）；`hasUncommittedChanges=true` 时仍可运行，但授权摘要记录 `uncommitted`，
  CLI/`overview` 明确展示；(b) 无初始 commit 时 `headCommit=null`，**不**猜 main；`project init`
  在无 HEAD 时提示用户确认「以当前工作区建立基线」，用户未确认则不注册/不运行（`not_run`）。
- **请求核对**：若要求 P02-3 支持「已确认 commit 的隔离副本」基线，属扩大范围（§2.2 排除），
  应作为独立 Feature；确认前按「当前工作区基线」实施。

### 15.4 未知脚本/拒绝/缺命令/超时/取消/停止未确认的状态映射（张力，请求核对）

- 事实：PRD FR-2 边界要求「挂起、缺命令、未知脚本和被拒授权都有独立可查询状态」；设计 07 §1
  给出 `CheckStatus = passed|failed|error|inconclusive|not_run` 语义；设计 11 §7 要求
  「failed/error/inconclusive/not_run 不伪装 passed」。
- 契约决定：§8.3 冻结**三轴映射表**（操作状态 / 检查状态 / 原因码），其中缺命令/未知脚本/权限
  拒绝 → `error`；超时/取消/停止未确认/源变化/证据缺口/输出溢出 → `inconclusive`；被拒授权/
  启动前取消 → `not_run`。停止未确认时**操作**保持 `failed` 且保留占用（不报告 stopped，
  与 P02-1 §10 同原则）。
- **请求核对**：若负责人要求「未知脚本」用 `not_run`（而非 `error`）或「停止未确认」用非终态
  操作状态，F-008/F-009/F-010 实现前需给出依据；确认前按 §8.3 实施。

### 15.5 线消息 schemaVersion 升 v3 与能力集合扩张（实施契约值，请求核对）

见 §3.1：发现/线协议版本不动，握手及全部消息升 schemaVersion=3，`capabilities.application`
的 commands/queries 集合扩张。风险是旧 P02-2 CLI 与新 Host 不兼容；以明确的
`unsupported_schema_version` 失败替代畸形响应，且 Host/CLI 同仓同版发布。若负责人要求保持 v2
外加字段，需在 F-014 前修订本文及 F-006/F-014 兼容策略。

### 15.6 异步操作模型首次引入（accepted 回执 + operationId + 操作表）（张力，请求核对）

- 事实：P02-2 §5.3 明确「`accepted` 仅为前向兼容保留的枚举值，本 Feature 任何代码路径不得产生
  它，也不为不存在的异步操作伪造 operationId（不建 operations 表、不发 operationId）」；设计 08
  §2 的 `CommandReceipt` 含 `operationId?`；设计 12 §4「默认接受任务后返回 Run ID」。
- 契约决定：P02-3 首次启用该前向兼容位——`baseline.run`（authorize）返回 `accepted` + `operationId`，
  指向持久 `baseline_operations` 行（§10）；`accepted` 回执与操作行在同一提交事务内落库，不存在
  「持久 accepted 但无操作行」；结果始终可经 `baselines.get` 查询。
- **请求核对**：若负责人要求基线也走同步命令（阻塞至检查完成再返回 `completed`），将违反
  「写事务内不长检查」纪律（§1.4 第 9 条）；确认前按异步模型实施。

### 15.7 证据内容读取路由（张力，请求核对）

- 事实：P02-2 §2.2/§3.2 明确「制品（Artifacts）读取不在本 Feature」「表外路径（含
  `/v1/artifacts/.../content`）一律 404，永不返回文件内容」；PRD FR-2 输出要求「输出制品」，
  非功能要求「大输出引用制品」。
- 契约决定：P02-3 **窄化解除**该禁令——仅新增 `GET /v1/artifacts/:artifactId/content`，**只**允许
  读取本项目本次基线操作发布的检查输出制品，有界、授权、已脱敏；不得扩展为通用文件读取，
  不得读取任意仓库/数据根文件。
- **请求核对**：若负责人要求证据以「内联有界 tail + 制品哈希引用」替代内容读取（不提供内容
  路由），F-011/F-014 实现前需给出依据；确认前按受控证据路由实施。

### 15.8 基线作用域表与设计 11 通用验证表的关系（张力，请求核对）

- 事实：设计 11 §2 有 `onboarding_operations`（init 步骤/失败/恢复）、`project_baselines`（不可变
  基线证据）；§7 有 `check_definitions`/`verification_batches`/`check_results`（通用验证，主体限
  Attempt/Feature/Baseline）。
- 契约决定：P02-3 采用**基线作用域**表名（`baseline_authorizations`/`baseline_operations`/
  `baseline_check_results`/`baseline_occupancy`，§10），理由：(a) 授权需**不可变**（`check_definitions`
  的 CAS 形态不匹配）；(b) 通用 `verification_batches` 面向 Attempt/Feature 验证（T07/T35/T36），
  属后续 Feature；(c) 迁移 v4 只加基线所需结构，不提前建未用的通用验证表。字段语义与设计 11
  对齐（`working_tree_digest`/`environment_summary`/`exit_code`/`signal`/`timed_out`/`output_refs`/
  `evidence_refs`/`status`）。
- **请求核对**：若负责人要求 P02-3 直接实现设计 11 的通用 `check_definitions`/`verification_batches`/
  `check_results` 并以其承载基线，F-007 实现前需给出依据；确认前按基线作用域表实施。

### 15.9 本契约新增的实施值（设计未给定数值，请求核对）

检查计划 `checks` 数量 1..64、单检查 `timeoutMs` 1..3 600 000（默认 600 000）、单检查输出采集
8 388 608 B、内联 `tail` 16 384 B、证据响应体 8 388 608 B、取消升级窗口 5 000+5 000 ms、
全局单并发 1、基线列表分页默认 20/上限 100、`previewDigest`/`planDigest`/`workingTreeDigest` 形态
（64 小写 hex）、操作状态枚举（§8.1）、原因码枚举（§8.3）。调整须有测试依据并回写本文，不得改
无界或变为可配置放宽项。

### 15.10 携带的既有核对请求

- P02-1 §15.4 的 T26 编号语义（§14.3）。
- P01-3 §9、P02-2 §15.5/§15.6 已登记但未见负责人逐条结论的实施值：P02-3 原样沿用，不重新解释。
- **设计 06 哈希变更**：P02-2 契约 §17 记录的 `06-project-and-context.md` 哈希为
  `ea9ef3e5...`，本次实测为 `617c86a3...`（设计草案在 P02-2 冻结后被编辑）。P02-3 以**本次实测
  哈希**为准（§17），并请求核对设计变更是否影响既有 P02-2 结论；不影响本文冻结的基线语义。

## 16. 对后续任务的契约约束（摘要）

| 任务 | 必须遵守 |
|---|---|
| F-002 | §3 版本、§5.1 信封/§5.3 回执形状（含 accepted+operationId）/§5.7 错误映射、§6 检查计划与授权摘要、§8 三轴状态；纯契约模块无 I/O 副作用；表驱动校验 |
| F-003 | §6.3 代码摘要范围、§10 迁移 v4 表、§8.3 状态映射的确定性测试样例；恶意初始化脚本/挂起进程树/证据故障夹具 |
| F-004 | §4 授权（inspect 用 project.register、overview 用 baseline.read）；真实临时 SQLite/Git；注册与健康分开 |
| F-005 | §12.1/§12.2 CLI 参数面/确认入口/解析纪律；不新增 Profile/Run/模型参数 |
| F-006 | §3.2 静态接入路由与 §11 装配；`projects.inspect`/`overview` 只读；能力只宣告真实接口 |
| F-007 | §10 迁移 v4 与窄端口；不可变授权、操作生命周期、单并发占用；空库/v3 库迁移 |
| F-008 | §6.2 授权摘要、§6.3 代码身份、§6.4 环境引用；§5.5 单 BEGIN IMMEDIATE；授权/拒绝/`not_run` |
| F-009 | §13 受监督进程（argv 无 shell、独立进程组、最小环境、可取消/超时）；确认执行身份后才放行脚本 |
| F-010 | §13 取消/超时/升级终止/停止核验；无法确认停止保留占用与隔离（`stop_unconfirmed`） |
| F-011 | §13 有界脱敏采集、制品发布、证据完整性；输出溢出 → `inconclusive`；不含 argv/stderr 原文入事件 |
| F-012 | §8.4 结果写回与收尾、§5.5 执行阶段在写事务外；授权/单并发/占用/幂等一致 |
| F-013 | 基线活动接入 Host quiesce/stop 与重启恢复；核对旧进程后才允许新检查 |
| F-014 | §3.2 基线路由与 §11 HostClient；能力只宣告真实接口；任意路径读取负例；不跨包导入内部 SQLite |
| F-015 | §12 基线 CLI 参数面/独立授权输入/查询取消/格式化；不新增 Run/模型参数 |
| F-016 | dist CLI 真实临时仓库/数据根纵向接线；`--wait`/`--follow` 与退出码；CLI 不打开 SQLite |
| F-017 | §12.4 两个 Skill 只经正式 CLI；不持有绕过人审权限；模型输出不替代用户确认 |
| F-018 | §14 全覆盖真实 Git/SQLite/进程/Host/CLI 集成回归；verify 全 0；不把 P02-4 的 accept:p02 列为已通过 |
| F-019 | 操作说明只用 dist 实际入口与本文参数；unsupported/`not_run`/观察语义写明 |
| F-020 | 报告引用受测 commit 与本文；FR 证据逐项；`not_run` 不折算 |

任何任务发现本文与实际需求/设计冲突，记录依据并请求核对，不擅自改协议或领域语义。

## 17. 输入文档版本

Feature 输入在 Harness（非本仓库内容、非运行时依赖），以 SHA-256 固化：

| 文档 | 版本/日期 | SHA-256 |
|---|---|---|
| `features/2026-10-04-23-19-52_p02-3/input/p02-onboarding.md`（本 Feature PRD） | v0.2，2026-10-01 | `4faabeb7b7140af8301fe1d2201d2633a3dd20403aa2de0e82e9680da83c3bed` |
| 同目录 `execution-contract.md` | 2026-10-01 | `89dcd2b28202fb9a27ed551be35ac7bc92819f70867ad7698450d9b6e5d8e069` |
| `core-design/06-project-and-context.md` | 2026-09-24 草案（P02-2 后经编辑，见 §15.10） | `617c86a32f629954bcc81721064aaa084a28a25c36a90ccb950457e986cd4e98` |
| `core-design/08-host-api-and-cli.md` | 2026-09-24 草案 | `507e23617a2fd1b1865eab17208512e115dd816c8eb6c8c0f8110e1ef7bd4163` |
| `core-design/07-verification-and-delivery.md` | 2026-09-24 草案 | `7a108c2fbc8cb7315f2431c5b8494a3839cf0358fd17f62551488c09c1a79754` |
| `core-design/11-database-model.md` | 草案 | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |
| `core-design/03-storage-and-transactions.md` | 2026-09-24 草案（含 S2 记录） | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/12-end-to-end-flows.md` | 2026-09-28 | `14acd09fc64ed3933b6f021e398f6b98a7211cfec68442f50f7c35cf9750f4d9` |
| `core-design/09-testing-and-implementation.md` | 2026-10-01 | `d6c91ca39046c3068bdc9aeed8d415382d76d34ebab59ab3df70c873140e9f58` |
| `08-migration-roadmap.md` | 2026-10-01 更新 | P02-1/P02-2 已核对（见 p02-1 契约 §17.2） |

## 18. 复核

- 基线：§1.3（`npm run verify` 退出 0，PASS 3/3；81 files / 2174 tests）。
- 本文引用的冻结事实（基线 hash、版本、路由、能力、错误码、scope/事件白名单、非目标、三轴状态）
  由 `test/docs-p02-3-onboarding-contract.test.ts` 交叉核对；实现任务改变「当前事实」（如 F-007 加
  迁移 v4、F-014 接路由、F-002 加能力位）时必须同步更新该守护与本文，不得让文档另立一套。
- 本文是实施前置契约，不声明任何 P02-3 能力已实现；未运行项与未验收平台在 F-020 报告记 `not_run`。
