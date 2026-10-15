# P03-5 工作区 CLI 操作说明（F-012）

- 文档状态：P03-5 / F-012 交付的 CLI 操作说明（简洁版）。上游契约：
  `docs/p03-5-workspace-host-integration-contract.md`（F-011 Host 接线与查询面）、
  `docs/p03-5-workspace-discard-contract.md`（F-010 丢弃预览/确认边界）。
- CLI 只经既有 HostClient 公共面提交/查询：不打开 SQLite、不读写代码工作目录、
  不直接调用 Git、不读取认证材料；命令只经过 Host，响应丢失先查既有回执再以
  同一冻结信封重试（不更换 commandId 造成重复副作用）。
- 本命令面不实现自动清理/强制删除/分支回滚；`workspace discard` 是唯一的
  工作区丢弃入口，丢弃范围固定为受管工作区目录与其 Git 登记（worktree_only）。
  本文示例只使用脱敏逻辑身份（示意 UUID/占位符）。

## 1. 命令面

| CLI 子命令 | 命令身份 | Core 操作 | 语义 |
|---|---|---|---|
| `shiploop workspace list --project <id>` | `workspace.list` | `workspaces.list` | 项目内受管工作区键集分页（只读） |
| `shiploop workspace get <featureId> --project <id>` | `workspace.get` | `workspaces.get` | 工作区详情（准备/最新 operation） |
| `shiploop workspace operations --project <id>` | `workspace.operations` | `workspace.operations.list` | 工作区 operation 审计分页（只读） |
| `shiploop workspace operation <operationId> --project <id>` | `workspace.operation` | `workspace.operations.get` | 单次 operation 详情与回执投影 |
| `shiploop workspace discard-preview <featureId> --project <id>` | `workspace.discard-preview` | `workspace.discard.preview` | 人工丢弃只读预览（不是删除） |
| `shiploop workspace discard <featureId> --project <id> --preview-file <file> --confirm` | `workspace.discard` | `workspace.discard` | 人工确认丢弃（绑定预览摘要） |

## 2. 参数（沿用既有模式）

- `workspace list --project <id> [--feature <id>] [--limit <int>] [--cursor <c>]`
- `workspace operations --project <id> [--feature <id>] [--limit <int>] [--cursor <c>]`
  - 分页默认 100、上限 500；cursor 为 `wscur_v1_` 不透明键集游标（跨数据根/
    跨项目/跨 Feature/畸形一律 `invalid_cursor`，绝不当从零读取）；
- `workspace get <featureId> --project <id>` / `workspace operation <operationId> --project <id>`
  - featureId 为稳定 ID，operationId 为 UUID v4；非法形态在连接 Host 之前退出 2；
- `workspace discard-preview <featureId> --project <id> [--command-id <uuid>]`
  - 预览不是删除，也不授权自动确认；completed 回执携带预览（见 §3）；
- `workspace discard <featureId> --project <id> --preview-file <file> --confirm [--command-id <uuid>]`
  - `--confirm`：显式非交互确认（必填）；缺确认或缺 `--preview-file` 在连接
    Host 之前本地拒绝（`confirmation_required` / `missing_required_option`，
    退出码 2），不隐式预览后自动同意；
  - `--preview-file`：discard-preview 的预览 JSON（建议保存 `--json` 输出的
    `result.preview` 段，逐字节回喂即合法输入）；CLI 在本地核验预览形状与
    Feature 一致性（`invalid_preview_file` / `preview_feature_mismatch`，
    退出码 2）；previewDigest/HEAD/内容摘要/revision/有效期由服务端重算复核，
    伪造摘要、过期预览或内容变化一律 conflict 拒绝（退出码 1，零删除）；
- 公共：`--data-root <abs>`、`--json`、写命令的 `--command-id <uuid>`（幂等/恢复）。

## 3. 结构化输出（--json 信封 result）

- `workspace.list`：`operation:"workspaces.list"`、`records[]`（每条含权威
  `record` 与派生 `state`）、`nextCursor`、`limit` 与 `completion`；
- `workspace.get`：`operation:"workspaces.get"`、权威 `workspace`、派生 `state`、
  `preparationOperation`/`latestOperation` 完整视图（阶段/原因/证据与回执引用，
  未知耗时/退出信息保持 `null` 不填零）与 `completion`；
- `workspace.operations` / `workspace.operation`：`record`（kind/executionStage/
  status/revision/principalId/commandId/requestDigest/result）+ `receipt` 投影
  （commandId/resultRef/status/reason；reason 缺失为 `null`，绝不回显正文/路径）
  与派生 `classification`（terminal/failed/blocked/succeeded）；
- `workspace.discard-preview`：`commandId`、`replayed`、原始预览 `preview`
  （绑定摘要 previewDigest/HEAD/codeDigest/ignoredDigest/workspaceRevision/
  expiresAtUtcMs、有界内容计数与 `truncated`、不可逆影响、`blockers`、
  `evidenceRef`）、派生 `state`/`expiresAt`、`notice` 与 `completion`；
- `workspace.discard`：`commandId`、`replayed`、`result`
  （workspaceOperationId/workspaceId/previewDigest 登记摘要）、`notice` 与
  `completion`；命令 completed 不等于丢弃成功——实际删除结果以
  `workspace operation <workspaceOperationId>` 与 `workspace get <featureId>` 为准；
- 状态分类（只读投影，不是第二套状态）：`preparing`（准备中）、`prepared`
  （准备完成，不是交付）、`retained`（保留，失败默认保留现场）、`quarantined`
  （隔离）、`cleanable`（可清理/清理待执行）、`cleaned`（实际已清理）；
  操作失败/受阻如实展示（`failed`/`blocked`），`pending` 不是最终结论；
- 所有视图 `completion.featureVerified=false`、`delivered=false`：accepted、
  准备完成、保留、可清理或实际已清理均不代表 Feature 交付；Runtime 结束、
  干净 status 或准备成功也不会显示为交付。

## 4. 错误与退出码

- 退出码沿用既有四档：0 成功；1 业务拒绝/操作失败；2 输入错误；3 连接/协议错误；
- 本地拒绝（退出码 2）：非法 project/feature/operation ID、非法分页、缺
  `--confirm`、缺/畸形 `--preview-file`、Feature 不一致、监听覆盖参数；
- Host/服务端拒绝（退出码 1 为主）：跨项目/不存在实体折叠 `not_found`（不泄漏
  存在性）、伪造摘要/过期预览/占用/停止证据缺失 `conflict`、能力缺失
  `forbidden`；服务端 `invalid_input`（如畸形游标解码失败）为退出码 2；
- Host 不可达/启动超时为退出码 3（`unreachable`/`start_timeout`），不折算业务失败；
- 响应丢失：先等待有界提交窗口再查该主体名下既有回执，未命中才以完全相同的
  冻结信封重发（同 commandId；重放返回原回执 `replayed=true`）；预算耗尽
  `outcome_unknown` 保留 commandId 供事后查回执。

## 5. 边界声明

- 可信项目模式不提供强 OS 隔离；工作区操作（准备/保留/清理/丢弃）均不是
  Feature 交付；
- 失败默认保留现场（retained）；停止不确定或现场不一致时隔离（quarantined），
  不自动删除；
- 本阶段（P03-5）尚无完整 Runtime/提交闭环：accepted、准备完成、可清理或
  已清理均不代表交付；
- 丢弃只处理已预览的受管工作区目录与 Git 登记：源仓库、Feature 分支、已提交
  成果与审计记录永远不在范围内；
- 公开投影不含绝对路径（canonicalPath/gitCommonDir）与内部身份哈希
  （repoIdentity）；CLI 不打开 SQLite、不读写代码工作目录、不直接调用 Git。
