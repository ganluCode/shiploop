import { describe, expect, it } from 'vitest';
import {
  computeBrownfieldCheckCommandDigest,
  type BrownfieldCheckDefinition,
} from '../../../packages/core/src/ports/brownfield.ts';
import {
  LEGACY_TODO_NOT_RUN,
  LegacyTodoSnapshotError,
  validateLegacyTodoBaselineSnapshot,
  type LegacyTodoBaselineSnapshot,
} from '../../helpers/p08-3/legacy-todo-fixture.ts';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const ENVIRONMENT = 'd'.repeat(64);

function definition(checkKey: string, argv: readonly string[]): BrownfieldCheckDefinition {
  return { checkKey, argv: [...argv], environmentIdentity: ENVIRONMENT, timeoutMs: 10_000, required: true };
}

function validSnapshot(): LegacyTodoBaselineSnapshot {
  const passing = definition('existing-check', ['node', 'checks/existing-check.mjs']);
  const failing = definition('known-failure', ['node', 'checks/known-failure.mjs']);
  return {
    schemaVersion: 1,
    kind: 'shiploop.p08.legacy-todo-baseline',
    repository: {
      kind: 'non-nezha',
      projectId: 'legacy-todo-project',
      repoIdentity: `gitdir-sha256:${DIGEST}`,
      pathDigest: DIGEST,
      initialCommitMessage: 'fixture: initial legacy todo repository',
    },
    headCommit: HEAD,
    headTree: TREE,
    workingTree: {
      statusPorcelain: ' M src/todo.mjs\nM  docs/notes.md\n?? notes/user-scratch.md',
      hasUncommittedChanges: true,
      dirtyFiles: [
        { path: 'src/todo.mjs', state: 'modified_unstaged', digest: DIGEST },
        { path: 'docs/notes.md', state: 'modified_staged', digest: DIGEST },
        { path: 'notes/user-scratch.md', state: 'untracked', digest: DIGEST },
      ],
    },
    files: [
      { path: 'README.md', digest: DIGEST },
      { path: 'src/todo.mjs', digest: DIGEST },
      { path: 'docs/notes.md', digest: DIGEST },
      { path: 'notes/user-scratch.md', digest: DIGEST },
    ],
    checks: [
      {
        check: passing,
        commandDigest: computeBrownfieldCheckCommandDigest(passing),
        result: { status: 'passed', exitCode: 0, evidenceRefs: ['checks/existing-check.json'] },
      },
      {
        check: failing,
        commandDigest: computeBrownfieldCheckCommandDigest(failing),
        result: {
          status: 'failed',
          reasonCode: 'non_zero_exit',
          exitCode: 3,
          evidenceRefs: ['checks/known-failure.json'],
          failureCaseIds: ['case:known-failure-exit-3'],
        },
      },
    ],
    knownFailures: [{
      checkKey: 'known-failure',
      reasonCode: 'non_zero_exit',
      exitCode: 3,
      failureCaseIds: ['case:known-failure-exit-3'],
    }],
    notRun: LEGACY_TODO_NOT_RUN,
  };
}

function mutated(mutate: (snapshot: Record<string, any>) => void): unknown {
  const snapshot = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, any>;
  mutate(snapshot);
  return snapshot;
}

function expectRejected(value: unknown, reason: string): void {
  let caught: unknown;
  try {
    validateLegacyTodoBaselineSnapshot(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LegacyTodoSnapshotError);
  expect((caught as LegacyTodoSnapshotError).reason).toBe(reason);
}

describe('P08-3 F-001 存量 Todo 基线快照契约', () => {
  it('[case:p08-3-f001-snapshot-valid] 快照记录 HEAD、仓库身份、工作区、文件摘要、检查定义与已知失败', () => {
    const snapshot = validSnapshot();
    expect(validateLegacyTodoBaselineSnapshot(snapshot)).toEqual(snapshot);
    expect(validateLegacyTodoBaselineSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('[case:p08-3-f001-snapshot-paths] 快照拒绝开发机绝对路径与凭据文本', () => {
    expectRejected(mutated(snapshot => {
      snapshot.repository.initialCommitMessage = '/Users/example/private/legacy-repo';
    }), 'absolute_path');
    expectRejected(mutated(snapshot => {
      snapshot.checks[0].check.argv = ['node', '/Users/example/private/check.mjs'];
    }), 'absolute_path');
    expectRejected(mutated(snapshot => {
      snapshot.repository.initialCommitMessage = 'Bearer sk-live-secret-value';
    }), 'credential_text');
  });

  it('[case:p08-3-f001-snapshot-no-output] 快照拒绝原始命令输出字段，只保留结构化检查结果', () => {
    expectRejected(mutated(snapshot => {
      snapshot.checks[1].result.stdout = 'known regression';
    }), 'model_or_command_output');
    expectRejected(mutated(snapshot => {
      snapshot.checks[1].result.stderr = 'known regression';
    }), 'model_or_command_output');
  });

  it('[case:p08-3-f001-snapshot-dirty-state] 快照必须同时保留 tracked 与 untracked 预存改动', () => {
    expectRejected(mutated(snapshot => {
      snapshot.workingTree.dirtyFiles = snapshot.workingTree.dirtyFiles.filter(
        (file: { state: string }) => file.state !== 'untracked',
      );
    }), 'untracked_dirty_file_missing');
    expectRejected(mutated(snapshot => {
      snapshot.workingTree.dirtyFiles = snapshot.workingTree.dirtyFiles.filter(
        (file: { state: string }) => file.state === 'untracked',
      );
    }), 'tracked_dirty_file_missing');
  });

  it('[case:p08-3-f001-snapshot-known-failure] 已知失败必须绑定真实失败检查，不能被删除或标记为通过', () => {
    expectRejected(mutated(snapshot => {
      snapshot.knownFailures = [];
    }), 'known_failure_missing');
    expectRejected(mutated(snapshot => {
      snapshot.checks[1].result = { status: 'passed', exitCode: 0, evidenceRefs: [] };
    }), 'known_failure_check_mismatch');
  });

  it('[case:p08-3-f001-snapshot-not-run] 真实 SQLite/Host/进程/跨层执行保持 not_run，不因局部夹具通过而放行', () => {
    expect(LEGACY_TODO_NOT_RUN.map(item => item.id)).toEqual([
      'real-sqlite-state',
      'real-host-lifecycle',
      'real-process-control',
      'cross-layer-lifecycle',
    ]);
    expect(LEGACY_TODO_NOT_RUN.every(item => item.status === 'not_run')).toBe(true);
    expectRejected(mutated(snapshot => {
      snapshot.notRun[0] = { ...snapshot.notRun[0], status: 'passed' };
    }), 'not_run_scope_invalid');
  });
});
