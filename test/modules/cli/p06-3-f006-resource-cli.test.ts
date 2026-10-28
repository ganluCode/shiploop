import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';
import { resourceFixture } from '../../helpers/p06-3-resource-fixture.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { startHost, connectToHost } from '../../../packages/host/src/index.ts';
import { validateCommandReceiptWire } from '../../../packages/host/src/client/app-wire.ts';

const project = randomUUID();
const id = randomUUID();
const digest = 'a'.repeat(64);

describe('P06-3 F-006 project resource CLI', () => {
  it('[case:resource-import-args] requires explicit identity and confirmation and accepts initial revision zero', () => {
    const args = ['project', 'resource-import', '--project', project, '--source', id, '--source-digest', digest,
      '--candidate', id, '--candidate-digest', digest, '--revision', '0', '--command-id', id, '--confirm', '--json'];
    expect(parseAppCliArgs(args, {})).toMatchObject({ commandId: 'project.resource-import', revision: 0, explicitCommandId: id });
    expect(() => parseAppCliArgs(args.filter(x => x !== '--confirm'), {})).toThrow();
    expect(() => parseAppCliArgs([...args, '--path', '/secret'], {})).toThrow();
  });

  it('[case:resource-list-real-host] queries an empty configuration through the real loopback Host', async () => {
    await withKnowledgeHost(async fixture => {
      let stdout = '';
      let stderr = '';
      const result = await runAppCli({ args: ['project', 'resource-list', '--project', fixture.projectId, '--data-root', fixture.root, '--json'],
        env: {}, platform: 'darwin', io: { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } } });
      expect(result.exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: 'project.resource-list', result: { schemaVersion: 1, projectId: fixture.projectId, revision: 0, resources: [] } });
      expect(stdout.trim().split('\n')).toHaveLength(1);
    });
  });

  it('[case:resource-cli-lifecycle] uses the real Host and Core for discovery, CAS, replay and revoke', async () => {
    const box = createBaselineFixture({ prefix: 'shiploop-p063-cli-' });
    let sourceLookup: (project: string, source: string) => ReturnType<ReturnType<typeof resourceFixture>['sources']['getSource']> = () => null;
    const root = box.dataRoot();
    const host = await startHost({ dataRoot: root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), env: {},
      projectResourceSources: { getSource: (p, s) => sourceLookup(p, s) } });
    const session = openSqliteStorageSession({ path: host.core.pathService.databaseFilePath() });
    try {
      const project = await host.core.stateStore.createProject({ displayName: 'Resource CLI' });
      const fixture = resourceFixture(session, project.id, root);
      sourceLookup = fixture.sources.getSource;
      const request = await fixture.request();
      async function cli(args: string[], projectId = project.id) {
        let stdout = ''; let stderr = '';
        const result = await runAppCli({ args: ['project', ...args, '--project', projectId, '--data-root', root, '--json'],
          env: {}, platform: 'darwin', io: { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } } });
        return { result, stderr, stdout, body: JSON.parse(stdout) };
      }
      const discovery = await cli(['resource-discover', '--source', request.sourceId]);
      expect(discovery.result.exitCode, discovery.stderr).toBe(0);
      expect(discovery.body.result).toMatchObject({ schemaVersion: 1, configurationChanged: false, candidates: [{ id: request.candidateId, digest: request.candidateDigest }] });
      expect(discovery.stdout).not.toContain('Use public commands');
      expect(discovery.stdout).not.toContain('credential:local-login');
      const other = await host.core.stateStore.createProject({ displayName: 'Other project' });
      const crossProject = await cli(['resource-discover', '--source', request.sourceId], other.id);
      expect(crossProject.result.exitCode).toBe(1);
      expect((await cli(['resource-list'], other.id)).body.result).toMatchObject({ revision: 0, resources: [] });
      const preview = await cli(['resource-preview', '--source', request.sourceId]);
      expect(preview.result.exitCode, preview.stderr).toBe(0);
      const commandId = randomUUID();
      const args = ['resource-import', '--source', request.sourceId, '--source-digest', request.sourceDigest, '--candidate', request.candidateId,
        '--candidate-digest', request.candidateDigest, '--revision', '0', '--command-id', commandId, '--confirm'];
      const imported = await cli(args);
      expect(imported.result.exitCode, imported.stderr).toBe(0);
      expect(imported.body.result).toMatchObject({ commandId, status: 'completed', result: { configuration: { revision: 1 }, appliesTo: 'new_attempts_only' } });
      expect(imported.stdout).not.toContain('credential:local-login');
      const rawClient = await connectToHost({ canonicalRoot: root });
      try {
        const rawReceipt = await rawClient.getReceipt(commandId);
        const malformed = structuredClone(rawReceipt) as any;
        malformed.result.configuration.resources[0].path = '/private/secret';
        expect(() => validateCommandReceiptWire(malformed)).toThrow(expect.objectContaining({ code: 'response_malformed' }));
      } finally { rawClient.close(); }
      const replay = await cli(args);
      expect(replay.result.exitCode, replay.stderr).toBe(0);
      expect(replay.body.result).toMatchObject({ commandId, replayed: true });
      const duplicate = await cli([...args.slice(0, -5), '--revision', '1', '--command-id', randomUUID(), '--confirm']);
      expect(duplicate.result.exitCode, duplicate.stderr).toBe(0);
      expect(duplicate.body.result.result.configuration.revision).toBe(1);
      const disabled = await cli(['resource-disable', '--resource', request.candidateId, '--revision', '1', '--command-id', randomUUID(), '--confirm']);
      expect(disabled.result.exitCode, disabled.stderr).toBe(0);
      const enabled = await cli(['resource-enable', '--resource', request.candidateId, '--revision', '2', '--command-id', randomUUID(), '--confirm']);
      expect(enabled.result.exitCode, enabled.stderr).toBe(0);
      const stale = await cli(['resource-revoke', '--resource', request.candidateId, '--revision', '0', '--command-id', randomUUID(), '--confirm']);
      expect(stale.result.exitCode).toBe(1);
      const revoked = await cli(['resource-revoke', '--resource', request.candidateId, '--revision', '3', '--command-id', randomUUID(), '--confirm']);
      expect(revoked.result.exitCode, revoked.stderr).toBe(0);
      expect(revoked.body.result.result.configuration).toMatchObject({ revision: 4, resources: [{ status: 'revoked', enabled: false }] });
      const again = await cli(['resource-revoke', '--resource', request.candidateId, '--revision', '4', '--command-id', randomUUID(), '--confirm']);
      expect(again.result.exitCode).toBe(1);
      expect((await cli(['resource-list'])).body.result.revision).toBe(4);
    } finally {
      session.close();
      await host.close();
      await box.dispose();
    }
  });

  it('[case:resource-query-args] distinguishes discovery and preview and refuses host overrides', () => {
    expect(parseAppCliArgs(['project', 'resource-discover', '--project', project, '--source', id], {})).toMatchObject({ commandId: 'project.resource-discover', sourceIds: [id] });
    expect(parseAppCliArgs(['project', 'resource-preview', '--project', project, '--source', id, '--selected', id], {})).toMatchObject({ commandId: 'project.resource-preview', selectedResourceIds: [id] });
    expect(() => parseAppCliArgs(['project', 'resource-list', '--project', project, '--host', 'localhost'], {})).toThrow();
  });
});
