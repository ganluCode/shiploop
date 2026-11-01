# P07 验收执行优化

## 已复现问题

受测基线 7ead782：P07 受影响集合单 worker 运行 900219ms 后超时。
104 文件集合只完成 13 文件（301 测试）；没有观察到断言失败，不等于其他检查通过。
原失败报告保留在 /private/tmp/shiploop-p07-accept-20261101 的 p07-offline-20261101-002。

耗时最大项（真实 Node 22 / Git / SQLite / 进程）：

| 文件 | 用例 | 原耗时 | 只读检查优化后（仍单 worker） |
| --- | --- | --- | --- |
| p03-8-f003-controlled-git-commit | 37 | 382176ms | 214931ms |
| p07-3-f011-project-delete-executor | 20 | 441134ms | 258345ms |

两文件合计由约 13.7 分钟降到约 7.9 分钟。完整定向回归 4 文件/87 测试通过，
JSON 测量记录：/private/tmp/p07-inspector-optimized-20261101.json。
该比较不是完整 Phase 的性能承诺。

## 实现边界

- WorkspaceInspector 每次仍执行 22 条受监督 Git 查询，保留两次 Git 快照与两次文件扫描，
  不缓存授权/代码事实，不省略身份、引用、内容、链接、输出/命令/总时间预算核验。
- 仅在同一轮中将独立只读查询分成最多 3 个一组；元数据先核验、gitlink 拒绝后才运行 status。
  写入、提交、删除、数据库事务不在该并行路径内。
- 失败时等待已启动的同组查询完成核验；任一停止未确认优先传播 stop_unconfirmed，不能被
  普通错误掩盖。保留停止未确认时的隔离边界。
- Phase 专用 Vitest 配置采用至多 2 个隔离 forks worker，与两份冻结 JSON 契约一致；
  仅测试文件并行，阶段步骤及单文件用例仍顺序执行。不是多 Agent，不改产品任务并发。
- 单步 15 分钟、总 45 分钟预算不变；原必需检查保留，并增加 WorkspaceInspector 安全回归。
- Recorder 诊断文件写入本次 run 的 recording-evidence，不修改受测仓库的已跟踪 tool-logs。

## 重验要求

代码、配置与范围已变化，正式重验必须使用新提交和新 run ID，不覆盖 002 失败记录。
未运行的工程/集成检查仍为 not_run；负责人签署独立保留 pending。
