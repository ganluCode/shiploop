# P07 负责人 walkthrough（使用 / 恢复演练与阶段审阅）

状态：待负责人执行。本文是操作与核对说明，不是验收结论；机器报告不能代替签署。

## 受测身份与前提

- 日期：由负责人填写；分支 `acceptance/p07` 由编排者从 `feat/p07/acceptance` 创建。
- 受测 commit：入口用 `git rev-parse HEAD` 记录完整 SHA；执行前工作树必须干净（入口 fail-closed）。
- Node/npm：Node 22.19.0、npm 10.9.3；锁文件 `package-lock.json`（npm，不使用 pnpm/yarn）。
- 平台：**仅正式支持 macOS（darwin）**。`accept:p07` 在非 darwin 上被入口拒绝；强沙箱、Windows/WSL/Linux 不在本阶段声明范围内。
- 前序资格：负责人核对 P07-1～P07-4 的分支链、祖先关系与交付证据并保存 `owner-baselines.json`；入口只验证其结构与 commit 祖先关系。

## 支持能力与边界（如实声明）

- **恢复**：在验证或提交边界终止自有 Host 后重启，先核对旧进程与 Git/工作区事实再显式恢复；未确认停止前保持隔离（quarantined）或拒绝，不自动重试、不派发新执行。四项不变量（代码保留、预算/deadline 不清零、依赖不误解锁、通知失败不重跑任务）由场景断言与证据文件同时证明。
- **原生恢复能力**：可信项目模式不是 OS 沙箱；Pi 会话续接是对话恢复，不是程序精确断点。原生存档缺失/损坏/不兼容、第二写入者与双存储不一致时明确拒绝或修复后继续；`unsupported`/`not_run` 不计为通过。
- **备份/归档**：`data.backup.create` 经真实 Host 导出 SQLite 在线备份与制品文件；`restore verify → prepare → confirm` 是独立离线维护入口，只发布到显式空目标根，不经 HTTP 替换正在运行的数据库。备份验证覆盖 manifest/数据库/迁移/制品哈希；**局限**：备份导出的是打包时刻的一致快照，不覆盖导出之后的增量；恢复目标是隔离数据根，不回写原根；checkpoint 明确 unsupported 时不冒充可恢复。
- **通知**：仅 `local-results` 本地渠道（冻结词汇），失败进入有界重试（默认 4 次、指数退避），投递独立于业务执行，不重跑任务；结果与原因经 Host/CLI 可查询。
- **能力缺口（如实保留）**：Feature finalization 的执行/收尾消费者是受信装配端口，默认生产 Host 不装配（capability gap 按设计保留）。因此全部 Task 通过后 Run 停在 `running` 等待最终核验，本阶段演示不宣称 Feature 交付完成。

## 负责人命令（示例；run-id 每次唯一，不复用旧目录）

```bash
node --version
npm --version
git rev-parse HEAD
git status --short
npm run accept:p07 -- --run-id p07-owner-<timestamp> \
  --prerequisites ./owner-baselines.json \
  --expected-commit <完整受测SHA> \
  --report-dir ./artifacts/acceptance/p07
```

- 默认模式执行：前序核验 → 可信范围去重测试（P07 文件 + 登记的必需底层回归）→ 恢复场景（绑定场景检查）→ 边界检查 → `verify --checks-only` 工程门禁。
- 显式全仓历史回归（不属于默认门禁）：

```bash
npm run accept:p07 -- --run-id p07-owner-<timestamp>-full \
  --prerequisites ./owner-baselines.json --full-regression
```

- 每条命令记录实际退出码。不要用上一次 run 的报告目录覆盖本次结果。

## 默认阶段范围与 verify / live / 签署的区别

| 项 | 语义 | 与阶段通过的关系 |
| --- | --- | --- |
| `accept:p07` 默认 | 当前阶段可信索引去重合集 + 必需底层回归 + 场景 + 边界 + `--checks-only` 工程检查 | 是离线检查的证据来源，不是签署 |
| `--full-regression` | 可信合集一次性全仓测试步骤 | 只有显式执行才记录 full-history 状态 |
| `npm run verify`（无参数） | 独立全仓工程门禁 | 默认入口不执行，报告记录 `not_run`；不等同已通过 |
| live | 真实模型/真实授权链路验证 | 需要负责人独立授权；未执行记 `not_run`，机器成功不能代替 |
| 负责人签署 | 人工确认时间、结论与证据 | 唯一的阶段放行依据；`nezha task report`、脚本绿灯、模型自称完成都不能代替 |

## 失败 / 超时 / 未运行的解释

- 步骤失败或超时后，后续步骤显示 `not_run`（不是 pass）；超时进程经停止核验后才清理资源，停止未确认保留现场并判失败。
- 场景记录三态：`pass` 要求期望达成、命令退出码 0、至少一条正常业务断言与清理确认；`not_run` 是完整结构化记录；`fail` 保留原因与执行错误链。零断言或仅退出码 0 不得通过。
- `deferred`：不在审阅影响边界内的历史测试逐项登记为 deferred/`not_run`（默认范围不删除任何测试）；只有 `--full-regression` 才执行完整可信并集。
- 敏感凭据与开发机绝对路径不进入报告；文本统一脱敏（哨兵 fail-closed）。

## 证据查验

- 入口结果：`runs/<run-id>/entry-result.json`；输入与范围：`runs/<run-id>/inputs.json`、`test-scope.json`；步骤日志：`runs/<run-id>/step-run/`。
- 场景证据：`runs/<run-id>/source/`（逐检查身份绑定的 sqlite/git/process/artifact/manifest/budget/notification/command/usage/cleanup 事实文件与 `result.json`）。
- 阶段报告：`reports/<run-id>/report.json`、`summary.md`；负责人可重算每条证据引用的哈希与身份（`verifyP07ReportDirectory`）。
- 产品报告：场景真实导出的 `products/feature.json` 绑定本次 runId/commit/输入摘要；缺失即阻塞，不得用 Nezha 编码报告冒充。
- 四项不变量：在 FR-1 演示场景（`p07-5-f012-closed-loop-demo`）的 before/after 证据与断言中同时成立。

## 安全清理

- 入口只清理自有的、带 `.owner` 标记的临时资源根；用户仓库、其他 run、历史报告与受管元数据不被触碰。
- 场景夹具清理顺序：自有进程树停止核验 → 事实导出 → 关闭 SQLite → 仅删除自有临时根；`cleanup_unconfirmed` 保留现场并阻止验收通过。
- 复核：`entry-result.json` 的 `cleanup.resourcesRemoved/processesGone` 与场景记录的 cleanup 状态一致。

## 本次 F-012 交付中修复的接线缺陷（负责人重点核对）

1. **Feature 报告会话归因**（`packages/core/src/adapters/sqlite/feature-execution-report-store.ts`）：P03-9 显式恢复后的新 Attempt 会话以旧会话为 parent 续接；原实现把链上会话归因到根 Attempt，导致恢复后报告违反线协议（`features.report.get` response_malformed）。现按各自 Attempt 归因；回归 `test/modules/cli/p03-10-feature-report-built.test.ts` 的 `[case:built-report-resumed-session-attribution]`。
2. **备份核验回执超限**（`packages/core/src/application/data-backup.ts`）：大型包（数百制品文件）的逐文件通过项使 `data.backup.verify` 回执超过 16 KiB 上限，命令以 internal 失败。现聚合为计数并有界保留问题项；回归 `test/modules/host/p07-3-f014-backup-host.test.ts` 的 `[case:verify-receipt-bounded-for-large-packages]`。

## 退出码与签署

离线预期事实：全部离线检查可 pass，manual（`P07-MANUAL-OWNER-GATE`）为 `owner_pending`、全仓历史为 `not_run` 时阶段总退出码仍为 1。只有负责人按相同身份封套记录实际命令、退出码、清理事实并明确确认后，阶段才能签署；签署不由入口、测试、模型或 `nezha task report` 自动生成。

- `accept:p07` 退出码：待负责人填写。
- `npm run verify` 退出码：待填写（默认范围未执行时留空并注明）。
- live：`not_run` / 由负责人填写实际证据路径。
- owner decision：`pending`。
