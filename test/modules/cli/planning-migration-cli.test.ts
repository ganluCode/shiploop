import { expect, it } from 'vitest';
import { parseManagedWorkflow, runManagedWorkflow } from '../../../packages/cli/src/managed-workflow.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';

const projectId = '11111111-1111-4111-8111-111111111111';

it('parses migration preview and emits the structured HostClient result', async () => {
  expect(parseManagedWorkflow(['planning', 'migration-preview', 'feature-1', '--project', projectId]).command)
    .toBe('planning.migration-preview');
  const output: string[] = [];
  const client = {
    close() {},
    async previewPlanningMigration(input: unknown) {
      expect(input).toMatchObject({ projectId, featureId: 'feature-1' });
      return { status: 'completed', operation: 'planning.migration.preview', result: { blockers: [] } };
    },
  } as unknown as HostClient;
  const result = await runManagedWorkflow({
    args: ['planning', 'migration-preview', 'feature-1', '--project', projectId, '--json'],
    connect: async () => client,
    io: { stdout: text => output.push(text), stderr: text => output.push(text) },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(output.join(''))).toMatchObject({ ok: true, command: 'planning.migration-preview' });
});

it('routes migration confirmation with the preview binding and target role', async () => {
  let input: unknown;
  const output: string[] = [];
  const client = {
    close() {},
    async confirmPlanningMigration(value: unknown) { input = value; return { status: 'completed', operation: 'planning.migration.confirm' }; },
  } as unknown as HostClient;
  const result = await runManagedWorkflow({
    args: ['planning', 'migration-confirm', 'feature-1', '--project', projectId, '--context', 'context-1', '--candidate', 'candidate-1', '--run', 'run-1',
      '--revision', '3', '--target-role', 'coding', '--workspace-id', 'workspace-1', '--workspace-revision', '2',
      '--head-commit', 'a'.repeat(40), '--preview-digest', 'b'.repeat(64), '--json'],
    connect: async () => client,
    io: { stdout: text => output.push(text), stderr: text => output.push(text) },
  });
  expect(result.exitCode).toBe(0);
  expect(input).toMatchObject({ projectId, featureId: 'feature-1', contextId: 'context-1', targetRole: 'coding', workspaceRevision: 2 });
});
