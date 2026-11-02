# P08-2 Todo CLI 演示需求输入与验收契约（F-001 冻结）

状态：F-001 冻结的需求输入与契约定义。本 Task 只交付契约与守护检查，不交付 Todo
实现代码；真实 Pi 规划、实现、live 验收分别由后续 Task 与阶段集成执行，当前一律
`not_run`，不折算为通过。

机器可读契约：`acceptance/p08.todo-requirements.json`（schemaVersion 1）。
加载与 fail-closed 校验入口：`scripts/acceptance/p08-todo-requirements.ts`。
来源：P08-2 PRD（p08-todo-demo，版本 0.2）FR-1/FR-2 与验收标准 1–5，
及 core-design 09-testing-and-implementation.md 的 Demo A 分层验证要求。

## 1. 冻结的需求行为

需求输入覆盖以下九类行为；正常行为必须以退出码 0 结束并可观察，失败行为必须
退出码非 0、输出可理解错误且不破坏已有数据：

| 类别 | 行为 | 关键可观察结果 |
| --- | --- | --- |
| add | `todo add <标题>` | 新条目获得唯一稳定 ID，出现在列表中 |
| list | `todo list` | 输出 ID、标题、完成状态；空列表退出码 0 |
| complete | `todo complete <ID>` | 指定条目变为已完成，其余不变 |
| delete | `todo delete <ID>` | 指定条目从列表消失，其余不变 |
| persistence | 进程 A 写入、进程 B 读取 | 跨进程读取同一数据，持久化文件位于项目数据目录 |
| empty-title | `todo add ""` | 退出码非 0，指明标题不能为空，数据不变 |
| unknown-id | complete/delete 不存在的 ID | 退出码非 0，指明 ID 不存在，数据不变 |
| invalid-command | 未知子命令或缺参数 | 退出码非 0，输出错误或用法说明，数据不变 |
| data-io-failure | 数据文件不可读/不可写（受控注入） | 退出码非 0，不把读失败当空列表成功，注入解除后数据仍可读 |

实现语言细节、存储格式与内部结构由 live 规划决定，但必须满足上表的可观察行为
与数据边界。数据读写失败通过受控注入构造，不依赖真实磁盘随机故障。

## 2. 临时项目、数据目录与清理责任

- 临时项目由检查或执行入口在系统临时目录（`os.tmpdir()`）下按 `mkdtemp` 语义
  创建唯一临时根，前缀 `shiploop-p08-todo-`；目录布局为
  `<tempRoot>/project`（项目根，含独立 Git 仓库）与 `<tempRoot>/project/data`
  （数据目录）。全部待办持久化文件必须位于数据目录内。
- 隔离：不复用开发仓库、真实 HOME 或既有项目数据；不读取开发机用户配置、凭据
  或未获准的全局资源；不在临时根之外写入业务数据。固定字面量的共享路径、系统
  目录均属禁止位置。
- 清理责任：创建该临时项目的入口负责清理，覆盖 success、failure、timeout、
  cancelled 四类结局；运行结束后必须能核验临时根不存在。清理失败保留现场并
  如实报告，不静默当作已清理；只允许删除本次创建的临时根。
- 机器无关：全部位置在运行时从系统临时目录派生，本契约及派生需求文本不包含
  任何开发机绝对路径（守护检查逐字符串扫描拒绝）。

## 3. 凭据边界

真实 Pi live 凭据只来自负责人授权的本机环境与受控配置；需求输入与契约文件、
测试与夹具、日志与运行证据、报告与 Git 提交一律不含凭据。缺认证或未授权时
对应 live 项记 `not_run`，不折算为通过，也不得改用 FakeRuntime 冒充。

## 4. 运行时政策：真实 Pi 与 FakeRuntime 边界

- 正常交付必须使用真实授权的 Pi 流程（runtime `pi`、mode `real-authorized`）：
  负责人授权的 provider 与 model、人工批准后才创建实现 Run、时间与次数预算，
  超预算停止。
- FakeRuntime 仅允许用于受控故障夹具，禁止替代正常交付或伪造成功证据。获准的
  故障夹具固定为五类：auth-failure（缺认证/认证失败）、budget-exhaustion
  （预算耗尽停止）、cancel（显式取消）、interruption-restart（获准中断后继续，
  先核对既有代码、预算与 usage）、dependency-failure（依赖失败后不继续执行）。
  故障全部用确定性注入构造，不要求也不依赖模型随机犯错。
- Runtime 或编排器自称 completed 不等于产品验收通过，须以独立核验为准。

## 5. live 规划政策

- 规划必须来自真实 ShipLoop 规划流程（实际 CLI），以冻结需求文件为固定输入
  快照；派生需求文本必须与冻结行为一致。
- live 规划必须产生不少于 3 项有依赖的 Task：ID 唯一、依赖显式声明且只引用
  同一计划内 Task、依赖图无环，且至少存在一条覆盖不少于 3 项 Task 的依赖链
  （`validateTodoTaskPlan` 提供机器判定）。
- 规划结果须负责人批准后才允许创建实现 Run；Task 只覆盖 Todo CLI 演示需求，
  不得扩张到其他 Phase/Feature 或提前实现后置能力。重复规划或重复启动不得
  产生超出指定范围的第二份交付执行。

## 6. live 证据身份链

`accept:p08:live` 运行报告承载本契约的 live 结果；未运行记 `not_run`。报告必须
保留六类制品的关联身份，并能从 Feature → Task → Run/Attempt → Git 提交 →
测试结果逐级对应：

| 制品 | 含义 |
| --- | --- |
| code | 临时项目内的实现代码 |
| tests | 与需求行为对应的测试文件及其执行结果 |
| taskResults | Task 级结果与失败、返工记录 |
| featureResult | Feature 最终结果（含 not_run 事实） |
| gitCommits | 临时项目 Git 提交 SHA，可追溯到具体 Task |
| runEvidence | Run/Attempt 身份、命令、退出码、预算与 usage 记录 |

无法关联的身份按缺口记录，不得宣称通过；报告与证据不包含凭据或开发机绝对
路径；`not_run` 不计入通过。

## 7. 边界与 not_run

- 本 Task 交付契约冻结与守护检查（`test/modules/acceptance/p08-2-f001-todo-requirements.test.ts`），
  不实现 Todo CLI 代码，不运行真实模型，不创建临时项目。
- 真实规划/批准/执行预算流程（F-002）、局部契约检查器（F-003）与阶段 live
  集成验收（后续 Task 与 `accept:p08:live`）分别交付；当前全部 `not_run`。
- 本契约与 ShipLoop 一期边界一致：不做 npm 公开发布、不自动 push/PR、不做
  跨平台正式认证；FakeRuntime 不用于冒充真实模型能力。
