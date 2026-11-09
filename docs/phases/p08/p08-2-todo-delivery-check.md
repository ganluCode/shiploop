# P08-2 Todo 交付局部契约检查（F-003）

状态：检查器与参考夹具已交付。live 临时项目的实际检查、真实 Host/SQLite/进程/Git
组合均为 `not_run`；本模块只提供确定性核对入口，不宣称任何 Todo 产品通过。

入口：`scripts/acceptance/p08-todo-delivery-check.ts`。核心 `checkTodoDelivery` 通过
注入端口核对临时 Todo 项目的九类冻结行为（F-001
`acceptance/p08.todo-requirements.json`）；默认端口工厂 `createProcessTodoCheckPorts`
以真实子进程与真实文件系统实现端口。参考夹具
`test/helpers/p08-2/todo-fixture-cli.mjs` 演示一个合规交付，并通过
`TODO_FIXTURE_FAULTS` 提供七类确定性违约（静默成功、吞写失败、读失败折算空列表、
失败破坏数据、不落盘等），证明检查器能逐项抓住违约交付。

## 检查内容

| 检查 id | 覆盖类别 | 判定 |
| --- | --- | --- |
| list-empty | list | 空列表退出码 0 且输出可解释为明确空列表，不是报错 |
| add-list | add, list | 两次新增退出码 0；ID 唯一、标题可见、初始未完成 |
| complete | complete | 状态翻转、其余条目不变、ID/标题稳定 |
| complete-repeat | complete | 重复完成行为确定（两次结果一致）且数据不变 |
| delete | delete | 条目消失、其余不变、数据仍可读 |
| persistence | persistence | 全新进程读取同一数据；数据目录内存在文件形式存储 |
| failure-empty-title | empty-title | 空标题/纯空白非零退出、错误可理解、已有数据不变 |
| failure-unknown-id | unknown-id | complete/delete 未知 ID 非零退出且回显目标 ID、数据不变 |
| failure-invalid-command | invalid-command | 未知子命令与缺参非零退出、数据不变 |
| failure-data-io | data-io-failure | 只读存储/数据不可读注入下非零退出，不折算空列表成功；注入解除后原数据完整可读 |
| project-tests | 全部九类 | 声明的测试文件真实存在且非空；项目测试命令仅按退出码 0 判定通过 |

每次 `runTodo` 都 spawn 全新进程，跨进程持久化由真实进程边界保证；list 输出格式
由交付接线通过 `TodoListInterpreter` 解释（实现细节由 live 规划决定），解释失败按
fail-closed 处理，不猜测降级。

## 使用

由后续演示控制器（F-004 起）在 live 临时项目上调用：

1. `validateTodoDeliveryTarget` fail-closed 校验目标：`dataDirectory` 必须位于
   `projectRoot` 内；`todoCommand`/`testCommand` 为非空命令数组；`declaredTests`
   的文件为项目相对路径（拒绝绝对路径与 `..` 逃逸），类别并集必须覆盖全部九类。
2. 交付接线声明 list 输出解释器（解析真实交付格式，不能解析时返回 null）。
3. `createProcessTodoCheckPorts(target, { timeoutMs, todoEnv, testEnv })` 构造端口
   （可换用自定义端口，但必须保持“每次调用全新进程”语义）。
4. `checkTodoDelivery(target, interpretList, ports)` 返回结构化报告：
   `passed` 仅在全部检查通过时为 true；报告只含稳定结果码与布尔事实，
   不含输出正文、绝对路径或环境内容。

## 边界

- 本检查器只验证 Todo 交付行为；报告 `outOfScope` 显式声明真实 Host、SQLite 并发
  竞争、进程停止核验与 Git 集成属于阶段集成检查，本模块不提供这些结论。
- 项目测试的成功只来自退出码 0，绝不解析日志中的成功文字；打印 "N passing" 但
  退出码非 0 的测试命令判定为失败。
- 命令超时、无法启动（`todo_unrunnable`）与输出不可解释（`list_uninterpretable`）
  均为失败，不折算为通过。
- 故障注入只修改本次临时项目数据目录的权限，解除后恢复可读写；不模拟随机磁盘
  故障，不接触临时根之外的路径。
- Task 索引：`test/index/phases/P08/features/P08-2/tasks/F-003.json`（unit）；
  真实 Pi live 交付、Host/SQLite/进程/Git 集成与 `accept:p08:live` 未运行。
