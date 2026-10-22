# P04-8 最终交付报告（F-010）

本交付包汇总离线矩阵、两个阶段入口和人工验收材料。工具与定向测试结果不构成 P04 阶段通过；P04 未放行，进入 P05 必须补齐独立阶段证据和负责人确认。

## 代码、工具和配置版本

前序受测基线为 `ff1b47957491221245065bd149951588a5153af8`；最终 F-010 提交通过 `git log -1 --format='%H %s' -- docs/p04-8-f010-delivery-report.md` 定位。定向测试针对 F-010 提交前工作树，最终提交不包含测试后未经验证的实现变更。人工阶段运行另用 `--expected-commit` 绑定其实际完整 SHA，不能借用本次临时项目 SHA。

| 项目 | 锁定/实测版本及来源 |
|---|---|
| Node / npm | 22.19.0 / 10.9.3；package.json、阶段配置及实际版本探测 |
| Git | 2.50.1 (Apple Git-155)，本次 macOS 实测 |
| 标准 Pi SDK | @earendil-works/pi-coding-agent 1.0.4；packages/host/package.json 与 package-lock.json |
| Pi agent-core / pi-ai | 1.0.4；package.json、package-lock.json；agent-core 是旧报告 SDK 字段的探测对象，不能代替 coding-agent 的安装证明 |
| TypeScript / Vitest | 7.0.2 / 5.0.3；package-lock.json |
| better-sqlite3 / Drizzle | 13.0.3 / 0.45.3；已安装包和锁文件 |
| 配置 | acceptance/p04.config.json configVersion=1；acceptance/p04.entry.json schemaVersion=1；acceptance/p04.checklist.json checklistVersion=1 |
| live 模板 | acceptance/p04.live.example.json schemaVersion=1，默认 approved=false，不是授权 |

正式运行还需保存 HEAD、tree、锁文件及配置 SHA-256、SDK 实际安装版本；离线报告已有 evidence/state/inputs.json 与证据哈希，缺失版本须记 unknown。

## 五层结论与计数

| 层次 | 本次状态 | 判据 |
|---|---|---|
| 定向测试 | 运行结果见下方证据记录 | F-010 的最终接线和交付边界用例 |
| Feature 索引合集 | not_run | Nezha 在最终代码上合并去重所有 Task 索引独立执行 |
| Phase 完整工程/集成 | not_run | 人工独立执行 accept:p04；保留全量工程门禁 |
| 真实 live | not_run | 每个场景另有授权、预算、真实证据；SDK 探针不能替代 Core Work 闭环 |
| 负责人确认 | pending | 负责人签署最终 SHA、证据和未决问题；模型不能代签 |

后四层当前计数为 pass=0、fail=0、not_run=3、pending=1；这是四个门槛的计数，不是冻结清单 16 个必需检查的统计。冻结检查计数来自每次 report.json 的 counts；manual pending 在清单 counts 中表现为 not_run，应另列 pending，不能相加重复计数。负例按预期拒绝属于定向测试通过，不能算作阶段业务场景通过。

## 命令、退出码和证据索引

本次本地实际执行命令与最终结果记录在本节的“本地验证记录”。完整 stdout/stderr 及真实退出码旁文件保存在 Harness 的 `verifications/F-010/runtime-logs/`；不在发布文档写开发机绝对路径。

- 交付接线测试：`node scripts/run-tests.ts test/modules/acceptance/p04-8-delivery.test.ts`。稳定 case 独立定位六种场景；使用真实临时 Git 项目、复制的入口和短 Node 子进程。全量门禁和 P04 大组命令仅捕获 argv，再替换为短进程；超时和停止不确定使用受控执行结果，非真实进程故障验收。
- [Task 索引](../test/index/phases/P04/features/P04-8/tasks/F-010.json)：当前新增测试及交 Nezha 的既有回归。
- [Feature 索引](../test/index/phases/P04/features/P04-8/feature.json)：全部 10 个 Task 的索引位置。F-001 原先缺少独立索引，本次补登记已有清单/报告测试，不修改历史任务状态。
- [故障矩阵总表](p04-8-f010-fault-matrix.md)：FR/T、文件、稳定 case 和公开能力限制。
- [人工清单与放行记录](p04-8-f010-manual-checklist.md)：可执行操作、证据核对和签署位置。
- [离线入口](p04-8-f008-phase-entry.md)：accept:p04 参数、观察、退出与保留现场契约。
- [live 入口](p04-8-f009-live-entry.md)：accept:p04:live 独立授权、预算、脱敏和支持限制。

离线原始证据：`runs/<run-id>/step-run/{run.json,state.json,steps/,logs/}` 与 `entry-result.json`。脱敏报告：`reports/<run-id>/{report.json,summary.md,evidence/}`；证据索引为 report.json 的 evidenceManifest。live 使用独立目录的 `evidence-index.json`、`events.jsonl`、`runner-result.json`、`report.json`；私有 runner-input.json/agent 不导出。

## 公开缺口与边界

- macOS、可信项目、默认单并发；Pi 默认工具没有强 OS 沙箱，HOME/资源选择隔离不等于网络或文件沙箱。
- 完整工程/跨 Feature 集成、真实 Core Work Run/Attempt/Recorder/持久预算链路尚无本次阶段证据；缺少产品 Feature 报告和逐项 SQLite/进程快照时，聚合器继续报告缺口。
- 已核对前序 F-009 的 `verifications/F-009/runtime-logs/test-posi125j.log`：全仓 typecheck exit=1，`test/modules/authorization/authorization-contract.test.ts:131` 为 TS2366，`test/modules/execution/control/p04-7-f001-stop-diagnostics.test.ts:57` 有两条 TS2322。本 Task 定向类型检查通过不清除这三条基线错误；未执行全仓复验，阶段完整工程门禁仍待解决并独立验证。
- live 当前只是独立 SDK 小改动探针，Core 业务闭环与外部 Bash/MCP/孤儿工具停止仍 not_run；真实认证、取消和实际用量均须获准后另验。required 生产续接不支持时拒绝，不能宣称 checkpoint 恢复、跨 provider 或缓存收益。
- 标准 Pi SDK 为默认；Pi Durable 保留实验候选，不进入本次生产依赖。Chat、其他 SDK 和其他平台不借用离线结果。
- 本次不修改 P05-P08 规划、模型套餐或活动执行配置。尚未通过项不能以已批准后置项替代；后置能力只按冻结清单 deferred 列示，未获批准的必需缺口继续阻塞阶段。

## 本地验证记录

- RED：`node scripts/run-tests.ts test/modules/acceptance/p04-8-delivery.test.ts`，`test-qynb0fww.log`，exit=1，2 项失败；交付文档及 Feature 索引尚未实现。初次 GREEN 为 `test-_t1vv9sk.log`，2/2、exit=0。
- 干净项目接线 RED：`test-6ovznrlr.log`（缺少 Node 路径脱敏导致拒绝报告）、`test-069zgyo9.log`（空 Git porcelain 被误判为 dirty）。修复仅登记已知 Node 可执行路径，并保留空 porcelain 的有效事实。
- 六场景及交付守护：`node scripts/run-tests.ts test/modules/acceptance/p04-8-delivery.test.ts --reporter=verbose`，`test-y4sylagk.log`，pass=10、fail=0、not_run=0，exit=0。其中 6 项是干净临时项目，4 项是交付文档、版本与索引核对。
- 定向 strict 类型检查：`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop --allowImportingTsExtensions --types node scripts/acceptance/p04-accept.ts scripts/acceptance/p04-integration-report.ts test/modules/acceptance/p04-8-delivery.test.ts`，`test-n5da3and.log`，exit=0。最初未传 TS7 所需的 --ignoreConfig，`test-f7ch0tfq.log` exit=1；这是命令校正，不是全仓类型检查结果。

- 文档收尾后及直接报告回归：`node scripts/run-tests.ts test/modules/acceptance/p04-8-delivery.test.ts test/modules/acceptance/p04-8-integration-report.test.ts -t 'case:delivery-|aggregates offline matrices|records traceable commit' --reporter=verbose`，`test-amsj29f8.log`，6 项通过（4 项交付守护复核、2 项既有聚合/脱敏回归），其余 11 项未选择，exit=0。连同六种接线场景，本 Task 本地共验证 12 个不同用例。

所有日志均位于 `verifications/F-010/runtime-logs/` 并附 `.log.exitcode`/`.log.json` 旁文件。较广回归只登记给 Nezha，本地未执行；完整工程/阶段/live/人审状态见前表。
