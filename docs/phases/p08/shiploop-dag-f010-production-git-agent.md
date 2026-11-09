# DAG F-010：生产 Pi GitAgent driver

本 Task 交付生产 driver 与受信装配函数，依赖 F-007 的集成执行协议。标准 Host 的冲突修复消费者、候选验证及受控提交接线属于 F-011；此处不自动启用修复策略，也不启动真实模型。

## 调用与授权

`productionPiGitAgentRuntime(dataRoot, authority)` 使用 `productionPiOptions` 创建真实生产 Work Runtime 工厂，再由 `createProductionPiGitAgentDriver` 将冻结修复请求映射到现有受监督 Pi 进程协议。模型、endpoint、私有凭据解析、SDK Session 和进程组停止核验沿用现有生产实现。`createProductionPiGitAgentDriver` 的工厂注入用于离线契约测试，不构成 live 证据。

调用方必须提供 `ProductionGitAgentAuthority`：

- `resolve`：将完整 requestDigest 绑定到批准的 strategy、locale、集成工作区及只读根映射；读取 intent/evidence 固定正文，driver 再核对其 SHA-256；提供批准的有限 maxRequests。
- `assertCurrent`：核对 repair/Attempt 的 owner、hostInstance、executionVersion、预算和工作区占用，拒绝迟到或撤销的执行。driver 在解析、启动、进程确认和候选读取边界调用。
- `confirmProcess`：以原修复身份持久确认 OS 进程身份，再允许子进程执行。Runtime 协议的合成 Work taskId 使用 repairId，仅作传输身份，不创建或改写业务 Task。
- `inspectCandidate`：确认停止后读取真实工作区/Git 事实，返回实际候选路径；driver 校验路径属于 writablePaths，不能用模型自报列表。Core 仍需重核冲突标记、越界修改、Git 状态与组合验证。
- `record`：保存绑定 requestDigest/execution 的结果、事件序列摘要、原始结构化 usage/duration 与停止 hold；发布失败阻止候选。正文、工具输入输出和 credential 不进入此记录。

这些回调只能来自可信装配，不从 HTTP/CLI 请求、模型结果或项目可执行代码加载。driver 不持有 Core 数据库连接，不设置通过标志，不批准或提交 Git，不推送、不派发后继。

## 工具、Prompt 与预算

中英文 `repair/git-agent.md` 接收完整冻结授权、前置交付意图与失败证据。GitAgent 不扫描全局资源、不重新采集可变项目文档或 Skills；必要设计由 intent 固定正文提供。文件工具仍拒绝绝对路径、路径穿越、Git 元数据、符号链接和硬链接；写入/编辑在创建父目录或打开文件前检查精确路径。模型只获得 list_files/read_file/write_file/edit_file，不获得 shell、Git、受限管理桥接、MCP 或 codemode。

模型使用获准 strategy，不执行 Work fallback 路由；GitAgent 的 SDK/适配器网络重试为零，模型多轮工具循环仍受 maxRequests、Token、剩余 runtime 和绝对 deadline 限制。配置和凭据缺失明确失败，认证正文只在受信生产凭据层处理。

重复 invocation/requestDigest 复用同一启动句柄；同 invocation 的不同授权拒绝；失败准入不被遗忘。无法装配生产 Runtime 时返回 `git_agent_driver_unavailable`。未知 usage 明确失败并在记录中保留 null，不把 0 当作已核实用量；超预算只允许以 failed/budget_exhausted 保留真实消耗，不允许变成成功候选。Core 原预算累计与 hold 继续生效。

## 监督

`superviseGitAgentRuntime` 从启动等待起计时，接受 AbortSignal，分别观察 result 与 stopped；取消回执也有有限等待。启动不确定、身份伪造、结果格式错误和停止未确认均保留 isolated，并返回绑定 execution 的 stop_unconfirmed hold。超时后才返回的启动句柄只取消，不再交付候选。取消窗口中的 completed 结果以 cancelled 结算，不能推动后继。只有结果无 failure、两个停止事实均确认且没有取消/超时才能交付候选。

## 本地证据与独立验收

本地聚焦测试：`production-pi-git-agent.test.ts` 23 项及 `p05-8-f001-git-agent-repair-contract.test.ts` 6 项，共 29 项通过。日志位于 Harness `verifications/F-010/runtime-logs/test-vf5392hi.log`，原 RED 与中间失败保留；每次日志均有真实退出码旁文件。类型检查通过（`test-m1ijgklq.log`）；模块边界检查通过，597 个生产源码文件、0 条诊断（`test-x1h1qvec.log`）。

Task 索引：`test/index/phases/P08/features/shiploop-dag/tasks/F-010.json`。其中三个 unit 文件交 Nezha 独立复验；九个真实 Git/SQLite/SDK/Host/进程回归文件已逐项绑定分配指定的 `test/index/phases/P07/integration.json`，本地 not_run。文件工具既有写入、生产 Runner 工具循环、真实进程强杀/停止与修复持久结算由独立集成验收覆盖。

真实模型、用户认证、在线配额/付费调用、标准 Host 修复闭环、全仓及 Phase 验收均未执行，不能由上述 29 项代替。当前无待负责人决策的实现契约阻塞；live 仍需独立授权，阶段签署保持独立。
