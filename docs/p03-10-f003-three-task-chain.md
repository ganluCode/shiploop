# F-003 三 Task 链诊断与阻塞交接

F-003 **尚未完成验收，须报告 blocked**。当前新增的两项测试通过，表示诊断能稳定复现缺口以及调度修复有效；不表示三 Task 纵向交付成功。独立输出 `three-task-chain.json` 的 `status` 为 `failed`，原因为 `task_passed_without_controlled_commit`。

## 实际运行与证据

复用 F-001 独立资源夹具，经正式构建 CLI 完成仓库注册、项目检查配置、基线运行、三 Task 导入、摘要审批、必需输入准备、执行预览及显式授权。Task 依赖为 `chain-1 → chain-2 → chain-3`。

Fake 只负责真实文件修改及真实工具命令；Host 中可信测试装配调用构建后的 `createNodeTaskVerificationExecutor`、SQLite VerificationStore、制品服务和 `taskVerificationCompletion`。检查使用真实 Node 子进程、实际文件断言、结果协议、退出码及输出制品；工作区身份来自真实 Git 检查。没有直接 SQL 修改业务状态，没有 seed 通过证据，没有手工 Git 提交。

| 阶段 | Node 退出码 / testCount | 实际观察 |
| --- | --- | --- |
| 第一项 | 0 / 1 | Fake completed 后仍是 running/verifying；真实检查收尾后变成 passed |
| 第二项首次 | 1 / 2 | stderr 包含 `expected repaired chain-2`；Task 进入新 Attempt，第三项零启动 |
| 第二项返工 | 0 / 2 | 新 Attempt、同 workspace；保留 tracked README 和 untracked marker，append 修复 |
| 第三项 | 0 / 3 | 第二项有效机器验证收尾后才启动；随后 Task 为 passed |

第二项两次 Attempt 的输入制品不同；新输入含保留现场与失败证据。Fake 修复命令先读取并精确核对旧 tracked/untracked 内容，再追加修改，丢失现场会真实失败。Task 计数分别为 1/2/1，Runtime 启动顺序为 1/2/2/3，总计四次。

以相同 commandId 和原请求重放 `execution start` 后，Attempt/Session/Runtime starts 均保持 4，Run/Batch 均保持 1，state_events 保持 50，command_receipts 保持 24，git_operations 保持 0。重放沿正式 CLI/Host/Core 回执路径执行。

本轮最终证据在 Feature workspace：

```text
verifications/F-003/runtime-logs/
  test-paeuc6he.log                  # 两项聚焦测试，exit 0；2 passed / 0 failed / 0 skipped
  test-wqdu81jm.log                  # typecheck，exit 0
  test-232ar8hv.log                  # 装配事务边界错误的失败日志
  test-dimzs0a5.log                  # 暂停原因被覆盖导致合法验证 ignored 的 RED
  evidence/three-task-chain-38487165-20bb-4707-944c-43db748a63b1/
    three-task-chain.json            # failed；四阶段输入、Git 身份、真实检查、完成回执、重放计数
    stage-*.json                    # 每次检查前 Task/Attempt/Run/检查批次/事件，以及真实结果
    evidence.json                   # 配置/导入/审批/授权/重放 CLI 轨迹、数据库只读观察、资源与工具身份
    cleanup.json                    # passed；进程树/组已停止，临时资源已删除
```

证据目录使用随机唯一名字，位于临时资源之外；检查输出在删除之前从实际制品完整导出。路径和凭据形态沿 F-001 清理及脱敏契约处理。所有中间 RED 日志及清理结果保留。`testedCommit` 是启动时 HEAD，`dirty: true` 表明当时还包含本次未提交改动；最终实现版本以 Git 提交为准。

## 已修复的集成问题

真实 Host 的补偿扫描会对 `run_control_blocked` 持久化通用诊断原因，覆盖 `verification_not_assembled`。验证完成事务只接受原有的获准暂停原因，因而真实检查通过后返回 `ignored / invalid_transition`，三 Task 链停在第一项。

`work-scheduler.ts` 现在仅在内存记录该控制阻塞诊断，保留持久暂停原因。新增真实 SQLite 聚焦用例验证重复扫描不改变 reason、revision，也不认领 Task。修复后真实三 Task 链可继续执行。没有放宽验证完成事务的状态校验。

## 必须由负责人处理的受控提交缺口

三个 Task 都进入 `passed`，但 `git_operations` 为空，收尾后的 `finalGit` 确认 HEAD/tree 保持不变且修改仍未提交；这不符合 F-003 的放行标准。

源码依据：

- `packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts` 的 passed 分支直接完成 Attempt/Task，未要求逐 Task Git operation 成功证据。
- `packages/core/src/ports/git-operations.ts` 的类型及验证器仅允许 `feature_final_commit`。
- `packages/core/src/adapters/sqlite/schema.ts` 的 `git_operations_type_check` 同样只允许 `feature_final_commit`。
- 设计 `core-design/07-verification-and-delivery.md` §2 要求检查、代码身份、Core 提交及证据、当前人工条件核对后，再原子完成 Attempt/Task。

负责人需要协调 Task 受控提交的生产能力：operation 类型及迁移、受控 Git/不可变 intent 与结果、证据关联、fencing、提交后代码身份与当前人工条件重核、失败/不确定结果处理，以及 Task 放行门禁。不能把 Feature 最终提交追认成 Task 放行时已有的提交，也不能让 Fake、诊断脚本或直接 SQL 替 Core 补写通过记录。

本轮未扩展这套跨契约生产能力。Feature 全量检查、受控最终提交、Feature completed 与 Run/Batch 完成的一致性均为 **not_run**，不得折算为通过。当前 Run 的 `scheduler_capability_missing` 也明确显示诊断装配没有 Feature 收尾消费者。以后续真实装配继续验收时，必须保留这些必需门禁，并重新验证 commandId 重放及最终 Git/回执一致性。

## 验证范围与复现

本地只运行新加的两个 task-local 文件及类型检查，没有执行全仓测试、组合 verify 或 Phase 门禁。任务索引 `test/index/phases/P03/features/P03-10/tasks/F-003.json` 同时登记 F-001 夹具与已有 scheduler 的受影响回归，后两者本轮 **未运行**，交 Nezha 独立执行。

```bash
P03_EVIDENCE_DIR=/absolute/caller-owned/evidence \
  node scripts/run-tests.ts \
  test/modules/acceptance/p03-10-three-task-chain.test.ts \
  test/modules/scheduling/p03-10-verification-pause.test.ts
```

没有设置 `P03_EVIDENCE_DIR` 时，测试将使用并删除自己的临时证据目录。保留复查材料时应指定外部目录。诊断测试刻意确认当前缺口；上游修好后它会失败，届时应升级成完整交付验收，不能继续将已消失的缺口作为预期成功。
