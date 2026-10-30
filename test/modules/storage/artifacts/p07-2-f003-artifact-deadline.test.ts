import { createHash } from 'node:crypto';
import { existsSync, readFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createWorkRecordingPublisher } from '../../../../packages/core/src/application/work-recording-publish.ts';
import { createWorkRecordingProjection } from '../../../../packages/core/src/application/work-recording-projection.ts';
import { createSqliteWorkRecordingStore } from '../../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createArtifactPublisher, ArtifactPublishError } from '../../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../../packages/core/src/application/artifact-verify.ts';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { ArtifactFileError } from '../../../../packages/core/src/ports/artifact-files.ts';
import type { ArtifactFileOperationOptions, ArtifactFileStore, ArtifactStagingWrite } from '../../../../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { openEvidenceFixture } from '../../../helpers/p03-6/evidence-fixture.ts';

function gate<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
const body = Buffer.from('bounded artifact body');
const digest = createHash('sha256').update(body).digest('hex');

async function fixture() {
  const box = createTempSandbox('p07-artifact-deadline-');
  const db = openSqliteStorageSession({ path: join(box.path, 'state.db') });
  try {
    await migrateSqliteStorage(db);
    const state = createSqliteStateStore(db, { nowUtcMs: Date.now });
    const project = await state.createProject({ displayName: 'deadline fixture' });
    const artifacts = createSqliteArtifactStore(db, { nowUtcMs: Date.now });
    const files = createArtifactFileStore({ dataRoot: box.path });
    return {
      box, db, project, artifacts, files,
      input: { projectId: project.id, kind: 'recording', mediaType: 'text/plain', expectedHash: digest,
        locator: 'recording/body', content: [body] },
      publisher: (ports: ArtifactFileStore = files) => createArtifactPublisher({ artifacts, files: ports,
        limits: { maxSizeBytes: 4096, timeoutMs: 150 } }),
      close() { db.close(); box.cleanup(); },
    };
  } catch (error) { db.close(); box.cleanup(); throw error; }
}

type Boundary = 'next' | 'write' | 'drain' | 'finish' | 'publish';

/** Trusted test ports hold actual staging I/O. A release is explicit; no sleep/poll barrier. */
function barrier(raw: ArtifactFileStore, boundary: Boundary) {
  const entered = gate();
  const held = gate();
  const done = gate();
  let options: ArtifactFileOperationOptions | undefined;
  let target: ArtifactStagingWrite | undefined;
  let returned = false;
  let active = false;
  const enter = (): void => { active = true; entered.release(); };
  let ordinal = 0;
  const content: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({
    async next() {
      if (boundary === 'next' && ordinal === 0) {
        enter();
        await held.promise;
        done.release();
      }
      return ordinal++ === 0 ? { done: false, value: body } : { done: true, value: undefined };
    },
    async return() { returned = true; return { done: true, value: undefined }; },
  }) };
  const files: ArtifactFileStore = {
    ...raw,
    async openStagingWrite(key, control) {
      options = control;
      target = await raw.openStagingWrite(key, control);
      if (boundary === 'write') {
        const actual = target;
        const stream = new Writable({
          highWaterMark: 4096,
          write(chunk, _encoding, callback) {
            enter();
            void held.promise.then(() => {
              // A producer callback released after cancellation must not write old bytes.
              if (options?.signal?.aborted) callback();
              else actual.stream.write(chunk, callback);
              done.release();
            });
          },
          final(callback) { actual.stream.end(callback); },
        });
        return { relativePath: actual.relativePath, stream };
      }
      if (boundary === 'drain') {
        const original = target.stream.write.bind(target.stream);
        target.stream.write = ((...args: Parameters<typeof original>) => {
          original(...args);
          enter();
          void held.promise.then(() => { target!.stream.emit('drain'); done.release(); });
          return false;
        }) as typeof original;
      }
      return target;
    },
    async abortStaging(write) {
      if (write !== target) write.stream.destroy();
      const stopped = raw.abortStaging!(target!);
      // These trusted injected callbacks cannot acknowledge stop until released.
      if (boundary === 'write' || boundary === 'drain') await held.promise;
      return stopped;
    },
    async finishStaging(write, control) {
      if (boundary === 'finish') {
        enter();
        await held.promise;
      }
      try { return await raw.finishStaging(target ?? write, control); }
      finally { if (boundary === 'finish') done.release(); }
    },
    async publishStaging(staged, key, control) {
      if (boundary === 'publish') {
        enter();
        await held.promise;
      }
      try { return await raw.publishStaging(staged, key, control); }
      finally { if (boundary === 'publish') done.release(); }
    },
  };
  return { files, content, entered, release: () => held.release(), done: done.promise,
    dispose: async () => { held.release(); if (active) await done.promise; },
    get returned() { return returned; }, get target() { return target; }, get options() { return options; } };
}

async function waitForBarrier(entered: Promise<void>, result: Promise<unknown>): Promise<void> {
  await Promise.race([entered, result.then(value => { throw new Error(`publication ended before barrier: ${String(value)}`); })]);
}

const boundaries: Boundary[] = ['next', 'write', 'drain', 'finish', 'publish'];
const modes = ['timeout', 'cancel', 'release'] as const;
const matrix = boundaries.flatMap(boundary => modes.map(mode => ({ boundary, mode, id: `${boundary}-${mode}` })));

describe('P07-2 F-003 Artifact 等待期限', () => {
  test('[case:timer-range-validation] 拒绝会溢出 Node 定时器或字节计数的预算', () => {
    for (const limits of [
      { maxSizeBytes: 4096, timeoutMs: 2_147_483_648 },
      { maxSizeBytes: 4096, timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
      { maxSizeBytes: Number.MAX_SAFE_INTEGER + 1, timeoutMs: 1000 },
    ]) {
      expect(() => createArtifactPublisher({ artifacts: {} as never, files: {} as never, limits })).toThrow();
    }
  });

  test.each([{ boundary: 'finish' }, { boundary: 'publish' }])('[case:sync-$boundary-overrun] 同步 $boundary 边界阻塞定时器后也拒绝迟到结果', async ({ boundary }) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const files: ArtifactFileStore = { ...f.files,
      async finishStaging(write, options) {
        const result = await f.files.finishStaging(write, options);
        if (boundary === 'finish') vi.setSystemTime(options!.deadlineMs! + 1);
        return result;
      },
      async publishStaging(staged, key, options) {
        const result = await f.files.publishStaging(staged, key, options);
        if (boundary === 'publish') vi.setSystemTime(options!.deadlineMs! + 1);
        return result;
      },
    };
    try {
      const error = await f.publisher(files).publishArtifact(f.input).catch(error => error);
      expect(error.code).toBe('timeout');
      expect((await f.artifacts.getArtifact(f.project.id, error.artifactId)).status).toBe('failed');
      if (boundary === 'publish') expect(readFileSync(join(f.box.path, error.details.finalRelativePath))).toEqual(body);
      await expect(f.artifacts.getArtifactInputRef(f.project.id, error.artifactId)).rejects.toThrow();
    } finally { vi.useRealTimers(); f.close(); }
  });

  test.each(matrix)('[case:$id] $boundary 屏障的 $mode 与迟到结果隔离', async ({ boundary, mode }) => {
    const f = await fixture();
    const b = barrier(f.files, boundary);
    // Drive only publication timers; real fs streams and SQLite remain real.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const result = f.publisher(b.files).publishArtifact({ ...f.input, content: b.content, signal: controller.signal }).catch(error => error);
    try {
      await waitForBarrier(b.entered.promise, result);
      expect(existsSync(join(f.box.path, b.target!.relativePath))).toBe(true);
      if (mode === 'release') b.release();
      if (mode === 'cancel') controller.abort();
      if (mode !== 'release') await vi.advanceTimersByTimeAsync(400);
      const value = await result;
      if (mode === 'release') {
        expect(value.artifact.status).toBe('ready');
        expect(value.artifact.contentHash).toBe(digest);
        expect(value.artifact.sizeBytes).toBe(body.length);
        expect(readFileSync(join(f.box.path, value.finalRelativePath))).toEqual(body);
        expect(existsSync(join(f.box.path, b.target!.relativePath))).toBe(false);
      } else {
        expect(value).toBeInstanceOf(ArtifactPublishError);
        expect(value.code).toBe(mode === 'cancel' ? 'cancelled' : 'timeout');
        expect(b.options?.signal?.aborted).toBe(true);
        // The held producer/port has not acknowledged stop; a timeout alone is not proof.
        expect(value.cleanupStatus).toBe('cleanup_unconfirmed');
        const before = await f.artifacts.getArtifact(f.project.id, value.artifactId);
        expect(before.status).toBe('failed');
        expect(before.failureReason).toContain(`code=${value.code}`);
        expect(existsSync(join(f.box.path, value.details.stagingRelativePath))).toBe(true);
        b.release();
        await b.done;
        expect(await f.artifacts.getArtifact(f.project.id, value.artifactId)).toEqual(before);
        const key = { projectId: f.project.id, artifactId: value.artifactId };
        expect(existsSync(join(f.box.path, f.files.resolvePlacement(key).finalRelativePath))).toBe(false);
        await expect(f.artifacts.getArtifactInputRef(f.project.id, value.artifactId)).rejects.toThrow();
        const verifier = createArtifactVerifier({ artifacts: f.artifacts, files: f.files, limits: { maxReadBytes: 4096 } });
        expect((await verifier.verifyArtifact(f.project.id, value.artifactId)).kind).toBe('failed_evidence');
        if (boundary === 'next') expect(b.returned).toBe(true);
        await f.files.abortStaging!(b.target!);
        expect(b.target!.stream.closed).toBe(true);
        for (const event of ['drain', 'error', 'close', 'finish']) expect(b.target!.stream.listenerCount(event), event).toBe(0);
      }
    } finally { await b.dispose(); await result; vi.useRealTimers(); f.close(); }
  });

  test('[case:opened-handle-deadline] 打开文件后发现预算耗尽仍须关闭已取得的句柄', async () => {
    const f = await fixture();
    let clock = 0;
    let opened: ArtifactStagingWrite | undefined;
    const files: ArtifactFileStore = { ...f.files, async openStagingWrite(key, options) {
      opened = await f.files.openStagingWrite(key, options);
      clock = 1000;
      return opened;
    } };
    const publisher = createArtifactPublisher({ artifacts: f.artifacts, files,
      limits: { maxSizeBytes: 4096, timeoutMs: 150 }, nowMs: () => clock });
    try {
      const error = await publisher.publishArtifact(f.input).catch(error => error);
      expect(error.code).toBe('timeout');
      expect(error.cleanupStatus).toBe('confirmed');
      expect(opened!.stream.closed).toBe(true);
      expect(existsSync(join(f.box.path, opened!.relativePath))).toBe(true);
      expect(error.details.stagingRelativePath).toBe(opened!.relativePath);
    } finally { if (opened) await f.files.abortStaging!(opened); f.close(); }
  });

  test('[case:uninterruptible-late-publish] 忽略取消的旧发布端只能留下文件残留，核验不能将 failed 恢复 ready', async () => {
    const f = await fixture();
    const entered = gate(); const held = gate(); const done = gate();
    let finalPath = '';
    const files: ArtifactFileStore = { ...f.files, async publishStaging(staged, key) {
      entered.release(); await held.promise;
      try { const published = await f.files.publishStaging(staged, key); finalPath = published.relativePath; return published; }
      finally { done.release(); }
    } };
    const result = f.publisher(files).publishArtifact(f.input).catch(error => error);
    try {
      await waitForBarrier(entered.promise, result);
      const error = await result;
      expect(error.code).toBe('timeout');
      expect(error.cleanupStatus).toBe('cleanup_unconfirmed');
      expect(error.details.pendingOperations).toContain('staging.publish');
      held.release(); await done.promise;
      expect(readFileSync(join(f.box.path, finalPath))).toEqual(body);
      const verifier = createArtifactVerifier({ artifacts: f.artifacts, files: f.files, limits: { maxReadBytes: 4096 } });
      expect((await verifier.verifyArtifact(f.project.id, error.artifactId)).kind).toBe('failed_evidence');
      await expect(f.artifacts.getArtifactInputRef(f.project.id, error.artifactId)).rejects.toThrow();
    } finally { held.release(); await done.promise; await result; f.close(); }
  });

  test('[case:file-error-cleanup-unconfirmed] 保留文件原错、失败阶段和残留身份，不能被清理失败覆盖', async () => {
    const f = await fixture(); const held = gate(); const done = gate();
    const failure = new ArtifactFileError('io', 'finish', 'synthetic ENOSPC', { details: { code: 'ENOSPC' } });
    const files: ArtifactFileStore = { ...f.files,
      finishStaging: async () => { throw failure; },
      async abortStaging(write) { await held.promise; try { return await f.files.abortStaging!(write); } finally { done.release(); } },
    };
    try {
      const error = await f.publisher(files).publishArtifact(f.input).catch(error => error);
      expect(error.code).toBe('file'); expect(error.stage).toBe('staging'); expect(error.cause).toBe(failure);
      expect(error.cleanupStatus).toBe('cleanup_unconfirmed');
      const record = await f.artifacts.getArtifact(f.project.id, error.artifactId);
      expect(record.failureReason).toContain('ENOSPC');
      expect(record.failureReason).toContain('cleanup_unconfirmed');
      expect(existsSync(join(f.box.path, error.details.stagingRelativePath))).toBe(true);
      expect(JSON.stringify(error.details)).not.toContain(f.box.path);
    } finally { held.release(); await done.promise; f.close(); }
  });

  test('[case:write-error-before-drain] write 返回 true 后的异步错误仍保留原错并停止生产', async () => {
    const f = await fixture(); const failure = Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
    let raw: ArtifactStagingWrite | undefined;
    const files: ArtifactFileStore = { ...f.files,
      async openStagingWrite(key, options) {
        raw = await f.files.openStagingWrite(key, options);
        return { relativePath: raw.relativePath, stream: new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)); } }) };
      },
      async abortStaging(write) { write.stream.destroy(); return f.files.abortStaging!(raw!); },
    };
    try {
      const error = await f.publisher(files).publishArtifact(f.input).catch(error => error);
      expect(error.code).toBe('file'); expect(error.cause).toBe(failure);
      expect((await f.artifacts.getArtifact(f.project.id, error.artifactId)).status).toBe('failed');
    } finally { f.close(); }
  });

  test('[case:direct-file-finish-cancel] 直接文件端口等待 finish 时取消须关闭 fd 且保留 staging', async () => {
    const f = await fixture();
    const write = await f.files.openStagingWrite({ projectId: f.project.id, artifactId: 'direct-cancel' });
    const controller = new AbortController();
    const result = f.files.finishStaging(write, { signal: controller.signal, deadlineMs: Date.now() + 1000 }).catch(error => error);
    try {
      controller.abort();
      const error = await result;
      expect(error.details.reason).toBe('operation_cancelled');
      expect(await f.files.abortStaging!(write)).toEqual({ confirmed: true });
      expect(write.stream.closed).toBe(true);
      expect(existsSync(join(f.box.path, write.relativePath))).toBe(true);
      // Repeated finishing/aborting old handles must not close an unrelated, reused fd.
      const sentinel = openSync(join(f.box.path, 'sentinel'), 'w');
      try {
        await f.files.abortStaging!(write);
        await expect(f.files.finishStaging(write)).rejects.toThrow();
        writeSync(sentinel, 'still open');
      } finally { closeSync(sentinel); }
      expect(readFileSync(join(f.box.path, 'sentinel'), 'utf8')).toBe('still open');
      for (const event of ['drain', 'error', 'close', 'finish']) expect(write.stream.listenerCount(event)).toBe(0);
    } finally { await f.files.abortStaging!(write); f.close(); }
  });

  test('[case:projection-no-late-watermark] 发布超时后旧文件迟到，真实记录索引和水位保持不变', async () => {
    const f = await openEvidenceFixture({ script: { schemaVersion: 1, steps: [] } });
    const raw = createArtifactFileStore({ dataRoot: f.budget.box.dataRoot });
    const entered = gate(); const held = gate(); const done = gate();
    const files: ArtifactFileStore = { ...raw, async publishStaging(staged, key) {
      entered.release(); await held.promise;
      try { return await raw.publishStaging(staged, key); } finally { done.release(); }
    } };
    const artifacts = createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 4096, timeoutMs: 100 } });
    const publisher = createWorkRecordingPublisher({ artifacts,
      limits: { maxBodyBytes: 4096, maxAttachmentBytes: 4096, maxTotalBytes: 8192, maxChunkBytes: 1024, maxQueueBytes: 1024 } });
    const projection = createWorkRecordingProjection({ publisher, store: createSqliteWorkRecordingStore(f.budget.session) }, f.request, f.verifier);
    const event = { schemaVersion: 1 as const, kind: 'message' as const, sequence: 1, eventId: `${f.eventIdentityPrefix}1`,
      occurredAtUtc: '2026-10-30T00:00:00.000Z', payload: { kind: 'message' as const, messageId: 'm1', role: 'assistant' as const, preview: 'body' } };
    const snapshot = () => ({ messages: f.query('SELECT count(*) AS n FROM session_messages'),
      manifests: f.query('SELECT count(*) AS n FROM recording_manifests'),
      session: f.query('SELECT * FROM sessions WHERE id = ?', f.sessionId) });
    const before = snapshot();
    const result = projection.prepare([{ event, redacted: false }]).catch(error => error);
    try {
      await waitForBarrier(entered.promise, result);
      expect(await result).toBeInstanceOf(Error);
      expect(projection.gaps).toContain('publication_timeout');
      expect(projection.gaps).toContain('cleanup_unconfirmed');
      expect(projection.watermark).toBeNull();
      held.release(); await done.promise;
      expect(snapshot()).toEqual(before);
      expect(projection.watermark).toBeNull();
      expect(f.query("SELECT count(*) AS n FROM artifacts WHERE kind = 'message' AND status = 'ready'")).toEqual({ n: 0 });
    } finally { held.release(); await done.promise; await result; f.close(); }
  });
});
