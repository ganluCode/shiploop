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
