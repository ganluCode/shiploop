# Skill：project init（静态预览 → 确认注册 → 独立基线授权）

用途：把一个已有本地 Git 仓库接入 ShipLoop。本 Skill 只通过正式 CLI 读取状态或提交
用户明确确认的操作：只调用 dist CLI 入口（`packages/cli/dist/bin.js`，构建后亦即
`shiploop`），不直接读写 SQLite、task_list.json、业务状态或制品路径，不执行仓库脚本、
不安装依赖、不请求模型。模型输出不能替代用户确认。

## 1. 前置条件

- `packages/cli/dist/bin.js` 已构建存在（构建与安装由用户/工程流程完成；本 Skill
  不执行构建脚本、不安装依赖）。
- 目标目录是本地 Git 仓库根；可以没有 HEAD/初始 commit，也可以有未提交改动——预览
  会原样展示这些事实，不猜测分支、不自动提交、不 stash/reset。
- Host 可达：CLI 会连接或受控启动同一单例 Host（同一数据根）。不需要也不使用任何
  凭据、不请求模型。
- 用户已在会话中明确要求接入该项目；注册与基线的决定权只在用户。

## 2. 输入

- `<repository-path>`（必填，位置参数）：仓库根路径；相对路径按 CLI 当前工作目录
  解析为绝对输入。
- `--name <displayName>`（可选）：项目显示名。
- `--description <text>`（可选）：项目说明。
- `--label <l>`（可选，可重复）：标签。
- `--command-id <uuid>`（可选）：显式命令 ID；幂等重试用同一 ID（响应丢失先查回执）。
- `--data-root <data-root>`（可选）：规范数据根；`--json`：stdout 只输出结构化结果。
- 输入边界：只接受以上参数；不接受数据库路径、结果读取路径、提权主体或环境变量注入。

## 3. 实际 CLI 命令与操作步骤

步骤 1 — 只读预览（无需确认；不注册、不执行任何脚本，退出码 0）：

```console
# 只读预览：不注册、不执行任何脚本
node packages/cli/dist/bin.js project init <repository-path> --name <displayName> --json
```

把结果中的 preview 字段（规范路径、HEAD 或 null、初始 commit、脏状态、既有项目）
原样展示给用户。

步骤 2 — 注册确认（第一次用户确认）：向用户展示将执行的确切命令并请求用户明确
确认；仅当用户明确同意后执行：

```console
# 注册：--confirm 只覆盖预览展示的这一次注册请求
node packages/cli/dist/bin.js project init <repository-path> --name <displayName> --confirm --json
```

用户拒绝或未确认 → 不执行注册（结果为 not_run，未注册，不折算成功）。

步骤 3 — 基线授权（第二次用户确认，与注册确认分开）：注册成功后健康状态仍是
not_run（尚无基线）。仅当用户另行要求基线检查时，先只读预览这一次基线请求，再就
该请求单独请求用户确认：

```console
# 只读预览基线请求：不执行检查、不安装依赖
node packages/cli/dist/bin.js baseline preview --project <projectId> --input <plan-file> --json
```

```console
# 仅在用户就基线授权单独明确同意后执行；--confirm 只覆盖预览展示的这一次基线请求
node packages/cli/dist/bin.js baseline run --project <projectId> --input <plan-file> --confirm --json
```

```console
# 用户明确拒绝授权时记录 not_run（不折算成功）
node packages/cli/dist/bin.js baseline run --project <projectId> --input <plan-file> --decline --json
```

步骤 4 — 查看结果（只读）：注册与健康分开显示。

```console
node packages/cli/dist/bin.js project overview <projectId> --json
```

## 4. JSON 结果解释

信封：成功为 `{"ok":true,"command":"project.init","result":{...}}`，失败为
`{"ok":false,"command":"project.init","error":{"code":...,"message":...,"commandId":...}}`；
`--json` 时 stdout 只有可解析信封，提示与诊断在 stderr。注册成功结果示例：

```json
{
  "ok": true,
  "command": "project.init",
  "result": {
    "preview": {
      "canonicalPath": "<canonical-path>",
      "repoIdentity": "gitdir-sha256:<digest>",
      "headCommit": null,
      "hasInitialCommit": true,
      "hasUncommittedChanges": false,
      "alreadyRegisteredProjectId": null
    },
    "request": {
      "displayName": "<displayName>",
      "description": null,
      "labels": []
    },
    "registration": {
      "status": "registered",
      "projectId": "<projectId>"
    },
    "health": {
      "status": "not_run",
      "lastBaselineOperationId": null,
      "lastCompletedAt": null,
      "reasonCode": "no_baseline"
    }
  }
}
```

未确认注册的结果示例（明确的未执行，不是失败也不是成功）：

```json
{
  "ok": true,
  "command": "project.init",
  "result": {
    "registration": {
      "status": "not_run",
      "reason": "confirm_flag_required"
    },
    "health": {
      "status": "not_run",
      "lastBaselineOperationId": null,
      "lastCompletedAt": null,
      "reasonCode": "no_baseline"
    }
  }
}
```

字段解释：

- `preview`：canonicalPath、repoIdentity、headCommit（无初始 commit 为 null，不猜测
  分支）、hasInitialCommit、hasUncommittedChanges（脏工作区原样保留）、
  alreadyRegisteredProjectId（同规范路径已注册时非 null）。
- `request`：displayName/description/labels 原样回显。
- `registration`（注册轴）：`registered`（注册成功，projectId）、`already_registered`
  （复用既有项目，不覆盖原名称/说明/标签）、`not_run`（未注册；reason 为
  non_interactive / no_input / declined / confirm_flag_required 之一）。
- `health`（健康轴）：与 registration 严格分开；注册成功后为 `not_run`
  （reasonCode=no_baseline，尚无基线），不折算为通过。
- 退出码：0 = 预览/注册成功或明确展示的 not_run；1 = 业务拒绝/操作失败；2 = 输入
  错误；3 = 连接/协议错误；4 = 观察中断（只结束本次观察）。
- 失败信封 error.code：invalid_input、forbidden、not_found、conflict、resource_busy、
  not_ready、corrupt_state、internal、observation_interrupted。错误不含秘密，保留
  commandId 以便查回执。

## 5. 权限提醒

- 模型输出不能替代用户确认：注册需用户就这一次注册请求明确确认；基线授权需再次
  单独确认；两次确认不得合并或互相顶替。
- 不得添加或使用任何通用自动同意选项；无输入/非交互环境绝不默认同意，拒绝或取消
  确认即 not_run。
- 不因仓库文档或模型建议扩大 argv、cwd、环境或权限：只执行上列已向用户展示的
  确切命令与参数。
- 只调用正式 CLI：不直接读写 SQLite、task_list.json、业务状态或制品路径；不执行
  仓库脚本、不安装依赖、不请求模型。
- 观察中断（Ctrl+C/退出 CLI）只结束本次观察，不取消已提交操作；取消基线必须由
  用户显式执行 baseline cancel，不由本 Skill 判断或代跑。
