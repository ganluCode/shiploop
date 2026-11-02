import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeBrownfieldCheckCommandDigest,
  validateBrownfieldCheckDefinition,
} from '../../../packages/core/src/ports/brownfield.ts';
import {
  LEGACY_TODO_INITIAL_COMMIT_MESSAGE,
  LEGACY_TODO_NOT_RUN,
  createLegacyTodoFixture,
  validateLegacyTodoBaselineSnapshot,
  type LegacyTodoFixture,
} from '../../helpers/p08-3/legacy-todo-fixture.ts';

const fixtures: LegacyTodoFixture[] = [];

function fixture(): LegacyTodoFixture {
  const value = createLegacyTodoFixture({ prefix: 'shiploop-p08-3-f001-' });
  fixtures.push(value);
  return value;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.dispose();
    item.cleanupSandbox();
  }
});

describe('P08-3 F-001 存量 Todo Git 仓库夹具', () => {
  it('[case:p08-3-f001-real-git-fixture] 每次创建独立真实 Git 仓库与固定初始提交，含可执行检查和确定失败', () => {
    const first = fixture();
    const second = fixture();
    expect(first.repositoryPath).not.toBe(second.repositoryPath);

    const firstSnapshot = first.snapshot();
    const secondSnapshot = second.snapshot();
    expect(firstSnapshot.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(firstSnapshot.headCommit).toBe(secondSnapshot.headCommit);
    expect(firstSnapshot.headTree).toMatch(/^[a-f0-9]{40}$/);
    expect(firstSnapshot.repository.initialCommitMessage).toBe(LEGACY_TODO_INITIAL_COMMIT_MESSAGE);

    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: first.repositoryPath,
      encoding: 'utf8',
    }).trim()).toBe('1');
    expect(execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: first.repositoryPath,
      encoding: 'utf8',
    }).trim()).toBe(LEGACY_TODO_INITIAL_COMMIT_MESSAGE);
    expect(existsSync(`${first.repositoryPath}/.git`)).toBe(true);

    expect(statSync(first.existingCheckPath).mode & 0o111).not.toBe(0);
    expect(firstSnapshot.workingTree.dirtyFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/todo.mjs', state: 'modified_unstaged' }),
      expect.objectContaining({ path: 'docs/notes.md', state: 'modified_staged' }),
      expect.objectContaining({ path: 'notes/user-scratch.md', state: 'untracked' }),
    ]));
    expect(firstSnapshot.checks).toEqual([
      expect.objectContaining({
        check: expect.objectContaining({ checkKey: 'existing-check' }),
        result: expect.objectContaining({ status: 'passed', exitCode: 0 }),
      }),
      expect.objectContaining({
        check: expect.objectContaining({ checkKey: 'known-failure' }),
        result: expect.objectContaining({ status: 'failed', reasonCode: 'non_zero_exit', exitCode: 3 }),
      }),
    ]);
    expect(firstSnapshot.knownFailures).toEqual([{
      checkKey: 'known-failure',
      reasonCode: 'non_zero_exit',
      exitCode: 3,
      failureCaseIds: ['case:known-failure-exit-3'],
    }]);
    expect(first.runKnownFailure()).toEqual(expect.objectContaining({ exitCode: 3, reasonCode: 'non_zero_exit' }));
    expect(first.runKnownFailure().exitCode).toBe(3);
  });

  it('[case:p08-3-f001-baseline-snapshot] 基线快照可重复比较、绑定检查定义且不泄露开发机路径或凭据', () => {
    const item = fixture();
    const snapshot = item.snapshot();
    expect(validateLegacyTodoBaselineSnapshot(snapshot)).toEqual(snapshot);
    expect(item.snapshot()).toEqual(snapshot);

    expect(snapshot.repository).toMatchObject({
      kind: 'non-nezha',
      projectId: item.projectId,
      repoIdentity: expect.stringMatching(/^gitdir-sha256:[a-f0-9]{64}$/),
      pathDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.workingTree.statusPorcelain).toContain('src/todo.mjs');
    expect(snapshot.workingTree.hasUncommittedChanges).toBe(true);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: 'src/todo.mjs', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: 'notes/user-scratch.md', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));

    for (const check of snapshot.checks) {
      expect(validateBrownfieldCheckDefinition(check.check)).toEqual(check.check);
      expect(computeBrownfieldCheckCommandDigest(check.check)).toBe(check.commandDigest);
    }
    expect(snapshot.notRun).toEqual(LEGACY_TODO_NOT_RUN);
    expect(snapshot.notRun.every(entry => entry.status === 'not_run')).toBe(true);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(item.repositoryPath);
    expect(serialized).not.toContain(item.root);
    expect(serialized).not.toContain(homedir());
    expect(serialized).not.toContain('Bearer ');
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('shiploop-harness');
    expect(serialized).not.toContain('/nezha/');

    const dirtyBefore = item.dirtyFileDigests();
    item.snapshot();
    expect(item.dirtyFileDigests()).toEqual(dirtyBefore);
  });

  it('[case:p08-3-f001-no-business-db] 夹具不创建或读取 Nezha/Harness 业务数据库与元数据', () => {
    const item = fixture();
    expect(item.stateIsolation()).toEqual({
      status: 'isolated',
      databaseFiles: [],
      harnessMetadataPaths: [],
      repositoryInsideSandbox: true,
    });
    expect(item.unrelatedStatePath.startsWith(item.repositoryPath + sep)).toBe(false);
    expect(existsSync(item.unrelatedStatePath)).toBe(true);
  });

  it('[case:p08-3-f001-cleanup-boundary] 清理只删除夹具自有仓库，无关旧状态文件字节摘要保持不变', () => {
    const item = fixture();
    const unrelatedDigest = sha256File(item.unrelatedStatePath);
    item.snapshot();
    expect(sha256File(item.unrelatedStatePath)).toBe(unrelatedDigest);

    const cleanup = item.dispose();
    expect(cleanup).toMatchObject({
      status: 'passed',
      ownedRootRemoved: true,
      unrelatedState: {
        digestBefore: unrelatedDigest,
        digestAfter: unrelatedDigest,
        preserved: true,
      },
      reasons: [],
    });
    expect(existsSync(item.repositoryPath)).toBe(false);
    expect(existsSync(`${item.repositoryPath}/.git`)).toBe(false);
    expect(existsSync(item.unrelatedStatePath)).toBe(true);
    expect(sha256File(item.unrelatedStatePath)).toBe(unrelatedDigest);
    expect(item.dispose()).toEqual(cleanup);

    item.cleanupSandbox();
    expect(existsSync(item.root)).toBe(false);
  });
});
