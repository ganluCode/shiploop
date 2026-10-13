// Synthetic protocol fixture only: no SDK, credentials, Core tables or OS stop claims.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideRuntimeRecovery, validateRuntimeRecoveryReference, validateRuntimeRecoveryRequest } from '../../../packages/core/src/index.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import type { RuntimeRecoveryCapabilities, RuntimeRecoveryDecision, RuntimeRecoveryKind, RuntimeRecoveryReference, RuntimeRecoveryRequest } from '../../../packages/core/src/index.ts';
import type { SyntheticEvent, SyntheticUsage } from './recording.ts';

export function syntheticCapabilities(): RuntimeRecoveryCapabilities {
  const evidence = { status: 'verified' as const, evidenceRef: 'synthetic-evidence', limits: ['synthetic only; no SDK guarantees'] };
  return { schemaVersion: 1, runtimeId: 'synthetic', adapterVersion: '1', sdkVersion: null,
    nativeFormats: [{ format: 'synthetic-json', versions: ['1'] }], limits: ['offline fixture'],
    capabilities: { nativeHistory: { ...evidence }, conversationResume: { ...evidence },
      executionRecovery: { ...evidence }, modelSwitchOnResume: { ...evidence }, nativeFork: { ...evidence } } };
}
export interface SyntheticTool {
  requestId: string;
  toolCallId: string;
  text: string;
  identifiable: boolean;
}
type ToolState = SyntheticTool & { confirmed: boolean };
interface NativeState {
  synthetic: true;
  request: RuntimeRecoveryRequest;
  providerSessionId: string;
  tools: ToolState[];
  replies: string[];
  status: 'active' | 'interrupted' | 'quarantined' | 'completed';
}
export type Interruption = 'before-tool' | 'after-tool' | 'stream';
export interface SyntheticResultEnvelope {
  request: RuntimeRecoveryRequest;
  invocationId: string;
  executionVersion: number;
  status: 'completed';
}
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export class SyntheticRecoveryDriver {
  readonly root: string;
  readonly capabilities: RuntimeRecoveryCapabilities;
  private state?: NativeState;
  private decision?: RuntimeRecoveryDecision;
  private lock?: { path: string; fd: number };
  private interrupted = false;
  private quarantined = false;
  private settled = false;
  newReplies = 0;

  constructor(root: string, capabilities = syntheticCapabilities()) {
    this.root = root;
    this.capabilities = structuredClone(capabilities);
    for (const dir of ['native', 'artifacts']) mkdirSync(join(root, dir), { recursive: true });
  }
  private nativePath(id: string) { return join(this.root, 'native', `${id}.json`); }
  private writerPath(providerSessionId: string) { return join(this.root, 'native', `${digest(providerSessionId)}.lock`); }
  private artifactPath(id: string) { return join(this.root, 'artifacts', `${id}.json`); }
  private reference(state: NativeState, kind: RuntimeRecoveryKind, hash: string): RuntimeRecoveryReference {
    const request = state.request;
    return validateRuntimeRecoveryReference({ schemaVersion: 1, kind, sourceProjectId: request.projectId, sourceSessionId: request.sessionId,
      runtime: request.strategy.runtime, provider: request.strategy.provider, model: request.strategy.model,
      providerSessionId: state.providerSessionId, nativeArchiveRef: `archive-${hash}`, nativeFormat: 'synthetic-json',
      nativeFormatVersion: '1', sourceDigest: hash,
      ...(kind === 'checkpoint' ? { checkpointRef: `checkpoint-${hash}` } : {}),
      ...(request.identity.purpose === 'work'
        ? { purpose: 'work', sourceTaskId: request.identity.taskId, sourceAttemptId: request.identity.attemptId }
        : { purpose: 'chat', sourceTurnId: request.identity.turnId }) });
  }
  private readSource(value: RuntimeRecoveryReference): NativeState {
    const source = validateRuntimeRecoveryReference(value);
    const bytes = readFileSync(this.artifactPath(source.nativeArchiveRef));
    if (digest(bytes) !== source.sourceDigest) throw new Error('source_digest_mismatch');
    if (source.kind === 'checkpoint' && !readFileSync(this.artifactPath(source.checkpointRef)).equals(bytes)) {
      throw new Error('checkpoint_source_mismatch');
    }
    const state = JSON.parse(bytes.toString('utf8')) as NativeState;
    if (state.synthetic !== true || !same(source, this.reference(state, source.kind, digest(bytes)))) {
      throw new Error('source_identity_mismatch');
    }
    validateRuntimeRecoveryRequest(state.request);
    return state;
  }
  begin(value: RuntimeRecoveryRequest, stopped: 'confirmed' | 'unknown' = 'unknown'): RuntimeRecoveryDecision {
    const request = validateRuntimeRecoveryRequest(value);
    if (this.state) {
      if (!same(this.state.request, request)) throw new Error('invocation_identity_conflict');
      return structuredClone(this.decision!);
    }
    const selection = request.recovery;
    let source: NativeState | undefined;
    if (selection.mode !== 'new' && selection.source) {
      if (stopped !== 'confirmed') throw new Error('stop_unconfirmed');
      source = this.readSource(selection.source);
      if (existsSync(this.writerPath(source.providerSessionId))) throw new Error('native_writer_busy');
    }
    const decision = decideRuntimeRecovery(request, this.capabilities);
    if (decision.mode === 'rejected') return decision;
    const path = this.nativePath(request.invocationId);
    const inherited = decision.mode === 'resume' ? source : undefined;
    const providerSessionId = inherited?.providerSessionId ?? `native-${request.invocationId}`;
    const lockPath = this.writerPath(providerSessionId);
    try { this.lock = { path: lockPath, fd: openSync(lockPath, 'wx') }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('native_writer_busy');
      throw error;
    }
    try {
      if (existsSync(path)) {
        this.state = JSON.parse(readFileSync(path, 'utf8')) as NativeState;
        if (!same(this.state.request, request)) throw new Error('invocation_identity_conflict');
      } else {
        this.state = { synthetic: true, request, providerSessionId,
          tools: structuredClone(inherited?.tools ?? []), replies: structuredClone(inherited?.replies ?? []), status: 'active' };
        this.save();
      }
      this.interrupted = this.state.status === 'interrupted';
      this.quarantined = this.state.status === 'quarantined';
      this.settled = this.state.status === 'completed';
      this.newReplies = 0;
      this.decision = decision;
      return structuredClone(decision);
    } catch (error) { this.close(); throw error; }
  }
  private save() {
    if (!this.lock || !this.state) throw new Error('no_native_writer');
    writeFileSync(this.nativePath(this.state.request.invocationId), stableStringify(this.state));
  }
  execute(tool: SyntheticTool, point?: Interruption): { status: string; requestId: string; toolCallId: string; stopped?: false; quarantined?: true } {
    if (!this.state || !this.lock) throw new Error('no_native_writer');
    const identity = { requestId: tool.requestId, toolCallId: tool.toolCallId };
    const uncertain = () => {
      this.quarantined = true;
      if (!this.settled) { this.state!.status = 'quarantined'; this.save(); }
      return { ...identity, status: 'needs_reconciliation', stopped: false as const, quarantined: true as const };
    };
    if (this.interrupted || this.quarantined || this.settled) return uncertain();
    let entry = this.state.tools.find(item => item.requestId === tool.requestId && item.toolCallId === tool.toolCallId);
    if (entry && (entry.text !== tool.text || entry.identifiable !== tool.identifiable)) throw new Error('request_identity_conflict');
    const existing = entry !== undefined;
    if (!entry) {
      entry = { ...tool, confirmed: false };
      this.state.tools.push(entry);
      this.save();
    }
    const interrupt = () => {
      this.interrupted = true;
      this.state!.status = 'interrupted';
      this.save();
      return { ...identity, status: 'interrupted', stopped: false as const };
    };
    if (point === 'before-tool') return interrupt();
    if (existing && !entry.confirmed && !tool.identifiable) return uncertain();
    const effect = { providerSessionId: this.state.providerSessionId, ...identity, text: tool.text };
    const matching = this.effects().filter(row => {
      const value = row as Record<string, unknown>;
      return value.providerSessionId === effect.providerSessionId && value.requestId === tool.requestId && value.toolCallId === tool.toolCallId;
    });
    if (matching.length > 1 || (matching.length === 1 && !same(matching[0], effect))) return uncertain();
    if (tool.identifiable && entry.confirmed && matching.length !== 1) return uncertain();
    // Only this controlled append tool has an absence/presence reconciliation rule.
    // This is not a replay guarantee for shell, Git or external APIs.
    if (!entry.confirmed && matching.length === 0) {
      appendFileSync(join(this.root, 'effects.jsonl'), `${JSON.stringify(tool.identifiable ? effect : { text: tool.text })}\n`);
    }
    if (point === 'after-tool') return interrupt();
    entry.confirmed = true;
    const replyKey = `${this.state.request.invocationId}/${tool.requestId}/${tool.toolCallId}`;
    if (!this.state.replies.includes(replyKey)) {
      this.state.replies.push(replyKey);
      this.newReplies += 1;
    }
    this.save();
    if (point === 'stream') return interrupt();
    return { ...identity, status: 'completed' };
  }
  events(): SyntheticEvent[] {
    if (!this.state) throw new Error('no_native_state');
    const providerSessionId = this.state.providerSessionId;
    return [
      ...this.state.tools.flatMap(tool => [
        { providerSessionId, nativeEventKey: `${tool.requestId}/${tool.toolCallId}/started`,
          requestId: tool.requestId, toolCallId: tool.toolCallId, payload: 'tool.started' },
        ...(tool.confirmed ? [{ providerSessionId, nativeEventKey: `${tool.requestId}/${tool.toolCallId}/completed`,
          requestId: tool.requestId, toolCallId: tool.toolCallId, payload: 'tool.completed' }] : []),
      ]),
      ...this.state.replies.map(reply => ({ providerSessionId, nativeEventKey: `reply/${reply}`, payload: 'message.completed' })),
    ];
  }
  usage(): SyntheticUsage[] {
    if (!this.state) throw new Error('no_native_state');
    const state = this.state;
    return state.replies.map(reply => ({ usageId: reply, providerSessionId: state.providerSessionId,
      scopeId: reply, covers: [reply], mode: 'incremental', tokens: 7,
      phase: reply.startsWith(`${state.request.invocationId}/`) ? 'current' : 'historical' }));
  }
  effects(): unknown[] {
    const path = join(this.root, 'effects.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  }
  archive(kind: RuntimeRecoveryKind): RuntimeRecoveryReference {
    if (!this.state) throw new Error('no_native_state');
    const bytes = stableStringify(this.state);
    const source = this.reference(this.state, kind, digest(bytes));
    for (const id of [source.nativeArchiveRef, ...(source.kind === 'checkpoint' ? [source.checkpointRef] : [])]) {
      const path = this.artifactPath(id);
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') !== bytes) throw new Error('immutable_source_conflict');
      } else writeFileSync(path, bytes, { flag: 'wx' });
    }
    return source;
  }
  history(source: RuntimeRecoveryReference): string[] {
    if (this.capabilities.capabilities.nativeHistory.status !== 'verified') throw new Error('native_history_unavailable');
    return this.readSource(source).replies;
  }
  cancel() {
    if (!this.state || !this.lock) throw new Error('no_native_writer');
    this.interrupted = true;
    this.quarantined = true;
    this.state.status = 'quarantined';
    this.save();
    return { accepted: true, stopped: false, quarantined: true };
  }
  resultEnvelope(): SyntheticResultEnvelope {
    if (!this.state) throw new Error('no_native_state');
    return { request: structuredClone(this.state.request), invocationId: this.state.request.invocationId,
      executionVersion: this.state.request.executionVersion, status: 'completed' };
  }
  acceptResult(envelope: SyntheticResultEnvelope) {
    if (this.interrupted || this.quarantined || this.settled || this.newReplies === 0 || !same(envelope, this.resultEnvelope())) return 'diagnostic_only';
    this.state!.status = 'completed';
    this.save();
    this.settled = true;
    return 'accepted_runtime_result';
  }
  close() {
    if (this.lock) { closeSync(this.lock.fd); unlinkSync(this.lock.path); this.lock = undefined; }
    this.state = undefined;
  }
}
