# P08-2 F-009 `accept:p08:live` 正式入口

入口脚本是 `npm run accept:p08:live`，实现位于 `scripts/acceptance/p08-todo-live-entry.ts`，旧的 `p08-todo-live.ts` 只负责保持既有 live 端口并转发到正式入口。

## 固定步骤

入口每次按以下顺序执行并在报告中逐项保存退出码、稳定命令名和相对证据引用：

1. `normal-live`：读取负责人提供的批准文件，使用批准的 provider/model、Task DAG、预算和真实 Pi Runner。每个 Task 仍由 F-004 的 Runtime → 局部检查 → Git 提交门禁串行解锁；报告保存前核对 commit/tree。
2. `negative-fixtures`：执行 F-005 的五个确定性故障夹具（认证、预算、取消、中断恢复、依赖失败），交叉核对 state/evidence 和保留资源。
3. `report-validation`：校验 F-004 交付报告，聚合 F-006 证据报告，并按制品摘要和 `artifactRoot` 复验。成功退出不等于证据报告 passed。
4. `clean-install`：在提供本地分发目录时调用 F-007 干净安装冒烟；缺少分发输入保持 `not_run`。
5. `existing-repository`：运行 F-008 存量仓库真实临时 Git 夹具测试。夹具通过只证明局部增量契约，不能代替真实用户仓库的产品闭环。

阶段结果只允许 `passed`、`failed`、`not_run`、`inconclusive`。退出码固定为：0、1、2、3。人工核对始终是 pending，因此脚本完成五步后通常为 `inconclusive`；脚本不会填写负责人签名。

## 报告与人工核对

正式报告 `shiploop.todo.live-acceptance` 保存：

- 当前代码 commit/tree、Node/npm/platform 和 Task/总预算；
- 五个阶段的实际状态、退出码、命令和报告根内相对证据路径；
- Todo 需求覆盖、真实模型参与、提交与报告身份、敏感边界和负责人签署五项人工 pending；
- 真实 Host/SQLite/进程/停止恢复、registry/native 安装和存量产品闭环的 Phase `not_run` 缺口。

报告不保存批准文件路径、凭据、绝对路径或原始大输出。F-006 的交付证据报告继续单独绑定 Project/Feature/Run/requirements/commit/tree 身份。F-007/F-008 的报告也保持各自类型，不通过复制说明合并为 Todo live 通过。

没有批准文件时入口仍会执行无需真实模型的安全编排检查，正常 live、负例、报告聚合和安装依赖步骤按原因记录 `not_run`；它返回退出码 2，并保留当前代码身份和人工核对项。真实模型和跨层集成需要负责人另行批准并由 Phase 入口保存完整证据。

定向测试：

```sh
node scripts/run-tests.ts test/modules/acceptance/p08-2-f009-todo-live-entry.test.ts
```

该测试只覆盖入口顺序、状态传播、退出码和报告边界；Feature/Phase 的完整回归与真实 live 由独立验证流程执行。
