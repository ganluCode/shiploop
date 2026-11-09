# P07-5 F-003：Verifier 崩溃与显式恢复

本 Task 使用真实临时 Git、SQLite、loopback Host、受监督检查进程和默认 CLI；FakeRuntime 只替代模型。阶段场景位于 `test/modules/acceptance/p07-5-f003-verifier-crash.test.ts`。不代表 P07 阶段或 live 验收通过。

## 场景与可核对事实

| case | 观察与断言 |
| --- | --- |
| `p07-stage-verifier-wait-quarantine` | 真实 Verifier 已启动、批次 running 时 SIGKILL Host；重启保留 interrupted Attempt、quarantined 工作区及不完整检查证据；CLI resume 非零拒绝；依赖无 Attempt。 |
| `p07-stage-resume-prefix-budget` | 公开命令建立三 Task 链；第一 Task 通过，第二 Task 的完整验证批次提交前崩溃。停止/录制/代码核对后才 retained/paused；重叠 resume 至多一次成功，同 commandId 重放，摘要不同 conflict。新 Attempt 使用原工作区，tracked/untracked 字节、passed 前缀、原 deadline/预算副本保持；计数恰好增加一次。新验证零测试导致 inconclusive，第三 Task 仍未启动。 |
| `p07-stage-unrelated-writer` | 在可信进程启动登记点注入另一个真实写入进程的 PID 与不匹配 startTime，未直接改业务表。重启不误杀该进程，其 heartbeat 在恢复观察后继续增长；stopConfirmed=false，拒绝接管。 |
| `p07-stage-workspace-drift-branch` | 崩溃后外部改变 worktree 分支；恢复隔离、不 reset/删文件、不增加认领或启动。 |
| `p07-stage-workspace-drift-binding` | 崩溃后复制并替换 Git common directory；同路径、同字节而 inode 身份不同，旧 binding 不获接管资格。 |
| `p07-stage-cancel-completion-race` | 完整批次收尾在屏障等待；公开 cancel 的状态事务落盘后释放完成路径，完成不能制造 Task passed、Git 提交或依赖解锁。 |

旧 Attempt、旧 owner、旧 hostInstanceId 和旧 executionVersion 的迟到结果均经真实生命周期存储围栏核对，不能覆盖当前 Task 状态。停止 census 缺失/异常、跨进程槽位竞争、公共 Git 锁的新旧身份互斥、恢复发布后漂移、显式 CLI 正向恢复、输出损坏等基础回归登记在 Task 索引，交 Nezha 独立验证。

## 实测发现与增量修复

1. 多 Task 复用工作区时，`managed_workspaces` 保存的是不可变的首次准备身份。原启动恢复和恢复结算把它当成当前写入者，导致第二 Task 被错误隔离。新增适配器内部 `workspace-writer.ts`，按有序 workspace 操作日志核对当前 Run/Attempt/owner/Host/version；无日志的旧数据保留原身份兼容。恢复事务仍检查当前 writer 和原工作区 revision/身份，不改历史准备身份、迁移或回执。
2. 正常工具事件会产生中间录制投影。恢复仅允许完整发布的最终清单覆盖纯 `recording_in_progress`/`terminal_watermark_unknown` 中间进度；历史 unknown/truncation、缺失最终清单、身份/哈希错误继续阻塞。公开最终清单引用的事件块和 Session 结算制品均实际核验；NDJSON 逐行解析。未被这些受信引用覆盖的 Session 制品继续报 unindexed，不能按目录名视为可信。

录制聚焦回归位于 `test/modules/recovery/p07-5-f003-recording-prefix.test.ts`，覆盖最终清单替代中间进度、最终缺失、历史缺口不得擦除和未知制品拒绝。真实阶段场景另核对默认 Recorder 发布的清单、块、结算及工作区文件。

## 验证与证据

开发期基准 HEAD 为 `53b54bb92a764611be3ce15dd10cea93f3b7d113`；以下测试执行于该提交加本 Task 的未提交改动，`sourceDirty=true`，不是干净提交的 Phase 验收。

日志均保存于 Harness Feature 的 `verifications/F-003/runtime-logs/`，包含完整输出、退出码和执行 JSON：

- 最终阶段六场景：`test-gkt20cq3.log`，6 passed，213309ms，exit 0。
- 录制聚焦与原 P07-2 恢复回归：`test-wmb7bh6e.log`，7 passed，exit 0。
- 受影响原夹具的公开建链、验证边界、提交边界：`test-39n6e60r.log`，3 passed、8 未选，exit 0。
- 索引/验收契约：`test-01kzj041.log`，10 passed，exit 0。
- 类型：`test-spje1a68.log`，exit 0；分层边界：`test-ngypzr01.log`，536 生产文件、0 诊断，exit 0。

本地最终选中行为合计 26 项通过；其余登记文件不宣称本地通过。较广范围只有仓库 Task 索引一份定义，Harness selection 引用 `test/index/phases/P07/features/P07-5/tasks/F-003.json`（18 文件，部分按稳定 case 选择）。原 RED/调试失败日志全部保留。

运行时设置 `SHIPLOOP_P07_EVIDENCE_DIR` 可导出跨清理保留的事实；本次已导出到上述验证目录下的 `evidence/`。文件名绑定 scenario、Run ID 与观察序号，包含业务状态、预算副本/deadline、原生进程登记与 OS 观测、Git、制品摘要；临时根以 `<fixture>` 代替。清理必须确认自有进程已停止，不清理用户仓库。证据文件的基准 commit 不冒充已提交修复的受测身份。

未运行全仓、组合 verify、Phase 入口、真实模型或 live；不修改正式 Task/Feature 状态，不合并或推送。Task completion claim 由 CLI 提交，最终通过仍取决于 Nezha 独立验证。
