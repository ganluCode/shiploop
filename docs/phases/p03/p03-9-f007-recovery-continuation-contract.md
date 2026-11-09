# P03-9 / F-007 同 Task 通用续接决策与来源快照契约

状态：已实现（P03-9 / F-007）。本文件描述 Core 行为，不表示 Pi SDK 原生
resume 已接入；生产适配仍属 P04。

## 1. 范围

`application/work-recovery-continuation.ts` 在显式继续或新 Attempt 之前，
对同 Task 的直接上一 Attempt 做一次只读、fail-closed 的续接规划，并发布不可变
`work-recovery-continuation` 记录。记录进入新 Attempt 的输入快照
（`ContextBuildInput.recovery` / `PreparedExecutionInputGroup.recovery`），不
启动 Runtime、不预占预算、不改写旧输入或原生档案。

## 2. 输入

- `selection`：P03-3A 的 `new` / `auto` / `required` × `conversation` /
  `checkpoint`，来源是 Core Artifact ID；
- `strategy`、`taskRevision`、当前已准备的输入快照引用；
- `next`：新 Attempt/Session/invocation/executionVersion 身份；
- `reconciliationEvidence`：P03-9 / F-006 的 reconciled 证据引用；
- 当前工作区身份：workspaceId、repoIdentity、branch、headCommit、codeDigest。

## 3. 决策规则

1. 候选只能是同 Project/Feature/Task 的直接上一 Attempt；任何活动 Attempt
   或旧 Attempt 遗留 held/quarantined 租约一律拒绝，`new` 不绕过。
2. 候选必须终态且 F-006 证据为 `reconciled`：无 gaps、无 unknown Git 操作、
   记录水位已停止、原生档案未被打开且单写入者已确认停止；工作区
   repo/branch/workspace 身份一致。
3. 有来源时：来源 Attempt/Session 必须与候选一致；归档/检查点 Artifact 必须
   ready 且摘要实测一致；候选与当前输入快照的标题/验收/需求/依赖/检查政策/
   权限/必需输入一致。仅 provider/model 变化交给 `modelSwitchOnResume` 能力；
   其他策略变化 auto 降级 `new`、required 拒绝。
4. 复用 P03-3A `decideRuntimeRecovery`：required 未支持即拒绝；auto 降级保留
   确定性原因；`new` 记录 `explicit_new`。

## 4. 不可变记录

记录固定：请求模式、实际决策与原因、来源 Attempt/Session、来源引用、当前完整
策略副本、工作区身份、F-006 证据引用、必需输入引用，以及精简 `handoff`
（上一 Attempt 状态/阶段/结束时间/诊断引用/必需输入；不内联完整原生历史）。
记录发布为同项目不可变 Artifact，并在 ContextBuilder 中作为必需
`recovery-record` 来源进入 snapshot/manifest/prompt。

## 5. 边界

- 不实现 Pi SDK resume、跨模型历史互通、原生库打开/复制或 exactly-once 外部
  副作用；
- 不重置 Task/Run/Batch 预算，不创建 Session/Attempt/Runtime；
- 新 Attempt 的实际认领、预算、幂等与启动仍由 F-008 及既有授权链路执行；
- 记录中的 `decision=resume` 只表示能力与现场预检通过，不是 Task passed 或
  进程已启动的证明。
