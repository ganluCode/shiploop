# P03-2 有版本的 ContextBuilder 契约（F-005；F-011/P03-8-F-001 扩展）

- 文档状态：P03-2 / F-005 交付的版本化 ContextBuilder 契约（Core 层）。上游：
  `docs/p03-2-execution-input-contract.md`（F-004 必需输入引用形态与校验读取）。
  执行输入准备编排与 snapshot/manifest/prompt 制品组属 F-006，Host/CLI 接线属
  F-007/F-008（本项不实现）。P03-7 / F-011 扩展可选同 Task 返工输入（见 §7），
  schemaVersion 升至 2；P03-8 / F-001 扩展可选交付政策固定（见 §8），
  schemaVersion 升至 3；P03-9 / F-007 以 v3 兼容的可选同 Task 续接记录
  扩展（见 §9，未提供该键的旧输入逐字节不变）；P06-2 / F-005 扩展已授权
  文档/记忆选择结果（见 §10），schemaVersion 升至 5。
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
  必须读取）与实际选入的有界历史索引；已授权文档/记忆选择的版本化受管制品身份、
  片段范围、用途、必需性、选择理由和截断状态；`meta.labels` 仅作追溯（见 §5）；
- `inputManifest`：逐来源记录 `sourceId`/`kind`/身份/`version`/`hash`/
  `purpose`/`selection`（选取范围）/`required`（必需性）/`reason`（选择理由）/
  `truncated`，来源类别词汇冻结为 fixed-guidance / task / acceptance /
  strategy / requirements / dependencies / check-policy / permissions / profile /
  required-input / history-index（v2 起追加 rework-guidance / rework-scene /
  failure-evidence / recovery-record；v3 起追加 delivery-policy；v5 起追加
  knowledge；新增类别须升 schemaVersion）；
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
4. `maxKnowledgeSources`：知识来源引用数上限；`maxKnowledgeSnippetChars`：单个
   片段字符上限；`maxKnowledgeTotalBytes`：知识片段 UTF-8 总字节上限。必需知识
   任一预算不足均返回 `limit_exceeded`，details 明确预算名、实测值与上限；可选
   知识按输入顺序截断或省略，并在 `omissions` 中记录；
5. 历史索引按剩余预算贪心保留（前缀策略），省略/截断在 manifest 标注——
   可选内容的省略是成功路径的一部分，不产生失败。

必需输入成分缺席或语义为空（无验收条目、缺必需输入清单、缺检查政策/权限/
策略副本等）→ `missing_required_input`；形态非法（非对象、字符串替代结构化
验收、坏摘要、跨项目/重复制品引用等）→ `validation`。错误消息与 details 只含
字段位置、限制名、实测字节数与计数，**不回显正文内容**。

## 4. 秘密纪律与不自动继承

- 输入项不允许内联正文/凭据字段：`apiKey`/`secret`/`content`/`credentials`
  等未知键一律 validation 拒绝（fail-closed）。知识选择只能携带文档/记忆 ID、
  版本、hash、片段范围和同项目受管 Artifact 引用；可选 snippet 也必须绑定该
  引用，正文不能通过可变路径或脱离制品的字段进入输入；
- 不读取 modelMap 重新路由：输入契约不存在任何路由/配置字段（`modelMap`、
  `settings`、`strategies` 等未知键拒绝），`executionConfig` 按副本原样进入
  snapshot 与 prompt（canonical 相等）；装配依赖只有预算；
- 不自动继承未选择的全局 MCP、Skills、扩展或全文知识（`mcpServers`/`skills`/
  `extensions`/`projectProfile` 等未知键一律拒绝）；文件正文一律不进入 prompt
  （只有受管引用），不能覆盖 Core 权限指导或扩大资源清单。

## 5. 有效验收身份（labels 等非业务元数据不混入）

`labels` 只进入 `inputSnapshot.meta.labels`（追溯记录），任何确定性摘要都不
计入 labels（snapshot/manifest/prompt 的 canonical 投影均排除）：相同已固定
业务内容在标签变化时产生完全相同的摘要与 prompt，与 planDigest 的业务摘要
纪律一致。

## 6. 本项不实现

执行输入准备编排与 snapshot/manifest/prompt 制品组发布、批准最终重核（F-006）、
Host/CLI 接线（F-007/F-008）、ProjectProfile 检测/确认流程、知识检索与 Artifact 字节读取、LLM 蒸馏、SDK 自动
资源加载（AGENTS.md 等）与原生会话续接；本项只消费已授权选择结果，不自动搜索或
继承全局知识；不宣称强 OS 沙箱（可信项目模式，见
`docs/p03-2-execution-input-contract.md` §3 边界）。

## 7. 同 Task 返工输入扩展（P03-7 / F-011，schemaVersion 2）

可选 `rework` 字段存在时，构建输出同 Task 返工输入快照（普通首次构建该字段为
`null`，业务投影不含返工键、摘要与 v1 纪律一致）：

- **关联身份**：当前返工 `attemptId`、直接上一 `previousAttemptId`（不得与当前
  相同）、`previousTaskId`（必须等于当前 taskId，跨 Task 来源拒绝）、同一受管
  worktree 与**已核对 Git/文件现场**身份（`scene.worktreeId` + `headCommit`
  40/64 位小写十六进制 + `codeDigest` 64hex——由受信准备路径核验后以身份形式
  提供，本端口不做文件 I/O 与字节级完整性核验）；
- **必需失败证据引用**：`failureEvidenceRefs` 至少一条（缺篇/空集 →
  missing_required_input），逐条为同项目 `ExecutionInputRef`（损坏摘要/未知键
  → validation，跨项目 → validation，上限
  `CONTEXT_REWORK_FAILURE_EVIDENCE_MAX_COUNT` 条）；按引用读取并核对 hash，
  失败正文与历史报告不内联进 prompt；
- **恢复来源与模式记录**：`recovery.selection` + `recovery.decision` 复用
  P03-3A `RuntimeRecoverySelection` / `RuntimeRecoveryDecision`（Fake 能力声明
  经 `decideRuntimeRecovery` 得出的决策原样记录），只记录本次来源与模式——
  不重新决策、不实现 Pi 原生续接、不宣称缓存或 Token 节省、不引入额外模型
  总结步骤。decision=rejected、required 降级 new、new 选择携带 resume 决策、
  resume 缺来源、kind 不一致、恢复来源 Attempt/项目/Task 与返工身份不符或
  Chat 来源一律 validation 拒绝；
- **固定返工交接指导**：`CONTEXT_REWORK_GUIDANCE` 是 Core 拥有的稳定常量
  （先核对现有文件与 Git 再增量修复；明确禁止删除、reset 或重建 worktree；
  原生会话历史不代替当前需求/权限），仅返工构建置于 `CONTEXT_FIXED_GUIDANCE`
  之后、`## Task` 之前，不随历史增长膨胀；prompt 增加 Rework handoff、
  Failure evidence 与 Recovery record 必需段落（受 `maxPromptBytes` 同一预算
  约束，超限整体失败，不截断）；
- **manifest 新增来源类别**：rework-guidance（固定指导）、rework-scene（现场
  身份）、failure-evidence（逐条证据引用，hash 取权威 contentHash）、
  recovery-record（来源与模式），全部 required=true、永不截断；
- **版本兼容**：snapshot/manifest/prompt 携带 schemaVersion 2；Attempt 持久
  快照读取接受 v1 历史快照与当前版本，未知版本明确拒绝，历史快照不被覆盖
  或改写（新返工输入经既有不可变制品组路径另行发布）。

## 8. 交付政策固定扩展（P03-8 / F-001，schemaVersion 3）

可选 `deliveryPolicy` 输入字段（`ContextDeliveryPolicyInput`：`digest` 必填
sha256、`copy` 可选有界普通 JSON 对象，上限
`CONTEXT_DELIVERY_POLICY_COPY_MAX_BYTES` 字节；null 与缺省同义——按缺省处理，
与 rework 约定一致；未知键 fail-closed）：

- **固定执行依据**：执行输入准备把当前有效 `policies.deliveryPolicy` 段
  （或未配置时的显式 null 形态摘要，见 ports/delivery-policy 的
  `computeDeliveryPolicyDigest`）随快照发布；此后全局/项目默认配置漂移不改
  变已发布快照字节，新准备按新政策生成；
- **Task/Feature 提交边界**：首版仅支持 `feature_final_only`——Task 保存
  验证成果但不自行提交，最终全量检查和必要人审有效后才提交（政策校验见
  ports/delivery-policy 与 settings-schema `policies.deliveryPolicy` 段）；
- **manifest 新增来源类别**：delivery-policy（digest+copy 形态与检查政策同
  一纪律），required=true、永不截断；prompt 携带 delivery policy 段落与
  Task/Feature 提交边界说明；
- **版本兼容**：snapshot/manifest/prompt 携带 schemaVersion 3；未提供
  `deliveryPolicy` 键的输入构建产物不携带该字段（v2 历史形态兼容）；
  Attempt 持久快照读取接受 v1/v2 历史快照与当前版本（rework 要求
  schemaVersion ≥ 2），未知版本明确拒绝。


## 9. 同 Task 续接记录扩展（P03-9 / F-007，schemaVersion 3 兼容追加）

可选 `recovery` 输入字段（`WorkRecoveryContinuationRecord`，由
`application/work-recovery-continuation.ts` 在核对直接上一 Attempt、停止/占用、
恢复现场、当前输入/策略与 P03-3A 能力后发布）：

- **固定内容**：请求模式（auto/new/required × conversation/checkpoint）、实际
  决策与原因、来源 Attempt/Session、来源 Artifact/检查点身份、当前完整策略副本
  （executionConfig/configSource/configSourceKey、权限与检查政策摘要）、工作区
  身份、恢复现场证据引用与必需输入引用；
- **安全新 Session 交接**：`handoff` 只携带上一 Attempt 状态/阶段/结束时间/
  诊断引用与必需输入引用；不内联完整原生历史，不重置预算，不启动 Runtime；
- **能力语义**：沿用 P03-3A conversation/checkpoint 与 nativeHistory/
  conversationResume/executionRecovery/modelSwitchOnResume/nativeFork；auto 降级
  显式记录原因，required 未支持明确拒绝，不伪造支持；
- **manifest**：新增 `recovery-continuation:<nextAttemptId>` 来源（kind
  `recovery-record`），required=true、永不截断；prompt 增加精简恢复交接与
  必需输入段落；
- **版本兼容**：snapshot/manifest/prompt 保持 schemaVersion 3；未提供
  `recovery` 的输入不携带该字段且摘要/字节不变（v1/v2/v3 历史形态兼容）；
  Attempt 持久快照读取接受 v1/v2/v3 历史快照与当前版本。该字段是 v3 内的
  可选追加，复用既有 `recovery-record` manifest 类别，不新增强制类别。

## 10. 已授权知识来源扩展（P06-2 / F-005，schemaVersion 5）

`ContextBuildInput.knowledge`（兼容受信装配的 `knowledgeSources` 别名）只接受已授权的文档或 accepted memory 选择。每项必须提供 `kind`、文档或记忆 ID、来源项目、知识版本、命中片段范围、用途、`required`、选择理由，以及同项目版本化 `contentRef`（Artifact ID、版本、contentHash、大小）。`snippet` 只能作为受管制品的命中片段随引用携带；未知字段、未知来源类别、跨项目身份、可变路径、内联正文或凭据均 fail-closed。

有效选择按输入顺序进入 snapshot 的业务投影和 Manifest。Manifest 使用 `knowledge` 来源类别，identity 记录项目、文档/记忆 ID 与 Artifact ID，`version`/`hash` 绑定知识版本与正文制品，`selection` 记录 `[start..end)` 范围，`purpose`、`required`、`reason` 与 `truncated` 记录选择依据。labels 仍只进入 `meta`，不影响摘要；相同输入可使用 `stableStringify` 独立复算 snapshot、Manifest 和 prompt 摘要。

知识预算包括引用数、单片段字符数和片段总 UTF-8 字节数。必需知识任一预算不足返回 `limit_exceeded`，details 保留预算名、实测值与上限；可选知识按输入顺序截断或省略，并在 `omissions` 记录。最终 prompt 仍受 `maxPromptBytes` 限制，固定指导始终位于知识内容之前。

ContextBuilder 升级到 v5 后，`CONTEXT_INPUT_SUPPORTED_SCHEMA_VERSIONS` 继续接受 v1、v2、v3、v4 历史快照与当前 v5；未知版本拒绝。未包含知识字段的历史快照不被重写，旧输入仍按原有可选字段边界读取。
