# P07-2 / F-003 制品发布等待与收尾

`ArtifactPublisher` 在既有 pending → staging → fsync/关闭 → 实测字节/hash 核验 → 不覆盖发布 → CAS ready 协议内增加期限和停止证据。没有修改数据库迁移、历史索引、恢复验收规则或其他 Task 状态。

## 控制与失败语义

- `limits.timeoutMs` 现在覆盖打开 staging、生产者 `next()`、写入回调/`drain`、`finishStaging`、摘要核验及正式发布。内部计时器和外部 AbortSignal 在等待开始前装配；调用前、结果返回后及 ready CAS 前重核资格。预算必须是安全整数，时间不得超过 Node 定时器的 `2^31-1` 毫秒范围。
- 每次发布使用独立 AbortController。超时、取消或发布失败撤销旧操作；生产者的迟到块、旧文件操作的返回值不会再进入 ready CAS，也不会形成正文引用、记录索引或水位。失败索引与 staging/正式残留保留。失败索引无法保存时继续返回 `failed_unrecorded`，不能声称持久失败已写入。
- 清理同时请求生产者 `return()` 和文件端口 `abortStaging()`，观察尚未结算的 next/finish/publish。清理预算为 `max(10, min(250, timeoutMs))` 毫秒；停止或句柄关闭未确认时，`ArtifactPublishError.cleanupStatus` 和 details 返回 `cleanup_unconfirmed`，并携带 artifact 身份、受控相对位置和 pendingOperations。原始 stage/code/cause 保留。
- `WorkRecordingPublisher` 同时保留原始缺口（如 `publication_timeout`）和 `cleanup_unconfirmed`。Projection 仍要求所有正文均成功后才能接纳批次；失败批次不推进消息索引和水位。
- `ArtifactFileStore` 的 open/finish/publish 接收可选 signal/deadline。新 `abortStaging` 只关闭其拥有的流并保留文件；旧适配器缺少该能力时不能据等待结束声称已停。真实适配器用 WeakMap 绑定句柄、复用 finish 结果，由 WriteStream 的异步 flush 和 autoClose 管理 fd；不在活动写入外部手动 close 数字 fd，避免重复清理关闭已复用的描述符。

## 能力边界

JavaScript 无法抢占正在执行的同步系统调用。默认文件适配器的路径检查、hard link 和正式文件/目录 fsync 仍有同步边界：调用前后检查 deadline，超时后拒绝继续发布或 ready；已形成的文件保留为残留。测试通过受控时钟模拟“系统调用返回时已超期”，不宣称在内核 I/O 永久卡住时能够按时终止整个线程。

登记 pending 与 ready CAS 继续使用 SQLite 的短事务和既有 busy 预算。文件/生产者等待均在写事务外；不对不可中止的 ready 事务使用只返回的 Promise.race。正式发布完成但 ready 存储提交失败继续保留 `kept_pending`，沿用已有恢复核验。

## 验收映射与本地结果

新增 `test/modules/storage/artifacts/p07-2-f003-artifact-deadline.test.ts`：24 项全部通过。真实临时 SQLite/staging/正式文件及可信端口屏障覆盖：

| 场景 | 证据 |
| --- | --- |
| next、write 回调、drain、finish、publish 各自超时/外部取消/正常放行 | 15 项矩阵；时间矩阵使用受控时钟，文件与 SQLite 保持真实 |
| 忽略取消的旧发布端在返回超时后才发布文件 | `uninterruptible-late-publish`；只留残留，failed 不能被 ArtifactVerifier 恢复 ready |
| 同步 finish/publish 返回时超期 | `sync-finish-overrun`、`sync-publish-overrun`；无 ready 引用 |
| 打开文件后才检测到超期 | `opened-handle-deadline`；关闭已取得句柄、保留 staging |
| 文件错误与清理未确认并存、异步写入报错 | `file-error-cleanup-unconfirmed`、`write-error-before-drain`；原始 cause/ENOSPC 不丢失 |
| 真实文件端口取消、重复清理和 fd 复用 | `direct-file-finish-cancel`；原句柄关闭，不误关哨兵 fd，监听器清理 |
| 正文超时后迟到文件的记录投影 | `projection-no-late-watermark`；真实 session_messages/recording_manifests/sessions 与原快照一致 |
| 定时器与字节计量有效范围 | `timer-range-validation` |

本地最终定向运行：新增文件、`artifact-publish.test.ts`、`artifact-file-store.test.ts`、`p04-5-work-recording-publisher.test.ts`，共 **4 文件、65 项通过**；包括既有 hash/size 不符、不覆盖发布、取消残留、错误保留及 commit busy 恢复。类型检查通过；模块边界检查通过（474 个生产文件、0 诊断）。

完整日志及退出码在 Harness 当前 Feature 的 `verifications/F-003/runtime-logs/`：

- 最终测试：`test-8v7tdlao.log`（exit_code=0）。
- 最终类型检查：`test-_xpn888z.log`（exit_code=0）。
- 最终边界检查：`test-lm7q3lpn.log`（exit_code=0）。
- 初始发布取消传播 RED：`test-w8fxqdow.log`。
- 清理缺口传播 RED：`test-k8pgj2a4.log`。

Task v2 索引：`test/index/phases/P07/features/P07-2/tasks/F-003.json`。登记 14 文件且路径全部核验；除上述 4 个本地文件外，其余 ArtifactVerifier/SQLite 索引、Recorder/恢复、输入制品、文档制品及 baseline 证据回归交 Nezha 独立执行，**本地未运行**。没有运行全仓、Feature/Phase 门禁、真实模型或进程接管，不以本地结果声明 Feature/Phase 验收通过。
