import { validateWorkspaceRetentionInput } from '../ports/workspace-retention.js';
import type { WorkspaceRetentionStore, WorkspaceRetentionInput, WorkspaceRetentionStop } from '../ports/workspace-retention.js';
import type { WorkResourceStopVerifier } from '../ports/work-resources.js';
import type { WorkspaceOperationCommit } from '../ports/workspace.js';

/** Retention has no filesystem mutation or deletion dependency. */
export function createWorkspaceRetentionService(options: {
  readonly store: WorkspaceRetentionStore;
  readonly stopVerifier?: WorkResourceStopVerifier;
  readonly publishEvidence: (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => Promise<string>;
}) {
  return {
    async retain(raw: WorkspaceRetentionInput): Promise<WorkspaceOperationCommit> {
      const input = validateWorkspaceRetentionInput(raw);
      const intent = options.store.begin(input);
      if (intent.commit.operation.status !== 'pending') return intent.commit;
      try {
        let stop: WorkspaceRetentionStop = intent.unstarted ? 'not_started' : intent.previouslyReleased ? 'confirmed' : 'unknown';
        let stopToken: object | undefined;
        if (stop === 'unknown' && intent.preparationStopped && options.stopVerifier) {
          const verified = await options.stopVerifier.verify(intent.resources);
          if (verified) { stopToken = verified; stop = 'confirmed'; }
        }
        const evidenceRef = await options.publishEvidence(input.identity.projectId, input.operationId, {
          schemaVersion: 1, operationId: input.operationId, identity: input.identity,
          workspaceId: input.workspaceId, reason: input.reason, stop,
          preparationStopped: intent.preparationStopped, previouslyReleased: intent.previouslyReleased,
          evidenceRefs: input.evidenceRefs, resources: intent.resources,
        });
        return options.store.finish(input, intent, stop, evidenceRef, stopToken);
      } catch (error) {
        options.store.quarantine(input, intent);
        throw error;
      }
    },
  };
}
