import { describe, expect, it } from 'vitest';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { HostProtocolError } from '../../../packages/host/src/contract/index.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';


const PROJECT = '12345678-1234-4123-8234-1234567890ab';
const COMMAND = '12345678-1234-4123-8234-1234567890ac';
const ISO = '2026-10-27T12:00:00.000Z';

function envelope(operation: 'project.profile.confirm' | 'project.profile.modify' | 'project.profile.reject', payload: unknown = {}) {
  return {
    schemaVersion: 5,
    commandId: COMMAND,
    operation,
    scope: { kind: 'project', projectId: PROJECT },
    expectedRevision: 1,
    issuedAt: ISO,
    payload,
  };
}

function profile() {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    version: 1,
    revision: 'v1',
    status: 'candidate',
    modules: [],
    documentRefs: [],
    detectionEvidenceRefs: [],
    confirmedBy: null,
  };
}

function query() {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    candidate: {
      projectId: PROJECT,
      version: 1,
      revision: 'v1',
      status: 'candidate',
      confirmed: false,
      confirmedBy: null,
      modules: [],
      evidence: [],
      profileDigest: 'a'.repeat(64),
      storeRevision: 1,
    },
    confirmed: null,
    modules: [{
      id: 'language-node', version: '1.0.0', status: 'candidate',
      scope: ['language:node'], appliesTo: ['.'], dependencies: [], digest: 'b'.repeat(64),
    }],
  };
}

describe('P06-1 Profile Core/Host protocol', () => {
  it('[case:profile-command-envelope] uses project CAS commands and rejects caller identity fields', () => {
    expect(validateCommandEnvelope(envelope('project.profile.confirm', { profile: profile() }))).toMatchObject({
      operation: 'project.profile.confirm', expectedRevision: 1, scope: { projectId: PROJECT },
    });
    expect(validateCommandEnvelope(envelope('project.profile.reject'))).toMatchObject({ operation: 'project.profile.reject', payload: {} });
    expect(() => validateCommandEnvelope({ ...envelope('project.profile.confirm', { profile: profile() }), actorId: 'forged' })).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => validateCommandEnvelope(envelope('project.profile.confirm', { profile: profile(), principal: 'forged' }))).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => validateCommandEnvelope({ ...envelope('project.profile.confirm', { profile: profile() }), schemaVersion: 999 })).toThrowError(expect.objectContaining({ code: 'unsupported_schema_version' }));
  });

  it('[case:profile-host-routes] exposes only the frozen profile paths and rejects nested path ambiguity', () => {
    expect(resolveAppRoute(`/v1/projects/${PROJECT}/profile`)).toMatchObject({ operation: 'projects.profile.get', method: 'GET' });
    expect(resolveAppRoute(`/v1/projects/${PROJECT}/profile/match`)).toMatchObject({ operation: 'projects.profile.match', method: 'GET' });
    expect(resolveAppRoute(`/v1/projects/${PROJECT}/profile/extra`)).toBeUndefined();
  });
  it('[case:profile-query-wire] validates identity, evidence/module versions and confirmation state', () => {
    expect(validateAppQueryResponse('projects.profile.get', query())).toEqual(query());
    const badState = query();
    (badState.candidate as { confirmed: boolean }).confirmed = true;
    expect(() => validateAppQueryResponse('projects.profile.get', badState)).toThrow(HostProtocolError);
    const unknown = query() as Record<string, unknown>;
    unknown.untrustedBody = 'secret';
    expect(() => validateAppQueryResponse('projects.profile.get', unknown)).toThrowError(expect.objectContaining({ code: 'response_malformed' }));
    expect(() => validateAppQueryResponse('projects.profile.get', { ...query(), schemaVersion: 99 })).toThrowError(expect.objectContaining({ code: 'unsupported_schema_version' }));
  });

  it('[case:profile-match-wire] keeps not_ready and ready as distinct query outcomes', () => {
    const ready = { schemaVersion: 1, projectId: PROJECT, match: { status: 'ready', profileVersion: 2, modules: [{ id: 'language-node', version: '1.0.0', reason: 'confirmed_profile_scope_match' }], missing: [] } };
    expect(validateAppQueryResponse('projects.profile.match', ready)).toEqual(ready);
    const blocked = { schemaVersion: 1, projectId: PROJECT, match: { status: 'not_ready', profileVersion: null, modules: [], missing: ['language-node'], reason: 'profile_not_confirmed' } };
    expect(validateAppQueryResponse('projects.profile.match', blocked)).toEqual(blocked);
    expect(() => validateAppQueryResponse('projects.profile.match', { ...ready, match: { ...ready.match, status: 'accepted' } })).toThrow(HostProtocolError);
  });

  it('[case:profile-command-idempotency] persists one profile decision and replays the same receipt without a second version', async () => {
    const { createCommandsTestFixture } = await import('../../helpers/p02-2/commands-fixture.ts');
    const { openSqliteStorageSession } = await import('../../../packages/core/src/adapters/sqlite/session.ts');
    const { createSqliteProjectProfileStore } = await import('../../../packages/core/src/adapters/sqlite/project-profile-store.ts');
    const { computeCapabilityModuleDigest } = await import('../../../packages/core/src/ports/project-profile-store.ts');
    const fixture = createCommandsTestFixture({ prefix: 'shiploop-p06-profile-command-' });
    const app = await fixture.openApplication();
    const owner = fixture.localOwner();
    try {
      const registered = await app.projectService.registerRepository({ repositoryPath: fixture.repoDirA, displayName: 'Profile command' });
      const projectId = registered.project.id;
      const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
      try {
        const store = createSqliteProjectProfileStore(session);
        const module = { schemaVersion: 1 as const, id: 'language-node', version: '1.0.0', scope: ['language:node'], appliesTo: ['.'], dependencies: [], contentRef: 'artifact:language-node', status: 'candidate' as const };
        store.createCapabilityModule({ projectId, module, digest: computeCapabilityModuleDigest(module) });
        store.createProjectProfile({ profile: { schemaVersion: 1, projectId, version: 1, revision: 'v1', status: 'candidate', modules: [{ id: 'language-node', version: '1.0.0', roots: ['.'], languages: ['node'], frameworks: [], capabilityRefs: [], checkRefs: [] }], documentRefs: [], detectionEvidenceRefs: [], confirmedBy: null }, evidence: [] });
      } finally { session.close(); }
      const issuedAt = new Date(1_900_000_000_000).toISOString();
      const profileValue = { schemaVersion: 1, projectId, version: 1, revision: 'v1', status: 'candidate', modules: [{ id: 'language-node', version: '1.0.0', roots: ['.'], languages: ['node'], frameworks: [], capabilityRefs: [], checkRefs: [] }], documentRefs: [], detectionEvidenceRefs: [], confirmedBy: null };
      const envelopeValue = { schemaVersion: 5 as const, commandId: COMMAND, operation: 'project.profile.confirm' as const, scope: { kind: 'project' as const, projectId }, expectedRevision: 1, issuedAt, payload: { profile: profileValue } };
      const first = await app.commandService.submit(owner, envelopeValue);
      const replay = await app.commandService.submit(owner, envelopeValue);
      expect(first).toMatchObject({ status: 'completed', operation: 'project.profile.confirm' });
      expect(replay).toMatchObject({ commandId: COMMAND, replayed: true, ...(first.status === 'completed' ? { resultRef: first.resultRef } : {}) });
      expect(app.projectProfileService.getQuery(owner, projectId).confirmed).toMatchObject({ version: 2, confirmed: true });
      await expect(app.commandService.submit(owner, { ...envelopeValue, payload: { profile: { ...profileValue, revision: 'different' } } })).rejects.toThrowError(expect.objectContaining({ code: 'conflict' }));
    } finally { app.close(); fixture.cleanup(); }
  });
});
