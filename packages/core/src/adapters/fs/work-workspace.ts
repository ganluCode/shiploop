import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { RepositoryBindingRecord } from '../../ports/state-store.js';
import type { RepositoryInspector } from '../../ports/repository-inspector.js';
import type { WorkWorkspaceAuthority, VerifiedWorkWorkspace } from '../../ports/work-resources.js';
import { StorageError } from '../../ports/errors.js';
import { createRepositoryInspector } from './repository-inspector.js';

/** Explicit roots are trusted assembly policy, not Planner or command arguments. */
export function createWorkWorkspaceAuthority(options: {
  readonly authorizedRoots: readonly string[];
  readonly inspector?: RepositoryInspector;
}): WorkWorkspaceAuthority {
  const tokens = new WeakSet<object>();
  const inspector = options.inspector ?? createRepositoryInspector();
  const roots = options.authorizedRoots.map(root => {
    if (!isAbsolute(root) || root === sep || root.split(sep).includes('..')) throw new TypeError('Invalid Work authorization root');
    return realpathSync(root);
  });
  const inside = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  };
  return {
    async verify(binding, input) {
      if (typeof input !== 'string' || !isAbsolute(input) || input.split(sep).includes('..') || /[\0-\x1f\x7f]/.test(input)) {
        throw new StorageError('validation', 'WorkWorkspace.verify', 'Invalid workspace path');
      }
      const canonicalPath = realpathSync(input);
      const authorizedRoot = roots.find(root => inside(root, canonicalPath));
      if (!authorizedRoot) throw new StorageError('ownership', 'WorkWorkspace.verify', 'Workspace outside authorized roots');
      const inspected = await inspector.inspect(canonicalPath);
      if (inspected.canonicalPath !== canonicalPath || inspected.repoIdentity !== binding.repoIdentity
        || inspected.gitCommonDir !== binding.gitCommonDir) {
        throw new StorageError('ownership', 'WorkWorkspace.verify', 'Workspace repository identity mismatch');
      }
      const token: VerifiedWorkWorkspace = Object.freeze({ binding: Object.freeze({ ...binding }), authorizedRoot, canonicalPath,
        resourceKey: `workspace:${createHash('sha256').update(JSON.stringify([binding.repoIdentity, canonicalPath])).digest('hex')}` });
      tokens.add(token);
      return token;
    },
    inspect(token) {
      if (!token || typeof token !== 'object' || !tokens.has(token)) {
        throw new StorageError('validation', 'WorkWorkspace.inspect', 'Unverified workspace identity');
      }
      return token as VerifiedWorkWorkspace;
    },
  };
}
