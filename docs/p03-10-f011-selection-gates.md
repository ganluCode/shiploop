# P03-10 / F-011 可信局部测试选择、安全回退与全量门禁阶段负例

本任务增加真实 Node 多模块临时工作区夹具，验证当前 Attempt 的局部测试选择必须来自受信目标定义，并在候选过期、路径/文件/符号链接/参数不安全、多模块漏选或共享配置变化时回退到全量目标。夹具经真实 Node 子进程执行，记录选择理由、argv、cwd、有限 timeout、退出码、执行模块和结果制品；没有可信回退时保持 inconclusive。

## 验收映射

| 验收点 | 用例（`[case:...]`） | 核对内容 |
| --- | --- | --- |
| 授权局部目标与证据 | `authorized-multimodule-evidence` | 两个真实模块通过受信 target/revision 运行；读取 artifact 核对 target、模块集合、exitCode；记录 reason/argv/cwd/timeout，明确 `shell=false`。 |
| 安全候选解析与回退 | `unsafe-candidate-fallback` | 缺失目标、过期定义、文件不存在、越界、符号链接、参数注入、多模块漏选和 shared config digest 变化均执行完整安全目标；无猜测命令。 |
| 证据与基线门槛 | `no-trusted-fallback`、`negative-evidence-gates` | 零测试及无可信回退保持 inconclusive；零退出但缺 artifact、部分模块实际未执行、原有 baseline 失败、全量步骤失败都不能成为 passed。 |
| 门禁完整性 | `gate-definition-integrity` | 真实运行 test、仓库 `typescript` 的 `tsc`、build、integration 四个子进程，逐步记录状态/退出码/制品；删减门禁定义直接 error，后继步骤在前序失败时为 not_run。 |
| 非 Node 协议 | `non-node-protocol` | 通过真实 `python3` 子进程验证同一结构化 argv/cwd/timeout/evidence 协议，仅登记一个受信目标，不引入多语言 Profile 系统。 |

## 实现与范围

- `test/helpers/p03-10/verification-selection-fixture.ts` 构造临时多模块工作区、Node 选择执行器、四步全量门禁、Python 协议执行器；没有修改生产执行器或官方任务元数据。
- `test/modules/acceptance/p03-10-selection-gates.test.ts` 包含 6 个稳定 case ID；索引登记在 `test/index/phases/P03/features/P03-10/tasks/F-011.json`，Feature 索引同步登记。
- Harness 选择文件 `verifications/F-011/test-selection.json` 只引用仓库索引。

## 本地验证与证据

所有执行经 Nezha test-command wrapper，完整合并输出、schema sidecar 和退出码保存在 Feature workspace 的 `verifications/F-011/runtime-logs/`：

- `red-selection-gates.log`：exit 1，预期 RED，夹具模块尚未存在。
- `selection-gates-tsc.log`：exit 0，6 passed / 0 failed / 0 skipped；含真实 Node 多模块、负例、全量门禁和 Python 协议。
- `typecheck.log`：exit 0，`npm run typecheck`。

全量门禁正向用例实际执行四个夹具子进程并读回状态制品；类型步骤调用当前仓库的 `typescript` `tsc`。本地 Task 范围已通过，未将局部夹具结果宣称为整个 Feature 或 P03 阶段验收；Feature/Phase 最终全量门禁由 Nezha 按 DAG 规则独立执行。官方 `task_list.json`、`feature.yaml` 未修改，收尾只通过 `nezha task report F-011` 提交结果。
