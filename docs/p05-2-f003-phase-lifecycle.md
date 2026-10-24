# P05-2 F-003 Phase 元数据与生命周期

实现基线：`c1518649848ebabd2ce08b21fda275745e007e6c`。本 Task 的最终 SHA 由提交及 Nezha 独立验证绑定。

## Core 命令

四个同步命令复用 command envelope、`phase.write` 能力、项目可见性、服务端摘要、幂等回执和 Phase 自身的 `expectedRevision`。scope 为 `{kind:'project', projectId}`；返回 `{phase: PublicPhaseRecord}`。

| operation | payload | 状态条件 | 事件 / 固定 payload |
| --- | --- | --- | --- |
| `phase.metadata.update` | `phaseId` 及至少一个 `title` / `description` / `labels` | 元数据编辑不改变生命周期 | `phase.metadata.updated` / `{metadataUpdated:true}` |
| `phase.close` | `phaseId` | open → closed | `phase.closed` / `{closed:true}` |
| `phase.reopen` | `phaseId` | closed → open | `phase.reopened` / `{reopened:true}` |
| `phase.archive` | `phaseId` | closed → archived | `phase.archived` / `{archived:true}` |

省略字段保持原值；`description:null` 清空说明，标签沿用既有规范化。未知字段拒绝。revision 不符固化 conflict 回执；非法迁移 reason 为 `invalid_phase_transition`，占用未结束为 `phase_execution_active`。同 commandId 同规范化参数返回原回执（包括原拒绝），不同参数返回 `idempotency_key_reuse`。归属、能力或结构错误不产生业务写入。

Phase、事件和回执在既有 `BEGIN IMMEDIATE` 中原子更新。关闭/归档在该事务内检查同 Phase 活动 Batch、Run、活动 Attempt、worktree 租约、held/quarantined 派发认领及槽位、停止操作及 `stop_confirmed`。到期租约仍阻止操作；命令不释放、回收或删除这些占用。事务内没有 Git、进程、文件、模型或网络等待。

归档不更改 Feature/Task 结果、执行历史、预算、计划审批或旧事件，不触碰源仓库，不产生交付通过语义。既有 execution.preview/start 在事务内拒绝 closed/archived Phase，防止旧预览绕过生命周期。

## 验证与影响范围

仓库索引：`test/index/phases/P05/features/P05-2/tasks/F-003.json`，Harness 仅引用这一份索引。全部选项为完整测试文件，不按名称过滤。

- 新增真实临时 Git/SQLite 测试 19 项：部分元数据更新、标签规范化、未知字段/权限/归属/revision 拒绝、显式迁移、幂等冲突、事件公开映射和非法 payload、重开库保留历史/源文件、六种活动 Batch、孤立活动 Run/Attempt、过期隔离 worktree 租约、派发认领/隔离槽位、三类停止未确认状态、双连接 CAS、关闭后旧预览拒绝、业务/事件/回执三个故障点回滚。
- 已本地运行新增文件及命令、事件、授权、Phase 创建契约五文件；最终按文件结果合计 365 项通过。命令白名单断言同时补齐基线已实现但旧断言遗漏的 `planning.start` / `planning.candidate.decide`，保持精确集合断言。
- 索引另外选择标签编辑、Host 计划接线、执行预览/启动和派发控制结算，由 Nezha 独立运行；本地 `not_run`。
- 本 Task 不修改 Git/worktree 创建、停止或回收算法；其影响是读取这些持久占用以阻止 Phase 状态更新。新增用例复用真实 Task claim/slot/lease 夹具，覆盖竞争及恢复隔离事实；既有结算回归检查原释放政策。没有扩大为 P01–P04 全量或 Phase 验收。

本地日志位于 Feature workspace 的 `verifications/F-003/runtime-logs/`：

| 日志 | 结果 |
| --- | --- |
| `test-fdvgracx.log` | RED：新增命令尚未支持 |
| `test-0b0q1p1x.log` | 初始纵向行为 GREEN：1 项 |
| `test-bgsy8iv5.log` | 事件/授权/Phase 创建三文件通过；当次新增/命令文件失败，保留原证据 |
| `test-rxgs_dxh.log` | 修正后新增与命令两文件 129 项通过（19 + 110），exit 0 |
| `test-6lu566p6.log` | `npm exec -- tsc -p packages/core/tsconfig.json --noEmit`，exit 0 |
| `test-01ibgryc.log` | `npm run check:boundaries`，363 个生产源码文件，0 diagnostics，exit 0 |
| `test-heux8vuz.log` | `npm run typecheck`，exit 1，仅剩既有 P05-1 测试错误 |

仓库级类型错误为 `test/modules/planning/p05-1-f014-planning-e2e.test.ts:248` 的 TS2554：SQL prepare 的类型参数声明两个绑定，get 实际传入四个。该文件相对 HEAD 无改动，F-001 交接亦已记录；不将仓库级类型检查记为通过。本 Task 引入的授权测试穷举分支已经补齐，Core 单独类型检查通过。

全仓测试、Feature union、Phase 验收和真实模型均为 `not_run`；本记录不替代 Nezha 独立验收。HostClient/CLI 新入口与公开协议整体版本整理属于后续接线任务。
