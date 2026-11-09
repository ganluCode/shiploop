import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkflowLocale, type WorkflowLocale } from 'shiploop-host';

const SKILL_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));
const SKILL_FILES = ['SKILL.md', 'references/project-init.md', 'references/providers.md', 'references/execution.md', 'references/diagnostics.md', 'references/cli.md', 'references/host.md', 'references/documentation.md', 'references/configuration-files.md', 'references/production-runtime.md', 'templates/feature-prd.md', 'templates/technical-design.md', 'templates/shiploop.yaml', 'templates/shiploop-context.json'] as const;
const SKILL_BUNDLES = [
  { name: 'shiploop', files: SKILL_FILES },
  { name: 'shiploop-plan-feature', files: ['SKILL.md', 'feature-map.md'] },
] as const;
const HARNESS_ROOTS = ['.agents', '.claude'] as const;

export type ShiploopSkillsSyncResult = { readonly status: 'synced'; readonly files: readonly string[] };

function rejectSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('shiploop_skills_target_symlink');
}

function skillSource(bundle: typeof SKILL_BUNDLES[number], relative: string, locale: WorkflowLocale): string {
  const localized = join(SKILL_ROOT, bundle.name, 'locales', locale, relative);
  return lstatSync(localized, { throwIfNoEntry: false })?.isFile() ? localized
    : join(SKILL_ROOT, bundle.name, 'locales', 'en-US', relative);
}

function stageSkills(stage: string, bundle: typeof SKILL_BUNDLES[number], locale: WorkflowLocale): void {
  for (const relative of bundle.files) {
    const source = skillSource(bundle, relative, locale);
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`shiploop_skill_missing:${relative}`);
    const target = join(stage, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
}

/** Synchronizes only the package-owned ShipLoop Skill directories. */
export function syncShiploopSkills(repositoryRoot: string, language: unknown = 'en-US'): ShiploopSkillsSyncResult {
  const locale = resolveWorkflowLocale(language);
  for (const bundle of SKILL_BUNDLES) for (const relative of bundle.files) {
    const source = skillSource(bundle, relative, locale);
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile() || lstatSync(source).isSymbolicLink()) throw new Error('shiploop_skill_missing');
  }
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot) {
    throw new TypeError('repositoryRoot must be a canonical absolute directory');
  }
  // Preflight both roots before creating directories or replacing any managed content.
  for (const harness of HARNESS_ROOTS) {
    for (const part of [harness, `${harness}/skills`, ...SKILL_BUNDLES.map(bundle => `${harness}/skills/${bundle.name}`)]) {
      const path = join(repositoryRoot, part);
      rejectSymlink(path);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error('shiploop_skills_target_not_directory');
    }
  }
  for (const harness of HARNESS_ROOTS) for (const bundle of SKILL_BUNDLES) {
    const relativeRoot = `${harness}/skills/${bundle.name}`;
    const target = join(repositoryRoot, relativeRoot);
    rejectSymlink(target);
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true });
    const stage = join(parent, `.shiploop-staging-${randomUUID()}`);
    const backup = join(parent, `.shiploop-backup-${randomUUID()}`);
    let backedUp = false;
    try {
      stageSkills(stage, bundle, locale);
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
  return { status: 'synced', files: [...SKILL_FILES, ...SKILL_BUNDLES[1].files.map(file => `shiploop-plan-feature/${file}`)] };
}
