import { createHash } from 'node:crypto';
import type { SqliteStorageSession } from './session.js';
import type { DocumentService } from '../../application/document-service.js';
import type { ArtifactPublisher } from '../../application/artifact-publish.js';
import { assertTrustedPrincipal, requireCapability, requireProjectVisible } from '../../ports/authorization.js';
import { validateStableId } from '../../ports/validation.js';
import { validateManagedDocumentSources, type ManagedDocumentBody, type ManagedDocumentSource } from '../../ports/managed-documents.js';
import { createManagedDocumentDrafts } from '../fs/managed-document-drafts.js';
import { StorageError } from '../../ports/errors.js';

export function createManagedDocuments(options: { session: SqliteStorageSession; dataRoot: string;
  documents: DocumentService; publisher: ArtifactPublisher; maintenanceGate?: import('../../ports/data-maintenance.js').MaintenanceWriteGate }) {
  const { session, documents, publisher } = options, files = createManagedDocumentDrafts(options.dataRoot);
  let tail: Promise<void> = Promise.resolve();
  async function serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  function authorize(principal: unknown, projectId: string, write = false) {
    const operation = 'ManagedDocuments';
    assertTrustedPrincipal(principal);
    validateStableId(projectId, { operation }, 'projectId');
    requireCapability(principal, write ? 'project.metadata.write' : 'project.read', operation);
    requireProjectVisible(principal, projectId, operation);
    const project = session.database.prepare('SELECT status FROM projects WHERE id=?').get(projectId) as { status: string } | undefined;
    if (!project || project.status !== 'active') throw new StorageError('not_found', operation, 'Project unavailable');
    if (write && options.maintenanceGate?.read().state !== undefined && options.maintenanceGate.read().state !== 'idle') {
      throw new StorageError('conflict', operation, 'Managed documents are unavailable during maintenance');
    }
  }
  async function capture(principal: unknown, projectId: string, featureId: string) {
    authorize(principal, projectId, true);
    validateStableId(featureId, { operation: 'ManagedDocuments' }, 'featureId');
    if (!session.database.prepare('SELECT 1 FROM features WHERE project_id=? AND id=?').get(projectId, featureId)) {
      throw new StorageError('not_found', 'ManagedDocuments', 'Feature unavailable');
    }
    const bound = session.database.prepare('SELECT path,role FROM feature_document_sources WHERE project_id=? AND feature_id=? ORDER BY path')
      .all(projectId, featureId) as ManagedDocumentSource[];
    if (!bound.some(doc => doc.role === 'prd')) throw new Error('managed_feature_prd_missing');
    const selected = [...bound];
    for (const doc of [{ path: 'README.md', role: 'index' }, { path: 'product/overview.md', role: 'product' },
      { path: 'architecture/overview.md', role: 'architecture' }] as const) {
      if (selected.some(item => item.path === doc.path)) continue;
      try { await files.read(projectId, doc.path); selected.push(doc); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const bodies: (ManagedDocumentBody & { required: true })[] = [];
    let total = 0;
    for (const source of validateManagedDocumentSources(selected)) {
      const body = await files.read(projectId, source.path);
      if ((total += body.sizeBytes) > 786432) throw new Error('managed_document_total_limit');
      let row = session.database.prepare('SELECT document_id FROM managed_document_sources WHERE project_id=? AND path=?')
        .get(projectId, source.path) as { document_id: string | null } | undefined;
      if (!row?.document_id) {
        const doc = await documents.createDocument(principal, projectId, { title: source.path, documentType: source.role });
        session.transactWrite('ManagedDocuments.bindIdentity', () => {
          session.database.prepare(`INSERT INTO managed_document_sources(project_id,path,document_id) VALUES (?,?,?)
            ON CONFLICT(project_id,path) DO UPDATE SET document_id=excluded.document_id WHERE document_id IS NULL`)
            .run(projectId, source.path, doc.id);
        });
        row = { document_id: doc.id };
      }
      const existing = session.database.prepare(`SELECT version,content_hash FROM document_versions
        WHERE project_id=? AND document_id=? ORDER BY version DESC LIMIT 1`).get(projectId, row.document_id) as
        { version: number; content_hash: string } | undefined;
      let version;
      if (existing?.content_hash === body.sha256) version = (await documents.readDocument(principal, projectId, row.document_id!, existing.version)).version;
      else {
        const bytes = Buffer.from(body.content);
        const frozen = await publisher.publishArtifact({ projectId, kind: 'managed-document-source', mediaType: 'text/markdown',
          expectedHash: body.sha256, locator: `managed-documents/${row.document_id}/${body.sha256}`, content: [bytes] });
        version = (await documents.registerDocumentVersion(principal, projectId, { title: source.path, documentType: source.role,
          documentId: row.document_id, version: (existing?.version ?? 0) + 1, status: 'published', reviewStatus: 'pending',
          source: { kind: 'artifact', artifactId: frozen.artifact.id } })).version;
      }
      if (version.contentHash !== body.sha256) throw new Error('managed_document_version_conflict');
      bodies.push({ ...source, ...body, required: true, documentId: row.document_id!, version: version.version });
    }
    const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1, featureId, documents: bodies, missing: [], omissions: [],
      mapping: null, featureMapped: true, repositoryHead: null, source: 'managed-project-documents' }));
    if (snapshot.length > 1048576) throw new Error('managed_document_context_limit');
    const hash = createHash('sha256').update(snapshot).digest('hex');
    const context = await publisher.publishArtifact({ projectId, kind: 'managed-document-context', mediaType: 'application/json',
      expectedHash: hash, locator: `managed-documents/contexts/${featureId}/${hash}`, content: [snapshot] });
    return { documents: bodies, requirementRefs: [{ artifactId: context.artifact.id, contentHash: hash }],
      context: { artifactId: context.artifact.id, contentHash: hash } };
  }
  return {
    async checkSources(principal: unknown, projectId: string, sources: readonly ManagedDocumentSource[]) {
      authorize(principal, projectId, true);
      for (const source of validateManagedDocumentSources(sources)) await files.read(projectId, source.path);
    },
    async locations(principal: unknown, projectId: string, featureId?: string) {
      authorize(principal, projectId);
      if (featureId !== undefined) {
        validateStableId(featureId, { operation: 'ManagedDocuments' }, 'featureId');
        if (!session.database.prepare('SELECT 1 FROM features WHERE project_id=? AND id=?').get(projectId, featureId)) throw new Error('managed_feature_missing');
      }
      return { schemaVersion: 1 as const, projectId, workingDirectory: await files.ensure(projectId),
        ...(featureId === undefined ? {} : { featureId, documents: session.database.prepare(
          'SELECT path,role FROM feature_document_sources WHERE project_id=? AND feature_id=? ORDER BY path').all(projectId, featureId) as ManagedDocumentSource[] }) };
    },
    async writeDraft(principal: unknown, projectId: string, input: { path: string; content: string; expectedHash?: string }) {
      authorize(principal, projectId, true);
      if (!input || Object.keys(input).some(key => !['path', 'content', 'expectedHash'].includes(key)) || typeof input.content !== 'string'
        || input.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedHash)) throw new Error('managed_document_input_invalid');
      return serialized(() => {
        authorize(principal, projectId, true);
        return files.write(projectId, input.path, input.content, input.expectedHash);
      });
    },
    async capture(principal: unknown, projectId: string, featureId: string) {
      return serialized(() => capture(principal, projectId, featureId));
    },
  };
}
export type ManagedDocuments = ReturnType<typeof createManagedDocuments>;
