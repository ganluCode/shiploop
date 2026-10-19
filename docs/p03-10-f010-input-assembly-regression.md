# P03-10 / F-010 输入装配历史增长与必需输入完整性确定性回归

本任务为已交付输入装配（P03-2 ExecutionInput prepare/ContextBuilder 与 P03-6 执行输入绑定）
增加确定性阶段回归：历史增长不膨胀与必需输入完整性。沿用前序输入装配测试夹具
（`test/modules/planning/p03-2-context-build.test.ts` 的 makeInput/makeBuilder 形态与
`test/helpers/p03-6/input-binding-fixture.ts` 的 openBindingFixture/expectRejection/
publishReadyArtifact），不新增知识平台、不调用模型、不修改生产代码。本回归只证明
T37「输入完整性与有界装配」，不宣称缓存命中或 Token 节省（token 估算恒为 estimation）。

## 验收映射

| 验收点 | 用例（`[case:...]`） | 核对内容 |
| --- | --- | --- |
| 同一 Task 小历史 vs 显著增长 progress/报告：固定指导不复制历史全文、动态内容走不可变引用/摘要；描述/acceptance/依赖结果始终可读 | `f010-history-small-vs-grown-readable`（p03-2-context-build.test.ts） | 固定指导常量原样位于历史段之前；60×2000 字 progress/报告摘要零全文内联（`FULL_BODY_MARK`/长正文标记缺失）；prompt ≤ maxPromptBytes 且与历史正文字节不成比例（<1/4）；snapshot.historyIndex 有界（entries≤maxHistoryEntries、omittedCount=3980、truncated=true），manifest `entries[1..20] of 4000` 与 truncated/omitted 两类省略标注齐全；两个规模下描述、`[1]/[2]` 全部 acceptance、`- task task-0: artifact art-dep-1` 依赖结果逐项可读；必需输入以 `sha256:<contentHash>` 引用提供、正文不内联；历史增长前后必需区逐字节一致、9 类固定来源 manifest 摘要不变；重复构建逐字节一致、tokenEstimate.kind=estimation。 |
| Attempt InputManifest、读取证据及输入摘要关联真实制品；改变源路径内容不改变既有快照 | `f010-input-manifest-evidence-digest-artifacts`、`f010-progress-report-growth-keeps-fixed-input`（p03-6-execution-input-binding.test.ts） | manifest 为同项目 ready 制品，文件字节哈希可复算；manifest.promptDigest 与实际 prompt 制品字节的域分离摘要逐字节绑定（`sha256(shiploop:context-input-prompt:v1\n+正文)`），required-input 来源 hash 与制品索引 content_hash 一致；读取证据为按 Attempt 关联的 `execution-input-read-evidence` 制品，逐项 contentHash/sizeBytes 可从真实文件复算；attempts.input_digest/input_ref 与冻结 snapshotDigest/快照制品一致；t-2（dependsOn t-1）准备制品组的依赖结果与 acceptance 在 snapshot/prompt/manifest 中可读。增长 progress/报告（300 行 progress + README 追加 + 20×20KB 报告制品）并改变源路径内容（`requirements/task-1.md`）后，三正文逐字节不变、增长标记零内联；受限读取返回固定正文而非源路径新内容（可变路径不是固定执行输入）。 |
| 必需输入缺失、损坏、受控路径越界及超出必需输入预算时启动被拒绝并给出明确原因，不静默截断 acceptance 或扩大读取权限 | `f010-required-input-missing-or-corrupt-rejected`、`f010-path-escape-and-permission-expansion-rejected`、`f010-required-input-budget-rejected`（绑定层）+ `f010-required-budget-structured-failure`（装配契约层） | 同长度篡改 → `input_corrupt`、制品缺失 → `input_missing`，拒绝证据按 Attempt 保留（outcome=rejected + 受控 reason），拒绝前后快照逐字节不变、acceptance 两条完整；cwd 根越界 → `cwd_root_unknown`、工作区符号链接越界 → `workspace_untrusted`、权限扩大 → `permission_expansion`、读取预算超出 → `limit_exceeded`，均零代码/工具副作用、零新增预留；装配契约层：必需输入清单缺席/acceptance 为空 → `missing_required_input`，引用数量超 `maxRequiredInputRefs` → `limit_exceeded`（limitName/measured/limit 齐全），prompt 预算不足 → `limit_exceeded` 且消息明确「不删减验收条目」。 |
| 只证明 T37；不调用模型、不宣称缓存命中或 Token 节省；沿用前序夹具、不新增知识平台 | 全部用例 | ContextBuilder 为纯函数（无 I/O/时钟/随机）；绑定链使用 Fake 策略配置但从不启动 Runtime/模型；无缓存、Token 节省或知识检索断言；夹具全部复用既有 helper，无新增夹具框架。 |

## 索引与选择

`test/index/phases/P03/features/P03-10/tasks/F-010.json` 登记 4 个文件（按文件显式 `all: true`，
7 个新用例带稳定 `[case:f010-*]` ID，文件内唯一）：

- `test/modules/planning/p03-2-context-build.test.ts`（含 2 个新用例；本地全量通过）。
- `test/modules/runtime/p03-6-execution-input-binding.test.ts`（含 5 个新用例；本地全量通过）。
- `test/modules/planning/p03-2-execution-input.test.ts`（受控采集/越界/损坏/预算负例回归；仅登记，未本地运行）。
- `test/modules/planning/p03-2-execution-input-prepare.test.ts`（准备层必需输入完整性回归；仅登记，未本地运行）。

Harness `verifications/F-010/test-selection.json` 只引用该仓库索引（`{"task_id":"F-010","index":...}`）。
后两个文件与两份文件中的既有用例属受影响回归，交 Nezha 独立执行；本地通过范围见下表。

## 本地验证与证据

所有执行经 `.dag_context.json` 的 Nezha test-command wrapper 保存完整合并输出、`.log.json`
与 `.log.exitcode`，位于 Feature workspace 的 `verifications/F-010/runtime-logs/`。

| 验证 | 日志 | 实际结果 |
| --- | --- | --- |
| planning 新用例（`-t f010`） | `test-7iydoezg.log` | exit 0；2 passed、56 skipped |
| binding 新用例（`-t f010`）首次 | `test-719tr8ww.log` | exit 1；依赖 Task 认领被 DAG 门控拒绝（not_ready），改为读取 t-2 准备制品组 |
| binding 新用例（`-t f010`）第二次 | `test-dojx9jf3.log` | exit 1；发现 manifest.promptDigest 是域分离摘要而非制品字节哈希，断言改为按实际 prompt 字节复算域摘要 |
| binding 新用例（`-t f010`）最终 | `test-6ohc0isg.log` | exit 0；5 passed、33 skipped |
| `test/modules/planning/p03-2-context-build.test.ts` 全量 | `test-kvbewphj.log` | exit 0；58 passed、0 failed |
| `test/modules/runtime/p03-6-execution-input-binding.test.ts` 全量 | `test-kcdmlu8r.log` | exit 0；38 passed、0 failed |
| `npm run typecheck` | `test-n4rcd7_t.log` | exit 0 |

新增用例为已交付行为的回归断言（TDD RED 不适用）；两轮中间失败均为测试自身假设修正
（见上表），保留日志未重跑读取输出。本地实际执行 2 个文件 96 个用例；索引中另外 2 个
回归文件仅登记交 Nezha。未运行全仓测试、组合门禁或 Phase 验收。Fake 策略、局部通过和
此索引均不表示真实 Pi/LLM、缓存/Token 收益或 P03 阶段验收通过。
