import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareEligibleFixture } from '../../../helpers/p03-9/finalization-retry-fixture.ts';
import { bindEvidenceToCurrentSource } from '../../../helpers/p03-9/finalization-host.ts';
import { createIsolatedHostEnvironment } from '../../../helpers/host/isolated-environment.ts';
import { createWorkspaceInspector } from '../../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { git } from '../../../helpers/git-repo.ts';
import { NOW } from '../../../helpers/p03-3/budget-fixture.ts';
import type { FinalizationCommitRequest } from '../../../../packages/core/src/ports/finalization-completion.ts';

const childPath = fileURLToPath(new URL('../../../helpers/p07-1/final-commit-host-child.ts', import.meta.url));

describe.skipIf(process.platform !== 'darwin')('P07 F-007 Feature final commit Host recovery', () => {
  it('[case:feature-host-restart] repairs the real Feature receipt after Host SIGKILL with the original artifact, once only', async () => {
    const f = await prepareEligibleFixture();
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-p07-final-' });
    try {
      await bindEvidenceToCurrentSource(f, 'export const project = "f007-feature";\n');
      const a = f.box.session.database.prepare('SELECT * FROM attempts ORDER BY number DESC LIMIT 1').get() as Record<string, any>;
      const repo = f.inspection.repository;
      const baseline = { repositoryBindingId: repo.repositoryBindingId, repositoryBindingRevision: repo.repositoryBindingRevision,
        canonicalPath: repo.canonicalPath, repoIdentity: repo.repoIdentity, gitCommonDir: repo.gitCommonDir,
        branch: repo.branch, baseCommit: repo.baseCommit };
      const inspection = await createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: async identity => identity }).inspect(baseline);
      const request: FinalizationCommitRequest = {
        projectId: f.box.projectId, featureId: f.box.featureId, runId: a.run_id, operationId: randomUUID(),
        expectedHead: inspection.repository.headCommit, codeDigest: inspection.codeDigest,
        planDigest: JSON.parse(a.input_snapshot).approval.planDigest,
        checkPolicyDigest: JSON.parse(a.input_snapshot).approval.checkPolicyDigest,
        workspaceId: f.workspaceId, workspaceRevision: 1,
        verificationRefs: [{ kind: 'verification_batch', id: (f.box.session.database.prepare('SELECT id FROM verification_batches ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id, digest: inspection.codeDigest }],
        approvalRefs: [{ kind: 'human_approval', id: f.approvalId, digest: inspection.codeDigest }],
        baseline, attempt: { attemptId: a.id, owner: a.owner_id, hostInstanceId: a.host_instance_id, executionVersion: a.execution_version },
        message: 'Feature final verified delivery', gitIdentity: { name: 'F007 Owner', email: 'f007@example.test', confirmed: true },
        deliveryPolicyDigest: 'a'.repeat(64),
      };
      const config = { dataRoot: f.box.box.dataRoot, dbPath: f.box.box.dbPath, fixtureRoot: f.box.box.root, request, nowMs: NOW };
      async function spawn(label: string, reconcile = false) {
        const child = env.processes.spawn({ scriptPath: childPath, config: { ...config, reconcile }, label,
          cwd: env.sandboxRoot, env: env.childEnv(), requireInside: env.sandboxRoot });
        await child.waitReady(30_000); child.releaseGo();
        return child;
      }
      const before = Number(git(['rev-list', '--count', 'HEAD'], baseline.canonicalPath).trim());
      const first = await spawn('feature-before-crash');
      const landed = await first.waitMessage('feature_commit_landed', 60_000);
      const head = (landed.facts as { head: string }).head;
      expect(f.box.session.database.prepare('SELECT status, actual_commit FROM git_operations WHERE id = ?').get(request.operationId))
        .toEqual({ status: 'pending', actual_commit: null });
      const claim = join(baseline.gitCommonDir, 'shiploop-baseline.claim');
      expect(JSON.parse(readFileSync(claim, 'utf8')).operationId).toBe(request.operationId);
      expect(first.kill('SIGKILL')).toBe(true);
      expect((await first.exited).signal).toBe('SIGKILL');
      const restart = await spawn('feature-reconcile', true);
      const message = await restart.waitMessage('feature_result', 60_000);
      expect(message.result).toMatchObject({ outcome: 'matched', operation: { status: 'succeeded', actualCommit: head,
        exitCode: null, durationMs: null, intent: { operationId: request.operationId } } });
      restart.send({ kind: 'close' });
      expect((await restart.exited).code).toBe(0);
      const again = await spawn('feature-terminal-replay', true);
      expect((await again.waitMessage('feature_result', 60_000)).result).toEqual(message.result);
      again.send({ kind: 'close' });
      expect((await again.exited).code).toBe(0);
      expect(Number(git(['rev-list', '--count', 'HEAD'], baseline.canonicalPath).trim())).toBe(before + 1);
      expect(existsSync(claim)).toBe(false);
      expect(f.box.session.database.prepare("SELECT COUNT(*) AS n FROM state_events WHERE aggregate_id = ? AND event_type = 'git.operation.settled'").get(request.operationId)).toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${(error as { stderrTail?: string }).stderrTail ?? ''}`, { cause: error });
    } finally { await env.dispose(); f.box.close(); }
  }, 150_000);
});
