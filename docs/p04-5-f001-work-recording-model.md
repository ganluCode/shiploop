# P04-5 F-001 Work recording 持久模型

F-001 增加公开记录的端口模型和 SQLite v32 迁移。消息、工具参数/结果、附件正文继续保存在 ready Artifact；Core 只保存身份、序列、来源、完整度和正文引用。本任务交付持久模型，不代表 Recorder 写入队列、Runtime 归一化或查询服务已经接入。

## 模型与范围

`packages/core/src/ports/work-recording.ts` 导出 `WorkRecordingMessageRecord` / `SessionMessageRecord`、`WorkRecordingManifestRecord` / `RecordingManifestRecord` 及严格校验器。两种记录都关联 project、session、run、attempt、invocation 和 executionVersion；providerMessageId、toolCallId、parentToolCallId 只表达公开来源和工具关系，不充当 Core 启动或命令幂等身份。

`session_messages` 的正文引用和附件引用携带 Artifact ID、SHA-256、字节数和受控逻辑 locator。`recording_manifests` 以版本追加完整度观察；可选 manifest Artifact 引用对应四列 `manifest_ref`、`manifest_hash`、`manifest_size_bytes`、`manifest_locator`，必须整体为空或整体有值。locator 不是文件系统授权，不应直接进入对外查询投影。

公开覆盖范围限定为 `public_events`、`public_messages`、`public_tools`、`attachments`、`final_result`、`minimal_diagnostics`。每个 manifest 明确排除 `hidden_reasoning`、`native_private_storage`、`unified_audit`，且 covers 与 excludes 不得重叠。`state_events` 继续保存统一审计/状态事实；新的公开记录索引不会写入或替换它。

来源保留 `live`、`native`、`recovered`、`mixed`。`native` 代表可导入的公开材料，不授予 SDK 私有表结构业务含义。`nativeRef` 复用 `WorkSessionNativeRef` 的版本/存储格式描述，不保存原生路径或 SDK 私有正文。

## 有界索引和身份核对

- sequence、版本、水位、时间和字节数必须是相应范围内的 JavaScript 安全整数；正文通过 Artifact 引用校验，拒绝正文/SDK 对象等未知字段。
- sourceRefs 最多 16 项；attachments、missingReasons、diagnostics 和完整度原因各最多 32 项。普通描述最多 256 码点，附件名最多 200，mediaType 最多 128，locator 最多 1024；附件元数据整体最多 65,536 UTF-8 字节。SQLite 还限制各 JSON 列的编码字节数。
- `assertWorkRecordingIdentity` 在形状校验后核对由已授权 WorkSession/Attempt 装配的身份。调用方仍须使用既有 principal 授权和执行 fencing；不得以待写记录自身构造 expected identity。
- 迁移通过同项目复合外键和 scope trigger 核对 Session、Attempt 的双向绑定及 run/version/invocation。没有独立 Attempt 的 Work 子 Session 沿同项目 Work 父链解析；有独立 Attempt 的子 Session 使用自身绑定，不能借父链绕过。
- message 行与 manifest 版本不可 UPDATE；manifest 必须追加更高版本，已知 watermark 不得退回或变回 unknown。消息按 Session/sequence、Session/messageKey、Project/eventId 去重，查询索引支持按项目、Session、sequence/version 有界读取。
- 消息正文、附件和 manifest 的引用必须属于同项目 ready Artifact，hash/size/locator 一致。附件引用保存在有界 JSON 中，由 trigger 补齐删除保护；索引引用后的 Artifact 身份不可变更。

## 完整度语义

SDK version、unknownEventCount、watermark、finalSequence 未知时保持 `null`。`partial` 和 `failed` 必须给出缺失原因；`complete` 不得带缺失原因、未知事件或截断。redaction 与 truncation 分别保留 applied 和原因，不能相互替代。

`sequenceReconciliation=match` 需要已知且相等的 watermark/finalSequence。finalized complete 必须核齐终态；SQLite 拒绝指向尚未持久化序列的 watermark，并拒绝在存在序列缺口时声明 complete。存在缺口仍可保存 partial manifest 和明确原因。watermark=0 表示尚无记录，区别于 unknown。记录 finalized 与 Runtime stopped 是独立事实，新表不会推进 Task/Attempt 业务状态或释放资源。

## 迁移与验证证据

v32 只新增两张表、索引和约束 trigger，v1–v31 SQL/checksum 未改变。JSON guard SQL 的生成使用冻结的 v32 字面量，不依赖未来可变的端口常量。测试覆盖空库、v20、v31 升级、旧 Session/Artifact/state_events 保留、迁移失败回滚和关闭重开后的幂等执行。

测试范围登记在 `test/index/phases/P04/features/P04-5/tasks/F-001.json`，Harness selection 引用该索引。完整 stdout/stderr 和退出码位于本 Feature workspace 的 `verifications/F-001/runtime-logs/`：

| 本地验证 | 证据 | 结果 |
| --- | --- | --- |
| 新端口、真实 SQLite、schema/migration 对齐，三个文件 | `test-hjx4mj1v.log` 及 JSON sidecar | exit 0；123 passed |
| 受影响的旧 Session migration 断言，`-t 'migration v20\|upgrades v'` | `test-5ubwhrmj.log` 及 JSON sidecar | exit 0；5 passed，16 未选执行 |
| Artifact trigger 优化后的 SQLite 复核（包含索引后继续发布制品） | `test-v6756xnm.log` 及 JSON sidecar | exit 0；11 passed |
| 最终 TypeScript | `test-n735a0kd.log` 及 JSON sidecar | exit 0 |
| 依赖边界 | `test-63az2rjt.log` 及 JSON sidecar | exit 0；317 个生产文件，0 diagnostics |

前次中断保存的安装和类型检查日志已按原字节复制为 `recovered-*.log`，保留早期失败与成功证据；没有重复安装依赖。新增 SQLite 测试首轮的资源占用夹具失败和测试类型错误保留在 `test-u82nstq5.log` / `test-bg0wxken.log`，后续修复已由上述通过日志覆盖。

索引中的 ownership matrix、旧 WorkEvidence、旧 Session query 和未选执行的 Session store 回归交由 Nezha 独立验证。本地未运行全仓测试、阶段验收或真实模型。

## 第二次执行：独立验收失败修复

上轮完成报告仅记录了完成声明。随后 Nezha 按七文件索引执行 215 个用例，结果为 214 passed / 1 failed，审计目录为 Feature workspace 的 `verifications/F-001/6755fc9ab6764ba28e8f422beed8db48/`，`human_blocked=false`。失败位于旧 Session 测试的 v20 DDL 回滚后重试升级断言：仍期望版本 31，而实际迁移已到 v32。

本轮只将该断言改为现有的 `LATEST_VERSION`，保留故障注入、DDL/迁移记录回滚与升级成功检查。上次定向筛选没有选中这个用例，不能以其通过结果推断整个 Session 测试文件通过。

本轮按原策略只定向执行该已知失败用例，`test-z7pygwaa.log` 和 JSON sidecar 记录 exit 0、1 passed、20 未选执行，绑定本轮继承的 invocation `ed19afd825ff40b095f43e107506815c`。七文件索引保持完整并再次核对，交 Nezha 独立重验；本地通过不替代独立验收。
