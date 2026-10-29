import { describe, expect, it } from 'vitest';
import { createExecutionKnowledgeReader } from '../../../packages/core/src/application/execution-knowledge.ts';
import { createHash } from 'node:crypto';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const content = 'Task requires the retry policy from the managed document.';

function reader() {
  const contentRef = {
    projectId: 'project-1', artifactId: 'artifact-1', version: 2,
    contentHash: hash(content), sizeBytes: Buffer.byteLength(content),
  };
  return createExecutionKnowledgeReader({
    documents: { getDocument: async () => ({
      id: 'doc-1', projectId: 'project-1', title: 'Retry policy', documentType: 'guide',
      effectiveVersionId: 'version-1', status: 'active', revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1,
    }) },
    documentQuery: {
      listDocumentVersions: () => [{
        document: {
          id: 'doc-1', projectId: 'project-1', title: 'Retry policy', documentType: 'guide',
          effectiveVersionId: 'version-1', status: 'active', revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1,
        },
        version: {
          id: 'version-1', projectId: 'project-1', documentId: 'doc-1', version: 2, status: 'published',
          contentRef, contentHash: contentRef.contentHash, sourceRefs: [], reviewStatus: 'approved',
          reviewedAgainstRevision: null, revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1,
        },
        contentLocator: 'documents/doc-1/v2/body', sourceLocators: [],
      }],
    },
    memoryQuery: { listAcceptedMemories: () => [] },
    verifier: { readVerifiedContent: async () => ({ projectId: 'project-1', artifactId: 'artifact-1', content: Buffer.from(content), contentHash: contentRef.contentHash, sizeBytes: contentRef.sizeBytes, locator: 'documents/doc-1/v2/body', relativePath: 'documents/doc-1/v2/body' }) },
  });
}

const budget = { maxSources: 4, maxSnippetChars: 128, maxTotalBytes: 1024, maxReadBytes: 4096, maxCandidates: 8 };

describe('P06-2 execution knowledge preparation', () => {
  it('[case:knowledge-authoritative-selection] resolves a project scoped version and emits verified identity', async () => {
    const result = await reader().resolve({
      projectId: 'project-1', featureId: 'feature-1', taskId: 'task-1',
      requests: [{ kind: 'document', documentId: 'doc-1', version: 2, keyword: 'retry', purpose: 'task-guidance', required: true }],
      budget,
    });
    expect(result.selections[0]).toMatchObject({
      kind: 'document', sourceId: 'doc-1', version: 2, projectId: 'project-1',
      contentRef: { artifactId: 'artifact-1', contentHash: hash(content) },
      purpose: 'task-guidance', required: true,
    });
    expect(result.budget).toMatchObject({ selectedSources: 1, bytesRead: Buffer.byteLength(content) });
  });

  it('[case:knowledge-cross-project-rejected] rejects a request that attempts to select another project', async () => {
    await expect(reader().resolve({
      projectId: 'project-1', featureId: 'feature-1', taskId: 'task-1',
      requests: [{ kind: 'document', documentId: 'doc-1', projectId: 'project-2', purpose: 'x', required: true }], budget,
    })).rejects.toMatchObject({ details: { reason: 'ownership_denied' } });
  });

  it('[case:knowledge-required-missing] preserves a structured missing-required failure', async () => {
    await expect(reader().resolve({
      projectId: 'project-1', featureId: 'feature-1', taskId: 'task-1',
      requests: [{ kind: 'document', documentId: 'missing', purpose: 'required-guide', required: true }], budget,
    })).rejects.toMatchObject({ details: { reason: 'missing_required_input' } });
  });
});
