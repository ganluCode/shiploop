import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import type { CommandProcessPort, CommandProcessRequest } from '../../../packages/core/src/ports/command-process.ts';
import type { IntegrationWorkspacePrepareInput } from '../../../packages/core/src/ports/integration-workspace.ts';

// No Git/process/filesystem side effects: verify the adapter's ownership protocol.
const fs = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path,
  lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  readFile: async (path: string) => {
    if (path.endsWith('/index')) return Buffer.from('index');
    if (fs.files.has(path)) return fs.files.get(path)!;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  },
  writeFile: async (path: string, content: string) => { fs.files.set(path, content); },
}));
const sha = (letter: string) => letter.repeat(40);
function fixture() {
  const repo = '/repo', common = '/repo/.git', path = '/integration', privateDir = `${common}/worktrees/integration`;
  const plan = { integrationId: 'a'.repeat(64), target: { baseCommit: sha('b'), canonicalPath: repo,
    gitCommonDir: common, repoIdentity: deriveRepoIdentity(common) }, mergeOrder: ['feature-a'],
    predecessors: [{ featureId: 'feature-a', delivery: { commitSha: sha('c') } }] } as any;
  const controller = new AbortController();
  let fenced = false, uncertain = false, attached = false;
  let onConfirm: ((request: CommandProcessRequest) => void) | undefined;
  const release = vi.fn(async () => {});
  const assertCurrent = vi.fn(() => {});
  const acquire = vi.fn(async () => ({ release, assertCurrent }));
  const mutations: string[] = [];
  const processes: CommandProcessPort = { async start(request, confirm) {
    onConfirm?.(request);
    await confirm({ launchId: 'launch-1', pid: 100, processGroupId: 100, startTime: 'start-1' });
    const args = request.argv;
    const mutation = args.includes('worktree') || args.includes('merge') || args.includes('commit') && !args.includes('cat-file');
    if (mutation) mutations.push(args.includes('worktree') ? 'worktree' : args.includes('merge') ? 'merge' : 'commit');
    let output = '';
    if (args.includes('--git-common-dir')) output = common;
    else if (args.includes('--git-dir')) output = privateDir;
    else if (args.includes('--git-path')) output = `${common}/index`;
    else if (args.includes('HEAD^{commit}')) output = sha('b');
    else if (args.includes('HEAD^{tree}')) output = sha('e');
    else if (args.includes('cat-file') && args.includes('commit')) output = `tree ${sha('e')}\n\nbase\n`;
    const stop = { confirmed: !(mutation && uncertain) };
    return {
      identity: { launchId: 'launch-1', pid: 100, processGroupId: 100, startTime: 'start-1' },
      output: (async function* () { if (output) yield { stream: 'stdout' as const, bytes: Buffer.from(output) }; })(),
      result: Promise.resolve({ exitCode: args.includes('symbolic-ref') && !attached ? 1 : 0, signal: null, reason: null, outputBytes: output.length, droppedOutputBytes: 0, stop }),
      stopped: Promise.resolve(stop), query: () => ({ identity: {} as any, state: 'stopped', bufferedOutputBytes: 0 }),
      cancel: async () => ({ accepted: true }),
    };
  } };
  const input: IntegrationWorkspacePrepareInput = { plan, integrationPath: path,
    owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true },
    signal: controller.signal, beforeWrite: () => { if (fenced) throw new Error('owner_fenced'); } };
  const adapter = createIntegrationGitWorkspace({ commandProcess: processes, metadataLock: { acquire } as any,
    confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
  return { input, adapter, controller, release, assertCurrent, acquire, mutations,
    uncertain: () => { uncertain = true; }, fence: () => { fenced = true; }, attachBranch: () => { attached = true; },
    onConfirm: (callback: (request: CommandProcessRequest) => void) => { onConfirm = callback; } };
}

beforeEach(() => fs.files.clear());
describe('integration short lock and launch fencing', () => {
  it('[case:integration-unknown-stop-retains-short-lock] retains the common-dir lock when the Git writer stop is unconfirmed', async () => {
    const f = fixture();
    f.uncertain();
    expect(await f.adapter.prepare(f.input)).toMatchObject({ status: 'unknown', reason: 'stop_unconfirmed' });
    expect(f.mutations).toEqual(['worktree']);
    expect(f.release).not.toHaveBeenCalled();
  });

  it('[case:integration-launch-confirmation-refences-owner] rejects an owner change during durable process confirmation before releasing Git', async () => {
    const f = fixture();
    f.onConfirm(request => { if (request.argv.includes('worktree')) f.fence(); });
    expect((await f.adapter.prepare(f.input)).status).toBe('blocked');
    expect(f.mutations).toEqual([]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('[case:integration-cancel-during-confirmation] cancels before releasing a suspended Git mutation', async () => {
    const f = fixture();
    f.onConfirm(request => { if (request.argv.includes('worktree')) f.controller.abort(); });
    expect((await f.adapter.prepare(f.input)).status).not.toBe('ready');
    expect(f.mutations).toEqual([]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('[case:integration-live-wrong-branch-isolated] refuses an attached foreign branch even when HEAD has not moved', async () => {
    const f = fixture();
    const prepared = await f.adapter.prepare(f.input);
    f.attachBranch();
    expect(await f.adapter.merge(prepared.workspace!)).toMatchObject({ status: 'blocked', reason: 'workspace_branch_changed' });
    expect(f.mutations).toEqual(['worktree']);
  });

  it('[case:integration-cleanup-refences-owner] retains the integration worktree after the owner changes', async () => {
    const f = fixture();
    const prepared = await f.adapter.prepare(f.input);
    const merged = await f.adapter.merge(prepared.workspace!);
    expect(merged.status).toBe('succeeded');
    f.fence();
    expect((await f.adapter.cleanup(merged.workspace!)).status).toBe('blocked');
    expect(f.mutations).toEqual(['worktree']);
  });

  it('[case:integration-short-lock-identity-rechecked] checks the exact short-lock lease before Git is released', async () => {
    const f = fixture();
    expect((await f.adapter.prepare(f.input)).status).toBe('ready');
    expect(f.assertCurrent).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
