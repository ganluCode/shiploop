# P04-7 / F-005 保守恢复事实核对契约

F-005 在 Host 重启或监督者崩溃后只核对已经持久化的事实。启动恢复先完成旧 Attempt 的 fencing 和有界进程观察，随后由 reconciliation 读取同一 Attempt 的资源、Session、工作区和 Artifact 事实。启动 Artifact 保持 `workspaceReconciled: false`；工作区、Git 和录制核对仍在后续阶段完成。

## 核对顺序

1. 使用启动 Artifact 中冻结的 `projectId`、`runId`、`attemptId`、`owner`、`hostInstanceId` 和 `executionVersion` 读取 Attempt 与 WorkResource snapshot。任一身份不一致都记录 gap，并保留 quarantine。
2. 将 Attempt 的 `invocationId` 当作持久 launch 回执。执行已经开始却没有该回执，或资源没有可核对的进程身份，不能按未启动处理。
3. 读取绑定 Attempt 的 Work Session。`reserved` 只能说明预占；`started` 说明原生 Session 仍可能占用，`ended` 缺少最终 stop 回执；只有 `stopped` 才能作为持久 stop 回执。Session 不存在、身份不一致、原生占用仍在或状态与 Attempt 阶段矛盾时隔离。
4. 检查 `recording_watermark`、`recording_gaps` 和 `last_activity_at`。非 reserved Session 没有水位、有录制缺口、最后活动早于启动、晚于当前恢复时间或晚于停止时间，都保持占用。
5. 停止观察必须成功，进程身份和 PID 启动身份必须与持久 lease 一致；WorkResource stop verifier 还要对完整的 invocation、进程和三项 lease 快照生成 opaque token。

## 结算边界

只有两种情况允许释放：确认 Attempt 从未授权启动并满足既有 `releaseRecoveredUnstartedInTransaction` 前置条件，或所有启动、Session、停止、进程、录制和工作区事实完整，且 `releaseRecoveredStoppedInTransaction` 接受匹配 token。其它情况调用 `quarantineRecoveredInTransaction`，保持 lease、写入者 fencing 和 workspace 用户修改。

恢复不删除 worktree，不 reset、stash 或清理用户文件，不重放不确定的 Git、文件或远端副作用，不创建新 Attempt，也不切换备用执行。诊断 Artifact 同时保存 runtime facts、所有 gap 和人工下一步；`taskPassed` 与 `newAttemptCreated` 永远为 `false`。重复恢复读取既有诊断和已收尾状态，不重复释放、提交或创建执行。
