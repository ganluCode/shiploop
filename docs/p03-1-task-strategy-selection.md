# P03-1 Task 策略副本与来源选择契约（F-003）

- 文档状态：F-003 交付的纯选择模块契约 + 实施契约值记录（F-005 导入事务、F-011 查询面的协议依据之一）。
- 实现入口：`packages/core/src/application/task-strategy-selection.ts`（经 `shiploop-core`
  公共入口导出：`selectTaskStrategy` / `validateTaskExecutionConfig` 与全部常量；
  结构化错误 operation 固定为 `TaskStrategySelection.select`）。
- 本模块是**纯函数**：不读时钟/文件系统/网络/数据库，不解析凭据引用，不创建 Task、
  不写执行快照；import 本模块无副作用。
- 本文不是阶段验收报告；Task 创建事务、来源存在性核验由 F-005 在提交时重核。

## 1. 职责与复用

创建 Task 时按已确认复杂度/defaultStrategy 解析契约**选择整体条目**，复制完整策略
与来源到 `tasks.execution_config` / `config_source` / `config_source_key`。复用既有
校验，不另立第二套：

- 来源 payload（global/project）经 `mergeEffectiveSettings` 重新以 schemaVersion=2
  校验（`SETTINGS_SCHEMA_VERSION = 2`；未知键、不完整条目、非法政策、秘密正文字段、
  非法引用一律带字段定位拒绝）；完整条目整体替换与不跨来源拼接 runtime/provider/model
  由合并层保证（`docs/p01-3-application-contract.md` §5.3）；
- `userOverride`（明确完整用户覆盖）与 `execution_config` 副本语义经
  `ports/settings-schema.ts` 的完整条目校验 `validateRuntimeStrategy`（同一套
  schemaVersion=2 条目规则）。

## 2. 选择与回退优先级（解析契约）

| 优先级 | 命中条件 | 输出来源 |
|---|---|---|
| 1 | `userOverride` 提供（明确完整用户覆盖） | `user_override` |
| 2 | 已确认复杂度（low/medium/high）且有效配置有 `modelMap.<complexity>` | 该条目既有来源 |
| 3 | 回退 `defaultStrategy`（复杂度缺省/null、或无对应 `modelMap` 条目时） | 该条目既有来源 |
| 无匹配 | 以上均未命中 | `no_strategy_match` 明确拒绝 |

- **整体条目**：命中即复制完整条目（runtime/provider/model/credentialRef?/endpointRef?），
  绝不跨来源拼接 runtime/provider/model（项目条目缺字段在校验阶段即报错，不借全局
  字段拼成「有效策略」）；
- **不猜**：无匹配（no_strategy_match）即配置错误——不猜复杂度、不注入任何默认厂商/
  模型、不静默降级（core-design/06 §3「无匹配则配置错误」）；
- 复杂度取值复用配置复杂度词汇（low/medium/high，`TASK_COMPLEXITY_VALUES`）；
  非法复杂度明确拒绝；复杂度以后改变也不自动换模型（副本落库后不追溯）。

### 2.1 已确认契约来源与实施契约值（回退优先级）

- 已确认：core-design/06 §3「创建编码Task时：复杂度策略→项目Agent明确覆盖→默认策略。
  完整条目一旦命中便校验……无匹配则配置错误」；core-design/11 §3.1「创建Task时Core按
  用途和复杂度选出完整策略复制到execution_config……config_source为
  project_default/global_default/user_override，config_source_key记录modelMap.low或
  purposeStrategies.planner等来源，仅供说明，不是执行时动态引用」。
- **实施契约值（设计未逐项给定，记录并核对后实现，见 §9）**：
  1. `userOverride`（创建输入的明确完整用户覆盖）优先于复杂度条目与 defaultStrategy；
  2. 复杂度缺省/null、或 `modelMap` 无该复杂度条目 → 回退 `defaultStrategy`；
  3. 无复杂度索引时不猜 `modelMap` 条目（复杂度未确认且无 defaultStrategy 即拒绝）；
  4. `agentOverrides` / `purposeStrategies` 不参与本任务的选择（需要 Agent/用途身份，
     创建 Task 输入没有该身份，另行定案）。

## 3. 来源与 sourceKey（仅作解释）

| 场景 | configSource | configSourceKey |
|---|---|---|
| 命中项目当前配置条目（合法项目覆盖） | `project_default` | `modelMap.low` / `defaultStrategy` 等（来源键路径） |
| 继承全局默认条目 | `global_default` | 同上 |
| 创建输入的明确完整用户覆盖 | `user_override` | `userOverride`（来源键路径，常量 `TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY`） |

**来源仅作解释**：`config_source` / `config_source_key` 是纯说明字符串（来源键路径 +
来源 scope 信息在合并结果中），不是执行时动态引用、不是运行时动态路由；执行使用
Task 副本，不重新读取 modelMap。

## 4. execution_config 副本形态（F-003 定案）

`tasks.execution_config` = **schemaVersion=2 标记 + 完整条目扁平副本**（core-design/11
§3.1 执行配置字段子集）：

```jsonc
{
  "schemaVersion": 2,        // SETTINGS_SCHEMA_VERSION 标记（副本格式门槛）
  "runtime": "…",            // 必需
  "provider": "…",           // 必需
  "model": "…",              // 必需
  "credentialRef": "…",      // 可选；引用字符串，非明文
  "endpointRef": "…"         // 可选；引用字符串，非带凭据 URL
}
```

- 副本是**全新独立对象**：调用方输入对象后续变化不改变已生成副本；重复调用不共享引用；
- core-design/11 §3.1 提到的推理参数/允许的非敏感环境参数在当前 schemaVersion=2 策略
  条目中未定义，不在副本中编造；随策略结构演进按版本契约追加；
- 副本完整语义校验入口：`validateTaskExecutionConfig`（schemaVersion 门槛 + 完整条目
  校验；round-trip 与选择输出逐字段一致）。

## 5. 拒绝矩阵（明确拒绝，不静默降级）

| 情形 | 结果 |
|---|---|
| 缺任一必需策略字段（runtime/provider/model） | 带字段定位拒绝（如 `userOverride.model`、`payload.strategies.modelMap.low.model`） |
| 无匹配的已确认默认（no_strategy_match） | 明确拒绝（`details.reason='no_strategy_match'`），不注入任何默认厂商/模型 |
| 不完整覆盖（userOverride 缺字段） | 拒绝，不从默认条目拼补（无「拼出有效策略」路径） |
| 非法凭据引用（带凭据 URL） | `credential_in_url` 拒绝，错误**不回显**秘密正文 |
| 秘密正文字段（apiKey/token/password 等） | 未知键拒绝，错误**不回显**秘密正文 |
| 未知字段（策略条目/副本/选择输入/payload 任意层） | 拒绝（schemaVersion 限定结构不接受任意对象） |
| 非法复杂度取值 | 带字段定位拒绝 |
| `userOverride: null` | 拒绝（无 null=清除语义；「不覆盖」请省略该键） |
| 无效来源 scope payload | 由 mergeEffectiveSettings 拒绝，不降级成另一来源 |

## 6. 合法 ≠ 可执行

选择成功只表示**结构合法的完整策略副本**。本模块不装配 Runner/认证/模型执行能力，
不产出可执行声明；`assessSettingsConfiguration` 在生产能力未装配时恒
`executable: false`（`execution_capability_not_assembled`）。不因生产 Runtime 能力
未装配而把合法草稿策略说成已可执行。

## 7. 测试与守护

- `test/modules/planning/p03-1-task-strategy-selection.test.ts`：各复杂度整体副本、三来源与 sourceKey、
  覆盖优先级与回退、无策略/无匹配、完整性与拒绝矩阵（缺字段/不完整覆盖/秘密正文/
  非法引用/未知字段/非法复杂度）、副本独立性、不硬编码模型（源码无厂商/模型字面量
  + 输出严格来自配置条目）、合法 ≠ 可执行、`validateTaskExecutionConfig` round-trip
  与拒绝矩阵、公共入口导出。
- `test/modules/planning/docs-p03-1-task-strategy-contract.test.ts`：本文档守护（常量与实现一致、
  优先级/来源/拒绝矩阵/范围边界逐项可核对）。
- 合并层（整体替换、来源解释）回归见 `test/modules/configuration/effective-settings-merge.test.ts`；
  条目校验回归见 `test/modules/configuration/settings-schema-v2.test.ts`。

## 8. 范围边界（本任务不做）

- **Task 策略编辑**（无活动 Attempt 时的显式编辑）与**重新应用默认**（预览 +
  显式确认）：随 T24 后续任务实现；
- **凭据解析**（CredentialProvider 临近执行解析引用）与 **Attempt 快照**（下一次
  Attempt 保存实际输入 JSON 快照与摘要）：不在本任务；
- `agentOverrides` / `purposeStrategies`（planner/judge/review）参与的选择：需要
  Agent/用途身份，另行定案；本任务只覆盖编码 Task 的复杂度/defaultStrategy 解析；
- 不创建 Task、不写库：副本落库与归属/CAS 重核是 F-005 导入事务的行为；
- 不做 Runtime 能力核验（`RuntimeCapabilityCatalog`）与执行编排。

## 9. 张力记录与请求核对

1. **userOverride 优先级**：core-design/06 §3 的链条为「复杂度策略→项目Agent明确
   覆盖→默认策略」，未显式描述创建输入的用户覆盖位置。T24 有「用户覆盖」语义
   （config_source=user_override），F-003 把创建输入的明确完整用户覆盖置于最优先
   （显式意图高于任何默认解析）。**请求核对**。
2. **回退优先级**：复杂度缺省/null 或无 `modelMap` 条目时回退 `defaultStrategy`、
   无复杂度索引时不猜 `modelMap` 条目，是本任务的实施契约值（设计只给链条与
   「无匹配即配置错误」）。**请求核对**。
3. **agentOverrides 不参与**：设计链条中间项「项目Agent明确覆盖」需要 Agent 身份，
   创建 Task 输入无该身份；强行猜 Agent 或把 agentOverrides 当作 user_override 都会
   改变领域语义，故本任务不实现，**请求核对**后随 Agent 身份契约补齐。
4. **execution_config 字段集**：schemaVersion 标记 + 完整条目扁平副本为实施契约值
   （core-design/11 §3.1 的推理参数/非敏感环境参数在 v2 策略条目中未定义，未编造）。
   **请求核对**；策略结构演进须升版并同步本守护。
5. **config_source_key for user_override**：取值 `userOverride`（选择输入的来源键
   路径）是实施契约值（设计只举例 `modelMap.low`/`purposeStrategies.planner`）。
   **请求核对**。
