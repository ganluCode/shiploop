# P05-8 F-002：有界 GitAgent Run 编排

Core 组合根提供 `gitAgentRepair`，仅供受信 Core 调用。`authorize`、`claim`、
`settle`、`hold` 和 `read` 均在现有 `AtomicCommandStore` 短事务内执行。
本任务交付授权、准入和持久事实；Runtime 监督、候选验证/提交及完整故障恢复分别由
F-003/F-004/F-005 继续接线，Host/CLI 公开协议由 F-006 交付。

## 授权与身份

- 迁移 v45 只追加修复授权、命令别名和非编码修复 Attempt 准入证据三表；v1–v44 不变。
  沿用原父 Batch、`runs`、`run_dispatch_intents`、派发 claim、slot、Feature 资源租约，
  不创建隐藏 Batch、编码 Task 或第二套 Git 状态机。
- 每个失败 Git operation 最多一个修复身份。commandId 同摘要返回原回执；同 repairId
  的另一个 commandId 只有授权摘要相同才绑定原回执。异摘要、改变 repairId 或重复
  利用同一来源创建另一修复均 conflict。过期后的原命令仍能读取原回执。
- 来源必须与原 Run、父 Batch 固定成员、Phase、仓库绑定、集成输入和基线一致。
  来源证据支持已保存的失败 Git 回执，以及 pending operation 上的真实冲突 observation。
  pending 本身、unknown、成功或用户描述均不构成修复授权。
- 失败回执证据 ID 使用 operationId，摘要为 `sha256(stableStringify(receipt))`；
  冲突 observation 使用 journal 行 ID，摘要为 `sha256(stableStringify(observation))`。
  工作区 ID 使用冻结 execution plan 的 integrationId，opaque 摘要为
  `sha256(stableStringify({repoIdentity, worktreePath, inputDigest, baselineCommitSha}))`。
  绝对路径只参与 Core 私有核验，不放入 Runtime 授权字段。
- 原 Run 必须已收口且无未确认停止的 Attempt/dispatch owner；否则持久化
  `identity_or_lock`。不自动终结原 Run、不抢占旧写入者。

## 派发、预算与控制

- 修复 Run 的 purpose 是 `git_agent_repair`，在编码 DAG 前单独路由。
  未装配消费者时记录 capability gap；恢复补扫使用既有队列，不依赖内存唤醒。
- `claim` 复用现有派发准入，按统一资源顺序获取 Feature 与集成工作区排他写租约、
  claim 和 slot；同时绑定预算授权版本、父 Batch 和修复 Attempt。savepoint 保证
  任一准入失败不留下部分锁/计数。未确认停止的旧 Attempt 阻止下一次准入。
- 只有首次准入返回 Attempt；重复 attemptId 返回 null，不能被解释为再次启动指令。
  消费者必须在事务提交后启动 Runtime，并按 Attempt 的 `maxTokens`、`maxRuntimeMs`
  和 `deadlineUtcMs` 执行，而不是重新使用原请求中的全部额度。默认 `childAgents=false`。
- Run 创建、Attempt 以及 Runtime 启动都消耗原 Batch 的累计计数；启动预占复用
  `runtime_start_reservations`。失败、备用、暂停、重开数据库与重试均不退额。
  修复尝试还受原 Run 上限、授权总次数、累计 token/运行时间、Run 绝对经过时间和
  原 Batch/修复 deadline 的最小值限制。父预算版本变化不能扩大旧修复授权。
- 父 Batch token 上限按既有编码 Attempt 的已知 input/output token，加修复的结算
  用量或尚未停止的完整预占计算。未知用量不当作零；配置费用上限时，由于当前修复
  输出没有可信费用度量，保守阻塞。后续接费用测量前不能声称该配置下可启动修复。
- 暂停和取消沿用现有控制入口，并把未确认停止的修复 Attempt 计入活动事实。
  数据库触发器同时阻止通用收尾/恢复入口释放其 claim、slot 或资源租约。
- `settle` 的停止证据必须由受监督 Core 消费者在事务外核验，不能取自模型正文。
  owner、host、授权版本和当前 claim/slot fencing 不一致即零写入拒绝；结果重放只读，
  矛盾结果 conflict。取消后的结果仅记账，不能复活 Run、释放资源或放行后继。
- 风险、额度、停止不确定和无效输出均保留人工阻塞，既有阻塞不可被后续成功输出、
  再授权或脚本清除。修改候选只进入待验证暂停，不写 Task passed、集成成功或 Git 提交。

## 验证与影响范围

受测起点为 `714b9c09d661a52bd485bc138bfac321d43a4898` 加本任务工作树变更。
本地定向结果：

| 检查 | 结果 | F-002 runtime-logs 证据 |
| --- | --- | --- |
| 修复 Run/准入、预算、控制、持久恢复、真实双进程竞争、Core 装配 | 36 passed | test-mtx2al1m.log |
| v44→v45 升级/备份保留、失败事务回滚 | 2 passed | test-zqbfu8so.log |
| F-001 输入/输出契约 | 6 passed | test-zqbfu8so.log |
| TypeScript | exit 0 | test-f8f34dzc.log |
| 包边界 | exit 0，394 文件无诊断 | test-7zhpnhrd.log |

完整 stdout/stderr、真实退出码和运行描述保存在 Harness
`verifications/F-002/runtime-logs/`，历史 RED/调试失败日志也保留。上述日志对应各自
已通过的文件/检查；没有把失败运行的总结果记为通过。

独立回归范围由 `test/index/phases/P05/features/P05-8/tasks/F-002.json` 登记：新增行为和
F-001 契约，以及受影响的入队/编码准入/资源互斥、暂停/取消/resume、派发收尾与崩溃窗口、
迁移器和 Core 组合根。较广回归由 Nezha 执行，本地保持 not_run；未启动全仓、Phase
验收或真实模型。此 Task 的通过声明不代表整个 GitAgent Feature 已完成验收。
