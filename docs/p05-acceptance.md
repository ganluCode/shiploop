# P05 阶段验收契约

状态：验收工具输入契约，不是阶段已通过证明。P05 默认执行离线可信测试索引去重合集、受影响基础模块和必要跨层冒烟；全仓历史回归、真实 live GitAgent 和负责人确认分别保留独立门槛。

机器可读输入位于 `acceptance/p05.checklist.json`、`acceptance/p05.config.json` 和 `acceptance/p05.entry.json`。`scripts/acceptance/p05-config.ts` 对三类输入执行 fail-closed 校验：未知字段、未知或重复检查、删减断言、身份/引用/证据改写、隐式 live 调用、绝对路径和凭据字段都会被拒绝。

## 检查范围

清单按 FR-1～FR-4 和 I01～I09 冻结：

- I01 验证一次规划候选、Phase/Feature 依赖、批准和固定 Batch。
- I02 验证 A/B 独立成果及 C 在集成证据形成前保持阻塞。
- I03 验证项目、Feature、迁移、契约和工作区资源互斥。
- I04 验证重复信号、崩溃、取消、租约、迟到结果和未确认停止。
- I05 验证固定成果 SHA、确定性 Git 集成、冲突留场和回执恢复。
- I06 验证 GitAgent 的授权写入范围、父预算、取消和修复失败。
- I07 验证无共同后继叶子的完整汇总、交付和批准分层。
- I08 验证追加 Feature 使用新 Batch，旧范围、策略和预算不扩张。
- I09 验证输入漂移、预算耗尽、证据损坏、清理不确定和阶段失败关闭。

每项均记录验证层次、执行类别、FR/场景引用、必需断言和证据类别。`offline` 只能使用 FakeRuntime 或脚本化 Runtime 且网络关闭；`live` 需要独立授权和有界请求证据；`manual` 需要负责人确认；`postponed` 不计入通过。

## 状态与报告

报告逐项保留 `pass`、`fail`、`not_run`。缺结果、缺必需证据、执行类别不匹配、人工 `pending/rejected` 或 live 证据缺失都不能变成 `pass`。`not_run` 不计入通过；必需项不是全部 `pass` 时阶段结论为 `fail`。负责人确认不能由模型代签。

每个场景证据至少绑定：场景 ID、输入摘要、受测完整 SHA、实际命令、退出码、状态快照、证据引用/哈希、用量来源和清理事实。用量来源只允许记录 `runtime-usage`、`command-output`、`manual-record` 或 `not_run`，不能写凭据、Token 或开发机绝对路径。

全仓历史回归不是默认门禁。只有显式 `--full-regression` 才能执行配置中声明的 `npm test`；未执行时保留 `not_run`，不能由阶段索引、Task 通过或离线结果代替。

## 人工放行

人工操作步骤见 [`docs/acceptance/p05-owner-walkthrough.md`](acceptance/p05-owner-walkthrough.md)。负责人必须在独立报告中确认：依赖安装和工具版本、受测完整 SHA、实际命令和退出码、离线/live/manual/not_run 分层、用量来源、临时 Git/SQLite/进程清理、未执行项和结论。机器不能代签；人工 pending 或 rejected 优先于机器成功。
