# P03-1 单 Feature 草稿计划导入 — 校验、DAG 与摘要契约

- 对应任务：F-001（在 packages/core 建立单 Feature 草稿计划的运行时校验、同 Feature DAG 校验与
  确定性 planDigest 计算，明确导入和编辑契约）。
- 文档状态：P03-1 实施前置契约 + F-001 交付的纯校验模块说明（F-002 ~ F-011 的协议依据之一，
  **不是阶段验收报告**，也不是已接入命令面/存储面的能力声明）。本文冻结时 SQLite 迁移仍止于
  P02 的 v5 前状态；P03-1 / F-002 已追加迁移 v6（phases/features/tasks/task_dependencies
  四表与 Drizzle 映射、CommandTransaction 插入原语，见
  `packages/core/src/adapters/sqlite/migrations.ts` 与 `ports/plan-store.ts`）；P03-1 / F-004 起
  `COMMAND_OPERATIONS` 增加 `phase.create`（能力位 `phase.write`、事件 `phase.created`，见
  §6.4），Host `/v1/commands` 通用路由随之受理该命令（接线宣告同步）；CLI 仍无计划入口
  （F-009 接入）。F-005 起继续改变这些事实时必须同步更新本文与文档守护测试。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收。
- 输入依据：P03-1 任务拆分（`task_list.json`，Feature 工作区）、知识目录
  `architecture-redesign/core-design/02-domain-and-lifecycle.md`（§8 两层 DAG、§10 标题/描述/标签
  规则）、`core-design/11-database-model.md`（§4 phases/features/tasks/task_dependencies 字段与
  约束）、`core-design/03-storage-and-transactions.md`（CAS revision 纪律）。知识目录是开发查阅
  路径（Harness 内），非本仓库内容、非运行时依赖。
- 与既有契约的关系：P01 应用服务语义以
  [p01-3-application-contract.md](p01-3-application-contract.md) 为准（稳定 ID、标签规范化、
  结构化错误、描述与上限规则直接复用，不另立数值）；命令信封、能力白名单与公开错误映射以
  [p02-2-commands-events-contract.md](p02-2-commands-events-contract.md) 为准；配置 payload 校验以
  `packages/core/src/ports/settings-schema.ts`（schemaVersion=2）为准。本文只在「计划 payload」
  这个新输入面上定案，不修改 P01/P02 的既有契约。
- 本文不静默改变领域语义；编号与语义张力集中记录于 §9，并按 §9.4 请求核对。

---

## 1. 前序基线核验（开工核对）

### 1.1 分支与提交

- 实际执行分支：`feat/2026-10-11-17-45-49_p03-1`（worktree
  `shiploop-2026-10-11-17-45-49_p03-1`，主仓库 `shiploop` 的正式开发 worktree）。
- 开工时 HEAD（= P03-1 起点，完整 hash）：
  `0e76ad8d9ae7a9e03949c8af4bae8e7e236acd56`（`docs(acceptance): record P02 approval and final
  replay evidence`，P02-4 收尾的**纯文档提交**）。`main` 当前 tip 与该提交一致
  （`git merge-base --is-ancestor main HEAD` 为真且 `git rev-list --count main..HEAD` = 0），
  即 P03-1 直接从 P02 放行基线起步，无夹带提交。
- P02 阶段放行与双 CLI 闭环证据见 `docs/acceptance/`（p02 系列）；F-001 不代签、不自动合并、
  不扩大放行范围，P03 阶段验收由后续 `accept:p03` 提供（本任务不实现）。

### 1.2 现有公共端口实际核对（复用清单，非占位）

F-001 实际打开 `0e76ad8` 的源码逐项核对，下表入口在开工时已存在且被 `npm test` 收集；P03-1
新增的校验**直接复用**这些规则，不另立第二套：

| 规则 | 复用入口（`packages/core/src/ports/`） | 既有测试 |
|---|---|---|
| 稳定 ID（1-128 位，`[A-Za-z0-9._-]`，字母数字开头） | `validation.ts` `validateStableId` | `project-metadata-validation.test.ts` |
| 标签规范化（trim → NFC → ASCII 小写 → 实体内去重；`LABEL_MAX_LENGTH = 64`、`LABELS_MAX_COUNT = 50`） | `validation.ts` `normalizeLabels` | `project-metadata-validation.test.ts` |
| 描述语义（省略/null/全空白 → null；原文保留；`DESCRIPTION_MAX_LENGTH = 10000` 码点） | `validation.ts` `validateProjectDescription` 的语义（计划描述同规则实现） | `project-metadata-validation.test.ts` |
| 结构化错误（kind/operation/entity/details，脱敏：不回显输入正文，最多 receivedType） | `errors.ts` `StorageError`、`validation.ts` `validationError` | `storage-contracts.test.ts` |
| 严格未知键拒绝 / 原型污染防护 | `validation.ts` `rejectUnknownKeys`、`requireSafeRecordKey` | `settings-schema-v2.test.ts` 等 |
| SHA-256 摘要形态（64 位小写十六进制） | `validation.ts` `validateSha256Digest` | `storage-validation.test.ts` |
| complexity 取值（low/medium/high） | `settings-schema.ts` `ModelComplexity`（`modelMap` 键） | `effective-settings-merge.test.ts` |
| expectedRevision 唯一权威来源（信封顶层；payload 携带即未知键） | `commands.ts` §5.1 纪律 | `command-register.test.ts`、`commands-contract.test.ts` |

### 1.3 环境、脚本与开工基线实测

| 项 | 值 |
|---|---|
| Node / npm / TypeScript / Vitest | `22.19.0` / `10.9.3` / `7.0.2` / `5.0.3`（精确锁定，run-tests 启动器校验） |
| 工程脚本 | `npm test`（`node scripts/run-tests.ts`）、`npm run typecheck`、`npm run check:boundaries`、`npm run build`、`npm run verify`、`npm run accept:p01` / `accept:p02`（无 `accept:p03`） |

开工基线实测（本 worktree，`npm ci` 重建依赖后，全部真实退出码）：

- `npm test`：退出 0，**117 test files / 2971 tests passed**，无 skip；
- `npm run typecheck`：退出 0；
- `npm run check:boundaries`：退出 0（106 个生产源码文件，0 诊断）；
- `npm run build`：退出 0（含 Host/CLI dist 冒烟）。

P03-1 之后每次收尾仍须跑完整门禁（`npm run verify` 或等价的 test+typecheck+build 序列）。

## 2. 计划 payload 契约（FEATURE_PLAN_SCHEMA_VERSION = 1）

实现入口：`packages/core/src/ports/feature-plan.ts`（经 `shiploop-core` 公共入口导出：
`validateFeaturePlanInput` / `computeFeaturePlanDigest` / `canonicalFeaturePlanBusinessJson` 与
全部常量）。本模块是**纯函数**：不读时钟/文件系统/网络/数据库，不产生持久化副作用；
归属与引用存在性由 F-005 的导入事务在提交时重核（§6.3）。

### 2.1 结构与字段

```jsonc
{
  "schemaVersion": 1,            // 必填；唯一支持 1，未知/更高版本拒绝，不静默降级
  "feature": {                    // 必填对象；未知键拒绝
    "title": "…",                 // 必填非空，trim 后 ≤ PLAN_TITLE_MAX_LENGTH（码点）
    "description": "…",           // 可选 string|null；全空白/省略/null → null；≤ DESCRIPTION_MAX_LENGTH
    "labels": ["…"],              // 可选；复用 normalizeLabels（含 64/50 上限）
    "sourceRefs": [               // 可选；Feature 输入来源引用（§2.3）
      { "artifactId": "art-1", "contentHash": "…" }
    ]
  },
  "tasks": [                      // 可选（缺省 = 空草稿）；0..PLAN_TASKS_MAX_COUNT 个
    {
      "id": "t-1",                // 必填稳定 ID；计划内唯一
      "title": "…",               // 必填非空（description 或引用不能替代 Task 名称）
      "description": "…",         // 同 feature.description 规则
      "labels": ["…"],            // 可选；normalizeLabels
      "complexity": "low",        // 可选 'low'|'medium'|'high'|null（复用配置复杂度取值）
      "acceptance": {             // 必填；结构化验收不可缺省（引用/描述不能替代完整验收）
        "criteria": ["…"]         // 1..PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT 条非空字符串
      },                          // 每条 trim 后 ≤ PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH 码点
      "requirementsRefs": [       // 可选；需求/验收引用（§2.3）
        { "artifactId": "art-2" }
      ],
      "dependsOn": ["t-0"]        // 可选；同 Feature 任务 ID（§3）
    }
  ]
}
```

**明确不在计划 payload 中的字段（未知键一律拒绝）**：`expectedRevision`、`revision`、
`createdAtUtcMs`、`updatedAtUtcMs`、`projectId`、`phaseId`、`featureId`、`executionConfig`、
`configSource`、`configSourceKey`、策略来源说明等。归属与 CAS 属于命令信封与聚合存储
（§6）；执行策略副本是 F-003/F-005 的服务端行为，不是计划作者输入。

### 2.2 边界常量（实施契约值）

设计未给出具体数值；下表为 F-001 选定的实施契约值（量级对齐仓库既有上限），与
`feature-plan.ts` 导出常量一致，任何入口不得另立数值。长度均以 Unicode 码点计（emoji 不记
为 2），并先做标签规范化/trim：

| 常量（实施契约值） | 含义 |
|---|---|
| `FEATURE_PLAN_SCHEMA_VERSION = 1` | 计划 payload 结构版本（独立演进，见 §5） |
| `PLAN_TITLE_MAX_LENGTH = 200` | Feature/Task 标题上限（与项目展示名同量级） |
| `PLAN_TASKS_MAX_COUNT = 100` | 单计划任务数上限（0 合法：空草稿） |
| `PLAN_DEPENDENCY_EDGES_MAX_COUNT = 200` | 依赖边总数上限（各任务 dependsOn 之和） |
| `PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT = 32` | 单 Task 验收条目上限 |
| `PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH = 2000` | 单条验收正文上限 |
| `PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT = 8` | 单 Task 需求/验收引用上限（去重后） |
| `PLAN_FEATURE_SOURCE_REFS_MAX_COUNT = 16` | Feature 来源引用上限（去重后） |
| （复用）`DESCRIPTION_MAX_LENGTH = 10000` | Feature/Task 描述上限（同项目描述） |
| （复用）`LABEL_MAX_LENGTH = 64` / `LABELS_MAX_COUNT = 50` | 标签规则（normalizeLabels） |

边界语义：**边界值通过、越界拒绝**（如任务数 100 通过/101 拒绝、边数 200 通过/201 拒绝、
标题 200/201、验收条目 32/33、验收正文 2000/2001、Task 引用 8/9、来源引用 16/17、描述
10000/10001），均有测试（`test/p03-1-plan-validation.test.ts`）。

### 2.3 引用支持的形态与缺失判断

- 唯一支持的形态是**身份级制品引用**：`{ artifactId: <稳定 ID>, contentHash?: <64 位小写
  十六进制> }`。`contentHash` 携带时把引用绑定到具体内容版本；省略表示仅按 artifactId 引用。
  引用只描述身份，**不内联正文**，不接受路径、URL 或自由文本。
- **缺失判断**：`undefined` / `null` / `[]` 三种形态一律判为缺失并归一为空数组，纯校验不报
  错；存在时必须是非空数组且逐项通过形态校验。**必需性**（如「已约定必需引用」）不由纯
  校验判定，由 F-005 导入事务按当次导入契约重核（缺失、不可见或非可用状态的引用不能作为
  合法输入）。
- 完全相同的引用（artifactId 与 contentHash 均一致）静默去重；不同 contentHash 的同
  artifactId 视为两个不同引用。输出按 (artifactId, contentHash) 排序（摘要顺序无关的基础）。
- **归属与引用是否真实存在（同项目、ready、可见）不在纯校验范围**，留给事务提交重核；
  纯校验只保证引用形态合法、数量有界。

## 3. 同 Feature DAG 校验

依据 core-design/02 §8 与 core-design/11 §4：`task_dependencies` 两端必须是**同 Feature** 的
任务，UNIQUE(feature_id, task_id, depends_on_id)，无自依赖、无环。校验顺序（首错即抛，
确定性）：顶层结构与版本 → Feature 元数据 → 任务结构（含任务数边界）→ 依赖边总数边界 →
重复 ID → 逐边语义（自依赖/重复依赖/缺依赖/跨 Feature 依赖）→ 环检测。

| 场景 | 错误定位（details.field） | 节点定位（details 键） |
|---|---|---|
| 重复任务 ID | `tasks[i].id`（i=后出现者） | `taskId` |
| 缺依赖（目标不在本计划任务集） | `tasks[i].dependsOn[j]` | `taskId`、`dependsOnTaskId` |
| 跨 Feature 依赖 | `tasks[i].dependsOn[j]` | `taskId`、`dependsOnTaskId`（reason 含目标所属 Feature） |
| 自依赖 | `tasks[i].dependsOn[j]` | `taskId`、`dependsOnTaskId` |
| 重复依赖（同任务对同目标重复边） | `tasks[i].dependsOn[j]`（j=重复者） | `taskId`、`dependsOnTaskId` |
| 依赖环 | `tasks.dependencies` | `cycle`（环路径节点序列，首尾相同） |
| 依赖边总数越界 | `tasks.dependencies` | —（reason 含实测边数） |

- **缺依赖 vs 跨 Feature 依赖**：纯校验无数据库上下文，缺省时未知目标报「缺依赖：目标不在
  本计划任务集内」；调用方可通过 `options.externalTasks`（taskId → featureId 的只读映射，
  纯数据注入）提供解析上下文，命中时精确报「跨 Feature 依赖不被允许」。全部错误都带**字段或节点定位**；F-005 导入事务用真实库内解析复用同一函数。
- 所有错误均为 `StorageError(kind='validation')`，operation 默认 `FeaturePlan.validate`
  （可经 `options.operation` 覆盖为具体命令名），entity 取 `feature`/`task`，details 脱敏：
  只有 field/reason/节点定位/receivedType，**不回显输入正文**。

### 3.1 草稿语义

- **无 Task 的计划可校验为草稿**（`taskCount=0`、`executable=false`，**明确不可执行**）；
  合法三 Task 链通过纯校验后 `executable=true`——这只表示「结构上具备可执行前提」，不代表
  已批准、配置就绪或可启动 Run。
- 本任务（F-001）**不生成 Run、审批或模型调用**，不写任何持久化；校验与摘要均为纯函数。

## 4. 确定性业务摘要（planDigest）

- 定义：`planDigest = SHA-256(PLAN_DIGEST_DOMAIN + "\n" + canonicalFeaturePlanBusinessJson(plan))`，
  64 位小写十六进制；`PLAN_DIGEST_DOMAIN = 'shiploop:feature-plan-business:v1'` 锚定领域语义。
- **摘要输入（业务执行依据）**：Feature 标题/业务描述/来源引用；每个 Task 的 id/标题/业务
  描述/complexity/结构化验收（保持输入顺序，验收条目是有序清单）/需求引用/依赖边。
- **顺序无关**：JSON 键序、任务输入顺序、依赖边输入顺序、引用输入顺序变化，摘要一致
  （规范化时任务按 id 排序、依赖与引用按身份排序、对象键递归排序）。
- **变化即改变摘要**：需求引用、验收（内容/条数/顺序）、业务描述、依赖（增删边）、标题、
  complexity、任务 id 等已约定执行依据变化，摘要改变。
- **不改变业务摘要**：纯标签变化（labels 被明确排除在摘要输入外，F-007 标签编辑据此不改变
  planDigest）；revision、时间戳及策略来源说明——这三者**无法进入计划 payload**（未知键
  拒绝），因此不可能影响摘要；未来若执行策略字段进入计划输入，须归入非摘要元数据区并保持
  摘要稳定（见 §9.2）。
- 归一化等价：省略与 `null` 描述、缺失与空数组引用、省略与 `null` complexity、完全重复引用
  去重——摘要一致；零 Task 草稿仍有确定性摘要。
- **planDigest 不是 CAS 依据**：并发控制只看 Feature 聚合 revision（§6）；planDigest 供审批
  绑定与「实质修订使旧摘要批准失效」的变更识别（F-008），不是并发令牌。

## 5. 版本兼容

- `FEATURE_PLAN_SCHEMA_VERSION = 1` 是计划 payload 的独立结构版本，与
  `SETTINGS_SCHEMA_VERSION = 2`（配置 payload）、`WIRE_MESSAGE_SCHEMA_VERSION = 3`（线消息）
  **互不联动**，各自显式演进。
- 未知/更高 `schemaVersion` 一律拒绝（kind='validation'），**不静默降级**、不猜测旧格式。
- F-009 把计划命令接入 Host/HostClient 时，须按 P02-2 既定纪律评估线消息版本与能力集合的
  精确核验（能力集合变化需显式升版），本文不预先替 F-009 冻结线协议版本号。F-004 已在
  v3 内增量加入 `phase.create`/`phase.write`（与 P02-3 / F-014 在 v3 内扩张 `baseline.cancel`
  同一先例，见 §9.6）；升版评估仍归 F-009。
- 错误归属实体类型扩展：`StorageEntityType` 新增 `feature` / `task`（P03-1/F-001），供计划
  校验错误定位；持久化表随 F-002 迁移建立，错误类型先于表存在不构成存储承诺。

## 6. 导入与编辑契约（归属、CAS 与单一权威来源）

本节为 F-005（导入）/F-007（标签编辑）/F-008（实质修订）冻结的接入规则；F-001 本身不注册
命令、不建表。

### 6.1 新增操作的归属

- 计划导入与修订是 **project scope** 的应用命令（信封 `scope.kind='project'`），目标聚合是
  **Feature 聚合**（Feature + 其 Tasks + 同 Feature 依赖边，在同一写事务内整体提交）；Phase
  创建（F-004）归属 Phase 聚合，命名与行为已定案于 §6.4。计划导入/修订的能力命名（如
  `feature.plan.import` / `feature.plan.update`）与命令操作名由 F-009 冻结进
  `COMMAND_OPERATIONS`/`APP_CAPABILITIES`，本任务不预支。
- 计划 payload 只携带业务内容（§2.1）；projectId/phaseId/featureId 由命令信封（scope 与
  payload 外层字段，按 P02-2 信封规范）与导入事务解析，纯校验不查归属。

### 6.2 expectedRevision：唯一权威来源与创建/更新区别

- **唯一权威来源是命令信封顶层**（P02-2 §5.1 纪律的延续）：更新类命令必填 ≥1 整数；
  **计划 payload 内出现 `expectedRevision`（或任何 revision 形态字段）即按未知键拒绝**——
  **不建立两个 CAS 权威来源**，payload 与信封各说各话的输入根本进不了校验。
- **创建（导入新 Feature）**：不携带 expectedRevision（创建类命令禁止携带，P02-2 同纪律）；
  服务端生成初始 revision。
- **更新（编辑既有 Feature 的计划）**：必须携带恰好一个 expectedRevision，对应 **Feature
  聚合的 revision**。Task 与依赖边**没有独立 CAS**：实质修订（F-008）在 Feature 聚合的同一
  写事务内整体替换计划成员与边，一次 CAS 一次递增；标签编辑（F-007）与实质修订共用同一
  Feature 聚合 revision，竞争编辑由 CAS 裁决（同 revision 只有一个生效）。
- 纯标签编辑（F-007）只更新标签与 revision，planDigest 与 planStatus 不变；实质修订
  （F-008）更新 planDigest 并使旧摘要的批准不可继续生效。两类操作是**可区分的契约**，不是
  同一命令的两个模式。

### 6.3 事务提交重核（纯校验明确不做的事）

纯校验（本模块）只保证：结构、版本、边界、同 Feature DAG 与摘要确定性。以下事项由导入/
修订命令在**同一写事务**内重核，失败整组拒绝且不留半成功状态：

- 归属：projectId 存在且获准、Phase 存在/open 且同项目、Feature（更新时）存在且同项目同
  Phase；跨项目/跨 Phase 一律 ownership/conflict 拒绝；
- 引用：已约定必需引用真实存在、同项目、可见且处于可用状态（复用 Artifact 受控查询）；
- CAS：expectedRevision 与 Feature 聚合当前 revision 一致；
- 幂等：同 commandId 同参数重放返回原结果且零新增写入（P02 回执机制）。

### 6.4 Phase 创建命令（F-004 定案）

- 命令操作 `phase.create`（project scope、创建类、能力位 `phase.write`）进入
  `COMMAND_OPERATIONS`/`APP_CAPABILITIES`；payload 只含 `id`/`title`/`description`/`labels`
  业务字段，**严格未知键拒绝**：主体身份、批准、执行结果、状态、revision、projectId 等
  一律不能经请求输入；projectId 由信封 scope 携带，创建类禁止携带 expectedRevision。
- 稳定 ID：payload `id` 可缺省——缺省时服务端生成 UUID v4（与 F-002 存储原语同一定案），
  指定时按既有稳定 ID 规则校验并作为业务 ID 唯一性依据；重复业务 ID 按 `conflict`
  （`details.reason='phase_already_exists'`）拒绝并固化 rejected 回执（settings 首建
  already_exists 同一纪律），不覆盖既有 Phase、不写事件。
- 创建成功在同一 `BEGIN IMMEDIATE` 内写入 open Phase（revision=1）+ `phase.created` 脱敏
  事件（aggregate_type='phase'、payload 恒 `{"created":true}`）+ completed 回执（结果
  `{"phase": <公开 Phase 记录>}`：id/projectId/title/description/labels/status/revision/
  createdAt/updatedAt，不声称批准、可执行或执行结果）。
- 幂等沿用 P02 §5.5：同 commandId 同规范化参数返回原回执（`replayed:true`）且零新增实体/
  事件；不同参数 `conflict`（`idempotency_key_reuse`）。不可见或不存在的项目统一 `forbidden`
  （`project_not_visible`，不泄漏存在性）；非法元数据 `invalid_input` 定位到 payload 字段。
- 本命令不执行仓库脚本、不创建执行实体；关闭/重开/归档生命周期不在 P03-1 范围（验收明确
  只提供 Phase 建立入口）。

## 7. 测试与守护

- `test/p03-1-plan-validation.test.ts`：合法三 Task 链、空草稿不可执行、结构/DAG 负例全清单
  （重复 ID、缺名称、缺完整 acceptance、非法 complexity/标签、缺依赖、自依赖、重复依赖、环、
  跨 Feature 依赖）、全部边界值与越界值、错误脱敏。
- `test/p03-1-plan-digest.test.ts`：顺序无关、业务敏感性、纯标签/缺省归一不改变摘要、
  信封字段无法进入 payload、摘要构造（领域前缀 + 规范化 JSON 的 SHA-256）、规范化 JSON 字段
  白名单与排序。
- `test/docs-p03-1-plan-import-contract.test.ts`：本文档守护（基线事实、常量与实现一致、
  版本兼容、错误清单、CAS 契约、摘要规范逐项可核对）。
- `test/p03-1-phase-create-command.test.ts`（F-004）：真实 SQLite 应用测试覆盖 Phase 创建
  同事务持久化（Phase/脱敏事件/回执）与重开可读、幂等重放/参数冲突、重复业务 ID、
  非法元数据与提权字段、归属越权与不存在项目、三个写入边界故障整组回滚、无执行实体。
- F-002 起的真实 SQLite 迁移/存储原语、F-005 的真实导入事务与竞争测试按各自任务验收，
  不以本任务的纯函数通过冒充。

## 8. 范围边界（本任务不做）

- 不建 Phase/Feature/Task/依赖表，不做 Drizzle 映射（F-002）；
- 不做策略副本选择（F-003）、Phase 创建命令（F-004）、导入/修订应用用例与事务（F-005/
  F-008）、查询面（F-006）、Host/CLI 接入（F-009/F-010）；
- 不生成 Run、Attempt、Batch、审批或任何模型调用；不虚构「已批准/已执行」状态；
- 不实现 Feature 间（外层 DAG）依赖校验——本契约只覆盖单 Feature 内 Task DAG；外层 DAG
  随 Phase 成员管理另行定案。

## 9. 张力记录与请求核对

1. **`requirements_ref` 必填 vs 纯校验可选**：core-design/11 §4 tasks 表 `requirements_ref`
   为必填 TEXT，但任务验收只把「缺名称/缺完整 acceptance」列为纯校验负例。本契约把引用的
   结构存在交纯校验、必需性交导入事务（§2.3）。**F-002 定案**：迁移 v6 以多值 JSON 数组列
   `requirements_refs`（NOT NULL DEFAULT '[]'，身份级 {artifactId,contentHash?} 形态）落表，
   与本契约 §2.3 的多引用形态一致；「已约定必需引用」的必需性仍由 F-005 导入事务重核，
   DDL 不强制非空数组（空引用的草稿任务合法）。
2. **执行策略与摘要**：本契约把策略来源说明排除在业务摘要外（§4）；F-003 的
   executionConfig 副本与 configSource 是否永远不参与 planDigest（当前结论：不参与，
   策略变化不改业务计划身份，但 F-008 实质修订仍按需重算摘要仅因业务字段变化），**请求
   确认**。**F-003 定案**：策略副本与来源说明永远不参与 planDigest——策略选择是导入事务
   的服务端行为（不在计划 payload，§2.1），策略变化不改业务计划身份；副本形态与来源选择
   契约见 `docs/p03-1-task-strategy-selection.md`（`application/task-strategy-selection`）。
3. **验收条目顺序敏感性**：验收 criteria 视为有序清单参与摘要（重排改变摘要）；若后续认为
   条目顺序无业务含义，需在升版时调整（会改变既有摘要值，升级前必须冻结）。**请求确认**。
4. **边界数值**（§2.2 表）为实施契约值，设计未给定；沿用既有量级选定，**请求确认**后视为
   冻结值，修改须走契约修订并同步守护测试。
5. **Phase 稳定 ID 语义（F-004 定案）**：F-002 存储定案为「Phase/Feature 稳定 ID 由适配器
   生成 UUID v4」，而 F-004 验收要求「创建含稳定 ID…」且「重复业务 ID…拒绝」。定案：命令
   payload 的 `id` 可缺省（缺省生成 UUID v4，F-002 语义不变），指定时作为业务 ID 并启用重复
   拒绝（§6.4）；两者不冲突但语义边界需确认。**请求核对**。
6. **命令/能力集合在 v3 内扩张（F-004）**：`phase.create`/`phase.write` 进入冻结清单与 Host
   接线宣告（不漂移守护要求 Core 与接线同步），线消息 `WIRE_MESSAGE_SCHEMA_VERSION` 保持 3
   ——与 P02-3 / F-014 在 v3 内扩张（baseline.cancel）同一先例；「能力集合变化需显式升版」
   的评估仍由 F-009 按 P02-2 纪律执行。**请求核对**。
