# DAG F-011：GitAgent 候选与集成证据

本任务交付 Core 修复消费者、候选裁决与集成证据发布服务，以及受控 Git 提交/恢复所需的适配器支持。生产 Core/Host 组合根的最终装配仍由 F-014 完成；这些构造函数不自动启用修复策略，不注册模型可调用的管理入口。

## 调用链和可信依赖

1. `createGitAgentIntegrationRepairConsumer` 消费既有 repair Run。首次认领前重新读取失败 operation、失败回执或 journal 证据，核对身份、输入摘要、工作区摘要和证据引用。仅冲突或明确批准的组合验证失败允许调用 Runtime；Git lock、对象缺失、身份错误和正常 merge 继续走确定性处理。
2. 可信 `admit` 重核当前 credential reference、策略授权、owner/version、工作区占用和父预算。无 driver 或核验失败先持久化 hold，不创建新的模型 admission。已认领的重放只收尾已有候选；停止未知保留隔离，不重新启动。
3. 新启动使用 store 实际授予的剩余 Token/runtime/deadline，随后由现有 `runGitAgentRepairAttempt` 监督及结算。调用方必须持久关联收紧后的 Runtime requestDigest；原 repair 授权摘要仍作为业务操作绑定。失败、取消或停止未知不能进入候选提交。
4. `createGitAgentCandidateFinalizationService` 的可信 `integration` 接点提供原失败 operation、模型启动前的不可变完整工作区 inspection、当前授权核验和发布器。原 inspection 必须由 Core 保存并核对制品身份，不能使用模型结果、可变路径或候选返回后的快照替代。
5. 候选返回后读取实际 bytes/modes、Git 状态、HEAD、祖先关系和冲突标记。模型报告的 changedPaths 必须等于启动前后实际内容差异，且属于精确 writablePaths；原有确定性合并已经暂存且未被模型修改的文件可进入受控提交。删除、重命名、冲突标记、越界、输入/身份漂移、验证期间同路径字节变化均阻塞。
6. Core 验证器返回 `verification_result` 和 `planEvidence`，授权读取器将同一 plan/result 引用写入不可变 Git 意图。Core 控制者仍需核对冻结检查范围、实际结果和制品摘要，Runtime 自报通过不参与裁决。

这些依赖只由可信应用装配提供；不从 HTTP、CLI、模型输出或项目脚本反序列化函数。`admit`/`assertCurrent` 不能是生产中的恒真回调。当前构造函数不代替 F-014 的可信身份、制品解析、工作区资源和 Host 生命周期装配。

## 受控 operation 与恢复

`gitAgentIntegrationCommitPlan` 从原执行计划和已持久化的 repair Run 派生修复计划，因此相同 repair 的恢复保持相同 operation ID。它与原失败 operation 分开，原失败回执不被改写为成功。SHA operation 对公共锁使用稳定 UUID 映射；Git 意图、消息和回执仍保存完整 SHA 身份。

修复使用 `integration_commit`，不使用 `feature_final_commit`，也不改变前置 Feature 的 delivery、Task 通过标志、DAG 边或预算。意图的 `budgetSnapshot.gitAgentRepair` 绑定 repairId、原授权摘要、原 operation/inputDigest、准确父提交和 Core 验证 plan/result 引用；`sourcePlanId/sourcePlanRevision/sourcePlanInputDigest` 绑定业务计划的 CAS 快照。

受控提交读取 MERGE_HEAD、暂存范围、实际 tree 和用户确认的 Git 身份。只有冻结双父完全匹配的冲突修复才能生成 merge commit；组合验证修复允许单父。`WorkspaceInspector` 仅在可信 `integrationRepair: true` 下读取 detached/unmerged 常规文件并扫描冲突标记，默认编码工作区仍拒绝这些状态。符号链接、特殊文件、Git 元数据和资源停止纪律保留。

回执丢失时复用现有 reconciliation：核对实际 HEAD/tree、完整父列表、准确消息/operation、原始验证 inspection、资源和授权，落已有 operation 的回执；不再调用 commit 或 push。重放不能越过新的人工 hold。

## 发布与后继门禁

`createGitAgentIntegrationEvidencePublisher` 先经可信 `verify` 重读实际 Git/制品事实，再在同一 Core 事务中核对修复与原 operation、原计划 owner/version、revision、输入摘要和授权。`verify` 必须检查实际工作区停止且干净、目标基线、全部直接前置祖先关系，以及冻结检查计划和结果制品；`authorize` 在写事务内重核同一授权、资源围栏和预算/deadline。

只有成功受控 operation、完整 plan/result evidence 和 SQLite CAS 都成立时，原业务 integration plan 才可成为 `integration_passed`。业务计划和执行计划的 inputDigest 使用各自的摘要域。原 source operation 为 pending 时可在同一事务补齐成功回执；已经 failed 的历史回执保持原样。重复发布复用相同事实，不重复状态事件或提交。

候选终结服务还独立核对实际提交覆盖全部冻结前置。只修好合并前缀而未覆盖所有输入时返回 `integration_coverage_incomplete`，不发布后继证据；剩余确定性集成及其验证必须完成后走受控集成路径，不能用修复候选的成功替代完整集成。`successorUnlocked` 仅表示证据门槛已满足，不直接派发后继或修改其状态。

## 本地验证与保留范围

- 新增三个文件共 33 项通过：纯候选/消费者/发布规则 31 项；真实临时 detached 冲突 Git + SQLite 受控提交及回执恢复 2 项。最终日志：Harness `verifications/F-011/runtime-logs/test-jz262gqd.log`。
- 既有候选与恢复两个文件 13 项通过：`test-w8h948tm.log`。首次 SQLite 恢复基线另有 1 项通过，见 `test-b3rhyytj.log`，不混入最终 46 项计数。
- 类型检查通过：`test-4b2msk7g.log`；模块边界通过（599 文件、0 诊断）：`test-hnm9f7dh.log`。RED、中间失败、真实退出码及旁文件均保留。首轮基线日志因路径重复输入写到错误目录，已完整复制回本任务日志目录（`test-06qs25zo.*`），未为复制证据重跑。
- Task 索引：`test/index/phases/P08/features/shiploop-dag/tasks/F-011.json`。5 个 unit 文件交 Nezha 独立复验；10 个 integration 文件均绑定 `test/index/phases/P07/integration.json`，其中本地执行范围如上，其余保持 not_run。
- 未执行全仓、Phase、live、真实认证或付费模型。完整生产 Host/SQLite/授权修复/进程强杀/后继派发组合场景是 Phase 的独立门槛，本地临时仓库和注入 Runtime 不代替它。
