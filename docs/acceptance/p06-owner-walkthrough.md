# P06 负责人 walkthrough

状态：2026-10-29 负责人明确接受 P06，允许准备 P07；阶段验收通过。

## 本次最终记录（优先于下文模板）

- 受测提交：`5c1c13939d9a4d9bd841e676d41bd483fbe64618`，acceptance/p06。
- P06 影响范围测试 149 文件、2134 项通过；离线 10 项通过。
- 方舟 ark-agentplan/ark-code-latest 最小真实验证 3 请求通过，实际记录用量 1457 Token（partial），停止及临时资源清理已确认。
- 负责人在本对话明确确认通过，正式聚合为 12 pass / 0 fail / 0 not_run，exitCode=0，报告完整性通过。
- 最终报告：`/private/tmp/shiploop-p06-accept-20261029/reports-approved/p06-offline-20261029-005/summary.md`。
- `npm run verify` / 全仓历史回归未执行；负责人同意按影响范围验收并延期全仓到 CI，不是已通过，也不再作为本次签署前置门槛。
- 下文保留通用操作模板；其中旧的 verify 必需条件由本次明确决策替代。没有新跑模型或伪造历史测试。

## 受测身份与前提

- 日期：由负责人填写。
- 分支：由编排者填写；Runtime 不创建或切换分支。
- 受测 commit：由入口 `git rev-parse HEAD` 记录，必须是完整 SHA，且执行前工作树干净。
- Node/npm：要求 Node 22.19.0、npm 10.9.3；锁文件使用 `package-lock.json`。
- 平台：正式条件为 macOS。
- 前序资格：负责人核对 P06-1～P06-6 的分支链、祖先关系、接口和已验收证据，并保存 `owner-baselines.json`；入口只验证其结构和 commit 祖先关系。

## 负责人命令

```bash
node --version
npm --version
git rev-parse HEAD
git status --short
npm run accept:p06 -- --run-id p06-owner-<timestamp> \
  --prerequisites ./owner-baselines.json \
  --expected-commit <完整受测SHA> \
  --report-dir ./artifacts/acceptance/p06
npm run verify
```

如明确授权完整历史回归，再另行使用：

```bash
npm run accept:p06 -- --run-id p06-owner-<timestamp>-full \
  --prerequisites ./owner-baselines.json --full-regression
```

每条命令均记录实际退出码。不要用上一次 run 的报告目录覆盖本次结果；不要把 `accept:p06` 的离线报告当作 `verify` 结果。

## 观察与检查

负责人逐项打开 `artifacts/acceptance/p06/runs/<run-id>/` 与 `reports/<run-id>/`，核对：

1. 入口先核验配置、清单、入口契约、包脚本、Node/npm、干净 commit 和前序资格，之后才出现步骤进程。
2. 步骤顺序为 prerequisites → scenario-close-loop → trusted-index → manual-gate；失败/超时后的步骤显示 `not_run`，不是 pass。
3. Todo 仓库包含预置脏文件、暂存修改、未跟踪文件和已知退出码 3；结果中这些事实仍在，恶意初始化哨兵未出现。
4. Profile、配置、失败基线、文档检索和受限增量均来自真实临时 Git/SQLite/Host；知识 manifest 固定摘要，未绑定 `global.md` 或隐式 `AGENTS.md`。
5. FakeRuntime 只修改 `todo/inbox.txt`；第二仓库、原有脏状态、文档和任务状态的变化符合报告。Runtime completed 不替代 Task/Feature passed。
6. 已选 Skill 和本地 stdio Fake MCP 可见；未选资源、默认扫描、未授权工具和跨项目读取不可用；远程 HTTP/SSE 明确 unsupported。
7. 负例包含非零退出、超时、取消、输入身份变化、资源竞争和报告写入失败，每项有实际结果/副作用快照。
8. `report.json` 的 identity、checklistDigest、commands、files 和每个证据引用可以重算；`summary.md` 与报告一致。产品报告是本次 run 的真实 Core/Host 查询封套，状态为 queued 或实际记录状态，不冒充模型完成。
9. 运行结束后自有进程已核验停止，临时资源已移除；停止不确定时应保留现场并判失败。用户仓库、其他 run、历史报告和受管元数据没有被入口清理。
10. 报告中的 live、manual、full regression 和其他 not_run/known gap 原样保留。

## 证据记录

- 入口结果：`runs/<run-id>/entry-result.json`
- 输入与范围：`runs/<run-id>/inputs.json`
- 步骤日志：`runs/<run-id>/step-run/`
- 场景证据：`runs/<run-id>/source/`
- 阶段报告：`reports/<run-id>/report.json`、`summary.md`
- 独立测试日志：`verifications/F-008/runtime-logs/`
- 定向选择：`verifications/F-008/test-selection.json`

## 退出码与签署

离线演示的预期事实是：十项离线检查可以 pass，但 live 和人工项为 `not_run`，因此阶段总退出码仍为 1。只有独立 live runner 和负责人确认按相同身份封套写入、且 `verify` 结果独立满足门槛时，负责人才能填写签署决定。负责人签署不由入口、测试、模型或 `nezha task report` 自动生成。

- `accept:p06` 退出码：待填写。
- `verify` 退出码：待填写。
- live：`not_run` / 由负责人填写实际证据路径。
- manual：`pending` / 由负责人填写姓名、时间和决定。
- owner decision：`pending`。
- phase accepted：`false`，除非负责人完成独立门禁并按项目流程签署。

已知缺口：默认入口不调用真实模型；远程 MCP、Chat、OpenViking/向量库和强 OS 沙箱未验收；全仓历史回归默认不运行；前序 Feature 的最终资格、live 和人工确认必须由负责人独立核对。成功退出码只描述本次命令和报告，不改变 Phase/Feature/Task 受管状态。
