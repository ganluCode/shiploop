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

当前限制：可信嵌入方可向 `startHost` 注入 `projectResourceSources`；默认 Host 未装配来源目录，因此无法发现或导入来源。普通 CLI 通过既有 owner Host 连接，目前没有受限主体 CLI 凭据接线；受限 Work 通道不能由该命令替代。来源登记与受限身份入口需另行确定，不要将局部测试通过解释为资源管理已交付。
