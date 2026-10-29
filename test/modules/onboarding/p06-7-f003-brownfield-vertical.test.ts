import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo, type AppCliRunResult } from '../../../packages/cli/src/app-execute.ts';
import { startHost, connectToHost, type HostClient, type RunningHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createTodoBrownfieldFixture, type TodoBrownfieldFixture } from '../../helpers/p06-7/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CATALOG = createStaticRuntimeCapabilityCatalog([{
  runtimeId: 'pi',
  providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
}]);
const CONFIG = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
};

interface Invocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

function collectIo(): { readonly io: AppCliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function envelope(invocation: Invocation): Record<string, any> {
  expect(invocation.stdout.trim().split('\n'), invocation.stderr).toHaveLength(1);
  return JSON.parse(invocation.stdout) as Record<string, any>;
}

function writeJson(fixture: TodoBrownfieldFixture, name: string, value: unknown): string {
  const path = join(fixture.root, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return path;
}

function planFor(checkKey: string, argv: readonly string[], timeoutMs = 10_000) {
  return {
    checks: [{ checkKey, kind: 'command' as const, argv: [...argv], timeoutMs, required: true }],
  };
}

describe('P06-7 F-003 brownfield onboarding and baseline vertical flow', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
  });

  it('[case:p06-f003-todo-public-onboarding] registers, detects and explicitly confirms a dirty Todo project through CLI/Host/Core', async () => {
    const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f003-flow-', stepMs: 100 });
    let host: RunningHost | undefined;
    let client: HostClient | undefined;
    const dataRoot = fixture.dataRoot;
    const cli = async (args: readonly string[]): Promise<Invocation> => {
      const io = collectIo();
      const result = await runAppCli({
        args: [...args, '--data-root', dataRoot, '--json'],
        io: io.io,
        env: {},
        userHomeDir: fixture.homeDir,
        platform: 'darwin',
      });
      return { result, stdout: io.stdout(), stderr: io.stderr() };
    };
    const start = async (): Promise<void> => {
      host = await startHost({ dataRoot, capabilityCatalog: CATALOG, env: fixture.childEnv() });
      client = await connectToHost({ canonicalRoot: host.canonicalRoot });
    };

    try {
      await start();
      const before = fixture.dirtyBaseline();
      const inspection = await client!.inspectRepository(fixture.todoRepositoryPath);
      expect(inspection).toMatchObject({
        schemaVersion: 3,
        hasInitialCommit: true,
        hasUncommittedChanges: true,
        headCommit: before.head,
        alreadyRegistered: null,
      });

      const init = await cli(['project', 'init', fixture.todoRepositoryPath, '--name', 'Todo brownfield', '--confirm']);
      expect(init.result.exitCode, init.stderr).toBe(0);
      const projectId = envelope(init).result.registration.projectId as string;
      expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(envelope(init).result.health).toMatchObject({ status: 'not_run', reasonCode: 'no_baseline' });

      const duplicate = await cli(['project', 'init', fixture.todoRepositoryPath, '--name', 'must not replace', '--confirm']);
      expect(duplicate.result.exitCode, duplicate.stderr).toBe(0);
      expect(envelope(duplicate).result.registration).toEqual({ status: 'already_registered', projectId });

      const beforeDetect = await client!.getProjectProfile(projectId);
      expect(beforeDetect).toMatchObject({ candidate: null, confirmed: null, modules: [] });
      expect((await client!.matchProjectProfile(projectId, { directory: 'src' })).match).toMatchObject({
        status: 'not_ready', reason: 'profile_not_confirmed', profileVersion: null,
      });

      const detectCommandId = randomUUID();
      const detect = await cli(['project', 'profile', 'detect', '--project', projectId, '--confirm', '--command-id', detectCommandId]);
      expect(detect.result.exitCode, detect.stderr).toBe(0);
      expect(envelope(detect).result).toMatchObject({ status: 'completed', operation: 'project.profile.detect' });
      const detected = await client!.getProjectProfile(projectId);
      expect(detected.candidate).toMatchObject({ version: 1, status: 'candidate', confirmed: false, projectId });
      expect(detected.confirmed).toBeNull();
      expect(detected.modules.map(module => module.id).sort()).toEqual(['language-node', 'language-typescript']);
      expect(detected.candidate!.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ confirmed: false, source: expect.any(String) }),
      ]));
      expect((await client!.matchProjectProfile(projectId, { directory: 'src' })).match.status).toBe('not_ready');

      const detectReplay = await cli(['project', 'profile', 'detect', '--project', projectId, '--confirm', '--command-id', detectCommandId]);
      expect(detectReplay.result.exitCode, detectReplay.stderr).toBe(0);
      expect(envelope(detectReplay).result.replayed).toBe(true);
      expect((await client!.getProjectProfile(projectId)).candidate?.version).toBe(1);
      await expect(client!.detectProjectProfile({ projectId })).rejects.toMatchObject({ code: 'conflict' });

      const candidate = detected.candidate!;
      const profileInput = writeJson(fixture, 'confirmed-profile.json', {
        schemaVersion: 1,
        projectId,
        version: candidate.version,
        revision: candidate.revision,
        status: candidate.status,
        modules: candidate.modules,
        documentRefs: [],
        detectionEvidenceRefs: candidate.evidence.map(evidence => evidence.id),
        confirmedBy: null,
      });
      const confirm = await cli(['project', 'profile', 'confirm', '--project', projectId, '--revision', '1', '--input', profileInput, '--confirm']);
      expect(confirm.result.exitCode, confirm.stderr).toBe(0);
      expect(envelope(confirm).result).toMatchObject({ status: 'completed', operation: 'project.profile.confirm' });
      const confirmed = await client!.getProjectProfile(projectId);
      expect(confirmed.confirmed).toMatchObject({ version: 2, status: 'confirmed', confirmed: true, projectId });
      expect(confirmed.candidate).toBeNull();
      expect((await client!.matchProjectProfile(projectId, { directory: 'src', requiredModuleIds: ['language-typescript'] })).match)
        .toMatchObject({ status: 'ready', profileVersion: 2 });

      const staleConfirm = await cli(['project', 'profile', 'confirm', '--project', projectId, '--revision', '1', '--input', profileInput, '--confirm']);
      expect(staleConfirm.result.exitCode).toBe(1);
      expect(envelope(staleConfirm).error).toMatchObject({ code: 'conflict' });
      expect((await client!.getProjectProfile(projectId)).confirmed).toMatchObject({ version: 2 });

      const configInput = writeJson(fixture, 'project-config.json', CONFIG);
      const configCommandId = randomUUID();
      const config = await cli(['config', 'create', '--scope', 'project', '--project', projectId, '--input', configInput, '--command-id', configCommandId]);
      expect(config.result.exitCode, config.stderr).toBe(0);
      expect(envelope(config).result).toMatchObject({ status: 'completed', operation: 'settings.project.create' });
      const settings = await client!.getProjectSettings(projectId);
      expect(settings).toMatchObject({ scope: { kind: 'project', projectId }, revision: 1, schemaVersion: 2 });
      expect((await client!.getEffectiveSettings(projectId)).strategies.defaultStrategy).toMatchObject({
        strategy: CONFIG.strategies.defaultStrategy,
        source: { kind: 'project_default', scopeRevision: 1, sourceKey: 'defaultStrategy' },
      });
      expect((await client!.getProjectOverview(projectId)).settings).toMatchObject({ configured: true, revision: 1 });
      const configReplay = await cli(['config', 'create', '--scope', 'project', '--project', projectId, '--input', configInput, '--command-id', configCommandId]);
      expect(configReplay.result.exitCode, configReplay.stderr).toBe(0);
      expect(envelope(configReplay).result.replayed).toBe(true);
      expect((await client!.getProjectSettings(projectId)).revision).toBe(1);

      const failingPlan = writeJson(fixture, 'baseline-failing.json', planFor(fixture.checks.failing.checkKey, fixture.checks.failing.argv));
      const failingCommandId = randomUUID();
      const failed = await cli(['baseline', 'run', '--project', projectId, '--input', failingPlan, '--confirm', '--wait', '--command-id', failingCommandId]);
      expect(failed.result.exitCode, failed.stderr).toBe(1);
      const failedResult = envelope(failed).result;
      expect(failedResult).toMatchObject({ state: 'failed', checks: [{ checkKey: fixture.checks.failing.checkKey, status: 'failed', exitCode: 3 }] });
      const failedAgain = await cli(['baseline', 'run', '--project', projectId, '--input', failingPlan, '--confirm', '--wait', '--command-id', failingCommandId]);
      expect(failedAgain.result.exitCode, failedAgain.stderr).toBe(1);
      expect(envelope(failedAgain).result.operationId).toBe(failedResult.operationId);
      expect(JSON.parse(readFileSync(join(fixture.checkFactsDir, 'check-fail.json'), 'utf8')).runs).toBe(1);

      const missingPlan = writeJson(fixture, 'baseline-missing.json', planFor('todo-check-missing-command', fixture.checks.missingTool.argv));
      const missing = await cli(['baseline', 'run', '--project', projectId, '--input', missingPlan, '--confirm', '--wait']);
      expect(missing.result.exitCode).toBe(1);
      expect(envelope(missing).result).toMatchObject({ state: 'failed', checks: [{ status: 'not_run' }] });
      expect(existsSync(join(fixture.checkFactsDir, 'missing-tool.json'))).toBe(false);

      const timeoutPlan = writeJson(fixture, 'baseline-timeout.json', planFor('todo-check-timeout', fixture.checks.hang.argv, 150));
      const timeout = await cli(['baseline', 'run', '--project', projectId, '--input', timeoutPlan, '--confirm', '--wait']);
      expect(timeout.result.exitCode).toBe(1);
      expect(envelope(timeout).result).toMatchObject({ state: 'timeout', checks: [{ status: expect.stringMatching(/inconclusive|not_run|error/), timedOut: true }] });

      const listed = await client!.listBaselines(projectId, { limit: 10 });
      expect(listed.records.length).toBe(3);
      expect(listed.records.map(item => item.operationId)).toEqual(expect.arrayContaining([
        failedResult.operationId,
        envelope(missing).result.operationId,
        envelope(timeout).result.operationId,
      ]));
      expect(listed.records).toHaveLength(3);
      expect((await client!.getProjectOverview(projectId)).health).toMatchObject({ status: 'unhealthy' });

      const clonePath = join(fixture.root, 'repos', 'todo-clone');
      execFileSync('git', ['clone', '--quiet', fixture.todoRepositoryPath, clonePath], { env: fixture.childEnv() });
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clonePath, encoding: 'utf8' }).trim()).toBe(before.head);
      const cloneInit = await cli(['project', 'init', clonePath, '--name', 'Todo clone', '--confirm']);
      expect(cloneInit.result.exitCode, cloneInit.stderr).toBe(0);
      const cloneProjectId = envelope(cloneInit).result.registration.projectId as string;
      expect(cloneProjectId).not.toBe(projectId);
      expect((await client!.getProjectOverview(cloneProjectId)).binding?.canonicalPath).toBe(resolve(clonePath));

      client!.close();
      await host!.close();
      client = undefined;
      host = undefined;
      await start();
      expect((await client!.getProjectProfile(projectId)).confirmed).toMatchObject({ version: 2, confirmed: true });
      expect((await client!.getProjectSettings(projectId)).revision).toBe(1);
      expect((await client!.listBaselines(projectId, { limit: 10 })).records).toHaveLength(3);
      expect((await client!.getProjectOverview(projectId)).registration).toEqual({ status: 'registered' });
      expect(fixture.compareDirtyBaseline(before)).toEqual({ matches: true, differences: [] });
      expect(readFileSync(join(fixture.todoRepositoryPath, 'docs', 'getting-started.md'), 'utf8')).toContain('ShipLoop P06 存量接入验收使用的 Todo 应用');
      expect(existsSync(fixture.maliciousSentinelPath)).toBe(false);
      expect(existsSync(join(fixture.todoRepositoryPath, 'node_modules'))).toBe(false);
    } finally {
      client?.close();
      if (host !== undefined) await host.close();
      await fixture.dispose();
    }
  }, 120_000);

  it('[case:p06-f003-no-head-and-cross-project-boundary] preserves no-HEAD not-run state and rejects a project-scoped query for an unknown subject', async () => {
    const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f003-boundary-', stepMs: 100 });
    let host: RunningHost | undefined;
    let client: HostClient | undefined;
    const cli = async (args: readonly string[]): Promise<Invocation> => {
      const io = collectIo();
      const result = await runAppCli({ args: [...args, '--data-root', fixture.dataRoot, '--json'], io: io.io, env: {}, userHomeDir: fixture.homeDir, platform: 'darwin' });
      return { result, stdout: io.stdout(), stderr: io.stderr() };
    };
    try {
      host = await startHost({ dataRoot: fixture.dataRoot, capabilityCatalog: CATALOG, env: fixture.childEnv() });
      client = await connectToHost({ canonicalRoot: host.canonicalRoot });
      const noHead = join(fixture.root, 'repos', 'no-head');
      mkdirSync(noHead, { recursive: true });
      execFileSync('git', ['init', '--quiet', noHead], { env: fixture.childEnv() });
      const inspection = await client.inspectRepository(noHead);
      expect(inspection).toMatchObject({ headCommit: null, hasInitialCommit: false, hasUncommittedChanges: false });
      const init = await cli(['project', 'init', noHead, '--name', 'No HEAD', '--confirm']);
      expect(init.result.exitCode).toBe(0);
      const projectId = envelope(init).result.registration.projectId as string;
      expect(envelope(init).result.health).toMatchObject({ status: 'not_run', reasonCode: 'no_baseline' });
      const profile = await client.getProjectProfile(projectId);
      expect(profile.candidate).toBeNull();
      const detect = await cli(['project', 'profile', 'detect', '--project', projectId, '--confirm']);
      expect(detect.result.exitCode).toBe(0);
      expect(envelope(detect).result.status).toBe('completed');
      expect((await client.getProjectProfile(projectId)).candidate).toMatchObject({ status: 'manual_configuration_required', confirmed: false });
      await expect(client.getProjectProfile('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'not_found' });
      expect(fixture.compareDirtyBaseline()).toEqual({ matches: true, differences: [] });
    } finally {
      client?.close();
      if (host !== undefined) await host.close();
      await fixture.dispose();
    }
  }, 60_000);
});
