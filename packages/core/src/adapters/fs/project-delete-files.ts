/** Fixed leaf removal only. Never recursive rm, and never a source-repository path. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PublicError } from '../../ports/commands.js';
import { validateStableId } from '../../ports/validation.js';
import type { ProjectDeleteOperation } from '../../ports/project-delete.js';
import type { ProjectDeleteFileIdentity, ProjectDeleteFilePlan, ProjectDeleteFiles, ProjectDeleteFileTarget } from '../../ports/project-delete-executor.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SCAN = 50_000;
function fail(reason: string): never { throw new PublicError('conflict', 'project.delete.execute', undefined, { details: { reason } }); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function identity(path: string): ProjectDeleteFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) fail('symlink_rejected');
  return { device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}
export function createProjectDeleteFiles(options: { readonly dataRoot: string }): ProjectDeleteFiles {
  if (!isAbsolute(options.dataRoot)) throw new TypeError('dataRoot must be absolute');
  const root = realpathSync(options.dataRoot);
  const rootIdentity = identity(root);
  if (!lstatSync(root).isDirectory()) fail('data_root_changed');
  function absolute(path: string): string {
    if (!path || isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) fail('invalid_managed_target');
    const abs = join(root, path);
    if (!abs.startsWith(root + sep)) fail('outside_managed_root');
    return abs;
  }
  function ancestors(path: string): Record<string, ProjectDeleteFileIdentity> {
    if (!isDeepStrictEqual(identity(root), rootIdentity)) fail('data_root_changed');
    const result: Record<string, ProjectDeleteFileIdentity> = { '.': rootIdentity };
    let part = root;
    for (const name of relative(root, dirname(absolute(path))).split(sep)) {
      part = join(part, name);
      const value = identity(part);
      if (!lstatSync(part).isDirectory() || realpathSync(part) !== part) fail('directory_identity_changed');
      result[relative(root, part)] = value;
    }
    return result;
  }
  function checkAncestors(target: ProjectDeleteFileTarget): void {
    if (!isDeepStrictEqual(ancestors(target.relativePath), target.ancestors)) fail('directory_identity_changed');
  }
  function observe(path: string): ProjectDeleteFileTarget {
    const parents = ancestors(path), abs = absolute(path);
    const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES)) fail('invalid_managed_file');
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        size += count;
        if (size > MAX_FILE_BYTES) fail('file_budget_exhausted');
        hash.update(buffer.subarray(0, count));
      }
      const fileIdentity = { device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
      if (!isDeepStrictEqual(fileIdentity, identity(abs)) || fstatSync(fd, { bigint: true }).mtimeNs !== stat.mtimeNs || BigInt(size) !== stat.size) fail('file_identity_changed');
      return { relativePath: path, identity: fileIdentity, sha256: hash.digest('hex'), sizeBytes: size, ancestors: parents };
    } finally { closeSync(fd); }
  }
  function verifyRemoved(target: ProjectDeleteFileTarget): void {
    checkAncestors(target);
    try { lstatSync(absolute(target.relativePath)); }
    catch (error) { if (missing(error)) return; throw error; }
    fail('cleanup_unconfirmed');
  }
  function assertArea(projectId: string, bodies: readonly ProjectDeleteFileTarget[], staging: readonly ProjectDeleteFileTarget[], empty: boolean): void {
    const allowed = new Set(bodies.map(t => t.relativePath));
    const stageAllowed = new Set(staging.map(t => t.relativePath));
    let remaining = MAX_SCAN;
    const scan = (path: string): string[] => {
      // Check every ancestor even when the leaf directory is absent.
      ancestors(`${path}/entry`);
      try {
        const entries = readdirSync(absolute(path));
        remaining -= entries.length;
        if (remaining < 0) fail('file_scan_incomplete');
        return entries;
      } catch (error) { if (missing(error)) return []; throw error; }
    };
    const finalArea = `projects/${projectId}/artifacts`;
    // Projects with zero artifacts need not have an artifacts directory.
    let names: string[];
    try { names = scan(finalArea); } catch (error) { if (missing(error) && bodies.length === 0) names = []; else throw error; }
    for (const name of names) {
      const path = `${finalArea}/${name}`;
      if (!allowed.has(`${path}/content`)) fail('unregistered_managed_file');
      for (const leaf of scan(path)) if (leaf !== 'content' || empty) fail('unregistered_managed_file');
    }
    let stageNames: string[];
    try { stageNames = scan(`staging/${projectId}`); } catch (error) { if (missing(error) && staging.length === 0) stageNames = []; else throw error; }
    for (const name of stageNames) {
      if (empty || !stageAllowed.has(`staging/${projectId}/${name}`)) fail('unregistered_managed_file');
    }
  }
  return {
    prepare(operation) {
      const inventory = operation.manifest?.inventory;
      if (!inventory || !inventory.complete) fail('manifest_unavailable');
      const projectId = validateStableId(operation.projectId, { operation: 'project.delete.execute' }, 'projectId');
      const bodies = inventory.artifactBodies.map(body => {
        const id = validateStableId(body.artifactId, { operation: 'project.delete.execute' }, 'artifactId');
        const target = observe(`projects/${projectId}/artifacts/${id}/content`);
        if (target.sha256 !== body.sha256 || target.sizeBytes !== body.sizeBytes) fail('artifact_body_changed');
        return target;
      });
      const staging = inventory.objects.filter(o => o.kind === 'artifact-staging-entry').map(o => {
        const prefix = `staging/${projectId}/`;
        if (!o.id.startsWith(prefix) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.part$/.test(o.id.slice(prefix.length))) fail('invalid_staging_target');
        const target = observe(o.id);
        if (!o.file || o.file.sha256 !== target.sha256 || o.file.sizeBytes !== target.sizeBytes) fail('staging_body_changed');
        return target;
      });
      assertArea(projectId, bodies, staging, false);
      return { manifestDigest: operation.manifestDigest, bodies, staging };
    },
    remove(target, guard) {
      guard();
      checkAncestors(target);
      try {
        const actual = observe(target.relativePath);
        if (!isDeepStrictEqual(actual, target)) fail('file_identity_changed');
      } catch (error) { if (missing(error)) { verifyRemoved(target); return; } throw error; }
      guard();
      checkAncestors(target);
      if (!isDeepStrictEqual(identity(absolute(target.relativePath)), target.identity)) fail('file_identity_changed');
      unlinkSync(absolute(target.relativePath));
      const fd = openSync(dirname(absolute(target.relativePath)), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      verifyRemoved(target);
    },
    verifyRemoved,
    assertWorkspacePath(projectId, featureId, registeredPath) {
      validateStableId(projectId, { operation: 'project.delete.execute' }, 'projectId');
      validateStableId(featureId, { operation: 'project.delete.execute' }, 'featureId');
      const path = `projects/${projectId}/worktrees/${featureId}`;
      if (absolute(path) !== registeredPath) fail('workspace_outside_managed_root');
      ancestors(path);
      try {
        if (!lstatSync(registeredPath).isDirectory() || realpathSync(registeredPath) !== registeredPath) fail('directory_identity_changed');
      } catch (error) { if (!missing(error)) throw error; }
    },
    verifyEmpty(operation, plan) {
      if (plan.manifestDigest !== operation.manifestDigest) fail('file_plan_mismatch');
      for (const target of [...plan.bodies, ...plan.staging]) verifyRemoved(target);
      assertArea(operation.projectId, plan.bodies, plan.staging, true);
    },
  };
}
