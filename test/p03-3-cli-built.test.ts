/** F-014: built CLI -> public commands -> persistent budget. No business-row seeding. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';
import { confirmProcessExit } from './helpers/host/managed-child.ts';
import { assertNoCredentialShapesInText, assertNoSensitiveText, redactSensitiveText } from '../scripts/acceptance/p02-report.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const hostEntry = fileURLToPath(new URL('./helpers/host/dist-host-entry-catalog.mjs', import.meta.url));

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, timeout: 540_000, stdio: 'pipe' });
  expect(existsSync(bin)).toBe(true);
}, 570_000);

interface Invocation {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}
interface Envelope {
  ok: boolean;
  command: string;
  result: Record<string, unknown>;
  error?: { code: string; details?: { reason?: string } };
}
interface BudgetResult {
  executionState: string;
  states: Record<string, boolean>;
  budget: {
    batch: {
      id: string;
      budgetRevision: number;
      runtimeStartsReserved: number;
      dimensions: Record<string, { limit: number; used: number | null; remaining: number | null }>;
      usage: { tokenUsed: number | null; costUsed: number | null };
    };
    runs: { id: string; status: string; reason: string; startedAt: string | null }[];
  };
  revisions: { records: { version: number }[] };
}

function expectPersistentBudget(actual: BudgetResult, previous: BudgetResult): void {
  const deadline = actual.budget.batch.dimensions.deadlineUtcMs!;
  const oldDeadline = previous.budget.batch.dimensions.deadlineUtcMs!;
  expect(deadline.limit).toBe(oldDeadline.limit);
  expect(deadline.used).toBeGreaterThanOrEqual(oldDeadline.used!);
  expect(deadline.remaining).toBeLessThanOrEqual(oldDeadline.remaining!);
  expect(deadline.used! + deadline.remaining!).toBe(deadline.limit);
  // Only the query-time projection changes; every persisted field must remain equal.
  expect(actual).toEqual({
    ...previous,
    budget: {
      ...previous.budget,
      batch: {
        ...previous.budget.batch,
        dimensions: { ...previous.budget.batch.dimensions, deadlineUtcMs: deadline },
      },
    },
  });
}

function invoke(env: IsolatedHostEnvironment, args: string[]): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: env.sandboxRoot, env: env.childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let bytes = 0;
    const timer = setTimeout(() => {
      failure = new Error('built CLI timeout');
      child.kill('SIGKILL');
    }, 60_000);
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        failure = new Error('built CLI output exceeded limit');
        child.kill('SIGKILL');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.on('error', error => { failure = error; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) throw new Error('Host failed to spawn');
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode, escalated: [] })
    : new Promise<{ code: number | null; signal: string | null; escalated: string[] }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal, escalated: [] }));
    });
  await confirmProcessExit({
    pid: child.pid,
    isAlive: () => child.exitCode === null && child.signalCode === null,
    kill: signal => child.kill(signal as NodeJS.Signals), exited,
  }, { ipcClose: false, stepMs: 5_000 });
}

const initialBudget = {
  batch: {
    maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2,
    deadlineUtcMs: '2099-06-01T00:00:00.000Z', maxTokenTotal: 1_000, maxCostTotal: 12.5,
  },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 },
};
const revisedBudget = {
  batch: {
    ...initialBudget.batch, maxRuns: 3, maxTotalAttempts: 6, maxRuntimeStarts: 5,
    maxNoProgressRuns: 3, deadlineUtcMs: '2099-07-01T00:00:00.000Z',
    maxTokenTotal: 2_000, maxCostTotal: 20,
  },
  run: { maxAttemptsPerRun: 3, runTimeLimitMs: 7_200_000 },
};

describe('F-014 built CLI acceptance', () => {
  it('prepare -> preview -> explicit start -> replay -> revise -> restart; negative cases never complete work', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f014-built-' });
    const root = env.dataRoot('app').canonicalRoot;
    const hosts: ChildProcess[] = [];
    const records: unknown[] = [];
    let passed = false;
    const sanitize = (text: string) => redactSensitiveText(text
      .replaceAll(env.sandboxRoot, '<sandbox>')
      .replaceAll(repoRoot, '<repo>/')
      .replaceAll(process.execPath, '<node>'), [homedir()]);
    const file = (name: string, data: unknown) => {
      const path = join(env.sandboxRoot, name);
      writeFileSync(path, JSON.stringify(data));
      records.push({ kind: 'input', path: `<sandbox>/${name}`, document: JSON.parse(sanitize(JSON.stringify(data))) });
      return path;
    };
    const cli = async (args: string[]) => {
      const argv = [...args, '--data-root', root, '--json'];
      const result = await invoke(env, argv);
      records.push(JSON.parse(sanitize(JSON.stringify({ kind: 'command', argv: ['node', 'packages/cli/dist/bin.js', ...argv], ...result }))));
      expect(result.signal).toBeNull();
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      return { ...result, envelope: JSON.parse(result.stdout) as Envelope };
    };
    const ok = async <T = Record<string, unknown>>(args: string[]): Promise<T> => {
      const result = await cli(args);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.envelope.ok).toBe(true);
      return result.envelope.result as T;
    };
    const fail = async (args: string[], exit: number, code: string, reason?: string) => {
      const result = await cli(args);
      expect(result.exitCode, result.stdout + result.stderr).toBe(exit);
      expect(result.envelope.ok).toBe(false);
      expect(result.envelope.error?.code).toBe(code);
      if (reason) expect(result.envelope.error?.details?.reason).toBe(reason);
    };
    const startHost = async () => {
      const child = spawn(process.execPath, [hostEntry, '--data-root', root], {
        cwd: env.sandboxRoot, env: env.childEnv(), stdio: 'ignore',
      });
      hosts.push(child);
      let spawnError: Error | undefined;
      child.on('error', error => { spawnError = error; });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('built Host exited before discovery');
        const discovery = join(root, 'host', 'discovery.json');
        if (existsSync(discovery)) {
          const record = JSON.parse(readFileSync(discovery, 'utf8')) as { pid: number };
          if (record.pid === child.pid) {
            records.push({ kind: 'host', entry: 'test/helpers/host/dist-host-entry-catalog.mjs', catalog: 'explicit test pi/anthropic/openai; no runtime', pid: child.pid });
            return child;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('built Host discovery timeout');
    };
    try {
      const repo = join(env.sandboxRoot, 'project');
      initGitRepo(repo);
      writeFileSync(join(repo, 'README.md'), '# F-014 temporary project\n');
      commitAll(repo, 'initial', { home: env.childEnv().HOME as string });
      const host = await startHost();
      const registered = await ok<{ result: { project: { id: string } } }>(['project', 'register', repo, '--name', 'F-014']);
      const project = registered.result.project.id;
      const projectArgs = ['--project', project];
      const config = file('config.json', {
        schemaVersion: 2,
        strategies: {
          defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        },
        policies: { executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000 }, verification: { requireChecksBeforeDone: true } },
      });
      await ok(['config', 'create', '--scope', 'global', '--input', config]);

      // Existing baseline publisher supplies a genuine ready artifact through public commands.
      const checks = file('checks.json', { checks: [{
        checkKey: 'requirements', kind: 'command',
        argv: [process.execPath, '-e', 'process.stdout.write("F-014 requirement: explicit authorization and finite persistent budgets")'],
        timeoutMs: 10_000, required: true,
      }] });
      const baseline = await ok<{ state: string; checks: { output: { artifactId: string } }[] }>(
        ['baseline', 'run', ...projectArgs, '--input', checks, '--confirm', '--wait'],
      );
      expect(baseline.state).toBe('passed');
      const artifactId = baseline.checks[0]!.output.artifactId;
      const phase = await ok<{ result: { phase: { id: string } } }>(['phase', 'create', ...projectArgs, '--title', 'F-014 phase']);
      const plan = file('plan.json', {
        schemaVersion: 1,
        feature: { title: 'F-014 feature', description: 'Built budget acceptance', sourceRefs: [], labels: [] },
        tasks: [{ id: 'f014-task', title: 'Budget task', complexity: 'low', acceptance: { criteria: ['Explicit authorization'] } }],
      });
      const imported = await ok<{ result: { feature: { id: string; planDigest: string } } }>(
        ['feature', 'import', ...projectArgs, '--phase', phase.result.phase.id, '--revision', '1', '--input', plan],
      );
      const feature = imported.result.feature.id;
      const budgetPath = file('budget.json', initialBudget);
      const previewArgs = ['execution', 'preview', feature, ...projectArgs, '--input', budgetPath];
      const blocked = await ok(previewArgs);
      expect(blocked.status).toBe('blocked');
      await ok(['feature', 'approve', feature, ...projectArgs, '--digest', imported.result.feature.planDigest, '--revision', '1']);
      const items = file('items.json', { items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId } }] });
      const prepared = await ok(['task', 'prepare', 'f014-task', ...projectArgs, '--feature', feature, '--input', items]);
      expect(prepared.bindable).toBe(true);
      expect(prepared.execution).toEqual({ started: false, runnable: false, capability: 'unknown' });
      expect(prepared.group).toHaveLength(3);
      const preview = await ok<{ status: string; previewDigest: string; execution: unknown; authorization: unknown }>(previewArgs);
      expect(preview.status).toBe('ready');
      expect(preview.execution).toEqual({ started: false, runtimeExecution: false });
      expect(preview.authorization).toMatchObject({ confirmed: false });
      const originalFeature = await ok<{ feature: { status: string } }>(['feature', 'get', feature]);
      expect(typeof originalFeature.feature.status).toBe('string');
      expect(originalFeature.feature.status).not.toBe('completed');
      const commandId = randomUUID();
      const start = ['execution', 'start', feature, ...projectArgs, '--input', budgetPath, '--preview-digest', preview.previewDigest, '--command-id', commandId];
      await fail(start, 2, 'invalid_input', 'confirmation_required');
      await fail(['receipt', 'get', commandId], 1, 'not_found');
      await fail(['execution', 'start', feature, ...projectArgs, '--input', budgetPath, '--preview-digest', '0'.repeat(64), '--confirm'], 1, 'conflict', 'preview_stale');
      const started = await ok<{ status: string; batchId: string; runId: string; completion: unknown }>([...start, '--confirm']);
      expect(started.status).toBe('accepted');
      expect(started.completion).toMatchObject({ featureVerified: false, businessCompleted: false });
      const budgetArgs = ['execution', 'budget', started.batchId, ...projectArgs];
      const before = await ok<BudgetResult>(budgetArgs);
      expect(before.executionState).toBe('not_executed');
      expect(before.states).toMatchObject({ accepted: true, notExecuted: true, businessCompleted: false });
      expect(before.budget.batch.runtimeStartsReserved).toBe(0);
      expect(before.budget.batch.dimensions.maxRuns).toMatchObject({ limit: 2, used: 1, remaining: 1 });
      expect(before.budget.batch.dimensions.maxTotalAttempts?.used).toBe(0);
      expect(before.budget.batch.usage).toEqual({ tokenUsed: null, costUsed: null });
      expect(before.budget.runs).toHaveLength(1);
      expect(before.budget.runs[0]).toMatchObject({ id: started.runId, status: 'queued', reason: 'runtime_not_found', startedAt: null });
      const replay = await ok([...start, '--confirm']);
      expect(replay).toMatchObject({ replayed: true, batchId: started.batchId, runId: started.runId });
      expectPersistentBudget(await ok<BudgetResult>(budgetArgs), before);
      const revisionPath = file('budget-revised.json', revisedBudget);
      const reviseArgs = ['execution', 'revise', started.batchId, ...projectArgs, '--revision', '1', '--reason', 'F-014 explicit increase', '--input', revisionPath];
      const revisionId = randomUUID();
      expect(await ok([...reviseArgs, '--command-id', revisionId])).toMatchObject({ budgetRevision: 2 });
      expect(await ok([...reviseArgs, '--command-id', revisionId])).toMatchObject({ replayed: true, budgetRevision: 2 });
      await fail(reviseArgs, 1, 'conflict', 'budget_revision_stale');
      const after = await ok<BudgetResult>(budgetArgs);
      expect(after.budget.batch).toMatchObject({ budgetRevision: 2, runtimeStartsReserved: 0 });
      expect(after.budget.batch.dimensions.maxRuns).toMatchObject({ limit: 3, used: 1, remaining: 2 });
      expect(after.budget.batch.dimensions.maxTotalAttempts?.used).toBe(0);
      expect(after.budget.batch.usage).toEqual(before.budget.batch.usage);
      expect(after.budget.runs).toEqual(before.budget.runs);
      expect(after.revisions.records.map(record => record.version)).toEqual([1, 2]);
      const otherRepo = join(env.sandboxRoot, 'other-project');
      initGitRepo(otherRepo);
      writeFileSync(join(otherRepo, 'README.md'), '# Other temporary project\n');
      commitAll(otherRepo, 'initial', { home: env.childEnv().HOME as string });
      const other = await ok<{ result: { project: { id: string } } }>(['project', 'register', otherRepo, '--name', 'F-014 other']);
      await fail(['execution', 'budget', started.batchId, '--project', other.result.project.id], 1, 'not_found');
      await ok(['host', 'stop']);
      await stopOwnedChild(host);
      await startHost();
      expectPersistentBudget(await ok<BudgetResult>(budgetArgs), after);
      expect(await ok([...start, '--confirm'])).toMatchObject({ replayed: true, batchId: started.batchId, runId: started.runId });
      const featureState = await ok<{ feature: { status: string } }>(['feature', 'get', feature]);
      expect(featureState.feature).toEqual(originalFeature.feature);
      await ok(['host', 'stop']);
      passed = true;
    } finally {
      try {
        for (const child of hosts) await stopOwnedChild(child);
        records.push({ kind: 'cleanup', ownedHostsExited: true });
      } catch (error) {
        passed = false;
        throw error;
      } finally {
        try {
          await env.dispose();
        } catch (error) {
          passed = false;
          throw error;
        } finally {
          // Optional explicit destination; not developer-local CLI configuration.
          const evidencePath = process.env.SHIPLOOP_F014_EVIDENCE;
          if (evidencePath) {
            const evidence = JSON.stringify({
              schemaVersion: 1, passed, runtimeExecution: false,
              stockHostConfiguration: 'not_run: production catalog empty (known P03-1 gap)', records,
            }, null, 2) + '\n';
            assertNoSensitiveText(evidence, [homedir(), env.sandboxRoot, repoRoot], 'F-014 evidence');
            assertNoCredentialShapesInText(evidence, 'F-014 evidence');
            writeFileSync(evidencePath, evidence);
          }
        }
      }
    }
  }, 180_000);
});
