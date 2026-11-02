/**
 * P08-3 / F-002 存量演示结构化证据封套契约（unit，无 IO）。
 *
 * 覆盖验收点：
 * - 封套包含 schemaVersion/kind、项目与绑定身份（路径脱敏为摘要）、受测提交、
 *   基线与当前代码身份、检查范围、每项检查状态/退出/超时信息、制品引用与
 *   remaining gaps；未执行检查保持 not_run；
 * - 结果区分既有失败、新失败、修复后的通过和不可比较，不因成功文本或既有
 *   失败数量豁免新检查；
 * - 写入路径脱敏、读取拒绝绝对路径/用户目录/凭据/原始输出字段；摘要、命令
 *   参数和制品哈希保留可复核；损坏或身份不匹配的封套拒绝读取；
 * - 真实 Git/SQLite/Host/进程快照采集属于 Phase 集成场景，通过 phaseIntegration
 *   记录为 not_run，不在本契约内伪造。
 */
import { describe, expect, it } from 'vitest';
import {
  BROWNFIELD_EVIDENCE_KIND,
  BROWNFIELD_EVIDENCE_SCHEMA_VERSION,
  BrownfieldEvidenceError,
  collectBrownfieldEvidenceEnvelope,
  computeBrownfieldEvidenceDigest,
  deriveBrownfieldEvidenceOutcome,
  validateBrownfieldEvidenceEnvelope,
  type BrownfieldEvidenceEnvelope,
} from '../../../packages/core/src/ports/brownfield-evidence.ts';
import {
  computeBrownfieldCheckCommandDigest,
  deriveUnavailableBrownfieldCheck,
  type BrownfieldCheckDefinition,
  type BrownfieldCheckResult,
  type BrownfieldCheckSnapshot,
  type BrownfieldCodeIdentity,
} from '../../../packages/core/src/ports/brownfield.ts';

const PROJECT_ID = 'project-p08-3';
const BINDING_ID = 'binding-legacy-todo';
const REPO_IDENTITY = `gitdir-sha256:${'a'.repeat(64)}`;
const REPOSITORY_PATH = '/tmp/shiploop-p08-3-demo/repository';
const ENVIRONMENT = 'e'.repeat(64);
const HEAD_BASELINE = 'a'.repeat(40);
const HEAD_CURRENT = 'b'.repeat(40);
const TREE_DIGEST = 'f'.repeat(64);
const ARTIFACT_DIGEST = '1'.repeat(64);
const COLLECTED_AT = 1_769_000_000_000;

function definition(checkKey: string, overrides: Partial<BrownfieldCheckDefinition> = {}): BrownfieldCheckDefinition {
  return {
    checkKey,
    argv: ['node', `checks/${checkKey}.mjs`],
    environmentIdentity: ENVIRONMENT,
    timeoutMs: 10_000,
    required: true,
    ...overrides,
  };
}

function snapshot(check: BrownfieldCheckDefinition, result: BrownfieldCheckResult): BrownfieldCheckSnapshot {
  return { check, commandDigest: computeBrownfieldCheckCommandDigest(check), result };
}

function passed(evidenceRef?: string): BrownfieldCheckResult {
  return { status: 'passed', evidenceRefs: evidenceRef === undefined ? [] : [evidenceRef] };
}

function failed(
  exitCode: number,
  failureCaseIds: readonly string[] | undefined,
  evidenceRef = `artifacts/failure-${exitCode}.json`,
): BrownfieldCheckResult {
  return {
    status: 'failed',
    reasonCode: 'non_zero_exit',
    exitCode,
    evidenceRefs: [evidenceRef],
    ...(failureCaseIds === undefined ? {} : { failureCaseIds }),
  };
}

function codeIdentity(headCommit: string): BrownfieldCodeIdentity {
  return { repoIdentity: REPO_IDENTITY, headCommit, workingTreeDigest: TREE_DIGEST, hasUncommittedChanges: true };
}

function artifact(ref: string, bytes = 128) {
  return { ref, digest: ARTIFACT_DIGEST, bytes };
}

function baseInput() {
  const existing = definition('existing-check');
  const knownFailure = definition('known-failure');
  const fixedCheck = definition('fixed-check');
  const newCheck = definition('new-check');
  const pendingCheck = definition('pending-check');
  const timeoutCheck = definition('timeout-check', { required: false });
  return {
    projectId: PROJECT_ID,
    binding: {
      projectId: PROJECT_ID,
      repositoryBindingId: BINDING_ID,
      bindingRevision: 2,
      canonicalPath: REPOSITORY_PATH,
      repoIdentity: REPO_IDENTITY,
    },
    testCommit: HEAD_CURRENT,
    baselineCodeIdentity: codeIdentity(HEAD_BASELINE),
    currentCodeIdentity: codeIdentity(HEAD_CURRENT),
    checkScope: {
      requiredCheckKeys: ['existing-check', 'known-failure', 'fixed-check', 'new-check', 'pending-check'],
      optionalCheckKeys: ['timeout-check'],
    },
    baselineChecks: [
      snapshot(existing, passed('artifacts/existing-baseline.json')),
      snapshot(knownFailure, failed(3, ['case:known-failure-exit-3'])),
      snapshot(fixedCheck, failed(9, ['case:fixed-check-exit-9'])),
    ],
    currentChecks: [
      snapshot(existing, passed('artifacts/existing-current.json')),
      snapshot(knownFailure, failed(3, ['case:known-failure-exit-3'])),
      snapshot(fixedCheck, passed('artifacts/fixed-current.json')),
      snapshot(newCheck, failed(5, ['case:new-check-exit-5'])),
      deriveUnavailableBrownfieldCheck(pendingCheck, 'tool_unavailable'),
      snapshot(timeoutCheck, {
        status: 'inconclusive',
        reasonCode: 'timed_out',
        evidenceRefs: ['artifacts/timeout-current.json'],
      }),
    ],
    artifacts: [
      artifact('artifacts/existing-baseline.json'),
      artifact('artifacts/existing-current.json'),
      artifact('artifacts/failure-3.json'),
      artifact('artifacts/failure-9.json'),
      artifact('artifacts/fixed-current.json'),
      artifact('artifacts/failure-5.json'),
      artifact('artifacts/timeout-current.json'),
    ],
    baselineDirtyFiles: [
      { path: 'src/todo.mjs', state: 'modified_unstaged' as const, digest: '3'.repeat(64) },
      { path: 'docs/notes.md', state: 'modified_staged' as const, digest: '4'.repeat(64) },
      { path: 'notes/user-scratch.md', state: 'untracked' as const, digest: '5'.repeat(64) },
    ],
    currentDirtyFiles: [
      { path: 'src/todo.mjs', state: 'modified_unstaged' as const, digest: '3'.repeat(64) },
      { path: 'docs/notes.md', state: 'modified_staged' as const, digest: '4'.repeat(64) },
      { path: 'notes/user-scratch.md', state: 'untracked' as const, digest: '5'.repeat(64) },
      { path: 'src/increment.mjs', state: 'untracked' as const, digest: '6'.repeat(64) },
    ],
    phaseIntegration: [{ id: 'real-git-sqlite-host-process', reason: 'phase_integration_scenarios_pending' }],
    collectedAtUtcMs: COLLECTED_AT,
  };
}

function collectedEnvelope(): BrownfieldEvidenceEnvelope {
  return collectBrownfieldEvidenceEnvelope(baseInput());
}

function tampered(
  envelope: BrownfieldEvidenceEnvelope,
  mutate: (draft: Record<string, any>) => void,
  options: { readonly recomputeDigest?: boolean } = {},
): unknown {
  const draft = JSON.parse(JSON.stringify(envelope)) as Record<string, any>;
  mutate(draft);
  if (options.recomputeDigest) {
    const { envelopeDigest, ...body } = draft;
    draft.envelopeDigest = computeBrownfieldEvidenceDigest(body);
  }
  return draft;
}

function expectValidateRejected(value: unknown, reason: string): void {
  let caught: unknown;
  try {
    validateBrownfieldEvidenceEnvelope(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrownfieldEvidenceError);
  expect((caught as BrownfieldEvidenceError).reason).toBe(reason);
}

function expectCollectRejected(value: unknown, reason: string): void {
  let caught: unknown;
  try {
    collectBrownfieldEvidenceEnvelope(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrownfieldEvidenceError);
  expect((caught as BrownfieldEvidenceError).reason).toBe(reason);
}

describe('P08-3 F-002 存量演示证据封套契约', () => {
  it('[case:p08-3-f002-envelope-valid] 收集生成完整封套并可无损读回，包含身份、检查范围、超时信息、制品与缺口', () => {
    const envelope = collectedEnvelope();

    expect(validateBrownfieldEvidenceEnvelope(envelope)).toEqual(envelope);
    expect(validateBrownfieldEvidenceEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);

    expect(envelope.schemaVersion).toBe(BROWNFIELD_EVIDENCE_SCHEMA_VERSION);
    expect(envelope.kind).toBe(BROWNFIELD_EVIDENCE_KIND);
    expect(envelope.projectId).toBe(PROJECT_ID);
    expect(envelope.binding.projectId).toBe(PROJECT_ID);
    expect(envelope.binding.repositoryBindingId).toBe(BINDING_ID);
    expect(envelope.binding.pathDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(envelope.binding)).not.toContain('canonicalPath');
    expect(envelope.testCommit).toBe(HEAD_CURRENT);
    expect(envelope.baselineCodeIdentity).toEqual(codeIdentity(HEAD_BASELINE));
    expect(envelope.currentCodeIdentity).toEqual(codeIdentity(HEAD_CURRENT));
    expect(envelope.checkScope.requiredCheckKeys).toEqual([
      'existing-check', 'fixed-check', 'known-failure', 'new-check', 'pending-check',
    ]);
    expect(envelope.checkScope.optionalCheckKeys).toEqual(['timeout-check']);

    expect(envelope.checks.map(row => [row.check.checkKey, row.outcome])).toEqual([
      ['existing-check', 'passed'],
      ['fixed-check', 'fixed'],
      ['known-failure', 'existing_failure'],
      ['new-check', 'new_failure'],
      ['pending-check', 'not_run'],
      ['timeout-check', 'incomparable'],
    ]);
    expect(envelope.checks.find(row => row.check.checkKey === 'timeout-check')?.timeout).toEqual({
      limitMs: 10_000,
      timedOut: true,
    });
    expect(envelope.checks.find(row => row.check.checkKey === 'known-failure')?.failureComparison).toBe('same_failure');

    expect(envelope.artifacts.map(item => item.ref)).toEqual([
      'artifacts/existing-baseline.json',
      'artifacts/existing-current.json',
      'artifacts/failure-3.json',
      'artifacts/failure-5.json',
      'artifacts/failure-9.json',
      'artifacts/fixed-current.json',
      'artifacts/timeout-current.json',
    ]);
    expect(envelope.workingTreePreservation.status).toBe('preserved');
    expect(envelope.workingTreePreservation.currentDirtyFiles.map(file => file.path)).toContain('src/increment.mjs');

    expect(envelope.remainingGaps).toEqual([
      { id: 'known-failure:known-failure', kind: 'existing_failure', reason: 'baseline_failure_unresolved' },
      { id: 'new-failure:new-check', kind: 'new_failure', reason: 'new_or_changed_failure' },
      { id: 'not-run:pending-check', kind: 'required_check_not_run', reason: 'tool_unavailable' },
      { id: 'phase:real-git-sqlite-host-process', kind: 'phase_integration_not_run', reason: 'phase_integration_scenarios_pending' },
    ]);
    expect(envelope.summary).toEqual({
      checks: 6, passed: 1, existingFailure: 1, newFailure: 1, fixed: 1, incomparable: 1, notRun: 1,
    });
    expect(envelope.collectedAtUtcMs).toBe(COLLECTED_AT);
    expect(envelope.envelopeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[case:p08-3-f002-outcome-classification] 区分既有失败、新失败、修复后的通过与不可比较，既有失败数量不豁免新检查', () => {
    const pair = (
      baseline: BrownfieldCheckSnapshot | null,
      current: BrownfieldCheckSnapshot,
    ) => deriveBrownfieldEvidenceOutcome(baseline, current);

    const def = definition('check-a');
    const changedDef = definition('check-a', { timeoutMs: 20_000 });

    expect(pair(snapshot(def, failed(3, ['case:a'])), snapshot(def, failed(3, ['case:a'])))).toBe('existing_failure');
    expect(pair(snapshot(def, passed()), snapshot(def, failed(3, ['case:a'])))).toBe('new_failure');
    expect(pair(snapshot(def, failed(3, ['case:a'])), snapshot(def, passed()))).toBe('fixed');
    expect(pair(snapshot(def, failed(3, ['case:a'])), snapshot(changedDef, failed(3, ['case:a'])))).toBe('incomparable');
    expect(pair(snapshot(def, failed(3, ['case:a'])), snapshot(def, failed(3, ['case:a', 'case:b'])))).toBe('new_failure');
    expect(pair(snapshot(def, failed(3, undefined)), snapshot(def, failed(3, ['case:a'])))).toBe('incomparable');
    expect(pair(snapshot(def, failed(3, ['case:a'])), snapshot(def, failed(3, undefined)))).toBe('incomparable');
    expect(pair(null, snapshot(def, failed(3, ['case:a'])))).toBe('new_failure');
    expect(pair(null, snapshot(def, passed()))).toBe('passed');
    expect(pair(
      deriveUnavailableBrownfieldCheck(def, 'tool_unavailable'),
      snapshot(def, failed(3, ['case:a'])),
    )).toBe('incomparable');
    expect(pair(snapshot(def, failed(3, ['case:a'])), snapshot(def, {
      status: 'inconclusive', reasonCode: 'timed_out', evidenceRefs: [],
    }))).toBe('incomparable');
    expect(pair(snapshot(def, passed()), snapshot(def, {
      status: 'not_run', reasonCode: 'not_started', evidenceRefs: [],
    }))).toBe('not_run');

    // 篡改判定即使重算 envelopeDigest 也会被派生重算拒绝；未重算时同样拒绝。
    expectValidateRejected(tampered(collectedEnvelope(), draft => {
      draft.checks[2].outcome = 'passed';
    }, { recomputeDigest: true }), 'outcome_mismatch');
    expectValidateRejected(tampered(collectedEnvelope(), draft => {
      draft.checks[2].outcome = 'passed';
    }), 'outcome_mismatch');
  });

  it('[case:p08-3-f002-redaction] 写入把仓库路径脱敏为摘要；读取拒绝绝对路径、用户目录、凭据与原始输出字段', () => {
    const envelope = collectedEnvelope();
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(REPOSITORY_PATH);
    expect(serialized).not.toContain('canonicalPath');
    // 命令参数、摘要与制品哈希仍保留可复核。
    expect(envelope.checks[0].check.argv).toEqual(['node', 'checks/existing-check.mjs']);
    expect(envelope.checks[0].commandDigest).toBe(computeBrownfieldCheckCommandDigest(envelope.checks[0].check));
    expect(envelope.artifacts.every(item => item.digest).toString()).not.toBe('');

    expectValidateRejected(tampered(envelope, draft => {
      draft.workingTreePreservation.currentDirtyFiles[0].path = '/Users/ganlu/repo/src/todo.mjs';
    }, { recomputeDigest: true }), 'absolute_path');
    expectValidateRejected(tampered(envelope, draft => {
      draft.workingTreePreservation.currentDirtyFiles[0].path = 'C:\\Users\\ganlu\\repo\\src\\todo.mjs';
    }, { recomputeDigest: true }), 'absolute_path');
    expectValidateRejected(tampered(envelope, draft => {
      draft.phaseIntegration[0].reason = '~/legacy/.auth/token';
    }, { recomputeDigest: true }), 'user_home_reference');
    expectValidateRejected(tampered(envelope, draft => {
      draft.checks[0].check.argv.push('sk-live-abc123');
    }, { recomputeDigest: true }), 'credential_text');
    expectValidateRejected(tampered(envelope, draft => {
      draft.checks[0].check.argv.push('Bearer abcdef123456');
    }, { recomputeDigest: true }), 'credential_text');
    expectValidateRejected(tampered(envelope, draft => {
      draft.checks[0].current.stdout = 'legacy todo check: ok';
    }, { recomputeDigest: true }), 'raw_output_field');
    expectValidateRejected(tampered(envelope, draft => {
      draft.checks[0].current.authorization = 'Bearer abcdef123456';
    }, { recomputeDigest: true }), 'sensitive_field');

    // 收集端同样拒绝携带绝对路径的检查定义（同步重算 commandDigest 排除干扰），
    // 不静默改写命令参数。
    const badArgvInput = baseInput();
    const badSnapshot = badArgvInput.currentChecks[0]!;
    const badCheck = { ...badSnapshot.check, argv: ['node', `${REPOSITORY_PATH}/check.mjs`] };
    badArgvInput.currentChecks[0] = {
      ...badSnapshot,
      check: badCheck,
      commandDigest: computeBrownfieldCheckCommandDigest(badCheck),
    };
    expectCollectRejected(badArgvInput, 'absolute_path');
  });

  it('[case:p08-3-f002-integrity] 损坏封套（摘要、命令摘要、制品覆盖、派生字段被改）拒绝读取', () => {
    const envelope = collectedEnvelope();

    expectValidateRejected(tampered(envelope, draft => {
      draft.checks[2].current.exitCode = 4;
    }), 'envelope_digest_mismatch');
    expectValidateRejected(tampered(envelope, draft => {
      draft.summary.passed = 6;
    }, { recomputeDigest: true }), 'summary_mismatch');
    expectValidateRejected(tampered(envelope, draft => {
      draft.remainingGaps = draft.remainingGaps.filter((gap: { id: string }) => gap.id !== 'new-failure:new-check');
    }, { recomputeDigest: true }), 'gap_mismatch');
    expectValidateRejected(tampered(envelope, draft => {
      draft.checks[0].commandDigest = '0'.repeat(64);
    }, { recomputeDigest: true }), 'command_digest_mismatch');
    expectValidateRejected(tampered(envelope, draft => {
      draft.artifacts = draft.artifacts.filter((item: { ref: string }) => item.ref !== 'artifacts/failure-3.json');
    }, { recomputeDigest: true }), 'artifact_coverage_missing');
    expectValidateRejected(tampered(envelope, draft => {
      draft.artifacts[0].digest = 'not-a-digest';
    }, { recomputeDigest: true }), 'artifact_digest_invalid');
    expectValidateRejected(tampered(envelope, draft => {
      draft.workingTreePreservation.status = 'changed';
    }, { recomputeDigest: true }), 'working_tree_status_mismatch');
  });

  it('[case:p08-3-f002-identity-binding] 项目、仓库与受测提交身份不匹配的封套拒绝写入或读取', () => {
    const otherIdentity = { ...codeIdentity(HEAD_BASELINE), repoIdentity: `gitdir-sha256:${'b'.repeat(64)}` };
    const repoMismatch = baseInput();
    repoMismatch.currentCodeIdentity = otherIdentity;
    expectCollectRejected(repoMismatch, 'identity_mismatch');

    const commitMismatch = baseInput();
    commitMismatch.testCommit = HEAD_BASELINE;
    expectCollectRejected(commitMismatch, 'test_commit_mismatch');

    const bindingProjectMismatch = baseInput();
    bindingProjectMismatch.binding = { ...bindingProjectMismatch.binding, projectId: 'project-other' };
    expectCollectRejected(bindingProjectMismatch, 'binding_project_mismatch');

    expectValidateRejected(tampered(collectedEnvelope(), draft => {
      draft.projectId = 'project-other';
    }, { recomputeDigest: true }), 'binding_project_mismatch');

    expectValidateRejected(tampered(collectedEnvelope(), draft => {
      draft.testCommit = 'c'.repeat(40);
    }, { recomputeDigest: true }), 'test_commit_mismatch');
  });

  it('[case:p08-3-f002-not-run-semantics] 未执行检查保持 not_run 并进入缺口；必需检查与 Phase 集成范围不被成功文本折算', () => {
    const envelope = collectedEnvelope();
    const pending = envelope.checks.find(row => row.check.checkKey === 'pending-check')!;
    expect(pending.current.status).toBe('not_run');
    expect(pending.current.reasonCode).toBe('tool_unavailable');
    expect(envelope.remainingGaps).toContainEqual({
      id: 'not-run:pending-check', kind: 'required_check_not_run', reason: 'tool_unavailable',
    });
    expect(envelope.remainingGaps).toContainEqual({
      id: 'phase:real-git-sqlite-host-process',
      kind: 'phase_integration_not_run',
      reason: 'phase_integration_scenarios_pending',
    });

    // 可选检查 not_run 不产生缺口。
    const optionalOnly = baseInput();
    optionalOnly.currentChecks = optionalOnly.currentChecks.filter(
      (item: BrownfieldCheckSnapshot) => item.check.checkKey !== 'pending-check',
    );
    optionalOnly.checkScope = {
      requiredCheckKeys: optionalOnly.checkScope.requiredCheckKeys.filter(key => key !== 'pending-check'),
      optionalCheckKeys: optionalOnly.checkScope.optionalCheckKeys,
    };
    const optionalEnvelope = collectBrownfieldEvidenceEnvelope(optionalOnly);
    expect(optionalEnvelope.remainingGaps.some(gap => gap.kind === 'required_check_not_run')).toBe(false);

    // Phase 集成 not_run 状态不可被改为完成。
    expectValidateRejected(tampered(collectedEnvelope(), draft => {
      draft.phaseIntegration[0].status = 'passed';
    }, { recomputeDigest: true }), 'phase_scope_invalid');

    // 工作区预存改动被破坏时明确记录缺口。
    const dirtyLost = baseInput();
    dirtyLost.currentDirtyFiles = dirtyLost.currentDirtyFiles.filter(
      (file: { path: string }) => file.path !== 'src/todo.mjs',
    );
    const dirtyEnvelope = collectBrownfieldEvidenceEnvelope(dirtyLost);
    expect(dirtyEnvelope.workingTreePreservation.status).toBe('changed');
    expect(dirtyEnvelope.remainingGaps).toContainEqual({
      id: 'working-tree-preservation', kind: 'working_tree_changed', reason: 'baseline_dirty_files_not_preserved',
    });

    // 检查范围必须与实际行一致：范围外行与缺失行都拒绝。
    const scopeExtra = baseInput();
    scopeExtra.checkScope = { ...scopeExtra.checkScope, optionalCheckKeys: ['ghost-check'] };
    expectCollectRejected(scopeExtra, 'scope_mismatch');
    const scopeRequiredFlag = baseInput();
    const flagged = scopeRequiredFlag.currentChecks[0]!;
    const flaggedCheck = { ...flagged.check, required: false };
    scopeRequiredFlag.currentChecks[0] = {
      ...flagged,
      check: flaggedCheck,
      commandDigest: computeBrownfieldCheckCommandDigest(flaggedCheck),
    };
    expectCollectRejected(scopeRequiredFlag, 'scope_required_flag_mismatch');
  });
});
