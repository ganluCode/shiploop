import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runP03Acceptance } from '../../../scripts/acceptance/p03-accept.ts';
import { loadP03AcceptanceConfig } from '../../../scripts/acceptance/p03-config.ts';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const outcome: P02BoundedRunOutcome = { kind: 'exit', exitCode: 0, signal: null, timedOut: false,
  durationMs: 1, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, spawnError: null, stoppedVerified: true };
function options() {
  const directory = mkdtempSync(join(tmpdir(), 'shiploop-p03-controller-'));
  dirs.push(directory);
  return { repoRoot: process.cwd(), config: loadP03AcceptanceConfig('acceptance/p03.config.json'),
    reportRoot: directory, testFiles: ['test/modules/acceptance/p03-phase-test-evidence.test.ts'] };
}

describe('P03 controller never fabricates assertion evidence', () => {
  it('[case:empty-selection] rejects an empty test selection without starting an unfiltered npm test', async () => {
    let calls = 0;
    await expect(runP03Acceptance({ ...options(), testFiles: [], runProcess: async () => { calls++; return outcome; } })).rejects.toThrow(/empty|空/);
    expect(calls).toBe(0);
  });
  it('[case:no-json-proof] command exit zero without a real test report is not Phase acceptance', async () => {
    const result = await runP03Acceptance({ ...options(), runProcess: async () => outcome });
    expect(result.exitCode).not.toBe(0);
    expect(result.conclusion).not.toBe('pass');
  });
  it('[case:no-stop-proof] an unconfirmed child process stop cannot produce a successful cleanup', async () => {
    const result = await runP03Acceptance({ ...options(), runProcess: async () => ({ ...outcome, stoppedVerified: false }) });
    expect(result.exitCode).not.toBe(0);
  });
  it('[case:diagnostic-redaction] preserves a failing command report after replacing known local paths', async () => {
    const result = await runP03Acceptance({ ...options(), runProcess: async () => ({ ...outcome,
      exitCode: 1, stderr: `failed at ${process.cwd()}/test/example.test.ts` }) });
    expect(result.exitCode).not.toBe(0);
    expect(result.reportWritten, result.problems.join('\n')).toBe(true);
  });
  it('[case:isolated-home-redaction] also redacts a tool installation outside the isolated HOME', async () => {
    const result = await runP03Acceptance({ ...options(), runProcess: async () => ({ ...outcome,
      exitCode: 1, stderr: 'npm via npm_execpath (/Users/tool-owner/.nvm/bin/npm.js)' }) });
    expect(result.reportWritten, result.problems.join('\n')).toBe(true);
  });
  it('[case:raw-credential-redaction] exports fixture JSON without leaking credential-shaped fields', async () => {
    const result = await runP03Acceptance({ ...options(), runProcess: async (_cmd, _args, options) => {
      writeFileSync(join(options.env!.P03_EVIDENCE_DIR!, 'fixture.json'), JSON.stringify({
        auth: 'bearer', token: 'synthetic-secret', detail: 'Bearer synthetic-secret', status: 'failed' }));
      return { ...outcome, exitCode: 1 };
    } });
    expect(result.reportWritten, result.problems.join('\n')).toBe(true);
    const content = readFileSync(join(result.runDir!, 'evidence/scenarios/fixture.json'), 'utf8');
    expect(content).not.toContain('synthetic-secret');
    expect(JSON.parse(content).status).toBe('failed');
  });
  it('[case:runner-rejection] preserves diagnostic resources when the runner throws without stop evidence', async () => {
    let tempRoot = '';
    try {
      await expect(runP03Acceptance({ ...options(), runProcess: async (_cmd, _args, options) => {
        tempRoot = join(options.env!.HOME!, '..');
        throw new Error('runner rejected');
      } })).rejects.toThrow('runner rejected');
      expect(tempRoot).not.toBe('');
      expect(existsSync(tempRoot)).toBe(true);
    } finally {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
