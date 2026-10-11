# P02-4 人工审阅清单（FR-1/FR-2、T 索引子集与放行）

- 对应阶段：P02-4（P02 双客户端与初始化验收）。检查 ID 与证据字段以
  [../../docs/p02-4-acceptance-contract.md](../../docs/p02-4-acceptance-contract.md) 为准；
  操作步骤与验收复跑见 [../../docs/p02-4-operations.md](../../docs/p02-4-operations.md)；
  机器可读必需检查清单为 `acceptance/p02.config.json`。
- 适用平台：**macOS**（唯一正式支持与验收平台）；Windows / WSL / Linux 未验收。
- **状态：人工未审阅 = 未完成。** 本清单由负责人逐项审阅、填写 §8 并签字后才构成放行；
  任何脚本 pass、报告 `PASS` 或 Nezha 的 `completed` 都**不等于**放行，**不自动签字**，
  也不代替任何人工核对项。

## 1. 审阅边界

- P02-4 交付的是**阶段验收能力**（双 CLI 场景、负例组合、报告聚合、`npm run accept:p02`、
  干净快照复跑）与本文档；它不交付 Pi/Work、Web、rebind 等后序能力（见 §6）。
- 逐项核对必须落到**真实测试入口、`accept:p02` 报告与证据文件**（§7），不能只看测试数量
  或「正常完成」文本；`not_run` 永不折算通过。
- 审阅只读证据与公开命令面；**不得手工修改业务数据库、不得删除任何锁（含
  `host/writer.lock`）来推进或“修复”状态**（详见操作指南 §5）。

## 2. FR-1 逐项核对（阶段闭环演示；PRD `p02-acceptance.md` §3.2 FR-1）

| FR-1 分支 | 检查 ID | 实际测试入口 | 证据 | 人工核对 |
|---|---|---|---|---|
| FR-1 双 CLI 同数据根、唯一 Host | `P02-FR1-UNIQUE-HOST` | `test/p02-4-dual-cli-acceptance.test.ts` | 报告 `checks[]`、`evidence/`（`hostInstanceId`/锁/监听） | ☐ |
| FR-1 共享持久项目/配置状态 | `P02-FR1-SHARED-STATE` | `test/p02-4-dual-cli-acceptance.test.ts` | 双客户端返回值逐字段一致（`projectId`/`revision`/来源） | ☐ |
| FR-1 获准基线执行与双端查询 | `P02-FR1-BASELINE-OK` | `test/p02-4-dual-cli-acceptance.test.ts` | `operationId`、逐项检查、制品 `hash`/`size` | ☐ |
| FR-1 重启后仍能查询项目和检查结果 | `P02-FR1-RESTART-QUERY` | `test/p02-4-restart-acceptance.test.ts` | 前后 `hostInstanceId`、持久身份、旧凭据拒绝、启动次数不变 | ☐ |
| FR-1 边界：夹具准备失败不伪装通过 | `P02-PHASE-FIXTURE` | `test/p02-4-acceptance-controller.test.ts` | `fixture_status`、依赖项 `not_run`、证据保留、进程回收 | ☐ |
| FR-1 边界：必需检查未运行 → `not_run` | `P02-PHASE-NOT-RUN` | `test/p02-4-report-aggregation.test.ts` | 必需清单、缺失结果、聚合结论、退出码 | ☐ |
| FR-1 边界：重复运行不依赖上次残留 | `P02-ENG-CLEAN-REPLAY` | `test/p02-4-clean-replay.test.ts` | 两次退出 0、run-id/报告独立、`docs/acceptance/evidence-p02-4-clean-replay/` | ☐ |
| FR-1 工程门禁（verify 退出码） | `P02-ENG-VERIFY` | `npm run verify` | `report.json` 的 `steps[]`/测试计数 | ☐ |

## 3. FR-2 逐项核对（负例与证据；PRD `p02-acceptance.md` §3.2 FR-2）

| FR-2 分支 | 检查 ID | 实际测试入口 | 证据 | 人工核对 |
|---|---|---|---|---|
| FR-2 重复初始化/路径别名幂等 | `P02-FR2-DUPLICATE-INIT` | `test/p02-4-idempotency-acceptance.test.ts` | 两次 `projectId`、行数、元数据前后快照 | ☐ |
| FR-2 命令重放/参数冲突零副作用 | `P02-FR2-COMMAND-CONFLICT` | `test/p02-4-idempotency-acceptance.test.ts` | `replayed:true`、`idempotency_key_reuse`、副作用零断言 | ☐ |
| FR-2 源文件保留、未知脚本零执行 | `P02-FR2-SOURCE-PRESERVED` | `test/p02-4-repo-preservation-acceptance.test.ts` | HEAD/`git status`/文件摘要、哨兵零执行、产物清单 | ☐ |
| FR-2 认证/协议/范围/监听拒绝 | `P02-FR2-AUTH-REJECT` | `test/p02-4-negative-acceptance.test.ts` | 错误码、零副作用、`127.0.0.1` 绑定、脱敏扫描 | ☐ |
| FR-2 客户端退出/观察中断 | `P02-FR2-CLIENT-EXIT` | `test/p02-4-restart-acceptance.test.ts` | 退出码 4、`observation_interrupted`、Host 存活、零 stop/cancel | ☐ |
| FR-2 基线失败/未授权/执行异常 | `P02-FR2-BASELINE-FAILURE` | `test/p02-4-baseline-failure-acceptance.test.ts` | 检查状态/`reasonCode`、注册保留、失败证据不删 | ☐ |
| FR-2 证据与报告可验证、失败如实记录 | `P02-PHASE-REPORT` | `test/p02-4-acceptance-report.test.ts` | 报告 Schema、`evidence[]` 的 `hash`/`size`、脱敏、结论 | ☐ |

- 负例只有在**错误断言与副作用断言同时成立**时才计 pass；逐项核对时两类断言都要看。
- 每项核对以 `artifacts/acceptance/p02/<run-id>/` 的 `report.json`/`summary.md`/`evidence/`
  为准；核对人应抽查证据 `hash`/`size` 与报告重验结论一致。

## 4. 阶段支持的 T 索引子集与已知限制

| T 索引 | P02-4 实际覆盖子集（不宣称完整索引） | 已知限制（不覆盖） |
|---|---|---|
| T10 基础 | 受限 principal 跨项目/证据越权拒绝、凭据脱敏、payload 不提权（`P02-FR2-AUTH-REJECT`） | 审批流、运行时凭据注入 |
| T15 基础 | 重复 init/别名幂等、干净/脏仓库只读接入、失败基线不撤销注册（`P02-FR2-DUPLICATE-INIT`/`P02-FR2-SOURCE-PRESERVED`/`P02-FR2-BASELINE-FAILURE`） | 移动 rebind、多 clone 归档/删除边界、init 中断半注册恢复的产品级语义 |
| T17 | 双 CLI 竞争唯一 Host、认证/协议拒绝、旧实例/旧 token 拒绝、客户端退出 Host 存活 | —（前序覆盖，本阶段组合复验） |
| T23 | 监听覆盖拒绝、Host/Origin 拒绝、实际绑定 `127.0.0.1` 负例组合 | —（前序覆盖，本阶段组合复验） |
| T26 命令幂等 | 重放复用原回执零副作用、异摘要 `conflict`、超时先查回执（`P02-FR2-COMMAND-CONFLICT`） | T26 编号与设计 09「配置 CAS」不一致，按行为映射、待负责人统一编号（契约 §4.1/§8-1） |

其他已知限制：`stop_unconfirmed` 保留占用、需人工核对后才能重跑；P02-2 顶层帮助文案漂移
（契约 §8-6）待修正；证据脱敏不是通用秘密检测；未验收平台与后序能力见 §6。

## 5. 诊断与排障核对（与操作指南 §5 对应）

- [ ] 注册与健康独立：`registered` 不等于 `healthy`，无基线为 `not_run`（`no_baseline`），
      基线失败**不撤销注册**、不删失败证据（FR-1/FR-2 交叉）。
- [ ] 重复 init 幂等：同一 `projectId`/`already_registered`，原元数据不被覆盖（FR-2）。
- [ ] commandId 重放/冲突：`replayed:true` 零副作用；异参数复用 `idempotency_key_reuse`
      conflict 且原回执可查（FR-2）。
- [ ] 超时/响应丢失先查回执（`receipt get`），命中不重发、未知才有限重发（FR-2）。
- [ ] 认证/协议拒绝（`unauthorized`/`protocol_incompatible`/`unsupported_schema_version`）
      零副作用、不泄密（FR-2）。
- [ ] `failed`/`not_run`/`cancelled`/`timed_out` 如实展示、不伪装 `passed`（FR-2）。
- [ ] `stop_unconfirmed` 保留占用与诊断，不确认停止不重跑（FR-2）。
- [ ] 文档**不指导**手工修改业务数据库或删除锁来解决问题（FR-2 证据真实性）。

## 6. 平台、安全边界与未实现声明核对

- [ ] 正式支持仅 **macOS**；不把 macOS 结果外推为 Windows/WSL/Linux 已兼容。
- [ ] **可信项目 ≠ 强沙箱**：首版不提供强 OS 文件/进程沙箱，声明与实现一致（不冒充强隔离）。
- [ ] **未实现**不冒充完成：**Pi**/Work（模型执行、DAG、Scheduler/Runner）、**Web**（托管
      Chat、Web/Electron、配对界面）、**rebind**（移动 rebind、多 clone 归档）与强沙箱、
      审批流、通知、NAS/云端均为 `not_run`/未支持。
- [ ] 示例与文档无真实凭据、无开发机固定路径；报告/证据脱敏抽查通过。
- [ ] Harness 验证策略已记录：应对齐 `npm run verify`（Feature）与 `npm run accept:p02`
      （阶段），本轮**不修改**任何 Harness/executor 配置，对齐由操作者核对。

## 7. 证据位置

| 证据 | 位置 |
|---|---|
| 阶段验收报告（每次运行独立） | `artifacts/acceptance/p02/<run-id>/report.json`、`summary.md`、`evidence/` |
| 干净快照连续复跑证据 | `docs/acceptance/evidence-p02-4-clean-replay/`（`outcome.json`、`independence.json`、`build-scan.json`、`accept-runs/`、`logs/`） |
| 必需检查清单（机器可读） | `acceptance/p02.config.json` |
| 文档守护 | `test/docs-p02-4-operations.test.ts`（本清单引用的测试/证据存在性一并守护） |

## 8. 缺陷记录与放行（人工填写）

| 缺陷 | 严重度/影响 | 证据 | 修复 commit | 复验结果 |
|---|---|---|---|---|
| 待填写 | | | | |

任何影响数据一致性、项目隔离、凭据保护或验收真实性的问题都阻塞放行。文档或低风险改善可
明确留到后续，不隐式忽略。

- 受测 commit：________
- `npm run verify` 退出码与证据：________
- `npm run accept:p02` 报告（run-id）：________
- 干净快照复跑证据：________
- 已知限制/延期问题：________
- 结论：□通过，允许进入后续阶段　□有条件通过（写明条件）　□不通过
- 验收人/日期：________

**人工未审阅时本清单保持未完成状态：以上空白栏不预填、勾选框不预选、不自动签字；Nezha 的
`completed` 或任何脚本 pass 均不等于放行。**
