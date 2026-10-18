import { describe, expect, it } from 'vitest';
import {
  validateNodeCheckReport,
  createNodeTaskVerificationExecutor,
} from '../../../packages/core/src/application/node-task-verification.js';

const report = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  protocol: 'shiploop.node-check',
  collected: true,
  testCount: 2,
  targets: ['test/unit/a.test.ts', 'test/unit/b.test.ts'],
  ...overrides,
});

describe('P03-7 F-005 Node Task verification', () => {
  it('accepts only a trusted non-empty report covering the planned targets', () => {
    expect(validateNodeCheckReport(report(), ['test/unit/a.test.ts'])).toMatchObject({
      testCount: 2,
      targets: ['test/unit/a.test.ts', 'test/unit/b.test.ts'],
    });
    expect(() => validateNodeCheckReport(report({ testCount: 0 }), ['test/unit/a.test.ts']))
      .toThrow(/testCount/);
    expect(() => validateNodeCheckReport(report({ collected: false }), ['test/unit/a.test.ts']))
      .toThrow(/collected/);
    expect(() => validateNodeCheckReport(report({ targets: ['test/unit/other.test.ts'] }), ['test/unit/a.test.ts']))
      .toThrow(/target/);
    expect(() => validateNodeCheckReport('{"ok":true}', ['test/unit/a.test.ts']))
      .toThrow();
  });

  it('does not start a process before durable identity confirmation', async () => {
    const starts: string[] = [];
    const executor = createNodeTaskVerificationExecutor({
      processes: {
        async start(_request, confirm) {
          const identity = { launchId: '00000000-0000-4000-8000-000000000001', pid: 42, processGroupId: 42, startTime: 't' };
          await confirm(identity);
          starts.push(identity.launchId);
          throw new Error('test stop');
        },
      },
      artifacts: {} as never,
      files: {} as never,
      verification: {
        createVerificationBatchInTransaction: () => ({ batch: { revision: 1 }, created: true }),
        getVerificationBatch: () => ({ revision: 1 }),
        saveCheckResultInTransaction: () => ({ result: { id: 'result-1', status: 'error' } }),
        finalizeVerificationBatchInTransaction: () => ({ status: 'inconclusive' }),
      } as never,
      atomic: { transact: (_operation: string, callback: (tx: unknown) => unknown) => callback({}) } as never,
      resolveCwd: async () => '/tmp/project',
      resolveEnvironment: () => ({ PATH: '/usr/bin' }),
      confirmProcessIdentity: async () => {},
    });
    const result = await executor.start({
      projectId: 'project-1', operation: 'op-1', batchId: 'batch-1',
      plan: { status: 'ready', selectedChecks: [{ checkKey: 'unit', scope: 'task', kind: 'command', argv: ['node', 'check.js'], cwdRef: '.', environmentRef: null, timeout: 1000, required: true, requirementRefs: [] }] },
      targets: ['test/unit/a.test.ts'],
      codeDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), environmentSummary: {},
      featureId: 'feature-1', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', executionVersion: 1,
    });
    expect(result).toMatchObject({ status: 'inconclusive' });
    expect(starts).toEqual([expect.any(String)]);
  });
});
