# P03-7 Feature 交付记录（F-016 跨模块接线验收）

日期：2026-10-17。分支：`feat/2026-10-11-17-45-49_p03-7-task`（基线分支
`feat/2026-10-11-17-45-49_p03-6-runtime-fakeruntime`）。本记录由 F-016 任务
Runtime 保存，供 Nezha 独立复验与 Feature 完整门禁交接；不冒称 Feature 全量
验收已通过（完整 verify 由 Nezha 在全部 Task 通过后执行）。

## 1. 实际前序输入基线

- 输入 PRD：`input/p03-task-verification.md`（版本 0.3，2026-10-13 恢复边界补充）
  与 `input/execution-contract.md`；验收索引 T04/T07/T13/T35/T39。
- 前序阶段：P03-6（FakeRuntime）分支链为直接基线；P02 基线 `0e76ad8` 在
  main（本 Feature 开工核对记录见 F-001 progress）。
- F-016 开工时 HEAD：`7b16e97`（F-015 跨检查执行器契约用例），工作区干净；
  依赖 F-014、F-015 均已通过（`task_list.json` 16/16 中前 15 项 passes=true）。
- F-016 交付提交：`cdaea31`（测试与夹具，7 文件 +1032/-50）；本文档随同
  提交信息前缀为 `F-016: 保存 P03-7 Feature 交付记录` 的提交入库（git log
  可核，避免自引用哈希漂移）。

## 2. 实现范围（Feature 汇总 + F-016 明细）

P03-7 整体（F-001–F-015，此前已交付并通过各自聚焦验收）：

- F-001/F-004：确认的检查定义、显式模块清单与安全全量回退策略（配置通道，
  不建并行配置系统）。
- F-002/F-003：VerificationBatch/CheckResult SQLite 持久化（迁移 v21）、
  候选校验与受信目标解析（路径/参数注入 fail-closed）。
- F-005/F-006/F-015：真实 Node 受监督检查执行器、机器验收聚合（空检查/
  证据缺口/源码变化不折算通过）、跨执行器契约用例。
- F-007/F-008/F-013/F-014：人审事项/决定（迁移 v22/v23）、Task 证据/人审/
  返工链查询、CLI/Host 命令接线。
- F-009/F-010/F-011/F-012：代码尝试预算（maxCodeAttempts 默认含首次三次）、
  fencing 原子放行、返工输入快照（schema v2，迁移 v24）、同 worktree 有界
  增量返工与显式验证继续。

F-016（本次交付）：

- `test/modules/verification/p03-7-f016-e2e-three-task-chain.test.ts`：正式装配入口
  （openCoreApplication 组合 + workExecution 调度 + 显式 FakeRuntime + 真实
  临时 SQLite/Git/worktree/受监督进程）驱动 t-1→t-2→t-3 链：首次检查失败
  （真实定版失败批次 + 受信收尾）→ 同 worktree 第二次增量修复成功（首跑文件
  保留、runtime_starts=2）→ 依赖仅在 t-1 有效通过后解锁（只读 DAG 评估
  dependency_pending）→ t-2/t-3 依次通过；全部通过后调度给出
  feature_final_verification 交接缺口，Run/Feature 不被冒称完成（P03-8 边界）；
  关闭核验 closed=true、无未决 Attempt。
- `test/modules/verification/p03-7-f016-verification-wiring.test.ts`：分组集成验证局部选择与安全
  回退（候选缺失/解析拒绝/共享高风险变更/无回退政策 error 空计划）、参数与
  路径攻击（payload 级 8 类 + 解析级 5 类，候选内容不进入 argv）、零测试
  （真实执行器 inconclusive）、输出/证据缺口（聚合层 + 预算分类层双层闭环：
  无输出制品 → non_code_failure/evidence_incomplete，不误扣代码额度）、检查
  前后源码变化（source_changed/execution_identity_changed 失效旧证据）。
- `test/modules/verification/p03-7-f016-approval-budget-integration.test.ts`：机器绿仍等人审
  （Task 不 passed、Run paused(approval)、后继不解锁）；新阻塞与完成竞争
  （批准后新增 block → 继续保持等待）；越权（forbidden）与过期摘要（conflict）
  批准拒绝；解除不启动编码（runtime_starts/Attempt 计数不变）；显式继续复用
  有效证据（零新增编码调用，同 commandId 重放同一回执）；三次含首次耗尽
  （Task failed、Run 暂停 code_attempts_exhausted、后继 blocked、
  runtime_starts=3、持久计数直接断言）；重复与迟到结果不放行
  （invalid_transition / stale_execution_identity fencing）；暂停 Run 未终态
  时同 Feature 新 Run 派发被控制层拒绝（execution_in_progress，不提供绕过
  暂停重置计数的入口）；数据库重开后计数/失败链仍为权威状态；基础设施错误
  （timeout 类）不误扣代码额度（code_attempts_used 退回、独立
  infrastructure_error 暂停分支、不自动返工）。
- 共享测试支持小范围扩展：`input-binding-fixture.ts` 新增 `thirdTaskChained`
  （三 Task 链）；`approval-continue-seed.ts` 通用化（taskId/免审批直接放行），
  既有 F-014 用法保持兼容（仅非空断言调整）。

## 3. 工具版本

- Node.js 22.19.0（engines 固定）、npm 10.9.3、TypeScript 7.0.2、
  vitest 5.0.3（本地锁定）、better-sqlite3 13.0.3、drizzle-orm 0.45.3。
- 测试无网络、无模型、无真实凭据；FakeRuntime + 真实临时 SQLite/Git/
  worktree/文件 + 受监督进程（`/usr/bin/true` 探针，停止证据可核验）。

## 4. 命令与退出码（完整日志见 §5）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node scripts/run-tests.ts test/modules/verification/p03-7-f016-e2e-three-task-chain.test.ts` | 0（attempt2） | 1 passed（attempt1 为 RED 阶段，1 failed，保留） |
| `node scripts/run-tests.ts test/modules/verification/p03-7-f016-verification-wiring.test.ts` | 0（attempt2） | 7 passed（attempt1 1 failed，保留） |
| `node scripts/run-tests.ts test/modules/verification/p03-7-f016-approval-budget-integration.test.ts` | 0（attempt2） | 3 passed（attempt1 3 failed，保留） |
| `node scripts/run-tests.ts test/modules/verification/p03-7-f012-work-loop-rework.test.ts test/modules/verification/p03-7-f014-cli-vertical.test.ts test/modules/verification/p03-7-f014-cli-built.test.ts` | 0 | 6 passed（回归批次 1） |
| `node scripts/run-tests.ts test/modules/verification/p03-7-f013-host-query-wiring.test.ts test/modules/verification/p03-7-f013-verification-approval-query.test.ts test/modules/runtime/p03-6-execution-input-binding.test.ts` | 0 | 39 passed（回归批次 2） |
| `npx tsc -p tsconfig.json` | 0（attempt2） | 0 diagnostics（attempt1 修复类型问题，保留） |
| `node scripts/run-tests.ts`（四个 F-016/受影响文件收尾复跑） | 0 | 13 passed |

任务 Runtime 按策略未运行：全量 `npm test`、`npm run verify`、
`npm run check:boundaries`、`npm run build`、`accept:p01/p02` 及任何组合门禁
（Feature 完整门禁由 Nezha 在全部 Task 通过后执行）。

## 5. 证据路径（均为完整 stdout/stderr + 退出码旁文件）

- 运行日志：`verifications/F-016/runtime-logs/`（19 个文件：*.log 与
  *.exitcode 成对；含 RED 阶段失败日志，不覆盖）。
- 测试选择清单：`verifications/F-016/test-selection.json`（task_id=F-016；
  本地已运行 9 文件 + 未本地运行的受影响回归 10 文件，交 Nezha 独立复验；
  本地已通过见 §4，未运行项不宣称通过）。
- 测试资源清理：全部临时 SQLite/Git/worktree/文件由夹具 afterEach 清理；
  受管进程停止在 E2E/耗尽用例中经 `workExecution.close()` 核验
  （closed=true、pendingAttemptIds=[]）；无生产失败现场需要保留。

## 6. 已知缺口与边界（如实声明，不冒称完成）

- 本节交付时 Feature 完整质量门禁尚待 Nezha 执行；2026-10-17 的首次失败、
  小范围修复及完整复验见下方补充验收记录。`verify` 包含全量测试、类型检查和构建，
  边界检查另行执行；不将 Task 局部通过等同于 Feature 验收。
- 「新 Run 不重置计数」在装配层表现为：暂停 Run 未终态时同 Feature 新 Run
  派发被 `execution_in_progress` 拒绝（不存在绕过暂停重置计数的入口）；
  Run 级重试/换模型下的计数保持语义由 F-009 单元测试（BudgetFixture）覆盖。
- 「旧执行或 Verifier 停止未知不能返工」的细粒度隔离/补证释放语义由 F-012
  专项测试覆盖；F-016 装配层断言基础设施暂停分支不发起返工认领。
- 调度诊断会覆写暂停 Run 的 reason（run_control_blocked），属既有核心行为
  （F-012/F-014 已记录）；F-016 断言权威事实（Run 非终态暂停、不认领）。
- P03-8 最终交付（Feature 提交/最终验收）、P03-9 控制与恢复（通用取消/重启
  恢复）、P03-10 阶段验收脚本、真实 Pi Runtime（P04）均不在本 Feature 范围，
  未实现、未冒称完成；scheduler 的 feature_final_verification 消费者未装配
  （E2E 断言 capability 缺口）。
- 验收索引 T04/T07/T13/T35/T39：仅声明本 Feature 适用范围；机器证据见
  §4/§5，人审/放行由 Nezha 独立验证履行。

## 7. 覆盖的验收标准对照

| F-016 验收点 | 证据 |
| --- | --- |
| 1. 三 Task 链端到端（首次失败/二次修复/文件保留/依赖解锁） | e2e 测试 1 项（41s，全真实资源） |
| 2. 验证选择组 + 人审/放行组 | wiring 7 项 + approval 1 项 |
| 3. 预算/失败链组（耗尽/迟到/重开/infra） | approval-budget 2 项 |
| 4. task-local 测试与选择清单，不跑全量/组合门禁 | §4/§5 + test-selection.json |
| 5. 交付记录与证据落盘 | 本文档 |

## 8. Feature 门禁补充验收（2026-10-17）

首次全量门禁失败于旧的 P02 Host 握手测试：F-013 增加三个查询能力后，旧断言仍要求
36 项，实际已为 39 项。本次保留原有检查，增加三个新操作名称断言，并将精确数量更新
为 39；不修改业务实现、不删除用例、不放宽协议/授权要求。

以项目固定的 Node 22.19.0/npm 10.9.3 完整复验：

- 全量测试：264 文件通过，5040 用例通过、1 跳过；该跳过项为默认关闭的真实
  pi-durable SDK 实验，不声明该实验已在本次运行。
- `npm run verify`：退出 0，3/3 步骤通过，包含全量测试、类型检查、构建，以及
  构建产物的 Core/Host/CLI 装配、生命周期与纵向冒烟；总耗时约 16.12 分钟。
- 独立边界检查：227 个生产源文件、0 diagnostics，退出 0；`git diff --check` 通过。
- Feature 工作区证据位于 `verifications/manual-gate-20261017/`，原失败报告和因
  终端 Node 26 与项目版本不符而取消的日志均保留；取消不计为通过。

结论：P03-7 Feature 工程门禁验收通过，16/16 Task 保持已通过，未调用模型或重跑
已完成 Task。此结论不代表 P03 整阶段验收，也不覆盖本记录列出的 P03-8/9/10 或真实 Pi 缺口。
