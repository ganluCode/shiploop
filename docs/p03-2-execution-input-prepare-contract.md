# P03-2 执行输入准备与制品组契约（F-006）

- 文档状态：P03-2 / F-006 交付的执行输入准备契约（Core 层）。上游：
  `docs/p03-2-execution-input-contract.md`（F-004 采集与校验读取）、
  `docs/p03-2-context-build-contract.md`（F-005 有版本 ContextBuilder）、
  `docs/p03-2-plan-approval-verification-contract.md`（F-003 有效批准复合身份）。
  Host/CLI 接线属 F-007/F-008（F-007 Host 侧与 F-008 CLI 侧均已交付，见 §8 写回登记）；Run/Attempt
  绑定与 startRun 属 P03-3/4（本项不创建任何执行实体）。
- 实现入口：`packages/core/src/ports/execution-input-prepare.ts`（受控制品
  词汇、策略副本/权限面内容身份摘要、一致读视图与权限读取端口形态、
  制品组身份形态与失败原因词汇）、`packages/core/src/application/execution-input-prepare.ts`
  （`createExecutionInputPrepareService` 事务外准备端口 +
  `submitExecutionInputPrepare` 最终写事务内重核提交）。命令面操作
  `execution.input.prepare`（能力位同名；创建类不携带 expectedRevision）经
  `createCommandService` 接线；生产装配经 `openCoreApplication`（`shiploop-core`
  公共入口导出，`CoreApplication.executionInputPrepare`）。

## 1. 三阶段结构与事务边界

| 阶段 | 位置 | 内容 |
|---|---|---|
| 1 捕获 | 单一 DEFERRED 读事务（`readExecutionInputPreparationView`） | Feature + 全部 Task + 全部依赖边 + 全部决策记录 + 全局/项目当前配置在同一快照内取得；视图内 fail-fast 核验有效批准（F-003 纯规则，先于任何文件 I/O） |
| 2 组装与发布 | 事务外 I/O | F-004 `captureRequiredInputs` 采集必需输入（文件来源捕获实际字节并发布为不可变制品；制品来源核验归属与 ready）→ F-005 ContextBuilder 纯组装 → ArtifactPublisher 发布三正文 → `readVerifiedContent` 逐正文字节级复验 |
| 3 最终重核与提交 | 调用方同一 BEGIN IMMEDIATE 写事务（`submitExecutionInputPrepare`） | 当前 planDigest、有效批准复合身份、Task 策略副本内容身份、权限面内容身份与全部制品索引重核；通过才写脱敏事件 `execution.input.prepared`（payload 恒 `{prepared:true}`，聚合为目标 Task）与 completed 回执 |

- 外部 I/O（源文件读取、staging/发布、正文复验）绝不在写事务内等待；
  **不宣称文件系统与 SQLite 存在跨介质原子事务**：制品索引经发布器各自
  短事务提交，事件/回执在最终写事务内原子一致；
- 命令 payload 面严格冻结为 `featureId`/`taskId`/`items`（必需输入采集清单，
  逐项深校验在应用层复用 ports/execution-input 契约；可为空数组）；
  snapshot/manifest/prompt/permissions/approval 等服务端决定字段一律不能经
  请求输入；
- 捕获阶段批准无效（未批准/拒绝/过期/不一致）直接抛 PublicError（零回执、
  零发布 I/O）；最终重核失败固化 rejected 回执（零事件，details.reason
  携带明确漂移原因）。

## 2. 制品组身份（可绑定输入）

三正文各发布为同项目不可变受管 Artifact（物理位置仅由 artifactId 推导，
locator 是逻辑身份字段）：

| 正文 | kind | mediaType | locator |
|---|---|---|---|
| inputSnapshot | `execution-snapshot` | `application/json` | `execution-input-groups/<taskId>/snapshot` |
| inputManifest | `execution-manifest` | `application/json` | `execution-input-groups/<taskId>/manifest` |
| prompt | `execution-prompt` | `text/plain` | `execution-input-groups/<taskId>/prompt` |

- 正文序列化：snapshot/manifest 用 `stableStringify`（键递归排序的规范化
  JSON，相同输入逐字节可复现），prompt 为 ContextBuilder 输出原文；
- `PreparedExecutionInputGroup` / completed 回执 result 携带：同项目三正文
  引用（artifactId/version/contentHash/sizeBytes/locator/mediaType）、必需
  输入引用集、`schemaVersion`（= ContextBuilder `CONTEXT_INPUT_SCHEMA_VERSION`）、
  各正文摘要（制品 contentHash + F-005 域摘要 snapshotDigest/manifestDigest/
  promptDigest + 策略副本/权限面内容身份）、批准复合身份（planDigest +
  checkPolicyDigest + decisionId）与 taskRevision；`bindable: true` 仅在
  阶段 3 全部重核通过后出现；
- 供 P03-3/4 绑定到新 Run/Attempt；绑定前必须按当前状态重核（历史回执
  重放不代表该输入仍满足当前执行前置条件）。

## 3. 最终重核与身份漂移（不误报纪律）

重核基线是**内容身份**，不是裸 revision：

| 重核项 | 基线 | 漂移 reason | 不误报边界 |
|---|---|---|---|
| 计划业务摘要 | `approval.planDigest` | `plan_changed` | 捕获后实质修订（即使已被重新批准）即过期，旧视图不得作为当前有效输入返回 |
| 有效批准 | `verifyFeaturePlanApprovalInTransaction`（F-003 复用入口） | F-003 原因词汇（`not_approved`/`rejected`/`check_policy_changed`/…） | 检查政策变化使旧批准过期；重批当前身份后恢复 |
| Task 策略副本 | `digests.strategyCopyDigest`（executionConfig+configSource+configSourceKey 规范化摘要，与 F-005 manifest task-strategy 来源摘要同一公式） | `task_strategy_changed` | **纯标签编辑只递增 revision 不改变内容身份，不误报**；默认 modelMap 变化不进入任何捕获身份（策略按副本使用，不重读路由），天然不触发 |
| 权限面 | `digests.permissionsDigest`（grants 规范化摘要） | `permissions_changed` | 权限由可信装配读取器提供（请求不能伪造），捕获与最终重核各读一次 |
| 制品索引 | 三正文 + 全部必需输入 ready 且 hash/size/locator 一致 | `artifact_not_ready`/`artifact_missing`/`artifact_changed` | 篡改/缺失/未 ready 均不产生可绑定结果 |

## 4. 失败证据与幂等

- 任一必需制品缺失、篡改、超预算或发布失败均不留下可绑定的半完整制品组：
  已发布制品保持不可变（本身是可核对证据），索引沿用既有 pending/failed
  与 staging 残留核对行为，不覆盖、不自动删除任何已有正式输入；
- 修改无活动 Attempt 的 Task 策略副本并满足当前批准条件后生成的新快照
  反映新策略；旧 snapshot/manifest/prompt 与源制品逐字节不变（新准备生成
  新 artifactId，物理文件互不覆盖）；准备不同后续尝试的输入不更新历史正文；
- 凭据始终只有引用：快照/prompt/回执不携带正文或凭据（F-005 契约的
  `rejectUnknownKeys` 面向全链路生效）；
- 幂等：重复 `commandId` 由既有命令回执机制重放原回执（事务外准备仅对新
  命令执行，不重复发布）；异参复用按既有规则 conflict。

## 5. 失败原因词汇与公开错误映射

- 捕获/组装/发布失败（PublicError）：`validation`/`source_unavailable`/
  `limit_exceeded`/`context_build_failed` → `invalid_input`；  `feature_not_found`/`required_input_not_found` → `not_found`；
  `ownership_denied` → `forbidden`；批准原因（`no_plan`/`no_tasks`/
  `not_approved`/`rejected`/`plan_changed`/`check_policy_changed`/
  `approval_state_inconsistent`）→ `conflict`；`corrupt`/`reference_mismatch`/
  `published_body_mismatch` → `corrupt_state`；`publish_failed`/`timeout`/
  `file_io` → `internal`；
- 最终重核漂移（rejected 回执 reason）：`plan_changed` + F-003 批准原因 +
  `task_strategy_changed`/`task_not_in_plan`/`permissions_changed`/
  `artifact_not_ready`/`artifact_missing`/`artifact_changed`；
- 错误 details 只含身份键、摘要、字节数、限制值与脱敏原因，不含绝对路径
  或正文内容。

## 6. 装配与预算

- 生产装配（`openCoreApplication`）：获准源文件根白名单 `inputSourceRoots`
  由可信装配注入（缺省空名单——任何 file 来源都是未获准引用，制品来源
  不受影响）；权限读取器缺省 `TRUSTED_PROJECT_PERMISSIONS_READER`（P03-2
  无运行时授权面的显式空集边界宣告，不是查询失败兜底）；预算面使用 Core
  冻结缺省（`DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS`（maxRequiredItems=16）、
  `DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET`（maxPromptBytes=400 000 等）、
  F-004 采集限制与发布/复验限制同一契约）；
- 命令端口未装配时 `execution.input.prepare` unsupported（不冒充能力）。

## 7. 本项不实现

Host/CLI 接线（F-007/F-008）、Run/Attempt 绑定与 startRun（P03-3/4）、
批输入/项目级中断核对（F-012 verifyProject）、ProjectProfile/检索/LLM 蒸馏
（F-005 契约 §6 同一边界）、强 OS 沙箱（可信项目模式，见
`docs/p03-2-execution-input-contract.md` §3）。

## 8. F-007 接线定案（写回登记）

- HostClient 公共方法 `prepareExecutionInput` 经既有 `POST /v1/commands` 通用路由
  接线（创建类冻结信封/回执/有限重试），completed 回执内嵌制品组身份经客户端
  线校验器 `validateExecutionInputPrepareResultWire` 复核（bindable/bodyRef/
  requiredInputs/digests/approval/tokenEstimate 冻结字段集，正文永不内联）；
- 制品组身份查询沿用既有回执/结果读取（`receipts.get`/`results.resolve`），
  不新增查询面；线消息 schemaVersion 随 P03-2 能力集合变化显式升 v5；
- 受控制品组读取边界：输入正文若经 Host 提供，只允许按获准制品组内 Artifact
  身份作有界校验读取（F-004 `captureRequiredInputs` 归属/ready/身份核验）；
  不新增接受任意 path/locator 的通用文件接口（表外路径 404），跨项目或未知
  正文统一 not_found/forbidden，不泄漏存在性与物理路径；CLI 入口属 F-008
 （已交付：`task prepare`/`task inputs`，制品组身份查询沿用既有回执读取，
  操作说明见 `docs/p03-2-cli-approval-input-operations.md`）。

## 9. F-009 集成回归写回登记

- `test/p03-2-integration-regression.test.ts`（正式构建 dist CLI + dist Host + 隔离
  真实 SQLite）以真实命令复核本契约的漂移与不可变纪律：非活动 Task 副本编辑后新
  制品组摘要改变、旧 snapshot/manifest/prompt 逐字节不变且历史回执保留原身份；
  modelMap 更新不进入捕获身份（新准备照常可绑定）；纯标签编辑不误报。
- 历史增长（40 份大段报告制品 + 8 次标签 CAS）后新准备的三正文摘要与正文逐字节
  不变、报告标记零泄漏、prompt ≤ maxPromptBytes、acceptance 逐项完整可读——
  T37「不因历史增长膨胀提示词」的正式链路证据。
- fail-closed 矩阵：必需输入缺失（`required_input_not_found`）、file 来源越界
 （生产装配获准根白名单缺省为空 → `unknown_root`；词法穿越结构层拒绝）、制品索引
  声明超 `maxItemBytes` → `limit_exceeded`、跨项目制品 → `ownership_denied`、
  秘密字段连接前拒绝；输出零路径/零秘密泄漏。篡改后回执身份不被修复或掩盖、新准备
  发布新制品组不覆盖旧正文（失败证据保留；逐字节校验读取 → `corrupt` 的运行时
  语义在 Core `readVerifiedContent` 层覆盖，见交接文档 §8.2——Host `artifacts.get`
  仅限 P02-3 基线输出成员，无通用制品正文读取面）。
- 交接文档 `docs/p03-2-handoff.md` §3.3/§3.4 冻结制品组绑定身份、漂移词汇与预算
  缺省的 P03-3/4 复用方式。
