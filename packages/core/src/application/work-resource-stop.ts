import type { CommandProcessPort } from '../ports/command-process.js';
import type { WorkResourceSnapshot, WorkResourceStopVerifier } from '../ports/work-resources.js';
import { StorageError } from '../ports/errors.js';

/** Stop and cleanup are external effects; the later short transaction fences this evidence. */
export function createWorkResourceStopVerifier(options: {
  readonly process: Pick<CommandProcessPort, 'recoverStop'>;
  readonly finalize: (snapshot: WorkResourceSnapshot) => Promise<boolean>;
}): WorkResourceStopVerifier {
  const evidence = new WeakMap<object, WorkResourceSnapshot>();
  return {
    async verify(snapshot) {
      if (snapshot.processIdentity === null || snapshot.invocationId === null || snapshot.leases.length !== 3) return null;
      const frozen = structuredClone(snapshot);
      const stopped = await options.process.recoverStop?.(frozen.processIdentity);
      if (stopped?.confirmed !== true || await options.finalize(structuredClone(frozen)) !== true) return null;
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
