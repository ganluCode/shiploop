/**
 * F-003 受保护 Host 文件存储回归（真实临时文件，无 mock、无网络、无子进程）。
 *
 * 协议依据（唯一）：docs/p02-1-host-lifecycle-contract.md
 * - §3.1/§3.2 规范数据根（realpath 固定）与 dataRootIdentity；
 * - §3.3 host/ 0700、discovery.json/auth.token 0600、writer.lock 布局与
 *   fail-closed 权限/属主/符号链接矩阵；
 * - §4.2 密码学随机凭据，错误/日志不含凭据；
 * - §5.1/§5.2 发现唯一允许形态、原子发布与读取信任条件；
 * - §10.5 按实例清理（核对 hostInstanceId；绝不删除 writer.lock）。
 *
 * F-003 不实现 OS 锁（F-004）与启动入口（F-006）：本套件只验证存储层在真实
 * 文件系统上的保护语义。默认数据根规则复用 P01 的 deriveDefaultDataRoot
 * （从 core 源码导入；测试按仓库约定只导入源文件、不导入工作区包名）。
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveDefaultDataRoot } from '../packages/core/src/index.ts';
import {
  AUTH_TOKEN_FILE_NAME,
  DISCOVERY_FILE_NAME,
  HOST_DIR_NAME,
  WRITER_LOCK_FILE_NAME,
  computeDataRootIdentity,
  createHostFileStore,
  isHostProtocolError,
  resolveCanonicalDataRoot,
  type HostDiscoveryRecord,
} from '../packages/host/src/index.ts';
import { withTempSandbox } from './helpers/temp-sandbox.ts';

/** 构造一条结构合法的发现记录（身份默认指向给定数据根身份）。 */
function makeRecord(dataRootIdentity: string, overrides: Record<string, unknown> = {}): HostDiscoveryRecord {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    hostInstanceId: randomUUID(),
    dataRootIdentity,
    listenAddress: '127.0.0.1',
    port: 54_321,
    pid: 48_210,
    startedAt: '2026-10-05T00:20:00.000Z',
    ...overrides,
  } as HostDiscoveryRecord;
}

/** 在沙箱内建立一个已解析的规范根与其文件存储。 */
function makeStore(sandboxRoot: string, name = 'data') {
  const candidate = join(sandboxRoot, name);
  mkdirSync(candidate);
  const resolved = resolveCanonicalDataRoot({ dataRoot: candidate });
  const store = createHostFileStore({ canonicalRoot: resolved.canonicalRoot });
  return { store, ...resolved };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function listTmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
}

/** 把错误的消息与 details 序列化，用于脱敏断言（不得含绝对路径/凭据/原文）。 */
function errorText(error: unknown): string {
  if (!isHostProtocolError(error)) {
    throw new Error(`预期 HostProtocolError，实际收到：${String(error)}`);
  }
  return `${error.message}|${JSON.stringify(error.toErrorBody())}|${JSON.stringify(error.details ?? {})}`;
}

describe('F-003 规范数据根解析（§3.1/§3.2）', () => {
  it('显式根经 realpath 固定；同根路径别名获得相同规范根与数据根身份', () => {
    withTempSandbox((root) => {
      const candidate = join(root, 'data');
      mkdirSync(candidate);
      const real = realpathSync(candidate);
      // macOS 上 /var→/private/var 等前缀符号链接使 mkdtemp 结果通常不是 realpath；
      // 构造一个必然不同的别名（加上或去掉 /private 前缀）。
      const alias =
        real === candidate
          ? real.startsWith('/private/')
            ? real.slice('/private'.length)
            : `/private${real}`
          : candidate;

      const a = resolveCanonicalDataRoot({ dataRoot: candidate });
      const b = resolveCanonicalDataRoot({ dataRoot: alias });
      expect(a.canonicalRoot).toBe(real);
      expect(b.canonicalRoot).toBe(real);
      expect(a.dataRootIdentity).toBe(b.dataRootIdentity);
      expect(a.dataRootIdentity).toBe(computeDataRootIdentity(real));
    });
  });

  it('不同实际根获得不同数据根身份', () => {
    withTempSandbox((root) => {
      const { dataRootIdentity: idA } = makeStore(root, 'a');
      const { dataRootIdentity: idB } = makeStore(root, 'b');
      expect(idA).not.toBe(idB);
    });
  });

  it('默认根复用 P01 deriveDefaultDataRoot 推导形态，createIfMissing 时以 0700 创建', () => {
    withTempSandbox((root) => {
      const fakeHome = join(root, 'home');
      mkdirSync(fakeHome);
      const defaultRoot = deriveDefaultDataRoot(fakeHome);
      expect(defaultRoot.endsWith('/Library/Application Support/shiploop')).toBe(true);

      const resolved = resolveCanonicalDataRoot({ defaultDataRoot: defaultRoot, createIfMissing: true });
      expect(resolved.canonicalRoot).toBe(realpathSync(defaultRoot));
      expect(modeOf(resolved.canonicalRoot)).toBe(0o700);
      expect(resolved.dataRootIdentity).toBe(computeDataRootIdentity(realpathSync(defaultRoot)));
    });
  });

  it('拒绝相对路径、空值、NUL、文件系统根与来源歧义', () => {
    withTempSandbox((root) => {
      const candidate = join(root, 'data');
      mkdirSync(candidate);
      const bad: Array<Record<string, unknown>> = [
        { dataRoot: 'relative/path' },
        { dataRoot: '' },
        { dataRoot: 'a\0b' },
        { dataRoot: '/' },
        { defaultDataRoot: 'relative' },
        {},
        { dataRoot: candidate, defaultDataRoot: candidate },
        { dataRoot: 123 },
      ];
      for (const options of bad) {
        expect(() => resolveCanonicalDataRoot(options), JSON.stringify(options)).toThrowError(
          expect.objectContaining({ code: 'invalid_input' }),
        );
      }
    });
  });

  it('createIfMissing=false 时缺失根返回 host_not_found（status/stop 不创建根）；根本身是文件被拒绝', () => {
    withTempSandbox((root) => {
      const missing = join(root, 'missing');
      expect(() => resolveCanonicalDataRoot({ dataRoot: missing })).toThrowError(
        expect.objectContaining({ code: 'host_not_found' }),
      );
      const file = join(root, 'a-file');
      writeFileSync(file, 'x');
      expect(() => resolveCanonicalDataRoot({ dataRoot: file })).toThrowError(
        expect.objectContaining({ code: 'invalid_input' }),
      );
    });
  });
});

describe('F-003 Host 私有目录保护（§3.3 fail-closed 矩阵）', () => {
  it('ensureHostDir 创建 0700 当前用户所有的 host/ 目录，可幂等重入', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      expect(statSync(hostDir).isDirectory()).toBe(true);
      expect(lstatSync(hostDir).isSymbolicLink()).toBe(false);
      expect(modeOf(hostDir)).toBe(0o700);
      expect(statSync(hostDir).uid).toBe(process.getuid!());
      store.ensureHostDir();
    });
  });

  it('非 darwin 平台与未 realpath 固定的根一律拒绝', () => {
    withTempSandbox((root) => {
      const candidate = join(root, 'data');
      mkdirSync(candidate);
      expect(() =>
        createHostFileStore({ canonicalRoot: realpathSync(candidate), platform: 'linux' }),
      ).toThrowError(expect.objectContaining({ code: 'unsupported_platform' }));
      // 别名（未 realpath）不是规范根。
      expect(() => createHostFileStore({ canonicalRoot: candidate })).toThrowError(
        expect.objectContaining({ code: 'invalid_input' }),
      );
    });
  });

  it('既有 host/ 权限过宽（0755）fail-closed：拒绝且不修改、不写入任何文件', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      mkdirSync(hostDir, { mode: 0o755 });
      chmodSync(hostDir, 0o755);
      expect(() => store.ensureHostDir()).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(modeOf(hostDir)).toBe(0o755);
      expect(readdirSync(hostDir)).toEqual([]);
    });
  });

  it('host/ 为指向根外的符号链接：拒绝且不向逃逸目标写入', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(store.canonicalRoot, HOST_DIR_NAME));
      expect(() => store.ensureHostDir()).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(() => store.publishDiscovery(makeRecord(store.dataRootIdentity))).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(readdirSync(outside)).toEqual([]);
    });
  });

  it('host/ 位置是普通文件而非目录：拒绝', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      writeFileSync(join(store.canonicalRoot, HOST_DIR_NAME), 'x');
      expect(() => store.ensureHostDir()).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
    });
  });

  it('发现文件为符号链接或非普通文件：读取与发布均拒绝且不覆盖可疑位置', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      const discoveryPath = join(hostDir, DISCOVERY_FILE_NAME);
      const secret = join(root, 'secret.json');
      writeFileSync(secret, '{}');
      symlinkSync(secret, discoveryPath);
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(() => store.publishDiscovery(makeRecord(store.dataRootIdentity))).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      // 符号链接未被覆盖、目标未被写入。
      expect(lstatSync(discoveryPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(discoveryPath)).toBe(secret);
      expect(readFileSync(secret, 'utf8')).toBe('{}');

      unlinkSync(discoveryPath);
      mkdirSync(discoveryPath);
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(() => store.publishDiscovery(makeRecord(store.dataRootIdentity))).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(statSync(discoveryPath).isDirectory()).toBe(true);
    });
  });

  it('发现文件权限过宽（0644）：读取拒绝且不修改权限', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      store.publishDiscovery(makeRecord(store.dataRootIdentity));
      const discoveryPath = join(store.canonicalRoot, HOST_DIR_NAME, DISCOVERY_FILE_NAME);
      chmodSync(discoveryPath, 0o644);
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(modeOf(discoveryPath)).toBe(0o644);
    });
  });

  it('缺失 host/ 或 discovery.json 的读取返回 host_not_found，而非其他错误', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'host_not_found' }),
      );
      store.ensureHostDir();
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'host_not_found' }),
      );
      expect(() => store.readTrustedAuthToken()).toThrowError(
        expect.objectContaining({ code: 'host_not_found' }),
      );
    });
  });
});

describe('F-003 本机凭据（§4.2）', () => {
  it('凭据为 64 位小写 hex、密码学随机源、0600；两次生成互不相同且可回读', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const tokenA = store.issueAuthToken();
      expect(tokenA).toMatch(/^[0-9a-f]{64}$/);
      const tokenPath = join(store.canonicalRoot, HOST_DIR_NAME, AUTH_TOKEN_FILE_NAME);
      expect(modeOf(tokenPath)).toBe(0o600);
      expect(statSync(tokenPath).uid).toBe(process.getuid!());
      expect(readFileSync(tokenPath, 'utf8')).toBe(tokenA);
      expect(store.readTrustedAuthToken()).toBe(tokenA);

      const tokenB = store.issueAuthToken();
      expect(tokenB).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenB).not.toBe(tokenA);
      expect(store.readTrustedAuthToken()).toBe(tokenB);
    });
  });

  it('凭据内容畸形/权限过宽/缺失分别映射 invalid_discovery 与 unsafe_discovery，且不回显内容', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const tokenPath = join(store.canonicalRoot, HOST_DIR_NAME, AUTH_TOKEN_FILE_NAME);
      writeFileSync(tokenPath, 'not-a-real-token', { mode: 0o600 });
      try {
        store.readTrustedAuthToken();
        expect.unreachable();
      } catch (error) {
        expect(isHostProtocolError(error, 'invalid_discovery')).toBe(true);
        expect(errorText(error)).not.toContain('not-a-real-token');
      }

      const token = store.issueAuthToken();
      chmodSync(tokenPath, 0o644);
      try {
        store.readTrustedAuthToken();
        expect.unreachable();
      } catch (error) {
        expect(isHostProtocolError(error, 'unsafe_discovery')).toBe(true);
        expect(errorText(error)).not.toContain(token);
      }
      chmodSync(tokenPath, 0o600);

      // 发现存在但凭据缺失：invalid_discovery（状态不一致，而非“无 Host”）。
      store.publishDiscovery(makeRecord(store.dataRootIdentity));
      unlinkSync(tokenPath);
      expect(() => store.readTrustedAuthToken()).toThrowError(
        expect.objectContaining({ code: 'invalid_discovery' }),
      );
    });
  });

  it('存储层所有错误均不携带绝对路径与凭据', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const token = store.issueAuthToken();
      const discoveryPath = join(store.canonicalRoot, HOST_DIR_NAME, DISCOVERY_FILE_NAME);
      writeFileSync(discoveryPath, 'garbage{', { mode: 0o600 });
      const failures: unknown[] = [];
      for (const action of [
        () => store.readTrustedDiscovery(),
        () => store.publishDiscovery(makeRecord(computeDataRootIdentity('/somewhere/else'))),
        () => resolveCanonicalDataRoot({ dataRoot: 'relative' }),
        () => createHostFileStore({ canonicalRoot: root }),
      ]) {
        try {
          action();
        } catch (error) {
          failures.push(error);
        }
      }
      expect(failures.length).toBe(4);
      for (const error of failures) {
        const text = errorText(error);
        expect(text).not.toContain(root);
        expect(text).not.toContain(store.canonicalRoot);
        expect(text).not.toContain(token);
        expect(text).not.toContain('garbage{');
      }
    });
  });
});

describe('F-003 发现原子发布与读取（§5.1/§5.2）', () => {
  it('发布成功：0600、内容严格可校验回读、无残留临时文件', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const record = makeRecord(store.dataRootIdentity);
      store.publishDiscovery(record);
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      const discoveryPath = join(hostDir, DISCOVERY_FILE_NAME);
      expect(modeOf(discoveryPath)).toBe(0o600);
      expect(statSync(discoveryPath).uid).toBe(process.getuid!());
      expect(listTmpFiles(hostDir)).toEqual([]);
      expect(store.readTrustedDiscovery()).toEqual(record);
      expect(JSON.parse(readFileSync(discoveryPath, 'utf8'))).toEqual(record);
    });
  });

  it('发现不得指定任意 URL/公网地址/根外凭据路径：未知字段与非回环地址一律拒绝且不产生文件', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      const rejected: Array<Record<string, unknown>> = [
        { listenAddress: '0.0.0.0' },
        { listenAddress: '::' },
        { listenAddress: 'localhost' },
        { listenAddress: '192.168.1.10' },
        { listenAddress: 'host.example.com' },
        { url: 'http://evil.example.com/' },
        { tokenPath: join(root, 'outside-token') },
        { port: 0 },
        { port: 65_536 },
      ];
      for (const overrides of rejected) {
        expect(() =>
          store.publishDiscovery(makeRecord(store.dataRootIdentity, overrides)),
        ).toThrowError(expect.objectContaining({ code: 'invalid_discovery' }));
      }
      expect(readdirSync(hostDir)).toEqual([]);
    });
  });

  it('发布指向其他数据根身份的记录被拒绝；既有有效发现不被部分覆盖', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const original = makeRecord(store.dataRootIdentity);
      store.publishDiscovery(original);
      const discoveryPath = join(store.canonicalRoot, HOST_DIR_NAME, DISCOVERY_FILE_NAME);
      const before = readFileSync(discoveryPath, 'utf8');

      expect(() =>
        store.publishDiscovery(makeRecord(computeDataRootIdentity('/somewhere/else'))),
      ).toThrowError(expect.objectContaining({ code: 'invalid_discovery' }));
      expect(readFileSync(discoveryPath, 'utf8')).toBe(before);
      expect(listTmpFiles(join(store.canonicalRoot, HOST_DIR_NAME))).toEqual([]);
    });
  });

  it('发布被拒绝时不留下可连接的半文件：目标可疑即整体拒绝且无临时文件残留', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      const discoveryPath = join(hostDir, DISCOVERY_FILE_NAME);
      mkdirSync(discoveryPath); // 可疑形态：同名目录
      expect(() => store.publishDiscovery(makeRecord(store.dataRootIdentity))).toThrowError(
        expect.objectContaining({ code: 'unsafe_discovery' }),
      );
      expect(listTmpFiles(hostDir)).toEqual([]);
      expect(statSync(discoveryPath).isDirectory()).toBe(true);
    });
  });

  it('崩溃残留的孤儿临时文件不会被误认为发现，也不阻碍后续正常发布', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      writeFileSync(join(hostDir, `.${DISCOVERY_FILE_NAME}.${randomUUID()}.tmp`), '{"half":', {
        mode: 0o600,
      });
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'host_not_found' }),
      );
      const record = makeRecord(store.dataRootIdentity);
      store.publishDiscovery(record);
      expect(store.readTrustedDiscovery()).toEqual(record);
    });
  });

  it('损坏 JSON 与未知 schemaVersion 的发现：invalid_discovery，不回显原文', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const discoveryPath = join(store.canonicalRoot, HOST_DIR_NAME, DISCOVERY_FILE_NAME);
      writeFileSync(discoveryPath, '{"schemaVersion":', { mode: 0o600 });
      try {
        store.readTrustedDiscovery();
        expect.unreachable();
      } catch (error) {
        expect(isHostProtocolError(error, 'invalid_discovery')).toBe(true);
        expect(errorText(error)).not.toContain('{"schemaVersion":');
      }

      writeFileSync(
        discoveryPath,
        JSON.stringify(makeRecord(store.dataRootIdentity, { schemaVersion: 99 })),
        { mode: 0o600 },
      );
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'invalid_discovery' }),
      );
    });
  });

  it('发现数据根身份与本地规范根不一致：拒绝读取', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const foreign = makeRecord(computeDataRootIdentity('/somewhere/else'));
      const discoveryPath = join(store.canonicalRoot, HOST_DIR_NAME, DISCOVERY_FILE_NAME);
      writeFileSync(discoveryPath, JSON.stringify(foreign), { mode: 0o600 });
      expect(() => store.readTrustedDiscovery()).toThrowError(
        expect.objectContaining({ code: 'invalid_discovery' }),
      );
    });
  });
});

describe('F-003 按实例清理（§10.5 第 5 步）', () => {
  it('身份一致时删除发现与凭据；writer.lock 内容与权限保持不变', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const record = makeRecord(store.dataRootIdentity);
      store.publishDiscovery(record);
      store.issueAuthToken();
      const lockPath = join(store.canonicalRoot, HOST_DIR_NAME, WRITER_LOCK_FILE_NAME);
      writeFileSync(lockPath, 'lock-target', { mode: 0o600 });

      const result = store.cleanupInstanceFiles(record.hostInstanceId);
      expect(result).toEqual({
        outcome: 'cleaned',
        deletedDiscovery: true,
        deletedAuthToken: true,
      });
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      expect(readdirSync(hostDir).sort()).toEqual([WRITER_LOCK_FILE_NAME]);
      expect(readFileSync(lockPath, 'utf8')).toBe('lock-target');
      expect(modeOf(lockPath)).toBe(0o600);
    });
  });

  it('旧实例迟到清理不得删除新实例发现或凭据（内容与权限断言）', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const stale = makeRecord(store.dataRootIdentity);
      store.publishDiscovery(stale);
      store.issueAuthToken();

      // 新实例接管（同一存储对象模拟新写入者）：发布新身份与新凭据。
      const fresh = makeRecord(store.dataRootIdentity);
      store.publishDiscovery(fresh);
      const freshToken = store.issueAuthToken();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      const discoveryBefore = readFileSync(join(hostDir, DISCOVERY_FILE_NAME), 'utf8');
      const tokenBefore = readFileSync(join(hostDir, AUTH_TOKEN_FILE_NAME), 'utf8');

      const result = store.cleanupInstanceFiles(stale.hostInstanceId);
      expect(result.outcome).toBe('skipped_instance_mismatch');
      expect(result.deletedDiscovery).toBe(false);
      expect(result.deletedAuthToken).toBe(false);
      expect(readFileSync(join(hostDir, DISCOVERY_FILE_NAME), 'utf8')).toBe(discoveryBefore);
      expect(readFileSync(join(hostDir, AUTH_TOKEN_FILE_NAME), 'utf8')).toBe(tokenBefore);
      expect(store.readTrustedAuthToken()).toBe(freshToken);
    });
  });

  it('发现缺失/损坏/可疑时 fail-closed：不删除任何文件', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      store.ensureHostDir();
      const hostDir = join(store.canonicalRoot, HOST_DIR_NAME);
      const token = store.issueAuthToken();

      // 发现缺失：不删凭据（无法核对身份）。
      expect(store.cleanupInstanceFiles(randomUUID()).outcome).toBe('skipped_discovery_absent');
      expect(readFileSync(join(hostDir, AUTH_TOKEN_FILE_NAME), 'utf8')).toBe(token);

      // 发现损坏：不删凭据。
      writeFileSync(join(hostDir, DISCOVERY_FILE_NAME), 'broken{', { mode: 0o600 });
      expect(store.cleanupInstanceFiles(randomUUID()).outcome).toBe('skipped_discovery_invalid');
      expect(readFileSync(join(hostDir, AUTH_TOKEN_FILE_NAME), 'utf8')).toBe(token);

      // 发现为符号链接：不跟随、不删除链接本身。
      unlinkSync(join(hostDir, DISCOVERY_FILE_NAME));
      symlinkSync(join(root, 'anywhere'), join(hostDir, DISCOVERY_FILE_NAME));
      expect(store.cleanupInstanceFiles(randomUUID()).outcome).toBe('skipped_discovery_unsafe');
      expect(lstatSync(join(hostDir, DISCOVERY_FILE_NAME)).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(hostDir, AUTH_TOKEN_FILE_NAME), 'utf8')).toBe(token);
    });
  });

  it('host/ 缺失或不可信时不执行任何删除；非法实例身份是输入错误', () => {
    withTempSandbox((root) => {
      const { store } = makeStore(root);
      expect(store.cleanupInstanceFiles(randomUUID()).outcome).toBe('skipped_host_dir_absent');

      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, DISCOVERY_FILE_NAME), 'x');
      symlinkSync(outside, join(store.canonicalRoot, HOST_DIR_NAME));
      expect(store.cleanupInstanceFiles(randomUUID()).outcome).toBe('skipped_host_dir_unsafe');
      expect(readFileSync(join(outside, DISCOVERY_FILE_NAME), 'utf8')).toBe('x');

      expect(() => store.cleanupInstanceFiles('not-a-uuid')).toThrowError(
        expect.objectContaining({ code: 'invalid_input' }),
      );
    });
  });
});
