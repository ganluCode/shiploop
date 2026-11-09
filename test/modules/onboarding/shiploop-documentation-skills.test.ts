import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { syncShiploopSkills } from '../../../packages/cli/src/shiploop-skills.js';
import { readSettingsFile } from '../../../packages/cli/src/config-file.js';
import { validateSettingsPayload } from '../../../packages/core/src/ports/settings-schema.js';

it('init 同步文档规范和模板，重复同步不覆盖项目文档和其他 Skill', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-doc-skills-')));
  const files = ['references/documentation.md', 'templates/feature-prd.md', 'templates/technical-design.md', 'references/configuration-files.md', 'references/production-runtime.md', 'templates/shiploop.yaml', 'templates/shiploop-context.json'];
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/README.md'), 'existing docs');
    mkdirSync(join(root, '.agents/skills/custom'), { recursive: true });
    writeFileSync(join(root, '.agents/skills/custom/SKILL.md'), 'custom skill');
    const result = syncShiploopSkills(root, 'zh-CN');
    for (const file of files) expect(result.files).toContain(file);
    for (const harness of ['.agents', '.claude']) {
      const target = join(root, harness, 'skills/shiploop');
      expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('references/documentation.md');
      const planningRoot = join(root, harness, 'skills/shiploop-plan-feature');
      const planning = readFileSync(join(planningRoot, 'SKILL.md'), 'utf8');
      expect(planning).toContain('当前对话模型');
      expect(planning).toContain('共享');
      expect(planning).toContain('feature dependencies');
      expect(readFileSync(join(planningRoot, 'feature-map.md'), 'utf8')).toContain('DAG');
      writeFileSync(join(planningRoot, 'feature-map.md'), 'stale');
      for (const file of files) expect(readFileSync(join(target, file), 'utf8').length).toBeGreaterThan(100);
      expect(JSON.parse(readFileSync(join(target, 'templates/shiploop-context.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, shared: expect.any(Array), features: {} });
      expect(validateSettingsPayload(readSettingsFile(join(target, 'templates/shiploop.yaml'), 'config.create', true), { operation: 'test.template' }))
        .toMatchObject({ strategies: { modelMap: { medium: { fallbacks: [{ provider: 'ark-agentplan' }, { provider: 'wlb' }] } } } });
      writeFileSync(join(target, 'templates/feature-prd.md'), 'stale');
    }
    syncShiploopSkills(root, 'zh-CN');
    for (const harness of ['.agents', '.claude']) {
      expect(readFileSync(join(root, harness, 'skills/shiploop-plan-feature/feature-map.md'), 'utf8')).toContain('DAG');
      expect(readFileSync(join(root, harness, 'skills/shiploop/templates/feature-prd.md'), 'utf8')).not.toBe('stale');
    }
    expect(readFileSync(join(root, 'docs/README.md'), 'utf8')).toBe('existing docs');
    expect(readFileSync(join(root, '.agents/skills/custom/SKILL.md'), 'utf8')).toBe('custom skill');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
