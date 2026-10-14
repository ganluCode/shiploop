import { deriveManagedFeatureBranch } from '../ports/workspace-preparation.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { WorkResourceAccess } from '../ports/work-resources.js';
import type { WorkspacePreparationInput, WorkspacePreparationOutcome, WorkspacePreparationStore,
  PreparationWorkspaceAuthority, FeatureWorktreePreparer } from '../ports/workspace-preparation.js';
import type { WorkspaceOperationCommit } from '../ports/workspace.js';

export function createWorkspacePreparationService(options: {
  readonly store: WorkspacePreparationStore;
  readonly authority: PreparationWorkspaceAuthority;
  readonly resources: WorkResourceAccess;
  readonly gitLock: GitPublicMetadataLock;
  readonly preparer: FeatureWorktreePreparer;
  /** Publishes an immutable JSON Artifact; the store rechecks that its ID is ready. */
  readonly publishEvidence: (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => Promise<string>;
}) {
  return {
    async prepare(input: WorkspacePreparationInput): Promise<WorkspaceOperationCommit> {
      const authorization = options.store.readAuthorization(input);
      const token = await options.authority.verifyPreparation(authorization.binding, authorization.featureId);
      const baseline = { repositoryBindingId: authorization.binding.id,
        repositoryBindingRevision: authorization.binding.bindingRevision, repoIdentity: authorization.binding.repoIdentity,
        gitCommonDir: authorization.binding.gitCommonDir!, canonicalPath: token.canonicalPath,
        branch: deriveManagedFeatureBranch(input.identity.projectId, authorization.featureId),
        baseCommit: authorization.baseCommit };
      const intent = options.store.begin(input, baseline);
      if (intent.replay) return intent;
      let outcome: WorkspacePreparationOutcome;
      try {
        const lease = await options.gitLock.acquire({ repoIdentity: authorization.binding.repoIdentity,
          gitCommonDir: authorization.binding.gitCommonDir!, workspacePath: authorization.binding.canonicalPath,
          operationId: input.operationId });
        try {
          const admit = () => {
            const current = options.store.readAuthorization(input);
            if (JSON.stringify(current) !== JSON.stringify(authorization)) throw new Error('preparation_authority_changed');
            const occupancy = options.resources.read(input.identity);
            if (!occupancy.leases.some(l => l.resourceKey === token.resourceKey)) throw new Error('preparation_occupancy_changed');
          };
          admit();
          outcome = await options.preparer.prepare(authorization.binding, baseline, input.operationId, admit);
        } finally { await lease.release(); }
      } catch {
        // Lock/authority failure is safe before I/O; after a preparer exception retain uncertainty.
        outcome = { inspection: null, isolated: true, reason: 'workspace_preparation_uncertain',
          result: { startedAtUtcMs: null, endedAtUtcMs: null, durationMs: null, exitCode: null, signal: null } };
      }
      try {
        const evidenceRef = await options.publishEvidence(input.identity.projectId, input.operationId,
          { schemaVersion: 1, operationId: input.operationId, baseline, outcome });
        return options.store.finish(input, intent, outcome, evidenceRef);
      } catch (error) {
        // Do not release a path after Git succeeded but evidence/CAS persistence failed.
        options.store.quarantine(input);
        throw error;
      }
    },
  };
}
