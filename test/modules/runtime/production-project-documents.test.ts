import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { captureProjectDocuments, createProjectDocumentTool, parseProjectDocumentSnapshot } from '../../../packages/host/src/runtime/production-project-documents.js';
import { loadBuiltinPromptTemplates } from '../../../packages/core/src/adapters/fs/prompt-templates.js';

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'shiploop-documents-'));
  try { await mkdir(join(cwd, 'docs')); await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

it('binds only exact Feature IDs and reads the frozen copy after the source changes', async () => fixture(async cwd => {
  await writeFile(join(cwd, 'docs/README.md'), 'index');
  await writeFile(join(cwd, 'docs/current.md'), 'original requirements');
  await writeFile(join(cwd, 'docs/other.md'), 'unrelated');
  await writeFile(join(cwd, 'docs/shiploop-context.json'), JSON.stringify({ schemaVersion: 1,
    shared: [{ path: 'docs/README.md', role: 'index', required: true }],
    features: {
      'feature-1': [{ path: 'docs/current.md', role: 'prd', required: true }],
      'feature-2': [{ path: 'docs/other.md', role: 'prd', required: true }],
    } }));
  const snapshot = await captureProjectDocuments(cwd, 'feature-1');
  expect(snapshot.featureMapped).toBe(true);
  expect(snapshot.documents.map(doc => doc.path)).toEqual(['docs/README.md', 'docs/current.md']);
  expect(snapshot.mapping?.sha256).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(cwd, 'docs/current.md'), 'changed requirements');
  const parsed = parseProjectDocumentSnapshot(JSON.stringify(snapshot), 'feature-1');
  const tool = createProjectDocumentTool(parsed, loadBuiltinPromptTemplates('zh-CN'));
  expect(await tool.execute('read', { path: 'docs/current.md' })).toMatchObject({
    content: [{ text: 'original requirements' }], details: { frozen: true, sha256: snapshot.documents[1].sha256 },
  });
  await expect(tool.execute('unbound', { path: 'docs/other.md' })).rejects.toThrow('project_document_not_bound');
  expect(await readFile(join(cwd, 'docs/current.md'), 'utf8')).toBe('changed requirements');
  expect((await captureProjectDocuments(cwd, 'f01')).featureMapped).toBe(false);
  expect((await captureProjectDocuments(cwd, 'f01')).documents.map(doc => doc.path)).toEqual(['docs/README.md']);
  expect(() => parseProjectDocumentSnapshot(JSON.stringify(snapshot), 'feature-2')).toThrow();
  snapshot.documents[0].content = 'tampered';
  expect(() => parseProjectDocumentSnapshot(JSON.stringify(snapshot), 'feature-1')).toThrow('project_document_snapshot_invalid');
}));

it.each(['../outside.md', '/tmp/outside.md', '.git/data.md', 'node_modules/data.md', 'docs/../outside.md'])('rejects unsafe explicit document path %s', async path => fixture(async cwd => {
  await writeFile(join(cwd, 'docs/shiploop-context.json'), JSON.stringify({ schemaVersion: 1,
    shared: [{ path, role: 'architecture', required: true }] }));
  await expect(captureProjectDocuments(cwd, 'feature-1')).rejects.toThrow('project_document_mapping_invalid');
}));

it('fails for missing explicit inputs instead of silently dropping requirements', async () => fixture(async cwd => {
  await writeFile(join(cwd, 'docs/shiploop-context.json'), JSON.stringify({ schemaVersion: 1,
    shared: [{ path: 'docs/missing.md', role: 'architecture', required: true }] }));
  await expect(captureProjectDocuments(cwd, 'feature-1')).rejects.toThrow();
}));

it('does not follow discovered symlinks and rejects explicitly selected symlinks', async () => fixture(async cwd => {
  await writeFile(join(cwd, 'outside.md'), 'private');
  await symlink(join(cwd, 'outside.md'), join(cwd, 'docs/link.md'));
  expect((await captureProjectDocuments(cwd, 'feature-1')).documents).toEqual([]);
  await writeFile(join(cwd, 'docs/shiploop-context.json'), JSON.stringify({ schemaVersion: 1,
    shared: [{ path: 'docs/link.md', role: 'design', required: true }] }));
  await expect(captureProjectDocuments(cwd, 'feature-1')).rejects.toThrow('file_path_rejected');
}));

it('reports absent conventional entry points and oversized optional candidates', async () => fixture(async cwd => {
  await writeFile(join(cwd, 'docs/large.md'), 'x'.repeat(262145));
  const snapshot = await captureProjectDocuments(cwd, 'feature-1');
  expect(snapshot.documents).toEqual([]);
  expect(snapshot.missing).toContain('docs/README.md');
  expect(snapshot.omissions).toContain('docs/large.md:unavailable');
  expect(snapshot.featureMapped).toBe(false);
}));

it('rejects required documents exceeding the total snapshot budget', async () => fixture(async cwd => {
  const shared = [];
  for (let i = 0; i < 5; i++) {
    const path = `docs/required-${i}.md`;
    shared.push({ path, role: 'design', required: true });
    await writeFile(join(cwd, path), 'x'.repeat(262144));
  }
  await writeFile(join(cwd, 'docs/shiploop-context.json'), JSON.stringify({ schemaVersion: 1, shared }));
  await expect(captureProjectDocuments(cwd, 'feature-1')).rejects.toThrow('project_document_total_limit');
}));

it('keeps localized prompts path-only and names the frozen reader', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    const templates = loadBuiltinPromptTemplates(locale);
    expect(templates.render('runtime/project-documents.md', { index: 'docs/README.md', evidence: 'artifact-id' }))
      .toContain('read_project_document');
    expect(templates.render('runtime/tools/read_project_document.md')).toContain('SHA-256');
  }
});

it('rejects incomplete managed snapshots before a model can use them', async () => fixture(async cwd => {
  await writeFile(join(cwd, 'docs/README.md'), 'index');
  const snapshot = { ...await captureProjectDocuments(cwd, 'feature-1'), source: 'managed-project-documents',
    featureMapped: true, missing: [], omissions: [] };
  expect(() => parseProjectDocumentSnapshot(JSON.stringify(snapshot), 'feature-1'))
    .toThrow('project_document_required_missing');
  const prd = { ...snapshot.documents[0], role: 'prd', required: true };
  const complete = { ...snapshot, documents: [prd] };
  expect(parseProjectDocumentSnapshot(JSON.stringify(complete), 'feature-1').documents).toHaveLength(1);
  for (const override of [{ featureMapped: false }, { missing: ['feature/prd.md'] },
    { omissions: ['feature/prd.md:unavailable'] }, { documents: [{ ...prd, required: false }] }]) {
    expect(() => parseProjectDocumentSnapshot(JSON.stringify({ ...complete, ...override }), 'feature-1'))
      .toThrow('project_document_required_missing');
  }
  expect(() => parseProjectDocumentSnapshot(JSON.stringify({ ...complete, documents: [{ ...prd, content: 'tampered' }] }), 'feature-1'))
    .toThrow('project_document_snapshot_invalid');
}));

it.each(['en-US', 'zh-CN'] as const)('explains artifact/path confusion in %s without exposing other paths', async locale => fixture(async cwd => {
  await writeFile(join(cwd, 'docs/README.md'), 'index');
  const snapshot = await captureProjectDocuments(cwd, 'feature-1');
  const tool = createProjectDocumentTool(snapshot, loadBuiltinPromptTemplates(locale));
  let error: unknown;
  try { await tool.execute('wrong', { path: 'managed-documents/contexts/feature-1/hash' }); } catch (caught) { error = caught; }
  expect(String(error)).toContain('project_document_not_bound');
  expect(String(error)).toContain('read_project_document');
  expect(String(error)).toContain(locale === 'zh-CN' ? '准确相对路径' : 'exact relative path');
  expect(String(error)).not.toContain(cwd);
}));

it('records Git HEAD separately from the captured working-file hashes', async () => fixture(async cwd => {
  execFileSync('/usr/bin/git', ['init', '-q', cwd]);
  execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'test baseline']);
  await writeFile(join(cwd, 'docs/README.md'), 'uncommitted document');
  const snapshot = await captureProjectDocuments(cwd, 'feature-1');
  expect(snapshot.repositoryHead).toBe(execFileSync('/usr/bin/git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  expect(snapshot.documents[0].content).toBe('uncommitted document');
}));
