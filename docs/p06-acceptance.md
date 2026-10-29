# P06 存量接入与资源验收

2026-10-29 最终决定：P06 影响范围离线验收和最小真实模型验证通过，负责人已确认放行。
全仓历史回归明确延期到 CI，未执行且不作为本次签署前置。受测身份和最终报告见
[负责人记录](acceptance/p06-owner-walkthrough.md)。

`npm run accept:p06` 是开发验收入口，使用当前提交的前序 P06 代码、真实临时 Git/SQLite、loopback Host、脚本化 FakeRuntime 和本地无凭据 stdio MCP。入口不调用模型，不维护 ShipLoop 或 Nezha 的 Phase/Feature/Task 状态。

## 前提与命令

正式受测源码必须位于干净提交。Node 22.19.0、npm 10.9.3，使用仓库锁定工具。编排者先核对 P06-1～P06-6 的交付与接口，并提供 JSON 文件：`approvedBy` 为实际核对人，`features` 必须恰好包含六项，每项有 `feature`（如 `P06-1`）、完整 `commit`、`delivered: true`、`interfacesSatisfied: true`。入口逐项核对该提交是当前 HEAD 的祖先；布尔声明不替代负责人审阅。Runtime 不自行签发这份文件，也不创建、改名或切换分支。

```bash
npm run accept:p06 -- --run-id p06-owner-001 \
  --prerequisites ./owner-baselines.json \
  --expected-commit <完整受测SHA> \
  --report-dir ./artifacts/acceptance/p06
```

示例中的 SHA 和审批文件需由编排者提供。每次运行选择新 ID；已有运行或报告目录一律拒绝复用。配置、冻结清单、入口契约、仓库身份、工具版本、前序资格、测试索引及报告路径均在启动场景之前校验；不能把脏源码冒充 HEAD。Todo 夹具中的脏文件是专门保留的业务输入，与验收工具源码的干净提交要求分别检查。

## 固定步骤与预算

1. `p06-prerequisites`：核验前序资格后，构建本机 Host 原生锁。
2. `p06-scenario-close-loop`：执行 `p06-7-f008-demo.test.ts` 的真实离线演示并导出结构化证据。
3. `p06-trusted-index`：执行 P06-1～P06-7 当前可信 Task 索引的去重文件合集；演示文件已在上一步运行，不重复。早期 Feature 直接登记 Task 索引；P06-5/P06-7 的 `feature.json` 还需与磁盘 Task 集合严格一致。未知、空、缺失、越界、符号链接和非法选择均拒绝，空集合不会退化到全仓。
4. `p06-manual-gate`：读取独立负责人记录；没有记录时为 `not_run`，不执行一个返回 0 的占位命令。

默认单步 900000ms、总计 1200000ms。可用 `--step-timeout-ms`、`--overall-timeout-ms` 指定有限预算。失败或超时后未启动步骤记 `not_run`；剩余总预算限制下一步。输出有界，完整的有界步骤日志与截断标记留在运行目录。进程停止使用已验证的祖先关系及 PID/启动/argv 身份；只有仍匹配的根进程才可按其进程组停止，其他已知后代逐项核验。即使主进程返回 0 也核验后代和进程组；未知存活成员、扫描失败或停止不确定会阻止成功并保留资源。

每次入口创建新的系统临时根、HOME/TMPDIR 和所有权标记，子进程只接收明确的环境白名单。只有停止确认且所有权仍匹配时才回收本次临时根。不会根据进程名批量停止，不删除其他 run、报告或用户仓库。临时制品先导出、重读和散列，再关闭/删除资源。

## 演示与证据

演示在同一个真实 Todo 仓库和同一个业务项目中，通过 Core 命令注册、Host/CLI 确认技术画像与运行策略，通过 CLI 持久化退出码 3 的已知失败基线，再用 Host 检索项目文档。Core 固定 Attempt 的知识版本与摘要，FakeRuntime 仅获准写 `todo/inbox.txt`；真实子进程核对增量，原有修改、暂存内容、未跟踪文件、文档和第二仓库保持原样。Runtime completed 后 Task 仍是 running，演示不伪造任务验收通过。

资源部分使用独立受信的 SDK loader/stdio 测试夹具，真实加载已选 Skill，发现并调用一个已选工具；未选工具不能解析，隐式 Skills、扩展和上下文文件不出现。二次 Host 竞争、非零检查、超时、取消、跨项目读取、输入身份变化和真实报告写入拒绝均核对结果及副作用。恢复、跨项目工具句柄和受限 Work 权限的完整矩阵来自可信索引中的 F-005 测试，不把这一次正常工具调用当作恢复验证。

FR-1、FR-2、I01～I08 及七个故障子场景分别导出带唯一身份的 `sqlite/git/process/artifact/command-exit/usage/manifest/cleanup` 类型化快照。各场景保留不同的实际操作观测；最终一致性快照来自同一次演示结束前的真实数据库、Git 和文件。所有场景捕获完成后才通过共享清理屏障删除资源。数据库快照使用 SQLite backup API，不通过 SQL 制造产品状态。产品 Feature 报告来自真实 Core/Host 查询，在关闭资源前导出。

报告根内布局：

- `runs/<id>/inputs.json`：配置、前序资格、输入哈希及完整测试选择。
- `runs/<id>/step-run/`：步骤顺序、实际 argv、退出码、耗时、停止核验和日志。
- `runs/<id>/source/`：场景与产品导出，含 `entry/steps.json` 的步骤/清理记录。
- `runs/<id>/entry-result.json`：入口结果，不代表负责人已签署。
- `reports/<id>/report.json`、`summary.md`：最终可复核报告，包含输入摘要、受测 commit、工具链、逐项状态、实际命令、产品报告及证据哈希。

报告器重读并验证场景、产品、步骤和外部门禁，再从冻结清单重建结论。缺证据、篡改、失败、未运行或清理不确定均不能通过。入口退出码与最终报告一致；报告发布/核验失败返回 1。报告目录不允许覆盖；整目录核验函数为 `verifyP06ReportDirectory(directory, identity)`。

## 独立门槛与当前限制

默认不执行 `npm run verify` 或全仓历史回归。`--full-regression` 是负责人显式选择的附加全仓步骤，不能由 Task Runtime 自行开启。工程 `verify` 仍是独立命令，保留测试、类型、边界、构建和产物冒烟语义，不用此入口的离线通过替代它。

P06 冻结清单包含必需的 live 与人工项。离线全部通过时，报告应是 `offlineConclusion=pass`、`conclusion=fail`、退出码 1，直到独立门槛满足；不能把这称为整个 Phase 通过。`--live-authorized <capture.json>` 仅导入另一位获准 live runner 产生的、有调用预算和清理证据的记录，不发起模型请求；`--manual-record <capture.json>` 只导入负责人记录。二者必须绑定本次 runId、testedCommit、inputDigest，完整结构见 `P06GateCapture`。可以先核对一次离线运行的 inputsDigest，再为同一干净提交和相同输入准备新的运行 ID 及其独立门禁记录；不能把上一 run 的身份直接复制为本次证明。

正式验收仅针对 macOS；HTTP/SSE MCP、远程服务器、付费模型、Chat、向量库和 OpenViking 不在默认范围。资源清单与接口权限通过不代表强 OS 沙箱。前序 Phase 的人工验收资格仍由编排者核对；本入口没有自动签署或补签历史阶段。

本次 F-008 的实际命令、退出码、日志、未运行项与 owner 状态见[负责人 walkthrough](acceptance/p06-owner-walkthrough.md)。Task 定向通过不等于完成整阶段或全仓验收。
