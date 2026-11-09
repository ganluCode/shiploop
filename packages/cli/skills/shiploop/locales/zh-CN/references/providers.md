# Provider 和模型配置

配置使用 ShipLoop 的全局或项目设置，不读取全局 Pi CLI 的当前模型。

配置输入支持严格 JSON 和可注释的 YAML；每档可配置有序 fallbacks 和 fallbackPolicy。创建项目根目录模板、持续保存同步及已有 Task 的生效边界，先读取 [configuration-files.md](configuration-files.md)。

```json
{
  "schemaVersion": 2,
  "strategies": {
    "modelMap": {
    "low": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "credential://pi/<provider-id>"
    },
    "medium": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "credential://pi/<provider-id>"
    },
    "high": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "credential://pi/<provider-id>"
    }
    }
  }
}
```

```bash
shiploop config create --scope global --input global-config.json --data-root "$DATA_ROOT" --json
shiploop config effective --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
```

凭据只能使用引用，不能把 API Key、Token、密码或含密钥 URL 写入配置。Provider 和 Model 必须存在于可信能力目录；更新配置前读取 revision，并使用 `config update --revision`。

Task 会保存策略副本，修改默认配置不会自动覆盖已有 Task；需要改变已规划的 Task 时使用 `task strategy` 或 `task strategy-reapply-preview` / `task strategy-reapply`，核对影响范围再提交。已经创建的 Attempt 使用自己的策略快照。

`credentialRef` 不是创建凭据的命令：还需要 Host 可信装配映射到明确的认证来源。不要假设任意 `credential://...` 字符串就能使用 API Key，不要假设会继承全局 Pi 登录或 models.json。Provider/model 不在能力目录时，先解决 Host 装配/目录配置，不能绕过校验。

标准 Host 现在支持显式生产装配：当前 data-root 下 pi/runtime.json 定义允许的 Provider/Model，pi/auth.json 保存字面 API Key 或 builtin openai-codex 的 OAuth；两个文件必须由当前用户持有、权限 0600、非符号链接。未配置仍保持空能力目录，修改能力清单后重启 Host。生产 credentialRef 固定映射 credential://pi/<provider-id>。不自动扫描或复制全局 Pi/Codex 配置，不接受命令式 Key、其他 OAuth Provider 或环境插值。

Codex 订阅登录由用户在终端执行，不替用户完成浏览器授权，不读取/粘贴令牌：

```bash
shiploop provider login openai-codex
shiploop provider login openai-codex --method device
shiploop provider auth-status openai-codex --json
shiploop provider models openai-codex --json
shiploop provider logout openai-codex
```

支持 --data-root。浏览器模式打印授权网址，需要交互终端；设备码可用于无回调终端。Ctrl+C 取消，最长15分钟。auth-status 仅本地检查、无联网；ready 不证明额度和连通性，refresh_required 由执行时 SDK 尝试刷新。私有凭据跨进程加锁并原子保存，保留其他厂商/飞书；不复制全局登录。logout 只删本地凭据，不撤销服务器授权或取消当前请求。
models 离线列出内置ID及 enabled；登录不扩大能力清单。保留原 pi/runtime.json 项，显式加入 openai-codex 与所需模型ID后空闲重启。YAML 用 runtime: pi、model: openai-codex/<已启用ID>，可省略 credentialRef；不允许 custom 端点。订阅 Token 正常记录，费用未知，不套用 API 单价。不要为了检查擅自发真实模型请求。

pi/runtime.json（示例只启用一个内置模型）：

```json
{"schemaVersion":1,"providers":[{"id":"zai-coding-cn","models":["glm-5.3"]}]}
```

pi/auth.json（只在私有数据根保存，不写入项目仓库）：

```json
{"zai-coding-cn":{"type":"api_key","key":"<由用户本地填写>"}}
```

pi 目录不得允许其他用户写入，建议 0700。未内置的 Provider 还需显式 custom 配置（api、baseUrl、contextWindow、maxTokens、reasoning），不能直接把自定义 ID 当作内置模型。缺少准确地址/API 协议时先请用户提供脱敏配置，不猜测；不要把 Key 发到对话里。

标准编码 Work 提供文件读写、精确 edit_file、rg 搜索、受监督 execute_command 和目录 AGENTS.md 查询；默认启用可信 SDK Codemode，提示模型批量读取/搜索。命令默认十分钟，超时会终止当前 Invocation 并核验整组进程。Task 只做相关测试，正式提交、推送与验收由 Core 管理。

规划已接 planning_candidate_submit 最小权限桥；仅允许读取/搜索及提交候选，不开放 Shell/写文件，不自动批准。选定项目 Skills 经 Core 实际加载/摘要核验；不隐式扫描全局 Skills、MCP 或插件。

生产政策支持 policies.piAgent（连续重试与切备选）、piExecution（请求/输入/输出/思考档/命令时限/Codemode）、featureAutoFix（失败修复，默认 high/三次）、deliveryPolicy.auto_push 和 feishu。完整字段、显式预算、私有飞书凭据和恢复边界见 [production-runtime.md](production-runtime.md)。
