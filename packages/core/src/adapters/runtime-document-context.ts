import { createHash } from 'node:crypto';
import type { ArtifactPublisher } from '../application/artifact-publish.js';
import type { RuntimeExecutionRequest } from '../ports/runtime-execution.js';

/** Trusted assembly only: additional invocation evidence never rewrites approved Task inputs. */
export async function publishRuntimeDocumentContext(publisher: ArtifactPublisher, request: RuntimeExecutionRequest, content: Uint8Array) {
  if (content.byteLength > 2097152) throw new Error('runtime_document_context_limit');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const locator = `runtime-context/${createHash('sha256').update(request.invocationId).digest('hex')}/documents.json`;
  const result = await publisher.publishArtifact({ projectId: request.projectId, kind: 'project-document-context',
    mediaType: 'application/json', locator, expectedHash: contentHash, content: [content] });
  return { projectId: request.projectId, artifactId: result.artifact.id, kind: result.artifact.kind,
    purpose: 'project-documents', version: result.artifact.version, contentHash, sizeBytes: content.byteLength,
    locator, mediaType: result.artifact.mediaType, origin: { kind: 'artifact' as const } };
}
