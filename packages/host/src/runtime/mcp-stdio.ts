/** Session-owned MCP lifecycle. Only trusted Host/Runner assembly supplies launch plans and registration. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  McpClient, McpTimeoutError, parseJsonRpcMessage, SUPPORTED_PROTOCOL_VERSIONS,
} from '@earendil-works/pi-mcp';
import type { InitializeResult, JsonRpcMessage, ServerCapabilities, Tool } from '@earendil-works/pi-mcp';
import type { CommandProcessIdentity } from 'shiploop-core';
import { stableStringify } from 'shiploop-core';
import type { McpStartupPlan, McpStartupServerPlan } from './mcp-startup-plan.js';
import { createMcpToolCatalog, discoverMcpTools, McpToolCatalogError, type McpToolCatalog, type McpToolFailureReason } from './mcp-tool-catalog.js';

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export type McpStdioConnectionState = 'not_started' | 'starting' | 'available' | 'failed' | 'closed';
export type McpStdioStopStatus = 'confirmed' | 'unconfirmed' | 'unknown';
export type McpStdioErrorCode = 'unsupported_platform' | 'invalid_startup_plan' | 'missing_executable'
  | 'spawn_failed' | 'process_exited_during_start' | 'process_registration_failed' | 'startup_plan_conflict'
  | 'handshake_timeout' | 'incompatible_protocol' | 'incompatible_capabilities' | 'protocol_error'
  | 'server_exited' | 'cleanup_unconfirmed' | 'closed' | 'tool_discovery_failed';

/** Never includes executable, environment, server output or arbitrary SDK exception text. */
export class McpStdioError extends Error {
  constructor(readonly code: McpStdioErrorCode, readonly causeCode?: McpStdioErrorCode,
    readonly discoveryReason?: McpToolFailureReason) {
    super(`MCP stdio ${code}`);
    this.name = 'McpStdioError';
  }
}
export interface McpStdioProcessRegistration {
  readonly processIdentity: CommandProcessIdentity;
  readonly projectId: string;
  readonly sessionId: string;
  readonly serverId: string;
  readonly invocationId: string;
  readonly planDigest: string;
}
/** Resolve only after committing ownership. A late resolution cannot release protocol requests. */
export type McpStdioProcessRegistrar = (registration: McpStdioProcessRegistration) => Promise<{ readonly launchId: string }>;
export interface McpStdioReady {
  readonly initialize: InitializeResult;
  readonly protocolVersion: string;
  readonly capabilities: ServerCapabilities;
  /** Raw discovery, for the subsequent authorization/schema bridge; never registered as Pi tools here. */
  readonly tools: readonly Tool[];
  readonly processRegistration: McpStdioProcessRegistration;
}
export interface McpStdioCloseResult {
  readonly status: McpStdioStopStatus;
  readonly confirmed: boolean;
  readonly processIdentity: CommandProcessIdentity | null;
  /** Retained even when OS identity acquisition failed. Never sufficient for recovery signalling. */
  readonly pid: number | null;
}
export interface McpStdioProcessRow { readonly pid: number; readonly processGroupId: number; readonly startTime: string }
/** Trusted OS inspection seam. Unknown census is never treated as an empty group. */
export interface McpStdioProcessInspector {
  identify(pid: number, launchId: string): Promise<CommandProcessIdentity>;
  matches(identity: CommandProcessIdentity): Promise<boolean>;
  groupAbsent(processGroupId: number): Promise<boolean>;
}
export interface McpStdioConnectionOptions {
  readonly plan: McpStartupPlan;
  readonly server?: McpStartupServerPlan;
  readonly registerProcess: McpStdioProcessRegistrar;
  readonly platform?: string;
  readonly handshakeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxStderrBytes?: number;
  readonly processInspector?: McpStdioProcessInspector;
}
export interface McpStdioConnection {
  readonly state: McpStdioConnectionState;
  readonly error: McpStdioError | null;
  /** The attempted registration is retained even if persistence rejects or times out. */
  readonly processRegistration: McpStdioProcessRegistration | null;
  readonly stopEvidence: McpStdioCloseResult | null;
  readonly server: McpStartupServerPlan;
  start(): Promise<McpStdioReady>;
  /** Approved Pi definitions only; raw MCP client and direct tool dispatch stay private. */
  createToolCatalog(): Promise<McpToolCatalog>;
  close(): Promise<McpStdioCloseResult>;
}
export type McpStdioManagerStartOptions = McpStdioConnectionOptions;
export interface McpStdioConnectionManager {
  start(options: McpStdioManagerStartOptions): Promise<McpStdioConnection>;
  get(projectId: string, sessionId: string, serverId: string, invocationId: string): McpStdioConnection | undefined;
  closeAll(): Promise<readonly McpStdioCloseResult[]>;
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new McpStdioError('invalid_startup_plan');
  return value;
}
function within<T>(promise: Promise<T>, ms: number, code: McpStdioErrorCode): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpStdioError(code)), Math.max(1, ms));
  })]).finally(() => clearTimeout(timer));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function ps(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('/bin/ps', args, {
    env: { PATH: SYSTEM_PATH, LC_ALL: 'C' }, timeout: 1_000, maxBuffer: 4_194_304,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function parseRow(stdout: string, pid: number): McpStdioProcessRow | null {
  const row = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s|$)/);
  return row && Number(row[1]) === pid ? { pid, processGroupId: Number(row[2]), startTime: row[3]! } : null;
}
const realInspector: McpStdioProcessInspector = {
  async identify(pid, launchId) {
    const row = parseRow(await ps(['-p', String(pid), '-o', 'pid=,pgid=,lstart=']), pid);
    if (!row || row.processGroupId !== pid) throw new McpStdioError('process_exited_during_start');
    return freeze({ launchId, ...row });
  },
  async matches(identity) {
    const row = parseRow(await ps(['-p', String(identity.pid), '-o', 'pid=,pgid=,lstart=']), identity.pid);
    return row !== null && row.processGroupId === identity.processGroupId && row.startTime === identity.startTime;
  },
  async groupAbsent(pgid) {
    const rows = await ps(['-axo', 'pid=,pgid=']);
    if (!rows.trim()) return false;
    return !rows.trim().split('\n').some(line => Number(line.trim().split(/\s+/)[1]) === pgid);
  },
};

/** Own pipes only: nothing from the server is forwarded to Runner stdout or to a console. */
class McpStdioTransport {
  private readonly messages = new Set<(message: JsonRpcMessage) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly closes = new Set<() => void>();
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private stderrBuffer = Buffer.alloc(0);
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<McpStdioCloseResult>;
  private closed = false;
  private closeEmitted = false;
  private failure?: McpStdioError;
  private identity: CommandProcessIdentity | null = null;
  private pid: number | null = null;
  private totalBytes = 0;
  constructor(private readonly options: {
    server: McpStartupServerPlan; maxMessageBytes: number; maxStderrBytes: number;
    closeTimeoutMs: number; inspector: McpStdioProcessInspector;
  }) {}
  get processIdentity(): CommandProcessIdentity | null { return this.identity; }
  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onError(listener: (error: Error) => void): () => void { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  onClose(listener: () => void): () => void { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  private fail(error: McpStdioError): void {
    this.failure ??= error;
    for (const listener of this.errors) listener(this.failure);
  }
  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closes) listener();
  }
  private readonly stdout = (chunk: Buffer) => {
    if (this.closed || this.failure) return;
    this.totalBytes += chunk.length;
    if (this.totalBytes > 8_388_608) { this.fail(new McpStdioError('protocol_error')); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.failure) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > this.options.maxMessageBytes) this.fail(new McpStdioError('protocol_error'));
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > this.options.maxMessageBytes) { this.fail(new McpStdioError('protocol_error')); return; }
      if (!line.toString('utf8').trim()) continue;
      try {
        const message = parseJsonRpcMessage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
        if ('result' in message && message.result && typeof message.result === 'object'
          && 'protocolVersion' in message.result
          && !(SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(message.result.protocolVersion)) {
          this.fail(new McpStdioError('incompatible_protocol'));
          return;
        }
        for (const listener of this.messages) listener(message);
      } catch { this.fail(new McpStdioError('protocol_error')); }
    }
  };
  private readonly stderr = (chunk: Buffer) => {
    // Bounded private tail; server diagnostics never enter public errors or snapshots.
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]).subarray(-this.options.maxStderrBytes);
  };
  private readonly pipeError = () => { if (!this.closed) this.fail(new McpStdioError('protocol_error')); };
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new McpStdioError('closed'));
    // The lifecycle pre-starts the transport to commit identity before McpClient.connect calls start again.
    this.startPromise ??= this.spawn();
    return this.startPromise;
  }
  private async spawn(): Promise<void> {
    const { server } = this.options;
    const child = spawn(server.executable, [...server.argv], {
      cwd: server.cwd, env: { PATH: SYSTEM_PATH, ...server.environment }, shell: false,
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid ?? null;
    child.stdout.on('data', this.stdout);
    child.stderr.on('data', this.stderr);
    child.stdin.on('error', this.pipeError);
    child.stdout.on('error', this.pipeError);
    child.stderr.on('error', this.pipeError);
    child.once('close', () => {
      if (!this.closed) this.fail(new McpStdioError('process_exited_during_start'));
      this.emitClose();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.on('error', (error: NodeJS.ErrnoException) => {
        const failure = new McpStdioError(error.code === 'ENOENT' ? 'missing_executable' : 'spawn_failed');
        this.fail(failure); reject(failure);
      });
    });
    if (this.pid === null) throw new McpStdioError('spawn_failed');
    try {
      this.identity = await within(this.options.inspector.identify(this.pid, randomUUID()), 1_500, 'process_registration_failed');
    } catch {
      throw this.failure ?? new McpStdioError(child.exitCode !== null || child.signalCode !== null
        ? 'process_exited_during_start' : 'process_registration_failed');
    }
    if (this.failure) throw this.failure;
  }
  async send(message: JsonRpcMessage): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed || !this.child?.stdin.writable) throw new McpStdioError('closed');
    const bytes = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(bytes) > this.options.maxMessageBytes) throw new McpStdioError('protocol_error');
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(bytes,
      error => error ? reject(new McpStdioError('protocol_error')) : resolve()));
  }
  async close(): Promise<void> { await this.shutdown(); }
  shutdown(): Promise<McpStdioCloseResult> {
    this.stopPromise ??= this.stop();
    return this.stopPromise;
  }
  private async waitExit(ms: number): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let timer: NodeJS.Timeout;
    let done!: () => void;
    await new Promise<void>(resolve => {
      done = resolve;
      child.once('exit', done);
      timer = setTimeout(done, ms);
    }).finally(() => { clearTimeout(timer); child.off('exit', done); });
  }
  private async absent(): Promise<boolean> {
    if (this.pid === null) return true;
    try { return await within(this.options.inspector.groupAbsent(this.pid), 1_500, 'cleanup_unconfirmed'); }
    catch { return false; }
  }
  private async stop(): Promise<McpStdioCloseResult> {
    this.closed = true;
    const child = this.child;
    try {
      child?.stdin.end();
      await this.waitExit(this.options.closeTimeoutMs);
      if (!(await this.absent()) && child) {
        let matched = false;
        if (this.identity) {
          try { matched = await within(this.options.inspector.matches(this.identity), 1_500, 'cleanup_unconfirmed'); } catch { /* unknown */ }
        }
        if (matched && this.identity) {
          try { process.kill(-this.identity.processGroupId, 'SIGTERM'); } catch { /* verify absence below */ }
          await this.waitExit(this.options.closeTimeoutMs);
          if (!(await this.absent())) {
            try { process.kill(-this.identity.processGroupId, 'SIGKILL'); } catch { /* verify absence below */ }
            await this.waitExit(this.options.closeTimeoutMs);
          }
        } else if (this.identity === null && child.exitCode === null && child.signalCode === null) {
          // An unreaped owned ChildProcess can be stopped even if identity construction failed.
          // Descendants still require a full census; no recovery signals use a bare stored PID.
          child.kill('SIGKILL');
          await this.waitExit(this.options.closeTimeoutMs);
        }
      }
      const confirmed = await this.absent();
      return freeze({ status: confirmed ? 'confirmed' as const : 'unconfirmed' as const,
        confirmed, processIdentity: this.identity, pid: this.pid });
    } finally {
      child?.stdout.off('data', this.stdout); child?.stderr.off('data', this.stderr);
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
      this.buffer = Buffer.alloc(0); this.stderrBuffer = Buffer.alloc(0);
      this.emitClose();
      this.messages.clear(); this.errors.clear(); this.closes.clear();
    }
  }
}

function selectServer(plan: McpStartupPlan, server?: McpStartupServerPlan): McpStartupServerPlan {
  const selected = server ?? (plan.servers.length === 1 ? plan.servers[0] : undefined);
  const approved = selected && plan.servers.find(item => stableStringify(item) === stableStringify(selected));
  if (!approved) throw new McpStdioError('invalid_startup_plan');
  return approved;
}

export function createMcpStdioConnection(options: McpStdioConnectionOptions): McpStdioConnection {
  // Snapshot before asynchronous registration. Mutable caller input cannot alter the approved spawn.
  const plan = freeze(structuredClone(options.plan));
  const server = selectServer(plan, options.server);
  if ((options.platform ?? process.platform) !== 'darwin' || process.platform !== 'darwin') throw new McpStdioError('unsupported_platform');
  if (typeof options.registerProcess !== 'function') throw new McpStdioError('invalid_startup_plan');
  const handshakeMs = bounded(options.handshakeTimeoutMs, 5_000, 60_000);
  const closeMs = bounded(options.closeTimeoutMs, 2_000, 10_000);
  const transport = new McpStdioTransport({ server,
    maxMessageBytes: bounded(options.maxMessageBytes, 1_048_576, 8_388_608),
    maxStderrBytes: bounded(options.maxStderrBytes, 65_536, 1_048_576), closeTimeoutMs: closeMs,
    inspector: options.processInspector ?? realInspector });
  let state: McpStdioConnectionState = 'not_started';
  let error: McpStdioError | null = null;
  let registration: McpStdioProcessRegistration | null = null;
  let startPromise: Promise<McpStdioReady> | undefined;
  let closePromise: Promise<McpStdioCloseResult> | undefined;
  let client: McpClient | undefined;
  let catalogPromise: Promise<McpToolCatalog> | undefined;
  const discover = (timeoutMs: number, signal?: AbortSignal) => {
    const deadline = Date.now() + timeoutMs;
    return discoverMcpTools(cursor => client!.request('tools/list', cursor === undefined ? undefined : { cursor },
      { timeoutMs: Math.max(1, deadline - Date.now()), signal }));
  };
  let closing = false;
  let stopEvidence: McpStdioCloseResult | null = null;
  let rejectFailure!: (error: McpStdioError) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});
  const fail = (cause: McpStdioError) => {
    if (state === 'available' && cause.code === 'process_exited_during_start') cause = new McpStdioError('server_exited');
    error ??= cause;
    rejectFailure(error);
    if (state === 'available') {
      state = 'failed';
      void close();
    }
  };
  transport.onError(cause => fail(cause instanceof McpStdioError ? cause : new McpStdioError('protocol_error')));
  const close = (): Promise<McpStdioCloseResult> => {
    if (closePromise) return closePromise;
    closing = true;
    if (state === 'starting') fail(new McpStdioError('closed'));
    closePromise = (async () => {
      // Closing the client removes correlation timers and SDK transport listeners.
      await client?.close().catch(() => {});
      stopEvidence = await transport.shutdown();
      if (!stopEvidence.confirmed) {
        error = new McpStdioError('cleanup_unconfirmed', error?.code);
        state = 'failed';
      } else if (state !== 'failed') state = 'closed';
      return stopEvidence;
    })();
    return closePromise;
  };
  return {
    get state() { return state; }, get error() { return error; }, get processRegistration() { return registration; },
    get stopEvidence() { return stopEvidence; }, server,
    start() {
      if (startPromise) return startPromise;
      if (closing) return Promise.reject(new McpStdioError('closed'));
      state = 'starting';
      const deadline = Date.now() + handshakeMs;
      const execute = async (): Promise<McpStdioReady> => {
        await transport.start();
        if (closing || Date.now() >= deadline) throw new McpStdioError('handshake_timeout');
        const processIdentity = transport.processIdentity;
        if (!processIdentity) throw new McpStdioError('process_registration_failed');
        registration = freeze({ processIdentity, projectId: plan.projectId, sessionId: plan.sessionId,
          serverId: server.resourceId, invocationId: plan.invocationId, planDigest: plan.digest });
        let ack: { readonly launchId: string };
        try { ack = await options.registerProcess(registration); }
        catch { throw new McpStdioError('process_registration_failed'); }
        if (!ack || ack.launchId !== processIdentity.launchId) throw new McpStdioError('process_registration_failed');
        if (closing || error) throw error ?? new McpStdioError('closed');
        client = new McpClient({ name: 'shiploop-mcp-client', version: '1.0.0', requestTimeoutMs: handshakeMs });
        const initialized = await client.connect(transport);
        if (!initialized.capabilities.tools || typeof initialized.capabilities.tools !== 'object'
          || Array.isArray(initialized.capabilities.tools)) {
          throw new McpStdioError('incompatible_capabilities');
        }
        const tools = await discover(Math.max(1, deadline - Date.now()));
        if (closing || error) throw error ?? new McpStdioError('closed');
        state = 'available';
        return freeze({ initialize: initialized, protocolVersion: initialized.protocolVersion,
          capabilities: initialized.capabilities, tools, processRegistration: registration });
      };
      startPromise = within(Promise.race([execute(), failure]), handshakeMs, 'handshake_timeout').catch(async cause => {
        error ??= cause instanceof McpStdioError ? cause : cause instanceof McpToolCatalogError
          ? new McpStdioError('tool_discovery_failed', undefined, cause.reason) : cause instanceof McpTimeoutError
          ? new McpStdioError('handshake_timeout') : new McpStdioError('protocol_error');
        state = 'failed';
        const result = await close();
        if (!result.confirmed && error.code !== 'cleanup_unconfirmed') error = new McpStdioError('cleanup_unconfirmed', error.code);
        throw error;
      });
      return startPromise;
    },
    createToolCatalog() {
      if (state !== 'available' || closing || !client) return Promise.reject(error ?? new McpStdioError('closed'));
      catalogPromise ??= createMcpToolCatalog({ plan, endpoints: [{ server,
        discover: async signal => {
          if (state !== 'available' || closing) throw error ?? new McpStdioError('closed');
          return discover(handshakeMs, signal);
        },
        call: async (name, args, signal) => {
          if (state !== 'available' || closing) throw error ?? new McpStdioError('closed');
          return client!.callTool(name, args, { signal, timeoutMs: handshakeMs });
        },
      }] });
      return catalogPromise;
    }, close,
  };
}

export function createMcpStdioConnectionManager(): McpStdioConnectionManager {
  const entries = new Map<string, { digest: string; connection: McpStdioConnection; promise: Promise<McpStdioConnection> }>();
  const keyOf = (project: string, session: string, server: string, invocation: string) => JSON.stringify([project, session, server, invocation]);
  return {
    start(options) {
      const server = selectServer(options.plan, options.server);
      const key = keyOf(options.plan.projectId, options.plan.sessionId, server.resourceId, options.plan.invocationId);
      // Compare actual plan data as well as its trusted digest to reject mutated envelopes.
      const digest = createHash('sha256').update(stableStringify(options.plan)).digest('hex');
      const existing = entries.get(key);
      if (existing) return existing.digest === digest ? existing.promise : Promise.reject(new McpStdioError('startup_plan_conflict'));
      const connection = createMcpStdioConnection(options);
      const promise = connection.start().then(() => connection);
      entries.set(key, { digest, connection, promise });
      return promise;
    },
    get(project, session, server, invocation) { return entries.get(keyOf(project, session, server, invocation))?.connection; },
    async closeAll() {
      const results: McpStdioCloseResult[] = [];
      for (const entry of entries.values()) results.push(await entry.connection.close());
      return results;
    },
  };
}

/** All-or-rollback construction; individual failed starts preserve their own identity and stop evidence. */
export async function startMcpStdioConnections(options: Omit<McpStdioConnectionOptions, 'server'>): Promise<readonly McpStdioConnection[]> {
  const manager = createMcpStdioConnectionManager();
  const connections: McpStdioConnection[] = [];
  try {
    for (const server of options.plan.servers) connections.push(await manager.start({ ...options, server }));
    return connections;
  } catch (cause) {
    const stops = await manager.closeAll();
    if (stops.some(stop => !stop.confirmed)) throw new McpStdioError('cleanup_unconfirmed', cause instanceof McpStdioError ? cause.code : 'protocol_error');
    throw cause;
  }
}
