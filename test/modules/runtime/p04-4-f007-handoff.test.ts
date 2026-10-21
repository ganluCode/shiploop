import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const matrix = new URL('../../../docs/p04-4-f007-pi-support-matrix.md', import.meta.url);
const handoff = new URL('../../../docs/p04-4-f007-recovery-handoff.md', import.meta.url);

describe('F-007 recovery handoff materials', () => {
  it('[case:support-matrix-statuses] records the supported state vocabulary and standard Pi production boundary', () => {
    const text = readFileSync(matrix, 'utf8');
    for (const term of ['PI_RUNTIME_RECOVERY_DESCRIPTOR', '1.0.4', 'jsonl', 'unsupported', 'verified', 'unverified', 'not_run', 'partial',
      'nativeHistory', 'conversationResume', 'executionRecovery', 'modelSwitchOnResume', 'nativeFork', 'FakeRuntime',
      'executionStopControl', 'verificationStops']) {
      expect(text).toContain(term);
    }
  });

  it('[case:downstream-recovery-evidence] names the evidence required by Recorder, usage, runtime control and acceptance', () => {
    const text = readFileSync(handoff, 'utf8');
    for (const term of ['P04-5', 'P04-6', 'P04-7', 'P04-8', 'RuntimeRecoveryRecording', 'sourceWatermark',
      'excluded_unknown_scope', 'invocationId', 'recording gaps', 'Task `passed`', 'required', 'auto', 'absolute path']) {
      expect(text).toContain(term);
    }
  });
});
