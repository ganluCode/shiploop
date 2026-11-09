import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createProductionFileTools, loadProductionInstructions } from '../../../packages/host/src/runtime/production-pi-tools.js';
import { discoverProjectDocuments } from '../../../packages/host/src/runtime/production-project-documents.js';

it('loads only root and target-ancestor instructions, including new target directories', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'production-instructions-'));
  try {
    await mkdir(join(cwd, 'src'));
    await mkdir(join(cwd, 'other'));
    await writeFile(join(cwd, 'AGENTS.md'), 'root rules');
    await writeFile(join(cwd, 'src/AGENTS.md'), 'src rules');
    await writeFile(join(cwd, 'other/AGENTS.md'), 'unrelated rules');
    expect((await loadProductionInstructions(cwd, 'src/new/file.ts')).map(record => record.content)).toEqual(['root rules', 'src rules']);
    await expect(loadProductionInstructions(cwd, '../outside.ts')).rejects.toThrow('file_path_rejected');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('indexes bounded project design documents by path and hash without reading unrelated trees', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'production-doc-index-'));
  try {
    await mkdir(join(cwd, 'docs/product'), { recursive: true });
    await mkdir(join(cwd, 'docs/architecture'), { recursive: true });
    await mkdir(join(cwd, 'docs/phases/p01/features'), { recursive: true });
    await mkdir(join(cwd, 'docs/phases/p01/designs'), { recursive: true });
    await mkdir(join(cwd, 'vendor/docs'), { recursive: true });
    await writeFile(join(cwd, 'docs/README.md'), '# index');
    await writeFile(join(cwd, 'docs/product/overview.md'), '# product');
    await writeFile(join(cwd, 'docs/architecture/overview.md'), '# architecture');
    await writeFile(join(cwd, 'docs/phases/p01/scope.md'), '# scope');
    await writeFile(join(cwd, 'docs/phases/p01/features/f01.md'), '# feature');
    await writeFile(join(cwd, 'docs/phases/p01/designs/f01.md'), '# design');
    await writeFile(join(cwd, 'vendor/docs/secret.md'), 'do not index');
    const entries = await discoverProjectDocuments(cwd);
    expect(entries.map(entry => entry.path)).toEqual([
      'docs/README.md',
      'docs/architecture/overview.md',
      'docs/phases/p01/designs/f01.md',
      'docs/phases/p01/features/f01.md',
      'docs/phases/p01/scope.md',
      'docs/product/overview.md',
    ]);
    expect(entries.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(entries.some(entry => entry.path.includes('vendor'))).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('patches exact text, rejects ambiguous/stale edits and leaves the file intact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'production-tools-'));
  try {
    await writeFile(join(cwd, 'code.ts'), 'one\none\ntwo\n');
    const tools = createProductionFileTools({ cwd, deadline: Date.now() + 60000 });
    const patch = tools.find(tool => tool.name === 'edit_file')!;
    await expect(patch.execute('a', { path: 'code.ts', oldText: 'one', newText: 'new' })).rejects.toThrow('edit_match_ambiguous');
    await patch.execute('b', { path: 'code.ts', oldText: 'two', newText: 'three' });
    expect(await readFile(join(cwd, 'code.ts'), 'utf8')).toBe('one\none\nthree\n');
    await expect(patch.execute('c', { path: 'code.ts', oldText: 'three', newText: 'four', expectedHash: '0'.repeat(64) })).rejects.toThrow('edit_content_changed');
    const read = tools.find(tool => tool.name === 'read_file')!;
    const result = await read.execute('d', { path: 'code.ts' });
    expect(JSON.stringify(result)).toContain('three');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
