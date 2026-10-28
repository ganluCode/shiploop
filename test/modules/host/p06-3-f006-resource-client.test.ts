import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';

describe('P06-3 F-006 HostClient resource revision', () => {
  it('[case:resource-unknown-version] preserves the unsupported protocol version classification', () => {
    expect(() => validateAppQueryResponse('project.resources.list', { schemaVersion: 2, projectId: randomUUID(), revision: 0, resources: [], digest: 'a'.repeat(64) }))
      .toThrow(expect.objectContaining({ code: 'unsupported_schema_version' }));
  });

  it('[case:resource-initial-revision] sends revision zero in the import envelope without weakening other revision validators', async () => {
    let requestBody = '';
    const server = createServer((request, response) => {
      request.on('data', chunk => { requestBody += String(chunk); });
      request.on('end', () => { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end('{}'); });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const client = createHostClientApplication({ port: address.port, token: 'synthetic', connectMs: 1000, appRequestMs: 1000,
      submitBudgetMs: 2000, assertOpen: () => {}, registerSubscription: () => {}, unregisterSubscription: () => {} });
    try {
      await expect(client.importProjectResource({ projectId: randomUUID(), expectedRevision: 0, sourceId: randomUUID(),
        sourceDigest: 'a'.repeat(64), candidateId: randomUUID(), candidateDigest: 'b'.repeat(64), commandId: randomUUID() })).rejects.toThrow();
      expect(JSON.parse(requestBody)).toMatchObject({ operation: 'project.resource.import', expectedRevision: 0 });
      await expect(client.enableProjectResource({ projectId: randomUUID(), resourceId: randomUUID(), expectedRevision: -1 })).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
