import { createHash } from 'node:crypto';
import type { ArtifactVerifier } from './artifact-verify.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { GitOperationIntent, GitOperationEvidenceRef } from '../ports/git-operations.js';
import type { WorkspaceInspection } from '../ports/workspace-inspector.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';

export async function publishGitCommitInspection(publisher: Pick<ArtifactPublisher, 'publishArtifact'>,
  projectId: string, operationId: string, inspection: WorkspaceInspection): Promise<GitOperationEvidenceRef> {
  const body = Buffer.from(JSON.stringify(inspection));
  if (body.length > 4 * 1024 * 1024) throw new Error('commit_inspection_oversized');
  const digest = createHash('sha256').update(body).digest('hex');
  const result = await publisher.publishArtifact({ projectId, kind: 'git_commit_inspection', mediaType: 'application/json',
    expectedHash: digest, locator: `git-operations/${operationId}/inspection.json`, content: [body] });
  return { kind: 'artifact', id: result.artifact.id, digest };
}

/** Reads original bytes through the bounded, same-project artifact verifier.
 * Today's source can never manufacture historical verification evidence.
 */
export async function readGitCommitInspection(intent: GitOperationIntent,
  artifacts: Pick<ArtifactVerifier, 'readVerifiedContent'>): Promise<WorkspaceInspection | null> {
  for (const ref of intent.verificationRefs.filter(ref => ref.kind === 'artifact').slice(0, 16)) {
    try {
      const content = await artifacts.readVerifiedContent(intent.projectId, ref.id);
      if (content.content.length > 4 * 1024 * 1024 || content.contentHash !== ref.digest
        || createHash('sha256').update(content.content).digest('hex') !== ref.digest) continue;
      const inspection = JSON.parse(Buffer.from(content.content).toString('utf8')) as WorkspaceInspection;
      if (inspection.repository.headCommit === intent.expectedHead
        && inspection.repository.repoIdentity === intent.repoIdentity
        && inspection.repository.repositoryBindingId === intent.repositoryBindingId
        && inspection.repository.canonicalPath === intent.worktreePath
        && verificationCodeIdentity(inspection).codeDigest === intent.codeDigest) return inspection;
    } catch { /* Missing, corrupt, incompatible or unrelated evidence stays unverified. */ }
  }
  return null;
}
