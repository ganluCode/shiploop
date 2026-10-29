# P07-1 / F-006 Verifier 恢复交接

F-006 补齐 Task Verifier 的持久进程身份、迟到结果围栏和输出证据核验。沿用已有 Node 检查执行器、VerificationBatch/CheckResult、启动恢复、Task 收尾及 Host 显式继续命令。

## 行为与边界

- 迁移 v54 追加 `verification_processes`，以 `(batch_id, check_key)` 唯一登记监督进程的 launchId、PID、进程组和启动时间，更新/删除身份被拒绝。登记事务先于工作负载确认，历史 v1–v53 SQL 保持原样。
- 重启恢复和占用释放均读取登记过的 Task 检查进程，复用原有 PID 出生身份、进程组与后代停止核验。单个进程停止未知时仍核验其余已登记进程；没有全部确认不释放占用。进程清单有上限，溢出/损坏失败关闭。
- 保存 CheckResult、定版 VerificationBatch 在写事务中重新比对 Attempt/Task 执行版本及项目、Feature、Run、Task 归属。恢复撤销旧版本后，旧 Verifier 不能继续写入或定版。`passed` 必须具有同一批次全部选中检查和必需检查的通过结果，不能借用另一批次结果补齐。
- 检查超时保存 `error + timedOut`，与既有存储约束一致；未执行检查保留空开始/结束时间。退出码 0、零测试和模型最终文本均不授予 Task 通过。
- 默认 Core Task 收尾与 `task.verification.continue` 在 Git 副作用前重新校验输出 Artifact 的完整身份及实际字节。代码现场由既有 Task committer 重新核验；人工批准/阻塞仍由既有状态落库事务重核。
- 启动恢复核对已有验证批次的身份、定义政策、必需/选中结果、输出 Artifact 和代码摘要，纳入原有恢复指纹。运行中批次、缺结果、缺输出、损坏输出或代码漂移保留隔离，不凭历史绿色批次自动通过 Task。
- 完整证据且全部进程停止时，可以保留工作区并经当前授权的 Host 显式 resume 创建新 Attempt 重新验证。旧中断 Attempt 不复活，重复继续被拒绝，原批次累计预算与绝对截止时间继续生效。没有引入自动验证重试循环。

本项聚焦 Task 验证边界；Git 已提交回执恢复与整体恢复操作分别由 F-007/F-008 负责。证据不完整的隔离现场需要后续受控处置，本项不增加绕过隔离的入口。

## 真实故障测试

`test/modules/recovery/p07-1-f006-verifier-recovery.test.ts` 使用临时 Git/SQLite、真实 Host 子进程、生产 Node Verifier、受监督检查命令及公开 Host/Core 操作；Runtime 使用确定性 Fake，不调用模型。

| 场景 | 断言 |
| --- | --- |
| Verifier 挂起且后代忽略 TERM | Host 强杀后后代仍持续写文件；重启按持久身份停止检查进程和后代；保留 3 组隔离租约；迟到结果拒绝；后继 Task 未启动 |
| 命令退出、结果未落库 | 独立 IPC 屏障证明命令已退出，CheckResult 尚为 0，批次 running；重启不补造结果、不放行 Task |
| CheckResult passed、批次尚未定版 | 身份复核回调内的独立屏障证明检查结果与输出已保存而批次仍 running；重启保留隔离且后继 Task 无 Attempt |
| 批次 passed、Task 尚未提交 | 重启不自动通过；显式继续后新 Attempt 检查并完成真实本地提交；同工作区、不同 Attempt、累计次数增加、原 deadline/预算快照不变 |
| 输出文件损坏 | 在批次定版屏障修改真实输出字节；收尾拒绝 Git 副作用；重启保留隔离 |
| 代码漂移 | 在批次定版屏障追加未跟踪源码；收尾拒绝旧检查结果；重启保留隔离 |
| 新增人工阻塞 | 机器检查结束后经 Host 管理命令添加阻塞；机器证据可保持 passed，Task/Attempt 等待人工，后继 Task 无 Attempt |
| 零测试 | 真实命令退出 0，但协议计数为 0；持久结果 inconclusive，无 Git 提交与 Task 通过 |

测试中的命令退出屏障包装真实进程结果 Promise，CheckResult 保存屏障使用执行器既有身份复核回调，批次屏障位于生产执行器返回之后，均未替换业务检查结论。故障现场仅位于测试自有临时资源；测试 finally 执行进程缺席核验和清理。实际 SQLite、输出正文及工作区占用由断言核对，临时资源不作为永久证据路径。

## 本地验证与交接范围

本地分组验证覆盖 46 项不同用例：上述真实 Host 8 项、VerificationStore 26 项、停止/重探测 4 项、Schema 对齐 5 项、Verifier 时间限制 2 项及真实检查超时 1 项。原始 RED、调试失败、后续通过日志均保留；这是分组运行的合集，不声称一次执行了完整索引。

日志位于 Feature workspace 的 `verifications/F-006/runtime-logs/`，每次均由受控助手保留 stdout/stderr、真实退出码及 sidecar：

| 内容 | 通过日志 |
| --- | --- |
| 挂起/未落库重启 | `test-maya3aad.log` |
| CheckResult 已保存、批次未定版 | `test-7_2uh5il.log` |
| 完整批次显式重验 | `test-qlv16k0e.log` |
| 损坏输出/代码漂移 | `test-n9atq7pf.log` |
| 人工阻塞/零测试 | `test-5ayn_vz7.log` |
| Store 原有及新增身份围栏 25 项 | `test-r9libf7t.log` |
| v53→v54 升级与故障回滚 | `test-auh5oytz.log` |
| 停止未知/重探测、跨批次拒绝及 Schema 主键/外键 | `test-1xgliiz1.log` |
| Schema 其他对齐与 Verifier 时间限制 | `test-6pzq1w50.log`（其中 5 项通过；该轮另外两项 Schema 断言已在 `test-1xgliiz1.log` 修正后通过） |
| 真实检查超时 | `test-y6cn_jbv.log` |
| 最终 TypeScript 类型检查 | `test-234pcbfl.log` |
| 最终模块边界检查（470 文件，0 诊断） | `test-ow75fycg.log` |

工具链：Node 22.19.0、npm 10.9.3。`git diff --check` 通过。

仓库 Task 索引为 `test/index/phases/P07/features/P07-1/tasks/F-006.json`，Harness selection 仅引用此索引。索引额外登记既有 Node 执行器、聚合、显式继续、跨层检查选择、启动恢复、恢复核对和时间限制的较广回归，由 Nezha 独立执行；未在本地运行的部分不记为通过。

未执行全仓测试、组合 verify、Phase 验收、live 模型或发布；不据此声明 Feature/Phase 验收通过。分配分支沿用既有名称，不由 Runtime 创建、切换或改名；预先存在的分支命名异常仍见 F-001 交接。
