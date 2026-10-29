import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommandProcessPort, ConfirmCommandProcessIdentity } from '../../ports/command-process.js';
import type {
  IntegrationMergeOutcome, IntegrationWorkspaceAdapter, IntegrationWorkspaceFacts,
  IntegrationWorkspaceHandle, IntegrationWorkspaceOutcome, IntegrationWorkspacePrepareInput,
  IntegrationWorkspaceReason, IntegrationWorkspaceStep,
} from '../../ports/integration-workspace.js';
import type { GitPublicMetadataLock } from '../../ports/git-public-metadata-lock.js';
import { createGitPublicMetadataLock } from './git-public-metadata-lock.js';
import { deriveObservedRepoIdentity } from './repository-inspector.js';
import { deriveRepoIdentity } from '../../ports/repository-inspector.js';
import { createCommandProcessAdapter } from '../process/command-process.js';

const SYSTEM_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', PAGER: 'cat',
});
const GIT_PREFIX = ['/usr/bin/git', '--no-pager', '--no-optional-locks',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never'];
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OWNER_FILE = 'shiploop-integration-owner.json';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type GitResult = {
  readonly output: Buffer;
  readonly exitCode: number | null;
  readonly reason: string | null;
  readonly signal: string | null;
};
type SourceSnapshot = {
  readonly head: string;
  readonly commonDir: string;
  readonly refs: string;
  readonly remoteRefs: string;
  readonly indexDigest: string;
  readonly status: string;
};
type State = {
  readonly input: IntegrationWorkspacePrepareInput;
  readonly source: SourceSnapshot;
  readonly privateGitDir: string;
  readonly workspaceId: string;
};

class IntegrationGitError extends Error {
  readonly reason: IntegrationWorkspaceReason;
  readonly stopConfirmed: boolean;
  constructor(reason: IntegrationWorkspaceReason, stopConfirmed = true) {
    super(`IntegrationGit: ${reason}`);
    this.name = 'IntegrationGitError';
    this.reason = reason;
    this.stopConfirmed = stopConfirmed;
  }
}

function text(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) throw new IntegrationGitError('git_failed');
  return value;
}
function oid(value: string): string {
  const result = value.trim();
  if (!OID.test(result)) throw new IntegrationGitError('git_failed');
  return result;
}
function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function inside(root: string, value: string): boolean {
  const suffix = relative(root, value);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}
function details(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof IntegrationGitError) return { reason: error.reason, stopConfirmed: error.stopConfirmed };
  return { reason: 'git_failed' };
}

export function createIntegrationGitWorkspace(options: {
  readonly commandProcess?: CommandProcessPort;
  readonly confirmProcessIdentity: ConfirmCommandProcessIdentity;
  readonly metadataLock?: GitPublicMetadataLock;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}): IntegrationWorkspaceAdapter {
  if (!options || typeof options.confirmProcessIdentity !== 'function') {
    throw new TypeError('createIntegrationGitWorkspace: confirmProcessIdentity is required');
  }
  const processes = options.commandProcess ?? createCommandProcessAdapter();
  const metadataLock = options.metadataLock ?? createGitPublicMetadataLock();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new TypeError('createIntegrationGitWorkspace: invalid process limits');
  }
  const states = new Map<string, State>();

  async function withLock<T>(input: IntegrationWorkspacePrepareInput, workspacePath: string, work: () => Promise<T>): Promise<T> {
    let lease;
    try {
      lease = await metadataLock.acquire({ repoIdentity: input.plan.target.repoIdentity, workspacePath,
        gitCommonDir: input.plan.target.gitCommonDir, operationId: randomUUID() });
    } catch {
      throw new IntegrationGitError('git_lock_present');
    }
    try { return await work(); } finally { await lease.release(); }
  }

  async function run(cwd: string, args: readonly string[], input: IntegrationWorkspacePrepareInput,
    allowedExitCodes: readonly number[] = [0], stdin?: Uint8Array): Promise<GitResult> {
    let handle;
    try {
      handle = await processes.start({
      argv: [...GIT_PREFIX, ...args], cwd,
      environment: { ...SYSTEM_ENV, ...(input.gitIdentity ? {
        GIT_AUTHOR_NAME: input.gitIdentity.name,
        GIT_AUTHOR_EMAIL: input.gitIdentity.email,
        GIT_COMMITTER_NAME: input.gitIdentity.name,
        GIT_COMMITTER_EMAIL: input.gitIdentity.email,
      } : {}) },
      stdin, timeoutMs, maxInputBytes: 65_536, maxOutputBytes,
      }, async identity => options.confirmProcessIdentity(identity), input.signal);
    } catch (error) {
      if (error instanceof Error && error.message.includes('stop_unconfirmed')) throw new IntegrationGitError('stop_unconfirmed', false);
      throw new IntegrationGitError('git_failed');
    }
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    try {
      for await (const event of handle.output) {
        outputBytes += event.bytes.byteLength;
        if (outputBytes > maxOutputBytes) await handle.cancel();
        else if (event.stream === 'stdout') stdout.push(Buffer.from(event.bytes));
      }
    } catch {
      await handle.cancel();
      const stopped = (await handle.stopped).confirmed;
      throw new IntegrationGitError(stopped ? 'git_failed' : 'stop_unconfirmed', stopped);
    }
    const result = await handle.result;
    const stopped = result.stop.confirmed && (await handle.stopped).confirmed;
    if (!stopped) throw new IntegrationGitError('stop_unconfirmed', false);
    if (result.droppedOutputBytes > 0 || outputBytes > maxOutputBytes) throw new IntegrationGitError('git_failed');
    if (result.reason !== null || result.signal !== null) throw new IntegrationGitError('operation_unknown');
    if (!allowedExitCodes.includes(result.exitCode ?? -1)) {
      return { output: Buffer.concat(stdout), exitCode: result.exitCode, reason: result.reason, signal: result.signal };
    }
    return { output: Buffer.concat(stdout), exitCode: result.exitCode, reason: result.reason, signal: result.signal };
  }

  async function safeRealpath(path: string): Promise<string> {
    try { return await realpath(path); } catch { throw new IntegrationGitError('path_changed'); }
  }
  async function sourceSnapshot(input: IntegrationWorkspacePrepareInput): Promise<SourceSnapshot> {
    const source = input.plan.target.canonicalPath;
    const commonDir = await safeRealpath(text((await run(source,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'], input)).output).trim());
    const head = oid(text((await run(source, ['rev-parse', '--verify', 'HEAD^{commit}'], input)).output));
    const refs = text((await run(source, ['for-each-ref', '--format=%(refname) %(objectname)'], input)).output);
    const remoteRefs = text((await run(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], input)).output);
    const indexPath = text((await run(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], input)).output).trim();
    let indexDigest: string;
    try { indexDigest = sha(await readFile(indexPath)); } catch { throw new IntegrationGitError('source_changed'); }
    const status = text((await run(source, ['status', '--porcelain=v1', '-z'], input)).output);
    return { head, commonDir, refs, remoteRefs, indexDigest, status };
  }
  async function verifyTarget(input: IntegrationWorkspacePrepareInput): Promise<SourceSnapshot> {
    const plan = input.plan;
    const sourcePath = await safeRealpath(plan.target.canonicalPath);
    if (sourcePath !== plan.target.canonicalPath) throw new IntegrationGitError('path_changed');
    const snapshot = await sourceSnapshot(input);
    if (snapshot.commonDir !== plan.target.gitCommonDir
      || (deriveObservedRepoIdentity(snapshot.commonDir) !== plan.target.repoIdentity
        && deriveRepoIdentity(snapshot.commonDir) !== plan.target.repoIdentity)) {
      throw new IntegrationGitError('repo_identity_changed');
    }
    if (snapshot.head !== plan.target.baseCommit) throw new IntegrationGitError('target_head_drift');
    if (snapshot.status !== '') throw new IntegrationGitError('source_dirty');
    const base = await run(sourcePath, ['cat-file', '-e', `${plan.target.baseCommit}^{commit}`], input, [0, 1]);
    if (base.exitCode !== 0) throw new IntegrationGitError('input_missing');
    return snapshot;
  }
  async function privateGitDir(path: string, input: IntegrationWorkspacePrepareInput): Promise<string> {
    const value = text((await run(path, ['rev-parse', '--path-format=absolute', '--git-dir'], input)).output).trim();
    return await safeRealpath(value);
  }
  async function lockPresent(privateDir: string, commonDir: string, input: IntegrationWorkspacePrepareInput): Promise<boolean> {
    const paths = [join(privateDir, 'index.lock'), join(privateDir, 'HEAD.lock'), join(commonDir, 'packed-refs.lock'), join(commonDir, 'index.lock')];
    for (const path of paths) {
      try { await access(path, constants.F_OK); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationGitError('git_lock_present');
      }
    }
    // Asking Git for the path also verifies that a replaced .git marker is noticed before mutation.
    const actualPrivate = await privateGitDir(input.plan.target.canonicalPath, input);
    if (actualPrivate !== commonDir && !inside(join(commonDir, 'worktrees'), actualPrivate)) {
      throw new IntegrationGitError('repo_identity_changed');
    }
    return false;
  }
  async function facts(path: string, input: IntegrationWorkspacePrepareInput): Promise<IntegrationWorkspaceFacts> {
    const head = oid(text((await run(path, ['rev-parse', '--verify', 'HEAD^{commit}'], input)).output));
    const tree = oid(text((await run(path, ['rev-parse', '--verify', 'HEAD^{tree}'], input)).output));
    const raw = text((await run(path, ['cat-file', 'commit', head], input)).output);
    const split = raw.indexOf('\n\n');
    if (split < 0) throw new IntegrationGitError('git_failed');
    const parents = raw.slice(0, split).split('\n').filter(line => line.startsWith('parent ')).map(line => oid(line.slice(7)));
    const statusPorcelain = text((await run(path, ['status', '--porcelain=v1', '-z'], input)).output);
    const unresolvedRaw = text((await run(path, ['ls-files', '-u', '-z'], input)).output);
    const unresolvedPaths = unresolvedRaw ? [...new Set(unresolvedRaw.slice(0, -1).split('\0').map(record => record.slice(record.indexOf('\t') + 1)))] : [];
    return { head, tree, parents, statusPorcelain, unresolvedPaths };
  }
  function makeHandle(state: State, status: IntegrationWorkspaceHandle['status'], currentHead: string,
    steps: readonly IntegrationWorkspaceStep[], workspaceFacts: IntegrationWorkspaceFacts): IntegrationWorkspaceHandle {
    return Object.freeze({ workspaceId: state.workspaceId, ownerId: state.input.owner.ownerId,
      ownerVersion: state.input.owner.ownerVersion, path: state.input.integrationPath,
      gitCommonDir: state.input.plan.target.gitCommonDir, repoIdentity: state.input.plan.target.repoIdentity,
      targetBase: state.input.plan.target.baseCommit, plan: state.input.plan, gitIdentity: state.input.gitIdentity,
      status, currentHead, steps: [...steps], facts: workspaceFacts });
  }
  function outcome(status: IntegrationWorkspaceOutcome['status'], reason: IntegrationWorkspaceReason | null,
    workspace: IntegrationWorkspaceHandle | null, extra: Readonly<Record<string, unknown>> = {}): IntegrationWorkspaceOutcome {
    return { status, reason, workspace, details: { ...(reason ? { reason } : {}), ...extra } };
  }
  async function markerMatches(state: State, input: IntegrationWorkspaceHandle): Promise<boolean> {
    if (input.workspaceId !== state.workspaceId || input.ownerId !== state.input.owner.ownerId
      || input.ownerVersion !== state.input.owner.ownerVersion || input.path !== state.input.integrationPath) return false;
    try {
      const raw = JSON.parse((await readFile(join(state.privateGitDir, OWNER_FILE), 'utf8')));
      return raw && raw.workspaceId === state.workspaceId && raw.ownerId === state.input.owner.ownerId
        && raw.ownerVersion === state.input.owner.ownerVersion && raw.planId === state.input.plan.integrationId;
    } catch { return false; }
  }
  async function sourceUnchanged(state: State, input: IntegrationWorkspacePrepareInput): Promise<boolean> {
    const after = await sourceSnapshot(input);
    return after.head === state.source.head && after.commonDir === state.source.commonDir
      && after.refs === state.source.refs && after.remoteRefs === state.source.remoteRefs
      && after.indexDigest === state.source.indexDigest && after.status === state.source.status;
  }

  async function prepare(input: IntegrationWorkspacePrepareInput): Promise<IntegrationWorkspaceOutcome> {
    let state: State | undefined;
    try {
      if (!input.plan || !input.plan.target || !input.integrationPath || !isAbsolute(input.integrationPath)
        || input.integrationPath.includes('\0') || input.integrationPath === input.plan.target.canonicalPath
        || inside(input.plan.target.canonicalPath, input.integrationPath)
        || !input.owner.ownerId || !Number.isSafeInteger(input.owner.ownerVersion) || input.owner.ownerVersion < 1
        || input.gitIdentity.confirmed !== true) {
        throw new IntegrationGitError('workspace_creation_failed');
      }
      const path = resolve(input.integrationPath);
      try { await lstat(path); throw new IntegrationGitError('workspace_creation_failed'); }
      catch (error) { if (error instanceof IntegrationGitError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = await safeRealpath(dirname(path));
      if (parent !== dirname(path)) throw new IntegrationGitError('path_changed');
      const source = await verifyTarget(input);
      const workspaceId = randomUUID();
      state = { input: { ...input, integrationPath: path }, source, privateGitDir: '', workspaceId };
      const added = await withLock(input, input.plan.target.canonicalPath, () => {
        input.beforeWrite?.();
        return run(input.plan.target.canonicalPath,
          ['worktree', 'add', '--detach', path, input.plan.target.baseCommit], input);
      });
      if (added.exitCode !== 0 || added.reason !== null) throw new IntegrationGitError('workspace_creation_failed');
      if (await safeRealpath(path) !== path) throw new IntegrationGitError('path_changed');
      const privateDir = await privateGitDir(path, input);
      state = { ...state, privateGitDir: privateDir };
      if (await lockPresent(privateDir, source.commonDir, input)) throw new IntegrationGitError('git_lock_present');
      const workspaceFacts = await facts(path, input);
      if (workspaceFacts.head !== input.plan.target.baseCommit || workspaceFacts.statusPorcelain !== '') {
        throw new IntegrationGitError('workspace_creation_failed');
      }
      await writeFile(join(privateDir, OWNER_FILE), JSON.stringify({ workspaceId, ownerId: input.owner.ownerId,
        ownerVersion: input.owner.ownerVersion, planId: input.plan.integrationId, targetBase: input.plan.target.baseCommit }) + '\n', { flag: 'wx', mode: 0o600 });
      if (!(await sourceUnchanged(state, input))) throw new IntegrationGitError('source_changed');
      states.set(workspaceId, state);
      const workspace = makeHandle(state, 'ready', workspaceFacts.head, [], workspaceFacts);
      return outcome('ready', null, workspace, { workspaceId, ownerId: input.owner.ownerId, path });
    } catch (error) {
      const reason = error instanceof IntegrationGitError ? error.reason : 'workspace_creation_failed';
      const status = reason === 'stop_unconfirmed' || reason === 'operation_unknown' ? 'unknown' : 'blocked';
      return outcome(status, reason, null, { path: input.integrationPath, ...details(error) });
    }
  }

  async function merge(workspace: IntegrationWorkspaceHandle): Promise<IntegrationMergeOutcome> {
    const state = states.get(workspace.workspaceId);
    const noSteps = workspace.steps ?? [];
    if (!state || !(await markerMatches(state, workspace))) {
      return { ...outcome('blocked', 'workspace_not_owned', null), steps: noSteps };
    }
    let current = workspace;
    try {
      if (current.status === 'cleaned') return { ...outcome('blocked', 'workspace_already_cleaned', current), steps: current.steps };
      for (;;) {
      if (await safeRealpath(state.input.integrationPath) !== state.input.integrationPath) throw new IntegrationGitError('path_changed');
      const actualFacts = await facts(state.input.integrationPath, state.input);
      if (actualFacts.head !== current.currentHead) throw new IntegrationGitError('workspace_head_drift');
      if (actualFacts.statusPorcelain !== '') throw new IntegrationGitError('workspace_not_clean');
      if (await lockPresent(state.privateGitDir, state.source.commonDir, state.input)) throw new IntegrationGitError('git_lock_present');
      if (!(await sourceUnchanged(state, state.input))) throw new IntegrationGitError('source_changed');
      const next = state.input.plan.mergeOrder[current.steps.length];
      if (next === undefined) return { ...outcome('succeeded', null, current.status === 'succeeded' ? current : makeHandle(state, 'succeeded', current.currentHead, current.steps, actualFacts), { complete: true }), steps: current.steps };
      const predecessor = state.input.plan.predecessors.find(item => item.featureId === next);
      const inputSha = predecessor?.delivery?.commitSha;
      if (!inputSha) throw new IntegrationGitError('input_not_approved');
      const object = await run(state.input.integrationPath, ['cat-file', '-e', `${inputSha}^{commit}`], state.input, [0, 1]);
      if (object.exitCode !== 0) throw new IntegrationGitError('input_missing');
      const parentBefore = actualFacts.head;
      const merged = await withLock(state.input, state.input.integrationPath, () => {
        state.input.beforeWrite?.();
        return run(state.input.integrationPath, ['merge', '--no-ff', '--no-commit', '--no-edit', inputSha], state.input, [0, 1]);
      });
      const afterMerge = await facts(state.input.integrationPath, state.input);
      if (merged.exitCode !== 0 || afterMerge.unresolvedPaths.length > 0) {
        const reason: IntegrationWorkspaceReason = afterMerge.unresolvedPaths.length > 0 ? 'merge_conflict' : 'merge_failed';
        current = makeHandle(state, 'blocked', afterMerge.head, current.steps, afterMerge);
        return { ...outcome('blocked', reason, current, { inputSha, parentBefore, unresolvedPaths: afterMerge.unresolvedPaths }), steps: current.steps };
      }
      const mergeHead = text((await run(state.input.integrationPath, ['rev-parse', '--verify', 'MERGE_HEAD'], state.input)).output).trim();
      if (mergeHead !== inputSha) throw new IntegrationGitError('commit_facts_mismatch');
      const message = `Merge ${inputSha} into ShipLoop integration ${state.input.plan.integrationId}\n`;
      const committed = await withLock(state.input, state.input.integrationPath, () => {
        state.input.beforeWrite?.();
        return run(state.input.integrationPath, ['commit', '--no-gpg-sign', '--cleanup=verbatim', '--file=-'], state.input, [0], Buffer.from(message));
      });
      if (committed.exitCode !== 0) throw new IntegrationGitError('merge_failed');
      const afterCommit = await facts(state.input.integrationPath, state.input);
      if (afterCommit.head === parentBefore || afterCommit.parents[0] !== parentBefore || !afterCommit.parents.includes(inputSha)
        || afterCommit.statusPorcelain !== '') throw new IntegrationGitError('commit_facts_mismatch');
      const step: IntegrationWorkspaceStep = { ordinal: current.steps.length + 1, featureId: next, inputSha,
        parentBefore, parents: afterCommit.parents, commitSha: afterCommit.head, treeSha: afterCommit.tree, status: 'succeeded' };
      const steps = [...current.steps, step];
      await writeFile(join(state.privateGitDir, OWNER_FILE), JSON.stringify({ workspaceId: state.workspaceId,
        ownerId: state.input.owner.ownerId, ownerVersion: state.input.owner.ownerVersion,
        planId: state.input.plan.integrationId, targetBase: state.input.plan.target.baseCommit, steps }) + '\n', { mode: 0o600 });
      if (!(await sourceUnchanged(state, state.input))) throw new IntegrationGitError('source_changed');
      current = makeHandle(state, 'ready', afterCommit.head, steps, afterCommit);
      state.input.onStep?.(current);
      if (steps.length === state.input.plan.mergeOrder.length) {
        const completed = makeHandle(state, 'succeeded', afterCommit.head, steps, afterCommit);
        return { ...outcome('succeeded', null, completed, { complete: true }), steps };
      }
    }
    } catch (error) {
      const reason = error instanceof IntegrationGitError ? error.reason : 'git_failed';
      const status = reason === 'stop_unconfirmed' || reason === 'operation_unknown' ? 'unknown' : 'blocked';
      return { ...outcome(status, reason, current, details(error)), steps: current.steps };
    }
  }

  async function cleanup(workspace: IntegrationWorkspaceHandle): Promise<IntegrationWorkspaceOutcome> {
    const state = states.get(workspace.workspaceId);
    if (!state || !(await markerMatches(state, workspace))) return outcome('blocked', 'workspace_not_owned', null);
    try {
      if ((workspace.status !== 'ready' && workspace.status !== 'succeeded') || workspace.steps.length !== state.input.plan.mergeOrder.length) {
        return outcome('blocked', 'workspace_not_clean', workspace);
      }
      const current = await facts(state.input.integrationPath, state.input);
      if (current.statusPorcelain !== '' || current.unresolvedPaths.length > 0) return outcome('blocked', 'workspace_not_clean', workspace);
      if (await lockPresent(state.privateGitDir, state.source.commonDir, state.input)) return outcome('blocked', 'git_lock_present', workspace);
      if (!(await sourceUnchanged(state, state.input))) return outcome('blocked', 'source_changed', workspace);
      const removed = await withLock(state.input, state.input.plan.target.canonicalPath, () => run(state.input.plan.target.canonicalPath,
        ['worktree', 'remove', state.input.integrationPath], state.input));
      if (removed.exitCode !== 0 || removed.reason !== null) return outcome('blocked', 'workspace_not_clean', workspace);
      try { await lstat(state.input.integrationPath); return outcome('blocked', 'workspace_not_clean', workspace); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!(await sourceUnchanged(state, state.input))) return outcome('blocked', 'source_changed', workspace);
      states.delete(workspace.workspaceId);
      const cleaned = Object.freeze({ ...workspace, status: 'cleaned' as const });
      return outcome('cleaned', null, cleaned, { workspaceId: workspace.workspaceId });
    } catch (error) {
      const reason = error instanceof IntegrationGitError ? error.reason : 'git_failed';
      return outcome(reason === 'stop_unconfirmed' || reason === 'operation_unknown' ? 'unknown' : 'blocked', reason, workspace, details(error));
    }
  }
  return { prepare, merge, cleanup };
}

export const createIntegrationWorkspace = createIntegrationGitWorkspace;
