import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import {
  computeProfileConfirmationDigest,
  createStaticRuntimeCapabilityCatalog,
  createLocalOwnerPrincipal,
  type ProjectProfile,
} from '../../../packages/core/src/index.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createProjectProfileInspector } from '../../../packages/core/src/adapters/fs/project-profile-inspector.ts';
import { createSqliteProjectProfileStore } from '../../../packages/core/src/adapters/sqlite/project-profile-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { connectToHost, startHost, type HostClient, type RunningHost } from '../../../packages/host/src/index.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const CATALOG = createStaticRuntimeCapabilityCatalog([]);
const OWNER = createLocalOwnerPrincipal();
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: process.cwd(), timeout: 60_000 });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function profileSnapshot(
  confirmed: { readonly version: number; readonly profileDigest: string; readonly confirmedBy: string },
  modules: readonly { readonly id: string; readonly version: string; readonly reason: string }[],
) {
  return {
    schemaVersion: 1 as const,
    profileVersion: confirmed.version,
    profileDigest: confirmed.profileDigest,
    confirmationDigest: computeProfileConfirmationDigest({
      projectId: 'unused',
      profileVersion: confirmed.version,
      profileDigest: confirmed.profileDigest,
      confirmedBy: confirmed.confirmedBy,
    }),
    modules,
  };
}

function buildExecutionInput(profile: ReturnType<typeof profileSnapshot>) {
  return createContextBuilder({
    budget: {
      maxPromptBytes: 100_000,
      maxRequiredSnapshotBytes: 50_000,
      maxRequiredInputRefs: 8,
      maxHistoryEntries: 4,
      maxHistoryEntryChars: 100,
      bytesPerTokenEstimate: 4,
    },
  }).build({
    projectId: 'project-1',
    featureId: 'feature-1',
    taskId: 'task-1',
    task: {
      title: 'Profile snapshot',
      description: 'Use the confirmed project profile.',
      acceptance: { criteria: ['profile remains immutable after drift'] },
      requirementsRefs: [],
      dependencies: [],
      executionConfig: { runtime: 'pi', provider: 'example', model: 'model-1' },
      configSource: 'project_default',
      configSourceKey: 'default',
    },
    checkPolicy: { digest: digest('policy') },
    permissions: { grants: ['repo.read'] },
    profile,
    requiredInputs: [],
  });
}

function cliInvocation(args: readonly string[]) {
  let stdout = '';
  let stderr = '';
  const io: AppCliIo = {
    stdout: value => { stdout += value; },
    stderr: value => { stderr += value; },
  };
  return runAppCli({ args, io, platform: 'darwin' }).then(result => ({ result, stdout, stderr }));
}

describe('P06-1 F-007 Core/Host/CLI profile integration', () => {
  it('[case:profile-real-project-flow] preserves Git, SQLite, Host, CLI and immutable snapshot facts across confirmation drift and restart', async () => {
    const sandbox = createTempSandbox('shiploop-p06-f007-');
    cleanups.push(() => sandbox.cleanup());
    const repository = join(sandbox.path, 'repository');
    const unknownRepository = join(sandbox.path, 'unknown-repository');
    const dataRoot = join(sandbox.path, 'data');
    execFileSync('mkdir', ['-p', repository, unknownRepository]);
    writeFileSync(join(repository, 'package.json'), JSON.stringify({ name: 'profile-fixture', scripts: { test: 'echo should-not-run' } }));
    writeFileSync(join(repository, 'src.ts'), 'export const value = 1;\n');
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'user.email', 'shiploop-test@example.invalid']);
    git(repository, ['config', 'user.name', 'ShipLoop Test']);
    git(repository, ['add', 'package.json', 'src.ts']);
    git(repository, ['commit', '--quiet', '-m', 'fixture']);
    writeFileSync(join(repository, 'uncommitted.ts'), 'const secretLike = "do-not-persist";\n');
    writeFileSync(join(unknownRepository, 'mystery.xyz'), 'unknown language content\n');
    git(unknownRepository, ['init', '--quiet']);
    git(unknownRepository, ['config', 'user.email', 'shiploop-test@example.invalid']);
    git(unknownRepository, ['config', 'user.name', 'ShipLoop Test']);
    git(unknownRepository, ['add', 'mystery.xyz']);
    git(unknownRepository, ['commit', '--quiet', '-m', 'unknown fixture']);
    const beforeStatus = git(repository, ['status', '--porcelain']);
    const beforeUncommitted = readFileSync(join(repository, 'uncommitted.ts'), 'utf8');

    const inspector = createProjectProfileInspector();
    const inspection = await inspector.inspect(repository);
    expect(inspection.candidateProfile.modules.map(module => module.id)).toEqual([
      'language-node',
      'language-typescript',
    ]);
    expect(inspection.evidence.every(evidence => !evidence.confirmed)).toBe(true);
    expect(JSON.stringify(inspection)).not.toContain('should-not-run');

    const unknownInspection = await inspector.inspect(unknownRepository);
    expect(unknownInspection.candidateProfile.status).toBe('manual_configuration_required');
    expect(unknownInspection.uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'unknown_language', status: 'manual_configuration_required' }),
    ]));

    const app = await openCoreApplication({ dataRoot, capabilityCatalog: CATALOG });
    const registered = await app.projectService.registerRepository({
      repositoryPath: repository,
      displayName: 'Profile fixture',
    });
    const unknownRegistered = await app.projectService.registerRepository({
      repositoryPath: unknownRepository,
      displayName: 'Unknown fixture',
    });
    const dbSession = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
    try {
      const store = createSqliteProjectProfileStore(dbSession);
      const moduleInputs = inspection.candidateProfile.modules.map(module => ({
        projectId: registered.project.id,
        module: {
          schemaVersion: 1 as const,
          id: module.id,
          version: module.version,
          scope: [`capability:${module.id}`],
          appliesTo: ['.'],
          dependencies: module.id === 'language-typescript' ? ['language-node@1.0.0'] : [],
          contentRef: `artifact:${module.id}@${module.version}`,
          status: 'candidate' as const,
        },
        digest: digest(JSON.stringify({
          schemaVersion: 1,
          id: module.id,
          version: module.version,
          scope: [`capability:${module.id}`],
          appliesTo: ['.'],
          dependencies: module.id === 'language-typescript' ? ['language-node@1.0.0'] : [],
          contentRef: `artifact:${module.id}@${module.version}`,
          status: 'candidate',
        })),
      }));
      store.createCapabilityModules(moduleInputs);
      store.createProjectProfile({
        profile: { ...inspection.candidateProfile, projectId: registered.project.id },
        evidence: inspection.evidence,
      });
      store.createProjectProfile({
        profile: { ...unknownInspection.candidateProfile, projectId: unknownRegistered.project.id },
        evidence: unknownInspection.evidence,
      });
      expect(() => store.createCapabilityModule({
        projectId: registered.project.id,
        module: {
          schemaVersion: 1,
          id: 'malicious-module',
          version: '1.0.0',
          scope: ['credential.read'],
          appliesTo: ['.'],
          dependencies: [],
          contentRef: 'artifact:module?token=should-not-persist',
          status: 'candidate',
        },
        digest: digest('malicious'),
      })).toThrow();
      expect(() => app.projectProfileService.getQuery(OWNER, '22222222-2222-4222-8222-222222222222')).toThrow();
    } finally {
      dbSession.close();
      app.close();
    }

    let host: RunningHost | undefined = await startHost({ dataRoot, capabilityCatalog: CATALOG, env: {} });
    cleanups.push(async () => {
      if (host !== undefined) await host.close().catch(() => undefined);
    });
    let client: HostClient = await connectToHost({ canonicalRoot: host.canonicalRoot });
    cleanups.push(() => client.close());

    const initial = await client.getProjectProfile(registered.project.id);
    expect(initial.projectId).toBe(registered.project.id);
    expect(initial.candidate).toMatchObject({ status: 'candidate', confirmed: false, version: 1 });
    expect(initial.confirmed).toBeNull();
    expect((await client.matchProjectProfile(registered.project.id, { directory: 'src', requiredModuleIds: ['language-typescript'] })).match)
      .toMatchObject({ status: 'not_ready', reason: 'profile_not_confirmed' });

    const unknownQuery = await client.getProjectProfile(unknownRegistered.project.id);
    expect(unknownQuery.candidate).toMatchObject({ status: 'manual_configuration_required', confirmed: false });
    expect(unknownQuery.candidate?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'manual_configuration_required', confirmed: false }),
    ]));
    const unknownCli = await cliInvocation(['project', 'profile', 'get', unknownRegistered.project.id, '--data-root', host.canonicalRoot]);
    expect(unknownCli.result.exitCode).toBe(0);
    expect(unknownCli.stdout).toContain('manual_configuration_required');
    expect(unknownCli.stdout).toContain('unconfirmed');

    const candidate = initial.candidate;
    if (candidate === null) throw new Error('candidate profile missing');
    const confirmReceipt = await client.confirmProjectProfile({
      projectId: registered.project.id,
      expectedRevision: 1,
      profile: { ...inspection.candidateProfile, projectId: registered.project.id },
    });
    expect(confirmReceipt).toMatchObject({ status: 'completed', operation: 'project.profile.confirm' });
    const confirmed = (await client.getProjectProfile(registered.project.id)).confirmed;
    if (confirmed === null) throw new Error('confirmed profile missing');
    const confirmedByV2 = confirmed.confirmedBy;
    if (typeof confirmedByV2 !== 'string') throw new Error('confirmed profile actor missing');
    expect(confirmed).toMatchObject({ version: 2, confirmed: true, projectId: registered.project.id });
    const matchV2 = await client.matchProjectProfile(registered.project.id, { directory: 'src', requiredModuleIds: ['language-typescript'] });
    expect(matchV2.match).toMatchObject({ status: 'ready', profileVersion: 2 });
    const snapshotV2 = buildExecutionInput(profileSnapshot({ ...confirmed, confirmedBy: confirmedByV2 }, matchV2.match.modules));
    const snapshotProfileV2 = snapshotV2.inputSnapshot.profile;
    if (snapshotProfileV2 === undefined) throw new Error('profile snapshot missing');
    expect(snapshotProfileV2.profileVersion).toBe(2);
    expect(JSON.stringify(snapshotV2)).not.toContain('do-not-persist');

    const modifiedProfile: ProjectProfile = {
      ...inspection.candidateProfile,
      projectId: registered.project.id,
      version: 2,
      revision: 'v2',
      status: 'confirmed',
      confirmedBy: OWNER.principalId,
    };
    const modifyReceipt = await client.modifyProjectProfile({
      projectId: registered.project.id,
      expectedRevision: 2,
      profile: modifiedProfile,
    });
    expect(modifyReceipt).toMatchObject({ status: 'completed', operation: 'project.profile.modify' });
    const afterDrift = await client.getProjectProfile(registered.project.id);
    const confirmedV3 = afterDrift.confirmed;
    if (confirmedV3 === null) throw new Error('drifted profile missing');
    const confirmedByV3 = confirmedV3.confirmedBy;
    if (typeof confirmedByV3 !== 'string') throw new Error('drifted profile actor missing');
    expect(confirmedV3).toMatchObject({ version: 3, confirmed: true });
    expect(snapshotProfileV2.profileVersion).toBe(2);
    expect(snapshotProfileV2.profileDigest).toBe(confirmed.profileDigest);
    const matchV3 = await client.matchProjectProfile(registered.project.id, { directory: 'src', requiredModuleIds: ['language-typescript'] });
    expect(matchV3.match.profileVersion).toBe(3);
    const snapshotV3 = buildExecutionInput(profileSnapshot({ ...confirmedV3, confirmedBy: confirmedByV3 }, matchV3.match.modules));
    if (snapshotV3.inputSnapshot.profile === undefined) throw new Error('new profile snapshot missing');
    expect(snapshotV3.inputSnapshot.profile.profileVersion).toBe(3);

    const badProfile = { ...modifiedProfile, version: 3, revision: 'v3', modules: [{ ...modifiedProfile.modules[0]!, id: 'missing-module' }] };
    const failedProfileError = await client.modifyProjectProfile({ projectId: registered.project.id, expectedRevision: 3, profile: badProfile }).catch(error => error);
    expect(failedProfileError).toMatchObject({ code: 'invalid_input' });
    expect(await client.getProjectProfile(registered.project.id)).toMatchObject({ confirmed: { version: 3 } });
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
    expect(readFileSync(join(repository, 'uncommitted.ts'), 'utf8')).toBe(beforeUncommitted);

    const canonicalRoot = host.canonicalRoot;
    client.close();
    await host.close();
    host = await startHost({ dataRoot: canonicalRoot, capabilityCatalog: CATALOG, env: {} });
    client = await connectToHost({ canonicalRoot: host.canonicalRoot });
    expect((await client.getProjectProfile(registered.project.id)).confirmed).toMatchObject({ version: 3, confirmed: true });
    const cliAfterRestart = await cliInvocation(['project', 'profile', 'get', registered.project.id, '--data-root', host.canonicalRoot]);
    expect(cliAfterRestart.result.exitCode).toBe(0);
    expect(cliAfterRestart.stdout).toContain('confirmed=true');
    expect(cliAfterRestart.stdout).toContain('version=3');
    expect(existsSync(join(dataRoot, 'host', 'discovery.json'))).toBe(true);
  });
});
