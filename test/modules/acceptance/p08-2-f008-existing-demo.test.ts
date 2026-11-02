import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  P08_EXISTING_DEMO_NOT_RUN,
  createExistingRepoReport,
  evaluateExistingRepoInitialization,
  validateExistingRepoReport,
  type ExistingRepoReport,
} from '../../../scripts/acceptance/p08-existing-demo.ts';
import { createExistingRepoFixture, type ExistingRepoFixture } from '../../helpers/p08-2/existing-repo-fixture.ts';

const fixtures: ExistingRepoFixture[] = [];

function fixture(): ExistingRepoFixture {
  const value = createExistingRepoFixture({ prefix: 'shiploop-f008-existing-' });
  fixtures.push(value);
  return value;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

describe('P08-2 F-008 非 Nezha 存量仓库增量变更夹具与记录', () => {
  it('[case:p08-2-f008-baseline-fixture] 夹具包含真实脏文件、已有测试和明确已知失败，基线可复核', () => {
    const item = fixture();
    const baseline = item.snapshot();

    expect(baseline.repository.kind).toBe('non-nezha');
    expect(baseline.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.dirtyFiles.map(file => file.path)).toEqual([
      'docs/notes.md',
      'notes/work-in-progress.md',
      'src/legacy.mjs',
    ]);
    expect(baseline.existingTests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'known-regression', exitCode: 1, knownFailure: true }),
      expect.objectContaining({ id: 'existing-smoke', exitCode: 0, knownFailure: false }),
    ]));
    expect(baseline.knownFailures).toEqual(['known-regression']);
    expect(baseline.fileSnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/legacy.mjs', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: 'test/known-regression.mjs', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    expect(item.runKnownFailure().exitCode).toBe(1);
  });

  it('[case:p08-2-f008-init-protects-dirty-state] 初始化授权核对项目归属和范围，不覆盖原内容、不自动提交', () => {
    const item = fixture();
    const before = item.snapshot();
    const initialization = evaluateExistingRepoInitialization({
      baseline: before,
      after: item.snapshot(),
      authorization: {
        confirmed: true,
        projectId: before.repository.projectId,
        repositoryPathDigest: before.repository.pathDigest,
        approvedPaths: ['src/increment.mjs', 'test/increment.test.mjs'],
      },
      automaticCommit: false,
    });

    expect(initialization).toMatchObject({
      status: 'passed',
      ownershipVerified: true,
      pathScopeVerified: true,
      headPreserved: true,
      dirtyFilesPreserved: true,
      automaticCommit: false,
    });
    expect(item.snapshot()).toEqual(before);
    expect(readFileSync(item.dirtyTrackedPath, 'utf8')).toContain('local work in progress');
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: item.repositoryPath, encoding: 'utf8' }).trim())
      .toBe('fixture: initial non-nezha repository');
  });

  it('[case:p08-2-f008-increment-scope-and-evidence] 增量只提交批准路径，代码/测试与原有失败分别记录', () => {
    const item = fixture();
    const baseline = item.snapshot();
    item.applyApprovedIncrement();
    const changed = item.incrementChanges();
    const commit = item.commitApprovedIncrement();
    const after = item.snapshot();
    const initialization = evaluateExistingRepoInitialization({
      baseline,
      after: { ...baseline, headCommit: baseline.headCommit },
      authorization: {
        confirmed: true,
        projectId: baseline.repository.projectId,
        repositoryPathDigest: baseline.repository.pathDigest,
        approvedPaths: changed.map(change => change.path),
      },
      automaticCommit: false,
    });
    const report = createExistingRepoReport({
      projectId: baseline.repository.projectId,
      repositoryLabel: 'non-nezha-todo-fixture',
      baseline,
      initialization,
      request: {
        id: 'increment-001',
        description: '为存量 Todo 增加归档标记',
        approvedPaths: changed.map(change => change.path),
      },
      changes: changed,
      verification: {
        command: ['node', 'test/increment.test.mjs'],
        exitCode: 0,
        evidenceRef: 'checks/increment-001.json',
      },
      git: {
        headBefore: baseline.headCommit,
        commitSha: commit.commitSha,
        treeSha: commit.treeSha,
        committedPaths: commit.committedPaths,
        originalDirtyPathsPreserved: after.dirtyFiles.map(file => file.path).includes('src/legacy.mjs'),
      },
    });

    expect(report.kind).toBe('shiploop.existing-repo.incremental-evidence');
    expect(report.status).toBe('inconclusive');
    expect(report.statusReason).toBe('known_baseline_failure');
    expect(report.increment.scope.status).toBe('passed');
    expect(report.increment.changes.map(change => change.kind)).toEqual(['code', 'test']);
    expect(report.baseline.knownFailures).toEqual(['known-regression']);
    expect(report.baselineGaps).toEqual([
      expect.objectContaining({ id: 'known-regression', status: 'unresolved', reason: 'known_baseline_failure' }),
    ]);
    expect(report.git.committedPaths).toEqual(['src/increment.mjs', 'test/increment.test.mjs']);
    expect(report.git.originalDirtyPathsPreserved).toBe(true);
    expect(report.notRun).toEqual(P08_EXISTING_DEMO_NOT_RUN);
    expect(validateExistingRepoReport(report)).toEqual(report);
    expect(JSON.stringify(report)).not.toContain(item.repositoryPath);
    expect(JSON.stringify(report)).not.toContain('Todo live');
  });

  it('[case:p08-2-f008-rejects-out-of-scope-and-known-failure-waiver] 越界变更、缺基线失败或自动豁免均 fail-closed', () => {
    const item = fixture();
    const baseline = item.snapshot();
    const initialization = evaluateExistingRepoInitialization({
      baseline,
      after: baseline,
      authorization: {
        confirmed: true,
        projectId: baseline.repository.projectId,
        repositoryPathDigest: baseline.repository.pathDigest,
        approvedPaths: ['src/increment.mjs'],
      },
      automaticCommit: false,
    });

    expect(() => createExistingRepoReport({
      projectId: baseline.repository.projectId,
      repositoryLabel: 'fixture',
      baseline,
      initialization,
      request: { id: 'increment-002', description: '越界', approvedPaths: ['src/increment.mjs'] },
      changes: [
        { path: 'package.json', kind: 'code', digest: 'a'.repeat(64) },
        { path: 'test/increment.test.mjs', kind: 'test', digest: 'b'.repeat(64) },
      ],
      verification: { command: ['node', 'test/increment.test.mjs'], exitCode: 0, evidenceRef: 'checks/x.json' },
      git: {
        headBefore: baseline.headCommit, commitSha: 'b'.repeat(40), treeSha: 'c'.repeat(40),
        committedPaths: ['package.json'], originalDirtyPathsPreserved: true,
      },
    })).toThrow(/increment_scope_invalid/);

    const valid = createExistingRepoReport({
      projectId: baseline.repository.projectId,
      repositoryLabel: 'fixture',
      baseline,
      initialization,
      request: { id: 'increment-003', description: '合法', approvedPaths: ['src/increment.mjs', 'test/increment.test.mjs'] },
      changes: [
        { path: 'src/increment.mjs', kind: 'code', digest: 'a'.repeat(64) },
        { path: 'test/increment.test.mjs', kind: 'test', digest: 'b'.repeat(64) },
      ],
      verification: { command: ['node', 'test/increment.test.mjs'], exitCode: 0, evidenceRef: 'checks/x.json' },
      git: {
        headBefore: baseline.headCommit, commitSha: 'b'.repeat(40), treeSha: 'c'.repeat(40),
        committedPaths: ['src/increment.mjs', 'test/increment.test.mjs'], originalDirtyPathsPreserved: true,
      },
    });
    expect(() => validateExistingRepoReport({
      ...valid,
      baselineGaps: valid.baselineGaps,
      status: 'passed',
      statusReason: null,
    } as ExistingRepoReport)).toThrow(/status_propagation_invalid/);
  });
});
