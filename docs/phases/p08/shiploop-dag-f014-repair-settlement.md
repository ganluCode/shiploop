# F-014：修复候选结算与生产接线缺口

日期：2026-11-10。本文记录 F-014 的实现与验证状态；正式 Feature 验收仍由验收流程记录。

## 当前状态

F-014 的默认 Host 接线已完成：`gitAgent` capability 为 `available`。默认 WorkScheduler 会先识别并消费已授权的 integration repair Run；只有 repair consumer 返回未消费时，才继续执行原有 `beforeRun`、Feature DAG 和 Task claim 路径。

当前闭环包含：repair authorization、持久 Attempt、冻结上下文、Pi Runtime 消费、候选前 inspection、独立候选验证、候选终结、受控双父 Git 提交、`integrationResult` 发布、successor baseline 绑定，以及 dispatch/slot/租约释放和重放幂等。未知进程或停止证据不足时仍保持阻塞，不释放资源。

本文件后续章节保留各实现检查点的历史记录。章节中写有“仍未接通”“保持 `unsupported`”的段落，描述的是对应检查点当时的状态，以本节为当前状态准则。

## 候选结算

旧实现把“允许启动下一次模型请求”与“结算当前已停止的候选”共用次数检查。仅授权一次修复时，即使模型成功返回 `modified`，仍会因为次数达到上限而写入不可清除的 `budget_exhausted`，候选终结服务因此拒绝验证和提交。

现在将两者区分：

- 新调用仍要求次数和父 Batch 的准入计数有余量。
- 已停止且没有失败码的 `modified` / `no_change` 候选允许计数等于上限，但不允许超过上限。
- 有效候选进入 `paused / repair_pending_verification`，等待 Core 验证；不直接标记成功或解锁后继。
- Token、时间、停止证据、既有人工阻塞和失败码检查保留。没有增加授权额度，没有清除历史 hold，没有允许新的隐式重试。

针对临时 SQLite 的回归覆盖最后一次候选、`no_change`、父计数等于/超过上限、失败码、重复结算，以及候选后拒绝再启动。

## 生产接线历史检查点

在该历史检查点，`assembleDagIntegration` 尚未接通默认 GitAgent consumer；后续实现已完成默认 Host 装配。

方案 A 中后继 Run 在明确授权的 Batch 内以 queued 状态等待集成；集成租约由 `integration_execution_claims` 持有。旧 `GitAgentRepairStore.authorize` 则要求 source Run 已终态且没有其他活动 Run/dispatch claim，再创建独立 `git_agent_repair` Run。直接将两个模块连接会被活动 Run 唯一约束和工作区租约阻塞，不能通过移除这些检查绕过。

下一个装配步骤应使修复消费现有明确授权的 Batch/待集成成员身份，持久绑定 source operation、冻结策略和上下文、owner/version、候选前 inspection 与进程身份；不能为接线暗建 Batch/Run、修改不可变 input_snapshot 或提前创建编码 Attempt/worktree。修复启动、结算、独立验证、受控提交、基线绑定和重启恢复必须分别有证据。

Host 已有的生产 Runtime driver 和模块单元测试不等于上述生产授权链已经可用。完成该接线和临时 Git/SQLite 垂直验证前，F-014 保持未通过。

## 待集成成员授权入口

新增 v73 `integration_repair_authorizations`，保存绑定原集成 operation 的不可变 request、owner/revision 围栏及幂等回执。`dagIntegration.authorizeRepair` 是内部受信入口，事务内复用 `context.authorize` 核对当前完整集成授权；不向模型、Host 命令或配置开放任意授权写入。

新授权要求原 Run 为未启动的 queued execute 成员、具有冻结 integrationAuthorization、没有编码基线/Attempt/活动 dispatch；原失败 operation、工作区摘要和失败证据必须匹配，且所有已登记集成进程已确认停止、集成资源租约有效。相同 commandId 和完整内容重放返回原回执，即使已过期也不重新授权；变更内容、owner/revision 或复用其他修复身份均拒绝。

该记录仅固定修复意图，不预占 Runtime 次数或 Token，不创建专用 repair Run，也不解除编码门禁。模型启动消费者仍必须在实际启动前持久认领、冻结剩余预算/策略/上下文与候选前工作区证据，并监督停止。现有 `git_agent_repairs` 终态 Run 修复路径保留；不能把新的授权回执直接交给旧队列 claim。

本步尚未实现新授权的 Runtime 消费、候选提交与恢复链；生产 `gitAgent` 能力保持 `unsupported`，不标记 F-014 通过。

## 受信 Runtime 消费者检查点

新增 v74 `integration_repair_attempts`，并提供 `createSqliteIntegrationRepairAttempts` 与 `createIntegrationRepairConsumer`。本检查点仍未接入默认 Host。

- 一个授权当前只允许一个持久 Attempt；重复消费不重新启动 Runtime、不新增 Run、不重置预算。竞争消费者只有首次认领者可启动。
- 同一短事务内占用既有 Run dispatch/execution slot，增加父 Batch 的 attempts/runtimeStarts 与原 Run 的 attempts；集成工作区继续由原 integration owner 持有。
- Token 上限考虑本 Batch 编码已报用量、Feature/Git 修复及本表预占，未知编码用量拒绝准入。本表预占保守保留，不按模型成功结果自动退额。
- 启动前保存收紧后的完整 Runtime request，不能改变原授权的路径/上下文引用。进程确认保存经过校验的 OS 身份，停止结算只更新本次登记的 launch。
- 超时/取消结果保持失败语义；不因晚到 completed 或后续重放交付候选。候选回调只表示交给下一步独立核验，不表示验证、提交或后继解锁成功。
- 未确认停止时，数据库触发器拒绝释放 dispatch、slot 及原集成资源。重开数据库能读取已停止结果；仅有认领、请求或未知停止时返回阻塞，不盲目重跑。

定向 6 文件 184 项测试、类型检查通过。新增行为使用 Fake Runtime 和临时 SQLite 验证，不是生产模型调用或真实故障恢复验收。

### 仍未接通的边界

1. 将已完成的 provider/credential/策略冻结、候选前 inspection 制品及受信 Runtime authority 装配进默认消费者；目前只有内部上下文准备入口和离线 driver 垂直验证。
2. 将默认集成执行器与本消费者连接，并在实际认领/启动事务内重核完整批准与输入事实。
3. 受监督恢复认领后的进程及 dispatch/slot 收尾；本检查点仅保守拒绝未知执行，不自动释放或重新认领。
4. 候选验证、受控提交和 integrationResult 发布的生产编排仍未接通；同 Run 下独立修复 operation 身份已在下节补齐。

以上边界未完成前，不得启用生产能力、恢复 F-014 为通过、自动启动模型或释放后继编码门禁。

## 本轮验证

- 定向 6 文件、175 项测试通过：待集成修复授权、Schema 对照、迁移执行、旧修复队列、集成候选链和方案 A 多成员授权。
- `npm run typecheck`、`git diff --check`、`npm run build` 通过；构建包含临时 Core/Host/CLI 入口冒烟。
- 多成员授权回归暴露随机 UUID 顺序问题：回执创建使用冻结成员顺序，重读使用 UUID 排序。现在按冻结 scope.featureIds 重建 runIds，并覆盖正序/逆序输入。此排序只影响回执关联，不改变 DAG 依赖或执行顺序。
- 补齐迁移执行测试的表清单：此前 v69/v72 已有表与本轮 v73 表均明确列出。
- 未运行全仓测试、真实模型或生产项目；未重装、未改 Feature/Task 状态、未提交或 push。

## Host 工厂、共享预算与修复提交身份

修复集成提交的 Git operation 不复用普通编码 Attempt 外键：`intent.attemptId` 保持为 `null`，repair Attempt 的 UUID、owner 和 execution version 保存在 `budgetSnapshot.gitAgentRepair` binding 中。这样 Git operation 仍遵守普通 operation schema，同时保留 repair 归属围栏。

repair merge commit 的第一个 parent 取候选验证时实际观察到的目标工作区 HEAD，第二个 parent 取前置 Feature 的 delivery commit；冻结 integration target base 只用于目标身份校验。候选源码身份使用 `verificationCodeIdentity`，提交前后的完整字节一致性继续由 `gitCommitSourceDigest` 校验。

- `productionPiOptions` 提供静态 `gitAgentRuntimeFactory`，通过 HostStartOptions 和 CoreApplicationOptions 传到集成器。工厂复用同一份已解析配置、WorkRuntimeFactory 和 capabilityCatalog，不重新读取 runtime.json。工厂构造不读取授权、不发送模型请求。未配置 Pi、恢复隔离、quiesce 或非法工厂均保持拒绝边界。
- `dagIntegration.repairRuntime` 仅构造受信适配器；它不自行解析/批准 Binding、不认领 Attempt、不启动模型。该入口不暴露为 CLI/HTTP 参数。生产策略和上下文持久装配仍需完成，不能由任意回调替代可信事实。
- 新增共享 `integrationRepairReservedTokens`，Feature 自动修复、旧 GitAgent 与新集成修复均计入本表的完整 Token 预占。当前策略不自动退款；无 Token 上限时不新增限制。临时 SQLite 测试验证预占耗尽时旧修复路径不启动模型、不发布制品。
- Run/Batch 暂停控制把未确认停止的集成修复计入活动写入者，保持 pausing，而不是提前返回 paused。未知进程仍保留槽位/租约。
- 同 Run 修复计划新增可选 `repairAuthorization`，冻结 repairId、authorizationDigest 和 sourceOperationId，产生独立稳定 operation ID。历史无该字段计划的摘要输入不变，不改前置覆盖集合。提交授权同时核对这三个字段和既有 GitAgent budgetSnapshot 绑定。
- 真实临时 Git 测试覆盖新身份下的双父 merge commit 与幂等提交；该测试使用受信夹具，不等于默认 Host 已完成冲突自动修复闭环。

阶段验证：7 文件 80 项通过（提交身份、临时 Git、预算消费者、暂停与工厂）；另一组 6 文件 98 项通过（工厂/Host/驱动/旧修复）。两组范围重叠，不累加作为独立测试总数。类型检查通过。仍未运行全仓/真实模型/生产数据验收，也未重装、提交或 push。

## 冻结上下文与生产 Runtime authority

- 新增 v75 `integration_repair_contexts`。在任何修复 Attempt 准入之前，将当前批准、策略、语言、请求上限、意图和失败证据、仓库基线及完整候选前 inspection 保存成有界、校验 SHA 的不可变制品。事务外读取/发布制品，短事务内重核完整事实后绑定引用。
- 默认集成器新增内部 `prepareRepairContext` / `readRepairContext`。只使用已配置的 high 策略与对应 Pi 凭据引用；没有可用配置或可靠 HEAD 证据时拒绝，不猜测默认模型或基线。
- 新增 `createIntegrationRepairRuntimeAuthority`，供现有生产 Pi driver 使用。实际启动前核对持久 Runtime request、owner/Host/version、冻结配置和工作区；确认进程时持久记录 OS 身份；候选路径根据受信 inspection 计算，不接受模型自报路径。
- 候选不能更改仓库身份、注册信息、Git 引用、目录、授权范围外文件、文件模式或索引对象。回归先暴露引用摘要变化未被拒绝，补齐检查后通过。允许冲突文件工作区内容变化，不允许模型自行提交或解锁编码。
- Runtime 结构化结果及事件类型/序号另存制品；不保存原始工具事件正文。重复消费已停止候选不重复调用模型，旧 before inspection 不被覆盖。
- 离线垂直测试使用生产 Pi driver、Fake WorkRuntimeFactory、真实临时 SQLite 和制品文件。覆盖进程确认、候选结算与重复消费；没有调用真实 Pi 模型，也没有证明默认 Host 自动消费和候选终结链已经可用。

本轮五文件定向回归 154 项通过；其后新增策略漂移用例，授权链单文件复验 35 项通过，确认配置变化时不启动模型、不创建 Attempt、不扣准入预算。`npm run typecheck`、`npm run build`（含临时 Core/Host/CLI 冒烟）、`git diff --check` 通过。测试集合有重叠，不累加历史次数。

下一步仍需：将上下文准备纳入 Host quiesce 等待；装配默认消费者及候选独立核验/受控提交/结果发布；完成未知进程恢复和 dispatch/slot 收尾。上述链路完成前保持 `gitAgent: unsupported`，F-014 未通过，不重装、不修改业务状态、不启动真实模型。

## 未提交候选的独立命令验证

原 `createNodeIntegrationVerificationExecutor` 要求工作区干净、无索引/工作区差异，并确认所有前置 SHA 已成为 HEAD 的祖先。这适用于已提交集成，不适用于尚未提交、索引仍有 UU 的冲突修复候选。不能为了接通候选而放宽原入口。

新增独立内部入口 `createNodeIntegrationCandidateVerificationExecutor`，构造时接收 Core 冻结的 operationId、inputDigest 和完整候选 inspection，不从 Runtime 输出或 Host 请求中读取这项授权。

- 运行选定检查前后，重核授权、截止时间、HEAD/tree、仓库身份、注册信息、Git 引用、状态、内容/忽略项/目录及冲突标记，拒绝不完整或变化的候选。
- 候选入口不要求被合并前置已是当前 HEAD 的祖先，因为此时 Core 尚未创建 merge commit；这不免除受控提交后的前置覆盖检查，也不代表后继可以启动。
- 命令及停止证据继续使用现有 CommandProcess 与有界制品收集，严格执行被冻结计划选中的检查，不自动扩展为全量测试。原已提交入口规则不变。
- 候选计划/结果使用独立制品类型 `integration-candidate-verification-plan/result`，显式记录 workingTreeDigest 和 hasUncommittedChanges=true；不能作为已提交集成通过的证明。

新增真实临时 Git/SQLite 测试：制造合并冲突、写入解决内容，真实运行 Node 检查并保存证据；确认检查结束时 HEAD 不变、索引仍未合并，再将证据交给既有 Core 受控提交服务，核对双父 merge commit 和干净工作区。这是验证执行器到受控提交的真实模块串联，不包含默认 Host 调度、模型修复、新授权记录到终结服务的装配、integrationResult 发布或后继基线绑定。

本步没有完成整个正常生产路径，F-014 仍未通过。后续应把上述执行器接入现有 candidate finalizer 的 verify 边界，并连接持久修复视图、当前授权、结果发布和基线绑定；不得以本测试通过替代这些步骤。

验证：4 个定向文件、83 项测试通过（候选执行器、真实 Git 提交、旧候选终结链、新授权链）。`npm run typecheck`、`npm run build`（包含临时 Core/Host/CLI 冒烟）、`git diff --check` 通过。没有运行全仓测试、真实模型或生产项目；没有重装、提交、push 或修改 Feature/Task 状态。

## 受控提交的真实集成租约接线

继续装配时发现：原受控提交与丢回执恢复服务只支持编码 Attempt 的三把 Work 租约；之前真实 Git 测试也沿用了这类夹具。因此它们尚不能消费方案 A 的原集成资源，已有 `IntegrationCommitResourceFence` 类型当时并未使用。

- `integration_commit` 现在必须使用显式注入的集成资源校验器，不允许回退到普通编码租约。普通 Task/Feature 提交保持原路径。
- 集成快照包含 source integration 身份、ownerVersion、完整资源声明、真实 Feature resource leases 及写入者身份。首次提交和只读回执恢复共用校验，要求源 operation、项目/owner/Host/version 一致，资源完整、未过期且处于 held。
- 写入前独立确认集成写入者停止，并重读同一快照；整个提交过程继续重核授权和资源，不解锁/释放租约，不增建编码 Attempt。
- 临时 Git 夹具改用 SQLite 中真实的共享代码门、集成 worktree 独占租约和 contract 租约，不再用伪造 Work 租约证明集成路径可用。回归覆盖缺少校验器、旧 owner/version、错误 source operation、contract 租约丢失、过期及停止不确定时拒绝提交；回执丢失只观察既有 merge commit，不重复提交。

本步仍未提供默认 Host 的具体资源 reader/停止证据装配，也未连接修复持久视图、candidate finalizer、结果发布与后继基线绑定。因此没有启用生产能力，F-014 仍未通过。这里完成的是受控提交/恢复端的资源接收边界，不是整个正常成功路径。

验证：真实集成提交文件 7 项通过；随后补充的资源快照反例单独复验通过。普通受控提交、回执恢复、候选终结链、命令验证执行器共 4 文件 97 项通过（242 秒，非全仓测试）。`npm run typecheck`、`npm run build`（临时入口冒烟）、`git diff --check` 通过，F-014 测试索引补入受影响的普通提交/恢复文件并通过 JSON 解析。集合存在重叠，不累加历史次数。未重装、未提交/push、未启动真实模型或改生产数据。

## 新修复记录接入既有候选终结服务

- `createSqliteIntegrationRepairCandidates` 从不可变授权和原 Run 的修复 Attempt 读取 `GitAgentRepairView`，核对 project/repair/run/source/owner/请求一致；保留真实 dispatch、停止时间、用量和输出，不创建第二个 repair Run，不改预算或编码状态。
- 新增 v76 `integration_repair_candidate_holds`。候选终结服务的首个 hold 持久绑定 project/repair/attempt；后续 hold 不覆盖、不清除首个原因，数据库禁止修改或删除。历史授权回执保持原值，当前阻塞单独读取。
- `createIntegrationRepairFinalizationConsumer` 将已停止候选交给既有 `createGitAgentCandidateFinalizationService`，向调用方返回其实际结论，不再把 Runtime 的 `modified` 当作提交/集成成功。未知停止不进入终结服务，不重启模型、不释放执行槽。
- 离线串联使用生产 Pi driver、Fake Work Runtime、真实 SQLite 的授权/Attempt/候选视图和既有终结服务。覆盖验证失败持久阻塞；成功提交结论和提交后发布阻塞正确传递；重复消费不重复 Runtime、验证或提交；源失败 operation 保留且修复 operation 身份独立。
- 这些串联测试的 Git 执行、验证结果及集成发布均为显式测试替身；真实 Git/独立命令/受控提交仍由上一节模块测试覆盖。尤其测试中 publish=true 不是默认 Host 或后继基线真实落库的证明；本轮没有绑定任何真实后继。
- 回归额外暴露：已结算请求在工作区内容恢复到旧 snapshot 时仍能重新解析启动 Binding。现在 resolve 在读取 snapshot 前及返回 Binding 前均拒绝已有 process identity/output/stoppedAt 的 Attempt，防止绕过消费者重复启动。读历史结果和结算不受此启动检查影响。

默认 Host 的完整装配仍未接通：还要提供当前集成授权/资源和停止证据 reader、候选独立命令验证及提交授权、实际结果发布和后继基线绑定，并处理 quiesce 与恢复收尾。保持 `gitAgent: unsupported`、F-014 未通过；没有重装、修改生产状态或调用真实模型。

修复上下文现在同时冻结 Core 生成的完整 `VerificationPlan`，包括选中的检查定义、命令参数、工作目录、超时和 required 语义；`factsDigest` 覆盖该计划。后续候选验证只能消费这份制品，不能在模型运行后读取漂移的当前配置或只根据 `verificationScope` 字符串猜测命令。

## 默认 Runtime 消费入口

`dagIntegration.consumeRepairRuntime(projectId, repairId, claim)` 已接入正式授权链：

- 读取并校验冻结上下文和授权 Attempt；
- 使用 Host 注入的生产 Pi Runtime factory；
- 在 Attempt 事务中绑定完整 Runtime request、确认进程身份并结算停止证据、用量和结果；
- 结果保留在 `integration_repair_attempts`，候选回调只做身份和冻结工作区核对；
- 同一 repairId 的消费被去重，并纳入 `activeCount`、`enterQuiesce`、`awaitQuiesce`。

这一入口故意没有把 Runtime 的 `modified` 当作已验收，也没有提交 Git 或绑定后继基线。下一步是把它连接到冻结 `VerificationPlan` 的独立命令验证和既有候选终结服务，再接受控提交与 integrationResult 发布。类型检查、构建和临时 Core/Host/CLI 冒烟通过；未调用真实模型、未修改生产 SQLite、未提交或 push。

## 候选独立验证接线

Runtime 停止并保存候选后，默认消费入口现在会：

- 从受信 workspace inspector 重新确认仓库身份、HEAD、索引和冲突标记；
- 使用 repair context 中冻结的 `VerificationPlan`，通过现有 CommandProcess 和有界制品收集执行选定检查；
- 发布 `integration-repair-verification-binding`，记录 operation、inputDigest、计划制品和结果制品引用；
- 只有检查 `passed` 且停止证据确认时，候选才会继续向终结阶段；失败则写入不可覆盖的候选 hold。

这一步仍未创建 integration commit，也未更新 `integration_plans.integration_result` 或 `run_execution_baselines`。验证绑定制品还需要接入候选终结服务的 `verify`/`readAuthorization`，再由 Core 受控 Git 提交并发布集成结果。类型检查、构建、Core/Host/CLI 冒烟通过；未调用真实模型或生产数据。

验证：候选授权/消费者、Schema 对照、迁移执行和既有集成终结服务 4 文件、159 项通过（约 30 秒）。类型检查、构建及临时 Core/Host/CLI 冒烟通过；未运行全仓测试。迁移回归最初因新增表清单未按字母排序失败，调整预期顺序后复验通过。未提交或 push。

## 修复上下文纳入 quiesce

`prepareRepairContext` 现在纳入 `dagIntegration` 的活动追踪：上下文 inspection、意图读取、制品发布和最终绑定期间都会计入 `activeCount`，`enterQuiesce` 后拒绝新准备，`awaitQuiesce` 会等待已接受的准备操作。相同 repairId 的并发准备共享同一次在途操作及其结果，不会重复捕获或并行写入上下文制品。

本步只收紧生命周期边界，没有开启 GitAgent 能力，也没有把上下文准备误认为候选已验收。类型检查和差异检查通过；默认 Host 的 Runtime 消费、结果发布、后继基线绑定与恢复收尾仍未完成。

新增 Core 临时装配回归覆盖同一 `repairId` 的并发准备去重、成功/失败共享结果、停止期间拒绝新准备、活动计数及失败后的清理；2 项通过。此前实现暴露了“先创建 Promise、后登记活动”的重复启动问题，已改为独立的 repair-context pending map。

失败场景另发现清理使用 `void promise.finally` 会派生未处理拒绝；现明确处理清理分支的失败，原始失败仍传播给所有调用者。成功/失败两项回归无未处理错误。类型检查、构建及临时 Core/Host/CLI 冒烟通过，未运行全仓、未启动真实模型、未改生产 SQLite。未提交、push 或重装。默认 Host 修复执行、结果发布与后继绑定仍未接通。
