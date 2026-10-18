# P03-3 / F-014 交付报告

## 结论

2026-10-13，F-014 预算集成子集通过；verification.scope=`full`。
无产品逻辑、依赖、Schema 或 Runtime 扩展。正式构建 CLI 完成真实临时项目的
计划导入/审批、prepare、显式 start、同命令重放、预算查询/修订和 Host 重启查询。
不直接插入业务表，不加载用户配置，不调用真实模型。

**不是完整生产 Runtime 验收**：Host 通过公开装配入口注入显式静态测试能力目录；
生产空目录问题仍保留。accepted 只表示授权持久提交；Run 为 queued/
`scheduler_not_assembled`，runtimeStartsReserved=0，Feature 未完成，费用未知为 null。

## 输入与实现

- 输入：Harness `input/p03-execution-budget.md`，v0.3，2026-10-11。
- 输入 SHA-256：`4f732cb9d0b23d4d7af82d75bb629f3a2d8cc7baa8cbfb257ba16abe85780cf9`。
- 范围：FR-1/FR-2 正常及关键负例、T13/T21/T25 预算子集、T31 单 Feature 子集。
- 前序实现基线：`72b13f6a0f0df3dcec1dc99de63585f65589f42c`（F-013）。
- F-014 验收实现 commit：`2bdcff145e1870fe30ab9cbae476c1970cb8f335`。
- 分支：`feat/2026-10-11-17-45-49_p03-3-feature`；未切换、reset 或重写历史。
- 新增 `test/modules/execution/budget/p03-3-cli-built.test.ts`、`test/modules/execution/budget/docs-p03-3-handoff.test.ts`；
  [交接与覆盖索引](../p03-3-handoff.md) 登记于 README。

## 实际验证

所有日志以首行 JSON 保存真实命令、exitCode 和 signal；原始执行日志位于 Harness
`tool-logs/`，发布副本位于 [evidence-p03-3](evidence-p03-3/index.json)。
没有用 affected 选择替代全量门禁，也没有 skip、删除原有断言或修改验证脚本。

| 命令/轮次 | 退出码 | 结果及发布日志 |
|---|---|---|
| `node scripts/run-tests.ts test/modules/execution/budget/docs-p03-3-handoff.test.ts` | 1 | 预期 RED，交接文档尚不存在；`F-014-red.log` |
| `node scripts/run-tests.ts test/modules/execution/budget/p03-3-cli-built.test.ts`，首轮 | 1 | prepare 返回完整 capability/runnable 事实，修正新增精确断言；`F-014-built-initial.log` |
| 同上，第二轮 | 1 | deadline 查询时间自然前进；改为时间投影单调性 + 其余持久字段严格相等；`F-014-built-second.log` |
| `node scripts/run-tests.ts test/modules/execution/budget/p03-3-cli-built.test.ts test/modules/execution/budget/docs-p03-3-handoff.test.ts` | 0 | 2 文件/2 用例通过；`F-014-focused.log` |
| `npm run verify`，首轮 | 1 | test 183 文件/3944 用例通过；typecheck 发现新测试脱敏函数缺参数；build=`not_run`；`F-014-verify.log` |
| `npm run check:boundaries` | 0 | 135 生产源文件，0 诊断；`F-014-boundaries.log` |
| `node scripts/run-tests.ts p03-3` | 0 | 缩小到同职责：27 文件/436 用例通过；`F-014-feature-tests.log` |
| `npm run typecheck` | 0 | 修复后独立类型检查通过；`F-014-typecheck.log` |
| `npm run verify`，最终轮 | 0 | full：test 183 文件/3944 用例、typecheck、build 全通过；`F-014-verify-final.log` |

最终 verify 于 `2026-10-13T11:00:24.231Z` 开始，test 127.8 秒、typecheck 0.8 秒、
build 9.4 秒，PASS 3/3。构建包括 native Host lock、三包 tsc、CLI bin 权限/shebang 和
Core/Host/CLI 正式入口冒烟。P01/P02/P03-1/P03-2 回归保留，全量通过。
日志中的空 Git HEAD、clone/worktree 信息来自现有测试夹具，不是忽略的失败步骤。

## CLI 脱敏证据

最终轮 [built-cli-verify.json](evidence-p03-3/built-cli-verify.json) 的 passed=true；
含 28 次正式 dist CLI 调用、6 份逻辑输入、2 次 Host 装配和 ownedHostsExited=true。
命令逐项保留 argv、exitCode、signal、stdout/stderr，不把负例退出码 1/2 改成成功。
初始两轮失败的 JSON 和日志也保留，不覆盖成成功。

- 基线通过公共 `baseline run --confirm --wait` 发布需求文本 Artifact，再用于 prepare。
- 未批准预览 blocked；缺确认 exit 2 且无回执；错误摘要、旧预算版本、跨项目预算查询 exit 1。
- accepted 对应真实 Batch/Run；同 commandId 重放返回原身份，runsCreated=1，Attempt/Runtime=0。
- 修订版本 1→2 幂等且不启动；Host 重启后预算/回执一致，旧 Run 上限不追溯改写。
- deadline 是绝对时间；查询 used/remaining 随时间变化，其他持久字段保持完全一致。
- 进程 PID 退出、CLI stop 和沙箱清理均核验；不以 discovery 文件消失代替真实退出。

[index.json](evidence-p03-3/index.json) 保存输入摘要、12 份证据的原始/发布 SHA-256、
字节数、命令退出信息和工具版本。发布副本遮盖 HOME/仓库/临时路径；递归解析 JSON
字符串并遮盖凭据形状键（包括公开预览 authorization 摘要，以 `<key>_redacted` 标明），
再扫描外层文本和内嵌 stdout。未导出 auth.token、认证头或用户环境。
发布转换只作用于报告副本，不修改产品响应、原始证据或验收断言。

## 工具与缺口

实测平台 macOS/darwin arm64，Darwin 25.6.0；Node 22.19.0、npm 10.9.3、
Vitest 5.0.3、TypeScript 7.0.2、better-sqlite3 13.0.3、Git 2.50.1（Apple Git-155）。
未新增依赖或修改全局设置。

- 已知缺口：生产 Host `capabilityCatalog` 默认空。显式
  `test/helpers/host/dist-host-entry-catalog.mjs` 加载正式 dist，仅注入可信静态目录；
  不能据此声称生产模型配置已可用。前序 P03-1 已记录，本轮不放宽生产 fail-closed。
- `not_run`：真实 SDK/模型/网络凭据、Scheduler/Runner/SessionRecorder、实际 token/cost
  结算、完整进程暂停取消恢复、多 Feature 拓扑跑批、模型探测/降级、Windows/Linux。
- `not_run`：独立阶段 `accept:p01`/`accept:p02`（本轮要求为完整 verify）；`accept:p03`
  未创建也未执行。相关阶段测试随现有全量 test 正常执行，不能等同于重跑阶段验收脚本。
- 无本 Feature 必需预算行为留待 P03-10 首次补写。事务、启动预占、有效进展、修订/查询、
  accepted v5/v6、旧政策含义、baseline 占用及 P03-4/6/9 接线职责见交接文档。
