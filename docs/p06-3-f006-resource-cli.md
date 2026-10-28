# 项目 Skills/MCP 资源命令

通过项目 Host 操作，查询需要项目读取权限，导入、启用、停用和撤销需要项目写入授权。资源配置仅影响新的执行；Skills/MCP 不授予审批、验收、增额、人工丢弃或 owner 权限。

```text
shiploop project resource-list --project <id> --json
shiploop project resource-discover --project <id> --source <source-id> --json
shiploop project resource-preview --project <id> --source <source-id> [--selected <resource-id>] --json
shiploop project resource-import --project <id> --source <source-id> --source-digest <sha256> --candidate <id> --candidate-digest <sha256> --revision <n> --command-id <uuid> --confirm --json
shiploop project resource-enable --project <id> --resource <id> --revision <n> --command-id <uuid> --confirm --json
shiploop project resource-disable --project <id> --resource <id> --revision <n> --command-id <uuid> --confirm --json
shiploop project resource-revoke --project <id> --resource <id> --revision <n> --command-id <uuid> --confirm --json
```

来源 ID 由可信项目来源目录提供，不能传文件路径或凭据。首次资源配置的 revision 为 0；之后使用当前列表返回的 revision。断线后以同一 command ID 和同一请求核对回执，不以新身份盲目重试。

## 用户显式登记来源

默认 Host 已装配项目来源目录，无需代码注入。用户先创建符合资源 manifest v1 的 JSON 文件，选择一个稳定 source UUID，通过管理 CLI 显式确认：

```bash
shiploop project resource-source-register --project <project-id> --source <source-uuid> --manifest-file <absolute-manifest-path> --revision 0 --confirm --json
shiploop project resource-discover --project <project-id> --source <source-uuid> --json
shiploop project resource-preview --project <project-id> --source <source-uuid> --json
```

登记只允许用户 owner 管理入口；`--manifest-file` 是本操作专用的明确路径授权，日常发现、预览和导入仍只接受 source ID。Core 校验项目存在与权限、manifest 版本与正文结构，拒绝符号链接、目录、超限文件与伪造主体字段。不会全局扫描、启动 MCP 或执行 Skill。登记不等于导入、启用或批准执行。

目录保存在 Host 数据根的 `project-resource-sources.json`（0600），由 Host 唯一写锁保护，同步 CAS 与原子替换，按 projectId/sourceId 隔离；不新增业务 SQLite 迁移。来源路径不进入公开响应、Skill、输入快照或普通日志。重启重新读取严格校验目录，损坏或权限异常不静默重建。

来源 revision **独立于** resource-list 的配置 revision：首次登记使用 0，后续更新或移除使用登记响应返回值。相同请求可安全重试；移除保留 tombstone 防止旧登记复活，不删除原文件、不撤销已有资源。manifest 正文变更会改变发现摘要，旧预览的导入必须重新确认。

```bash
shiploop project resource-source-remove --project <project-id> --source <source-uuid> --revision <source-revision> --confirm --json
```

## 用户管理与 Agent 通道

普通 CLI 是用户管理工具，沿用 owner 连接，**不是 Agent 的受限入口**。Agent 复用 P04 的 `createWorkToolClient` 和 `/v1/work/tools`；凭据由可信 Host/Runner 交接，不进入模型提示词、Skill 或 argv。只开放既有获准操作，登记、导入与启用资源不自动加入 Work 操作集。

受限凭据不能调用来源管理路由；撤销、失效或重启后拒绝，由可信控制层核验后重签，绝不发现或回退 owner、启动替代 Host。验收覆盖真实有效 Work 凭据无法登记来源，以及撤销后受限调用失败。可信项目模式并非 OS 沙箱，不能防御同 OS 用户恶意 shell 主动读取 owner 文件；不宣称普通 CLI 已具备受限认证模式。
