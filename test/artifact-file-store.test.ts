/**
 * F-010 制品文件适配器回归（真实临时文件系统，非 mock）。
 *
 * 覆盖（P01-2 / F-010 验收点，全部为真实断言）：
 * - 物理位置只由授权数据根 + 稳定 project/artifact ID 推导；locator（含中文
 *   多字节）是逻辑身份，不改变物理路径；夹具断言所有实际写入均位于受控根，
 *   根外哨兵文件及其目录内容保持不变；
 * - 绝对路径、父目录穿越、非法 ID/locator 在发布/读取/核对入口均为可识别
 *   校验错误且零写入；父目录符号链接与目标文件符号链接逃逸分别返回 escape，
 *   已存在祖先经 realpath 核验、文件操作执行 lstat/no-follow 核对；
 * - staging 与正式文件位于同一文件系统（同在授权根），不覆盖写入策略与受限
 *   权限（文件 0o600、目录 0o700）；同名已有文件保留并返回冲突；
 * - 目录扫描不跟随链接、分页限制每批处理量；不存在的数据根与权限拒绝显式
 *   返回错误，不创建成功假象；
 * - 可信项目模式边界：本测试验证 realpath/lstat/no-follow 检查生效，不宣称
 *   强 OS 沙箱；检查与操作之间的并发替换窗口属于已记录的 trusted-project 前提。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  ARTIFACT_FILE_SCAN_MAX_LIMIT,
  deriveArtifactFinalRelativePath,
  isArtifactFileError,
} from '../packages/core/src/ports/artifact-files.ts';
import type {
  ArtifactFileError,
  ArtifactFileErrorKind,
  ArtifactFileKey,
  ArtifactFileScanEntry,
  ArtifactFileStore,
  ArtifactStagingFile,
} from '../packages/core/src/ports/artifact-files.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const PROJECT_A = 'proj-a01';
const PROJECT_B = 'proj-b02';
const ARTIFACT_1 = 'art-0001';
const ARTIFACT_2 = 'art-0002';

const SENTINEL_CONTENT = 'SENTINEL-OUTSIDE-DO-NOT-TOUCH';

type Fixture = {
  readonly sandboxPath: string;
  readonly root: string;
  readonly outsideDir: string;
  readonly sentinelFile: string;
  readonly store: ArtifactFileStore;
  /** 登记测试自己在根外预置的夹具路径（区别于适配器的实际写入）。 */
  readonly allowOutside: (absPath: string) => void;
  readonly cleanup: () => void;
};

/** 在独立临时沙箱中建立授权数据根与根外哨兵区，装配真实文件适配器。 */
function createFixture(): Fixture {
  const sandbox = createTempSandbox('shiploop-f010-');
  const root = join(sandbox.path, 'data-root');
  const outsideDir = join(sandbox.path, 'outside');
  mkdirSync(root);
  mkdirSync(outsideDir);
  const sentinelFile = join(outsideDir, 'sentinel.txt');
  writeFileSync(sentinelFile, SENTINEL_CONTENT);
  let counter = 0;
  const store = createArtifactFileStore({
    dataRoot: root,
    stagingName: () => `fixed-${(counter += 1)}`,
  });
  const allowedOutside = new Set<string>([resolve(outsideDir), resolve(sentinelFile)]);
  const fixture: Fixture = {
    sandboxPath: sandbox.path,
    root,
    outsideDir,
    sentinelFile,
    store,
    allowOutside: (absPath: string) => {
      allowedOutside.add(resolve(absPath));
    },
    cleanup: () => {
      // 权限用例会 chmod 0o000；清理前恢复，保证 rmSync 可移除。
      chmodSync(root, 0o755);
      restoreModes(root);
      sandbox.cleanup();
    },
  };
  fixtureOutsideRegistry.set(fixture, allowedOutside);
  return fixture;
}

function restoreModes(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      chmodSync(abs, 0o755);
      restoreModes(abs);
    }
  }
}

/** 递归列出目录内全部路径（lstat，不跟随符号链接）。 */
function listAllPaths(dir: string): string[] {
  const result: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      result.push(abs);
      if (entry.isDirectory()) {
        walk(abs);
      }
    }
  };
  walk(dir);
  return result;
}

/** 夹具级不变量：沙箱内除预置/登记的根外夹具外，所有实际路径都位于受控数据根。 */
function assertAllWritesInsideRoot(fixture: Fixture): void {
  const realRoot = resolve(fixture.root);
  for (const abs of listAllPaths(fixture.sandboxPath)) {
    const resolved = resolve(abs);
    const insideRoot = resolved === realRoot || resolved.startsWith(realRoot + sep);
    expect(
      insideRoot || fixtureAllowedOutside(fixture, resolved),
      `实际写入越出受控根：${abs}`,
    ).toBe(true);
  }
  expect(readFileSync(fixture.sentinelFile, 'utf8')).toBe(SENTINEL_CONTENT);
}

// allowOutside 登记集合保存在弱引用之外的模块级 Map，避免暴露可变内部状态。
const fixtureOutsideRegistry = new WeakMap<Fixture, Set<string>>();
function fixtureAllowedOutside(fixture: Fixture, resolved: string): boolean {
  return fixtureOutsideRegistry.get(fixture)?.has(resolved) ?? false;
}

async function expectFileError(
  kind: ArtifactFileErrorKind,
  fn: () => Promise<unknown> | unknown,
): Promise<ArtifactFileError> {
  try {
    await fn();
  } catch (error) {
    expect(isArtifactFileError(error, kind), `expected ArtifactFileError(${kind}), got ${String(error)}`).toBe(true);
    return error as ArtifactFileError;
  }
  throw new Error(`expected ArtifactFileError(${kind})`);
}

async function expectValidation(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected validation error, got ${String(error)}`).toBe(true);
    return;
  }
  throw new Error('expected validation error');
}

function key(artifactId: string, projectId = PROJECT_A, locator?: string): ArtifactFileKey {
  return locator === undefined
    ? { projectId, artifactId }
    : { projectId, artifactId, locator };
}

/** 完整发布一段文本正文（staging → finish → publish）。 */
async function publishText(
  store: ArtifactFileStore,
  artifactKey: ArtifactFileKey,
  text: string,
): Promise<void> {
  const write = await store.openStagingWrite(artifactKey);
  write.stream.end(text, 'utf8');
  const staging = await store.finishStaging(write);
  await store.publishStaging(staging, artifactKey);
}

async function readFinalText(store: ArtifactFileStore, artifactKey: ArtifactFileKey): Promise<string> {
  const content = await store.openFinalRead(artifactKey);
  const chunks: Buffer[] = [];
  for await (const chunk of content.stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('F-010 受控逻辑定位', () => {
  it('物理位置只由数据根与稳定 ID 推导，locator（含中文）不改变物理路径', () => {
    const fixture = createFixture();
    try {
      const plain = fixture.store.resolvePlacement(key(ARTIFACT_1));
      const withLocator = fixture.store.resolvePlacement(key(ARTIFACT_1, PROJECT_A, 'reports/结果.md'));
      const otherLocator = fixture.store.resolvePlacement(key(ARTIFACT_1, PROJECT_A, 'logs/run.txt'));
      expect(plain.finalRelativePath).toBe(`projects/${PROJECT_A}/artifacts/${ARTIFACT_1}/content`);
      expect(withLocator.finalRelativePath).toBe(plain.finalRelativePath);
      expect(otherLocator.finalRelativePath).toBe(plain.finalRelativePath);
      expect(plain.finalRelativePath).not.toContain('reports');
      expect(plain.finalRelativePath).not.toContain('结果');
      expect(plain.finalRelativePath.startsWith('/')).toBe(false);
      expect(plain.stagingRelativeDir).toBe(`staging/${PROJECT_A}`);
      // 不同项目/制品推导不同位置（ID 参与推导）。
      expect(fixture.store.resolvePlacement(key(ARTIFACT_2)).finalRelativePath).not.toBe(
        plain.finalRelativePath,
      );
      expect(
        fixture.store.resolvePlacement(key(ARTIFACT_1, PROJECT_B)).finalRelativePath,
      ).not.toBe(plain.finalRelativePath);
    } finally {
      fixture.cleanup();
    }
  });

  it('发布-读取闭环：中文 locator 的多字节正文逐字节一致且落在推导位置', async () => {
    const fixture = createFixture();
    try {
      const text = '验收报告：全部通过 ✅ — 多字节正文往返';
      const artifactKey = key(ARTIFACT_1, PROJECT_A, '报告/验收.md');
      await publishText(fixture.store, artifactKey, text);
      const finalAbs = join(fixture.root, deriveArtifactFinalRelativePath(artifactKey));
      expect(readFileSync(finalAbs, 'utf8')).toBe(text);
      expect(await readFinalText(fixture.store, artifactKey)).toBe(text);
      const stat = await fixture.store.statFinal(artifactKey);
      expect(stat.sizeBytes).toBe(Buffer.byteLength(text, 'utf8'));
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('非法 ID/locator 在定位、发布、读取、核对入口均为校验错误且零写入', async () => {
    const fixture = createFixture();
    try {
      const badKeys: unknown[] = [
        { projectId: '../escape', artifactId: ARTIFACT_1 },
        { projectId: '', artifactId: ARTIFACT_1 },
        { projectId: 'a/b', artifactId: ARTIFACT_1 },
        { projectId: PROJECT_A, artifactId: '..', },
        { projectId: PROJECT_A, artifactId: 'a/b' },
        { projectId: PROJECT_A, artifactId: ARTIFACT_1, locator: '/etc/passwd' },
        { projectId: PROJECT_A, artifactId: ARTIFACT_1, locator: '../secret' },
        { projectId: PROJECT_A, artifactId: ARTIFACT_1, locator: 'a\\b' },
        { projectId: PROJECT_A, artifactId: ARTIFACT_1, locator: 'a//b' },
        { projectId: PROJECT_A, artifactId: ARTIFACT_1, unknown: true },
      ];
      for (const bad of badKeys) {
        await expectValidation(() => fixture.store.resolvePlacement(bad));
        await expectValidation(() => fixture.store.openStagingWrite(bad));
        await expectValidation(() => fixture.store.openFinalRead(bad));
        await expectValidation(() => fixture.store.statFinal(bad));
      }
      expect(listAllPaths(fixture.root)).toHaveLength(0);
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('F-010 staging 生命周期与不覆盖发布', () => {
  it('staging 写入使用受限权限且位于受控 staging 区', async () => {
    const fixture = createFixture();
    try {
      const write = await fixture.store.openStagingWrite(key(ARTIFACT_1));
      expect(write.relativePath).toBe(`staging/${PROJECT_A}/${ARTIFACT_1}.fixed-1.part`);
      write.stream.end('payload-正文');
      const staging = await fixture.store.finishStaging(write);
      expect(staging.relativePath).toBe(write.relativePath);
      expect(staging.sizeBytes).toBe(Buffer.byteLength('payload-正文', 'utf8'));
      const abs = join(fixture.root, write.relativePath);
      expect(lstatSync(abs).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(fixture.root, 'staging', PROJECT_A)).mode & 0o777).toBe(0o700);
      await fixture.store.discardStaging(staging);
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('发布后 staging 消失、正式文件受限权限且字节一致', async () => {
    const fixture = createFixture();
    try {
      const artifactKey = key(ARTIFACT_1);
      const write = await fixture.store.openStagingWrite(artifactKey);
      write.stream.end('正式内容');
      const staging = await fixture.store.finishStaging(write);
      const published = await fixture.store.publishStaging(staging, artifactKey);
      expect(published.relativePath).toBe(`projects/${PROJECT_A}/artifacts/${ARTIFACT_1}/content`);
      expect(published.sizeBytes).toBe(Buffer.byteLength('正式内容', 'utf8'));
      expect(existsSync(join(fixture.root, staging.relativePath))).toBe(false);
      const finalAbs = join(fixture.root, published.relativePath);
      expect(lstatSync(finalAbs).mode & 0o777).toBe(0o600);
      expect(readFileSync(finalAbs, 'utf8')).toBe('正式内容');
      expect(await readFinalText(fixture.store, artifactKey)).toBe('正式内容');
    } finally {
      fixture.cleanup();
    }
  });

  it('同名已有文件保留并返回冲突，第二次发布不覆盖既有内容', async () => {
    const fixture = createFixture();
    try {
      const artifactKey = key(ARTIFACT_1);
      await publishText(fixture.store, artifactKey, '第一版内容');
      const write2 = await fixture.store.openStagingWrite(artifactKey);
      write2.stream.end('第二版内容');
      const staging2 = await fixture.store.finishStaging(write2);
      const error = await expectFileError('conflict', () =>
        fixture.store.publishStaging(staging2, artifactKey),
      );
      expect(error.operation).toBe('ArtifactFileStore.publishStaging');
      // 既有内容与第二次的 staging 残留都保留（不覆盖、不自动删除未知文件）。
      expect(await readFinalText(fixture.store, artifactKey)).toBe('第一版内容');
      expect(readFileSync(join(fixture.root, staging2.relativePath), 'utf8')).toBe('第二版内容');
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('discardStaging 移除残留且幂等；未 end 的写入句柄也能安全丢弃', async () => {
    const fixture = createFixture();
    try {
      const write = await fixture.store.openStagingWrite(key(ARTIFACT_1));
      write.stream.write('半截内容');
      await fixture.store.discardStaging(write);
      expect(existsSync(join(fixture.root, write.relativePath))).toBe(false);
      // 幂等：再次丢弃同一引用不报错。
      await fixture.store.discardStaging({ relativePath: write.relativePath, sizeBytes: 0 });
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('写入流失败时 finishStaging 返回 io 错误且保留残留证据', async () => {
    const fixture = createFixture();
    try {
      const write = await fixture.store.openStagingWrite(key(ARTIFACT_1));
      write.stream.write('partial');
      write.stream.destroy(new Error('injected stream failure'));
      const error = await expectFileError('io', () => fixture.store.finishStaging(write));
      expect(error.operation).toBe('ArtifactFileStore.finishStaging');
      // 残留保留供核对（不自动删除未知状态文件），清理由 discardStaging 显式执行。
      expect(existsSync(join(fixture.root, write.relativePath))).toBe(true);
      await fixture.store.discardStaging({ relativePath: write.relativePath, sizeBytes: 0 });
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('伪造的 staging 引用（越出 staging 区、跨项目、绝对路径）被拒绝且零副作用', async () => {
    const fixture = createFixture();
    try {
      const artifactKey = key(ARTIFACT_1);
      const legit = await fixture.store.openStagingWrite(artifactKey);
      legit.stream.end('x');
      const staging = await fixture.store.finishStaging(legit);
      // 形态非法的引用：发布与丢弃都在校验阶段拒绝。
      const forged: ArtifactStagingFile[] = [
        { relativePath: `projects/${PROJECT_A}/artifacts/${ARTIFACT_1}/content`, sizeBytes: 1 },
        { relativePath: 'staging/../../outside/x.part', sizeBytes: 1 },
        { relativePath: '/absolute/path.part', sizeBytes: 1 },
        { relativePath: `staging/${PROJECT_A}/not-a-staging-file`, sizeBytes: 1 },
      ];
      for (const fake of forged) {
        await expectValidation(() => fixture.store.publishStaging(fake, artifactKey));
        await expectValidation(() => fixture.store.discardStaging(fake));
      }
      // 形态合法但属于其他项目的 staging 引用：发布因项目不匹配拒绝；
      // 丢弃对不存在的残留幂等成功（不报错、也不触碰任何文件）。
      const otherProjectRef: ArtifactStagingFile = {
        relativePath: `staging/${PROJECT_B}/${ARTIFACT_1}.fixed-9.part`,
        sizeBytes: 1,
      };
      await expectValidation(() => fixture.store.publishStaging(otherProjectRef, artifactKey));
      await fixture.store.discardStaging(otherProjectRef);
      // 合法 staging 未受任何伪造尝试影响，仍可正常发布。
      await fixture.store.publishStaging(staging, artifactKey);
      expect(await readFinalText(fixture.store, artifactKey)).toBe('x');
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('F-010 路径逃逸防护（真实符号链接）', () => {
  it('父目录符号链接逃逸：发布、读取、核对入口均拒绝且哨兵目录保持为空', async () => {
    const fixture = createFixture();
    try {
      const escapeTarget = join(fixture.outsideDir, 'escape-target');
      mkdirSync(escapeTarget);
      fixture.allowOutside(escapeTarget);
      mkdirSync(join(fixture.root, 'projects'));
      symlinkSync(escapeTarget, join(fixture.root, 'projects', PROJECT_A), 'dir');
      const artifactKey = key(ARTIFACT_1);

      // 读取/核对入口
      await expectFileError('escape', () => fixture.store.statFinal(artifactKey));
      await expectFileError('escape', () => fixture.store.openFinalRead(artifactKey));
      // 发布入口（staging 已合法完成，正式发布经符号链接祖先时必须拒绝）
      const write = await fixture.store.openStagingWrite(artifactKey);
      write.stream.end('不应落盘');
      const staging = await fixture.store.finishStaging(write);
      const error = await expectFileError('escape', () =>
        fixture.store.publishStaging(staging, artifactKey),
      );
      expect(error.kind).toBe('escape');
      // 哨兵目录仍然为空：没有任何字节经链接写出受控根。
      expect(readdirSync(escapeTarget)).toHaveLength(0);
      expect(existsSync(join(escapeTarget, 'artifacts'))).toBe(false);
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('staging 区祖先符号链接逃逸：openStagingWrite 拒绝且目标目录无新增', async () => {
    const fixture = createFixture();
    try {
      const escapeTarget = join(fixture.outsideDir, 'staging-escape');
      mkdirSync(escapeTarget);
      fixture.allowOutside(escapeTarget);
      symlinkSync(escapeTarget, join(fixture.root, 'staging'), 'dir');
      await expectFileError('escape', () => fixture.store.openStagingWrite(key(ARTIFACT_1)));
      expect(readdirSync(escapeTarget)).toHaveLength(0);
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('目标文件符号链接逃逸：读取/核对/发布均不跟随，哨兵内容不变', async () => {
    const fixture = createFixture();
    try {
      const artifactKey = key(ARTIFACT_1);
      const finalDir = join(fixture.root, 'projects', PROJECT_A, 'artifacts', ARTIFACT_1);
      mkdirSync(finalDir, { recursive: true });
      symlinkSync(fixture.sentinelFile, join(finalDir, 'content'), 'file');

      await expectFileError('escape', () => fixture.store.statFinal(artifactKey));
      await expectFileError('escape', () => fixture.store.openFinalRead(artifactKey));

      const write = await fixture.store.openStagingWrite(artifactKey);
      write.stream.end('覆盖尝试');
      const staging = await fixture.store.finishStaging(write);
      // 目标是既有符号链接：不覆盖、不跟随，返回可识别错误（escape 或 conflict 均保留目标）。
      try {
        await fixture.store.publishStaging(staging, artifactKey);
        throw new Error('expected publish to reject symlinked target');
      } catch (error) {
        expect(
          isArtifactFileError(error, 'escape') || isArtifactFileError(error, 'conflict'),
          `expected escape/conflict, got ${String(error)}`,
        ).toBe(true);
      }
      expect(readFileSync(fixture.sentinelFile, 'utf8')).toBe(SENTINEL_CONTENT);
      expect(lstatSync(join(finalDir, 'content')).isSymbolicLink()).toBe(true);
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('逃逸错误的消息与诊断不含绝对路径', async () => {
    const fixture = createFixture();
    try {
      const escapeTarget = join(fixture.outsideDir, 'leak-check');
      mkdirSync(escapeTarget);
      fixture.allowOutside(escapeTarget);
      symlinkSync(escapeTarget, join(fixture.root, 'staging'), 'dir');
      const error = await expectFileError('escape', () =>
        fixture.store.openStagingWrite(key(ARTIFACT_1)),
      );
      const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
      expect(serialized).not.toContain(fixture.sandboxPath);
      expect(serialized).not.toContain(resolve(fixture.root));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('F-010 有界扫描', () => {
  it('扫描正式制品区不跟随链接，条目类型与大小正确', async () => {
    const fixture = createFixture();
    try {
      await publishText(fixture.store, key(ARTIFACT_1), '甲');
      await publishText(fixture.store, key(ARTIFACT_2), '乙');
      const artifactsDir = join(fixture.root, 'projects', PROJECT_A, 'artifacts');
      symlinkSync(fixture.sentinelFile, join(artifactsDir, 'stray-link'), 'file');
      writeFileSync(join(artifactsDir, 'stray-file.txt'), 'orphan');

      const page = await fixture.store.scanFinalArea(PROJECT_A);
      expect(page.nextCursor).toBeNull();
      const byName = new Map(page.entries.map((entry) => [entry.name, entry]));
      expect([...byName.keys()].sort()).toEqual([ARTIFACT_1, ARTIFACT_2, 'stray-file.txt', 'stray-link']);
      expect(byName.get(ARTIFACT_1)?.kind).toBe('directory');
      expect(byName.get('stray-file.txt')?.kind).toBe('file');
      expect(byName.get('stray-file.txt')?.sizeBytes).toBe(Buffer.byteLength('orphan', 'utf8'));
      // 符号链接如实列出但不穿透：不读取目标、不上报目标大小。
      const link = byName.get('stray-link');
      expect(link?.kind).toBe('symlink');
      expect(link?.sizeBytes).toBeNull();
      assertAllWritesInsideRoot(fixture);
    } finally {
      fixture.cleanup();
    }
  });

  it('分页限制每批处理量，游标遍历不重复不遗漏且终止', async () => {
    const fixture = createFixture();
    try {
      for (const id of ['art-p01', 'art-p02', 'art-p03']) {
        await publishText(fixture.store, key(id), `内容-${id}`);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: { entries: readonly ArtifactFileScanEntry[]; nextCursor: string | null } =
          await fixture.store.scanFinalArea(PROJECT_A, { limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.entries.length).toBeLessThanOrEqual(2);
        seen.push(...page.entries.map((entry) => entry.name));
        if (page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
        if (guard === 9) {
          throw new Error('分页未在有限批次内终止');
        }
      }
      expect([...seen].sort()).toEqual(['art-p01', 'art-p02', 'art-p03']);
    } finally {
      fixture.cleanup();
    }
  });

  it('扫描 staging 区列出残留文件；不存在的项目区返回空页', async () => {
    const fixture = createFixture();
    try {
      const write = await fixture.store.openStagingWrite(key(ARTIFACT_1));
      write.stream.end('残留');
      await fixture.store.finishStaging(write);
      const page = await fixture.store.scanStagingArea(PROJECT_A);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.kind).toBe('file');
      expect(page.entries[0]?.sizeBytes).toBe(Buffer.byteLength('残留', 'utf8'));
      // 从未写入的项目：正式区与 staging 区都返回空页（不是错误）。
      expect((await fixture.store.scanFinalArea(PROJECT_B)).entries).toHaveLength(0);
      expect((await fixture.store.scanStagingArea(PROJECT_B)).entries).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('非法分页参数与非法 projectId 为校验错误', async () => {
    const fixture = createFixture();
    try {
      for (const limit of [0, -1, 1.5, ARTIFACT_FILE_SCAN_MAX_LIMIT + 1, '2']) {
        await expectValidation(() => fixture.store.scanFinalArea(PROJECT_A, { limit }));
      }
      await expectValidation(() => fixture.store.scanFinalArea(PROJECT_A, { cursor: 'a/b' }));
      await expectValidation(() => fixture.store.scanFinalArea('../escape'));
      await expectValidation(() => fixture.store.scanStagingArea('a/b'));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('F-010 装配与显式错误', () => {
  it('不存在的数据根明确 not_found 且不被创建；相对路径/文件根被拒绝', () => {
    const sandbox = createTempSandbox('shiploop-f010-asm-');
    try {
      const missing = join(sandbox.path, 'missing-root');
      try {
        createArtifactFileStore({ dataRoot: missing });
        throw new Error('expected not_found');
      } catch (caught) {
        expect(isArtifactFileError(caught, 'not_found'), String(caught)).toBe(true);
      }
      expect(existsSync(missing)).toBe(false);
      // 相对路径与“根是文件”均为 invalid_input。
      const fileRoot = join(sandbox.path, 'a-file');
      writeFileSync(fileRoot, 'not a dir');
      for (const bad of ['relative/root', fileRoot]) {
        try {
          createArtifactFileStore({ dataRoot: bad });
          throw new Error(`expected invalid_input for ${bad}`);
        } catch (caught) {
          expect(isArtifactFileError(caught, 'invalid_input'), String(caught)).toBe(true);
        }
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('数据根可以经符号链接路径给出（内部以 realpath 为准）', async () => {
    const fixture = createFixture();
    const linkSandbox = createTempSandbox('shiploop-f010-link-');
    try {
      const viaLink = join(linkSandbox.path, 'root-link');
      symlinkSync(fixture.root, viaLink, 'dir');
      const linked = createArtifactFileStore({ dataRoot: viaLink });
      await publishText(linked, key(ARTIFACT_1), '经链接根写入');
      expect(await readFinalText(linked, key(ARTIFACT_1))).toBe('经链接根写入');
      // 写入仍落在真实受控根内。
      expect(
        existsSync(join(fixture.root, 'projects', PROJECT_A, 'artifacts', ARTIFACT_1, 'content')),
      ).toBe(true);
      assertAllWritesInsideRoot(fixture);
    } finally {
      linkSandbox.cleanup();
      fixture.cleanup();
    }
  });

  it('权限拒绝显式返回 permission 错误，不创建成功假象', async () => {
    const fixture = createFixture();
    try {
      await publishText(fixture.store, key(ARTIFACT_1), '已有内容');
      chmodSync(join(fixture.root, 'projects'), 0o000);
      await expectFileError('permission', () => fixture.store.statFinal(key(ARTIFACT_1)));
      await expectFileError('permission', () => fixture.store.openFinalRead(key(ARTIFACT_1)));
      await expectFileError('permission', () => fixture.store.scanFinalArea(PROJECT_A));
    } finally {
      fixture.cleanup();
    }
  });
});
