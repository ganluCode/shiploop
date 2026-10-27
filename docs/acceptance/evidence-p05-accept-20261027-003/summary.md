# P05 阶段验收摘要 — 未通过

- 报告分层：阶段验收报告（本文件，phase-acceptance）与产品 Feature 执行报告（feature-execution-report）分开记录；本摘要不复述产品报告正文。
- 运行 ID：`p05-accept-20261027-003`
- 生成时间（UTC）：2026-10-27T06:23:57.454Z
- 报告 Schema 版本：1
- 输入计划：P05 阶段验收契约与执行报告（2026-10-23-18-55-21_shiploop-p05-feature / p05-acceptance，版本 1.0）
- 范围：FR-1/FR-2/FR-3/FR-4 及 P05-1～P05-9 的离线、live、人工和显式全仓回归开关
- 校验清单摘要：plan=deb0f36e824cd3e9872d8b494f799e31dd4b0d66501270c753de877cdef2026c · checklist=2096d41b97f3a83baece5032cbabdbd36122272d79490587ccc6f779638d387f · 契约 docs/p05-acceptance.md
- 受测 commit：`245fa62f5fc36e22d510dd98fe9c61aeb2a58b03`（工作树 clean，分支 acceptance/p05）
- 前序基线：2026-10-23-18-55-21_shiploop-p05-feature @ `245fa62f5fc36e22d510dd98fe9c61aeb2a58b03`（acceptance/p05）
- 平台：darwin 25.6.0 / arm64
- 工具版本：Node v22.19.0 · npm 10.9.3 · git version 2.50.1 (Apple Git-155) · SQLite 3.51.0 2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl (64-bit) · better-sqlite3 13.0.3 · drizzle-orm unknown
- 执行身份：fake-provider / fake-model（realModel=false，network=denied）
- 总体结论：**fail**（pass 12 / fail 0 / not_run 3，必需检查共 15 项）

## 阶段检查结果（按检查清单分层记录）

| 检查 ID | 层 | FR | T 编号 | 状态 | 真实断言/副作用 | 证据数 |
|---|---|---|---|---|---|---|
| P05-FR1-OFFLINE-CLOSURE | phase-acceptance | FR-1 | FR-1,AC-1,AC-3 | pass | 57/57；副作用 ok | 12 |
| P05-FR2-CONCURRENCY-INTEGRATION | phase-acceptance | FR-2 | FR-2,AC-1,AC-3 | pass | 33/33；副作用 ok | 11 |
| P05-FR3-FAULT-RECOVERY | phase-acceptance | FR-3 | FR-3,AC-1,AC-3 | pass | 21/21；副作用 ok | 11 |
| P05-FR4-REPORT-MANUAL-GATE | phase-acceptance | FR-4 | FR-4,AC-2,AC-4 | not_run (skipped) | 0/0；副作用 unknown | 3 |
| P05-I01-PLANNING-APPROVAL | feature-integration | FR-1,FR-2 | I01,P05-1,P05-2,P05-3 | pass | 8/8；副作用 ok | 10 |
| P05-I02-AB-CONVERGENCE | feature-integration | FR-2 | I02,P05-4,P05-6,P05-7 | pass | 8/8；副作用 ok | 10 |
| P05-I03-RESOURCE-MUTEX | feature-integration | FR-2,FR-3 | I03,P05-4,P05-5 | pass | 8/8；副作用 ok | 10 |
| P05-I04-RECOVERY-FENCING | feature-integration | FR-3 | I04,P05-4,P05-5,P05-7 | pass | 8/8；副作用 ok | 10 |
| P05-I05-GIT-INTEGRATION | feature-integration | FR-2,FR-3 | I05,P05-6,P05-7 | pass | 9/9；副作用 ok | 11 |
| P05-I06-BOUNDED-REPAIR | feature-integration | FR-3 | I06,P05-8 | pass | 9/9；副作用 ok | 11 |
| P05-I07-LEAF-DELIVERY | feature-integration | FR-2,FR-4 | I07,P05-9 | pass | 9/9；副作用 ok | 11 |
| P05-I08-APPEND-BATCH | feature-integration | FR-2 | I08,P05-2,P05-3,P05-9 | pass | 7/7；副作用 ok | 9 |
| P05-I09-INPUT-BUDGET-INTEGRITY | phase-acceptance | FR-1,FR-3,FR-4 | I09,P05-10 | pass | 9/9；副作用 ok | 12 |
| P05-LIVE-GIT-AGENT-AUTH | phase-acceptance | FR-3 | FR-3,I06,P05-8 | not_run (skipped) | 0/0；副作用 unknown | 1 |
| P05-MANUAL-OWNER-GATE | phase-acceptance | FR-4 | FR-4,AC-2,AC-4 | not_run (skipped) | 0/0；副作用 unknown | 3 |

## 命令记录

| 命令 | argv | cwd（逻辑） | 退出码 | 耗时（ms） |
|---|---|---|---|---|
| p05-trusted-index | `<node> scripts/run-tests.ts test/modules/authorization/authorization-contract.test.ts test/modules/cli/p05-9-batch-delivery-cli.test.ts test/modules/commands/command-receipts-store.test.ts test/modules/commands/commands-contract.test.ts test/modules/delivery/p03-8-f004-git-commit-reconciliation.test.ts test/modules/delivery/p05-6-f001-integration-plan.test.ts test/modules/delivery/p05-6-f002-integration-plan-store.test.ts test/modules/delivery/p05-6-f003-integration-plan-generation.test.ts test/modules/delivery/p05-6-f004-integration-plan-control.test.ts test/modules/delivery/p05-6-f005-integration-plan-query.test.ts test/modules/delivery/p05-6-f005-integration-plan-sqlite-query.test.ts test/modules/delivery/p05-6-f006-integration-assembly.test.ts test/modules/delivery/p05-7-f001-integration-execution-plan.test.ts test/modules/delivery/p05-7-f002-git-operation-persistence.test.ts test/modules/delivery/p05-7-f003-integration-git-workspace.test.ts test/modules/delivery/p05-7-f004-deterministic-integration.test.ts test/modules/delivery/p05-7-f005-integration-verification.test.ts test/modules/delivery/p05-7-f006-integration-reconciliation.test.ts test/modules/delivery/p05-7-f008-integration-vertical.test.ts test/modules/delivery/p05-8-f001-git-agent-repair-contract.test.ts test/modules/delivery/p05-8-f002-git-agent-repair-run.test.ts test/modules/delivery/p05-8-f003-git-agent-runtime.test.ts test/modules/delivery/p05-8-f004-git-agent-candidate-finalization.test.ts test/modules/delivery/p05-8-f005-git-agent-recovery-sqlite.test.ts test/modules/delivery/p05-8-f005-git-agent-recovery.test.ts test/modules/delivery/p05-8-f006-git-agent-host-query.test.ts test/modules/delivery/p05-8-f007-git-agent-composition.test.ts test/modules/delivery/p05-9-f001-batch-delivery-query.test.ts test/modules/delivery/p05-9-f002-batch-leaf-finalization.test.ts test/modules/delivery/p05-9-f003-batch-lifecycle.test.ts test/modules/delivery/p05-9-f004-phase-delivery-approval-sqlite.test.ts test/modules/delivery/p05-9-f004-phase-delivery-approval.test.ts test/modules/delivery/p05-9-f005-batch-operations.test.ts test/modules/delivery/p05-9-f008-batch-delivery-vertical.test.ts test/modules/delivery/p05-9-f008-delivery-record.test.ts test/modules/execution/budget/p03-3-attempt-budget-reservation.test.ts test/modules/execution/budget/p03-3-execution-start.test.ts test/modules/execution/budget/p03-3-work-command-receipts.test.ts test/modules/execution/budget/p05-3-f001-batch-members.test.ts test/modules/execution/budget/p05-3-f002-preview-scope.test.ts test/modules/execution/budget/p05-3-f003-preview-orchestration.test.ts test/modules/execution/budget/p05-3-f004-batch-authorization.test.ts test/modules/execution/budget/p05-3-f005-batch-retry.test.ts test/modules/execution/budget/p05-3-f008-batch-cross-layer.test.ts test/modules/execution/control/p05-5-f006-feature-control.test.ts test/modules/execution/dispatch/p05-4-f008-feature-dispatch-vertical.test.ts test/modules/host/control/p05-5-f007-resource-host-wiring.test.ts test/modules/host/p03-10-feature-report-contract.test.ts test/modules/host/p05-1-f006-submission-tools.test.ts test/modules/host/p05-3-f006-batch-host.test.ts test/modules/host/p05-3-f006-batch-wire.test.ts test/modules/host/p05-7-f007-integration-host-cli.test.ts test/modules/host/p05-9-f006-batch-delivery-host.test.ts test/modules/planning/docs-p05-1-planning-candidate-contract.test.ts test/modules/planning/p05-1-f001-planning-candidate-digest.test.ts test/modules/planning/p05-1-f001-planning-candidate-validation.test.ts test/modules/planning/p05-1-f002-planning-context-store.test.ts test/modules/planning/p05-1-f002-planning-strategy-selection.test.ts test/modules/planning/p05-1-f003-planning-start-command.test.ts test/modules/planning/p05-1-f004-planning-input-prepare.test.ts test/modules/planning/p05-1-f005-planning-dispatch-claim.test.ts test/modules/planning/p05-1-f006-planning-candidate-submit.test.ts test/modules/planning/p05-1-f007-planning-execution.test.ts test/modules/planning/p05-1-f008-planning-candidate-decision.test.ts test/modules/planning/p05-1-f009-planning-control.test.ts test/modules/planning/p05-1-f010-planning-recovery.test.ts test/modules/planning/p05-1-f011-planning-query.test.ts test/modules/planning/p05-1-f012-planning-host-wiring.test.ts test/modules/planning/p05-1-f013-planning-cli.test.ts test/modules/planning/p05-1-f014-planning-e2e.test.ts test/modules/planning/p05-2-f002-feature-dag.test.ts test/modules/planning/p05-2-f005-feature-dag-update.test.ts test/modules/planning/p05-2-f006-phase-graph-query.test.ts test/modules/planning/p05-2-f007-phase-graph-cli.test.ts test/modules/planning/p05-2-f007-phase-graph-host-wiring.test.ts test/modules/planning/p05-2-f008-phase-graph-vertical.test.ts test/modules/planning/p05-2-feature-phase-affiliation.test.ts test/modules/planning/p05-2-phase-lifecycle.test.ts test/modules/recovery/p03-9-f005-startup-recovery.test.ts test/modules/recovery/p04-9-f007-dispatch-crash-windows.test.ts test/modules/recovery/p05-4-f006-dispatch-recovery.test.ts test/modules/recovery/p05-5-f005-resource-recovery.test.ts test/modules/scheduling/p03-4-work-resources.test.ts test/modules/scheduling/p04-9-f003-execution-slot.test.ts test/modules/scheduling/p04-9-f004-dispatch-task-claim.test.ts test/modules/scheduling/p04-9-f006-dispatch-control-settlement.test.ts test/modules/scheduling/p05-4-f002-scheduler-candidates.test.ts test/modules/scheduling/p05-4-f003-concurrent-dispatch.test.ts test/modules/scheduling/p05-4-f004-feature-scheduler.test.ts test/modules/scheduling/p05-5-f001-feature-resources.test.ts test/modules/scheduling/p05-5-f002-feature-resource-sqlite.test.ts test/modules/scheduling/p05-5-f003-feature-dispatch-resources.test.ts test/modules/scheduling/p05-5-f004-resource-settlement.test.ts test/modules/scheduling/p05-5-f007-resource-query.test.ts test/modules/scheduling/p05-5-f008-cross-layer.test.ts test/modules/storage/sqlite/p04-9-dispatch-intent-schema.test.ts test/modules/storage/sqlite/p04-9-dispatch-slot-schema.test.ts test/modules/storage/sqlite/p05-1-f002-planning-context-schema.test.ts test/modules/storage/sqlite/p05-1-f003-planning-start-schema.test.ts test/modules/storage/sqlite/p05-2-f001-feature-dependencies-schema.test.ts test/modules/storage/sqlite/p05-7-f004-integration-journal-schema.test.ts test/modules/storage/sqlite/p05-8-f002-repair-migration.test.ts test/modules/storage/sqlite/sqlite-cas-and-atomicity.test.ts test/modules/storage/sqlite/sqlite-migration-runner.test.ts test/modules/storage/sqlite/sqlite-schema-migrations.test.ts test/modules/workspace/p05-4-f005-feature-workspace-concurrency.test.ts` | `<repo>` | 0 | 502839 |
| p05-affected-regression | `<node> scripts/run-tests.ts test/modules/acceptance/p05-10-f002-fixture.test.ts test/modules/acceptance/p05-10-f003-normal-flow.test.ts test/modules/acceptance/p05-10-f004-fault-matrix.test.ts test/modules/acceptance/p05-10-f005-git-integration.test.ts test/modules/acceptance/p05-10-f006-combined-faults.test.ts test/modules/acceptance/p05-10-f007-phase-entry.test.ts test/modules/acceptance/p05-10-f008-closeout.test.ts test/modules/acceptance/p05-10-f009-closeout.test.ts` | `<repo>` | 0 | 56787 |
| p05-cross-layer-smoke | `<node> scripts/run-tests.ts test/modules/acceptance/p05-acceptance-contract.test.ts test/modules/acceptance/p05-product-report.test.ts test/modules/acceptance/p05-phase-evidence.test.ts` | `<repo>` | 0 | 3974 |
| p05-manual-gate | `<node> -e process.exit(0)` | `<repo>` | 0 | 47 |

## 清理与证据导出

- 清理确认：已确认；受管进程组：已消失
- cleanup manifest 证据：`evidence/cleanup/manifest.json`
- 清理备注：仅回收本次入口创建的 resources；停止不确定保留现场。

## 产品 Feature 报告引用

| Feature | 说明 | 命令（逻辑） | 证据 |
|---|---|---|---|
| 13decda1-f800-4732-a0aa-732311a0a0ac | Core/Host 临时项目排队状态报告（离线，不代表真实模型执行完成） | `node scripts/run-tests.ts test/modules/acceptance/p05-acceptance-contract.test.ts test/modules/acceptance/p05-product-report.test.ts` | `evidence/product/13decda1-f800-4732-a0aa-732311a0a0ac.json` |

## Deferred（不计入已通过数）

| ID | 标题 | 状态 |
|---|---|---|
| P05-POST-FULL-HISTORY-REGRESSION | 后置：全仓历史回归 | not_run |

## 遗留问题

| ID | 说明 | 阻塞 |
|---|---|---|
| P05-PHASE-GATE-LIVE | P05 阶段放行待真实 live 验收证据（当前 not_run，不被 mock 覆盖） | 否 |
| P05-PHASE-GATE-MANUAL | P05 阶段放行待负责人人工确认（当前 pending，工具不代签） | 否 |

## 证据清单

共 141 项，均为报告目录内相对路径（evidence/ 前缀），在临时资源清理前导出；逐项 identity/category/sha256/sizeBytes 见 report.json。
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/steps/01-p05-trusted-index.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 8126 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/steps/02-p05-affected-regression.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 1245 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 911 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-command-exit.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-command-exit.json / command-exit / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 11702 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 11698 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-manifest.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-manifest.json / manifest / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 11698 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-sha.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 11693 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-usage.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 11695 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 11697 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/extra/test-scope.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/extra/test-scope.json / report / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 25105 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/result.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/result.json / report / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 5552 bytes
- `evidence/checks/P05-FR1-OFFLINE-CLOSURE/manifest.json`（evidence/checks/P05-FR1-OFFLINE-CLOSURE/manifest.json / manifest / 清理前 / P05-FR1-OFFLINE-CLOSURE）— 1028 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/steps/01-p05-trusted-index.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 8126 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/steps/02-p05-affected-regression.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 1245 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 911 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 11696 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-git.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-git.json / git / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 11693 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-process.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-process.json / process / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 11697 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 11698 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-sha.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 11693 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-usage.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 11695 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/extra/test-scope.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/extra/test-scope.json / report / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 25105 bytes
- `evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/result.json`（evidence/checks/P05-FR2-CONCURRENCY-INTEGRATION/result.json / report / 清理前 / P05-FR2-CONCURRENCY-INTEGRATION）— 3269 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/steps/01-p05-trusted-index.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-FR3-FAULT-RECOVERY）— 8126 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/steps/02-p05-affected-regression.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-FR3-FAULT-RECOVERY）— 1245 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-FR3-FAULT-RECOVERY）— 911 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-FR3-FAULT-RECOVERY）— 11696 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-git.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-git.json / git / 清理前 / P05-FR3-FAULT-RECOVERY）— 11693 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-process.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-process.json / process / 清理前 / P05-FR3-FAULT-RECOVERY）— 11697 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-FR3-FAULT-RECOVERY）— 11698 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-usage.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-FR3-FAULT-RECOVERY）— 11695 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-FR3-FAULT-RECOVERY）— 11697 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/extra/test-scope.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/extra/test-scope.json / report / 清理前 / P05-FR3-FAULT-RECOVERY）— 25105 bytes
- `evidence/checks/P05-FR3-FAULT-RECOVERY/result.json`（evidence/checks/P05-FR3-FAULT-RECOVERY/result.json / report / 清理前 / P05-FR3-FAULT-RECOVERY）— 2176 bytes
- `evidence/checks/P05-FR4-REPORT-MANUAL-GATE/manual.json`（evidence/checks/P05-FR4-REPORT-MANUAL-GATE/manual.json / manual / 清理前 / P05-FR4-REPORT-MANUAL-GATE）— 224 bytes
- `evidence/checks/P05-FR4-REPORT-MANUAL-GATE/result.json`（evidence/checks/P05-FR4-REPORT-MANUAL-GATE/result.json / report / 清理前 / P05-FR4-REPORT-MANUAL-GATE）— 247 bytes
- `evidence/checks/P05-FR4-REPORT-MANUAL-GATE/manifest.json`（evidence/checks/P05-FR4-REPORT-MANUAL-GATE/manifest.json / manifest / 清理前 / P05-FR4-REPORT-MANUAL-GATE）— 269 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/steps/01-p05-trusted-index.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I01-PLANNING-APPROVAL）— 8126 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/steps/02-p05-affected-regression.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I01-PLANNING-APPROVAL）— 1245 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I01-PLANNING-APPROVAL）— 911 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I01-PLANNING-APPROVAL）— 11696 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I01-PLANNING-APPROVAL）— 11698 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-command-exit.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-command-exit.json / command-exit / 清理前 / P05-I01-PLANNING-APPROVAL）— 11702 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-sha.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-I01-PLANNING-APPROVAL）— 11693 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I01-PLANNING-APPROVAL）— 11695 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/extra/test-scope.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/extra/test-scope.json / report / 清理前 / P05-I01-PLANNING-APPROVAL）— 25105 bytes
- `evidence/checks/P05-I01-PLANNING-APPROVAL/result.json`（evidence/checks/P05-I01-PLANNING-APPROVAL/result.json / report / 清理前 / P05-I01-PLANNING-APPROVAL）— 985 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/steps/01-p05-trusted-index.json`（evidence/checks/P05-I02-AB-CONVERGENCE/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I02-AB-CONVERGENCE）— 8126 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/steps/02-p05-affected-regression.json`（evidence/checks/P05-I02-AB-CONVERGENCE/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I02-AB-CONVERGENCE）— 1245 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I02-AB-CONVERGENCE/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I02-AB-CONVERGENCE）— 911 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I02-AB-CONVERGENCE）— 11696 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-git.json`（evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-git.json / git / 清理前 / P05-I02-AB-CONVERGENCE）— 11693 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I02-AB-CONVERGENCE）— 11698 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-sha.json`（evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-I02-AB-CONVERGENCE）— 11693 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I02-AB-CONVERGENCE/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I02-AB-CONVERGENCE）— 11695 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/extra/test-scope.json`（evidence/checks/P05-I02-AB-CONVERGENCE/extra/test-scope.json / report / 清理前 / P05-I02-AB-CONVERGENCE）— 25105 bytes
- `evidence/checks/P05-I02-AB-CONVERGENCE/result.json`（evidence/checks/P05-I02-AB-CONVERGENCE/result.json / report / 清理前 / P05-I02-AB-CONVERGENCE）— 973 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/steps/01-p05-trusted-index.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I03-RESOURCE-MUTEX）— 8126 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/steps/02-p05-affected-regression.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I03-RESOURCE-MUTEX）— 1245 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I03-RESOURCE-MUTEX）— 911 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I03-RESOURCE-MUTEX）— 11696 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-process.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-process.json / process / 清理前 / P05-I03-RESOURCE-MUTEX）— 11697 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I03-RESOURCE-MUTEX）— 11698 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I03-RESOURCE-MUTEX）— 11695 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-I03-RESOURCE-MUTEX）— 11697 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/extra/test-scope.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/extra/test-scope.json / report / 清理前 / P05-I03-RESOURCE-MUTEX）— 25105 bytes
- `evidence/checks/P05-I03-RESOURCE-MUTEX/result.json`（evidence/checks/P05-I03-RESOURCE-MUTEX/result.json / report / 清理前 / P05-I03-RESOURCE-MUTEX）— 981 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/steps/01-p05-trusted-index.json`（evidence/checks/P05-I04-RECOVERY-FENCING/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I04-RECOVERY-FENCING）— 8126 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/steps/02-p05-affected-regression.json`（evidence/checks/P05-I04-RECOVERY-FENCING/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I04-RECOVERY-FENCING）— 1245 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I04-RECOVERY-FENCING/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I04-RECOVERY-FENCING）— 911 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I04-RECOVERY-FENCING）— 11696 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-process.json`（evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-process.json / process / 清理前 / P05-I04-RECOVERY-FENCING）— 11697 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I04-RECOVERY-FENCING）— 11698 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I04-RECOVERY-FENCING）— 11695 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-I04-RECOVERY-FENCING/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-I04-RECOVERY-FENCING）— 11697 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/extra/test-scope.json`（evidence/checks/P05-I04-RECOVERY-FENCING/extra/test-scope.json / report / 清理前 / P05-I04-RECOVERY-FENCING）— 25105 bytes
- `evidence/checks/P05-I04-RECOVERY-FENCING/result.json`（evidence/checks/P05-I04-RECOVERY-FENCING/result.json / report / 清理前 / P05-I04-RECOVERY-FENCING）— 983 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/steps/01-p05-trusted-index.json`（evidence/checks/P05-I05-GIT-INTEGRATION/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I05-GIT-INTEGRATION）— 8126 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/steps/02-p05-affected-regression.json`（evidence/checks/P05-I05-GIT-INTEGRATION/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I05-GIT-INTEGRATION）— 1245 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I05-GIT-INTEGRATION/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I05-GIT-INTEGRATION）— 911 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-git.json`（evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-git.json / git / 清理前 / P05-I05-GIT-INTEGRATION）— 11693 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I05-GIT-INTEGRATION）— 11696 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I05-GIT-INTEGRATION）— 11698 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-sha.json`（evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-I05-GIT-INTEGRATION）— 11693 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I05-GIT-INTEGRATION）— 11695 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-I05-GIT-INTEGRATION/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-I05-GIT-INTEGRATION）— 11697 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/extra/test-scope.json`（evidence/checks/P05-I05-GIT-INTEGRATION/extra/test-scope.json / report / 清理前 / P05-I05-GIT-INTEGRATION）— 25105 bytes
- `evidence/checks/P05-I05-GIT-INTEGRATION/result.json`（evidence/checks/P05-I05-GIT-INTEGRATION/result.json / report / 清理前 / P05-I05-GIT-INTEGRATION）— 1067 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/steps/01-p05-trusted-index.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I06-BOUNDED-REPAIR）— 8126 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/steps/02-p05-affected-regression.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I06-BOUNDED-REPAIR）— 1245 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I06-BOUNDED-REPAIR）— 911 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-git.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-git.json / git / 清理前 / P05-I06-BOUNDED-REPAIR）— 11693 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I06-BOUNDED-REPAIR）— 11696 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-process.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-process.json / process / 清理前 / P05-I06-BOUNDED-REPAIR）— 11697 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I06-BOUNDED-REPAIR）— 11698 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I06-BOUNDED-REPAIR）— 11695 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-I06-BOUNDED-REPAIR）— 11697 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/extra/test-scope.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/extra/test-scope.json / report / 清理前 / P05-I06-BOUNDED-REPAIR）— 25105 bytes
- `evidence/checks/P05-I06-BOUNDED-REPAIR/result.json`（evidence/checks/P05-I06-BOUNDED-REPAIR/result.json / report / 清理前 / P05-I06-BOUNDED-REPAIR）— 1070 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/steps/01-p05-trusted-index.json`（evidence/checks/P05-I07-LEAF-DELIVERY/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I07-LEAF-DELIVERY）— 8126 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/steps/02-p05-affected-regression.json`（evidence/checks/P05-I07-LEAF-DELIVERY/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I07-LEAF-DELIVERY）— 1245 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I07-LEAF-DELIVERY/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I07-LEAF-DELIVERY）— 911 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I07-LEAF-DELIVERY）— 11696 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-git.json`（evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-git.json / git / 清理前 / P05-I07-LEAF-DELIVERY）— 11693 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-report.json`（evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-report.json / report / 清理前 / P05-I07-LEAF-DELIVERY）— 11696 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I07-LEAF-DELIVERY）— 11698 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-sha.json`（evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-I07-LEAF-DELIVERY）— 11693 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I07-LEAF-DELIVERY/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I07-LEAF-DELIVERY）— 11695 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/extra/test-scope.json`（evidence/checks/P05-I07-LEAF-DELIVERY/extra/test-scope.json / report / 清理前 / P05-I07-LEAF-DELIVERY）— 25105 bytes
- `evidence/checks/P05-I07-LEAF-DELIVERY/result.json`（evidence/checks/P05-I07-LEAF-DELIVERY/result.json / report / 清理前 / P05-I07-LEAF-DELIVERY）— 1064 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/steps/01-p05-trusted-index.json`（evidence/checks/P05-I08-APPEND-BATCH/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I08-APPEND-BATCH）— 8126 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/steps/02-p05-affected-regression.json`（evidence/checks/P05-I08-APPEND-BATCH/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I08-APPEND-BATCH）— 1245 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I08-APPEND-BATCH/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I08-APPEND-BATCH）— 911 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-sqlite.json`（evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-sqlite.json / sqlite / 清理前 / P05-I08-APPEND-BATCH）— 11696 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I08-APPEND-BATCH）— 11698 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-sha.json`（evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-I08-APPEND-BATCH）— 11693 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I08-APPEND-BATCH/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I08-APPEND-BATCH）— 11695 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/extra/test-scope.json`（evidence/checks/P05-I08-APPEND-BATCH/extra/test-scope.json / report / 清理前 / P05-I08-APPEND-BATCH）— 25105 bytes
- `evidence/checks/P05-I08-APPEND-BATCH/result.json`（evidence/checks/P05-I08-APPEND-BATCH/result.json / report / 清理前 / P05-I08-APPEND-BATCH）— 882 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/steps/01-p05-trusted-index.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/steps/01-p05-trusted-index.json / command-exit / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 8126 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/steps/02-p05-affected-regression.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/steps/02-p05-affected-regression.json / command-exit / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 1245 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/steps/03-p05-cross-layer-smoke.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/steps/03-p05-cross-layer-smoke.json / command-exit / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 911 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-command-exit.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-command-exit.json / command-exit / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 11702 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-artifact.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-artifact.json / artifact / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 11698 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-manifest.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-manifest.json / manifest / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 11698 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-sha.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-sha.json / sha / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 11693 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-usage.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-usage.json / usage / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 11695 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-cleanup.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/scenarios/phase-evidence-cleanup.json / cleanup / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 11697 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/extra/test-scope.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/extra/test-scope.json / report / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 25105 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/result.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/result.json / report / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 1085 bytes
- `evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/manifest.json`（evidence/checks/P05-I09-INPUT-BUDGET-INTEGRITY/manifest.json / manifest / 清理前 / P05-I09-INPUT-BUDGET-INTEGRITY）— 1112 bytes
- `evidence/checks/P05-LIVE-GIT-AGENT-AUTH/live.json`（evidence/checks/P05-LIVE-GIT-AGENT-AUTH/live.json / live / 清理前 / P05-LIVE-GIT-AGENT-AUTH）— 240 bytes
- `evidence/checks/P05-MANUAL-OWNER-GATE/manual.json`（evidence/checks/P05-MANUAL-OWNER-GATE/manual.json / manual / 清理前 / P05-MANUAL-OWNER-GATE）— 219 bytes
- `evidence/checks/P05-MANUAL-OWNER-GATE/result.json`（evidence/checks/P05-MANUAL-OWNER-GATE/result.json / report / 清理前 / P05-MANUAL-OWNER-GATE）— 242 bytes
- `evidence/checks/P05-MANUAL-OWNER-GATE/manifest.json`（evidence/checks/P05-MANUAL-OWNER-GATE/manifest.json / manifest / 清理前 / P05-MANUAL-OWNER-GATE）— 254 bytes
- `evidence/product/13decda1-f800-4732-a0aa-732311a0a0ac.json`（evidence/product/13decda1-f800-4732-a0aa-732311a0a0ac.json / report / 清理前）— 10086 bytes
- `evidence/state/git.json`（evidence/state/git.json / git / 清理前）— 306 bytes
- `evidence/state/process.json`（evidence/state/process.json / process / 清理前）— 631 bytes
- `evidence/state/inputs.json`（evidence/state/inputs.json / artifact / 清理前）— 18408 bytes
- `evidence/toolchain/tool-versions.json`（evidence/toolchain/tool-versions.json / artifact / 清理前）— 391 bytes
- `evidence/cleanup/manifest.json`（evidence/cleanup/manifest.json / manifest / 清理前）— 303 bytes

## 已知限制

- live 检查在本次汇总中保持 not_run：真实 Pi 闭环需显式授权与真实证据，不被 mock 结果覆盖。
- 人工验收保持 pending：负责人身份/时间/结论由人工清单确认，模型不代签。
- 本报告为阶段验收工具输出（phase-acceptance 层），工具交付通过不等于 P05 阶段验收通过。
- Pi SDK 版本记录于 evidence/toolchain/tool-versions.json（@earendil-works/pi-agent-core）。
- 默认阶段范围：可信索引中 106 个 P05/必要底层测试文件；76 个历史文件 not_run，详见 test-scope.json。
- 产品报告来自临时项目真实 Core/Host 查询，状态为 queued；仅证明查询与报告导出链路，不替代 Runtime 执行完成证据。
- live not_run、人工 pending，不签署 P05 Phase 通过。

