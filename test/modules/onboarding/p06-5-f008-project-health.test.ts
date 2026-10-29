import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);
const resources: Array<{ close(): void; dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    resource.close();
    await resource.dispose();
  }
});

function envelope(projectId: string, payload: unknown) {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation: 'baseline.run' as const,
    scope: { kind: 'project' as const, projectId },
    issuedAt: new Date().toISOString(),
    payload,
  };
}

describe('P06-5 F-008 project health applicability', () => {
  it('[case:health-invalidated-by-working-tree] preserves history while invalidating current health after a real Git change', async () => {
    const fixture = createBaselineFixture({ prefix: 'shiploop-p06-5-f008-' });
    const app = await openCoreApplication({ dataRoot: fixture.dataRoot(), capabilityCatalog: catalog });
    resources.push({ close: () => app.close(), dispose: fixture.dispose });

    const registration = await app.projectService.registerRepository({
      repositoryPath: fixture.repos.withHead,
      displayName: 'health applicability',
    });
    const projectId = registration.project.id;
    const plan = {
      checks: [{
        checkKey: 'node-version',
        kind: 'command' as const,
        argv: [process.execPath, '--version'],
        timeoutMs: 10_000,
        required: true,
      }],
    };
    const preview = await app.baselineService.previewBaseline(owner, projectId, { plan });
    const receipt = await app.baselineExecutionService.submit(
      owner,
      envelope(projectId, { decision: 'authorize', plan, previewDigest: preview.previewDigest }),
    );
    expect(receipt.status).toBe('accepted');
    if (receipt.status !== 'accepted') throw new Error('expected accepted baseline receipt');
    await app.baselineExecutionService.waitForIdle();

    const before = await app.onboardingService.getProjectOverview(owner, projectId);
    expect(before.health.status).toBe('healthy');
    expect(before.health.applicability).toBe('applicable');
    expect(before.health.lastBaseline?.checks).toEqual([
      { checkKey: 'node-version', status: 'passed', required: true },
    ]);
    const historical = await app.baselineQueryService.getBaseline(owner, receipt.operationId);
    const operationsBefore = app.baselineStore.listBaselineOperations(projectId, { limit: 100 });
    const artifactId = historical.checks[0]?.output?.artifactId;
    expect(artifactId).toEqual(expect.any(String));

    appendFileSync(join(fixture.repos.withHead, 'README.md'), '\nchanged after baseline\n', 'utf8');

    const after = await app.onboardingService.getProjectOverview(owner, projectId);
    expect(after.health.status).toBe('unhealthy');
    expect(after.health.applicability).toBe('inapplicable');
    expect(after.health.applicabilityReasons).toContain('source_changed');
    expect(after.health.lastBaseline?.checks[0]).toMatchObject({ status: 'passed', required: true });

    const historicalAfter = await app.baselineQueryService.getBaseline(owner, receipt.operationId);
    expect(historicalAfter.checks[0]?.status).toBe('passed');
    expect(historicalAfter.checks[0]?.output?.artifactId).toBe(artifactId);
    expect(app.baselineStore.listBaselineOperations(projectId, { limit: 100 })).toEqual(operationsBefore);
  }, 90_000);
});
