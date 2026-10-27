import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/index.ts';
import { CURRENT_SCHEMA_VERSION, CURRENT_PROTOCOL_VERSION } from '../../../packages/host/src/contract/constants.ts';
import { validateHandshakeResponse } from '../../../packages/host/src/contract/handshake.ts';
import { createRestrictedPrincipal, scopeAllowlist } from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/http-probe.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';

const owner = createLocalOwnerPrincipal();

describe('P06-2 knowledge Host queries', () => {
  it('[case:knowledge-loopback-restart] searches and reads verified documents and accepted memories without changing state, across restart', async () => {
    await withKnowledgeHost(async f => {
      expect(f.client.handshake.capabilities.application.queries).toEqual(expect.arrayContaining(['knowledge.search', 'knowledge.read', 'memory.search']));
      const before = f.snapshot();
      const search = await f.client.searchKnowledge(f.projectId, { keyword: 'needle' });
      expect(search.results).toHaveLength(1);
      expect(search.results[0]).toMatchObject({ documentId: f.published.document.id, version: 1, sourceRefs: [{ projectId: f.projectId, artifactId: f.source.id, version: f.source.version, contentHash: f.source.contentHash }], position: { line: 2 } });
      const read = await f.client.readKnowledge(f.projectId, { documentId: f.published.document.id, version: 1 });
      expect(read.contentText).toBe(f.body);
      expect(read.contentHash).toBe(search.results[0].contentHash);
      const memories = await f.client.searchMemories(f.projectId, { keyword: 'needle' });
      expect(memories.results).toMatchObject([{ recordKey: 'build.rule', version: 1, scope: 'build', status: 'accepted', sourceRefs: [{ projectId: f.projectId, artifactId: f.source.id, version: f.source.version }], snippet: 'needle 记忆 build command' }]);
      expect(JSON.stringify({ search, read, memories })).not.toContain(f.root);
      expect(f.snapshot()).toEqual(before);
      await f.restart();
      const afterRestart = f.snapshot();
      expect(await f.client.searchKnowledge(f.projectId, { keyword: 'needle' })).toEqual(search);
      expect(await f.client.readKnowledge(f.projectId, { documentId: f.published.document.id, version: 1 })).toEqual(read);
      expect(await f.client.searchMemories(f.projectId, { keyword: 'needle' })).toEqual(memories);
      expect(f.snapshot()).toEqual(afterRestart);
    });
  });

  it('[case:knowledge-diagnostic-errors] distinguishes empty results, missing versions, corrupt bodies and insufficient budget in HostClient', async () => {
    await withKnowledgeHost(async f => {
      const input = { documentId: f.published.document.id, version: 1 };
      expect(await f.client.searchKnowledge(f.projectId, { keyword: 'absent' })).toMatchObject({ results: [], diagnostics: [{ code: 'no_results' }] });
      expect(await f.client.searchKnowledge(f.projectId, { ...input, maxReadBytes: 1 })).toMatchObject({ results: [], diagnostics: [{ code: 'budget_exceeded' }] });
      await expect(f.client.readKnowledge(f.projectId, { ...input, maxReadBytes: 1 })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'budget_exceeded' } });
      await expect(f.client.readKnowledge(f.projectId, { ...input, version: 99 })).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.client.readKnowledge(f.otherProjectId, input)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await f.client.searchMemories(f.projectId, { keyword: 'needle', maxReadBytes: 1 })).toMatchObject({ results: [], diagnostics: [{ code: 'budget_exceeded' }] });
      writeFileSync(join(f.root, 'projects', f.projectId, 'artifacts', f.published.version.contentRef.artifactId, 'content'), 'CORRUPTED private data');
      expect(await f.client.searchKnowledge(f.projectId, input)).toMatchObject({ results: [], diagnostics: [{ code: 'corrupt_content' }] });
      await expect(f.client.readKnowledge(f.projectId, input)).rejects.toMatchObject({ code: 'corrupt_state' });
      // Memory content is independently verified before a snippet can be returned.
      writeFileSync(join(f.root, 'projects', f.projectId, 'artifacts', f.memoryContent.id, 'content'), 'CORRUPTED private memory');
      const memory = await f.client.searchMemories(f.projectId, { keyword: 'needle' });
      expect(memory.results).toEqual([]);
      expect(memory.diagnostics[0].code).toBe('corrupt_content');
      expect(JSON.stringify(memory)).not.toContain('CORRUPTED');
    });
  });

  it('[case:knowledge-scope-auth-and-input] enforces trusted principal and project route scope, rejecting bodies, duplicate parameters and forged authority', async () => {
    await withKnowledgeHost(async f => {
      const scoped = await f.scoped(createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: scopeAllowlist([f.projectId]) }));
      expect((await scoped.client.searchKnowledge(f.projectId, { keyword: 'needle' })).results).toHaveLength(1);
      await expect(scoped.client.searchKnowledge(f.otherProjectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(scoped.client.readKnowledge(f.otherProjectId, { documentId: f.published.document.id })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(scoped.client.searchMemories(f.otherProjectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(scoped.client.searchKnowledge(f.projectId, { keyword: 'needle', projectId: f.otherProjectId } as never)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(scoped.client.readKnowledge(f.projectId, { documentId: f.published.document.id, projectId: f.otherProjectId } as never)).rejects.toMatchObject({ code: 'invalid_input' });
      const base = `/v1/projects/${f.projectId}/knowledge/search?keyword=needle`;
      const before = f.snapshot();
      const unauthenticated = await loopbackRequest({ port: scoped.port, method: 'GET', path: base });
      expect(unauthenticated.statusCode).toBe(401);
      for (const [path, body] of [
        [base, { projectId: f.otherProjectId }],
        [base + `&projectId=${f.otherProjectId}`, undefined],
        [base + '&keyword=again', undefined],
        [base + '&actorId=owner', undefined],
        [base + '&maxReadBytes=NaN', undefined],
        [base + '&path=%2Fprivate%2Fcredentials', undefined],
      ] as const) {
        const response = await loopbackRequest({ port: scoped.port, token: scoped.token, method: 'GET', path, ...(body === undefined ? {} : { body }) });
        expect(response.statusCode).toBe(400);
        expect(response.bodyText).not.toContain('/private/credentials');
        expect(response.bodyText).not.toContain(scoped.token);
      }
      expect(f.snapshot()).toEqual(before);
    });
  });

  it('[case:knowledge-capability-assembly] advertises each assembled query only and returns unsupported for absent methods', async () => {
    await withKnowledgeHost(async f => {
      const partial = await f.scoped(owner, { knowledgeQueryService: { search: f.host.core.knowledgeQueryService.search }, memoryQueryService: undefined });
      const handshake = await loopbackRequest({ port: partial.port, token: partial.token, method: 'POST', path: '/v1/host/handshake', body: { schemaVersion: CURRENT_SCHEMA_VERSION, protocolVersion: CURRENT_PROTOCOL_VERSION, hostInstanceId: partial.hostInstanceId, dataRootIdentity: partial.dataRootIdentity } });
      expect(handshake.statusCode).toBe(200);
      const parsed = validateHandshakeResponse(handshake.json(), { expectedHostInstanceId: partial.hostInstanceId, expectedDataRootIdentity: partial.dataRootIdentity });
      expect(parsed.capabilities.application.queries).toContain('knowledge.search');
      expect(parsed.capabilities.application.queries).not.toContain('knowledge.read');
      expect(parsed.capabilities.application.queries).not.toContain('memory.search');
      expect((await partial.client.searchKnowledge(f.projectId, { keyword: 'needle' })).results).toHaveLength(1);
      await expect(partial.client.readKnowledge(f.projectId, { documentId: f.published.document.id })).rejects.toMatchObject({ code: 'unsupported' });
      await expect(partial.client.searchMemories(f.projectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'unsupported' });
      const missing = await f.scoped(owner, { knowledgeQueryService: undefined, memoryQueryService: undefined });
      await expect(missing.client.searchKnowledge(f.projectId, { keyword: 'needle' })).rejects.toMatchObject({ code: 'unsupported' });
      const broken = await f.scoped(owner, { knowledgeQueryService: { search: async () => { throw new Error(`/private/internal SECRET ${randomUUID()}`); } } });
      const response = await loopbackRequest({ port: broken.port, token: broken.token, method: 'GET', path: `/v1/projects/${f.projectId}/knowledge/search?keyword=needle` });
      expect(response.statusCode).toBe(500);
      expect(response.bodyText).not.toMatch(/SECRET|private|stack/);
    });
  });
});
