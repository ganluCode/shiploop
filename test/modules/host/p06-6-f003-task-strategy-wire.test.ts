import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createHostClientApplication, validateAppQueryResponse,
  validateTaskStrategyReapplicationPreviewWire, validateTaskStrategyReapplicationResultWire,
} from '../../../packages/host/src/index.ts';
import { validateTaskStrategyReapplicationPreview } from '../../../packages/core/src/protocol.ts';

const hash = 'a'.repeat(64);
function preview() {
  return {
    schemaVersion: 1, scope: 'task-strategy-reapplication-preview', status: 'ready',
    identity: { projectId: '11111111-1111-4111-8111-111111111111', globalSettingsRevision: 1, projectSettingsRevision: null,
      selectedTaskIds: ['task-a'], taskRevisions: [{ taskId: 'task-a', revision: 1 }], candidateDigest: hash },
    items: [{ taskId: 'task-a', featureId: 'feature-a', taskRevision: 1, complexity: 'low',
      current: { configSource: 'global_default', configSourceKey: 'defaultStrategy', digest: hash },
      candidate: { configSource: 'global_default', configSourceKey: 'defaultStrategy', digest: hash },
      diff: { changed: false, fields: [], beforeDigest: hash, afterDigest: hash }, eligible: true, reasons: [] as string[] }],
    changedCount: 0, blockedReasons: [] as string[],
  };
}

describe('P06-6 F-003 策略重应用公开 wire', () => {
  it('[case:wire-schema-authority] Core 与 Host 共用响应 schema，拒绝遗漏字段、身份不一致、伪计数及敏感扩展', () => {
    const valid = preview();
    expect(validateTaskStrategyReapplicationPreview(valid)).toEqual(valid);
    expect(validateAppQueryResponse('task.strategy.reapply.preview', valid)).toEqual(valid);
    const mutations: ((value: ReturnType<typeof preview>) => unknown)[] = [
      value => ({ ...value, changedCount: 1 }),
      value => ({ ...value, unexpected: '/Users/sensitive' }),
      value => ({ ...value, identity: { ...value.identity, taskRevisions: undefined } }),
      value => ({ ...value, items: [{ ...value.items[0], taskId: 'different' }] }),
      value => ({ ...value, items: [{ ...value.items[0], candidate: { ...value.items[0]!.candidate, executionConfig: { token: 'never-echo' } } }] }),
      value => ({ ...value, items: [{ ...value.items[0], current: { ...value.items[0]!.current, configSourceKey: '/Users/sensitive' } }] }),
      value => ({ ...value, items: [{ ...value.items[0], reasons: ['never-echo'] }] }),
      value => ({ ...value, identity: { ...value.identity, selectedTaskIds: ['../invalid'] } }),
      value => ({ ...value, items: [] }),
    ];
    for (const mutate of mutations) {
      const invalid = mutate(valid);
      expect(() => validateTaskStrategyReapplicationPreview(invalid)).toThrow();
      try {
        validateTaskStrategyReapplicationPreviewWire(invalid);
        throw new Error('accepted malformed response');
      } catch (error) {
        expect(error).toMatchObject({ code: 'response_malformed' });
        expect(JSON.stringify(error)).not.toMatch(/never-echo|\/Users\/sensitive/);
      }
    }
  });

  it('[case:wire-result-identities] 更新结果必须完整一一对应 Task 与 revision，未知字段拒绝', () => {
    const valid = { updatedTaskIds: ['task-a'], taskRevisions: [{ taskId: 'task-a', revision: 2 }], updatedCount: 1 };
    expect(validateTaskStrategyReapplicationResultWire(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, taskRevisions: undefined }, { ...valid, updatedCount: 2 },
      { ...valid, taskRevisions: [{ taskId: 'other-task', revision: 2 }] },
      { ...valid, taskRevisions: [{ taskId: 'task-a', revision: 0 }] },
      { ...valid, token: 'never-echo' },
    ]) expect(() => validateTaskStrategyReapplicationResultWire(invalid)).toThrowError(expect.objectContaining({ code: 'response_malformed' }));
  });

  it('[case:wire-client-scope] 结构合法但项目或选中 Task 与请求不符的响应同样拒绝', async () => {
    let body = preview();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('address missing');
      const client = createHostClientApplication({ port: address.port, token: 'fixture-token', connectMs: 200,
        appRequestMs: 2000, submitBudgetMs: 5000, assertOpen() {}, registerSubscription() {}, unregisterSubscription() {} });
      const projectId = body.identity.projectId;
      await expect(client.previewTaskStrategyReapplication(projectId, ['task-b'])).rejects.toMatchObject({ code: 'response_malformed' });
      body = { ...body, identity: { ...body.identity, projectId: '22222222-2222-4222-8222-222222222222' } };
      await expect(client.previewTaskStrategyReapplication(projectId, ['task-a'])).rejects.toMatchObject({ code: 'response_malformed' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
