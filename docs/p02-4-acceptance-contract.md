# P02-4 P02 双客户端与初始化验收 — 阶段验收契约与检查清单

- 对应任务：F-001（核验前序放行基线，冻结 P02 阶段验收清单与接口映射）。
- 文档状态：P02-4 实施前置契约（验收约定与检查清单，**不是**阶段验收报告）。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收。
- 输入依据：PRD `p02-acceptance.md`（版本 0.2，2026-10-01，待审阅）与共同执行约束
  `execution-contract.md`（开发查阅路径：
  `../../../../ai-coding/shiploop-harness/workspace/features/2026-10-04-23-19-52_p02-4-p02/input/`，
  非本仓库、非运行时依赖），以及 Harness 知识目录 `architecture-redesign/`（不在本仓库）。
- 本文只规定 **P02-4 的验收约定、检查清单与接口映射**；它描述 F-002 ~ F-014 应实现的检查项
  与证据形态，不代替任何任务的验收报告，也不交付 `accept:p02` 的实现（由 F-011 交付）。
  产品实现只在 ShipLoop 目标仓库进行，Harness 仅保存任务元数据与编排。
- 本文复用前序已核对契约（P01-4 / P02-1 / P02-2 / P02-3），**不把设计文档中的候选名称直接
  当作现存命令**；发现的矛盾集中记录于 §8 并请求核对，不静默改变领域语义。

---

## 1. 前序基线核验（开工核对）

### 1.1 分支与提交（规划时结论的开工复验）

- 实际执行分支：`feat/2026-10-04-23-19-52_p02-4-p02`（worktree
  `/Users/ganlu/Documents/my-dev/code/mygit/AI/shiploop-2026-10-04-23-19-52_p02-4-p02`）。
- 基线（`feature.yaml.metadata.base_branch`）：`feat/2026-10-04-23-19-52_p02-3`
  （= 当前 HEAD `18d490e`，即 P02-3 F-020 交付报告提交；本 Feature 开工时尚无新提交）。
- 已核验祖先链（`git merge-base --is-ancestor` 逐项为真，`git fsck` 无损坏对象）：

| 阶段前置（phase.yaml step_id） | 执行分支 | tip commit | 已交付报告 |
|---|---|---|---|
| p02-host-lifecycle（P02-1） | `feat/2026-10-04-23-19-52_p02-1-host` | `7ae5f39` | `docs/acceptance/p02-1-f014-report.md` |
| p02-commands-events（P02-2） | `feat/2026-10-04-23-19-52_p02-2` | `3caca48` | `docs/acceptance/p02-2-f020-report.md` |
| p02-onboarding（P02-3） | `feat/2026-10-04-23-19-52_p02-3` | `18d490e` | `docs/acceptance/p02-3-f020-report.md` |

- P02-3 已交付**受测代码** commit 为 `fdacf25`（F-019 文档/交接 + 文档守护），产品代码最后
  变更为 `6c140f8`（F-018 真实 Git/SQLite/进程/Host/CLI 端到端集成回归 + `output_overflow`
  终态修复）；`18d490e`（F-020 交付报告与守护）在其后，只增加文档与守护测试。
- **P01 放行依据实际存在**：`acceptance/p01`（tip `5a43a04`，两轮独立集成 24/24、无效受测
  ref 负例按预期失败）已并入 `main`（tip `24dcb7d`，「record owner approval for P01」为
  人工放行记录，见 `docs/acceptance/p01-review-results.md`、`p01-review-checklist.md`）。
  P01 放行由负责人签字，本任务只核验记录存在，**不代替人工签字**。
- **规划时结论的复验与修正**：规划时记录「main 为 5a43a04、Host/CLI 仍是 P01 入口、
  feature.yaml 指定的 P02-3 基线尚未发现」。开工复验：`main` 现为 `24dcb7d`（`5a43a04` 为其
  祖先）；`feat/2026-10-04-23-19-52_p02-3` 分支**已存在**且被当前分支祖先包含；Host/CLI 已是
  P02-1/P02-2/P02-3 入口（见 §1.2）。规划时缺失项均已出现，**无因前序缺失记录的阻塞项**；
  F-001 不重建前序能力、不自动合并分支、不以任何方式代替人工放行。

### 1.2 已交付能力与入口确实存在（非占位）

| 能力 | 已交付入口 | 位置 |
|---|---|---|
| CLI 可执行入口 | `packages/cli/dist/bin.js`（`bin: {shiploop: ./dist/bin.js}`，`#!/usr/bin/env node`，mode 755 由 `scripts/prepare-cli-bin.ts` 核验） | `packages/cli/src/bin.ts` 唯一读 argv/env、唯一退出 |
| Host 后台进程入口 | `packages/host/dist/start.js`（CLI 启动器独立 argv spawn） | `packages/host` |
| 生命周期 | `host start\|status\|stop`、`connectToHost`/`probeDiscoveredHost`/`ensureHostRunning`、`acquireWriterLock`/`openLockedWriter` | `docs/p02-1-host-lifecycle-contract.md`、`docs/p02-1-writer-lock.md` |
| 应用命令/回执 | `commandService.submit`（六命令白名单 + `baseline.preview`/`baseline.run`/`baseline.cancel`）、`commandReceiptsService`、`GET /v1/receipts/:commandId`、`GET /v1/results/:resultRef` | `docs/p02-2-commands-events-contract.md`、`docs/p02-2-handoff.md` |
| 查询/事件 | `queryService`（快照/项目/配置/事件分页）、`GET /v1/snapshot`、`GET /v1/events`（SSE，`evcur_v1` 游标） | 同上 |
| 静态接入 | `onboardingService`（`projects.inspect`/`projects.overview`）、`project init`/`project overview` | `docs/p02-3-onboarding-contract.md` |
| 基线授权/执行 | `baselineService`（previewDigest 绑定授权）、`baselineExecutionService`（单并发、取消/超时/停止核验、保守重启恢复） | `docs/p02-3-baseline-execution.md`、`docs/p02-3-baseline-recovery.md` |
| 基线查询/证据 | `baselineQueryService`（`baselines.list`/`baselines.get`/`artifacts.get`）、`createBaselineEvidenceCollector`/`readBaselineOutput` | `docs/p02-3-baseline-evidence.md` |
| 受监督进程 | `CommandProcessPort` + `createCommandProcessAdapter`（放行协议、进程组停止核验） | `docs/p02-3-command-process.md` |

测试实际存在：`test/` 下 102 个 `*.test.ts`（含双客户端纵向、真实集成回归与跨进程夹具），
由 `npm test` 默认收集（`vitest.config.ts`：`passWithNoTests:false`、`exclude` helpers/fixtures）。

### 1.3 基线验证命令与退出码（开工复验实测）

在依赖由锁定版本 `npm ci` 重建后执行（Node `22.19.0` / npm `10.9.3` / lockfileVersion `3`）：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm ci` | 退出 0（0 vulnerabilities） |
| 工程验证 | `npm run verify` | **退出 0（`PASS 3/3`）** |
| ├─ 测试 | `npm test` | 退出 0，**102 test files / 2713 tests passed**，套件内无 skip |
| ├─ 类型 | `npm run typecheck` | 退出 0 |
| └─ 构建 | `npm run build` | 退出 0（N-API 锁模块 + 三包 dist + `dist/bin.js` 冒烟 + 无副作用加载） |

结论：前序已交付能力在 P02-4 分支可用；F-001 的检查清单即建立在这些真实入口与测试之上。

---

## 2. 阶段必需检查清单与 FR 需求映射

### 2.1 稳定检查 ID 约定

- 检查 ID 形如 `P02-<GROUP>-<NAME>`，全大写、连字符分隔，**跨运行稳定**；报告、证据目录名与
  阶段聚合都以此 ID 为业务身份，不使用展示名。
- `P02-ENG-*` 为工程检查；`P02-FR1-*`/`P02-FR2-*` 为 PRD FR 分支检查；`P02-PHASE-*` 为阶段
  控制检查（夹具失败、必需检查未运行、报告完整性）。
- 检查 ID 的机器可读清单由 F-009/F-010 的版本化报告 Schema 与 `acceptance/p02.config.json`
  固定；F-001 只在此冻结 ID 集合与语义。**未知或重复的检查 ID 必须被拒绝**，不得被聚合为通过。

本阶段冻结的必需检查（全部为 `required`，任一非 `pass` 即使 `accept:p02` 非零退出）：

| 检查 ID | FR / 阶段分支 | 说明 | 承担任务 | 测试 / 命令入口 | 关键证据字段 |
|---|---|---|---|---|---|
| `P02-ENG-VERIFY` | 工程 | `npm run verify`（锁文件预检 + test/typecheck/build）退出 0 | F-011 | `npm run verify`（盘 `scripts/verify.ts`） | `exit_code`、`steps[].label`/`exit_code`、测试文件/用例计数 |
| `P02-FR1-UNIQUE-HOST` | FR-1 **唯一 Host** | 同一临时数据根同步启动两个真实 dist CLI：恰一持锁 Host/写入者、同一 `hostInstanceId` 与 `dataRootIdentity`、`127.0.0.1` 随机端口、发现目录权限合规 | F-003 | `test/p02-4-dual-cli-acceptance.test.ts`（复用 `test/helpers/host/` 与 p02-3 双客户端夹具） | 两 CLI 启动记录、`hostInstanceId`/`dataRootIdentity`、锁持有/落选回收、监听地址、文件权限 |
| `P02-FR1-SHARED-STATE` | FR-1 **共享项目/配置** | CLI A 确认注册 + 配置写入后，CLI B 经列表/详情/overview/配置查询读到同一 `projectId`、绑定、描述、标签、当前值、`revision` 与有效来源 | F-003 | 同上 | `projectId`、绑定身份、配置 `revision`/`source`、双客户端返回值逐字段一致 |
| `P02-FR1-BASELINE-OK` | FR-1 **授权基线** | 用户明确确认的确定性成功命令：双客户端查询同一 `operationId`、逐项检查结果、退出码 0、代码身份与可校验输出制品；`accepted` 不作 `passed` 依据 | F-003 | `test/p02-4-dual-cli-acceptance.test.ts`（复用 `test/helpers/p02-3/` 命令样例） | `operationId`、`checkKey`/状态/`exitCode`、代码身份、`artifactId`/`hash`/`size`、双客户端一致 |
| `P02-FR2-DUPLICATE-INIT` | FR-2 **重复初始化** | 同规范路径及其真实路径别名重复 init 得同一 `projectId`；项目/绑定各一份，原名称/描述/标签/配置未被覆盖 | F-004 | `test/p02-4-idempotency-acceptance.test.ts` | 两次返回 `projectId`、项目/绑定行数、元数据前后快照、别名 realpath |
| `P02-FR2-COMMAND-CONFLICT` | FR-2 **命令重放/冲突** | 显式同一 `commandId` 重放返回原持久回执与结果身份、零重复副作用；同 `principal`/`commandId` 异参数得 `conflict`（`idempotency_key_reuse`）且无额外变更，原回执仍可查 | F-004 | 同上（`receipt get` 与 `POST /v1/commands` 重放） | `commandId`/`requestDigest`、`replayed:true`、`conflict` 错误码、启动次数/项目行数/检查记录/事件计数、源文件摘要不变 |
| `P02-FR2-SOURCE-PRESERVED` | FR-2 **源文件保留** | 干净仓库与含 staged/unstaged/untracked 的仓库接入前后 HEAD、索引、Git 状态、文件字节摘要一致；恶意初始化/安装脚本哨兵零执行、无 `node_modules` 等意外产物、AGENTS.md 不被覆盖 | F-005 | `test/p02-4-repo-preservation-acceptance.test.ts`（复用 p02-3 仓库变体与哨兵夹具） | HEAD、`git status` 原文、tracked/untracked 摘要、哨兵不存在、产物清单 |
| `P02-FR2-AUTH-REJECT` | FR-2 **认证拒绝** | 缺失/错误 token、旧实例身份、数据根不匹配、未知协议/Schema、非法 JSON/分页、任意路径读取、根外/符号链接 cwd、受限 principal 跨项目、监听覆盖与 Host/Origin 拒绝；零副作用且不泄密 | F-006 | `test/p02-4-negative-acceptance.test.ts`（复用受限 principal 装配与 T23 负例） | 错误码（`unauthorized`/`protocol_incompatible`/`unsupported_schema_version`/`invalid_input`…）、副作用零断言、实际绑定 `127.0.0.1`、脱敏扫描（无 token/认证头形状） |
| `P02-FR2-CLIENT-EXIT` | FR-2 **客户端退出** | 运行基线时退出/中断 CLI 的 wait/follow（退出码 4 `observation_interrupted`）：不发 stop/cancel、Host 存活、另一 CLI 仍可认证查询同一 Host | F-007 | `test/p02-4-restart-acceptance.test.ts` | 子进程退出码、观察中断错误体、Host 存活探测、操作继续/收尾状态、零 stop/cancel 请求 |
| `P02-FR1-RESTART-QUERY` | FR-1 **重启查询** | 正式显式 `host stop`（三证据）后重启取新 `hostInstanceId`；新 CLI 读到原 `projectId`、配置值/`revision`、基线结果、代码身份、输出制品 `hash`/`size` 一致；旧 token/旧实例请求被拒、原基线不自动重跑 | F-007 | 同上（+ P02-3 重启恢复回归） | 前后 `hostInstanceId`、锁释放/发现移除证据、持久身份逐字段、旧凭据拒绝码、基线启动次数不变 |
| `P02-FR2-BASELINE-FAILURE` | FR-2 **基线失败** | 固定非零退出、拒绝授权 `not_run`、缺命令/未知脚本、超时 `timed_out`、显式取消 `cancelled`、停止未确认 `stop_unconfirmed` 保留占用、`preview_stale`；失败不撤销注册、不删证据、不冒充通过 | F-008 | `test/p02-4-baseline-failure-acceptance.test.ts`（复用挂起/超时/取消/停止核验用例） | 检查状态/`reasonCode`/子命令退出码、argv/cwd/`environmentRef`/`timeoutMs`/耗时/代码身份、输出制品、overview 注册+失败健康、零启动断言、占用保留 |
| `P02-PHASE-FIXTURE` | **夹具失败** | 夹具准备失败明确 `fail`/`not_run`，阶段非零，保留已取得证据并回收自有进程/临时资源 | F-009 / F-011 | `test/p02-4-acceptance-controller.test.ts`（注入准备错误） | `fixture_status`、失败原因、依赖检查状态、阶段退出码、证据保留、进程回收核验 |
| `P02-PHASE-NOT-RUN` | **必需检查未运行** | 未提交结果/启动失败/超时/被跳过的必需项标 `not_run`，不得聚合为通过 | F-009 / F-011 | `test/p02-4-report-aggregation.test.ts` | 必需检查清单、`status`、缺失结果、聚合结论、退出码 |
| `P02-PHASE-REPORT` | 报告完整性 | 版本化报告 Schema、逐项结果、证据 `path`/`hash`/`size`、脱敏与总体结论可验证 | F-009 | 同上 + `test/p02-4-acceptance-report.test.ts` | `report_schema_version`、输入计划摘要、受测 commit、工具版本、`checks[]`、`evidence[]`、结论、已知限制 |
| `P02-ENG-CLEAN-REPLAY` | 重复运行不依赖残留 | 干净源码快照 `npm ci`/build 后从非源码 cwd 连续两次 `accept:p02` 均退出 0；run-id/报告/临时资源独立、互不覆盖；结束后无自有 Host/基线进程残留 | F-012 | `test/p02-4-clean-replay.test.ts`（复用 `scripts/clean-snapshot-replay.ts`） | 两次退出码、run-id/报告目录、证据 `hash`/`size` 复验、进程/锁清理断言、路径扫描 |

> 上表「测试入口」对尚未实现的后继任务（F-002 ~ F-012）为**约定文件/入口**（实现任务若调整
> 命名须同步本文与守护测试）；F-001 只冻结检查 ID、分支语义与证据字段，实际测试由对应任务按
> TDD 落地。`P02-ENG-VERIFY` 的入口现已存在。

### 2.2 FR 分支覆盖核对

PRD §3.2 的每个 FR 分支都有稳定检查 ID 承接，且每项都断言**真实状态/文件/返回值**，
不以「正常完成文本」或测试数量替代：

| 要求分支 | 承接检查 ID |
|---|---|
| FR-1 双 CLI 同数据根、唯一 Host | `P02-FR1-UNIQUE-HOST` |
| FR-1 共享持久项目/配置状态 | `P02-FR1-SHARED-STATE` |
| FR-1 获准基线命令执行与双端查询 | `P02-FR1-BASELINE-OK` |
| FR-1 重启后仍能查询项目和检查结果 | `P02-FR1-RESTART-QUERY` |
| FR-1 边界：夹具准备失败 | `P02-PHASE-FIXTURE` |
| FR-1 边界：必需检查未运行 | `P02-PHASE-NOT-RUN` |
| FR-1 边界：重复运行不依赖上次残留 | `P02-ENG-CLEAN-REPLAY` |
| FR-2 重复初始化/路径别名 | `P02-FR2-DUPLICATE-INIT` |
| FR-2 命令重放与参数冲突 | `P02-FR2-COMMAND-CONFLICT` |
| FR-2 认证/协议/范围/监听拒绝 | `P02-FR2-AUTH-REJECT` |
| FR-2 源文件保留、未知脚本零执行 | `P02-FR2-SOURCE-PRESERVED` |
| FR-2 客户端退出/观察中断 | `P02-FR2-CLIENT-EXIT` |
| FR-2 基线失败与执行异常 | `P02-FR2-BASELINE-FAILURE` |
| FR-2 证据与报告可验证、失败如实记录 | `P02-PHASE-REPORT` |

阶段通过要求：**所有必需检查实际通过且证据完整**；任一 `fail`/`not_run`、证据缺失/损坏即
阶段不通过（§2.5）。业务「拒绝/未启动」类负例只有在错误断言**与**零副作用/持久状态断言同时
成立时，该检查才计 `pass`；业务 `not_run` 本身永不算通过。

### 2.3 前序必需回归由 `verify` 覆盖（不只核对测试数量）

`npm run verify` 的 `npm test` 步骤默认收集 `test/**/*.test.ts`（`passWithNoTests:false`，
不跳过）。下列前序回归**实际入口**必须保持可运行（`P02-ENG-VERIFY` 退出 0 即覆盖；不得用删
测试、`passWithNoTests` 或跳过替代）：

| 分支 | 前序实际测试入口（`test/`） |
|---|---|
| T17 Host 单例/竞争/锁/发现 | `host-lifecycle-contract.test.ts`、`host-launcher.test.ts`、`host-fixture-kit.test.ts`、`writer-lock-child.ts`（helpers） |
| T17 认证/协议/传输 | `host-http-transport.test.ts`、`host-cli-execute.test.ts`、`client-protocol-boundary.test.ts` |
| 命令幂等/回执 | `atomic-commands.test.ts`、`command-receipts-store.test.ts`、`commands-contract.test.ts`、`app-cli-execute.test.ts` |
| 查询/事件/SSE | `host-app-routes.test.ts`、`host-sse-events.test.ts`、`snapshot-and-events.test.ts`、`app-cli-events-observe.test.ts` |
| T10 授权/脱敏 | `authorization-contract.test.ts`、`authorized-queries.test.ts`、`host-protected-storage.test.ts` |
| T15 注册/接入子集 | `project-registration.test.ts`、`repository-inspector.test.ts`、`p02-3-init-overview-vertical.test.ts`、`p02-3-inspect-overview.test.ts` |
| 基线授权/执行/证据/恢复 | `baseline-contract.test.ts`、`baseline-execution.test.ts`、`baseline-evidence.test.ts`、`baseline-host-faults.test.ts`、`baseline-host-recovery.test.ts`、`p02-3-baseline-preview-authorize.test.ts` |
| 受监督进程/停止核验 | `supervised-command-process.test.ts`、`supervised-process-stopping.test.ts` |
| 端到端集成回归 | `p02-1-integration-regression.test.ts`、`p02-2-integration-regression.test.ts`、`p02-3-integration-regression.test.ts` |
| SQLite/存储底座 | `sqlite-migration-runner.test.ts`、`sqlite-schema-migrations.test.ts`、`sqlite-cas-and-atomicity.test.ts`、`sqlite-baseline-store.test.ts` |
| 工程门禁 | `verify.test.ts`、`typescript-build.test.ts`、`boundary-check.test.ts`、`deterministic-test-harness.test.ts` |

### 2.4 复用夹具与故障注入（不新建第二套）

| 用途 | 现有入口 |
|---|---|
| 隔离数据根/受管子进程/伪 Host/脱敏证据日志 | `test/helpers/host/` |
| 基线组合夹具（仓库变体、命令样例、挂起进程树、恶意初始化脚本、证据故障注入） | `test/helpers/p02-3/`（`createBaselineFixture`） |
| 受控只读 SQLite 探针（不写业务状态） | `test/helpers/p02-2/storage-probe.ts` |
| 跨进程竞争/中断子进程 | `test/helpers/register-race-child.ts`、`settings-race-child.ts`、`cas-race-child.ts`、`interrupt-publish-child.ts`、`writer-lock-child.ts` |
| 安全清理（拒绝未知根/符号链接逃逸） | `test/helpers/safe-cleanup.ts`、`temp-sandbox.ts` |

F-002 在上述基础上为 P02-4 场景提供**专属**临时数据根、真实 Git 仓库变体与证据快照工具：
夹具自测须证明启动失败/屏障超时/断言失败仍回收已核验的自有进程；只清理本次授权临时根；
停止未确认时保留资源与诊断，不删除仍可能被写入的目录。

### 2.5 结果状态与聚合规则

- 每个检查的结果状态只有三种：`pass`、`fail`、`not_run`。**未提交结果、启动失败、超时与被
  跳过的必需项一律 `not_run`**，不得默认成功。
- 预期负例（拒绝、冲突、失败分支）只有在**错误断言与副作用断言同时通过**时才计为 `pass`；
  只有错误类型而没有「零启动/状态不变/源文件不变」副作用证据不算通过。
- 聚合：任一必需检查 `fail` 或 `not_run`、证据缺失/损坏、报告写入失败 → 阶段结论非通过且
  `accept:p02` 非零退出。空结果集不得聚合为通过。
- 阶段外的能力（Pi/模型 Live、Web、其他平台、强沙箱）标 `not_run`/未支持，**不计入 P02 必需
  项的通过数**，不得折算。

---

## 3. 验收接口与可复跑约定（真实入口，非设计候选名）

阶段验收必须经**产品公共入口**执行，不得用验收脚本直接插业务行、手工改 SQLite 或删锁替代。

### 3.1 真实 dist CLI 入口、参数与退出码

- 可执行入口：`node packages/cli/dist/bin.js …`（构建后 `bin: shiploop`；`npm run build` 的
  `scripts/prepare-cli-bin.ts` 校验 shebang 与 mode 755，`scripts/smoke-built-entries.ts` 冒烟）。
  命令面（`packages/cli/src/bin.ts` 分派；应用面 `runAppCli`、生命周期面 `runHostCli`）：

| 命令组 | 子命令 | 关键参数 |
|---|---|---|
| `host` | `start\|status\|stop` | `--data-root <abs>`；`status`/`stop` 只读不启动 Host |
| `project` | `init\|overview\|register\|list\|get\|edit\|labels` | `init <repository-path> [--name] [--description] [--label] --confirm`；`edit --revision`；`list --limit/--cursor/--match` |
| `config` | `create\|update\|get\|effective\|export` | `--scope global\|project`、`--project`、`--input <file>`（payload `schemaVersion=2`）、`update --revision` |
| `receipt` | `get <commandId>` | 幂等回执查询（超时/响应丢失先查回执） |
| `events` | — | `(--project <id> \| --global)`、`--cursor`、`--snapshot-only`、`--follow` |
| `baseline` | `preview\|run\|list\|status\|cancel\|evidence` | `--project`、`--input <file>`（检查计划）、`run (--confirm\|--decline) [--wait] [--follow]`、`cancel --confirm`、`--command-id <uuid>` |

- 基线命令的完整调用形态：`baseline preview`、`baseline run`、`baseline list`、
  `baseline status`、`baseline cancel`、`baseline evidence`。
- 通用参数：`--data-root <abs>`（POSIX 绝对路径，相对/空/NUL/`/` → 退出码 2）、`--json`（单信封
  `{ok,command,result|error}`；`--follow` 为 NDJSON）、`--command-id <uuid v4>`（省略由
  HostClient 生成一次并冻结；重放用同一信封）。
- **退出码（五档，冻结值）**：`0` 成功；`1` 业务拒绝/操作失败（`forbidden`/`conflict`/
  `not_ready`/`resource_busy`/`preview_stale`/`stop_unconfirmed`、`--wait` 终态非全 passed 等）；
  `2` 输入错误（参数/ID/分页/监听覆盖/本地不安全发现）；`3` 连接/协议错误（`host_not_found`/
  超时/`protocol_incompatible`/`response_malformed`）；`4` 观察中断（`observation_interrupted`，
  操作未取消、Host 未停止）。开工实测样例：无参数 → 2；`host status` 无实例 → 3；
  `project init <不存在路径>` → 2。
- 监听地址不可配置：`--bind/--host/--address/--port/--listen*` 与 `SHIPLOOP_HOST_*` 监听覆盖
  一律拒绝（退出码 2）。完整参数以 [p02-2-operations.md](p02-2-operations.md)、
  [p02-3-operations.md](p02-3-operations.md) 的真实示例为准。

### 3.2 Host 路由与线协议

- 生命周期（P02-1，冻结）：发现 `schemaVersion=1`、握手 `protocolVersion=1`、路由
  `POST /v1/host/handshake`、`GET /v1/host/status`、`POST /v1/host/stop`；Bearer-only、
  Host/Origin 校验、无 CORS、16 KiB 体上限、脱敏错误。
- 应用面（P02-2）：命令唯一入口 `POST /v1/commands`（信封内 `operation` 判别）；
  `GET /v1/receipts/:commandId`、`GET /v1/results/:resultRef`；`GET /v1/projects`、
  `/v1/projects/:projectId`、`/v1/projects/:projectId/repository-binding`、
  `/v1/projects/label-counts`；`GET /v1/settings/global`、`/settings/global/export`、
  `/v1/projects/:projectId/settings`、`.../settings/effective`、`.../settings/export`；
  `GET /v1/snapshot`；`GET /v1/events`（SSE，`Last-Event-ID`/`?cursor=` 恢复，心跳 15 000 ms）。
- 基线面（P02-3）：`GET /v1/projects/inspect?path=<abs>`（唯一仓库根绝对路径例外，永不返回
  文件内容）、`GET /v1/projects/:projectId/overview`、`POST /v1/commands`（`baseline.preview`/
  `baseline.run`/`baseline.cancel`）、`GET /v1/projects/:projectId/baselines`（分页默认 20、
  上限 100）、`GET /v1/baselines/:operationId`（含逐项检查与 ≤16 KiB tail）、
  `GET /v1/artifacts/:artifactId/content`（有界 ≤8 MiB、授权、脱敏）。
- 线消息 `schemaVersion=5`（P03-2 / F-007 升版：决策/策略/输入准备三命令与审批查询
  进入握手集合，见 `docs/p03-2-plan-approval-contract.md`；P03-1 / F-009 冻结时为 4，
  P02-3 冻结时为 3，P02-2 起点为 2）；事件封套
  `schemaVersion=1`；游标 `evcur_v1_<base64url>` 绑定数据根与 scope（计划列表另有
  `plcur_v1_`）；未知版本/能力 → `unsupported_schema_version`/
  `unsupported`，不猜测降级。表外路径 → `unsupported`/`404`，永不返回文件内容。
- `quiescing`/`stopping`/`starting` 下 `POST /v1/commands` 返回 `503 not_ready`，只读查询不受
  影响；体积/分页/超时为契约 §13 有限值，不可配置放宽。

### 3.3 可信授权上下文

- 认证唯一来源：P02-1 本机 Bearer 单令牌（`host/auth.token` 0600，`host/` 0700，
  `host/writer.lock` 永不删除；发现文件 0600，属主核验）。凭据不进 URL/query/argv/env/日志/
  响应/证据。
- 生产装配：认证通过后固定绑定 `principalId = "local-owner"`（`TrustedPrincipal`，全部应用
  能力、`projectScope.kind='all'`）；Core 应用层只接收显式传入的可信主体，绝不来自请求数据。
- 受限主体（`test-restricted:<uuid>` + 能力收窄 + 项目允许列表）**只由可信测试装配注入**；
  请求中的 `actorId`/`principal`/能力字段不提权。授权检查在 Core 应用层（不经 HTTP 同样拒绝）；
  不可见/未知一律 `forbidden`/`not_found`。重放与回执读取**重核当前身份与权限**。
- 数据根身份 `dataRootIdentity = lower_hex(sha256(utf8(canonicalRoot)))`；Host 与客户端握手
  双向核验 `hostInstanceId`/`dataRootIdentity` 后才允许业务请求。

### 3.4 幂等回执

- 一次逻辑命令一个冻结信封：`commandId`（UUID v4）+ `scope` 三态（`registration`/`global`/
  `project`）+ `operation` + 可选 `expectedRevision` + `issuedAt`/`expiresAt`（±60 s 偏差、
  默认 TTL 60 s、最大寿命 300 s）+ 精确 payload 白名单；`requestDigest` 由服务端按规范化
  JSON 重算。
- 幂等键 = `(principalId, commandId)` + 摘要：同 ID 同摘要命中持久回执（`replayed:true`，零
  副作用）；同 ID 不同摘要 `conflict`（`idempotency_key_reuse`）；不同主体同 ID 相互独立。
  业务写入、`state_events` 与完成回执同事务提交；不存在「持久 accepted 但结果永不可知」。
- 超时/响应丢失先 `GET /v1/receipts/:commandId` 取原结果，命中即零重发；未知才以**完全相同
  信封**有限重发。`resultRef`（`v1.<43 base64url>`）为不透明结果引用，经
  `GET /v1/results/:resultRef` 授权解析，后续编辑不改写该次结果。`baseline.run` 的 `accepted`
  回执返回 `operationId`；**`accepted` 不是通过**，终态以持久检查状态为准。

### 3.5 基线状态与证据查询

- CLI：`baseline list`（分页）、`baseline status <operationId>`（操作 + 逐项检查 + 代码身份 +
  `checks[].output {artifactId, byteSize, truncated}` + ≤16 KiB tail）、`baseline evidence
  <artifactId>`（脱敏正文，有界 ≤8 MiB）；Host 路由见 §3.2。
- 健康由最近一次终态操作派生：`healthy` 当且仅当操作 `completed` 且全部 `required` 检查
  `passed` 且无 `source_changed`/`evidence_incomplete`/`output_overflow`；否则 `unhealthy`/
  `not_run`。注册与健康严格分轴；**基线失败不撤销注册、不删除失败证据**。
- 覆盖缺口（溢出/丢失/发布失败/停止未确认/制品缺失）→ 检查 `inconclusive` 并记录原因；
  未收齐/缺失的输出永不证明通过。`failed`/`error`/`inconclusive`/`not_run` 永不伪装 `passed`。
- 阶段结论只引用上述结构化事实与证据 `hash`/`size`，不从日志文字或 Nezha `completed` 推断通过。

### 3.6 进程夹具与受监督进程约束

- 受监督命令进程（P02-3 契约 §13）：授权与代码身份核对后 ready/握手、`confirm` 回调短事务
  提交进程身份后才放行用户命令（握手预算 5 s）；argv 直接 spawn（无 shell）、独立进程组、
  最小环境（PATH + 显式允许列表）；取消/超时 SIGTERM → 5 s → SIGKILL，停止以「进程组不存在」
  的真实探测为准，**无法核验 = `stop_unconfirmed`**（保留占用、不重跑、不释放资源）。
- 验收夹具要求（F-002 落地、F-003 ~ F-008 复用）：真实 dist CLI 以现有同步屏障竞争连接同根；
  stdout/stderr 采集有大小上限；可取得规范仓库身份/HEAD/Git 状态/tracked+untracked 文件摘要/
  非秘密 Host 身份/操作与检查状态/输出制品摘要；数据库只经受控只读探针核对，不插入或修改
  业务状态；夹具自测证明启动失败/屏障超时/断言失败仍回收自有进程；只清理本次授权临时根，
  拒绝未知路径/符号链接逃逸；停止未确认时保留资源与诊断。

### 3.7 版本化输入（未知版本明确拒绝）

| 版本化输入 | 当前值 | 落点 |
|---|---|---|
| 配置 `schemaVersion` | `2`（`SETTINGS_SCHEMA_VERSION`） | `packages/core/src/ports/settings-schema.ts` |
| 导出格式版本 | `1`（`SETTINGS_EXPORT_FORMAT_VERSION`） | `packages/core/src/application/configuration-service.ts` |
| SQLite 迁移 | v1..v13（v2 `state_events`、v3 `command_receipts`、v4 基线四表、v5 accepted 回执扩展；P03-1 / F-002 起 v6 计划结构四表，见 `docs/p03-1-plan-import-contract.md`；P03-2 / F-002 起 v7 `approvals` 审批决策记录表，见 `docs/p03-2-plan-approval-contract.md`；P03-2 / F-003 起 v8 `approvals.check_policy_digest` 检查政策身份绑定，见 `docs/p03-2-plan-approval-verification-contract.md`；P03-3 / F-002 起 v9 单 Feature 执行域三表 `execution_batches`/`runs`/`batch_budget_revisions`，见 `docs/p03-3-execution-schema-contract.md`；P03-3 / F-003 起 v10 Work accepted 回执真实 Batch/Run 关联，历史 v1..v9 checksum 不变，见 `docs/p03-3-work-command-receipts-contract.md`；P03-3 / F-006 起 v11 Task 尝试计数列与预占账本表，历史 v1..v10 checksum 不变，见 `docs/p03-3-attempt-budget-contract.md`；P03-3 / F-007 起 v12 Runtime 启动预占账本表 `runtime_start_reservations`，历史 v1..v11 checksum 不变，见 `docs/p03-3-runtime-start-contract.md`；P03-3 / F-008 起 v13 Run 结果账本和 Task 首次通过事实，历史 v1..v12 checksum 不变，见 `docs/p03-3-run-outcome-settlement-contract.md`） | `packages/core/src/adapters/sqlite/migrations.ts` |
| 发现 / 握手 | `schemaVersion=1` / `protocolVersion=1` | `shiploop-host` 契约（P02-1） |
| 应用线消息 / 事件封套 / 游标 / 结果引用 | `schemaVersion=5`（P03-2 / F-007 起）/ `schemaVersion=1` / `evcur_v1`（计划列表 `plcur_v1`）/ `v1.<43>` | `shiploop-core/protocol`、`ports/*` |
| 阶段验收配置版本 | `configVersion`（F-010 冻结，建议 `1`） | `acceptance/p02.config.json`（见 §3.8） |

### 3.8 报告位置、配置入口与有限超时（F-009 / F-010 / F-011 实现、F-001 冻结约定）

- **报告默认位置**：`artifacts/acceptance/p02/<run-id>/`（相对仓库根；每次运行独立目录）：
  `report.json`（版本化机器可读）、`summary.md`（同源摘要）、`evidence/`（清理临时资源前导出
  的脱敏证据副本，引用为报告目录内相对路径，带 `hash`/`size`）。
- **run-id**：`<UTC YYYYMMDDThhmmssZ>-<8 hex>`，必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`、
  不含路径分隔符；非法 run-id 拒绝。
- **配置入口**：仓库内版本化 `acceptance/p02.config.json`（F-010 创建），字段含
  `configVersion`、`reportRoot`、`requiredChecks`（有序检查 ID，须完整映射 §2.1 清单）、
  `timeouts`（各步骤有限毫秒）。运行时校验拒绝未知 `configVersion`、未知/缺失/重复检查 ID、
  移除或关闭必需项、非正/无限超时与报告路径逃逸。CLI/环境变量仅作**覆盖**报告位置与有限
  预算，不得放宽必需检查集合、不得提供跳过认证/负例/verify 的开关。
- **命令入口**：`npm run accept:p02 [-- --run-id <id> --report-dir <dir> …]`（F-011 的
  `scripts/acceptance/p02-accept.ts`）：单次调用完成前提检查、`npm run verify`、§2.1 固定必需
  场景与报告/证据核验；全部必需检查 `pass` 且证据/清理成功才退出 0。环境变量约定
  `SHIPLOOP_ACCEPT_P02_RUN_ID` / `SHIPLOOP_ACCEPT_P02_REPORT_DIR` / 超时覆盖（沿用
  `SHIPLOOP_VERIFY_STEP_TIMEOUT_MS` 于 `scripts/verify.ts`）。
- **有限超时**：`npm run verify` 单步默认 `600_000ms`（已实现）；Git 夹具子进程 `30_000ms`
  （`test/helpers/git-repo.ts`）；验收控制器各步骤与整体均有限预算，超时后先核验进程停止再
  清理。
- **证据保留**：成功或失败都保留已取得证据；失败路径同样写出报告。报告不含认证文件、完整
  环境变量、合成/真实 token、认证头或用户文件正文；临时资源路径用逻辑映射表达。清理只删除
  本次持有且位于临时授权根内的资源。需随版本保存的脱敏证据放 `docs/acceptance/evidence-p02-4/`
  （沿用前序惯例，必要时加 `.gitignore` 例外）。

---

## 4. 阶段验收索引（T10 / T15 / T17 / T23 与命令幂等）映射

按**实际行为**映射（PRD §3.3「本阶段设计验收索引：T10 基础、T15 基础、T17、T23、T26 命令
幂等」；索引原文见 Harness 知识 `core-design/09-testing-and-implementation.md` §2）。本阶段
只覆盖下列**子集**，不宣称完整索引已验收：

| 索引 | P02-4 实际覆盖子集 | 明确不覆盖（后续） |
|---|---|---|
| **T10 基础**（项目隔离、审批、凭据脱敏和不可信内容） | 受限 principal 跨项目/基线证据越权拒绝（`P02-FR2-AUTH-REJECT`）、认证头/token 不出现在 JSON/诊断/证据、不信任 payload 字段不提权 | 审批流、运行时凭据注入 |
| **T15 基础**（init 重复/中断/移动/已有失败/多 clone，归档删除边界） | 重复 init/路径别名幂等（`P02-FR2-DUPLICATE-INIT`）、干净/脏仓库接入只读（`P02-FR2-SOURCE-PRESERVED`）、已有失败基线不撤销注册且可查询（`P02-FR2-BASELINE-FAILURE`） | 移动 rebind、多 clone 归档与删除边界、init 中断半注册恢复的产品级语义 |
| **T17**（Host 竞争、认证、协议版本、客户端退出） | 双 CLI 竞争唯一 Host（`P02-FR1-UNIQUE-HOST`）、认证/协议拒绝、旧实例/旧 token 拒绝（`P02-FR2-AUTH-REJECT`、`P02-FR1-RESTART-QUERY`）、客户端退出 Host 存活（`P02-FR2-CLIENT-EXIT`） | —（组合复验前序完整覆盖） |
| **T23**（本地 Host 不可改公网监听） | 监听覆盖参数/env 拒绝、Host/Origin 拒绝、实际绑定 `127.0.0.1` 的负例组合（`P02-FR2-AUTH-REJECT`） | —（组合复验前序完整覆盖） |
| **命令幂等**（PRD「T26 命令幂等」） | 重放复用原回执零副作用、异摘要 `conflict`、超时先查回执、一次副作用（`P02-FR2-COMMAND-CONFLICT`） | —（P02-2 已完整认领语义，本阶段复验） |
| **设计 09 T26（配置 CAS）** | 仅回归复用：insert-only、`expectedRevision`、`stale_dependency`、配置竞争（P01-4/P02-2 子集，`P02-FR1-SHARED-STATE` 引用） | 配置历史版本表、跨层策略编排、计划修改越过活动执行/过期审批（无执行域） |

### 4.1 T26 编号不一致记录（沿用 P02-1 §15.4 / P02-2 §14.3 结论，按行为映射）

- PRD（p02-acceptance §3.3 与 P02-1/P02-2/P02-3 各 PRD）写「T26 命令幂等」；设计 09 §2 的
  T26 原文为「当前配置 CAS 冲突、计划修改禁止越过活动执行、过期审批失效」，其重复请求语义
  另由 T03 承载；命令幂等由设计 08/12 独立规定（`commandId` + 请求摘要 + 持久回执）。
- **编号差异是文档问题**：PRD 的 T26（命令幂等）与设计 09 的 T26（配置 CAS）是两个不同事项。
  本契约按具体行为分别映射（上表两行），不据此增减任何行为、不宣称完整索引已验收；核对请求
  继续携带（§8），待负责人给出统一编号结论。

---

## 5. 平台、版本与依赖锁定

- 正式验收限 **macOS**；Windows/WSL/Linux 不作为当前通过条件。
- 沿用 P01 锁定版本，不隐式升级：Node `22.19.0`、npm `10.9.3`、TypeScript `7.0.2`、
  Vitest `5.0.3`、`better-sqlite3` `13.0.3`、`drizzle-orm` `0.45.3`、
  `@types/better-sqlite3` `9.6.0`、`@types/node` `22.20.4`；`package-lock.json`
  `lockfileVersion` 为 `3`；包管理器固定 `npm`。本地状态继续 **better-sqlite3 + Drizzle**，
  制品正文存受控文件。新增依赖须明确授权并更新锁文件。
- 正式验收命令应在**无 `node_modules`/`dist` 残留的干净源码快照**中 `npm ci` 后执行（F-012）。

---

## 6. 非目标与边界

本次**无**以下能力，验收不得依赖也不得宣称已实现：

- **Work/Pi 模型调用**（Work/Batch/Run/Attempt、DAG 调度、Scheduler/Runner、Pi SDK 与真实
  模型执行、FakeRuntime 仅可替代模型）；
- **Web**（托管 Chat、Web/Electron、配对界面）；
- **Profile 推断**（`project init` 的 Profile/技术栈推断）；
- **rebind**（移动 rebind、多 clone 归档）；
- **强沙箱**（强 OS 文件/进程沙箱；可信项目模式 ≠ 强沙箱，要求强隔离被明确拒绝不静默降级）；
- 其他后序阶段能力（审批流、通知投递、NAS/云端、非 macOS 平台、配置历史版本表、跨层策略编排）。

其他边界：

- 本阶段验收项可以修复前序问题，但不能降低门槛；阶段验收不依赖后续 Phase，也不提前实现
  后续 Phase 的占位接口。
- `npm run verify`（Feature 级）与 `npm run accept:p02`（阶段级，F-011 交付）为记录在案的
  执行要求：Feature 验证以 `npm run verify` 退出码为依据，阶段通过以 `accept:p02` 退出码与
  逐项证据为依据。**本轮不自动修改任何 Harness YAML / executor / agent 配置**，对齐由操作者
  在执行前核对（§7）。

---

## 7. 输入版本与验证策略交接

- PRD 输入：`input/p02-acceptance.md` v0.2（2026-10-01，「待审阅的需求文档」）；共同执行约束
  `execution-contract.md`（2026-10-01）。详细设计为 Harness 知识目录 `architecture-redesign/`
  （`core-design/08-host-api-and-cli.md`、`06-project-and-context.md`、`03-storage-and-transactions.md`、
  `09-testing-and-implementation.md`、`08-migration-roadmap.md` 等；不在本仓库，版本以内容哈希
  固化于各前序契约 §17）。
- 仓库级默认验证为 `npm test`；`npm run verify`（锁文件预检 + test/typecheck/build 串联，
  fail-closed）为工程检查编排；边界 `npm run check:boundaries`。
- **建议 Harness 将本仓库验收命令对齐为 `npm run verify`（Feature）与 `npm run accept:p02`
  （阶段）**，以退出码为通过依据。本任务未自动修改任何 executor/agent/YAML 配置。

---

## 8. 已记录的设计张力与待核对项（不静默改变语义）

P02-4 只**记录并携带**前序已登记的核对请求，不在本阶段静默决定；实施中如再发现接口/领域语义
冲突，先记录并请求核对。与前序一致、对 P02-4 直接相关的张力（详见各前序契约对应章节）：

1. **T26 编号不一致**（P02-1 §15.4、P02-2 §14.3、P02-3 §14.3，本契约 §4.1）：PRD「T26 命令
   幂等」vs 设计 09 T26「配置 CAS」；按行为映射，**请求核对**统一编号。
2. **注册前无 projectId：信封 scope 三态与 `command_receipts.project_id` 可空**
   （P02-2 §15.1）：与设计 08/11 候选字段不一致，**请求核对**。
3. **全局配置/全局事件的授权范围**（P02-2 §15.2）：独立能力位的划分，**请求核对**。
4. **P01 首次创建不写事件 vs 命令路径创建事件**（P02-2 §15.3）：创建事件只在命令提交路径
   写入，**请求核对**。
5. **inspect 身份/权限范围、独立授权输入、当前工作区基线（无隔离副本）、状态映射（未知脚本
   →`error`、停止未确认→`inconclusive`+占用保留）、线消息升 v3、`accepted`+operationId 异步
   模型、证据内容读取路由、基线作用域表 vs 设计 11 通用验证表**（P02-3 §15.1 ~ §15.10）：
   均按前序契约冻结行为实施，**保持待核对**。
6. **CLI 顶层帮助文案漂移（本阶段开工实测发现）**：`shiploop` 无参数错误提示与 `host --help`
   边界行仍写「本版本仅提供 host 生命周期命令/shiploop host start/status/stop」（P02-1 文案），
   实际命令面已含 `project/config/receipt/events/baseline`（应用面自身文案正确）。属用户可见
   帮助文案漂移，非领域语义变化；F-001 不改产品代码，**记录并请求核对**（可由后续文档/文案
   任务修正并补回归）。
7. **验收工具约定**（沿用 P01-4 §8-9）：设计未规定 `accept:p02` 的报告位置、`run-id` 形态、
   `configVersion` 与检查 ID 集合；本契约为实施值，**请求核对**；若设计给出不同约定，应由
   显式变更同步本文、报告 Schema 与测试。

未列入的矛盾按「已有契约优先复用」处理；不得由实施任务静默改变领域语义。

---

## 9. 复核

- 基线：§1.3（`npm ci` 退出 0；`npm run verify` 退出 0，`PASS 3/3`；102 test files / 2713
  tests）。祖先链与分支/报告存在性由 §1.1 表格记录的 `git merge-base --is-ancestor` 实测。
- 本文引用的真实入口、常量、检查 ID 集合与测试文件由
  [docs-p02-4-acceptance-contract.test.ts](../test/docs-p02-4-acceptance-contract.test.ts)
  交叉核对，防止文档与实现漂移。
- 本 Feature 只交付验收约定与检查清单（文档 + 守护测试）；夹具、场景、报告、配置、
  `accept:p02` 与阶段最终报告由 F-002 ~ F-014 交付。本轮不自动修改任何 Harness 配置；
  未验收平台、Pi/模型 Live、强 OS 沙箱与后序能力明确为 `not_run`/未支持。
