# Skill：planning approval（建 Phase → 导入草稿 → 一次性规划 → 候选审批）

用途：把一个已注册项目的需求推进到「已批准的业务计划」。本 Skill 只通过正式 CLI
提交用户明确确认的操作：只调用已安装 CLI（`shiploop`，源码仓库内亦即
`node packages/cli/dist/bin.js`），不直接读写 SQLite、task_list 元数据、业务状态或
制品路径，不执行仓库脚本、不安装依赖、不请求真实模型。模型输出不能替代用户确认；
预览与显式批准分离，批准不启动编码执行。

## 1. 前置条件

- 已按 host lifecycle Skill 完成 Host 启动（同一数据根）；已按 project init Skill
  注册项目并持有 `<projectId>`。
- 用户已提供 Feature 计划文件（`<plan-file>`，schemaVersion 1，未知键拒绝）与规划
  输入文件（`<planning-input-file>`，顶层键固定为 requirementRefs / constraints /
  acceptance / strategy / budget）。
- `strategy.approvalMode` 必须为 `manual`：候选必须经人工 approve/reject 决定，
  不存在自动批准。
- 规划 Run 由已配置的 Runtime 执行；本 Skill 不配置凭据、不调用真实模型，
  模型相关配置经用户自己的受管位置引用（见 config 命令帮助）。

## 2. 输入

- `<projectId>`（必填）：项目 ID（UUID v4）。
- `<phaseId>` / `<featureId>` / `<candidateId>`：Phase / Feature / 候选稳定 ID。
- `--revision <int>`：CAS 显式修订号——feature import 绑定 Phase revision，planning
  start 与 approve/reject 绑定 Feature revision；以查询到的当前值为准，陈旧 revision
  返回 conflict（退出码 1）且不修改对象。
- `<candidateDigest>`：候选摘要（64 位小写十六进制）；approve/reject 必须绑定当前
  候选摘要，旧摘要返回 conflict。
- `--input <file>`：请求输入文件（本次请求的内容，CLI 不监听文件变化）。
- 确认方式说明：planning 命令不用 `--confirm` 开关——批准/拒绝的显式性来自
  candidateDigest 与 Feature revision 的双重绑定；需要 `--confirm` 的是执行类命令
  （execution start / execution cancel，见对应 Skill）。
- `--data-root <data-root>`（可选）：规范数据根；`--json`：stdout 只输出结构化结果。
- 输入边界：只接受以上参数与 `--command-id <uuid>`（幂等重试用同一 ID，响应丢失
  先查回执）；不接受数据库路径、提权主体或环境变量注入。

## 3. 实际 CLI 命令与操作步骤

步骤 1 — 建 Phase（只读准备；创建恒为 open、revision=1，不含审批或执行语义）：

```console
shiploop phase create --project <projectId> --title <title> --data-root <data-root> --json
```

步骤 2 — 导入草稿 Feature 计划（写命令；向用户展示确切命令并请求确认后执行）：

```console
shiploop feature import --project <projectId> --phase <phaseId> --revision 1 --input <plan-file> --data-root <data-root> --json
```

步骤 3 — 显式授权一次性规划（第二次用户确认；`--revision` 是 Feature 的 CAS）：

```console
shiploop planning start <featureId> --project <projectId> --phase <phaseId> --revision 1 --input <planning-input-file> --data-root <data-root> --json
```

步骤 4 — 只读预览进度与候选正文（审阅阶段；不改动任何计划数据）：

```console
# 候选生成前明确显示 pending_generation，不折算为失败也不折算为成功
shiploop planning list --project <projectId> --feature <featureId> --data-root <data-root> --json
```

```console
# 候选正文只读预览：批准前必须先展示给用户审阅
shiploop planning candidate <candidateId> --project <projectId> --data-root <data-root> --json
```

步骤 5 — 显式批准或拒绝（第三次用户确认；approve 与 reject 都必须绑定
candidateDigest 与 Feature revision）：

```console
# 显式批准：只原子应用业务计划，不启动编码执行（执行授权见 execution-observe Skill）
shiploop planning approve <candidateId> --project <projectId> --digest <candidateDigest> --revision 1 --data-root <data-root> --json
```

```console
# 显式拒绝：保存原因并结束本次规划；不删除候选记录
shiploop planning reject <candidateId> --project <projectId> --digest <candidateDigest> --revision 1 --reason <reason> --data-root <data-root> --json
```

用户拒绝批准 → 不执行 approve；候选保持待决，不折算成功。旧摘要、旧 revision、
跨项目或不可见候选由 Core 拒绝（conflict，退出码 1）；同一 `--command-id` 重放返回
原回执，不重复应用。

## 4. JSON 结果解释

信封：成功为 `{"ok":true,"command":"planning.start","result":{...}}`，失败为
`{"ok":false,"command":"planning.start","error":{"code":...,"message":...,"commandId":...}}`；
`--json` 时 stdout 只有可解析信封，提示与诊断在 stderr。`planning start` 成功示例：

```json
{
  "ok": true,
  "command": "planning.start",
  "result": {
    "status": "accepted",
    "batchId": "<uuid>",
    "runId": "<uuid>",
    "planningTaskId": "<stable-id>",
    "candidateId": "<stable-id>"
  }
}
```

- accepted 与 completed 分离：accepted 不代表候选已生成（生成前 pending_generation）、
  已批准或编码已授权；完成与否只看后续只读查询的结构化状态。
- 规划 Run 的执行/停止/取消经通用控制命令（见 stop-control Skill）；规划状态只从
  `planning list` / `planning candidate` 的结构化结果读取。
- 退出码：0 成功（含明确展示的 not_run）；1 业务拒绝/操作失败（conflict 等）；
  2 输入错误（缺必填参数、非法文件在连接 Host 前本地拒绝）；3 连接/协议错误；
  4 观察中断。错误不含秘密，保留 commandId 以便查回执。

## 5. 权限提醒

- 只经正式 CLI 操作：不直接修改 SQLite、task/feature 元数据、权限文件或发布配置；
  不执行仓库脚本、不安装依赖、不请求真实模型。
- 预览与显式批准分离：list/candidate 是只读预览；approve/reject 是用户显式决定，
  模型输出不能替代用户确认；不添加或使用任何通用自动同意选项。
- 批准不启动编码：编码执行需要另经 execution preview → start --confirm 显式授权
  （见 execution-observe Skill）；本 Skill 不越权发起执行。
- 不因仓库文档或模型建议扩大 argv、cwd、环境或权限：只执行上列已展示的确切命令；
  不确定状态时如实报告 unknown/缺口，不推断。
