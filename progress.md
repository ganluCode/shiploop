# P03-10 工作进度

## F-004 — Core 完整 Feature 执行报告（2026-10-19）

- 新增 `QueryService.getFeatureReport` 和只读 report 端口/SQLite 适配器，默认 Core 装配已接入。复用既有分轴判断；全部 Task、跨 Run Attempt、返工/取消/interrupted、子 Session、检查、审批、operation、诊断与证据按稳定身份重建。
- ID keyset 分页在单一一致读事务内排空，附项目事件水位；正文按快照 hash/size 与执行归属校验。缺字段、缺/坏证据保留并标 partial；未知 token/cache/cost 为 null，Fake 标 synthetic；Session 累计时间与墙钟跨度分列。
- 聚焦真实 SQLite 六项测试全部通过：三 Task、两 Run、130 Attempt/130 审批、重叠 Session、WAL 第二连接中途写入隔离、重复关联、缺历史字段/证据、正文损坏/缺文件/归属错误、授权与查询前后全库快照不变。`verifications/F-004/runtime-logs/test-xvpyhlc9.log` exit 0，6 passed / 0 failed / 0 skipped。
- `test-157mv3ds.log` typecheck exit 0；`test-gw93ei8l.log` 边界检查 exit 0（284 文件，0 diagnostics）。早期 RED/失败日志均保留，后续重跑均基于相关实现或用例修正。
- 交接：`docs/p03-10-f004-feature-report.md`；索引 `test/index/phases/P03/features/P03-10/tasks/F-004.json`；Harness selection 已引用索引。既有 Feature delivery / Work Session 查询回归只登记，交 Nezha 独立运行；未跑全量/组合门禁/Phase 验收。
- 无未解决阻塞。Host/CLI 报告暴露由 F-005 继续；未修改正式 feature.yaml/task_list 状态，收尾只经 Nezha CLI 报告。

## F-001 — 独立真实资源验收夹具

实现与局部验证完成；提交与任务报告以 Git/Nezha 记录为准。仅处理 F-001，没有修改 feature.yaml、task_list 或其他任务状态。

- 受测基线：`14386921209e98f6bfc49f2c93373aeacc0473a5`，与 P03-9 累计分支一致；P02 `0e76ad8d9ae7a9e03949c8af4bae8e7e236acd56` 祖先检查通过。
- 新增 `test/helpers/p03-10/acceptance-fixture.ts` 和显式构建 Fake Host 脚本，复用 P02 隔离资源、CLI session、只读探针、监督器、OwnedProcessTree 与真实 CommandProcess。业务数据只由构建 CLI/Host 写入。
- 证据覆盖基线/工具、CLI 实际结果、只读 SQLite 实体及 operation 关联、Git、进程身份、有界输出与 Fake unknown 用量。先导出再停树/组，全部确认后删除；失败保留并允许重试，cleanup 保留各次结果和耗时。
- 六项自测覆盖准备/Host 中断、真实执行、只读拒写、脱敏和输出边界、外部路径/悬空链接保护、停止未确认、活跃工具树与导出失败。
- 本地 TDD：缺夹具 RED → 最小 GREEN → 四场景 RED/GREEN → 六场景及强化断言。发现预算未知量保护和 requirementsRefs/prepare 不一致后，按公开契约修正装配；没有放宽产品保护。悬空链接测试验证了底层清理拒绝，修正测试创建链接的 finally 回收后六测再次 GREEN。
- 最终聚焦日志 `test-1ezmbjj1.log`：exit 0，6 passed / 0 failed / 0 skipped，含真实 build 与 Core/Host/CLI 入口烟测。`test-vgwkdhqe.log`：typecheck exit 0。日志位于 Feature workspace `verifications/F-001/runtime-logs/`；所有旧失败证据保留。
- 最终工具树在异常前仍活跃、异常后进程组消失；cleanup 341ms。两处本次早期失败遗留根经身份/无进程使用与安全边界核对后已清理，保留额外清理报告。
- 测试索引：`test/index/phases/P03/features/P03-10/tasks/F-001.json`；Harness selection 只引用该索引。P03 Phase 仍为人工验收、not_accepted；广泛回归交由 Nezha。
- 使用、P03-1～9 接口映射、实际版本、六项证据目录、清理语义与限制见 [F-001 交接](docs/p03-10-f001-fixture.md)。

本地通过只表示资源夹具满足本任务验证范围。真实 Pi/LLM、完整 P03 故障矩阵、Verifier/最终交付场景、跨平台及全阶段验收均未在本轮运行；Fake completed 不折算 Task passed 或 Feature completed。

## F-002 — P03 阶段验收机器可读检查清单与受校验配置

实现与局部验证完成；提交与任务报告以 Git/Nezha 记录为准。仅处理 F-002，未修改 feature.yaml、task_list 或其他任务状态。

- 新增 `acceptance/p03.checklist.json`（33 项 = 30 必需 + 3 deferred）与 `acceptance/p03.config.json`，固定 FR-1～FR-3 正常/关键负例、T02～T40 验收编号（T38 仅报告结构、T40 仅通用恢复决策）与证据要求映射；完成、预算耗尽、人工阻塞、最终检查失败、仅收尾重试五个纵向演示独立成项，unit/feature-integration/phase-acceptance 分层标注。
- 新增 `scripts/acceptance/p03-config.ts`：冻结基线 + fail-closed 校验，拒绝无效配置、重复/未知/deferred 检查 ID、删减断言、改写 FR/T 映射、降级层次、业务版本表/凭据字段；配置沿用 npm 与 P01/P02 版本约束，含有限步骤/总时间与输出上限、显式 Fake 身份、临时资源与报告范围；live/Pi、强沙箱、后序能力 deferred（not_run/postponed），不计入已通过数。
- 测试：`test/modules/acceptance/p03-10-checklist-config.test.ts` 9 个 `[case:...]`；索引 `test/index/phases/P03/features/P03-10/tasks/F-002.json`，Harness selection 仅引用该索引。
- 验证：`test-yex50_3h.log` exit 0（9 passed / 0 failed / 0 skipped）；`test-64bt5d0y.log` typecheck exit 0。日志在 Feature workspace `verifications/F-002/runtime-logs/`。
- 交接与映射表见 `docs/p03-10-f002-checklist.md`。

本地通过只覆盖本任务清单/配置校验范围。`accept:p03` 控制器与阶段报告聚合由后续任务交付；真实 Pi/live、强沙箱、真实用量/缓存收益未运行且不折算通过。

## F-003 — 三 Task 链诊断与受控提交阻塞

F-003 尚未满足验收，收尾应报告 `blocked`；正式 feature.yaml、task_list 及其状态未修改。负责人需协调逐 Task 受控提交契约与实现，不能用 Feature 最终提交补认 Task 放行证据。

- 新增正式构建 CLI/Host 三 Task 场景：项目内真实检查配置、导入/摘要审批/显式执行授权；Fake 实际写文件，真实 Node 检查及 Git 身份检查，生产 VerificationStore/制品/Task 完成服务负责结算，无业务表 SQL seed。
- 真实顺序为 1 → 2 首次 → 2 返工 → 3，检查退出码 0/1/0/0、testCount 1/2/2/3。第二项新 Attempt 保留同 worktree 的 tracked README 和 untracked marker，先核对原内容再 append 增量修复；新输入含现场与失败证据；第二项通过前第三项零启动。Task Attempt/代码次数分别 1/2/1。
- 修复实际 RED：补偿扫描用 run_control_blocked 覆盖验证暂停原因，导致真实检查通过后 completion ignored/invalid_transition。现在保留持久暂停原因，控制诊断留在内存；新增重复扫描的 SQLite 回归。
- 动态确认关键缺口：三个 Task 最终均 passed，但 git_operations 为零、HEAD 未改变。诊断报告 `status: failed / task_passed_without_controlled_commit`；端口与数据库约束均仅支持 feature_final_commit。Feature 全量检查与收尾为 not_run，未宣称 Feature/阶段通过。
- 同 commandId 原请求经 CLI 重放后，starts/Attempt/Session=4，Run/Batch=1，事件=50，回执=24，Git operation=0，全部不增加；最终 Git HEAD/tree 不变，修改仍未提交。检查前阶段轨迹、两次输入、真实输出、Git 事实及回执完整导出；cleanup passed，进程树/组停止、资源删除。
- TDD 与诊断日志均在 Feature workspace `verifications/F-003/runtime-logs/`：初始缺三 Task RED `test-xc4kk71y.log`；事务装配 RED `test-232ar8hv.log`；验证暂停 RED `test-dimzs0a5.log`；最终 `test-paeuc6he.log` exit 0，2 passed / 0 failed / 0 skipped；`test-wqdu81jm.log` typecheck exit 0。两项测试 GREEN 仅证明诊断与修复有效，不表示 F-003 验收成功。
- 最终证据目录：`evidence/three-task-chain-38487165-20bb-4707-944c-43db748a63b1/`，含 three-task-chain.json、stage-*.json、evidence.json、cleanup.json。受测 HEAD 为 `9c81be306ba4a8de462f777fdc4972dad93a524d`，dirty=true 记录本次待提交代码；最终实现以 Git 提交为准。
- 索引 `test/index/phases/P03/features/P03-10/tasks/F-003.json`，Harness selection 已落盘并引用它。新增两文件已本地执行；F-001 六项及旧 scheduler 五项为已选未运行回归，交 Nezha。未运行全仓/组合 verify/阶段验收。
- 具体装配、阻塞接口、证据与后续门禁见 [F-003 交接](docs/p03-10-f003-three-task-chain.md)。
