# F-016 P03 阶段报告聚合、证据索引与严格退出结论

本任务复用 P01/P02 的验收报告机制，新增 P03 专属的报告模块
`scripts/acceptance/p03-report.ts`。它是 `accept:p03` 控制器（F-017）的输入/输出层：
负责把 P03 检查清单（F-002 冻结）中的逐项结果、清理证据和完整产品 Feature 报告引用
聚合成一次独立 run 的机器报告与可审阅摘要，并给出 fail-closed 退出码。

不修改产品代码、Host/CLI 契约、依赖或迁移；不调用模型、不联网。

## 交付物

| 路径 | 内容 |
| --- | --- |
| `scripts/acceptance/p03-report.ts` | P03 阶段报告 Schema v1、严格聚合、阶段门禁、证据清单、脱敏、run-id、写出与落盘重验 |
| `test/modules/acceptance/p03-10-phase-report.test.ts` | 6 个稳定 `[case:...]` 用例 |
| `test/index/phases/P03/features/P03-10/tasks/F-016.json` | Task 测试索引（v2，按 case 选择） |
| `docs/p03-10-f016-phase-report.md` | 本交接 |
| Feature workspace `verifications/F-016/test-selection.json` | Harness 选择清单（引用仓库 v2 索引） |

## 分层

| 层 | 载体 | 本任务职责 |
| --- | --- | --- |
| 阶段验收报告 | `reportLayer: "phase-acceptance"`，`report.json`/`summary.md` | 清单逐项状态、FR/T 映射、证据、清理、产品报告引用、退出结论 |
| 产品 Feature 执行报告 | Core/Host/CLI `feature-execution-report` 投影（F-004～F-006） | 仅以 `productReports[]` 引用完整报告证据（`evidenceRef` + hash/size），不复制正文、不反写产品状态 |

`summary.md` 首行显式声明两者分层；阶段检查表带 `layer`（unit /
feature-integration / phase-acceptance）、`fr`、`acceptanceRefs`（T 编号）。

## 报告字段（Schema v1）

- 输入计划：`plan.phaseId/stepId/title/scope/version/contractDoc`，
  `digestSha256`（输入计划摘要）与 `checklistDigestSha256`（清单摘要）。
- 受测事实：`git.commit/worktree/branch/priorBaselines`、`platform`、`tools`
  （node/npm/git/sqlite/better-sqlite3/drizzle-orm）、`fakeIdentity`（冻结 Fake）。
- 命令：`commands[].label/argv/cwd（逻辑位置）/exitCode/durationMs/timedOut`。
- 检查：清单顺序的 30 个必需项；每项含 `checklistAssertions`（冻结断言文本）、
  `evidenceCategories`、`assertions`（真实状态断言 ID + 结果）、`sideEffectVerified`、
  `executionMode`、`status`、`notRunReason`、`evidenceRefs`、`coverage/coverageNote`。
- 计数与结论：`counts{pass,fail,not_run,total}` 与 `conclusion`；重验时按清单重算。
- 证据：`evidence[]` 含 `identity`（稳定身份）、`category`、相对 `path`、`sha256`、
  `sizeBytes`、`checkId`、`capturedBeforeCleanup`。
- 清理：`cleanup{confirmed,processesGone,manifestEvidenceRefs,notes}`。
- 分层引用：`productReports[]{featureId,label,command,evidenceRef}`。
- 遗留问题：`openIssues[]{id,summary,blocking}`；`blocking=true` 使结论非零。
- `deferred[]` 来自清单 deferred 项（not_run/postponed），不计入 pass。

## 通过门禁（fail-closed）

聚合（`aggregateP03CheckResults`）：

1. 未知/重复检查 ID 抛 `unknown_check`/`duplicate_check`；缺失必需项记
   `not_run/missing_result`；not_run 必须有明确分类
   （`missing_result/preparation_failure/missing_output/timeout/skipped`）。
2. 任何 `pass`（正常或预期负例）必须：至少一条断言且全部满足、
   `sideEffectVerified=true`、`executionMode="fake"`。缺断言、断言不满足、
   副作用未核对、`live` 执行（真假执行混淆）一律降级 `fail`；仅 `detail`/
   logger 文本不能构成通过。

阶段门禁（`evaluateP03PhaseConclusion`）：

3. 每个必需检查有证据引用，且覆盖清单声明的全部证据类别；证据 `checkId` 不得
   跨检查复用，未被引用的证据不得静默聚合。
4. 清理前必须导出 `sqlite`、`git`、`process`、`manifest` 四类证据
   （`capturedBeforeCleanup=true`）。
5. `cleanup.confirmed=true`、`cleanup.processesGone=true`，且
   `manifestEvidenceRefs` 指向 `manifest` 类别、清理前导出的证据。
6. 至少一个 `productReports[]`，其证据存在、类别为 `report`、清理前导出。
7. 任一阻塞遗留问题使结论 `fail`。

退出码（`computeP03PhaseExitCode`）：仅当结论 pass、落盘证据/报告重验成功且
cleanup 已确认时为 0；其余为 1。写入失败抛 `report_write_failed`；写出后立即
`verifyP03ReportDirectory` 重验 Schema、计数/结论、run-id、证据 size/sha256。

## 脱敏与证据完整性

- `writeP03AcceptanceReport({sensitiveValues})` 在写盘前统一脱敏证据文本、
  `report.json` 与 `summary.md`，并对三者做敏感值复核、凭据键名/Bearer 形状扫描、
  开发机绝对路径扫描（`/Users/…`、`/home/…`、`C:\Users\…`）。
  未登记敏感值且无法脱敏的命中以 `secret_leak`/`absolute_path_leak` 明确失败。
- 证据 hash/size 在脱敏后按实际写盘字节计算；重验读取磁盘字节复核。
- 路径只允许报告目录内 `evidence/…` 相对路径；`..`、绝对路径、反斜杠、
  重复 identity/path 一律拒绝。
- 每次运行独立 `<reportRoot>/<run-id>/`，已存在 run-id 拒绝覆盖。

## F-017 接入建议

1. 读取 `loadP03Checklist()` 与 `loadP03AcceptanceConfig()`；由场景结果构造
   `P03PhaseReportInput.results`，为每个必需检查附真实断言与副作用核对。
2. 在清理临时资源**前**采集 SQLite/Git/进程导出与 cleanup manifest，连同各检查
   证据（声明的每个类别至少一项）作为 `evidenceFiles` 传入；产品 Feature 报告
   通过 `shiploop feature report <featureId> --project <projectId> --json` 输出作为
   `category: "report"` 证据，并登记 `productReports`。
3. 传入合成凭据、仓库根/临时目录等 `sensitiveValues`，命令记录使用逻辑 argv/cwd。
4. 以 `writeP03AcceptanceReport(...).exitCode` 作为 `accept:p03` 退出码；失败仍保留
   报告与证据供审阅，但不得宣称通过。

## 验证

本地：`test/modules/acceptance/p03-10-phase-report.test.ts` 6 个 case 覆盖分层/
清单映射、严格 pass 门禁、not_run 分类、证据完整性、cleanup/产品报告门禁和
脱敏/run-id；`npm run typecheck` 通过。完整日志与 selection 见 Feature workspace
`verifications/F-016/`。较广回归、Feature/Phase 验收由 Nezha 独立执行。

不声明 Pi/live、强沙箱或真实模型用量通过；deferred 项保持 not_run/postponed。
