# P04-6 / F-007 跨场景确定性回归交接

## 实现与修复

本 Task 新增七个稳定 case：用量组合五个、效率组合一个、真实 Host/构建 CLI 组合一个。用量使用受控观察事实，效率使用受控时间边界；Host/CLI 使用真实临时 SQLite、loopback Host 和正式构建产物，不调用真实模型。

回归暴露并修复 `packages/core/src/application/usage-normalization.ts` 的两个问题：

1. 有已知小计和无法确认恢复基线的累计观察时，已知小计仍保留，但覆盖度应为 `partial`，不能显示为 `reported`；全部无法确认时保留 `unknown` 和 null。
2. 模型维度分组曾重新归一化子集，使全局已经排除的模型归属冲突或父级汇总的叶明细重新计入。现在先对全量观察归一化一次，再从同一结果投影 Attempt/Task/Run/Feature 和 runtime/provider/model；各层共享去重决定。

不改变原始 usage 证据；恢复来源、累计基线、未归属原因、重复事件原因继续保留。

## 验收场景映射

| 范围 | 仓库文件与稳定 case | 关键断言 |
| --- | --- | --- |
| 多 Attempt、最终累计、恢复与模型 | `test/modules/runtime/p04-6-usage-cross-scenarios.test.ts`：`attempts-final-baseline-switch`、`unattributed-replay-coverage`、`model-attribution-consistent` | 三次 Attempt、两个 Run、累计恢复 150−100=50、重复 final 排除、恢复引用和基线保留；总 input=180，模型维度与总计一致，无法归属维度为 null/unknown |
| 缓存与 reasoning、父子汇总 | 同文件：`cache-weighted-missing-zero`、`parent-child-once` | input=1000、output=100，不叠加缓存或 reasoning；缓存加权率 170/1000=0.17；缺字段不填零，混合/合成来源、partial/unknown、零分母、父级与叶明细择一 |
| 效率与后台测试 | `test/modules/runtime/p04-6-efficiency-projection.test.ts`：`cross-stage-lifecycle`，沿用 `background-lifecycle`、`background-real-exit`、`overlap-and-stages` 等 | started/running 的 2ms 启动回执不能作为真实测试耗时，补齐终态后为 100ms；重复/逆序事实结果相同；失败/取消请求、退避、工具、验证、Git、收尾累计 400ms，并发活动区间并集 260ms；缺边界保持 null/partial；既有真实 IPC 子进程仍覆盖启动与退出 7 |
| 失败/取消/返工与完整查询 | `test/modules/cli/p03-10-feature-report-built.test.ts`：新增 `built-usage-diagnostics-history` | 三次 Attempt 分别 failed/cancelled/succeeded，latest 与累计/前驱链并存；全部三项 Task 返回，未执行 Task 保留未知；两个模型累计 1000/50；Feature input=1050、output=105、缓存 180/1050，synthetic 明示 |
| Host/CLI 只读与脱敏 | 同新增 built case | HostClient、CLI JSON 与重复查询逐字段相等；文本含完整历史和模型信息；跨项目拒绝；查询前后数据库快照相同；无效证据中的合成秘密、原生路径和 Host token 不进入公开结果 |
| 分页、一致快照、严格协议 | 索引复用 built `built-report-parity`、`built-report-errors`，Host 与 delivery 既有真实 SQLite 用例 | 超过 128 条 Attempt 的 keyset 分页、WAL 写入隔离、重复关联去重、只读、权限边界、缺证据、严格线协议、CLI JSON/text parity；本 Task 仅登记，由 Nezha 独立执行 |

新集成用例显式按 Attempt 绑定 settlement 的 `executionVersion`，避免旧 helper 固定写入 1 导致后续 Attempt 证据被正确拒绝。

## 本地验证证据

日志根目录为 Feature workspace 的 `verifications/F-007/runtime-logs/`。使用 `.dag_context.json` 指定的 `nezha.dag.test_command` 包装器，完整 stdout/stderr 和结果 JSON（含原始退出码）均保留。

| 命令（包装器后的实际 argv） | 结果 | 日志 |
| --- | --- | --- |
| `node scripts/run-tests.ts test/modules/runtime/p04-6-usage-cross-scenarios.test.ts test/modules/runtime/p04-6-efficiency-projection.test.ts` | exit 0，14 passed | `test-r7as0q2e.log` |
| `node scripts/run-tests.ts test/modules/cli/p03-10-feature-report-built.test.ts -t built-usage-diagnostics-history` | exit 0，1 passed，2 skipped（仅聚焦新增 case）；beforeAll 构建及构建入口 smoke 通过 | `test-qp4flnyz.log` |
| `npm run typecheck` | exit 0 | `test-pt937jwf.log` |
| `npm run check:boundaries` | exit 0，328 个生产源文件、0 诊断 | `test-6vb72lpa.log` |

修复前的 RED 证据：`test-0z31w2kl.log`（恢复覆盖度误为 reported）、`test-u0spvy4f.log`（模型子集错误重新计入 input=40）；修复后首次两项 GREEN 为 `test-z1f28ibq.log`。其后扩充组合场景的日志中，`test-ttk6zfm3.log` 记录测试期望累计值的算术修正（500 改为 400，其余 18 项通过，包括既有归一化五项），`test-1rszqd5t.log` 记录 settlement 夹具版本绑定修正。上述失败均已由最终两个 GREEN 运行覆盖；保留原始日志，不覆盖或改写失败历史。

## 索引与验证边界

真实模块索引：`test/index/phases/P04/features/P04-6/tasks/F-007.json`（v2）。Harness `verifications/F-007/test-selection.json` 只引用该仓库索引，避免双份维护。沿用 P04-6 现有的 Task 索引布局；全部路径已核对存在，显式 case 均来自真实测试标题。

本地通过范围仅为上表；既有 Host、delivery、CLI 文本/错误/分页回归登记到 affected selection 后交 Nezha 独立运行，不将登记视为通过。没有运行全量 `npm test`、`npm run verify` 或阶段验收脚本，没有发送通知，没有修改 `task_list.json` 或 `feature.yaml`。

真实模型/真实 provider 缓存及 reasoning/线上恢复口径、人工验收、Feature gate 与 Phase gate 均为 `not_run`；Fake、合成 usage 和受控 IPC 结果不能替代这些验收。完成报告通过 Nezha CLI 提交，本 Task 本地通过不表示整个阶段通过。
