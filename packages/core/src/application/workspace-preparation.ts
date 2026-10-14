import { deriveManagedFeatureBranch } from '../ports/workspace-preparation.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { WorkResourceAccess } from '../ports/work-resources.js';
import type { WorkspacePreparationInput, WorkspacePreparationStore,
  PreparationWorkspaceAuthority, FeatureWorktreePreparer } from '../ports/workspace-preparation.js';
import type { CommandProcessIdentity, CommandProcessStop } from '../ports/command-process.js';
import type { WorkspaceOperationCommit } from '../ports/workspace.js';

export function createWorkspacePreparationService(options: {
  readonly store: WorkspacePreparationStore;
  readonly authority: PreparationWorkspaceAuthority;
  readonly resources: WorkResourceAccess;
  readonly gitLock: GitPublicMetadataLock;
  readonly preparer: FeatureWorktreePreparer;
  /** Trusted supervisor proof of group absence; do not infer this from lease expiry. */
  readonly verifyPreparationStop?: (identity: CommandProcessIdentity) => Promise<CommandProcessStop>;
  /** Publishes an immutable JSON Artifact; the store rechecks that its ID is ready. */
  readonly publishEvidence: (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => Promise<string>;
}) {
  return {
    async prepare(input: WorkspacePreparationInput): Promise<WorkspaceOperationCommit> {
      const authorization = options.store.readAuthorization(input);
      let token;
      try { token = await options.authority.verifyPreparation(authorization.binding, authorization.featureId); }
      catch (error) { options.store.quarantine(input); throw error; }
      const baseline = { repositoryBindingId: authorization.binding.id,
        repositoryBindingRevision: authorization.binding.bindingRevision, repoIdentity: authorization.binding.repoIdentity,
        gitCommonDir: authorization.binding.gitCommonDir!, canonicalPath: token.canonicalPath,
        branch: deriveManagedFeatureBranch(input.identity.projectId, authorization.featureId),
        baseCommit: authorization.baseCommit };
      const intent = options.store.begin(input, baseline);
      if (!['pending', 'succeeded'].includes(intent.operation.status)) throw new Error('terminal_preparation_not_recoverable');
      try {
        const lease = await options.gitLock.acquire({ repoIdentity: authorization.binding.repoIdentity,
          gitCommonDir: authorization.binding.gitCommonDir!, workspacePath: authorization.binding.canonicalPath,
          operationId: input.operationId });
        try {
          const admit = () => {
            const current = options.store.readAuthorization(input);
            if (JSON.stringify(current) !== JSON.stringify(authorization)) throw new Error('preparation_authority_changed');
            options.store.assertCurrent(input, intent);
            const occupancy = options.resources.read(input.identity);
            if (!occupancy.leases.some(l => l.resourceKey === token.resourceKey)) throw new Error('preparation_occupancy_changed');
          };
          admit();
          let journal = options.store.readJournal(input, intent);
          for (const process of journal.unfinishedProcesses) {
            if (!options.verifyPreparationStop || !(await options.verifyPreparationStop(process)).confirmed) {
              throw new Error('previous_git_stop_unconfirmed');
            }
            admit();
            options.store.recordCheckpoint(input, intent, 'stop', process);
          }
          journal = options.store.readJournal(input, intent);
          const outcome = await options.preparer.prepare(authorization.binding, baseline, input.operationId, admit, {
            ...journal,
            recordDirectory: value => options.store.recordCheckpoint(input, intent, 'directory', value),
            recordProcess: value => options.store.recordCheckpoint(input, intent, 'process', value),
            recordStop: value => options.store.recordCheckpoint(input, intent, 'stop', value),
          });
          if ((intent.replay || journal.directoryIdentity !== null) && outcome.reason !== null) {
            throw new Error('workspace_reuse_refused: ' + outcome.reason);
          }
          admit();
          const evidenceRef = await options.publishEvidence(input.identity.projectId, input.operationId,
            { schemaVersion: 1, operationId: input.operationId, attemptId: input.identity.attemptId,
              preparationOperationId: intent.workspace.preparationOperationId,
              runtimeRecovery: 'not_evaluated', baseline, outcome });
          // Evidence publication can yield; recheck bytes and HEAD before committing its receipt.
          if (outcome.inspection !== null && outcome.reason === null) {
            const current = await options.preparer.prepare(authorization.binding, baseline, input.operationId, admit, {
              ...options.store.readJournal(input, intent),
              recordDirectory: () => { throw new Error('unexpected_recovery_mutation'); },
              recordProcess: () => { throw new Error('unexpected_recovery_mutation'); },
              recordStop: () => { throw new Error('unexpected_recovery_mutation'); },
            });
            if (!current.inspection || current.reason !== null
              || current.inspection.repository.headCommit !== outcome.inspection.repository.headCommit
              || current.inspection.codeDigest !== outcome.inspection.codeDigest
              || current.inspection.ignoredDigest !== outcome.inspection.ignoredDigest) throw new Error('workspace_changed_before_receipt');
          }
          admit();
          // Keep the short Git metadata lock through the fenced receipt commit.
          return options.store.finish(input, intent, outcome, evidenceRef);
        } finally { await lease.release(); }
      } catch (error) {
        // Preserve pending intent and bytes on uncertain I/O or persistence failure.
        options.store.quarantine(input, intent);
        throw error;
      }
    },
  };
}
