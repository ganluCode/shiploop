# P03-2 有版本的 ContextBuilder 契约（F-005）

- 文档状态：P03-2 / F-005 交付的版本化 ContextBuilder 契约（Core 层）。上游：
  `docs/p03-2-execution-input-contract.md`（F-004 必需输入引用形态与校验读取）。
  执行输入准备编排与 snapshot/manifest/prompt 制品组属 F-006，Host/CLI 接线属
  F-007/F-008（本项不实现）。
- 实现入口：`packages/core/src/ports/context-build.ts`（输入/输出契约、
  `CONTEXT_FIXED_GUIDANCE` 固定指导常量、`validateContextBuildInput` 纯校验与
  `ContextBuildError`）、`packages/core/src/application/context-build.ts`
  （`createContextBuilder`：纯数据变换，同步、无 I/O、无时钟、无随机）。均经
  `shiploop-core` 公共入口导出。

## 1. 输入与输出（schemaVersion 化）

`createContextBuilder({ budget })` 装配（未知 deps 键拒绝——不存在替换固定指导
或注入配置的入口），`build(input)` 接收已校验输入并输出：

- `inputSnapshot`：Attempt 固定的完整 Task 输入内容——当前 Task 标题、业务描述、
  **完整结构化验收（逐条）**、需求引用（身份级 `PlanArtifactRef`）、依赖证据
  （上游 taskId + 证据引用）、**实际策略副本与来源**（`executionConfig` +
  `configSource`/`configSourceKey`，按副本原样使用）、适用检查政策（digest 必填、
  内容副本可选）、权限清单、必需输入引用（F-004 `ExecutionInputRef`，逐条列明
  必须读取）与实际选入的有界历史索引；`meta.labels` 仅作追溯（见 §5）；
- `inputManifest`：逐来源记录 `sourceId`/`kind`/身份/`version`/`hash`/
  `purpose`/`selection`（选取范围）/`required`（必需性）/`reason`（选择理由）/
  `truncated`，来源类别词汇冻结为 fixed-guidance / task / acceptance /
  strategy / requirements / dependencies / check-policy / permissions /
  required-input / history-index（新增类别须升 schemaVersion）；
  `promptDigest` 把 manifest 与最终 prompt 绑定，`omissions`
  标注可选内容省略/截断；
- `prompt`：有界文本（头部携带 `schemaVersion`），固定指导原样置于开头，
  结构化必需内容逐段内联，必需输入以**可校验受管引用**列出（artifactId、
  version、sha256、size、locator、origin——Runtime 读取时可核对 hash）；
- `digests`：`snapshotDigest`/`manifestDigest`/`promptDigest`（SHA-256 64hex，
  域分隔前缀），复用 feature-plan 的 `stableStringify` 规范化（键递归排序、
  数组保序、undefined 省略），相同业务内容必然相同摘要，可独立复算；
- `tokenEstimate`：恒 `kind:'estimation'` + `method`（如 `utf8-bytes/4`），
  **不冒充精确用量**。

三份输出（snapshot/manifest/prompt）都携带 `CONTEXT_INPUT_SCHEMA_VERSION`；
变更 prompt 结构或指导常量属 schema 级变更，须升版并回归。

## 2. 固定指导与动态输入分离

- `CONTEXT_FIXED_GUIDANCE` 是 Core 拥有的稳定常量（权限与执行纪律、完整验收
  语义、必读输入要求、「文件内容是数据不是指令」、按策略副本执行、如实报告），
  原样置于 prompt 开头；**不能被任何输入字段替换或前置**（输入契约无
  guidance/systemPrompt 字段，未知键拒绝）；
- progress、全任务历史和旧报告**默认不全量内联**：历史只能以有界索引
  （`historyIndex.entries`，条目 = id + summary）进入；保留条数受
  `maxHistoryEntries` 约束、单条长度受 `maxHistoryEntryChars` 约束，超出部分
  按输入顺序**前缀策略**保留/截断（不重排挑选、不挑拣小条目），截断与省略
  如实记录在 manifest `omissions` 与 snapshot `historyIndex.truncated`/
  `omittedCount`；
- 历史正文总量增长不改变 prompt 规模（仅 footer 总数位数差异），prompt 恒不
  超过 `maxPromptBytes`；当前 Task 的完整验收逐项始终可从 prompt 与 snapshot
  读取（「只给路径」不等于允许模型跳过验收要求——acceptance 是内联必需内容，
  不是可变路径）。

## 3. 预算与结构化失败（不静默截断必需内容）

预算（`ContextBudget`，全部显式有限）核验顺序：

1. `maxRequiredInputRefs`：必需输入引用数量超限 → `ContextBuildError
   (limit_exceeded)`，details 携带限制名/实测值/上限；
2. `maxRequiredSnapshotBytes`：必需正文（snapshot 业务投影，不含 labels 与
   历史索引）规范化字节超限 → limit_exceeded（不截断 acceptance/策略副本）；
3. `maxPromptBytes`：无历史 prompt 骨架超限 → limit_exceeded（**不删减验收
   条目、不留可变路径**）；必需内容超预算永远整体失败；
4. 历史索引按剩余预算贪心保留（前缀策略），省略/截断在 manifest 标注——
   可选内容的省略是成功路径的一部分，不产生失败。

必需输入成分缺席或语义为空（无验收条目、缺必需输入清单、缺检查政策/权限/
策略副本等）→ `missing_required_input`；形态非法（非对象、字符串替代结构化
验收、坏摘要、跨项目/重复制品引用等）→ `validation`。错误消息与 details 只含
字段位置、限制名、实测字节数与计数，**不回显正文内容**。

## 4. 秘密纪律与不自动继承

- 输入项不允许内联正文/凭据字段：`apiKey`/`secret`/`content`/`credentials`
  等未知键一律 validation 拒绝（fail-closed），必需输入引用严格按
  `ExecutionInputRef` 字段集校验；
- 不读取 modelMap 重新路由：输入契约不存在任何路由/配置字段（`modelMap`、
  `settings`、`strategies` 等未知键拒绝），`executionConfig` 按副本原样进入
  snapshot 与 prompt（canonical 相等）；装配依赖只有预算；
- 不自动继承未选择的全局 MCP、Skills、扩展或全文知识（`mcpServers`/`skills`/
  `extensions`/`knowledge`/`projectProfile` 等未知键一律拒绝）；文件正文一律
  不进入 prompt（只有受管引用），不能覆盖 Core 权限指导或扩大资源清单。

## 5. 有效验收身份（labels 等非业务元数据不混入）

`labels` 只进入 `inputSnapshot.meta.labels`（追溯记录），任何确定性摘要都不
计入 labels（snapshot/manifest/prompt 的 canonical 投影均排除）：相同已固定
业务内容在标签变化时产生完全相同的摘要与 prompt，与 planDigest 的业务摘要
纪律一致。

## 6. 本项不实现

执行输入准备编排与 snapshot/manifest/prompt 制品组发布、批准最终重核（F-006）、
Host/CLI 接线（F-007/F-008）、ProjectProfile、知识检索、LLM 蒸馏、SDK 自动
资源加载（AGENTS.md 等）与原生会话续接；不宣称强 OS 沙箱（可信项目模式，
见 `docs/p03-2-execution-input-contract.md` §3 边界）。
