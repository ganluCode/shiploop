# P06-7 F-004 知识与受限增量场景

本任务覆盖 I03（知识与 Manifest）、I04（受限增量）及相关 I07 负例；不代表 P06 阶段验收或负责人签署。

`test/modules/acceptance/p06-7-f004-knowledge-increment.test.ts` 使用 F-002 Todo 存量仓库及真实临时 Git、SQLite、制品和检查子进程。复用绑定夹具通过公开 Core 命令完成注册、配置、计划批准、输入准备、启动授权，再通过真实认领端口创建 Attempt 和授权 invocation。没有手工写业务 SQLite；只有模型决策由声明式 FakeRuntime 替代。

六个稳定 case 覆盖：

- `p06-f004-query-readonly`：身份/版本/中文关键词检索、受管来源与 hash/位置/有界片段、真实正文；全库逻辑快照、制品文件摘要和 Git 状态不变。
- `p06-f004-attempt-increment`：知识版本、hash、范围、用途、理由及预算固定进制品组和真实 Attempt；发布新版本、修改项目配置、查询另一项目后旧行与制品字节不变。FakeRuntime 只获准 Todo 子目录，读取固定 snapshot/manifest 后修改 `todo/inbox.txt`；实际文件、Git diff、命令退出码 0 相互核对。原脏文件、暂存内容、文档、隐含指令文件和另一项目文档保持原样。
- `p06-f004-rejections`：跨项目 ID、伪造 projectId、路径穿越、读取预算不足、缺少必需知识、缺失/损坏正文、未经确认的资源参数拒绝；全库及工作区无意外副作用。
- `p06-f004-failure-evidence`：写入后失败保留部分进度，实际增量检查退出码 7、已知失败检查退出码 3，符号链接和目录穿越拒绝；按 Attempt/输入摘要发布并复读结构化失败制品。
- `p06-f004-snapshot-validation`：v5 知识字段被保存；旧 schema 携带新字段、跨项目引用、非法范围/预算和未知字段拒绝。
- `p06-f004-drift-and-replay`：相同准备命令重放零新增副作用，异参同 ID 冲突；Manifest 实际字节漂移导致绑定 `input_corrupt`，错误与拒绝证据制品原因一致，原 Attempt 输入与工作区不变，独立 SQLite 连接复读核对。

纵向测试发现并修复生产缺口：`AttemptStore.validateAttemptInputSnapshot` 原先不接受 `knowledge` / `knowledgeBudget`，知识输入能准备却无法认领。现在仅 v5 接受这两个字段，复用 ContextBuilder 的同一校验、保留项目隔离及总字节上限；历史无知识快照行为不变，没有修改 SQLite schema。

本地最终定向验证命令：

```text
node scripts/run-tests.ts test/modules/acceptance/p06-7-f004-knowledge-increment.test.ts test/modules/runtime/p03-6-execution-input-binding.test.ts --testNamePattern 'p06-f004-|case:launch-receipt-binding'
```

Node 22.19.0，Vitest 5.0.3；7 项通过（新增 6 项及原绑定夹具的 1 项），38 项按明确 case 筛选未运行，退出码 0。完整日志及退出码 sidecar 位于 Harness Feature 的 `verifications/F-004/runtime-logs/test-h_eowel8.log`。类型检查退出码 0：`test-5npaqvpb.log`；边界检查 468 个生产文件、0 诊断、退出码 0：`test-6lkqarq_.log`。原始 RED 与调试失败日志均保留，真实生产缺口的 RED 为 `test-xycxqcg4.log`。

Task v2 索引为 `test/index/phases/P06/features/P06-7/tasks/F-004.json`。其余 ContextBuilder、知识查询/Manifest 集成和旧画像快照回归只登记交 Nezha，不能记为本地通过。未执行全仓、阶段入口、真实模型、live 或人工签署。

范围说明：限制作用于本次 FakeRuntime 的可信装配根；不声明 Pi 默认工具具有文件白名单或强 OS 沙箱。全局文档、仓库 AGENTS.md 哨兵及未选资源没有进入本次固定输入；这不是所有 Runtime 的资源隔离证明。Task 仍为 running，模型 completed 和本次实际检查通过不直接设置产品 Task passed。场景证据在临时制品删除前复读核对；阶段报告采集/持久导出接线由 F-006 负责，本任务不声称已输出正式阶段报告。
