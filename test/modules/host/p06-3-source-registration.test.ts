import { randomUUID } from 'node:crypto';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHost, connectToHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';
import { resourceManifest } from '../../helpers/p06-3-resource-fixture.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';

it('[case:source-registration-default-host] persists owner-approved sources without assembly injection', async () => {
  const box = createBaselineFixture({ prefix: 'shiploop-source-registry-' });
  const root = box.dataRoot();
  const options = { dataRoot: root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), env: {} };
  let host = await startHost(options);
  let client = await connectToHost({ canonicalRoot: root });
  try {
    const project = await host.core.stateStore.createProject({ displayName: 'Sources' });
    const sourceId = randomUUID();
    const manifestPath = join(root, 'approved-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(resourceManifest()));
    const input = { projectId: project.id, sourceId, manifestPath, expectedRevision: 0, action: 'register' as const };
    await expect(client.discoverProjectResourceCandidates(project.id, [sourceId])).rejects.toBeDefined();
    let stdout = ''; let stderr = '';
    const cli = await runAppCli({ args: ['project', 'resource-source-register', '--project', project.id, '--source', sourceId,
      '--manifest-file', manifestPath, '--revision', '0', '--confirm', '--data-root', root, '--json'],
      env: {}, platform: 'darwin', io: { stdout: v => { stdout += v; }, stderr: v => { stderr += v; } } });
    expect(cli.exitCode, stderr).toBe(0);
    const registered = JSON.parse(stdout).result;
    expect(registered).toMatchObject({ schemaVersion: 1, projectId: project.id, sourceId, revision: 1, registered: true });
    expect(JSON.stringify(registered)).not.toContain(root);
    expect(await client.configureProjectResourceSource(input)).toEqual(registered);
    const found = await client.discoverProjectResourceCandidates(project.id, [sourceId]);
    expect(found.candidates).toHaveLength(1);
    const oldDigest = found.sources[0]!.sourceDigest!;
    const imported = await client.importProjectResource({ projectId: project.id, sourceId, sourceDigest: oldDigest,
      candidateId: found.candidates[0]!.id, candidateDigest: found.candidates[0]!.digest, expectedRevision: 0 });
    expect(imported.status).toBe('completed');
    expect((await client.listProjectResources(project.id)).revision).toBe(1);
    writeFileSync(manifestPath, JSON.stringify(resourceManifest('2.0.0')));
    await expect(client.importProjectResource({ projectId: project.id, sourceId, sourceDigest: oldDigest,
      candidateId: found.candidates[0]!.id, candidateDigest: found.candidates[0]!.digest, expectedRevision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await client.listProjectResources(project.id)).revision).toBe(1);
    const other = await host.core.stateStore.createProject({ displayName: 'Other' });
    await expect(client.discoverProjectResourceCandidates(other.id, [sourceId])).rejects.toBeDefined();
    client.close();
    await host.close();
    host = await startHost(options);
    client = await connectToHost({ canonicalRoot: root });
    expect((await client.discoverProjectResourceCandidates(project.id, [sourceId])).candidates).toHaveLength(1);
    expect(await client.configureProjectResourceSource({ projectId: project.id, sourceId, expectedRevision: 1, action: 'remove' })).toMatchObject({ revision: 2, registered: false });
    await expect(client.configureProjectResourceSource(input)).rejects.toBeDefined();
    await expect(client.discoverProjectResourceCandidates(project.id, [sourceId])).rejects.toBeDefined();
  } finally {
    client.close();
    await host.close();
    await box.dispose();
  }
});

it('[case:source-registration-rejects-untrusted] rejects non-owner, invalid files, schema injection and stale updates without changing registry', async () => {
  const box = createBaselineFixture({ prefix: 'shiploop-source-security-' });
  const root = box.dataRoot();
  const host = await startHost({ dataRoot: root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), env: {} });
  const client = await connectToHost({ canonicalRoot: root });
  try {
    const project = await host.core.stateStore.createProject({ displayName: 'Security' });
    const owner = createLocalOwnerPrincipal();
    const limited = { ...owner, principalId: 'work-test', projectScope: { kind: 'allowlist' as const, projectIds: [project.id] } };
    const sourceId = randomUUID();
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(resourceManifest()));
    const input = { projectId: project.id, sourceId, manifestPath, expectedRevision: 0, action: 'register' as const };
    await expect(host.core.projectResourceService.configureSource(limited, input)).rejects.toMatchObject({ kind: 'ownership' });
    await expect(client.configureProjectResourceSource({ ...input, principalId: 'local-owner' } as never)).rejects.toBeDefined();
    const link = join(root, 'symlink.json'); symlinkSync(manifestPath, link);
    await expect(client.configureProjectResourceSource({ ...input, manifestPath: link })).rejects.toBeDefined();
    await expect(client.configureProjectResourceSource({ ...input, manifestPath: root })).rejects.toBeDefined();
    writeFileSync(join(root, 'invalid.json'), '{}');
    await expect(client.configureProjectResourceSource({ ...input, manifestPath: join(root, 'invalid.json') })).rejects.toBeDefined();
    await client.configureProjectResourceSource(input);
    const before = readFileSync(join(root, 'project-resource-sources.json'));
    const replacement = join(root, 'replacement.json'); writeFileSync(replacement, JSON.stringify(resourceManifest('2.0.0')));
    await expect(client.configureProjectResourceSource({ ...input, manifestPath: replacement })).rejects.toBeDefined();
    expect(readFileSync(join(root, 'project-resource-sources.json'))).toEqual(before);
    await expect(client.configureProjectResourceSource({ ...input, sourceId: randomUUID(), projectId: randomUUID() })).rejects.toBeDefined();
    expect(readFileSync(join(root, 'project-resource-sources.json'))).toEqual(before);
    const replacement2 = join(root, 'replacement2.json'); writeFileSync(replacement2, JSON.stringify(resourceManifest('3.0.0')));
    const race = await Promise.allSettled([replacement, replacement2].map(path => client.configureProjectResourceSource({ ...input, expectedRevision: 1, manifestPath: path })));
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = readFileSync(join(root, 'project-resource-sources.json'));
    writeFileSync(join(root, 'project-resource-sources.json'), '{broken');
    await expect(client.discoverProjectResourceCandidates(project.id, [sourceId])).rejects.toBeDefined();
    await expect(client.configureProjectResourceSource({ ...input, expectedRevision: 2 })).rejects.toBeDefined();
    expect(readFileSync(join(root, 'project-resource-sources.json'), 'utf8')).toBe('{broken');
    writeFileSync(join(root, 'project-resource-sources.json'), current);
  } finally { client.close(); await host.close(); await box.dispose(); }
});
