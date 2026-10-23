import { relative } from 'node:path';
import { beforeEach, expect } from 'vitest';

if (process.env.SHIPLOOP_P04_EVIDENCE_DIR) {
  beforeEach(() => {
    const state = expect.getState() as { testPath?: string; currentTestName?: string };
    process.env.SHIPLOOP_P04_EVIDENCE_TEST_FILE = state.testPath ? relative(process.cwd(), state.testPath) : '';
    process.env.SHIPLOOP_P04_EVIDENCE_TEST_NAME = state.currentTestName ?? '';
  });
}
