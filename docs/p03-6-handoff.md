# P03-6 异步 Runtime 契约与 FakeRuntime 执行接线 — 真实资源纵向集成与交接（P03-6 → P03-7/9、P04 及 P03-10）

- 来源 Feature：P03-6（F-001 Runtime 端口与可信注册、F-002 执行输入绑定、F-003 确定性
  FakeRuntime、F-004 受控真实工具命令、F-005 可控故障与生命周期、F-006 最小 Work Session
  持久关联、F-007 有界公开证据采集、F-008 认领接通执行、F-009 fenced 结算、F-010 停止
  监督、F-011 只读查询面、F-012 组合根/Host 接线、F-013 CLI 输出、F-014 真实资源纵向
  集成与本文交接）。
- 交接对象：**P03-7**（执行验证/交付方向）、**P03-9**（Run 控制与恢复）、**P04**（标准 Pi
  SDK 适配器，接同一 Runtime 端口）与 **P03-10**（阶段验收 `accept:p03` 提供方；本 Feature
  不创建 `accept:p03`）。
- 输入文档版本：PRD `input/shiploop-v1/p03-work-loop/features/p03-fake-runtime.md`（含
  2026-10-13 Runtime 恢复补充与 2026-10-14 前置交付与实现选择）、共同执行约束
  `execution-contract.md`、恢复边界设计 `core-design/14-runtime-recovery-and-durable.md` 与
  `core-design/05-runtime-and-session-recording.md`；实施契约为 `docs/p03-6-work-session-contract.md`
  与 `docs/p03-6-session-query-contract.md`。
- 基线与代码：P03-5 交接提交 `ad4a383`（同一分支链）、P03-3A 通用恢复协议已合入
  （`docs/p03-3a-handoff.md`、`docs/p03-3a-runtime-recovery-contract.md`、
  `docs/p03-3a-pi-durable-capability-matrix.md`）。各 Feature 提交：F-001 `31483a2`、
  F-002 `0cef36e`、F-003 `d1a3fde`、F-004 `a743da8`、F-005 `9f0fecd`、F-006 `94b3aec`、
  F-007 `7fd38a9`、F-008 `142fcfa`、F-009 `5c2d375`、F-010 `95fa876`、F-011 `63c14ec`、
  F-012 `2644bf9`、F-013 `ad0ca98`；**F-014 交接提交即本文所在提交**（文档先于提交无法
  自引用完整 hash；精确 hash、命令/退出码与脱敏证据以 Feature 工作区
  `verifications/F-014/` 记录为准，未运行不计通过）。
- 工具版本：Node v22.19.0、npm 10.9.3、TypeScript 7.0.2、vitest 5.0.3、better-sqlite3
  13.0.3（`package-lock.json` 锁定）。仅 macOS 验收；Windows/WSL/Linux 为 not_run。
- 本文只交接**已实现且有真实测试**的公共面与失败边界；未实现/未运行能力显式标注
  not_run。**真实 Pi SDK/付费模型：not_run**；Chat 服务、完整 SessionRecorder、真实
  Token/缓存汇总、Verifier/验收装配、完整 Run 恢复：not_run。

## 1. 实现范围（逐 Feature）

| Feature | 交付 | 主要落点 |
|---|---|---|
| F-001 | 异步 Runtime 执行契约（RuntimeExecutionRequest/Handle、事件/结果/停止证据版本化校验、九类 RuntimeError）+ 静态可信注册表 | `ports/runtime-execution.ts`、`ports/runtime-registry.ts`、`application/runtime-execution.ts` |
| F-002 | 不可变执行输入绑定：核验 Attempt/制品/策略/权限/恢复来源，发布按 Attempt 关联的读取证据 | `ports/execution-input-binding.ts`、`application/execution-input-binding.ts` |
| F-003 | 确定性 FakeRuntime：声明式脚本（七种步骤）+ 有界异步事件通道/背压 + 文件三层防线 | `ports/fake-runtime-script.ts`、`adapters/fake-runtime.ts` |
| F-004 | 受控真实工具命令：批准定义装配期快照、CommandProcess 身份提交放行、进程组停止核验聚合 | `adapters/fake-runtime.ts`、`ports/command-process.ts`、`adapters/process/command-process.ts` |
| F-005 | 可控故障与生命周期：await_gate/raise、事件丢失/重复/乱序/门闩、结果与事件结束顺序、取消 acceptOnly、stopped 门闩/未确认、恢复能力差异 | `ports/fake-runtime-script.ts`、`adapters/fake-runtime.ts` |
| F-006 | 最小 Work Session 与 Attempt 持久关联（迁移 v20 `sessions` 表；DDL 身份不可变/set-once/单调约束） | `ports/work-session.ts`、`adapters/sqlite/work-session-store.ts`、`docs/p03-6-work-session-contract.md` |
| F-007 | 最小有界公开事件/结果证据采集器（NDJSON 分块、稳定身份去重、水位、脱敏、完整性复核） | `ports/work-evidence-recorder.ts`、`application/work-evidence-recorder.ts` |
| F-008 | ExecutionService：消费认领/工作区令牌，事务外绑定与能力预检，最终短事务原子建 Session + 启动预占 | `application/execution-service.ts` |
| F-009 | fenced 结算：结果/记录/停止三类事实独立，重复/迟到不重复扣额；Task/Attempt 代次 fence | `ports/runtime-settlement.ts`、`application/runtime-settlement.ts` |
| F-010 | 停止监督：身份匹配取消、Runtime/工具超时、父 deadline、未知停止 quarantined 不释放 | `application/execution-supervision.ts`、`application/execution-workspace-retention.ts` |
| F-011 | 只读查询面：sessions.list/session.get/session.evidence.get + 公开投影与 fail-closed 证据校验 | `ports/work-session-query.ts`、`adapters/sqlite/work-session-query-store.ts`、`docs/p03-6-session-query-contract.md` |
| F-012 | 组合根/Host 接线：Runtime 未装配 runtime_not_found 不认领；取消命令/回执/重放、Host 关闭停止核验 | `adapters/work-execution.ts`、`adapters/composition.ts`、`packages/host` |
| F-013 | CLI execution sessions/session/session-evidence/cancel 结构化输出（五类表达互不折算） | `packages/cli/src/app/work-session.ts`、`packages/cli/src/app/args.ts` |
| F-014 | 真实资源纵向集成、完整门禁与本文交接（不新增产品行为/依赖/迁移） | `test/p03-6-vertical-integration.test.ts`、`test/docs-p03-6-handoff.test.ts` |

## 2. F-014 真实资源纵向集成（验收 1/3；真实 SQLite/Git/文件/受控进程，仅模型决策为 Fake）

`test/p03-6-vertical-integration.test.ts` 两个用例：

1. **全链路纵向**：前序正式入口（project.register → settings → phase/plan 导入 → 批准 →
   execution.input.prepare → execution.start，均为真实命令事务）→ Host 扫描认领 + 真实
   worktree 准备 → 显式 Fake 装配（`read_input`/`write_file`/`tool_command`/`message`/`usage`；
   真实写文件入 worktree、真实 `node -e` 受控工具进程经身份提交放行）→ 构建入口
   `packages/cli/dist/bin.js` 查询。真实 SQLite 断言：
   - 一次启动预占：`execution_batches.runtime_starts = 1`、单 Attempt、单
     `task_attempt_reservations`；
   - 唯一 Work Session/Attempt 关联：`sessions_attempt_unique` 部分唯一索引存在，行级
     `attempts.session_id = sessions.id`、kind='work'；
   - 证据可核验：结果与事件制品经 `ArtifactVerifier.readVerifiedContent`（hash/size）复核，
     CLI `session-evidence` 字节与核验正文一致；
   - 未装配 Verifier 明确暂停：Attempt `verifying`、t-1 未 passed（`first_passed_at` 为
     null）、Feature 非 completed、依赖后继 t-2（`dependsOn: ['t-1']`）DAG 不就绪且再扫描
     不产生第二 Attempt（后继不解锁）。
2. **停止未确认**：`lifecycle.stopped.unconfirmed` 注入监督边界故障；结果正文（含已知
   `durationMs`、synthetic 用量，未知 `signal`/`costUsdMicros` 为 null）在停止未知时仍
   持久保存；重开数据库（第二连接）断言 Attempt interrupted、三份租约 quarantined、证据
   字节与工作区写入字节原样保留；同 Task 替代认领经既有认领端口 conflict 拒绝（不新开
   Attempt）；Host 安全关闭 `resource_busy` 拒绝且持写锁（重开装配同样被拒）——停止未
   确认不释放隔离、不报告安全关闭。

## 3. 关键场景复跑矩阵（验收 2；均为既有真实资源测试，本项复跑通过）

| 场景 | 测试文件 |
|---|---|
| 缺 Runtime/能力/输入 | `p03-6-runtime-host-wiring.test.ts`（runtime_not_found 不认领）、`p03-6-runtime-execution-contract.test.ts`、`p03-6-execution-input-binding.test.ts` |
| 身份或权限错误 | `p03-6-runtime-host-wiring.test.ts`（401/400/409/跨项目 forbidden/越权）、`p03-6-execution-service.test.ts`（owner/host/version/lease/权限重核） |
| 大事件背压 | `p03-6-fake-runtime.test.ts`、`p03-6-runtime-host-wiring.test.ts`（96 事件）、`p03-6-work-evidence-recorder.test.ts` |
| 重复/乱序/丢失事件 | `p03-6-fake-runtime-lifecycle.test.ts`、`p03-6-work-evidence-recorder.test.ts`（去重/乱序窗口/缺口） |
| 未知终态 | `p03-6-runtime-execution-contract.test.ts`、`p03-6-fake-runtime-lifecycle.test.ts`、`p03-6-runtime-settlement.test.ts` |
| 启动/运行/磁盘失败 | `p03-6-execution-service.test.ts`（start 抛错/外键延迟 COMMIT）、`p03-6-work-evidence-recorder.test.ts`（ENOSPC/短写）、`p03-6-execution-uncertainty.test.ts` |
| 挂起超时 | `p03-6-execution-stopping.test.ts`（取消挂起执行）、`p03-6-fake-runtime-lifecycle.test.ts`（await_gate） |
| 取消/完成竞争 | `p03-6-execution-process-stopping.test.ts`、`p03-6-runtime-host-wiring.test.ts`（仅结算一次不重复扣额） |
| 旧 Attempt 迟到 | `p03-6-runtime-settlement.test.ts`（stale owner/host/version/terminal 隔离）、`p03-6-execution-uncertainty.test.ts`（迟到令牌不释放新占用） |
| result completed 但子进程仍活跃 | `p03-6-fake-tool-command.test.ts`（父退子活不结算，升级终止才 confirmed）、`p03-6-fake-runtime-lifecycle.test.ts` |

隔离说明：Git、SQLite、文件与受控进程全部使用隔离真实临时资源；只有模型决策由
FakeRuntime 脚本替代。FR-1（端口与生命周期）正常/负例见 F-001/F-008/F-009/F-010 测试；
FR-2（确定性脚本与输入核验）正常/负例见 F-002/F-003/F-004/F-005 测试。

## 4. 验收索引映射（T05/T06/T37 子集；T40 仅记录 Fake 恢复决定子集）

| 索引 | 本项适用子集 | 证据 |
|---|---|---|
| T05 Runtime 契约子集 | 自定义契约（非 Pi RPC 照搬）、异步 handle/有界消费/一次结算/未知终态拒绝 | `p03-6-runtime-execution-contract.test.ts`（35 用例） |
| T06 受控进程子集 | 批准命令定义快照、argv 不拼 shell、身份提交放行、进程组停止核验、父退子活不冒充停止 | `p03-6-fake-tool-command.test.ts`（19 用例）、`p03-6-execution-process-stopping.test.ts` |
| T37 输入接线子集 | 不可变输入快照核验、受限读取器、读取证据、必需输入/权限/恢复来源预检 | `p03-6-execution-input-binding.test.ts`（31 用例） |
| T40 恢复决定子集（仅记录） | Fake 以可信目录数据覆盖 conversationResume/executionRecovery 能力差异；required 不降级、auto 记录原因；非 new 恢复如实声明全新执行 | `p03-6-fake-runtime-lifecycle.test.ts`；决定记录于本文 §5 |

**不冒称**：Pi SDK 供应商部分（T30/T38/T40–T42）、完整 Recorder、真实 Token 汇总、
Verifier、完整恢复与 P03 阶段验收均不在本 Feature 范围内。

## 5. 恢复边界与 T43/T44 Core/Fake（验收 7；P03-3A 版本与实验矩阵保留）

- 恢复请求校验复用 P03-3A `validateRuntimeRecoveryRequest` 与
  `RuntimeRecoveryService.evaluate`（来源、停止、输入、代码与权限授权预检）；本 Feature
  不重建恢复 Schema，不要求接入 Pi Durable，不提前建设 Chat 服务。
- T43（恢复能力分离、来源与 required 拒绝、无 SDK 公共入口）Core/Fake 部分：
  `p03-6-fake-runtime-lifecycle.test.ts` 覆盖 conversationResume 与 executionRecovery 能力
  差异、required 不降级拒绝；组合根不装配 Fake 的结构断言保持（Fake 仅测试显式装配）。
- T44（稳定身份、重复请求、工具前后崩溃、停止不确定、单原生写入者、重复事件/用量、
  预算不清零）Core/Fake 部分：事件身份由 SHA-256 关联 token 派生；重复请求稳定身份全等；
  stopped 门闩/未确认与工具进程组核验覆盖停止不确定；单写入者由 `sessions_attempt_unique`
  + owner/host/version fence 落实；重复/迟到事件与用量按稳定身份去重；默认更新不重置预算
  （`p03-6-execution-service.test.ts`）。
- **P03-3A 版本与实验矩阵保留**：`docs/p03-3a-handoff.md`（最终证据提交
  `d9dd2c31620f52cef098a1ab320f3ee38ec0a67e`，分支
  `feat/2026-10-13-20-23-23_p03-3a-runtimepi-durable`）与
  `docs/p03-3a-pi-durable-capability-matrix.md` 原样保留；P04 默认标准 Pi SDK，Pi Durable
  仅为显式可关闭候选。本 Feature 不宣称真实 Pi 已支持任何恢复能力。

## 6. 完整门禁与验证记录（真实命令/退出码；日志在 Feature 工作区 `tool-logs/`）

| 检查 | 命令 | 结果 |
|---|---|---|
| 全量测试（238 文件分批，并集为 `npm test` 同一文件集） | `node scripts/run-tests.ts <批次文件>` ×3 + 干净树单文件复跑 `test/p02-4-clean-replay.test.ts` | 批 1：80 文件 1404 通过 exit 0；批 2：78 文件通过、clean-replay 因未提交脏树按设计失败（非代码回归，提交后复跑）；批 3：79 文件 1561 通过 exit 0；clean-replay 复跑结果以 `verifications/F-014/verification-result.json` 为准（单文件成功运行约 560–790 秒，可能超出 600 秒工具预算，超出则记 not_run 并保留日志） |
| 类型检查 | `npm run typecheck` | exit 0 |
| 正式构建 | `npm run build` | exit 0（含 dist 冒烟） |
| 工程边界 | `npm run check:boundaries` | exit 0（208 生产文件 0 diagnostics） |
| 暂存/工作树检查 | `git diff --check` | exit 0 |

说明：`npm run verify` 编排为 test→typecheck→build 三步串行，全量套件墙钟约 13–15 分钟，
超出本 Agent 单命令 600 秒预算；按 F-011 既有纪律以同一命令分批执行并保留全部日志，
不拼接失败批次冒充通过。P02 验收证据日志（`docs/acceptance/evidence-p02-4-clean-replay/`）
按历史约定在复跑后还原，不随运行提交。

## 7. P03-7/9 与 P04 可复用公共面（唯一一套，不得重建第二套）

- **Runtime 端口**：`ports/runtime-execution.ts`（RuntimeExecutionRequest/Handle、事件/结果/
  停止证据校验器、RuntimeError）、`ports/runtime-registry.ts`（可信静态注册）；P04 标准 Pi
  适配器接同一端口，经组合根 `workRuntimeFactory` 显式装配（`adapters/work-execution.ts`）。
- **Fake 脚本**：`ports/fake-runtime-script.ts`（十种步骤 + lifecycle 纯数据故障节）、
  `adapters/testing.ts`（`createFakeWorkRuntimeFactory`/`createFakeRuntimeGate`）；P03-7/9/10
  的无 LLM 测试继续以显式 Fake 装配驱动真实资源。
- **输入读取**：`application/execution-input-binding.ts`（bind → RuntimeExecutionRequest +
  受限 reader + 读取证据）；Host 侧 reader 按 invocationId 绑定
  （`adapters/work-execution.ts`）。
- **Session/制品**：`ports/work-session.ts`、`adapters/sqlite/work-session-store.ts`（迁移
  v20 sessions 表）、`application/work-evidence-recorder.ts`（NDJSON 分块/水位/脱敏）、
  `ports/work-session-query.ts` 只读查询面。
- **结算/停止**：`application/runtime-settlement.ts`（fenced 三类事实结算）、
  `application/execution-supervision.ts`（取消/超时/停止监督）、
  `application/execution-workspace-retention.ts`（保留现场与安全释放）。
- **装配公共面**：`openCoreApplication`/`openFakeCoreApplication`、`startHost`/`startFakeHost`、
  CLI `execution sessions/session/session-evidence/cancel`（`packages/cli/src/app/work-session.ts`）。

## 8. 已知缺口与契约冲突核对（不折算通过）

- 未装配 Verifier：`completed` 只进入 verifying，`verification_not_assembled` 明确暂停；
  Task/Feature 不通过、后继不解锁（§2 真实断言）。Verifier 装配属 P03-7。
- 无完整 SessionRecorder/原生档案审计：采集范围仅 Fake 可见公开面，缺口显式记录；
  synthetic 用量 `basis: 'synthetic'` 不进真实用量汇总。
- 无完整 Run 恢复：恢复选择当前 `mode: 'new'`；同 Task auto/new/required 续接政策与
  Runner 重启恢复属 P03-9。
- 单并发全局占用（`global:execution` 租约）；多并发调度不在首版范围。
- 仅 macOS 验收；可信项目模式不具备强 OS 沙箱。
- 契约冲突核对：本 Feature 未发现与 P03-3A 恢复协议、P03-4 认领/预算、P03-5 工作区
  语义的冲突；F-010 修正的 usage wire 平铺格式与 retention operationId UUID 派生均已按
  既有契约落实并回归。

## 9. 交接纪律

### 验收工具修补（2026-10-16）

- 完整快照复跑必须在已提交且干净的基线上显式运行：
  `SHIPLOOP_TEST_RUN_TIMEOUT_MS=4800000 SHIPLOOP_VERIFY_STEP_TIMEOUT_MS=1200000 npm test -- test/p02-4-clean-replay.test.ts`。
  默认 `npm test` 不等价于该完整复跑；两次 accept:p02 均成功才能放行。
- 隔离环境只额外传递上述两项有限预算，不导入用户认证、MCP、模型或测试过滤器；
  内层 verify 同时把批准预算传到测试启动器，避免默认 600 秒提前截断。
- 构建迁移扫描与快照内已验证的 `acceptance/p02.config.json` 版本清单精确比较，
  不再把 P02 的五项迁移作为后续所有 Feature 的上限。
- 验收子进程记录实际后代关系；超时或异常时按 PID、启动时间与命令重新核验后
  清理独立进程组后代，未确认停止仍然失败；不按进程名批量终止。
- 命令输出发现凭据形状时省略整个受影响输出流并记录摘要、字节数与真实退出码；
  报告写入器的凭据拒绝检查不关闭。活跃临时文件消失仅容忍 ENOENT，其他文件系统
  错误和持续写入仍使清理核验失败。

### 既有交接要求

- 本 Feature 不提供 `accept:p03`（P03-10 职责）；不宣称 Feature/Phase 已通过阶段验收。
- 后续任务复用 §7 公共面，不得重建第二套 Runtime 端口/会话表/证据格式；契约冲突记录
  并核对，不以"后续再补"关闭必需行为。
- P04 接入标准 Pi SDK 时沿用 P03-6 Core 恢复端口与 fenced 结算；Pi Durable 候选启用需
  单独验证并重跑 §5 相关验收。
