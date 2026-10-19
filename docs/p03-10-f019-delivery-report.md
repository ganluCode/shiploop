# F-019 交付报告：P03-10 交付整理、P03 人工验收清单与 P04 进入门槛记录

日期：2026-10-19。本报告只整理文档与索引，不执行全量测试、`npm run verify`、
`accept:p03`、`accept:p03:clean-replay` 或其他阶段全量入口，也不代表任何阶段已验收。

配套文档：

- 人工清单：[p03-10-f019-p03-manual-checklist.md](p03-10-f019-p03-manual-checklist.md)
- P04 进入门槛记录：[p03-10-f019-p04-gate-record.md](p03-10-f019-p04-gate-record.md)
- F-018 定向人工验收与阶段验收分离：[p03-10-f018-manual-acceptance.md](p03-10-f018-manual-acceptance.md)

## 四层结论分离

四个层次互不折算；低层通过不能推断高层通过。

| 层次 | 载体 | 当前状态 |
| --- | --- | --- |
| Nezha 开发任务（F-001 ~ F-019） | `nezha task report` 完成声明 + 独立验收 | 任务级声明完成；每项以独立 Nezha 验收为准，本报告不代为判定 |
| Feature 索引验证 | `test/index/phases/P03/features/P03-10/`，`task_union` 重跑 Task 索引合集 | 候选索引已登记；由 Nezha 独立执行，不等于全量或阶段验收 |
| P03 人工阶段验收 | 人工清单 + `accept:p03`/`accept:p03:clean-replay` 真实报告 | pending；双次全量阶段复跑尚未执行，状态 pending/not_run |
| P04 放行 | P04 进入门槛记录（负责人签署） | 未放行；见门槛记录，不得由局部测试通过推断 |

## 受测提交与测试结果

| 证据 | 受测提交 | 测试结果 | 说明 |
| --- | --- | --- | --- |
| F-018 定向人工验收 | `98d0a85241d9316ed9970ceaf23b8d5b10f2f8d0` | 3 个定向文件、22 项测试通过，退出码 0；TypeScript 类型检查退出码 0 | 证据：`verifications/F-018/manual-20261019/verification.json`（Harness 证据目录，含日志 hash）；详见 `docs/p03-10-f018-manual-acceptance.md` |
| F-019 文档守护 | 本报告、人工清单、门槛记录与测试索引所在提交（hash 由 `verifications/F-019/verification.json` 记录） | RED 7 项失败（文档缺失，退出码 1）→ GREEN 7 项通过（退出码 0），仅运行 `test/modules/acceptance/docs-p03-10-f019-delivery.test.ts` | 日志：`verifications/F-019/runtime-logs/`（文件名与退出码以该目录 `.log`/`.log.exitcode` 旁文件为准） |
| F-018 复跑工具控制器定向验证 | `98d0a85241d9316ed9970ceaf23b8d5b10f2f8d0` | 同上 F-018 定向人工验收记录 | 索引 `test/index/phases/P03/features/P03-10/tasks/F-018.json` |

## 修复内容

- F-018（`98d0a85`，见 `docs/p03-10-f018-manual-acceptance.md`）：首轮失败或缺报告即停止；
  移除启动者继承的 npm 环境变量避免命令串回开发目录；准备步骤原子保存；非空证据目录
  拒绝重用、非法 round 副作用前拒绝、缺真实退出码记 unknown；运行中异常保留快照，
  cleanup 不再无条件声明 processesGone。
- F-019：仅新增交付报告、P03 人工验收清单、P04 进入门槛记录、文档守护测试与 F-019
  测试索引登记；不修改产品代码、P03 检查清单冻结项、验收控制器或既有证据。

## 已知缺口

- 双次全量阶段复跑未执行（pending/not_run）：`npm run verify` 与 `accept:p03`/`accept:p03:clean-replay`
  的两轮真实报告、代码/配置身份与进程清理证据均未产生；此前 `26200fb` 阶段的超时与失败
  不追认为通过（见 `docs/p03-10-f018-manual-acceptance.md`）。
- P03 人工阶段验收未签署；P04 进入门槛未放行，负责人签署位为空。
- F-018 中断会话未正常收尾，其完整用量不伪造补入统计。
- 真实 Pi 生产认证、live 用量/缓存收益、Pi Durable 生产接入、强 OS 沙箱、Windows/WSL/Linux
  均未验收；Fake 验收不折算真实 Runtime 能力。

## 完整阶段验收的执行方式

完整阶段验收须在负责人明确授权后，由独立终端或受监督后台脚本执行
`npm run accept:p03:clean-replay -- --out-dir <全新证据目录>`（干净提交、有限步骤预算），
不占用模型单条 600 秒 Bash 工具反复启动，也不得为绕过失败跳过 verify、删除断言
或把未执行项写成通过。两个真实报告、代码/配置身份与进程清理证据核对一致后，
才由负责人填写 P03 阶段通过与 P04 放行结论。

## 边界声明

- 平台与运行模式：仅 macOS；用户明确授权的可信项目模式；单并发 Work 闭环。
- 验收身份：现有 P03 验收使用冻结 Fake Runtime 合成指标，只证明确定性闭环，
  不证明真实模型执行。
- 真实 Pi/live/Durable 实验：真实 Pi SDK 生产接入、live 用量/缓存与 Pi Durable
  候选实验均未在本任务验证；Durable 结论以 `pi-durable-experiment-decision` 记录为准，
  不作为一期通过门槛。
- 本任务仅整理文档和索引，不修改 P04-P08、执行模型策略或产品领域契约。
