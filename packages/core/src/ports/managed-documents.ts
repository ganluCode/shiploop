import { requirePlainObject, rejectUnknownKeys, validateArtifactLocator, validationError } from './validation.js';

export type ManagedDocumentRole = 'prd' | 'design' | 'architecture' | 'product' | 'index';
export interface ManagedDocumentSource { readonly path: string; readonly role: ManagedDocumentRole }

export function validateManagedDocumentSources(value: unknown): ManagedDocumentSource[] {
  const context = { operation: 'ManagedDocuments.validate' };
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw validationError(context, 'documents', 'expected_1_to_16_documents');
  const seen = new Set<string>();
  return value.map(item => {
    const object = requirePlainObject(item, context, 'documents.item');
    rejectUnknownKeys(object, ['path', 'role'], context, 'documents.item');
    const path = validateArtifactLocator(object.path, context, 'documents.path');
    if (!path.endsWith('.md') || path.length > 512 || /[\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => part.startsWith('.') || part === 'node_modules')
      || !['prd', 'design', 'architecture', 'product', 'index'].includes(String(object.role)) || seen.has(path)) {
      throw validationError(context, 'documents', 'invalid_or_duplicate_document');
    }
    seen.add(path);
    return { path, role: object.role as ManagedDocumentRole };
  });
}

export interface ManagedDocumentBody extends ManagedDocumentSource {
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly documentId: string;
  readonly version: number;
}
