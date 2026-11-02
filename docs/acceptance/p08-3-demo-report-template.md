# P08-3 非 Nezha 存量演示结果报告模板

复制本模板为一次演示的报告文件；配套流程见
[P08-3 非 Nezha 存量演示运行手册](p08-3-existing-demo-runbook.md)。尖括号 `<...>` 为待填项；
没有实测的项填 `not_run` 并写原因，**不得留空、不得估算、不得把 `not_run` 写成通过**。

## 0. 报告身份

| 字段 | 值 |
| --- | --- |
| 报告类型 | `shiploop.p08-3.existing-demo-report` |
| 演示 ID / 运行 ID | `<demo-id>` |
| 记录时间（UTC） | `<YYYY-MM-DDThh:mm:ssZ>` |
| 操作身份 | `<执行者姓名/角色>` |
| 审阅/负责人 | `<姓名或 pending>` |
| 关联需求/Feature/Task | `<需求 ID / Feature / Task>` |
| 仓库标签 | `<repositoryLabel>` |
| 项目身份 `projectId` | `<projectId>` |
| 仓库路径摘要 | `<sha256>` |

不写入仓库绝对路径；路径摘要用于身份核对，不用于定位文件。

## 1. 代码与工具身份

| 字段 | 值 |
| --- | --- |
| 分支 | `<branch>` |
| 演示前 `HEAD` / `tree` | `<commit>` / `<tree>` |
| 增量提交 `commit` / `tree` | `<commit>` / `<tree>` |
| Node 版本 | `<node --version>` |
| npm 版本 | `<npm --version>` |
| 平台 | `darwin` / `<platform>` |
| 锁文件摘要 | `package-lock.json` `<sha256>` |
| 工作树状态 | `clean` / `dirty（见 §2）` |

## 2. 准备快照与基线

| 字段 | 值 |
| --- | --- |
| `HEAD` / `tree` | `<commit>` / `<tree>` |
| `git status --porcelain` | `<原文摘要>` |
| 脏文件（分类 + 摘要） | `<path> / modified_staged｜modified_unstaged｜untracked / <sha256>` |
| 仓库外无关旧状态文件摘要 | `<sha256>` |
| 基线检查命令 | `<argv>` |
| 基线检查退出码 | `<0/非 0/not_run>` |
| 已知失败 ID（`known_failure`） | `<check-id>` |
| 初始化保护核对 | `HEAD 未变` / `脏状态未变` / `未自动提交`（逐项打勾或写明不符） |

已知失败必须保留在 `baselineGaps` 中，状态 `unresolved`；新需求通过不得自动豁免旧失败。

## 3. 需求与批准范围

| 字段 | 值 |
| --- | --- |
| 需求说明 | `<一句话>` |
| 批准路径（code） | `<path>` |
| 批准路径（test） | `<path>` |
| 显式确认依据 | `<确认命令/时间/确认人>` |
| 越界路径 | `<none>` / `<path（越界即失败）>` |
| 允许的检查范围 | `<argv 列表或检查 ID>` |
| 明确不执行的检查 | `<全仓/历史矩阵等，附原因>` |

## 4. 命令与退出码明细

每条命令一行；日志按报告根内相对路径记录，保留真实退出码与耗时。`0` 不代表证据存在：
缺少制品或日志时按 `inconclusive` 记录。

| # | 时间（UTC） | 工作目录范围 | 命令（argv） | 退出码 | 日志路径 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `<time>` | `<repo/demo-root>` | `<node scripts/run-tests.ts ...>` | `<0/1/124/not_run>` | `<logs/01.log>` | `passed/failed/not_run/inconclusive` |
| 2 | `<time>` | `<repo/demo-root>` | `<git status --porcelain>` | `<0>` | `<logs/02.log>` | `passed` |

超时用工具真实退出码（如 124）记录，并注明超时点；不得为通过而放宽超时重跑。

## 5. 分层验收结果

| 层级 | 状态 | 证据路径 | 说明 |
| --- | --- | --- | --- |
| 代码交付（commit/tree、diff） | `passed/failed/not_run` | `<evidence>` | `<commit 存在≠验收>` |
| Task 局部验证（unit） | `passed/failed/not_run` | `<logs/...>` | `<定向文件与退出码>` |
| Task 局部验证（integration） | `passed/failed/not_run/inconclusive` | `<logs/...>` | `<真实 Git/SQLite/Host/进程范围>` |
| Feature 门禁（`task_union`） | `passed/failed/not_run/pending` | `<编排器记录>` | `<独立复验，不是 Phase>` |
| Phase 真实 Git/SQLite/Host/进程集成验收 | `not_run` / `<...>` | `<evidence>` | `<负责人独立执行；当前仓库无阶段入口>` |
| 真实 Pi live | `not_run` / `<...>` | `<批准文件与报告引用>` | `<独立授权；provider/model/次数/预算>` |

Nezha completed、测试数量、成功日志都不得写入「产品验收通过」一栏。

## 6. 结果计数与遗留问题

| 计数项 | 数量 |
| --- | --- |
| `passed` | `<n>` |
| `failed` | `<n>` |
| `not_run` | `<n>` |
| `inconclusive` | `<n>` |
| 人工 pending | `<n>` |

- 遗留问题：`<逐条列出，含基线缺口 unresolved、未修失败、待确认契约>`；
- 未运行项：`<逐项列出原因与负责人>`；
- 已知失败是否被自动豁免：`no`（必须为 no）。

计数只统计实际执行且有证据的条目；未运行项单独计数，不并入 `passed`。

## 7. 证据索引

| 证据 | 类型/kind | 相对路径 | 摘要（sha256） |
| --- | --- | --- | --- |
| 演示报告 | `shiploop.p08-3.existing-demo-report` | `<report.json>` | `<sha256>` |
| 存量增量契约报告 | `shiploop.existing-repo.incremental-evidence` | `<path>` | `<sha256>` |
| 日志 | `<tool>` | `<logs/01.log>` | `<sha256>` |

报告与制品只放相对引用与摘要；绝对路径、凭据与完整认证内容禁止入册。

## 8. 真实 Pi live 授权状态

| 字段 | 值 |
| --- | --- |
| 是否请求真实模型执行 | `yes/no` |
| 授权状态 | `pending / granted / declined / not_run` |
| provider / model | `<provider/model>` |
| 次数与总时长预算 | `<max tasks>` / `<total timeout>` |
| 批准依据 | `<批准文件标识（不写绝对路径、不写密钥）>` |
| 实际调用次数与用量 | `<n>` / `<usage>` |
| 结论 | `passed / failed / not_run` |

未授权、未执行或预算耗尽一律 `not_run`/`failed`，不得用普通测试、夹具或 FakeRuntime 结果代替。

## 9. 清理与停止确认

| 字段 | 值 |
| --- | --- |
| Host 是否已停止 | `yes/no/not_run` |
| 进程停止确认证据 | `<path>` |
| 临时仓库/数据根清理 | `done / not_run` |
| 用户仓库保留情况 | `<未改动 / 仅增量提交>` |
| 预存脏文件摘要核对 | `unchanged / changed（说明）` |
| 清理后仓库外旧状态摘要 | `<sha256>` |

停止未确认时不得开始新 Run、不得释放工作区；把事实写进本表并标记 `not_run`。

## 10. 敏感信息与报告卫生自检

- [ ] 无凭据、令牌、OAuth 或完整认证内容；
- [ ] 无绝对路径（仅仓库路径摘要与相对证据路径）；
- [ ] 无模型完整 transcript 或原始大输出；
- [ ] 未运行项没有被写成 `passed`；
- [ ] 未修改 P08-4 阶段报告，未声称阶段集成已执行。

## 11. 结论与签署

| 字段 | 值 |
| --- | --- |
| 本次演示结论 | `passed / failed / inconclusive / not_run` |
| 结论理由 | `<一句话>` |
| 可作为下一阶段基线的 commit | `<commit>` 或 `none` |
| 负责人确认 | `pending`（默认） / `confirmed` |
| 签署人 / 时间（UTC） | `<姓名>` / `<time>` |

负责人未签署时保持 `pending`；自动流程与文档测试都不能代签，也不能把 `pending` 折算为通过。
