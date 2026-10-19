import { createExecutionService } from '../../../packages/core/src/application/execution-service.ts';
import { createRuntimeExecutionService } from '../../../packages/core/src/application/runtime-execution.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken, type FakeRuntimeOptions } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createStaticRuntimeRegistry } from '../../../packages/core/src/ports/runtime-registry.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeAdapter, RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import { openBindingFixture, BINDING_NOW, type BindingFixture, type ClaimedAttempt } from '../p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../p03-6/evidence-fixture.ts';
import type { WorkEvidenceRecorderLimits } from '../../../packages/core/src/ports/work-evidence-recorder.ts';

export interface RuntimeNegativeFixture extends BindingFixture {
  readonly sessions: ReturnType<typeof createSqliteWorkSessionStore>;
  readonly lifecycle: ReturnType<typeof createSqliteAttemptLifecycleStore>;
  readonly settlement: ReturnType<typeof createRuntimeSettlementService>;
  readonly service: ReturnType<typeof createExecutionService>;
  readonly claim: ClaimedAttempt;
  starts(): number;
  start(): ReturnType<ReturnType<typeof createExecutionService>['start']>;
  json(artifactId: string): Promise<ReturnType<typeof JSON.parse>>;
}

/** Real claim, launch debit, Session, Recorder and fenced settlement; no network/SDK. */
export async function openRuntimeNegativeFixture(options: Partial<FakeRuntimeOptions> = {},
  wrap: (adapter: RuntimeAdapter) => RuntimeAdapter = adapter => adapter,
  evidence: { secrets?: readonly string[]; limits?: Partial<WorkEvidenceRecorderLimits> } = {}): Promise<RuntimeNegativeFixture> {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  try {
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
    const lifecycle = createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW });
    const attempts = createSqliteAttemptAccess(f.session);
    const dag = createSqliteTaskDagStore(f.session);
    const settlement = createRuntimeSettlementService({ lifecycle, attempts, dag, publisher: f.publisher, secrets: evidence.secrets });
    const fake = createFakeRuntime({
      script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'retained.txt', content: 'retained progress\n' }] },
      workspaceRoots: { 'workspace-root': f.box.root },
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      nowUtcMs: () => BINDING_NOW, ...options,
    });
    const configuration = createStaticRuntimeCapabilityCatalog([{
      runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    }]);
    let starts = 0;
    const adapter = wrap(fake.adapter);
    const runtime = createRuntimeExecutionService({ configuration, registry: createStaticRuntimeRegistry([{
      descriptor: fake.descriptor, adapter: { start(request: RuntimeExecutionRequest) { starts++; return adapter.start(request); } },
    }], configuration) });
    const service = createExecutionService({
      atomic: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => BINDING_NOW }),
      resources: f.createResources(), sessions, inputBinding: f.bindingService, runtime, dag, attempts, settlement,
      recorder: createWorkEvidenceRecorder({ publisher: f.publisher, verifier: f.verifier, sessions, secrets: evidence.secrets,
        limits: { ...DEFAULT_RECORDER_LIMITS, tailWaitMs: 50, ...evidence.limits } }),
      eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`, nowUtcMs: () => BINDING_NOW,
    });
    const claim = f.claimTask('t-1');
    return { ...f, sessions, lifecycle, settlement, service, claim, starts: () => starts,
      start: () => service.start(f.bindingInput(claim)),
      async json(artifactId: string) {
        const artifact = await f.verifier.readVerifiedContent(f.projectId, artifactId);
        return JSON.parse(Buffer.from(artifact.content).toString('utf8'));
      },
    };
  } catch (error) { f.close(); throw error; }
}
