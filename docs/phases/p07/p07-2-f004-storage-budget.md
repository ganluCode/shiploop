# P07-2 / F-004 一次记录的累计磁盘额度与失败收尾

为一次记录（一次 `WorkEvidenceRecorder.record()`）的全部落盘内容建立单一累计磁盘额度，并在磁盘写入失败时保留可信前缀、缺口与有限收尾回退。来源：`input/p07-recorder-bounds.md` FR-1/FR-2、验收 2；core-design/05 §5/§6。没有修改数据库迁移、历史索引或其他 Task 状态。

## 计量范围与账本

新增 `application/work-recording-budget.ts`（纯内存、无 I/O）。一次记录内的事件分块 ndjson、公开消息/工具正文、附件与覆盖 Manifest 共享同一账本：

- `limitBytes = recorder.maxTotalBytes`。P07-2 / F-004 起 `maxTotalBytes` 的语义从"仅事件分块累计"升级为"本次记录全部落盘内容的累计磁盘额度"；同一事件的重复存储（消息正文与事件分块各写一份）按各自写入分别计量。
- 收尾保留额度 `reserve = min(chunkMaxBytes, floor(maxTotalBytes/4))`：正文累计申请不得超过 `limitBytes − reserve`，使成功/失败覆盖 Manifest 始终有有限额度可用；收尾申请可使用全部剩余。reserve 有限且由既有限制推导，不新增配置旋钮；Manifest 超出剩余额度时不夸大保证，按额度不足走 SQLite 元数据回退。
- 写入前申请：事件行/清单用 `claimExact`（全有或全无，NDJSON 行不可切分）；公开正文/附件在发布器内按块 `claim`（部分授予即写入可用前缀并标记 `session_storage_quota`）。申请是同步原子扣减，并发发布竞争同一额度不超售。
- 写入中/后结算：ready 制品以实测 `sizeBytes` 结算为 `writtenBytes`；失败、短写与 staging 残留的申请结算为 `failedWriteBytes`；实测超过申请时记 `oversoldBytes` 并继续扣减。申请一律不退还：失败重试、重新分块或原生补充都重新申请，不重新获得额度。
- 账目 `claimed = written + failed + inFlight` 恒成立；清单诊断固定携带 `storage_budget:limit=…,reserve=…,claimed=…,written=…,failed=…,oversold=…` 一行，`WorkEvidenceRecordingOutcome.storageBudget` / `WorkEvidenceRecordingError.storageBudget` 同步暴露，供测试与磁盘实测核对。

单次 `publishBody` 的局部 `maxTotalBytes` 仍只约束单条消息正文+附件；会话级额度与局部上限同时生效，互不替代。

## 停止与失败语义

- 事件行无法全额申请 → 既有受控停止 `total_bytes_limit_exceeded`（存储额度原因）；required 模式不得成为完整成功，已完整落盘批次保留、水位不回退。
- 公开正文/附件额度不足 → 发布器返回 `truncated`/`unavailable` 并标记 `session_storage_quota`；投影拒绝接纳未完整批次，消息索引与水位不推进，已 ready 正文保留为前缀证据。
- 成功清单无法在收尾额度内发布 → `manifest_storage_exhausted`；失败清单优先在收尾额度内发布，发布失败或额度不足 → `evidence_unrecoverable`，转由既有 SQLite 元数据保存缺口、最后可信水位与空 `manifestRef`（coverage=failed，不伪造引用）。
- SQLite 元数据也无法写入 → 新增 `evidence_metadata_unpersisted` 缺口随 `WorkEvidenceRecordingError` 传播给监督层（`safeStopRequired` 继续阻止后继），不伪造 complete/成功。
- 磁盘故障分类沿用 F-001：注入 ENOSPC → `event_storage_exhausted` / `manifest_storage_exhausted`；写入/同步关闭/发布边界、短写（size_mismatch）→ `event_file_write_failed`。失败制品与 staging 残留保留，重复故障处理产生的失败文件与诊断有界（额度耗尽即停止新增写入，诊断 ≤32 条）。

## 边界（不夸大）

额度只约束记录器管理的写入：不扫描/清理全盘，不删除历史会话，不是 OS 磁盘配额，也不限制授权工具对工作区/仓库的写入。保留收尾额度不能保证物理磁盘彻底不可写时 Manifest 一定可生成；磁盘失败测试一律使用受控端口注入（ENOSPC/权限/短写），不耗尽宿主磁盘，证据如实区分注入故障与真实系统磁盘耗尽。全项目保留/归档属于后续 P07-3。

## 验收映射与本地结果

新增 `test/modules/runtime/p07-2-f004-storage-budget.test.ts`（19 项），更新 `p07-2-f001-recorder-bounds.test.ts` 的字节边界用例以新额度语义：

| 验收点 | 证据（均读取真实临时目录文件与 SQLite 索引核对，不只断言内存计数） |
| --- | --- |
| 账本申请/结算/失败不退还/超售防御/收尾保留 | `budget-claim-settle`、`budget-streaming-partial-grant`、`budget-concurrent-no-oversell`、`budget-oversold-guard`、`budget-reserve-derivation` |
| 多消息共享会话额度、局部上限独立、失败不退还 | `publisher-shared-quota`、`publisher-failed-write-no-refund` |
| 分块+正文+Manifest 共享额度且与磁盘实测一致 | `cumulative-disk-scope`（ready 文件字节/hash 与索引、水位、清单账目行逐项核对） |
| 精确达界正常提交；下一字节标存储额度原因 | `exact-body-cap`（正文池精确贴界 complete；少 1 字节 → `session_storage_quota` + required 不完整成功） |
| 额度不足停止新增正文、未完整批次不推进水位 | `quota-stop-mid-recording` |
| 打开 ENOSPC / 写入错误 / 同步关闭权限 / 发布边界 / 短写注入 | `fault-open-enospc`、`fault-write-error`、`fault-finish-permission`、`fault-publish-error`、`fault-short-write`（ready 前缀保留、消息索引为空、水位不动、失败清单新制品不覆盖现有文件） |
| 重复故障有界 | `repeated-faults-bounded`（失败制品/打开次数 ≤3，`evidence_unrecoverable` + SQLite 空 manifestRef 回退） |
| Manifest 无法落盘 → SQLite 缺口/水位/空 manifestRef | `manifest-budget-sqlite-fallback` |
| 数据库也无法写入 → 监督层传播证据未持久化 | `metadata-also-unpersisted` |
| 收尾保留额度保护失败清单 | `reserve-protects-closeout` |

本地定向运行（真实临时 Git/SQLite/文件链，Fake/脚本化 Runtime，无真实模型）：

- F-004 新增 + F-001/F-004 更新 + 记录链局部回归 6 文件 **97 项通过**；相邻回归 3 文件 **26 项通过**（`p07-2-f002-runner-bounds`、`p04-5-work-recording-store`、`p04-8-recovery-recording-fault-matrix`）。
- TypeScript 类型检查通过；模块边界检查通过（475 个生产源码文件、0 诊断）。

日志与退出码在 Harness 当前 Feature 的 `verifications/F-004/runtime-logs/`。测试索引：`test/index/phases/P07/features/P07-2/tasks/F-004.json`；未在本地运行的更广回归（Artifact 发布/文件/核验、执行装配、恢复记录等 13 个文件）已列入索引，交由 Nezha 独立复验。
