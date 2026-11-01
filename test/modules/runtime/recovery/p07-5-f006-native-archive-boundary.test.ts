/**
 * P07-5 / F-006：标准 Pi 原生档案异常与恢复声明行为验收（离线，不调用模型）。
 *
 * 来源正文全部来自真实 SDK SessionManager 落盘的标准 JSONL（无伪造原生
 * SQLite 表）；矩阵覆盖：
 * 1. [case:p07-f006-genuine-jsonl-admission] 真实标准 JSONL 的免模型读取与
 *    恢复准备：水位事实正确、字节仅来自制品读取器、来源文件保持不变；
 * 2. [case:p07-f006-source-missing] 来源缺失（adapter 制品读取拒绝 + 公共
 *    Core 服务制品缺失）明确拒绝且不触碰来源；
 * 3. [case:p07-f006-body-corrupt] 正文损坏（截断尾行/空正文）拒绝；
 * 4. [case:p07-f006-digest-mismatch] 摘要不匹配（sourceDigest 与正文不符）拒绝；
 * 5. [case:p07-f006-unknown-format-version] 未知格式/版本（引用格式版本与
 *    正文 header 版本）拒绝；
 * 6. [case:p07-f006-cross-project-purpose] 跨项目/用途/任务引用拒绝；
 * 7. [case:p07-f006-declared-mode-matrix] auto/new/required × conversation/
 *    checkpoint 的已声明行为：生产能力目录保持 unsupported，auto 仅按政策
 *    新建并记录降级，required 明确拒绝，new 不读取来源；
 * 8. [case:p07-f006-evidence-separation] 公开恢复闭环与 adapter 本地验证分开
 *    留证：Core 水位与原生水位分字段绑定，历史用量排除，live 续聊 not_run。
 */
import { observeP07Memory, observeP07Native } from '../../../helpers/p07-5/entry-observation.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { recoveryRecordingForRequest } from '../../../../packages/core/src/application/runtime-recovery-recording.ts';
import { createRuntimeRecoveryService } from '../../../../packages/core/src/application/runtime-recovery.ts';
import { computeExecutionPermissionsDigest } from '../../../../packages/core/src/ports/execution-input-prepare.ts';
import type { ExecutionInputRef, RuntimeExecutionRequest, RuntimeRecoveryReference, RuntimeRecoveryRequest } from '../../../../packages/core/src/index.ts';
import { PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION, PI_RUNTIME_RECOVERY_CAPABILITIES, PI_SDK_VERSION,
  type PiRecoveryWriterLease } from '../../../../packages/host/src/runtime/pi-adapter.ts';
import { preparePiRecovery, validatePiNativeArchive } from '../../../../packages/host/src/runtime/pi-native-session.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { observeP07Native(root); await rm(root, { recursive: true, force: true }); } });

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 真实标准 Pi JSONL：仅离线追加消息，绝不调用模型。 */
async function genuineArchive(root: string): Promise<{ file: string; bytes: Uint8Array; sessionId: string }> {
  const source = SessionManager.create(root, join(root, 'source-scope'));
  source.appendModelChange('anthropic', 'claude-sonnet-4-5');
  source.appendMessage({ role: 'user', content: 'existing work', timestamp: 1 });
  source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous answer' }],
    provider: 'anthropic', model: 'claude-sonnet-4-5', api: 'anthropic-messages', timestamp: 2,
    stopReason: 'stop', usage });
  const file = source.getSessionFile();
  if (file === undefined) throw new Error('genuine session file missing');
  return { file, bytes: new Uint8Array(await readFile(file)), sessionId: source.getSessionId() };
}

function artifact(projectId: string, id: string, bytes: Uint8Array, kind: string, mediaType: string): ExecutionInputRef {
  return { projectId, artifactId: id, kind, purpose: 'recovery', version: 1, contentHash: digest(bytes),
    sizeBytes: bytes.byteLength, locator: `sessions/${id}`, mediaType, origin: { kind: 'file', root: 'data', relativePath: `sessions/${id}` } };
}

function recoverySource(archive: Uint8Array, providerSessionId: string, patch: Partial<RuntimeRecoveryReference> = {}): RuntimeRecoveryReference {
  return { schemaVersion: 1, purpose: 'work', kind: 'conversation',
    sourceProjectId: 'project-1', sourceSessionId: 'session-old', sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old',
    runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5', providerSessionId,
    nativeArchiveRef: 'archive-old', nativeFormat: PI_NATIVE_SESSION_FORMAT,
    nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION, sourceDigest: digest(archive), ...patch } as RuntimeRecoveryReference;
}

function executionRequest(source: RuntimeRecoveryReference, mode: 'auto' | 'required' = 'required'): RuntimeExecutionRequest {
  const input = artifact('project-1', 'input', Buffer.from('input'), 'execution-input', 'text/plain');
  return { schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-new',
    invocationId: 'invocation-new', executionVersion: 2,
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    prompt: input, inputManifest: input, cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 100, maxOutputBytes: 100_000 },
    recovery: { mode, kind: 'conversation', source } };
}

/** 公共 Core 恢复服务入参（RuntimeRecoveryRequest 形态，不含执行请求扩展字段）。 */
function recoveryServiceRequest(source: RuntimeRecoveryReference, mode: 'auto' | 'required' | 'new' = 'required',
  kind: 'conversation' | 'checkpoint' = 'conversation'): RuntimeRecoveryRequest {
  return { schemaVersion: 1, projectId: 'project-1', sessionId: 'session-new', executionVersion: 2, invocationId: 'invocation-new',
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    ...(mode === 'new' ? { recovery: { mode } } : { recovery: { mode, kind, source } }) } as RuntimeRecoveryRequest;
}

/** 受控租约：字节仅来自制品读取器；可注入缺失/损坏正文与停止状态。 */
function controlledLease(source: RuntimeRecoveryReference, archive: Uint8Array, options: {
  stopConfirmed?: boolean; archiveBytes?: Uint8Array | null; sdkVersion?: string; formatVersion?: string;
} = {}) {
  const workSource = source as RuntimeRecoveryReference & { sourceAttemptId: string };
  const workIdentity = { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' };
  const stopBytes = Buffer.from('{"confirmed":true}');
  /* 制品 ref 描述登记字节；缺失时读取器直接拒绝，损坏时 ref 描述实际服务字节。 */
  const served = options.archiveBytes == null ? archive : options.archiveBytes;
  const archiveRef = artifact('project-1', 'archive-old', served, 'runtime-native-archive', 'application/x-ndjson');
  const stop: ExecutionInputRef = artifact('project-1', 'stop-old', stopBytes, 'recovery-stop', 'application/json');
  const request = executionRequest(source);
  const value: PiRecoveryWriterLease = {
    source: { reference: source, archive: archiveRef, sdkVersion: options.sdkVersion ?? PI_SDK_VERSION,
      previousWriter: { status: (options.stopConfirmed === false ? 'unknown' : 'confirmed') as 'confirmed', stopEvidence: stop } },
    sourceReadOnly: true,
    authority: { projectId: request.projectId, featureId: request.featureId, taskId: workIdentity.taskId,
      taskStatus: 'unfinished', previousAttemptId: workSource.sourceAttemptId, previousSessionId: workSource.sourceSessionId },
    writer: { purpose: 'work', attemptId: workIdentity.attemptId, invocationId: request.invocationId,
      sessionId: request.sessionId, executionVersion: request.executionVersion, owner: request.owner, exclusive: true },
    assertCurrent: async () => {},
    readVerifiedArtifact: async ref => {
      if (ref.artifactId === 'archive-old') {
        if (options.archiveBytes === null) throw new Error('artifact_not_found');
        return served;
      }
      if (ref.artifactId === 'stop-old') return stopBytes;
      throw new Error(`unexpected artifact: ${ref.artifactId}`);
    },
    release: async () => {},
  };
  return value;
}

/** 公共 Core 恢复服务夹具：内存制品 + 来源读取器（带调用计数）。 */
function publicService() {
  const grantDigest = computeExecutionPermissionsDigest(['repo.read']);
  const put = (id: string, bytes: Uint8Array, kind: string, mediaType: string) =>
    ({ ref: artifact('project-1', id, bytes, kind, mediaType), record: {
      id, projectId: 'project-1', kind, mediaType, status: 'ready' as const, expectedHash: digest(bytes),
      contentHash: digest(bytes), sizeBytes: bytes.byteLength, locator: `sessions/${id}`, version: 1,
      failureReason: null, revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1 } });
  const contents = new Map<string, Uint8Array>();
  const records = new Map<string, ReturnType<typeof put>['record']>();
  const add = (entry: ReturnType<typeof put>, bytes: Uint8Array) => { contents.set(entry.ref.artifactId, bytes); records.set(entry.ref.artifactId, entry.record); };
  const snapshotBytes = Buffer.from(JSON.stringify({ snapshot: true }));
  const snapshot = { ref: { ...artifact('project-1', 'snapshot', snapshotBytes, 'execution-input', 'application/json'), purpose: 'snapshot' as const },
    record: { id: 'snapshot', projectId: 'project-1', kind: 'execution-input', mediaType: 'application/json', status: 'ready' as const,
      expectedHash: digest(snapshotBytes), contentHash: digest(snapshotBytes), sizeBytes: snapshotBytes.byteLength,
      locator: 'sessions/snapshot', version: 1, failureReason: null, revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1 } };
  add(snapshot, snapshotBytes);
  const archiveBytes = Buffer.from('{"native":"placeholder"}');
  let archiveEntry = put('archive-old', archiveBytes, 'runtime-native-archive', 'application/x-ndjson');
  add(archiveEntry, archiveBytes);
  const checkpointEntry = put('checkpoint-old', archiveBytes, 'runtime-checkpoint', 'application/x-ndjson');
  add(checkpointEntry, archiveBytes);
  const stopEntry = put('stop-old', Buffer.from('{"stopped":true}'), 'recovery-stop', 'application/json');
  add(stopEntry, Buffer.from('{"stopped":true}'));
  const workAccess = {
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    authentication: { status: 'ready', digest: 'a'.repeat(64), sourceRef: 'credential-1', kind: 'environment' },
    resources: { digest: 'a'.repeat(64), entries: [{ id: 'tool-1', kind: 'tool', sourceRef: 'tool-source', version: '1',
      contentDigest: null, status: 'available', capabilities: ['read'], transport: null }] },
  };
  let sourceReference = recoverySource(archiveBytes, 'native:session/1');
  const current = { inputSnapshot: snapshot.ref, codeDigest: 'a'.repeat(64), permissions: { grants: ['repo.read'] }, workAccess };
  const evidenceFor = (source: RuntimeRecoveryReference) => put('evidence', Buffer.from(JSON.stringify({
    schemaVersion: 1, source, inputSnapshot: snapshot.ref, archive: archiveEntry.ref,
    ...(source.kind === 'checkpoint' ? { checkpoint: checkpointEntry.ref } : {}),
    codeDigest: 'a'.repeat(64), permissionsDigest: grantDigest, workAccess,
  })), 'runtime-recovery-evidence', 'application/json');
  let evidenceEntry = evidenceFor(sourceReference);
  add(evidenceEntry, Buffer.from(JSON.stringify({})));
  const refreshEvidence = () => {
    records.delete('evidence'); contents.delete('evidence');
    evidenceEntry = evidenceFor(sourceReference);
    const bytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, source: sourceReference, inputSnapshot: snapshot.ref, archive: archiveEntry.ref,
      ...(sourceReference.kind === 'checkpoint' ? { checkpoint: checkpointEntry.ref } : {}),
      codeDigest: 'a'.repeat(64), permissionsDigest: grantDigest, workAccess,
    }));
    add(evidenceEntry, bytes);
  };
  refreshEvidence();
  let readCurrentCalls = 0;
  let foreignEvidence = false;
  const service = createRuntimeRecoveryService({
    configuration: { resolve: (runtimeId: string) => runtimeId === 'pi'
      ? { runtimeId, providers: [{ providerId: 'anthropic' }] } : undefined } as never,
    capabilities: { resolve: (runtimeId: string) => runtimeId === 'pi' ? PI_RUNTIME_RECOVERY_CAPABILITIES : undefined } as never,
    sources: {
      readCurrent: () => { readCurrentCalls += 1; return current; },
      readSource: () => ({ evidence: foreignEvidence
        ? { ...evidenceEntry.ref, projectId: 'project-2' }
        : evidenceEntry.ref, stopped: 'confirmed', stopEvidence: stopEntry.ref }),
    },
    artifacts: { getArtifact: async (_projectId: string, id: string) => {
      const record = records.get(id);
      if (record === undefined) throw Object.assign(new Error('artifact_not_found'), { kind: 'not_found' });
      return record;
    } } as never,
    verifier: { readVerifiedContent: async (projectId: string, id: string) => {
      const record = records.get(id);
      if (record === undefined) throw Object.assign(new Error('artifact_not_found'), { kind: 'not_found' });
      return { ...record, projectId, artifactId: id, content: contents.get(id)! };
    } } as never,
  });
  const observe = () => observeP07Memory({ artifact: { artifacts: [...contents].map(([id, bytes]) => ({
    projectId: 'project-1', artifactId: id, kind: records.get(id)!.kind, contentHash: digest(bytes), sizeBytes: bytes.length,
  })) } });
  return { service, observe, readCurrentCalls: () => readCurrentCalls, setArchive: (bytes: Uint8Array) => {
    records.delete('archive-old'); contents.delete('archive-old');
    archiveEntry = put('archive-old', bytes, 'runtime-native-archive', 'application/x-ndjson');
    add(archiveEntry, bytes);
    sourceReference = recoverySource(bytes, 'native:session/1');
    refreshEvidence();
  }, dropEvidence: () => { records.delete('evidence'); contents.delete('evidence'); },
  useForeignEvidence: () => { foreignEvidence = true; },
    conversationSource: () => sourceReference,
    checkpointSource: () => { sourceReference = { ...recoverySource(archiveBytes, 'native:session/1'), kind: 'checkpoint' as const, checkpointRef: 'checkpoint-old' }; refreshEvidence(); return sourceReference; } };
}

describe('P07-5 F-006 standard Pi native archive boundary', () => {
  it('[case:p07-f006-genuine-jsonl-admission] 真实标准 JSONL 免模型验证通过且来源不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-jsonl-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const source = recoverySource(genuine.bytes, genuine.sessionId);
    const prepared = await preparePiRecovery(executionRequest(source), source, controlledLease(source, genuine.bytes));
    const entries = new TextDecoder().decode(genuine.bytes).trim().split('\n').map(line => JSON.parse(line) as { id?: string });
    expect(prepared.nativeWatermark).toEqual({ entryCount: entries.length - 1, lastEntryId: entries.at(-1)!.id });
    expect(Buffer.from(prepared.archive).equals(genuine.bytes)).toBe(true);
    /* 本地事实只含原生水位与身份摘要，不包含 Core 结算声明。 */
    expect(Object.keys(prepared).sort()).toEqual(['archive', 'assertCurrent', 'nativeWatermark', 'reference']);
    expect(prepared.reference).toMatchObject({ providerSessionId: genuine.sessionId, sourceDigest: digest(genuine.bytes) });
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it('[case:p07-f006-source-missing] 来源缺失明确拒绝且不触碰来源文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-missing-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const source = recoverySource(genuine.bytes, genuine.sessionId);
    /* adapter：制品读取器返回来源缺失。 */
    await expect(preparePiRecovery(executionRequest(source), source,
      controlledLease(source, genuine.bytes, { archiveBytes: null }))).rejects.toThrow('artifact_not_found');
    /* 公共 Core 服务：来源证据制品缺失。 */
    const f = publicService();
    f.dropEvidence();
    await expect(f.service.evaluate(recoveryServiceRequest(recoverySource(Buffer.from('x'), 'native:session/1'))))
      .rejects.toThrow();
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it.each([
    ['truncated-tail', (bytes: Uint8Array) => bytes.slice(0, Math.max(1, bytes.byteLength - 8))],
    ['broken-json', () => new TextEncoder().encode('{broken json\n')],
    ['empty-body', () => new Uint8Array(0)],
  ])('[case:p07-f006-body-corrupt-%s] 正文损坏拒绝且来源保持不变', async (_id, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-corrupt-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const corrupted = mutate(genuine.bytes);
    /* 登记摘要与制品服务方一致（自洽），但正文本身损坏。 */
    const source = recoverySource(corrupted, genuine.sessionId);
    await expect(preparePiRecovery(executionRequest(source), source,
      controlledLease(source, genuine.bytes, { archiveBytes: corrupted })))
      .rejects.toMatchObject({ reason: corrupted.byteLength === 0 ? 'native_archive_size_invalid' : 'native_archive_corrupt' });
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it('[case:p07-f006-digest-mismatch] 摘要不匹配在两层入口均拒绝且来源保持不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-digest-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    /* 准入层：引用摘要与租约制品身份不符 → 来源档案身份不匹配。 */
    const source = recoveryReferenceWithDigest(genuine, digest(new TextEncoder().encode('other content')));
    await expect(preparePiRecovery(executionRequest(source), source, controlledLease(source, genuine.bytes)))
      .rejects.toMatchObject({ reason: 'source_archive_identity_mismatch' });
    /* 验证层：制品内部自洽但与恢复引用声明的 sourceDigest 不符 → 正文摘要不匹配，不产生水位事实。 */
    expect(() => validatePiNativeArchive({ archive: genuine.bytes,
      reference: { providerSessionId: genuine.sessionId, sourceDigest: 'b'.repeat(64) }, assertCurrent: async () => {} }))
      .toThrowError(expect.objectContaining({ reason: 'native_archive_digest_mismatch' }));
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it.each([
    ['reference-format', (root: string, genuine: Awaited<ReturnType<typeof genuineArchive>>) => {
      const source = { ...recoverySource(genuine.bytes, genuine.sessionId), nativeFormatVersion: '9' };
      return { source, lease: controlledLease(source, genuine.bytes), reason: 'native_format_incompatible' };
    }],
    ['sdk-mismatch', (root: string, genuine: Awaited<ReturnType<typeof genuineArchive>>) => {
      const source = recoverySource(genuine.bytes, genuine.sessionId);
      return { source, lease: controlledLease(source, genuine.bytes, { sdkVersion: '0.0.0' }), reason: 'native_format_incompatible' };
    }],
  ])('[case:p07-f006-unknown-format-%s] 未知格式/版本拒绝', async (_id, build) => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-format-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const { source, lease, reason } = build(root, genuine);
    await expect(preparePiRecovery(executionRequest(source), source, lease)).rejects.toMatchObject({ reason });
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it('[case:p07-f006-unknown-format-header] 正文 header 未知版本拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-header-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const lines = new TextDecoder().decode(genuine.bytes).trim().split('\n');
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    const rebuilt = new TextEncoder().encode([JSON.stringify({ ...header, version: 9 }), ...lines.slice(1)].join('\n'));
    const source = recoverySource(rebuilt, genuine.sessionId);
    await expect(preparePiRecovery(executionRequest(source), source, controlledLease(source, rebuilt)))
      .rejects.toMatchObject({ reason: 'native_format_incompatible' });
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it.each([
    ['cross-project', { sourceProjectId: 'project-other' }],
    ['cross-purpose', { purpose: 'chat', sourceTurnId: 'turn-1' }],
    ['cross-task', { sourceTaskId: 'task-other' }],
  ])('[case:p07-f006-cross-%s] 越界引用拒绝', async (_id, patch) => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-cross-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const source = recoverySource(genuine.bytes, genuine.sessionId, patch as Partial<RuntimeRecoveryReference>);
    await expect(preparePiRecovery(executionRequest(source), source, controlledLease(source, genuine.bytes)))
      .rejects.toMatchObject({ reason: 'source_identity_mismatch' });
    expect(new Uint8Array(await readFile(genuine.file))).toEqual(genuine.bytes);
  });

  it('[case:p07-f006-cross-project-core] 公共服务拒绝跨项目来源证据', async () => {
    const f = publicService();
    f.useForeignEvidence();
    await expect(f.service.evaluate(recoveryServiceRequest(recoverySource(Buffer.from('{"native":"placeholder"}'), 'native:session/1'))))
      .rejects.toMatchObject({ details: expect.objectContaining({ reason: 'source_project_mismatch', field: 'ref.projectId' }) });
    f.observe();
  });

  it('[case:p07-f006-declared-mode-matrix] auto/new/required 声明行为：降级如实、unsupported 不冒充', async () => {
    const f = publicService();
    const placeholder = Buffer.from('{"native":"placeholder"}');
    const conversation = recoverySource(placeholder, 'native:session/1');
    /* 生产能力目录：恢复相关能力保持 unsupported，不因本测试宣称支持。 */
    for (const name of ['conversationResume', 'executionRecovery', 'nativeFork'] as const) {
      expect(PI_RUNTIME_RECOVERY_CAPABILITIES.capabilities[name]).toMatchObject({ status: 'unsupported' });
    }
    /* required：明确拒绝，不静默新建。 */
    await expect(f.service.evaluate(recoveryServiceRequest(conversation, 'required')))
      .resolves.toEqual({ mode: 'rejected', reasons: ['conversationResume:unsupported', 'nativeFork:unsupported'] });
    /* auto：仅按获准政策新建（降级），并保留来源核对过程。 */
    const before = f.readCurrentCalls();
    await expect(f.service.evaluate(recoveryServiceRequest(conversation, 'auto')))
      .resolves.toEqual({ mode: 'new', reasons: ['conversationResume:unsupported', 'nativeFork:unsupported'] });
    expect(f.readCurrentCalls()).toBeGreaterThan(before);
    /* checkpoint：executionRecovery 未支持，required 拒绝、auto 降级。 */
    const checkpoint = f.checkpointSource();
    await expect(f.service.evaluate(recoveryServiceRequest(checkpoint, 'required', 'checkpoint')))
      .resolves.toEqual({ mode: 'rejected', reasons: ['executionRecovery:unsupported', 'nativeFork:unsupported'] });
    await expect(f.service.evaluate(recoveryServiceRequest(checkpoint, 'auto', 'checkpoint')))
      .resolves.toEqual({ mode: 'new', reasons: ['executionRecovery:unsupported', 'nativeFork:unsupported'] });
    /* new：不读取任何来源。 */
    const beforeNew = f.readCurrentCalls();
    await expect(f.service.evaluate(recoveryServiceRequest(conversation, 'new')))
      .resolves.toEqual({ mode: 'new', reasons: ['explicit_new'] });
    expect(f.readCurrentCalls()).toBe(beforeNew);
    /* auto 降级作为观察事实进入恢复录制：decision 如实记录 new+原因，不冒充成功恢复。 */
    const downgrade = { schemaVersion: 1 as const, requestedMode: 'auto' as const, source: conversation,
      decision: { mode: 'new' as const, reasons: ['conversationResume:unsupported', 'nativeFork:unsupported'] },
      sourceWatermark: null, nativeSourceWatermark: null, sourceGaps: [], sourceSdkVersion: null, sdkVersion: null,
      nativeFormat: null, nativeFormatVersion: null, providerSessionId: null, actualProvider: null, actualModel: null,
      historicalUsage: 'excluded_unknown_scope' as const, newEvents: { firstSequence: 1 as const, scope: 'current_invocation' as const },
      coverage: 'partial' as const, gaps: [] };
    const recorded = recoveryRecordingForRequest(executionRequest(conversation, 'auto'), downgrade)!;
    expect(recorded.decision).toEqual(downgrade.decision);
    expect(recorded.coverage).toBe('partial');
    f.observe();
    expect(recorded.gaps).toContain('source_watermark_unknown');
    expect(recorded.historicalUsage).toBe('excluded_unknown_scope');
  });

  it('[case:p07-f006-evidence-separation] 公开闭环与 adapter 本地验证分开留证，live 保持 not_run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-sep-'));
    roots.push(root);
    const genuine = await genuineArchive(root);
    const source = recoverySource(genuine.bytes, genuine.sessionId);

    /* adapter 本地验证：仅原生水位与身份摘要，无 Core 结算字段。 */
    const prepared = await preparePiRecovery(executionRequest(source), source, controlledLease(source, genuine.bytes));
    const localFacts = JSON.stringify(prepared, (_key, value: unknown) => typeof value === 'function' ? undefined : value);
    for (const forbidden of ['mode', 'settlement', 'passed', 'attempt']) expect(localFacts).not.toContain(`"${forbidden}"`);

    /* 公开恢复闭环：决策对象仅含 mode/kind/reasons，不含原生水位。 */
    const f = publicService();
    const publicSource = f.conversationSource();
    const decision = await f.service.evaluate(recoveryServiceRequest(publicSource));
    const decisionText = JSON.stringify(decision);
    expect(decision.mode).toBe('rejected');
    for (const forbidden of ['entryCount', 'lastEntryId', 'watermark']) expect(decisionText).not.toContain(forbidden);

    /* 录制把两类事实按字段来源绑定：Core 持久水位与 adapter 原生水位不混用。 */
    const observed = { schemaVersion: 1 as const, requestedMode: 'required' as const, source: publicSource,
      decision: { mode: 'rejected' as const, reasons: ['conversationResume:unsupported'] },
      sourceWatermark: null, nativeSourceWatermark: prepared.nativeWatermark, sourceGaps: [],
      sourceSdkVersion: PI_SDK_VERSION, sdkVersion: PI_SDK_VERSION,
      nativeFormat: PI_NATIVE_SESSION_FORMAT, nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION,
      providerSessionId: genuine.sessionId, actualProvider: 'anthropic', actualModel: 'claude-sonnet-4-5',
      historicalUsage: 'excluded_unknown_scope' as const,
      newEvents: { firstSequence: 1 as const, scope: 'current_invocation' as const },
      coverage: 'partial' as const, gaps: [] };
    const sessions = { getWorkSession: (projectId: string, sessionId: string) => {
      if (projectId === 'project-1' && sessionId === 'session-old') {
        return { attemptId: 'attempt-old', kind: 'work' as const, recordingWatermark: 19, recordingGaps: ['missing_sequences:3-4'] };
      }
      throw new Error('session_not_registered');
    } } as unknown as Parameters<typeof recoveryRecordingForRequest>[2];
    const recording = recoveryRecordingForRequest(executionRequest(publicSource), observed, sessions)!;
    expect(recording.sourceWatermark).toBe(19);
    expect(recording.nativeSourceWatermark).toEqual(prepared.nativeWatermark);
    expect(recording.sourceGaps).toEqual(['missing_sequences:3-4']);
    expect(recording.historicalUsage).toBe('excluded_unknown_scope');

    /* Recorder 水位缺失（来源会话未登记）时不虚构基线，只记缺口。 */
    const missing = recoveryRecordingForRequest(executionRequest(publicSource), observed,
      { getWorkSession: () => { throw new Error('session_not_registered'); } } as unknown as Parameters<typeof recoveryRecordingForRequest>[2])!;
    expect(missing.sourceWatermark).toBeNull();
    expect(missing.gaps).toContain('source_watermark_unknown');

    /* live 真实模型续聊未执行：能力保持 unsupported，不因离线证据宣称生产恢复。 */
    expect(PI_RUNTIME_RECOVERY_CAPABILITIES.capabilities.conversationResume.status).toBe('unsupported');
    saveBoundaryEvidence({ liveModelContinuation: 'not_run', durableCandidate: 'not_used', decision, nativeWatermark: prepared.nativeWatermark });
  });
});

function recoveryReferenceWithDigest(genuine: { bytes: Uint8Array; sessionId: string }, sourceDigest: string): RuntimeRecoveryReference {
  return { ...recoverySource(genuine.bytes, genuine.sessionId), sourceDigest };
}

/** 环境显式提供证据目录时导出（默认不向仓库工作树写入；与 F-005 证据导出同一纪律）。 */
function saveBoundaryEvidence(payload: Record<string, unknown>): void {
  const root = process.env.SHIPLOOP_P07_EVIDENCE_DIR;
  if (root === undefined || root === '') return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'f006-native-boundary.json'),
    `${JSON.stringify({ schemaVersion: 1, kind: 'p07-5-f006-scenario', scenario: 'native-boundary', ...payload }, null, 2)}\n`, 'utf8');
}
