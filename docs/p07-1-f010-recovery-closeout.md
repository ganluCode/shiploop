# P07-1 / F-010 恢复闭环收尾与组合隔离交接

F-010 是 P07-1 的收尾 Task：把 F-001～F-009 交付的边界夹具、fencing、Verifier/回执恢复、
诊断与显式继续装配成默认 Core/Host/CLI 入口下的代表性闭环，并叠加一个组合隔离场景；
维护每 Task 局部测试索引与 Feature 去重并集，形成可复核的 FR-1/FR-2 映射与交付证据。

## 默认入口代表性闭环（真实 Host/SQLite/Git/受控进程；零模型请求）

`test/modules/recovery/p07-1-f010-loop-verifier.test.ts`
（`[case:f010-verifier-boundary-loop]`）：生产 Verifier 批次定版（passed）、
Task 提交前强杀 Host → 重启恢复核对完成（retained/paused，不自动通过）→
同一持久事实经真实 loopback HostClient、CLI JSON（`execution recovery`）与同库
Core 只读装配三通道一致，连续查询零副作用 → 显式继续经默认 CLI
（`execution resume`）→ 新 Attempt 真实重验并提交一次。最终断言不依赖输出
字符串：Attempt 序列 `interrupted,succeeded`、task_commit 回执 succeeded 且
actual_commit 即 HEAD、Git commit 数恰 +1、原 worktree 代码内容保留且干净、
预算累计（attempts/runtime 各 +1，deadline 与预算快照不变）、恢复保持解除
（Run 离开 interrupted/paused 且 reason 不再是 restart_recovery）、进程树缺席
（检查进程/worker 全部退出，重启 Host 协作关闭退出码 0）。

`test/modules/recovery/p07-1-f010-loop-git-receipt.test.ts`
（`[case:f010-git-receipt-loop]`）：条件 post-commit 钩子在真实 commit 落盘后
阻塞回执事务，此时强杀 Host → 重启诊断隔离旧 Attempt、副作用核对 matched、
回执保持 pending、预算不变 → 三通道查询 pending 回执一致可见（pending 回执
存在时下一步 resume 可执行）→ 显式 CLI resume 触发受信结算：原回执补记
succeeded（actual_commit 即强杀时 HEAD），不重放 Git；后续获准执行代码无变化
沿用 no_change。最终 Git commit 数与强杀时完全一致（不重复提交）、worktree
保留且干净、预算累计 2/2、进程树缺席、协作关闭退出码 0。

## 组合隔离场景（旧写入者停止未知 + 遗留锁/外部漂移）

`test/modules/recovery/p07-1-f010-combined-isolation.test.ts`
（`[case:f010-combined-unknown-writer-lock]`）：

- Runner 执行中强杀 Host；受控工具组按监督者断连升级自灭后，测试在 worktree
  启动一个脱离受控组的真实旧写入者（TERM 免疫、持续写 heartbeat），并把持久
  占用身份篡改为指向它（startTime 不可核对＝PID 复用/旧标识场景），叠加外部
  遗留 `index.lock`。
- 重启后恢复停止身份不符→不猜杀、不确认（`stop_unconfirmed`）；屏障证明竞争
  重叠：`stop_unconfirmed` 观察落库时旧写入者文件仍在增长，且其写入同时构成
  恢复核对观测到的工作区漂移；恢复证据同时记录 `stop_unconfirmed` 与
  `git_lock_present`。
- 诊断与隔离经 HostClient 与 CLI 一致展示（下一步被 `stop_unconfirmed`、
  `workspace_quarantined`、`quarantined_occupancy` 阻塞）；迟到 runtime 结果按
  过期执行身份忽略（`stale_execution_identity`）；未启动新执行（Attempt/Runtime
  启动计数不变、Task 不通过、无 Git 副作用）；未删除代码（worktree 与
  heartbeat 现场保留）。
- 修复前置事实（外部停止旧写入者、移除遗留锁）后不自动继续；受控重启重评
  恢复：reprobe 确认停止、锁/漂移缺口从证据中消失，但录制水位等不可补证事实
  保持隔离——继续仍需显式授权，显式 CLI resume 被失败关闭拒绝（退出码非 0、
  ok=false 信封），不绕过未核事实；预算/Attempt/启动计数全程不变。
- 隔离未解除时装配级 close 按设计失败关闭（quiesce 未确认退出非 0，不借
  close 释锁）；进程退出释放 OS 写锁供下一次受控启动。测试收尾按 p03-9 同一
  纪律先撤隔离租约再协作关闭（退出码 0）。

## FR-1 / FR-2 到各 Task 真实测试的映射

| 分支 | 真实测试（文件内 case） |
| --- | --- |
| FR-1 正常：验证边界重启→诊断→显式继续 | F-006 `p07-complete-revalidate`；F-010 `f010-verifier-boundary-loop`（默认三通道闭环） |
| FR-1 正常：commit 已落盘回执未写→核对→受信结算 | F-007 `task-restart-intact`；F-008 `f008-matched-resume-settles`；F-010 `f010-git-receipt-loop`（CLI 发起闭环） |
| FR-2 正常：重启后旧 Attempt/Git/锁结构化核对 | F-009 `f009-restart-diagnostics-resume`（三通道一致+零副作用）；F-010 两条闭环 |
| PID 身份不符/复用 | F-002 `recovery-identity-boundary`、`git-lock-identity-race`（仓库实体身份）；F-003 stop reprobe；F-010 `f010-combined-unknown-writer-lock`（身份不符不猜杀） |
| 迟到 owner/迟到结果 | F-006 `p07-verifier-orphan`（迟到 CheckResult stale 拒绝）；F-007 旧 owner 回执 finalize stale 拒绝；F-004 迟到恢复结果 CAS 隔离；F-008 `f008-resume-replay-conflict`；F-010 组合场景 `runtime_completed` → `stale_execution_identity` |
| DB 落库失败/回执未持久化 | F-001 git 提交屏障（确定性构造）；F-004 SQLite fencing/CAS；F-007 二次落库失败幂等；F-008 结算收尾事务 |
| 遗留锁 | F-002 `git-lock-identity-race`（claim 争用）；F-005 recovery-git-reader 锁探测失败关闭；F-010 组合场景（index.lock 与停止未知叠加） |
| 工作区变化 | F-005 恢复期 tracked 漂移回归（p03-9-f006）；F-006 `p07-code-drift`；F-010 组合场景（恢复观察期 heartbeat 漂移） |
| 证据缺失 | F-007 `task-restart-missing-inspection`（verification_evidence_missing）；F-008 `f008-unknown-effect-resume-refused`；F-006 `p07-corrupt-output` |
| 无确定证据不接管/不重复提交/不释放占用 | 上述各隔离场景；F-010 组合场景修复后仍隔离、显式授权被拒 |

每 Task 局部索引位于 `test/index/phases/P07/features/P07-1/tasks/F-00N.json`
（F-001～F-010 全部登记），Feature 去重并集由 `feature.json` 引用；
Feature 门禁按 task_union 模式重跑去重索引，不复制历史矩阵到单个巨型文件。

## 计数差异（恢复相关口径）

| 事件 | attempts_created / runtime_starts | 说明 |
| --- | --- | --- |
| 同进程网络/连接重试 | 不变 | 请求级重试属存活 Attempt 内行为，不产生新计数 |
| Host 进程重启（恢复观察/reprobe） | 不变 | 三条闭环与组合场景重启段预算均保持 1/1 |
| 显式 resume 后获准新 Attempt | +1 / +1 | 两条闭环终态 2/2；deadline 与 budget_snapshot 不变 |
| 受信结算/no_change 收尾 | 不变 | 复用已发生的 commit，不新增提交或启动 |
| 未解隔离期间的修复/查询/拒绝 | 不变 | 组合场景全程预算 1/1，直至测试结束 |

## 本地验证记录

工具链：Node 22.19.0（`process.execPath` 固定）、macOS/darwin、仓库本地
vitest 5.0.3（scripts/run-tests.ts fail-closed 启动器）。受控助手保留完整
stdout/stderr、真实退出码与 sidecar；日志位于 Harness
`verifications/F-010/runtime-logs/`。

| 内容 | 结果 | 日志 |
| --- | --- | --- |
| F-010 三文件合并回归 | 3/3 通过，105.5s，exit 0 | `test-iuzpgg5q.log` |
| 闭环一单文件复跑 | 1/1 通过，72.9s，exit 0 | `test-4zdhz8jp.log` |
| 闭环二单文件复跑 | 1/1 通过，96.8s，exit 0 | `test-r9pl2v81.log` |
| 组合场景单文件复跑 | 1/1 通过，48.0s，exit 0 | `test-4lnbez8e.log` |
| TypeScript 类型检查 | exit 0 | `test-ejxpaxu8.log` |
| 模块边界检查 | 473 生产文件 0 诊断，exit 0 | `test-_4ky_bdt.log` |

迭代过程 RED/调试失败日志保留（不覆盖）：`test-mf3typbd.log`（闭环一首次
运行：Task 已通过后等待 Run 终态超时，改为断言恢复保持解除）、
`test-0dfsfajc.log`/`test-z7esqxli.log`（CLI pending 回执投影字段假设错误）、
`test-_yhz_xth.log`/`test-q9d4qn_i.log`（SQL 字符串字面量引号错误）、
`test-cjoh8ieq.log`（结算后立即断言租约数，忽略新 Attempt 即时认领）、
`test-02t71yw8.log`（监督者组等待语义：后代存活阻塞批次定版）、
`test-ycx0htzc.log`/`test-v86zn_lb.log`（组合场景屏障/身份不可变约束发现）、
`test-fixf2_zy.log`/`test-3ug9zu1v.log`（工具超时与断连升级杀死写入者）、
`test-gma91lu1.log`（隔离未解除时装配级 close 失败关闭退出码 1）。

每条闭环按场景名落盘结构化证据（`p07-1-evidence/*.jsonl`，含故障前后两拍、
实体/进程/Git/预算快照与代码版本绑定）；临时根在测试收尾按缺席核验后删除。

## 范围与已知缺口

- 本 Task 未修改生产源码：闭环与组合场景全部经默认 Core/Host/CLI 入口驱动；
  仅有三类可信测试故障点（FakeRuntime 门闩与受控工具命令、条件 post-commit
  钩子、测试注入的旧写入者/遗留锁/身份篡改——后者与 p03-9 f016 同一模式）。
- 索引中较广受影响回归（F-006/F-007/F-008/F-009 及 p03-9 f013/f014/f015）
  由 Nezha 独立复验，本地未运行的不计为通过。
- 全仓历史回归、`npm run verify` 全量门禁、真实模型与 live 验证未执行
  （not_run）；P07-1 Task 完成声明不等于 Phase 验收通过。
- Run 终态结算依赖 Feature 收尾消费者装配（测试 Host 未装配
  finalizationExecution/finalizationCompletion 时调度保留 capability gap），
  闭环断言到「恢复保持解除、Task/回执/预算一致」为止，不冒充 Feature 收尾。
- 既有基线缺口沿用前序记录：p03-9-f016 等旧夹具缺已确认 Profile 的用例、
  Feature 分支命名 `feat/2026-10-29-21-59-22_p07-1-fencing` 与
  git-naming.md 的 `feat/p07/<key>` 不符（编排者绑定，Runtime 未改名）。
