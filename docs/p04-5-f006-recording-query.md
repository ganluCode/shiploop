# F-006 Work 公开记录查询交接

Core 查询已接入现有 `createQueryService`、`WorkSessionQueryReadStore` 和 SQLite composite query store。Host/CLI 暴露由后续任务接入；本任务没有新增 HTTP 路由或执行操作。

## 接口

- `listWorkRecording(principal, { projectId, runId | attemptId | sessionId, recordType, limit?, cursor? })`：恰好指定一个父级；`recordType` 为 `messages` 或 `manifests`。默认 limit=50，最大 200。消息类型包括公开消息、工具开始/结束、错误和最终结果。
- `readWorkRecordingBody(principal, { projectId, sessionId | attemptId, artifactId })`：恰好指定 Session 或 Attempt，返回受控 `artifact` 引用及 `Uint8Array content`。沿用 ArtifactVerifier 的 8 MiB 正文上限。
- 操作身份为 `execution.recording.list`、`execution.recording.body.get`。返回类型及常量从 Core index/protocol 导出。

两者都在任何数据库读取前检查可信 principal、`project.read` 和项目可见性。列表游标绑定数据根、项目、父级种类/ID、记录种类，沿用现有受控分页编码。消息按 `(sequence,id)`、manifest 按 `(version,id)` 排序；SQL 只取 limit+1，每页及其 manifest 元数据在同一 SQLite 一致读事务内读取。跨页不承诺冻结整个运行的历史快照。

Run/Attempt 汇总其 Work 根 Session 与 Work 子 Session。Session 查询只返回该 Session 的记录；Attempt 正文查询可读取其 Work 后代记录。Chat 边、Chat 用途及声明另一 Attempt 的子 Session 均不能继承成员资格。持久记录的 invocation、executionVersion、Run、Attempt 须与真实 Work 根匹配，否则 corrupt_state。

公开引用仅含 artifactId/contentHash/sizeBytes；不返回 locator、SDK nativeRef、providerMessageId、sourceRefs 或自由诊断文本。工具调用身份对 `[sessionId, toolId]` 做 SHA256 映射，保留同 Session 内父子相等关系。诊断、缺口、截断和脱敏原因只保留已知公开码；参数化原因映射为固定类别，未知内容为 `recording_detail_redacted`。缺 manifest 的消息显式返回 partial/recording_manifest_missing。

正文必须属于持久消息、附件或 manifest 的精确引用。拥有相同目录前缀不足以授权。核验同项目 ready Artifact 的 locator/hash/size 与索引一致后，使用现有只读 ArtifactVerifier 检查真实文件；查询不修复、不发布、不调用 Runtime/SDK、不写事件或业务表。

拒绝不存在、非成员、外项目或非 ready Artifact 时返回 not_found。已索引正文的异常为 corrupt_state，并区分 `recording_body_missing`、`recording_body_corrupt`、`recording_body_size_limit`、`recording_reference_mismatch`；错误不暴露文件路径。

## 验证证据

日志根为 Feature workspace `verifications/F-006/runtime-logs/`，完整输出、真实退出码 sidecar 和中间失败均保留。

- 首次 RED：`test-49m8s6ft.log`，exit 1，唯一失败为 `q.listWorkRecording is not a function`，真实 SQLite/Session/Artifact 夹具成功。
- 最终聚焦：`test-7308al4c.log`，exit 0，新增文件 12 passed / 0 failed / 0 skipped。涵盖父级分页、工具/错误/最终结果、manifest 版本、游标绑定、非法 limit、授权、字段脱敏、精确附件/清单成员资格、正文缺失/损坏/超限、子 Session/Chat 隔离、损坏身份、缺清单及全库快照/重开一致性。
- 两项中间损坏夹具失败由现有不可变触发器阻止写入导致（`test-ezkrhior.log`）；夹具现在仅在构造损坏数据时绕过相应守卫，查询前恢复真实触发器。产品守卫未修改。
- 最终 typecheck：`test-yvwp6fjs.log`，exit 0。
- 架构边界：`test-kete9ed3.log`，exit 0，323 production source files / 0 diagnostics。

仓库索引 `test/index/phases/P04/features/P04-5/tasks/F-006.json` 登记 8 个文件；Harness selection 只引用该索引。除新增查询测试外，另外 7 个既有回归仅选择，交 Nezha 独立执行；本地未运行全仓测试、组合门禁、Feature/Phase 验收或真实模型。任务完成声明及独立验收以 Nezha 回执为准。
