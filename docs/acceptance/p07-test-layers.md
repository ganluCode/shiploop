# P07 测试分层迁移

2026-11-01：保留全部 Task 历史通过记录与原始选择范围，仅为 P07-5 选择条目登记分类。

## 分类

当前 Feature 的历史内联选择为 70 个文件。与规范仓库 Task 索引去重合并后为 76 个文件，
其中 3 个纯单元文件、73 个集成文件。额外 6 个规范索引回归仍保留，不因迁移遗漏。

审阅为纯单元的文件：

- test/modules/recovery/p07-5-f003-recording-prefix.test.ts：内存 manifest 与端口替身核验。
- test/modules/recovery/p07-2-f006-recording-recovery.test.ts：恢复决策与身份/缺口逻辑，不启动资源。
- test/modules/cli/p07-4-f009-notification-cli.test.ts：参数解析、视图与帮助，不访问 Host/SQLite。

其余真实 SQLite、Git、Host、子进程、文件持久化和混合场景保守登记 integration；不靠耗时
或目录推断为 unit。以后若拆出纯逻辑用例，可使用稳定 case ID 缩小边界，不删除集成断言。

## 门禁

- Nezha Feature 门禁运行 3 个单元文件的去重合集，不等于 P07 已验收。
- test/index/phases/P07/integration.json 保留 73 个集成文件，既是 Nezha 延后范围覆盖索引，
  也是 accept:p07 默认范围的必需输入。正式入口核验覆盖并纳入范围及输入摘要，不因属于旧 Phase 而跳过。
- 规范 Task 索引和 Harness 内联选择都补分类；Task 通过历史不重置、不重新调用模型。
- 新执行的 Task/Feature 可能显示 delivered，表示代码交付但集成 not_run；不等于 completed，
  不解除人工阻塞、不自动签署 Phase、不清理待验 worktree。

正式 Phase 验收仍需在干净的 acceptance/p07 分支使用新 run ID 执行，并保留集成结果、
缺口和负责人签署。本文不是本次正式验收通过证据。
