import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';

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

  it('[case:resource-query-args] distinguishes discovery and preview and refuses host overrides', () => {
    expect(parseAppCliArgs(['project', 'resource-discover', '--project', project, '--source', id], {})).toMatchObject({ commandId: 'project.resource-discover', sourceIds: [id] });
    expect(parseAppCliArgs(['project', 'resource-preview', '--project', project, '--source', id, '--selected', id], {})).toMatchObject({ commandId: 'project.resource-preview', selectedResourceIds: [id] });
    expect(() => parseAppCliArgs(['project', 'resource-list', '--project', project, '--host', 'localhost'], {})).toThrow();
  });
});
