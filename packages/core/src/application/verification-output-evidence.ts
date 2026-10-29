import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { VerificationStore } from '../ports/verification-store.js';
import { StorageError } from '../ports/errors.js';
import { createArtifactVerifier } from './artifact-verify.js';

/** Recheck durable output bytes before any completion/continue side effect. */
export async function verifyStoredVerificationOutputs(deps: {
  readonly verification: VerificationStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
}, projectId: string, batchId: string): Promise<void> {
  const batch = deps.verification.getVerificationBatch(projectId, batchId);
  const results = deps.verification.listCheckResults(projectId, batchId);
  const fail = (): never => { throw new StorageError('conflict', 'verification.evidence',
    'Verification evidence is incomplete', { details: { reason: 'verification_output_incomplete' } }); };
  if (batch.status === 'running' || results.length === 0
    || batch.checkSnapshot.some(check => (check.required || batch.selection.selectedCheckKeys.includes(check.checkKey))
      && !results.some(result => result.checkKey === check.checkKey))) fail();
  const verifier = createArtifactVerifier({ artifacts: deps.artifacts, files: deps.files,
    limits: { maxReadBytes: 8_388_608 } });
  for (const result of results) {
    const evidence = deps.verification.readCheckResultEvidence(projectId, result.id);
    if (evidence.status !== 'complete') fail();
    else if ((await verifier.verifyArtifact(projectId, evidence.artifactId)).kind !== 'verified_ready') fail();
  }
}
