/** P04-1/F-007 controlled Pi fixtures: no provider, credentials or model calls. */
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { ExecutionInputRef } from '../../../packages/core/src/ports/execution-input.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { PiSession, PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';

const digest = 'a'.repeat(64);

export function piRequest(overrides: Partial<RuntimeExecutionRequest> = {}): RuntimeExecutionRequest {
  const ref = (purpose: string): ExecutionInputRef => ({
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain', origin: { kind: 'file', root: 'workspace', relativePath: `${purpose}.txt` },
  });
  return {
    schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1',
    executionVersion: 1, owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
    prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.read'], isolation: 'trusted_project' },
    limits: { timeoutMs: 1_000, maxEvents: 100, maxOutputBytes: 100_000 }, recovery: { mode: 'new' },
    ...overrides,
  };
}

export function piAssembly(agentDir: string, input = 'controlled prompt'): PiTrustedAssembly {
  return {
    agentDir,
    resolveWorkingDirectory: () => agentDir,
    inputReader: { read: async () => input },
    credentialRef: { kind: 'trusted-resolution', id: 'f007-offline-credential' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
  };
}

export interface ScriptedPiSessionOptions {
  readonly events?: readonly unknown[];
  readonly settle?: boolean;
  readonly onAbort?: () => void;
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

/** Minimal AgentSession substitute with explicit lifecycle control. */
export class ScriptedPiSession implements PiSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  private listener: ((event: unknown) => void) | undefined;
  private readonly options: ScriptedPiSessionOptions;
  private disposed = false;
  private aborted = false;

  constructor(options: ScriptedPiSessionOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId ?? 'provider-session-f007';
    this.sessionFile = options.sessionFile ?? `/native/${this.sessionId}.jsonl`;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async prompt(): Promise<void> {
    for (const event of this.options.events ?? []) this.listener?.(event);
  }

  async waitForIdle(): Promise<void> {
    if (this.options.settle !== false) this.listener?.({ type: 'agent_settled' });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.options.onAbort?.();
  }

  dispose(): void { this.disposed = true; }
  wasAborted(): boolean { return this.aborted; }
  wasDisposed(): boolean { return this.disposed; }
}
