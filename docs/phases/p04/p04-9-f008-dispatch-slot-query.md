# P04-9 F-008：Core 派发队列与执行槽位只读投影

日期：2026-10-22。范围：Core 查询端口、应用投影与真实 SQLite 测试；Host/CLI/客户端接线留待 F-009。没有新迁移、预算账本或第二套可变队列状态。

## 查询契约

- 新操作 `execution.dispatch.list`（`EXECUTION_DISPATCH_LIST_OPERATION`）按项目返回有界派发队列；故意不并入 `EXECUTION_SCHEDULE_QUERY_OPERATIONS`，因为该常量与 Host 已接线查询一一对应，本任务不提前宣告 Host 接线。
- 输入仅 `{ projectId, limit?, cursor? }`：能力位复用 `project.read`，先做能力/项目可见性检查，再校验分页与游标；未知键、非法 limit、坏游标、跨项目/跨根游标一律按既有 `invalid_input` 纪律拒绝。
- 稳定排序为 `runs.created_at,id` 升序；limit 默认 50、上限 200；`plcur_v1_` 游标绑定数据根 + 项目 + `dispatch-queue` scope（`ports/queries.ts` 新增 scope kind）。数据根、项目或父级不符时不当作从零读取。
- 未知项目对可见主体返回空页（与既有列表折叠一致），不可见项目返回 `forbidden`，不回显归属；损坏的认领/槽位行或跨 Run 关联 `corrupt_state`，不折算空结果。

## 投影事实

- 展示状态与阻塞原因直接复用 F-001 `deriveRunDispatchDisplay`（queued/waiting_slot/claimed/running/blocked/pausing/paused/cancelling/interrupted/终态），不落库为可编辑状态。
- 每条记录含 Run 身份/状态/持久原因、最近一代认领（owner/host/claimVersion/origin/lease/settledAt/reason）、关联槽位（slotIndex/state/lease/releasedAt）、活动与最近 Attempt（executionVersion/exitCode/durationMs）及 Run 时间；未知时间与停止证据保持 `null`。
- 槽位摘要返回容量、全局活动/隔离计数、本项活动计数与 `otherProjectActive`；跨项目占用只暴露布尔摘要，不返回其他项目/Run/认领/owner/host 身份。
- 容量限制呈现为 `execution_slot_unavailable` + 摘要；Runtime 未装配通过 Run 持久原因（如 `scheduler_not_assembled`）单独可见，二者不互相冒充。
- 全部读取在同一 `BEGIN DEFERRED` 一致读事务内完成；查询零写入、零事件、零唤醒、零续租、零预算扣减。真实 SQLite 测试逐表核对查询前后业务事实不变。

## 验证证据（本地定向）

日志与退出码位于 Feature workspace `verifications/F-008/runtime-logs/`。

| 检查 | 结果 |
| --- | --- |
| 新增派发/槽位投影 8 项（投影、阻塞原因、槽位隔离/过期、容量 vs 未装配、跨项目摘要、分页/游标、授权/损坏、只读脱敏） | 8 passed，exit 0（`test-w3gmx_ys.log`） |
| 既有调度查询/控制恢复查询/派发契约/计划分页 4 文件 | 37 passed，exit 0（`test-dlabiho2.log`） |
| 既有单槽位原语 | 1 文件通过（同批 `host-lifecycle-contract` 因 P04-5 recording 能力预期未同步而失败，与本任务无关） |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | 339 生产文件，0 diagnostics，exit 0 |

仓库索引：`test/index/phases/P04/features/P04-9/tasks/F-008.json`（6 文件）。Harness selection 引用该索引；其余登记文件交 Nezha 独立复验。未运行全量、Feature/Phase 验收、live 或真实模型。
