import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { resourceFixture } from '../../helpers/p06-3-resource-fixture.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { CURRENT_HOST_CAPABILITIES } from '../../../packages/host/src/contract/lifecycle.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import { HostProtocolError } from '../../../packages/host/src/contract/errors.ts';

const owner = createLocalOwnerPrincipal();
const NOW = new Date().toISOString();

function importEnvelope(projectId: string, commandId = randomUUID()) {
  return {
    schemaVersion: 5,
    commandId,
    issuedAt: NOW,
    operation: 'project.resource.import' as const,
    scope: { kind: 'project' as const, projectId },
    expectedRevision: 0,
    payload: {
      sourceId: '11111111-1111-4111-8111-111111111111',
      sourceDigest: 'a'.repeat(64),
      candidateId: '22222222-2222-4222-8222-222222222222',
      candidateDigest: 'b'.repeat(64),
    },
  };
}

describe('P06-3 F-005 resource command and Host contract', () => {
  let app: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
  let sandbox: ReturnType<typeof createTempSandbox> | undefined;

  afterEach(() => {
    app?.close();
    app = undefined;
    sandbox?.cleanup();
    sandbox = undefined;
  });

  it('[case:resource-command-contract] validates resource operation versions and payload allowlists before authorization', () => {
    const valid = importEnvelope('33333333-3333-4333-8333-333333333333');
    expect(validateCommandEnvelope(valid)).toMatchObject({ operation: 'project.resource.import', expectedRevision: 0 });
    expect(() => validateCommandEnvelope({ ...valid, schemaVersion: 4 })).toThrow();
    expect(() => validateCommandEnvelope({ ...valid, payload: { ...valid.payload, principal: 'attacker' } })).toThrow();
    expect(() => validateCommandEnvelope({ ...valid, operation: 'project.resource.revoke', payload: { resourceId: valid.payload.candidateId, extra: true } })).toThrow();
  });

  it('[case:receipt-idempotency] commits resource configuration and receipt together, replaying the same command only', async () => {
    sandbox = createTempSandbox('shiploop-p063-f005-');
    const capabilityCatalog = createStaticRuntimeCapabilityCatalog([]);
    app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog });
    const project = await app.stateStore.createProject({ displayName: '资源命令项目' });
    const fixtureSession = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
    const resources = resourceFixture(fixtureSession, project.id, sandbox.path);
    const request = await resources.request();
    fixtureSession.close();
    app.close();
    app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog, projectResourceSources: resources.sources });

    const input = { ...importEnvelope(project.id), payload: request };
    const first = await app.commandService.submit(owner, input);
    expect(first).toMatchObject({ status: 'completed', operation: 'project.resource.import' });
    if (first.status !== 'completed') throw new Error('expected completed receipt');
    expect(first.result).toMatchObject({ resourceLoaded: false, runtimeExecuted: false, appliesTo: 'new_attempts_only' });

    const replay = await app.commandService.submit(owner, input);
    expect(replay).toEqual({ ...first, replayed: true });

    await expect(app.commandService.submit(owner, { ...input, payload: { ...request, candidateDigest: 'c'.repeat(64) } })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'idempotency_key_reuse' },
    });
    expect(app.projectResourceService.list(owner, project.id).revision).toBe(1);
  });

  it('[case:host-resource-surface] exposes only versioned resource routes/capabilities and rejects malformed wire responses', () => {
    expect(resolveAppRoute('/v1/projects/project-1/resources')).toMatchObject({ operation: 'project.resources.list', method: 'GET' });
    expect(resolveAppRoute('/v1/projects/project-1/resources/candidates')).toMatchObject({ operation: 'project.resources.candidates', method: 'GET' });
    expect(resolveAppRoute('/v1/projects/project-1/resources/preview')).toMatchObject({ operation: 'project.resources.preview', method: 'GET' });
    expect(CURRENT_HOST_CAPABILITIES.application.commands).toEqual(expect.arrayContaining([
      'project.resource.import', 'project.resource.enable', 'project.resource.disable', 'project.resource.revoke',
    ]));
    expect(CURRENT_HOST_CAPABILITIES.application.queries).toEqual(expect.arrayContaining([
      'project.resources.list', 'project.resources.candidates', 'project.resources.preview',
    ]));
    expect(validateAppQueryResponse('project.resources.list', {
      schemaVersion: 1, projectId: 'project-1', revision: 0, resources: [], digest: 'd'.repeat(64),
    })).toMatchObject({ projectId: 'project-1', revision: 0 });
    expect(() => validateAppQueryResponse('project.resources.list', {
      schemaVersion: 1, projectId: 'project-1', revision: 0, resources: [], digest: 'd'.repeat(64), path: '/private/source',
    })).toThrow(HostProtocolError);
  });
});
