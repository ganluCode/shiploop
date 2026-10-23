# P04 人工验收：在代码仓库怎么操作

本清单把机器已测的部分与负责人必须亲自确认的部分分开。**不要编辑 SQLite、
feature.yaml、task_list.json 或任何 passes/status 字段来“通过验收”。**

## 1. 打开正确目录

```bash
cd /Users/ganlu/Documents/my-dev/code/mygit/AI/shiploop
nvm use 22.19.0
git branch --show-current
git rev-parse HEAD
export P04_DIR=/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/state/acceptance/p04-owner-20261023
```

分支应为 `acceptance/p04`。使用 npm，不是 pnpm。不要为了核对结果重新运行
全仓测试或真实模型；下面的验证命令是只读的，不调用 LLM。

## 2. 核验证据包没有坏

```bash
node scripts/acceptance/p04-closeout.ts --verify "$P04_DIR"
```

应看到 `evidenceVerified: true`、`machineAssertionsPassed: true`。工具逐项核对文件
字节数、SHA-256、受测提交、真实 Vitest 用例结果，而不是只检查某条命令退出 0。

`phaseAccepted: false` **不是程序又出错**：此工具只核验补充离线证据，不代签人工
确认、不把 SDK 探针当成完整业务验收。若命令非零，先反馈原输出，不要删除或改报告。

## 3. 看清实际覆盖和缺口

```bash
cat "$P04_DIR/handoff.md"
```

重点看四件事：受测提交、机器通过项、真实模型验证结果、尚未完成/明确后置项。
以下概念不能混淆：

| 看到的结果 | 意味着什么 |
| --- | --- |
| 离线 15 项用例绑定通过 | 故障矩阵、局部测试、停止/恢复及 P04-9 六项有实际断言结果；不是 15 项付费模型测试 |
| SDK change 探针通过 | 真实模型能用受限工具改临时文件，独立检查通过后仅在临时库提交 |
| 真实取消已确认停止 | 当前 Runner/同步工具已停止；取消时未知用量不伪造成 0 |
| Core Attempt 为 verifying | Runtime 已结束，等待业务验证；不等于 Task passed 或 Feature completed |

历史全仓工程门禁、170 文件集成回归和本次补充包各自绑定实际提交；跨提交只能按
受影响范围解释，不能把它们拼成“一次完整同 SHA 的 Phase 入口成功”。

## 4. 亲眼看真实 Core 数据

仅在 handoff.md 明确给出 `core-live/core.sqlite` 时执行；若该验证失败或未产出，
应先修复，不要创建空文件冒充。

```bash
sqlite3 -readonly "$P04_DIR/core-live/core.sqlite" 'PRAGMA integrity_check;'
sqlite3 -readonly -header -column "$P04_DIR/core-live/core.sqlite" \
  'SELECT id,status FROM runs; SELECT id,status FROM tasks; SELECT id,status FROM attempts; SELECT id,status FROM sessions;'
sqlite3 -readonly -header -column "$P04_DIR/core-live/core.sqlite" \
  'SELECT id,state,reason FROM run_dispatch_claims; SELECT id,state,reason FROM execution_slot_claims;'
```

第一条应返回 `ok`。后两条用于观察：一个真实 Attempt/Session；Session 是否停止；
Task 有没有被模型回复直接标通过；占槽如果未释放，是否有与当前验证阶段一致的原因。
具体预期以同一证据包的 handoff.md 为准，不要求所有行一律 completed/released。

Navicat 打开的是**现有 SQLite 文件**，用户名/密码留空；数据库路径选上面的完整
`core.sqlite`。验收包内快照只用于只读检查，不连接为正在运行的 Host 数据目录。

## 5. 看模型实际改了什么

根据 handoff.md 中给出的受管工作区路径，打开 `shiploop-live-proof.txt`。应只有一行：

```text
shiploop live ok
```

这证明模型在受管 Feature 工作区写入了指定文件，而不是修改真实开发仓库。
同步检查真实 SDK 的 `report.json` 和 Core 的 `result.json`：厂商/模型应是
`ark-agentplan/ark-code-latest`，最多 3 请求/场景、无备用模型、无 push。
所有临时数据保留供核对，不需要你重跑付费验证。

## 6. 最后你需要确认什么

- [ ] 上面的只读核验通过，文件实际可读，结果与 handoff.md 一致。
- [ ] 接受首版仅 macOS 可信项目模式，不是强 OS 沙箱。
- [ ] 接受生产并发固定 1；>1 应明确拒绝，Feature 并发留给 P05。
- [ ] 接受标准 Pi 原生历史不等于 checkpoint；未验证的 required resume 明确拒绝。
- [ ] 知道 Chat、桌面、Pi Durable 生产引擎和强沙箱不在本次交付内。
- [ ] 核对 handoff.md 的未完成项；有机器/业务缺口时，不签署“P04 全部通过”。

然后把结果直接回复当前对话，例如：

```text
我已按 P04-owner 清单完成只读检查，受测 SHA 为……。
上述首版边界接受/不接受。发现的问题是……。
```

**只有完整工程/集成、所需真实业务证据和负责人确认三者齐全时**，再明确回复
“P04 验收通过，允许进入 P05”。单独接受设计限制不等于替未执行的场景签字。
负责人姓名、确认时间、最终 SHA、证据位置和结论届时记录；当前一律 pending。

## 原始契约

冻结的阶段要求仍见 [P04 阶段验收契约](../p04-acceptance.md) 和
[完整人工清单](../p04-8-f010-manual-checklist.md)。本说明不删减必需检查，也不改写历史失败。
