# P04-5 F-004 SessionRecorder 投影

`createWorkEvidenceRecorder` 可通过 `recording: { publisher, store, nowUtcMs? }` 接受 F-002 的 `WorkRecordingPublisher` 和 F-003 的 `WorkRecordingStore`。`recordingMode` 是可信 Core 装配参数，仅允许 `required`（默认）或 `best_effort`；Runtime 事件不能修改策略。未提供 recording 的旧调用方继续保留 evidence-only 路径。生产组合根的端口注入与纵向接线由 F-008 完成。

## 公开记录与持久顺序

`work-recording-projection.ts` 只依赖端口，不访问 SQLite。Recorder 并行观察事件流、result 和 stopped；逐批等待正文写入，最多接纳 min(chunkMaxEvents, 64) 条事件。事件窗口、chunk 字节、总事件数、总字节及 result/stop 尾部等待沿用既有有限预算；不存在 UI 消费依赖或第二套事件总线。

每条已接纳事件的公开 payload 先脱敏、分块发布为独立 JSON Artifact、校验 ready/完整性，再发布原始事件 chunk，最后在短事务提交索引、manifest 元数据及 Session watermark。批次不完整时不推进其索引水位，已发布正文继续留作证据。recording manifest 有独立递增版本，采集中显式 partial/recording_in_progress，最终 manifest Artifact 经严格校验和完整性核验后才关联到最终索引元数据。

- 用户/助手消息保留 provider message ID、角色、公开 preview 及可选 text；工具开始/完成保留 toolCallId、parentToolCallId、公开 input/output、事件 ID 和顺序。父子 Session 关系沿用既有存储模型，消息行不伪造工具身份。
- warning/diagnostic 映射为 error 角色；其余公开状态与 usage 作为 system 消息保留。最终结果摘要、结果是否 settled、终态序列、独立停止观察进入 manifest；Runtime settlement 继续单独发布结果事实。
- 可选 text/input/output 每字段限制 65,536 UTF-8 字节，同时仍受 Recorder 的更小事件/总量预算约束。只有 preview 的事件不会补造全文；不解析 Pi 私有档案、不声明 SDK 未公开内容或第三方工具内部审计。
- known empty terminal 可用 0 表示无事件；终态序列未知、缺口或落后于已持久水位均不能声明完整。落后的原始 final sequence 留在 evidence manifest，索引水位保持不回退。
- 预先脱敏和正文 publisher 的脱敏事实共同进入行级 redacted 与 manifest redaction 标记；配置凭据不进入正文或索引。

## 策略与独立事实

required 出现正文/磁盘/索引失败或声明范围不完整时，请求有限 cancel，尽力发布 failed manifest 并关闭索引元数据，保留已写正文和最后有效水位，抛出带 safeStopRequired 的 WorkEvidenceRecordingError。现有 supervision 负责独立停止核验、保留/隔离与结算；取消接受不代表停止确认。

best_effort 不因记录 partial 单独取消 Runtime。发布失败后，在同一事件数和尾部期限预算内丢弃后续事件，避免有界生产者等待消费者而死锁；保留显式 partial、缺口和结果。manifest 文件存储也失败时仍尽力关闭 SQLite manifest 元数据，manifestRef 保持 null，错误继续携带 best_effort 模式。监督及结算保留记录失败事实，但在 Runtime 完成且停止确认后允许进入独立 verification；不会将 recording.complete 改为 true。

result 完成与 stopped.confirmed 分别保留。停止已被观察但 confirmed=false 可以完成公开记录，却仍由 settlement 阻止安全释放/后继。缺停止证据在有限尾部超时后成为 partial/failed。Recorder 不修改 Task/Feature 的验收状态；best_effort 也不能跳过 Verification、审批或停止确认。原生恢复 handoff 元数据沿用已有 Session 更新，不覆盖索引事务生成的水位和规范缺口。

## 本地验证证据

完整 stdout/stderr、真实退出码和 sidecar 位于本 Feature workspace 的 `verifications/F-004/runtime-logs/`。首次实现证据绑定 invocation `c5d3909138924b69959baffe84fe43b0`；本次返工验证绑定 invocation `ae600a0d30d343f4a625758ad0f97c4c`。

| 范围 | 日志 | 结果 |
| --- | --- | --- |
| 首次实现的 SessionRecorder 聚焦文件 | `test-5_j_qkdx.log` | exit 0，13 passed、0 failed、0 skipped |
| 本次返工 19 文件 affected 选择 | `test-x4igh80_.log` | exit 0，19 files、323 passed、0 failed、0 skipped |
| 本次返工 Host 锁/组合定向复核 | `test-jnkmr064.log` | exit 0，25 passed、0 failed、0 skipped |
| 本次返工 usage 定向复核 | `test-vpclef_m.log` | exit 0，1 passed、13 skipped |
| 既有 WorkEvidenceRecorder + 当时新增文件 | `test-800ko4nj.log` | exit 0，46 passed（旧文件 33 + 新文件 13） |
| 既有 Runtime settlement | `test-v22449ak.log` | settlement 27/27 通过；该条组合命令因新增文件中的父工具边界尝试失败而整体 exit 1，39 passed/1 failed |
| 首次实现类型检查 | `test-5854wpj0.log` | exit 0 |
| 本次最终类型检查 | `test-k_adezti.log` | exit 0 |
| 本次 Core/Host/CLI 依赖边界 | `test-41a7mkwh.log` | exit 0，321 生产文件，0 diagnostics |

父工具边界失败说明存储要求 parentToolCallId 必须有不同的当前工具身份；已撤回消息行上的该扩展，保留既有工具父子关系且没有放宽存储约束。之后只复测受影响的新文件，13/13 通过；结算测试未为刷新日志重复执行。旧 Recorder 在后续改动中不走 projection 分支。本地三份测试文件合计覆盖 73 个不同用例，表格不把重复运行叠加计数。

13 个新增用例覆盖公开消息/工具与终态、慢正文发布背压和水位顺序、required/best_effort 写失败、best_effort 有界 producer drain、序列缺口、结果完成但停止未确认、停止尾部超时、best_effort supervision 不单独取消/隔离、磁盘无法生成 manifest、终态落后水位、空事件流，以及正文/行级脱敏。初始缺少索引实现的 RED `test-jkah4qbn.log`、夹具修正与中间失败均保留。

任务 v2 索引 `test/index/phases/P04/features/P04-5/tasks/F-004.json` 与 Harness selection 内容一致，共登记 19 份文件。本次返工已用同一受影响选择实际运行 19 份文件并通过；首次实现阶段的局部日志仍保留用于区分证据。本轮未运行全仓测试、组合门禁、阶段验收或 live 模型。F-005 负责恢复/重复补录等进一步完整度处理，F-006/F-007 负责查询与展示，F-008 负责生产装配与跨层闭环。本地通过不代替独立验收。
