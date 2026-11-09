import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createProductionCommandTools, resolveProductionRg } from '../../../packages/host/src/runtime/production-command-tools.js';

it('runs a command in its fixed cwd and returns nonzero exit, duration and bounded output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'command-tools-'));
  try {
    await writeFile(join(cwd, 'marker.txt'), 'local marker');
    const tools = createProductionCommandTools({ cwd, deadline: Date.now() + 60000, rgPath: resolveProductionRg(),
      terminateInvocation: () => { throw new Error('unexpected termination'); } });
    const result = await tools[0].execute('one', { command: 'cat marker.txt; exit 7' });
    expect(result).toMatchObject({ isError: true, details: { exitCode: 7 } });
    expect(JSON.stringify(result)).toContain('local marker');
    expect((result as { details: { elapsedMs: number } }).details.elapsedMs).toBeGreaterThanOrEqual(0);
    const search = tools.find(t => t.name === 'search_content')!;
    const found = await search.execute('two', { pattern: 'marker', path: '.' });
    expect(JSON.stringify(found)).toContain('marker.txt');
    await expect(search.execute('three', { pattern: 'marker', path: '../' })).rejects.toThrow('file_path_rejected');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
