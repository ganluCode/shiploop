# P03-10 工作进度

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
