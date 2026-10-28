# P06-2 / F-009 项目知识与输入 Manifest 纵向集成

本交接记录 F-009 的正式装配面、跨层回归范围和验证边界。测试使用真实临时数据根、SQLite、Artifact 文件和 Core 组合根；没有调用模型、网络或 OpenViking。

## 装配面

`openCoreApplication` 现在公开 `documentService`，其实现复用同一 SQLite `documents`/`document_versions` 存储、ArtifactPublisher、ArtifactVerifier 和受信 `inputSourceRoots`。文档登记、版本追加和受控读取因此与已经装配的 `knowledgeQueryService`、`memoryService`、`executionInputPrepare` 使用同一项目身份和制品完整性边界。

输入准备仍只接受受控知识选择描述。`createExecutionKnowledgeReader` 按 `kind + stable source id + version` 去重；memory 选择兼容 record key 查询并在 Manifest 中保存实际 memory record ID。`ContextBuilder` 保留首次选择的用途/理由/片段，预算按去重后的来源计数；受控 `contentRef` 搭配同值 `contentHash` 会被规范化接受，任意扁平制品字段仍继续拒绝。

Core 公共入口继续通过 `packages/core/src/index.ts` 导出端口与应用类型；Host 的知识能力仍只声明已装配的 `knowledge.search`、`knowledge.read`、`memory.search`，协议版本保持现有 `WIRE_MESSAGE_SCHEMA_VERSION`/Host protocol v1。F-009 没有增加 OpenViking、向量、自动提炼、Skills/MCP 或 Chat 能力。

## 纵向回归

测试文件：`test/modules/planning/p06-2-f009-manifest-integration.test.ts`。

同一真实临时 Core 项目覆盖：

- 文档 v1 登记、v2 追加、同版本重放、关键词和 ID 读取；
- accepted memory 候选、显式 CAS 接受和 memory 检索；
- 第二项目隔离、跨项目文档读取/登记拒绝；
- 受控 Task 计划、审批和 `execution.input.prepare`；
- Manifest 读取复核 project/feature/task、文档和 memory 身份、版本、hash、片段范围、选择理由和预算身份；重复文档选择只出现一次；
- 重开 Core 后身份和查询结果稳定；正文篡改、读取预算不足和必需来源失效均保留结构化诊断；
- 同一 commandId 重放原回执且不重复生成结果；数据库中无 Run/Attempt，证明没有 Runtime 或模型调用。

所有临时资源在测试 finally 中关闭和删除；正文篡改在断言后恢复原字节。测试中唯一的能力目录是离线 `pi/fake/offline-model`，没有 Runtime factory 和真实调用。

## F-009 验证接线

仓库唯一任务索引为 `test/index/phases/P06/features/P06-2/tasks/F-009.json`，Harness 选择清单只引用该索引：`verifications/F-009/test-selection.json`。索引包含本次纵向测试、知识读取/ContextBuilder 回归、Core/Host/CLI 能力和边界契约、测试阶段索引；Feature union 由 Nezha 去重执行。

当前本地已执行：

- `node scripts/run-tests.ts test/modules/planning/p06-2-f009-manifest-integration.test.ts`：2 项通过，退出码 0；日志 `verifications/F-009/runtime-logs/test-m2zpbvsw.log`；
- 同一受影响选择的 9 个测试文件：242 项通过，退出码 0；日志 `verifications/F-009/runtime-logs/test-b6fd9wdj.log`；
- `npm run typecheck`：退出码 0；日志 `verifications/F-009/runtime-logs/typecheck-f009-final.log`；
- `npm run build`：退出码 0，Core assembly/Host/CLI 构建与入口冒烟均通过；日志 `verifications/F-009/runtime-logs/build-f009.log`。

`npm run verify`、全仓历史回归和 Phase acceptance 未运行；本地没有单独运行 `scripts/verify.ts --checks-only`。
