# 标准 Host 的 Pi 执行接线

本次范围：标准 host start 的 Pi 编码、候选规划、Feature 自动修复、受控推送与飞书通知。启动或读取配置不发模型请求；模型调用仍需正式规划/执行授权和预算。

## 文件与边界

标准入口读取当前 data-root 下的两个用户管理文件，不扫描全局 Pi 配置、不继承全局登录，也不接受项目设置里的模块路径或可执行文件：

```text
<data-root>/pi/runtime.json   # 非秘密模型能力清单，0600
<data-root>/pi/auth.json      # API Key，0600，禁止提交 Git
<data-root>/pi/sessions/      # 隔离的原生 Session，保留以便排查
```

默认 data-root 是 `~/Library/Application Support/shiploop`。pi 目录建议 0700。配置文件必须为当前用户所有的普通文件、非符号链接、最大 64 KiB，不能对其他用户开放读写。

未提供 runtime.json 时保持空目录，不偷偷启用模型；文件畸形、未知字段、不安全权限或未知内置模型会拒绝 Host 启动，而非悄悄退回其他模型。修改 runtime.json 后需要重启 Host；auth.json 在新 Invocation 启动时读取。

## GitAgent 修复 driver

受信装配可调用 `productionPiGitAgentRuntime(dataRoot, authority)`，复用标准 Pi 的模型能力、私有凭据解析、进程监督和 SDK Runner。`authority` 必须核对冻结授权、owner/version、工作区、批准策略和上下文摘要，持久确认进程身份，并在确认停止后检查候选与保存记录。没有可用生产配置时明确返回 `git_agent_driver_unavailable`，不回退其他模型。

GitAgent 使用冻结的中英文 `repair/git-agent.md`，只提供工作区内文件读取及精确获准路径的写入/编辑工具；模型请求次数、Token 和 deadline 受父授权约束。验证、正式提交和后继派发仍由 Core 控制。标准 Host 的冲突修复消费者接线由 DAG F-011 负责；本 driver 的单元测试不证明真实认证、付费模型或 Git/进程纵向已验收。接口与待验范围见 [F-010 交接](phases/p08/shiploop-dag-f010-production-git-agent.md)。

## 项目文档上下文

默认使用统一项目文档目录：`<data-root>/projects/<projectId>/documents/working/`。`feature create --prd ... [--design ...]` 绑定相对路径；`planning start <featureId> --project <projectId>` 自动固定文档版本、发布上下文制品并保存 SQLite 元数据，无需手填映射 JSON 或制品 ID。批准候选后编码及 Feature 修复继续读取同一份固定输入。完整命令见 [统一文档操作说明](shiploop-managed-documents.md)。

以下仓库文档采集是兼容旧项目的后备路径：仅在未绑定受管文档上下文时使用，不会覆盖已固定的规划输入。

规划、编码、Feature 自动修复启动前，Host 会捕获授权 worktree 的文档上下文，发布 `project-document-context` 制品（项目、Feature、Invocation 身份、采集时间、路径、角色、必读标记、正文、SHA-256 与大小）。这是启动时追加的证据，不修改此前已批准的 Task 输入清单，也不等于批准文档。

提示词只带索引和制品引用，不自动塞入全部正文。`read_project_document` 按准确相对路径读取固定副本，校验内容身份；`read_file` 仍读取当前文件。采集时记录可用的 Git HEAD；它不代表文档已提交，实际正文身份以文件哈希为准。默认有界发现 docs 下 Markdown，实际存在的 docs/README.md、docs/product/overview.md、docs/architecture/overview.md 是必读入口；其余为按需候选。缺失入口和省略项会列出，不把 f01 别名推测为官方 Feature ID。

已有自定义布局或需要准确绑定当前 PRD／设计时，维护仓库 `docs/shiploop-context.json`（schemaVersion 1、shared 数组、features 按真实 Feature ID 索引）。条目含 path、role（index/product/architecture/prd/design/other）、required。显式映射只采集共享项和当前 Feature 项；文件缺失、不安全路径、符号链接、必读内容超限在模型请求前失败。required=false 只表示按需读取，不允许缺文件。

仓库兼容路径限制：Markdown 单文件 256 KiB、正文合计 1 MiB、最多 128 文档、64 目录、深度 6、2048 个目录项；映射文件 64 KiB。可选发现超限记录省略，必读超限失败。无全局扫描，不自动读取文档全文作为 Prompt。受管文档正文合计上限 768 KiB；新版 Skills 优先使用受管目录，不要求创建仓库映射。模型发现需求不明确时必须报告缺口。

## 内置 Provider 示例

runtime.json：

```json
{
  "schemaVersion": 1,
  "providers": [
    { "id": "zai-coding-cn", "models": ["glm-5.3"] },
    { "id": "xiaomi-token-plan-cn", "models": ["mimo-v2.6-pro"] }
  ]
}
```

只填自己需要的 Provider。内置 ID/模型会按隔离安装的 Pi SDK 离线目录核验，不进行联网探测。

auth.json：

```json
{
  "zai-coding-cn": { "type": "api_key", "key": "<填写你的 Key>" },
  "xiaomi-token-plan-cn": { "type": "api_key", "key": "<填写你的 Key>" }
}
```

生产入口接受字面 API Key，以及 builtin `openai-codex` 的 ChatGPT 订阅 OAuth。不会执行 `!command`、环境插值或扫描全局 Pi/Codex 登录。其他 OAuth Provider 暂未开放。

### Codex 订阅

在你自己的终端运行，按输出的网址完成授权：

```bash
shiploop provider login openai-codex
# 无浏览器回调或远程终端：
shiploop provider login openai-codex --method device
shiploop provider auth-status openai-codex --json
shiploop provider models openai-codex --json
shiploop provider logout openai-codex
```

命令均支持 `--data-root <绝对路径>`，默认 ShipLoop 私有数据根；不继承 Shell 中全局 Pi/Codex 账号。
登录打印网址，不自动打开浏览器；浏览器模式需交互终端，回调端口由 SDK 管理，必要时可粘贴回跳 URL（输入不回显）。设备码模式按网址输入屏幕上的一次性代码。Ctrl+C 取消，最长十五分钟；未成功登录不覆盖原凭据。不要在对话中粘贴授权码或令牌。

`auth-status` 只检查本地记录，不发请求、不刷新、不验证额度。ready 不代表在线调用成功；refresh_required 表示执行时需要 SDK 刷新，若授权已撤销需重新登录。退出只删除 ShipLoop 内该 Provider 的凭据，不撤销服务器授权，不影响全局 Pi/Codex 登录，也不主动取消已发出的请求。

`models` 离线列出当前 SDK 内置模型及 enabled 标志。登录不会修改模型能力清单；从列表选择实际 ID，在私有 `pi/runtime.json` 的 providers 中保留原项并加入：

```json
{"id":"openai-codex","models":["<models命令返回的模型ID>"]}
```

能力清单变更后空闲时重启 Host。该 Provider 不允许 custom 端点。项目 YAML 可写：

```yaml
strategies:
  modelMap:
    high:
      runtime: pi
      model: openai-codex/<已启用模型ID>
```

凭据引用由配置文件适配补为 credential://pi/openai-codex。账号登录/退出通常不需要重启；下一次请求重新解析私有认证。SDK 按需提前刷新，跨进程 OS 锁内再次核对并将轮换结果原子保存后释锁；取消不会丢弃已开始轮换的刷新令牌。并发登录/退出也走同一锁，保留其他厂商和飞书项。私有文件仍为0600，不输出 access/refresh，订阅费用记为未知而非套用 API 价格。首版使用 SSE，沿用现有连续重试/备用模型机制。

先确保文件权限，再重启：

```bash
chmod 700 "$HOME/Library/Application Support/shiploop/pi"
chmod 600 "$HOME/Library/Application Support/shiploop/pi/runtime.json" \
  "$HOME/Library/Application Support/shiploop/pi/auth.json"
shiploop host stop
shiploop host start
```

## 自定义 Provider

不在 SDK 内置目录的 ark-agentplan、wlb 等 ID 不能只写一个名字，必须显式配置真实服务的 API 类型、地址、上下文与输出限制。例如以下只是结构示例，地址和模型必须替换为服务实际值：

```json
{
  "schemaVersion": 1,
  "providers": [{
    "id": "my-provider",
    "models": ["my-model"],
    "custom": {
      "api": "openai-completions",
      "baseUrl": "https://api.example.com/v1",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "reasoning": false
    }
  }]
}
```

支持 openai-completions、openai-responses、anthropic-messages；自定义地址要求 HTTPS（离线测试仅允许 HTTP 127.0.0.1），不能含用户信息、query 或 fragment。请求禁止 HTTP 重定向，避免把 Key 转发给其他地址。

自定义模型未提供可验证价格，因此上报成本为 unknown/null，不能把 SDK 的占位零价格当作免费。

同一 Provider 的模型可以通过 custom.modelOverrides 按模型 ID 保存独立 name、contextWindow、maxTokens、reasoning、input、thinkingLevelMap 和 compat.supportsDeveloperRole；custom.compat 保存 Provider 级兼容开关。不把各模型不同的上下文和输出上限合并成一个值。迁移时原配置缺省的字段使用当前 SDK 默认值（如 maxTokens=16384），不宣称原文件显式提供了这些值。

默认思考档仍为 off，可用项目 policies.piExecution.thinkingLevel 指定；模型不支持所请求档位时由 SDK clampThinkingLevel 解析，加载清单记录请求和实际档位。不复制全局 Pi 的思考档偏好。high 模型档位和 thinkingLevel 是两个独立配置。

自定义端点可省略策略中的 endpointRef，使用显式模型清单内的固定地址；若填写则必须为 endpoint://pi/<provider-id>。未知端点引用拒绝，不静默忽略；内置 Provider 不接受覆盖端点。

## 配置 low/medium/high 策略

能力清单和策略是两层：runtime.json 决定哪些模型可以装配；ShipLoop config 决定任务用哪个模型。

```json
{
  "schemaVersion": 2,
  "strategies": {
    "modelMap": {
      "medium": {
        "runtime": "pi",
        "provider": "zai-coding-cn",
        "model": "glm-5.3",
        "credentialRef": "credential://pi/zai-coding-cn"
      }
    }
  }
}
```

生产执行使用的 credentialRef 必须是 `credential://pi/<provider-id>`，它只映射到私有 auth.json 中同名 Provider，不是任意文件路径或全局登录发现。通过 CLI 的 config create/update/watch 读取 JSON/YAML 时，Pi 策略可省略 credentialRef，由文件适配层补该引用；不会创建凭据或复制全局 Pi 登录。

配置文件也支持省略 provider，使用 `model: ark-agentplan/ark-code-latest`，仍需 `runtime: pi`。按第一个斜杠拆分，后面的斜杠保留在模型 ID 中。显式 provider 时 model 保持原样，避免破坏 org/model 等原生模型 ID；两种格式不要混填。默认策略、分档、用途、Agent 覆盖、备用链和自动修复 strategy 都适用；数据库及直接 HostClient 请求仍使用明确的 provider/model/credentialRef。已有 Task 快照不自动变化。

```bash
shiploop config create --scope project --project "$PROJECT_ID" --input ./shiploop-config.json --json
shiploop config effective --project "$PROJECT_ID" --json
```

已有配置改用 config update 并传查询返回的 revision。配置改变不自动覆盖已有 Task 策略或已授权 Batch。

### 备用模型

项目配置 JSON/YAML 的每个 modelMap 条目可保存有序 fallbacks 和 fallbackPolicy。完整格式、文件监视与 YAML 模板见 [配置文件说明](../packages/cli/skills/shiploop/locales/zh-CN/references/configuration-files.md)。备用链随 Task 策略冻结并进入批准摘要；无备用字段保持旧行为。保存、编辑和显式重新应用都会校验全部模型能力，不把错误备用模型拖到执行期才发现。

标准生产 Pi 已装配 failureRouting：限流及重试耗尽后的可切换错误进入 Core 受控流程，确认停止、录制完整、工作区与预算后才创建下一 Attempt，不跨模型复用原生 Session。每个新 Task 重新使用其首选，不全局粘住备用模型。当前未接入厂商可信恢复时间的持久冷却，不猜测额度重置时间。

SDK 在 429/错误响应上初始化的无范围零用量不是可信计费事实，记录为 unknown/null；错误过程已经报告的非零部分用量仍保留为未知范围，不为了切换模型伪造完整计量或放宽录制门禁。配置/启动错误、停止不确定及证据缺口仍然停止，不保证所有认证启动失败都能切换。

## 执行保证与当前限制

- 使用现有受监督 CommandProcess、Pi Work Runner、身份提交、事件录制和停止核验路径；不新造数据库写入或 Task 通过逻辑。已有 Core Scheduler 在恢复核对后启动。
- 输入只从当前 Invocation 的 Core 绑定读取器取得，Runner 再核对引用、SHA-256 与长度；cwd 由受管工作区根解析，不接受模型指定任意绝对工作目录。
- 编码与修复工具：list_files/read_file/write_file/edit_file/read_project_instructions、search_files/search_content、execute_command。文件工具拒绝越界、符号链接、硬链接和 .git；edit_file 要求唯一旧文本并支持 expectedHash。Shell 固定 worktree、显式工具链环境，不继承 Host token/API Key。
- Shell 子进程继承已持久登记的 Runner 监督进程组；命令超时、取消或输出溢出终止整个 Invocation，Host 核验整组停止再允许后续执行。正常非零退出反馈模型，可继续局部修复。默认单命令 10 分钟，保留 64 KiB 输出，观测超 8 MiB 终止。可信项目模式不是强 OS 沙箱，Shell 仍可访问 cwd 之外和网络。
- 自动加载根 AGENTS.md；修改子目录前用 read_project_instructions 读取适用祖先规则。只加载 Core 已选定并核验修订/摘要的 Skills，单项 32 KiB、总 128 KiB；init 注入文件不代表已选定。必需资源失效拒绝，允许省略的资源记录原因。不发现全局 Skills、插件或 MCP。
- 规划只提供读取/搜索/规范查询和 planning_candidate_submit；没有写文件和 Shell。每次 Invocation 使用私有环回最小权限通道，Core 核对当前身份/租约并验证候选。相同正文复用 commandId 和 issuedAt，结果未知时可安全重放；完成仅保存候选，不自动批准或启动编码。
- 不自动批准人工门禁、增额或删除工作区；模型不得自行操作正式 Git 和 SQLite。仅显式配置 auto_push 的已验收边界由 Core 推送；不把 Runtime completed 当 Task/Feature passed。
- 每次 Invocation 默认最多 256 次推理、512000 输入 UTF-8 字节、单次最多 16384 输出 Token；可配置并受模型及 Core 时限/事件/输出/预算限制。输入字节与估计 Token 窗口分开检查，超限诊断只记录类别及数值。不自动压缩或预热。
- 同 Invocation 保留防重语义；Codex OAuth 已接通，跨模型原生 Session resume 未接通，不自动创建新会话绕过恢复失败。
- 原生 Session 留在私有数据根；受控进程停止确认后清理临时输入文件，停止不确定时保留现场。

## 项目配置：重试、修复、推送和通知

以下政策可放入现有 schemaVersion: 2 的 JSON/YAML 配置；通过 config create/update 或显式 config watch 提交，不会仅因文件存在就生效。每次执行启动冻结 piAgent/piExecution；已开始执行不热改。pi/runtime.json 的 pi_agent、execution 是部署默认，显式数字 execution 上限同时是项目不能放大的 ceiling。

```yaml
policies:
  piAgent:
    transient_retry_attempts: 10
    transient_retry_backoff_base_seconds: 1
    fallback_on_connection_exhausted: true
    fallback_on_server_exhausted: true
    fallback_on_authentication: true
  piExecution:
    maxRequests: 256
    maxInputBytes: 512000
    maxOutputTokens: 16384
    thinkingLevel: medium
    commandTimeoutMs: 600000
    codemode: true
  featureAutoFix:
    enabled: true
    # strategy 省略使用 modelMap.high；maxRepairs 省略使用 3。
    maxRepairs: 3
    # maxTokenTotal、timeoutMs、maxTurns 可省略，不增加 Feature 专属限制。
    # 需要独立模型时填写完整单策略，无 fallbacks：
    # strategy:
    #   runtime: pi
    #   provider: ark-agentplan
    #   model: ark-code-latest
    #   credentialRef: credential://pi/ark-agentplan
  deliveryPolicy:
    commitMode: task_and_feature
    gitIdentity:
      name: Your Name
      email: you@example.com
      confirmed: true
    auto_push: false
    push_remote: origin
  feishu:
    enabled: false
    notify:
      task_completed: true
      feature_completed: true
      rate_limited: true
      model_fallback: true
      error_stopped: true
      human_blocked: true
```

- 重试是每个 Invocation 中连续失败的重试额度，范围 0..10；成功完整响应后清零连续计数，累计故障保留。首次失败后等 2 秒，其次 3 秒，再次 4 秒，上限 60 秒；0 表示不重试。不是整个 Run 共用十次。切备选仍须配置 fallbacks、通过停止/录制/授权/预算检查；显式 Task fallbackPolicy 优先。
- Feature 所有 Task 通过后由 Core 执行已声明的 Feature 检查；失败且 autoFix 开启才调用修复 Runtime，随后独立重验。默认 high 模型、最多三次，不重跑已完成 Task、不覆盖人工阻塞。只限制修复次数；未配置 maxTokenTotal/timeoutMs/maxTurns 时不增加 Feature 专属限制，但仍受父 Batch、Host/模型单次上限、截止时间和 runtimeStarts 约束。修复轮次、进程身份和录制持久保存，重启不重置次数。
- auto_push 默认 false。Task 相关测试及审批通过并完成本地 commit 后推送；Feature 最终检查和审批通过并完成本地 commit 后推送。仅精确 SHA 到当前分支、禁止 force。推送地址摘要随意图保存，结果未知先核对远端 SHA，地址漂移或非快进等失败停止交付，保留本地提交。Git 使用隔离环境，不假定继承全局 credential helper；远端认证需在可信环境配置。
- Codemode 默认加载 SDK 内置扩展，无需 PI_CODEMODE 环境变量。提示模型批量独立读取/搜索，写入与依赖命令顺序执行；codemode:false 可禁用。模型是否采用由实际工具记录确认，不保证所有模型都调用。
- 飞书总开关默认 false；开启后未指定的事件开关默认 true。复用持久 local-results 投递队列，失败独立退避；可能至少一次送达，卡片带 delivery ID 便于识别重复。支持 Task/Feature 结果、人工阻塞、限流切备选与其他模型切换；普通成功 Run 结束不另行发失败消息。

飞书使用与 Nezha 相同的宽屏 interactive 卡片布局：项目与任务、状态详情、Task 用量分组；成功绿色、错误红色、降级/人工确认橙色。保留 ShipLoop 标题标识。Task 显示难度、执行模型、当前 Run 内该 Task 的累计会话耗时、普通输入＋输出 Token（不含缓存、单位 k）、累计连接故障次数。新会话从有界录制清单直接读取故障计数，不扫描历史 transcript；缺失为未知，部分为已记录部分。历史错误占位零用量不当真实零。模型切换显示原/新模型；未接入可信恢复时间时不猜额度重置时间。

### 现存上限的实际口径

Batch 预算在 execution start 的预览/授权中提交：整批截止时间、Run/Attempt/Runtime 启动计数必需；maxTokenTotal/maxCostTotal 可选，未配置不设 Token/费用总额限制。Run 另有自己的总时间和尝试次数，恢复或重试不重置绝对截止时间。

Core 当前未配置时的默认 Work Session 上限为 60 秒、单工具为 30 秒；它们可能比生产 Shell 默认 600 秒更小，实际取最小值。生产 Host 单次默认还有 256 请求、512000 输入字节、16384 输出 Token（每次响应，非整个任务总 Token）的保护。底层 CommandProcess 目前仅接受最多 1 小时时限，而 Runtime 配置校验接受至 24 小时，尚存在上限不一致；不能仅配置 Session 2 小时就宣称已支持。上限调整需同步端口/监督/测试，不是自动修复次数配置的一部分。

飞书凭据只加入私有 pi/auth.json，不写进项目 YAML：

```json
{
  "feishu": {
    "type": "webhook",
    "url": "https://open.feishu.cn/open-apis/bot/v2/hook/<你的机器人>",
    "secret": "<启用签名校验时填写；未启用则省略此字段>"
  }
}
```

保留已有 Provider 凭据，不用此示例覆盖整个文件。支持飞书/国际版 Lark 官方 HTTPS 机器人 URL，签名、10 秒超时、有界响应和脱敏失败原因；取消仅在发送者真正停止后确认，已发送消息无法撤回。项目 feishu 配置覆盖私有 runtime.json 的 notifications.feishu 默认；修改私有默认需重启 Host，auth.json 在发送时读取。

## 验证边界

离线回归使用真实 SDK、本机模拟 HTTP、临时 Git/SQLite，覆盖 Codemode 文件往返、Shell 超时与孙进程停止、规划候选提交、资源摘要、重试、修复重验和本地 bare remote 推送。飞书使用注入 transport 校验卡片/签名/取消。没有发送外网模型或真实通知，不替代真实 Provider/飞书连通性及项目实战验收。

真实验证须单独明确 Provider/Model、请求/Token/时限、可修改文件和预算，不从“开启配置”推断已允许发送测试请求。
