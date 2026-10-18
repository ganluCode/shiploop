# 测试目录与执行索引

## 测试代码按模块归属

```text
test/
  modules/
    planning/                # Phase/Feature/Task 计划与审批
    execution/budget/        # 执行预算与 Run
    execution/control/       # 暂停、取消、时间上限
    scheduling/              # Task DAG 与认领
    recovery/                # 启动核对、恢复与隔离
    runtime/                 # Runtime、Session、进程
    delivery/                # 验证、审批与 Git 交付
    delivery/retry/          # 只收尾重试
    host/                    # Host 生命周期、HTTP、控制接口
    cli/                     # CLI 参数、命令与输出
    storage/                 # SQLite、制品与存储契约
    verification/            # 验收计划与返工
    workspace/               # worktree 与工作区
    ...                      # 其他现有领域模块
  helpers/                   # 夹具、受控子进程、资源清理；不是测试入口
  index/phases/              # Phase → Feature → Task 的组合索引
```

测试文件中的旧 Pxx/Fxxx 前缀暂时保留，方便追溯提交与历史报告；它们不决定模块归属。
新增测试不得继续堆放到 test 根目录。需要子模块时再建子目录，不按每个 Task 复制代码。
共享辅助函数继续放 helpers；不得把测试移动到 helpers 以规避收集。

测试类型不等于目录名：真实 SQLite、Git、Host、受控进程测试依然是集成测试。
当前 P03-9 的最小必需验证包含这些场景，不能通过标成 unit 缩减验收要求。

## 索引是执行范围，不是测试包装文件

当前首批登记：

- `index/phases/P03/phase.json`：人工阶段验收声明；**不是已通过证明**。
- `index/phases/P03/features/P03-9/feature.json`：18 个 Task 的索引目录。
- `index/phases/P03/features/P03-9/tasks/F-001.json`：单个 Task 的实际测试范围。

Task JSON 使用 Nezha v2 schema。当前存量用例首轮按文件显式 `all: true`，
对应 19 个本 Feature 文件，不包含此前大批历史模块回归。
部分文件有多个测试类型，暂不凭猜测拆掉其中断言或谎称函数级选择。

新增/精细化测试可用稳定 ID：

```ts
test('[case:pause-idempotent] 重复暂停不产生第二个操作', () => {
  // 实际行为断言。
});
```

```json
{
  "schema_version": 2,
  "task_id": "F-001",
  "projects": [{
    "id": "shiploop",
    "tests": [{"file": "test/modules/execution/control/example.test.ts", "cases": ["pause-idempotent"]}]
  }]
}
```

示例中的文件名不是已存在测试。实际索引必须指向现有路径，ID 须文件内唯一；
不要给 describe 加 ID，参数化展开用例须使用不同 ID。选择测试用例，不是调用生产函数。
Task 可跨模块选用例；Feature 合并去重后在最终代码上重跑。

Harness 的 `verifications/<task>/test-selection.json` 只引用仓库内索引：

```json
{"task_id":"F-001","index":"test/index/phases/P03/features/P03-9/tasks/F-001.json"}
```

只维护一份范围。改动测试行为时审阅关联索引；不因为了变绿而漏选必需场景、移除失败断言。
先读取当前 Task 分配，再按本规范新增/修改模块测试，并登记索引。不编辑 Harness 权威任务状态。

## 分层执行

- Task：当前索引列出的用例；精确选择与结果核对由项目配置的测试适配器执行。
- Feature：使用 `task_union` 重跑 Task 索引合集，不自动代表全量或阶段验收。
- Phase：人工明确发起 `npm run verify` 或独立阶段验收脚本，不自动开测。

`npm test` / `npm run verify` 保留原来的完整收集范围，没有通过配置排除旧失败。
手工快速检查可以显式点名模块，例如：

```bash
npm test -- test/modules/execution/control/p03-9-f001-execution-pause.test.ts
```

## 本次迁移的验证边界

原 299 个文件（298 个 TypeScript、1 个 JavaScript）迁入模块目录，helpers 保留。
原 Vitest 收集到的 3669 条用例记录（295 个有用例的文件）按旧新路径映射核对；
另外 4 个文件在原收集中也没有用例记录。本次另外新增目录/索引约束测试。
这证明收集未丢失，**不证明所有测试通过**。全仓类型检查另行执行并保留证据。

旧路径映射见 `index/path-mapping.json`。历史 Harness 会话和验收日志未重写。
此前全量门禁的失败继续记录在 [已知全量回归](../docs/testing/known-full-regressions.md)，
Feature 局部通过不将这些失败清零，不自动把 Phase 标为验收通过。
