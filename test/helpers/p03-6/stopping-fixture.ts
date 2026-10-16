import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle } from '../../../packages/core/src/ports/command-process.ts';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createExecutionWorkspaceRetainer } from '../../../packages/core/src/application/execution-workspace-retention.ts';
import { createWorkspaceRetentionService } from '../../../packages/core/src/application/workspace-retention.ts';
import { createSqliteWorkspaceRetentionStore } from '../../../packages/core/src/adapters/sqlite/workspace-retention.ts';
import { createSqliteWorkspaceAccess } from '../../../packages/core/src/adapters/sqlite/workspace.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createCompletedReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createResultRef } from '../../../packages/core/src/ports/command-receipts.ts';
import { git } from '../git-repo.ts';
import { expect, vi, type Mock } from 'vitest';
import type { BindingFixture } from './input-binding-fixture.ts';
import type { ExecutionService, ExecutionServiceResult, ExecutionRetentionInput } from '../../../packages/core/src/application/execution-service.ts';
import type { WorkResourceAccess, WorkResourceIdentity } from '../../../packages/core/src/ports/work-resources.ts';
import type { WorkspaceOperationAccess } from '../../../packages/core/src/ports/workspace.ts';
import type { RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { CommandProcessPort } from '../../../packages/core/src/ports/command-process.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createExecutionService, type ExecutionServiceDeps } from '../../../packages/core/src/application/execution-service.ts';
import { createRuntimeExecutionService } from '../../../packages/core/src/application/runtime-execution.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createFakeRuntime, createFakeRuntimeGate, fakeRuntimeCorrelationToken, type FakeRuntimeOptions } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createStaticRuntimeRegistry } from '../../../packages/core/src/ports/runtime-registry.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openBindingFixture, BINDING_NOW } from './input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from './evidence-fixture.ts';

export interface StoppingFixture extends BindingFixture {
  readonly service: ExecutionService;
  readonly deps: ExecutionServiceDeps;
  readonly identity: WorkResourceIdentity;
  readonly retain: Mock<(input: ExecutionRetentionInput) => Promise<void>>;
  readonly cancel: Mock<() => void>;
  readonly resources: WorkResourceAccess;
  readonly workspaces: WorkspaceOperationAccess;
  readonly rawHandles: RuntimeHandle[];
  readonly processes: CommandProcessHandle[];
  readonly processPort: CommandProcessPort;
  readArtifact(artifactId: string): Promise<any>;
  dispose(): Promise<void>;
  start(extra?: Record<string, unknown>): Promise<ExecutionServiceResult>;
}

export async function fixture(options: Partial<FakeRuntimeOptions> = {}, override: Partial<ExecutionServiceDeps> = {},
  setup?: (f: BindingFixture, deps: ExecutionServiceDeps) => void, taskId: 't-1' | 't-2' = 't-1'): Promise<StoppingFixture> {
  const f = await openBindingFixture({ secondTask: taskId === 't-2' });
  const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
  const attempts = createSqliteAttemptAccess(f.session), dag = createSqliteTaskDagStore(f.session);
  const settlement = createRuntimeSettlementService({ publisher: f.publisher, attempts, dag,
    lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }) });
  const processPort = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2_000 });
  const processes: CommandProcessHandle[] = [];
  const fake = createFakeRuntime({ commandProcess: { ...processPort, start: async (request, confirm) => {
      const handle = await processPort.start(request, confirm); processes.push(handle); return handle;
    } }, commitCommandIdentity: async (processIdentity, context) => {
      f.session.transactWrite('test.commit-tool', () => f.createResources().confirmLaunchInTransaction({ projectId: f.projectId,
        attemptId: context.attemptId!, owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1 }, processIdentity));
      return { launchId: processIdentity.launchId };
    }, script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hang' }] },
    gates: { hang: createFakeRuntimeGate() }, workspaceRoots: { 'workspace-root': f.box.root },
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }], nowUtcMs: () => BINDING_NOW, ...options });
  const rawHandles: Awaited<ReturnType<typeof fake.adapter.start>>[] = [];
  const cancel = vi.fn<() => void>();
  const configuration = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]);
  const runtime = createRuntimeExecutionService({ configuration, registry: createStaticRuntimeRegistry([
    { descriptor: fake.descriptor, adapter: { async start(request: RuntimeExecutionRequest) {
      const handle = await fake.adapter.start(request);
      rawHandles.push(handle);
      return { ...handle, cancel: async () => { cancel(); return handle.cancel(); } };
    } } },
  ], configuration) });
  const retain = vi.fn(async (_input: import('../../../packages/core/src/application/execution-service.ts').ExecutionRetentionInput): Promise<void> => {});
  const deps: ExecutionServiceDeps = { atomic: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => BINDING_NOW }),
    resources: f.createResources(), sessions, attempts, dag, settlement, runtime, inputBinding: f.bindingService,
    recorder: createWorkEvidenceRecorder({ publisher: f.publisher, verifier: f.verifier, sessions, limits: DEFAULT_RECORDER_LIMITS }),
    eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`, nowUtcMs: () => BINDING_NOW,
    supervision: { stopWaitMs: 3_000, drainWaitMs: 200, closeWaitMs: 5_000, retain }, ...override };
  setup?.(f, deps);
  const service = createExecutionService(deps);
  const resources = createSqliteWorkResourceAccess(f.session, { workspaceAuthority: f.authority, stopVerifier: service.stopVerifier, nowUtcMs: () => BINDING_NOW });
  const workspaces = createSqliteWorkspaceAccess(f.session, { resources, nowUtcMs: () => BINDING_NOW });
  const retention = createWorkspaceRetentionService({
    stopVerifier: service.stopVerifier,
    store: createSqliteWorkspaceRetentionStore(f.session, { resources, workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }),
    publishEvidence: async (projectId, operationId, evidence) => {
      const body = Buffer.from(JSON.stringify(evidence));
      return (await f.publisher.publishArtifact({ projectId, kind: 'workspace_evidence', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${operationId}.json`, content: [body] })).artifact.id;
    },
  });
  retain.mockImplementation(createExecutionWorkspaceRetainer({ workspaces, retention }));
  const claim = f.claimTask(taskId);
  const identity = { projectId: f.projectId, attemptId: claim.receipt.attempt.id, owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1 };
  const operationId = randomUUID(), workspaceId = randomUUID();
  const receipt = (step: string) => createCompletedReceipt({ commandId: randomUUID(), principalId: 'test-prepare', operation: 'execution.start',
    scope: { kind: 'project', projectId: f.projectId }, requestDigest: 'a'.repeat(64), issuedAt: new Date(BINDING_NOW).toISOString(),
    completedAt: new Date(BINDING_NOW).toISOString(), result: { step }, resultRef: createResultRef(randomBytes(32)) });
  f.session.transactWrite('test.prepare', () => {
    const binding = f.workspace.binding;
    const begin = workspaces.beginInTransaction({ identity, operationId, workspaceId, featureId: f.featureId, kind: 'prepare',
      executionStage: 'preflight', expectedWorkspaceRevision: null, baseline: { repositoryBindingId: binding.id,
        repositoryBindingRevision: binding.revision, repoIdentity: binding.repoIdentity, canonicalPath: f.workspace.canonicalPath,
        gitCommonDir: binding.gitCommonDir, branch: git(['branch', '--show-current'], f.workspace.canonicalPath).trim(),
        baseCommit: git(['rev-parse', 'HEAD'], f.workspace.canonicalPath).trim() }, receipt: receipt('begin') });
    workspaces.finishInTransaction({ identity, operationId, expectedRevision: begin.operation.revision,
      expectedWorkspaceRevision: begin.workspace.revision, status: 'succeeded', workspaceStatus: 'ready', headCommit: null, codeDigest: null,
      result: { evidenceRefs: [f.requirementArtifactId], errorRef: null, startedAtUtcMs: BINDING_NOW, endedAtUtcMs: BINDING_NOW,
        durationMs: null, exitCode: null, signal: null }, receipt: receipt('finish') });
  });
  const readArtifact = async (artifactId: string) => {
    const verified = await f.verifier.readVerifiedContent(f.projectId, artifactId);
    return JSON.parse(Buffer.from(verified.content).toString());
  };
  return { ...f, service, deps, retain, cancel, identity, resources, workspaces, rawHandles, readArtifact, processes, processPort,
    async dispose() {
      await service.close();
      for (const handle of rawHandles) await handle.cancel();
      await Promise.all(rawHandles.map(handle => handle.stopped));
      for (const handle of processes) {
        await handle.cancel();
        const stop = await processPort.recoverStop!(handle.identity);
        expect(stop.confirmed).toBe(true);
      }
      f.close();
    },
    start: (extra = {}) => service.start(f.bindingInput(claim, extra)) };
}
