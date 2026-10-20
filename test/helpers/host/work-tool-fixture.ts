import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkToolChannel } from '../../../packages/core/src/application/work-tool-channel.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { openClaimFixture } from '../p03-4/task-claim-fixture.ts';
import { NOW } from '../p03-3/budget-fixture.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createVerificationCandidateValidator } from '../../../packages/core/src/application/verification-candidates.ts';
import { createTestTargetResolver } from '../../../packages/core/src/adapters/fs/verification-target-resolver.ts';
import type { VerifiedArtifactContent } from '../../../packages/core/src/application/artifact-verify.ts';
import type { WorkAccessOperation } from '../../../packages/core/src/ports/work-access.ts';

export const CODE_DIGEST = 'ab'.repeat(32);
const POLICY = {
  requireChecksBeforeDone: true,
  checkDefinitions: [{ checkKey: 'unit-core', scope: 'module', kind: 'command', argv: ['node', 'test.js'],
    cwdRef: null, environmentRef: null, timeout: 120_000, required: true, requirementRefs: [] }],
  modules: [{ moduleKey: 'core', allowedTargets: ['packages/core'], impactScope: ['packages/core'], sharedHighRiskFiles: [] }],
  fullFallback: { checkRefs: ['unit-core'] },
};

export async function openWorkToolFixture(options: {
  operations?: WorkAccessOperation[];
  composed?: boolean;
  restrictedPrincipal?: boolean;
  afterRead?: (content: VerifiedArtifactContent) => Promise<void>;
} = {}) {
  const f = await openClaimFixture();
  try {
    const claim = f.store().claimTask(f.input());
    const attempt = claim.receipt.attempt;
    const binding = {
      principal: options.restrictedPrincipal ? {
        principalId: 'work-agent', capabilities: new Set<'project.read'>(['project.read']),
        projectScope: { kind: 'allowlist' as const, projectIds: [f.ids.projectId] },
      } : createLocalOwnerPrincipal(), projectId: f.ids.projectId, hostInstanceId: 'host-1',
      identity: { purpose: 'work' as const, runId: f.ids.runId, taskId: f.ids.taskId, attemptId: attempt.id },
      invocationId: 'invocation-1', executionVersion: attempt.executionVersion, nowUtcMs: NOW,
      strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
    };
    f.box.session.database.prepare("UPDATE attempts SET status='executing', invocation_id=? WHERE id=?")
      .run(binding.invocationId, attempt.id);
    f.box.session.database.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.ids.runId);
    f.box.session.database.prepare("UPDATE execution_batches SET status='running' WHERE id=?").run(f.ids.batchId);
    let current: typeof binding | null = binding;
    const access = {
      schemaVersion: 1, context: {
        grantId: randomUUID(), principalId: binding.principal.principalId, projectId: binding.projectId,
        hostInstanceId: binding.hostInstanceId, identity: binding.identity, invocationId: binding.invocationId,
        executionVersion: binding.executionVersion, issuedAtUtcMs: NOW - 100, expiresAtUtcMs: NOW + 1000,
        operations: options.operations ?? ['task.read', 'candidate.submit', 'evidence.submit'],
      },
      runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet',
      authentication: { kind: 'local_login', sourceRef: randomUUID(), pluginId: null, environmentRefs: [] }, resources: [],
    };
    const attempts = createSqliteAttemptAccess(f.box.session);
    const artifacts = createSqliteArtifactStore(f.box.session, { nowUtcMs: () => NOW });
    const files = createArtifactFileStore({ dataRoot: f.box.box.dataRoot });
    const publisher = createArtifactPublisher({ artifacts, files, limits: { maxSizeBytes: 1_000_000, timeoutMs: 10_000 }, nowMs: () => NOW });
    const verifier = createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_000_000 }, nowMs: () => NOW });
    const workspaceRoot = join(f.box.box.root, 'candidate-workspace');
    mkdirSync(join(workspaceRoot, 'packages/core'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'packages/core/test.ts'), 'test');
    const authority = {
      currentBinding: () => current,
      candidateContext: () => ({ policy: POLICY, workspaceRoot, codeDigest: CODE_DIGEST }),
    };
    const channel = options.composed ? (await f.box.box.openApplication()).createWorkToolChannel(authority) : createWorkToolChannel({
      ...authority,
      atomicStore: f.box.services.atomic, attempts, dag: createSqliteTaskDagStore(f.box.session),
      candidates: createVerificationCandidateValidator({ attempts, verifier, resolver: createTestTargetResolver() }),
      verifier: { readVerifiedContent: async (projectId, artifactId) => {
        const content = await verifier.readVerifiedContent(projectId, artifactId);
        await options.afterRead?.(content);
        return content;
      } },
    });
    const bridge = channel.bind(access, binding);
    const request = (operation = 'task.read', payload: Record<string, unknown> = {}) => ({
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
      operation, scope: { kind: 'project', projectId: binding.projectId },
      payload: { identity: binding.identity, invocationId: binding.invocationId, executionVersion: binding.executionVersion, ...payload },
    });
    const publish = async (value: unknown, projectId = binding.projectId) => {
      const body = Buffer.from(JSON.stringify(value));
      return (await publisher.publishArtifact({ projectId, kind: 'work-submission', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'), locator: `work/${randomUUID()}.json`, content: [body] })).artifact.id;
    };
    const candidate = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, projectId: binding.projectId,
      attemptId: binding.identity.attemptId, executionVersion: binding.executionVersion, codeDigest: CODE_DIGEST,
      modules: [{ moduleKey: 'core', targets: ['packages/core/test.ts'], reason: 'core changed' }], ...overrides });
    const snapshot = () => ({ ...f.snapshot(), ...f.box.snapshot() });
    return { f, channel, bridge, binding, access, request, publish, candidate, artifacts, files,
      snapshot, setCurrent: (value: typeof binding | null) => { current = value; }, close: () => f.box.close() };
  } catch (error) { f.box.close(); throw error; }
}
