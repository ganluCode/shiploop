/** P05-8 / F-003 production candidate boundary.
 *
 * The Pi process/SDK driver is injected by trusted Host assembly. This adapter
 * validates the Core repair envelope and exposes no Core store, Git command,
 * commit, push, or approval operation to the driver.
 */
import {
  validateGitAgentRuntimeRequest,
} from 'shiploop-core';
import type {
  GitAgentRuntimeAdapter, GitAgentRuntimeHandle, GitAgentRuntimeRequest,
} from 'shiploop-core';

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
