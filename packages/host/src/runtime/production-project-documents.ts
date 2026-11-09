import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { productionFilePath } from './production-pi-tools.js';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';
import type { PromptTemplateCatalog } from 'shiploop-core';

const MAPPING = 'docs/shiploop-context.json';
const ROLES = ['index', 'product', 'architecture', 'prd', 'design', 'other'] as const;
type Role = typeof ROLES[number];
type DocumentEntry = { path: string; role: Role; required: boolean };
export interface ProjectDocument extends DocumentEntry { sha256: string; sizeBytes: number; content: string }
export interface ProjectDocumentSnapshot {
  schemaVersion: 1;
  featureId: string;
  documents: ProjectDocument[];
  missing: string[];
  omissions: string[];
  mapping: { path: string; sha256: string; content: string } | null;
  featureMapped: boolean;
  repositoryHead: string | null;
  source?: 'managed-project-documents';
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const validPath = (path: unknown): path is string => typeof path === 'string' && path.length <= 512
  && !/[\\\x00-\x1f\x7f]/.test(path) && !path.startsWith('/')
  && !path.split('/').some(part => !part || ['.', '..', '.git', 'node_modules'].includes(part));

async function read(cwd: string, path: string, maximum: number): Promise<string> {
  const file = await open(await productionFilePath(cwd, path, false), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error('project_document_size_limit');
    const bytes = await file.readFile();
    if (bytes.length > maximum) throw new Error('project_document_size_limit');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { await file.close(); }
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project_document_mapping_invalid');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => ['__proto__', 'constructor', 'prototype'].includes(key) || keys && !keys.includes(key))) {
    throw new Error('project_document_mapping_invalid');
  }
  return result;
}
function entries(value: unknown): DocumentEntry[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('project_document_mapping_invalid');
  return value.map(item => {
    const entry = object(item, ['path', 'role', 'required']);
    if (!validPath(entry.path) || !entry.path.endsWith('.md') || !ROLES.includes(entry.role as Role)
      || typeof entry.required !== 'boolean') throw new Error('project_document_mapping_invalid');
    return { path: entry.path, role: entry.role as Role, required: entry.required };
  });
}

/** Captures bounded repository documents, never global resources or runtime state. */
export async function captureProjectDocuments(cwd: string, featureId: string): Promise<ProjectDocumentSnapshot> {
  let repositoryHead: string | null = null;
  try {
    const git = await promisify(execFile)('/usr/bin/git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'],
      { timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    const head = git.stdout.trim();
    if (/^[a-f0-9]{40,64}$/.test(head)) repositoryHead = head;
  } catch { /* Hashes still identify exact captured bytes when Git HEAD is unavailable. */ }
  const result: ProjectDocumentSnapshot = { schemaVersion: 1, featureId, documents: [], missing: [], omissions: [], mapping: null, featureMapped: false, repositoryHead };
  const selected = new Map<string, DocumentEntry>();
  let explicit = false;
  try {
    const content = await read(cwd, MAPPING, 65536);
    const mapping = object(JSON.parse(content), ['schemaVersion', 'shared', 'features']);
    if (mapping.schemaVersion !== 1) throw new Error('project_document_mapping_invalid');
    const features = object(mapping.features ?? {});
    for (const [id, value] of Object.entries(features)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('project_document_mapping_invalid');
      entries(value);
    }
    result.mapping = { path: MAPPING, sha256: hash(content), content };
    result.featureMapped = Object.hasOwn(features, featureId);
    for (const entry of [...entries(mapping.shared ?? []), ...entries(features[featureId] ?? [])]) {
      const previous = selected.get(entry.path);
      selected.set(entry.path, { ...entry, required: entry.required || previous?.required === true });
    }
    explicit = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!explicit) {
    for (const [path, role] of [['docs/README.md', 'index'], ['docs/product/overview.md', 'product'], ['docs/architecture/overview.md', 'architecture']] as const) {
      selected.set(path, { path, role, required: true });
    }
    let directories = 0, visited = 0;
    async function walk(path: string, depth: number): Promise<void> {
      if (depth > 6 || directories++ >= 64) { result.omissions.push(path + ':depth_or_directory_limit'); return; }
      // The placeholder validates every ancestor, including the docs directory itself.
      let children;
      try {
        await productionFilePath(cwd, path + '/.document-index', false);
        children = await readdir(join(cwd, path), { withFileTypes: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const name = path + '/' + child.name;
        if (++visited > 2048) { result.omissions.push(path + ':entry_limit'); return; }
        if (!validPath(name)) continue;
        if (child.isSymbolicLink() || child.name.startsWith('.') || child.name === 'node_modules') continue;
        if (child.isDirectory()) { await walk(name, depth + 1); continue; }
        if (!child.isFile() || !child.name.endsWith('.md') || selected.has(name)) continue;
        if (selected.size >= 128) { result.omissions.push(path + ':document_limit'); return; }
        const role: Role = name.includes('/features/') ? 'prd' : name.includes('/designs/') ? 'design'
          : name.includes('/architecture/') ? 'architecture' : 'other';
        selected.set(name, { path: name, role, required: false });
      }
    }
    await walk('docs', 0);
  }
  let total = 0;
  // Required entries are captured first; optional candidates never consume their budget.
  for (const entry of [...selected.values()].sort((a, b) => Number(b.required) - Number(a.required) || (a.path < b.path ? -1 : 1))) {
    try {
      const content = await read(cwd, entry.path, 262144), sizeBytes = Buffer.byteLength(content);
      if (total + sizeBytes > 1048576) {
        if (entry.required) throw new Error('project_document_total_limit');
        result.omissions.push(entry.path + ':total_byte_limit'); continue;
      }
      total += sizeBytes;
      result.documents.push({ ...entry, content, sizeBytes, sha256: hash(content) });
    } catch (error) {
      if (explicit || entry.required && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.missing.push(entry.path);
      else result.omissions.push(entry.path + ':unavailable');
    }
  }
  result.documents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}

export async function discoverProjectDocuments(cwd: string): Promise<ProjectDocument[]> {
  return (await captureProjectDocuments(cwd, '')).documents;
}

export function parseProjectDocumentSnapshot(text: string, featureId: string): ProjectDocumentSnapshot {
  if (Buffer.byteLength(text) > 2097152) throw new Error('project_document_snapshot_limit');
  const raw = object(JSON.parse(text), ['schemaVersion', 'featureId', 'documents', 'missing', 'omissions', 'mapping', 'featureMapped', 'repositoryHead', 'source']);
  if (raw.source !== undefined && raw.source !== 'managed-project-documents') throw new Error('project_document_snapshot_invalid');
  if (raw.schemaVersion !== 1 || raw.featureId !== featureId || !Array.isArray(raw.documents) || raw.documents.length > 128
    || typeof raw.featureMapped !== 'boolean' || !Array.isArray(raw.missing) || !Array.isArray(raw.omissions)
    || [...raw.missing, ...raw.omissions].some(x => typeof x !== 'string' || x.length > 600)) throw new Error('project_document_snapshot_invalid');
  if (raw.repositoryHead !== null && (typeof raw.repositoryHead !== 'string' || !/^[a-f0-9]{40,64}$/.test(raw.repositoryHead))) {
    throw new Error('project_document_snapshot_invalid');
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const value of raw.documents) {
    const doc = object(value, ['path', 'role', 'required', 'content', 'sizeBytes', 'sha256', 'documentId', 'version']);
    entries([{ path: doc.path, role: doc.role, required: doc.required }]);
    if (paths.has(doc.path as string) || typeof doc.content !== 'string' || doc.sizeBytes !== Buffer.byteLength(doc.content)
      || Number(doc.sizeBytes) > 262144 || doc.sha256 !== hash(doc.content)) throw new Error('project_document_snapshot_invalid');
    totalBytes += Number(doc.sizeBytes);
    if (totalBytes > 1048576) throw new Error('project_document_snapshot_limit');
    paths.add(doc.path as string);
    if (doc.documentId !== undefined && (typeof doc.documentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(doc.documentId)
      || !Number.isSafeInteger(doc.version) || Number(doc.version) < 1)) throw new Error('project_document_snapshot_invalid');
  }
  if (raw.source === 'managed-project-documents' && (raw.featureMapped !== true
    || raw.missing.length > 0 || raw.omissions.length > 0
    || !raw.documents.some(value => {
      const doc = value as Record<string, unknown>;
      return doc.role === 'prd' && doc.required === true;
    }))) throw new Error('project_document_required_missing');
  if (raw.mapping !== null) {
    const m = object(raw.mapping, ['path', 'sha256', 'content']);
    if (m.path !== MAPPING || typeof m.content !== 'string' || Buffer.byteLength(m.content) > 65536 || m.sha256 !== hash(m.content)) {
      throw new Error('project_document_snapshot_invalid');
    }
  }
  return raw as unknown as ProjectDocumentSnapshot;
}

export function createProjectDocumentTool(snapshot: ProjectDocumentSnapshot, templates: PromptTemplateCatalog): PiSubmissionToolDefinition {
  return { name: 'read_project_document', label: 'read_project_document', executionMode: 'sequential',
    description: templates.render('runtime/tools/read_project_document.md'),
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const doc = snapshot.documents.find(doc => doc.path === (params as { path?: unknown }).path);
      if (!doc) {
        throw new Error(`project_document_not_bound: ${templates.render('runtime/tools/read_project_document.md')}`);
      }
      return { content: [{ type: 'text', text: doc.content }], details: { path: doc.path, sha256: doc.sha256, sizeBytes: doc.sizeBytes, frozen: true } };
    } };
}
