# P07-3 F-008 项目软归档、等待收尾与显式恢复

Core 生命周期：`active → archiving → archived`，显式恢复 `archived → active`。
删除（`archived → deleting`）的状态原语随 F-001 迁移表就绪，但预览/确认命令属后续 Task，本 Task 未接线。

## 命令语义

`project.archive`（project scope + `project.lifecycle.write` + 信封 expectedRevision = 项目当前 revision，payload `{projectId}`）分两段短写事务：

1. **enter 事务**：重放重核、维护占用（`configuration` 类别）、项目归属与 revision CAS；
   `active → archiving` 时同一事务内更新 status/revision 并追加唯一一条 `project.status_changed`
   事件（payload 只含 `{from,to}`），同时以真实 commandId + 请求摘要持久化进程内检查点回执
   （principal `core-project-archive`，与 workspace discard 内部检查点同一先例）。
   已是 `archiving` 时：同 commandId 凭检查点同摘要继续（不同参数 `command_reused` 冲突）；
   新命令须持当前 revision 显式继续。已是 `archived` 时幂等直接进入 settle；`deleting` 稳定拒绝。
2. **事务外有界等待**：默认 10 秒（`PROJECT_ARCHIVE_CLOSEOUT_BUDGET_MS`）轮询只读收尾快照，
   不持写事务、不做进程/Git/文件 I/O；预算与间隔可注入（Host/CLI 可装配更小值）。
3. **settle 事务**：同事务重核重放与占用。收尾快照全部阻塞为 0 才 `archiving → archived`
   （状态、事件与回执原子提交，result `{status:'archived',settled:true,project}`）；
   仍有阻塞或超时则回执如实记录 `completed + settled=false + blockers`（项目保持可查询的
   `archiving`，不伪造 archived）；新 commandId 再次提交归档继续收尾。

`project.restore` 同一短写事务完成：仅允许 `archived → active`，重核归属与 revision CAS；
不自动恢复 Run、不清预算、不重复已通过 Task（本用例不写任何执行/预算/任务行）。
数据备份恢复是 `data.backup.restore`（不同命令与能力位），公开名称互不通用。

## 门控与占用

进入 `archiving` 即刻阻止新活动：

- 新规划/新 Batch/Run：`planning.start`、`execution.start`、finalization retry、`execution.resume`
  在各自写事务内已重核 `project.status === 'active'`（既有检查，随本 Task 的状态写入开始生效）。
- 新 Attempt：`task-claim-store.claimTask` 在维护门控之后新增同事务项目状态检查
  （`not_ready` / `project_not_active`）；planning claim 既有同型检查不变。已持回执的认领重放不受影响，
  在途执行沿既有安全收尾路径完成。
- 维护占用（backup/restore/migration 等 held/blocked）阻止归档/恢复写入；只读查询不受门控阻塞。

收尾阻塞集合（`createSqliteProjectLifecycleAccess`，与 Phase 归档同一纪律、按项目聚合）：
非终态 Batch/Run、preparing/executing/verifying Attempt、held/quarantined 的 worktree 租约、
Run 派发认领与执行槽位、未确认停止（`status<>'stopped' OR stop_confirmed<>1`）、
同项目进行中的基线操作（accepted/running/cancelling）。租约到期不证明写入者停止，保持阻塞（fail-closed）。

## 文件与历史保留

归档只改 `projects.status/revision/updated_at` 并追加事件；不删除、不移动源仓库、Git worktree、
制品、Session 及历史结果（测试以全业务表快照 + 源仓库文件树对照断言）。显式恢复同样只写项目行。

## 列表可见性

`listProjects` / `countProjectLabels` 缺省隐藏 `archived`（`archiving`/`deleting` 保持可见可查询）；
`filter.status` 支持 `visible`（缺省）/`all`/具体状态（如 `archived` 显式筛选历史归档项）。
`projects.get` 不受影响。Host `app-transport` 与客户端把 `status` 查询参数不透明透传，取值由 Core 单一权威复核。

## 边界与已知缺口

- 等待预算耗尽不是失败转移：项目保持 `archiving`，回执 settled=false；停止不明不推断安全。
- Host 能力宣告（`CURRENT_HOST_CAPABILITIES`）尚未包含 `project.archive`/`project.restore`/
  `data.*` 命令——`host-lifecycle-contract.test.ts` 的对应断言在 F-001 起于 HEAD 上即失败，
  属 Host 接线后续 Task 的已知缺口，非本 Task 回归（本 Task 保持该文件不在索引内）。
- 本 Task 未运行全仓/Feature/Phase 门禁或真实模型/live；独立验收由 Nezha 按 F-008 索引执行。
