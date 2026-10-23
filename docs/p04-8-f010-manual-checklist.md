# P04 人工验收清单与进入门槛记录

实际操作先看 [P04 人工逐步操作](acceptance/p04-owner-walkthrough.md)。本文件保留完整门槛与签署字段；历史 not_run 不随补充探针自动变为通过。

当前 P04 未放行，P05 进入门槛尚未满足。每一步分别保存状态、实际命令、退出码、UTC 时间、受测完整 SHA 和证据位置；待核对项不得根据 Task completed 自动勾选。

## 执行顺序

- [ ] 定向测试：核对 F-010 本地日志及旁文件（待核对）。需独立复验时只点名 `node scripts/run-tests.ts test/modules/acceptance/p04-8-delivery.test.ts`，不得从该测试递归执行阶段。
- [ ] Feature 索引合集：由 Nezha 对 `test/index/phases/P04/features/P04-8/feature.json` 中 Task v2 索引合并去重执行，保存最终代码身份与逐用例结果（not_run）。索引是范围声明，不是通过证明。
- [ ] Phase 完整工程/集成：负责人明确发起后，在依赖已按锁文件安装、工具版本匹配的干净代码快照中执行下面命令（not_run）。全量工程门禁和 P04 集成都须有实际结果，不因 Task 定向测试成功省略。
- [ ] 真实 live：按 F-009 文档逐场景批准 provider/model、认证引用、临时仓库、预算及资源，再执行下面 live 命令（not_run）。确认真实调用数、用量 partial/unknown、工具副作用、独立检查和受控提交。
- [ ] 负责人确认：核对所有有效阶段证据、缺口和版本后填写末尾签署记录（pending）。未获签署不得进入 P05；模型不能自行批准。

以下是人工后续命令模板，本 Task 未执行完整阶段或付费 live。先替换示例 SHA、run-id 和授权文件路径，在独立终端或受监督流程执行；不占用模型单条 600 秒工具反复启动，也不隐式运行第二次全量。

```sh
git status --porcelain
git rev-parse HEAD
node --version
npm --version
npm run accept:p04 -- --help
npm run accept:p04 -- --run-id p04-owner-001 --expected-commit REPLACE_WITH_FULL_SHA
npm run accept:p04 -- --run-id p04-owner-001 --expected-commit REPLACE_WITH_FULL_SHA --observe
```

记录每条命令实际退出码；离线入口即使两步退出 0，也因 live/manual 未完成而整体非零。observe 只核验已有证据，不补跑、不签署、不覆盖。若报告根或时间预算使用非默认值，观察时须原样提供。停止或清理不确定先保留现场、核对旧进程和占用；不能删除目录后就认为已停止。重跑须核验后使用新 run-id。

```sh
npm run accept:p04:live -- --approval /absolute/private/owner-approved-live.json
```

change、cancel、resume-required 必须各自批准并使用独立目录。当前 required 生产会话续接只验证明确拒绝，不能标成实际续接成功。F-009 工具是 SDK 探针；Core Work 真实 Run/Attempt、Recorder、预算与外部进程停止仍须另有人工阶段方案和证据。无授权或缺认证必须 realCalls=0、status=not_run，不能静默切换供应商。

## 必需证据复核

- [ ] 代码/SDK/工具/配置版本与输入摘要一致（待核对）；更改代码、配置或预算后不复用旧成功。
- [ ] report.json/summary.md 和 evidenceManifest 文件、大小、哈希完整，所有必需断言和副作用实际成立（待核对）。原始日志私有保留，导出仅使用脱敏证据。
- [ ] 六种接线场景和三组业务故障矩阵逐项核对（待核对）；正常退出不替代授权、状态、记录水位和用量去重证据。
- [ ] SQLite、Git、进程停止、资源 manifest 与产品 Feature 报告引用有效（待核对）；阶段报告与产品报告分层。
- [ ] pass/fail/not_run 计数按冻结必需检查计算，manual pending 单列、deferred 不计入通过（待核对）。测试用例计数与门槛计数分开。
- [ ] 真实模型身份、认证授权、请求数、取消及工具停止有实际证据；未验证能力保持 not_run（待核对）。
- [ ] 无 blocking issue、停止不确定、必需记录缺口或未解除的人工阻塞（待核对）；工具成功不能清除负责人 hold。

## P04 放行及 P05 进入记录

负责人身份：待填写

批准时间：待填写（UTC）

最终代码 SHA / tree / 配置摘要：待填写

完整工程/集成证据索引及退出码：待填写

真实 Core Work/live/取消/停止证据：待填写

遗留问题及已批准后置项依据：待填写

理由：待填写

结论：待填写（未签署；当前 P04 未放行，不批准进入 P05）
