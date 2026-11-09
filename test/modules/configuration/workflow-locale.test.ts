import { expect, it } from 'vitest';
import { validateSettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';
import { mergeEffectiveSettings } from '../../../packages/core/src/application/effective-settings.ts';
import { loadBuiltinPromptTemplates } from '../../../packages/core/src/adapters/fs/prompt-templates.ts';
import { createPromptTemplateCatalog } from '../../../packages/core/src/ports/prompt-templates.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

it('defaults to English and accepts only global English/Chinese locale', () => {
  expect(mergeEffectiveSettings({}).locale).toBe('en-US');
  expect(validateSettingsPayload({ schemaVersion: 2, locale: 'zh-CN' }, { operation: 'test', entity: { type: 'global_settings' } }).locale).toBe('zh-CN');
  expect(mergeEffectiveSettings({ global: { scopeRevision: 1, payload: { schemaVersion: 2, locale: 'zh-CN' } } }).locale).toBe('zh-CN');
  for (const locale of ['fr-FR', '', 'en', null]) expect(() => validateSettingsPayload({ schemaVersion: 2, locale }, { operation: 'test' })).toThrow();
  expect(() => validateSettingsPayload({ schemaVersion: 2, locale: 'zh-CN' }, { operation: 'test', entity: { type: 'project_settings', projectId: 'p' } })).toThrow();
});

it('selects bilingual prompts, records locale provenance and falls back to English per module', () => {
  const templates = loadBuiltinPromptTemplates();
  expect(templates.locale).toBe('en-US');
  expect(templates.render('languages/common.md')).toContain('Red');
  expect(templates.render('languages/common.md')).not.toContain('通用开发规范');
  const zh = templates.forLocale('zh-CN');
  expect(zh.render('languages/common.md')).toContain('通用开发规范');
  expect(zh.render('runtime/reply-language.md')).toContain('中文');
  expect(templates.render('runtime/reply-language.md')).toContain('English');
  const fallback = createPromptTemplateCatalog({ 'en-us/test.md': 'English {{value}}' }).forLocale('zh-CN');
  expect(fallback.render('test.md', { value: '保留原文' })).toBe('English 保留原文');
  expect(fallback.provenance(['test.md'])).toMatchObject({ locale: 'zh-CN', modules: [{ id: 'test.md', locale: 'en-US' }] });
  expect(() => templates.forLocale('fr-FR')).toThrow();
});

it('keeps the catalog immutable even when the caller changes its original input', () => {
  const input = { 'en-us/test.md': 'original' };
  const catalog = createPromptTemplateCatalog(input);
  input['en-us/test.md'] = 'changed';
  expect(catalog.forLocale('zh-CN').render('test.md')).toBe('original');
});

it('ships matching module/variable sets and English assets without untranslated copy', () => {
  const root = new URL('../../../packages/core/prompts/', import.meta.url);
  const en = readdirSync(new URL('en-US/', root), { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('.md')).sort();
  const zh = readdirSync(new URL('zh-CN/', root), { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('.md')).sort();
  expect(en).toEqual(zh);
  for (const path of en) {
    const english = readFileSync(new URL('en-US/' + path, root), 'utf8');
    const chinese = readFileSync(new URL('zh-CN/' + path, root), 'utf8');
    expect(english, path).not.toMatch(/[\p{Script=Han}]/u);
    const variables = (s: string) => [...new Set(s.match(/{{\s*[\w.]+\s*}}/g) ?? [])].sort();
    expect(variables(english), path).toEqual(variables(chinese));
  }
});

it('freezes Task language in prompt/snapshot/manifest identity while preserving user content', () => {
  const builder = createContextBuilder({ promptTemplates: loadBuiltinPromptTemplates(), budget: {
    maxPromptBytes: 200000, maxRequiredSnapshotBytes: 100000, maxRequiredInputRefs: 8,
    maxHistoryEntries: 20, maxHistoryEntryChars: 120, bytesPerTokenEstimate: 4,
  } });
  const input = { projectId: 'p', featureId: 'f', taskId: 't', task: {
    title: '保留任务原文', description: '不翻译用户数据', acceptance: { criteria: ['中文验收要求'] },
    requirementsRefs: [], dependencies: [], languages: ['typescript'], executionConfig: { runtime: 'pi', provider: 'p', model: 'm' },
    configSource: 'global_default', configSourceKey: 'default',
  }, checkPolicy: { digest: 'a'.repeat(64) }, permissions: { grants: [] }, requiredInputs: [] };
  const en = builder.build(input), zh = builder.build({ ...input, locale: 'zh-CN' });
  expect(en.inputSnapshot.locale).toBe('en-US');
  expect(zh.inputManifest.locale).toBe('zh-CN');
  expect(en.prompt).toContain('Use English for progress');
  expect(zh.prompt).toContain('使用中文报告进展');
  for (const value of [en, zh]) {
    expect(value.prompt).toContain('中文验收要求');
    expect(value.inputSnapshot.task.title).toBe('保留任务原文');
    expect(value.inputManifest.promptTemplates?.modules.map(m => m.id)).toContain('runtime/reply-language.md');
  }
  expect(en.digests.snapshotDigest).not.toBe(zh.digests.snapshotDigest);
  expect(en.digests.manifestDigest).not.toBe(zh.digests.manifestDigest);
  expect(builder.build(input)).toEqual(en);
  expect(() => builder.build({ ...input, locale: 'fr-FR' })).toThrow();
});

it.each([undefined, 'zh-CN'] as const)('migrates legacy global settings without losing payload or an explicit locale: %s', async locale => {
  const sandbox = createTempSandbox('shiploop-locale-migration-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.filter(m => m.version < 67) });
    const payload = { schemaVersion: 2, policies: { piExecution: { codemode: true } }, ...(locale ? { locale } : {}) };
    session.database.prepare('INSERT INTO global_settings (id,created_at,revision,updated_at,schema_version,payload) VALUES (?,?,?,?,?,?)')
      .run('global', 1, 4, 1, 2, JSON.stringify(payload));
    await migrateSqliteStorage(session);
    const row = session.database.prepare('SELECT revision,payload FROM global_settings').get() as { revision: number; payload: string };
    expect(JSON.parse(row.payload)).toEqual({ ...payload, locale: locale ?? 'en-US' });
    expect(row.revision).toBe(locale ? 4 : 5);
    await migrateSqliteStorage(session);
    expect(session.database.prepare('SELECT revision FROM global_settings').get()).toEqual({ revision: row.revision });
    expect(session.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { session.close(); sandbox.cleanup(); }
});
