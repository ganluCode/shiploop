import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { syncShiploopSkills } from '../../../packages/cli/src/shiploop-skills.ts';

describe('ShipLoop official Skills sync', () => {
  it('writes the same official Skill into both Harness directories', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-skills-')));
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });

    const result = syncShiploopSkills(root);
    const agents = join(root, '.agents', 'skills', 'shiploop', 'SKILL.md');
    const claude = join(root, '.claude', 'skills', 'shiploop', 'SKILL.md');

    expect(result.status).toBe('synced');
    expect(existsSync(agents)).toBe(true);
    expect(readFileSync(agents, 'utf8')).toBe(readFileSync(claude, 'utf8'));
    expect(readFileSync(agents, 'utf8')).toContain('shiploop project init');
  });

  it('replaces only the managed ShipLoop directory and preserves other user Skills', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-skills-')));
    const userSkill = join(root, '.agents', 'skills', 'my-skill', 'SKILL.md');
    mkdirSync(join(root, '.agents', 'skills', 'my-skill'), { recursive: true });
    writeFileSync(userSkill, 'user skill');
    const managed = join(root, '.agents', 'skills', 'shiploop', 'SKILL.md');
    mkdirSync(join(root, '.agents', 'skills', 'shiploop'), { recursive: true });
    writeFileSync(managed, 'old version');

    syncShiploopSkills(root);
    const second = syncShiploopSkills(root);

    expect(second.status).toBe('synced');
    expect(readFileSync(userSkill, 'utf8')).toBe('user skill');
    expect(readFileSync(managed, 'utf8')).not.toBe('old version');
  });
});
