/**
 * P01-4 / F-002 P01 验收夹具回归（真实临时 Git 仓库 + 隔离临时 home + 真实数据根 +
 * 固定内容夹具，非 mock）。
 *
 * 覆盖（F-002 验收点，全部为真实断言）：
 * - 每次创建独立系统临时根，内含隔离 home、数据根与真实 Git 仓库；仓库路径含
 *   Unicode/空格；夹具携带项目标签、合法配置与固定制品字节；Git 身份为一次性注入、
 *   不读取用户全局配置或认证文件；
 * - 连续两次创建得到不同临时根但相同业务输入摘要；真实 Git 与真实 SQLite 可用；
 *   源仓库哨兵、HEAD 与工作文件有清理前后可断言的快照；
 * - 准备失败、回调异常与正常完成都关闭受管 Core 应用并清理；只删除本次持有且位于
 *   临时授权根内的资源，拒绝未知根、受保护用户仓库与符号链接逃逸，根外哨兵不变；
 * - 证据先序列化到独立报告目录，再删除临时业务资源；Git/夹具子进程有有限超时并核验
 *   退出；缺失必需工具显式失败而非 skip。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FixtureProcessError,
  createP01AcceptanceFixture,
  runCheckedProcess,
  withP01AcceptanceFixture,
} from './helpers/p01-4-fixture.ts';
import { SafeCleanupError, assertSafeToRemove, safeRemoveTempRoot } from './helpers/safe-cleanup.ts';
import { git } from './helpers/git-repo.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_TMP = resolve(tmpdir());

function isInside(candidate: string, directory: string): boolean {
  const base = resolve(directory);
  const target = resolve(candidate);
  return target !== base && target.startsWith(base + '/');
}

describe('F-002 real temp fixture: isolated home, data root and Git repo', () => {
  it('creates independent temp home/data root/repo with Unicode+space path, labels, valid config and fixed artifact bytes', () => {
    const fixture = createP01AcceptanceFixture();
    try {
      // 独立系统临时根，拒绝落在受测仓库或真实 HOME 之内。
      expect(isInside(fixture.root, REAL_TMP)).toBe(true);
      expect(isInside(fixture.root, REPO_ROOT)).toBe(false);
      expect(isInside(fixture.root, homedir())).toBe(false);

      for (const directory of [fixture.homeDir, fixture.dataRoot, fixture.repoDir]) {
        expect(isInside(directory, fixture.root)).toBe(true);
        expect(existsSync(directory)).toBe(true);
      }

      // 仓库路径包含 Unicode 与空格。
      const repoBase = fixture.repoDir.slice(fixture.root.length + 1);
      expect(repoBase).toMatch(/\s/);
      expect(repoBase).toMatch(/[^\x00-\x7F]/);

      // 固定业务输入：项目标签、合法配置与固定制品字节。
      expect(fixture.businessInput.project.labels.length).toBeGreaterThan(0);
      expect(fixture.businessInput.globalSettings.schemaVersion).toBe(2);
      expect(fixture.businessInput.projectSettings.schemaVersion).toBe(2);
      expect(fixture.artifactBytes.length).toBeGreaterThan(0);
      expect(fixture.artifactSha256).toMatch(/^[0-9a-f]{64}$/);

      // 真实 Git：固定测试 commit 存在；身份为一次性注入，不读取用户全局配置。
      expect(fixture.sourceRepoHead).toMatch(/^[0-9a-f]{40}$/);
      const author = git(['log', '-1', '--format=%an <%ae>'], fixture.repoDir).trim();
      expect(author).toBe('ShipLoop Test <shiploop-test@example.invalid>');
      const globalName = (() => {
        try {
          return git(['config', '--global', '--get', 'user.name'], fixture.repoDir).trim();
        } catch {
          // 未找到全局 user.name（GIT_CONFIG_GLOBAL=/dev/null）以非零退出。
          return '';
        }
      })();
      expect(globalName).toBe('');

      // 真实 SQLite 可用：夹具准备期已探测版本。
      expect(fixture.tools.gitVersion).toMatch(/^git version \d/);
      expect(fixture.tools.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);

      // 源仓库哨兵内容固定。
      const sentinelPath = join(fixture.repoDir, fixture.businessInput.repo.sentinelFileName);
      expect(readFileSync(sentinelPath, 'utf-8')).toBe(fixture.businessInput.repo.sentinelContent);
    } finally {
      fixture.dispose();
    }
  });

  it('gives two consecutive creations different temp roots but the same business input digest', () => {
    const first = createP01AcceptanceFixture();
    const second = createP01AcceptanceFixture();
    try {
      expect(first.root).not.toBe(second.root);
      expect(first.reportDir).not.toBe(second.reportDir);
      expect(first.businessInputDigest).toBe(second.businessInputDigest);
      expect(first.businessInput).toEqual(second.businessInput);
      // 固定内容夹具可复现：两次正文与摘要一致。
      expect(Buffer.compare(first.artifactBytes, second.artifactBytes)).toBe(0);
      expect(first.artifactSha256).toBe(second.artifactSha256);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('exposes stable source-repo snapshots (sentinel, HEAD, working files) before cleanup', () => {
    const fixture = createP01AcceptanceFixture();
    try {
      const before = fixture.snapshotSourceRepo();
      const again = fixture.snapshotSourceRepo();
      expect(again).toEqual(before);
      expect(before.head).toBe(fixture.sourceRepoHead);
      expect(before.sentinelSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(before.files).length).toBeGreaterThan(0);
      for (const digest of Object.values(before.files)) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
      // 快照不修改仓库：操作后 HEAD/工作树仍一致。
      expect(fixture.snapshotSourceRepo()).toEqual(before);
    } finally {
      fixture.dispose();
    }
  });
});

describe('F-002 safe cleanup and evidence-before-delete', () => {
  it('serializes evidence to the independent report dir, then removes business resources but keeps the report', () => {
    const fixture = createP01AcceptanceFixture();
    const snapshot = fixture.snapshotSourceRepo();
    const evidence = fixture.writeEvidence('snapshots/source-repo.json', JSON.stringify(snapshot, null, 2));
    expect(evidence.relativePath).toBe('snapshots/source-repo.json');
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.sizeBytes).toBeGreaterThan(0);

    fixture.cleanup();
    // 业务资源已删除。
    expect(existsSync(fixture.root)).toBe(false);
    // 证据先于删除写出，且删除后仍可读取（独立报告目录不在业务根内）。
    const evidencePath = join(fixture.reportDir, 'snapshots', 'source-repo.json');
    expect(existsSync(evidencePath)).toBe(true);
    expect(readFileSync(evidencePath, 'utf-8')).toContain(snapshot.head);

    fixture.discardReport();
    expect(existsSync(fixture.reportDir)).toBe(false);
  });

  it('closes tracked Core applications and cleans up even when the callback throws', async () => {
    let observedRoot: string | undefined;
    let observedReport: string | undefined;
    await expect(
      withP01AcceptanceFixture(async (fixture) => {
        observedRoot = fixture.root;
        observedReport = fixture.reportDir;
        const app = await fixture.openApplication();
        // 已装配应用可由夹具关闭；这里故意抛出以验证 finally 收尾。
        expect(app.dataRoot).toBe(realpathSync(fixture.dataRoot));
        throw new Error('fixture callback boom 故意失败');
      }),
    ).rejects.toThrow('fixture callback boom 故意失败');
    expect(observedRoot).toBeTypeOf('string');
    expect(existsSync(observedRoot as string)).toBe(false);
    // dispose 同时清理独立报告目录。
    expect(observedReport).toBeTypeOf('string');
    expect(existsSync(observedReport as string)).toBe(false);
  });

  it('refuses unknown roots and protected user repositories, leaving outside sentinels unchanged', () => {
    const fixture = createP01AcceptanceFixture();
    const sentinel = fixture.outsideSentinelPath;
    const sentinelDigestBefore = fixture.snapshotOutsideSentinel();
    try {
      // 未知根：目标不在授权临时根之内。
      const foreign = join(REPO_ROOT, 'docs');
      const unauthorized = (() => {
        try {
          assertSafeToRemove(foreign, { authorizedRoot: REAL_TMP, protectedPaths: [REPO_ROOT] });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(unauthorized).toBeInstanceOf(SafeCleanupError);
      expect((unauthorized as SafeCleanupError).kind).toBe('not_authorized');

      // 受保护用户仓库：授权根内但属于受保护路径。
      const protectedAttempt = (() => {
        try {
          assertSafeToRemove(REPO_ROOT, { authorizedRoot: resolve(REPO_ROOT, '..'), protectedPaths: [REPO_ROOT] });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(protectedAttempt).toBeInstanceOf(SafeCleanupError);
      expect((protectedAttempt as SafeCleanupError).kind).toBe('protected');

      // 正常清理本次持有的临时根成功，且根外哨兵不变。
      safeRemoveTempRoot(fixture.root, { authorizedRoot: REAL_TMP, protectedPaths: [REPO_ROOT, homedir()] });
      expect(existsSync(fixture.root)).toBe(false);
      expect(existsSync(sentinel)).toBe(true);
      expect(fixture.snapshotOutsideSentinel()).toBe(sentinelDigestBefore);
    } finally {
      fixture.dispose();
    }
  });

  it('rejects symlink escapes without following them and keeps the external target unchanged', () => {
    const fixture = createP01AcceptanceFixture();
    const escapeLink = join(fixture.root, 'escape-link');
    symlinkSync(REPO_ROOT, escapeLink, 'dir');
    try {
      const attempt = (() => {
        try {
          assertSafeToRemove(fixture.root, {
            authorizedRoot: REAL_TMP,
            protectedPaths: [homedir()],
          });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(attempt).toBeInstanceOf(SafeCleanupError);
      expect((attempt as SafeCleanupError).kind).toBe('symlink_escape');
      // 未跟随链接：外部目标仍在。
      expect(existsSync(REPO_ROOT)).toBe(true);
      expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);

      // 移除逃逸链接后可安全清理。
      rmSync(escapeLink, { force: true });
      safeRemoveTempRoot(fixture.root, { authorizedRoot: REAL_TMP, protectedPaths: [homedir()] });
      expect(existsSync(fixture.root)).toBe(false);
      expect(existsSync(REPO_ROOT)).toBe(true);
    } finally {
      if (existsSync(escapeLink)) {
        rmSync(escapeLink, { force: true });
      }
      fixture.dispose();
    }
  });
});

describe('F-002 fixture subprocesses: finite timeout and explicit failure', () => {
  it('runs a checked subprocess and verifies its exit code', () => {
    const result = runCheckedProcess('git', ['--version'], { timeoutMs: 5_000 });
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toMatch(/^git version \d/);
  });

  it('enforces a finite timeout and kills an over-budget subprocess', () => {
    const attempt = (() => {
      try {
        runCheckedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(attempt).toBeInstanceOf(FixtureProcessError);
    expect((attempt as FixtureProcessError).kind).toBe('timeout');
  });

  it('fails explicitly (not skip) when a required executable is missing', () => {
    const attempt = (() => {
      try {
        runCheckedProcess('shiploop-definitely-missing-binary-xyz', ['--version'], { timeoutMs: 5_000 });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(attempt).toBeInstanceOf(FixtureProcessError);
    expect((attempt as FixtureProcessError).kind).toBe('spawn');
    expect((attempt as FixtureProcessError).message).toContain('shiploop-definitely-missing-binary-xyz');
  });
});
