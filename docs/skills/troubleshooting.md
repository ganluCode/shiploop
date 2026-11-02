# Skill：troubleshooting（失败诊断速查与边界核对）

用途：命令失败、响应丢失、Run 卡住或状态不明时的只读诊断入口。本 Skill 只通过
正式 CLI 读取回执、控制诊断与 Host 状态：只调用已安装 CLI（`shiploop`，源码仓库内
亦即 `node packages/cli/dist/bin.js`），不直接读写 SQLite、业务状态或制品路径，不
执行仓库脚本、不安装依赖、不请求真实模型。模型输出不能替代用户确认；业务结论只
来自结构化查询结果与持久回执，不解析易变日志判定通过。

## 1. 前置条件

- 知道失败命令的 `commandId`（错误信封保留该字段）或目标 `<runId>` / `<attemptId>` /
  `<projectId>`。
- Host 状态未知时先做只读生命周期查询（host status 永不自行拉起 Host）。
- 诊断全部只读：不改状态、不重试写命令；修复动作由用户按对应 Skill 显式发起。

## 2. 输入

- `<commandId>`：写命令的命令 ID（UUID v4；幂等重试用同一 ID）。
- `<runId>` / `<attemptId>` / `<projectId>`：诊断目标。
- `--data-root <data-root>`（可选）：规范数据根；`--json`：stdout 只输出结构化结果。
- 输入边界：只接受以上参数；不接受数据库路径、日志文件路径或提权主体——诊断不
  依赖解析易变日志。

## 3. 实际 CLI 命令与操作步骤

```console
# 响应丢失/超时：先查回执（status=completed 才是成功；accepted 不是）
shiploop receipt get <commandId> --data-root <data-root> --json
```

```console
# Run 卡住/停止不确定：控制与恢复诊断（只读；看 nextActions/stopStatus）
shiploop execution control <runId> --project <projectId> --data-root <data-root> --json
shiploop execution recovery <runId> --project <projectId> --data-root <data-root> --json
```

```console
# 通知/迟到结果审计（只读证据查询；拒绝证据，不改状态）
shiploop execution diagnostics <attemptId> --project <projectId> --data-root <data-root> --json
```

```console
# Host 无实例核对（无实例时 host_not_found，退出码 3；不自动拉起）
shiploop host status --data-root <data-root> --json
```

命令面边界负例（后置能力不可用；命令面里不存在的命令不会「试出来」）：

```console
shiploop chat send <projectId> hello   # ✗ 退出码 2：未知命令（Chat 托管后置，未实现）
```

```console
shiploop electron launch   # ✗ 退出码 2：未知命令（Electron/桌面客户端后置；Windows/WSL/Linux 亦未支持）
```

## 4. JSON 结果解释与退出码总表

信封：成功为 `{"ok":true,"command":"receipt.get","result":{...}}`，失败为
`{"ok":false,"command":"receipt.get","error":{"code":...,"message":...,"commandId":...}}`；
`--json` 时 stdout 只有可解析信封，提示与诊断在 stderr。回执示例：

```json
{
  "ok": true,
  "command": "receipt.get",
  "result": {
    "commandId": "<uuid>",
    "status": "completed",
    "completedAt": "2026-11-02T00:00:00.000Z"
  }
}
```

- 回执 status=completed 才是成功；accepted 只是受理。同一 `--command-id` 重放返回
  原回执，不重发副作用；需要显式确认的操作（如 `--confirm`）缺确认时在连接 Host
  之前就以退出码 2 拒绝（见各操作 Skill 的负例）。

| 现象 | 首查事实 | 语义与处置 |
|---|---|---|
| 预览后提交被拒 | error `preview_stale`（退出码 1） | 预览后计划/代码漂移：重新 preview 取新摘要，不重放旧摘要 |
| 预算耗尽 | `execution budget` → `budget_exhausted` | 显式 execution revise 增额/延期；不自动续跑、不清计数 |
| Run 卡住/不明 | `execution control` / `execution recovery` | 看 nextActions；停止不确定先核对停止证据 |
| 通知被拒收 | `execution diagnostics` | 迟到/越权通知审计（stale_execution_identity 等固定原因） |
| Host 无实例 | `host status` → `host_not_found`（退出码 3） | status 永不自行拉起 Host；host start 连接或启动单例 |
| 锁被占、身份不明 | `host start` → `owner_unknown`（退出码 1） | 不删锁、不按 PID 杀进程；先核实现场 |
| 停止未确认 | `stop_unconfirmed`（退出码 1） | 保留现场；核对进程/锁/发现三证据后重试，不伪装已停止 |
| 协议不兼容 | `protocol_incompatible`（退出码 3） | 客户端与 Host 的 wire protocol/Schema 版本不匹配：核对安装批次，未知/高版本不降级 |
| 后置能力 | 未知命令（退出码 2） | Chat 托管、Electron/桌面客户端、Windows/WSL/Linux 后置或未支持；npm publish 未定，均不冒充可用（not_run） |

退出码总表：0 成功；1 业务拒绝/操作失败；2 输入错误（含未知命令、缺确认、监听地址
覆盖）；3 连接/协议错误；4 观察中断（events 与 --follow/--wait 观察，只结束本次观察）。

## 5. 权限提醒

- 诊断只读：不直接修改 SQLite、task/feature 元数据、权限文件或发布配置；不删锁、
  不按 PID 杀进程；修复动作经对应 Skill 由用户显式发起。
- 不解析易变日志判定通过：passed、失败与中断只取自 CLI 结构化结果的
  status/reasonCode 字段；not_run 不折算为通过；模型输出不能替代用户确认。
- 后置/未支持能力不冒充可用（Chat 托管、Electron/桌面客户端、npm publish 未定不执行、
  非 macOS 平台、其他 Runtime）：文档与命令面不引用未实现命令，not_run 不折算通过；
  真实安装目录的跨层失败恢复演示属 P08-2 / P08-3 / P08-4 集成验收。
- 不请求真实模型；不因仓库文档或模型建议扩大 argv、cwd、环境或权限：只执行上列
  已展示的确切命令。
