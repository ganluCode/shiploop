import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHostClientApplication } from '../packages/host/src/client/app-client.ts';
import { validateExecutionPreviewResultWire } from '../packages/host/src/client/app-wire.ts';

const featureId = randomUUID();
const digest = 'a'.repeat(64);
const budget = {
  batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 2, deadlineUtcMs: 1_900_000_000_000 },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: 60_000 },
};
function preview() {
  return {
    schemaVersion: 1, projectId: randomUUID(), scope: { featureIds: [featureId] },
    status: 'ready', noWorkReason: null, blocked: [], previewDigest: digest,
    runtimeExecution: false, generatedAtUtcMs: 1_800_000_000_000,
    summary: {
      approval: { planDigest: digest, checkPolicyDigest: digest, decisionId: null },
      plan: { planDigest: digest, taskCount: 1, pendingTaskIds: [featureId] },
      code: { headCommit: 'a'.repeat(40), workingTreeDigest: digest, hasUncommittedChanges: false },
      checkPolicyDigest: digest,
      tasks: [{ taskId: featureId, status: 'pending', strategyCopyDigest: digest, strategyConfigSource: 'project' }],
      permissions: { tasks: [{ taskId: featureId, digest }] },
      inputs: { refs: [{ artifactId: randomUUID(), version: 1, contentHash: digest, sizeBytes: 1 }] },
      budget, concurrency: { maxConcurrentWorks: 1, source: 'project' },
    },
  };
}

describe('P03-3 Host execution client regression', () => {
  it('same Batch retry sends only featureIds and retryBatchId to the wire', async () => {
    let received: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing port');
    const client = createHostClientApplication({
      port: address.port, token: 'fixture', connectMs: 1_000, appRequestMs: 1_000,
      submitBudgetMs: 2_000, assertOpen() {}, registerSubscription() {}, unregisterSubscription() {},
    });
    const retryBatchId = randomUUID();
    try {
      await expect(client.startExecution({ projectId: randomUUID(), featureIds: [featureId], retryBatchId }))
        .rejects.toMatchObject({ code: 'response_malformed' });
      expect(received?.payload).toEqual({ featureIds: [featureId], retryBatchId });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('accepts a complete ready preview', () => {
    const value = preview();
    expect(validateExecutionPreviewResultWire(value)).toEqual(value);
  });

  it.each([
    ['empty summary', (value: any) => { value.summary = {}; }],
    ['missing approval', (value: any) => { delete value.summary.approval; }],
    ['bad nested digest', (value: any) => { value.summary.tasks[0].strategyCopyDigest = 'bad'; }],
    ['negative count', (value: any) => { value.summary.plan.taskCount = -1; }],
    ['invalid budget', (value: any) => { value.summary.budget.run.maxAttemptsPerRun = -1; }],
    ['unknown nested field', (value: any) => { value.summary.code.secret = 'private'; }],
    ['invalid feature id', (value: any) => { value.scope.featureIds = ['bad']; }],
    ['multiple features', (value: any) => { value.scope.featureIds.push(randomUUID()); }],
    ['negative timestamp', (value: any) => { value.generatedAtUtcMs = -1; }],
    ['ready with blockers', (value: any) => { value.blocked = [{ kind: 'plan_approval', reason: 'not_approved' }]; }],
    ['blocked without reason', (value: any) => { value.status = 'blocked'; value.summary = null; value.previewDigest = null; }],
    ['malformed blocker', (value: any) => { value.status = 'blocked'; value.summary = null; value.previewDigest = null; value.blocked = [{}]; }],
    ['no_work without reason', (value: any) => { value.status = 'no_work'; value.summary = null; value.previewDigest = null; }],
  ])('rejects %s without leaking response content', (_name, mutate) => {
    const value = preview();
    mutate(value);
    expect(() => validateExecutionPreviewResultWire(value)).toThrow();
  });
});
