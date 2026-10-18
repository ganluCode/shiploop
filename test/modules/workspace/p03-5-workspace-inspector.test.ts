import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle, CommandProcessIdentity, CommandProcessPort } from '../../../packages/core/src/ports/command-process.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { commitAll, git, initGitRepo } from '../../helpers/git-repo.ts';

const sandboxes: ReturnType<typeof createTempSandbox>[] = [];
afterEach(() => { for (const box of sandboxes.splice(0)) box.cleanup(); });
function fixture() {
  const box = createTempSandbox(); sandboxes.push(box);
  const source = join(box.path, 'source'); initGitRepo(source);
  writeFileSync(join(source, '.gitignore'), 'node_modules/\nresult.bin\n');
  writeFileSync(join(source, 'source.ts'), 'initial\n');
  writeFileSync(join(source, 'deleted.ts'), 'delete me\n');
  writeFileSync(join(source, 'tracked space\nname.bin'), Buffer.from([0, 255, 128]));
  const baseCommit = commitAll(source, 'initial');
  const root = join(box.path, 'managed'); mkdirSync(root);
  const workspace = join(root, 'feature');
  git(['worktree', 'add', '-b', 'feature/test', workspace, baseCommit], source);
  const common = realpathSync(join(source, '.git'));
  const baseline = { repositoryBindingId: 'binding', repositoryBindingRevision: 1,
    repoIdentity: deriveRepoIdentity(common), canonicalPath: realpathSync(workspace),
    gitCommonDir: common, branch: 'feature/test', baseCommit };
  const inspector = createWorkspaceInspector({ authorizedRoots: [root],
    confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
  return { box, source, root, workspace, baseline, inspector };
}
function snapshot(f: ReturnType<typeof fixture>) {
  return { head: git(['rev-parse', 'HEAD'], f.source), refs: git(['show-ref'], f.source),
    index: readFileSync(join(f.source, '.git', 'index')),
    worktreeIndex: readFileSync(join(git(['rev-parse', '--absolute-git-dir'], f.workspace).trim(), 'index')),
    sourceUntracked: readFileSync(join(f.source, 'local-only.txt')),
    sourceIgnored: readFileSync(join(f.source, 'result.bin')),
    source: readFileSync(join(f.source, 'source.ts')),
    tracked: readFileSync(join(f.workspace, 'source.ts')),
    ignored: readFileSync(join(f.workspace, 'node_modules', 'precious.bin')),
    untracked: readFileSync(join(f.workspace, 'space\nname.bin')) };
}
const confirm = async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId });
function reader(f: ReturnType<typeof fixture>, options: Partial<Parameters<typeof createWorkspaceInspector>[0]> = {}) {
  return createWorkspaceInspector({ authorizedRoots: [f.root], confirmProcessIdentity: confirm, ...options });
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('P03-5 F-004 read-only workspace evidence', () => {
  it('verifies actual registration and all content without changing source refs, index or bytes', async () => {
    const f = fixture();
    writeFileSync(join(f.source, 'source.ts'), 'source dirty, never copy\n');
    writeFileSync(join(f.source, 'local-only.txt'), 'source untracked');
    writeFileSync(join(f.source, 'result.bin'), Buffer.from([255, 0]));
    writeFileSync(join(f.workspace, 'source.ts'), 'modified\n');
    rmSync(join(f.workspace, 'deleted.ts'));
    writeFileSync(join(f.workspace, 'space\nname.bin'), Buffer.from([0, 255, 17]));
    mkdirSync(join(f.workspace, 'node_modules'));
    writeFileSync(join(f.workspace, 'node_modules', 'precious.bin'), Buffer.from([128, 0, 255]));
    const before = snapshot(f);
    const evidence = await f.inspector.inspect(f.baseline);
    expect(evidence.complete).toBe(true);
    expect(evidence.repository).toMatchObject({ repoIdentity: f.baseline.repoIdentity,
      gitCommonDir: f.baseline.gitCommonDir, canonicalPath: f.baseline.canonicalPath,
      headCommit: f.baseline.baseCommit, branch: f.baseline.branch, baseCommit: f.baseline.baseCommit });
    expect(evidence.registration).toMatchObject({ path: f.baseline.canonicalPath, branch: 'refs/heads/feature/test' });
    expect(evidence.contents.tracked).toContainEqual(expect.objectContaining({ path: 'deleted.ts', state: 'deleted', digest: null, sizeBytes: null }));
    expect(evidence.contents.tracked).toContainEqual(expect.objectContaining({ path: 'source.ts', digest: sha(Buffer.from('modified\n')) }));
    expect(evidence.contents.tracked).toContainEqual(expect.objectContaining({ path: 'tracked space\nname.bin', digest: sha(Buffer.from([0, 255, 128])) }));
    expect(evidence.contents.untracked).toContainEqual(expect.objectContaining({ path: 'space\nname.bin', sizeBytes: 3, digest: sha(Buffer.from([0, 255, 17])) }));
    expect(evidence.contents.ignored).toContainEqual(expect.objectContaining({ path: 'node_modules/precious.bin', protection: 'preserve', digest: sha(Buffer.from([128, 0, 255])) }));
    expect(evidence.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.evidenceId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.startedAt).toMatch(/Z$/); expect(evidence.endedAt).toMatch(/Z$/);
    expect(snapshot(f)).toEqual(before);
    const again = await f.inspector.inspect(f.baseline);
    expect(again.evidenceId).toBe(evidence.evidenceId);
    writeFileSync(join(f.workspace, 'node_modules', 'precious.bin'), 'changed ignored');
    const changed = await f.inspector.inspect(f.baseline);
    expect(changed.ignoredDigest).not.toBe(evidence.ignoredDigest);
    expect(changed.codeDigest).toBe(evidence.codeDigest);
    expect(changed.evidenceId).not.toBe(evidence.evidenceId);
  }, 60_000);

  it('rejects detached HEAD and unexpected branch, while accepting committed progress', async () => {
    const f = fixture();
    writeFileSync(join(f.workspace, 'source.ts'), 'progress');
    const progress = commitAll(f.workspace, 'progress');
    expect((await f.inspector.inspect(f.baseline)).repository.headCommit).toBe(progress);
    git(['checkout', '--detach', progress], f.workspace);
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'detached_head' });
    git(['checkout', '-b', 'other'], f.workspace);
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'branch_mismatch' });
  }, 60_000);

  it('accounts for staged deletions and config changes, and protects empty directories', async () => {
    const f = fixture();
    const clean = await f.inspector.inspect(f.baseline);
    git(['rm', 'deleted.ts'], f.workspace);
    mkdirSync(join(f.workspace, 'node_modules'));
    writeFileSync(join(f.workspace, '.gitignore'), 'node_modules/\nresult.bin\ncache/\n');
    const evidence = await f.inspector.inspect(f.baseline);
    expect(evidence.codeDigest).not.toBe(clean.codeDigest);
    expect(evidence.contents.tracked).toContainEqual(expect.objectContaining({ path: 'deleted.ts', state: 'deleted', indexObject: null }));
    expect(evidence.contents.directories).toContain('node_modules');
    expect(evidence.directoryProtection).toBe('preserve');
  }, 30_000);

  it('keeps rm --cached ignored bytes independently protected, without fabricating tracked content', async () => {
    const f = fixture();
    git(['rm', '--cached', 'source.ts'], f.workspace);
    writeFileSync(join(f.workspace, '.gitignore'), 'source.ts\nnode_modules/\n');
    const evidence = await f.inspector.inspect(f.baseline);
    expect(evidence.contents.tracked).toContainEqual(expect.objectContaining({ path: 'source.ts', state: 'deleted', indexObject: null, sizeBytes: null, digest: null }));
    expect(evidence.contents.ignored).toContainEqual(expect.objectContaining({ path: 'source.ts', state: 'present', protection: 'preserve', digest: sha(Buffer.from('initial\n')) }));
    expect(evidence.ignoredProtection).toBe('preserve');
    writeFileSync(join(f.workspace, 'source.ts'), 'ignored progress');
    const changed = await f.inspector.inspect(f.baseline);
    expect(changed.codeDigest).toBe(evidence.codeDigest);
    expect(changed.ignoredDigest).not.toBe(evidence.ignoredDigest);
  }, 30_000);

  it('rejects malformed/injected inputs before launching a process', async () => {
    const f = fixture(); const start = vi.fn();
    const inspector = reader(f, { processes: { start } });
    for (const patch of [{ baseCommit: '--exec=bad' }, { baseCommit: 'HEAD' }, { branch: '-bad' },
      { branch: 'HEAD' }, { branch: 'bad.lock' }, { branch: 'a@{b' }, { branch: 'a\nb' }, { environment: { GIT_DIR: 'bad' } }]) {
      await expect(inspector.inspect({ ...f.baseline, ...patch })).rejects.toMatchObject({ reason: 'invalid_input', complete: false });
    }
    expect(() => reader(f, { environment: { GIT_CONFIG_COUNT: '1' } } as never)).toThrow('invalid_input');
    expect(() => reader(f, { limits: { maxFiles: 20_001 } })).toThrow('invalid_input');
    expect(start).not.toHaveBeenCalled();
  });

  it('distinguishes missing, unauthorized, wrong repository and damaged reciprocal registration', async () => {
    const f = fixture();
    await expect(f.inspector.inspect({ ...f.baseline, canonicalPath: join(realpathSync(f.root), 'missing') })).rejects.toMatchObject({ reason: 'not_found' });
    await expect(f.inspector.inspect({ ...f.baseline, canonicalPath: realpathSync(f.source) })).rejects.toMatchObject({ reason: 'outside_authorized_root' });
    await expect(f.inspector.inspect({ ...f.baseline, repoIdentity: 'gitdir-sha256:wrong' })).rejects.toMatchObject({ reason: 'repository_mismatch' });
    const privateDir = git(['rev-parse', '--absolute-git-dir'], f.workspace).trim();
    const backlink = join(privateDir, 'gitdir');
    const saved = readFileSync(backlink);
    writeFileSync(backlink, join(f.source, '.git') + '\n');
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'registration_damaged' });
    writeFileSync(backlink, saved);
    writeFileSync(join(f.workspace, '.git'), 'not a gitdir pointer\n');
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'registration_damaged' });
  });

  it('rejects a missing confirmed commit rather than guessing a branch', async () => {
    const f = fixture();
    await expect(f.inspector.inspect({ ...f.baseline, baseCommit: 'f'.repeat(40) })).rejects.toMatchObject({ reason: 'commit_missing', complete: false });
  }, 15_000);

  it('bounds the complete file, byte and output inventories with no partial evidence', async () => {
    const f = fixture();
    for (const [limits, reason] of [[{ maxFiles: 2 }, 'file_limit'], [{ maxBytes: 2 }, 'byte_limit'],
      [{ maxOutputBytes: 2 }, 'output_limit']] as const) {
      try { await reader(f, { limits }).inspect(f.baseline); throw new Error('expected rejection'); }
      catch (error) { expect(error).toMatchObject({ reason, complete: false }); expect(error).not.toHaveProperty('codeDigest'); }
    }
  }, 30_000);

  it('rejects outward and dangling links and never reads special files', async () => {
    const f = fixture(); const path = join(f.workspace, 'link');
    symlinkSync(f.source, path);
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'symlink_rejected' });
    rmSync(path); symlinkSync(join(f.box.path, 'missing'), path);
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'symlink_rejected' });
    rmSync(path); execFileSync('/usr/bin/mkfifo', [path]);
    await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'special_file' });
  }, 30_000);

  it('rejects unauthorized leaf/ancestor aliases but supports the macOS temporary-root alias', async () => {
    const f = fixture();
    const outsider = join(f.box.path, 'outside'); mkdirSync(outsider);
    const leaf = join(realpathSync(f.root), 'alias'); symlinkSync(outsider, leaf);
    await expect(f.inspector.inspect({ ...f.baseline, canonicalPath: leaf })).rejects.toMatchObject({ reason: 'symlink_rejected' });
    const child = join(outsider, 'child'); mkdirSync(child);
    await expect(f.inspector.inspect({ ...f.baseline, canonicalPath: join(leaf, 'child') })).rejects.toMatchObject({ reason: 'symlink_rejected' });
    expect((await f.inspector.inspect(f.baseline)).complete).toBe(true);
  }, 20_000);

  it('reports file permission refusal without a usable digest', async () => {
    const f = fixture(); const path = join(f.workspace, 'source.ts'); chmodSync(path, 0);
    try { await expect(f.inspector.inspect(f.baseline)).rejects.toMatchObject({ reason: 'permission_denied', complete: false }); }
    finally { chmodSync(path, 0o644); }
  }, 15_000);

  it('detects changes between bounded observations, including ignored bytes', async () => {
    const f = fixture(); mkdirSync(join(f.workspace, 'node_modules'));
    const path = join(f.workspace, 'node_modules', 'evidence'); writeFileSync(path, 'before');
    const real = createCommandProcessAdapter(); let calls = 0;
    const processes: CommandProcessPort = { async start(request, acknowledge, signal) {
      if (++calls === 12) writeFileSync(path, 'after');
      return real.start(request, acknowledge, signal);
    } };
    await expect(reader(f, { processes }).inspect(f.baseline)).rejects.toMatchObject({ reason: 'content_changed', complete: false });
    expect(calls).toBe(22);
  }, 20_000);

  it('isolates inherited Git variables and repo fsmonitor scripts with fixed argv/environment', async () => {
    const f = fixture(); const sentinel = join(f.box.path, 'executed');
    const script = join(f.box.path, 'fsmonitor'); writeFileSync(script, `#!/bin/sh\ntouch '${sentinel}'\n`); chmodSync(script, 0o755);
    git(['config', 'core.fsmonitor', script], f.workspace);
    const old = process.env.GIT_DIR; process.env.GIT_DIR = '/definitely-invalid';
    const real = createCommandProcessAdapter(); const requests: unknown[] = [];
    const processes: CommandProcessPort = { async start(request, acknowledge, signal) {
      requests.push(request);
      expect(request.argv[0]).toBe('/usr/bin/git'); expect(request.cwd).toBe(f.baseline.canonicalPath);
      expect(request.environment).not.toHaveProperty('GIT_DIR');
      expect(request.environment.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(request.argv).toContain('core.fsmonitor=false');
      return real.start(request, acknowledge, signal);
    } };
    try { expect((await reader(f, { processes }).inspect(f.baseline)).complete).toBe(true); }
    finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
    expect(requests).toHaveLength(22); expect(existsSync(sentinel)).toBe(false);
  }, 20_000);

  it('uses real supervised timeout and confirms the group stopped before returning', async () => {
    const f = fixture(); const real = createCommandProcessAdapter(); let handle: CommandProcessHandle | undefined;
    const processes: CommandProcessPort = { async start(request, acknowledge, signal) {
      handle = await real.start({ ...request, argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] }, acknowledge, signal);
      return handle;
    } };
    await expect(reader(f, { processes, limits: { gitTimeoutMs: 100 } }).inspect(f.baseline)).rejects.toMatchObject({ reason: 'git_timeout' });
    expect((await handle!.stopped).confirmed).toBe(true);
  }, 20_000);

  it('refuses unconfirmed stop even if the command claims a successful exit', async () => {
    const f = fixture();
    const processes: CommandProcessPort = { async start() {
      const identity: CommandProcessIdentity = { launchId: 'fake', pid: 100, processGroupId: 100, startTime: 'fake' };
      return { identity, query: () => ({ identity, state: 'uncertain', bufferedOutputBytes: 0 }),
        output: { async *[Symbol.asyncIterator]() {} }, result: Promise.resolve({ exitCode: 0, signal: null,
        reason: null, outputBytes: 0, droppedOutputBytes: 0, stop: { confirmed: false } }),
        stopped: Promise.resolve({ confirmed: false }), cancel: async () => ({ accepted: true }) };
    } };
    await expect(reader(f, { processes }).inspect(f.baseline)).rejects.toMatchObject({ reason: 'stop_unconfirmed', complete: false });
  });
});
