# P08 一期总验收契约说明

版本：0.2（对应 PRD `input/shiploop-v1/p08-release-acceptance/features/p08-acceptance.md`）。
本文冻结 P08 总验收（P08-4）的配置、检查清单与证据契约，供 `npm run accept:p08`
（P08-4 后续 Task 交付）与负责人核对使用；机器可读契约见：

- `acceptance/p08.checklist.json` — 冻结检查清单（六层次、三态、必需事实类别）；
- `acceptance/p08.config.json` — 验收配置（工具链、预算、live/运行身份/Nezha 边界政策）；
- `acceptance/p08.entry.json` — 正式入口契约（固定步骤顺序、默认执行与显式选项）。

校验入口：`scripts/acceptance/p08-config.ts`（fail-closed，结构/唯一性/允许值漂移一律拒绝）。

## 1. 验证层次与三态

清单逐项表达六个验证层次，每个层次都必须被必需检查覆盖：

| 层次 | 含义 |
| --- | --- |
| `code-delivery` | 前序 P08-1～P08-3 代码交付与交付报告前置输入 |
| `task-local` | Task 局部验证（实际命令/退出码/证据路径） |
| `feature-gate` | Feature 门禁（去重 Task 索引）结果作为阶段输入 |
| `phase-integration` | Phase 集成：确定性回归、安装检查、两类项目闭环复跑 |
| `live` | Todo 新项目与存量项目真实模型 live 证据 |
| `manual` | 负责人 macOS 操作与一期放行签署 |

结果只有 `pass` / `fail` / `not_run` 三态。**not_run 不折算通过**：缺失结果、
真实模型缺失、负责人未确认或跨层检查未运行一律保持 `not_run`，不把缺失输入
默认为通过；人工 pending/rejected 不能由机器代签；deferred 项不参与通过计数。

## 2. 运行身份与运行目录

每次 P08 运行固定身份：`runId`、受测 `commit`、输入摘要（`inputsDigest`）与
工具链（Node 22.19.0 / npm 10.9.3 / darwin）。报告与全部证据引用必须绑定同一
身份，身份漂移 fail-closed。运行目录按 `runId` 一次性预留
（`create-once`）：已存在的运行目录不可被覆盖，保留旧运行并失败退出。

## 3. 前置输入与两类 live 分开核对

- P08-1：交付报告 `docs/acceptance/p08-1-delivery-report.md` + 发布清单
  `acceptance/p08-1.release-manifest.json`；
- P08-2：live 入口文档 `docs/phases/p08/p08-2-live-acceptance-entry.md` + Todo live 证据
  （`shiploop.todo.live-evidence`，由 `npm run accept:p08:live` 生成）；
- P08-3：演示报告模板与运行手册（`docs/acceptance/p08-3-demo-report-template.md`、
  `docs/acceptance/p08-3-existing-demo-runbook.md`）+ 存量证据封套
  （`shiploop.brownfield.evidence-envelope`）。

交付缺失、报告缺失、commit 非法或非受测 HEAD 祖先时输出 blocked/not_run，
不以占位实现或补库放行。Todo live 与存量 live **分别核对、互不替代**；
默认 `accept:p08` 入口不调用真实模型（live 证据 import-only），真实模型须
负责人经独立 `accept:p08:live` 入口授权与预算。

## 4. Nezha 边界与发布纪律

Nezha 只作为开发编排工具，不是 ShipLoop 产品运行时依赖。P08 报告不得把
Harness 状态、测试数量或成功日志文字当作产品通过依据；通过判定只来自持久
状态与可观察事实证据。本 Feature 不自动 npm 发布、不 push、不修改 Phase
状态；人工批准一期验收后才安排正式发布（后置能力单列，不混入一期验收）。

## 5. 前序 Task（F-001～F-008）边界

本契约与校验覆盖结构、身份、范围、证据导入、安装检查、正式入口与报告聚合；真实
SQLite、Git、Host、受控进程与跨层故障事实由 P08-4 F-009 在真实临时资源上交付，
缺失时保持 not_run。

## 6. 本 Task（F-009）Phase 集成边界

`p08-phase-integration.ts` 由正式入口在安装产物检查后调用：在独立临时目录解包受测
P08-1 tarball，启动打包 CLI/Host，创建 Todo 新项目和非 Nezha 存量 Git 仓库，读取
真实 SQLite、Git HEAD/tree/status、CLI 回执、既有失败传播和 Host 停止状态。脱敏证据
在临时资源删除后复制进 P08 报告，缺少 SQLite/Git/Host/进程/制品/清理事实或身份
漂移时 fail-closed。当前 npm registry 缓存不足时，安装证据明确记录锁定依赖闭包与
本地 tarball 解包边界，不把未运行的 registry/native/live 检查标为通过。

真实 Pi live、人工确认和未授权 Live 仍由独立入口保持 `not_run`，机器报告不签署
Phase 或修改 Feature/Task 状态。

## 7. 身份校验（F-002）

`scripts/acceptance/p08-identity.ts` 提供统一身份基座（fail-closed）：

- 前置交付基线（`shiploop.p08.prerequisite-baselines`）：P08-1～P08-3 逐项校验
  feature 身份、commit 格式、交付状态、接口满足声明与受测 HEAD 祖先关系；
  任一缺失或不匹配形成 blocked/not_run，不产生验收通过；
- 不可变输入摘要：运行身份绑定配置/清单/前置交付/工具链/适用测试范围/外部
  报告引用的内容摘要；HEAD、源码哈希/文件集合或工具链漂移输出结构化原因并
  失败关闭；运行目录按 runId 一次性预留，旧运行不可覆盖；
- 外部证据（只读导入）：Todo Live（`shiploop.todo.live-evidence`）、存量 Live
  （`shiploop.brownfield.evidence-envelope`）、安装产物（`shiploop.p08.release-manifest`）
  与人工门禁（`shiploop.p08.manual-gate-record`）分别校验来源 kind、runId、commit、
  输入摘要、结构版本与允许状态；重复引用、损坏 JSON、未知字段或非受测 HEAD
  祖先的陈旧 commit 一律拒绝；两类 live 互不替代；人工门禁身份必须与当前
  P08 运行完全一致；
- 校验失败写入脱敏诊断（`shiploop.p08.identity-diagnostic`）：不含开发机绝对
  路径与凭据；重复 runId 时保留旧运行证据并写入独立 diagnostics 目录，不覆盖
  原报告、产品 SQLite 或 Feature/Phase 元数据；
- 真实前序报告与 Live 运行是否存在由 Phase 入口核对；本模块不执行 Git/
  SQLite/Host/模型命令，祖先关系由入口经受控 probe 注入。

## 8. 安装产物检查（F-005）

`scripts/acceptance/p08-install-check.ts` 为阶段入口的 `p08-installation` 步骤
提供干净安装与本地 pack 产物检查（fail-closed）：

- 在独立临时 staging 中读取 P08-1 交付的本地 tarball（复制后只按 staging 字节
  判定），逐包核对包名、版本、tarball/包内文件 sha256、bin/exports/main/types
  入口（bin 必须带可执行位与 shebang）、Node/npm 引擎与平台范围、依赖闭包
  （禁止 workspace/file/link/绝对路径 spec，内部依赖必须在制品集合内解析）与
  release/distribution manifest 的协议和 Schema 范围；未知/更高版本策略必须是
  reject；
- fail-closed 命中：缺少必需产物、摘要不符、未构建入口、本地路径依赖、闭包
  缺口、协议或 Schema 越界、Nezha 运行时依赖或模块引用、Harness 路径引用、
  个人绝对路径、疑似凭据、产物目录位于 node_modules 内（开发目录捷径）；
- 报告记录安装前置、实际工具版本（注入 probe 或实际进程探测）、制品清单、
  逐项检查结果、inputsDigest 与 staging 清理状态；失败时按调用方目录保留脱敏、
  create-once 诊断；当前开发目录 node_modules 或源码入口的存在不构成通过依据；
- 期望范围从仓库 `distribution-compatibility.json` 加载（`loadP08InstallExpectedScope`），
  结构或策略不满足冻结契约即拒绝，不猜测降级；
- 真实独立目录 npm 安装、better-sqlite3 原生加载、Host 启动与 CLI 操作登记为
  phase-integration `not_run` 边界（`P08_INSTALL_CHECK_NOT_RUN`），不折算为通过；
  本模块不执行 npm publish/install、git push、模型请求、远端写操作或用户仓库清理。
