# 项目 YAML 配置与备用模型

界面/回复语言 `locale` 仅属全局配置，支持 `en-US`（默认）和 `zh-CN`。不要加入项目 shiploop.yaml；通过 `--scope global` 提交。更新是整个 payload 替换，必须保留现有模型、政策和其他字段。

## 用户要求创建配置时

1. 检查项目根目录是否已有 shiploop.yaml、shiploop.yml 或配置 JSON；有则先读取并作局部修改，不覆盖用户注释和未涉及字段。
2. 读取项目当前配置和已装配的模型资料，向用户确认 low/medium/high 及 planner 的分配、备用顺序。没有确认的档位留空或保留注释，不猜能力和额度。
3. 以 [templates/shiploop.yaml](../templates/shiploop.yaml) 为基础，在实际项目根目录生成 shiploop.yaml。模板中的厂商/模型只是示例，必须核对当前能力目录；创建文件不等于保存到数据库或授权模型调用。
4. 每个策略填写 runtime；可省略 provider，写成 model: provider/model。Pi 的 credentialRef 可省略，文件读取时补为 credential://pi/<provider>；它只生成引用，不创建或复制 Key。Key 只能留在 ShipLoop 私有数据目录，禁止写入项目文件、日志或对话。备用项不嵌套，不重复主/备模型身份。
5. 展示生成路径、已确认的模型顺序和未决定项。只在用户明确要求同步/监视后执行下面命令；不暗自启动后台监视或执行 Run。

## 手工提交

简写适用于 JSON/YAML 的 config create/update/watch，包括默认策略、low/medium/high、用途策略、Agent 覆盖、备用链和自动修复 strategy：

```yaml
schemaVersion: 2
strategies:
  modelMap:
    medium:
      runtime: pi
      model: ark-agentplan/ark-code-latest
      fallbacks:
        - runtime: pi
          model: zai-coding-cn/glm-5.3
```

省略 provider 时按第一个斜杠拆分；后面的斜杠属于模型 ID。显式写 provider 时，model 按原始模型 ID 使用，不再拆分，避免破坏 org/model。两种格式不要混填；runtime 不自动猜测。显式 credentialRef 保留并交由原校验核验；非 Pi 不自动生成凭据引用。数据库和直接 HostClient 请求仍使用展开后的正式字段。实际 Provider/Model/私有凭据必须先配置，简写不绕过能力、审批和预算检查。

JSON 与 YAML 均可用于 config create/update 的 --input。JSON 仍是严格 JSON，不支持注释；需要注释使用 .yaml 或 .yml。

```bash
shiploop config create --scope project --project "$PROJECT_ID" --input ./shiploop.yaml --json
# 已有配置：先 config get 获取最新 revision，再 config update --revision <n>。
```

## 保存自动同步

```bash
shiploop config watch --project "$PROJECT_ID" --confirm
# 默认当前目录 shiploop.yaml；其他位置或 JSON 使用 --input <file>。
```

这是显式开启的持续 CLI 进程，不是永久注册给 Host 的后台监听。需要后台运行时先取得用户授权、保存 PID 和日志。Host 重启或连接失败后需查原回执并重新启动监视。

- 初次将文件经标准 Host 命令写入项目配置；之后内容相同或只改注释不增加 revision。
- 监视期间 YAML/JSON 写坏或 Schema 拒绝：告警并保留数据库旧值，修正文件后继续。
- 其他客户端更新了数据库版本：告警并退出，不覆盖 UI/其他 Agent 的配置。
- 写命令超时先查同一 commandId 回执，结果未知时停止并保留 ID，不换新 ID 盲写。
- Ctrl+C/SIGTERM 只停止文件监视，不停止 Host、Run 或正在执行的 Task。

## 有序降级

fallbacks 是同一 Task 获批策略中的有序备用链。无备用列表时保持原行为。默认对限流、耗尽重试后的连接/服务端失败及认证失败启用切换；fallbackPolicy 可对某类设置 stop。

每次切换仍需 Core 核验旧执行已停止、必要录制完整、工作区可复用、授权有效和预算充足，才创建新 Attempt。工具错误、测试失败、协议/配置问题不通过换模型掩盖。全部备用不可用或停止不确定时停止。不能承诺同一 Session 跨模型恢复。

每个新 Task 从其冻结的首选模型重新开始，不把前一个 Task 的备用模型变成全局默认。当前生产入口没有持久接入厂商重置时间，不猜测冷却时间，也不发送 hi 探测。

## 生效范围

修改文件/数据库只更新默认配置；当前 Task、已批准的 Task、已有 Attempt/Batch 快照不被自动改写。已有未执行 Task 要改模型或备用链，使用 task strategy-preview / task strategy-reapply 的显式预览、CAS 和确认流程；可能需要重新批准，不绕过门禁。

这里的 shiploop.yaml 是项目策略，不是私有 pi/runtime.json 能力清单或 pi/auth.json 凭据库。能力清单仍需重启 Host；普通策略保存不需重启。

标准 Pi 的规划候选提交桥已接通；规划结果仍须经正式接口审阅与批准，不把候选提交当自动批准。规划降级的范围依现有 Core 约束，不套用编码 Task 的全部切换保证。

重试、Codemode、自动修复、auto_push 和飞书政策也能放入项目 YAML/JSON，详见 [production-runtime.md](production-runtime.md)。模板默认不开修复、远端推送或外部通知；开启前必须核对预算、Git 身份及私有凭据。
