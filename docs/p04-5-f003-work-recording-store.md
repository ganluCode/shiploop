# P04-5 F-003 recording 短事务存储

`WorkRecordingStore` 提供同步 `commitRecording` 和有界 `getLatestManifest` 端口；SQLite adapter 由装配层持有连接，application/Runner 只依赖端口。沿用 F-001 的 v32 表和不可变 manifest 版本，没有修改历史迁移。F-002 的正文发布在提交端口之前完成。

## 提交流程

- 事务外严格校验有界记录和批次（最多 64 条），核对每条记录/manifest 与可信 Core identity；SDK 事件身份不替代 Attempt/commandId。
- 通过 `SqliteStorageSession.transactWrite` 的短写事务核对项目、Work Session 父链、双向 Attempt 绑定、run、invocation、executionVersion、Task 当前代次、owner 和 host。独立绑定 Attempt 的子 Session 不能借父链绕过。拒绝 Chat、错误用途、stopped Session 和终态 Attempt。
- 按 Project/eventId、Session/messageKey、Session/sequence、记录 ID，以及 Session/toolCallId/工具阶段查重。语义摘要包含正文和附件 hash/size、角色、事件身份和父子工具关系；忽略传输时间、观察来源、行 ID 与相同正文的发布 ID/locator。相同摘要只接纳一次，原索引不可覆盖。
- 内容冲突返回 `conflict`、`inserted=0`，整批不接纳新消息；追加一个 `partial` manifest，以有界 `stable_identity_content_conflict` 诊断和 missing reason 保留冲突事实。原记录、原 manifest Artifact 和原水位保持可查；诊断 manifest 不伪装成原 Artifact 的内容。
- 新消息正文、附件及 manifest 引用均核对同项目 ready Artifact 的 expected hash、content hash、size 和 locator。实际正文流/hash 计算由 Artifact 发布流程完成；短事务只核对持久元数据，不重新读取正文文件。
- Session revision 与最新 manifest revision 同时 CAS。首次 expectedManifestRevision 为 0，提交的 version/revision 均为期望值 + 1。精确成功请求重试可以跨过旧 CAS 返回 `duplicate` 和最新 manifest，不再增加 Session revision。
- 原子提交消息索引及工具父子字段、manifest、Session 缺口、水位及 revision。已知水位不得回退/变 unknown；水位必须指向已持久记录，序列缺口要求显式 `sequence_gap` 且不能声明 complete。SQLite 触发器继续提供约束兜底。

调用方遇到 CAS 冲突应重读 Session revision/最新 manifest 后重建批次。`inserted` 仅表示新接纳索引数，不执行 Attempt 结算或预算扣减。调用方负责 principal 授权；该端口不承诺 Runtime 库与 Core 库之间的 exactly-once。

## 验证与交接

全部测试由规定的 `nezha.dag.test_command` 保存完整输出和真实退出码，绑定继承的 invocation。Feature workspace 下 `verifications/F-003/runtime-logs/` 的关键证据：

| 验证 | 日志 | 结果 |
| --- | --- | --- |
| 初始 RED：adapter 尚不存在 | `test-bx5b8_qk.log` | exit 1，缺少目标实现 |
| 最终新增存储端口测试 | `test-v__c2gdq.log` | exit 0，10 passed |
| 既有 recording SQLite 持久模型约束 | `test-mzc1kn5b.log` | exit 0，11 passed |
| 最终 TypeScript | `test-zcc2w_21.log` | exit 0 |
| Core/Host/CLI 依赖边界 | `test-uovuk6dn.log` | exit 0，320 文件，0 diagnostics |

新增测试覆盖成功重放、恢复来源变化、旧请求在新 manifest 之后重试、冲突保留证据、身份/用途/代次 fencing、ready/hash/size/locator/跨项目 Artifact、两个独立连接的旧 CAS 竞争及关闭重开、最终 Session UPDATE 故障回滚、子 Session/终态 Attempt、工具身份/父子关系、有界批次与缺口。对 tasks、attempts、runs、execution_batches、state_events 的提交前后快照确认无业务结算副作用。

仓库 v2 索引为 `test/index/phases/P04/features/P04-5/tasks/F-003.json`，与 Harness selection 内容一致。额外登记的 Runtime 模型、旧 WorkSession、WorkEvidence、通用 CAS 和 ownership matrix 回归未在本地执行，交 Nezha 独立验证。本地没有运行全仓测试或阶段验收。
