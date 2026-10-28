import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { describe, expect, it, afterEach } from 'vitest';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { createHostLifecycleServer, createHostStopController, createIdleActivityGate } from '../../../packages/host/src/index.ts';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';

const projectId = randomUUID();
const previousId = randomUUID();
const currentId = randomUUID();
const artifactId = randomUUID();

function check(status: 'passed' | 'failed' = 'passed') {
  return {
    checkKey: 'lint', argv: ['node', 'lint'], cwdRef: null, environmentRef: 'approved', timeoutMs: 1000,
    required: true, status, exitCode: status === 'passed' ? 0 : 1, signal: null, timedOut: false,
    output: { artifactId, byteSize: 3, truncated: false }, tail: 'ok',
    startedAt: null, endedAt: null, durationMs: null,
  };
}

function source(operationId: string) {
  return {
    operationId, projectId, operationStatus: 'completed',
    codeIdentity: { headCommit: 'a'.repeat(40), workingTreeDigest: 'b'.repeat(64), hasUncommittedChanges: false },
    repositoryBindingId: randomUUID(), repositoryBindingRevision: 1,
    dirtyScope: { status: 'clean', explanation: 'clean' },
    environmentIdentity: {
      schemaVersion: 1, environmentRef: 'approved', definitionRevision: 'v1', toolchain: {},
      platform: { os: 'darwin', arch: 'arm64' }, allowedVariables: [], coverage: [], unknownFields: [],
    },
    evidence: [{ operationId, checkKey: 'lint', artifactId }], gaps: [],
  };
}

function comparison() {
  const previous = source(previousId);
  const current = source(currentId);
  return {
    schemaVersion: 1, projectId, previous, current,
    codeDiff: { headCommitChanged: false, workingTreeDigestChanged: false, uncommittedChangesChanged: false, anyChanged: false },
    identityDiff: { repositoryBindingChanged: false, dirtyScopeChanged: false, environmentChanged: false },
    checks: [{
      checkKey: 'lint', classification: 'unchanged_passed', definitionChanged: false,
      previous: check(), current: check(),
      evidence: {
        previous: { operationId: previousId, checkKey: 'lint', artifactId },
        current: { operationId: currentId, checkKey: 'lint', artifactId },
      },
    }],
    comparable: true, gaps: [],
  };
}

describe('P06-5 F-010 baseline Host query contract', () => {
  it('routes the versioned baseline comparison query separately from baseline detail', () => {
    expect(resolveAppRoute('/v1/baselines/compare')).toEqual({ operation: 'baselines.compare', method: 'GET' });
    expect(resolveAppRoute(`/v1/baselines/${previousId}`)).toMatchObject({ operation: 'baselines.get' });
  });

  it('validates both source identities, per-check states and evidence references', () => {
    const value = comparison();
    expect(validateAppQueryResponse('baselines.compare', value)).toEqual(value);
  });

  it('rejects unknown versions and missing source identity instead of returning success', () => {
    const value = comparison();
    expect(() => validateAppQueryResponse('baselines.compare', { ...value, schemaVersion: 2 })).toThrow();
    const invalid = structuredClone(value) as { previous: { codeIdentity: unknown } };
    invalid.previous.codeIdentity = null;
    expect(() => validateAppQueryResponse('baselines.compare', invalid)).toThrow();
  });
});

const LOOPBACK_TOKEN = randomBytes(32).toString('hex');
const LOOPBACK_NOW = new Date(1_900_000_000_000).toISOString();
let loopbackFixture: CommandsTestFixture | undefined;
let loopbackApp: Awaited<ReturnType<CommandsTestFixture['openApplication']>> | undefined;
let loopbackServer: Server | undefined;

async function setupLoopbackComparison() {
  loopbackFixture = createCommandsTestFixture({ prefix: 'shiploop-f010-baseline-host-' });
  loopbackApp = await loopbackFixture.openApplication({
    baselineEnvironmentDirectory: {
      resolveEnvironmentRef: (ref: string) => ref === 'test' ? { allowedVariables: [], definitionRevision: 'v1' } : null,
    },
  });
  const registration = await loopbackApp.projectService.registerRepository({ repositoryPath: loopbackFixture.repoDirA, displayName: '基线比较 Host 项目' });
  let lifecycle: 'ready' = 'ready';
  const stop = createHostStopController({
    activityGate: createIdleActivityGate(), getLifecycleState: () => lifecycle, setLifecycleState: () => {},
    prepareTeardown: () => Promise.resolve(), releaseAfterTeardown: () => Promise.resolve(),
  });
  loopbackServer = createHostLifecycleServer({
    hostInstanceId: randomUUID(), dataRootIdentity: 'cd'.repeat(32), startedAt: new Date().toISOString(),
    pid: process.pid, authToken: LOOPBACK_TOKEN, getLifecycleState: () => lifecycle,
    getActivities: () => stop.getActivities(), stop,
    application: {
      principal: loopbackFixture.localOwner(), commandService: loopbackApp.commandService,
      queryService: loopbackApp.queryService, commandReceiptsService: loopbackApp.commandReceiptsService,
      onboardingService: loopbackApp.onboardingService, baselineQueryService: loopbackApp.baselineQueryService,
      baselineComparisonService: loopbackApp.baselineComparisonService,
      baselineExecutionService: loopbackApp.baselineExecutionService, planningQueryService: loopbackApp.planningQueryService,
      getLifecycleState: () => lifecycle,
    },
  });
  await new Promise<void>((resolve, reject) => { loopbackServer!.once('error', reject); loopbackServer!.listen(0, '127.0.0.1', resolve); });
  const address = loopbackServer.address();
  if (address === null || typeof address !== 'object') throw new Error('missing loopback address');
  return {
    projectId: registration.project.id,
    client: createHostClientApplication({
      port: address.port, token: LOOPBACK_TOKEN, connectMs: 1000, appRequestMs: 2000, submitBudgetMs: 3000,
      assertOpen: () => {}, registerSubscription: () => {}, unregisterSubscription: () => {},
    }),
  };
}

afterEach(async () => {
  loopbackServer?.closeAllConnections();
  if (loopbackServer !== undefined) await new Promise<void>(resolve => loopbackServer!.close(() => resolve()));
  loopbackServer = undefined;
  loopbackApp?.close();
  loopbackApp = undefined;
  loopbackFixture?.cleanup();
  loopbackFixture = undefined;
});

describe('P06-5 F-010 loopback comparison query', () => {
  it('matches Core comparison and health projection without changing SQLite facts or starting checks', async () => {
    const f = await setupLoopbackComparison();
    const plan = { checks: [{ checkKey: 'ok', kind: 'command' as const, argv: [process.execPath, '-e', 'process.stdout.write("ok")'], environmentRef: 'test', timeoutMs: 10_000, required: true }] };
    const owner = loopbackFixture!.localOwner();
    const createBaseline = async () => {
      const preview = await loopbackApp!.baselineService.previewBaseline(owner, f.projectId, { plan });
      const receipt = await loopbackApp!.baselineExecutionService.submit(owner, {
        schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION, commandId: randomUUID(), operation: 'baseline.run',
        scope: { kind: 'project', projectId: f.projectId }, issuedAt: LOOPBACK_NOW,
        payload: { decision: 'authorize', plan, previewDigest: preview.previewDigest },
      });
      await loopbackApp!.baselineExecutionService.waitForIdle();
      if (receipt.status !== 'accepted') throw new Error('expected accepted baseline receipt');
      return receipt.operationId;
    };
    const previousOperationId = await createBaseline();
    const currentOperationId = await createBaseline();
    const beforeOperations = loopbackApp!.baselineStore.listBaselineOperations(f.projectId, { limit: 100 });
    const beforeArtifacts = await loopbackApp!.artifactStore.listArtifacts(f.projectId);
    const beforeOverview = await loopbackApp!.onboardingService.getProjectOverview(owner, f.projectId);
    const beforeHostOverview = await f.client.getProjectOverview(f.projectId);
    const { readAt: _beforeHostReadAt, ...beforeHostOverviewFacts } = beforeHostOverview;
    const { readAt: _beforeReadAt, ...beforeOverviewFacts } = beforeOverview;
    const direct = await loopbackApp!.baselineQueryService.compareBaselines(owner, previousOperationId, currentOperationId);
    const viaHost = await f.client.compareBaselines(previousOperationId, currentOperationId);
    expect(viaHost).toEqual(direct);
    expect(viaHost.previous.operationId).toBe(previousOperationId);
    expect(viaHost.current.operationId).toBe(currentOperationId);
    expect(loopbackApp!.baselineStore.listBaselineOperations(f.projectId, { limit: 100 })).toEqual(beforeOperations);
    expect(await loopbackApp!.artifactStore.listArtifacts(f.projectId)).toEqual(beforeArtifacts);
    const afterOverview = await loopbackApp!.onboardingService.getProjectOverview(owner, f.projectId);
    const afterHostOverview = await f.client.getProjectOverview(f.projectId);
    const { readAt: _afterReadAt, ...afterOverviewFacts } = afterOverview;
    const { readAt: _afterHostReadAt, ...afterHostOverviewFacts } = afterHostOverview;
    expect(afterOverviewFacts).toEqual(beforeOverviewFacts);
    expect(afterHostOverviewFacts).toEqual(beforeHostOverviewFacts);
  }, 60_000);
});
