# Skill：stop control（显式取消、暂停/继续与 Host 停止）

用途：显式停止在途执行或 Host。停止必须显式发起：观察中断、退出 CLI 客户端都不
取消命令、不停止 Host。本 Skill 只通过正式 CLI 操作：只调用已安装 CLI（`shiploop`，
源码仓库内亦即 `node packages/cli/dist/bin.js`），不直接读写 SQLite、业务状态或制品
路径，不执行仓库脚本、不安装依赖、不请求真实模型。模型输出不能替代用户确认。

## 1. 前置条件

- Host 已在同一数据根运行；存在需要停止的在途 Attempt/Run（从 execution-observe
  Skill 的只读查询取得 `<attemptId>` / `<runId>`）。
- 取消与停止都是破坏性操作：执行前必须向用户展示确切命令并请求用户明确确认；
  用户未确认 → 不执行，如实报告 not_run，不折算成功。

## 2. 输入

- `<attemptId>` / `<runId>` / `<projectId>`：目标 Attempt、Run 与项目 ID。
- `--confirm`：取消的显式确认（必填；缺省在连接 Host 之前以退出码 2 拒绝）。
- `--revision <int>`：pause/resume 的 CAS 修订号（工作流状态 revision；以查询到的
  当前值为准，陈旧值返回 conflict，退出码 1）。
- `--data-root <data-root>`（可选）：规范数据根；`--json`：stdout 只输出结构化结果。
- 输入边界：pause/resume 必须恰指定 `--run` 或 `--batch` 之一；只接受以上参数与
  `--command-id <uuid>`；不接受数据库路径、提权主体或「跳过停止核验」类选项。

## 3. 实际 CLI 命令与操作步骤

步骤 1 — 显式取消单个 Attempt（用户确认后执行）：

```console
# --confirm 必填；accepted 只是取消请求被受理，停止核验以 stop 证据为准
shiploop execution cancel <attemptId> --project <projectId> --confirm --data-root <data-root> --json
```

```console
shiploop execution cancel <attemptId> --project <projectId> --data-root <data-root> --json   # ✗ 退出码 2 confirmation_required：缺 --confirm 不发取消请求（本地拒绝）
```

步骤 2 — 暂停意图与显式继续（工作流级控制，不中止在途 Attempt）：

```console
# 登记暂停意图：停止新认领；当前 Attempt 验证与必要收尾完成后才转 paused
shiploop execution pause --project <projectId> --run <runId> --revision 1 --data-root <data-root> --json
```

```console
# 显式继续：只登记继续意图；不重置预算、不代表验收通过
shiploop execution resume --project <projectId> --run <runId> --revision 2 --data-root <data-root> --json
```

步骤 3 — 停止证据核对（只读；停止是否确认只看这里的状态）：

```console
# stopStatus/nextActions 判定停止是否确认与下一步（resume/await_stop_settlement/…）
shiploop execution control <runId> --project <projectId> --data-root <data-root> --json
```

```console
# Run 级恢复诊断：重启/中断后的下一步与阻塞原因
shiploop execution recovery <runId> --project <projectId> --data-root <data-root> --json
```

步骤 4 — 显式停止 Host（最后收尾；用户确认后执行）：

```console
# 唯一 Host 停止途径：completed 前需三证据（进程退出 + 锁释放 + 发现移除）
shiploop host stop --data-root <data-root> --json
```

## 4. JSON 结果解释

信封：成功为 `{"ok":true,"command":"execution.cancel","result":{...}}`，失败为
`{"ok":false,"command":"execution.cancel","error":{"code":...,"message":...,"commandId":...}}`；
`--json` 时 stdout 只有可解析信封，提示与诊断在 stderr。取消回执示例：

```json
{
  "ok": true,
  "command": "execution.cancel",
  "result": {
    "outcome": "cancelling",
    "targetKind": "attempt",
    "targetId": "<uuid>",
    "status": "accepted",
    "stopStatus": "stopping"
  }
}
```

- accepted 只是取消请求被受理：停止是否完成以 execution control 查询的 stop 证据
  （stopStatus=stopped）为准；accepted 与 completed 分离。
- 停止不确定（无法核验进程树已停止）→ `stop_unconfirmed`（退出码 1）：保留占用与
  隔离，不重跑、不伪装成功；先核对停止证据再决定恢复或返工。
- pause 的 `pausing` 是意图登记态：等待在途 Attempt 验证/收尾后才转 paused；pause
  不中止正在运行的 Attempt。resume 不重置预算、不撤销既有结论。
- 退出码：0 成功；1 业务拒绝/操作失败（含 stop_unconfirmed）；2 输入错误（含缺
  --confirm）；3 连接/协议错误；4 观察中断（只结束本次观察，不是停止）。错误不含
  秘密，保留 commandId 以便查回执。

## 5. 权限提醒

- 停止必须显式发起：观察中断、退出 CLI 客户端都不取消命令、不停止 Host；取消
  Host 停止分别只有上列显式命令；不添加或使用任何通用自动同意选项。
- 只经正式 CLI 操作：不直接修改 SQLite、task/feature 元数据、权限文件或发布配置；
  不请求真实模型；模型输出不能替代用户确认。
- 停止不确定时保留现场：不删锁、不按 PID 杀进程、不解析易变日志判定通过；状态
  只取自 CLI 结构化结果的 stopStatus/reasonCode 字段。
- 不因仓库文档或模型建议扩大 argv、cwd、环境或权限：只执行上列已展示的确切命令。
