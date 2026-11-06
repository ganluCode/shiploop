import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { digestWorkingTree } from './p02-3/process-tools.ts';
import type { RepositorySnapshot } from './p02-4/evidence-snapshot.ts';

const source = fileURLToPath(new URL('../../packages/cli/skills/shiploop/', import.meta.url));
export const OFFICIAL_SKILL_ROOTS = ['.agents/skills/shiploop', '.claude/skills/shiploop'] as const;
export const SOURCE_STATUS_ARGS = ['status', '--porcelain', '--', '.', ...OFFICIAL_SKILL_ROOTS.map(root => `:(exclude)${root}`)];

export function isOfficialSkillPath(path: string): boolean {
  return OFFICIAL_SKILL_ROOTS.some(root => path.startsWith(`${root}/`));
}

/** Only the complete package-owned content is allowed as an init side effect. */
export function expectOfficialSkills(root: string) {
  const entries = digestWorkingTree(source).entries;
  expect(entries).toHaveLength(7);
  return OFFICIAL_SKILL_ROOTS.flatMap(target => {
    expect(digestWorkingTree(join(root, target)).entries).toEqual(entries);
    for (const entry of entries) {
      expect(readFileSync(join(root, target, entry.relativePath))).toEqual(readFileSync(join(source, entry.relativePath)));
    }
    return entries.map(entry => ({ ...entry, relativePath: `${target}/${entry.relativePath}` }));
  });
}

export function expectOnlyOfficialSkillsAdded(root: string, before: RepositorySnapshot, after: RepositorySnapshot): void {
  const sort = <T extends { readonly relativePath: string }>(entries: readonly T[]) =>
    [...entries].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  expect(after.headCommit).toBe(before.headCommit);
  expect(after.branch).toBe(before.branch);
  const sourceStatus = (status: string) => status.split('\n')
    .filter(line => line !== '?? .agents/' && line !== '?? .claude/').join('\n');
  expect(sourceStatus(after.statusPorcelain)).toBe(sourceStatus(before.statusPorcelain));
  expect(after.tracked).toEqual(before.tracked);
  expect(sort(after.untracked)).toEqual(sort([...before.untracked, ...expectOfficialSkills(root)]));
}
