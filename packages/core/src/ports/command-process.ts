/** F-009: trusted-project command execution contract. No shell or database ownership. */
export interface CommandProcessRequest {
  readonly argv: readonly string[];
  /** Explicit, already authorized absolute working directory. */
  readonly cwd: string;
  /** Approved values only; never inherits Host environment. Omitted PATH gets a fixed system PATH. */
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  /** Serialized launch input + stdin; at most 65,536 bytes. */
  readonly maxInputBytes: number;
  /** Combined stdout/stderr; at most 8 MiB. */
  readonly maxOutputBytes: number;
}

/** Flat, bounded JSON, compatible with baseline_occupancy.process_identity. */
export interface CommandProcessIdentity {
  readonly launchId: string;
  readonly pid: number;
  readonly processGroupId: number;
  /** OS start identity from macOS ps, not a Host timestamp. */
  readonly startTime: string;
}

/** Core must resolve ONLY AFTER a durable identity commit; errors prevent release. */
export type ConfirmCommandProcessIdentity = (
  identity: CommandProcessIdentity,
) => Promise<{ readonly launchId: string }>;

export type CommandProcessReason = 'missing_command' | 'permission_denied' | 'spawn_failed'
  | 'cancelled' | 'timed_out' | 'output_overflow' | 'supervisor_lost' | 'consumer_closed';
export interface CommandProcessOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly bytes: Uint8Array;
}
export interface CommandProcessStop {
  /** Entire controlled group absent; false requires Core to retain occupancy/quarantine. */
  readonly confirmed: boolean;
}
export interface CommandProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: CommandProcessReason | null;
  /** Bytes retained in the bounded output consumer. */
  readonly outputBytes: number;
  /** Observed pipe bytes omitted during overflow/stop drain; never imply completeness. */
  readonly droppedOutputBytes: number;
  readonly stop: CommandProcessStop;
}
export interface CommandProcessSnapshot {
  readonly identity: CommandProcessIdentity;
  readonly state: 'running' | 'stopping' | 'stopped' | 'uncertain';
  readonly bufferedOutputBytes: number;
}
export interface CommandProcessHandle {
  readonly identity: CommandProcessIdentity;
  /** Single bounded consumer; consume concurrently with result. No full-output accumulation. */
  readonly output: AsyncIterable<CommandProcessOutput>;
  readonly result: Promise<CommandProcessResult>;
  readonly stopped: Promise<CommandProcessStop>;
  query(): CommandProcessSnapshot;
  /** Acceptance is not stop confirmation. Repeated requests are idempotent. */
  cancel(): Promise<{ readonly accepted: boolean }>;
}
export interface CommandProcessPort {
  start(request: CommandProcessRequest, confirm: ConfirmCommandProcessIdentity,
    signal?: AbortSignal): Promise<CommandProcessHandle>;
}
export type CommandProcessErrorReason = 'invalid_input' | 'unsupported_platform'
  | 'handshake_failed' | 'confirmation_failed' | 'start_aborted' | 'stop_unconfirmed';
export class CommandProcessError extends Error {
  readonly reason: CommandProcessErrorReason;
  constructor(reason: CommandProcessErrorReason) {
    super(`CommandProcess.start: ${reason}`);
    this.name = 'CommandProcessError';
    this.reason = reason;
  }
}
