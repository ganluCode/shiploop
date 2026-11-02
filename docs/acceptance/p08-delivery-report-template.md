# P08 一期交付报告模板与填写规则

复制本模板为一次 P08 运行的报告草稿；机器可读结果由 `npm run accept:p08` 发布。尖括号
`<...>` 为待填项。没有实测的项填 `not_run` 并写原因，**不得留空、不得估算、不得把
`not_run`/`deferred` 写成通过**。

本模板不产生验收结论。代码 commit 存在、测试数量、日志中的成功文字、`nezha task report`
的 completed 或文档完整都不能替代 [负责人 walkthrough](p08-owner-walkthrough.md) 的签署。
默认入口不调用真实模型；live 证据只做 import-only 核对。

## 1. 报告身份与受测代码

| 字段 | 值 |
| --- | --- |
| 报告类型 | `shiploop.p08.acceptance-report` |
| 运行 ID `runId` | `<run-id>` |
| 受测 commit | `<40 位小写十六进制 SHA>` |
| 受测 tree | `<tree SHA>` |
| 分支 | `<branch>` |
| 工作树状态 | `clean` / `dirty（拒绝运行，见 §3）` |
| 输入摘要 `inputsDigest` | `<64 位小写十六进制>` |
| 检查清单摘要 `checklistDigest` | `<64 位小写十六进制>` |
| 记录时间（UTC） | `<YYYY-MM-DDThh:mm:ssZ>` |
| 操作身份 / 审阅人 | `<姓名或角色>` / `<姓名或 pending>` |

身份三件套（`runId`、`testedCommit`、`inputsDigest`）必须与报告、前置交付、安装清单、
两类 live 证据和人工门禁记录完全一致；不一致按失败处理，不用旧报告或旧制品补位。

## 2. 工具链与平台

本节记录实际工具版本与运行平台；报告不得用其他机器的版本代替。

| 字段 | 值 |
| --- | --- |
| 平台 | `darwin`（macOS） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| 包管理器 | `npm@10.9.3` |
| 锁文件 | `package-lock.json`（`lockfileVersion: 3`） |
| 锁文件摘要 | `<sha256>` |

非 macOS、非上述 Node/npm 的运行不能被记为本期通过；跨平台结果另行验收。

## 3. 范围与预算

| 字段 | 值 |
| --- | --- |
| 范围策略 | `p08-impact-and-required-regressions` / `full-trusted-union` |
| 选中测试文件数 | `<n>`（逐文件列在 §4） |
| 必需底层回归 | `<n>`（P05 规划 e2e、P07 关闭循环、P08-2/3 存量、Git 对账、崩溃窗口、证据完整性、本地 pack 等） |
| `deferred` 历史文件数 | `<n>`（逐项保留原因，不参与通过计数） |
| 全仓历史回归 | `not_run`（默认）/ `selected`（仅 `--full-regression` 显式开启） |
| 单步预算 | `900000` ms（15 分钟） |
| 总预算 | `7200000` ms（2 小时） |
| 并发 | 步骤串行；隔离测试文件最多 2 个 worker |
| 网络 / 真实模型 | 默认拒绝/不调用；live 仅 import-only，真实模型需独立授权入口 |
| 明确不执行的检查 | `<全仓、历史矩阵、live、Phase 集成等，附原因>` |

超时用工具真实退出码（如 124）记录并注明超时点；不得为通过而放宽超时重跑。`deferred`
项不是失败也不是通过，只是不在本次影响边界内。

## 4. 实际命令与退出码

每条命令一行；日志使用报告根内的相对路径，保留真实退出码与耗时。`0` 不代表证据存在：
缺少制品或日志时按 `inconclusive`/`not_run` 记录。

| # | 时间（UTC） | 工作目录范围 | 命令（argv） | 退出码 | 耗时 | 日志相对路径 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `<time>` | `<repo>` | `npm run accept:p08 -- --run-id <run-id> --expected-commit <sha>` | `<0/1/124>` | `<ms>` | `runs/<run-id>/entry-result.json` | `pass/fail/not_run/inconclusive` |
| 2 | `<time>` | `<repo>` | `git status --porcelain` | `0` | `<ms>` | `runs/<run-id>/source/entry/run.json` | `pass` |
| 3 | `<time>` | `<repo>` | `<定向测试 argv>` | `<0/1>` | `<ms>` | `<相对日志路径>` | `pass/fail` |

报告根固定为 `artifacts/acceptance/p08/`：运行工作目录 `runs/<runId>/`、步骤日志与身份文件在
`step-run/` 与 `source/`，正式报告在 `reports/<runId>/report.json` 与 `summary.md`，重复
`runId` 的诊断在 `diagnostics/<runId>/`。运行目录 create-once，旧运行不被覆盖。

## 5. 分层验收结果

| 层级 | 状态 | 证据路径 | 说明 |
| --- | --- | --- | --- |
| 代码交付（commit/tree/diff） | `pass/fail/not_run` | `<commit 与报告>` | commit 存在 ≠ 验收通过 |
| Task 局部验证（unit） | `pass/fail/not_run` | `<日志与索引>` | 定向文件、实际退出码 |
| Task 局部验证（integration） | `pass/fail/not_run/inconclusive` | `<日志>` | 真实 Git/SQLite/Host/进程范围 |
| Feature 门禁（`task_union`） | `pass/fail/not_run/pending` | `<编排器记录>` | 独立复验，不是 Phase |
| Phase 集成（安装/确定性回归/两类项目） | `not_run` / `<...>` | `<证据>` | 跨层真实资源；未运行不得折算 |
| Live（Todo 与存量分开） | `not_run` / `<...>` | `<批准文件与报告引用>` | 独立授权；两类不可互相替代 |
| 人工门禁 `P08-MANUAL-OWNER-GATE` | `pending/confirmed/rejected` | `<manual gate record>` | 唯一签署依据；机器不能代签 |

宿主/框架状态（Nezha completed）、测试数量或日志成功文字只能作为开发过程信息，不能写入
“产品验收通过”。

## 6. 计数规则

| 计数项 | 数量 | 规则 |
| --- | --- | --- |
| `pass` | `<n>` | 必需项全部有可核验证据且通过 |
| `fail` | `<n>` | 有失败断言、身份/摘要不符或超时 |
| `not_run` | `<n>` | 未执行、缺授权或跨层证据缺失；不折算通过 |
| `deferred` | `<n>` | 不在影响边界的历史测试；单独计数，不参与通过 |
| 人工 pending | `<n>` | 负责人未确认项；不折算通过 |

计数只统计实际执行且有证据的条目。`phaseAccepted` 在负责人确认前必须为 `false`，
`ownerSignature` 必须为 `pending`。

## 7. 证据索引

| 证据 | `kind` | 相对路径 | 摘要（sha256） |
| --- | --- | --- | --- |
| 阶段报告 | `shiploop.p08.acceptance-report` | `reports/<run-id>/report.json` | `<sha256>` |
| 报告摘要 | `report` | `reports/<run-id>/summary.md` | `<sha256>` |
| 运行身份与范围 | `report` | `runs/<run-id>/inputs.json`、`runs/<run-id>/test-scope.json` | `<sha256>` |
| 安装清单 | `shiploop.p08.release-manifest` | `acceptance/p08-1.release-manifest.json` | `<sha256>` |
| 安装检查 | `install` | `runs/<run-id>/source/entry/installation.json` | `<sha256>` |
| Todo live | `shiploop.todo.live-evidence` | `<相对路径>` | `<sha256>` |
| 存量 live | `shiploop.brownfield.evidence-envelope` | `<相对路径>` | `<sha256>` |
| 人工门禁 | `shiploop.p08.manual-gate-record` | `<相对路径>` | `<sha256>` |

报告与制品只放仓库内相对引用和摘要；绝对路径、凭据、完整认证内容和模型完整 transcript
禁止入册。临时证据被删除后，报告仍应能用 `verifyP08ReportDirectory` 离线复核文件清单与哈希。

## 8. 人工状态与 Live 状态

| 字段 | 值 |
| --- | --- |
| 人工门禁状态 | `pending` / `confirmed` / `rejected` |
| 确认人（安全标识符） | `<owner>` |
| 确认时间（UTC） | `<time>` 或 `null` |
| Todo live 状态 | `not_run` / `pass` / `fail` |
| Todo live 授权 | `pending` / `granted` / `declined` / `not_run` |
| 存量 live 状态 | `not_run` / `pass` / `fail` |
| 存量 live 授权 | `pending` / `granted` / `declined` / `not_run` |

人工门禁记录的机器可读结构：

```json
{
  "schemaVersion": 1,
  "kind": "shiploop.p08.manual-gate-record",
  "identity": {
    "runId": "<run-id>",
    "testedCommit": "<40-hex>",
    "inputsDigest": "<64-hex>"
  },
  "owner": "<owner>",
  "status": "pending",
  "confirmedAtUtcMs": null,
  "notes": "<可选的脱敏说明>"
}
```

`confirmed` 必须提供确认时间；`pending`/`rejected` 不得被脚本改写为通过。Todo live 与存量
live 分别核对、互不替代；缺少授权或证据时保持 `not_run`，不用 FakeRuntime、夹具或另一类
live 报告补齐。

## 9. 遗留问题与未运行项

- 遗留问题：`<逐条列出：基线缺口 unresolved、未修失败、待确认契约、产品报告缺失>`；
- 未运行项：`<逐项列出原因与负责人>`；
- 已知失败是否被自动豁免：`no`（必须为 no）；
- 是否修改 Phase/Feature/Task 状态：`no`（报告工具不改状态）。

## 10. 敏感信息与报告卫生自检

- [ ] 无凭据、令牌、OAuth、Cookie 或完整认证内容；
- [ ] 无开发机绝对路径（仅相对证据路径与摘要）；
- [ ] 无模型完整 transcript 或原始大输出；
- [ ] 未运行项没有被写成 `passed`/`pass`；
- [ ] 未修改正式 Task/Feature/Phase 元数据，未自动 npm publish/push/merge；
- [ ] 未把文档、测试数量或 Nezha 状态当作签署依据。

## 11. 机器可读报告骨架

`report.json` 由报告聚合器生成，以下仅示意必填结构；不得手工改写派生计数或结论。
`testScope` 与 `counts` 是报告的一部分，`deferred` 只在 `testScope.deferred` 中逐项登记。

```json
{
  "schemaVersion": 1,
  "kind": "shiploop.p08.acceptance-report",
  "phase": "P08",
  "layer": "phase-acceptance",
  "identity": {
    "runId": "<run-id>",
    "testedCommit": "<40-hex>",
    "inputsDigest": "<64-hex>",
    "toolchain": { "node": "22.19.0", "npm": "10.9.3", "platform": "darwin" }
  },
  "checklistDigest": "<64-hex>",
  "testScope": {
    "policy": "p08-impact-and-required-regressions",
    "selected": ["test/modules/acceptance/p08-4-f008-docs.test.ts"],
    "selectedReasons": { "test/modules/acceptance/p08-4-f008-docs.test.ts": "<reason>" },
    "requiredRegressions": [],
    "deferred": [{ "file": "<relative test path>", "status": "not_run", "reason": "<reason>", "source": "trusted-index-union" }],
    "fullRegression": { "enabled": false, "status": "not_run", "command": ["npm", "test"], "reason": "<reason>" }
  },
  "counts": { "pass": 0, "fail": 0, "not_run": 0 },
  "layers": [{ "id": "phase-integration", "status": "not_run", "counts": { "pass": 0, "fail": 0, "not_run": 1 }, "checkIds": ["P08-DETERMINISTIC-PHASE-REGRESSION"] }],
  "checks": [{ "id": "P08-MANUAL-OWNER-GATE", "execution": "manual", "status": "not_run", "reason": "owner_pending" }],
  "productReports": [],
  "blockingIssues": ["<issue>"],
  "knownGaps": ["<gap>"],
  "conclusion": "fail",
  "exitCode": 1,
  "baseline": { "candidateCommit": "<40-hex>", "phaseAccepted": false, "ownerSignature": "pending", "note": "<note>" }
}
```

## 12. 结论与签署

| 字段 | 值 |
| --- | --- |
| 报告结论 | `pass` / `fail`（由冻结清单与证据派生） |
| 入口退出码 | `<0/1>` |
| 可作为下一阶段候选基线的 commit | `<commit>` 或 `none` |
| 负责人确认 | `pending`（默认） / `confirmed` / `rejected` |
| 签署人 / 时间（UTC） | `<姓名>` / `<time>` |

只有负责人按同一身份封套核对实际命令、退出码、证据、清理事实并明确确认后，Phase 才能
签署；`accept:p08`、测试、文档或 `nezha task report` 都不能自动生成签署。
