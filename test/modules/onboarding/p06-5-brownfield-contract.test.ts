import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  BROWNFIELD_CHECK_STATUSES,
  BROWNFIELD_CONTRACT_SCHEMA_VERSION,
  BROWNFIELD_FAILURE_COMPARISONS,
  BrownfieldContractError,
  compareBrownfieldBaseline,
  computeBrownfieldCheckCommandDigest,
  createBrownfieldMovePreview,
  deriveUnavailableBrownfieldCheck,
  validateBrownfieldBaselineState,
  validateBrownfieldMoveConfirmation,
  validateBrownfieldMovePreview,
  type BrownfieldBaselineState,
  type BrownfieldCheckDefinition,
  type BrownfieldCheckSnapshot,
  type BrownfieldRepositoryFacts,
} from '../../../packages/core/src/ports/brownfield.ts';

const PROJECT_ID = 'project-p06-5';
const BINDING_ID = 'binding-old';
const OLD_REPO_IDENTITY = 'gitdir-sha256:' + 'a'.repeat(64);
const NEW_REPO_IDENTITY = 'gitdir-sha256:' + 'b'.repeat(64);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function oldBinding() {
  return {
    projectId: PROJECT_ID,
    repositoryBindingId: BINDING_ID,
    bindingRevision: 3,
    repoIdentity: OLD_REPO_IDENTITY,
  };
}

function facts(overrides: Record<string, unknown> = {}): BrownfieldRepositoryFacts {
  return {
    canonicalPath: '/tmp/new-repo',
    repoIdentity: NEW_REPO_IDENTITY,
    headCommit: HEAD_B,
    hasInitialCommit: true,
    hasUncommittedChanges: false,
    workingTreeDigest: DIGEST_B,
    ...overrides,
  } as BrownfieldRepositoryFacts;
}

function definition(overrides: Partial<BrownfieldCheckDefinition> = {}): BrownfieldCheckDefinition {
  return {
    checkKey: 'unit-tests',
    argv: ['npm', 'test', '--', 'unit-tests'],
    cwdRef: 'packages/core',
    environmentIdentity: DIGEST_A,
    timeoutMs: 60_000,
    required: true,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<BrownfieldCheckSnapshot> = {},
): BrownfieldCheckSnapshot {
  const check = definition();
  return {
    check: check,
    commandDigest: computeBrownfieldCheckCommandDigest(check),
    result: {
      status: 'failed',
      reasonCode: 'non_zero_exit',
      exitCode: 1,
      evidenceRefs: ['artifact-old'],
      failureCaseIds: ['case:old-failure'],
    },
    ...overrides,
  };
}

function state(overrides: Partial<BrownfieldBaselineState> = {}): BrownfieldBaselineState {
  return {
    schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
    projectId: PROJECT_ID,
    binding: oldBinding(),
    codeIdentity: {
      repoIdentity: OLD_REPO_IDENTITY,
      headCommit: HEAD_A,
      workingTreeDigest: DIGEST_A,
      hasUncommittedChanges: true,
    },
    checks: [snapshot()],
    historicalEvidenceRefs: ['artifact-old'],
    ...overrides,
  };
}

function expectValidation(run: () => unknown, field?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrownfieldContractError);
  expect(isStorageError(caught, 'validation')).toBe(true);
  if (field !== undefined) expect((caught as BrownfieldContractError).details?.field).toBe(field);
}

describe('P06-5 存量接入纯契约', () => {
  it('移动预览绑定 projectId、旧 binding identity 与新的只读仓库事实，并要求显式摘要确认', () => {
    const preview = createBrownfieldMovePreview({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      newRepository: facts(),
    });

    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.oldBinding).toEqual(oldBinding());
    expect(preview.newRepository.repoIdentity).toBe(NEW_REPO_IDENTITY);
    expect(validateBrownfieldMovePreview(preview)).toEqual(preview);
    expect(validateBrownfieldMoveConfirmation({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      previewDigest: preview.previewDigest,
      decision: 'confirm',
    }, preview)).toMatchObject({ projectId: PROJECT_ID, previewDigest: preview.previewDigest });
  });

  it('同 remote/HEAD 也不自动合并；旧新 repo identity 和 working-tree digest 分开保存', () => {
    const preview = createBrownfieldMovePreview({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      newRepository: facts({ headCommit: HEAD_A, repoIdentity: NEW_REPO_IDENTITY, workingTreeDigest: DIGEST_A }),
    });
    expect(preview.oldBinding.repoIdentity).not.toBe(preview.newRepository.repoIdentity);
    expect(preview.requiresExplicitConfirmation).toBe(true);
    expect(preview.identityRelation).toBe('different');
    expect(preview.newRepository).not.toHaveProperty('remote');
  });

  it('移动确认拒绝跨项目、旧 binding revision 漂移、未知字段、伪造主体和缺少摘要', () => {
    const preview = createBrownfieldMovePreview({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      newRepository: facts(),
    });
    expectValidation(() => validateBrownfieldMoveConfirmation({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: 'other-project',
      oldBinding: oldBinding(),
      previewDigest: preview.previewDigest,
      decision: 'confirm',
    }, preview), 'payload.oldBinding.projectId');
    expectValidation(() => validateBrownfieldMoveConfirmation({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: { ...oldBinding(), bindingRevision: 4 },
      previewDigest: preview.previewDigest,
      decision: 'confirm',
    }, preview), 'payload.oldBinding.bindingRevision');
    expectValidation(() => validateBrownfieldMoveConfirmation({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      decision: 'confirm',
      principalId: 'forged',
    }), 'payload.principalId');
    expectValidation(() => validateBrownfieldMoveConfirmation({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      previewDigest: 'f'.repeat(64),
      decision: 'confirm',
    }, preview), 'payload.previewDigest');
    expectValidation(() => validateBrownfieldMoveConfirmation({
      schemaVersion: 999,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      previewDigest: preview.previewDigest,
      decision: 'confirm',
    }), 'payload.schemaVersion');
  });

  it('当前工作区无 HEAD 或脏状态保留在代码身份中；不创建 commit/副本/stash/reset', () => {
    const noHeadPreview = createBrownfieldMovePreview({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      oldBinding: oldBinding(),
      newRepository: facts({ headCommit: null, hasInitialCommit: false, hasUncommittedChanges: true }),
    });
    const noHead = validateBrownfieldMovePreview(noHeadPreview);
    expect(noHead.newRepository.headCommit).toBeNull();
    expect(noHead.newRepository.hasInitialCommit).toBe(false);
    expect(noHead.newRepository.hasUncommittedChanges).toBe(true);
    expect(noHead).not.toHaveProperty('commit');
    expect(noHead).not.toHaveProperty('stash');
    expect(noHead).not.toHaveProperty('reset');
  });

  it('逐项状态保持兼容：不可用且未执行是 not_run；失败诊断不折算通过', () => {
    const unavailable = deriveUnavailableBrownfieldCheck(definition({ checkKey: 'lint' }), 'tool_unavailable');
    expect(unavailable.result).toEqual({ status: 'not_run', reasonCode: 'tool_unavailable', evidenceRefs: [] });
    expect([...BROWNFIELD_CHECK_STATUSES]).toEqual(['passed', 'failed', 'error', 'inconclusive', 'not_run']);
    for (const reason of ['non_zero_exit', 'timed_out', 'cancelled', 'stop_unconfirmed'] as const) {
      const current = validateBrownfieldBaselineState(state({ checks: [
        snapshot({ result: { status: reason === 'non_zero_exit' ? 'failed' : 'inconclusive', reasonCode: reason, evidenceRefs: ['artifact-old'], ...(reason === 'non_zero_exit' ? { exitCode: 1 } : {}) } }),
      ] }));
      expect(current.checks[0]?.result.status).not.toBe('passed');
    }
  });

  it('按同项目 checkKey + command/cwd/environment identity 比较，保留代码身份和证据', () => {
    const oldState = state();
    const newCheck = snapshot({
      result: {
        status: 'failed', reasonCode: 'non_zero_exit', exitCode: 2,
        evidenceRefs: ['artifact-new'], failureCaseIds: ['case:new-failure'],
      },
    });
    const compared = compareBrownfieldBaseline({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      old: oldState,
      current: state({
        codeIdentity: { ...oldState.codeIdentity, headCommit: HEAD_B, workingTreeDigest: DIGEST_B, hasUncommittedChanges: false },
        checks: [newCheck],
        historicalEvidenceRefs: ['artifact-old', 'artifact-new'],
      }),
    });
    expect(compared.oldCodeIdentity.headCommit).toBe(HEAD_A);
    expect(compared.newCodeIdentity.headCommit).toBe(HEAD_B);
    expect(compared.checks[0]).toMatchObject({
      checkKey: 'unit-tests',
      old: { status: 'failed', evidenceRefs: ['artifact-old'] },
      current: { status: 'failed', evidenceRefs: ['artifact-new'] },
      failureComparison: 'different_failure',
    });
  });

  it('没有稳定用例身份时逐项标记 indeterminate，不按失败数量或退出码豁免', () => {
    const compared = compareBrownfieldBaseline({
      schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      old: state({ checks: [snapshot({ result: { status: 'failed', reasonCode: 'non_zero_exit', exitCode: 1, evidenceRefs: ['old-evidence'] } })] }),
      current: state({ checks: [snapshot({ result: { status: 'failed', reasonCode: 'non_zero_exit', exitCode: 1, evidenceRefs: ['new-evidence'] } })] }),
    });
    expect(compared.checks[0]?.failureComparison).toBe('indeterminate');
    expect(compared.checks[0]?.old?.evidenceRefs).toEqual(['old-evidence']);
    expect(compared.checks[0]?.current?.evidenceRefs).toEqual(['new-evidence']);
    expect(BROWNFIELD_FAILURE_COMPARISONS).toContain('indeterminate');
  });

  it('纯契约源码不导入供应商 SDK、HTTP、ORM，也不执行外部副作用', () => {
    const source = readFileSync(new URL('../../../packages/core/src/ports/brownfield.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/pi-agent|better-sqlite|drizzle|fetch\(|node:http|child_process|node:fs/);
  });
});
