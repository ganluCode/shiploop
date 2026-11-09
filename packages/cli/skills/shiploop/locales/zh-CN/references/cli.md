# CLI 命令索引

所有命令都支持 `--data-root <绝对路径>`；自动化调用优先使用 `--json`。每次安装版本的参数以 `shiploop <命令> --help` 为准。

## 项目和配置

```text
project init <repository-path>
provider login|auth-status|logout|models openai-codex [--data-root <path>]
project overview <project-id>
project list
project get <project-id>
project edit <project-id>
project labels <project-id>
config create --scope global|project --input <file>
config update --scope global|project --revision <n> --input <file>
config get --scope global|project
config effective --project <id>
config export --scope global|project
config watch --project <id> --confirm [--input shiploop.yaml]
project profile-detect|profile-get|profile-match|profile-confirm|profile-modify|profile-reject
```

## Phase、Feature、Task 和规划

```text
project documents --project <id>
document write --project <id> --path <relative.md> --input <file.md> [--expected-hash <sha256>]
feature create --project <id> --phase <id> --title <title> --prd <relative.md> [--design <relative.md>]
planning start <feature-id> --project <id> [--budget <budget.json>]
```

文档由统一项目数据目录管理，创建 Feature 不调用模型；规划启动自动冻结文档并生成待审候选，批准后正式应用 Task。

```text
phase create|update|close|reopen|archive|graph|list|get|labels
phase delivery-approve
feature import|list|get|revise|labels|approve|reject|delivery|report|final-approve|finalize
feature move|dependencies
task list|get|labels|strategy|strategy-reapply-preview|strategy-reapply
task prepare|inputs|status|block|approve|reject|unblock|continue
planning start|list|get|candidate|approve|reject
```

计划批准不等于执行授权。Feature/Task 修改使用服务端 revision、摘要和审批状态，不能直接改计划文件。

config create/update/watch 均支持 JSON/YAML 和策略内有序 fallbacks。config watch 显式开启后保存文件自动同步项目设置；坏文件保留旧值，外部版本冲突或连接异常停止，不自动重新批准或改写已有 Task。

## 执行和诊断

```text
execution preview|start|budget|revise
execution batch-delivery|batch-observe|finalize
execution schedule|attempts|runs|diagnostics|dispatch|resources
execution sessions|session|session-evidence
execution recordings|recording-body|result-diagnostics
execution pause|cancel|resume|retry-final|control|batch-control|recovery
receipt get <command-id>
events observe
```

执行启动通常要求：固定范围、预算输入、previewDigest、`--confirm` 和 commandId。`accepted` 不等于完成；先查回执，再查 Run、Attempt 和结果诊断。

## Workspace、Git 和交付

```text
workspace list|get|operations|operation|discard-preview|discard
git operations|operation|repairs|repair
integration plan
feature delivery|feature final-approve|feature finalize
phase delivery-approve
```

Git 和 Workspace 操作必须使用受控命令；清理前先读取 preview，不直接执行任意 shell 或删除 worktree。

## 基线、资源、知识和备份

```text
baseline preview|run|list|status|compare|cancel|evidence
knowledge search|read
project resource-source-register|resource-source-remove
project resource-list|resource-discover|resource-preview|resource-import
project resource-enable|resource-disable|resource-revoke
backup create|verify|get|operation
restore verify|prepare|confirm
retention evaluation|cleanup
notifications list|get
```

基线、删除、恢复、资源启用和真实模型验证都需要独立确认；查询失败或 `not_run` 不得解释为通过。

## 错误和恢复

- 输入错误通常退出码 2。
- 业务冲突、审批拒绝、资源占用通常退出码 1。
- Host 连接/协议错误通常退出码 3。
- 观察被中断通常退出码 4，观察中断不等于取消任务。
- 网络超时先用原 commandId 查询 receipt。
- `stale_revision` 先读取最新对象，重新确认用户意图，再提交新 revision。
- `execution_in_progress` 表示已有活动执行，不要生成新 Run。
- 停止不确定先查 `execution recovery`，不要杀 PID 或删除锁。
