# 失败 Planner 的退役与重新规划

`planning.start` 不会隐式关闭旧上下文。`open` / `candidate_published` 与唯一索引保持一致，失败 Run 的未结算上下文仍阻塞新规划；冲突会携带 contextId、candidateId、runId 和约束名称。

## 正式入口

先用只读命令检查现场：

```bash
shiploop planning get <candidateId> --project <projectId> --json
shiploop execution recovery <runId> --project <projectId> --json
shiploop execution session <attemptId> --project <projectId> --json
```

停止和资源归属有充分证据后，显式退役旧上下文：

```bash
shiploop planning retire <featureId> --project <projectId> \
  --context <contextId> --candidate <candidateId> --run <runId> \
  --revision <featureRevision> --workspace-revision <workspaceRevision或none> \
  --command-id <新UUID> --json
```

HostClient 对应方法为 `retirePlanning({projectId, featureId, contextId, candidateId, runId, expectedRevision, workspaceRevision, commandId})`。`workspaceRevision=null` 表示没有工作区；CLI 使用 `none`。

通常路径校验项目归属、Feature CAS、Run/context/candidate 身份、终态 Run/Attempt、Session stopped 与完整记录水位、工作区 CAS/归属/retained、待处理 Git/工作区操作及 dispatch 所有权。活动执行、未知停止和未核验隔离继续拒绝；不把无 PID、startedAt=null、Host ready 或租约到期当停止证明。

Pi 在 supervisor 提交前失败的窄路径可以自动准备独立证据：私有 bootstrap 的属主、权限、修改时间、invocation/cwd/Attempt 身份、冻结输入正文哈希匹配，且尚无 supervisorGroupId；协议保证 supervisor 提交及 durable acknowledgement 前不会释放 workload。Core 还执行两次当前无 Pi 写入进程的清点和工作区检查，要求 HEAD 等于基线、无改动，并用恢复指纹和 CAS 防止检查期间事实变化。只在这些条件全部成立时，按精确 owner 结算三个无进程身份的隔离租约、dispatch claim/slot，将工作区改为 retained，并发布证据制品；原 Session 的 ended、记录缺口、Run 失败和预算保持原样。客户端不能传入“已停止”标记绕过核验；隔离恢复实例不启用此路径。

工作区不可变归属可能来自更早的 Attempt。此时还必须独立核验原 owner 的终态 Run、已 stopped Session、无租约及未释放 claim/slot，不将它与当前失败 Attempt 混同。已取消 Run 的 interrupted 历史 Attempt 在其 Session 已 stopped 且占用全部结算后不再误作活动写入者；缺失停止记录或任何残余占用仍阻塞。

成功时只将未决定上下文改为 cancelled，并按原 owner 结算残余 dispatch claim/slot、追加审计事件与回执；保留原 Run 失败、Attempt、Session、候选/制品和预算，不创建新 Run。相同 commandId/参数重放返回原回执；改参冲突。CLI 自动取原 issuedAt，直接 HostClient 重放需使用原回执 issuedAt 选项。

退役成功后才由用户另行授权规划：

```bash
shiploop planning start <featureId> --project <projectId> --json
```

这会启动模型，但不批准候选、不启动编码。新规划使用新授权 Batch，不重置旧 Batch 的累计消耗。

## 当前不能自动恢复的现场

### 启动预算预占前失败

ExecutionService 在调用 Runtime 前必须原子预占启动预算并创建 Session。若终态规划 Attempt 无 Session、无 runtime_start_reservations 且无工作区租约，可在完整项目/执行身份与 dispatch 所有权校验后退役，不伪造 Session stopped。重启若将其工作区重新隔离，必须另外通过无写入进程清点、干净 Git 基线和指纹/CAS 核验，才可恢复为 retained；活动执行和已预占但停止不明的调用不适用。

认领回执固定的是执行身份，而不是可续期的租约截止时间。输入绑定允许权威 Attempt 在同 owner/host/executionVersion 下延长租约；拒绝回执声称比权威事实更长的期限，绑定时重核三个资源均 held 且未过期。否则后台心跳可能在工作区准备期间更新 lease_until，使合法启动被误判 claim_identity_mismatch。

以下为仍不能恢复的未知启动情况：

历史只有 `runner_start_failed`、Session ended/stop unknown、记录不完整，且没有上述独立启动前证据时，无法证明“从未启动”，也无法按身份核对进程树。退役命令会返回停止未确认或证据未确认冲突，保留隔离。不要直接 UPDATE/DELETE SQLite、删锁、删 Session/worktree 或盲目 kill。

新 Runner 将 CommandProcess 的有界失败原因保存为 `runner_start_<reason>`；原始未知异常仍是 `runner_start_failed`。只有 `runner_invalid_input` 表示已确认启动前校验拒绝，不能追溯赋予历史错误此证明。

Host graceful stop 若返回 `quiesce_not_confirmed`，不代表进程退出，禁止假报重启成功。新 Host 的停机门控仅把自身归属的隔离租约计入待停止活动，保留其他历史 Host 的隔离资源不动。旧 Host 的升级须另行核验全部执行、内核身份及子进程；不是退役命令的强制杀进程功能。新增退役能力的客户端允许连接未宣告此能力的旧 Host 进行诊断；旧 Host 不会因此获得退役实现。

## F01 恢复记录（2026-11-09）

- 正式退役 commandId：e49457d9-e8ac-46ab-ac3a-f0f242cf2b17，completed；旧 context cancelled，workspace revision 30 → 31 / retained，隔离租约 3 → 0。
- 原 Run 9732183d-6e7f-4562-b749-f44cee36ab7b 仍 failed，原 Batch revision=1、计数 1/1/1/1、未知用量均保留。历史原始超时原因仍未持久化，启动前证据不等于补造该错误原因。
- 经用户授权仅重跑 F01，start commandId：36af5f2c-4146-425d-b36f-b7367f77b431；新 Run cdb241ed-631a-4013-8072-a1705ac33a1b，Batch 007b29d3-cb4d-4e70-9842-1f6666b15a44。
- 13:52:32（Asia/Shanghai）新 Attempt 1a22e551-fb3e-471d-b0b2-8830d086a6bf 为 executing，Session d7f56e93-5520-4549-b065-ffffd0bbc36c 为 started。此为启动检查点，不代表计划已完成或获批。
- 上述重跑于 13:53:56 失败（planning_candidate_missing）：先出现候选 JSON/引用校验拒绝，随后工作区/Attempt 租约未随 dispatch 心跳续租，提交被拒 grant_revoked。现已让心跳在同一事务中按完整 owner/version 围栏续租活动 Attempt 和三个工作区资源；到期/隔离资源不得复活。中英候选提示词明确通过 JSON.stringify 提交，并将未知 Artifact 引用留空交 Core 注入。
- 该次 Session 已 stopped、记录完整、资源清零后，正式退役 18ca74fb-dda8-475a-a0d8-67a9ee14bcf1 完成；14:10:21 再启动 commandId=24f7b1ab-9fa3-449d-b5c0-b66add51258b，Run=2fb2f2ab-aab6-4df5-bb67-059e93dc16a7，candidate=c92a0e56-1da3-495a-b4cf-707eaa3c664a。该请求 accepted，不代表完成。
- 14:12:10 最终核验：该 Run succeeded / planning_candidate_published，Attempt succeeded，耗时 108202ms；上下文 candidate_published，executionState=awaiting_approval，decision=null。超过一分钟的心跳续租已在生产观察到；没有批准候选或启动编码。
