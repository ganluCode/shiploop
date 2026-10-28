import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { compareBaselineDetails } from '../../../packages/core/src/ports/baseline-comparison.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import type { BaselineCheckResult, BaselineDetailResult } from '../../../packages/core/src/ports/baseline.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);
const initialBaselineCase = process.env.BASELINE_CASE;
const resources: Array<{ close(): void; dispose(): Promise<void> }> = [];

afterEach(async () => {
  if (initialBaselineCase === undefined) delete process.env.BASELINE_CASE;
  else process.env.BASELINE_CASE = initialBaselineCase;
  for (const resource of resources.splice(0).reverse()) {
    resource.close();
    await resource.dispose();
  }
});

function envelope(projectId: string, payload: unknown) {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation: 'baseline.run',
    scope: { kind: 'project' as const, projectId },
    issuedAt: new Date().toISOString(),
    payload,
  };
}

function check(checkKey: string, argv: string[]): BaselineCheckResult {
  return {
    checkKey, argv, cwdRef: null, environmentRef: 'case', timeoutMs: 10_000, required: true,
    status: 'failed', reasonCode: undefined, exitCode: 1, signal: null, timedOut: false,
    output: { artifactId: `${checkKey}-artifact`, byteSize: 12, truncated: false }, tail: 'failed',
    startedAt: null, endedAt: null, durationMs: null,
  };
}

function detail(operationId: string, projectId: string, checks: readonly BaselineCheckResult[]): BaselineDetailResult {
  return {
    schemaVersion: 3,
    operation: {
      operationId, kind: 'baseline', status: 'completed', createdAt: '', startedAt: '', endedAt: '',
      summary: { total: checks.length, passed: checks.filter(c => c.status === 'passed').length, failed: checks.filter(c => c.status === 'failed').length, error: 0, inconclusive: 0, notRun: 0 },
    },
    authorization: {
      projectId, repositoryBindingId: 'binding', repositoryBindingRevision: 1,
      codeIdentity: { headCommit: 'a'.repeat(40), workingTreeDigest: 'b'.repeat(64), hasUncommittedChanges: false },
      dirtyScope: { status: 'clean', explanation: 'clean' },
      environmentIdentity: { schemaVersion: 1, environmentRef: 'case', definitionRevision: 'v1', toolchain: {}, platform: { os: 'darwin', arch: 'arm64' }, allowedVariables: ['BASELINE_CASE'], coverage: ['BASELINE_CASE'], unknownFields: [] },
      policyRevision: 'c'.repeat(64), planDigest: 'd'.repeat(64), plan: { checks: [] }, authorizedBy: 'owner', authorizedAt: '',
    },
    checks,
  };
}

describe('P06-5 F-007 baseline comparison', () => {
  it('pairs by check definition and separates a fixed failure from a new failure', async () => {
    const box = createBaselineFixture({ prefix: 'shiploop-p06-5-f007-' });
    let caseName = 'first';
    const app = await openCoreApplication({
      dataRoot: box.dataRoot(), capabilityCatalog: catalog,
      baselineEnvironmentDirectory: { resolveEnvironmentRef: (ref: string) => ref === 'case' ? { allowedVariables: ['BASELINE_CASE'], definitionRevision: 'v1' } : null },
    });
    process.env.BASELINE_CASE = caseName;
    const projectId = (await app.projectService.registerRepository({ repositoryPath: box.repos.withHead, displayName: 'comparison' })).project.id;
    const source = "process.stdout.write('result'); process.exit((process.env.BASELINE_CASE === 'first') === (process.argv[1] === 'a') ? 1 : 0)";
    const plan = { checks: ['a', 'b'].map(checkKey => ({ checkKey, kind: 'command' as const, argv: [process.execPath, '-e', source, checkKey], environmentRef: 'case', timeoutMs: 10_000, required: true })) };
    const preview = await app.baselineService.previewBaseline(owner, projectId, { plan });
    const first = await app.baselineExecutionService.submit(owner, envelope(projectId, { decision: 'authorize', plan, previewDigest: preview.previewDigest }));
    await app.baselineExecutionService.waitForIdle();
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') throw new Error('expected first receipt');

    caseName = 'second';
    process.env.BASELINE_CASE = caseName;
    const preview2 = await app.baselineService.previewBaseline(owner, projectId, { plan });
    const second = await app.baselineExecutionService.submit(owner, envelope(projectId, { decision: 'authorize', plan, previewDigest: preview2.previewDigest }));
    await app.baselineExecutionService.waitForIdle();
    expect(second.status).toBe('accepted');
    if (second.status !== 'accepted') throw new Error('expected second receipt');

    const beforeOperations = app.baselineStore.listBaselineOperations(projectId, { limit: 100 });
    const beforeArtifacts = await app.artifactStore.listArtifacts(projectId);
    const comparison = await app.baselineQueryService.compareBaselines(owner, first.operationId, second.operationId);
    const comparisonViaDedicatedService = await app.baselineComparisonService.compareBaselines(owner, first.operationId, second.operationId);
    expect(comparisonViaDedicatedService).toEqual(comparison);
    expect(app.baselineStore.listBaselineOperations(projectId, { limit: 100 })).toEqual(beforeOperations);
    expect(await app.artifactStore.listArtifacts(projectId)).toEqual(beforeArtifacts);
    expect(comparison.projectId).toBe(projectId);
    expect(comparison.checks.map(checkResult => [checkResult.checkKey, checkResult.classification])).toEqual([
      ['a', 'fixed'], ['b', 'regressed'],
    ]);
    expect(comparison.previous.evidence.every(ref => ref.artifactId !== null)).toBe(true);
    expect(comparison.current.evidence.every(ref => ref.artifactId !== null)).toBe(true);
    expect(comparison.codeDiff).toMatchObject({ anyChanged: false });
  });

  it('does not infer that two nonzero results are the same failure', () => {
    const previous = detail('11111111-1111-4111-8111-111111111111', 'project-a', [check('lint', ['node', 'lint'])]);
    const current = detail('22222222-2222-4222-8222-222222222222', 'project-a', [check('lint', ['node', 'lint'])]);
    const result = compareBaselineDetails(previous, current, 'project-a');
    expect(result.checks[0]).toMatchObject({ classification: 'incomparable', reason: 'failure_identity_missing' });
    expect(result.checks[0]?.evidence.previous?.artifactId).toBe('lint-artifact');
    expect(result.checks[0]?.evidence.current?.artifactId).toBe('lint-artifact');
  });

  it('rejects changed definitions, environment identity drift, and unknown detail versions', () => {
    const previous = detail('11111111-1111-4111-8111-111111111111', 'project-a', [{ ...check('lint', ['node', 'lint']), status: 'passed', exitCode: 0 }]);
    const changedDefinition = detail('22222222-2222-4222-8222-222222222222', 'project-a', [{ ...check('lint', ['node', 'other']), status: 'passed', exitCode: 0 }]);
    expect(compareBaselineDetails(previous, changedDefinition, 'project-a').checks[0]).toMatchObject({ classification: 'incomparable', reason: 'check_definition_changed', definitionChanged: true });

    const changedEnvironmentBase = detail('33333333-3333-4333-8333-333333333333', 'project-a', [{ ...check('lint', ['node', 'lint']), status: 'passed', exitCode: 0 }]);
    if (changedEnvironmentBase.authorization === null) throw new Error('expected authorization');
    const changedEnvironment: BaselineDetailResult = {
      ...changedEnvironmentBase,
      authorization: {
        ...changedEnvironmentBase.authorization,
        environmentIdentity: { ...changedEnvironmentBase.authorization.environmentIdentity!, definitionRevision: 'v2' },
      },
    };
    const environmentResult = compareBaselineDetails(previous, changedEnvironment, 'project-a');
    expect(environmentResult.identityDiff.environmentChanged).toBe(true);
    expect(environmentResult.checks[0]).toMatchObject({ classification: 'incomparable', reason: 'environment_identity_changed' });

    expect(() => compareBaselineDetails({ ...previous, schemaVersion: 999 }, previous, 'project-a')).toThrow('unsupported detail schema version');
  });
});
