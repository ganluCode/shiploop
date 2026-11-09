# P06-6 / F-006 四层标签 Core 查询契约

本 Task 提供 Core/SQLite 查询；Host、HostClient、CLI 接线交 F-007。局部测试通过不表示 Feature 或 Phase 验收通过。

- `queryService.listPhases(principal, {projectId, labels?, match?, limit?, cursor?})`。
- `queryService.listFeatures(principal, {projectId, phaseId, labels?, match?, limit?, cursor?})`。
- `queryService.listTasks(principal, {projectId, featureId, labels?, match?, limit?, cursor?})`。
- `queryService.listRuns(principal, {projectId, featureId?, batchId?, labels?, match?, limit?, cursor?})`，操作身份 `runs.list`，返回 `{schemaVersion, scope:'run-list', records, nextCursor, limit}`。
- `queryService.getLabelCounts(principal, {entity, projectId, phaseId?, featureId?, batchId?, labels?, match?})`，操作身份 `labels.counts`，返回 `{entity, labels:[{label,count}]}`。`entity` 仅允许 `phase|feature|task|run`。`phaseId` 仅用于 Feature，`featureId` 仅用于 Task/Run，`batchId` 仅用于 Run；省略父级统计该项目内指定层。计数不接受分页参数。

所有查询要求 `project.read`。项目可见性授权先于分页/标签校验；不可见与不存在项目对受限主体均为 `forbidden`。SQL 再应用同一可见性谓词；跨项目或不存在父级返回相同的空页/空计数。Task 列表及计数均只含已有业务列表允许的 `kind='coding'`。

标签复用 `validateProjectListFilter`/`normalizeLabels`：trim、NFC、ASCII 小写、去重和既有数量/长度上限。默认 `match='any'`；空标签表示无标签约束。`any` 命中任一，`all` 命中全部。非法标签、match、limit、cursor、未知参数拒绝，不降级为无过滤。列表默认 50、最大 200，稳定 `id` 升序，使用排他的键集下界和 `limit+1` 探测末页；不做全库内存筛选。

沿用 `plcur_v1_` 不透明游标格式。游标绑定数据根、层级、项目、父级；有标签约束时，以数据根和排序后的规范化标签/match 摘要派生绑定身份。标签顺序/重复和页大小不改变筛选语义；换标签、match、层级、项目、父级、数据根均拒绝续页。空标签下 any/all 等价，保留原无标签游标兼容性。分页不是跨请求的数据库快照；并发修改后按当前持久事实续读。

计数与列表使用相同标签匹配语义，统计匹配实体携带的所有标签。SQL `COUNT(DISTINCT e.id)` 保证同一实体同一标签只计一次，既不跨层求和，也不只计算当前页。例如匹配 `alpha` 的实体分别携带 `[alpha,beta]`、`[alpha]`，结果为 `alpha:2,beta:1`。

Run 列表直接读取持久 `runs.labels`，包含终态及排队 Run；返回 id/projectId/featureId/batchId/labels/status/purpose/revision/createdAt/updatedAt，时间为 ISO UTC。执行与配置快照不进入此投影。父级标签变化不追溯 Run 标签，不改变 Batch 范围或执行事实。

查询不写库、不追加事件、不续租、不创建 Run/Attempt。没有新依赖、迁移或执行命令。真实临时 SQLite 用例验证四层筛选、分页、计数、跨项目/父级隔离、只读全表快照及重开一致；测试中的 SQL 仅用于预置数据、旧重复数组和 planning Task 隔离场景。

测试索引：`test/index/phases/P06/features/P06-6/tasks/F-006.json`。本地已运行新增标签查询与既有计划查询两个文件（18 项通过）；其余索引文件交 Nezha 独立验证，不能将选择清单视为通过证据。完整日志与退出码保存在 Harness `verifications/F-006/runtime-logs/`。
