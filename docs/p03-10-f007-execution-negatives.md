# P03-10 / F-007 执行负例组

本任务增加持续检查失败的真实 CLI/Host 纵向场景，并将既有预算、认领、范围与资源门控负例按稳定 case ID 组合为可执行索引。生产代码无需修改。

## 场景与验收映射

| 验收点 | 索引中的用例 | 核对内容 |
| --- | --- | --- |
| 首次失败及最多两次修复后停止 | `persistent-check-failure` | 构建 CLI 注册、配置、批准、授权；Fake 实际修改文件；真实 Node 检查进程三次退出 1；生产 Verification/Task completion 负责结算。恰好 3 个失败 Attempt/CheckResult/Session，父计数为 Run=1、Attempt=3、Runtime start=3；Task failed，Feature 非 completed。 |
| SQLite 并发、唯一 owner/version、重复请求和 CAS | `batch-race`、`run-race`、`attempt-race`、`start-race`、`settlement-*`、`claim-*`、`late-*`、`task-fence` | 真实独立进程经 barrier 竞争同一 SQLite；核对唯一成功、预算及账本/事件数量。认领竞争另明确核对唯一 Task/Attempt owner/version、三项 lease 归属、零 Runtime 启动和重开持久不变。旧身份成功通知及 CAS 冲突不覆盖新状态。 |
| 累计预算与成功 workKey | `success-work-key`、`shared-parent-budget`、`deadline-limit`、`no-progress-limit` | 成功不退款、不自动重入；重开/显式新 Run/更换模型策略不清父预算；绝对 deadline 到界及无进展上限拒绝新增工作，计数不溢出。 |
| 依赖、无待办与预览范围 | `dependency-*`、`empty-scope`、`no-pending-work`、`preview-stale` | failed/skipped/cancelled 和缺通过证据都不能认领后继；拒绝后数据库快照不变；无待办返回 no_work，过期摘要返回 preview_stale，零 Batch/Run 创建。 |
| Work/baseline、Git 公共元数据、事件归属 | `baseline-work-*`、`baseline-work-lock`、`linked-worktree-lock`、`git-lock-race`、`task-event-isolation`、`foreign-recording` | 双向占用拒绝和真实竞争单赢家；linked worktree 共享 Git common-dir 锁并保留原生锁；不同 Task 的事件/取消互相隔离，外来事件不进入当前持久记录水位。 |

完整路径和精确 case 列表见 `test/index/phases/P03/features/P03-10/tasks/F-007.json`：11 个文件、35 个展开后唯一 case。为被选旧用例增加稳定 ID，参数化用例分别展开为不同 ID；保留原有行为断言，并补强认领竞争的 owner/version、启动数与重开断言。Harness 的 `verifications/F-007/test-selection.json` 只引用此仓库索引。

持续失败场景的修复先读取同 worktree 内已存在的 tracked `README.md` 和 untracked `chain-2.txt`，再追加内容；第三次失败时两份文件都包含两次修复内容。检查正文经制品端口读取，每个 CheckResult 核对退出码、超时标记与独立输出制品。停止时代码仍保留在工作区，三个失败现场和检查输出导出后才执行夹具清理。

Run 在代码次数耗尽后为 `paused / code_attempts_exhausted`。调度公开契约按 Run 控制优先返回 `run_control_blocked`、空 `readyTaskIds` 和 `readiness.state=blocked`；chain-2 持久状态仍为 pending、没有 Attempt。不能要求此时查询一定返回 `dependency_failed`；独立 `dependency-*` 用例验证未被 Run 控制遮蔽的依赖门控。重复原 execution.start 的请求不新增 Run、Attempt、Session、启动记录、预算、事件或回执。

## 本地验证与证据

所有执行经 `.dag_context.json` 的 Nezha test-command wrapper 保存完整合并输出、`.log.json` 和 `.log.exitcode`，位于 Feature workspace 的 `verifications/F-007/runtime-logs/`。

| 验证 | 最终日志 | 实际结果 |
| --- | --- | --- |
| `node scripts/run-tests.ts test/modules/acceptance/p03-10-execution-negatives.test.ts` | `test-8trgi67z.log` | exit 0；1 passed、0 failed、0 skipped |
| 认领文件，仅 `claim-same_task / claim-different_tasks / claim-idempotent` | `test-yzuigm86.log` | exit 0；3 passed、0 failed、32 skipped；未宣称整个文件通过 |
| 最终 `npm run typecheck` | `test-jfq6snmu.log` | exit 0 |
| Nezha 索引加载/路径规则及 Vitest 仅收集 | `selection-validation.json`、`selection-discovery.log`、`collected-cases.json` | 11 个文件合法，35 个选定 ID 各出现一次；没有执行这些回归 |

最终纵向证据在 `verifications/F-007/scenarios/persistent-check-failure-29071521-f093-497e-aac6-8686d1b77b08/`：`failure-1/2/3.json`、`persistent-failure-summary.json`、`evidence.json`、`cleanup.json`。清理确认进程树及进程组停止，资源删除成功，耗时 291ms。

初始 RED 和中间断言错误日志均保留：`test-4xywn7nl.log` 检查尚未接入持续失败；`test-h0je9jtz.log` 发现 Run 控制优先的实际调度契约；`test-ochdq0ae.log` 首次 GREEN。后续重跑基于修复增量现场、无序 CheckResult 集合比较和重放副作用断言的实际变化。没有重复未改测试以读取结果。

本地实际执行 4 个用例；索引中其余 31 个用例交 Nezha 独立运行。未执行全仓测试、组合 verify 或 Phase 验收。Fake 运行、局部通过和此索引均不表示真实 Pi/LLM、Feature 完整交付或 P03 阶段验收通过。
