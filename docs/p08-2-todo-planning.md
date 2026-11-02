# P08-2 Todo 规划、批准与执行预算接线（F-002）

状态：交付可调用的真实 ShipLoop CLI 接线与局部协议验证。真实 Pi 规划、负责人批准、
跨层 Host/SQLite/进程执行及 Todo 交付验收均为 `not_run`。单元测试中的脚本化 CLI
响应只验证门禁和协议，不作为模型生成计划或产品通过的证据。

入口：`scripts/acceptance/p08-todo-planning-cli.ts`；流程与范围检查：
`scripts/acceptance/p08-todo-planning.ts`。后续演示控制器也可直接调用
`prepareTodoPlanningSession` / `executeTodoPlanningCliStep`，每次只推进一个阶段。

## 准备

前提是已安装/构建与受测提交一致的 Core/Host/CLI，在独立的临时 Git 项目中通过正式
CLI 注册 Project、创建 Phase、导入空草稿 Feature。负责人在受管配置中设置真实 Pi 的
planner/default/modelMap 策略及凭据引用；本入口不读取凭据文件、不自动改配置、不导入
业务计划、不写 Core SQLite。需求制品必须已通过正式输入制品入口登记，内容是
`acceptance/p08.todo-requirements.json` 的原始 UTF-8 字节。

准备一个 JSON 选项文件，字段对应 `TodoPlanningOptions`：

- `requirementsText`：冻结需求文件的完整原文，保留结尾换行；入口计算原文字节 SHA-256。
- `requirementArtifactId`：该正文在产品中的已登记制品 ID。
- `projectId` / `phaseId` / `featureId` / `revision`：本次产品身份与当前 Feature CAS。
- `route`：`{runtime:"pi",provider:"<授权 provider>",model:"<授权 model>"}`。
- `taskLimit`：3..100；规划必须有不少于三项的依赖链，所有 ID 唯一、无环、无悬空引用。
- `planningBudget` / `executionBudget`：各一份完整预算，例如下面的结构。

```json
{
  "batch": {
    "maxRuns": 1,
    "maxTotalAttempts": 9,
    "maxRuntimeStarts": 9,
    "maxNoProgressRuns": 1,
    "deadlineUtcMs": 2000000000000
  },
  "run": { "maxAttemptsPerRun": 9, "runTimeLimitMs": 120000 }
}
```

数值仅展示形状，负责人须按当次授权填写绝对 deadline 和次数/时限；不自动延长过期
预算、不因恢复重置用量。Core 对期限与累计限额作权威校验。两个 Batch 均限制一个
Run：一个用于规划，一个用于指定 Feature 的实现；不创建新的重试 Batch。

以下 `<session>` 是演示控制器在其 `os.tmpdir()` + `mkdtemp` 临时根下分配的专用子目录；
`<cli-bin>` 是本次受测构建的 `packages/cli/dist/bin.js` 或独立安装后的对应 bin 文件。
`<data-root>` 必须始终指向本次独立 Host 的数据根。命令中的占位符需由负责人替换。

```text
node scripts/acceptance/p08-todo-planning-cli.ts prepare <session> <options.json>
```

会保存 `snapshot.json`、`planning-input.json`、`execution-budget.json`、`state.json`。
快照包含正文摘要、指定范围、Pi provider/model、两份预算和稳定 UUID 命令 ID；相同
session 再次 prepare 不会重置既有批准、失败或执行记录，输入变化会拒绝覆盖。

## 分阶段操作

1. 负责人显式授权有限规划：

   ```text
   node scripts/acceptance/p08-todo-planning-cli.ts plan <session> <cli-bin> <data-root> --authorize-planning
   ```

   先用实际 `config effective` 核对 planner 路由，再通过 `planning start` 提交固定输入。
   accepted 只表示规划 Run 已授权，候选还需等 Core 完成生成；本入口不无限轮询。

2. 候选生成后只读审阅：

   ```text
   node scripts/acceptance/p08-todo-planning-cli.ts review <session> <cli-bin> <data-root>
   ```

   使用 `planning candidate` 的结构化正文验证 ≥3 Task 的依赖链和最大数量，拒绝跨项目/
   Feature、环、重名、悬空依赖和超出冻结需求的制品引用。输出完整计划、验收与
   `candidateDigest`，供负责人逐项核对九类行为覆盖和自然语言范围。引用检查不能替代
   对需求语义的人审；不能因为模型说 completed 就批准。

3. 负责人完成语义审阅后，以看到的摘要明确批准：

   ```text
   node scripts/acceptance/p08-todo-planning-cli.ts approve <session> <cli-bin> <data-root> <candidateDigest> --scope-confirmed
   ```

   重新读取候选并比对审阅内容，调用 `planning approve`，绑定原 revision、候选摘要与
   固定命令 ID。CLI 的新增 `decisionActor` 来自回执 `principalId`，不从用户参数接收；
   记录认证主体只说明谁提交了决定，负责人确认仍由显式操作承担。批准不会启动实现。

4. 单独预览实现授权：

   ```text
   node scripts/acceptance/p08-todo-planning-cli.ts preview <session> <cli-bin> <data-root>
   ```

   使用 `feature get` 核对已应用计划、全部 Task 的真实 Pi 策略；使用 `execution preview`
   核对单 Feature 范围、计划摘要、批准 ID、原始需求制品内容哈希、全部 Task 策略副本
   摘要及原预算。不接受由 Phase 自动展开的额外 Feature。保存 `previewDigest`。

5. 负责人核对预览后单独确认启动：

   ```text
   node scripts/acceptance/p08-todo-planning-cli.ts start <session> <cli-bin> <data-root> <previewDigest> --confirm
   ```

   批准与预览都存在才调用 `execution start <featureId>`，不使用 Phase 范围或隐式 retry。
   返回一个实现 Run；输出保持 `status=accepted, productVerified=false`，不声称任务、
   Feature 或 Phase 通过。Core 在提交时再次核对预览有效性、人工阻塞与预算。

## 恢复、失败与清理

- 每个写命令先保存意图身份，再发送固定 command ID 与原参数。发生响应丢失或本地进程
  中断后，重新调用同一阶段；CLI 先查回执，再按原信封重放。批准已提交造成 revision
  推进时，使用已保存意图恢复原回执；不生成新的批准或第二份实现 Run。
- 成功记录已保存时重复 plan/approve/start 复用本地记录。开始发送 start 后不再生成
  新预览，以免把不确定结果换成另一份授权；需要调整预算时先通过产品控制命令核对
  原 Run，不删除 session 或改命令 ID 来重试。
- 失败记录 `action/reason/exitCode`，包含业务拒绝、路由/摘要/范围漂移和传输结果不确定；
  不复制 stderr、未知错误正文、凭据或开发机路径。原失败保留，后续成功不清空历史。
  CLI 参数和命令信封仍由产品校验，演示文件不构成 OS 沙箱或新的权限系统。
- `.stage-lock` 阻止同一 session 的并发操作者。中断遗留锁时返回
  `session_busy_or_recovery_required`，先核对旧进程与产品回执，不能自动抢锁。
- session 与临时项目由外层演示控制器管理；所有结局均须先停止/核对本次 Host、Run、
  Runner 及工具，再保存脱敏证据，最后只删除自己创建的临时根并核验不存在。
  本模块不自动取消已 accepted 的规划/实现，也不删除正在执行的目录。

## 验证与保留门槛

Task 索引：`test/index/phases/P08/features/P08-2/tasks/F-002.json`。
本地纯协议与文件记录测试不启动模型、Host、SQLite 或子进程。
CLI 批准决定人与回放的真实 Host/SQLite 回归登记到分配策略指定的
`test/index/phases/P07/integration.json`，并在本 Task 索引中明确标为 integration；
此旧 Phase 路径来自当前策略，不宣称本次在验收 P07。跨层真实流程和打包 CLI 进程、
负责人批准、真实 Pi 生成计划与 Todo 实现均留给本 Phase 集成/live，保持 `not_run`。
全仓、组合 verify、Phase 入口未运行，Nezha completed 不能替代任何产品结论。
