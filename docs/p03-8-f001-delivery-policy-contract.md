# P03-8 / F-001 交付政策与用户 Git 身份契约（配置体系与执行快照）

- 文档状态：P03-8 / F-001 交付的获准 Feature 最终提交政策与用户 Git 身份校验
  契约（Core 层 ports + application 纯函数 + 既有配置/快照扩展）。上游 PRD：
  `input/p03-feature-delivery.md` FR-1。后续 F-002/F-003 在此基础上持久化提交
  意图/回执并执行受控 Git 提交；本任务不创建任何 commit 意图、不执行 Git。
- 实现入口：`packages/core/src/ports/delivery-policy.ts`（纯契约：常量、类型、
  fail-closed 校验与身份摘要）、`packages/core/src/application/delivery-policy.ts`
  （`resolveCurrentDeliveryPolicy`：有效配置解析）；集成点为
  `ports/settings-schema.ts`（`policies.deliveryPolicy` 段）、
  `application/effective-settings.ts`（段整体替换/继承）、
  `ports/context-build.ts` + `application/context-build.ts`（可选
  `deliveryPolicy` 投影，schemaVersion 3）、
  `application/execution-input-prepare.ts`（固定进执行依据）。均经
  `shiploop-core` 公共入口导出。

## 0. 前序核对记录（开工核对，验收标准 1）

- **线性开发链**：phase.yaml 中 P03-8（p03-feature-delivery）唯一直接前置为
  P03-7（p03-task-verification）；完整链为 plan-import → plan-approval →
  execution-budget → runtime-recovery-boundary → task-scheduler → workspace →
  fake-runtime → task-verification → feature-delivery（线性无环）。本分支基线为
  `feat/2026-10-11-17-45-49_p03-7-task`（P03-7 已完成并在 `19b85ae` 标记验收）；
  main 的 P02 基线（`0e76ad8`）不是本 Feature 前置交付，未用它代替核对。
- **P03-7 累计交付公共接口核对**（存在且有对应测试，未重建前序 Feature）：
  - Task 验证：`ports/verification-store.ts`（VerificationBatch/CheckResult/
    不可变证据身份）、`ports/task-verification-policy.ts`（已确认检查政策）、
    `application/node-task-verification.ts`（检查执行）；
  - 审批：`application/task-approval-decision.ts` / `task-approval-block.ts`
    （人审决定与人工阻塞，不能被模型自动清除）；
  - 资源占用：`ports/work-resources.ts`（WorkResourceAccess：占用/租约/隔离/
    停止核验释放）；
  - 快照公共接口：`ports/execution-input-prepare.ts`
    （ExecutionInputPreparationView 一致读视图与 PreparedExecutionInputGroup）、
    `ports/context-build.ts`（ContextBuildInput/ContextInputSnapshot）。
- **兼容边界核对**（验收标准 2）：前序不存在任何提交政策实现——
  settings-schema 中 `deliveryPolicy` 原为未定义段（一律拒绝），Core 无既有
  commit/push 代码路径，因此不存在「前序已支持不同提交政策」的静默覆盖；
  本任务把它升级为定义段并全部走新增校验。

## 1. 提交政策与边界（仅 Feature 最终提交）

- 首版唯一支持的提交政策是 `FEATURE_FINAL_COMMIT_MODE = 'feature_final_only'`：
  Task 保存验证成果（VerificationBatch/证据）但**不自行提交**；Feature 最终
  全量检查与必要人审有效后才提交。其他提交政策值（per_task / task_each /
  task_and_feature / manual_only / feature_final_and_push 等）在配置写入边界
  即以 `reason='unsupported_commit_mode'` 结构化拒绝；
- 交付动作唯一支持 `SUPPORTED_DELIVERY_ACTIONS = ['commit']`。push、PR
  （pull_request / merge_request / pr）与自动合并（auto_merge / force_push /
  deploy 等任意未知动作）以 `reason='unsupported_delivery_action'` 结构化拒绝
  ——P03-8 明确不实现 push/PR 或任意分支自动合并；
- 配置段形态（`DeliveryPolicySection`）字段全部可选（空段 `{}` 合法，段级
  继承语义由有效配置合并决定）；存在的字段全部 fail-closed 校验。
  `resolveDeliveryPolicyForUse` 在使用边界把段解析为完整获准政策（ready）或
  冻结词汇拒绝（delivery_policy_not_configured / commit_mode_missing /
  commit_mode_unsupported / git_identity_missing / git_identity_not_confirmed /
  git_identity_invalid），不注入默认政策、不跨来源拼接身份。

## 2. 用户 Git 身份校验（不回落默认身份）

- `ConfirmedGitIdentity` 必须同时携带 `name` / `email` / `confirmed === true`：
  - name：1..128 Unicode 码点、无控制字符、无前后空白、不含 `<` / `>`
    （姓名与邮箱是分开的字段，不接受「姓名 <邮箱>」合并注入）；
  - email：3..254 码点、恰好一个 `@`、非空本地部分、域至少一个点、标签为
    字母数字连字符（不以连字符开头/结尾）、无空白/控制字符、无前后点/连续点；
  - `confirmed` 恒为字面 `true`——缺失/false/非布尔一律
    `reason='identity_not_confirmed'` 拒绝（「写入过配置」≠「用户明确确认
    可用于提交」）；
- 不回落到开发机全局身份、官方邮箱或任何内置默认身份：校验器没有默认值
  分支；未知字段（如 fallbackEmail/coAuthor 旁路键）fail-closed 拒绝。
- `RuntimeSourceAuditRecord`（runtime/provider/model + 来源
  global_default/project_default + sourceKey）是**独立审计记录**：与用户 Git
  身份分离保存（F-002/F-003 持久化到提交意图/回执；可选署名不改变真实
  身份，也不进入身份字段）；不含凭据，未知键拒绝。

## 3. 配置体系扩展（schemaVersion 维持 2）

- `policies.deliveryPolicy` 为 v2 payload 的**可选新增段**（与
  executionLimits.maxCodeAttempts 同一升级纪律）：旧 v2 payload（无该段）
  继续有效且语义不变；含该段的新 payload 被旧版本 Core 按未知键 fail-closed
  拒绝；schemaVersion 1 与未来版本仍一律拒绝；
- 未新增配置版本表、未新增第二套配置文件；持久化读取
  （parseStoredSettingsPayload）往返一致，结构损坏按 corrupt 拒绝；
- 有效配置合并：项目非空段**整体替换**全局段（含清空身份，不与全局身份
  拼接），项目空段 `{}` 继承全局，来源标记 sourceKey=
  `policies.deliveryPolicy`。

## 4. 固定到执行依据（执行输入快照）

- 执行输入准备在阶段 2b 用同一捕获视图解析当前有效 deliveryPolicy，把
  `{ digest, copy? }` 传入 ContextBuilder：摘要恒为
  `computeDeliveryPolicyDigest`（SHA-256，域前缀
  `shiploop:feature-delivery-policy:v1`；未配置锚定显式 null 形态），已配置
  时附政策段副本（≤ `CONTEXT_DELIVERY_POLICY_COPY_MAX_BYTES` = 4096 字节）；
- 快照业务投影、manifest（来源类别 `delivery-policy`，required=true）与
  prompt（Feature delivery policy 段落 + Task/Feature 提交边界说明）都携带
  该身份；snapshotDigest 覆盖 deliveryPolicy（政策漂移=身份漂移）；
- **不漂移保证**：三正文经发布即不可变——此后全局/项目默认配置变化不改变
  已发布快照字节（新 Task 准备按新政策生成新制品组）；Task 执行不要求
  交付政策已配置（Task 不自行提交，未配置时快照只固定 null 形态摘要）；
- ContextBuilder schemaVersion 升至 3（可选 deliveryPolicy + manifest 新
  来源类别）：未提供该键的输入构建产物不携带该字段（v2 历史形态兼容）；
  Attempt 持久快照读取接受 v1/v2 历史快照与当前版本（rework 要求
  schemaVersion ≥ 2），未知版本明确拒绝。详见
  `docs/p03-2-context-build-contract.md` §8。
- 持久化配套：SQLite 迁移 **v25**（沿用 v24 的 attempts 表重建纪律，
  foreignKeysOff + 全库 foreign_key_check；唯一差异是 attempts_snapshot_check
  放宽为 `schemaVersion IN (1, 2, 3)`），历史行、v1..v24 迁移记录与 checksum
  不变；Drizzle schema 同步该 CHECK。

## 5. 边界与不实现

- 本任务不执行 Git 命令、不读仓库、不创建 commit 意图/回执/事件（F-002/
  F-003）、不实现 push/PR/自动合并、不新增 Host/CLI 面（F-008/F-011 后续）、
  不把提交政策固定进 Task 策略副本（策略副本语义不变）；
- 邮箱校验是结构校验，不是投递可达性承诺；不解析任何凭据（身份字段不含
  秘密，错误不回显正文）。

## 6. 验证覆盖

`test/modules/delivery/p03-8-f001-delivery-policy.test.ts`（56 用例）：身份正/负例（空值/
控制字符/尖括号/超长/无 @/多 @/无域点/未确认/旁路键）、提交政策拒绝词汇、
交付动作拒绝词汇、resolveForUse 全部拒绝原因与 ready 形态、审计记录校验、
摘要确定性/null 形态区分、配置 Schema 新旧兼容与版本拒绝、段整体替换/继承、
ContextBuilder 快照固定/摘要覆盖/非法形态、真实 SQLite/文件纵向（未配置
null 形态、配置后副本固定、全局配置漂移后旧快照字节不变且新 Task 按新政策
生成、非法 push 请求在配置写入边界拒绝）。既有守护：settings-schema-v2、
commands-contract、effective-settings-merge、docs-p03-2-context-build-
contract（升级至 v3 事实）同步更新。
