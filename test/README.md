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
- `index/phases/P03/features/P03-10/feature.json`：已登记的 P03-10 Task；包括 F-001 夹具、F-002 检查清单/配置，以及 F-003 三 Task 链诊断和受影响回归。F-003 当前检测到受控提交缺口，诊断测试通过不代表纵向交付验收或阶段通过。F-004 登记完整 Feature 报告的 SQLite 用例与既有查询回归；F-005 登记授权 Host/HostClient、正式构建 CLI 完整报告及 P01/P02 授权、分页、协议拒绝回归。F-006 登记执行报告文本视图/人工提示用例与构建 CLI 文本回归。F-007 登记持续检查失败纵向负例，以及 SQLite 竞争、累计预算、执行范围、依赖、资源锁和事件归属的 35 个精确 case。本地通过范围见各任务交接。

- `index/phases/P04/features/P04-2/tasks/F-007.json`：真实临时 Host/Core 的允许、越权、幂等与重启验证，以及真实 SDK 显式资源加载、认证/推理区分和合成凭据脱敏。四个文件已本地聚焦验证，另五个回归仅登记交 Nezha；实际 manifest、权限矩阵、日志与 live `not_run` 见 [交接文档](../docs/p04-2-f007-access-integration.md)。

- `index/phases/P04/features/P04-3/tasks/F-007.json`：故障路由组合矩阵、受管查询脱敏/兼容、安装 SDK 重试边界，以及分类/累计重试/备用/预检/停止与架构关联回归。实际本地日志、SDK API 边界和独立验收范围见 [故障路由交接](../docs/p04-3-f007-failure-routing-integration.md)。

- `index/phases/P04/features/P04-6/tasks/F-007.json`：跨 Attempt 恢复/累计/去重、缓存与模型归属、后台测试与并发阶段耗时，以及真实 SQLite/Host/构建 CLI 的只读、分页、授权和脱敏回归。本地通过与仅登记范围见 [P04-6 交接](../docs/p04-6-f007-cross-scenario-regressions.md)；live 保持 `not_run`。

- `index/phases/P04/features/P04-7/tasks/F-008.json`：真实三代写入进程、四层超时、Host SIGKILL 后恢复、身份/停止/flush/过期资源隔离及失败清理证据。本地新增四文件 22 项通过，原 Host-loss 兼容用例精确通过 1 项；其余回归交 Nezha。manifest、类型检查既有错误和 `not_run` 边界见 [F-008 交接](../docs/p04-7-f008-process-resource-matrix.md)。

- `index/phases/P04/features/P04-8/tasks/F-005.json`：恢复来源/权限/副作用政策、标准 Pi 原生写入者与档案故障、恢复水位及用量去重，组合新增真实 SQLite 记录故障/迟到结果 9 项。新增文件本地通过，其余已存在用例交 Nezha 独立复验；数据库故障不代表 Pi 使用 SQLite，范围与证据见 [F-005 矩阵](../docs/p04-8-f005-recovery-recording-matrix.md)。

- `index/phases/P04/features/P04-8/tasks/F-006.json`：五类控制事件（请求取消/工具取消/超时/Host 异常/Runner 强杀）、停止不确定保留占用、取消窗口迟到结果与报告证据完整性离线矩阵，组合新增真实进程+SQLite 18 项；本地通过后无遗留进程，其余取消/停止/步骤器回归交 Nezha，场景与证据见 [F-006 矩阵](../docs/p04-8-f006-control-fault-matrix.md)。

- `index/phases/P04/features/P04-8/tasks/F-009.json`：live 授权/零调用、预算、定向检查/Git 交付、证据水位和凭据边界；真实 SDK 在离线 transport 下核对工具循环、401 与取消。阶段入口/报告和既有 SDK/认证回归交 Nezha；真实模型、Core 业务闭环和外部工具进程保持 `not_run`，见 [live 工具说明](../docs/p04-8-f009-live-entry.md)。

- `index/phases/P04/features/P04-8/feature.json`：F-001 至 F-010 的完整 Task 索引目录，仅作为 Feature 去重选择。F-010 新增干净临时 Git 项目的六种最终接线场景与交付守护；既有步骤器/入口/报告/live 回归交 Nezha。默认无模型/网络调用，不递归启动全量或阶段。版本、实际命令与退出码见 [交付报告](../docs/p04-8-f010-delivery-report.md)，人工阶段及真实 live、签署分别保持独立门槛。

- `index/phases/P04/features/P04-9/tasks/F-001.json`：Run 级持久派发认领与单执行槽位（迁移 v33）。
  覆盖新端口契约、真实临时 SQLite 约束/升级/回滚/高版本拒写、Drizzle 与迁移对齐、迁移执行器，
  以及因新增迁移而维护的 P03-4/P03-6/P04-5 版本断言；七文件全部本地定向通过，模型、阶段全量与
  live 保持 `not_run`，范围见 [F-001 契约](../docs/p04-9-f001-dispatch-slot-contract.md)。

- `index/phases/P04/features/P04-9/tasks/F-002.json`：Run 持久入队（迁移 v34）。
  覆盖入队契约与命令路径原子性/幂等/守卫/回滚/唤醒、v34 约束与 v33→v34 升级，
  以及受影响的启动/重试/resume/仅收尾与迁移版本断言。新增两文件本地 14 项通过，
  其余登记回归见 [F-002 交接](../docs/p04-9-f002-persistent-enqueue.md)；Host 纵向
  收尾回归因本 workspace 未构建 Host 原生写入锁而无法运行（与本 Task 无关），
  模型、阶段全量与 live 保持 `not_run`。

- `index/phases/P04/features/P04-9/tasks/F-003.json`：单执行槽位事务原语（迁移 v33 表）。
  覆盖真实临时 SQLite 的跨连接/跨进程容量 1 竞争、同身份幂等、一 Run 一槽与一槽一
  owner、旧 owner/version 与伪造释放围栏、到期只隔离不回收、容量 >1/0/负数/非整数
  与生产并发配置 fail-closed、槽位不改写三组租约/基线/Git 事实，以及项目/工作区/
  Git 短锁既有回归。新增文件本地 8 项通过；三文件索引见
  [F-003 交接](../docs/p04-9-f003-execution-slot.md)。`p03-4-task-dag`/`p03-4-task-claim`
  的迁移版本硬编码断言在开工基线即失败（v33/v34 追加后未更新），未纳入本 Task 范围。

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

F-009 的 FakeRuntime 异常、输出、证据与恢复边界见 `index/phases/P03/features/P03-10/tasks/F-009.json` 和 [交接文档](../docs/p03-10-f009-runtime-negatives.md)：本地三个新增文件 23 项通过；八个既有回归文件仅登记，交 Nezha 独立执行。

F-019 的交付报告、P03 人工验收清单与 P04 进入门槛记录文档守护见
`index/phases/P03/features/P03-10/tasks/F-019.json`：仅文档/索引守护用例（候选索引），
不代表全量测试、递归重跑或任何阶段验收；双次全量阶段复跑仍为 pending/not_run。
