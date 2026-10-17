# P03-8 F-003：受控 Git 提交执行器

入口：`application/controlled-git-commit.ts`、`ports/controlled-git-commit.ts`、
`adapters/fs/git-commit-driver.ts`。公共 Core 入口只导出契约与应用服务，
不导入进程/SQLite 适配器，无新增依赖或迁移。

## 可信装配与边界

- `commit({projectId, operationId})` 不接收 argv、环境、路径、Git 身份或审批布尔值。
  `readAuthorization` 是**可信 Core 装配端口**，不是 Host/Runtime payload：每次调用
  必须从当前权威状态重读验证、审批、提交权限、政策及 owner/executionVersion，
  缺失/失效/未执行证据均不得返回 `true`。授权含 F-001 确认身份、F-002 意图字段、
  WorkspaceBaseline、现有 WorkResourceIdentity 和明确的证据内文件清单。
- 本项实现确定性提交执行，不实现 F-005 最终门禁、F-006 Feature 人审、
  F-007 最终完成编排或 F-008 Host 命令。上述入口后续接入本服务；本项没有给
  生产 Host 注册一个使用伪造审批的默认执行器，也没有提前把 Feature/Run 标成完成。
- 资源使用既有 `WorkResourceAccess.read` / `WorkResourceStopVerifier`：必须持有
  global → project Work → 规范 workspace 三个有效占用，匹配 owner/host/version，
  且旧写进程停止证据有效；停止核验期间出现新 invocation/process 也拒绝。
  Feature 最终提交的 `intent.attemptId` 可以为 null，但仍需携带承载当前占用的
  WorkResourceIdentity；**本服务既不重新认领，也不释放这些占用**。
- 装配 `transact` 必须使用操作存储所在 session 的同步 `transactWrite`。
  当前授权重读、意图登记/终态回执和 F-002 事件在同一个写事务内；事务不等待 Git。
- `confirmProcessIdentity` 由 Core 提供且须持久化进程身份再返回，复用既有受监督
  CommandProcessPort；进程身份确认返回后、真正释放进程前再次检查当前授权。
  此处 Git 命令身份的 journal 不应覆盖旧 Runtime 的 Work processIdentity。
- `excludedPaths` 为可信装配明确列出的工作区内 Core 数据/Artifact 目录；默认额外
  排除 `.shiploop`，不能来自 Planner。所有外部路径先经受控 WorkspaceInspector
  核验 realpath、仓库 common dir、绑定、登记、分支与基线；本服务再与意图比对。

## 执行与证据

1. 拒绝 pending operation 重放（`reconciliation_required`）；终态重放返回历史事实前
   重读当前授权及原意图，新增人工阻塞或旧身份不能借重放绕过。查询历史事实仍使用
   F-002 只读存储，不以历史成功作为新的交付授权。
2. 旧 Runtime 停止确认后取得现有 common-dir claim（`shiploop-baseline.claim`），
   与 baseline / Work 共用同一实现和规范资源键；不同 linked worktree 竞争也拒绝。
3. 扫描现场，核对 expected HEAD 与 `verificationCodeIdentity` 的原验证摘要。
   只允许清单中的精确文件，不接受目录、路径穿越、`.git` 或 Core 制品。
   他人的已暂存成果不清空、不夹带；未交付的 tracked/untracked 源码阻止成功及
   `no_change`，仅明确排除的数据目录可以保留未暂存。
4. `git add -A -- <literal paths>` 覆盖修改、新文件、删除、配置和执行位；已暂存
   的删除保持原状。分批 argv 遵守既有进程协议的 256 参数上限。检查暂存 blob 的
   SHA-256 和模式与验证现场一致，clean filter 改写内容时拒绝并保留现场。
5. 固定 `write-tree`，通过 F-002 持久化不可变 pending 意图；重新读取意图并在
   最后一次源码/HEAD/index 核对后才执行 commit。实际消息由公共纯函数
   `gitOperationCommitMessage` 从原消息生成，追加 `ShipLoop-Operation: <operationId>`，
   F-004 核对消息时须复用该函数，不能只按 tree 相同认领提交。
6. Git 退出码不是成功证据：实际 HEAD、唯一 parent、tree、index、消息、author/
   committer 和源码均须一致。保留真实 hook（包括配置的 hooksPath）；hook 改暂存、
   只改工作区或退出失败都记录失败，保留实际 commit/tree、退出码及用户成果。
7. 事务内最后重读当前授权和占用。提交已合法发生但人审/owner/version 晚变，保存
   failed 操作与实际 Git 事实，不放行 Task/Feature；不改任务通过状态或解除人工阻塞。

原验证摘要包含 tracked/untracked 分类，add/commit 自然改变分类。因此意图始终
保存**原 Verifier 摘要**；前后额外用 `gitCommitSourceDigest` 比较所有实际存在文件的
路径/内容/模式（含未提交的 Core/ignored 文件），不因分类变化误判，也不把它伪造为
新的验证通过证据。实际 commit tree 还独立与固定的候选 tree 核对。

`no_change` 仅在候选 tree 等于真实原 HEAD tree 且上述核对全部通过时返回：保留
原 HEAD/tree，不调用 commit，不制造退出码 0 或空提交，exitCode/durationMs 为 null。

## 失败与恢复交接

- 源码/HEAD 漂移等执行前冲突抛结构化 `StorageError`，供外层暂停核对；不运行
  commit/reset/stash 或覆盖用户文件。若已暂存则保留，不擅自恢复用户 index。
- commit 启动后的停止未知、扫描失败或 DB 回执失败：保留 pending 意图、工作区
  占用及 common-dir claim；不能自动再 commit 或按超时抢锁。F-004 需确认已记录
  进程停止、按 parent/tree/消息/operation 核对，并使用同 owner 的显式恢复释放。
- 已明确观察的 hook 失败/证据失效：保存 failed 回执及实际 Git 事实后释放短 Git
  claim，但仍不释放 Work 占用。历史验证结果不删除，failed receipt 不满足交付。
- Core 锁仅协调受控执行者，不隔离外部编辑器/Git 或同用户恶意进程。最后一次读取
  与进程执行之间仍存在外部 TOCTOU；通过前后核对保守拒绝，不承诺强 OS 隔离。

## 有界进程与测试

固定 `/usr/bin/git`，独立 argv、stdin 消息、最小环境，不继承 HOME/GIT_DIR/
GIT_INDEX_FILE/凭据；关闭系统/全局配置与签名交互，但不禁用 hooks。每命令最多
30 秒、1 MiB 输出，driver session 总 120 秒/4 MiB/1100 次调用；超过上限 fail-closed。
沿用 WorkspaceInspector 自身的文件/字节/扫描上限。允许路径最多 512 项/32 KiB；
大项目超过界限需明确调整可信实现，不能截断证据声称通过。

- `test/p03-8-f003-controlled-git-commit.test.ts`：31 个用例，真实临时 Git、真实
  SQLite 操作存储和受监督进程；动态测试 authority/Work snapshot 为确定性替身，
  不冒充尚未交付的 Feature 门禁/人审生产装配。
- `test/p03-8-f003-git-commit-driver.test.ts`：6 个端口边界用例，覆盖 argv/环境、
  身份确认后权限变化、停止未知、超时、缺输出、错误 OID 与参数分批。

本任务仅局部测试；受影响回归清单交 Nezha，Feature 全量/类型检查/构建仍须独立执行。
