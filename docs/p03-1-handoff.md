# P03-1 领域归属与确定性计划导入 — 交接（P03-1 → P03-2 及 P03-10）

- 来源 Feature：P03-1（F-001 纯校验/摘要、F-002 迁移 v6 存储、F-003 策略选择、F-004 Phase 创建、
  F-005 计划导入、F-006 授权查询、F-007 纯标签编辑、F-008 实质修订与活动保护契约、F-009 Host/
  HostClient 接入、F-010 CLI 入口、F-011 局部集成回归与本文交接）。
- 交接对象：**P03-2**（后续计划/执行域 Feature）与 **P03-10**（阶段验收 `accept:p03` 提供方）。
- 输入文档版本：PRD `p03-plan-import.md`（版本 0.3，2026-10-11，重规划待审阅）、共同执行约束
  `execution-contract.md`（规划草案，2026-10-01）、实施契约
  [p03-1-plan-import-contract.md](p03-1-plan-import-contract.md)（F-001 前置契约 + §6.4/§6.5/§6.6/
  §6.7/§6.8 定案与 §9 张力记录）、[p03-1-task-strategy-selection.md](p03-1-task-strategy-selection.md)
  （F-003 契约）。
- 基线与代码：P02 验收基线 commit `0e76ad8`；P03-1 各 Feature 提交 F-001 `169bc4b`、F-002
  `88b4aa9`、F-003 `1d88e10`、F-004 `2219dd0`、F-005 `97f2a5e`、F-006 `c7fdbbc`、F-007
  `4add70e`、F-008 `96978e6`、F-009 `29781ae`、F-010 `5a9753c`；**F-011 交接提交即本文所在
  提交**（文档先于提交无法自引用完整 hash；精确 hash、验证命令/退出码与脱敏证据以 Feature
  工作区 `verifications/F-011/` 记录为准，未运行不计通过）。
- 本文只交接**已实现且已有真实测试**的公共面、Schema 与失败边界；未实现/未运行能力显式标注
  `not_run`。**P03-1 不提供 `accept:p03`**（由 P03-10 提供），也未运行真实 Pi live。

## 1. 实现范围（逐 Feature）

| Feature | 交付 | 主要落点 |
|---|---|---|
| F-001 | 单 Feature 草稿计划纯校验、同 Feature DAG 校验、确定性 planDigest | `packages/core/src/ports/feature-plan.ts` |
| F-002 | 迁移 v6 四表+ Drizzle 映射 + CommandTransaction 原子插入原语 | `adapters/sqlite/migrations.ts`、`schema.ts`、`plan-store.ts`、`atomic-commands.ts` |
| F-003 | 创建 Task 时按复杂度复制完整策略与来源（纯选择） | `application/task-strategy-selection.ts` |
| F-004 | `phase.create` 最小 Phase 创建命令（事件+回执同事务） | `application/command-service.ts` |
| F-005 | `feature.plan.import` 单 Feature 计划导入应用用例 | `application/feature-plan-import.ts` |
| F-006 | Phase/Feature/Task 详情、层级列表、Task DAG 授权查询（一致读视图） | `application/query-service.ts`、`adapters/sqlite/plan-store.ts` |
| F-007 | `plan.labels.update` 纯标签 CAS 编辑（三实体） | `application/plan-labels-update.ts` |
| F-008 | `feature.plan.revise` 草稿实质修订 + 活动执行输入保护契约 + 批准失效纯规则 | `application/feature-plan-revise.ts` |
| F-009 | 计划命令/查询接入 Host 传输与 HostClient（线消息 v3→v4 显式升版） | `packages/host/src/runtime/app-transport.ts`、`client/app-client.ts` |
| F-010 | CLI `phase|feature|task` 三命令组（12 子命令，`--input` 有界 UTF-8 计划文件） | `packages/cli/src/app/*`、`app-execute.ts` |
| F-011 | 正式构建产物局部集成回归（本文 §5/§6/§8 证据来源）与交接 | `test/p03-1-integration-regression.test.ts`、`test/helpers/host/dist-host-entry-catalog.mjs` |

## 2. SQLite Schema（迁移 v6，冻结事实）

- 迁移 v6 追加 `phases`、`features`、`tasks`、`task_dependencies` 四表；v1–v5 SQL/checksum 未改动
  （`test/p03-1-plan-structure-storage.test.ts`「历史 v1–v5 SQL/checksum 与开工冻结摘要一致」）。
- 关键约束：同项目/同 Feature 复合外键、`UNIQUE(feature_id, task_id, depends_on_id)` 依赖边、
  自依赖 CHECK、状态/JSON CHECK、`plan_digest` 形态 CHECK；`tasks(feature_id,id)` 唯一索引作复合
  外键目标。标签默认空数组且不继承。
- 空库与真实 P02 v5 库（项目、配置、Artifact、回执、事件）两条升级路径均真实测试；迁移失败回滚、
  高版本/checksum 漂移拒写继续有效（同文件用例）。
- **未建表**（不得提前）：Feature DAG、Batch、Run、Attempt、Approval、配置/计划版本表。

## 3. P03-2 可复用的实体/命令/查询（不得重建）

- **命令**（信封/能力位/回执/事件同事务纪律全部沿用 P02）：
  `phase.create`（`phase.write`）、`feature.plan.import`（`feature.plan.import`）、
  `plan.labels.update`（`plan.labels.write`，目标 Phase/Feature/Task 自身 revision CAS）、
  `feature.plan.revise`（`feature.plan.revise`，Feature 聚合 CAS）。命令面冻结于
  `packages/core/src/ports/commands.ts` 白名单。
- **查询**：`phases.list/get`、`features.list/get`、`tasks.list/get`（能力位复用 `project.read`；
  分页 limit 1..200、`plcur_v1_` 受控游标、单一 DEFERRED 读事务一致视图、不可见/不存在统一
  `not_found` 防枚举）。Feature 详情含 `planDigest`、`planStatus`、`notExecutableReasons`
  （`no_tasks`/`plan_not_approved`）与完整 Task DAG。
- **Host/CLI 线面**：线消息 schemaVersion **4**（F-009 显式升版，旧版本明确拒绝）；六查询路由
  `/v1/phases|features|tasks` 平坦形态；HostClient 公共方法 `createPhase`/`importFeaturePlan`/
  `updatePlanLabels`/`reviseFeaturePlan` + 六查询；CLI `phase create|list|get|labels`、
  `feature import|list|get|revise|labels`、`task list|get|labels`（`--revision` 唯一 CAS 入口）。
  真实纵向：`test/p03-1-plan-host-wiring.test.ts`（真实 Host+HostClient+SQLite 12 用例）、
  `test/p03-1-plan-cli-vertical.test.ts`（真实 CLI 纵向）与 F-011 集成回归（正式构建产物链路）。
- **摘要字段与批准失效规则**：`planDigest` 是规范化业务 JSON 的 SHA-256（顺序无关；纯标签/
  revision/时间戳/策略来源不参与）；批准绑定 planDigest 的**纯规则**
  `decidePlanApprovalValidity`（实质变化回 draft、摘要不变不失效）——完整 Approval 记录/决策
  流程是 P03-2 范围，P03-1 未实现。
- **策略副本来源**：`selectTaskStrategy`（userOverride > `modelMap.<复杂度>` > defaultStrategy，
  整体条目独立副本，不跨来源拼接）；`execution_config` 保存 schemaVersion=2 完整条目 +
  `config_source`（project_default/global_default/user_override）+ `config_source_key`（仅解释）。
  副本在创建/新成员加入时从事务内当前配置复制，之后**默认配置变化不追溯**既有 Task。
- **事件白名单**：`phase.created`、`feature.plan.imported`、`phase|feature|task.labels.updated`、
  `feature.plan.revised`（payload 恒为对应单键脱敏形状，见 `ports/plan-store.ts` 冻结清单）。

## 4. 活动保护接线约束（P03-2 start/claim 必须遵守）

- 草稿可编辑性与活动执行输入保护在**同一写事务**内重核（`feature-plan-revise.ts`）；queued/
  running/paused/停止未知等活动依据不能被实质修订覆盖；保护探测**fail-closed**（查询异常整组
  回滚，绝不默认为无活动）。
- 生产当前**无 Run 表**：边界以 `NO_ACTIVE_EXECUTION_INPUTS_PROBE` 显式宣告（能力边界声明，
  不是"已验证无活动"）；未来 start/claim 必须在同一事务与聚合 CAS 契约内写入活动依据，
  不能只在事务外查一次或用进程内布尔锁。
- **证据边界（必须如实区分）**：上述保护在 P03-1 由纯规则（`test/p03-1-plan-revise-rules.test.ts`）
  与**隔离测试装配**（`test/p03-1-plan-revise-command.test.ts` 注入 guards/预置状态）验证；
  真实 Work/Run 竞争**未验证**（Work 尚未实现，不宣称已验证）。

## 5. 负例矩阵复核（F-011 验收 2；均为真实 SQLite 测试）

| 矩阵项 | 证据（测试文件 / 用例） |
|---|---|
| 空库 / P02 v5 升级 | `p03-1-plan-structure-storage.test.ts`：「真实空库迁移到 v6」「真实 P02 v5 库…升级到 v6：既有数据与事件序列逐字段保留」「v6 迁移失败整组回滚」「高版本与 checksum 漂移拒写」 |
| 非法状态 / 外键 / 唯一约束 | 同文件：「不存在或跨项目父级由外键/复合外键拒绝」「跨 Feature 依赖、自依赖与重复边…」「非法状态与非法 JSON…」 |
| 依赖负例整组拒绝 | `p03-1-plan-validation.test.ts`（纯校验负例全清单）+ `p03-1-plan-import-command.test.ts`「计划结构/DAG 负例：自依赖、环、重复计划内 ID、跨 Feature 依赖…整组拒绝零写入」+ `p03-1-plan-revise-command.test.ts`「依赖环/缺依赖/跨 Feature 依赖失败…零业务写入」 |
| 策略缺失 / 默认漂移 | `p03-1-plan-import-command.test.ts`「策略副本来自事务内当前配置：无匹配拒绝整组；配置之后变化不追溯既有 Task」；`p03-1-plan-import-race.test.ts`（三路跨进程真实竞争：导入×2+配置 CAS 更新，不追溯）；纯选择拒绝矩阵 `p03-1-task-strategy-selection.test.ts`（无匹配/不完整覆盖/非法凭据引用/秘密正文字段） |
| 越权 | `p03-1-phase-create-command.test.ts`（归属越权/缺能力/不存在项目）；`p03-1-plan-import-command.test.ts` / `p03-1-plan-revise-command.test.ts`「授权：缺能力 forbidden；不可见项目 forbidden」；`p03-1-label-edit-command.test.ts`「跨项目目标/不存在目标/不可见项目/缺能力均拒绝且零写入」；`p03-1-plan-queries.test.ts`（受限主体统一 not_found 不泄策略） |
| 幂等 | `p03-1-phase-create-command.test.ts`、`p03-1-plan-import-command.test.ts`「同 commandId 同参数重放返回相同 ID/摘要且零新增写入；不同参数冲突且零写入」、`p03-1-label-edit-command.test.ts`「同 commandId 重放返回原回执且不再次增加 revision/事件」、`p03-1-plan-revise-command.test.ts` 重放用例 |
| CAS | Phase 聚合 CAS（导入）+ Feature 聚合 CAS（修订）+ 实体自身 revision CAS（标签）：`p03-1-plan-import-command.test.ts`「Phase 聚合 CAS…固化 rejected」、`p03-1-plan-revise-command.test.ts`「旧 revision…」「同 revision 竞争修订经 CAS 裁决仅一个生效」、`p03-1-label-edit-command.test.ts`「同 revision 竞争编辑仅一个生效（跨进程真实竞争）」；一致读视图 `p03-1-plan-queries-consistency.test.ts` |
| 事务故障 | `p03-1-phase-create-command.test.ts`（三注入点整组回滚）、`p03-1-plan-import-command.test.ts`（五写入边界故障整组回滚）、`p03-1-plan-revise-command.test.ts`（六写入边界故障整组回滚）、`p03-1-label-edit-command.test.ts`（三写入边界故障）——`test/helpers/p02-2/fault-injection.ts` 注入点 |
| 状态/事件/回执真实一致性 | 以上各用例 + F-011 `p03-1-integration-regression.test.ts` 端到端主线（进程重开查询 + 独立只读探针库重开审计：行/事件序/回执三方一致，见 §8） |

批准失效与活动保护证据归类：**纯规则** = `p03-1-plan-revise-rules.test.ts`、
`p03-1-label-edit-rules.test.ts`；**测试装配** = 预置 `plan_status='approved'`/注入 guards（不新增
生产审批/Run 入口）；**尚未实现的 Work** = 真实 Run/Attempt 竞争 not_run（Work 调度与 Runtime
执行属后续阶段）。

## 6. 验收索引映射（T02 / T03 存储子集 / T26 计划编辑子集 / T32 元数据子集）

「仅声明本项适用范围，不代表已通过」——以下为 P03-1 实际交付证据；标注 not_run 的部分不在
P03-1 范围，不得折算通过：

| 编号 | 必测行为 | P03-1 交付子集 | 范围外（not_run） |
|---|---|---|---|
| T02 | DAG 缺失依赖/环拒绝；依赖 passed 才解锁 | 缺失依赖/自依赖/重复边/环/跨 Feature 拒绝：`p03-1-plan-validation.test.ts`、`p03-1-plan-structure-storage.test.ts`（库约束层）、导入/修订整组拒绝用例（§5） | 「依赖 passed 才解锁」是执行解锁语义：无 Run/执行，P03-1 未实现（后续执行域 Feature） |
| T03（存储子集） | 原子认领、并发冲突、重复请求、状态事件事务一致 | 并发冲突（三路跨进程竞争 `p03-1-plan-import-race.test.ts`；CAS 竞争、一致读 `p03-1-plan-queries-consistency.test.ts`）、重复请求（幂等重放/参数冲突，§5）、状态事件事务一致（写入边界故障整组回滚 + F-011 库重开审计） | 「原子认领」为执行域认领语义：无 Run/Attempt 表，P03-1 未实现 |
| T26（计划编辑子集） | 当前配置 CAS 冲突、计划修改禁止越过活动执行、过期审批失效 | 配置 CAS：导入在事务内以当前配置重核（`p03-1-plan-import-command.test.ts` 策略副本用例 + race）；禁止越过活动执行：同事务保护 + fail-closed 探测（`p03-1-plan-revise-command.test.ts` 活动保护用例，装配验证）；审批失效：`decidePlanApprovalValidity` 纯规则（实质变化回 draft、纯标签不失效） | 「过期审批」完整生命周期（审批创建/时限）P03-2；真实活动 Run 竞争 not_run |
| T32（元数据子集） | Project/Phase/Feature/Task 标签数组校验、任一/全部筛选、跨项目与项目内分层计数；运行中改标签不改变批次范围或验收 | 四级实体标签数组校验（复用 normalizeLabels 64/50 上限）+ CAS 冲突 + 标签不传播/不失效计划：`p03-1-label-edit-command.test.ts`、`p03-1-label-edit-rules.test.ts`、`p03-1-plan-structure-storage.test.ts`（JSON 约束） | 任一/全部标签筛选、分层计数（查询能力未实现）；运行中改标签不变批次范围（无批次/运行，not_run） |

## 7. 完整门禁与验证记录（真实命令/退出码）

- `npm run verify`（预检 + `npm test` + `npm run typecheck` + `npm run build` 含三包入口冒烟）：
  exit 0；`npm test` 覆盖 **137 files / 3242 tests**（含 F-011 新增
  `test/p03-1-integration-regression.test.ts` 3 用例与 `test/docs-p03-1-handoff.test.ts` 8 守护）。
- `npm run check:boundaries`：exit 0（112 production source files / 0 diagnostics）。
- F-011 集成回归（正式构建产物 + 隔离真实 SQLite）：端到端主线（进程重开查询 + 库重开审计）、
  负例与幂等/CAS、生产构建边界（dist/start.js 空能力目录对 strategies fail-closed）3 用例 passed。
- `accept:p03`：**not_run**（P03-10 提供）；真实 Pi live：**not_run**；Windows/WSL/Linux：未验收。
- 单次运行的完整输出、退出码与脱敏证据路径记录于 Feature 工作区 `tool-logs/F-011-*.log` 与
  `verifications/F-011/`（本仓库文档不内联一次性 run-id/绝对路径）。

## 8. 已知缺口（不折算通过）

1. **能力目录装配**：生产 Host 入口目录为空（fail-closed），纯生产构建下 strategies 配置无法
   创建（`unknown_runtime` 拒绝、零写入——F-011 生产边界用例验证）。目录装配/来源是后续阶段
   范围；F-011 集成回归以受信测试目录装配（`dist-host-entry-catalog.mjs`，同一纪律与
   `detached-host-entry-catalog.ts` 一致），**不是产品能力放宽**。
2. **Work/Runtime 未实现**：无 Run/Attempt/Approval 表与执行入口；活动保护与批准失效仅有
   纯规则/测试装配证据（§4）。
3. **Phase 生命周期不完整**：仅 open 创建；closed/archived 管理属 P05；导入侧对 closed/archived
   Phase 拒绝已实现（`phase_not_open`）。
4. **模型规划/Feature DAG/配置与计划版本表**：PRD 明确不包含；P03-2 起按阶段说明实施。
5. PRD 验收 1–4 与契约 §9 各张力记录均已由对应 Feature 定案或记录请求核对；未决核对项不阻塞
   P03-1 局部交付（详见契约 §9）。

## 9. 交接纪律

- P03-2 起步基线 = F-011 交接提交（§开头记录方式）；开工前核对公共接口与真实测试，不把本文
  历史表述当现状。
- 不得重建：命令信封/回执/事件体系、授权查询模式、配置体系、SQLite 迁移（只能从 v6 追加）。
- 不得弱化：fail-closed 探测、防枚举 not_found、脱敏事件、幂等/CAS 纪律、「不宣称执行」边界。
- 本文档事实与守护测试 `test/docs-p03-1-handoff.test.ts` 同源；后续 Feature 改变这些事实时必须
  同步更新本文与守护。
