# P05 macOS 人工验收操作清单

本清单只记录人工事实，不能由模型、Task 状态或机器全绿代签。报告目录应位于受测仓库之外的临时目录；报告不包含凭据，不填写 API key、Token、Cookie、认证文件内容或开发机绝对路径。

## 1. 受测快照与环境

- [ ] 负责人记录操作人、UTC 时间、结论和报告 ID。
- [ ] 在受测仓库执行 `git branch --show-current`、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}` 和 `git status --porcelain`，记录完整 commit SHA、tree SHA 和干净状态。
- [ ] 核对 `node --version`、`npm --version`、`npm ci` 使用的 `package-lock.json` 摘要；报告只写版本和摘要，不写路径。
- [ ] 确认 macOS、Node/npm 和锁文件符合 `acceptance/p05.config.json`，不把其他平台结果折算为本阶段通过。

## 2. 默认离线阶段入口

- [ ] 运行 P05 入口的离线模式，使用临时 SQLite、Git、数据根和 home；确认网络关闭、FakeRuntime/脚本化 Runtime 和真实模型请求数为零。
- [ ] 记录每个 I01～I09 的实际命令、cwd 的仓库相对标识、开始/结束时间、退出码、状态、证据引用和用量来源。
- [ ] 确认可信索引按 P05-1～P05-9 去重，空索引、越界路径、缺失 Feature 声明、SHA/输入摘要不匹配和证据写入失败均 fail-closed。
- [ ] 查看 `runs/<run_id>/test-scope.json`：selected 包含全部 P05 文件和登记的底层回归，deferred 逐项记录后置历史测试及原因；后置不算通过。默认总预算 20 分钟。
- [ ] 查看阶段报告的 `productReports` 引用及相应 JSON：封套身份与本次运行一致，内容来自临时项目真实 Core/Host 查询。queued 快照仅验证报告链路，不能记为真实 Runtime 任务完成。
- [ ] 核对 A/B/C、资源锁、迟到结果、Git 冲突/修复、叶子汇总和追加 Batch 的 SQLite、Git、文件与进程事实；不能用模型输出或分支 HEAD 漂移代替固定成果证据。

## 3. macOS 临时项目与代表性场景

每次人工验收先创建一个新的临时项目和报告根，项目、SQLite、Git/worktree、数据根、home、进程和报告分别归属于本次 `run_id`。示例命令只使用仓库外的临时目录，不把本机路径写进报告：

```sh
REPORT_ROOT="$(mktemp -d)"
PROJECT_ROOT="$(mktemp -d)"
cd "$PROJECT_ROOT"
git init -q
```

- [ ] 规划 A、B、C 三个 Feature：A/B 依赖同一固定基线但保留独立 worktree 和成果 SHA；C 在两个成果、集成计划和组合验证证据形成前保持 `blocked`/`pending`。
- [ ] 先在批准并发和执行槽位允许的条件下运行不同资源的 A/B，再用同一迁移、契约或项目资源制造资源竞争；用持久租约、owner/version 和可观察屏障记录串行等待，不能只看日志。
- [ ] 在临时 Git 中记录固定目标基线和合并顺序；制造 Git 冲突后保留冲突现场，核对修复失败、预算耗尽或取消时的工作区、operation 回执和后继阻塞。禁止选择 ours/theirs、强推或删除现场来伪造成功。
- [ ] 对重复派发、进程遗留、租约到期、重启、迟到结果和未确认停止逐项核对 SQLite、Git/worktree、进程树及资源归属；旧 owner 不得释放新 owner 的资源。
- [ ] 清理前导出报告、步骤日志、SQLite/Git/进程和 cleanup manifest；正常停止才记录 `cleanup=confirmed`，停止不确定、修复失败或预算耗尽时保留现场并记录 `uncertain`/`failed`。

## 4. 可选 live GitAgent


- [ ] 只有负责人单独批准后才填写 live 输入：临时 Git、provider/model、认证来源名称、请求次数/预算、写入范围和过期时间。
- [ ] 未批准、认证缺失或证据缺失时记录 `not_run`/`zero-call`，不发请求，也不以离线 Fake 结果替代。
- [ ] 已批准时记录真实请求数、工具副作用、退出码、usage 来源、停止/清理事实和完整 SHA；报告不得包含凭据。

## 5. 显式全仓回归

- [ ] 只有负责人明确选择 `--full-regression` 时才运行全仓历史回归；默认阶段入口不得隐式执行 `npm test`。
- [ ] 未选择时将该项记录为 `not_run`，不能写成 pass；选择后记录命令、退出码、耗时、受测 SHA 和证据摘要。

## 6. 清理与签署

- [ ] 阶段结束后核对本次运行创建的临时 Git、SQLite、文件和进程均已清理；停止不确定时保留现场并记录 `cleanup=uncertain`，不得释放业务占用或标记 `processesGone=true`。
- [ ] 报告重新读取并确认没有凭据、绝对路径、未绑定 SHA 的成功结果、重复 run ID 或被覆盖的既有成功证据。
- [ ] 记录每个未执行项及原因，包括 live、manual、全仓回归和任何资源/清理阻塞。
- [ ] 负责人签署完整 SHA、报告摘要、结论和时间。负责人 `pending/rejected` 时阶段结论保持 `fail`，机器通过不能放行。

人工记录字段模板：

```text
operator: <负责人标识>
recorded_at_utc: <UTC 时间>
run_id: <稳定运行 ID>
tested_commit: <完整 SHA>
mode: offline | live | manual | not_run
commands: <实际命令及参数，去除凭据和本机绝对路径>
exit_codes: <逐项退出码>
usage_sources: runtime-usage | command-output | manual-record | not_run
cleanup: confirmed | failed | uncertain
unexecuted: <项目和原因>
owner_decision: pending | rejected | confirmed
owner_signature: <负责人明确确认>
```
