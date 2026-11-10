import { expect, it, vi } from 'vitest';
import { createNodeIntegrationVerificationExecutor } from '../../../packages/core/src/adapters/integration-verification.ts';
import type { IntegrationVerificationExecutionInput } from '../../../packages/core/src/ports/integration-verification.ts';
import type { ArtifactPublishResult } from '../../../packages/core/src/application/artifact-publish.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';

const state = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock('../../../packages/core/src/application/baseline-evidence.ts', () => ({
  BASELINE_OUTPUT_MAX_BYTES: 8388608,
  createBaselineEvidenceCollector: () => ({ collect: state.collect }),
}));

function fixture() {
  state.collect.mockReset();
  const input = { projectId: 'project', operationId: 'operation', sourcePlanId: 'source', targetBaseline: 'a'.repeat(40),
    inputDigest: 'b'.repeat(64), targets: ['tests'],
    workspace: { path: '/managed/integration', gitCommonDir: '/source/.git', repoIdentity: 'repo', currentHead: 'c'.repeat(40),
      targetBase: 'a'.repeat(40), facts: { head: 'c'.repeat(40), tree: 'd'.repeat(40), statusPorcelain: '', unresolvedPaths: [] },
      plan: { integrationId: 'integration', predecessors: [{ delivery: { commitSha: 'e'.repeat(40) } }] } },
    plan: { status: 'ready', selectedCheckKeys: ['tests'], selectedChecks: [{ checkKey: 'tests', kind: 'command', argv: ['node', 'tests.mjs'],
      cwdRef: null, environmentRef: null, timeout: 1000, required: true }] },
  } as unknown as IntegrationVerificationExecutionInput;
  const identity = { launchId: 'launch', pid: 1, processGroupId: 1, startTime: 'os-start' };
  const handle = { identity, output: (async function* () { yield { stream: 'stdout', bytes: Buffer.from('SHIPLOOP_NODE_CHECK_RESULT={"schemaVersion":1,"protocol":"shiploop.node-check","collected":true,"testCount":1,"targets":["tests"]}\n') }; })(),
    cancel: vi.fn(async () => ({ accepted: true })), result: Promise.resolve({}), stopped: Promise.resolve({ confirmed: true }) };
  const start = vi.fn(async (_request, confirm) => { await confirm(identity); return handle; });
  const confirmProcessIdentity = vi.fn(async () => ({ launchId: 'launch' }));
  const authorize = vi.fn(async () => ({ deadlineUtcMs: 2000, bindingId: 'binding', bindingRevision: 1 }));
  const git = { facts: vi.fn(async () => ({ head: input.workspace.currentHead, tree: input.workspace.facts.tree })),
    stagedPaths: vi.fn(async () => []), unstagedPaths: vi.fn(async () => []), isAncestor: vi.fn(async () => true) };
  const publishArtifact = vi.fn(async (value) => ({ artifact: { id: `artifact-${value.kind}`, projectId: value.projectId,
    status: 'ready', contentHash: value.expectedHash }, finalRelativePath: value.locator } as unknown as ArtifactPublishResult));
  const inspection = { repository: { headCommit: input.workspace.currentHead, canonicalPath: input.workspace.path,
    gitCommonDir: input.workspace.gitCommonDir, repoIdentity: input.workspace.repoIdentity }, statusPorcelainBase64: '',
    codeDigest: '1'.repeat(64), ignoredDigest: '2'.repeat(64), contents: { tracked: [], untracked: [], ignored: [], directories: [] } } as unknown as WorkspaceInspection;
  const inspector = { inspect: vi.fn(async () => inspection) };
  const deps = { processes: { start } as never, artifacts: {} as never, files: {} as never, inspector,
    publisher: { publishArtifact }, driverFor: vi.fn(() => ({ open: vi.fn(() => git) })) as never,
    authorize, confirmProcessIdentity, resolveCwd: vi.fn(async () => '/managed/integration'),
    resolveEnvironment: vi.fn(() => ({})), assertOutsideTransaction: vi.fn(), nowUtcMs: () => 1000 };
  state.collect.mockImplementation(async ({ handle }) => {
    for await (const _ of handle.output) { /* one bounded consumer */ }
    return { eligibleForPass: true, stopConfirmed: true, exitCode: 0, signal: null, processReason: null,
      integrity: { complete: true }, report: { artifactId: 'report', contentHash: 'f'.repeat(64) },
      output: { artifactId: 'output', contentHash: 'f'.repeat(64) } };
  });
  return { input, deps, git, start, handle, authorize, publishArtifact, confirmProcessIdentity, inspection, inspector };
}

it('[case:integration-node-exec-evidence] executes confirmed checks, confirms launch and publishes separate plan/result evidence', async () => {
  const f = fixture();
  const result = await createNodeIntegrationVerificationExecutor(f.deps).start(f.input);
  expect(result).toMatchObject({ status: 'passed', stopped: true, commitSha: f.input.workspace.currentHead,
    inputDigest: f.input.inputDigest, verificationPlan: { id: 'artifact-integration-verification-plan' },
    verificationResult: { id: 'artifact-integration-verification-result' } });
  expect(f.confirmProcessIdentity).toHaveBeenCalledOnce();
  expect(f.start.mock.calls[0]![0]).toMatchObject({ argv: ['node', 'tests.mjs'], cwd: '/managed/integration', timeoutMs: 1000 });
  expect(f.git.isAncestor).toHaveBeenCalledWith('e'.repeat(40), f.input.workspace.currentHead);
  expect(f.publishArtifact).toHaveBeenCalledTimes(2);
  expect(state.collect).toHaveBeenCalledWith(expect.objectContaining({
    codeIdentity: { headCommit: f.input.workspace.currentHead, workingTreeDigest: f.inspection.codeDigest, hasUncommittedChanges: false },
  }));
});

it('[case:integration-node-exec-fences] refuses revoked authorization, expired budget, changed Git and incomplete coverage before checks', async () => {
  for (const mode of ['authority', 'deadline', 'head', 'coverage']) {
    const f = fixture();
    if (mode === 'authority') f.authorize.mockRejectedValue(new Error('revoked'));
    if (mode === 'deadline') f.authorize.mockResolvedValue({ deadlineUtcMs: 1000, bindingId: 'binding', bindingRevision: 1 });
    if (mode === 'head') f.git.facts.mockResolvedValue({ head: 'f'.repeat(40), tree: f.input.workspace.facts.tree });
    if (mode === 'coverage') f.git.isAncestor.mockResolvedValue(false);
    await expect(createNodeIntegrationVerificationExecutor(f.deps).start(f.input)).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
  }
});

it('[case:integration-node-exec-stop] unknown stop never produces passing evidence or starts the next check', async () => {
  const f = fixture();
  state.collect.mockImplementation(async ({ handle }) => {
    for await (const _ of handle.output) {}
    return { eligibleForPass: false, stopConfirmed: false, exitCode: 0, signal: null, integrity: { complete: false } };
  });
  const input = { ...f.input, targets: ['tests', 'build'], plan: { ...f.input.plan,
    selectedCheckKeys: ['tests', 'build'], selectedChecks: [...f.input.plan.selectedChecks,
      { ...f.input.plan.selectedChecks[0]!, checkKey: 'build' }] } };
  const result = await createNodeIntegrationVerificationExecutor(f.deps).start(input);
  expect(result).toMatchObject({ status: 'inconclusive', stopped: false });
  expect(f.start).toHaveBeenCalledOnce();
});

it('[case:integration-node-exec-stop-disagreement] process result stop evidence cannot override an unconfirmed stopped channel', async () => {
  const f = fixture();
  f.handle.stopped = Promise.resolve({ confirmed: false });
  const result = await createNodeIntegrationVerificationExecutor(f.deps).start(f.input);
  expect(result).toMatchObject({ status: 'inconclusive', stopped: false });
});

it('[case:integration-node-exec-cancel] cancelled admission never starts a verifier', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  await expect(createNodeIntegrationVerificationExecutor({ ...f.deps, signal: controller.signal }).start(f.input)).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it('[case:integration-node-exec-check-failure] a nonzero check with complete evidence stays failed', async () => {
  const f = fixture();
  const capture = state.collect.getMockImplementation()!;
  state.collect.mockImplementation(async input => ({ ...await capture(input), eligibleForPass: false, exitCode: 1 }));
  expect(await createNodeIntegrationVerificationExecutor(f.deps).start(f.input)).toMatchObject({ status: 'failed', stopped: true });
});

it('[case:integration-node-exec-mutated-source] rejects workspace mutation during checks before publishing a result', async () => {
  const f = fixture();
  const capture = state.collect.getMockImplementation()!;
  state.collect.mockImplementation(async input => {
    const output = await capture(input);
    f.git.facts.mockResolvedValue({ head: 'f'.repeat(40), tree: f.input.workspace.facts.tree });
    return output;
  });
  await expect(createNodeIntegrationVerificationExecutor(f.deps).start(f.input)).rejects.toMatchObject({ details: { reason: 'source_changed' } });
  expect(f.publishArtifact).toHaveBeenCalledTimes(1);
});

it('[case:integration-node-exec-plan-coverage] refuses omitted check targets and never publishes a plan', async () => {
  const f = fixture();
  await expect(createNodeIntegrationVerificationExecutor(f.deps).start({ ...f.input, targets: ['unselected'] })).rejects.toMatchObject({ details: { reason: 'verification_plan_unavailable' } });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.publishArtifact).not.toHaveBeenCalled();
});

it('[case:integration-node-exec-same-path-mutation] changed bytes on the same path or ignored content invalidate checked code identity', async () => {
  const f = fixture();
  const capture = state.collect.getMockImplementation()!;
  state.collect.mockImplementation(async input => {
    const output = await capture(input);
    f.inspector.inspect.mockResolvedValue({ ...f.inspection, ignoredDigest: '3'.repeat(64) });
    return output;
  });
  await expect(createNodeIntegrationVerificationExecutor(f.deps).start(f.input)).rejects.toMatchObject({ details: { reason: 'source_changed' } });
  expect(f.publishArtifact).toHaveBeenCalledTimes(1);
});

it('[case:integration-node-exec-evidence-publication] a missing or mismatched Artifact publication prevents process launch', async () => {
  const f = fixture();
  f.publishArtifact.mockResolvedValue({ artifact: { projectId: 'foreign', id: 'wrong', status: 'ready', contentHash: 'f'.repeat(64) } } as unknown as ArtifactPublishResult);
  await expect(createNodeIntegrationVerificationExecutor(f.deps).start(f.input)).rejects.toMatchObject({ details: { reason: 'verification_evidence_incomplete' } });
  expect(f.start).not.toHaveBeenCalled();
});
