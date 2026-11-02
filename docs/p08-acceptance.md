# P08 一期总验收契约说明

版本：0.2（对应 PRD `input/shiploop-v1/p08-release-acceptance/features/p08-acceptance.md`）。
本文冻结 P08 总验收（P08-4）的配置、检查清单与证据契约，供 `npm run accept:p08`
（P08-4 后续 Task 交付）与负责人核对使用；机器可读契约见：

- `acceptance/p08.checklist.json` — 冻结检查清单（六层次、三态、必需事实类别）；
- `acceptance/p08.config.json` — 验收配置（工具链、预算、live/运行身份/Nezha 边界政策）；
- `acceptance/p08.entry.json` — 正式入口契约（固定步骤顺序、默认执行与显式选项）。

校验入口：`scripts/acceptance/p08-config.ts`（fail-closed，结构/唯一性/允许值漂移一律拒绝）。

## 1. 验证层次与三态

清单逐项表达六个验证层次，每个层次都必须被必需检查覆盖：

| 层次 | 含义 |
| --- | --- |
| `code-delivery` | 前序 P08-1～P08-3 代码交付与交付报告前置输入 |
| `task-local` | Task 局部验证（实际命令/退出码/证据路径） |
| `feature-gate` | Feature 门禁（去重 Task 索引）结果作为阶段输入 |
| `phase-integration` | Phase 集成：确定性回归、安装检查、两类项目闭环复跑 |
| `live` | Todo 新项目与存量项目真实模型 live 证据 |
| `manual` | 负责人 macOS 操作与一期放行签署 |

结果只有 `pass` / `fail` / `not_run` 三态。**not_run 不折算通过**：缺失结果、
真实模型缺失、负责人未确认或跨层检查未运行一律保持 `not_run`，不把缺失输入
默认为通过；人工 pending/rejected 不能由机器代签；deferred 项不参与通过计数。

## 2. 运行身份与运行目录

每次 P08 运行固定身份：`runId`、受测 `commit`、输入摘要（`inputsDigest`）与
工具链（Node 22.19.0 / npm 10.9.3 / darwin）。报告与全部证据引用必须绑定同一
身份，身份漂移 fail-closed。运行目录按 `runId` 一次性预留
（`create-once`）：已存在的运行目录不可被覆盖，保留旧运行并失败退出。

## 3. 前置输入与两类 live 分开核对

- P08-1：交付报告 `docs/acceptance/p08-1-delivery-report.md` + 发布清单
  `acceptance/p08-1.release-manifest.json`；
- P08-2：live 入口文档 `docs/p08-2-live-acceptance-entry.md` + Todo live 证据
  （`shiploop.todo.live-evidence`，由 `npm run accept:p08:live` 生成）；
- P08-3：演示报告模板与运行手册（`docs/acceptance/p08-3-demo-report-template.md`、
  `docs/acceptance/p08-3-existing-demo-runbook.md`）+ 存量证据封套
  （`shiploop.brownfield.evidence-envelope`）。

交付缺失、报告缺失、commit 非法或非受测 HEAD 祖先时输出 blocked/not_run，
不以占位实现或补库放行。Todo live 与存量 live **分别核对、互不替代**；
默认 `accept:p08` 入口不调用真实模型（live 证据 import-only），真实模型须
负责人经独立 `accept:p08:live` 入口授权与预算。

## 4. Nezha 边界与发布纪律

Nezha 只作为开发编排工具，不是 ShipLoop 产品运行时依赖。P08 报告不得把
Harness 状态、测试数量或成功日志文字当作产品通过依据；通过判定只来自持久
状态与可观察事实证据。本 Feature 不自动 npm 发布、不 push、不修改 Phase
状态；人工批准一期验收后才安排正式发布（后置能力单列，不混入一期验收）。

## 5. 本 Task（F-001）边界

本契约与校验只覆盖结构、唯一性与允许值；真实安装、SQLite、Git、Host、受控
进程与跨层故障事实由 P08-4 后续 Task（身份校验、范围计划、证据导入、安装
检查、正式入口与 Phase 集成场景）在真实临时资源上交付，缺失时保持 not_run。
