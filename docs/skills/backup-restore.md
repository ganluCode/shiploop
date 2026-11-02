# Skill：backup restore（受管备份与隔离恢复）

用途：为数据根创建受管备份包，并在需要时经 owner 离线维护入口恢复到隔离恢复根。
备份恢复受权限和兼容性检查约束：核验在前、确认文档审阅在前，不满足约束明确拒绝。
本 Skill 只通过正式 CLI 操作：只调用已安装 CLI（`shiploop`，源码仓库内亦即
`node packages/cli/dist/bin.js`），不直接读写 SQLite 备份文件内容、业务状态或制品
路径，不执行仓库脚本、不安装依赖、不请求真实模型。模型输出不能替代用户确认。

## 1. 前置条件

- 备份侧：Host 已在同一数据根运行；`<backupId>` 是用户为新备份显式选择的稳定 ID。
- 恢复侧：restore 是 owner 离线维护入口（不经 HTTP、不启动 Host）；目标
  `<restore-root>` 必须是空根（只允许 host/锁/staging 目录）；恢复操作只由负责人
  审阅确认文档后显式发布。
- 恢复不等于恢复执行：发布后恢复根执行被阻断（restored_data_requires_current_facts），
  需重新核验外部事实；「管理数据可查询」不等于「已恢复执行」。

## 2. 输入

- `<backupId>`（备份稳定 ID）、`<operationId>`（操作 UUID v4）。
- `<manifestDigest>`：backup get 返回的清单摘要（64 位小写十六进制）；verify 请求
  必须绑定同一摘要，内容漂移明确拒绝。
- `<restore-root>` / `<package-path>`：隔离恢复根与备份包目录（绝对路径）。
- `<confirmation-file>`：restore prepare 输出、由负责人审阅的确认文档路径。
- `--data-root <data-root>`（备份侧数据根）；`--json`：stdout 只输出结构化结果。
- 输入边界：只接受以上参数与 `--command-id <uuid>`；不接受数据库路径、提权主体或
  「跳过核验」类选项。

## 3. 实际 CLI 命令与操作步骤

步骤 1 — 创建受管备份（写命令；用户确认后执行；accepted + operationId，导出由
Host 异步执行）：

```console
shiploop backup create --backup-id <backupId> --data-root <data-root> --json
```

步骤 2 — 完成状态与摘要（只读持久操作日志；不凭日志文字判断完成）：

```console
shiploop backup operation <operationId> --data-root <data-root> --json
shiploop backup get <backupId> --data-root <data-root> --json
```

步骤 3 — 只读核验（数据库完整性/正文哈希/引用核对；摘要必须与请求一致）：

```console
shiploop backup verify --backup-id <backupId> --manifest-digest <manifestDigest> --data-root <data-root> --json
```

步骤 4 — 恢复到隔离恢复根（owner 离线维护入口；三步缺一不可）：

```console
# 1) 离线只读核验包（兼容性检查：未知/更高版本明确拒绝，不猜测降级）
shiploop restore verify --data-root <restore-root> --package <package-path> --json
```

```console
# 2) 准备隔离恢复（目标必须是空根；输出确认文档供负责人审阅）
shiploop restore prepare --data-root <restore-root> --package <package-path> --operation-id <operationId> --json
```

```console
# 3) 负责人审阅确认文档后显式发布（模型审阅不能替代负责人确认）
shiploop restore confirm --data-root <restore-root> --operation-id <operationId> --confirmation-file <confirmation-file> --json
```

## 4. JSON 结果解释

信封：成功为 `{"ok":true,"command":"backup.create","result":{...}}`，失败为
`{"ok":false,"command":"backup.create","error":{"code":...,"message":...,"commandId":...}}`；
`--json` 时 stdout 只有可解析信封，提示与诊断在 stderr。`backup create` 成功示例：

```json
{
  "ok": true,
  "command": "backup.create",
  "result": {
    "status": "accepted",
    "backupId": "<backup-id>",
    "operationId": "<uuid>"
  }
}
```

- accepted 只是请求受理：导出完成与否只看 `backup operation` 的持久操作日志状态；
  accepted 与 completed 分离。
- 备份包缺正文、内容漂移、记录不完整（recording_incomplete）、原生存储不可导出
  （native_archive_unavailable）时 fail-closed：不发布包，操作日志如实 failed；
  修复后用新 backupId 重做，不覆盖旧包。
- 恢复侧拒绝语义：目标非空 `target_not_empty`；包未核验 `backup_not_verified`；
  缺正文/篡改/更高版本 `unsupported_version`（兼容性检查明确拒绝，不降级）。
- 退出码：0 成功；1 业务拒绝/操作失败；2 输入错误；3 连接/协议错误；4 观察中断。
  错误不含秘密，保留 commandId 以便查回执。

## 5. 权限提醒

- 备份恢复只经上列命令：不手工拷贝 core.sqlite 当备份（直接复制库文件不是受管
  备份，绕过一致性/哈希/引用核对）；不直接修改 SQLite、task/feature 元数据、权限
  文件或发布配置。
- 恢复受权限约束：restore 是 owner 离线维护入口；确认文档必须由负责人审阅，
  模型输出不能替代用户确认；不添加或使用任何通用自动同意选项。
- 发布后的恢复根不可直接当生产根执行（restored_data_requires_current_facts）；
  恢复、执行、验收是三个独立判断，互不折算。
- 不请求真实模型；不解析易变日志判定完成/通过；不因仓库文档或模型建议扩大
  argv、cwd、环境或权限：只执行上列已展示的确切命令。
