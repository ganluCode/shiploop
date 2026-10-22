# P04 阶段验收契约（含 P04-9 补充项）

状态：验收工具输入契约，不是已通过证明。P04 尚未放行，P05 进入门槛未满足。
本文件是 `acceptance/p04.config.json` 的 `plan.contractDoc`；工具实现的详细说明见
[阶段入口](p04-8-f008-phase-entry.md)、[集成报告](p04-8-f010-delivery-report.md)、
[P04-9 补充项交接](p04-9-f011-acceptance-handoff.md)。

## 1. 范围与层级

P04 覆盖原有八项 Feature（P04-1～P04-8）与末尾补充项 P04-9（持久派发队列与执行槽位）。
四类执行类别必须分开记录，不得互相顶替：

| 类别 | 含义 | 未完成时显示 |
| --- | --- | --- |
| offline | 确定性离线矩阵、步骤与 SQLite/进程/文件证据 | `not_run` |
| live | 显式批准的 provider/model、认证引用、预算与临时资源 | `not_run` |
| manual | 负责人确认、时间、结论并绑定受测 commit | `pending` |
| postponed | Pi Durable 生产引擎、Chat/桌面/强沙箱等后置能力 | `postponed` |

`offline` 使用显式 Fake 身份（`fake-provider`/`fake-model`、`network=denied`），
Fake 通过不等于 live 可用；`postponed` 不计入已通过数。Chat、桌面、通知、发布与
强 OS 沙箱不在本阶段放行范围。

## 2. 必需检查与计数

- 清单：`acceptance/p04.checklist.json`（`checklistVersion=1`），冻结顺序为
  FR 组（FR-1～FR-4）→ 验收编号组（T35～T44）→ 纵向演示组 → P04-9 补充组
  （`P04-P9-AC1`～`AC6`）→ deferred 组。
- 计数规则：必需项全部 `pass` 才算通过；deferred 只显示 `not_run`/`postponed`，
  不参与已通过计数；覆盖按必需断言判定，不按测试数量判断。
- 配置：`acceptance/p04.config.json`（`configVersion=1`）的 `requiredChecks`
  必须与冻结必需 ID 顺序完全一致；删减、重排、顶替或把 deferred 计入必需项一律
  `invalid_config`。
- P04-9 六项补充检查逐条对应 `input/p04-dispatch-foundation.md` §3.5 的六项验收，
  证据类别要求真实 SQLite/竞争/恢复记录；命令退出 0、旧清单八项成功或已通过 Task
  都不能替代。
- 冻结校验器更新时保留原有十六项必需断言与顺序；补充项只能追加在
  P04-VERT-MANUAL-BLOCK 之后、deferred 之前。

## 3. 阶段入口与冻结接口

- 入口：`npm run accept:p04`，实现 `scripts/acceptance/p04-accept.ts`。
- 入口声明：`acceptance/p04.entry.json`（`schemaVersion=2`），冻结步骤顺序
  `engineering-gate` → `p04-integration`、工程门禁 argv、集成 runner、测试索引根、
  必需 Feature 集合（P04-1～P04-9）与 P04-9 补充检查的 Task 索引报告映射。
- 测试索引：`test/index/phases/P04/features/<feature>/tasks/F-*.json`（Nezha v2）。
  入口校验 Feature 集合、v2 schema、项目 `shiploop`、显式 `all`/`cases`、路径归属
  与文件存在性，并按路径去重。P04-9 还必须提供 `feature.json`，其 Task 列表必须与
  磁盘索引逐一一致。
- 受测代码须已提交且工作树干净；步骤之间与报告前复核 HEAD/工作树漂移。报告目录
  已存在即拒绝复用；`--observe` 只读核验身份、步骤水位与报告哈希，不重跑、不补签。

## 4. 证据与报告

- 每项必需检查必须有真实断言、副作用核对和证据引用；检查声明的每个证据类别都
  必须由其证据引用覆盖，缺类别即阶段结论非零。
- 报告保存受测 commit/tree、工具版本、命令 argv/cwd/退出码/耗时、证据
  identity/category/sha256/size、清理事实、覆盖度与已知缺口；证据在临时资源清理
  前导出（`capturedBeforeCleanup=true`）。
- SQLite/Git/进程/清理 manifest 证据与产品 Feature 执行报告分层可追溯；缺产品
  Feature 报告时不得判定阶段通过。
- P04-9 补充检查在离线入口只写入 Task 索引导航证据（artifact），不绑定命令退出
  作为通过依据；SQLite/竞争/恢复证据未核对时保持 `not_run`。旧清单/旧报告因检查
  数量、顺序与清单摘要不匹配被拒绝，不能沿用旧成功。

## 5. 放行门槛

以下五项缺一不可，全部由人工独立发起或提交：

1. 定向测试（Task 级局部证据）；
2. Feature 索引合集（`task_union` 去重后在最终代码上执行）；
3. Phase 完整工程/跨 Feature 集成（人工发起 `npm run accept:p04`）；
4. 真实 live（每场景独立授权与预算，`npm run accept:p04:live`）；
5. 负责人确认（绑定最终 SHA、证据与遗留问题）。

工具交付、离线命令退出 0、`completed` 的 Task 或历史实验结论都不等于阶段验收通过；
负责人 hold 不能由模型或脚本清除。
