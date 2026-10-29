# P07-1 F-007 Git 提交回执恢复

本 Task 贯通真实 commit 已发生、结果事务尚未提交的故障窗口。测试使用临时 Git/SQLite、真实 Host 子进程和受控 Runtime，不调用模型、不 push。

## 行为

- `observeGitCommit` 供启动诊断、Task/Feature 回执核对共用。必须同时匹配 expectedHead 父链、candidateTree、完整 operation 消息、author 和 committer；相同 tree 或退出码 0 都不能替代这些事实。HEAD 未前进时保留 pending intent 并返回 `not_executed`，不推断 `no_change`。
- Feature 交付可通过受信 publisher 保存原始 WorkspaceInspection。恢复通过受限 ArtifactVerifier 核对项目、制品摘要、原始 HEAD、binding、仓库、路径和代码摘要，不用当前源码制造历史验证证据。旧调用方未装配原始制品时，pending 核对保持 unknown，不能据此交付。
- 启动恢复检查原始检查制品及 passed 验证批次归属，并把核对结果存入恢复诊断 Artifact。它不补写旧 owner 的成功回执，不把 Task 标为 passed。存在 pending Git intent 时保留隔离占用、原 intent 和公共 claim，给出 `git_receipt_recovery_required`，等待显式可信处理。
- 显式 Feature 收尾通过当前 Run 的授权 seal 和 receipt CAS 补回执。seal 包含 Run/Batch/计划/审批/策略/绑定、验证结果和相关占用；在异步核对后及回执/最终业务事务内同步重核。Git operation 自身的写入不改变授权 seal，旧 operation 不能覆盖新 operation 的交付投影。
- 已有终态回执只作为历史事实；复用交付还需检查当前 Git 和授权。未知提交、事实不可读、原始验证制品缺失、未知 claim、原生锁及异步漂移均保留现场。重叠读者通过 CAS 只产生一份回执/结算事件，精确 operation claim 的释放支持重叠读者已释放的情况。

## 实测与边界

本地 Task 定向通过 22 个不同用例（7 个文件中选定用例）：

| 范围 | 本地结果 | runtime-logs 日志 |
| --- | --- | --- |
| 新增 tree 不符、HEAD 未前进 | 2 passed | `test-3p3wp_0m.log` |
| 新增读者重叠、二次落库失败/重开、HEAD/index/授权漂移、不可读事实、未知 claim/native lock | 8 passed | `test-zhv8lom5.log` |
| Task 真实 commit 后 Host SIGKILL/重启；原始制品完整/缺失 | 2 passed | `test-uti7it13.log` |
| Feature 真实 commit 进程结束后、回执事务前 Host SIGKILL；重启补回执及再次重启终态复用 | 1 passed | `test-05nvagjs.log` |
| 既有 hook 工作区/暂存修改、原始证据缺失 | 3 passed | `test-jor0o2vb.log` |
| 既有启动核对：证据缺失时已提交 unknown／HEAD 未前进 not_executed，均隔离 | 2 passed | `test-jwcdblpc.log` |
| Feature 仅收尾回执丢失正常恢复 | 1 passed | `test-d71iz587.log` |
| Feature 真实核对期间新增人工阻塞 | 1 passed | `test-x6wn1lw9.log` |
| Feature no_change、提交后取消竞争 | 2 passed | `test-c26aix5s.log`；占用 seal 扩展后的 no_change 复验 `test-lq2aju0h.log` |

日志根位于 Harness 当前 Feature 的 `verifications/F-007/runtime-logs/`，完整输出和真实退出码旁文件均保留；最初 RED、夹具调试失败及修复前的失败记录没有覆盖。测试中对子进程执行有界关闭并核验退出，临时资源由夹具清理。

Task 索引为 `test/index/phases/P07/features/P07-1/tasks/F-007.json`。其余已登记的受控提交正常/取消/回执失败、Task store fencing/回滚/投影、公共锁、派发恢复 CAS 等回归交 Nezha 独立执行，不能称为本地全部通过。P05 integration journal 未改动，不扩展到集成 journal 矩阵。

本地类型检查通过（`test-4ldwe95w.log`）；模块边界检查通过（472 个生产文件、0 诊断，`test-l_qmffbr.log`）。未运行全仓、Phase 入口、真实模型或 live。Task 结果声明不代表 Feature/Phase 验收通过。启动保留隔离是有意的保守恢复：本 Task 没有新增绕过旧 fence、强制解除人工阻塞或直接清除 claim 的用户命令。
