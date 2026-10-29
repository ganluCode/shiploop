import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ProjectResourceCandidateSources } from '../../application/project-resource-service.js';
import type { ProjectResourceSourceInput, ProjectResourceSourceResult } from '../../ports/project-resource-sources.js';
import { StorageError } from '../../ports/errors.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BYTES = 1_048_576;
type Entry = { projectId: string; sourceId: string; path: string | null; revision: number };

function fail(kind: 'validation' | 'conflict' | 'io', reason: string): never {
  throw new StorageError(kind === 'io' ? 'corrupt' : kind, 'ProjectResourceSourceDirectory', 'Project source directory rejected', { details: { reason } });
}

/** Host writer lease owns this directory. Synchronous CAS/rename never yields between read and publish. */
export function createLocalProjectResourceSources(dataRoot: string): ProjectResourceCandidateSources {
  const filename = join(dataRoot, 'project-resource-sources.json');
  function load(): Entry[] {
    try {
      let initial;
      try { initial = lstatSync(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      if (!initial.isFile() || initial.isSymbolicLink()) fail('io', 'unsafe_directory');
      const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) fail('io', 'unsafe_directory');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const bytes = readSync(fd, buffer, length, buffer.length - length, null);
          if (bytes === 0) break;
          length += bytes;
        }
        if (length > MAX_BYTES) fail('io', 'unsafe_directory');
        raw = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      } finally { closeSync(fd); }
      if (raw.schemaVersion !== 1 || Object.keys(raw).sort().join() !== 'entries,schemaVersion' || !Array.isArray(raw.entries)) fail('io', 'invalid_directory');
      const seen = new Set<string>();
      for (const item of raw.entries) {
        if (item === null || typeof item !== 'object' || Object.keys(item).sort().join() !== 'path,projectId,revision,sourceId'
          || !UUID.test(item.projectId) || !UUID.test(item.sourceId) || !Number.isSafeInteger(item.revision) || item.revision < 1
          || (item.path !== null && (typeof item.path !== 'string' || !isAbsolute(item.path) || item.path.includes('\0')))) fail('io', 'invalid_directory');
        const key = `${item.projectId}:${item.sourceId}`;
        if (seen.has(key)) fail('io', 'duplicate_source');
        seen.add(key);
      }
      return raw.entries as Entry[];
    } catch (error) {
      if (error instanceof StorageError) throw error;
      fail('io', 'directory_read_failed');
    }
  }
  function save(entries: Entry[]) {
    const bytes = JSON.stringify({ schemaVersion: 1, entries });
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('validation', 'source_limit');
    const tmp = filename + '.' + randomUUID() + '.tmp';
    try {
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, filename);
      const directory = openSync(dataRoot, constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { fail('io', 'directory_publish_failed'); }
    finally { try { unlinkSync(tmp); } catch { /* Already published, or never created. */ } }
  }
  return {
    getSource(projectId, sourceId) {
      const entry = load().find(e => e.projectId === projectId && e.sourceId === sourceId);
      if (!entry || entry.path === null) return null;
      try {
        if (realpathSync(entry.path) !== entry.path || lstatSync(entry.path).isSymbolicLink()) return null;
      } catch { return null; }
      return { projectId, sourceId, path: entry.path };
    },
    configure(input: ProjectResourceSourceInput): ProjectResourceSourceResult {
      const entries = load();
      const entry = entries.find(e => e.projectId === input.projectId && e.sourceId === input.sourceId);
      let path: string | null = null;
      if (input.action === 'register') {
        try {
          if (!input.manifestPath || !isAbsolute(input.manifestPath) || lstatSync(input.manifestPath).isSymbolicLink()) fail('validation', 'invalid_source_file');
          path = realpathSync(input.manifestPath);
          if (!lstatSync(path).isFile()) fail('validation', 'invalid_source_file');
        } catch { fail('validation', 'invalid_source_file'); }
      }
      // Exact repeats are idempotent; retain tombstones so old registration cannot resurrect a removal.
      if (entry && entry.path === path && (input.expectedRevision === entry.revision || input.expectedRevision === entry.revision - 1)) {
        return { schemaVersion: 1, projectId: input.projectId, sourceId: input.sourceId, revision: entry.revision, registered: path !== null };
      }
      if ((entry?.revision ?? 0) !== input.expectedRevision) fail('conflict', 'stale_source_revision');
      if (!entry && input.action === 'remove') fail('validation', 'unknown_source');
      const next = { projectId: input.projectId, sourceId: input.sourceId, path, revision: input.expectedRevision + 1 };
      if (entry) entries[entries.indexOf(entry)] = next;
      else entries.push(next);
      save(entries);
      return { schemaVersion: 1, projectId: next.projectId, sourceId: next.sourceId, revision: next.revision, registered: next.path !== null };
    },
  };
}
