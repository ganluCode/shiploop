# P03-9 暂停、取消与幂等恢复收尾 — Feature 交付与前序接口交接

日期：2026-10-19。分支：`feat/2026-10-11-17-45-49_p03-9`；基线（与 `feat/2026-10-11-17-45-49_p03-8-git-feature` 的 merge-base）：`7b7dc88`；交接时 HEAD：`e4e12fa`。
状态：F-001..F-017 全部通过，F-018 交接本记录；**Feature 完整 verify（全量测试、类型检查、边界检查与构建）由 Nezha 在所有 Task 通过后独立执行，本记录不宣称全量 verify 已通过**。

## 1. 实现范围与提交

| Task | 交付 | 主提交 | 聚焦测试（通过数） |
| --- | --- | --- | --- |
| F-001 | Run/Batch Task 边界暂停：`execution.pause`、迁移 v27、`execution.run.paused`/`execution.batch.paused` | `40f9888` | `test/p03-9-f001-execution-pause.test.ts`（7） |
| F-002 | Run/Batch 取消意图与终态竞争：`execution.cancel`、迁移 v28 `execution_stop_operations`、4 类取消事件 | `874ea0e` | `test/p03-9-f002-execution-cancel.test.ts`（13） |
| F-003 | 取消接入 Runtime/Verifier 停止端口：迁移 v29 停止证据列、`execution-stop` Artifact | `ad4ba27` | `test/p03-9-f003-execution-stop.test.ts`（6） |
| F-004 | Session/工具/检查/Run/Batch 分层时间上限，超时复用受控停止 | `7556d01` | `test/p03-9-f004-time-limits.test.ts`（10） |
| F-005 | Host 启动 Work 恢复门控：有界扫描、fencing、recoverStop、停止证据；人工修复补齐 v29 迁移回归期望 | `222bfa9`、`3ffcabf` | `test/p03-9-f005-startup-recovery.test.ts`（15） |
| F-006 | 恢复现场核对与占用收尾：worktree/Git/记录水位/原生档案元数据对账，Run→paused、workspace→retained；attempt-2 补齐 v29 期望 | `d28e643`、`5c682ac` | `test/p03-9-f006-recovery-reconciliation.test.ts`（8） |
| F-007 | 同 Task auto/new/required 续接决策与不可变来源快照 | `cd13915` | `test/p03-9-f007-recovery-continuation.test.ts`（10） |
| F-008 | 显式工作流 `execution.resume`：重新授权、原 worktree 增量继续、幂等编排 | `3a2261c` | `test/p03-9-f008-workflow-resume.test.ts`（8） |
| F-009 | retryFinal 只读资格判定与受限 finalization scope | `82bda79` | `test/p03-9-f009-finalization-retry.test.ts`（7） |
| F-010 | `execution.retryFinal` 创建 finalization-only 新 Run、父 Batch 预算扣减；attempt-2 同步 Host 命令宣告 | `04eaa92`、`d84d1f6` | `test/p03-9-f010-finalization-run.test.ts`（8） |
| F-011 | finalization-only Run 确定性重验与 Feature 全量门禁，禁止进入编码调度 | `06add86` | `test/p03-9-f011-finalization-execution.test.ts`（9） |
| F-012 | finalization 审批继续、Git operation 幂等核对与完成 CAS | `98db678` | `test/p03-9-f012-finalization-completion.test.ts`（8） |
| F-013 | 控制进度、恢复诊断与 finalization 收尾结果查询 | `1be6f52` | `test/p03-9-f013-control-recovery-query.test.ts`（11） |
| F-014 | Host/HostClient 控制、retryFinal 与恢复诊断接线 | `9cef2ac` | `test/p03-9-f014-host-control-wiring.test.ts`（7） |
| F-015 | CLI Run/Batch 控制、retryFinal 与恢复诊断入口 | `3e74f62` | `test/p03-9-f015-cli-control.test.ts`（18）、`test/p03-9-f015-cli-control-vertical.test.ts`（4） |
| F-016 | 真实 Host 强杀与恢复集成；产品修复对账成功后 Task 回退 pending | `4c177e7` | `test/p03-9-f016-host-kill-recovery.test.ts`（4） |
| F-017 | Host/CLI finalization-only 端到端回归；scheduler/Verifier/completion 产品修复 | `e4e12fa` | `test/p03-9-f017-finalization-host-vertical.test.ts`（10） |
| F-018 | 本交付与接口交接记录及守护测试（`f6e12d4`）；attempt-2 修复 `test/p03-3-runtime-start-reservation.test.ts` 迁移期望至 v29（仅测试期望）；attempt-3 将 F-017 并发 retryFinal 断言去时序化（不同 commandId 竞争 + 同 commandId 确定性幂等重放）并提高 F-012 提交重试用例超时预算至 180s（不改断言） | `f6e12d4` | `test/docs-p03-9-handoff.test.ts`（6）、`test/p03-3-runtime-start-reservation.test.ts`（18） |

输入版本：源 PRD `input/p03-run-control.md`（v0.3，2026-10-11，含 2026-10-13 恢复补充与 2026-10-14 实现选择）；共同约束 `input/execution-contract.md`；P02 基线 `0e76ad8`（main）。

基线/工具版本（交接时实机）：Node v22.19.0、npm 10.9.3、TypeScript 7.0.2、vitest 5.0.3、better-sqlite3 13.0.3、drizzle-orm 0.45.3、macOS 26.6.2。前序各 Task 日志中记录的版本以当日实机为准，类型/边界检查在前序 Task 均 0 diagnostics。

## 2. 证据关联维度

- **开发编排证据**（本 Feature 报告与 `verifications/F-0xx/runtime-logs/`）关联 Nezha 的 Feature `2026-10-11-17-45-49_p03-9`、Task F-001..F-018、会话 attempt 与提交 operation；Nezha 编排状态与产品 ShipLoop 内部 Run/Attempt 状态不混用。
- **产品内集成证据**（F-005/F-016/F-017 等纵向测试）在临时数据根创建真实 Project/Feature/Run/Attempt/operation，断言 SQLite 状态、`runtime_starts`、停止 operation 与 Artifact 引用；日志脱敏，不含绝对路径/凭据/模型输出。
- 每条聚焦/回归日志带 `.log.exitcode`/`.log.json` 旁文件保存真实退出码；证据目录：本 Harness feature workspace 的 `verifications/F-001`..`verifications/F-017`（含 `F-005/c439c1d2…/verification.json` 独立验收、`F-017/f017-e2e-evidence.json` 端到端证据）。

## 3. FR-1/FR-2/FR-3 验收映射（正常例、关键负例、真实资源断言）

状态语义：**通过** = 对应聚焦测试已通过并留有日志；**not_run** = 本 Feature 范围外或未验证能力，不折算通过。

### FR-1 控制与停止核验（映射 T06、T13）

| 维度 | 内容 | 状态 |
| --- | --- | --- |
| 正常例 | 无活动 Attempt 安全 paused、活动 Attempt 先收尾再 paused（F-001）；cancelling→确认停止→cancelled、Batch 传播（F-002）；停止证据 Artifact 含 executionStage/退出码/信号/forced（F-003）；Session/工具/检查/Run/Batch 四层独立上限与最早持久截止归因（F-004）；Host 回执-查询-SSE 一致（F-013/F-014）；CLI 结构化输出区分 pausing/cancelling/stop_uncertain（F-015） | 通过 |
| 关键负例 | 重复 commandId 返回原回执、同 ID 异摘要拒绝、过期 revision、终态 `already_terminal` 不倒写、跨项目/无权限拒绝（F-001/F-002）；身份失配不误杀无关进程、探测失败/旧组不可核对→`interrupted`/`quarantined` 不释放占用（F-003）；已过 deadline 不启动、迟到取消不覆盖已落库结果（F-004）；`command_expired`、未知操作 501、线响应畸形拒绝、SSE 断开不取消（F-014）；未知用量/退出/耗时保持 null 非 0（F-013/T13） | 通过 |
| 真实资源断言 | 真实临时 SQLite 事务/CAS 竞争；真实受控挂起 Runtime/Verifier 进程组停止（T06）；父进程退出但子进程仍写文件时占用保留（F-003）；真实受控进程超时停止（F-004） | 通过 |

### FR-2 重启与显式继续（映射 T08 恢复子集、T25、T40 通用决策子集）

| 维度 | 内容 | 状态 |
| --- | --- | --- |
| 正常例 | Host 启动先恢复核对再放行，扫描/fencing/停止有界幂等（F-005）；对账通过 Run→`paused`、workspace→`retained`、仅释放匹配 holder 的 lease（F-006）；auto/new/required 决策与不可变续接输入保存请求模式/实际决策/原因/来源身份/完整策略（F-007，T25/T40 决策子集）；显式 resume 原 worktree 增量继续、passed Task 不重编码（F-008，T08 幂等复用）；强杀重启后重复/并发 resume 仅一个新 Attempt、复用同一 worktree（F-016） | 通过 |
| 关键负例 | 不因租约过期认定停止、身份/工作区失配不误杀、旧 owner/version 回写 fencing 拒绝（F-005，T06）；遗留 Git 锁只检测不删除、外部 HEAD 漂移、记录水位缺失/原生档案异常→保留隔离（F-006，T08 脏目录不清理/错误分支拒绝）；策略变化不静默沿用旧模型、来源缺失/损坏、required 未支持拒绝且不启动（F-007，T25 快照不可变）；终态 Run 不复活、授权/预算/占用检查失败零启动（F-008）；换 Session 不避开隔离、迟到结果拒绝（F-016） | 通过 |
| 真实资源断言 | 真实 Host/SQLite/锁/受控 FakeRuntime 子进程，SIGKILL Host 后重开核对（F-016，T06）；真实临时 Git worktree 登记/HEAD/父提交核对（F-006/F-012，T08）；受控子进程持续写文件、持久身份核对（F-005/F-016） | 通过 |

### FR-3 仅最终验收/收尾重试（映射 T21、T36）

| 维度 | 内容 | 状态 |
| --- | --- | --- |
| 正常例 | retryFinal 资格判定输出受限 scope 与缺失步骤（F-009）；finalization-only 新 Run 同事务创建/计数/回执/事件、父 Batch 预算扣减（F-010）；失效证据重验+Feature 全量检查、零编码承诺（F-011，T36）；审批继续、Git operation 复用/核对、完成 CAS（F-012）；`runAppCli → HostClient → Host → Core` 端到端（F-017） | 通过 |
| 关键负例 | 错误 workKey/项目/非终态 Run/授权失效拒绝（F-009）；maxRuns/无进展/deadline/不可继续 Batch 结构化拒绝、双命令竞争不超扣（F-010，T21）；零测试/not_run/error/inconclusive 检查不通过、源码/检查定义漂移失效（F-011，T36）；hook 改源码、HEAD 漂移等待重验不 reset（F-012）；并发重复 retryFinal 恰建一个 Run、取消后不自动继续（F-017，T21） | 通过 |
| 真实资源断言 | 真实临时 Git/SQLite/Artifact；`FakeRuntime` 启动数 0 且 SQLite `runtime_starts` 不变（T36）；真实 Git 提交已发生回执丢失按事实 reconcile、不重复提交；真实受信 Node Verifier 执行检查（F-017） | 通过 |

### not_run 与后续范围（不折算通过）

- 真实 Pi SDK/付费模型：not_run；T40 原生续接与 T41 由 P04 落实，本项仅交付 Fake/通用决策（auto 记录降级、required 拒绝）。
- 扩展真实故障矩阵（云/NAS/多机）：not_run，P07 范围。
- P03-10 阶段验收脚本：本 Feature 不提供 `accept:p03`，阶段验收由 P03-10 交付。
- Windows/WSL/Linux：未运行；首版仅 macOS。
- Pi Durable：按 [实验决定] 保持候选，不在一期默认路径；`core-design/14-runtime-recovery-and-durable.md` 边界保持。

## 4. 前序接口交接（实际公共接口与测试入口）

### 4.1 Host 控制/查询

- **命令**（project scope、`execution.start` 能力位，经既有 `POST /v1/commands` 冻结信封/回执/幂等通道；`packages/core/src/ports/commands.ts`）：`execution.pause`、`execution.cancel`（Attempt/Run/Batch 目标）、`execution.resume`、`execution.retryFinal`。
- **查询**（`packages/core/src/ports/execution-control-query.ts`）：`execution.run.control.get`、`execution.batch.control.get`、`execution.run.recovery.get`；Host 路由 `GET /v1/runs/:runId/control`、`GET /v1/batches/:batchId/control`、`GET /v1/runs/:runId/recovery`（`packages/host/src/contract/constants.ts`）。`EXECUTION_CONTROL_NEXT_ACTIONS` 冻结词汇：`none`/`resume`/`resume_blocked_occupancy`/`await_attempt_settlement`/`await_stop_settlement`/`stop_reconcile`/`retry_final`；`validateRunFinalizationScope` 对损坏 scope fail-closed。
- **HostClient**（`packages/host/src/client/app-client.ts`）：`pauseExecution`/`cancelExecution`/`resumeExecution`/`retryFinalExecution`/`getRunControl`/`getBatchControl`/`getRunRecovery`；线校验在 `packages/host/src/client/app-wire.ts`（未知键/版本/动作、伪造 finalization、零用量冒充均 `response_malformed`）。能力宣告同源：`packages/host/src/contract/lifecycle.ts` 的 `APPLICATION_COMMAND_CAPABILITIES`/`APPLICATION_QUERY_CAPABILITIES`。
- **CLI**（`packages/cli/src/app/args.ts`、`packages/cli/src/app/run-control.ts`）：`execution pause|cancel|resume|retry-final|control|batch-control|recovery`；只经 HostClient，不打开 SQLite。
- 测试入口：`test/p03-9-f013-control-recovery-query.test.ts`、`test/p03-9-f014-host-control-wiring.test.ts`、`test/p03-9-f015-cli-control.test.ts`、`test/p03-9-f015-cli-control-vertical.test.ts`。

### 4.2 恢复顺序（Host 重启 → 可继续）

1. Host 取数据根锁、打开 schema、完成 P02 baseline 恢复。
2. Work 恢复门控（`packages/core/src/ports/work-startup-recovery.ts`、`application/work-startup-recovery.ts`）：有界扫描非终态 Run/Attempt 与占用，先递增 Task fence、旧 Attempt 保留 `interrupted`，经既有 recoverStop 核对旧进程停止，证据先落 SQLite 再发布 Artifact（`packages/core/src/ports/execution-stop.ts` 语义）。
3. 现场对账（`packages/core/src/ports/work-recovery-reconciliation.ts`、`adapters/fs/recovery-git-reader.ts`）：worktree 归属/分支/HEAD/代码摘要、Git 意图与实际父/tree/HEAD、记录水位与缺口、原生档案元数据只读（不打开原生库）；全部通过才开放门控，Run→`paused`、workspace→`retained`，仅释放匹配 holder lease（`readForRecovery`/`releaseRecovered*`）；对账成功后仍为 running 的 Task 回退 `pending`。
4. 显式 `execution.resume`（`packages/core/src/application/execution-resume.ts`）：重核授权/策略/预算/deadline/占用后按 DAG 预演进入缺失步骤；不创建 Attempt/worktree、不启动 Runtime。
5. 认领时续接决策（`packages/core/src/ports/work-recovery-continuation.ts`）：auto/new/required，核对 F-006 reconciled 现场、旧占用与停止、来源 Attempt/Session/归档/检查点、当前完整策略；生成不可变续接记录 Artifact（`WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION=1`，kind `work-recovery-continuation`）接入 `ContextBuildInput.recovery`/`PreparedExecutionInputGroup.recovery` 与 Attempt 快照读回。
- 测试入口：`test/p03-9-f005-startup-recovery.test.ts`、`test/p03-9-f006-recovery-reconciliation.test.ts`、`test/p03-9-f007-recovery-continuation.test.ts`、`test/p03-9-f008-workflow-resume.test.ts`、`test/p03-9-f016-host-kill-recovery.test.ts`。

### 4.3 统一占用

- workspace lease（owner/host/version）+ Task `executionVersion` fencing + Run/Batch revision CAS 共同构成占用；`interrupted`/`quarantined` 及停止不确定不释放占用；恢复释放仅匹配 holder；同一原生档案单写入者，不因恢复开启并发续写。
- 测试入口：`test/p03-9-f002-execution-cancel.test.ts`（interrupted 占用保留）、`test/p03-9-f003-execution-stop.test.ts`（隔离）、`test/p03-9-f005-startup-recovery.test.ts`、`test/p03-9-f016-host-kill-recovery.test.ts`（换 Session 不避开隔离）。

### 4.4 当前策略快照与 finalization scope

- **策略快照**：F-007 续接记录为不可变输入，携带当前完整获准策略与来源身份；策略不兼容不静默沿用旧模型；快照脱敏、Attempt 间独立（T25）。
- **finalization scope**：`packages/core/src/ports/finalization-retry.ts` 的 `FINALIZATION_RETRY_SCOPE_SCHEMA_VERSION=1`、`FINALIZATION_PENDING_STEPS`（`task_revalidation`/`feature_verification`/`approval`/`reconcile_commit`/`commit`/`finalize`）、`FINALIZATION_RETRY_REJECTED_REASONS`；Run `inputSnapshot.finalization` 保存受限步骤与历史 Run/Batch 身份；`FINALIZATION_RETRY_RUN_KIND='finalization-only'`，零编码承诺（`coding.taskIds=[]`、`runtimeStarts=0`、`newAttempts=0`）。
- 测试入口：`test/p03-9-f009-finalization-retry.test.ts`、`test/p03-9-f010-finalization-run.test.ts`、`test/p03-9-f011-finalization-execution.test.ts`、`test/p03-9-f012-finalization-completion.test.ts`、`test/p03-9-f017-finalization-host-vertical.test.ts`。

## 5. F-018 质量门禁交接

- 本 Task 新增交接文档与守护测试；attempt-1 独立验收唯一失败为 `test/p03-3-runtime-start-reservation.test.ts` 迁移期望仍冻结 v28（F-003 已引入 v29 的前序既有失败，位于本清单内），attempt-2 将该文件两处期望（`appliedVersions` 与 `SQLITE_MIGRATIONS` 版本连续性）补齐 29，未改迁移 SQL/checksum/生产逻辑。attempt-2 独立验收另暴露两个负载相关时序失败（attempt-1 同清单下通过，本地单独运行均通过）：`test/p03-9-f017-finalization-host-vertical.test.ts` 并发重复 retryFinal 用例对双进程启动时序敏感（同 commandId 晚到时幂等重放返回原成功结果属产品正确行为，非缺陷），attempt-3 改为不同 commandId 并发竞争（碰撞与晚到均被 conflict 拒绝）并追加同 commandId 确定性幂等重放断言（返回原 Run、不重复创建），不断言强度；`test/p03-9-f012-finalization-completion.test.ts` 提交重试端到端用例在验证器全量负载下超默认 60s，attempt-3 将该用例超时预算提为 180s（不改断言）。验证：`node scripts/run-tests.ts test/docs-p03-9-handoff.test.ts` 6/6、`test/p03-3-runtime-start-reservation.test.ts` 18/18、`test/p03-9-f017-finalization-host-vertical.test.ts` 10/10（294s）、`test/p03-9-f012-finalization-completion.test.ts` 8/8（262s），均退出码 0，完整日志：Harness workspace `verifications/F-018/runtime-logs/`（`test-65i5n75y.log`、`test-msihqrnt.log`、`test-vg0tjzab.log`、`test-_n4c_jr_.log` 等）。
- 受影响回归选择清单：`verifications/F-018/test-selection.json`（本 Feature 全部 `test/p03-9-*.test.ts` 及直接相关契约/装配回归），交由 Nezha 独立 affected 回归；未在本地运行的文件不声明通过。
- Feature 完整门禁即项目 `npm run verify`（全量测试、类型检查、边界检查与构建，`scripts/verify.ts` 编排）由 Nezha 执行；全量必需通过，失败不得宣布 Feature 完成。保留全部既有负例与门槛，本 Task 未删测试、未降权限与验收要求。

## 6. 已知缺口与后续范围

- Pi 原生续接/跨模型历史互通、真实认证与用量：P04（T40 原生部分、T41）；本项 Fake 能力边界如实。
- 扩展故障矩阵与多机：P07。
- 阶段验收脚本：P03-10；本记录不提供 `accept:p03`。
- 前序遗留：attempt-1 迁移期望冻结与 attempt-2 两个负载相关时序失败均已在后续 attempt 修复；无未解决阻塞。F-005 rework_count=3 与 F-006/F-010/F-018 rework_count=1 的历史失败会话/日志按原样保留于各自 `verifications/`，修复提交均已合入本分支。
