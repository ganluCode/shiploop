import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateManagedDocumentSources } from '../../ports/managed-documents.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function createManagedDocumentDrafts(dataRoot: string) {
  const root = (projectId: string) => join(dataRoot, 'projects', projectId, 'documents', 'working');
  async function target(projectId: string, path: string, create: boolean): Promise<string> {
    validateManagedDocumentSources([{ path, role: 'prd' }]);
    let current = dataRoot;
    for (const part of ['projects', projectId, 'documents', 'working', ...path.split('/').slice(0, -1)]) {
      current = join(current, part);
      if (create) await mkdir(current, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('managed_document_path_rejected');
    }
    return join(root(projectId), path);
  }
  async function read(projectId: string, path: string) {
    const file = await open(await target(projectId, path, false), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error('managed_document_size_or_path');
      const bytes = Buffer.alloc(262145);
      let size = 0;
      while (size < bytes.length) {
        const result = await file.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 262144) throw new Error('managed_document_size_or_path');
      const after = await file.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('managed_document_changed_during_read');
      const body = bytes.subarray(0, size);
      return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), sha256: digest(body), sizeBytes: size };
    } finally { await file.close(); }
  }
  return { root, read,
    async ensure(projectId: string) { await target(projectId, 'README.md', true); return root(projectId); },
    async write(projectId: string, path: string, content: string, expectedHash?: string) {
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > 262144) throw new Error('managed_document_size_limit');
      const final = await target(projectId, path, true);
      let previous: Awaited<ReturnType<typeof read>> | undefined;
      try { previous = await read(projectId, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const sha256 = digest(bytes);
      if (previous?.sha256 === sha256) return { path, sha256, status: 'unchanged' as const };
      if (previous ? expectedHash !== previous.sha256 : expectedHash !== undefined) throw new Error('managed_document_changed');
      const temporary = join(dirname(final), '.document-' + randomUUID());
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(bytes); await file.sync(); await file.close();
        if (previous) {
          if ((await read(projectId, path)).sha256 !== previous.sha256) throw new Error('managed_document_changed');
          await rename(temporary, final);
        } else {
          // Copying a new draft must not overwrite another writer's newly created file.
          const { link } = await import('node:fs/promises');
          await link(temporary, final);
        }
        return { path, sha256, status: previous ? 'updated' as const : 'created' as const };
      } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
    } };
}
