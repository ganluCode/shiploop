/** Direct fd ownership in the actual writer. Import does not load native code or perform I/O. */
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { HostProtocolError, LOCK_ACQUIRE_TIMEOUT_MS, validateHandshakeResponse } from '../contract/index.js';
import type { HostDiscoveryRecord } from '../contract/index.js';
import { createHostFileStore, writerLockPathOf } from '../storage/index.js';

const OPERATION = 'host.discovery';
const RELATIVE_PATH = 'host/writer.lock';
interface NativeLock { tryLock(fd: number): boolean }

export interface WriterLockOptions {
  readonly canonicalRoot: string;
  /** Internal bounded budget: 0 is a single nonblocking attempt. */
  readonly timeoutMs?: number;
  readonly platform?: string;
  /** Trusted assembly/test injection only. Never supplied via argv, discovery or environment. */
  readonly nativeAddonPath?: string;
  /**
   * Trusted transport port: authenticate using protected token, no redirects, finite I/O,
   * honour signal. Return ONLY a successful authenticated handshake body, otherwise reject.
   * No probe means owner_unknown, never infer owner_active from PID or discovery alone.
   */
  readonly ownerProbe?: (discovery: HostDiscoveryRecord, token: string, signal: AbortSignal) => Promise<unknown>;
}
export interface WriterLock {
  readonly canonicalRoot: string;
  /** Assembly-only primitive. Preconditions: all writes closed AND instance cleanup finished. */
  releaseAfterWritesClosed(): void;
}

function failure(code: 'invalid_input' | 'unsupported_platform' | 'unsafe_discovery' | 'internal', reason: string) {
  return new HostProtocolError(code, OPERATION, '无法安全取得 Host 写入锁', {
    details: { relativePath: RELATIVE_PATH, reason },
  });
}

function loadNative(path?: string): NativeLock {
  const filename = path ?? fileURLToPath(new URL('../../dist/native/writer-lock.node', import.meta.url));
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0')) {
    throw failure('invalid_input', 'invalid_native_addon_path');
  }
  try {
    // Artifact, not a cross-package source import. dlopen happens only on explicit acquisition.
    const nativeModule = { exports: {} } as NodeJS.Module;
    process.dlopen(nativeModule, filename);
    const api = nativeModule.exports as NativeLock;
    if (typeof api.tryLock !== 'function') throw new Error('invalid native API');
    return api;
  } catch {
    throw failure('unsupported_platform', 'native_lock_unavailable');
  }
}

/** Attempts a real OS lock before allowing any writer factory to execute. Never unlinks lock file. */
export async function acquireWriterLock(options: WriterLockOptions): Promise<WriterLock> {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['canonicalRoot', 'timeoutMs', 'platform', 'nativeAddonPath', 'ownerProbe'].includes(key)) ||
      typeof options.canonicalRoot !== 'string' || !isAbsolute(options.canonicalRoot) ||
      options.canonicalRoot === '/' || options.canonicalRoot.includes('\0')) {
    throw failure('invalid_input', 'invalid_lock_options');
  }
  if (process.platform !== 'darwin' || (options.platform ?? process.platform) !== 'darwin') {
    throw failure('unsupported_platform', 'platform_not_darwin');
  }
  const timeoutMs = options.timeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > LOCK_ACQUIRE_TIMEOUT_MS) {
    throw failure('invalid_input', 'invalid_lock_budget');
  }
  if (options.ownerProbe !== undefined && typeof options.ownerProbe !== 'function') {
    throw failure('invalid_input', 'invalid_owner_probe');
  }
  const started = performance.now();
  const deadline = started + timeoutMs;
  const native = loadNative(options.nativeAddonPath);
  const store = createHostFileStore({ canonicalRoot: options.canonicalRoot });
  // Lock needs its protected parent. Only host/ and the lock target may be created before lock.
  store.ensureHostDir();
  const lockPath = writerLockPathOf(store.canonicalRoot);
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw failure(code === 'ELOOP' || code === 'EISDIR' ? 'unsafe_discovery' : 'internal', 'lock_open_failed');
  }
  let acquired = false;
  try {
    const assertTarget = () => {
      store.ensureHostDir();
      const actual = fstatSync(fd); const target = lstatSync(lockPath);
      if (!actual.isFile() || !target.isFile() || target.isSymbolicLink() || actual.nlink !== 1 ||
          (actual.mode & 0o777) !== 0o600 || actual.uid !== process.getuid!() ||
          actual.dev !== target.dev || actual.ino !== target.ino) {
        throw failure('unsafe_discovery', 'lock_target_unsafe');
      }
    };
    let probed = false;
    do {
      assertTarget();
      let locked: boolean;
      try { locked = native.tryLock(fd); }
      catch { throw failure('internal', 'lock_syscall_failed'); }
      if (locked) {
        assertTarget();
        acquired = true;
        let released = false;
        return Object.freeze({
          canonicalRoot: store.canonicalRoot,
          releaseAfterWritesClosed() {
            if (!released) { closeSync(fd); released = true; }
          },
        });
      }
      if (!probed && options.ownerProbe && performance.now() < deadline) {
        probed = true;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let active: HostDiscoveryRecord | undefined;
        try {
          const discovery = store.readTrustedDiscovery(); const token = store.readTrustedAuthToken();
          const input = await Promise.race([
            Promise.resolve().then(() => options.ownerProbe!(discovery, token, controller.signal)),
            new Promise((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error('owner probe deadline')); },
                Math.max(0, Math.min(1_000, deadline - performance.now())));
            }),
          ]);
          validateHandshakeResponse(input, {
            expectedHostInstanceId: discovery.hostInstanceId,
            expectedDataRootIdentity: store.dataRootIdentity,
          });
          active = discovery;
        } catch {
          // Untrusted response/errors may contain secrets. Do not retain or echo them.
        } finally { clearTimeout(timer); controller.abort(); }
        if (active) {
          throw new HostProtocolError('owner_active', OPERATION, '已有可认证的 Host 持有写入锁', {
            details: { reason: 'authenticated_owner', hostInstanceId: active.hostInstanceId, dataRootIdentity: store.dataRootIdentity },
          });
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await delay(Math.min(25, remaining));
    } while (performance.now() < deadline);
    throw new HostProtocolError('owner_unknown', OPERATION, '写入锁被占用，无法核验当前实例；拒绝接管', {
      details: { reason: 'lock_busy_owner_unverified', dataRootIdentity: store.dataRootIdentity },
    });
  } catch (error) {
    if (error instanceof HostProtocolError) throw error;
    throw failure('internal', 'lock_io_failed');
  } finally {
    if (!acquired) closeSync(fd);
  }
}

export interface ClosableWriter { close(): void | Promise<void> }
export interface LockedWriter<T extends ClosableWriter> {
  readonly writer: T;
  /** Close writer -> optional held-lock instance cleanup -> release. Failure retains lock. */
  close(cleanup?: () => void | Promise<void>): Promise<void>;
}

/** F-006 assembly seam. Only this factory callback may open Core/migrate after acquisition.
 * If opening partially succeeds then fails, the factory must close its partial resources.
 */
export async function openLockedWriter<T extends ClosableWriter>(
  options: WriterLockOptions,
  openWriter: () => T | Promise<T>,
): Promise<LockedWriter<T>> {
  const lock = await acquireWriterLock(options);
  let writer: T;
  try { writer = await openWriter(); }
  catch (error) { lock.releaseAfterWritesClosed(); throw error; }
  let closed = false;
  let writerClosed = false;
  let inFlight: Promise<void> | undefined;
  let finalizer: (() => void | Promise<void>) | undefined;
  return Object.freeze({
    writer,
    close(cleanup?: () => void | Promise<void>): Promise<void> {
      if (closed) return Promise.resolve();
      if (inFlight) return inFlight;
      finalizer ??= cleanup;
      inFlight = (async () => {
        if (!writerClosed) { await writer.close(); writerClosed = true; }
        await finalizer?.();
        lock.releaseAfterWritesClosed(); closed = true;
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  });
}
