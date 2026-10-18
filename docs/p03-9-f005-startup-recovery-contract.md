# P03-9 / F-005 Work 启动恢复门控

Host 在持有既有数据根 writer lock、打开当前 schema 后进入 Work 恢复。Core 装配时即关闭认领和显式派发入口；Host 先执行 P02 baseline 恢复，再核对遗留 Work，最后暴露服务与正常调度。恢复未完成时，认领与 `execution.start` 在提交事务内拒绝，调度扫描和 Runtime 调度入口不放行。

## 扫描与 fencing

SQLite 恢复事务分别读取最多 129 个候选 Attempt 和 Run，只处理其中 128 个。候选包括非终态 Attempt、仍持有 Work lease 的历史 Attempt，以及非终态 Run。超出上限时持久登记 `scan_limited` 并保留门控，不把未扫描记录视为安全。每个 Attempt 最多读取 4 条 lease，以发现超出既有 global/project/workspace 三元组的异常。

先核对 Attempt/lease/workspace 的 owner、host instance、execution version、Run/Attempt 关联与持久进程身份。短事务递增 Task execution version、将活动 Attempt 和需中断的 Run 标为 `interrupted`，并隔离 lease 与已登记 managed workspace。既有终态事实、代码引用、退出码、文件和预算/deadline 保留。未创建 Attempt 的 queued Run 继续保留已有授权。

恢复使用持久 phase 标记避免重复 fencing、停止和 Artifact 发布；在 fencing 提交后中断，再由新 Host 打开时可继续核对，且保留之前登记的缺口。旧 owner/version 的 Runtime 回写由既有 Attempt lifecycle 拒绝。

## 停止与证据

进程身份来自既有 lease 的 launchId、PID、PGID 与 start time。身份缺失、组内身份不一致或 workspace 关联失配时不发信号。租约过期既不授权停止，也不证明执行结束。

身份可核对时调用既有 `CommandProcess.recoverStop`，外层观察期限为 5 秒；只有其明确返回 `confirmed: true` 才登记停止确认。父进程退出不能代替旧进程组与子进程停止事实。恢复不接管旧 Runtime，不自动结算遗留成功，也不启动新的 Runtime。

停止观察先写 SQLite，再通过既有 Artifact 通道发布 `work-startup-recovery` JSON（Artifact kind 为 `workspace_evidence`）。因此 Artifact 发布失败仍保留 fencing、隔离与停止观察；重新打开恢复时复用该观察继续发布，不重复停止或改写已保存的停止事实。扫描、停止、证据发布失败均保留门控；无法持久登记诊断时 Host 启动失败，不对外宣告就绪。

F-005 始终保留遗留占用，`workspaceReconciled` 为 `false`。即使停止已确认，也需后续 F-006 核对 worktree、Git 副作用与记录水位，才可按既有收尾规则释放资源。

## 事件与验证

只扩展既有 `state_events` 白名单：项目事件 `work.recovery.updated` 聚合到实际 Run revision，全局阻塞事件为 `work.recovery.blocked`。内部 payload 严格校验字段、身份与 scope 关联；Host 公开投影仅为 `{ "recoveryUpdated": true }`。未知持久事件或损坏 payload 显式失败。

任务测试 `test/p03-9-f005-startup-recovery.test.ts` 使用真实 Host、SQLite 与受控进程，覆盖清洁启动、三个遗留执行阶段、旧身份拒写、fencing 后重启、存活子进程、过期/失配身份、workspace 失配、提交门控、扫描回滚、停止与 Artifact 失败、有界扫描及事件读取。当前受控进程 adapter 仅支持 macOS，因此该任务文件显式按平台跳过；本次验证在 macOS 执行。

## F-006 增量

F-006 在停止观察之后接入 Git/worktree/记录水位核对：只有全部必要事实可核验时才把 Run 置为 paused、workspace 置为 retained 并释放匹配 holder；否则保留 interrupted/quarantined。实现与测试边界见 [F-006 恢复现场核对契约](p03-9-f006-recovery-reconciliation-contract.md)。F-005 的 recorded 事件与 Artifact 保持不可变，`attempts.diagnostic_ref` 可指向较新的恢复诊断。
