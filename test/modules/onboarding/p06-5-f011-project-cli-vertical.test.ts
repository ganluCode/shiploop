import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../../../packages/cli/src/host/execute.ts';
import { createBaselineFixture, type BaselineFixture } from '../../helpers/p02-3/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url));
const DETACHED_HOST_ENTRY = fileURLToPath(new URL('../../helpers/host/detached-host-entry.ts', import.meta.url));

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parseJson(output: string): Record<string, any> {
  return JSON.parse(output) as Record<string, any>;
}

describe('F-011 real CLI repository move flow', () => {
  let fixture: BaselineFixture | undefined;
  const roots: string[] = [];
  let movedRepositoryPath: string | undefined;
  let originalRepositoryPath: string | undefined;

  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
  });
  beforeEach(() => { fixture = createBaselineFixture({ prefix: 'shiploop-f011-cli-' }); });
  afterEach(async () => {
    for (const root of roots) {
      const stop = collectIo();
      try {
        await runHostCli({ args: ['host', 'stop', '--data-root', root, '--json'], io: stop.io as HostCliIo, env: {} });
      } catch { /* fixture cleanup remains authoritative */ }
    }
    roots.length = 0;
    if (movedRepositoryPath !== undefined && originalRepositoryPath !== undefined && existsSync(movedRepositoryPath) && !existsSync(originalRepositoryPath)) {
      renameSync(movedRepositoryPath, originalRepositoryPath);
    }
    movedRepositoryPath = undefined;
    originalRepositoryPath = undefined;
    await fixture?.dispose();
    fixture = undefined;
  });

  it('uses explicit projectId and frozen preview through real CLI, Host, Git and SQLite', async () => {
    const root = fixture!.dataRoot('move');
    roots.push(root);
    const launch = {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: fixture!.childEnv(),
      pollIntervalMs: 50,
    };
    const run = async (args: readonly string[], cwd?: string) => {
      const io = collectIo();
      const result = await runAppCli({ args, io: io.io, launch, ...(cwd === undefined ? {} : { cwd }) });
      return { result, stdout: io.stdout(), stderr: io.stderr() };
    };

    const initial = await run([
      'project', 'init', fixture!.repos.withHead, '--name', 'F011', '--confirm', '--data-root', root, '--json',
    ]);
    expect(initial.result.exitCode, initial.stderr).toBe(0);
    const initialEnvelope = parseJson(initial.stdout);
    expect(initialEnvelope.ok).toBe(true);
    const projectId = initialEnvelope.result.registration.projectId as string;

    const moved = join(dirname(fixture!.repos.withHead), 'f011-moved-repository');
    originalRepositoryPath = fixture!.repos.withHead;
    movedRepositoryPath = moved;
    renameSync(fixture!.repos.withHead, moved);
    const previewInvocation = await run(['project', 'move-preview', moved, '--project', projectId, '--data-root', root, '--json']);
    expect(previewInvocation.result.exitCode, previewInvocation.stderr).toBe(0);
    const previewEnvelope = parseJson(previewInvocation.stdout);
    expect(previewEnvelope.command).toBe('project.repository-move-preview');
    expect(previewEnvelope.result.projectId).toBe(projectId);
    expect(previewEnvelope.result.oldBinding.canonicalPath).not.toBe(previewEnvelope.result.newRepository.canonicalPath);
    expect(previewEnvelope.result.requiresExplicitConfirmation).toBe(true);

    const beforeConfirmation = await run(['project', 'overview', '--project', projectId, '--data-root', root, '--json']);
    expect(beforeConfirmation.result.exitCode, beforeConfirmation.stderr).toBe(0);
    expect(parseJson(beforeConfirmation.stdout).result.binding.canonicalPath).toBe(previewEnvelope.result.oldBinding.canonicalPath);

    const previewFile = join(root, 'move-preview.json');
    writeFileSync(previewFile, JSON.stringify(previewEnvelope.result), 'utf8');
    const confirmed = await run([
      'project', 'move', moved, '--project', projectId, '--preview-file', previewFile, '--confirm', '--data-root', root, '--json',
    ]);
    expect(confirmed.result.exitCode, confirmed.stderr).toBe(0);
    const confirmedEnvelope = parseJson(confirmed.stdout);
    expect(confirmedEnvelope.command).toBe('project.repository-move-confirm');
    expect(confirmedEnvelope.result.status).toBe('completed');
    expect(confirmedEnvelope.result.result.project.id).toBe(projectId);
    expect(confirmedEnvelope.result.result.binding.canonicalPath).toBe(previewEnvelope.result.newRepository.canonicalPath);

    const overview = await run(['project', 'overview', '--project', projectId, '--data-root', root, '--json']);
    expect(overview.result.exitCode, overview.stderr).toBe(0);
    expect(parseJson(overview.stdout).result.binding.canonicalPath).toBe(previewEnvelope.result.newRepository.canonicalPath);
  });
});
