import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import {
  createLocalOwnerPrincipal,
  createStaticRuntimeCapabilityCatalog,
} from '../../../packages/core/src/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/ports/commands.ts';
import { runAppCli, type AppCliIo, type AppCliRunResult } from '../../../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../../../packages/cli/src/host/execute.ts';
import { createBaselineFixture, type BaselineFixture } from '../../helpers/p02-3/index.ts';
import { git } from '../../helpers/git-repo.ts';
import { openDataRootStorageProbe } from '../../helpers/p02-4/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const registerHooks = fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url));
const detachedHostEntry = fileURLToPath(new URL('../../helpers/host/detached-host-entry.ts', import.meta.url));
const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);

interface Invocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

function collectIo(): { readonly io: AppCliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parseJson(invocation: Invocation): Record<string, any> {
  expect(invocation.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(invocation.stdout) as Record<string, any>;
}

function commandEnvelope(projectId: string, payload: unknown) {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation: 'baseline.run' as const,
    scope: { kind: 'project' as const, projectId },
    issuedAt: new Date().toISOString(),
    payload,
  };
}

function planFor(argv: readonly string[], checkKey = 'todo-check', timeoutMs = 10_000) {
  return {
    checks: [{
      checkKey,
      kind: 'command' as const,
      argv: [...argv],
      timeoutMs,
      required: true,
    }],
  };
}

function writePlan(fixtureRoot: string, name: string, plan: unknown): string {
  const plans = join(fixtureRoot, 'plans');
  mkdirSync(plans, { recursive: true });
  const path = join(plans, `${name}.json`);
  writeFileSync(path, JSON.stringify(plan), 'utf8');
  return path;
}

function gitStatus(path: string): string {
  return git(['status', '--porcelain=v1'], path);
}

function cliRunner(fixture: BaselineFixture, roots: string[]) {
  return async (args: readonly string[], cwd?: string): Promise<Invocation> => {
    const io = collectIo();
    const dataRoot = args[args.indexOf('--data-root') + 1];
    if (typeof dataRoot === 'string' && !roots.includes(dataRoot)) roots.push(dataRoot);
    const launch = {
      entryArgv: ['--import', registerHooks, detachedHostEntry],
      childEnv: fixture.childEnv(),
      pollIntervalMs: 50,
    };
    const result = await runAppCli({ args, io: io.io, launch, ...(cwd === undefined ? {} : { cwd }) });
    return { result, stdout: io.stdout(), stderr: io.stderr() };
  };
}

async function stopRoots(roots: readonly string[]): Promise<void> {
  for (const root of roots) {
    const io = collectIo();
    try {
      await runHostCli({ args: ['host', 'stop', '--data-root', root, '--json'], io: io.io as HostCliIo, env: {} });
    } catch {
      // Fixture disposal below remains authoritative for temporary files.
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

describe('P06-5 F-013 brownfield integration by responsibility', () => {
  const active: Array<{ fixture: BaselineFixture; roots: string[] }> = [];

  afterEach(async () => {
    for (const item of active.splice(0).reverse()) {
      await stopRoots(item.roots);
      await item.fixture.dispose();
    }
  });

  it('[case:identity-baseline-compare] preserves dirty Todo files, old Nezha data, failed evidence, and compares a controlled fix through CLI/Host', async () => {
    const fixture = createBaselineFixture({ prefix: 'shiploop-p06-5-f013-todo-' });
    const roots: string[] = [];
    active.push({ fixture, roots });
    const run = cliRunner(fixture, roots);
    const root = fixture.dataRoot('todo');
    const repo = fixture.repos.withHead;
    const nezhaDir = join(repo, '.nezha');
    const todoPath = join(repo, 'TODO.md');
    const checkerPath = join(fixture.root, 'todo-check.mjs');
    mkdirSync(nezhaDir, { recursive: true });
    writeFileSync(join(nezhaDir, 'legacy.json'), '{"task":"keep","failed":true}\n', 'utf8');
    writeFileSync(todoPath, '# Todo\n- pending item\n', 'utf8');
    writeFileSync(join(repo, 'README.md'), '# changed before init\n', 'utf8');
    git(['add', 'TODO.md'], repo);
    writeFileSync(checkerPath, [
      "import { readFileSync } from 'node:fs';",
      "const todo = readFileSync(process.argv[2], 'utf8');",
      "if (todo.includes('resolved')) { process.stdout.write('todo fixed\\n'); process.exit(0); }",
      "process.stderr.write('known todo failure\\n'); process.exit(7);",
      '',
    ].join('\n'), 'utf8');
    const beforeNezha = readFileSync(join(nezhaDir, 'legacy.json'), 'utf8');
    const beforeReadme = readFileSync(join(repo, 'README.md'), 'utf8');
    const plan = planFor([process.execPath, checkerPath, todoPath]);
    const planPath = writePlan(fixture.root, 'todo', plan);

    const initialized = await run([
      'project', 'init', repo, '--name', 'legacy Todo', '--confirm', '--data-root', root, '--json',
    ]);
    expect(initialized.result.exitCode, initialized.stderr).toBe(0);
    const initializedEnvelope = parseJson(initialized);
    const projectId = initializedEnvelope.result.registration.projectId as string;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initializedEnvelope.result.health).toMatchObject({ status: 'not_run', reasonCode: 'no_baseline' });

    const failedRun = await run([
      'baseline', 'run', '--project', projectId, '--input', planPath, '--confirm', '--wait', '--data-root', root, '--json',
    ]);
    expect(failedRun.result.exitCode, failedRun.stderr).toBe(1);
    const failedResult = parseJson(failedRun).result as Record<string, any>;
    expect(failedResult.state).toBe('failed');
    expect(failedResult.checks[0]).toMatchObject({ checkKey: 'todo-check', status: 'failed', exitCode: 7 });
    const failedOperationId = failedResult.operationId as string;
    const failedArtifactId = failedResult.checks[0].output.artifactId as string;

    const failedStatus = await run(['baseline', 'status', failedOperationId, '--data-root', root, '--json']);
    expect(failedStatus.result.exitCode, failedStatus.stderr).toBe(0);
    expect(parseJson(failedStatus).result.checks[0]).toMatchObject({ status: 'failed', output: { artifactId: failedArtifactId } });
    const evidence = await run(['baseline', 'evidence', failedArtifactId, '--data-root', root, '--json']);
    expect(evidence.result.exitCode, evidence.stderr).toBe(0);
    const evidenceResult = parseJson(evidence).result as Record<string, any>;
    const evidenceContent = String(evidenceResult.content);
    const evidenceHash = createHash('sha256').update(evidenceContent).digest('hex');
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.selectOne<{ project_id: string; status: string; content_hash: string }>(
        'SELECT project_id, status, content_hash FROM artifacts WHERE id = ?', [failedArtifactId],
      )).toMatchObject({ project_id: projectId, status: 'ready', content_hash: evidenceHash });
    } finally {
      probe.close();
    }

    writeFileSync(todoPath, '# Todo\n- resolved item\n', 'utf8');
    const fixedRun = await run([
      'baseline', 'run', '--project', projectId, '--input', planPath, '--confirm', '--wait', '--data-root', root, '--json',
    ]);
    expect(fixedRun.result.exitCode, fixedRun.stderr).toBe(0);
    const fixedResult = parseJson(fixedRun).result as Record<string, any>;
    expect(fixedResult.state).toBe('passed');
    const comparisonRun = await run([
      'baseline', 'compare', failedOperationId, fixedResult.operationId as string, '--data-root', root, '--json',
    ]);
    expect(comparisonRun.result.exitCode, comparisonRun.stderr).toBe(0);
    const comparison = parseJson(comparisonRun).result as Record<string, any>;
    expect(comparison.projectId).toBe(projectId);
    expect(comparison.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkKey: 'todo-check', classification: 'fixed' }),
    ]));
    expect(comparison.previous.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: failedArtifactId }),
    ]));

    expect(readFileSync(join(nezhaDir, 'legacy.json'), 'utf8')).toBe(beforeNezha);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe(beforeReadme);
    expect(readFileSync(todoPath, 'utf8')).toContain('resolved item');
    expect(gitStatus(repo)).toBe(' M README.md\nAM TODO.md\n?? .nezha/\n');
    expect(existsSync(join(repo, 'node_modules'))).toBe(false);
  }, 90_000);

  it('[case:clone-move-explicit-project] keeps same-remote clones and projectId isolated while a confirmed move creates a new binding revision', async () => {
    const fixture = createBaselineFixture({ prefix: 'shiploop-p06-5-f013-move-' });
    const roots: string[] = [];
    active.push({ fixture, roots });
    const run = cliRunner(fixture, roots);
    const root = fixture.dataRoot('move');
    const planPath = writePlan(fixture.root, 'move-pass', planFor([process.execPath, '--version'], 'node-version'));

    const initA = await run(['project', 'init', fixture.repos.cloneA, '--name', 'clone A', '--confirm', '--data-root', root, '--json']);
    const initB = await run(['project', 'init', fixture.repos.cloneB, '--name', 'clone B', '--confirm', '--data-root', root, '--json']);
    expect(initA.result.exitCode, initA.stderr).toBe(0);
    expect(initB.result.exitCode, initB.stderr).toBe(0);
    const projectA = parseJson(initA).result.registration.projectId as string;
    const projectB = parseJson(initB).result.registration.projectId as string;
    expect(projectA).not.toBe(projectB);
    expect(parseJson(initA).result.preview.repoIdentity).not.toBe(parseJson(initB).result.preview.repoIdentity);

    const duplicate = await run(['project', 'init', fixture.repos.cloneA, '--name', 'must not replace', '--confirm', '--data-root', root, '--json']);
    expect(duplicate.result.exitCode, duplicate.stderr).toBe(0);
    expect(parseJson(duplicate).result.registration).toMatchObject({ status: 'already_registered', projectId: projectA });
    const overviewA = await run(['project', 'overview', '--project', projectA, '--data-root', root, '--json']);
    expect(parseJson(overviewA).result.project.displayName).toBe('clone A');

    const firstBaseline = await run([
      'baseline', 'run', '--project', projectA, '--input', planPath, '--confirm', '--wait', '--data-root', root, '--json',
    ]);
    expect(firstBaseline.result.exitCode, firstBaseline.stderr).toBe(0);
    const firstResult = parseJson(firstBaseline).result as Record<string, any>;
    const firstStatus = await run(['baseline', 'status', firstResult.operationId as string, '--data-root', root, '--json']);
    const firstAuthorization = parseJson(firstStatus).result as Record<string, any>;

    const oldPath = fixture.repos.cloneA;
    const movedPath = join(fixture.root, 'repos', 'clone-a-moved');
    renameSync(oldPath, movedPath);
    const preview = await run(['project', 'move-preview', movedPath, '--project', projectA, '--data-root', root, '--json']);
    expect(preview.result.exitCode, preview.stderr).toBe(0);
    const previewResult = parseJson(preview).result as Record<string, any>;
    expect(previewResult.projectId).toBe(projectA);
    expect(previewResult.requiresExplicitConfirmation).toBe(true);
    const previewFile = join(root, 'move-preview.json');
    writeFileSync(previewFile, JSON.stringify(previewResult), 'utf8');
    const confirmed = await run([
      'project', 'move', movedPath, '--project', projectA, '--preview-file', previewFile, '--confirm', '--data-root', root, '--json',
    ]);
    expect(confirmed.result.exitCode, confirmed.stderr).toBe(0);
    expect((parseJson(confirmed).result.result.project.id as string)).toBe(projectA);

    const secondBaseline = await run([
      'baseline', 'run', '--project', projectA, '--input', planPath, '--confirm', '--wait', '--data-root', root, '--json',
    ]);
    expect(secondBaseline.result.exitCode, secondBaseline.stderr).toBe(0);
    const secondResult = parseJson(secondBaseline).result as Record<string, any>;
    const secondStatus = await run(['baseline', 'status', secondResult.operationId as string, '--data-root', root, '--json']);
    const secondAuthorization = parseJson(secondStatus).result as Record<string, any>;
    expect(secondAuthorization.repositoryBindingRevision).toBeGreaterThan(firstAuthorization.repositoryBindingRevision);

    const overviewB = await run(['project', 'overview', '--project', projectB, '--data-root', root, '--json']);
    expect((parseJson(overviewB).result.binding.canonicalPath as string)).toBe(fixture.repos.cloneB);
    const movedOverview = await run(['project', 'overview', '--project', projectA, '--data-root', root, '--json']);
    expect((parseJson(movedOverview).result.binding.canonicalPath as string)).toBe(movedPath);
    expect(existsSync(join(movedPath, '.git'))).toBe(true);
  }, 90_000);

  it('[case:move-baseline-barrier-and-drift] blocks confirmed move behind a running baseline and records drift/not-run facts without side effects', async () => {
    const fixture = createBaselineFixture({ prefix: 'shiploop-p06-5-f013-faults-' });
    let environmentRevision = 'approved-v1';
    const app = await openCoreApplication({
      dataRoot: fixture.dataRoot('core'),
      capabilityCatalog: catalog,
      baselineEnvironmentDirectory: {
        resolveEnvironmentRef: (ref: string) => ref === 'approved' ? { allowedVariables: ['CI'], definitionRevision: environmentRevision } : null,
      },
    });
    let activeOperationId: string | undefined;
    let projectId: string | undefined;
    let movedPath: string | undefined;
    try {
      const registration = await app.projectService.registerRepository({ repositoryPath: fixture.repos.withHead, displayName: 'fault matrix' });
      projectId = registration.project.id;
      const passPlan = planFor([process.execPath, '--version'], 'pass');
      const approvedPlan = { checks: [{ ...passPlan.checks[0], environmentRef: 'approved' }] };
      const stalePreview = await app.baselineService.previewBaseline(owner, projectId, { plan: approvedPlan });
      environmentRevision = 'approved-v2';
      const stale = await app.baselineExecutionService.submit(owner, commandEnvelope(projectId, {
        decision: 'authorize', plan: approvedPlan, previewDigest: stalePreview.previewDigest,
      }));
      expect(stale.status).toBe('rejected');
      if (stale.status !== 'rejected') throw new Error('expected stale preview rejection');
      expect(stale.error.details?.reason).toBe('preview_stale');
      expect(await app.artifactStore.listArtifacts(projectId)).toMatchObject({ records: [] });

      const unavailablePlan = planFor(['p06-f013-command-that-is-not-installed'], 'unavailable');
      const unavailablePreview = await app.baselineService.previewBaseline(owner, projectId, { plan: unavailablePlan });
      const unavailable = await app.baselineExecutionService.submit(owner, commandEnvelope(projectId, {
        decision: 'authorize', plan: unavailablePlan, previewDigest: unavailablePreview.previewDigest,
      }));
      expect(unavailable.status).toBe('accepted');
      if (unavailable.status !== 'accepted') throw new Error('expected unavailable check acceptance');
      await app.baselineExecutionService.waitForIdle();
      expect(app.baselineStore.listBaselineCheckResults(unavailable.operationId)).toMatchObject([
        { checkKey: 'unavailable', status: 'not_run', reasonCode: 'missing_command', exitCode: null },
      ]);

      const hangPlan = planFor([
        process.execPath, '-e', 'process.stdout.write("barrier\\n"); setInterval(() => {}, 1000)',
      ], 'barrier', 60_000);
      const hangPreview = await app.baselineService.previewBaseline(owner, projectId, { plan: hangPlan });
      const running = await app.baselineExecutionService.submit(owner, commandEnvelope(projectId, {
        decision: 'authorize', plan: hangPlan, previewDigest: hangPreview.previewDigest,
      }));
      expect(running.status).toBe('accepted');
      if (running.status !== 'accepted') throw new Error('expected running baseline acceptance');
      activeOperationId = running.operationId;
      await waitFor(() => app.baselineStore.getBaselineOperation(running.operationId)?.status === 'running', 10_000);

      const movedRepositoryPath = join(fixture.root, 'repos', 'barrier-moved');
      movedPath = movedRepositoryPath;
      renameSync(fixture.repos.withHead, movedRepositoryPath);
      const movePreview = await app.repositoryMoveService.preview(owner, { projectId: projectId!, repositoryPath: movedRepositoryPath });
      await expect(app.repositoryMoveService.confirm(owner, {
        preview: movePreview,
        decision: {
          schemaVersion: 1,
          projectId: projectId!,
          oldBinding: movePreview.oldBinding,
          previewDigest: movePreview.previewDigest,
          decision: 'confirm',
        },
      })).rejects.toMatchObject({ kind: 'conflict' });
      expect((await app.stateStore.getRepositoryBinding(projectId!)).canonicalPath).toBe(movePreview.oldBinding.canonicalPath);
      expect(readFileSync(join(movedRepositoryPath, 'README.md'), 'utf8')).toContain('with-head');
      expect(app.baselineStore.getBaselineOperation(running.operationId)).toMatchObject({ status: 'running' });
    } finally {
      if (activeOperationId !== undefined && projectId !== undefined) {
        try {
          await app.baselineExecutionService.cancel(owner, projectId, activeOperationId);
          await app.baselineExecutionService.waitForIdle();
        } catch {
          // The final assertion remains the persisted operation and fixture cleanup is fail-closed.
        }
      }
      if (movedPath !== undefined && existsSync(movedPath) && !existsSync(fixture.repos.withHead)) {
        renameSync(movedPath, fixture.repos.withHead);
      }
      app.close();
      await fixture.dispose();
    }
  }, 90_000);
});
