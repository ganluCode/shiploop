# F-006：执行报告可审阅文本视图与人工操作提示

复用 F-004/F-005 的同一 `feature-execution-report` 报告投影，新增 CLI 纯视图层：

```text
packages/cli/src/app/report.ts
  buildFeatureReportTextView(report) -> FeatureReportTextView
  formatFeatureReportTextView(view)  -> string
shiploop feature report <featureId> --project <uuid> [--json]
```

`--json` 信封与 Core 投影逐字段一致（不变）；不带 `--json` 的文本输出改为
可审阅文本视图，取代此前的 JSON 倾倒。视图为纯函数：不读时钟、不写任何业务
状态，同一报告重复生成语义稳定、不重复行或计数；文本由报告投影重新生成，
不追加历史报告内容。

## 文本视图结构

- **Task 表**：完整、稳定排序（taskId 升序），区分最新状态（latest
  Attempt/状态）与累计次数（cumulative.attempts/byStatus/reworks）；
- **Attempt 历史**：按 Task 分组、number/id 稳定排序；每条含各 Run 归属、
  exitCode/signal/耗时、Session、rework/recovery、证据与诊断计数；
  缺失字段显示 `unknown`，不以 0 冒充；
- **Run 记录 / Session 记录**：各 Run 独立列示，历史计数不合并；
- **最终检查**：独立 VerificationBatch 与逐检查结果（机器轴，注明机器结果
  不构成人工批准）；
- **人工批准/阻塞**：审批轴状态、原因、逐事项（含决定/理由/描述）；
  未批准但机器全绿时 `waiting=true` 并显示「保持等待」，不显示已通过，
  也不建议跳过人审；
- **要求的交付状态**：`requiredStatus`（Feature deliveryStatus）与交付轴、
  Git operation 事实分列；
- **证据引用**：仅稳定身份与 availability（ready/missing/unavailable），
  不含正文或路径；
- **下一步显式操作**：outcome.nextStep 派生的人工/授权命令动作，
  全部 `automatic=false`，绝不暗示自动重跑编码或自动放行；
- **时间与指标标识**：累计 Session 时间（含重叠）与墙钟时间分列，边界缺失
  为 unknown；`basis=fake-synthetic` 标识 Fake 合成指标；声明不计算加权
  缓存率、不生成真实模型分组收益、余额或节省额度结论（真实费用聚合属
  后续阶段）。

## 验证交接

新增模块用例 `test/modules/cli/p03-10-feature-report-text.test.ts` 四个
`[case:...]`：三项以上 Task、失败后成功、取消与缺历史字段的稳定 Task 表/
Attempt 历史与各 Run 归属；未批准机器全绿的等待显示与分段人审/交付/证据/
显式操作；unknown/partial、Fake 合成指标与时间口径标识、无缓存率/收益/节省
结论；重复生成不重复行或计数、不追加旧报告内容、生成器零写入（SQLite 全表
快照不变）。

受影响回归（本地已运行）：`p03-10-feature-report-built.test.ts`（正式构建
CLI 文本仍含 partial/issue/审批描述/完整 Attempt 历史且不泄漏路径/凭据）、
`p03-10-feature-execution-report.test.ts` 与
`p03-10-feature-report-contract.test.ts`（共享夹具改动的报告投影/Host 契约）。
日志在 Feature workspace `verifications/F-006/runtime-logs/`；任务索引为
`test/index/phases/P03/features/P03-10/tasks/F-006.json`。较广回归与最终门禁
由 Nezha 独立执行；本地通过不代表 Feature 或 Phase 验收通过。
