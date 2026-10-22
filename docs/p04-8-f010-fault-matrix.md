# P04 离线故障矩阵与能力边界

本表是交付导航。执行结果以对应定向日志、Nezha 独立验证和人工阶段报告为准；测试按预期拒绝通过，不等于失败场景的产品执行成功。所有条目均可从模块文件独立点名执行，无需递归调用阶段入口。

## 最终接线六场景

测试文件：`test/modules/acceptance/p04-8-delivery.test.ts`。每个稳定 case 创建自己的干净 Git 项目，从复制的真实入口加载控制器。正常和非零步骤执行真实短 Node 子进程；原始阶段 argv 只记录、不交给 OS。超时及停止不确定是受控返回，不声称完成真实强杀验收。

| 场景 | 稳定 case ID | 必需观察 | 退出/保留语义 |
|---|---|---|---|
| 正常 | clean-normal | 无关 cwd 发现两个 scripts；离线 --help；live 无授权零调用；两步短进程 0/0 | help 0；live 2；阶段结果 1、phaseAccepted=false，人工/live 未放行 |
| 失败 | clean-failure | 工程短进程 0，集成短进程 17；前序证据保留 | 步骤 0/17；阶段 1 |
| 超时 | clean-timeout | 第一步 timeout，未知 exitCode=null，后序 not_run | 阶段 1，不伪造步骤退出码 |
| 证据损坏 | clean-corrupt-evidence | 改坏步骤证据后 observe 拒绝哈希/水位错误；执行调用不增加 | 保留损坏现场；不重跑 |
| 目录复用 | clean-directory-reuse | 第二次同 run-id 拒绝；原有步骤内容完全保留 | 不复用旧成功；不覆盖 |
| 停止不确定 | clean-stop-uncertain | stoppedVerified=false；后序不启动；resources 保留 | cleanup.confirmed/processesGone 均 false；阶段 1 |

这里的探针进程自身正常结束（exit 0）表示其结果被完整采集；不覆盖内部阶段 exit 1。两个失败拒绝场景直接核对异常，不为没有启动的命令制造退出码。日志中每个 `[case:clean-…]` 都有独立结果。

## 合并的业务故障矩阵

| 需求 | 可执行模块/索引 | 真实资源与检查重点 | 限制/补验 |
|---|---|---|---|
| FR-1 授权、认证、SDK、路由 | `test/modules/runtime/p04-8-access-fault-matrix.test.ts`；F-004.json | 实际临时资源、资源权限、越权、SDK 缺失/异常、认证、429/连接/服务端、累计重试/备用、事件/用量归属 | 供应商响应受控，无真实额度消耗 |
| FR-1/T40/T43/T44 恢复与记录 | `test/modules/runtime/p04-8-recovery-recording-fault-matrix.test.ts`；F-005.json；[详细矩阵](p04-8-f005-recovery-recording-matrix.md) | 真实 SQLite、重复记录/usage、超大消息、磁盘故障注入、迟到 fencing；索引组合来源权限、原生单写入者/损坏档案、标准 SDK required 拒绝 | SQLite 是 Core 记录库；不把故障注入当成真实磁盘满，不宣称 Pi SQLite checkpoint |
| FR-1/T06/T44 控制与停止 | `test/modules/execution/control/p04-8-control-fault-matrix.test.ts`；F-006.json；[详细矩阵](p04-8-f006-control-fault-matrix.md) | 真实进程及 SQLite，取消/工具取消/执行超时/Host 异常/Runner 强杀、停止不确定占用、迟到结果、证据损坏和目录复用 | 平台限 macOS；现场清理不等于业务隔离解除 |
| FR-2 步骤与独立入口 | `test/modules/acceptance/p04-8-step-runner.test.ts`、`test/modules/acceptance/p04-8-phase-entry.test.ts`；F-003/F-008.json | 顺序预算、真实退出码、开始即落盘、只读 observe、未知退出/停机/写失败 | 注入大组步骤；完整阶段另由人工发起 |
| FR-4 聚合与完整性 | `test/modules/acceptance/p04-8-integration-report.test.ts`、`test/modules/acceptance/p04-8-checklist-report.test.ts`；F-007/F-001.json | FR/T 必需断言、命令/产品报告分层、脱敏、证据哈希、not_run/pending、清理不确定 | 未绑定的必需来源继续 not_run，不自动补造阶段事实 |
| FR-3 零调用与 live 工具 | `test/modules/acceptance/p04-8-live.test.ts`；F-009.json；[live 说明](p04-8-f009-live-entry.md) | 授权/认证/预算/请求数闸门、受控独立检查/Git、事件水位、凭据边界、安装 SDK 的离线工具循环/401/取消 | 真实 live not_run；Core 业务闭环和外部工具进程停止 not_run |

表中 F-xxx.json 均位于 `test/index/phases/P04/features/P04-8/tasks/`。最终 Feature 索引登记所有 Task，不复制包装旧测试，不按用例数量替代 FR/T 覆盖；F-010 只在本地运行最终接线用例，业务矩阵/入口回归由 Nezha 选择独立执行。

## 人工能力核对

历史读取、conversationResume、executionRecovery 和切模型续接分别核对。当前标准 Pi 默认生产 required 续接不支持时必须拒绝；通用接口和受控恢复样例不作为真实 live 恢复证明。真实认证/OAuth、跨 provider 续接、第三方 MCP/Skills、外部孤儿进程、原生版本兼容与准确缓存收益，未有本次有效证据的均 not_run。

可信项目只代表显式授权，不是强 OS 沙箱。后置能力按 `acceptance/p04.checklist.json` 的 deferred 冻结项列示，不加入通过计数；必需项不能临时改成后置。负责人签署位置见 [人工清单](p04-8-f010-manual-checklist.md)。
