import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new URL('../docs/p03-9-handoff.md', import.meta.url);
const repoRoot = new URL('..', import.meta.url).pathname;

describe('P03-9 feature handoff', () => {
  const text = readFileSync(doc, 'utf8');

  it('covers delivery scope, input version, evidence association and handoff boundary', () => {
    for (const term of [
      // Feature 报告要素：实现范围、输入版本、commit、工具版本、证据路径、已知缺口。
      'feat/2026-10-11-17-45-49_p03-9',
      'p03-run-control.md',
      '7b7dc88',
      'e4e12fa',
      'Node v22.19.0',
      'better-sqlite3 13.0.3',
      'drizzle-orm 0.45.3',
      'verifications/F-001',
      'verifications/F-017',
      '已知缺口',
      // 证据关联维度：Nezha 开发编排与产品内真实运行实体分开，不混用。
      'Nezha',
      'runtime_starts',
      'Project/Feature/Run/Attempt/operation',
    ]) expect(text, term).toContain(term);
  });

  it('maps FR-1/FR-2/FR-3 cases onto T06, T08 recovery subset, T13, T21, T25, T36 and T40 decision subset', () => {
    for (const term of [
      'FR-1', 'FR-2', 'FR-3',
      'T06', 'T08', 'T13', 'T21', 'T25', 'T36', 'T40',
      'not_run',
      '关键负例',
      '真实资源断言',
    ]) expect(text, term).toContain(term);
    // 未执行与未支持能力不折算通过。
    expect(text).toContain('真实 Pi SDK/付费模型：not_run');
    expect(text).toContain('不提供 `accept:p03`');
    expect(text).toContain('P04');
    expect(text).toContain('P07');
  });

  it('documents host control/query, recovery order, unified occupancy, policy snapshot and finalization scope surfaces', () => {
    for (const term of [
      'execution.pause', 'execution.cancel', 'execution.resume', 'execution.retryFinal',
      'execution.run.control.get', 'execution.batch.control.get', 'execution.run.recovery.get',
      '/v1/runs/:runId/control', '/v1/runs/:runId/recovery', '/v1/batches/:batchId/control',
      'POST /v1/commands',
      'EXECUTION_CONTROL_NEXT_ACTIONS',
      'work-startup-recovery', 'work-recovery-reconciliation', 'work-recovery-continuation',
      'execution-resume',
      'quarantined', 'interrupted',
      'FINALIZATION_PENDING_STEPS', 'finalization-only',
      'FINALIZATION_RETRY_SCOPE_SCHEMA_VERSION',
      'pauseExecution', 'getRunControl', 'getRunRecovery',
      'packages/cli/src/app/run-control.ts',
    ]) expect(text, term).toContain(term);
  });

  it('only references implementation and test entry files that exist in the repository', () => {
    const referenced = [
      'packages/core/src/ports/commands.ts',
      'packages/core/src/ports/execution-control-query.ts',
      'packages/core/src/ports/work-startup-recovery.ts',
      'packages/core/src/ports/work-recovery-reconciliation.ts',
      'packages/core/src/ports/work-recovery-continuation.ts',
      'packages/core/src/ports/finalization-retry.ts',
      'packages/core/src/application/execution-pause.ts',
      'packages/core/src/application/execution-cancel.ts',
      'packages/core/src/application/execution-resume.ts',
      'packages/core/src/application/work-startup-recovery.ts',
      'packages/core/src/application/work-recovery-reconciliation.ts',
      'packages/core/src/application/work-recovery-continuation.ts',
      'packages/core/src/application/finalization-retry.ts',
      'packages/core/src/application/finalization-execution.ts',
      'packages/core/src/application/finalization-completion.ts',
      'packages/host/src/client/app-client.ts',
      'packages/host/src/client/app-wire.ts',
      'packages/host/src/contract/constants.ts',
      'packages/host/src/contract/lifecycle.ts',
      'packages/cli/src/app/run-control.ts',
      'packages/cli/src/app/args.ts',
      'test/p03-9-f001-execution-pause.test.ts',
      'test/p03-9-f002-execution-cancel.test.ts',
      'test/p03-9-f003-execution-stop.test.ts',
      'test/p03-9-f004-time-limits.test.ts',
      'test/p03-9-f005-startup-recovery.test.ts',
      'test/p03-9-f006-recovery-reconciliation.test.ts',
      'test/p03-9-f007-recovery-continuation.test.ts',
      'test/p03-9-f008-workflow-resume.test.ts',
      'test/p03-9-f009-finalization-retry.test.ts',
      'test/p03-9-f010-finalization-run.test.ts',
      'test/p03-9-f011-finalization-execution.test.ts',
      'test/p03-9-f012-finalization-completion.test.ts',
      'test/p03-9-f013-control-recovery-query.test.ts',
      'test/p03-9-f014-host-control-wiring.test.ts',
      'test/p03-9-f015-cli-control.test.ts',
      'test/p03-9-f015-cli-control-vertical.test.ts',
      'test/p03-9-f016-host-kill-recovery.test.ts',
      'test/p03-9-f017-finalization-host-vertical.test.ts',
    ];
    const missing = referenced.filter((rel) => !existsSync(repoRoot + rel));
    expect(missing, 'handoff 引用了不存在的路径').toEqual([]);
  });

  it('lists the P03-9 task commits it hands off', () => {
    for (const hash of [
      '40f9888', '874ea0e', 'ad4ba27', '7556d01', '222bfa9', '3ffcabf',
      'd28e643', '5c682ac', 'cd13915', '3a2261c', '82bda79', '04eaa92',
      'd84d1f6', '06add86', '98db678', '1be6f52', '9cef2ac', '3e74f62',
      '4c177e7', 'e4e12fa',
    ]) expect(text, `commit ${hash}`).toContain(hash);
  });

  it('hands the full gate to Nezha without claiming it already ran', () => {
    expect(text).toContain('test-selection.json');
    expect(text).toContain('Nezha');
    expect(text).toContain('npm run verify');
    // F-018 本任务不运行全量门禁，只允许以明确否定语义出现。
    expect(text).toContain('不宣称全量 verify 已通过');
  });
});
