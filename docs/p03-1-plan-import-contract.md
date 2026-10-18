# P03-1 单 Feature 草稿计划导入 — 校验、DAG 与摘要契约

- 对应任务：F-001（在 packages/core 建立单 Feature 草稿计划的运行时校验、同 Feature DAG 校验与
  确定性 planDigest 计算，明确导入和编辑契约）。
- 文档状态：P03-1 实施前置契约 + F-001 交付的纯校验模块说明（F-002 ~ F-011 的协议依据之一，
  **不是阶段验收报告**，也不是已接入命令面/存储面的能力声明）。本文冻结时 SQLite 迁移仍止于
  P02 的 v5 前状态；P03-1 / F-002 已追加迁移 v6（phases/features/tasks/task_dependencies
  四表与 Drizzle 映射、CommandTransaction 插入原语，见
  `packages/core/src/adapters/sqlite/migrations.ts` 与 `ports/plan-store.ts`）；P03-1 / F-004 起
  `COMMAND_OPERATIONS` 增加 `phase.create`（能力位 `phase.write`、事件 `phase.created`，见
  §6.4），Host `/v1/commands` 通用路由随之受理该命令（接线宣告同步）；F-009 接入 Host
  传输与 HostClient，F-010 增补 CLI 计划入口（`phase create|list|get|labels`、
  `feature import|list|get|revise|labels`、`task list|get|labels`，计划文件为有界
  UTF-8 `--input`，均经 Host 公共客户端）。F-006 起 Core 查询面提供计划详情/层级列表/
  Task DAG（§6.6 定案，能力位复用 `project.read`，Host/CLI 线接入已由 F-009/F-010
  完成）。F-008 起实质计划修订命令
  `feature.plan.revise`（能力位 `feature.plan.revise`、事件 `feature.plan.revised`）进入
  白名单与 Host 接线（§6.8 定案）。F-005 起继续改变这些事实时必须同步更新本文与文档守护测试。
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
10000/10001），均有测试（`test/modules/planning/p03-1-plan-validation.test.ts`）。

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
  `SETTINGS_SCHEMA_VERSION = 2`（配置 payload）、`WIRE_MESSAGE_SCHEMA_VERSION = 5`（线消息，
  P03-2 / F-007 起；P03-1 / F-009 冻结时为 4）**互不联动**，各自显式演进。
- 未知/更高 `schemaVersion` 一律拒绝（kind='validation'），**不静默降级**、不猜测旧格式。
- **F-009 定案（升版 3 → 4）**：P03-1 把计划域四命令（`phase.create`/
  `feature.plan.import`/`plan.labels.update`/`feature.plan.revise`，F-004 ~ F-008 已在 v3 内
  增量宣告，见 §9.6）与六查询（§6.6）纳入握手能力集合。P02-2 纪律要求客户端对能力集合做
  精确相等核验，同版本号改集合违反「未知字段/集合一律拒绝」纪律，故显式升
  `WIRE_MESSAGE_SCHEMA_VERSION = 4`（Host `CURRENT_SCHEMA_VERSION` 同步；与 P02-3 / F-006
  的 2 → 3 同一升版理由）。旧 v3/v2/v1 客户端在握手/命令信封得到明确
  `unsupported_schema_version`（400），不猜测降级；发现 schemaVersion 与 protocolVersion
  不变；持久回执读取时以当前常量重盖 schemaVersion，升级不破坏既有库。
- **后续演进（P03-2 / F-007 定案：升版 4 → 5）**：P03-2 把 Task 策略编辑/计划决策/
  执行输入准备三命令与 `features.approvals` 审批查询纳入握手能力集合，按同一纪律显式升
  `WIRE_MESSAGE_SCHEMA_VERSION = 5`（Host `CURRENT_SCHEMA_VERSION` 同步）；旧 v4/v3/v2/v1
  客户端得到明确 `unsupported_schema_version`（400）。本节的 3 → 4 定案作为历史记录保留。
- 错误归属实体类型扩展：`StorageEntityType` 新增 `feature` / `task`（P03-1/F-001），供计划
  校验错误定位；持久化表随 F-002 迁移建立，错误类型先于表存在不构成存储承诺。

## 6. 导入与编辑契约（归属、CAS 与单一权威来源）

本节为 F-005（导入）/F-007（标签编辑）/F-008（实质修订）冻结的接入规则；F-001 本身不注册
命令、不建表。

### 6.1 新增操作的归属

- 计划导入与修订是 **project scope** 的应用命令（信封 `scope.kind='project'`），目标聚合是
  **Feature 聚合**（Feature + 其 Tasks + 同 Feature 依赖边，在同一写事务内整体提交）；Phase
  创建（F-004）归属 Phase 聚合，命名与行为已定案于 §6.4。**F-005 定案**：计划导入的
  能力位与命令操作名即 `feature.plan.import`（原示例命名即定案；实质修订/标签编辑命令随
  F-007/F-008 冻结），已进入 `COMMAND_OPERATIONS`/`APP_CAPABILITIES`（§6.5）；线消息
  `WIRE_MESSAGE_SCHEMA_VERSION` 保持 3（与 F-004 同一 v3 内扩张先例，见 §9.6；升版评估
  仍归 F-009）。
- 计划 payload 只携带业务内容（§2.1）；projectId/phaseId/featureId 由命令信封（scope 与
  payload 外层字段，按 P02-2 信封规范）与导入事务解析，纯校验不查归属。

### 6.2 expectedRevision：唯一权威来源与创建/更新区别

- **唯一权威来源是命令信封顶层**（P02-2 §5.1 纪律的延续）：更新类命令必填 ≥1 整数；
  **计划 payload 内出现 `expectedRevision`（或任何 revision 形态字段）即按未知键拒绝**——
  **不建立两个 CAS 权威来源**，payload 与信封各说各话的输入根本进不了校验。
- **创建（导入新 Feature，F-005 定案修订）**：Feature 聚合本身是新建，服务端生成初始
  revision=1，Feature 自身无 CAS、不建立两个 CAS 权威来源；但导入在目标 **Phase 聚合**上
  追加成员，信封必须携带恰好一个 expectedRevision（= 目标 Phase 聚合当前 revision），
  导入事务在同一写事务内 CAS 重核（不匹配固化 rejected；Phase 关闭/归档等 revision 变化
  后旧值导入失败）。本定案收窄 F-001「创建不携带 expectedRevision」的原表述——其原意是
  「新 Feature 无自身 CAS」，这一点保持不变；张力记录见 §9.7。
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

### 6.5 计划导入命令（F-005 定案）

- 命令操作 `feature.plan.import`（project scope、能力位 `feature.plan.import`；信封必带
  expectedRevision=目标 Phase 聚合 revision，§6.2 F-005 定案）；payload 只含
  `phaseId`（稳定 ID）与 `plan`（计划 payload，§2.1 结构），**严格未知键拒绝**：featureId、
  执行策略、批准、状态、revision 等一律不能经请求输入。计划深校验在应用层导入事务内复用
  `validateFeaturePlanInput`（操作名 `feature.plan.import`，错误字段定位 `payload.plan.*`），
  并以事务内真实库解析的既有任务身份为 `externalTasks` 精确区分缺依赖/跨 Feature 依赖。
- 同一 BEGIN IMMEDIATE 短事务内重核并原子写入：项目授权（不可见/不存在统一 forbidden）、
  Phase 归属/open 状态与聚合 CAS、既有业务 ID（计划任务 ID 与库内任何任务冲突即
  `task_already_exists` 固化 rejected）、需求/验收引用制品身份（复用 ArtifactStore
  `getArtifactInputRef` 同一契约语义：缺失 not_found、跨项目 ownership→forbidden、非
  ready 或缺内容身份 conflict→`artifact_not_usable` 固化 rejected；携带 contentHash 时与
  制品当前不可变内容身份不一致→`artifact_content_hash_mismatch` 固化 rejected）、当前
  全局/项目配置（事务内读取，`selectTaskStrategy` 复制完整策略与来源；无匹配
  no_strategy_match 抛 invalid_input 整组拒绝）。文件完整性 I/O 不在导入事务内（引用只做
  索引级身份重核）。
- 写入顺序：Feature（draft/plan_status=draft、服务端 UUID v4、planDigest）→ Tasks
  （pending、完整 acceptance/引用/complexity/策略副本与来源）→ 依赖边 →
  `feature.plan.imported` 脱敏事件（aggregate_type='feature'、payload 恒
  `{"imported":true}`）→ completed 回执（结果 `{feature, tasks:[{id}], validation:
  {taskCount, dependencyEdgeCount, executable}}`，feature 为公开记录形态；结果有界、不含
  策略副本正文；不声称批准/可执行/Task 通过）。零 Task 草稿合法且 validation.executable
  恒 false。幂等沿用 P02 §5.5（同 commandId 同规范化参数原回执、不同参数
  `idempotency_key_reuse`）。
- 本命令不创建 Batch/Run/Attempt、不写批准、不实现计划修订/标签编辑（F-007/F-008）或
  查询面（F-006）。

### 6.6 计划查询面（F-006 定案）

Core 应用层 `QueryService` 增加六个授权查询（`ports/queries.ts` 契约与窄读取端口、
`adapters/sqlite/plan-store.ts` 读取原语、`adapters/sqlite/query-store.ts` 门面装配）；直接
调用 Core 查询也走同一授权（不经 HTTP 也拒绝）：

- **操作身份**：`PLAN_QUERY_OPERATIONS` = `phases.list` / `phases.get` / `features.list` /
  `features.get` / `tasks.list` / `tasks.get`（方法名 listPhases/getPhase/listFeatures/
  getFeature/listTasks/getTask）；能力位**复用 `project.read`**（不新增能力位）。**F-009 定案**：
  六项进入握手能力集合（线消息升 v4，§5），Host 路由为集合根 + 查询参数的平坦形态——
  `GET /v1/phases?projectId=&limit=&cursor=`（phases.list）、`GET /v1/features?projectId=&phaseId=`
  （features.list）、`GET /v1/tasks?projectId=&featureId=`（tasks.list）与单段详情
  `GET /v1/phases/:phaseId` / `GET /v1/features/:featureId` / `GET /v1/tasks/:taskId`；父级身份
  是 Core 查询服务的显式输入（Host 不解析层级、不读 SQLite），嵌套/多段形态一律 404；
  limit 十进制整数文本在传输层把关、范围与游标由 Core 单一权威复核；HostClient 公共方法
  `listPhases/getPhase/listFeatures/getFeature/listTasks/getTask` 与四个计划命令方法
  （`createPhase/importFeaturePlan/updatePlanLabels/reviseFeaturePlan`）经既有 /v1/commands 与
  授权查询模式接线，completed 回执内嵌结果与新事件 payload 均有客户端线校验器。
- **详情查询（按实体 ID）**：稳定 ID 校验先于读取；返回真实父级（projectId/phaseId/
  featureId）、标题/描述/标签/revision、结构化验收与需求/验收引用、**完整策略副本与来源**
  （executionConfig + configSource/configSourceKey；Feature 另含 sourceRefs 来源引用）；
  `features.get` 含 planDigest、planStatus、validation（与 F-001/导入回执同源：taskCount /
  dependencyEdgeCount / executable=taskCount>0 结构前提）、notExecutableReasons（有界枚举
  `no_tasks`（空草稿）/ `plan_not_approved`（planStatus≠approved），只反映持久状态推导）
  与**完整同 Feature Task DAG**（节点 id 升序 + 依赖边按 (taskId,dependsOnId) 排序）。
  结果字段集冻结，**不虚构 Run/Attempt 结果**（本阶段不建执行实体）。
- **不可见/不存在统一 `not_found`**（details.reason=`plan_entity_not_found`，与 receipts.get
  同一防枚举纪律：不区分存在性、不回显归属/实体身份，策略副本/引用不随错误泄漏）；
  能力缺失仍先行 `forbidden`（capability_denied）。
- **层级列表**：`phases.list` 按项目（projectId）、`features.list` 按 Phase（phaseId）、
  `tasks.list` 按 Feature（featureId）；项目 + 父级显式传入，严格未知键拒绝（actorId/
  principal/capabilities/scope 等提权字段一律 invalid_input）；稳定 id 升序键集分页，
  `PLAN_LIST_DEFAULT_LIMIT=50` / `PLAN_LIST_MAX_LIMIT=200`（边界值通过、越界与非法分页
  参数在任何 SQL 之前 invalid_input）；空列表 `records=[]` 且 `nextCursor=null`，末页
  `nextCursor=null`（页末明确可识别）。
- **受控游标**：`plcur_v1_<base64url 紧凑 JSON {v,id,root,sk}>`（与事件游标同一纪律）；
  绑定数据根身份（root 16hex 指纹）+ 列表层级 + 项目 + 父级（sk=scope 指纹）；跨项目/
  跨父级/跨层级/坏游标一律 `invalid_input(invalid_cursor)`，绝不当从零读取。
- **可见性先于分页及计数**：能力 + 项目可见性核验先于分页参数校验与读取（不可见项目
  + 非法 limit 仍先 forbidden）；可见范围谓词随 SQL 下推（先收窄再分页）；受限主体列表对
  不可见/不存在项目 forbidden 且错误完全一致，全量范围下未知项目自然空页（不泄漏存在性）。
- **一致读视图**：`features.get` 的 Feature + Task + 依赖边取自**单一 BEGIN DEFERRED 读事务**
  （复用 F-010 `transactSqliteConsistentRead`，不另立第二套事务规则）；并发修订只能观察到
  完整修订前或修订后，绝不出现「新 Task 配旧边/旧摘要」的混合状态；嵌套于写事务内调用
  是编程错误（TypeError）。查询面全部只读（不写任何行/事件/回执）。

### 6.7 纯标签 CAS 编辑命令（F-007 定案）

标签是元数据（core-design/02 §10）：纯标签编辑与实质计划编辑是**可区分的契约**，
不是同一命令的两个模式（实质修订归 F-008）。命令操作 `plan.labels.update`
（project scope、能力位 `plan.labels.write`）进入 `COMMAND_OPERATIONS`/
`APP_CAPABILITIES` 并经既有 `POST /v1/commands` 通用路由接线；线消息
`WIRE_MESSAGE_SCHEMA_VERSION` 保持 3（同 F-004/F-005 v3 内扩张先例，升版评估仍归
F-009）。

- **payload 只含 `entityType`（`phase`/`feature`/`task`）/`id`/`labels`**，严格未知键
  拒绝：需求/依赖/验收/状态/批准/标题/描述/revision 等混入即 `invalid_input`
  定位 `payload.<key>`；`expectedRevision` 唯一权威来源是信封顶层（payload 内
  出现即未知键，§6.2 纪律不变）。`labels` 必须显式提交完整集合（`[]` 即清空，
  缺省不静默清空），复用既有 `normalizeLabels`（trim → NFC → ASCII 小写 →
  实体内去重；`LABEL_MAX_LENGTH = 64`、`LABELS_MAX_COUNT = 50`）。
- **expectedRevision 指向目标实体自身 revision**（core-design/02「须按实体
  revision 做 CAS」）：编辑只更新目标实体 labels 与自身 revision（连带
  updated_at），**标签不向父子传播**；计划内容、Task 策略副本、acceptance、
  引用、依赖边、planDigest 与 planStatus 一律不变。与 §6.2 的关系：Feature
  目标的标签编辑与实质修订共用同一 Feature 聚合 revision（同一 CAS 空间）；
  Phase 目标与 Phase 聚合 revision 同源（与导入 Phase CAS 同一计数）；Task
  目标按 Task 自身 revision CAS（与「实质修订整体替换无独立 CAS」的边界见
  §9.8 张力记录）。
- **CAS 与幂等**：旧 revision 在任何业务写入之前固化 rejected 回执（`conflict`，
  details `{reason:'conflict', expectedRevision, actualRevision, entityType}`）；
  同 revision 竞争编辑经单语句条件 UPDATE 裁决**仅一个生效**（revision 只增加
  一次）；同 commandId 同规范化参数重放返回原回执（`replayed:true`）且不再次
  增加 revision/事件，不同参数 `conflict`（`idempotency_key_reuse`，P02 §5.5）。
- **同事务脱敏事件**：编辑成功在写事务内追加 `phase.labels.updated` /
  `feature.labels.updated` / `task.labels.updated`（聚合为目标实体自身，
  aggregateRevision=编辑后 revision，payload 恒 `{labelsUpdated:true}`，不携带
  标签正文/批准语义）；三个事件类型进入计划域与公开事件白名单。
- **归属与拒绝**：项目把关先行（不可见/不存在统一 `forbidden`（
  `project_not_visible`））；跨项目目标 `forbidden`（`ownership_denied`）；目标
  缺失 `not_found`；非法标签/混入字段 `invalid_input` 定位 `payload.*`。上述
  拒绝不写任何业务数据（零实体/事件/回执）。完成回执结果**有界**
  `{entityType, id, labels, revision, updatedAt}`，不声称批准、可执行或执行结果。
- **approved 语义与活动输入不失效**（core-design/02：「不因单纯改标签使计划
  审批、Task 通过结果或活动 Run 失效」）：以纯规则 `PLAN_LABELS_EDIT_IMPACT`
  （`application/plan-labels-update.ts`，经 Core 公共入口导出：不改摘要/批准
  语义/计划内容/策略、不传播、不使批准与活动输入失效）+ 隔离测试装配验证
  （直接持久列预置 `plan_status='approved'`）；P03-1 **不增加生产审批/Run 创建
  入口**来制造测试前提。标签不参与 planDigest（§4 规范化白名单不含 labels），
  纯标签编辑不改变计划业务身份。

### 6.8 实质计划修订命令（F-008 定案）

未执行草稿的实质修订与纯标签编辑是**可区分的契约**（§6.7）。命令操作
`feature.plan.revise`（project scope、能力位 `feature.plan.revise`）进入
`COMMAND_OPERATIONS`/`APP_CAPABILITIES` 并经既有 `POST /v1/commands` 通用路由
接线；线消息 `WIRE_MESSAGE_SCHEMA_VERSION` 保持 3（同 F-004/F-005/F-007 的
v3 内扩张先例，升版评估仍归 F-009）。

- **payload 只含 `featureId`（稳定 ID）与 `plan`（修订后的完整计划载荷，
  §2.1 结构）**，严格未知键拒绝：`planStatus`/批准/执行结果/状态/revision
  等一律不能经请求输入；信封 expectedRevision 唯一权威来源不变，指向**目标
  Feature 聚合当前 revision**（§6.2 更新条款）。计划深校验在应用层修订事务
  内复用 `validateFeaturePlanInput`（操作名 `feature.plan.revise`，错误字段定位
  `payload.plan.*`），并以事务内真实库解析的既有任务身份为 `externalTasks`
  精确区分缺依赖/跨 Feature 依赖。
- **成员整体替换（一次 CAS 一次递增）**：修订在同一写事务内以最终成员/边全集
  整体替换 Feature 计划：既有 Task 按**稳定 ID 保留身份**（同一行更新，
  created_at/状态保留，revision 递增一次）；仅新 Task 按创建策略规则（F-003
  `selectTaskStrategy`）从本事务读取的当前配置复制完整策略与来源；被移除成员
  与全部旧边删除、新边插入（边插后不可变，整体替换而非逐边修改）；新成员
  ID 与库内任何其他 Feature 任务冲突即 `task_already_exists` 固化 rejected。
  **既有 Task 不因当前默认配置或 complexity 编辑自动更换 executionConfig**
  （替换原语在存储层强制保留策略副本列，仅业务内容列被替换）；Task 策略编辑、
  重新应用默认与执行输入快照属 P03-2。
- **同一写事务重核草稿可编辑性与活动执行输入保护**：Feature 业务状态非
  `draft`（未执行草稿语义）固化 rejected（`feature_not_draft`）；活动执行输入
  探测在同一写事务内调用（BEGIN IMMEDIATE 串行化，探测与写入间无竞争窗口），
  queued/running/paused/停止未知等活动依据固化 rejected
  （`active_execution_inputs`），探测失败 **fail-closed**——异常传播整组回滚、
  不写回执，绝不把查询失败默认为无活动；未来 start/claim 必须遵守**同一写
  事务与聚合 CAS 契约**（不能只在事务外查一次或用进程内布尔锁），与修订的
  竞争由同事务串行化 + Feature 聚合 revision CAS 裁决。P03-1 存储无
  Batch/Run/Attempt 表，生产装配默认探测即「无执行实体表」的能力边界宣告
  （`NO_ACTIVE_EXECUTION_INPUTS_PROBE`），不是查询失败兜底；本任务以受控
  测试装配注入探测验证保护规则，**不创建假 Run 表、不宣称已验证真实 Work
  竞争**。
- **批准绑定 planDigest（可独立测试的纯规则）**：实质变化（修订前后摘要不同，
  含清空/重建计划）使旧摘要批准不可继续生效——planStatus 回 `draft`；摘要
  不变（标签不在摘要输入内，纯标签变化经由修订载荷）不失效，planStatus 保持。
  修订后的草稿仍是草稿，不自动批准或启动执行；完整 Approval 记录/决策流程
  属 P03-2（本阶段不建批准表）。引用重核与导入同一契约语义（缺失 not_found、
  跨项目 forbidden 抛出；非 ready/内容哈希不匹配固化 rejected）。
- **CAS 与幂等**：旧 revision 在任何业务写入之前固化 rejected（`conflict`，
  details 携带 expected/actual/entityType）；同 revision 竞争修订/标签编辑共用
  同一 Feature 聚合 CAS 空间，仅一个生效；修订提交时保留成员 Task revision
  递增一次，使并发 Task 标签编辑的旧 revision 失效（§9.9 定案）；同 commandId
  同规范化参数重放返回原回执（`replayed:true`）零新增写入，不同参数
  `conflict`（`idempotency_key_reuse`，P02 §5.5）。
- **同事务脱敏事件与有界回执**：修订成功追加 `feature.plan.revised`（聚合为
  目标 Feature 自身，aggregateRevision=修订后聚合 revision，payload 恒
  `{revised:true}`，不携带计划正文/成员变更明细/批准语义）；completed 回执结果
  含公开 Feature 记录、`tasks:[{id}]`、有界 `memberChanges`
  （kept/created/removed 计数）与 `validation`（taskCount/dependencyEdgeCount/
  executable），不携带策略副本正文，不声称批准/可执行/Task 通过/无活动执行。
  失败（含写入故障）整组回滚：原 Tasks/边/摘要/revision/事件保持一致，不出
  现成功回执或删除历史证据。

## 7. 测试与守护

- `test/modules/planning/p03-1-plan-validation.test.ts`：合法三 Task 链、空草稿不可执行、结构/DAG 负例全清单
  （重复 ID、缺名称、缺完整 acceptance、非法 complexity/标签、缺依赖、自依赖、重复依赖、环、
  跨 Feature 依赖）、全部边界值与越界值、错误脱敏。
- `test/modules/planning/p03-1-plan-digest.test.ts`：顺序无关、业务敏感性、纯标签/缺省归一不改变摘要、
  信封字段无法进入 payload、摘要构造（领域前缀 + 规范化 JSON 的 SHA-256）、规范化 JSON 字段
  白名单与排序。
- `test/modules/planning/docs-p03-1-plan-import-contract.test.ts`：本文档守护（基线事实、常量与实现一致、
  版本兼容、错误清单、CAS 契约、摘要规范逐项可核对）。
- `test/modules/planning/p03-1-phase-create-command.test.ts`（F-004）：真实 SQLite 应用测试覆盖 Phase 创建
  同事务持久化（Phase/脱敏事件/回执）与重开可读、幂等重放/参数冲突、重复业务 ID、
  非法元数据与提权字段、归属越权与不存在项目、三个写入边界故障整组回滚、无执行实体。
- `test/modules/planning/p03-1-plan-import-command.test.ts`（F-005）：真实 SQLite 应用测试覆盖三 Task 链
  导入闭环（同事务 Feature/Tasks/边/策略副本/摘要/事件/回执与重开一致）、Phase CAS 与
  closed/archived 拒绝、重复既有任务 ID、引用重核（缺失/跨项目/非可用/哈希不匹配）、策略
  副本来源与配置不追溯、结构/DAG 负例零写入、五个写入边界故障整组回滚、空草稿不可执行、
  授权矩阵。
- `test/modules/planning/p03-1-plan-import-race.test.ts`（F-005）：三路跨进程真实竞争（导入×2 + 配置 CAS
  更新）——只提交满足重核条件的完整组、无半成功、每 Feature 策略副本内部一致、配置变化
  不追溯既有 Task。
- `test/modules/planning/p03-1-label-edit-command.test.ts`（F-007）：真实 SQLite 应用测试覆盖三实体标签
  编辑闭环（只改 labels/revision、不传播、摘要保持不变、同事务脱敏事件与重开一致）、
  approved 语义与活动输入不失效（隔离装配）、元数据 CAS（旧 revision 拒绝/同 revision
  竞争仅一个生效/跨进程真实竞争/重放不重复递增）、拒绝矩阵（非法标签/混入字段/跨项目/
  缺能力零写入）与三个写入边界故障整组回滚。
- `test/modules/planning/p03-1-label-edit-rules.test.ts`（F-007）：纯规则契约（标签编辑影响面、标签规范化
  上限复用、严格未知键、事务输入面、事件白名单与公开映射同源）。
- `test/modules/planning/p03-1-plan-revise-rules.test.ts`（F-008）：纯规则契约（修订影响面冻结面、批准有效
  性纯规则矩阵、生产无 Run 装配边界宣告、命令/能力/事件白名单同源、信封与替换原语输入
  严格未知键与结构/边界/依赖语义）。
- `test/modules/planning/p03-1-plan-revise-command.test.ts`（F-008）：真实 SQLite 应用测试覆盖保留/新建/移除
  成员整体替换闭环（既有身份与策略副本保留、新 Task 按当前配置、摘要/事件/回执同事务提交
  与重开一致）、活动执行输入保护（四类活动依据拒绝 + 探测失败 fail-closed + 保护与 CAS
  竞争受控装配）、非 draft 拒绝、批准摘要失效与纯标签不失效（隔离装配预置 plan_status）、
  旧 revision/同 revision 竞争/与标签编辑共用 CAS 空间、依赖环/缺依赖/跨 Feature 依赖、
  引用重核、新成员 ID 冲突、归属越权与缺能力零写入、六个写入边界故障整组回滚、幂等重放/
  参数冲突与空草稿修订。
- F-002 的真实 SQLite 迁移/存储原语按其任务验收，不以本任务的纯函数通过冒充。
- `test/modules/planning/p03-1-integration-regression.test.ts`（F-011）：正式构建产物局部集成回归——
  beforeAll 真实 `npm run build`，全部命令经真实 `packages/cli/dist/bin.js` 子进程，Host
  用 dist 产物（`test/helpers/host/dist-host-entry-catalog.mjs` 装配 dist/runtime + 受信
  测试能力目录，与 F-016 目录夹具同一纪律）；覆盖端到端主线（创建 Phase → 三 Task 导入 →
  重查 → host stop 三证据 + pid 实际退出 → 重新拉起查询一致 → 独立只读探针库重开审计
  行/事件序/回执三方一致 → 标签摘要不变 → 实质修订摘要改变 → 最终审计）、负例与
  幂等/CAS（非法计划零写入、同 commandId 重放零新增、旧 revision conflict）、生产构建
  边界（dist CLI 拉起生产 dist/start.js，空能力目录对 strategies 配置 fail-closed 且
  零写入）。交接与验证记录见 [p03-1-handoff.md](p03-1-handoff.md)。

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
6. **命令/能力集合在 v3 内扩张（F-004，已由 F-009 定案）**：`phase.create`/`phase.write` 进入冻结清单与 Host
   接线宣告（不漂移守护要求 Core 与接线同步），线消息 `WIRE_MESSAGE_SCHEMA_VERSION` 曾保持 3
   ——与 P02-3 / F-014 在 v3 内扩张（baseline.cancel）同一先例；「能力集合变化需显式升版」
   的评估已由 F-009 按 P02-2 纪律执行并定案：**升版 3 → 4**（§5），P03-1 计划域能力集合变更
   全部落在 v4 宣告内，旧版本客户端得到明确拒绝。
7. **导入命令的 expectedRevision 指向（F-005 定案）**：F-001 冻结「创建（导入新 Feature）
   不携带 expectedRevision」，但 F-005 验收明确要求以「约定的 expectedRevision」导入并在
   同一事务重核 CAS。定案：信封 expectedRevision 指向**目标 Phase 聚合**（导入在其上追加
   成员），Feature 自身仍为服务端 revision=1 的新建、无第二 CAS 权威（§6.2 修订）；F-007/
   F-008 的 Feature 聚合修订 CAS 沿用 §6.2 更新条款不变。**请求核对**。
8. **Task 标签编辑的 CAS 空间（F-007 定案）**：§6.2 冻结「Task 与依赖边没有独立 CAS」的
   语境是 F-008 实质修订在 Feature 聚合事务内整体替换成员（一次 CAS 一次递增）；而 F-007
   验收要求「编辑只更新目标实体标签和 revision」「同 revision 竞争编辑仅一个生效」，故纯
   标签编辑按**目标实体自身 revision**做 CAS 并递增（Task 标签编辑递增 Task 自身 revision，
   不递增 Feature 聚合 revision；Feature/Phase 目标与各自聚合 revision 同源，§6.7）。两条
   规则在各自语境内自洽；F-008 实质修订整体替换 Task 成员时对并发 Task 标签编辑的合并/
   失效语义随 F-008 冻结。**请求核对**。
9. **实质修订的成员合并/递增语义与命令命名（F-008 定案）**：（a）修订提交时保留成员的
   业务内容（含标签）以本次计划载荷为准整体替换——先行提交的并发 Task 标签编辑结果被
   修订载荷覆盖（聚合级整体替换语义，Feature 聚合 CAS 是唯一裁决权威）；保留成员行
   revision 递增一次（无论字段是否实际变化），使后续以旧 Task revision 的标签编辑经
   CAS 拒绝；新成员 revision=1；被移除成员的历史证据由事件流承载，不伪造成员「从未
   存在」。（b）命令操作名/能力位定案为 `feature.plan.revise`，事件
   `feature.plan.revised`（payload 恒 `{revised:true}`）；线消息保持 v3 内扩张先例（§9.6）。
   （c）生产无 Batch/Run/Attempt 表期间，活动执行输入保护以受控测试装配验证，生产装配
   默认探测是「无执行实体表」边界宣告而非查询失败兜底；引入执行实体后必须替换为同事务
   真实查询且保持 fail-closed 与聚合 CAS 契约。**请求核对**。
