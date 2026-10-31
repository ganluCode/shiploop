/**
 * P07-3 / F-016 共享夹具：默认组合根 + 真实 Git/SQLite/文件 数据生命周期垂直场景。
 *
 * 只通过公开入口建立业务事实（project.register / settings / phase / plan /
 * execution.input.prepare / execution.start / data.backup.* / project.archive 等
 * 公开命令）；Runtime 侧会话与原生记录经真实 work session store 与登记 SQL 写入
 * （与 F-006 相同纪律：Runtime 写路径不是客户端 payload）。
 * 提供有界条件等待（observable progress），不用固定长 sleep 代替断言。
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
type BetterSqlite3Database = Database.Database;
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from '../temp-sandbox.ts';
import type { TempSandbox } from '../temp-sandbox.ts';
import { commitAll, git, initGitRepo } from '../git-repo.ts';

export const LIFECYCLE_CATALOG = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
]);

export function lifecycleBudget() {
  return {
    batch: {
      maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2, maxNoProgressRuns: 2,
      deadlineUtcMs: Date.now() + 3_600_000, maxTokenTotal: 1000, maxCostTotal: 10,
    },
    run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 },
  };
}

/** 有界条件等待：观察到目标事实才继续；超时携带标签失败，不用固定 sleep 冒充断言。 */
export async function waitFor(label: string, condition: () => boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export interface LifecycleApp {
  readonly sandbox: TempSandbox;
  readonly repoDir: string;
  readonly app: CoreApplication;
  readonly owner: TrustedPrincipal;
  submit(operation: string, payload: unknown, extra?: Record<string, unknown>): Promise<Record<string, any>>;
  /** 独立可写连接：Runtime 写路径使用，不经过应用会话。 */
  openSession(): SqliteStorageSession;
  /** 只读事实核验（better-sqlite3 readonly）。 */
  readonlyDatabase(): BetterSqlite3Database;
  repoFacts(): { head: string; refs: string };
  close(): Promise<void>;
}

export async function openLifecycleApp(prefix: string): Promise<LifecycleApp> {
  const sandbox = createTempSandbox(prefix);
  const repoDir = join(sandbox.path, 'repository');
  initGitRepo(repoDir);
  // 可检测清单：语言探测据此提出 Node 能力模块（公开 profile.confirm 需非空 modules）。
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'f016-lifecycle-fixture', private: true }, null, 2) + '\n');
  writeFileSync(join(repoDir, 'README.md'), 'lifecycle fixture\n');
  commitAll(repoDir, 'fixture baseline');
  const app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog: LIFECYCLE_CATALOG, inputSourceRoots: { repo: repoDir } });
  const owner = createLocalOwnerPrincipal();
  const submit = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    app.commandService.submit(owner, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
      operation, payload, ...extra,
    } as never) as Promise<Record<string, any>>;
  const openSession = () => openSqliteStorageSession({ path: join(sandbox.path, 'core.sqlite') });
  const readonlyDatabase = () => new Database(join(sandbox.path, 'core.sqlite'), { readonly: true });
  return {
    sandbox, repoDir, app, owner, submit, openSession, readonlyDatabase,
    repoFacts: () => ({ head: git(['rev-parse', 'HEAD'], repoDir).trim(), refs: git(['show-ref'], repoDir).trim() }),
    close: async () => {
      await app.workExecution.close();
      await app.close();
    },
  };
}

export interface SeededPlan {
  readonly projectId: string;
  readonly featureId: string;
  readonly phaseId: string;
}

/** 通过公开命令建立项目 + 全局策略 + Phase + 已批准 Feature 计划（单 Task t-1）。 */
export async function seedApprovedPlan(lifecycle: LifecycleApp): Promise<SeededPlan> {
  const registered = await lifecycle.submit('project.register', {
    repositoryPath: lifecycle.repoDir, displayName: 'F016 生命周期', description: null, labels: [],
  }, { scope: { kind: 'registration' } });
  const projectId = registered.result.project.id as string;
  const scope = { kind: 'project', projectId };
  // P06 项目画像：公开 detect → confirm 后才允许执行输入准备。
  const detected = await lifecycle.submit('project.profile.detect', {}, { scope });
  const profile = detected.result.profile as Record<string, unknown>;
  const profileReader = lifecycle.readonlyDatabase();
  let profileRevision: number;
  try {
    profileRevision = Number((profileReader.prepare('SELECT revision FROM project_profiles WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as { revision: number }).revision);
  } finally { profileReader.close(); }
  await lifecycle.submit('project.profile.confirm', { profile }, { scope, expectedRevision: profileRevision });
  await lifecycle.submit('settings.global.create', {
    schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  }, { scope: { kind: 'global' } });
  await lifecycle.submit('phase.create', { id: 'phase-1', title: 'F016', description: null, labels: [] }, { scope });
  const imported = await lifecycle.submit('feature.plan.import', {
    phaseId: 'phase-1',
    plan: {
      schemaVersion: 1,
      feature: { title: 'F016 集成', description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: 't-1', title: 't-1', acceptance: { criteria: ['生命周期一致性'] }, dependsOn: [] }],
    },
  }, { scope, expectedRevision: 1 });
  const featureId = imported.result.feature.id as string;
  const reader = lifecycle.readonlyDatabase();
  try {
    const feature = reader.prepare('SELECT plan_digest, revision FROM features WHERE id = ?').get(featureId) as { plan_digest: string; revision: number };
    await lifecycle.submit('feature.plan.decide', {
      featureId, planDigest: feature.plan_digest, decision: 'approve', reason: 'F016 集成授权',
    }, { scope, expectedRevision: feature.revision });
  } finally { reader.close(); }
  return { projectId, featureId, phaseId: 'phase-1' };
}

/** 公开 execution.start（内部真实预览）：返回 runId。同一预算对象仅计算一次，避免 deadline 漂移致 preview_stale。 */
export async function startExecution(lifecycle: LifecycleApp, plan: SeededPlan): Promise<string> {
  const budget = lifecycleBudget();
  const preview = await lifecycle.app.executionPreview.previewExecution(plan.projectId, {
    featureIds: [plan.featureId], budget,
  });
  if (preview.status !== 'ready') throw new Error(`preview not ready: ${JSON.stringify(preview)}`);
  const receipt = await lifecycle.submit('execution.start', {
    featureIds: [plan.featureId], budget, previewDigest: preview.previewDigest, retryBatchId: null,
  }, { scope: { kind: 'project', projectId: plan.projectId } });
  const runId = (receipt.runId ?? receipt.result?.runId) as string | undefined;
  if (receipt.status !== 'accepted' || typeof runId !== 'string') {
    throw new Error(`execution.start 未接受: ${JSON.stringify(receipt)}`);
  }
  return runId;
}

export function sha256Hex(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** 登记一枚 ready 制品：真实索引行 + 数据根内真实正文文件（返回内容 hash）。 */
export function seedReadyArtifact(lifecycle: LifecycleApp, projectId: string, artifactId: string, kind: string, body: Uint8Array, ageDays = 0): string {
  const hash = sha256Hex(body);
  const at = Date.now() - ageDays * 86_400_000;
  const relative = deriveArtifactFinalRelativePath({ projectId, artifactId });
  const target = join(lifecycle.sandbox.path, relative);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, body, { mode: 0o600 });
  const session = lifecycle.openSession();
  try {
    session.transactWrite('f016.seed-artifact', db => {
      db.prepare(`INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type,
        expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason)
        VALUES (?, ?, ?, 1, ?, ?, 'ready', 'application/octet-stream', ?, ?, ?, 1, ?, NULL)`)
        .run(artifactId, at, projectId, at, kind, hash, hash, body.byteLength, `${kind}/${artifactId}`);
    });
  } finally { session.close(); }
  return hash;
}

/** Runtime 写路径：Attempt + Work Session（started）+ 原生引用/水位/缺口 + 记录 manifest。
 * inputGroup 来自公开 execution.input.prepare 的真实制品组引用（满足 attempts 身份触发器）。 */
export function seedRuntimeRecords(
  lifecycle: LifecycleApp,
  input: { readonly projectId: string; readonly featureId: string; readonly runId: string; readonly inputGroup: Record<string, Record<string, unknown>>; readonly partialCoverage?: boolean },
): { readonly attemptId: string; readonly sessionId: string; readonly nativeRef: Record<string, unknown>; readonly watermark: number; readonly gaps: readonly string[] } {
  const attemptId = 'attempt-f016';
  const sessionId = 'session-f016';
  const invocationId = 'invocation-f016';
  const owner = 'owner-f016';
  const hostInstanceId = 'host-f016';
  const executionVersion = 1;
  const snapshot = input.inputGroup.snapshot!;
  const snapshotDigest = String(snapshot.contentHash);
  const now = Date.now();
  const session = lifecycle.openSession();
  try {
    session.transactWrite('f016.seed-attempt', db => {
      db.prepare("UPDATE tasks SET execution_version = 1 WHERE id = 't-1'").run();
      db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id, number,
        owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref, status, execution_stage, started_at, invocation_id)
        VALUES (?, ?, ?, ?, ?, ?, 't-1', 1, ?, ?, 1, 0, ?, ?, ?, 'executing', 'runtime', ?, ?)`)
        .run(attemptId, now, now, input.projectId, input.featureId, input.runId, owner, hostInstanceId,
          JSON.stringify({ schemaVersion: 1, projectId: input.projectId, featureId: input.featureId, taskId: 't-1',
            digests: { snapshotDigest }, group: input.inputGroup }),
          snapshotDigest, String(snapshot.artifactId), now, invocationId);
    });
    const sessions = createSqliteWorkSessionStore(session);
    const identity = { projectId: input.projectId, sessionId, attemptId, owner, hostInstanceId, executionVersion };
    // native_ref 不在会话行声明（声明即 native_archive_unavailable，备份拒绝发布）；
    // 原生版本信息保留在记录 manifest 的 native_ref/sdk/format 列，水位/缺口在会话列。
    // partialCoverage=true 时携带真实缺口（partial + missing_reasons + 会话缺口列），
    // 用于验证备份对缺口记录的 fail-closed 拒绝。
    const nativeRef = { schemaVersion: 1 as const, storageKind: 'artifact', formatVersion: '2' };
    const partial = input.partialCoverage === true;
    const gaps = partial ? ['native_history_gap'] : [];
    const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'f016' });
    sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
    const watermark = 7;
    // 记录内容制品（真实正文）+ 7 条 session_messages（水位 7 有真实序列支撑）。
    const recBody = new TextEncoder().encode('f016 recording message');
    const recArtifactId = 'artifact-rec-f016';
    const recHash = sha256Hex(recBody);
    const recRelative = deriveArtifactFinalRelativePath({ projectId: input.projectId, artifactId: recArtifactId });
    const recPath = join(lifecycle.sandbox.path, recRelative);
    mkdirSync(dirname(recPath), { recursive: true, mode: 0o700 });
    writeFileSync(recPath, recBody, { mode: 0o600 });
    session.transactWrite('f016.seed-recording', db => {
      db.prepare(`INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type,
        expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason)
        VALUES (?, ?, ?, 1, ?, 'recording-content', 'ready', 'application/octet-stream', ?, ?, ?, 1, ?, NULL)`)
        .run(recArtifactId, now, input.projectId, now, recHash, recHash, recBody.byteLength, `recording/${recArtifactId}`);
      const insertMessage = db.prepare(`INSERT INTO session_messages (id, created_at, updated_at, project_id, session_id,
        run_id, attempt_id, invocation_id, execution_version, sequence, event_id, message_key, kind, role,
        content_ref, content_hash, content_size_bytes, content_locator, source, source_refs, attachment_refs,
        occurred_at, recorded_at, truncated, redacted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'message', 'assistant', ?, ?, ?, ?, 'live', '[]', '[]', ?, ?, 0, 0)`);
      for (let sequence = 1; sequence <= watermark; sequence += 1) {
        insertMessage.run(`message-f016-${sequence}`, now, now, input.projectId, sessionId,
          input.runId, attemptId, invocationId, executionVersion, sequence,
          `event-f016-${sequence}`, `message-key-f016-${sequence}`,
          recArtifactId, recHash, recBody.byteLength, `recording/${recArtifactId}`, now - (watermark - sequence), now);
      }
      db.prepare('UPDATE sessions SET recording_watermark = ?, recording_gaps = ? WHERE id = ?')
        .run(watermark, partial ? JSON.stringify(gaps) : null, sessionId);
      db.prepare(`INSERT INTO recording_manifests (id, created_at, updated_at, project_id, revision, session_id, run_id,
        attempt_id, invocation_id, execution_version, version, watermark, final_sequence, sequence_reconciliation,
        coverage, source, scope, missing_reasons, diagnostics, truncation, redaction, sdk_version, format_version,
        native_ref, unknown_event_count, finalized)
        VALUES ('manifest-f016', ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ${watermark}, ${watermark}, ${partial ? "'not_available', 'partial'" : "'match', 'complete'"}, 'native',
        '{"covers":["public_events"],"excludes":["hidden_reasoning","native_private_storage","unified_audit"]}',
        ${partial ? '?' : "'[]'"}, '[]', '{"applied":false,"reasons":[]}', '{"applied":false,"reasons":[]}', 'f016-sdk', 'work-recording/v1', ?, 0, ${partial ? 0 : 1})`)
        .run(now, now, input.projectId, sessionId, input.runId, attemptId, invocationId, executionVersion,
          ...(partial ? [JSON.stringify(gaps)] : []), JSON.stringify(nativeRef));
    });
    return { attemptId, sessionId, nativeRef, watermark, gaps };
  } finally { session.close(); }
}

/** 只读事实核验：打开备份/目标数据库比对指定表行集合。 */
export function tableRows(database: BetterSqlite3Database, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

export function readonlyDatabase(path: string): BetterSqlite3Database {
  return new Database(path, { readonly: true });
}

export function readJsonIfExists(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>; } catch { return null; }
}
