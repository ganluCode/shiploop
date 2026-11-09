# P04-2 F-007 访问边界验证交接

F-007 在 F-001～F-006 上补充集成测试、实际资源清单与交接索引。生产代码未改动；沿用当前分支，恢复基线为 `19e01fa11cfb540f55d7d37b92c51b070ff68283`。

真实 Host 用例调用 `startHost`，使用同一临时数据根、真实 writer lock、SQLite Core、HTTP 路由、Artifact publisher/verifier 和候选校验器。Host 完成启动恢复之后才认领 Attempt，授权绑定该实例的真实 `hostInstanceId`，主体只有 `project.read` 和当前项目可见性。测试不启动模型或 Work 子进程；拆卸前仅释放夹具自行创建的合成 lease，再走真实 Host close 和临时资源清理。重启复用相同数据根，重新运行生产恢复逻辑。

## 权限与业务状态矩阵

| 场景 | 预期及实际断言 | 用例 |
|---|---|---|
| 当前授权 `task.read` | 返回当前 Task，数据库快照不变 | `real-host-allow-idempotency` |
| `candidate.submit` / `evidence.submit` | completed，主体为 work-agent，verificationPassed=false；仅新增原子回执 | 同上 |
| 同 commandId、同摘要并发重放 | 一份回执，一次非重放；另一次 replayed=true | 同上 |
| 同 commandId、不同摘要 | conflict，数据库快照不变 | 同上 |
| 跨项目、伪造主体、跨 Attempt | 拒绝，错误不回显合成秘密、token 或数据根 | `real-host-deny-authority` |
| 审批 / Task passed | 拒绝；审批、Task、Feature、预算、Run、Attempt、工作区等快照不变 | 同上 |
| 到期、撤销、Host / invocation / execution fence / 主体变化 | 查询与历史回执重放均拒绝，数据库快照不变 | 同上 |
| 同数据根 Host 重启 | 旧 token unauthorized；旧绑定在签发授权时即 forbidden；不能访问 owner 路由 | `real-host-restart-no-owner` |

业务快照覆盖 tasks、attempts、execution_batches、runs、budget revisions、Attempt/Runtime reservations、outcome settlements、workspace leases、state events、claim receipts、command receipts，以及额外的 features、approvals、managed_workspaces、sessions、verification_batches、check_results。提交成功只允许 command_receipts 变化。重启本身允许生产恢复写入核对事实；拒绝请求比较重启后的快照，不把合法恢复写入误记为越权写入。

## 资源与认证证据

`sdk-explicit-resources` 使用锁定的真实 SDK `DefaultResourceLoader`、内存 SettingsManager 和临时磁盘 skill。agentDir 的全局 skill、项目 `.pi/skills` 中未选择的 skill 与获准 skill 同时存在。关闭默认扫描、扩展、上下文文件、prompt templates 和 themes，仅传入获准文件。断言真实 `getSkills()` 只有 approved，再从 SDK 返回的文件读取实际内容、计算 SHA-256，核对获准资源身份并生成 Core manifest，避免用预期列表冒充实际观察。

必需但未核实的能力返回 required_unavailable；同一资源改为 optional/omit 后记录 omitted、unverified gap 和 difference。完全未知的能力枚举一律 unknown_resource，不视为 optional 可以放行。MCP、外部扩展和第三方工具能力仍需独立核实，本次没有宣称其真实可用。

`authentication-runtime-secret-boundary` 用临时 0600 认证文件和真实 SDK 离线 provider/model catalog 完成认证预检。结果为 authentication=ready、inference=unknown。受控 session 随后模拟 provider 失败，结果为 failed/provider_error，证明认证 ready 不代表模型推理成功。认证文件清空后预检为 authentication_missing。

该用例将新生成的合成秘密仅写入认证文件，并故意放进模拟 provider/进程异常，检查普通日志、文件输入装配后的 prompt、Runtime 快照、Runner 实际接收的 argv/environment/stdin、事件、结果与导出报告中均不存在秘密。Host 另将合成秘密作为伪造主体发送，检查真实 HTTP 错误正文不回显。秘密检查使用布尔断言，避免失败 diff 打印秘密本身。证据导出在检查通过后进行。

## 本地验证及证据

本 Feature workspace 为：
`/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-20-12-01-22_p04-2`。
以下路径相对该目录，所有执行均通过策略提供的 Nezha test_command wrapper，保留完整 stdout/stderr 及同名 `.log.json` 的退出码、耗时和 invocation。

| 执行范围 | 结果 | 耗时 | 日志 |
|---|---|---|---|
| 最小 RED：真实 Host 成功用例，夹具尚无启动前认领钩子 | exit 1；1 failed / 2 skipped | 2404 ms | `verifications/F-007/runtime-logs/test-zsy8nypw.log` |
| 两个新增文件 + 受共享夹具影响的既有 Host / Core 通道文件 | exit 0；29 passed / 0 failed / 0 skipped | 8269 ms | `verifications/F-007/runtime-logs/test-ygriuwf6.log` |
| Runtime 证据改为真实磁盘输入与实际空资源 manifest 后定向复测 | exit 0；2 passed / 0 failed / 0 skipped | 1084 ms | `verifications/F-007/runtime-logs/test-h0134pc2.log` |
| 全仓 typecheck | exit 1；仅既有 `test/modules/runtime/p04-1-pi-f007-contract.test.ts:77` TS18046 | 1447 ms | `verifications/F-007/runtime-logs/test-kvx1gnvl.log` |

中间诊断失败日志保留：缺少必需 capabilityCatalog 的 `test-mkrg0x24.log`；合成 lease 尚未释放导致真实 close 拒绝的 `test-kun3p_u7.log`；重启旧绑定在 issue 阶段提前拒绝的 `test-7v35057v.log`。均修正测试夹具/断言，不放宽产品授权或停止规则。首个 GREEN 为 `test-vtsulry1.log`（5 passed，3603 ms）。类型检查首轮 `test-qrnhe8dk.log` 包含本次字面量类型问题，已修正；最后仅保留前序任务已记录的 TS18046，未越界修改其他任务。

实际证据：

- `verifications/F-007/evidence/resources.json`：实际 manifest、可选降级 manifest、实际加载名称和固定原因。
- `verifications/F-007/evidence/authentication.json`：认证结果、实际空资源 manifest、Runtime/Runner 输入观察、受控错误事件与结果。
- `verifications/F-007/evidence/summary.json`：日志关联、测试范围、证据摘要及未运行项。
- `verifications/F-007/test-selection.json`：引用仓库 v2 Task 索引。

Task 索引 `test/index/phases/P04/features/P04-2/tasks/F-007.json` 包含 9 个文件。前四个文件本地已执行；其余五个认证、授权、资源与 Runtime 回归仅登记，由 Nezha 独立执行，不声称本地通过。最终 Runtime 证据更新后只复测该文件，没有重复执行未变化的其他通过文件。

真实模型请求、真实 OAuth 刷新/登录、live MCP / streamable HTTP、外部扩展、完整 Feature/Phase 验收均为 `not_run`。上述离线及临时 Host 通过结果不代表 live 推理可用或阶段放行。
