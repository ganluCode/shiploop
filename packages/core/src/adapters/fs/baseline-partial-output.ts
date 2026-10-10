/** Restart-only read of a collector's persisted staging identity; no arbitrary path API. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { BASELINE_OUTPUT_MAX_BYTES } from '../../application/baseline-evidence.js';
import { validateStableId } from '../../ports/validation.js';

export function createBaselinePartialOutputReader(dataRoot: string) {
  const root = realpathSync(dataRoot);
  return async (projectId: string, relativePath: string): Promise<Uint8Array> => {
    validateStableId(projectId, { operation: 'baseline.recovery' }, 'projectId');
    const prefix = `staging/${projectId}/`;
    if (!relativePath.startsWith(prefix) || !/^[a-zA-Z0-9._-]+\.part$/.test(relativePath.slice(prefix.length))) {
      throw new TypeError('Invalid partial evidence identity');
    }
    const path = join(root, relativePath);
    if (!realpathSync(dirname(path)).startsWith(root + sep)) throw new TypeError('Partial evidence escape');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > BASELINE_OUTPUT_MAX_BYTES) throw new TypeError('Invalid partial evidence file');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (n === 0) throw new TypeError('Partial evidence changed');
        offset += n;
      }
      return bytes;
    } finally { closeSync(fd); }
  };
}
