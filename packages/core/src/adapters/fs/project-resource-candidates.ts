import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  PROJECT_RESOURCE_CANDIDATE_MAX_BYTES,
  ProjectResourceCandidateDiscoveryError,
  sha256CandidateBytes,
} from '../../ports/project-resource-candidates.js';
import type {
  ProjectResourceCandidateSource,
  ProjectResourceCandidateSourceContent,
  ProjectResourceCandidateSourceReader,
} from '../../ports/project-resource-candidates.js';

function fail(reason: ConstructorParameters<typeof ProjectResourceCandidateDiscoveryError>[0]): never {
  throw new ProjectResourceCandidateDiscoveryError(reason);
}

function validatePath(source: ProjectResourceCandidateSource): void {
  if (source === null || typeof source !== 'object' || !isAbsolute(source.path)
    || source.path.length === 0 || source.path.length > 4096 || source.path.includes('\0')) {
    fail('invalid_path');
  }
}

function fsReason(error: unknown): ConstructorParameters<typeof ProjectResourceCandidateDiscoveryError>[0] {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'source_missing';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'EFBIG' || code === 'ENOMEM') return 'limit_exceeded';
  return 'source_io_failed';
}

/**
 * Reads only the exact file supplied by the caller. It never scans a directory,
 * imports a module, invokes a command, opens an MCP transport, or returns the path.
 */
export function createLocalProjectResourceCandidateSourceReader(options: {
  readonly maxBytes?: number;
} = {}): ProjectResourceCandidateSourceReader {
  const maxBytes = options.maxBytes ?? PROJECT_RESOURCE_CANDIDATE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROJECT_RESOURCE_CANDIDATE_MAX_BYTES) fail('invalid_input');
  return {
    async read(source): Promise<ProjectResourceCandidateSourceContent> {
      validatePath(source);
      let stat;
      try {
        stat = await lstat(source.path);
      } catch (error) {
        fail(fsReason(error));
      }
      if (stat.isSymbolicLink() || !stat.isFile()) fail('invalid_path');
      if (stat.size > maxBytes) fail('limit_exceeded');
      let bytes: Buffer;
      try {
        bytes = await readFile(source.path);
      } catch (error) {
        fail(fsReason(error));
      }
      if (bytes.byteLength > maxBytes) fail('limit_exceeded');
      return { bytes, digest: sha256CandidateBytes(bytes) };
    },
  };
}

export const createProjectResourceCandidateSourceReader = createLocalProjectResourceCandidateSourceReader;
