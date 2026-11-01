/**
 * P07-5 / F-006：原生档案单写入者与来源不可变性验收（离线，不调用模型）。
 *
 * 以两个真实受控写入者子进程 + 文件屏障争用同一原生来源/目标：
 * 1. [case:p07-f006-second-writer-stop-unconfirmed] 旧写入者持有 scope 且停止
 *    未确认时，真实第二写入者打开同一目录被拒（native_writer_scope_unavailable），
 *    恢复准入（preparePiRecovery）对未确认停止同样拒绝 source_stop_unconfirmed；
 * 2. [case:p07-f006-post-stop-managed-fork] 旧写入者确认停止后，仅经受管安全
 *    复制/分支在全新目录续接：来源摘要不变、source.jsonl 只写一次（0o400）、
 *    新会话身份不同、来源文件字节不变，且已占用目录永不复用；
 * 3. [case:p07-f006-two-writers-barrier] 双写入者屏障争用同一全新目标：屏障
 *    证明第一写入者活跃时第二写入者被拒，第一写入者干净退出后该 scope 依然
 *    永不复用（新尝试必须使用新目录）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PiRecoveryWriterLease } from '../../../../packages/host/src/runtime/pi-adapter.ts';
import { preparePiRecovery } from '../../../../packages/host/src/runtime/pi-native-session.ts';
import type { ExecutionInputRef, RuntimeExecutionRequest, RuntimeRecoveryReference } from '../../../../packages/core/src/index.ts';
import { PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION, PI_SDK_VERSION } from '../../../../packages/host/src/runtime/pi-adapter.ts';

const REGISTER = fileURLToPath(new URL('../../../helpers/node-ts-loader/register.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('../../../helpers/runtime-recovery/native-writer-child.ts', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

interface HeldWriter {
  readonly dir: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  release(): Promise<{ signal: NodeJS.Signals | null; code: number | null }>;
}

/** 启动真实受控写入者并在 ready 屏障上等待其持有原生 scope（不固定 sleep）。 */
async function holdWriter(cwd: string, dir: string): Promise<HeldWriter> {
  const readyFile = join(cwd, `${Math.random().toString(36).slice(2)}.ready.json`);
  const releaseFile = join(cwd, `${Math.random().toString(36).slice(2)}.release`);
  const child = spawn(process.execPath, ['--import', REGISTER, CHILD, 'hold', cwd, dir, readyFile, releaseFile],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const failure: string[] = [];
  child.stdout.on('data', chunk => failure.push(String(chunk)));
  child.stderr.on('data', chunk => failure.push(String(chunk)));
  const waitReady = async (): Promise<{ sessionId: string; sessionFile: string }> => {
    for (;;) {
      try { return JSON.parse(await readFile(readyFile, 'utf8')) as { sessionId: string; sessionFile: string }; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
  };
  const ready = await Promise.race([
    waitReady(),
    new Promise<never>((_, reject) => {
      child.on('exit', () => reject(new Error(`hold writer exited before ready: ${failure.join('')}`)));
      setTimeout(() => reject(new Error('hold writer ready timeout')), 60_000).unref();
    }),
  ]);
  return { dir, sessionId: ready.sessionId, sessionFile: ready.sessionFile,
    release: async () => {
      await writeFile(releaseFile, 'go\n');
      return await new Promise(resolve => child.on('exit', (code, signal) => resolve({ signal, code })));
    } };
}

function runChild(...args: string[]) {
  return spawnSync(process.execPath, ['--import', REGISTER, CHILD, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function artifact(id: string, bytes: Uint8Array): ExecutionInputRef {
  return { projectId: 'project-1', artifactId: id, kind: 'runtime-native-archive', purpose: 'recovery',
    version: 1, contentHash: digest(bytes), sizeBytes: bytes.byteLength, locator: `sessions/${id}`,
    mediaType: 'application/x-ndjson', origin: { kind: 'file', root: 'data', relativePath: `sessions/${id}` } };
}

function executionRequest(source: RuntimeRecoveryReference): RuntimeExecutionRequest {
  const input: ExecutionInputRef = { ...artifact('input', Buffer.from('input')), mediaType: 'text/plain' };
  return { schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-new',
    invocationId: 'invocation-new', executionVersion: 2,
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    prompt: input, inputManifest: input, cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 100, maxOutputBytes: 100_000 },
    recovery: { mode: 'required', kind: 'conversation', source } };
}

/** 受控租约：字节仅来自制品读取器（绝无原生路径）；记录读取顺序供断言。 */
function leaseWithReads(source: RuntimeRecoveryReference, archive: Uint8Array, stopConfirmed: boolean) {
  const workSource = source as RuntimeRecoveryReference & { sourceAttemptId: string };
  const workIdentity = { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' };
  const stopBytes = Buffer.from('{"confirmed":true}');
  const stop: ExecutionInputRef = { ...artifact('stop-old', stopBytes), kind: 'recovery-stop', mediaType: 'application/json' };
  const archiveRef = artifact('archive-old', archive);
  const reads: string[] = [];
  const request = executionRequest(source);
  const value: PiRecoveryWriterLease = {
    source: { reference: source, archive: archiveRef, sdkVersion: PI_SDK_VERSION,
      previousWriter: { status: (stopConfirmed ? 'confirmed' : 'unknown') as 'confirmed', stopEvidence: stop } },
    sourceReadOnly: true,
    authority: { projectId: request.projectId, featureId: request.featureId, taskId: workIdentity.taskId,
      taskStatus: 'unfinished', previousAttemptId: workSource.sourceAttemptId, previousSessionId: workSource.sourceSessionId },
    writer: { purpose: 'work', attemptId: workIdentity.attemptId, invocationId: request.invocationId,
      sessionId: request.sessionId, executionVersion: request.executionVersion, owner: request.owner, exclusive: true },
    assertCurrent: async () => {},
    readVerifiedArtifact: async ref => {
      reads.push(ref.artifactId);
      if (ref.artifactId === 'archive-old') return archive;
      if (ref.artifactId === 'stop-old') return stopBytes;
      throw new Error(`unexpected artifact: ${ref.artifactId}`);
    },
    release: async () => {},
  };
  return { value, reads };
}

function recoveryReference(archive: Uint8Array, providerSessionId: string): RuntimeRecoveryReference {
  const archiveRef = artifact('archive-old', archive);
  return { schemaVersion: 1, purpose: 'work', kind: 'conversation',
    sourceProjectId: 'project-1', sourceSessionId: 'session-old', sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old',
    runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5', providerSessionId,
    nativeArchiveRef: archiveRef.artifactId, nativeFormat: PI_NATIVE_SESSION_FORMAT,
    nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION, sourceDigest: archiveRef.contentHash };
}

describe('P07-5 F-006 native archive single writer', () => {
  it('[case:p07-f006-second-writer-stop-unconfirmed] 拒绝未确认停止的第二写入者并保留来源', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-writer-'));
    roots.push(root);
    const writer = await holdWriter(root, join(root, 'old-attempt'));
    try {
      /* 屏障证明旧写入者仍存活并持有原生 scope；真实第二写入者进程打开同一目录被拒。 */
      const second = runChild('try-open', root, join(root, 'old-attempt'));
      expect(second.status).toBe(1);
      expect(second.stdout).toContain('rejected:native_writer_scope_unavailable');

      /* 恢复准入在停止未确认时同样拒绝第二写入者，且不读取来源正文。 */
      const archive = new Uint8Array(await readFile(writer.sessionFile));
      const source = recoveryReference(archive, writer.sessionId);
      const unconfirmed = leaseWithReads(source, archive, false);
      await expect(preparePiRecovery(executionRequest(source), source, unconfirmed.value))
        .rejects.toMatchObject({ reason: 'source_stop_unconfirmed' });
      expect(unconfirmed.reads).toEqual([]);
      expect(digest(new Uint8Array(await readFile(writer.sessionFile)))).toBe(digest(archive));
    } finally {
      await writer.release();
    }
  }, 90_000);

  it('[case:p07-f006-post-stop-managed-fork] 确认停止后仅受管安全复制续接且来源摘要不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-fork-'));
    roots.push(root);
    const writer = await holdWriter(root, join(root, 'old-attempt'));
    const exit = await writer.release();
    expect(exit.code).toBe(0);
    const archive = new Uint8Array(await readFile(writer.sessionFile));
    const sourceDigest = digest(archive);
    const source = recoveryReference(archive, writer.sessionId);
    const confirmed = leaseWithReads(source, archive, true);
    const request = executionRequest(source);

    /* 受管准备：字节来自制品读取器（先停止证据、后来源正文），本地事实不含 Core 结算声明。 */
    const prepared = await preparePiRecovery(request, source, confirmed.value);
    expect(confirmed.reads).toEqual(['stop-old', 'archive-old']);
    expect(prepared.nativeWatermark).toMatchObject({ lastEntryId: expect.any(String) });
    expect(Object.keys(prepared).sort()).toEqual(['archive', 'assertCurrent', 'nativeWatermark', 'reference']);

    /* 真实子进程经受管安全复制/分支在全新目录续接：来源摘要不变、副本只写一次。 */
    const fork = runChild('fork', root, join(root, 'new-attempt'), writer.sessionFile);
    expect(fork.status).toBe(0);
    expect(fork.stdout).toMatch(/^forked:/);
    const forkedId = fork.stdout.trim().split(':')[1];
    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(writer.sessionId);

    const sourceCopy = join(root, 'new-attempt', 'source.jsonl');
    const copyBytes = new Uint8Array(await readFile(sourceCopy));
    expect(digest(copyBytes)).toBe(sourceDigest);
    expect((await stat(sourceCopy)).mode & 0o777).toBe(0o400);
    expect(digest(new Uint8Array(await readFile(writer.sessionFile)))).toBe(sourceDigest);

    /* 占用过的目录永不复用：同一目标再次分支、旧目录重开均被拒。 */
    const refork = runChild('fork', root, join(root, 'new-attempt'), writer.sessionFile);
    expect(refork.status).toBe(1);
    expect(refork.stdout).toContain('rejected:native_writer_scope_unavailable');
    const reopen = runChild('try-open', root, join(root, 'old-attempt'));
    expect(reopen.status).toBe(1);
    expect(reopen.stdout).toContain('rejected:native_writer_scope_unavailable');
    expect(digest(new Uint8Array(await readFile(writer.sessionFile)))).toBe(sourceDigest);
  }, 90_000);

  it('[case:p07-f006-two-writers-barrier] 双写入者屏障争用同一目标且 scope 永不复用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shiploop-p07f006-race-'));
    roots.push(root);
    const target = join(root, 'contended-attempt');
    const winner = await holdWriter(root, target);
    try {
      const loser = runChild('try-open', root, target);
      expect(loser.status).toBe(1);
      expect(loser.stdout).toContain('rejected:native_writer_scope_unavailable');
    } finally {
      const exit = await winner.release();
      expect(exit.code).toBe(0);
    }
    /* 第一写入者干净退出（停止已确认）后，该 scope 依然只认一次，不得复用。 */
    const afterCleanExit = runChild('try-open', root, target);
    expect(afterCleanExit.status).toBe(1);
    expect(afterCleanExit.stdout).toContain('rejected:native_writer_scope_unavailable');
  }, 90_000);
});
