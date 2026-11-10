# F-014 生产装配与受影响集成验收交接

F-014 未完成生产闭环。当前改动只加固装配失败关闭，并整理受影响回归入口；不能据此确认 Feature 或 Phase 通过。没有修改用户并发、auto_push、模型、真实业务项目、main 或正式任务状态。

## 已实现与本地验证

- Core 在接收 integrationPlanFactory 输出时校验 readApprovedBatch/readEvidence，以及显式 scheduler 的 list/reserve。null、缺方法、错误类型和异步工厂输出在返回应用前拒绝，失败仍由组合根关闭 SQLite。
- 命令服务在构造时拒绝损坏的显式 integrationStart；缺省未装配仍沿用既有 unsupported 语义。
- Pi GitAgent 构造时要求真实 Runtime 工厂和完整可信 authority。缺 Runtime 返回 missing_runtime/git_agent_driver_unavailable；损坏工厂与授权端口返回 configuration。生产 facade 不再返回一个只能在 start 时发现驱动缺失的适配器。
- 以上只是形状和存在性校验。函数存在不证明其绑定了同一 Core、正确仓库或合法授权；不能使用恒真回调替代这些事实。

本地聚焦 4 文件 33 项通过，其中 30 项 unit，另 3 项是临时 SQLite 组合构造/失败后重开检查。该 SQLite 小组已实际运行，应如实保留为定向构造证据；它不能替代整条生产链的集成验收。其余真实 Git/Host/进程矩阵未在本任务执行。

最终日志相对 Harness Feature 根目录 verifications/F-014/runtime-logs/：

- test-yd6shz72.log：上述 33 项；退出码 0。
- test-l6a7xvfs.log：typecheck 通过；退出码 0。
- test-vysktbnm.log：boundaries 602 个生产源码文件、0 条诊断；退出码 0。

原始 RED、一次类型检查失败及其修复后的日志和退出码旁文件均保留。没有运行 build、全仓、历史 Phase 或 live。

## 尚未接通的生产链路

1. composition 的 integrationPlanFactory 仍只支持可信注入；默认没有真实 Batch approval、前置交付/Git/制品核验事实、候选扫描及持久 reservation 的实现装配。
2. 仓库定义了 IntegrationVerificationExecutor.start 契约与测试注入 executor，但没有将真实 CommandProcess/Artifact 验证执行器接入集成验证服务。不能以测试的 passed:true 输出作为生产实现。
3. 确定性 integration workspace/journal/reconciliation、资源 owner/version 和 GitAgent authority/候选发布器仍缺少贯穿同一 SQLite session 的生产组合。现有 Work/Feature closeout 的验证和停止链不能自动证明这条独立集成链已装配。
4. 默认正常 Feature closeout、持久集成消费、Host startup recovery/周期补扫与集成成功后的后继 dispatch 尚未连通；当前可注入调度器不等于默认 Host 正在消费它。
5. Host 仍按既有真实能力宣告；没有为缺少上述适配器的链路增加可用标志。缺失生产链仍阻塞验收，不用 unsupported 分支冒充交付。

这些是代码实现缺口；本次未把它们归为负责人已经接受的例外，也没有清除任何人工 hold。后续修复必须完成真实适配器、授权/身份核对与生命周期装配，再以新提交验证。

## 范围、可执行入口与证据边界

- 本 Task 选择：test/index/phases/P08/features/shiploop-dag/tasks/F-014.json；Harness test-selection.json 仅引用它。
- Feature manifest 现在登记磁盘上全部 13 份 Task 索引（F-002 至 F-014），保留原索引内容。F-001 原来没有该目录下的 Task 索引，不能声称这份目录就是完整 14 Task 验收证明。
- 独立集成清单：test/index/phases/P08/features/shiploop-dag/integration.json。它去重合并这 13 份索引中的 35 个 integration 文件，不混入 unit，不调用全仓或历史 Phase。所有条目仍绑定策略指定的 test/index/phases/P07/integration.json。
- 这份清单只覆盖已登记回归。未有端到端用例的必需场景在下表明确阻塞；35 文件全部成功也不能自动签署生产闭环。

经单独授权执行集成回归时，在目标仓库根运行下列 Bash 入口。每文件独立调用现有 scripts/run-tests.ts（默认单次预算 600 秒），保留完整 stdout/stderr 和真实退出码；首个失败停止，后续视为 not_run。日志目录必须由操作者选择一个新路径；mkdir 失败即停止，防止覆盖旧证据。本 Task 没有执行这组命令。

```bash
DAG_LOG_ROOT=state/acceptance/shiploop-dag-integration-new-run
mkdir -p state/acceptance
mkdir "$DAG_LOG_ROOT" || exit $?
DAG_STEP=0
dag_check() {
  DAG_STEP=$((DAG_STEP + 1))
  local dag_log="$DAG_LOG_ROOT/$DAG_STEP.log"
  node scripts/run-tests.ts "$1" >"$dag_log" 2>&1
  local dag_exit=$?
  printf '%s\n' "$dag_exit" >"$dag_log.exitcode"
  tail -n 30 "$dag_log"
  return "$dag_exit"
}
dag_check test/modules/acceptance/p05-10-f005-git-integration.test.ts || exit $?
dag_check test/modules/acceptance/p08-4-f009-phase-integration.test.ts || exit $?
dag_check test/modules/delivery/git-agent-integration-commit.test.ts || exit $?
dag_check test/modules/delivery/p03-10-task-commit-store.test.ts || exit $?
dag_check test/modules/delivery/p03-8-f003-controlled-git-commit.test.ts || exit $?
dag_check test/modules/delivery/p03-8-f004-git-commit-reconciliation.test.ts || exit $?
dag_check test/modules/delivery/p05-6-f006-integration-assembly.test.ts || exit $?
dag_check test/modules/delivery/p05-7-f003-integration-git-workspace.test.ts || exit $?
dag_check test/modules/delivery/p05-7-f004-deterministic-integration.test.ts || exit $?
dag_check test/modules/delivery/p05-7-f008-integration-vertical.test.ts || exit $?
dag_check test/modules/delivery/p05-8-f002-git-agent-repair-run.test.ts || exit $?
dag_check test/modules/delivery/p05-8-f003-git-agent-runtime.test.ts || exit $?
dag_check test/modules/delivery/p05-8-f004-git-agent-candidate-finalization.test.ts || exit $?
dag_check test/modules/delivery/p05-8-f005-git-agent-recovery-sqlite.test.ts || exit $?
dag_check test/modules/delivery/p05-8-f007-git-agent-composition.test.ts || exit $?
dag_check test/modules/delivery/p05-9-f004-phase-delivery-approval-sqlite.test.ts || exit $?
dag_check test/modules/delivery/p05-9-f008-batch-delivery-vertical.test.ts || exit $?
dag_check test/modules/delivery/p07-5-f004-git-recovery-boundary.test.ts || exit $?
dag_check test/modules/host/p05-9-f006-batch-delivery-host.test.ts || exit $?
dag_check test/modules/host/production-pi-startup.test.ts || exit $?
dag_check test/modules/notifications/p07-4-f006-notification-projection.test.ts || exit $?
dag_check test/modules/planning/feature-dag-diamond-evidence.test.ts || exit $?
dag_check test/modules/planning/feature-dag-store-evidence.test.ts || exit $?
dag_check test/modules/planning/planning-baseline-separation.test.ts || exit $?
dag_check test/modules/runtime/p04-3-failure-routing-integration.test.ts || exit $?
dag_check test/modules/runtime/p06-7-f005-process-recovery.test.ts || exit $?
dag_check test/modules/runtime/production-pi-auth.test.ts || exit $?
dag_check test/modules/runtime/production-pi-file-tools.test.ts || exit $?
dag_check test/modules/runtime/production-pi-runner.test.ts || exit $?
dag_check test/modules/scheduling/p05-5-f002-feature-resource-sqlite.test.ts || exit $?
dag_check test/modules/scheduling/p05-5-f004-resource-settlement.test.ts || exit $?
dag_check test/modules/scheduling/p05-5-f008-cross-layer.test.ts || exit $?
dag_check test/modules/storage/sqlite/p08-dag-f013-delivery-context.test.ts || exit $?
dag_check test/modules/workspace/p03-5-git-operation-lock.test.ts || exit $?
dag_check test/modules/workspace/p03-5-workspace-inspector.test.ts || exit $?
```

## 必需场景覆盖表

| 场景 | 已登记回归 | 本次状态与保留缺口 |
| --- | --- | --- |
| Root/单前置/冻结起点 | planning-baseline-separation；p07-5-f005-execution-baseline 的 unit 在原 Task 索引 | 本任务 not_run；需要同一生产应用纵向冻结与准备证明 |
| 菱形 A→B/C→D、反向完成 | feature-dag-diamond-evidence；p05-7-f008-integration-vertical | 本任务 not_run；生产 Host 自动集成并只派发 D 一次仍缺用例/实现 |
| 两消费者/重复乱序/丢失唤醒 | p05-5-f002/f004/f008 资源矩阵；原 F-006 scheduler unit | 本任务 not_run；生产事件到持久集成消费/补扫仍阻塞 |
| 无冲突/已包含/空差异 | p05-7-f003/f004/f008 | 本任务 not_run；必须核验真实 Git 祖先与零模型请求 |
| 冲突及组合验证失败修复 | p05-8-f002/f003/f004；git-agent-integration-commit | 本任务 not_run；生产 authority、验证执行器和完整后继解锁链仍缺装配 |
| 越界/凭据引用/无 driver/修复失败 | production-pi-git-agent unit；p05-8-f004/f005-recovery-sqlite | unit 已过；持久消费者与真实进程组合 not_run |
| 副作用边界中断/回执丢失 | p03-8-f003/f004；p07-5-f004；git-agent-integration-commit | 本任务 not_run；保留所有失败和现场 |
| 活动或未知进程/租约过期/迟到结果 | p05-5-f002/f004/f008；p06-7-f005-process-recovery | 本任务 not_run；不能把租约到期当停止证明 |
| 输入被取代/DAG/CAS/仓库漂移 | feature-dag-store-evidence；p05-7-f004/f008；基线规则 unit | 本任务 not_run；生产组合仍需同库复核 |
| 旧 Planner 工作区正式迁移 | F-003 已有 port/CLI unit；planning-baseline-separation 只覆盖规划隔离 | 真实 Host 迁移与脏/活动拒绝纵向未在聚合索引中有完整专用场景，阻塞 |
| Phase 全部叶子汇总 | p05-9-f004-phase-delivery-approval-sqlite；p05-9-f006/f008 | 本任务 not_run；生产 leaf finalization 工厂/集成链及人工批准仍独立 |
| 公共查询/通知/Host 冒烟 | p08-dag-f013-delivery-context；p07-4-f006-notification-projection；p08-4-f009-phase-integration | 本任务 not_run；旧阶段安装/Host 场景不能替代新 DAG 生产装配冒烟 |

真实模型、付费额度、desktop-platform 实战迁移、main/父分支合并、负责人签署均未执行。不能将 Fake 成功、脚本退出 0、Task delivered 或上述清单存在视为这些门槛通过。
