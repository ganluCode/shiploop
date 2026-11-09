import type { SqliteStorageSession } from './session.js';
import { workRecoveryFingerprint } from './dispatch-recovery.js';
import { StorageError } from '../../ports/errors.js';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningRetireInput } from '../../ports/planning-retire.js';

interface Proof {
  readonly session: SqliteStorageSession;
  readonly input: PlanningRetireInput;
  readonly attemptId: string;
  readonly workspaceAttemptId: string;
  readonly fingerprint: string;
  readonly evidenceRef: string;
}
const proofs = new WeakMap<object, Proof>();

/** Adapter-private authority. A wire payload cannot construct this in-memory token. */
export function issuePlanningPreReleaseProof(proof: Proof): object {
  const token = Object.freeze({});
  proofs.set(token, { ...proof, input: structuredClone(proof.input) });
  return token;
}

export function inspectPlanningPreReleaseProof(session: SqliteStorageSession, input: PlanningRetireInput, token: unknown) {
  if (token === undefined) return undefined;
  const proof = token !== null && typeof token === 'object' ? proofs.get(token) : undefined;
  if (!proof || proof.session !== session || !isDeepStrictEqual(proof.input,input)
    || proof.fingerprint !== workRecoveryFingerprint(session, proof.attemptId)) {
    throw new StorageError('conflict', 'planning.retire', 'Planning recovery facts changed',
      { details: { reason: 'planning_retirement_evidence_changed' } });
  }
  return proof;
}
