# P08 一期能力矩阵与支持范围

状态：P08-4 / F-008 文档交付。本文记录一期（P01～P08）的**代码交付范围**、平台/协议/Schema
支持矩阵、安装产物摘要字段和不支持能力，供 [P08 负责人 walkthrough](acceptance/p08-owner-walkthrough.md)
与[交付报告模板](acceptance/p08-delivery-report-template.md)引用。

本文不是阶段验收结论：文档完整、测试通过、安装包存在或 Nezha 显示 completed 都不能签署
P08 Phase 或合并 main。机器可读的权威支持声明是仓库根的
[`distribution-compatibility.json`](../distribution-compatibility.json)；两者不一致时以该 JSON、
实际代码和检查入口为准，并应先修正文档。

## 1. 验证层次与当前状态

六个层次分别记录，不能相互替代：

| 层次 | 含义 | 当前事实 |
| --- | --- | --- |
| 代码交付 | 代码/文档已本地提交，commit 可解析 | P08-1～P08-3 与 P08-4 F-001～F-008 已交付；具体 SHA 由 Git 与交付报告记录 |
| Task 局部验证 | 单个 Task 的定向测试与退出码 | F-008 只覆盖文档链接、矩阵字段、示例脱敏与报告 schema；其他 Task 以各自索引与日志为准 |
| Feature 门禁 | 编排器对去重 Task 索引的独立复验 | 由独立验证执行，本文不代跑、不代签 |
| Phase 集成 | 干净安装、Host/CLI、SQLite、Git、受控进程、跨层故障与清理 | `not_run`：尚未在本期入口中形成完整跨层证据 |
| Live | Todo 新项目与存量项目的真实模型证据 | `not_run`：需要负责人独立授权、provider/model 与预算 |
| 人工门禁 | 负责人 macOS 操作与一期放行签署 | `pending`：唯一放行依据，机器报告不能代签 |

状态词汇固定为 `pass` / `fail` / `not_run`；`deferred` 只表示不在当前影响范围内的历史项，
不参与通过计数。`not_run` 与人工 `pending` 一律不折算为通过。

## 2. 一期能力矩阵（Core / Host / CLI / Pi Work）

以下“能力”表示已有代码与契约入口；“局部验证证据”不等于跨层集成或真实模型已验证。

| 能力域 | Core | Host / CLI | Pi Work | 证据入口 |
| --- | --- | --- | --- | --- |
| 项目接入与基线 | 项目注册、规范路径/身份、当前配置 CAS、获准基线检查 | `project init/overview`、`baseline preview/run/status/cancel/evidence` | 不涉及模型 | [project init Skill](skills/project-init.md)、[project overview Skill](skills/project-overview.md) |
| 一次性规划 | 草稿计划校验、DAG、摘要、候选审批、Task 策略副本 | 规划导入/修订/查询/批准命令与 Host 查询 | 规划只写候选，不启动编码 | [planning approval Skill](skills/planning-approval.md) |
| 执行预算与启动 | 显式预览、授权/预占、预算修订、结算与回执 | `execution preview/start`、预算与回执查询 | Runner 只消费被授权的请求 | [execution observe Skill](skills/execution-observe.md)、[P03-3 预算契约](p03-3-execution-budget-contract.md) |
| 调度、认领与 Workspace | Task DAG 就绪、认领/fencing、Attempt 生命周期、受管工作区准备/检查/丢弃 | `schedule`、`workspace list/discard-preview/discard` | 每个 Work Attempt 使用受管工作区 | [P03-4 认领契约](p03-4-task-claim-contract.md)、[P03-5 工作区操作](p03-5-cli-workspace-operations.md) |
| 标准 Pi Runtime | Runtime 能力目录、恢复政策、预算/停止核验由 Core 权威 | Host 组合根注入标准 Pi descriptor 与来源 | 标准 `@earendil-works/pi-coding-agent@1.0.4`；默认每 Task 新会话 | [Pi 支持矩阵](p04-4-f007-pi-support-matrix.md) |
| 验证与受控交付 | Task 局部检查、独立 Verifier、修复/返工边界、受控 Git 提交、Feature 交付 | 验证/交付命令与回执查询 | 模型完成或提交成功不等于 Task passed | [P03-7 交付契约](p03-7-f016-feature-delivery.md)、[P03-8 受控提交](p03-8-f003-controlled-git-commit.md) |
| 取消、停止与恢复 | 暂停/取消/停止证据、启动恢复、finalization 幂等 | 控制命令与恢复查询 | 停止未确认时保持隔离，不自动重试 | [stop control Skill](skills/stop-control.md)、[P03-9 恢复契约](p03-9-f005-startup-recovery-contract.md) |
| Feature 并发与集成 | Feature DAG、固定 Batch、共享资源锁、确定性 Git 集成、有界冲突修复 | Batch/集成计划/交付查询 | 冲突修复使用独立授权预算；不是每次合并都调用模型 | [P05-7 确定性集成](p05-7-f004-deterministic-integration.md)、[P05-8 有界修复](p05-8-f002-bounded-repair-run.md) |
| 存量项目接入 | 仓库探测、基线快照、增量范围与证据封套 | 项目生命周期、增量检查命令 | 真实模型增量演示需要独立入口和授权 | [P08-3 存量运行手册](acceptance/p08-3-existing-demo-runbook.md) |
| 备份/恢复与数据生命周期 | SQLite 在线备份、隔离恢复校验、项目归档/删除、保留政策 | `backup`、`restore`、`retention`、`project archive/delete-*` | 不涉及模型 | [backup restore Skill](skills/backup-restore.md)、[P07-3 数据生命周期](p07-3-data-lifecycle-operations.md) |
| 本地结果通知 | 结果事实与原因持久化，失败有界重试 | 本地 `local-results` 渠道与查询 | 通知失败不重跑业务 | [P07-4 通知操作](p07-4-result-notifications-operations.md) |
| 安装与发布候选 | 无运行时依赖 Nezha/Harness | 三包 local pack、制品检查、发布 CI 配置检查 | 不涉及模型 | [P08-1 制品检查](p08-1-artifact-verification.md)、[P08-1 支持矩阵](p08-1-support-matrix.md) |

### 2.1 Pi Work 的恢复与能力边界

标准 Pi 的生产 descriptor 不把 SDK 会话文件等同于 Core 执行恢复。以下能力当前为
`unsupported`，`auto` 降级为新会话、`required` 明确拒绝；未执行的实验保持 `not_run`：

- 原生历史读取（`nativeHistory`）、同 Task 对话续接（`conversationResume`）；
- 检查点式执行恢复（`executionRecovery`）、恢复时换模型（`modelSwitchOnResume`）、原生 fork（`nativeFork`）。

FakeRuntime 只用于确定性测试，不注册 Pi descriptor，也不能补齐 live 或 Phase 集成。
Pi 默认工具不是 OS 沙箱，本机同用户进程仍可能读取外部文件。

## 3. 平台与工具链支持矩阵

| 项目 | 支持值 | 说明 |
| --- | --- | --- |
| 正式平台 | macOS（`darwin`） | 三包 `os` 均限定 `darwin`；非 darwin 明确拒绝 |
| Windows / WSL / Linux | 未支持 | 不在本期验收条件内，不记为通过 |
| Node.js | `22.19.0` | 根与三包 `engines.node` 一致；不升级、不降级 |
| npm | `10.9.3` | `packageManager: npm@10.9.3`；不使用 pnpm/yarn |
| 锁文件 | `package-lock.json`（`lockfileVersion: 3`） | `npm ci` 安装；不通过 npx/全局工具补齐运行依赖 |
| 原生模块 | `better-sqlite3`、Host 写入锁 | 安装需要 Xcode Command Line Tools；真实安装加载属 Phase 集成 |
| 统一版本 | `0.0.0` | `shiploop-core` / `shiploop-host` / `shiploop-cli` 同版本、`private: true` |
| 分发模式 | `local-pack-only` | `published: false`；本阶段不执行 `npm publish` |

## 4. 协议与数据库 Schema 范围

以下值与 `distribution-compatibility.json` 一致，并受文档守护测试校验：

| 字段 | 值 | 语义 |
| --- | --- | --- |
| `hostProtocol.wireProtocolVersions` | `[1]` | 客户端与 Host 只声明线协议版本 1 |
| `hostProtocol.wireSchemaVersion` | `6` | 当前握手 schema 版本 |
| `hostProtocol.legacyHandshakeSchemaVersionsAccepted` | `[5]` | 只接受明确登记的 legacy 握手 schema |
| `hostProtocol.discoverySchemaVersions` | `[1]` | 发现文件 schema 版本 |
| `hostProtocol.unknownVersionPolicy` | `reject` | 未知/更高版本明确拒绝，不猜测降级 |
| `databaseSchema.engine` | `sqlite` | 本地状态库 |
| `databaseSchema.readableAppliedVersions` | `1..64` | 可读取的已应用迁移版本范围 |
| `databaseSchema.writableTargetVersion` | `64` | 当前可写目标版本 |
| `databaseSchema.higherVersionPolicy` | `reject` | 更高版本拒写并保留现场，不自动降级/覆盖 |

## 5. 安装产物摘要字段

安装校验入口为 `npm run pack:local` + `npm run verify:artifacts`，阶段入口的安装检查为
`scripts/acceptance/p08-install-check.ts`。摘要字段必须对应实际字节与生成时的源码提交；
提交或制品变化后必须重新生成，不能沿用旧摘要。

### 5.1 `distribution-manifest.json`（`kind: shiploop.local.distribution`）

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` / `kind` / `distributionMode` | 清单版本、类型与 `local-pack-only` 分发模式 |
| `gitCommit` | 生成制品时的完整源码 commit（40 位小写十六进制） |
| `platform` | 生成平台，本期固定 `darwin` |
| `toolchain.{node,npm,packageManager,lockfileVersion}` | 实际工具链与锁文件版本 |
| `compatibility` | 生成时的 `hostProtocol` / `databaseSchema` 范围副本 |
| `artifacts[].{name,version,filename,size,sha256}` | 三包名称、版本、tarball 文件名、字节数与 tarball 摘要 |
| `artifacts[].packageManifestSha256` | 包内 `package.json` 摘要 |
| `artifacts[].files` / `artifacts[].fileDigests` | 包内文件白名单与逐文件 SHA-256 |

### 5.2 `artifact-verification.json`（`kind: shiploop.artifact-verification`）

| 字段 | 含义 |
| --- | --- |
| `passed` | 仅当全部检查 `passed` 时为 `true`；`not_run` 不折算 |
| `environment` | 检查时的 Node/npm/平台等环境事实 |
| `inputs.distributionManifest` / `inputs.compatibility` / `inputs.artifacts` | 输入逻辑标签与摘要；不含绝对路径 |
| `checks[].{id,title,status,objects,problems}` | 稳定检查 ID、标题、`passed/failed`、检查对象与脱敏问题 |
| `notRun[].{id,reason,owner}` | 未运行项及原因，`owner` 固定为 `phase-integration` |
| `evidence[].{kind,label,sha256}` | `distribution-manifest` / `compatibility` / `tarball` / `checker` 证据摘要 |
| `summary.{passed,failed,notRun}` | 计数，不替代逐项状态 |

阶段安装检查（`shiploop.p08.install-check`）额外记录包名/版本/tarball 与包内文件摘要、bin/exports/main/types
入口、依赖闭包、引擎/平台、协议/Schema 越界、Nezha/Harness 引用、个人绝对路径、疑似凭据与 staging 清理状态。
真实独立目录 `npm install`、better-sqlite3 加载、打包 Host 启动与 CLI 操作仍为
`phase-integration` 的 `not_run` 边界（`P08_INSTALL_CHECK_NOT_RUN`）。

## 6. 明确不支持或后置的能力

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 托管 Chat / 聊天 UI | 后置 | 一期只交付 Work 闭环；ChatSessionService 与桌面 Chat 未实现 |
| Electron / 桌面客户端 | 后置 | 不在本期范围 |
| Web 客户端、NAS/云端部署 | 后置 | 不提供远程托管或同步 |
| 强 OS 沙箱 | 未支持 | 可信本机单用户模式；token 只防未授权本机读取，不防同用户恶意进程 |
| 其他 Runtime（非 Pi） | 未支持 | 未知 runtime 在配置层拒绝；Pi Durable 只是可关闭候选，不是默认装配 |
| Pi 原生历史/对话续接/检查点恢复/换模型恢复/fork | `unsupported` | 见 §2.1；`required` 时明确拒绝 |
| 公开 npm 发布、许可证、npm scope、公开包名、发布身份 | `pending` | 负责人未确认；本阶段只生成本地 pack 候选 |
| 通用自动修复 Runtime | 未装配 | 自动修复配置可校验，但产品默认装配未提供通用修复 Runtime |
| Windows/WSL/Linux 正式认证 | 未验收 | 跨平台另行验收 |

## 7. 与报告和 walkthrough 的关系

- [P08 负责人 walkthrough](acceptance/p08-owner-walkthrough.md) 说明从干净安装目录启动打包 CLI、
  Todo 新项目与存量仓库演示的核对点，以及基线脏文件、已有失败、清理、停止未确认和 Live 缺失的处理。
- [P08 交付报告模板](acceptance/p08-delivery-report-template.md) 规定代码 commit、工具版本、实际命令与
  退出码、范围与预算、证据路径、`pass/fail/not_run/deferred` 计数、人工状态和遗留问题的记录方式。
- [P08 总验收契约](p08-acceptance.md) 与 `acceptance/p08.*.json` 是机器可读的清单/配置/入口；
  入口命令为 `npm run accept:p08 -- --help`。

本矩阵中的“已交付”“已验证”“未运行”分别对应不同证据层次；任何一层都不能独自构成
P08 阶段通过或负责人签署。
