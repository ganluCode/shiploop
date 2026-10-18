/**
 * P03-9 / F-007 同 Task 通用续接决策与来源快照。
 *
 * 聚焦验收：
 * - 候选只允许同 Task 直接上一 Attempt；来源 Attempt/Session/归档/检查点身份
 *   必须一致，旧执行停止与工作区占用是 auto/new/required 的共同前提；
 * - Fake 不具备原生续接能力时 auto 显式新建并记录降级原因，new 明确新建，
 *   required 明确拒绝且不发布可执行记录/不启动 Runtime；
 * - 新 Attempt 的不可变输入固定请求模式、实际决策、原因、来源 Attempt/Session、
 *   当前完整策略、工作区与必需输入引用；旧输入/来源档案字节不变；
 * - 安全的新 Session 只携带精简交接与引用，不内联完整历史、不重置预算。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorkRecoveryContinuationService } from '../../../packages/core/src/application/work-recovery-continuation.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import {
  isWorkRecoveryContinuationError,
  validateWorkRecoveryContinuationRecord,
} from '../../../packages/core/src/ports/work-recovery-continuation.ts';
import type {
  WorkRecoveryContinuationRecord,
  WorkRecoveryContinuationRequest,
} from '../../../packages/core/src/ports/work-recovery-continuation.ts';
import { validateAttemptInputSnapshot } from '../../../packages/core/src/ports/attempt-store.ts';
import type { AttemptRecord, WorkspaceLeaseRecord } from '../../../packages/core/src/ports/attempt-store.ts';
import type { ArtifactRecord } from '../../../packages/core/src/ports/artifact-store.ts';
import type { ExecutionInputRef } from '../../../packages/core/src/ports/execution-input.ts';

const projectId = 'proj-1';
const featureId = 'feat-1';
const taskId = 'task-1';
const runId = 'run-1';
const archiveBody = '{"native":"synthetic history"}';
const archiveHash = sha256(archiveBody);
const codeDigest = 'c'.repeat(64);
const headCommit = 'b'.repeat(40);
const nowMs = 1_950_000_000_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Harness {
  readonly service: ReturnType<typeof createWorkRecoveryContinuationService>;
  readonly serviceWith: (descriptor: Record<string, unknown>) => ReturnType<typeof createWorkRecoveryContinuationService>;
  readonly store: MemoryArtifacts;
  readonly current: ExecutionInputRef;
  readonly candidate: AttemptRecord;
  readonly source: Record<string, unknown>;
  readonly reconciliation: ExecutionInputRef;
  readonly publishCount: () => number;
  readonly request: (overrides?: Record<string, unknown>) => WorkRecoveryContinuationRequest;
  readonly setAttempts: (attempts: readonly AttemptRecord[]) => void;
  readonly setLeases: (leases: readonly WorkspaceLeaseRecord[]) => void;
  readonly setCurrentBody: (body: Record<string, unknown>) => void;
  readonly setReconciliationBody: (body: Record<string, unknown>) => void;
  readonly snapshotBody: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

class MemoryArtifacts {
  readonly records = new Map<string, ArtifactRecord>();
  readonly contents = new Map<string, Buffer>();
  private next = 1;

  add(kind: string, body: string, locator: string, purpose = kind): ExecutionInputRef {
    const content = Buffer.from(body, 'utf8');
    const id = `artifact-${this.next++}`;
    const record: ArtifactRecord = {
      id, projectId, kind, mediaType: 'application/json', status: 'ready',
      expectedHash: sha256(body), contentHash: sha256(body), sizeBytes: content.byteLength,
      locator, version: 1, failureReason: null, revision: 1,
      createdAtUtcMs: 1, updatedAtUtcMs: 1,
    };
    this.records.set(id, record);
    this.contents.set(id, content);
    return {
      projectId, artifactId: id, kind, purpose,
      version: 1, contentHash: sha256(body), sizeBytes: content.byteLength,
      locator, mediaType: 'application/json', origin: { kind: 'artifact' },
    };
  }

  async getArtifact(requestedProjectId: string, artifactId: string): Promise<ArtifactRecord> {
    const record = this.records.get(artifactId);
    if (record === undefined || record.projectId !== requestedProjectId) throw new Error('artifact_not_found');
    return record;
  }

  async readVerifiedContent(requestedProjectId: string, artifactId: string) {
    const record = await this.getArtifact(requestedProjectId, artifactId);
    const content = this.contents.get(artifactId)!;
    return {
      projectId: requestedProjectId, artifactId, contentHash: sha256(content.toString('utf8')),
      sizeBytes: content.byteLength, locator: record.locator,
      relativePath: record.locator, content: new Uint8Array(content),
    };
  }

  corrupt(artifactId: string, body: string): void {
    this.contents.set(artifactId, Buffer.from(body, 'utf8'));
  }

  replace(ref: ExecutionInputRef, body: string): void {
    const content = Buffer.from(body, 'utf8');
    const previous = this.records.get(ref.artifactId)!;
    this.records.set(ref.artifactId, {
      ...previous, contentHash: sha256(body), sizeBytes: content.byteLength, expectedHash: sha256(body),
    });
    this.contents.set(ref.artifactId, content);
  }
}

function baseSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    projectId,
    featureId,
    taskId,
    task: {
      title: 'same task',
      description: 'resume this task',
      acceptance: { criteria: ['criterion one', 'criterion two'] },
      requirementsRefs: [{ artifactId: 'req-1', contentHash: sha256('req-1') }],
      dependencies: [{ taskId: 'task-0', evidenceRefs: [{ artifactId: 'dep-1' }] }],
      executionConfig: {
        schemaVersion: 2, runtime: 'fake', provider: 'provider-a', model: 'model-a',
        maxCodeAttempts: 3, workTimeoutMs: 60_000,
      },
      configSource: 'project_default',
      configSourceKey: 'default',
    },
    meta: { labels: [] },
    checkPolicy: { digest: sha256('check-policy') },
    permissions: { grants: ['repo.read', 'repo.write'] },
    requiredInputs: [],
    historyIndex: null,
    rework: null,
    ...overrides,
  };
}

function candidateSnapshot(body = baseSnapshot()): Record<string, unknown> {
  return body;
}

function makeHarness(): Harness {
  const store = new MemoryArtifacts();
  const currentBody = JSON.parse(stableStringify(baseSnapshot())) as Record<string, unknown>;
  (currentBody.task as Record<string, unknown>).executionConfig = {
    schemaVersion: 2, runtime: 'fake', provider: 'provider-a', model: 'model-a', maxCodeAttempts: 3, workTimeoutMs: 60_000,
  };
  (currentBody as { requiredInputs: unknown[] }).requiredInputs = [{
    projectId, artifactId: 'spec-artifact', kind: 'execution-input', purpose: 'spec',
    version: 1, contentHash: sha256('spec'), sizeBytes: 4, locator: 'inputs/spec',
    mediaType: 'text/plain', origin: { kind: 'artifact' },
  }];
  let current = store.add('execution-snapshot', stableStringify(currentBody),
    'inputs/task-1/snapshot', 'snapshot');
  const archive = store.add('native-archive', archiveBody, 'native/archive.json');
  let reconciliation = store.add('work-recovery-reconciliation',
    stableStringify(reconciliationBody(archive)), 'recovery/reconciliation.json');
  const candidateBody = JSON.parse(stableStringify(currentBody)) as Record<string, unknown>;
  const candidateSnapshotRef = store.add('execution-snapshot', stableStringify(candidateBody), 'inputs/task-1/snapshot-old');
  const candidate: AttemptRecord = {
    id: 'attempt-old', createdAtUtcMs: 1, updatedAtUtcMs: 2, revision: 1,
    projectId, featureId, runId, taskId, number: 1,
    owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1, leaseUntilUtcMs: 10,
    status: 'interrupted', executionStage: 'runtime',
    inputSnapshot: {
      projectId, featureId, taskId, schemaVersion: 3,
      group: {
        snapshot: { artifactId: candidateSnapshotRef.artifactId, version: 1,
          contentHash: candidateSnapshotRef.contentHash, sizeBytes: candidateSnapshotRef.sizeBytes,
          locator: candidateSnapshotRef.locator, mediaType: candidateSnapshotRef.mediaType },
        manifest: { artifactId: 'ignored-manifest', version: 1, contentHash: '0'.repeat(64), sizeBytes: 1,
          locator: 'ignored', mediaType: 'application/json' },
        prompt: { artifactId: 'ignored-prompt', version: 1, contentHash: '0'.repeat(64), sizeBytes: 1,
          locator: 'ignored', mediaType: 'text/plain' },
      },
      requiredInputs: [],
      digests: { snapshotDigest: candidateSnapshotRef.contentHash, manifestDigest: '1'.repeat(64),
        promptDigest: '2'.repeat(64), strategyCopyDigest: '3'.repeat(64), permissionsDigest: '4'.repeat(64) },
      approval: { planDigest: '5'.repeat(64), checkPolicyDigest: '6'.repeat(64), decisionId: null, featureRevision: 1 },
      taskRevision: 1, promptBytes: 10, tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' },
      preparedAtUtcMs: 1,
    },
    inputDigest: candidateSnapshotRef.contentHash, inputRef: candidateSnapshotRef.artifactId,
    sessionId: 'session-old', invocationId: 'invocation-old', codeRef: 'code-artifact',
    errorKind: 'runtime_error', diagnosticRef: 'diagnostic-artifact',
    startedAtUtcMs: 1, endedAtUtcMs: 100, durationMs: 99, exitCode: null, usageSummary: null,
  };
  let attempts: readonly AttemptRecord[] = [candidate];
  let leases: readonly WorkspaceLeaseRecord[] = [];
  let publishCount = 0;
  const publishImpl = async (input: unknown) => {
    publishCount += 1;
    const value = input as { projectId: string; kind: string; mediaType: string; expectedHash: string;
      locator: string; content: readonly Uint8Array[] };
    const body = Buffer.concat(value.content.map((part) => Buffer.from(part))).toString('utf8');
    const ref = store.add(value.kind, body, value.locator);
    return { artifact: store.records.get(ref.artifactId)!, finalRelativePath: ref.locator };
  };
  const serviceWith = (descriptor: Record<string, unknown>) => createWorkRecoveryContinuationService({
    attempts: {
      listTaskAttempts: () => attempts,
      listWorkspaceLeases: () => leases,
    },
    artifacts: store,
    verifier: store,
    publisher: { publishArtifact: publishImpl },
    recoveryCatalog: {
      resolve: (runtimeId) => runtimeId === 'fake' ? descriptor as never : undefined,
    },
    nowMs: () => nowMs,
  });
  const service = serviceWith(capabilities('verified'));
  const source = {
    schemaVersion: 1, purpose: 'work', kind: 'conversation',
    sourceProjectId: projectId, sourceSessionId: 'session-old',
    sourceTaskId: taskId, sourceAttemptId: 'attempt-old',
    runtime: 'fake', provider: 'provider-a', model: 'model-a',
    providerSessionId: 'native-session-1', nativeArchiveRef: archive.artifactId,
    nativeFormat: 'synthetic-json', nativeFormatVersion: '1', sourceDigest: archiveHash,
  };
  return {
    service, serviceWith, store, current, candidate, source, reconciliation,
    publishCount: () => publishCount,
    request(overrides = {}) {
      return {
        schemaVersion: 1, projectId, featureId, taskId,
        next: {
          attemptId: 'attempt-new', sessionId: 'session-new',
          invocationId: 'invocation-new', executionVersion: 2,
        },
        selection: { mode: 'auto', kind: 'conversation', source: structuredClone(source) },
        strategy: { runtime: 'fake', provider: 'provider-a', model: 'model-a' },
        taskRevision: 1,
        currentInputSnapshot: current,
        reconciliationEvidence: reconciliation,
        workspace: {
          workspaceId: 'ws-1', repositoryIdentity: 'repo-1', branch: 'main',
          headCommit, codeDigest,
        },
        ...overrides,
      } as WorkRecoveryContinuationRequest;
    },
    setAttempts(value) { attempts = value; },
    setLeases(value) { leases = value; },
    setCurrentBody(body) {
      current = store.add('execution-snapshot', stableStringify(body),
        'inputs/task-1/snapshot', 'snapshot');
    },
    setReconciliationBody(body) {
      reconciliation = store.add('work-recovery-reconciliation', stableStringify(body),
        'recovery/reconciliation.json');
    },
    snapshotBody: baseSnapshot,
  };
}

function reconciliationBody(archive: ExecutionInputRef, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, kind: 'work-recovery-reconciliation',
    projectId, featureId, runId, taskId, attemptId: 'attempt-old',
    owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
    status: 'reconciled', gaps: [], startupGaps: [],
    workspace: {
      id: 'ws-1', status: 'retained', canonicalPath: '/workspace', repoIdentity: 'repo-1',
      branch: 'main', baseCommit: 'a'.repeat(40), headCommit, codeDigest,
      registrationDigest: 'd'.repeat(64), trackedCount: 1, untrackedCount: 0, ignoredCount: 0,
      retainedTrackedCount: 1, retainedUntrackedCount: 0, locks: [],
    },
    recording: { sessionId: 'session-old', status: 'stopped', watermark: 7, gaps: [], artifactsChecked: 3 },
    native: {
      sessionStorageKind: 'json', sessionFormatVersion: '1',
      sourceArchiveRef: archive.artifactId, sourceDigest: archiveHash,
      sourceVerified: true, singleWriter: 'confirmed_stopped', opened: false,
    },
    gitOperations: [], taskPassed: false, newAttemptCreated: false, observedAtUtcMs: 1,
    ...overrides,
  };
}

function capabilities(status: 'verified' | 'unsupported' = 'verified') {
  const evidence = status === 'verified'
    ? { status, evidenceRef: 'capability-evidence', limits: [] }
    : { status, limits: [] };
  return {
    schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0.0', sdkVersion: null,
    nativeFormats: [{ format: 'synthetic-json', versions: ['1'] }], limits: [],
    capabilities: {
      nativeHistory: evidence, conversationResume: evidence, executionRecovery: evidence,
      modelSwitchOnResume: evidence, nativeFork: evidence,
    },
  };
}

function expectFailure(error: unknown, reason: string): void {
  expect(isWorkRecoveryContinuationError(error, reason as never), `应为 ${reason}: ${String(error)}`).toBe(true);
}

describe('P03-9 / F-007 同 Task 续接决策与来源快照', () => {
  it('Fake 无原生续接能力时 auto 新建并持久记录降级原因，旧档案/输入不变', async () => {
    const h = makeHarness();
    const recordBefore = stableStringify([...h.store.records.values()]);
    const archiveBefore = h.store.contents.get(h.source.nativeArchiveRef as string)!.toString('utf8');
    const service = h.serviceWith(capabilities('unsupported'));
    const result = await service.plan(h.request());
    expect(result.record.decision).toMatchObject({ mode: 'new' });
    expect(result.record.decision.reasons).toEqual(expect.arrayContaining([
      'conversationResume:unsupported', 'nativeFork:unsupported',
    ]));
    expect(result.record.sourceAttemptId).toBe('attempt-old');
    expect(result.record.sourceSessionId).toBe('session-old');
    expect(result.record.policy.executionConfig).toMatchObject({ provider: 'provider-a', model: 'model-a' });
    expect(result.record.requiredInputs.map((ref) => ref.artifactId))
      .toEqual(expect.arrayContaining([h.reconciliation.artifactId, h.source.nativeArchiveRef]));
    expect(result.record.handoff).toMatchObject({
      previousAttemptId: 'attempt-old', previousStatus: 'interrupted',
      note: expect.stringContaining('compact same-task handoff'),
    });
    expect(h.store.contents.get(h.source.nativeArchiveRef as string)!.toString('utf8')).toBe(archiveBefore);
    expect(stableStringify([...h.store.records.values()].filter((record) => record.id !== result.evidenceRef.artifactId)))
      .toBe(recordBefore);
    const published = JSON.parse(h.store.contents.get(result.evidenceRef.artifactId)!.toString('utf8'));
    expect(published).toEqual(result.record);
    expect(validateWorkRecoveryContinuationRecord(published).decision.mode).toBe('new');
  });

  it('new 明确新建（即使存在直接上一 Attempt），safe 新 Session 带精简交接与引用', async () => {
    const h = makeHarness();
    const result = await h.service.plan(h.request({ selection: { mode: 'new' } }));
    expect(result.record.decision).toEqual({ mode: 'new', reasons: ['explicit_new'] });
    expect(result.record.source).toBeNull();
    expect(result.record.sourceAttemptId).toBeNull();
    expect(result.record.handoff!.requiredInputRefs.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.record.handoff)).not.toContain('synthetic history');
  });

  it('required 在 Fake 不支持时明确拒绝，且不发布可执行记录、不启动 Runtime', async () => {
    const h = makeHarness();
    const service = h.serviceWith(capabilities('unsupported'));
    const request = h.request({
      selection: { mode: 'required', kind: 'conversation', source: h.source },
    });
    await expect(service.plan(request)).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'capability_unsupported'));
    expect(h.publishCount()).toBe(0);
  });

  it('required 能力 verified 时允许 resume；模型变化缺少 modelSwitchOnResume 时 required 拒绝、auto 新建', async () => {
    const h = makeHarness();
    const verified = capabilities('verified');
    verified.capabilities = { ...verified.capabilities, modelSwitchOnResume: { status: 'unsupported', limits: [] } };
    const service = h.serviceWith(verified);
    const source = { ...h.source, model: 'model-a' };
    const currentBody = JSON.parse(h.store.contents.get(h.current.artifactId)!.toString('utf8')) as Record<string, unknown>;
    (currentBody.task as Record<string, unknown>).executionConfig = {
      schemaVersion: 2, runtime: 'fake', provider: 'provider-a', model: 'model-b',
      maxCodeAttempts: 3, workTimeoutMs: 60_000,
    };
    h.setCurrentBody(currentBody);
    const strategy = { runtime: 'fake', provider: 'provider-a', model: 'model-b' };
    await expect(service.plan(h.request({
      selection: { mode: 'required', kind: 'conversation', source }, strategy,
    }))).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'capability_unsupported'));
    const auto = await service.plan(h.request({
      selection: { mode: 'auto', kind: 'conversation', source }, strategy,
    }));
    expect(auto.record.decision.mode).toBe('new');
    expect(auto.record.decision.reasons).toEqual(expect.arrayContaining(['modelSwitchOnResume:unsupported']));
  });

  it('来源不是同 Task 直接上一 Attempt 时拒绝', async () => {
    const h = makeHarness();
    const newerReconciliation = h.store.add('work-recovery-reconciliation',
      stableStringify({
        ...reconciliationBody({ artifactId: h.source.nativeArchiveRef as string, contentHash: archiveHash } as ExecutionInputRef),
        attemptId: 'attempt-newer',
      }), 'recovery/newer.json');
    const service = createWorkRecoveryContinuationService({
      attempts: {
        listTaskAttempts: () => [h.candidate,
          { ...h.candidate, id: 'attempt-newer', number: 2, sessionId: 'session-newer' }],
        listWorkspaceLeases: () => [],
      },
      artifacts: h.store, verifier: h.store,
      publisher: { publishArtifact: async (input: unknown) => {
        const value = input as { kind: string; locator: string; content: readonly Uint8Array[] };
        const body = Buffer.concat(value.content.map((part) => Buffer.from(part))).toString('utf8');
        const ref = h.store.add(value.kind, body, value.locator);
        return { artifact: h.store.records.get(ref.artifactId)!, finalRelativePath: ref.locator };
      } },
      recoveryCatalog: { resolve: () => capabilities('verified') as never },
      nowMs: () => nowMs,
    });
    await expect(service.plan(h.request({ reconciliationEvidence: newerReconciliation }))).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'candidate_identity_mismatch'));
  });

  it('任务输入变化：auto 新建并记录 input:changed，required 明确拒绝', async () => {
    const h = makeHarness();
    const changed = baseSnapshot();
    (changed.task as Record<string, unknown>).acceptance = { criteria: ['changed criterion'] };
    const changedRef = h.store.add('execution-snapshot', stableStringify(changed), 'inputs/task-1/snapshot-changed');
    h.setAttempts([{
      ...h.candidate,
      inputSnapshot: {
        ...h.candidate.inputSnapshot,
        group: {
          ...h.candidate.inputSnapshot.group,
          snapshot: { artifactId: changedRef.artifactId, version: changedRef.version,
            contentHash: changedRef.contentHash, sizeBytes: changedRef.sizeBytes,
            locator: changedRef.locator, mediaType: changedRef.mediaType },
        },
      },
    }]);
    const auto = await h.service.plan(h.request());
    expect(auto.record.decision.mode).toBe('new');
    expect(auto.record.decision.reasons).toContain('input:changed');
    await expect(h.service.plan(h.request({
      selection: { mode: 'required', kind: 'conversation', source: h.source },
    }))).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'input_changed'));
  });

  it('当前策略变化：仅模型变化交给能力判断，其他策略变化 auto 新建、required 拒绝', async () => {
    const h = makeHarness();
    const changed = JSON.parse(h.store.contents.get(h.current.artifactId)!.toString('utf8')) as Record<string, unknown>;
    (changed.task as Record<string, unknown>).executionConfig = {
      schemaVersion: 2, runtime: 'fake', provider: 'provider-a', model: 'model-a',
      maxCodeAttempts: 9, workTimeoutMs: 60_000,
    };
    const changedRef = h.store.add('execution-snapshot', stableStringify(changed), 'inputs/task-1/snapshot-policy');
    h.setAttempts([{
      ...h.candidate,
      inputSnapshot: {
        ...h.candidate.inputSnapshot,
        group: {
          ...h.candidate.inputSnapshot.group,
          snapshot: { artifactId: changedRef.artifactId, version: changedRef.version,
            contentHash: changedRef.contentHash, sizeBytes: changedRef.sizeBytes,
            locator: changedRef.locator, mediaType: changedRef.mediaType },
        },
      },
    }]);
    const auto = await h.service.plan(h.request());
    expect(auto.record.decision.mode).toBe('new');
    expect(auto.record.decision.reasons).toContain('policy:changed');
    await expect(h.service.plan(h.request({
      selection: { mode: 'required', kind: 'conversation', source: h.source },
    }))).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'policy_changed'));
  });

  it('旧占用未释放、恢复现场有缺口或来源损坏时先暂停（三个模式均不绕过）', async () => {
    const h = makeHarness();
    h.setLeases([{
      id: 'lease-1', createdAtUtcMs: 1, updatedAtUtcMs: 1, revision: 1, projectId,
      resourceKey: 'workspace:ws-1', resourceKind: 'workspace', ownerKind: 'attempt',
      owner: 'attempt-old', hostInstanceId: 'host-1', executionVersion: 1,
      state: 'quarantined', leaseUntilUtcMs: 10, processIdentity: null,
    }]);
    for (const selection of [{ mode: 'new' }, { mode: 'auto', kind: 'conversation', source: h.source }]) {
      await expect(h.service.plan(h.request({ selection }))).rejects.toSatisfy((error: unknown) =>
        isWorkRecoveryContinuationError(error, 'occupancy_unresolved'));
    }
    await expect(h.service.plan(h.request({
      selection: { mode: 'required', kind: 'conversation', source: h.source },
    }))).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'occupancy_unresolved'));

    h.setLeases([]);
    h.setReconciliationBody(reconciliationBody(
      { artifactId: h.source.nativeArchiveRef, contentHash: archiveHash } as ExecutionInputRef,
      { status: 'quarantined', gaps: ['stop_unconfirmed'] },
    ));
    await expect(h.service.plan(h.request())).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'reconciliation_unsafe'));

    h.setReconciliationBody(reconciliationBody(
      { artifactId: h.source.nativeArchiveRef, contentHash: archiveHash } as ExecutionInputRef,
    ));
    h.store.corrupt(h.source.nativeArchiveRef as string, archiveBody + 'tampered');
    await expect(h.service.plan(h.request())).rejects.toSatisfy((error: unknown) =>
      isWorkRecoveryContinuationError(error, 'source_invalid'));
  });

  it('续接记录可作为 Attempt 不可变输入读回，且旧输入与预算不受影响', async () => {
    const h = makeHarness();
    const planned = await h.serviceWith(capabilities('unsupported')).plan(h.request());
    const record = planned.record;
    const bodyRef = (purpose: string) => ({
      artifactId: `body-${purpose}`, version: 1, contentHash: sha256(purpose),
      sizeBytes: 10, locator: `inputs/${purpose}`, mediaType: 'application/json',
    });
    const prepared = {
      projectId, featureId, taskId, schemaVersion: 3,
      group: { snapshot: bodyRef('snapshot'), manifest: bodyRef('manifest'), prompt: bodyRef('prompt') },
      requiredInputs: record.requiredInputs,
      digests: {
        snapshotDigest: sha256('snapshot'), manifestDigest: sha256('manifest'),
        promptDigest: sha256('prompt'), strategyCopyDigest: sha256('strategy'),
        permissionsDigest: sha256('permissions'),
      },
      approval: { planDigest: sha256('plan'), checkPolicyDigest: sha256('check'),
        decisionId: null, featureRevision: 1 },
      taskRevision: 1, promptBytes: 10,
      tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' },
      preparedAtUtcMs: 1,
      recovery: record,
    };
    const validated = validateAttemptInputSnapshot(prepared);
    expect(validated.recovery).toEqual(record);
    expect(validated.recovery?.decision.reasons).toContain('conversationResume:unsupported');
    expect(validated.recovery?.policy.executionConfig).toMatchObject({ provider: 'provider-a', model: 'model-a' });
  });

  it('安全的新 Session 输入固定续接记录：完整策略/来源/必需引用，不内联完整历史', async () => {
    const h = makeHarness();
    const planned = await h.serviceWith(capabilities('unsupported')).plan(h.request());
    const record = planned.record as WorkRecoveryContinuationRecord;
    const builder = createContextBuilder({
      budget: {
        maxPromptBytes: 200_000, maxRequiredSnapshotBytes: 100_000,
        maxRequiredInputRefs: 16, maxHistoryEntries: 20, maxHistoryEntryChars: 120,
        bytesPerTokenEstimate: 4,
      },
    });
    const result = builder.build({
      projectId, featureId, taskId,
      task: {
        title: 'same task', description: 'resume this task',
        acceptance: { criteria: ['criterion one', 'criterion two'] },
        requirementsRefs: [{ artifactId: 'req-1', contentHash: sha256('req-1') }],
        dependencies: [{ taskId: 'task-0', evidenceRefs: [{ artifactId: 'dep-1' }] }],
        executionConfig: record.policy.executionConfig as Record<string, unknown>,
        configSource: record.policy.configSource,
        configSourceKey: record.policy.configSourceKey,
        labels: [],
      },
      checkPolicy: { digest: record.policy.checkPolicyDigest },
      permissions: { grants: ['repo.read', 'repo.write'] },
      requiredInputs: record.requiredInputs,
      recovery: record,
    });
    expect(result.inputSnapshot.recovery).toEqual(record);
    expect(result.inputSnapshot.task.executionConfig).toEqual(record.policy.executionConfig);
    expect(result.prompt).toContain('## Recovery continuation (same Task; compact handoff; native history not inlined)');
    expect(result.prompt).toContain('requested: mode auto kind conversation');
    expect(result.prompt).toContain('decision: mode new reasons:');
    expect(result.prompt).toContain('sourceAttemptId: attempt-old');
    expect(result.prompt).toContain('sourceSessionId: session-old');
    expect(result.prompt).toContain('## Recovery required inputs');
    expect(result.prompt).not.toContain(archiveBody);
    expect(result.inputManifest.sources.find((source) => source.kind === 'recovery-record'))
      .toMatchObject({ required: true, purpose: 'same-task-recovery-continuation' });
  });
});
