# P03-10 / F-001 真实资源验收夹具交接

本任务交付可独立运行、可被后续 P03-10 场景复用的资源夹具与六项自测。业务写入全部经过正式构建 CLI/Host；Git、SQLite、文件和进程均为隔离真实资源，模型行为使用显式 Fake 装配。没有改动产品实现、依赖或迁移。

## 受测基线与工具

开工 HEAD 与 `feature.yaml.metadata.base_branch` 指定的累计分支 `feat/2026-10-11-17-45-49_p03-9` 均为 `14386921209e98f6bfc49f2c93373aeacc0473a5`。已核对累计分支和 P02 基线 `0e76ad8d9ae7a9e03949c8af4bae8e7e236acd56` 都是受测 HEAD 的祖先。夹具在启动 Host 前重新执行祖先检查并导出实际 commit、累计分支 commit 与工作树 dirty 标记；引用不存在或检查失败会拒绝继续。最终验证在上述 HEAD 加本任务未提交修改上运行，因此证据 `dirty:true`，不将旧 commit 冒充本任务提交。

本轮工具：Node `v22.19.0`、npm `10.9.3`、Git `2.50.1 (Apple Git-155)`、TypeScript `7.0.2`、vitest `5.0.3`、better-sqlite3 `13.0.3`、drizzle-orm `0.45.3`。Node/npm 按项目 engines/packageManager，依赖按 package-lock 固定；测试启动器拒绝非本地或版本不匹配的 vitest。Git 为本机实际版本，未新增安装约束。每次夹具记录实际 Node/npm/Git 及 lock 版本，npm 版本探测也使用隔离 HOME。allocated 阶段中断早于前置检查时，metadata 明确为 `not_run`。

## 前序真实接口核对

下表是已核对的仓库接口、交接与局部测试入口。测试文件存在和历史交接描述不等于本轮重新运行；本任务只运行下文六项夹具自测及其必要构建/类型检查。前序交接中的早期 Schema/能力缺口须结合当前累计分支读取，不据旧草案另建服务。

| 来源 | 公开面与交接依据 | 已有局部测试入口 | F-001 使用边界 |
| --- | --- | --- | --- |
| P03-1 | `phase create`、`feature import`、Task 计划/DAG/策略副本；[交接](p03-1-handoff.md) | `test/modules/planning/p03-1-plan-cli-vertical.test.ts` | 通过构建 CLI 创建一个 Phase、单 Task Feature |
| P03-2 | `feature approve`、`task prepare`；批准绑定摘要、不可变输入组；[交接](p03-2-handoff.md) | `test/modules/planning/p03-2-cli-built.test.ts` | 计划 requirementsRefs 与 baseline Artifact 一致，prepare 必须 bindable |
| P03-3 | `execution preview/start`、预算预占/accepted；[交接](p03-3-handoff.md) | `test/modules/execution/budget/p03-3-cli-built.test.ts` | ready 后确认 start，记录 Batch/Run；accepted 只作授权事实 |
| P03-3A | 通用恢复身份/能力与 Fake 装配；[交接](p03-3a-handoff.md) | `test/modules/runtime/recovery/p03-3a-runtime-recovery.test.ts` | 复用当前 Host 的恢复门控，不另写恢复协议 |
| P03-4 | Scheduler、认领与 Attempt/租约；[查询契约](p03-4-schedule-query-contract.md) | `test/modules/scheduling/p03-4-cli-schedule-built.test.ts` | Host 实际认领后从第二条只读连接观察 Attempt |
| P03-5 | Feature worktree 准备、保留和占用；[交接](p03-5-handoff.md) | `test/modules/workspace/p03-5-cli-workspace-built.test.ts` | 真实工作区与 workspace operation 由 Host 生成 |
| P03-6 | `startFakeHost`、FakeRuntime 真实工具、`execution session`；[交接](p03-6-handoff.md) | `test/modules/runtime/p03-6-cli-session-built.test.ts`、`test/modules/runtime/p03-6-vertical-integration.test.ts` | Fake 仅替代模型；真实 Session/工具进程和公开 acceptance 投影 |
| P03-7 | 验证、人工批准与显式继续；[返工交接](p03-7-f012-handoff.md)、`docs/p03-7-f014-cli-approval-continue-contract.md` | `test/modules/verification/p03-7-f014-cli-built.test.ts` | 本夹具不装配 Verifier，不把模型 completed 当 Task passed |
| P03-8 | `feature delivery`、`git operation(s)` 与显式收尾；[CLI 操作说明](p03-8-f011-cli-delivery-operations.md) | `test/modules/delivery/p03-8-f011-cli-delivery-vertical.test.ts` | 只读取 git_operations 表；没有 Git 交付时明确为空，不虚造 operation |
| P03-9 | 控制/恢复/finalization；[交接](p03-9-handoff.md) | `test/modules/cli/control/p03-9-f015-cli-control-vertical.test.ts`、`test/modules/recovery/p03-9-f016-host-kill-recovery.test.ts`、`test/modules/delivery/retry/p03-9-f017-finalization-host-vertical.test.ts` | 复用 Host 关闭与 CommandProcess recoverStop；完整控制故障矩阵留给后续任务 |

没有发现 F-001 初始化、执行、取证和清理所需的缺失接口。P03-7～9 的完整产品场景没有在本任务重复实现或冒充通过。

## 资源与调用

入口：`test/helpers/p03-10/acceptance-fixture.ts` 的 `withP03AcceptanceFixture(options, body)`。装配脚本 `test/helpers/p03-10/dist-fake-host.mjs` 直接加载构建的 Host testing 入口和 Core 命令进程 adapter，仅注入 fake/fake-provider/fake-model 静态目录与声明式脚本，不靠生产自动发现或用户配置。

```ts
import { withP03AcceptanceFixture } from './test/helpers/p03-10/acceptance-fixture.ts';

await withP03AcceptanceFixture({ evidenceDir: '/tmp/p03-evidence-explicit' }, async fixture => {
  await fixture.startExecution();
  // 用公开 CLI 查询；等待业务事实时由场景提供有界轮询。
  const attempts = fixture.rows('attempts');
  // 此处的空数组只说明本次观察时尚无 Attempt，不能推导业务完成。
});
```

需先构建；自测文件的 beforeAll 会执行 `npm run build`，包含正式入口烟测。夹具默认准备到 imported 阶段：独立临时 Git 仓库/隔离 HOME/TMPDIR/数据根 → Fake Host ready → project register → config create → baseline run 发布真实需求输出 Artifact → phase create → feature import → 按 planDigest/revision approve → task prepare。调用 `startExecution()` 才进行 preview/confirm/start。

复用 P02-4 `createAcceptanceFixture`、P02-3 仓库/样例、既有只读 SQLite probe、CLI session、ProcessSupervisor、OwnedProcessTree 与产品 CommandProcess adapter；不重建 Host、ArtifactStore、命令系统或进程管理器。产品本地 Host 通信使用 loopback；没有外部网络、真实 LLM、用户凭据或真实 HOME 资源的使用。

`onStage` 可在 allocated/host-ready/registered/configured/imported/authorized 注入中断；`confirmStopped` 仅可收紧清理结论，不能覆盖真实停止失败。`script` 与 `toolCommands` 是受信测试装配参数，非用户业务配置。工具树用例在 allocated 阶段确定本次根内的真实写入目录。

预算限制次数与时间：Batch 的 Run/Attempt/Runtime start/无进展上限均为 2，deadline 为本次准备后 60 秒，Run 上限 2 Attempts/60 秒。Fake 实际 token、缓存、费用均 unknown，故不设置可选 token/cost 上限；未知量不能冒充 0，也不能靠移除产品预算保护得到通过。

## 证据与清理契约

`evidenceDir` 由调用方显式提供，必须位于待删除资源之外。`evidence.json` 包含受测基线/工具、输入与 CLI 实际退出码/信号/输出、Project/Phase/Feature/Batch/Run ID、只读数据库投影、Git 快照、受管进程事件、进程树诊断、持久组身份与样例输出统计。数据库明确标记为 live read-only observations，逐表观察不是事务备份。

只查询固定表和允许列，不读取配置、命令/事件 JSON 正文或 auth.token；每表最多读取 101 行，导出 100 行并标记 truncated。workspace/baseline 进程身份超过边界会拒绝删除，不能截断后遗漏活跃组。关联路径为 ids → runs.batch_id → attempts.run_id → sessions.attempt_id；workspace_operations 与 command_receipts 的 operation/operation_id/receipt/Attempt 引用提供操作证据。自测逐项断言此关联，Git 操作可为空。

CLI stdout/stderr 分别限制为 65,536/8,192 字节，结果等待 30 秒；overflow、信号或非零退出均拒绝。样例覆盖 2,048 字节上限并保留实际字节数/overflow。输入仅接受根内 JSON 文件名，拒绝穿越与现有/悬空 symlink。导出使用既有脱敏器替换资源根、证据根、开发仓库、Node、HOME 和调用方 secrets，并检查 CLI/input 的凭据形态。用量固定标明 `{source:'fake',tokens:'unknown',cache:'unknown',cost:'unknown'}`。

统一 teardown 先尝试只读取证，再关闭 Host、核验 CLI driver/grandchild 和样例退出，核验 Host/样例自有进程树，最后按已验证的 launchId/PID/PGID/startTime 调用 recoverStop。任一导出、停止、身份或安全删除失败都会保留资源并抛聚合错误；原始 body/init 错误不被覆盖。停止核验失败不会跳过其他进程的收尾尝试。

只有所有前置步骤确认成功且 cleanup 可写后，才调用已有安全 dispose 删除本次根。`cleanup.json` 记录树/组结论、删除结论、诊断、失败和耗时；`attempts` 保留重试前后的失败/成功历史。保留根中另写 `p03-cleanup-failed.json`；根路径在导出中脱敏，调用方仍持有 `fixture.root` 供诊断及恢复。消除障碍后可对原句柄再次 `teardown()`，删除成功后幂等。

## 本次局部验证与证据

独立命令：

```sh
P03_EVIDENCE_DIR='<explicit-persistent-evidence-dir>' \
  node scripts/run-tests.ts test/modules/acceptance/p03-10-fixture.test.ts
```

本任务实际使用 `.dag_context.json` 指定的 `nezha.dag.test_command` 包装器运行上式和 `npm run typecheck`，完整 stdout/stderr、真实退出码与统计保存在 Feature workspace 的 `verifications/F-001/runtime-logs/`。

最终运行（2026-10-18 UTC / 2026-10-19 本地）：`test-1ezmbjj1.log`，exit 0，**6 passed / 0 failed / 0 skipped**；约 51.6 秒，含构建与 Core/Host/CLI 入口烟测。类型检查：`test-vgwkdhqe.log`，exit 0，约 1.4 秒。此前 RED、失败诊断与修正后的 GREEN 日志均保留；没有通过重跑隐藏原始失败。

下表目录均相对于 Feature workspace 的 `verifications/F-001/fixture-evidence/`，每个目录包含 evidence.json 与 cleanup.json：

| 稳定 case ID | 验证 | 最终证据目录 |
| --- | --- | --- |
| prepare-interrupted | allocated 初始化中断仍取证并删除 | `shiploop-p03-evidence-B5Zyec` |
| built-resources | 构建主线、真实 Attempt/Session、公开 acceptance、只读探针拒写、外部路径/悬空链接保护、脱敏/有界输出、实体与 operation 关联 | `shiploop-p03-evidence-vKoKiO` |
| host-interrupted | Host-ready 异常，确认树退出 | `shiploop-p03-evidence-dtcWbI` |
| cleanup-unconfirmed | 未确认时保留，重试后删除，失败历史仍在 | `shiploop-p03-evidence-78X1Hj` |
| owned-tool-tree | 真正运行中的派生写入树；异常前 signal-0 确认组活跃，异常后确认树/组消失 | `shiploop-p03-evidence-spUNuu` |
| export-failure | 导出目标故障仍停 Host，保留资源；恢复目标后重试 | `shiploop-p03-evidence-UBps30` |

工具树的最终 cleanup 用时 341ms，证明没有等工具的 30 秒超时再清理；总时长包含真实工作区准备。早期 allocated 自测错误和后续悬空链接保护测试留下的两处本任务临时根，已核对创建时间、对应失败日志、无打开文件/进程及安全删除边界后回收；记录在 `verifications/F-001/retained-resources-cleanup.json`。

测试范围唯一登记于 `test/index/phases/P03/features/P03-10/tasks/F-001.json`（v2，六个稳定 case ID）。Harness `test-selection.json` 只引用该索引，Feature/Phase 索引保持阶段人工验收状态。更广回归由 Nezha 独立执行。

## 实际限制

本轮仅验证 macOS、可信临时项目、全局单并发。Fake completed 的公开查询为 runtimeCompleted=true、taskAccepted=false；没有 Verifier 装配，Task 未 passed、Feature 未 completed。没有运行整阶段验收或全量 verify，不提供本任务范围外的 accept:p03 命令。P04 默认 Pi SDK、T40 原生恢复/T41 与 Durable 实验候选的既有边界保持，均未在本轮验证。
