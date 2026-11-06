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

- `index/phases/P04/features/P04-9/tasks/F-004.json`：Run 归属/槽位与 Task claim 同事务衔接、
  回执持久关联、正常/返工/备用启动围栏。前七文件本地定向通过，新增派发文件 20 项；
  后三文件交 Nezha 独立复验。首次独立复验的预算迁移旧版本断言已定向修复，索引范围不缩减。
  事务边界、故障证据和后续生命周期范围见
  [F-004 交接](../docs/p04-9-f004-atomic-dispatch-claim.md)。

- `index/phases/P04/features/P04-9/tasks/F-005.json`：有界持久补扫与 Work 组合根。
  覆盖派发意图/续跑 Run 的 keyset 分页、稳定游标、重建调度器补扫、同 Run 两 Task
  复用同一认领/槽位、Runtime completed 不等于 passed、finalization-only 准入与
  handoff 幂等、启动门控与关闭。六文件本地定向通过（新增 6 项）；Host 纵向因本
  workspace 未构建原生写入锁而保持 `not_run`，范围与证据见
  [F-005 交接](../docs/p04-9-f005-persistent-rescan.md)。
- `index/phases/P04/features/P04-9/tasks/F-006.json`：暂停/取消接入派发与槽位生命周期。
  覆盖暂停即时阻止认领、排队控制不启动 Runner、补扫不复活控制状态、终态/暂停/取消
  的安全结算、停止不确定与持久结算失败保留/隔离、owner/认领版本/Attempt 围栏下的
  迟到结果与重复结算、显式继续追加 resume 代次、心跳续租与查询解释。新增 8 项本地
  通过；既有暂停/取消迁移版本断言按当前迁移清单派生后本地通过。范围与证据见
  [F-006 交接](../docs/p04-9-f006-dispatch-control-settlement.md)。

- `index/phases/P04/features/P04-9/tasks/F-007.json`：启动恢复核对 Run 认领/槽位、
  Attempt/回执/invocation 与旧资源组；覆盖四类崩溃窗口、快照漂移、恢复事务回滚、
  旧 owner 围栏、显式恢复占用/原 deadline 和旧库兼容及时钟回退。新增三文件本地 21 项通过，
  既有恢复/显式恢复文件及真实 Host 强杀用例有定向证据；其余索引范围交 Nezha。
  实际日志、进程清理与边界见 [F-007 交接](../docs/p04-9-f007-dispatch-startup-recovery.md)。

- `index/phases/P04/features/P04-9/tasks/F-008.json`：Core 派发队列与执行槽位只读投影。
  覆盖展示状态派生、容量/隔离/租约阻塞原因、Runtime 未装配与容量限制区分、跨项目
  槽位摘要、稳定分页与跨项目/跨根游标拒绝、授权/损坏行 fail-closed，以及真实 SQLite
  查询前后事实不变和重开一致。新增 8 项本地通过；既有调度/控制恢复查询、派发契约、
  单槽位与计划分页文件本地通过。范围与证据见
  [F-008 交接](../docs/p04-9-f008-dispatch-slot-query.md)；Host/CLI 接线属 F-009。

- `index/phases/P05/features/P05-1/tasks/F-001.json`：一次性规划候选纯数据契约。
  覆盖规划请求/候选/身份封装校验、执行语义字段冻结拒绝、复用业务计划 v1 的 DAG 负例
  定位、四类摘要区分与审批依据评估、测试候选协议不混用与契约文档守护。
  新增三文件 45 项本地通过；无存储/命令/工具通道变更，较广回归交 Nezha。
  契约见 [P05-1 规划候选契约](../docs/p05-1-planning-candidate-contract.md)。

- `index/phases/P05/features/P05-1/tasks/F-002.json`：规划上下文窄存储与 planner 用途策略副本
  （迁移 v35）。覆盖 v35 只追加/v1–v34 冻结、空库与 v34 升级保留既有计划/审批/派发/Attempt
  数据、真实 SQLite 归属/唯一/枚举/形状/写一次触发器负例、创建发布决策状态机与事务回滚、
  planning Task 与业务计划视图/编码范围/Task 列表隔离及修订保留、重开库副本一致与默认配置
  非追溯、损坏持久 JSON corrupt 拒绝，以及 purposeStrategies.planner → defaultStrategy 回退
  选择纯函数。新增三文件 25 项与受影响迁移断言本地通过；较广回归交 Nezha。

- `index/phases/P04/features/P04-9/tasks/F-009.json`：派发/槽位查询接入 Host、HostClient 与 CLI。
  覆盖真实 Host/HostClient 读取 Core 投影（派生状态用同一规则复核）、槽位摘要与跨项目
  布尔摘要、未认证/未知参数/可写意图拒绝、客户端解码冻结形状、CLI 参数与结构化/文本
  输出（等待/隔离原因与不验收边界），以及有界构建 CLI 的临时 Host 场景。新增三个文件
  35 项本地通过；五个既有回归文件本地通过，另两个 Core 契约文件本地通过。范围与证据见
  [F-009 交接](../docs/p04-9-f009-dispatch-query-wiring.md)。

- `index/phases/P04/features/P04-9/tasks/F-010.json`：生产组合根派发纵向与旧数据升级查询。
  新增文件（5+1 项）覆盖单 Feature 双 Task 串行派发/真实 Task 提交、Feature 最终交付、
  同 Run 双消费者唯一 Attempt、两个已授权 Run 竞争容量 1、丢失唤醒后的 Host 重建补扫，
  以及 P04-8（v32）升级后经生产查询端口读取 Run/Attempt/Git/通过证据。其余 8 个文件复用
  F-004/F-006/F-007、暂停/取消、显式 resume/原 deadline、返工/失败保留、仅收尾与真实
  v32 升级的既有用例；F-004/F-007 故障窗口与真实 v32 升级按稳定 `[case:]` 精确选择。
  首版 15 文件选择曾使独立验证超过 600s，本版按职责收敛并保留全部验收场景，不再并排
  重复覆盖。本地运行新增两文件与最终交付用例，未运行全量、阶段验收、live 或真实模型。

- `index/phases/P04/features/P04-9/feature.json`：F-001 至 F-011 的完整 Task 索引目录；
  阶段入口要求该合集存在且与磁盘 Task 索引逐一一致，否则在执行前失败。

- `index/phases/P04/features/P04-9/tasks/F-011.json`：把 P04-9 纳入既有 P04 验收工具。
  覆盖清单/配置冻结扩展、可信测试索引发现与去重、缺索引/损坏/合集不一致与旧八项报告
  的 fail-closed，以及受影响清单/入口/集成报告/交付回归。新增文件本地 5 项通过，
  五个文件合并回归本地 43 项通过；真实 `accept:p04`、`verify`、全仓、live 与负责人确认
  仍未运行。范围与证据见 [P04-9 补充项交接](../docs/p04-9-f011-acceptance-handoff.md)。

- `index/phases/P05/features/P05-1/tasks/F-012.json`：一次性规划 Host/HostClient 接线。
  新增真实 HTTP/SQLite/Git 与脚本化 Runtime 场景，覆盖 v7 回执恢复、候选查询与人工决定、
  权限隔离、取消/resume、SSE 断开、畸形响应及旧计划兼容；正常规划 Batch 收尾复用恢复规则。
  受影响的 Host/工具/规划执行与恢复、基线、预算和报告回归按文件登记；本地通过与未运行
  范围见 [F-012 交接](../docs/p05-1-f012-planning-host-protocol.md)，不代表全量/阶段验收。

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

P06-3/F-003 的项目资源配置、授权、CAS/幂等、真实双进程竞争、审计回滚与冻结快照用例见
`index/phases/P06/features/P06-3/tasks/F-003.json`。本地通过与仅选择交 Nezha 的回归范围、
构建/类型/边界日志及 F-004 后续接线边界见
[资源配置服务交接](../docs/p06-3-f003-project-resource-service.md)。

F-009 的 FakeRuntime 异常、输出、证据与恢复边界见 `index/phases/P03/features/P03-10/tasks/F-009.json` 和 [交接文档](../docs/p03-10-f009-runtime-negatives.md)：本地三个新增文件 23 项通过；八个既有回归文件仅登记，交 Nezha 独立执行。

F-019 的交付报告、P03 人工验收清单与 P04 进入门槛记录文档守护见
`index/phases/P03/features/P03-10/tasks/F-019.json`：仅文档/索引守护用例（候选索引），
不代表全量测试、递归重跑或任何阶段验收；双次全量阶段复跑仍为 pending/not_run。

- `index/phases/P08/features/P08-1/tasks/F-001.json`：分发元数据与兼容声明冻结。
  覆盖四个 package.json 的名称/统一版本/engines(Node 22.19.0、npm 10.9.3)/os(darwin)
  一致性、工作区依赖与 package-lock 的 link/版本关系、exports/main/types 的 dist→src
  可解析映射与 CLI bin shebang 约定、`distribution-compatibility.json` 与 Host 协议常量
  （wire schema 6、旧客户端握手 5、协议 1、发现 schema 1）及数据库 Schema 读写范围
  （迁移 1..64 连续）的一致性、握手版本门禁对未知 schema/协议的真实拒绝，以及无开发机
  路径/凭据样式/Nezha 依赖和发布阻塞（license、npm scope、正式包名、发布身份）保持
  pending 的边界。真实安装/原生模块加载/Host 启动/已有 Host 兼容矩阵登记为 Phase 集成
  not_run；本 Task 仅本地 pack 元数据冻结，不公开发布。

- `index/phases/P08/features/P08-1/tasks/F-002.json`：可重复的本地 Core/Host/CLI pack 构建。
  覆盖锁定 Node/npm 与 package-lock 预检、Core→Host→CLI staging 和 tarball 文件清单、
  产物摘要/commit/协议/Schema/平台清单绑定，以及 workspace/file/绝对路径、开发目录、
  缺入口、不可执行 bin、疑似凭据和摘要身份不匹配的 fail-closed 负例。真实独立目录
  npm 安装、原生模块加载、Host 启动与三包运行保持 Phase 集成 not_run。

- `index/phases/P08/features/P08-1/tasks/F-003.json`：可审阅的制品完整性与兼容检查器
  （`scripts/verify-artifacts.ts`，`npm run verify:artifacts`）。
  覆盖清单头/工具链/commit 漂移、tarball 身份与逐文件摘要、入口/exports/bin 权限、
  tarball 与工作区版本清单一致性、依赖闭包（悬空 workspace/file 规格、锁外依赖、
  发行代码未声明开发依赖）、Host 协议范围与数据库 Schema 范围对真实常量/迁移链的
  绑定（未知/高版本拒绝不降级）、敏感内容脱敏扫描，以及区分 passed/failed/not_run
  并携带 commit/工具版本/证据引用的结构化报告与 CLI 退出码；负例含篡改 tarball、
  缺 dist 入口、版本漂移、未知兼容版本和凭据样例。真实安装后跨包运行、原生模块
  加载、打包 Host 启动与已有 Host 兼容矩阵保持 Phase 集成 not_run，不折算为通过。

- `index/phases/P08/features/P08-1/tasks/F-004.json`：最小发布 CI 配置与本地检查器
  （`.github/workflows/release-ci.yml`、`scripts/verify-ci-config.ts`、
  `npm run verify:ci-config`，以及 `scripts/ci-summary.ts` 摘要渲染）。
  覆盖受限 YAML 子集解析（锚点/别名/流式/多行标量拒绝）、触发范围恰为 main 的
  push/pull_request、显式 contents: read 最小权限、macos-15 runner 与 Node 22.19.0
  工具链绑定、固定顺序必需步骤（npm ci → verify:ci-config → typecheck → light/standard → build → pack:local →
  verify:artifacts → ci-summary）且禁止 continue-on-error/if 跳过、run 命令白名单、
  禁止 npm publish/git push/gh/PR/合并与 ${{ 表达式、secrets/env 凭据注入隔离、
  Action 引用固定 vX.Y[.Z]/SHA 与白名单、npm 脚本/node 脚本文件接线与制品摘要
  if-no-files-found: error 上传、缺 package-lock/必需脚本/脚本文件 fail-closed；
  负例含额外工作流、无法解析 YAML、触发/权限/runner 漂移、乱序、未审命令、第三方
  Action、凭据注入与 CI 退出码/报告落盘语义。实际 GitHub Actions 运行、CI 环境
  原生模块加载与独立安装保持 Phase 集成 not_run；CI 不发布、不推送、不建 PR。

GitHub `release-ci` 在上述主检查通过后，将 heavy 组按 `test/ci-timings.json`
记录的历史文件耗时均衡分成四片，每片使用独立 macos-15 runner 和一个 Vitest worker。
新文件默认进入 heavy，并以 30 秒估计纳入分片；历史耗时只影响负载分配，不决定测试是否执行。
分片首个失败即退出，仍上传阶段报告和真实 Vitest JSON；最终 `deterministic-checks`
核对五个前置 Job 均成功、四份报告与提交相符、实际测试文件集合完整且无重复。
失败、取消、跳过或缺证据均不放行。`npm test` / `npm run verify` 的本地全量语义不变。
排障时可运行：`node scripts/run-tests.ts --stage heavy --shard 1/4 --stage-report /tmp/heavy-1.json`；
报告路径必须尚不存在，按需要显式配置 `SHIPLOOP_TEST_RUN_TIMEOUT_MS`。

- `index/phases/P08/features/P08-2/tasks/F-001.json`：Todo CLI 演示需求输入与验收契约冻结。
  覆盖 `acceptance/p08.todo-requirements.json` 的九类行为目录（新增/列表/完成/删除/
  跨进程持久化/空标题/未知 ID/无效命令/数据读写失败，失败行为非零退出且保全数据）、
  临时项目 os.tmpdir()+mkdtemp 边界与四类结局清理责任、凭据 not_run 政策、正常交付
  仅真实授权 Pi 且 FakeRuntime 限定五类确定性故障夹具、live 规划不少于 3 项有依赖
  Task 的 DAG 判定（validateTodoTaskPlan，含环/重名/悬空/链长负例）、六类证据制品
  身份链，以及契约漂移（版本/类别删减/绝对路径/凭据字段/政策弱化）fail-closed 拒绝。
  真实规划、Todo 实现与 live 验收由后续 Task 交付，当前 not_run。

- `index/phases/P08/features/P08-2/tasks/F-002.json`：Todo 规划/人工批准/预算与单 Feature
  启动的真实 CLI 接线。unit 覆盖固定输入/路由/预算、候选 DAG 与引用范围、显式批准和
  启动门禁、快照/预览漂移、失败原因、回执丢失后的原命令重放，以及本地不可变输入、
  原子记录与保守锁恢复；脚本化传输不构成真实模型通过证明。批准主体来自可信回执，
  对应 Host/SQLite 的 `p05-1-f014-planning-e2e` 回归标为 integration 并绑定当前分配
  指定的 `index/phases/P07/integration.json`，本 Task 不执行该 Phase 入口。跨层和真实
  模型/live 保持 not_run，操作入口与限制见 [F-002 接线](../docs/p08-2-todo-planning.md)。

- `index/phases/P08/features/P08-2/tasks/F-003.json`：Todo 交付结果局部契约检查器。
  unit 在真实临时项目（os.tmpdir()+mkdtemp 沙箱）中用真实子进程验证检查器：参考实现
  九类行为全部通过；空标题/未知 ID/无效命令静默成功、写失败吞掉、读失败折算空列表
  成功、失败破坏数据、不落盘逐项被抓住；项目测试仅按退出码判定，成功文字不折算
  通过；目标越界/绝对路径/.. 逃逸/类别缺口 fail-closed；报告不含绝对路径并显式把
  真实 Host、SQLite 竞争、进程停止与 Git 集成列为阶段集成 outOfScope。检查器本身
  不运行模型、不接触 Host/SQLite/Git；live 临时项目实际检查与 `accept:p08:live`
  保持 not_run，入口与限制见 [F-003 检查器](../docs/p08-2-todo-delivery-check.md)。

- `index/phases/P08/features/P08-2/tasks/F-004.json`：Todo 正常 live 交付编排。
  unit 覆盖真实 Pi 模式门禁、依赖 Task 串行解锁、局部验证失败传播、commit/tree 身份
  与证据保存失败；Runtime completed 不替代验证或本地提交。真实授权、真实 Pi、临时仓库
  和跨层 Host/SQLite/进程组合仍由 live/Phase 集成独立执行。

- `index/phases/P08/features/P08-2/tasks/F-005.json`：Todo live 确定性负例夹具。
  unit 使用真实 `mkdtemp` 临时根核对缺认证/未授权在认领前停止、依赖失败与预算耗尽传播、
  取消保留代码/Attempt/预算/证据，以及未确认停止时保持占用且不重启。状态文件、证据文件
  和实际部分 worktree 由 `auditTodoLiveNegative` 交叉核对；不调用模型，不把 fake 结果当作正常
  live 通过。真实 Host/SQLite/Git/进程组合和 Phase/live 入口保持 not_run。

- `index/phases/P08/features/P08-2/tasks/F-006.json`：Todo live 结构化报告与证据聚合。
  unit 覆盖需求版本/摘要与 Project/Feature/Run/Task/Attempt 身份绑定（含源交付报告 digest
  交叉核对与篡改拒绝）、四态状态传播（failed/inconclusive/not_run/人工待确认互不折算，
  声明状态必须等于按内容重推导结果）、敏感边界（凭据键/真实密钥值/绝对路径拒绝，制品仅
  相对引用加 sha256/字节完整性并可按 artifactRoot 复验）、证据缺失处理（退出码 0 缺制品、
  缺代码 commit/tree、Task 缺验证/提交证据一律 inconclusive 不产生 passed），以及
  `accept:p08:live` 未授权入口的结构化 not_run 报告。同时重跑 F-004 交付编排回归
（本 Task 修改了其入口模块）。跨层报告与真实 Git/SQLite/Host/进程资源一致性由
  Phase 集成验收负责，入口与限制见
  [F-006 报告](../docs/p08-2-todo-live-report.md)。

- `index/phases/P08/features/P08-2/tasks/F-007.json`：干净安装目录启动打包 CLI 的
  Todo 演示安装冒烟。unit 用打包夹具（真实 npm pack 生成三包 tarball 与分发清单）
  在真实临时沙箱执行真实 `npm install --offline` 与真实子进程：干净安装目录只用
  打包产物启动 CLI 并访问最小稳定协议（host start/status/host_not_found 拒绝/stop
  回执）；安装目录符号链接逃逸、分发清单缺失/篡改、兼容声明缺失、打包模式协议漂移、
  与源码模式协议不一致、token 外泄、输出/报告绝对路径逐项 fail-closed；运行时依赖
  清单与实例/数据根隔离入报告。真实 registry 安装、原生模块矩阵、Git/SQLite 业务流、
  跨进程组合与 live 交付保持 not_run，入口与限制见
  [F-007 安装冒烟](../docs/p08-2-todo-install-smoke.md)。

- `index/phases/P08/features/P08-2/tasks/F-008.json`：非 Nezha 存量仓库增量变更局部契约。
  使用真实临时 Git 仓库固定脏跟踪文件、暂存文件、未跟踪文件、已有测试和明确已知失败；
  初始化核对项目归属、路径授权、HEAD/脏状态保护和禁止自动提交。增量报告分别登记代码、
  新测试、验证退出码、commit/tree 与未解决基线缺口；已知失败不会被新需求通过自动豁免。
  测试属于 integration，真实 project init、SQLite、Host、进程、Pi、归档恢复和 Phase 报告
  保持 not_run，入口与限制见 [F-008 存量演示](../docs/p08-2-existing-demo.md)。

- `index/phases/P08/features/P08-2/tasks/F-009.json`：`accept:p08:live` 正式入口编排。
  unit 覆盖正常 live、负例、报告校验、干净安装和存量仓库五阶段的固定选择顺序，记录实际
  退出码与相对证据引用，并核对 `passed`/`failed`/`not_run`/`inconclusive` 传播和 0/1/2/3
  退出码映射。入口报告绑定 commit/tree、Node/npm/platform、预算、人工 pending 和 Phase
  集成 `not_run` 缺口；真实 Pi、Host/SQLite/进程/恢复和存量产品闭环仍须独立 Phase 验收，
  不能由局部测试、Feature 门禁或脚本自报完成替代。范围说明见
  [F-009 live 入口](../docs/p08-2-live-acceptance-entry.md)。
