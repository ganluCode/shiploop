/** F-011: fixed operation, durable checkpoints, supervised non-forced Git removal. */
import { createHash } from 'node:crypto';
import { PublicError } from '../ports/commands.js';
import { stableStringify } from '../ports/feature-plan.js';
import { rejectUnknownKeys, requirePlainObject } from '../ports/validation.js';
import type { ProjectDeleteStore, ProjectDeleteStep } from '../ports/project-delete.js';
import type { ProjectDeleteExecutor, ProjectDeleteFilePlan, ProjectDeleteFiles } from '../ports/project-delete-executor.js';
import type { GitPublicMetadataLease, GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { RepositoryBindingRecord } from '../ports/state-store.js';
import type { CommandProcessIdentity, CommandProcessStop } from '../ports/command-process.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { FeatureWorktreeCleaner, WorkspaceCleanerVerified } from '../ports/workspace-cleaner.js';

const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
function fail(reason: string): never { throw new PublicError('conflict', 'project.delete.execute', undefined, { details: { reason } }); }
export function createProjectDeleteExecutor(options: {
  readonly store: ProjectDeleteStore;
  readonly files: ProjectDeleteFiles;
  readonly gitLock: GitPublicMetadataLock;
  readonly bindingFor: (projectId: string) => RepositoryBindingRecord | Promise<RepositoryBindingRecord>;
  readonly cleanerFor: (projectId: string, confirm: (identity: CommandProcessIdentity) => Promise<{ launchId: string }>) => Promise<FeatureWorktreeCleaner>;
  readonly verifyProcessStop: (identity: CommandProcessIdentity) => Promise<CommandProcessStop>;
  readonly maxDurationMs?: number;
}): ProjectDeleteExecutor {
  const maxDurationMs = options.maxDurationMs ?? 600_000;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 600_000) throw new TypeError('Invalid cleanup budget');
  return {
    async execute(input) {
      const raw = requirePlainObject(input, { operation: 'project.delete.execute' }, 'input');
      rejectUnknownKeys(raw, ['principal', 'operationId', 'owner', 'expectedFence', 'previousExecutorStopped'], { operation: 'project.delete.execute' }, 'input');
      const prior = options.store.get(input.principal, input.operationId);
      if (prior.status === 'completed') return prior;
      const operation = options.store.claim(input.principal, input.operationId, input.owner, input.expectedFence, input.previousExecutorStopped === true);
      const identity = { operationId: operation.operationId, owner: operation.owner!, fence: operation.fence };
      const manifest = operation.manifest!;
      const leases: GitPublicMetadataLease[] = [];
      let step: ProjectDeleteStep = 'managed_worktrees';
      const deadline = Date.now() + maxDurationMs;
      const guard = () => {
        if (Date.now() >= deadline) fail('cleanup_budget_exhausted');
        options.store.assertCurrent(input.principal, identity);
        for (const lease of leases) lease.assertCurrent?.();
      };
      const checkpoint = (key: string, value: unknown) => { guard(); options.store.checkpoint(identity, step, key, value); };
      const read = () => options.store.readCheckpoints(identity, step);
      const verifyOutstanding = async () => {
        for (const [key, value] of Object.entries(options.store.readCheckpoints(identity, 'managed_worktrees'))) {
          if (!key.startsWith('process:') || options.store.readCheckpoints(identity, 'managed_worktrees')[`stop:${key.slice(8)}`]) continue;
          guard();
          if (!(await options.verifyProcessStop(value as CommandProcessIdentity)).confirmed) fail('cleanup_unconfirmed');
          guard();
          options.store.checkpoint(identity, 'managed_worktrees', `stop:${key.slice(8)}`, value);
        }
      };
      try {
        guard();
        const binding = await options.bindingFor(operation.projectId);
        guard();
        const bindingFact = manifest.inventory.repositoryBindings.find(b => b.bindingId === binding.id);
        if (!bindingFact || bindingFact.repoIdentity !== binding.repoIdentity || bindingFact.bindingRevision !== binding.bindingRevision
          || bindingFact.revision !== binding.revision || !binding.gitCommonDir) fail('repository_binding_changed');
        const targets = manifest.inventory.workspaceInspectionInputs.map(target => ({ workspaceId: target.workspaceId, baseline: {
          repositoryBindingId: target.repositoryBindingId, repositoryBindingRevision: target.repositoryBindingRevision,
          repoIdentity: target.repoIdentity, canonicalPath: target.canonicalPath, gitCommonDir: target.gitCommonDir,
          branch: target.branch, baseCommit: target.baseCommit,
        } satisfies WorkspaceBaseline }));
        // A single lock per common directory, independent of legacy/current repoIdentity.
        const lockTargets = new Map(targets.map(target => [target.baseline.gitCommonDir, target.baseline]));
        // The executor's own stop proof is insufficient for its supervised children.
        // Confirm every durable process before releasing a retained common-dir claim.
        await verifyOutstanding();
        for (const target of [...lockTargets.values()].sort((a, b) => a.gitCommonDir.localeCompare(b.gitCommonDir))) {
          guard();
          if (target.gitCommonDir !== binding.gitCommonDir || target.repoIdentity !== binding.repoIdentity) fail('repository_binding_changed');
          const lockInput = { repoIdentity: target.repoIdentity, gitCommonDir: target.gitCommonDir,
            workspacePath: binding.canonicalPath, operationId: operation.operationId };
          // A retained claim is released only after the caller's positive prior-executor proof.
          if (input.previousExecutorStopped && await options.gitLock.inspectRecovered?.(lockInput)) {
            guard();
            if (!await options.gitLock.releaseRecovered(lockInput)) fail('git_lock_recovery_unconfirmed');
          }
          leases.push(await options.gitLock.acquire(lockInput));
        }
        guard();
        // Every read-only and mutating Git launch is durably recorded before argv release.
        const confirm = async (process: CommandProcessIdentity) => {
          guard();
          options.store.checkpoint(identity, 'managed_worktrees', `process:${process.launchId}`, process);
          return { launchId: process.launchId };
        };
        const cleaner = await options.cleanerFor(operation.projectId, confirm);
        guard();
        // Restart checks use full launch/start/group identity, never PID/lease expiry alone.
        await verifyOutstanding();
        step = 'artifact_bodies';
        let plan = read().plan as ProjectDeleteFilePlan | undefined;
        if (!plan) {
          guard();
          plan = options.files.prepare(operation);
          checkpoint('plan', plan);
        }
        if (plan.manifestDigest !== operation.manifestDigest) fail('file_plan_mismatch');
        for (const [fileStep, targets] of [['artifact_bodies', plan.bodies], ['artifact_staging', plan.staging]] as const) {
          step = fileStep;
          for (const [index, target] of targets.entries()) {
            checkpoint(`intent:${index}`, { manifestDigest: operation.manifestDigest, target });
            guard();
            if (!read()[`removed:${index}`]) options.files.remove(target, guard);
            options.files.verifyRemoved(target);
            checkpoint(`removed:${index}`, { sha256: target.sha256, absent: true });
          }
          if (operation.steps.find(s => s.step === step)?.status !== 'completed') {
            guard();
            options.store.recordStep(identity, step, 'completed', hash(targets));
          }
        }
        step = 'managed_worktrees';
        for (const workspace of manifest.inventory.workspaces) {
          guard();
          const target = targets.find(t => t.workspaceId === workspace.workspaceId)?.baseline;
          if (!target) fail('workspace_baseline_missing');
          options.files.assertWorkspacePath(operation.projectId, workspace.featureId, target.canonicalPath);
          const verifiedKey = `verified:${workspace.workspaceId}`;
          let verified = read()[verifiedKey] as WorkspaceCleanerVerified | undefined;
          let expected;
          if ('unavailableReason' in workspace.inspection) {
            if (workspace.inspection.unavailableReason !== 'workspace_cleaned') fail('workspace_removal_evidence_missing');
            verified ??= options.store.priorWorkspaceRemoval(identity, workspace.workspaceId) ?? undefined;
            if (!verified) fail('workspace_removal_evidence_missing');
            checkpoint(verifiedKey, verified);
            expected = verified;
          } else {
            if (workspace.inspection.truncated || workspace.inspection.counts.modifiedTracked
              + workspace.inspection.counts.untracked + workspace.inspection.counts.ignored > 0) fail('workspace_discard_confirmation_required');
            expected = workspace.inspection;
          }
          const outcome = await cleaner.clean(binding, target, expected, {
            fence: guard,
            authorize: () => { guard(); return null; },
          }, {
            verified: verified ?? null, unfinishedProcesses: [],
            recordVerified: value => checkpoint(verifiedKey, value),
            recordProcess: process => checkpoint(`process:${process.launchId}`, process),
            recordStop: process => checkpoint(`stop:${process.launchId}`, process),
          });
          if (!outcome.removed || outcome.isolated) fail(outcome.isolated ? 'cleanup_unconfirmed' : outcome.reason ?? 'cleanup_failed');
          guard();
          const observed = read()[verifiedKey] as WorkspaceCleanerVerified;
          await cleaner.confirmRemoval(binding, target, observed);
          checkpoint(`removed:${workspace.workspaceId}`, { verifiedDigest: hash(observed), absent: true });
        }
        guard();
        await verifyOutstanding();
        if (operation.steps.find(s => s.step === step)?.status !== 'completed') options.store.recordStep(identity, step, 'completed', hash(read()));
        return await options.store.finish(identity, async current => {
          guard();
          options.files.verifyEmpty(current, plan);
          for (const workspace of manifest.inventory.workspaces) {
            guard();
            const target = targets.find(t => t.workspaceId === workspace.workspaceId)!.baseline;
            options.files.assertWorkspacePath(operation.projectId, workspace.featureId, target.canonicalPath);
            const verified = read()[`verified:${workspace.workspaceId}`] as WorkspaceCleanerVerified;
            if (!verified || !read()[`removed:${workspace.workspaceId}`]) return false;
            await cleaner.confirmRemoval(binding, target, verified);
          }
          await verifyOutstanding();
          guard();
          return true;
        });
      } catch (error) {
        // A failed receipt must not erase an already completed step or old fence.
        const current = options.store.get(input.principal, operation.operationId);
        if (current.owner === identity.owner && current.fence === identity.fence
          && current.steps.find(s => s.step === step)?.status !== 'completed') {
          options.store.recordStep(identity, step, 'failed', hash({ manifestDigest: operation.manifestDigest,
            reason: error instanceof PublicError ? error.details?.reason ?? error.code : 'cleanup_failed' }));
        }
        throw error;
      } finally {
        // On process uncertainty keep the common-dir claim for recovery. The
        // maintenance occupancy always stays held until final external verification.
        let uncertain = false;
        try {
          if (options.store.get(input.principal, operation.operationId).status !== 'completed') {
            const journal = options.store.readCheckpoints(identity, 'managed_worktrees');
            uncertain = Object.keys(journal).some(key => key.startsWith('process:') && !journal[`stop:${key.slice(8)}`]);
          }
        } catch { uncertain = true; }
        if (!uncertain) for (const lease of leases.reverse()) await lease.release();
      }
    },
  };
}
