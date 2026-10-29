import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHost, connectToHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';

it('[case:profile-detect-public-flow] initializes a candidate through default Host/CLI, preserves dirty files and requires explicit confirmation', async () => {
  const box = createBaselineFixture({ prefix: 'shiploop-profile-detect-' });
  const root = box.dataRoot();
  const repo = join(box.root, 'profile-repo'); mkdirSync(repo);
  const marker = join(repo, 'must-not-run');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'todo', scripts: { postinstall: `touch ${marker}` } }));
  writeFileSync(join(repo, 'todo.ts'), 'export const todo = 1;\n');
  execFileSync('git', ['init', '-q', repo]);
  const before = readFileSync(join(repo, 'todo.ts'));
  const options = { dataRoot: root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), env: {} };
  let host = await startHost(options);
  let client = await connectToHost({ canonicalRoot: root });
  try {
    let registration = '';
    const init = await runAppCli({ args: ['project', 'init', repo, '--name', 'Todo', '--confirm', '--data-root', root, '--json'],
      env: {}, platform: 'darwin', io: { stdout: text => { registration += text; }, stderr: () => {} } });
    expect(init.exitCode, registration).toBe(0);
    const projectId = JSON.parse(registration).result.registration.projectId as string;
    expect((await client.getProjectProfile(projectId)).candidate).toBeNull();
    const commandId = randomUUID();
    let output = ''; let errors = '';
    const result = await runAppCli({ args: ['project', 'profile', 'detect', '--project', projectId, '--command-id', commandId,
      '--confirm', '--data-root', root, '--json'], env: {}, platform: 'darwin',
      io: { stdout: text => { output += text; }, stderr: text => { errors += text; } } });
    expect(result.exitCode, errors + output).toBe(0);
    expect(JSON.parse(output).result.status).toBe('completed');
    const query = await client.getProjectProfile(projectId);
    expect(query.candidate).toMatchObject({ version: 1, status: 'candidate', confirmed: false });
    expect(query.confirmed).toBeNull();
    expect(query.modules.map(m => m.id).sort()).toEqual(['language-node', 'language-typescript']);
    expect((await client.matchProjectProfile(projectId, { directory: '.' })).match.status).toBe('not_ready');
    // Replaying one command is side-effect free. A fresh detection cannot replace a candidate.
    const original = await client.getReceipt(commandId);
    await expect(client.detectProjectProfile({ projectId, commandId }, { issuedAt: original.issuedAt })).resolves.toMatchObject({ replayed: true });
    await expect(client.detectProjectProfile({ projectId })).rejects.toMatchObject({ code: 'conflict' });
    // Public query contains enough candidate data to prepare the existing confirmation command.
    const candidate = query.candidate!;
    const profile = { schemaVersion: 1, projectId, version: candidate.version, revision: candidate.revision,
      status: candidate.status, modules: candidate.modules, documentRefs: [],
      detectionEvidenceRefs: candidate.evidence.map(e => e.id), confirmedBy: null };
    expect((await client.confirmProjectProfile({ projectId, expectedRevision: 1, profile })).status).toBe('completed');
    expect((await client.getProjectProfile(projectId)).confirmed).toMatchObject({ version: 2 });
    await expect(client.detectProjectProfile({ projectId })).rejects.toMatchObject({ code: 'conflict' });
    client.close(); await host.close(); host = await startHost(options); client = await connectToHost({ canonicalRoot: root });
    expect((await client.getProjectProfile(projectId)).confirmed).toMatchObject({ version: 2 });
    expect(readFileSync(join(repo, 'todo.ts'))).toEqual(before);
    expect(existsSync(marker)).toBe(false); expect(existsSync(join(repo, 'node_modules'))).toBe(false);
  } finally { client.close(); await host.close(); await box.dispose(); }
});
