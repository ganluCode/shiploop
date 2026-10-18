import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new URL('../../../docs/p03-6-handoff.md', import.meta.url);

describe('F-014 runtime/fake-runtime integration handoff', () => {
  it('hands off delivered runtime/fake surfaces with real-resource evidence, recovery boundary and not_run gaps', () => {
    const text = readFileSync(doc, 'utf8');
    for (const term of [
      'FR-1', 'FR-2', 'T05', 'T06', 'T37', 'T40', 'T43', 'T44',
      'not_run', 'accept:p03',
      'P03-7', 'P03-9', 'P03-10', 'P04',
      'RuntimeExecutionRequest', 'runtime-registry', 'workRuntimeFactory',
      'fake-runtime-script', 'createFakeWorkRuntimeFactory', 'createFakeRuntimeGate',
      'execution-input-binding', 'work-session', 'work-evidence-recorder',
      'runtime-settlement', 'execution-supervision', 'execution-workspace-retention',
      'sessions_attempt_unique', 'runtime_starts', 'task_attempt_reservations',
      'verifying', 'verification_not_assembled', 'quarantined', 'resource_busy',
      'synthetic', 'dependsOn', 'readVerifiedContent',
      'validateRuntimeRecoveryRequest', 'conversationResume', 'executionRecovery',
      'p03-3a-handoff.md', 'p03-3a-pi-durable-capability-matrix.md',
      'd9dd2c31620f52cef098a1ab320f3ee38ec0a67e',
      'core-design/14-runtime-recovery-and-durable.md',
      'modules/runtime/p03-6-vertical-integration.test.ts',
      'modules/runtime/p03-6-runtime-execution-contract.test.ts',
      'modules/runtime/p03-6-fake-tool-command.test.ts',
      'modules/runtime/p03-6-execution-input-binding.test.ts',
      'modules/runtime/p03-6-fake-runtime-lifecycle.test.ts',
      'modules/acceptance/p02-4-clean-replay.test.ts',
      'verifications/F-014/',
      'npm run verify', 'npm run typecheck', 'npm run build',
      'npm run check:boundaries', 'git diff --check',
    ]) expect(text, term).toContain(term);
    // 不宣称本 Feature 之外的能力：真实 SDK/模型、阶段验收均为 not_run 语义。
    expect(text).toContain('真实 Pi SDK/付费模型：not_run');
    expect(text).toContain('不提供 `accept:p03`');
  });
});
