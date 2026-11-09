# P06-3 / F-007 资源选择跨层集成交接

## 交付范围

本 Task 新增真实临时资源的跨层场景，代码提交为：

- `776021380799f1b413cc86dadeb3988cf20a61b5`：`F-007: 补齐项目资源跨层集成场景`
- `737d15ad3566c071753e3b3da02cd1b2ab8164da`：`F-007: 登记资源安全回归范围`

生产 Core/Host/CLI 代码没有修改。新增测试位于
`test/modules/host/p06-3-f007-resource-integration.test.ts`，Task 回归索引位于
`test/index/phases/P06/features/P06-3/tasks/F-007.json`。

## 新增真实场景

1. 在临时数据根和临时项目目录中启动真实 loopback Host，登记 owner 批准的 manifest，经过 HostClient 完成候选发现、预览、导入和获准清单查询。相同候选的重复导入保持单条授权事实。
2. 从真实 SQLite 配置生成 Attempt 资源选择、load plan、WorkAccess 配置和加载 manifest。SDK loader 使用 `noSkills/noExtensions/noPromptTemplates/noThemes/noContextFiles` 与显式 `additionalSkillPaths`，只加载批准的 Skill；临时全局 Skill 不进入加载结果。撤销后新快照资源为空，撤销前的旧选择摘要保持不变。
3. 通过真实 SQLite 触发器注入审计写入失败，核对导入失败后 revision 和 resources 都没有半条记录；随后以同一 revision 并发导入，核对一个 `completed`、一个持久 `rejected/conflict` 回执，配置表只保留一条授权事实。
4. 通过受限 Work 夹具验证 `task.read` 和 `evidence.submit`，恶意操作、路径/SQL 字段、跨项目 scope 以及当前 binding 冒充 owner 均拒绝且 SQLite 快照不变。另通过受限 Host 查询通道验证项目内 knowledge search 成功、跨项目查询拒绝。

候选内容仍按非可信数据处理；测试没有把 Skill 文本中的提示或工具名当作授权。远程 MCP、真实模型、OpenViking 和真实 provider 认证没有在本 Task 中调用。

## 实际验证

Node `22.19.0`、npm `10.9.3`，目标仓库当前受测提交为 `737d15ad3566c071753e3b3da02cd1b2ab8164da`。完整日志和退出码旁文件位于 Harness 工作区的 `verifications/F-007/runtime-logs/` 与 `tool-logs/`：

| 检查 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 新增跨层测试 | `/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir ... -- node scripts/run-tests.ts test/modules/host/p06-3-f007-resource-integration.test.ts` | exit 0；1 文件、3 tests 通过 | `runtime-logs/test-o7sdz0c1.log`、`f007-green-final.exitcode` |
| 类型检查 | `npm run typecheck` | exit 0 | `tool-logs/f007-typecheck-2.log`、`f007-typecheck-2.log.exitcode` |
| 构建和产物冒烟 | `npm run build` | exit 0 | `tool-logs/f007-build.log`、`f007-build.log.exitcode` |

首轮 RED 和修正记录也保留在 `runtime-logs/test-2zv7uyh6.log`、`runtime-logs/test-rd0r0emi.log`；它们不是通过证据。最终测试运行后已执行 `git diff --check`，选择清单中的 10 个测试文件均已核对存在。

`verifications/F-007/test-selection.json` 按 schema v2 登记新增场景、P06-3 资源/授权回归、P04 Work 通道和 P06-2 knowledge 查询。Runtime 本地只执行新增跨层文件；其余 9 个登记文件交由 Nezha 独立 affected 回归执行，不能按本地 3 项通过折算为已运行。

## 可信项目模式限制

来源登记是 owner 管理入口，普通 Work 只使用已签发的受限通道和项目范围。项目选择关闭全局目录、项目目录自动扫描和 SDK 默认扫描；资源 digest、来源 revision、身份、版本、能力和 transport 在导入与新 Attempt 边界复核。

可信项目模式依赖同一用户的本机文件访问权限，不是强 OS 沙箱。测试没有声称能够阻止同一操作系统用户绕过 Host/Core 直接读取 owner 文件或启动任意 shell。凭据只保留引用；本次测试和证据没有使用真实密钥、远程 MCP 或真实模型。

## 未运行项

全仓 `npm test`、`npm run verify`、P06 Phase 验收、Feature task-union、真实模型/provider、远程 MCP、OpenViking、live 验证和负责人签署均未运行。它们保持 `not_run`，由独立验收流程决定，不由本地聚焦测试替代。
