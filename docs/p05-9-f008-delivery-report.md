# P05-9 F-008 Batch 收尾纵向交付报告

日期：2026-10-26。范围：P05-9 Batch 收尾的代表性纵向验证、可信测试索引和交付记录接线。本文是 Feature 交付记录，不是 P05 阶段放行或负责人签署。

- 受测分支：`feat/p05/batch-delivery`
- 受测实现提交：`__FINAL_COMMIT__`（报告提交前一提交；仅绑定本 Task 的实现/测试/index 变更）
- 测试索引：`test/index/phases/P05/features/P05-9/tasks/F-008.json`
- Feature 合集：`test/index/phases/P05/features/P05-9/feature.json`
- Harness selection：`workspace/features/2026-10-23-18-55-21_p05-9-batch/verifications/F-008/test-selection.json`

## 已执行

| 项目 | 实际命令 | 退出码 | 证据 |
|---|---|---:|---|
| F-008 聚焦纵向测试 | `/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir <feature-workspace>/verifications/F-008/runtime-logs -- node scripts/run-tests.ts test/modules/delivery/p05-9-f008-batch-delivery-vertical.test.ts` | 0 | `verifications/F-008/runtime-logs/test-aeffi4uc.log`；最终本地结果 1 file / 4 passed / 0 failed / 0 skipped |
| 选择清单校验 | `node scripts/run-tests.ts test/modules/delivery/p05-9-f008-batch-delivery-vertical.test.ts` 使用同一项目 runner；Harness selection 指向 F-008 v2 索引 | not_run | 选择文件在提交后由 Nezha completion preflight 校验；不得把索引存在等同测试通过 |
| 受影响回归合集 | F-008 索引登记的 P05-7 Git、P05-9 Host、P05-3 Batch、P04-9 派发/恢复和 P03-9 resume 文件 | not_run | 交 Nezha 独立验证，未在 Runtime 重复运行大合集 |

## 覆盖事实

聚焦测试使用真实临时 SQLite、真实 Git worktree 和受控 Node 子进程：

- 两个并行叶子以实际 commit SHA 和输入摘要固定；父 Batch 未满足终态门禁时不能创建候选。
- 集成通过真实 Git worktree 产生 commit/tree 观察，验证通过真实受控进程写入临时 marker；Phase 批准记录绑定 candidate、叶子 commit、集成 commit/tree、输入摘要、预算/停止/计划摘要。目标仓库 HEAD 和 refs 保持不变，没有执行 main merge 或 remote push。
- 失败叶子、冲突现场、集成异常和授权修复后的验证失败分别保留 `blocked`、`reconciliation_required` 或 `blocked` 持久状态；验证进程退出码和 marker 副作用被断言。
- 固定 Batch 的 `featureIds` 只来自已批准范围；无共同后继叶子保留阻塞，不因运行中新增范围扩张旧 Batch。运行控制、迟到结果、重复信号/重启去重和预算耗尽由 F-008 索引登记的既有真实回归覆盖。
- 受控运行可通过 `SHIPLOOP_F008_EVIDENCE_DIR=<临时证据目录>` 导出 `vertical-delivery.json`，其中绑定 tested commit、真实输入 leaf SHA、命令退出码、SQLite 状态、目标 HEAD 前后值和 not_run/manual block 语义；默认测试不向源码仓库写证据。

## 范围边界

F-008 索引登记 F-001～F-008 的完整 Feature 合集及 8 个纵向/受影响回归文件。Runtime 本地只执行新增 F-008 文件；其余文件交 Nezha 独立验证，未运行项保持 `not_run`。本轮没有运行全仓测试、`npm run verify`、P05 阶段验收、真实模型/网络或远端 push。

机器通过不能替代人工批准。Phase 交付批准在测试中使用明确的 owner actor 和持久批准服务验证；P05 阶段负责人确认、main 合入和 push 仍是独立未授权动作，不能由本报告或脚本自动完成。

## 已知限制

- F-008 测试的真实 Git/SQLite/受控进程证据是离线临时资源证据；没有真实 provider/model 或外部远端验证。
- `npm run typecheck`、构建和更广受影响回归由 Nezha 独立验证；若 completion preflight 或独立验证发现索引、类型或历史回归问题，必须保留失败/not_run 事实。
- 本报告不修改官方 `feature.yaml`、`task_list.json` 或 Phase 状态；Task 完成声明只通过 `nezha task report F-008` 提交。
