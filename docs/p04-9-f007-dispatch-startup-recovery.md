# P04-9 F-007：Run 派发归属的启动恢复

Host 重启时，启动恢复先核对 Run 认领/槽位，再核对 Attempt、持久 claim 回执、invocation、进程身份和原有三组资源租约。SQLite 是唯一恢复事实源；没有模型调用，没有新预算账本或迁移。

## 恢复事务

- `adapters/sqlite/dispatch-recovery.ts` 是适配器内部受信恢复原语。扫描活动认领、有界历史与孤立槽位/租约；缺失授权、损坏回执或不匹配的代次均保留隔离并给出原因。历史超过 128 条时 fail-closed，不把截断扫描当作完成。
- 无 Attempt 的认领，只有确认没有启动预占、工作区操作、Git 操作或资源组等矛盾事实时才按未启动路径释放；queued Run 留给既有持久补扫。running/pausing 的未启动工作转 paused，等待显式继续。终态/取消状态不重开。
- 有 Attempt 的工作先隔离认领和槽位，沿用既有 Task fencing、受控进程停止、Git/worktree/Recorder 核对。租约过期没有释放权限。曾授权但没有进程回执的工作保持隔离。
- 已由原终态/保留事务确认停止、Session 水位完整、没有资源组与未结 Git/workspace 操作的遗留消费者，可以直接结算；保留 Task/Attempt 版本及通过事实。其他终态异常不推进通过 Task 的执行版本。
- `workRecoveryFingerprint` 在一致读中绑定 Run/父 Batch、Task/Attempt、认领/槽位/回执、启动预占、工作区/租约、Session、检查、引用制品与 Git/workspace 操作。异步核对和证据发布后，finish/quarantine 必须在写事务内重新匹配。快照变化时整组拒绝。
- finish 在同一事务中保留工作区、回退未通过 Task、释放匹配的旧租约及派发认领/槽位；故障回滚不留下半释放状态。再次重启复用持久观察。旧工作区/旧派发代次的历史观察不授予当前执行权；缺失关联也不能让启动门控漏过残留组。

`execution.resume` 的只读准备与写事务都核对派发归属。隔离、过期、无槽位、无 Attempt 或持久关联不完整的持有者拒绝继续；正常暂停的有效 held 持有者仍沿用既有停止核验和替换路径。受信释放后新代次追加 `resume` 关联，保留原父预算、绝对 deadline 和已完成证据，不重开旧 Attempt。

## 故障窗口与验证

| 窗口 | 实际证据 |
| --- | --- |
| 占槽但没有 Attempt | 真实 SQLite，关闭/重开连接两次；确认未启动后释放，预算与 queued Run 不变 |
| Task claim 提交后、授权启动前 | 真实工作区与制品核对；释放同身份的三组租约和派发槽位，保留其他 passed Task |
| 启动授权后、进程回执前 | 缺失身份、过期租约和反复重启均保持隔离；真实仍写入的进程组不因缺少 PID 被推断为停止 |
| 结果已到、完成结算前 | 真实三代写入组经新连接恢复停止，核对后释放；保留 code_ref/exit_code，Task 不自动 passed |
| 终态回执提交后、派发结算前 | 只结算消费者，Task/Attempt 和父预算逐行保持不变 |
| 释放事务崩溃 | SQLite 明确故障触发器；Run/工作区/资源/槽位一起回滚，再次恢复成功 |
| 核对期间状态变化 | 证据发布边界切换为 cancelling，快照匹配失败，不释放或恢复取消工作 |
| 旧 owner 通知 | 新认领代次生效后旧完成被忽略，旧结算和续租拒绝，新槽位保持不变 |
| 历史/损坏关联 | 无派发关联的旧三组租约仍按原恢复核对；缺失回执、部分资源组及已有观察但工作区丢失均阻止启动 |
| 真 Host 强杀 | 扩展既有 F-016 用例：SIGKILL 后旧工具继续写入，重启停止核验后仍因记录缺口保留认领/槽位隔离 |

所有进程等待有界，清理复核实际进程组消失。外部工具副作用仍需核对，本实现不承诺 exactly-once。

## 本地证据与独立回归

日志根目录：Harness Feature `verifications/F-007/runtime-logs/`。每个日志均有完整 stdout/stderr、JSON 和退出码旁文件。

- RED：`test-h6cfppim.log`，无 Attempt 槽位未被恢复释放，预期断言失败。
- 最终新增三个文件：19 passed，exit 0，`test-gz4nkdll.log`。
- 既有现场核对文件：11 passed，与新增用例一起运行的日志为 `test-eo_utr8l.log`（当时共 28 passed）。
- 既有显式恢复文件：9 passed，修复过度拦截正常 held 暂停的兼容问题后，日志 `test-sjp5385l.log`（当时共 26 passed）。
- 真实 Host 强杀定向用例：1 passed / 3 未选择，`test-f0e8edpt.log`。先显式构建了 Host 原生锁，`test-54mg4o_6.log` exit 0；没有运行全量构建。
- 最终 `npm run typecheck`：exit 0，`test-joxpcap7.log`；`npm run check:boundaries`：339 个生产文件、0 diagnostics、exit 0，`test-v66eq4lb.log`。
- 最终进程清理副本：`verifications/F-007/missing-process-receipt-cleanup.json` 与 `result-before-settlement-cleanup.json`，两组均为 `pass`、`processesGone: true`、`removed: true`，每组核对 4 个进程。

以上为首次实现的本地记录；独立验收及后续修复见下文。

仓库唯一选择索引为 `test/index/phases/P04/features/P04-9/tasks/F-007.json`（14 文件）。Harness selection 仅引用此索引。新增三文件、既有 F-006/F-008 恢复文件及 F-016 指定用例有本地通过证据；其他索引文件及 F-016 其余用例仅登记，交 Nezha 独立复验。未执行全量测试、Feature/Phase 验收、live 或真实模型。没有人工阻塞；独立验收结果由 Nezha 决定。

## 第一次独立验收后的修复

独立验证 `28a881fe4ca74639b61bfa5ffa5bb412/verification.json` 实际执行原索引 14 文件，138 passed / 11 failed。失败均在旧启动恢复文件：夹具获得时间晚于系统时钟，恢复直接写入当前时间，违反认领的 `settled_at >= acquired_at` 约束，导致 fencing 事务回滚及停止观察缺失。

修复 `dispatch-recovery.ts` 的隔离/释放写入：结算与更新时间取当前时钟、该行获得时间和已有更新时间的最大值。时钟回退不能使隔离失败或回拨已有时间；未启动/停止证据准入和原绝对 deadline 继续按原政策核对。没有修改历史迁移、旧测试断言、预算或停止约束。

- 新增两项时钟回退用例（释放和隔离），RED：`test-nasa3wbv.log`，两个约束错误均复现。
- GREEN：启动扫描 7 项及全部旧启动恢复 15 项通过，`test-n0duvf2s.log`，exit 0。
- 崩溃窗口/显式恢复 14 项通过，`test-qvm7fe89.log`，exit 0；本轮四文件合计 36 passed，新增三文件现为 21 项。
- 类型检查通过：`test-0pwktf3c.log`，exit 0。
- 本轮进程清理副本：`verifications/F-007/attempt-2-{missing-process-receipt,result-before-settlement}-cleanup.json`，两组各 4 个进程均确认停止并移除临时根。

重新审阅并校验原 14 文件索引，范围保持完整。其余上轮独立验证已通过的 138 项不整体重跑，交 Nezha 独立复验；未运行全量、阶段或 live。首次独立失败不因本地通过而自行清除，本次按新 invocation 提交完成声明，最终通过状态由 Nezha 更新。
