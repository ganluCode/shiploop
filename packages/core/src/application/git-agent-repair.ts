import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import { validateGitAgentRepairRequest } from '../ports/git-agent-repair.js';
import type { GitAgentRepairClaim, GitAgentRepairHold, GitAgentRepairStore } from '../ports/git-agent-repair-store.js';

/** Core orchestration only. Runtime adapters receive an admitted Attempt after commit.
 * No automatic retry, child Agent, Git commit, approval, resource release or hidden Batch.
 * A crash after admission requires supervised stop reconciliation, never blind replay.
 */
export function createGitAgentRepairService(deps: { readonly atomic: AtomicCommandStore; readonly store: GitAgentRepairStore }) {
  return {
    authorize(value: unknown, hold?: GitAgentRepairHold) {
      // Validate historical requests without a live clock: replay after deadline must
      // return the original receipt; new admission checks the persisted deadline.
      const request = validateGitAgentRepairRequest(value, { nowUtcMs: 0 });
      return deps.atomic.transact('GitAgentRepair.authorize', tx => deps.store.authorize(tx, request, hold));
    },
    read(projectId: string, repairId: string) {
      return deps.atomic.transact('GitAgentRepair.read', tx => deps.store.read(tx, projectId, repairId));
    },
    claim(input: GitAgentRepairClaim) {
      return deps.atomic.transact('GitAgentRepair.claim', tx => deps.store.claim(tx, input));
    },
    settle(input: GitAgentRepairClaim, output: unknown, stopEvidence: { readonly stopped: boolean }) {
      return deps.atomic.transact('GitAgentRepair.settle', tx => deps.store.settle(tx, input, output, stopEvidence.stopped));
    },
    hold(projectId: string, repairId: string, reason: GitAgentRepairHold) {
      return deps.atomic.transact('GitAgentRepair.hold', tx => deps.store.hold(tx, projectId, repairId, reason));
    },
  };
}

export type GitAgentRepairService = ReturnType<typeof createGitAgentRepairService>;
