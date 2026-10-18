# P03-9 / F-006 恢复现场核对与占用收尾契约

实施契约。前置：F-005 已把遗留 Attempt 标为 `interrupted`、隔离 lease/workspace 并保存停止观察；本任务只在停止观察可核对的条件下核对 Git/worktree、记录水位与受管 Artifact，然后决定恢复为 `paused` 还是继续隔离。设计依据：`core-design/04` §5/§5.1、`core-design/05` §11、`core-design/14`。

## 1. 边界

- Core 仍是业务事实源；本任务不读取 SDK 私有表、不开启原生档案写入、不创建新 Attempt、不把 Runtime 退出 0 或最后文本当作 Task passed。
- F-006 不新增迁移、表或事件类型。诊断正文保存为 `workspace_evidence` JSON Artifact，稳定引用写入 `attempts.diagnostic_ref`；F-005 的 `work.recovery.updated` 历史事件及 Artifact 保留。
- 成功时只更新原 `interrupted` Attempt 的诊断引用、`runs.status = paused`（reason `restart_recovery`）、`managed_workspaces.status = retained` 及已核验 HEAD/codeDigest，并按既有跨介质顺序最后释放匹配 holder 的 lease。
- 同一成功事务把该 Attempt 对应、仍为 `running` 且不存在其他活动 Attempt 的 Task 回退为 `pending`（revision +1）；否则显式 resume 的 DAG 预演会把已确认停止的历史执行误判为 `resource_busy`，从而无法创建新 Attempt。已 `passed`/`failed` 等终态 Task 不受影响，旧 executionVersion 的写资格也不恢复。
- 不可核验时保留 Run `interrupted`、workspace 与 lease `quarantined`；任何中途异常/重启都保留可恢复的持久占用。

## 2. Worktree 与 Git 核对

1. 仅使用 F-005 持久 evidence 中的 Attempt/owner/host/executionVersion；不接受客户端路径。
2. 经既有受界 `WorkspaceInspector` 核对规范路径、repository identity、Git worktree 登记、分支、HEAD、tracked/untracked/ignored 内容与 codeDigest。允许 HEAD 包含已提交进展，不 reset 到 base commit，不覆盖或重建目录。
3. 额外只读核对 `baseCommit` 与已记录 HEAD 是否为当前 HEAD 祖先；不满足时记录 `head_not_descended_from_base` / `recorded_head_not_ancestor` 并隔离。
4. 只检测 worktree/common Git 锁（index/HEAD/packed-refs/config），**不删除锁**；发现锁或探测失败时保留诊断。
5. 未完成 `git_operations` 以冻结的 expectedHead/candidateTree/message/identity 与实际 HEAD 父提交/tree/message 核对：
   - HEAD 仍为 expectedHead：记录 `not_executed`，不重试提交；
   - 已存在匹配提交：记录 `matched` 与实际 commit/tree，不重复提交；
   - 其它漂移：`unknown` 并记录 `git_commit_side_effect_unknown`，保持隔离。

## 3. 记录水位、Artifact 与原生档案

- 读取该 Attempt 的 Work Session `recording_watermark`、`recording_gaps`；已 started 但水位缺失、已记录缺口均作为恢复 gap。Recorder 水位独立于原生检查点。
- 核验恢复相关 Artifact（诊断、代码、结果及原生来源归档）；ready 正文缺失/hash/size 不符、非 ready、缺失引用均标为缺口。Task 输入快照仍由执行输入路径负责，不在恢复时重新解释。
- 原生档案只读取 `sessions.native_ref` 的 storageKind/formatVersion 元数据与恢复来源引用的 `nativeArchiveRef/sourceDigest`；不打开、不复制、不续写原生库。旧 Runner 未确认停止时不释放占用，因此不会出现两个 Runner 同库续写。
- 证据 JSON 明确携带 `taskPassed: false`、`newAttemptCreated: false`、`native.opened: false`。

## 4. 停止与释放

- 已授权启动且仍有 lease 的 Attempt：重新使用既有 `WorkResourceStopVerifier` 核对整组缺席，token 只对完全相同的 lease/invocation/process 快照有效。
- 从未授权启动且无进程身份、无 lease 的 Attempt：视为 `never_started`，不要求伪造停止证据；若仍有未启动 lease，使用既有 `releaseRecoveredUnstartedInTransaction` 收尾。
- `WorkResourceAccess` 新增仅供恢复使用的 `readForRecovery` / `releaseRecoveredStoppedInTransaction` / `releaseRecoveredUnstartedInTransaction` / `quarantineRecoveredInTransaction`：不恢复旧 task executionVersion 的写资格，只按不可变 Attempt/lease 身份核对。
- 成功事务内先写诊断与 paused/retained，再释放 lease；失败回滚保留 lease。重复恢复读取 `alreadyReconciled`（paused + retained + 无 lease）后不再创建 Attempt 或重复提交。

## 5. 集成与验证

- `createWorkStartupRecovery` 在 F-005 停止/证据之后，对本次 target 与已 recorded 但未成功收尾的 Attempt 调用 `reconcile`；全部 reconciled 才开放门控。
- `test/p03-9-f006-recovery-reconciliation.test.ts` 使用真实临时 Git/SQLite/Artifact 文件覆盖：tracked/untracked 保留、已提交进展、错误分支/路径、外部 HEAD 漂移、记录水位缺失、原生档案只读事实、已发生但回执缺失的提交、pending Artifact、重复恢复及历史 passed/证据保留。
- F-005 测试改为从不可变 recorded 事件读取其启动 Artifact；较新的恢复诊断可更新 `attempts.diagnostic_ref`，但不删除历史事件或 Artifact。
- `workspace.discard.preview` 读取历史 fenced Attempt 时只检查该 owner 的剩余 lease，不通过已撤销的 task executionVersion 门槛误报 ownership。
