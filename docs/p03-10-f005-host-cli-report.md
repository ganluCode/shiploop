# F-005：授权 Host 与构建 CLI 的完整执行报告

复用 F-004 的 `QueryService.getFeatureReport` 和现有 Host 查询通道：

```text
GET /v1/features/:featureId/report?projectId=<uuid>
HostClient.getFeatureReport(projectId, featureId)
shiploop feature report <featureId> --project <uuid> [--data-root <abs>] [--json]
```

CLI 通过 HostClient 连接已发现的授权 Host，沿用凭据、握手、超时和错误信封；
自身不打开 SQLite。Host 在握手查询能力中公布 `features.report.get`。
报告体沿用 Core 的 `schemaVersion: 1 / scope: feature-execution-report`，
其版本与已有 delivery 查询信封的版本独立。未知数字版本返回
`unsupported_schema_version`，嵌套未知键、非法类型、重复身份、归属或历史计数
不一致返回 `response_malformed`。校验复用 delivery、Work Session、verification、
Git 及 recovery 的既有公共协议检查。

## 完整性和有界读取

报告在一次响应中原子返回，上限为 UTF-8 JSON **16 MiB**；Host 发送与 HostClient
接收使用同一上限。普通查询的 64 KiB 上限保持不变。Core 在单一一致读事务中
排空各历史 keyset 分页，Host/CLI 保留全部数组、字段、null、issues 和 partial。
超过 16 MiB 时整次查询返回 `internal`，受控 reason 为 `response_budget_exceeded`；
不会输出截断报告，也不会退回最近两条历史。这个版本没有跨请求报告游标。

`--json` 输出既有成功信封 `{ok:true, command:"feature.report", result:<Core报告>}`，
`result` 与 Core 投影逐字段一致。文本输出包含 outcome、completeness、计数、issues
以及完整格式化报告。partial 表示历史或测量信息不完整，与 Feature 是否成功独立。
缺失的历史 Session、缺元数据的 Artifact、未知 token/cache/cost 等保持原有语义。
CLI 设置 `process.exitCode`，等待 stdout/stderr 排空后退出，保证大于管道缓冲区的
JSON 在正式构建入口也能完整输出。

数据库事实沿用 F-004 的单事务快照及事件水位；事务后核验的正文绑定该快照的
不可变 hash/size。读取期间发生的新状态变更只能在下一次查询中出现。
查询不启动 Runtime、不续租、不改变 Task/Feature 结果、不解除人工阻塞、不自动审批。

## 身份与证据

Host 仅接受其可信装配的 principal；请求不能传入 principal、actor 或路径。
Core 再核验主体形状、`project.read`、项目可见性和 Feature 的项目归属。
缺能力或超出 allowlist 返回 `forbidden`；不可见/不存在 Feature 在可读取的项目内
统一返回 `not_found`。无效 bearer 在既有认证层拒绝；非法可信装配主体在 Host
返回脱敏 `internal`，Core 直接调用保留 TypeError 编程错误。

HostClient 进一步核验返回的 Feature、Attempt、verification、approval、operation
均属于请求范围。公共报告只包含稳定身份、摘要和证据引用，不包含内部制品路径、
worktree 路径或凭据。历史证据正文复用既有通道，例如：

```text
shiploop execution session-evidence <attempt-uuid> --project <uuid> --artifact <artifact-id> --json
```

证据必须属于目标项目和 Attempt；任意 Artifact ID 或路径均不能绕过成员校验。
报告引用不扩大该读取权限，也不保证每种引用都能作为 Session 正文读取。
错误沿用 `{ok:false, command, error:{code,message,details?}}` 和已有非零退出码。

## 验证交接

新增模块用例：

- `test/modules/host/p03-10-feature-report-contract.test.ts`：路由/参数、真实 Core/SQLite/HostClient
  的 130 次 Attempt、跨 Run 失败/取消/审批、证据正文、缺历史 Session/Artifact、可信身份、
  越权与越界拒绝、读取中更新状态、未知版本/字段/归属/计数/时间以及 16 MiB 拒绝。
- `test/modules/cli/p03-10-feature-report-built.test.ts`：运行 `npm run build`，通过正式
  `dist/bin.js` 子进程输出 130 次 Attempt 与 130 项审批；逐字段比较 Core、检查文本中的
  partial/issue、历史证据读取，以及授权/版本/格式/大小错误。数据库全表快照保持不变。

正式构建用例首次检测到了原 CLI 在管道 65,536 字节处退出截断 JSON 的问题；
保留 RED 与修复后日志。聚焦测试和静态检查的最终结果见任务 workspace 的
`progress.md` 与 `verifications/F-005/runtime-logs/`。
任务索引为 `test/index/phases/P03/features/P03-10/tasks/F-005.json`，
保留 P01/P02 授权、分页、握手、协议拒绝和 CLI 回归，由 Nezha 独立执行较广范围。
本地聚焦通过不代表完整 Feature 或 Phase 验收通过。
