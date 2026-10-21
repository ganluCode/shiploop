/**
 * P04-5 / F-007 Work 公开记录 Host 接线（真实 Host + 真实 SQLite + HostClient）。
 *
 * 验收面（.dag_context.json F-007）：
 * - HostClient/wire 按 Run/Attempt/Session 查询记录索引与有界正文：结构化结果
 *   展示来源/顺序/父子关系（公开哈希）、coverage、watermark、missingReasons
 *   与分页；公开行不携带 locator/内部路径；
 * - 非法游标、跨项目/外域引用、缺失正文、hash/size 不符与未授权请求返回稳定
 *   公开错误（invalid_cursor / not_found / corrupt_state / unauthorized），
 *   不泄漏绝对路径或凭据；
 * - 查询只读：不启动 Runtime（runtime_starts=0）、不写业务表、不触碰 SQLite
 *   写路径；记录覆盖度不折算为 Task 通过。
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, startHost, type HostClient, type RunningHost } from '../../../packages/host/src/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { openBindingFixture, publishReadyArtifact, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { RECORDING_MESSAGE, RECORDING_MANIFEST } from '../../helpers/p04-5/recording-fixture.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;

afterEach(async () => {
  client?.close(); client = undefined;
  if (host) {
    // 夹具注入的认领/占用是合成身份（从未真正启动进程）：关闭前显式退役，
    // 避免生产停止门控把持久占用当作未确认活动（同 p03-4 调度接线测试）。
    fixture?.session.transactWrite('fixture.retireSyntheticOccupancy', () => {
      fixture!.session.database.prepare('DELETE FROM workspace_leases').run();
    });
    await host.close(); host = undefined;
  }
  fixture?.close(); fixture = undefined;
});

async function openCase() {
  const f = await openBindingFixture();
  fixture = f;
  const launch = f.claimAndLaunch('t-1');
  const attempt = launch.receipt.attempt;
  const identity = { projectId: f.projectId, sessionId: 'recording-session', runId: f.runId,
    attemptId: attempt.id, invocationId: launch.invocationId, executionVersion: attempt.executionVersion };
  const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => 100 });
  const created = sessions.createWorkSession({ sessionId: identity.sessionId, projectId: identity.projectId,
    attemptId: identity.attemptId, owner: attempt.owner, hostInstanceId: attempt.hostInstanceId,
    executionVersion: identity.executionVersion, purpose: 'execution', runtime: 'fake', adapterVersion: '1' });
  const locator = 'sessions/recording-session/messages/1.json';
  const ref = { ...await publishReadyArtifact(f, { kind: 'session-recording', locator, content: '{"public":"body"}' }), locator };
  const messages = [
    { ...RECORDING_MESSAGE, ...identity, id: 'message-1', contentRef: ref, toolCallId: 'toolu_providerRaw', parentToolCallId: null,
      createdAtUtcMs: 100, updatedAtUtcMs: 100, occurredAtUtcMs: 100, recordedAtUtcMs: 101 },
    { ...RECORDING_MESSAGE, ...identity, id: 'message-2', sequence: 2, eventId: 'event-2', messageKey: 'key-2', contentRef: ref,
      createdAtUtcMs: 100, updatedAtUtcMs: 100, occurredAtUtcMs: 102, recordedAtUtcMs: 103 },
  ];
  const manifest = { ...RECORDING_MANIFEST, ...identity, manifestRef: ref, watermark: 2,
    createdAtUtcMs: 100, updatedAtUtcMs: 100 };
  const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => 100 });
  store.commitRecording({ identity: { ...identity, owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, purpose: 'work' },
    expectedSessionRevision: created.session.revision, expectedManifestRevision: 0, messages, manifest });
  host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
  client = await connectToHost({ canonicalRoot: f.box.dataRoot });
  return { f, identity, messages, manifest, ref };
}

describe('F-007 HostClient 记录索引与正文', () => {
  it('[case:host-recording-list] 按 Run/Attempt/Session 返回结构化公开行（工具身份为公开哈希）', async () => {
    const { f, identity } = await openCase();
    for (const parent of [{ runId: f.runId }, { attemptId: identity.attemptId }, { sessionId: identity.sessionId }]) {
      const page = await client!.listWorkRecordings(f.projectId, { ...parent, recordType: 'messages' });
      expect(page).toMatchObject({ scope: 'work-recording', recordType: 'messages', limit: 50, nextCursor: null });
      expect(page.records).toHaveLength(2);
      const first = page.records[0]!;
      expect('sequence' in first).toBe(true);
      if (!('sequence' in first)) throw new Error('expected message row');
      expect(first).toMatchObject({ id: 'message-1', sequence: 1, sessionId: identity.sessionId,
        source: 'live', watermark: 2, coverage: 'partial',
        contentRef: { artifactId: expect.any(String), sizeBytes: expect.any(Number) } });
      // 原始 provider 工具串不出现；公开行为派生哈希。
      expect(first.toolCallId).toMatch(/^[0-9a-f]{64}$/);
      expect(first.toolCallId).not.toBe('toolu_providerRaw');
      expect(JSON.stringify(page)).not.toContain('locator');
      expect(JSON.stringify(page)).not.toContain('toolu_providerRaw');
    }
    const manifests = await client!.listWorkRecordings(f.projectId, { sessionId: identity.sessionId, recordType: 'manifests' });
    expect(manifests.records).toHaveLength(1);
    const manifestRow = manifests.records[0]!;
    expect('version' in manifestRow).toBe(true);
    if (!('version' in manifestRow)) throw new Error('expected manifest row');
    expect(manifestRow).toMatchObject({ coverage: 'partial', watermark: 2, finalized: false });
  });

  it('[case:host-recording-pagination] 有界分页返回可跟进游标；非法/跨父级游标稳定拒绝', async () => {
    const { f, identity } = await openCase();
    const first = await client!.listWorkRecordings(f.projectId, { sessionId: identity.sessionId, recordType: 'messages', limit: 1 });
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^plcur_v1_/);
    const second = await client!.listWorkRecordings(f.projectId,
      { sessionId: identity.sessionId, recordType: 'messages', limit: 1, cursor: first.nextCursor! });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({ id: 'message-2' });
    expect(second.nextCursor).toBeNull();

    // 客户端本地稳定拒绝非法字符游标；字符集合法但签名/绑定错误的游标由 Core 拒绝。
    await expect(client!.listWorkRecordings(f.projectId,
      { sessionId: identity.sessionId, recordType: 'messages', cursor: 'plcur_v1_@@@' }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    const tampered = first.nextCursor!.slice(0, -2)
      + (first.nextCursor!.endsWith('AA') ? 'BB' : 'AA');
    const tamperedError = await client!.listWorkRecordings(f.projectId,
      { sessionId: identity.sessionId, recordType: 'messages', cursor: tampered })
      .then(() => { throw new Error('expected cursor rejection'); }, error => error as { code: string });
    // 篡改游标始终以稳定公开错误拒绝（结构或绑定层面），不回显内容。
    expect(['invalid_input', 'invalid_cursor']).toContain(tamperedError.code);
    // 游标绑定父级：Session 父级页的游标在 Attempt 父级请求上重放被拒
    //（Core 约定：invalid_input + reason=invalid_cursor，同 sessions 列表）。
    await expect(client!.listWorkRecordings(f.projectId,
      { attemptId: identity.attemptId, recordType: 'messages', cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
  });

  it('[case:host-recording-body] 正文按父级读取且 hash/size 经 wire 复核；外域制品折叠 not_found', async () => {
    const { f, identity, ref } = await openCase();
    for (const parent of [{ attemptId: identity.attemptId }, { sessionId: identity.sessionId }]) {
      const body = await client!.readWorkRecordingBody(f.projectId, { ...parent, artifactId: ref.artifactId });
      expect(Buffer.from(body.content).toString('utf8')).toBe('{"public":"body"}');
      expect(body.artifact).toMatchObject({ artifactId: ref.artifactId, sizeBytes: ref.sizeBytes });
      expect(body).not.toHaveProperty('artifact.locator');
    }
    await expect(client!.readWorkRecordingBody(f.projectId,
      { sessionId: identity.sessionId, artifactId: 'artifact-unknown' }))
      .rejects.toMatchObject({ code: 'not_found' });
    // 跨项目/外域父级引用统一 not_found，不区分存在性。
    await expect(client!.listWorkRecordings(f.projectId, { runId: '0d0f6a93-4d92-4ae3-bdf3-aec76e5cd977', recordType: 'messages' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(client!.readWorkRecordingBody(f.projectId,
      { sessionId: 'other-session', artifactId: ref.artifactId }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('[case:host-recording-integrity] 缺失正文与 hash/size 不符返回稳定 corrupt_state 而不修复', async () => {
    const { f, identity, ref } = await openCase();
    const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const placement = files.resolvePlacement({ projectId: f.projectId, artifactId: ref.artifactId, locator: ref.locator });
    const path = join(f.box.dataRoot, placement.finalRelativePath);
    const bodyInput = { sessionId: identity.sessionId, artifactId: ref.artifactId };

    writeFileSync(path, 'x'.repeat(ref.sizeBytes));
    await expect(client!.readWorkRecordingBody(f.projectId, bodyInput))
      .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_corrupt' } });
    unlinkSync(path);
    const missing = await client!.readWorkRecordingBody(f.projectId, bodyInput).then(
      () => { throw new Error('expected corrupt_state rejection'); },
      error => error as unknown);
    expect(missing).toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_missing' } });
    // 公开错误不含绝对路径或 locator。
    const leaked = JSON.stringify(missing);
    expect(leaked).not.toContain(f.box.dataRoot);
    expect(leaked).not.toContain(ref.locator);
  });

  it('[case:host-recording-auth] 未授权请求 401；查询串白名单与非法 recordType 稳定拒绝', async () => {
    const { f, identity } = await openCase();
    const token = readFileSync(join(f.box.dataRoot, 'host', 'auth.token'), 'utf8');
    const anonymous = await loopbackRequest({ port: host!.port, method: 'GET',
      path: `/v1/work-recordings?projectId=${f.projectId}&sessionId=${identity.sessionId}&recordType=messages` });
    expect(anonymous.statusCode).toBe(401);
    expect((anonymous.json() as { error: { code: string } }).error.code).toBe('unauthorized');

    const unknownParam = await loopbackRequest({ port: host!.port, method: 'GET', token,
      path: `/v1/work-recordings?projectId=${f.projectId}&sessionId=${identity.sessionId}&recordType=messages&bogus=1` });
    expect(unknownParam.statusCode).toBe(400);
    expect((unknownParam.json() as { error: { details: { reason: string } } }).error.details.reason).toBe('unknown_query_parameter');

    const badRecordType = await loopbackRequest({ port: host!.port, method: 'GET', token,
      path: `/v1/work-recordings?projectId=${f.projectId}&sessionId=${identity.sessionId}&recordType=everything` });
    expect(badRecordType.statusCode).toBe(400);
    expect((badRecordType.json() as { error: { code: string } }).error.code).toBe('invalid_input');

    const missingParent = await loopbackRequest({ port: host!.port, method: 'GET', token,
      path: `/v1/work-recordings?projectId=${f.projectId}&recordType=messages` });
    expect(missingParent.statusCode).toBe(400);

    const bodyMissingArtifact = await loopbackRequest({ port: host!.port, method: 'GET', token,
      path: `/v1/work-recordings/body?projectId=${f.projectId}&sessionId=${identity.sessionId}` });
    expect(bodyMissingArtifact.statusCode).toBe(400);
  });

  it('[case:host-recording-readonly] 查询不启动 Runtime、不写业务表', async () => {
    const { f, identity } = await openCase();
    const before = {
      runtimeStarts: (f.query('SELECT runtime_starts AS n FROM execution_batches') as { n: number }).n,
      attempts: (f.query('SELECT count(*) AS n FROM attempts') as { n: number }).n,
      messages: (f.query('SELECT count(*) AS n FROM session_messages') as { n: number }).n,
      sessions: (f.query('SELECT count(*) AS n FROM sessions') as { n: number }).n,
    };
    await client!.listWorkRecordings(f.projectId, { runId: f.runId, recordType: 'messages' });
    await client!.listWorkRecordings(f.projectId, { sessionId: identity.sessionId, recordType: 'manifests', limit: 1 });
    const messagePage = await client!.listWorkRecordings(f.projectId, { attemptId: identity.attemptId, recordType: 'messages', limit: 1 });
    const messageRow = messagePage.records[0]!;
    if (!('sequence' in messageRow)) throw new Error('expected message row');
    expect(Buffer.from((await client!.readWorkRecordingBody(f.projectId,
      { attemptId: identity.attemptId, artifactId: messageRow.contentRef.artifactId })).content)
      .toString('utf8')).toBe('{"public":"body"}');
    expect(f.query('SELECT runtime_starts AS n FROM execution_batches')).toEqual({ n: before.runtimeStarts });
    expect(f.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: before.attempts });
    expect(f.query('SELECT count(*) AS n FROM session_messages')).toEqual({ n: before.messages });
    expect(f.query('SELECT count(*) AS n FROM sessions')).toEqual({ n: before.sessions });
  });
});
