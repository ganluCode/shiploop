# P08-2 F-006 Todo live 结构化报告与证据聚合

`scripts/acceptance/p08-todo-live-report.ts` 把一次 Todo live 演示聚合成可独立复验的结构化证据报告（`shiploop.todo.live-evidence`，schemaVersion 1）：

- **身份绑定**：需求版本与 sha256 摘要（`todoLiveRequirementsIdentity` 从冻结契约读取）、Project/Feature/Run 身份、每个 Task 的 Attempt、最终代码 commit/tree，以及源 F-004 交付报告的 `reportDigest`。聚合入口 `aggregateTodoLiveEvidence` 先复用 `validateTodoLiveReport` 校验交付报告，身份与 Task 结果只能从该报告绑定，不接受调用方另行声明。
- **状态语义**：检查条目由 `normalizeTodoLiveCheckOutcome` 规范——退出码 0 但缺受控制品记 `inconclusive`（不能靠空输出掩盖未执行的检查），非 0 记 `failed`，退出码不可得记 `inconclusive`。整体状态按内容重新推导：检查/交付失败 > 证据缺失（代码、Task 提交/验证、检查制品）> 未运行（`not_run`）> 人工待确认 > 全部通过。`not_run` 与人工待确认永不折算为 `passed`。
- **敏感边界**：报告不含凭据键、真实密钥值或开发机绝对路径；`validateTodoLiveEvidenceReport` 的敏感扫描优先于语义校验，可用 `forbiddenValues` 注入本次真实密钥复核。大输出不内嵌，制品以报告根内相对引用 + sha256 摘要 + 字节数登记（`todoLiveArtifactFromContent`），提供 `artifactRoot` 时逐个复验内容完整性。
- **未运行路径**：`aggregateTodoLiveNotRunEvidence` 记录缺授权/未装配的整体 `not_run` 报告，人工待确认项照常保留。`accept:p08:live` 入口未获授权时经 `todoLiveNotRunEntryReport` 输出该结构化报告并以退出码 2 结束；需求契约不可读时退回紧凑 `not_run` 输出，不伪造报告。

`saveTodoLiveEvidenceReport` 保存前完整校验，文件以 0600 独占创建。本模块不打开 SQLite、不调用模型、不执行 Git 命令；报告完整性不代替真实 Git/SQLite/Host/进程集成证据，跨层报告与真实资源一致性由 Phase 集成验收负责，未运行项保持 `not_run`。
