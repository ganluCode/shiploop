import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import { validateKnowledgeQueryResponse, type KnowledgeSearchResultSet } from '../../../packages/core/src/protocol.ts';

const projectId = randomUUID();
const documentId = randomUUID();
const contentHash = createHash('sha256').update('needle').digest('hex');
function searchResult(): KnowledgeSearchResultSet {
  const query = { documentId: null, version: null, keyword: 'needle', title: null, path: null };
  return { schemaVersion: 1, scope: 'knowledge-search', projectId, query,
    budget: { limit: 20, snippetMaxChars: 240, maxReadBytes: 65536, maxCandidates: 100, candidatesInspected: 1, bytesRead: 6 },
    results: [{ documentId, versionId: randomUUID(), version: 1, title: 'Guide', documentType: 'markdown', status: 'published',
      contentRef: { projectId, artifactId: randomUUID(), version: 1, contentHash, sizeBytes: 6 }, contentHash,
      sourceRefs: [], sourceLocators: ['docs/guide.md'], snippet: 'needle', position: { start: 0, end: 6, line: 1, column: 1 }, query, selectionReason: '关键词命中' }],
    diagnostics: [], truncated: false };
}

async function withFakeHost(run: (f: { client: ReturnType<typeof createHostClientApplication>; setBody(body: unknown): void; hang(): void }) => Promise<void>) {
  let body: unknown = searchResult();
  let hanging = false;
  const server = createServer((_request, response) => { if (!hanging) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)); } });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('missing address');
  const client = createHostClientApplication({ port: address.port, token: 'synthetic-private-token', connectMs: 100, appRequestMs: 100, submitBudgetMs: 500, assertOpen: () => {}, registerSubscription: () => {}, unregisterSubscription: () => {} });
  try { await run({ client, setBody: value => { body = value; }, hang: () => { hanging = true; } }); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

describe('knowledge shared wire and client rejection', () => {
  it('[case:knowledge-shared-schema] shares a strict Core schema and rejects unknown versions, nested private fields, invalid references, positions and budgets', () => {
    const valid = searchResult();
    expect(validateKnowledgeQueryResponse('knowledge.search', valid)).toEqual(valid);
    const mutations: ((v: any) => void)[] = [
      v => { v.schemaVersion = 99; },
      v => { v.results[0].contentRef.projectId = randomUUID(); },
      v => { v.results[0].sourceRefs = [{ projectId: randomUUID(), artifactId: randomUUID(), version: 1 }]; },
      v => { v.results[0].contentRef.physicalPath = '/private/credentials'; },
      v => { v.results[0].sourceLocators = ['/private/credentials']; },
      v => { v.results[0].contentHash = 'bad'; },
      v => { v.results[0].position.end = -1; },
      v => { v.results[0].position.line = 0; },
      v => { v.results[0].query = { ...v.query, keyword: 'changed' }; },
      v => { v.query.path = '/private/credentials'; },
      v => { v.budget.bytesRead = v.budget.maxReadBytes + 1; },
      v => { v.diagnostics = [{ code: 'secret', reason: 'x', bytesRead: 0 }]; },
      v => { delete v.results[0].snippet; },
    ];
    for (const mutate of mutations) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      expect(() => validateKnowledgeQueryResponse('knowledge.search', malformed)).toThrow();
      expect(() => validateAppQueryResponse('knowledge.search', malformed)).toThrow();
    }
  });

  it('[case:knowledge-client-response-scope] rejects another project, query or budget even in a structurally valid response', async () => {
    await withFakeHost(async f => {
      const valid = searchResult();
      f.setBody(valid);
      expect(await f.client.searchKnowledge(projectId, { keyword: 'needle' })).toEqual(valid);
      f.setBody({ ...valid, projectId: randomUUID(), results: [] });
      await expect(f.client.searchKnowledge(projectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'response_malformed' });
      f.setBody(valid);
      await expect(f.client.searchKnowledge(projectId, { keyword: 'different' })).rejects.toMatchObject({ code: 'response_malformed' });
      const emptyMemory = { ...valid, scope: 'memory-search', query: { keyword: 'needle', recordKey: null, scope: null, version: null }, results: [] };
      f.setBody(emptyMemory);
      expect(await f.client.searchMemories(projectId, { keyword: 'needle' })).toEqual(emptyMemory);
      await expect(f.client.searchMemories(projectId, { keyword: 'different' })).rejects.toMatchObject({ code: 'response_malformed' });
      f.setBody({ ...emptyMemory, budget: { ...valid.budget, maxReadBytes: 1, bytesRead: 0 } });
      await expect(f.client.searchMemories(projectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'response_malformed' });
      f.setBody(valid);
      await expect(f.client.searchKnowledge(projectId, { keyword: 'needle', maxReadBytes: 1 })).rejects.toMatchObject({ code: 'response_malformed' });
    });
  });

  it('[case:knowledge-client-hash-timeout] rejects changed read content and unknown schema, and ends hung queries within the existing request budget', async () => {
    await withFakeHost(async f => {
      const search = searchResult();
      const read = { ...search.results[0], schemaVersion: 1, scope: 'knowledge-read', projectId,
        contentText: 'forged', sizeBytes: 6, query: { documentId, version: 1, keyword: null, title: null, path: null }, budget: { maxReadBytes: 16 * 1024 * 1024, bytesRead: 6 } } as Record<string, unknown>;
      for (const k of ['sourceLocators', 'snippet', 'position', 'selectionReason']) delete read[k];
      f.setBody(read);
      await expect(f.client.readKnowledge(projectId, { documentId, version: 1 })).rejects.toMatchObject({ code: 'response_malformed' });
      f.setBody({ ...search, schemaVersion: 99 });
      await expect(f.client.searchKnowledge(projectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'unsupported_schema_version' });
      f.hang();
      await expect(f.client.searchKnowledge(projectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'unreachable' });
    });
  });
});
