import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new URL('../../../../docs/p03-3a-handoff.md', import.meta.url);

describe('F-005 runtime recovery handoff', () => {
  it('hands off the delivered recovery interfaces with Core authority and Work/Chat separation, without claiming runtime completion', () => {
    const text = readFileSync(doc, 'utf8');
    for (const term of [
      'RuntimeRecoveryRequest', 'decideRuntimeRecovery',
      'createStaticRuntimeRecoveryCatalog', 'validateRuntimeRecoveryStrategy',
      'RuntimeRecoverySourceReader', 'RUNTIME_RECOVERY_EVIDENCE_KIND',
      'runtimeRecoveryDescriptors', 'runtimeRecoverySources',
      'openCoreApplication', 'SyntheticEventRecorder', 'SyntheticUsageLedger',
      'invocationId', 'nativeFork', 'duplicate_runtime_id', 'unknown_runtime',
      'unsupported_schema_version', 'executable',
      'P03-4', 'P03-6', 'P03-9', 'P04', 'not_run',
      'Chat', 'Scheduler', 'Runner', 'Attempt',
      'p03-3a-runtime-recovery-contract.md',
      'p03-3a-synthetic-recovery-fixtures.md',
      'p03-3a-pi-durable-capability-matrix.md',
      'experiments/pi-durable/sources.json',
      'experiments/pi-durable/evidence.json',
      'SHIPLOOP_PI_DURABLE_SPIKE',
      'modules/runtime/recovery/p03-3a-runtime-entry-compat.test.ts',
    ]) expect(text, term).toContain(term);
  });
});
