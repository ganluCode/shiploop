# F-009 集成资源、停止证明与恢复边界

本次修改沿用现有 Feature 资源租约、公共 Git 短锁、Git operation 和 append-only journal，不新建执行状态机或预算。Task 本地验证不代表 Phase 验收。

- `assertIntegrationResourceFence` 统一启动与恢复的长租约校验：项目 Feature 编码共享门控与 integrationId 工作区排他资源必须由同 owner/version 持有，且未到期。短锁不允许混入长租约集合。资源集合仍由既有 `normalizeFeatureResourceSet` 按统一顺序规范化；Feature 编码 worktree 使用 Feature 自身资源，集成 worktree 使用 integrationId 资源。
- Git worktree 创建、merge、commit、remove 先通过长租约准入，随后单独取得 common-dir 短锁。锁的身份与 Core 授权在受监督进程身份持久确认后再次检查。Git I/O 位于 SQLite 事务之外；短锁只覆盖对应 Git 元数据写入及启动/停止核验，不覆盖模型或组合验证。
- `start(request, { signal })` 支持可信控制层取消；请求摘要不包含 AbortSignal。取消、归属变化、错误分支或外部 HEAD 漂移均阻止后续写入。停止未确认会保留公共 claim，不能根据 TTL/PID 猜测释放或重分配。过期/隔离/释放/新 owner 的工作区租约均不能发布恢复结果。
- 同 commandId 的只读查重先于重新准入：相同输入返回已持久观察；不同输入拒绝。只有持久意图而无完整观察时要求 reconciliation，既不重新 merge，也不重复 commit。查重不修改 Task/Session/Run/Batch 或预算。
- 恢复读取 journal、真实仓库归属、detached HEAD、owner 标记、Git 原生/公共残留锁和 commit parent/tree/message/identity。只恢复固定顺序内的精确 merge，或通过 Git ancestry 确认的 `already_included` 输入。缺 owner 标记的部分创建现场保留阻塞，不能凭路径合成归属。残留公共 claim 保持阻塞；此只读恢复器不删除 claim，也不启动替代写入者。
- 恢复提交再次比较 operation revision、intent 和最初 journal 快照；异步 Git 读取期间的竞争结果不能覆盖。组合验证的失败处理和正常结算均重新核对授权及 CAS，迟到失败也不能修改新归属的计划。

## 本地验证

5 个聚焦单元文件共 34 项通过；测试中的 Git、进程与文件系统均由显式替身控制，不冒充真实崩溃或重启实测。

- `integration-workspace-fencing.test.ts`：短锁停止不明保留、启动确认后的 owner/取消围栏、同 HEAD 错分支、清理围栏。
- `integration-recovery-reader.test.ts`：精确提交消息恢复、已包含祖先、分支/owner/common-dir/残留锁拒绝。
- `integration-command-replay.test.ts`：取消/到期后的原结果读取、commandId 输入冲突、未完成副作用拒绝重放。
- `p05-7-f006-integration-reconciliation.test.ts`：租约状态、停止证明、Git 漂移、operation/journal 竞争与幂等。
- `p05-7-f005-integration-verification.test.ts`：证据/状态原子提交、停止不明与撤销授权后的迟到成功/失败。

完整日志位于 Harness `verifications/F-009/runtime-logs/`：

- TDD RED：`test-5hc_cwpo.log`、`test-p43vq44a.log`、`test-4d9v1172.log`、`test-lerm44bk.log`、`test-1m27hm0a.log`、`test-kwpp19s8.log`。
- 最终聚焦 GREEN：`test-rvy_fofa.log`（34 passed）。
- 类型检查：`test-xkuvg6vo.log`（退出码 0）。
- 边界检查：`test-jakwls4j.log`（596 个生产源文件，0 诊断）。

## 独立验证与未执行项

仓库索引：`test/index/phases/P08/features/shiploop-dag/tasks/F-009.json`；Harness selection 只引用该索引。6 个 unit 文件供 Nezha 独立执行，其中既有 Feature 资源纯规则文件本地未重跑。

10 个 integration 文件全部绑定 `test/index/phases/P07/integration.json`，本次 Runtime **not_run**：真实 Git/worktree 创建与有序 merge、丢失回执后的 SQLite 重启核对、竞争认领、资源停止结算、真实跨进程公共锁竞争、真实 Runner 强杀及残留子进程恢复。既有集成恢复夹具补充了必需的资源租约授权字段，未将真实 Git/SQLite/进程测试标为 unit。

既有 Git 崩溃窗口用例包含故障注入和真实 Git/SQLite 核对；进程强杀证据另由真实进程测试提供。它们不等于已逐边界执行所有 Git 进程的 SIGKILL 矩阵，Phase 实际执行及其证据仍是独立门槛。本次没有执行全仓、Phase、live、模型请求或阶段签署。
