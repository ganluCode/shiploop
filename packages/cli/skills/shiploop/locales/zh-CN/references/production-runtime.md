# 生产 Runtime 政策

所有项目政策放在 schemaVersion: 2 的 policies 下；JSON/YAML 等价，需用 config create/update 或显式 config watch 提交。不要直接修改 SQLite。

| 段 | 主要字段 | 默认与边界 |
| --- | --- | --- |
| piAgent | transient_retry_attempts、transient_retry_backoff_base_seconds | 10 次连续重试，基数 1 秒，等待 2/3/4…秒最多 60 秒；完整响应成功重置连续计数，累计故障保留 |
| piAgent | fallback_on_connection_exhausted、fallback_on_server_exhausted、fallback_on_authentication | 默认 true，仍要求已批准 fallbacks、停止与录制完整、预算充足；Task 显式 fallbackPolicy 优先 |
| piExecution | maxRequests、maxInputBytes、maxOutputTokens | 默认 256 请求、512000 输入字节、16384 输出 Token；还受模型上下文和 Core 预算约束 |
| piExecution | thinkingLevel、commandTimeoutMs、codemode | 默认 off、600000 毫秒、true；high 模型档与思考档独立 |
| featureAutoFix | enabled、strategy、maxRepairs、maxTokenTotal、timeoutMs、maxTurns | 默认关闭；strategy 缺省选 high、次数缺省 3；三个预算字段可省略，省略表示不增加 Feature 专属限制，仍受父 Batch/Host/模型约束 |
| deliveryPolicy | auto_push、push_remote | 默认 false、origin；正式 commit 还需 commitMode: task_and_feature 及 confirmed gitIdentity |
| feishu | enabled、notify | 默认关闭；开启后未指定事件默认全开 |

Feature 所有 Task 通过才执行已声明的 Feature 检查。失败时开启 autoFix 才调用独立修复 Runtime；每次修复停止确认后重新检查，最多三次，不重复已通过 Task、不替代人工审批、不运行全仓测试。修复轮次持久化，重启不能清零；未配置 Feature 专属预算时仍受父 Batch 剩余预算、Host 单次上限和最终截止时间约束。

auto_push 在 Task/Feature 检查与审批通过且本地 commit 成功后执行，精确 SHA 到分支、不 force。回执未知先查远端；远端地址漂移或认证失败保留本地提交并停止交付。不要为重试 push 而重跑已完成代码。Git 隔离环境不默认继承用户全局 credential helper。

飞书 notify 字段：task_completed、feature_completed、rate_limited、model_fallback、error_stopped、human_blocked。使用持久通知队列，失败不会回滚业务；网络结果未知可能重复消息，以 delivery ID 识别。普通成功 Run 不重复发送错误通知。

卡片与 Nezha 使用相同的宽屏分组布局和颜色：项目与任务、状态详情、Task 用量；成功绿色、失败红色、降级/人工确认橙色。Task 累计当前 Run 内该 Task 的各次尝试，显示难度、执行模型、会话耗时、普通输入＋输出 Token（不含缓存、单位 k）和连接故障次数。缺失值未知，部分数据标注已记录部分；不扫描 transcript 或把缺失指标当零。

注意实际时限取所有层最小值。Core 未配置时 Work 为60秒、工具30秒，不会因为生产 Shell 默认600秒就自动延长。Host 单次还默认限制256请求、512000输入字节、单次输出16384 Token；输入/输出上限不是整批 Token 总额。Batch 有获批截止时间/启动计数，Token/费用上限可省略；配置两小时 Session 之前需处理底层进程一小时上限的不一致，不宣称当前已支持任意长执行。

私有凭据只加入当前 data-root 的 pi/auth.json（0600，目录0700），保留现有厂商字段：

```json
{"feishu":{"type":"webhook","url":"https://open.feishu.cn/open-apis/bot/v2/hook/<id>","secret":"<可选签名密钥>"}}
```

不在对话中索取 Key，不读取/展示现有密钥。私有 pi/runtime.json 可配置 pi_agent、execution、notifications.feishu，变更需重启 Host；项目政策覆盖默认，私有显式数字 execution 值为不可放大的部署上限。新 Invocation 冻结配置，运行中的执行不热改。不要为了验证配置擅自发送真实模型或飞书请求。

编码工具包括文件读写/精确替换、rg 搜索、受监督 Shell 与目录规范读取；默认 Codemode 是 SDK 内置受信扩展，不需要 PI_CODEMODE 环境变量。提示优先批量独立读取/搜索，依赖命令和写操作顺序执行。Shell 在可信项目模式中不是强 OS 沙箱。模型不能自行 commit/push/改官方元数据或数据库。

仅 Core 已选定的 Skills 才加载，init 注入不等于选定；根 AGENTS.md 自动读取，编辑子目录前查询祖先规范。规划仅有读取/搜索/候选提交，不可写代码或执行 Shell；候选仍须人工审阅和正式批准。
