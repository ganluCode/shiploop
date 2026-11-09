# Codex 订阅认证

按用户批准的 ShipLoop 私有登录方案实施，不复制全局 Pi/Codex 凭据，不发送真实模型请求。

- CLI：provider login/auth-status/logout/models openai-codex；显式 --data-root；登录支持浏览器/设备码和取消，状态只读不刷新，输出不含令牌。
- Host 包提供本地认证服务，CLI 只依赖其公开入口；业务 SQLite/模型策略不由登录操作改写。
- 私有 pi/auth.json 保留现有 API Key 和飞书项；实现 SDK CredentialStore，原子保存、0600、拒绝符号链接/不安全权限；跨进程 OS 文件锁串行化刷新/登录落盘/退出。
- Pi SDK 负责 OAuth 流程和提前刷新。Runner 每次请求交由 SDK 解析认证，刷新结果在释放锁前落盘；取消不打断已经开始的令牌轮换落盘。
- 只支持 builtin openai-codex OAuth，不允许自定义端点伪装订阅 Provider，不接受把 OAuth 当固定 API Key。
- 订阅调用按未知费用处理，保留 Token 用量，不套用 API 单价。备用路由核验 OAuth 已配置，不主动刷新或探测。
- Provider/模型允许列表仍来自 pi/runtime.json；models 命令列出 SDK 内置模型及是否启用，登录不私自扩大模型能力。修改允许列表后重启 Host。
- 验证使用临时私有目录、真实文件锁、模拟 OAuth、实际 SDK + 本地假 HTTP；不读真实凭据、不做真实登录或请求。
