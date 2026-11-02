import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';
import { BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createFeatureNodeVerificationExecutor } from '../../../packages/core/src/application/node-task-verification.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { verifyStoredVerificationOutputs } from '../../../packages/core/src/application/verification-output-evidence.ts';
import { createFeatureCloseoutVerifier } from '../../../packages/core/src/application/feature-closeout-verifier.ts';
import { computeFeatureCheckPolicyDigest } from '../../../packages/core/src/ports/plan-approval-verification.ts';

it('runs only the approved Feature command and persists verifiable real output without new coding Attempts', async () => {
  // This existing fixture explicitly reserves final resources. It is not proof
  // that default Host resource acquisition or automatic handoff is assembled.
  const f = await openDeliveryVertical({ confirmProjectProfile: true });
  try {
    const before = f.counts();
    const attemptsBefore = f.db.prepare('SELECT COUNT(*) AS n FROM attempts').get();
    const key = { projectId: f.fixture.projectId, featureId: f.fixture.featureId, runId: f.fixture.runId, inputDigest: 'a'.repeat(64) };
    const base = { kind: 'command' as const, cwdRef: null, environmentRef: null, timeout: 5000, required: true, requirementRefs: [] };
    const policy = { checkDefinitions: [
      { ...base, checkKey: 'unit', scope: 'module' as const, argv: [process.execPath, '-e',
        `const fs=require('node:fs');if(fs.readFileSync('README.md','utf8')!=='downstream\\n')process.exitCode=1;console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:1,targets:['unit']}));`] },
      { ...base, checkKey: 'all', scope: 'project' as const, argv: [process.execPath, '-e', 'process.exit(99)'] },
    ], fullFallback: { checkRefs: ['all'] }, featureChecks: ['unit'] };
    const processes = createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1000 });
    const verification = createSqliteVerificationStore(f.fixture.session, { nowUtcMs: () => BINDING_NOW });
    let starts = 0;
    const execute = createFeatureNodeVerificationExecutor({
      processes: { start: async (...args) => { starts++; return processes.start(...args); } },
      atomic: createSqliteAtomicCommandStore(f.fixture.session), verification,
      artifacts: f.core.artifactStore, files: f.core.artifactFileStore,
      resolveCwd: async () => f.root, resolveEnvironment: () => ({}),
      confirmProcessIdentity: async () => {}, nowUtcMs: () => BINDING_NOW,
      resolveFeatureAttempt: () => ({ taskId: 't-2', attemptId: f.resourceIdentity.attemptId }),
    });
    let executionFailure: unknown;
    const verifier = createFeatureCloseoutVerifier({
      prepare: async () => ({ inputDigest: key.inputDigest, checkKeys: ['unit'], input: { ...key, batchId: randomUUID(), executionVersion: f.resourceIdentity.executionVersion,
        resourceIdentity: f.resourceIdentity, workspaceBaseline: f.baseline, policy, policyDigest: computeFeatureCheckPolicyDigest(policy), environmentSummary: {}, targets: ['unit'] } }),
      verifyEvidence: async (projectId, batchId) => { await verifyStoredVerificationOutputs({ verification: f.core.verificationStore,
        artifacts: f.core.artifactStore, files: f.core.artifactFileStore }, projectId, batchId); return true; },
      coordinator: {
        taskDag: { evaluate: () => ({ projectId: key.projectId, featureId: key.featureId, runId: key.runId,
          reason: (f.db.prepare("SELECT id FROM tasks WHERE feature_id=? AND status<>'passed'").get(key.featureId) ? 'dependency_pending' : 'all_passed'),
          handoff: 'feature_final_verification' }) },
        resources: f.core.workResources, stopVerifier: createWorkResourceStopVerifier({ process: processes, finalize: async () => true }),
        workspace: createWorkspaceInspector({ authorizedRoots: [f.fixture.box.root], confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) }),
        execute: { start: async input => { try { return await execute.start(input); } catch (error) { executionFailure = error; throw error; } } },
        withResource: async (_identity, run) => { expect(f.core.workResources.read(f.resourceIdentity).leases).toHaveLength(3); return run(); },
      },
    });
    const result = await verifier.verify(key).catch(error => { throw executionFailure ?? error; });
    expect(result).toMatchObject({ passed: true, reason: 'verified' });
    expect(starts).toBe(1);
    expect(f.core.verificationStore.getVerificationBatch(key.projectId, result.evidenceRef).status).toBe('passed');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual(attemptsBefore);
    expect(f.counts()).toEqual(before);
  } finally { await f.close(); }
}, 90_000);
