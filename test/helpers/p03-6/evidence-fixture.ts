/**
 * P03-6 / F-007 证据采集测试夹具（仅测试，不进 packages/）。
 *
 * 全真实资源：真实 SQLite（迁移至 v20，经公开命令通道注册/配置/计划/批准/
 * 启动）+ 真实 Artifact 文件/索引/发布/完整性端口 + 真实 Work Session 存
 * 储 + 真实 FakeRuntime 执行（临时工作区）。无任何 mock 框架、网络或 SDK；
 * 故障注入经可信装配（门闩/包装端口）显式进行。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openBudgetFixture, NOW } from '../p03-3/budget-fixture.ts';
import type { BudgetFixture } from '../p03-3/budget-fixture.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import {
  createFakeRuntime,
  fakeRuntimeCorrelationToken,
} from '../../../packages/core/src/adapters/fake-runtime.ts';
import type {
  FakeRuntimeGateControl,
  FakeRuntimeHandle,
} from '../../../packages/core/src/adapters/fake-runtime.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { WorkEvidenceRecorderLimits } from '../../../packages/core/src/ports/work-evidence-recorder.ts';

export const EVIDENCE_NOW = NOW + 1000;

const INPUT_HASH = 'cd'.repeat(32);

export const DEFAULT_RECORDER_LIMITS: WorkEvidenceRecorderLimits = {
  maxEventBodyBytes: 8_192,
  chunkMaxEvents: 4,
  chunkMaxBytes: 262_144,
  maxTotalEvents: 1_000,
  maxTotalBytes: 4_000_000,
  reorderWindow: 1,
  tailWaitMs: 5_000,
};

export interface EvidenceFixtureOptions {
  /** Fake 脚本（可信测试装配纯数据）。 */
  readonly script: unknown;
  readonly limits?: Partial<WorkEvidenceRecorderLimits>;
  /** P07-2：装配期有效限制（recorder/publish）；提供时必须与 limits 一致。 */
  readonly effectiveLimits?: unknown;
  /** 注入脱敏秘密字面量。 */
  readonly secrets?: readonly string[];
  /** Fake 门闩（lifecycle/await_gate 引用）。 */
  readonly gates?: Readonly<Record<string, FakeRuntimeGateControl>>;
  /** 包装制品文件端口（故障注入，如 ENOSPC/短写）。 */
  readonly wrapFiles?: (files: ReturnType<typeof createArtifactFileStore>) => ReturnType<typeof createArtifactFileStore>;
  /** Fake 事件缓冲收窄（背压验证）。 */
  readonly fakeBuffer?: { readonly maxEvents?: number; readonly maxBytes?: number };
}

export interface EvidenceFixture {
  readonly budget: BudgetFixture;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly publisher: ReturnType<typeof createArtifactPublisher>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly sessions: ReturnType<typeof createSqliteWorkSessionStore>;
  readonly recorder: ReturnType<typeof createWorkEvidenceRecorder>;
  readonly request: RuntimeExecutionRequest;
  readonly eventIdentityPrefix: string;
  readonly handle: FakeRuntimeHandle;
  /** 直接 SQL 读取（断言辅助）。 */
  readonly query: (sql: string, ...params: unknown[]) => unknown;
  close(): void;
}

export async function openEvidenceFixture(options: EvidenceFixtureOptions): Promise<EvidenceFixture> {
  const budget = await openBudgetFixture();
  try {
    const ids = await budget.start();
    const session = budget.session;
    const db = session.database;
    // Direct fixture seeding mirrors claimTask's Task/Attempt generation CAS.
    db.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run(ids.taskId);
    const nowUtcMs = () => EVIDENCE_NOW;

    /* 输入制品索引（ready；会话创建只核对存在性与身份）。 */
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'execution-input', 'ready', 'application/json', ?, ?, ?, ?)`)
      .run('snapshot-1', EVIDENCE_NOW, EVIDENCE_NOW, budget.projectId, INPUT_HASH, INPUT_HASH, 10, 'inputs/snapshot-1');

    const attemptId = 'attempt-1';
    /* input_snapshot 必须满足 attempts_snapshot_check（schemaVersion/project/
     * feature/task/digests 与列一致）：复用 F-006 测试的完整快照形状。 */
    const inputSnapshot = {
      schemaVersion: 1, projectId: budget.projectId, featureId: budget.featureId, taskId: ids.taskId,
      group: {
        snapshot: { artifactId: 'snapshot-1', version: 1, contentHash: INPUT_HASH, sizeBytes: 10, locator: 'inputs/snapshot-1', mediaType: 'application/json' },
        manifest: { artifactId: 'snapshot-1', version: 1, contentHash: INPUT_HASH, sizeBytes: 10, locator: 'inputs/snapshot-1', mediaType: 'application/json' },
        prompt: { artifactId: 'snapshot-1', version: 1, contentHash: INPUT_HASH, sizeBytes: 10, locator: 'inputs/snapshot-1', mediaType: 'application/json' },
      },
      requiredInputs: [],
      digests: {
        snapshotDigest: INPUT_HASH, manifestDigest: INPUT_HASH, promptDigest: INPUT_HASH,
        strategyCopyDigest: INPUT_HASH, permissionsDigest: INPUT_HASH,
      },
      approval: { planDigest: INPUT_HASH, checkPolicyDigest: INPUT_HASH, decisionId: null, featureRevision: 1 },
      taskRevision: 1, promptBytes: 10,
      tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' },
      preparedAtUtcMs: EVIDENCE_NOW,
    };
    db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
      number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'owner-1', 'host-1', 1, ?, ?, ?, 'snapshot-1')`)
      .run(attemptId, EVIDENCE_NOW, EVIDENCE_NOW, budget.projectId, budget.featureId, ids.runId, ids.taskId,
        EVIDENCE_NOW + 600_000, JSON.stringify(inputSnapshot), INPUT_HASH);

    const artifacts = createSqliteArtifactStore(session, { nowUtcMs });
    const rawFiles = createArtifactFileStore({ dataRoot: budget.box.dataRoot });
    const files = options.wrapFiles === undefined ? rawFiles : options.wrapFiles(rawFiles);
    const publisher = createArtifactPublisher({
      artifacts, files, limits: { maxSizeBytes: 4_000_000, timeoutMs: 60_000 }, nowMs: nowUtcMs,
    });
    const verifier = createArtifactVerifier({
      artifacts, files, limits: { maxReadBytes: 4_000_000 }, nowMs: nowUtcMs,
    });
    const sessions = createSqliteWorkSessionStore(session, { nowUtcMs });

    const sessionId = 'session-1';
    sessions.createWorkSession({
      sessionId, projectId: budget.projectId, attemptId,
      owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
      purpose: 'execution', runtime: 'fake', adapterVersion: '1.0-fake',
    });
    sessions.applyWorkSessionProgress({
      sessionId, projectId: budget.projectId, attemptId,
      owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
      expectedRevision: 1, kind: 'started',
    });

    const limits: WorkEvidenceRecorderLimits = { ...DEFAULT_RECORDER_LIMITS, ...options.limits };
    const recorder = createWorkEvidenceRecorder({
      publisher, verifier, sessions, limits,
      ...(options.effectiveLimits === undefined ? {} : { effectiveLimits: options.effectiveLimits }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      nowMs: nowUtcMs,
    });

    const workspaceDir = join(budget.box.root, 'fake-workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const fake = createFakeRuntime({
      script: options.script,
      workspaceRoots: { 'workspace-root': workspaceDir },
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      adapterVersion: '1.0-fake',
      nowUtcMs,
      ...(options.gates === undefined ? {} : { gates: options.gates }),
      ...(options.fakeBuffer === undefined ? {} : { buffer: options.fakeBuffer }),
    });

    const inputRef = (purpose: string) => ({
      projectId: budget.projectId, artifactId: 'snapshot-1', kind: 'execution-input', purpose,
      version: 1, contentHash: INPUT_HASH, sizeBytes: 10, locator: 'inputs/snapshot-1',
      mediaType: 'application/json', origin: { kind: 'artifact' },
    });
    const request: RuntimeExecutionRequest = {
      schemaVersion: 1,
      projectId: budget.projectId,
      featureId: budget.featureId,
      sessionId,
      executionVersion: 1,
      owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
      identity: { purpose: 'work', runId: ids.runId, taskId: ids.taskId, attemptId },
      invocationId: 'invocation-1',
      strategy: { runtime: 'fake', provider: 'test-provider', model: 'fake-model' },
      prompt: inputRef('prompt') as RuntimeExecutionRequest['prompt'],
      inputManifest: inputRef('manifest') as RuntimeExecutionRequest['inputManifest'],
      cwd: { root: 'workspace-root', relativePath: '.' },
      permissions: { grants: [], isolation: 'trusted_project' },
      limits: { timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 4_000_000 },
      recovery: { mode: 'new' },
    };
    const handle = await fake.adapter.start(request) as FakeRuntimeHandle;

    return {
      budget,
      projectId: budget.projectId,
      featureId: budget.featureId,
      runId: ids.runId,
      taskId: ids.taskId,
      attemptId,
      sessionId,
      publisher, verifier, artifacts, sessions, recorder, request,
      eventIdentityPrefix: `evt.${fakeRuntimeCorrelationToken(request)}.`,
      handle,
      query: (sql, ...params) => db.prepare(sql).get(...params as never[]),
      close() { void handle.cancel().catch(() => undefined); budget.close(); },
    };
  } catch (error) {
    budget.close();
    throw error;
  }
}
