# P03-7 F-014 人审决定/显式验证继续 CLI-Host 命令链接线契约

状态：已实现并通过任务级验证（2026-10-17）。本文是 F-014 命令面的公共契约说明；
实现以本地代码与测试为权威。

## 1. 命令身份（冻结词汇；全部经 HostClient → 既有 Host 命令路由 → Core 应用能力）

| CLI | 操作 | 说明 |
|---|---|---|
| `task status <taskId> --project` | 只读查询 | 机器结论 / 人审待处理 / 有效 Task 状态三分区（F-013 三查询聚合） |
| `task block <taskId> …` | `task.approval.block` | 添加阻塞/必需审批事项（expectedRevision=Task revision） |
| `task approve\|reject\|unblock <taskId> <itemId> …` | `task.approval.approve\|reject\|unblock` | 事项决定（expectedRevision=事项 item revision） |
| `task continue <taskId> --attempt --batch …` | `task.verification.continue` | 显式验证继续（expectedRevision=Task revision） |
| `config create\|update`（`policies.verification`） | 既有 settings 命令 | 检查定义/模块策略确认（F-001 复用既有配置与授权命令通道） |

- 不新增第二 Host/查询面：任务状态查询复用 `execution.task.verification.get`、
  `execution.task.approvals.list`、`execution.task.rework-chain.list`；命令经既有
  `commands.submit` 冻结信封与回执幂等通道。

## 2. 结构化回执与业务状态（冻结字段集线校验）

- `task.approval.block` completed result：`{taskId, manualBlock:true, revision, item,
  planDigest, checkPolicyDigest}`；
- `task.approval.approve/reject/unblock`：`{taskId, item, decision,
  executionStarted:false, runtimeCalled:false}`；
- `task.verification.continue`：`{taskId, attemptId, verificationBatchId, disposition,
  status, waitingFor, reason, runtimeCalled:false, executionStarted:false}`。
- `packages/host/src/client/app-wire.ts` 对以上结果做冻结字段集精确键校验（漂移即
  `response_malformed`）；命令结果 item 是持久事项记录（毫秒时间戳），与查询面
  公开投影（ISO 时间）分开冻结。HostClient 新增 `submitTaskApprovalBlock`、
  `submitTaskApprovalDecision`、`continueTaskVerification`（输入严格未知键拒绝）。
- CLI 纯视图（`packages/cli/src/app/approvals.ts`）：执行边界恒为
  `started=false / runtimeCalled=false / runnable=false`；继续结果
  `waitingFor='verification_not_assembled'` 映射 `display='unsupported'`（未装配
  语言执行器明确 unsupported，不折算通过）。

## 3. 状态折算不变量

- `task status` 三分区独立展示；`display='passed'` 仅当机器 `status='passed'` 且
  有效 `task.effectivePassed`（builder 内断言不变量，违反即抛错）；
- 错误（error）、等待批准（waiting_approval）、not_run 与额度耗尽（exhausted）
  一律不打印为通过；退出码沿用既有约定（0 成功/1 业务拒绝/2 输入错误/3 协议）。

## 4. 参数守护（不接受客户端伪造主体或明文凭据）

- 伪造主体/凭据参数（`--principal/--actor/--decision-actor/--token/--credentials`）
  在解析层就是未知参数（退出码 2）；HostClient 输入键冻结同样拒绝；
- 检查定义/模块策略确认（config `policies` 段）递归扫描键名：明文秘密/环境值
  字段与主体字段拒绝；checkDefinitions 的 `scope`（task/module/project）是检查
  范围词汇，保留由服务端 Schema 唯一权威校验；
- 决定人由 Host 可信装配绑定（local-owner）；`--party` 是业务责任主体名，越权
  责任主体（不在授权角色集）得到 `forbidden`。

## 5. 测试映射

| 验收要求 | 证据入口 |
|---|---|
| 检查确认 + 伪造字段拒绝 + 决定/解除 + 状态三分区 + Runtime 计数不变 | `test/p03-7-f014-cli-vertical.test.ts` |
| 批准→继续→重放/重复继续/过期观察；机器绿等待批准不折算通过 | 同上（显式验证继续用例） |
| 同 commandId 重放、过期摘要、越权主体、重复继续回执；批准/继续零 Runtime/编码调用 | `test/p03-7-f014-cli-built.test.ts`（dist/bin.js） |
| 参数映射/输入守护/折算不变量/帮助边界/生产源码无开发机路径 | `test/p03-7-f014-cli-args.test.ts` |

## 6. 边界

- 批准/拒绝/解除/继续均不启动执行、不调用 Runtime、不创建 Attempt；批准不是
  启动授权，解除不自动恢复执行；显式继续只复用已保存机器证据（零新增编码调用）。
- 本任务只接线既有能力与结构化展示；Task 局部验证不代表 P03-8 Feature 全量交付；
  可信项目模式非强 OS 沙箱；未装配语言执行器明确 unsupported。
- 开发机绝对路径与 Fake 配置不进入默认生产依赖（生产源码/帮助扫描 + 依赖清单
  断言）；不新增阶段验收脚本；Feature 全量门禁与阶段验收在 DAG 结束后统一执行。
- 测试环境说明：真实装配中后台调度诊断会覆写 Run 暂停原因（`run_control_blocked`），
  验证继续用例在 FakeRuntime 执行完毕后关闭调度扫描再播种（与 F-012 继续测试
  同一无调度环境），不在本任务内改变调度/验证收尾语义。
