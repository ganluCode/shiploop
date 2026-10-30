# P07-3 F-010 项目删除持久意图与清除事务

`project.delete.confirm` 现在在 Core 组合根装配。确认 payload 为
`{projectId, confirmed:true, previewDigest, expiresAtUtcMs, cursor?}`，信封
`expectedRevision` 绑定项目 revision。多页预览提交进入末页的 cursor；单页可省略。
预览命令自身的回执不参与清点摘要，其他回执（包括 registration scope 中的项目注册结果）参与清点。

确认处理器在事务外重读文件/工作区事实，随后存储在 BEGIN IMMEDIATE 内重新核对主体、
命令摘要/时效、项目 archived/revision、完整数据库快照、活动引用和维护资格。
同事务保存固定 manifest、唯一 operation、独立 accepted 回执、三项待执行步骤、
维护占用及 deleting 状态/事件。数据库快照摘要也参与用户确认的 previewDigest，
正文/引用/归属/Schema 变化使旧预览失效；不在写事务内运行 Git 或文件流。

追加迁移 v56 创建 project_delete_operations、project_delete_steps、project_delete_receipts，
没有修改历史迁移 SQL/checksum。operation 和最小回执没有 projects FK，删除后可继续按原
主体和项目可见性查询/重放。已完成回执仅保留 `{projectDeleted:true}`（注册回执另保留项目 ID
供既有授权核验），不保留原结果正文或错误详情。operation 完成时移除 manifest，只留摘要、
身份、状态与步骤摘要。既有 command-receipts 查询使用独立回执作为后备来源。

`projectDeleteStore` 为可信内部端口：

- `get(principal, operationId)`：按原主体读取固定清单与步骤。
- `claim(principal, operationId, owner, expectedFence, previousExecutorStopped)`：新执行代次；
  替换已有执行者必须由可信控制层确认旧执行者停止，不因时间到期或 PID 消失推断。
- `recordStep(identity, step, status, evidenceDigest)`：记录 artifact_bodies、artifact_staging、
  managed_worktrees 的进度；已完成步骤不可覆盖，旧 fence 无法推进。
- `finish(identity, verifyExternal)`：要求全部步骤完成，再调用可信文件观察器核验全部固定目标
  实际清理事实。观察器不接受客户端传入，必须由 F-011 文件执行器/可信装配提供；本 Task
  不实现文件删除或自动后台续跑。核验未知/失败保留 deleting、失败步骤和维护占用。

最终事务重新核对执行代次、步骤和数据库快照，按真实 FK 图子表优先清除项目行；循环引用
在同一事务内延后检查，foreign_keys 保持开启且提交前检查全部 FK。既有保留触发器只对
匹配 project_delete operation 的 purging 状态和维护 owner/fence 放行。清除失败整体回滚，
另外记录 database 失败步骤；文件已完成事实不会被伪装回滚或伪装整体完成。
跨项目 JSON 引用的变化阻止最终清除；未参与删除的项目、源仓库、Git 分支、备份保留。

本地验证：新增 7 项行为 + 1 项迁移测试均通过；Schema 全文件 65 项通过；回执存储、
生命周期契约、迁移执行器三文件 113 项通过；预览只读/分页两项通过；typecheck 通过，
边界检查 500 个生产文件、0 诊断。完整 stdout/stderr 和退出码均保存在 Harness
`verifications/F-010/runtime-logs/`。失败 RED/调试日志保留。

Task 索引：`test/index/phases/P07/features/P07-3/tasks/F-010.json`；其中预览剩余 6 项及维护
门控文件仅登记交 Nezha 独立复验。未运行全仓、Feature/Phase 验收、真实模型/live；本地通过
不等于独立验收通过。F-011 仍需实现受界文件执行、实际不存在核验与续跑恢复。
