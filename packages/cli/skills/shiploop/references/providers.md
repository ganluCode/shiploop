# Provider 和模型配置

配置使用 ShipLoop 的全局或项目设置，不读取全局 Pi CLI 的当前模型。

```json
{
  "schemaVersion": 2,
  "strategies": {
    "modelMap": {
    "low": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "credential://<name>"
    },
    "medium": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "credential://<name>"
    },
    "high": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "credential://<name>"
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
