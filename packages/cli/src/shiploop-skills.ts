import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = fileURLToPath(new URL('../skills/shiploop/', import.meta.url));
const SKILL_FILES = ['SKILL.md', 'references/project-init.md', 'references/providers.md', 'references/execution.md', 'references/diagnostics.md', 'references/cli.md', 'references/host.md'] as const;
const TARGET_ROOTS = ['.agents/skills/shiploop', '.claude/skills/shiploop'] as const;

export type ShiploopSkillsSyncResult = { readonly status: 'synced'; readonly files: readonly string[] };

function rejectSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('shiploop_skills_target_symlink');
}

function stageSkills(stage: string): void {
  for (const relative of SKILL_FILES) {
    const source = join(SKILL_ROOT, relative);
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`shiploop_skill_missing:${relative}`);
    const target = join(stage, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
}

/** Synchronizes only the package-owned ShipLoop Skill directories. */
export function syncShiploopSkills(repositoryRoot: string): ShiploopSkillsSyncResult {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot) {
    throw new TypeError('repositoryRoot must be a canonical absolute directory');
  }
  // Preflight both roots before creating directories or replacing any managed content.
  for (const harness of ['.agents', '.claude']) {
    for (const part of [harness, `${harness}/skills`, `${harness}/skills/shiploop`]) {
      const path = join(repositoryRoot, part);
      rejectSymlink(path);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error('shiploop_skills_target_not_directory');
    }
  }
  for (const relativeRoot of TARGET_ROOTS) {
    const target = join(repositoryRoot, relativeRoot);
    rejectSymlink(target);
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true });
    const stage = join(parent, `.shiploop-staging-${randomUUID()}`);
    const backup = join(parent, `.shiploop-backup-${randomUUID()}`);
    let backedUp = false;
    try {
      stageSkills(stage);
      if (lstatSync(target, { throwIfNoEntry: false })) {
        renameSync(target, backup);
        backedUp = true;
      }
      try { renameSync(stage, target); }
      catch (error) {
        if (backedUp) renameSync(backup, target);
        throw error;
      }
      if (backedUp) rmSync(backup, { recursive: true, force: true });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return { status: 'synced', files: [...SKILL_FILES] };
}
