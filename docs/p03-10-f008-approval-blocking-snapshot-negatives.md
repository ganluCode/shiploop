# F-008 阶段负例组

F-008 将审批、人工阻塞、活动输入保护、受控提交竞争和报告等待状态登记为一个独立的 v2 测试选择集。生产实现已经具备这些边界；本任务补充稳定 case ID、索引和 task-local 交接证据，便于 Runtime 与 Nezha 分别执行同一组负例。

## 覆盖范围

- `task.strategy.update` 在默认配置变化后仍保持已有 Task 策略副本，并在活动执行输入存在时拒绝编辑。
- `feature.plan.revise` 在活动执行输入存在时拒绝修订，实质计划变化使旧计划批准失效。
- `task.approval.approve/reject/unblock` 只接受绑定计划摘要、代码摘要和 CAS revision；客户端不能伪造决定身份，未经分配的主体不能决定，决定不会创建 Run、Attempt 或 Runtime。
- 机器检查通过但人审未完成时，Task 保持等待，后继不解锁；新增人工阻塞与显式继续竞争时仍等待，解除只保存决定，显式继续才复用已有证据。
- 代码摘要、观察摘要或人工阻塞变化使旧验证证据不能继续使用。
- 受控 Git 提交在批准、Attempt 版本或责任主体于提交后变化时保留实际 Git/operation 事实，同时将交付标为失败并阻止 Feature 完成；已结算操作重放不能越过新阻塞。
- 文本报告把“机器全绿但等待人审”显示为等待，不把它显示为已通过或建议绕过审批。

`test/index/phases/P03/features/P03-10/tasks/F-008.json` 是唯一选择入口。测试复用了既有正式 Core/SQLite/Git 夹具；F-008 专属标题使用 `[case:f008-...]` 稳定标记，报告等待用例继续保留被 F-006 引用的 `[case:text-approval-waiting]`。F-007 的持续失败、预算和认领竞争选择不计入本任务。

## 验证边界

F-008 Runtime 只运行本索引中的 task-local case。受影响范围的更广回归由 Nezha 依据 `.dag_context.json` 独立执行；局部通过不代表 P03 阶段验收或 Feature 全量通过。每次运行的合并 stdout/stderr、原始退出码和 sidecar 应保存到 Feature workspace 的 `verifications/F-008/runtime-logs/`。
