/** P05-8 / F-003 production candidate boundary.
 *
 * The Pi process/SDK driver is injected by trusted Host assembly. This adapter
 * validates the Core repair envelope and exposes no Core store, Git command,
 * commit, push, or approval operation to the driver.
 */
import {
  validateGitAgentRuntimeRequest, RuntimeError,
} from 'shiploop-core';
import type {
  GitAgentRuntimeAdapter, GitAgentRuntimeHandle, GitAgentRuntimeRequest, RuntimeExecutionRequest,
} from 'shiploop-core';

/** Recheck the frozen repair envelope at both sides of the production process boundary. */
export function productionGitAgentRequest(manifest: unknown, request: RuntimeExecutionRequest): GitAgentRuntimeRequest | undefined {
  if (request.prompt.kind !== 'git-agent-repair-prompt') return undefined;
  const value = manifest as { gitAgent?: unknown; productionLimits?: { maxRequests?: number; tokenLimit?: number } };
  const repair = validateGitAgentRuntimeRequest(value?.gitAgent);
  const execution = repair.execution, authorization = repair.authorization;
  if (request.invocationId !== execution.invocationId || request.executionVersion !== execution.executionVersion
    || request.owner.principalId !== execution.ownerId || request.owner.hostInstanceId !== execution.hostInstanceId
    || request.projectId !== authorization.projectId || request.featureId !== authorization.featureId
    || request.identity.purpose !== 'work' || request.identity.runId !== authorization.runId
    || request.identity.attemptId !== execution.attemptId || request.identity.taskId !== authorization.repairId
    || request.recovery.mode !== 'new' || request.limits.timeoutMs > authorization.budget.remainingRuntimeMs
    || value.productionLimits?.tokenLimit !== authorization.budget.remainingTokens
    || !Number.isSafeInteger(value.productionLimits?.maxRequests) || value.productionLimits!.maxRequests! < 1
    || value.productionLimits!.maxRequests! > 10000) {
    throw new RuntimeError('permission', 'git_agent_execution_identity_mismatch');
  }
  return repair;
}

export interface PiGitAgentRuntimeDriver {
  start(request: GitAgentRuntimeRequest): Promise<GitAgentRuntimeHandle>;
}

export interface PiGitAgentRuntimeOptions {
  readonly driver: PiGitAgentRuntimeDriver;
}

export function createPiGitAgentRuntimeAdapter(options: PiGitAgentRuntimeOptions): GitAgentRuntimeAdapter {
  if (options.driver === null || typeof options.driver !== 'object' || typeof options.driver.start !== 'function') {
    throw new TypeError('PiGitAgentRuntime: trusted driver is required');
  }
  return {
    async start(rawRequest) {
      const request = validateGitAgentRuntimeRequest(rawRequest);
      return options.driver.start(request);
    },
  };
}
