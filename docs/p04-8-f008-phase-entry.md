# P04-8 F-008 阶段入口交接

`npm run accept:p04` 已接入独立离线阶段入口。仅人工明确发起时运行完整工程门禁和 P04 跨 Feature 测试。普通 Task 验证不执行此命令；控制器测试使用注入执行器和一个短子进程，不启动完整门禁。

## 执行契约

- `acceptance/p04.entry.json` 固定步骤顺序及入口接口；`acceptance/p04.config.json` 沿用 F-001 的 Node/npm、单步/总预算、清单和报告配置。
- 第一步使用当前 Node 执行 `scripts/verify.ts --step-timeout-ms <单步预算>`，即 `npm run verify` 的同一个完整入口，保留全部测试、类型检查和构建门禁。
- 第二步执行 `node scripts/run-tests.ts <显式文件列表>`。从 P04-1 至 P04-8 的 v2 Task 索引收集、校验、去重测试文件，Phase 按完整文件运行；缺失索引、空选择、越界路径或缺失入口直接失败。配置不能注入自定义命令、Shell 或改写步骤顺序。
- 仓库 cwd 取自脚本位置，不使用调用者 cwd、npm prefix 或 `INIT_CWD`。受测代码须已提交；记录当前 HEAD，`--expected-commit` 可额外核对期望 SHA。步骤之间及报告前复核 HEAD/工作树，漂移不复用旧结论。
- 仅保留 PATH、区域等必要环境，隔离 HOME、TMPDIR、Pi 与 XDG 目录、npm cache/config，剔除继承的 npm lifecycle/prefix、NODE_OPTIONS 和供应商凭据。离线测试使用 Fake；这不是操作系统网络沙箱。
- F-003 步骤器顺序、有界执行，开始与完成分别落盘运行身份和步骤记录。单步预算还受剩余总预算限制，准备/报告耗时也纳入入口总时限判定。停止不确定保留 `resources`，不把删除目录当成进程停止证据。

## 人工运行和只读观察

以下命令是人工后续操作示例，本 Task 未执行阶段流程：

```sh
npm run accept:p04 -- --run-id p04-review-001 --expected-commit <完整受测SHA>
npm run accept:p04 -- --run-id p04-review-001 --observe
```

可选参数只有 `--run-id`、`--report-dir`、`--expected-commit`、`--step-timeout-ms`、`--overall-timeout-ms`、`--observe`、`--help`。时间均为有限整数毫秒。省略 run-id 时新建唯一运行；观察必须显式指定 run-id，预算及报告根须与原运行一致。观察只核验已有步骤水位/哈希、代码和输入身份、报告完整性，不调用步骤执行器，不覆盖结果。

默认输出位于已忽略的 `artifacts/acceptance/p04/`：

```text
runs/<run-id>/step-run/{run.json,state.json,steps/,logs/}
runs/<run-id>/entry-result.json
runs/<run-id>/resources/       # 停止或清理不确定时保留
reports/<run-id>/{report.json,summary.md,evidence/}
```

自定义报告根应位于仓库外或受忽略目录，避免输出污染受测工作树。入口原子认领 run-id；已有运行/报告目录拒绝覆盖。中断、失败或报告写入失败后，已完成步骤证据仍在 `runs/`。缺少完整结果的观察会非零退出，不自动恢复或重跑；本入口不提供隐式 resume。重新执行需人工核验旧进程停止，再显式使用新的运行身份。

## 报告与退出码

F-007 聚合器生成 commit、Node/npm/Git/SDK 版本、真实退出码和证据索引；FR-2 的 `entry-steps.json` 额外保留全部计划步骤，包括 `not_run` 与 `exitCode: null`，不伪造退出码。原始日志和步骤证据留在本地运行目录，报告副本统一脱敏。

入口沿用阶段聚合器的严格非零语义。完整离线命令执行完毕也不意味着 Phase 通过：live 保留 `not_run`，人工确认保留 `pending`，返回结果明确 `phaseAccepted: false`。缺少的逐项 SQLite/进程快照、产品 Feature 报告及检查证据不会通过命令退出 0 自动补造；本入口只绑定实际执行的 FR-1/FR-2 步骤，其他检查没有独立来源时仍为 `not_run`。报告写入失败、证据损坏、目录冲突、未知退出、超时和清理不确定均非零。

## 本 Task 验证范围

入口定向测试 17 项通过，包括固定参数/环境、前序证据保留、超时与总预算、未知退出码、目录/符号链接保护、前置接口/commit/工具版本拒绝、代码漂移、报告损坏、观察零重跑和清理不确定；其中一个真实短子进程验证退出码 `23`，其余阶段命令均由受控执行器替代。新增入口和测试的定向 TypeScript strict 检查通过。

Task 索引：`test/index/phases/P04/features/P04-8/tasks/F-008.json`。步骤器、聚合器及清单报告回归仅登记交 Nezha 独立运行；本地未执行这些回归组。完整工程/阶段集成、真实 Pi live、负责人确认均未运行或待确认，本 Task 局部验证不构成阶段验收证据。
