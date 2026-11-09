import { describe, expect, it } from 'vitest';
import { createPromptTemplateCatalog, selectTaskPromptModules } from '../../../packages/core/src/ports/prompt-templates.ts';
import { loadBuiltinPromptTemplates } from '../../../packages/core/src/adapters/fs/prompt-templates.ts';
import { validatePlanningCandidatePayload } from '../../../packages/core/src/ports/planning-candidates.ts';

describe('Markdown prompt templates', () => {
  it('replaces explicit variables once and never evaluates supplied content', () => {
    const catalog = createPromptTemplateCatalog({ 'task.md': '# {{task.title}}\n{{task.body}}' });
    expect(catalog.render('task.md', { 'task.title': 'T', 'task.body': '{{task.title}} $(touch pwned)' }))
      .toBe('# T\n{{task.title}} $(touch pwned)');
    expect(() => catalog.render('task.md', { 'task.title': 'secret-content' })).toThrow('prompt_variable_missing:task.body');
    expect(() => catalog.render('../task.md')).toThrow();
    expect(() => createPromptTemplateCatalog({ 'bad.md': '{{task.title()}}' })).toThrow();
    expect(() => createPromptTemplateCatalog({ 'bad.md': '{{__proto__.value}}' })).toThrow();
    expect(() => createPromptTemplateCatalog({ 'bad.md': '{{task' })).toThrow();
  });

  it('loads packaged assets and composes only the selected language standards in stable order', () => {
    const catalog = loadBuiltinPromptTemplates();
    const first = selectTaskPromptModules(['typescript', 'sql', 'typescript']);
    expect(first).toEqual(selectTaskPromptModules(['sql', 'typescript']));
    expect(first).toContain('languages/typescript.md');
    expect(first).toContain('languages/sql.md');
    expect(first).not.toContain('languages/python.md');
    expect(new Set(first).size).toBe(first.length);
    expect(selectTaskPromptModules(['unknown-dsl'])).toEqual(['languages/common.md']);
    for (const id of first) expect(catalog.render(id).length).toBeGreaterThan(80);
    expect(catalog.render('planner/complexity.md')).toContain('low');
    expect(catalog.render('planner/complexity.md')).toContain('CAS');
    expect(catalog.render('planner/task-metadata.md')).toContain('languages');
    expect(catalog.provenance(first)).toMatchObject({ version: 1, modules: expect.any(Array) });
  });

  it('clearly separates Core artifact provenance from project document paths', () => {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const context = loadBuiltinPromptTemplates(locale).render('planner/context.md', {
        projectId: 'p', phaseId: 'ph', featureId: 'f', runId: 'r', planningTaskId: 't', candidateId: 'c',
        revision: '1', planDigest: 'digest', planStatus: 'draft', inputDigest: 'input', constraints: 'none',
        acceptance: 'criteria', requirements: '- artifactId=artifact-1 contentHash=hash', approvalMode: 'manual',
        taskLimit: '5', worktreeId: 'w', headCommit: 'head', codeDigest: 'code', configSource: 'project',
        configSourceKey: 'planner', runtime: 'pi', provider: 'provider', model: 'model', credentialLine: '',
        endpointLine: '', permissions: 'trusted', requiredInputs: '- purpose=requirements artifactId=artifact-1',
      });
      expect(context).toContain('read_project_document');
      expect(context).toContain(locale === 'zh-CN' ? '不是文档路径' : 'not document paths');
      expect(context).toMatch(/Core.*(frozen|已冻结)/u);
    }
  });

  it('binds template content changes to provenance and reports missing assets', () => {
    const a = createPromptTemplateCatalog({ 'a.md': 'A' });
    const b = createPromptTemplateCatalog({ 'a.md': 'B' });
    expect(a.provenance(['a.md'])).not.toEqual(b.provenance(['a.md']));
    expect(() => a.render('missing.md')).toThrow('prompt_template_missing:missing.md');
  });

  it('publishes a candidate example that satisfies the official planner schema', () => {
    const text = loadBuiltinPromptTemplates().render('planner/candidate-schema.md', {
      projectId: '"project-1"', featureId: '"feature-1"', runId: '"run-1"', candidateId: '"candidate-1"',
    });
    const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(json).toBeDefined();
    expect(validatePlanningCandidatePayload(JSON.parse(json!)).plan.tasks[0])
      .toMatchObject({ complexity: 'low', labels: ['backend'], languages: ['typescript'] });
  });
});
