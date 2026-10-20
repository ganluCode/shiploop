/** Supervised Pi transport. Trusted composition owns executable, environment and identity commit. */
import { createHash } from 'node:crypto';
import { RuntimeError } from 'shiploop-core';
import type {
  CommandProcessHandle, CommandProcessPort, CommandProcessResult, CommandProcessIdentity,
  RuntimeExecutionRequest, RuntimeExecutionResult, RuntimeEvent, RuntimeHandle, RuntimeStopEvidence, RuntimeUsageReport,
} from 'shiploop-core';
import {
  PiRunnerDecoder, PiRunnerEventChannel, validatePiRunnerMessage, validatePiRunnerRequest,
} from './pi-runner-protocol.js';

export interface PiRunnerSnapshot {
  readonly failure: { readonly kind: 'protocol' | 'process' | 'timeout'; readonly reason: string; readonly sequence: number } | null;
  readonly diagnostics: readonly { readonly code: string; readonly sequence: number }[];
  readonly lastMessageSequence: number;
  readonly lastEventSequence: number | null;
  readonly bufferedEvents: number;
  readonly bufferedBytes: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
}
export interface PiRunnerHandle extends RuntimeHandle {
  readonly result: Promise<RuntimeExecutionResult>;
  readonly stopped: Promise<RuntimeStopEvidence>;
  inspect(): PiRunnerSnapshot;
}
export interface PiRunnerAdapterOptions {
  readonly process: CommandProcessPort;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly confirm: (identity: CommandProcessIdentity, request: RuntimeExecutionRequest) => Promise<{ readonly launchId: string }>;
}

/** No eviction: forgetting an invocation would permit replay. Create a new scope only with Core authorization. */
export function createPiRunnerAdapter(options: PiRunnerAdapterOptions): {
  start(request: RuntimeExecutionRequest): Promise<PiRunnerHandle>;
} {
  const invocations = new Map<string, { digest: string; handle: Promise<PiRunnerHandle> }>();
  const versions = new Map<string, number>();
  const argv = [...options.argv], environment = { ...options.environment };
  return {
    async start(value) {
      const request = validatePiRunnerRequest(value);
      const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const existing = invocations.get(request.invocationId);
      if (existing) {
        if (existing.digest !== digest) throw new RuntimeError('protocol', 'runner_invocation_conflict');
        return existing.handle;
      }
      if (request.identity.purpose !== 'work') throw new RuntimeError('protocol', 'runner_work_required');
      const key = JSON.stringify([request.projectId, request.identity.runId, request.identity.taskId, request.identity.attemptId]);
      const newest = versions.get(key);
      if (newest !== undefined && request.executionVersion <= newest) throw new RuntimeError('protocol', 'runner_stale_execution');
      if (invocations.size >= 1024) throw new RuntimeError('process', 'runner_invocation_capacity');
      versions.set(key, request.executionVersion);
      // Publish admission before any async startup/confirmation: rejected starts also remain admitted.
      const handle = Promise.resolve().then(async () => {
        let processHandle: CommandProcessHandle;
        try {
          processHandle = await options.process.start({
            argv, cwd: options.cwd, environment,
            stdin: Buffer.from(JSON.stringify(request)), timeoutMs: request.limits.timeoutMs,
            maxInputBytes: 65_536, maxOutputBytes: request.limits.maxOutputBytes,
          }, identity => options.confirm(identity, request));
        } catch { throw new RuntimeError('process', 'runner_start_failed'); }
        return manageRunner(request, processHandle);
      });
      invocations.set(request.invocationId, { digest, handle });
      return handle;
    },
  };
}

function wireEvent(event: RuntimeEvent): RuntimeEvent {
  const payload = event.payload as RuntimeEvent['payload'] & { readonly kind?: RuntimeEvent['kind']; readonly usage?: unknown };
  if (payload.kind === 'usage') return { ...event, payload: payload.usage as unknown as RuntimeEvent['payload'] };
  const { kind: _payloadKind, ...wirePayload } = payload;
  return { ...event, payload: wirePayload as RuntimeEvent['payload'] };
}

function manageRunner(request: RuntimeExecutionRequest, process: CommandProcessHandle): PiRunnerHandle {
  let failure: PiRunnerSnapshot['failure'] = null;
  let lastMessageSequence = 0, lastEventSequence: number | null = null;
  let usage: RuntimeUsageReport | null = null;
  let candidate: RuntimeExecutionResult | null = null;
  let runnerStop: RuntimeStopEvidence | null = null;
  let outcome: CommandProcessResult | null = null;
  let outputBytes = 0, eventCount = 0;
  let settled = false, cancelPromise: Promise<{ accepted: boolean; reason: string | null }> | undefined;
  const diagnostics: Array<{ code: string; sequence: number }> = [];
  const diagnose = (code: string) => {
    if (diagnostics.length < 32) diagnostics.push({ code, sequence: lastMessageSequence });
  };
  const cancel = () => {
    cancelPromise ??= process.cancel().then(receipt => ({ accepted: receipt.accepted, reason: null }),
      () => ({ accepted: false, reason: 'runner_cancel_failed' }));
    return cancelPromise;
  };
  const fail = (kind: 'protocol' | 'process' | 'timeout', reason: string) => {
    if (failure || settled) return;
    failure = { kind, reason, sequence: lastMessageSequence };
    diagnose(reason);
    void cancel();
  };
  const channel = new PiRunnerEventChannel(() => fail('protocol', 'runner_consumer_closed'));
  const decoder = new PiRunnerDecoder();
  const drain = (async () => {
    try {
      for await (const output of process.output) {
        outputBytes += output.bytes.byteLength;
        if (outputBytes > request.limits.maxOutputBytes) fail('protocol', 'runner_output_overflow');
        if (failure) continue; // Keep draining supervised pipes after a controlled failure.
        if (output.stream === 'stderr') {
          // Never retain arbitrary SDK stderr: it can contain prompt text, paths or secrets.
          diagnose('runner_stderr_omitted');
          continue;
        }
        for (const value of decoder.push(output.bytes)) {
          const message = validatePiRunnerMessage(value, request, lastMessageSequence);
          lastMessageSequence = message.sequence;
          switch (message.kind) {
            case 'event': {
              if (candidate) throw new RuntimeError('protocol', 'runner_event_after_result');
              if (message.body.sequence !== (lastEventSequence ?? 0) + 1) throw new RuntimeError('protocol', 'runner_event_sequence');
              if (++eventCount > request.limits.maxEvents) throw new RuntimeError('protocol', 'runner_event_overflow');
              lastEventSequence = message.body.sequence;
              if (message.body.payload.kind === 'usage') usage = message.body.payload.usage;
              if (!channel.push(wireEvent(message.body))) throw new RuntimeError('protocol', 'runner_buffer_overflow');
              break;
            }
            case 'result':
              if (candidate) throw new RuntimeError('protocol', 'runner_duplicate_result');
              if (runnerStop) throw new RuntimeError('protocol', 'runner_result_after_stop');
              if (message.body.lastEventSequence !== lastEventSequence) throw new RuntimeError('protocol', 'runner_result_watermark');
              candidate = message.body;
              if (candidate.usage !== null) usage = candidate.usage;
              break;
            case 'stopped':
              if (runnerStop) throw new RuntimeError('protocol', 'runner_duplicate_stop');
              if (!candidate) throw new RuntimeError('protocol', 'runner_stop_before_result');
              runnerStop = message.body;
              break;
            case 'diagnostic':
              if (diagnostics.length >= 32) throw new RuntimeError('protocol', 'runner_diagnostics_overflow');
              diagnose(message.body.code);
              break;
          }
        }
      }
      if (!failure) decoder.finish();
    } catch (error) {
      fail(error instanceof RuntimeError ? 'protocol' : 'process',
        error instanceof RuntimeError ? error.reason : 'runner_disconnected');
      // A broken decoder must not stop draining the bounded process output.
      // Generator exceptions close its consumer; CommandProcess also requests controlled stop.
    } finally { channel.close(); }
  })();
  const processResult = process.result.then(value => { outcome = value; return value; }, () => {
    fail('process', 'runner_process_lost');
    return null;
  });
  const stopped = process.stopped.then(async stop => {
    await drain;
    return {
      schemaVersion: 1 as const, confirmed: stop.confirmed && runnerStop?.confirmed === true,
      checkedAtUtc: new Date().toISOString(),
      detail: !stop.confirmed ? 'runner_process_stop_unconfirmed' : runnerStop?.confirmed !== true ? 'runner_stop_evidence_missing' : null,
    };
  }, () => ({ schemaVersion: 1 as const, confirmed: false, checkedAtUtc: new Date().toISOString(), detail: 'runner_process_stop_unknown' }));
  const result = (async (): Promise<RuntimeExecutionResult> => {
    await Promise.all([drain, processResult]);
    const observed = outcome as CommandProcessResult | null;
    if (!failure) {
      if (observed?.reason === 'timed_out') fail('timeout', 'runner_timed_out');
      else if (observed?.reason === 'cancelled') fail('process', 'runner_cancelled');
      else if (observed?.reason === 'output_overflow') fail('protocol', 'runner_output_overflow');
      else if (observed?.reason === 'missing_command' || observed?.reason === 'permission_denied' || observed?.reason === 'spawn_failed') fail('process', 'runner_launch_failed');
      else if (observed?.reason) fail('process', 'runner_disconnected');
      else if (observed?.signal !== null || (observed?.exitCode !== null && observed?.exitCode !== 0)) fail('process', 'runner_crashed');
      else if (!candidate) fail('protocol', 'runner_missing_terminal');
    }
    settled = true;
    const final = candidate as RuntimeExecutionResult | null;
    const error = failure as PiRunnerSnapshot['failure'];
    return {
      schemaVersion: 1,
      terminal: error?.kind === 'timeout' ? 'timed_out' : error?.reason === 'runner_cancelled' ? 'cancelled' : error ? 'failed' : final!.terminal,
      reason: error?.reason ?? final?.reason ?? null,
      exitCode: observed?.exitCode ?? null, signal: observed?.signal ?? null,
      durationMs: final?.durationMs ?? null, usage, lastEventSequence,
    };
  })();
  return {
    events: channel, result, stopped,
    cancel: () => settled ? Promise.resolve({ accepted: false, reason: 'runner_already_settled' }) : cancel(),
    inspect: () => ({ failure: failure && { ...failure }, diagnostics: diagnostics.map(item => ({ ...item })),
      lastMessageSequence, lastEventSequence, bufferedEvents: channel.snapshot().events, bufferedBytes: channel.snapshot().bytes,
      exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null }),
  };
}
