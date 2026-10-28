import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);
const openResources: Array<{ close(): void; dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const resource of openResources.splice(0).reverse()) {
    resource.close();
    await resource.dispose();
  }
});

function envelope(operation: string, projectId: string, payload: unknown) {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation,
    scope: { kind: 'project' as const, projectId },
    issuedAt: new Date().toISOString(),
    payload,
  };
}

describe('P06-5 F-006 基线预览身份', () => {
  it('预览公开绑定、脏范围和环境定义身份，并使环境定义漂移的旧授权失效', async () => {
    const box = createBaselineFixture({ prefix: 'shiploop-p06-5-f006-' });
    let environment = { allowedVariables: ['CI'], definitionRevision: 'ci-v1' };
    const app = await openCoreApplication({
      dataRoot: box.dataRoot(),
      capabilityCatalog: catalog,
      baselineEnvironmentDirectory: { resolveEnvironmentRef: (ref: string) => ref === 'ci' ? environment : null },
    });
    openResources.push({ close: () => app.close(), dispose: box.dispose });

    const projectId = (await app.projectService.registerRepository({
      repositoryPath: box.repos.withHead,
      displayName: 'F-006',
    })).project.id;
    const plan = {
      checks: [{
        checkKey: 'node-version',
        kind: 'command' as const,
        argv: [process.execPath, '--version'],
        environmentRef: 'ci',
        timeoutMs: 10_000,
        required: true,
      }],
    };
    const previewReceipt = await app.commandService.submit(owner, envelope('baseline.preview', projectId, { plan }));
    expect(previewReceipt.status).toBe('completed');
    if (previewReceipt.status !== 'completed') throw new Error('expected preview result');
    const preview = previewReceipt.result as Record<string, any>;
    expect(preview.repositoryBindingId).toEqual(expect.any(String));
    expect(preview.repositoryBindingRevision).toBeGreaterThan(0);
    expect(preview.bindingRecordRevision).toBeGreaterThan(0);
    expect(preview.dirtyScope).toMatchObject({ status: 'clean' });
    expect(preview.environmentIdentity).toMatchObject({
      environmentRef: 'ci',
      definitionRevision: 'ci-v1',
      allowedVariables: ['CI', 'PATH'],
    });
    expect(JSON.stringify(preview)).not.toContain('CI_VALUE');

    environment = { allowedVariables: ['CI', 'HOME'], definitionRevision: 'ci-v2' };
    const runReceipt = await app.commandService.submit(owner, envelope('baseline.run', projectId, {
      decision: 'authorize',
      plan,
      previewDigest: preview.previewDigest,
    }));
    expect(runReceipt.status).toBe('rejected');
    if (runReceipt.status !== 'rejected') throw new Error('expected stale rejection');
    expect(runReceipt.error.details?.reason).toBe('preview_stale');
    expect((await app.artifactStore.listArtifacts(projectId)).records).toHaveLength(0);
  });
});
