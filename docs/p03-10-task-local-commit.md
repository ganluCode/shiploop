# Task 本地受控提交与放行

## 已确认的策略

2026-10-19 用户确认：每个 Task 都需本地提交；push 是独立、可配置的远端交付动作，不决定本地提交是否发生。

新配置使用 `policies.deliveryPolicy.commitMode: task_and_feature`，并显式配置经用户确认的 Git 姓名和邮箱。旧 `feature_final_only` 名称仅为历史配置/快照读取兼容保留，不再豁免 Task 本地提交。没有有效身份时拒绝执行提交，不借用开发机全局身份。

当前已实现的 deliveryActions 仍仅为 `['commit']`，不执行 push；本次没有增加远端凭据、remote/ref 授权或推送传输适配器。未来启用 push 必须单独完成这些授权和回执，不能把自动本地 commit 当成 push 授权。

## 执行顺序

1. 可信检查定版并绑定当前 Attempt、验证批次、代码和批准身份。
2. 保存不可变代码制品；人工事项未满足时保存机器证据并等待，不提交、不放行。
3. Core 受控提交器核对 owner/host/executionVersion、Run/Batch 控制状态、截止时间、工作区占用、停止证据和当前策略。
4. 在独立 Git 公共元数据锁下，核对真实 HEAD、验证过的文件内容和允许路径；暂存后再核对，持久化不可变 `task_commit` 意图，然后执行 Git。
5. 核对实际 parent/tree/message/用户身份和源码，保存操作回执。成功本地提交不更新 Feature deliveryStatus。
6. 再核对源码并以当前工作区归属 CAS 推进已知 HEAD；原 baseCommit 不变，后继合法复用该工作区。
7. 生命周期事务再次核对当前人工条件、验证批次和匹配的提交回执，才完成 Attempt/Task，并按停止证据释放占用。没有回执的直接验证提交/人工继续不能放行。

Feature 最终检查/审批和交付仍独立执行；所有源码已由 Task 提交时，最终 Git 步骤可明确记录 `no_change`，不能重复提交同一成果。没有源码变化的 Task 同样记录经核验的 `no_change`，不伪造空提交。

## 持久化与异常

- v30 只新增迁移，重建 Git operation 类型约束，旧迁移 SQL/checksum 不改。
- `task_commit` 必须绑定 Attempt；回执 `deliveryStatus` 恒为 `not_requested`，不能冒充 Feature 已交付。
- 验证前现场作为不可变制品引用进入提交意图。崩溃后的 pending 只走既有真实 Git 核对，不盲目再 commit；无法证明副作用时保留 pending/unknown 和占用。
- hook 改源码、HEAD 漂移、停止不确定、当前批准撤销、陈旧 owner/version、失败提交或损坏证据都不能放行后继。
- 显式继续仍需授权、输入/环境/证据有效性和修订核对；批准本身不触发代码运行或 Git。
- 已确认 hook 拒绝、HEAD 未变的失败操作可在显式继续时以新意图重试，旧回执保留；pending 且核对为未执行时明确要求恢复处理，不盲目重试。
- 验证代码身份包含文件模式并单独绑定 HEAD；完整源码与 Git index 的逐字节核对独立于增量暂存集合，不能用 assume-unchanged 或 core.filemode 隐藏修改。
- Git 子进程纳入取消与停止核验；输出核验按对象数和字节双重分批，超限明确拒绝，不把缺失输出当成功。

## 验收边界

验收必须区分产品内部临时仓库的 Task commit 与开发本仓库的 F-003 commit。三 Task 演示须证明三个成功 Task 对应三个受控提交、中间失败 Attempt 不提交、返工保留现场、最终检查和最终交付可核对，以及命令重放不重复副作用。

普通 Run 的最终收尾在本次演示中由公开 Scheduler/FeatureFinalization 服务显式装配；这不代表默认 Host 已装配全部生产编码/验证/最终交付消费者。Phase 完整验收与真实 Pi 接入仍有独立门槛。
