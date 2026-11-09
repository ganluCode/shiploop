# F-004：Core Feature 完整执行报告

入口是 `QueryService.getFeatureReport(principal, { projectId, featureId })`，操作名
`features.report.get`。需要 `project.read` 和项目可见权限；不存在与跨项目目标
统一为 `not_found`。默认 Core composition 已装配；旧的手工装配若不提供
`featureReportReads`，此方法返回 `unsupported`。Host/CLI 协议暴露由后续任务处理。

## 读取与结果

- `FeatureExecutionReportReadStore` 是只读窄端口。SQLite 适配器复用既有 Feature delivery、Work Session
  读取与行映射；application 和 ports 不接触 SQLite、HTTP 或 Runtime SDK。
- `schemaVersion: 1 / scope: feature-execution-report`。`feature / axes / outcome` 复用既有分轴判断，
  独立保留 Task 当前进度、最终检查、审批/阻塞、Git delivery 以及 `outcome.nextStep`。
  全部 Task passed 不能单独导出 Feature completed；历史失败也不会覆盖当前状态。
- `tasks[].current` 是持久 Task 当前状态；`latestAttempt / cumulative / attempts` 是跨 Run 历史。
  成功、失败、返工、取消、interrupted 都保留；无 Attempt 的 Task 也保留。
  rework/recovery 仅公开来源身份与决策，不输出恢复记录中的 workspace/内部路径。
- `runs / sessions / verifications / operations` 保留各自稳定身份；子 Work Session 归属于根 Attempt，
  不因父子关系重复计时。operations 包括 Task 提交、Feature 最终提交及已有回执。
- `evidence` 是按 Artifact ID 去重的引用索引，含 `artifactId / availability / artifact`。
  缺元数据的引用仍保留为 missing；availability 表示快照中的索引状态。
  输入组、必需输入、失败证据、审批证据、检查输出以及 Session 证据都纳入。
  Attempt 的 `resultEvidence` 正文另经 hash/size 和归属校验；缺文件、损坏或归属不符仅使该记录 partial。
- 诊断保留全部已持久化记录。SQLite 本来就把每个 Attempt 的通知诊断限制为 32 条；报告不会创造被存储层拒收的历史。

## 一致性与测量

数据库事实在一个同步一致读事务内收集；Attempt、Run、verification、operation、approval 的 ID keyset
分页在同一事务中排空，其他关联读取也在该事务中。不存在跨请求游标拼接历史报告。
`consistency.eventWatermark` 是该项目在快照中的事件水位，不能单独当作实体或原生 Runtime 存储的版本号。

事务结束后按不可变 ready Artifact 引用读取结算正文，核对快照 hash/size 以及 project、Attempt、
执行版本、owner/host、task/run/Session 归属。正文不可用或缺历史身份字段时保留 Attempt，输出
`result_evidence_missing/invalid` 等 issues。不会启动恢复、续租、预算计算、审批决定或提交。

时间、退出码、信号和 executionStage 保留已有事实。`timing.cumulativeSessionMs` 只累加去重 Session
中已知的时长（可为部分和），`measuredSessions / totalSessions / completeness` 说明覆盖情况。
`wallClockMs` 是所有 Session 的最早 startedAt 到最晚 endedAt 的跨度，包含重叠和空隙；任一边界缺失就为 null，
无 Session 时两者都为 null。它不是 Feature 生命周期的日历时长。

Attempt usage 保留已知 token/cost，未知值为 null，不从执行输入估算量推导实际用量；
Fake 一律标 synthetic。P03 没有正规化 cache 测量，所以 cacheReadTokens/cacheWriteTokens 为 null，
并标记 cache_unknown。partial 与 Feature outcome 独立：报告测量不完整不改写持久 Feature 状态。
相同实体快照与相同不可变证据生成相同语义、排序和计数，不读取当前时间作为结束时间。

## 验证范围

`test/modules/delivery/p03-10-feature-execution-report.test.ts` 的六个稳定 case 覆盖真实 SQLite：
三 Task、两 Run、跨 Run 失败/返工、取消/interrupted、子 Session 重叠、130 Attempt 和 130 审批分页、
重复身份、缺历史字段/证据、证据归属/完整性、授权以及查询前后全库快照不变。
另用 WAL 的第二连接在读取中提交新 Attempt/Run 状态，验证当前报告不混入新事实、下一快照才可见。

索引为 `test/index/phases/P03/features/P03-10/tasks/F-004.json`。本地只运行新增报告测试；
已有 Feature delivery 和 Work Session 查询回归已登记，交 Nezha 独立运行。
本任务不表示完整 Feature 或 Phase 验收通过。
