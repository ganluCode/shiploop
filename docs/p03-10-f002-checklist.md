# P03-10 / F-002 P03 阶段验收检查清单与受校验配置

本任务交付 P03 阶段验收的**机器可读检查清单**与**受校验配置**，固定 FR、验收编号（T 编号）与证据要求的映射。只新增验收工具输入与校验代码，不改产品实现、依赖、迁移或 Host/CLI 契约。

## 交付物

| 路径 | 内容 |
| --- | --- |
| `acceptance/p03.checklist.json` | 机器可读检查清单（checklistVersion=1）：33 项 = 30 必需 + 3 deferred |
| `acceptance/p03.config.json` | 阶段验收配置（configVersion=1）：必需检查、版本约束、预算、Fake 身份、临时资源、报告范围 |
| `scripts/acceptance/p03-config.ts` | 冻结基线与 fail-closed 校验（`validateP03Checklist` / `validateP03AcceptanceConfig` / `loadP03*` / `summarizeP03Checklist`） |
| `test/modules/acceptance/p03-10-checklist-config.test.ts` | 8 个稳定 `[case:...]` 用例，索引登记于 `test/index/phases/P03/features/P03-10/tasks/F-002.json` |

## 清单结构与 ID 规则

每项含稳定 ID（`P03-` 前缀）、group、title、验证层次 layer、FR 映射 fr、验收编号映射 acceptanceRefs、必需断言 assertions、证据类别 evidence；T38/T40 另有 `coverage: partial` 与 `coverageNote`，deferred 项另有 `deferredStatus`。

- **group**：`fr`（FR-1～FR-3 的正常与关键负例，6 项）、`acceptance`（T 编号，19 项）、`vertical`（必需纵向演示，5 项）、`deferred`（范围外，3 项）。
- **layer**（区分单元测试、Feature 集成与阶段验收）：`unit`（P03-T24、P03-T38）、`feature-integration`（T 编号场景组）、`phase-acceptance`（FR 与纵向演示）。
- **evidence**（证据类别词汇表）：`command-exit`、`sqlite`、`git`、`process`、`artifact`、`report`、`manifest`。
- 覆盖判定按**必需断言**核对，**不按测试数量**判断覆盖。

## FR 映射

| FR | 正常项 | 关键负例项 |
| --- | --- | --- |
| FR-1 阶段纵向验收 | `P03-FR1-CLOSED-LOOP` | `P03-FR1-NEG-INTEGRITY`（失败/未运行/缺输出/真假执行混淆记 fail 或 not_run） |
| FR-2 实战负例与清理 | `P03-FR2-MATRIX`（场景矩阵、cleanup manifest、支持限制） | `P03-FR2-NEG-GUARDRAILS`（人工未批/最终失败不放行、停止不确定隔离、异常不误扣返工） |
| FR-3 可审阅执行报告 | `P03-FR3-REPORT` | `P03-FR3-NEG-REPORT-INTEGRITY`（partial/去重/不反写通过） |

## 验收编号（T 编号）映射

必需全覆盖：T02、T03、T04、T06、T07、T08、T13、T21、T24、T25、T26、T29、T31、T35、T36、T37、T39，分别对应 `P03-Txx` 检查项（含必需断言与证据类别）。

- **T38 仅报告结构**（`P03-T38`，coverage=partial）：只验证完整 Task 视图、尝试去重与汇总字段结构；真实模型汇总、加权缓存率由 P04/P07 兑现。
- **T40 仅通用恢复决策**（`P03-T40`，coverage=partial）：只验证同 Task 续接/新 Attempt/拒绝复用的 Core 决策与活跃旧进程拒绝重叠；Pi SDK 原生续接、换模型与原生检查点在 P04 验证。

## 必需纵向演示（5 项）

| ID | 演示 | 映射 |
| --- | --- | --- |
| `P03-VERT-COMPLETE` | 完成闭环（三 Task 链、增量返工、门禁与收尾提交） | FR-1 / T04·T07·T08 |
| `P03-VERT-BUDGET-EXHAUSTED` | 预算耗尽（拒绝新增工作、预算不清零） | FR-2 / T13·T21 |
| `P03-VERT-MANUAL-BLOCK` | 人工阻塞（全绿不放行、解除需授权） | FR-2 / T39 |
| `P03-VERT-FINAL-FAIL` | 最终检查失败（Task 通过与最终验收失败分离） | FR-1·FR-2 / T36·T07 |
| `P03-VERT-RETRY-FINAL` | 仅收尾重试（零 Runtime 启动增量、不重复提交） | FR-1 / T36 |

## 配置约束（`acceptance/p03.config.json`）

- **版本约束**：沿用 npm 和 P01/P02 冻结约束（`toolchain`：node `22.19.0`、npm `10.9.3`、`npm@10.9.3`、`package-lock.json`），与 root `package.json` engines/packageManager 逐字段核对；不改写包管理器或工具版本。
- **有限预算**：`timeouts.stepMs`/`overallMs` 为有限正毫秒（1,000～7,200,000，overallMs ≥ stepMs）；`maxCommandOutputBytes` 有上下限（1,024～16 MiB）。0/Infinity/NaN/字符串一律拒绝。
- **显式 Fake 身份**：`fakeIdentity` 固定 `fake-provider`/`fake-model`/`realModel=false`/`network=denied`；不得冒充真实模型或 live。
- **临时资源**：`tempResources` 全部为隔离临时资源（git/sqlite/dataRoot/home = `temp`，`reusePrevious=false`）；不得复用上次资源或写入开发机路径。
- **报告范围**：`reportRoot=artifacts/acceptance/p03`；`reportScope.statuses=[pass, fail, not_run]`、`includeEvidenceHash`、`includeManualChecklist` 为真，`deferredCountsAsPassed=false`。
- **必需检查**：`requiredChecks` 恰好为 30 个必需 ID（顺序固定），deferred ID 不得列入。

## 校验规则（fail-closed，全部 `invalid_config`）

1. 无效配置：未知 configVersion/字段、非对象、路径逃逸/绝对路径、非有限或越界预算与输出上限、overallMs < stepMs。
2. 检查 ID：重复、未知、deferred ID 混入 requiredChecks、缺失必需项、重排必需项一律拒绝。
3. 试图减少必需项：从清单移除冻结检查、删减必需断言、改写 FR/T 映射、改写证据类别、降级/升格验证层次、解除 T38/T40 的 partial 限定、把必需项降级为 deferred、把 deferred 改为计入通过，一律拒绝。
4. 配置是**验收工具输入**：`schemaVersions`/`migrations`/`settings`/`database`/`productConfig` 等业务配置键与凭据形态字段（token/secret/…）一律拒绝，不新增业务版本表或第二套产品配置体系。

## deferred（不在本期通过范围）

| ID | 状态 | 说明 |
| --- | --- | --- |
| `P03-OOS-LIVE-PI` | not_run | 真实 Pi/live、凭据与真实模型用量验收不在本期范围，未运行显示 not_run，不折算已通过 |
| `P03-OOS-STRONG-SANDBOX` | postponed | 强 OS 沙箱后置，可信项目模式边界如实呈现 |
| `P03-OOS-LATER-CAPABILITIES` | postponed | 真实模型汇总、加权缓存率、Token/费用收益及 Chat/桌面/通知/发布等后序能力后置 |

deferred 项不出现在 `requiredChecks`，`summarizeP03Checklist` 只把必需项列入 countedChecks；未运行项显示 not_run 或明确后置，均不参与 P03 已通过计数。

## 边界

- 本配置/清单是验收工具输入（`scripts/acceptance/`，不进 `packages/`），不新增业务版本表或第二套产品配置体系。
- 不调用模型、不联网、不读取用户凭据、不修改业务数据；校验只读 JSON。
- 本任务不交付 `accept:p03` 控制器与阶段报告聚合（后续任务交付），只固定它们共同消费的清单与配置契约。
- 证据与本地日志见 Feature workspace `verifications/F-002/runtime-logs/`；更广回归由 Nezha 独立执行。
