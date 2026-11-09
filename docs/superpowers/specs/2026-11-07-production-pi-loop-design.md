# 生产 Pi 编码与规划闭环补齐设计

状态：用户已批准并实施；相关离线验证结果见同日实施计划。本文区分产品接线和真实外部验证，不代表已跑真实 Provider 或飞书。

## 目标与范围

使标准 Host 的 Pi Work 能完成可信项目中的代码阅读、修改、相关测试及候选规划提交。
保留 Core 对 Task 状态、批准、正式 Git 提交、交付和验收的所有权。

首批包括受监督 Shell、搜索、局部编辑、项目规范与选定 Skills、工具记录，以及规划提交桥。
不包括子 Agent、任意扩展、MCP、浏览器自动化、OAuth 或跨模型原生 Session 恢复。
这次不改变已批准任务、真实项目配置，也不自动调用外部模型。

## 改动前源码证据

- `packages/host/src/runtime/production-pi.ts`：在启动前拒绝 planning-prompt；已经复用 CommandProcess 与 Core 输入绑定。
- `packages/host/src/runtime/production-pi-runner.ts`：仅有 list_files/read_file/write_file；资源自动发现关闭；64 请求、8192 输出 Token、64000 输入字节及 off 思考档写死。
- 同一 Runner 的输入检查将序列化消息字节数与模型 Token 窗口直接比较，单位不一致；不能把该检查当精确 Token 预算。
- `packages/host/src/runtime/work-submission-tools.ts`：已有 planning_candidate_submit 工具；只通过受限 Work 通道提交候选。
- `packages/host/src/runtime/work-tool-access.ts`：已有 Host 实例内的签发、绑定和撤销机制。
- `packages/core/src/ports/project-resources.ts`：已有项目资源选择、身份、修订与加载清单；禁止隐式全局扫描。
- `packages/core/src/ports/command-process.ts`：已有持久身份确认、有界输出、取消和进程组停止确认端口。

## 方案选择

1. 推荐：在当前受监督 Runner 中装配 ShipLoop 自有工具，并复用 Core 资源与提交通道。改动集中、权限和记录一致，但需补真实子进程及通道接线测试。
2. 开放 SDK 默认 Bash 和全部默认资源发现：代码较少，但会绕开当前进程监督及项目资源选择，不适合现有边界。
3. 保持文件工具、让模型仅生成脚本：无法实际安装、构建或测试，不能满足自动开发目标。

按用户已确认的方案 1 实施，并一并接入自动修复、推送、重试、飞书和默认 Codemode。

## 受监督命令工具

- 工具以授权 worktree 为固定 cwd，不允许模型选择任意绝对 cwd；需要子目录时必须验证仍处于该 worktree。
- Shell 使用固定解释器、禁用登录配置，环境由可信装配显式提供。PATH 包含明确选定 Node 和工具链目录；不继承模型凭据或 Host 管理 token。
- 依赖安装所需网络作为可信项目执行权限声明。首版无 OS 网络隔离，不将参数声明描述为可强制的断网沙箱。
- 复用 CommandProcess 已持久登记的 Runner 进程组监督；Shell 及子进程继承同组，不创建脱离监督的第二进程组。Runner 启动前经可信确认提交实际组身份，工具只使用冻结组 ID，不能在父进程退出后改用新的 ppid。
- Host 可在 Runner 退出后清点/停止整组，不仅依赖 Runner finally；命令超时终止 Invocation，停止未知不继续执行。
- 单命令默认 10 分钟，不能超过 Attempt 剩余时限；配置允许的范围受底层进程端口上限约束。
- 取消、超时、输出溢出走统一停止流程。停止未确认时保留占用和现场，不继续发下一命令或切模型。
- 返回退出码、信号、超时原因、耗时、保留/丢弃字节数和有界 stdout/stderr。非零退出作为工具失败反馈给模型，允许局部修复。
- Task 只执行计划声明的相关单元测试。全量与集成测试走相应验收流程，不由工具默认追加。
- 提示词禁止模型进行正式 commit/push、修改 ShipLoop 数据库及批准记录。可信 Shell 能访问 cwd 之外；这些约束不是强安全隔离，也不以简单命令黑名单宣称已阻止全部绕过。

## 搜索与局部编辑

- search_files/search_content 使用可信解析的 rg 可执行文件和结构化 argv，不拼接模型字符串为 Shell；限制匹配数、输出、搜索时限与路径。
- 默认排除 .git、依赖目录、构建产物和原生会话；显式范围只能在授权工作区内。rg 缺失返回明确诊断，不扫描用户其他目录。
- 局部编辑首版使用精确旧文本替换：path、oldText、newText，可附当前内容摘要。匹配零次或多次拒绝，要求先读最新文件；不默认模糊匹配。
- 沿用现有路径、符号链接、硬链接和文件大小检查；写入前核对摘要，避免基于旧读取覆盖。它是可信项目内的冲突保护，不是任意并发写的事务保证。
- 保留整文件写入供新建及小文件使用，不强制模型每次重写大文件。

## 项目规范与 Skills

- 仅加载本次授权项目中的 AGENTS.md，以及经 Core 资源选择确认的 Skills；不扫描用户全局目录、不加载任意插件或 MCP。
- AGENTS.md 来自授权工作区，并按适用目录规则提供；不把全部子目录规范当成对整个项目生效。对尚未读取的目标目录提供受控的规范查询能力。
- Skills 使用已冻结的资源选择、修订和内容摘要，核对实际加载结果；不能仅因 init 复制了文件就报告已加载。
- 记录文件相对路径、摘要、大小、加载或省略原因及清单摘要；加载内容有单项和总量限制，超限明确拒绝或按已声明策略省略，不静默截断关键规范。
- 项目文件是任务参考资料，不能扩展本次工具权限、读取凭据、自动批准或绕开正式接口。

## 规划提交桥

- 在 Host 就绪后为当前 planning Attempt 签发最小 Work 通道权限；凭据不进入提示词、工具参数、日志或模型事件。
- Runner 仅获得受限通道，注册现有 planning_candidate_submit；候选正文由 Core 正式接口校验和保存。
- 绑定 project/run/task/attempt/invocation/executionVersion，不接收模型指定身份。不将通用 Host 管理 token 交给 Runner。
- 通道结果未知时按候选摘要保留同一 commandId/issuedAt 完整信封并重放，最多保留 64 个正文身份；Core 用同一事务时钟写入规划上下文，不混用墙钟造成 updated_at 倒退。
- 有效提交后仍进入正式候选审阅、批准和执行流程；模型文本声称完成不等于计划已保存。
- Invocation 结束、撤销、取消及 Host 重启使权限失效；迟到提交拒绝。通过这些回归后才移除生产 planning-prompt 拒绝。

## 长任务配置与诊断

- 将请求次数、输入 UTF-8 字节上限、单次输出 Token 上限、思考档和工具超时从 Runner 常量改为受校验配置，保留明确默认值。
- 输入字节预算与 Token 预算分开命名和诊断。使用 SDK 可用的模型 Token 估计能力或明确保守估计，不能直接把字节数当 Token 数。
- 输出不超过模型能力与 Core 剩余预算；若思考档不受模型支持，明确记录 SDK 解析后的实际档位。
- 执行开始冻结本次配置并记录非秘密摘要；配置中途修改不改变当前 Attempt。项目策略与私有部署上限分别说明，不让 YAML 中的未经授权字段自动提高批准预算。
- 预算拒绝保留具体类别、配置值和观测值，不仅输出 production_request_budget。不得记录凭据或原始敏感输入。
- 本次不静默启用自动上下文压缩；压缩/恢复仍需独立验证。

## 改动与实施顺序

1. 扩展生产配置解析和诊断；提取文件工具模块，补搜索与精确局部编辑。
2. 接入工具进程监督、身份持久记录、取消及清理，验证崩溃场景。
3. 对接项目规范与选定 Skills，核对加载清单和预算。
4. 接通受限规划提交桥及回执恢复，再移除启动拒绝。
5. 更新生产说明、操作 Skills、工具能力展示和限制说明；构建全局 CLI，确认无运行任务后重启 Host。

实际涉及 Host 生产工具/装配/配置、受限提交工具、Core 资源加载/修复/交付/通知接线及定向测试。新增 v65 迁移保存 feature_repair_attempts 和 git_pushes；不修改既有已发布迁移。

## Feature 修复与交付

- 全部 Task 有效通过后才执行 Feature 相关检查；检查失败且 policies.featureAutoFix.enabled=true 才启动独立修复 Runtime。strategy 可配置 runtime/provider/model/credentialRef/endpointRef，省略取 high，maxRepairs 默认及上限为三次。
- 不复活 passed Task、不制造虚假 Task Attempt；修复在原 Feature dispatch lease 下执行，记录独立轮次、冻结策略、失败证据、录制、进程身份与停止结果。人工阻塞始终优先，修复不能代替批准。
- maxTokenTotal/timeoutMs/maxTurns 可选；省略时不增加 Feature 专属限制，但修复仍受父 Batch/Run 剩余预算、Host/模型单次上限、截止时间和 runtimeStarts 约束。修复轮次持久化，重启不清零。
- 修复停止确认后 Core 独立重验最新代码，最多失败三轮后停止。取消/录制/停止等待有界，未知进程保留现场并由启动恢复核对，不把超时当已经停止。
- policies.deliveryPolicy.auto_push 默认 false，push_remote 默认 origin。Task/Feature 有效验收及审批通过、本地提交完成后精确 SHA 推送到分支；禁止 force，模型不自行执行 Git 交付。
- 推送意图、远端地址摘要、分支、SHA 和回执持久化。结果未知先查远端，再决定补推；远端地址漂移拒绝。未确认 push 不能结算为交付成功，本地 commit 保留，不能因此重做编码。

## 连续重试与备用模型

- policies.piAgent 支持 Nezha 同名配置：transient_retry_attempts=10、transient_retry_backoff_base_seconds=1，以及 fallback_on_connection_exhausted/fallback_on_server_exhausted/fallback_on_authentication，后三项默认 true。
- 生产 Pi 使用连续失败额度，成功完整响应重置连续计数，累计故障保留。基数一秒时等待 2/3/4…秒，封顶60秒；范围0..10次重试。旧调用方不指定 consecutive 时仍保持旧累计语义。
- 连接或临时服务端错误重试耗尽、认证错误可按已冻结 fallbacks 顺序切换；Task 显式 fallbackPolicy 优先。停止、录制、授权、预算任一未满足均停止，不为了切模型伪造用量。新 Task 从自己的首选开始，不跨模型复用原生 Session。

## 飞书通知与 Codemode

- policies.feishu 控制总开关和 task_completed/feature_completed/rate_limited/model_fallback/error_stopped/human_blocked。总开关默认 false，启用后事件默认全开。复用持久通知 outbox，投递失败不改变业务状态；未知网络回执可能重复，卡片携带 delivery ID。
- 已确认备用切换产生脱敏持久事件，限流切换也能通知。普通成功 Run 不额外误报停止；并非每次短暂429/连接重试都发通知。
- Webhook/可选 secret 只保存私有 pi/auth.json，不写项目配置或模型上下文。官方HTTPS地址、HMAC签名、禁止重定向、十秒上限、有界响应；取消等待实际发送者停止，无法撤回已送达消息。
- SDK 内置 Codemode 默认显式加载，无需 PI_CODEMODE 环境变量，policies.piExecution.codemode=false 可禁用。提示批量独立读取/搜索，依赖编辑/命令顺序执行；不加载任意扩展，不保证模型一定采用。
- 配置与可复制示例见 docs/shiploop-production-pi.md 和官方 Skill references/production-runtime.md。

## 验证与完成条件

- 离线测试使用真实 SDK、临时 Git 仓库、真实命令进程和本机 HTTP 模拟模型，不使用外部付费请求。
- 编码闭环：读取规范、搜索、局部修改、相关测试先失败再修复成功；录制含命令、退出码和脱敏输出。
- 进程闭环：超时、取消、孙进程、Runner 异常退出、输出超限及停止未知；不可遗漏受控进程或伪报停止。
- 规划闭环：候选提交、校验失败后修正、同 ID 重放、结果未知、过期身份和跨项目拒绝；只生成候选，不自动批准。
- 资源闭环：选定 Skill 确实加载；未选定全局资源不加载；摘要变化及必需资源缺失明确失败。
- 预算闭环：边界值、旧配置兼容、请求次数、输入字节、输出 Token、实际思考档均有明确诊断。
- 类型、架构边界和构建冒烟通过；不运行仓库全量门禁。真实 Provider 和 Electron 实战验证需另外取得具体预算授权。

## 验证边界

本次不发真实模型请求、飞书消息或用户远端推送。离线规划已能发布候选而不自动批准；真实 SDK 工具、Shell 孙进程超时停止和临时 bare remote 回执恢复有独立回归。真实 Provider、远端认证和机器人投递需后续明确授权验证。跨模型 resume、OAuth、MCP、子 Agent 与浏览器仍不在本次范围。
