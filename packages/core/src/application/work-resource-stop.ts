import type { CommandProcessPort } from '../ports/command-process.js';
import type { WorkManagedProcess, WorkResourceSnapshot, WorkResourceStopVerifier } from '../ports/work-resources.js';
import { StorageError } from '../ports/errors.js';

function processKey(value: { readonly launchId: string; readonly pid: number; readonly processGroupId: number; readonly startTime: string }): string {
  return JSON.stringify([value.launchId, value.pid, value.processGroupId, value.startTime]);
}
function validManagedProcess(snapshot: WorkResourceSnapshot, value: WorkManagedProcess): boolean {
  const process = value?.processIdentity;
  return value?.kind === 'mcp'
    && typeof value.projectId === 'string' && value.projectId === snapshot.identity.projectId
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.serverId === 'string' && value.serverId.length > 0
    && typeof value.invocationId === 'string' && value.invocationId === snapshot.invocationId
    && value.executionVersion === snapshot.identity.executionVersion
    && process !== null && typeof process === 'object'
    && typeof process.launchId === 'string' && process.launchId.length > 0
    && Number.isSafeInteger(process.pid) && process.pid > 1
    && process.processGroupId === process.pid
    && typeof process.startTime === 'string' && process.startTime.length > 0;
}

/** Stop and cleanup are external effects; the later short transaction fences this evidence. */
export function createWorkResourceStopVerifier(options: {
  readonly process: Pick<CommandProcessPort, 'recoverStop'>;
  readonly finalize: (snapshot: WorkResourceSnapshot) => Promise<boolean>;
}): WorkResourceStopVerifier {
  const evidence = new WeakMap<object, WorkResourceSnapshot>();
  return {
    async verify(snapshot) {
      if (snapshot.processIdentity === null || snapshot.invocationId === null || snapshot.leases.length !== 3) return null;
      const managed = snapshot.managedProcesses ?? [];
      if (managed.some(item => !validManagedProcess(snapshot, item))) return null;
      const identities = [snapshot.processIdentity, ...managed.map(item => item.processIdentity),
        ...(snapshot.verificationProcesses ?? [])];
      if (new Set(identities.map(processKey)).size !== identities.length) return null;
      const frozen = structuredClone(snapshot);
      const stop = options.process.recoverStop;
      if (typeof stop !== 'function') return null;
      let stopped: readonly { readonly confirmed: boolean }[];
      try { stopped = await Promise.all(identities.map(identity => stop(identity))); } catch { return null; }
      if (stopped.some(result => result.confirmed !== true)) return null;
      let finalized: boolean;
      try { finalized = await options.finalize(structuredClone(frozen)); } catch { return null; }
      if (finalized !== true) return null;
      const token = Object.freeze({});
      evidence.set(token, frozen);
      return token;
    },
    inspect(token) {
      const snapshot = token !== null && typeof token === 'object' ? evidence.get(token) : undefined;
      if (!snapshot) throw new StorageError('validation', 'WorkResources.release', 'Unverified stop evidence');
      return structuredClone(snapshot);
    },
  };
}
