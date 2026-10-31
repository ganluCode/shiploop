/**
 * P07-4 / F-002：结果证据 missing / corrupt / 记录缺口统一展示与安全有界读取。
 *
 * 覆盖验收点：
 * - 实际读取的运行结果、检查输出与 Work 记录正文均核对制品成员关系、受控
 *   位置、内容摘要、大小及适用执行身份；ready 元数据不等于正文有效；
 * - 删除 / 篡改 / 结构损坏 / 未知版本 / 引用归属错误分别返回可诊断的
 *   missing、corrupt 或既有对应错误及稳定制品引用；不伪造空正文或 complete；
 * - 结果摘要展示 Recorder 真实 coverage / 水位 / 截断 / 脱敏 / 缺失原因；
 *   P07-2 背压或尾部丢失不被 settlement 成功文本抹平；
 * - 正文按明确制品引用按需读取，具字节与时间上限；查询不修复文件、不修改
 *   业务状态或记录水位（真实临时文件 + SQLite 全表快照核对）。
 */
import { expect, test, afterEach } from 'vitest';
import { lstatSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { WORK_SESSION_SETTLEMENT_MAX_READ_BYTES } from '../../../packages/core/src/ports/work-session-query.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import {
  reportAttempt,
  reportArtifact,
  reportDatabaseSnapshot,
  reportSettlement,
} from '../../helpers/p03-10/report-fixture.ts';
import { openBudgetFixture, BUDGET, NOW, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openBindingFixture, publishReadyArtifact } from '../../helpers/p03-6/input-binding-fixture.ts';
import { RECORDING_MESSAGE, RECORDING_MANIFEST } from '../../helpers/p04-5/recording-fixture.ts';
import { createLocalOwnerPrincipal } from '../../helpers/p02-2/principals.ts';

const owner = createLocalOwnerPrincipal();
const fixtures: { close(): void }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

/** 每次调用推进 2 分钟的时钟：任何有界读取必然超过毫秒级时间上限。 */
function advancingClock(stepMs = 120_000): () => number {
  let calls = 0;
  return () => NOW + (calls += 1) * stepMs;
}

function budgetQueries(f: BudgetFixture, nowUtcMs: () => number = () => NOW) {
  const store = createSqliteQueryStore(f.session);
  const stateStore = createSqliteStateStore(f.session);
  return createQueryService({
    projectReads: store, snapshots: store, eventReads: store, stateStore,
    configurationService: createConfigurationService({ stateStore, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) }),
    planReads: store, executionBudgetReads: store, scheduleReads: store, workspaceReads: store,
    workSessionReads: store, taskEvidenceReads: store, gitOperationReads: store,
    featureDeliveryReads: store, featureReportReads: store, executionControlReads: store,
    resultDiagnosticsReads: store,
    artifacts: createSqliteArtifactStore(f.session), artifactFiles: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    dataRootIdentity: computeDataRootIdentity(f.box.dataRoot), nowUtcMs,
  });
}

function artifactPath(f: BudgetFixture, artifactId: string): string {
  return join(f.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId }));
}

/** 单 Run + 单成功 Attempt + 已发布 settlement 证据的基础场景。 */
async function evidenceFixture(settlementOverrides: Record<string, unknown> = {}) {
  const f = await openBudgetFixture(BUDGET, [
    { id: 't-1', title: 'Task 1', acceptance: { criteria: ['result evidence'] }, dependsOn: [] },
    { id: 't-2', title: 'Task 2', acceptance: { criteria: ['result evidence'] }, dependsOn: [] },
  ]);
  fixtures.push(f);
  const started = await f.start();
  const runId = started.runId!;
  const attempt = reportAttempt(f, { id: 'ev-a1', runId, status: 'succeeded' });
  const ref = reportSettlement(f, attempt, settlementOverrides);
  return { f, runId, attempt, ref };
}

/** 直接登记 recording_manifests 元数据行（内容摘要/正文不参与，Recorder 事实按行投影）。 */
function insertManifest(f: BudgetFixture, options: {
  sessionId: string; attemptId: string; runId: string; invocationId: string;
  id?: string; version?: number; executionVersion?: number;
  coverage?: 'complete' | 'partial' | 'failed'; watermark?: number | null;
  missingReasons?: string[]; diagnostics?: string[];
  truncation?: { applied: boolean; reasons: string[] };
  redaction?: { applied: boolean; reasons: string[] };
  unknownEventCount?: number | null; finalized?: boolean;
}) {
  const {
    sessionId, attemptId, runId, invocationId,
    id = `manifest-${sessionId}-v${options.version ?? 1}`, version = 1, executionVersion = 1,
    coverage = 'partial', watermark = null, missingReasons = ['sequence_gap'],
    diagnostics = [], truncation = { applied: false, reasons: [] }, redaction = { applied: false, reasons: [] },
    unknownEventCount = null, finalized = false,
  } = options;
  f.session.database.prepare(`INSERT INTO recording_manifests (id, created_at, updated_at, revision, project_id,
    session_id, run_id, attempt_id, invocation_id, execution_version, version, manifest_ref, manifest_hash,
    manifest_size_bytes, manifest_locator, watermark, final_sequence, sequence_reconciliation, coverage, source,
    scope, missing_reasons, diagnostics, truncation, redaction, sdk_version, format_version, native_ref,
    unknown_event_count, finalized) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL,
    'not_available', ?, 'mixed', ?, ?, ?, ?, ?, NULL, 'work-recording/v1', NULL, ?, ?)`)
    .run(id, NOW, NOW, f.projectId, sessionId, runId, attemptId, invocationId, executionVersion, version,
      watermark, coverage,
      JSON.stringify({ covers: ['public_events'], excludes: ['hidden_reasoning', 'native_private_storage', 'unified_audit'] }),
      JSON.stringify(missingReasons), JSON.stringify(diagnostics),
      JSON.stringify(truncation), JSON.stringify(redaction), unknownEventCount, finalized ? 1 : 0);
}

function insertChildSession(f: BudgetFixture, id: string, parentId: string) {
  f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, project_id, parent_session_id, kind,
    purpose, runtime, adapter_version, input_ref, last_activity_at) SELECT ?, ?, ?, project_id, id, 'work',
    'subtask', runtime, adapter_version, input_ref, ? FROM sessions WHERE id = ?`)
    .run(id, NOW, NOW, NOW, parentId);
}

/** 登记 session_messages 元数据行（水位守卫要求消息行真实存在）。 */
function insertMessage(f: BudgetFixture, options: {
  sessionId: string; attemptId: string; runId: string; invocationId: string;
  id: string; sequence: number;
  contentRef: { artifactId: string; contentHash: string; sizeBytes: number; locator: string };
  executionVersion?: number;
}) {
  const { sessionId, attemptId, runId, invocationId, id, sequence, contentRef, executionVersion = 1 } = options;
  f.session.database.prepare(`INSERT INTO session_messages (id, created_at, updated_at, revision, project_id,
    session_id, run_id, attempt_id, invocation_id, execution_version, sequence, event_id, message_key, kind, role,
    provider_message_id, tool_call_id, parent_tool_call_id, source, source_refs, attachment_refs, occurred_at,
    recorded_at, truncated, redacted, content_ref, content_hash, content_size_bytes, content_locator)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'message', 'assistant', NULL, NULL, NULL, 'live', '[]', '[]',
    ?, ?, 0, 0, ?, ?, ?, ?)`)
    .run(id, NOW, NOW, f.projectId, sessionId, runId, attemptId, invocationId, executionVersion, sequence,
      `event-${id}`, `key-${id}`, NOW, NOW, contentRef.artifactId, contentRef.contentHash, contentRef.sizeBytes, contentRef.locator);
}

/** 模拟磁盘元数据损坏：临时移除不可变守卫完成改写后恢复（生产写入仍受保护）。 */
function withDroppedTrigger(f: BudgetFixture, trigger: string, mutate: () => void) {
  const guard = f.session.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger) as { sql: string };
  f.session.database.exec(`DROP TRIGGER ${trigger}`);
  try { mutate(); } finally { f.session.database.exec(guard.sql); }
}

test('[case:settlement-body-paths] getWorkSession 结果证据区分 missing / corrupt / invalid / identity 并携带稳定引用', async () => {
  const { f, attempt, ref } = await evidenceFixture();
  const q = budgetQueries(f);
  const path = artifactPath(f, ref.artifactId);
  // 正常读取：ready + 正文核验 + 执行身份绑定通过。
  const detail = await q.getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id });
  expect(detail.resultEvidence).toMatchObject({ kind: 'runtime-settlement', recording: { complete: false, gaps: ['historical_tail_missing'] } });

  const before = reportDatabaseSnapshot(f);
  // 删除正文 → missing。
  unlinkSync(path);
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_missing', artifactId: ref.artifactId } });
  // 篡改（同长度换内容）→ 摘要不匹配 → corrupt。
  writeFileSync(path, 'x'.repeat(ref.sizeBytes));
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_corrupt', artifactId: ref.artifactId } });
  // 截断（大小不匹配）→ corrupt。
  writeFileSync(path, 'short');
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_corrupt', artifactId: ref.artifactId } });
  // 符号链接越界 → 不跟随、不修复。
  rmSync(path);
  symlinkSync('/etc/hosts', path);
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_unavailable', artifactId: ref.artifactId } });
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  rmSync(path);
  // 文件系统损坏阶段只读：业务行不变。
  expect(reportDatabaseSnapshot(f)).toEqual(before);
  // 结构损坏（非对象正文）与未知版本 → body_invalid（各用独立 Attempt，避免改写 set-once 的 result_ref）。
  const brokenAttempt = reportAttempt(f, { id: 'ev-a-broken', runId: attempt.runId, taskId: 't-2', number: 2, status: 'succeeded' });
  const broken = reportArtifact(f, 'ev-broken', `sessions/${brokenAttempt.sessionId}/runtime-settlement.json`, 'not json', 'runtime-settlement');
  f.session.database.prepare('UPDATE sessions SET result_ref = ? WHERE id = ?').run(broken.artifactId, brokenAttempt.sessionId);
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: brokenAttempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_invalid', artifactId: broken.artifactId } });
  const versionAttempt = reportAttempt(f, { id: 'ev-a-version', runId: attempt.runId, taskId: 't-2', number: 3, status: 'succeeded' });
  const badVersion = reportArtifact(f, 'ev-bad-version', `sessions/${versionAttempt.sessionId}/runtime-settlement.json`,
    { schemaVersion: 2, kind: 'runtime-settlement', identity: {} }, 'runtime-settlement');
  f.session.database.prepare('UPDATE sessions SET result_ref = ? WHERE id = ?').run(badVersion.artifactId, versionAttempt.sessionId);
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: versionAttempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_invalid', artifactId: badVersion.artifactId } });
  // 引用归属错误：identity 绑定其他 Attempt → identity_mismatch。
  const other = reportAttempt(f, { id: 'ev-a2', runId: attempt.runId, taskId: 't-2', number: 4, status: 'succeeded' });
  const foreign = reportSettlement(f, other, { identity: { projectId: f.projectId, attemptId: attempt.id } });
  const beforeFinal = reportDatabaseSnapshot(f);
  await expect(q.getWorkSession(owner, { projectId: f.projectId, attemptId: other.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_identity_mismatch', artifactId: foreign.artifactId } });
  // 查询零写入：业务行/预算/回执/事件不变化。
  expect(reportDatabaseSnapshot(f)).toEqual(beforeFinal);
});

test('[case:evidence-body-paths] readWorkSessionEvidence 区分 missing / corrupt 并拒绝越权制品与路径穿越', async () => {
  const { f, attempt, ref } = await evidenceFixture();
  const q = budgetQueries(f);
  const path = artifactPath(f, ref.artifactId);
  const input = { projectId: f.projectId, attemptId: attempt.id, artifactId: ref.artifactId };
  // 正常读取：成员制品 + 受控位置 + 摘要/大小核验。
  const body = await q.readWorkSessionEvidence(owner, input);
  expect(body.artifact).toMatchObject({ artifactId: ref.artifactId, kind: 'runtime-settlement', contentHash: ref.contentHash, sizeBytes: ref.sizeBytes });
  expect(JSON.parse(Buffer.from(body.content).toString('utf8'))).toMatchObject({ kind: 'runtime-settlement' });

  // 同项目但非本 Attempt 受控前缀的制品（构造提前于快照，仅登记不读）。
  const foreign = reportArtifact(f, 'ev-foreign-loc', 'inputs/ev-foreign', 'foreign body');
  const before = reportDatabaseSnapshot(f);
  unlinkSync(path);
  await expect(q.readWorkSessionEvidence(owner, input))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'evidence_body_missing', artifactId: ref.artifactId } });
  writeFileSync(path, 'x'.repeat(ref.sizeBytes));
  await expect(q.readWorkSessionEvidence(owner, input))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'evidence_body_corrupt', artifactId: ref.artifactId } });
  rmSync(path);
  symlinkSync('/etc/hosts', path);
  await expect(q.readWorkSessionEvidence(owner, input))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'evidence_body_unavailable', artifactId: ref.artifactId } });
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  rmSync(path);
  writeFileSync(path, 'x'.repeat(ref.sizeBytes));
  await expect(q.readWorkSessionEvidence(owner, { ...input, artifactId: foreign.artifactId }))
    .rejects.toMatchObject({ code: 'not_found' });
  for (const artifactId of ['../escape', '/etc/passwd', `${ref.artifactId}/../../x`]) {
    await expect(q.readWorkSessionEvidence(owner, { ...input, artifactId }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:issue-codes] 报告与结果诊断对结果证据问题给出细分 issue 与稳定引用，不伪造空正文或零 Token', async () => {
  const { f, attempt, ref } = await evidenceFixture();
  const runId = attempt.runId;
  const q = budgetQueries(f);
  const input = { projectId: f.projectId };
  // 基线：正文有效 → 无 result_evidence issue、稳定引用可见。
  const baseline = await q.listResultDiagnostics(f.owner, { ...input, attemptId: attempt.id });
  expect(baseline.records[0].issues).not.toContain('result_evidence_missing');
  expect(baseline.records[0].resultEvidenceRef).toBe(ref.artifactId);
  expect(baseline.records[0].runtime.resultKnown).toBe(true);

  // 索引非 ready → missing（独立 Attempt；不伪造零 Token 或 complete）。
  const notReady = reportAttempt(f, { id: 'ev-iss-notready', runId, taskId: 't-2', number: 2, status: 'succeeded' });
  const notReadyRef = reportSettlement(f, notReady);
  f.session.database.prepare("UPDATE artifacts SET status = 'failed' WHERE id = ?").run(notReadyRef.artifactId);
  const notReadyPage = await q.listResultDiagnostics(f.owner, { ...input, attemptId: notReady.id });
  expect(notReadyPage.records[0].issues).toContain('result_evidence_missing');
  expect(notReadyPage.records[0].runtime.resultKnown).toBe(false);
  expect(notReadyPage.records[0].recording).toBeNull();
  expect(notReadyPage.records[0].resultEvidenceRef).toBe(notReadyRef.artifactId);
  expect(notReadyPage.records[0].usage).toMatchObject({ basis: 'unknown', inputTokens: null, outputTokens: null, costMicros: null });

  // 删除正文 → body_missing（列表与报告一致，不伪造空正文）。
  const path = artifactPath(f, ref.artifactId);
  unlinkSync(path);
  const missingPage = await q.listResultDiagnostics(f.owner, { ...input, attemptId: attempt.id });
  expect(missingPage.records[0].issues).toContain('result_evidence_body_missing');
  expect(missingPage.records[0].resultEvidenceRef).toBe(ref.artifactId);
  let report = await q.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  const validTask = report.tasks.find(t => t.current.taskId === 't-1')!;
  expect(validTask.attempts[0].issues).toContain('result_evidence_body_missing');
  expect(validTask.attempts[0].resultEvidence).toBeNull();

  // 篡改（同长度）→ body_corrupt。
  writeFileSync(path, 'x'.repeat(ref.sizeBytes));
  const corruptPage = await q.listResultDiagnostics(f.owner, { ...input, attemptId: attempt.id });
  expect(corruptPage.records[0].issues).toContain('result_evidence_body_corrupt');

  // 结构损坏 → body_invalid（独立 Attempt，单次 set-once 引用）。
  const brokenAttempt = reportAttempt(f, { id: 'ev-iss-broken', runId, taskId: 't-2', number: 3, status: 'succeeded' });
  const broken = reportArtifact(f, 'ev-iss-broken-result', `sessions/${brokenAttempt.sessionId}/runtime-settlement.json`, 'not json', 'runtime-settlement');
  f.session.database.prepare('UPDATE sessions SET result_ref = ? WHERE id = ?').run(broken.artifactId, brokenAttempt.sessionId);
  const brokenPage = await q.listResultDiagnostics(f.owner, { ...input, attemptId: brokenAttempt.id });
  expect(brokenPage.records[0].issues).toContain('result_evidence_body_invalid');
  expect(brokenPage.records[0].resultEvidenceRef).toBe(broken.artifactId);

  // 身份不符 → identity_mismatch（identity 绑定其他 Attempt）。
  const other = reportAttempt(f, { id: 'ev-iss-a2', runId, taskId: 't-2', number: 4, status: 'succeeded' });
  const foreign = reportSettlement(f, other, { identity: { projectId: f.projectId, attemptId: attempt.id } });
  const before = reportDatabaseSnapshot(f);
  report = await q.getFeatureReport(f.owner, { projectId: f.projectId, featureId: f.featureId });
  const foreignTask = report.tasks.find(t => t.current.taskId === 't-2')!;
  const foreignAttempt = foreignTask.attempts.find(a => a.id === other.id)!;
  expect(foreignAttempt.issues).toContain('result_evidence_identity_mismatch');
  expect(foreignAttempt.resultEvidence).toBeNull();
  const foreignPage = await q.listResultDiagnostics(f.owner, { ...input, attemptId: other.id });
  expect(foreignPage.records[0].issues).toContain('result_evidence_identity_mismatch');
  expect(foreignPage.records[0].resultEvidenceRef).toBe(foreign.artifactId);
  // 只读：查询不修复文件、不改业务行。
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:recorder-summary] 结果摘要展示 Recorder 真实 coverage/水位/截断/脱敏/缺失原因且不被成功文本抹平', async () => {
  // settlement 主张 recording complete（带合法 manifest 引用），但 Recorder 事实是
  // partial + P07-2 背压缺口：两轴并列展示，成功文本不抹平缺口。
  const { f, attempt, runId } = await evidenceFixture({
    recording: { complete: true, manifestRef: 'manifest-ev-a1-session-v1', failure: null, gaps: [], watermark: 5 },
  });
  f.session.database.prepare("UPDATE attempts SET invocation_id = 'inv-ev-a1' WHERE id = ?").run(attempt.id);
  // 真实消息行支撑 Recorder 水位；manifest 元数据经生产校验约束登记。
  const bodyRef = reportArtifact(f, 'ev-rec-body', `sessions/${attempt.sessionId}/messages/3.json`, '{"seq":3}', 'session-recording');
  insertMessage(f, {
    sessionId: attempt.sessionId!, attemptId: attempt.id, runId, invocationId: 'inv-ev-a1',
    id: 'ev-message-3', sequence: 3, contentRef: bodyRef,
  });
  insertManifest(f, {
    sessionId: attempt.sessionId!, attemptId: attempt.id, runId, invocationId: 'inv-ev-a1',
    coverage: 'partial', watermark: 3, unknownEventCount: 2,
    missingReasons: ['recording_failed:event_queue_backpressure', '/private/secret-path'],
    diagnostics: ['secret provider error'],
    truncation: { applied: true, reasons: ['total_volume_limit'] },
    redaction: { applied: true, reasons: ['configured_literal_redaction'] },
  });
  insertChildSession(f, 'ev-child', attempt.sessionId!);
  insertManifest(f, {
    sessionId: 'ev-child', attemptId: attempt.id, runId, invocationId: 'inv-ev-a1',
    id: 'manifest-child-v1', coverage: 'complete', watermark: null, missingReasons: [], unknownEventCount: 0,
    finalized: false, truncation: { applied: false, reasons: [] }, redaction: { applied: false, reasons: [] },
  });
  const q = budgetQueries(f);
  const page = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: attempt.id });
  const record = page.records[0];
  // Recorder 真实事实逐项展示；自由文本原因码被脱敏映射。
  expect(record.recorder).toMatchObject({ truncated: false });
  expect(record.recorder!.sessions).toHaveLength(2);
  expect(record.recorder!.sessions[0]).toMatchObject({
    sessionId: attempt.sessionId, version: 1, coverage: 'partial', watermark: 3, unknownEventCount: 2,
    truncation: { applied: true, reasons: ['total_volume_limit'] },
    redaction: { applied: true, reasons: ['configured_literal_redaction'] },
    missingReasons: ['recording_failed:event_queue_backpressure', 'recording_detail_redacted'],
    finalized: false,
  });
  expect(record.recorder!.sessions[1]).toMatchObject({ sessionId: 'ev-child', coverage: 'complete', watermark: null, finalized: false });
  // settlement 成功主张不抹平 Recorder 缺口；两轴事实同时保留。
  expect(record.recording).toMatchObject({ complete: true, gaps: [], watermark: 5 });
  expect(record.issues).toContain('recording_partial');
  // 有 Session 无 manifest → 显式缺口；无 Session → recorder 为 null。
  const bare = reportAttempt(f, { id: 'ev-no-manifest', runId, taskId: 't-2', number: 2, status: 'succeeded' });
  reportSettlement(f, bare);
  const barePage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: bare.id });
  expect(barePage.records[0].recorder).toEqual({ sessions: [], truncated: false });
  expect(barePage.records[0].issues).toContain('recording_manifest_missing');
  const noSession = reportAttempt(f, { id: 'ev-no-session', runId, taskId: 't-2', number: 3, status: 'cancelled', session: false });
  const nonePage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: noSession.id });
  expect(nonePage.records[0].recorder).toBeNull();
  // 树内 Session 超上限 → truncated 标志，不静默丢弃。
  for (let n = 1; n <= 17; n++) insertChildSession(f, `ev-child-${String(n).padStart(2, '0')}`, attempt.sessionId!);
  const truncated = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: attempt.id });
  expect(truncated.records[0].recorder!.truncated).toBe(true);
  expect(truncated.records[0].issues).toContain('recording_manifests_truncated');
  // 归属不一致的 manifest（模拟磁盘损坏改写）fail-closed，查询零写入。
  withDroppedTrigger(f, 'recording_manifests_immutable', () => {
    f.session.database.prepare("UPDATE recording_manifests SET attempt_id = 'ev-no-manifest' WHERE id = 'manifest-child-v1'").run();
  });
  const before = reportDatabaseSnapshot(f);
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: attempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state' });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:bounded-byte-time] 结果证据正文受字节与时间上限约束并返回可诊断原因', async () => {
  const { f, attempt, ref } = await evidenceFixture();
  const runId = attempt.runId;
  // 字节上限：超过 settlement 缓冲上限的正文拒绝读取（独立 Attempt，单次 set-once 引用）。
  const bigAttempt = reportAttempt(f, { id: 'ev-big-attempt', runId, taskId: 't-2', number: 2, status: 'succeeded' });
  const big = reportArtifact(f, 'ev-big', `sessions/${bigAttempt.sessionId}/runtime-settlement.json`,
    'x'.repeat(WORK_SESSION_SETTLEMENT_MAX_READ_BYTES + 1), 'runtime-settlement');
  f.session.database.prepare('UPDATE sessions SET result_ref = ? WHERE id = ?').run(big.artifactId, bigAttempt.sessionId);
  await expect(budgetQueries(f).getWorkSession(owner, { projectId: f.projectId, attemptId: bigAttempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_size_limit', artifactId: big.artifactId } });
  const page = await budgetQueries(f).listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: bigAttempt.id });
  expect(page.records[0].issues).toContain('result_evidence_body_size_limit');
  // 时间上限：推进时钟使有界读取超时，详情与证据读取分别给出 timeout 原因。
  const before = reportDatabaseSnapshot(f);
  await expect(budgetQueries(f, advancingClock()).getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'result_evidence_body_timeout', artifactId: ref.artifactId } });
  await expect(budgetQueries(f, advancingClock()).readWorkSessionEvidence(owner, { projectId: f.projectId, attemptId: attempt.id, artifactId: ref.artifactId }))
    .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'evidence_body_timeout', artifactId: ref.artifactId } });
  // 固定时钟不受影响（上限存在但不误伤正常读取）。
  expect((await budgetQueries(f).getWorkSession(owner, { projectId: f.projectId, attemptId: attempt.id })).resultEvidence)
    .toMatchObject({ kind: 'runtime-settlement' });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

/* ---------------- Work 记录正文（openBindingFixture 家族） ---------------- */

type RecordingFixture = Awaited<ReturnType<typeof recordingFixture>>;
async function recordingFixture() {
  const f = await openBindingFixture();
  try {
    const launch = f.claimAndLaunch('t-1');
    const attempt = launch.receipt.attempt;
    const identity = {
      projectId: f.projectId, sessionId: 'recording-session', runId: f.runId,
      attemptId: attempt.id, invocationId: launch.invocationId, executionVersion: attempt.executionVersion,
      owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, purpose: 'work' as const,
    };
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const created = sessions.createWorkSession({
      sessionId: identity.sessionId, projectId: identity.projectId,
      attemptId: identity.attemptId, owner: identity.owner, hostInstanceId: identity.hostInstanceId,
      executionVersion: identity.executionVersion, purpose: 'execution', runtime: 'fake', adapterVersion: '1',
    });
    const locator = 'sessions/recording-session/messages/1.json';
    const ref = { ...await publishReadyArtifact(f, { kind: 'session-recording', locator, content: '{"public":"body"}' }), locator };
    const { owner: _owner, hostInstanceId: _host, purpose: _purpose, ...recordIdentity } = identity;
    const message = {
      ...RECORDING_MESSAGE, ...recordIdentity, contentRef: ref, createdAtUtcMs: NOW,
      updatedAtUtcMs: NOW, occurredAtUtcMs: NOW, recordedAtUtcMs: NOW,
    };
    const manifest = {
      ...RECORDING_MANIFEST, ...recordIdentity, manifestRef: ref, watermark: 1,
      createdAtUtcMs: NOW, updatedAtUtcMs: NOW,
    };
    const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
    store.commitRecording({
      identity, expectedSessionRevision: created.session.revision, expectedManifestRevision: 0,
      messages: [message], manifest,
    });
    return { ...f, identity, message, manifest, ref };
  } catch (error) { f.close(); throw error; }
}

function recordingQueries(f: RecordingFixture, nowUtcMs: () => number = () => NOW) {
  const reads = createSqliteQueryStore(f.session);
  const stateStore = createSqliteStateStore(f.session);
  return createQueryService({
    projectReads: reads, snapshots: reads, eventReads: reads, stateStore,
    configurationService: createConfigurationService({ stateStore, capabilityCatalog: f.box.capabilityCatalog }),
    planReads: reads, executionBudgetReads: reads, scheduleReads: reads, workspaceReads: reads,
    workSessionReads: reads, taskEvidenceReads: reads, gitOperationReads: reads,
    featureDeliveryReads: reads, executionControlReads: reads,
    artifacts: createSqliteArtifactStore(f.session), artifactFiles: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    dataRootIdentity: computeDataRootIdentity(f.box.dataRoot), nowUtcMs,
  });
}

function recordingSnapshot(session: SqliteStorageSession) {
  const tables = session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: session.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
}

test('[case:recording-body-bounds] Work 记录正文缺失/篡改/超时返回稳定引用且查询零写入', async () => {
  const f = await recordingFixture();
  try {
    const q = recordingQueries(f);
    const input = { projectId: f.projectId, sessionId: f.identity.sessionId, artifactId: f.ref.artifactId };
    // 正常读取。
    expect(Buffer.from((await q.readWorkRecordingBody(owner, input)).content).toString()).toBe('{"public":"body"}');
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const placement = files.resolvePlacement({ projectId: f.projectId, artifactId: f.ref.artifactId, locator: f.ref.locator });
    const path = join(f.box.dataRoot, placement.finalRelativePath);
    const before = recordingSnapshot(f.session);
    // 缺失 → missing + 稳定制品引用。
    unlinkSync(path);
    await expect(q.readWorkRecordingBody(owner, input))
      .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_missing', artifactId: f.ref.artifactId } });
    // 篡改 → corrupt + 稳定制品引用。
    writeFileSync(path, 'x'.repeat(f.ref.sizeBytes));
    await expect(q.readWorkRecordingBody(owner, input))
      .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_corrupt', artifactId: f.ref.artifactId } });
    // 时间上限 → timeout + 稳定制品引用（先恢复原正文；正常时钟不受影响）。
    writeFileSync(path, '{"public":"body"}');
    expect((await q.readWorkRecordingBody(owner, input)).artifact.artifactId).toBe(f.ref.artifactId);
    await expect(recordingQueries(f, advancingClock()).readWorkRecordingBody(owner, input))
      .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_timeout', artifactId: f.ref.artifactId } });
    // 查询零写入：全表快照不变。
    expect(recordingSnapshot(f.session)).toEqual(before);
  } finally { f.close(); }
});

