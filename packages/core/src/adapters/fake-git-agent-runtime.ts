/** P05-8 / F-003 deterministic, no-model GitAgent Runtime. */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { validateGitAgentRuntimeRequest, validateGitAgentRuntimeResult } from '../ports/git-agent-runtime.js';
import type {
  GitAgentRuntimeAdapter, GitAgentRuntimeHandle, GitAgentRuntimeRequest, GitAgentRuntimeResult,
} from '../ports/git-agent-runtime.js';
import { validateGitAgentRuntimeScript } from '../ports/git-agent-runtime-script.js';
import type { GitAgentRuntimeScript, GitAgentRuntimeScriptStep } from '../ports/git-agent-runtime-script.js';

export interface GitAgentRuntimeGate {
  wait(): Promise<void>;
  readonly released?: boolean;
}
export interface GitAgentRuntimeGateControl extends GitAgentRuntimeGate {
  release(): void;
}
export function createGitAgentRuntimeGate(): GitAgentRuntimeGateControl {
  let released = false;
  let wake!: () => void;
  const pending = new Promise<void>(resolve => { wake = resolve; });
  return { wait: () => pending, get released() { return released; }, release() { if (!released) { released = true; wake(); } } };
}

export interface FakeGitAgentRuntimeOptions {
  readonly script: unknown;
  /** Trusted assembly mapping Core workspace identity to an existing directory. */
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly gates?: Readonly<Record<string, GitAgentRuntimeGate>>;
  /** Finite test budget; no default path can wait forever. */
  readonly maxRuntimeMs?: number;
}

export interface FakeGitAgentRuntimeHandle extends GitAgentRuntimeHandle {
  readonly inspection: { readonly writes: () => readonly string[] };
}

class RuntimeTimeout extends Error {}
class RuntimeCancelled extends Error {}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}
function forbidden(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return segments.includes('.git') || segments.includes('.shiploop') || segments.includes('metadata')
    || segments.includes('credentials') || segments.includes('secrets') || basename === '.env'
    || basename.startsWith('.env.') || /(?:\.sqlite3?|\.db)$/.test(basename);
}
function executionResult(request: GitAgentRuntimeRequest, terminal: GitAgentRuntimeResult['terminal'], changedPaths: readonly string[], verification: GitAgentRuntimeResult['verification'], usage: GitAgentRuntimeResult['usage'], failure: GitAgentRuntimeResult['failure'], stop: GitAgentRuntimeResult['stop']): GitAgentRuntimeResult {
  return validateGitAgentRuntimeResult({ schemaVersion: 1, repairId: request.authorization.repairId, terminal, execution: request.execution, changedPaths, verification, usage, failure, stop }, request);
}

/** Script is trusted test data only; it has no shell, Git, SQLite, network, or model entry point. */
export function createFakeGitAgentRuntime(options: FakeGitAgentRuntimeOptions): GitAgentRuntimeAdapter & { readonly script: GitAgentRuntimeScript } {
  const script = validateGitAgentRuntimeScript(options.script);
  const roots = new Map<string, string>();
  for (const [workspaceId, root] of Object.entries(options.workspaceRoots)) {
    if (!isAbsolute(root)) throw new TypeError('FakeGitAgentRuntime: workspace root must be absolute');
    const real = realpathSync(root);
    if (!lstatSync(real).isDirectory()) throw new TypeError('FakeGitAgentRuntime: workspace root must be a directory');
    roots.set(workspaceId, real);
  }
  const gates = new Map(Object.entries(options.gates ?? {}));
  for (const step of script.steps) {
    if (step.op === 'await_gate' && !gates.has(step.name)) throw new TypeError(`FakeGitAgentRuntime: missing gate ${step.name}`);
  }
  const maxRuntimeMs = options.maxRuntimeMs ?? 1_000;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 3_600_000) throw new TypeError('FakeGitAgentRuntime: maxRuntimeMs must be finite');

  return {
    script,
    async start(rawRequest): Promise<FakeGitAgentRuntimeHandle> {
      const request = validateGitAgentRuntimeRequest(rawRequest);
      const root = roots.get(request.authorization.workspace.workspaceId);
      if (root === undefined) throw new Error('workspace_not_authorized');
      const writes: string[] = [];
      let settled = false;
      let cancelled = false;
      let cancelWake!: () => void;
      const cancelPending = new Promise<void>(resolve => { cancelWake = resolve; });
      let settleStopped!: (stop: { readonly confirmed: boolean; readonly detail: string | null }) => void;
      const stopped = new Promise<{ readonly confirmed: boolean; readonly detail: string | null }>(resolve => { settleStopped = resolve; });
      const verification: GitAgentRuntimeResult['verification'] = {
        strategyId: request.authorization.verification.strategyId,
        strategyDigest: request.authorization.verification.digest,
        outputDigest: null,
        exitCode: null,
      };
      const usage = { consumedTokens: 0, runtimeMs: 0 };
      let result!: Promise<GitAgentRuntimeResult>;
      const run = async (): Promise<GitAgentRuntimeResult> => {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new RuntimeTimeout()), maxRuntimeMs); });
        const waitGate = async (gate: GitAgentRuntimeGate): Promise<void> => {
          await Promise.race([gate.wait(), cancelPending, timeout]);
          if (cancelled) throw new RuntimeCancelled();
        };
        let terminal: GitAgentRuntimeResult['terminal'] = 'completed';
        let failure: GitAgentRuntimeResult['failure'] = null;
        try {
          for (const step of script.steps) {
            await Promise.race([Promise.resolve(), timeout]);
            if (cancelled) throw new RuntimeCancelled();
            await runStep(step, request, root, writes, verification, usage, gates, waitGate);
          }
          terminal = writes.length === 0 ? 'no_change' : 'completed';
        } catch (error) {
          if (error instanceof RuntimeCancelled) {
            terminal = 'cancelled';
            failure = { classification: 'runtime', code: 'cancelled' };
          } else if (error instanceof RuntimeTimeout) {
            terminal = 'timed_out';
            failure = { classification: 'runtime', code: 'timeout' };
          } else if (error instanceof FakeRuntimeFailure) {
            terminal = error.classification === 'invalid' ? 'invalid' : 'failed';
            failure = { classification: error.classification, code: error.code };
          } else {
            terminal = 'failed';
            failure = { classification: 'runtime', code: 'runtime_error' };
          }
        } finally {
          settled = true;
          clearTimeout(timeoutHandle);
        }
        const stop = { confirmed: !script.stopUnconfirmed, detail: script.stopUnconfirmed ? 'stop_unconfirmed' : null };
        if (!stop.confirmed && failure === null) failure = { classification: 'stop_unconfirmed', code: 'stop_unconfirmed' };
        const final = executionResult(request, terminal, writes, verification, usage, failure, stop);
        settleStopped(stop);
        return final;
      };
      result = run();
      return {
        result,
        stopped,
        cancel: async () => {
          if (settled) return { accepted: false, reason: 'already_settled' };
          cancelled = true;
          cancelWake();
          return { accepted: true, reason: 'cancel_requested' };
        },
        inspection: { writes: () => [...writes] },
      };
    },
  };
}

class FakeRuntimeFailure extends Error {
  constructor(readonly classification: 'invalid' | 'out_of_scope' | 'runtime' | 'process_exited', readonly code: string) { super(code); }
}

async function runStep(
  step: GitAgentRuntimeScriptStep,
  request: GitAgentRuntimeRequest,
  root: string,
  writes: string[],
  verification: GitAgentRuntimeResult['verification'],
  usage: { consumedTokens: number; runtimeMs: number },
  gates: Map<string, GitAgentRuntimeGate>,
  waitGate: (gate: GitAgentRuntimeGate) => Promise<void>,
): Promise<void> {
  switch (step.op) {
    case 'no_change': return;
    case 'verification':
      (verification as { outputDigest: string | null; exitCode: number | null }).outputDigest = step.outputDigest;
      (verification as { outputDigest: string | null; exitCode: number | null }).exitCode = step.exitCode;
      return;
    case 'usage':
      if (step.consumedTokens > request.authorization.budget.remainingTokens || step.runtimeMs > request.authorization.budget.remainingRuntimeMs) throw new FakeRuntimeFailure('invalid', 'budget_exhausted');
      usage.consumedTokens += step.consumedTokens;
      usage.runtimeMs += step.runtimeMs;
      if (usage.consumedTokens > request.authorization.budget.remainingTokens || usage.runtimeMs > request.authorization.budget.remainingRuntimeMs) throw new FakeRuntimeFailure('invalid', 'budget_exhausted');
      return;
    case 'fail': throw new FakeRuntimeFailure(step.classification, step.code);
    case 'process_exit': throw new FakeRuntimeFailure('process_exited', step.code);
    case 'await_gate': await waitGate(gates.get(step.name) as GitAgentRuntimeGate); return;
    case 'write_file': {
      if (forbidden(step.path) || !request.authorization.writablePaths.includes(step.path)) throw new FakeRuntimeFailure('out_of_scope', forbidden(step.path) ? 'protected_path' : 'path_outside_authorized_scope');
      const target = join(root, step.path);
      if (!inside(root, target)) throw new FakeRuntimeFailure('out_of_scope', 'path_escape');
      const parent = dirname(target);
      if (!existsSync(parent) || !inside(root, realpathSync(parent))) throw new FakeRuntimeFailure('out_of_scope', 'parent_or_symlink_escape');
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || !inside(root, realpathSync(target)) || stat.isDirectory()) throw new FakeRuntimeFailure('out_of_scope', 'symlink_or_directory');
        if ((stat.mode & 0o222) === 0) throw new FakeRuntimeFailure('out_of_scope', 'write_denied');
        if (readFileSync(target, 'utf8') === step.content) return;
      }
      writeFileSync(target, step.content, { encoding: 'utf8', flag: 'w' });
      if (!writes.includes(step.path)) writes.push(step.path);
      return;
    }
  }
}
