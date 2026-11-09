import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { syncShiploopSkills } from '../../../packages/cli/src/shiploop-skills.ts';

describe('ShipLoop official Skills sync', () => {
  it('defaults to English and switches only managed bundles to Chinese on explicit resync', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-locale-skills-')));
    try {
      syncShiploopSkills(root);
      for (const harness of ['.agents', '.claude']) {
        expect(readFileSync(join(root, harness, 'skills/shiploop/SKILL.md'), 'utf8')).toContain('Project Operations');
        expect(readFileSync(join(root, harness, 'skills/shiploop-plan-feature/SKILL.md'), 'utf8')).toContain('current Harness');
      }
      syncShiploopSkills(root, 'zh-CN');
      const path = join(root, '.agents/skills/shiploop/SKILL.md');
      const chinese = readFileSync(path, 'utf8');
      expect(chinese).toContain('项目操作');
      expect(() => syncShiploopSkills(root, 'fr-FR')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(chinese);
      syncShiploopSkills(root, 'en-US');
      expect(readFileSync(path, 'utf8')).toContain('Project Operations');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects a linked planning Skill before replacing either official Skill', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-plan-link-')));
    try {
      const managed = join(root, '.agents/skills/shiploop');
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, 'SKILL.md'), 'keep until all targets pass preflight');
      const external = join(root, 'external');
      mkdirSync(external);
      symlinkSync(external, join(root, '.agents/skills/shiploop-plan-feature'));
      expect(() => syncShiploopSkills(root)).toThrow('shiploop_skills_target_symlink');
      expect(readFileSync(join(managed, 'SKILL.md'), 'utf8')).toBe('keep until all targets pass preflight');
      expect(existsSync(join(external, 'SKILL.md'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
