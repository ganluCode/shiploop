/**
 * F-008 工作区清理资格判定（纯判定）契约测试。
 *
 * 验收覆盖：
 * 1. 正常组：安全完整成功 + 停止确认 + 无占用 + 交付完成 + 清理授权 → 可清理；
 * 2. 关键负例表驱动：失败/partial/人审等待/提交失败/缺证据/脏内容/ignored 保护等
 *    逐项拒绝（保留或隔离），Runtime completed 或 git status 干净本身不足；
 * 3. 证据缺失/非法/过期不能被当作安全输入；
 * 4. 纯判定：不删目录、不运行 Git、不变更 Task/Feature 结果（无 I/O 依赖、不改输入）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideWorkspaceCleanup } from '../packages/core/src/application/workspace-cleanup-policy.ts';
import { validateWorkspaceCleanupInput, WORKSPACE_CLEANUP_REASONS } from '../packages/core/src/ports/workspace-cleanup.ts';
import { StorageError } from '../packages/core/src/ports/errors.ts';
import type { WorkspaceCleanupInput, WorkspaceCleanupOutcome, WorkspaceCleanupReason } from '../packages/core/src/ports/workspace-cleanup.ts';

const NOW = 1_700_000_000_000;

/** 测试夹具需要逐字段打补丁：深度可变镜像（契约本身保持只读）。 */
type DeepMutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T[K] extends object ? DeepMutable<T[K]> : T[K] };

function evidence(overrides: Partial<{ ref: string; observedAtUtcMs: number; expiresAtUtcMs: number }> = {}) {
  return { ref: 'ev-1', observedAtUtcMs: NOW - 1_000, expiresAtUtcMs: NOW + 60_000, ...overrides };
}

function baseInput(): DeepMutable<WorkspaceCleanupInput> {
  return {
    nowUtcMs: NOW,
    inspection: { verified: true, scanComplete: true, evidence: [evidence()] },
    execution: { runtimeOutcome: 'completed', acceptance: 'passed', manualReview: 'none', evidence: [evidence()] },
    stop: { state: 'confirmed', evidence: [evidence()] },
    occupancy: { activeLeases: 0, processActive: false, quarantined: false, evidence: [evidence()] },
    delivery: { artifactsPolicy: 'not_required', artifactsSaved: false, commitCapability: 'assembled',
      commitStatus: 'not_required', requiredDeliveriesComplete: true, evidence: [evidence()] },
    contents: { trackedChanges: 0, untrackedChanges: 0, ignored: [], evidence: [evidence()] },
    authorization: { autoCleanup: true, grantedBy: 'principal-1', evidence: [evidence()] },
  };
}

function mutate(patch: (input: ReturnType<typeof baseInput>) => void): ReturnType<typeof baseInput> {
  const input = baseInput();
  patch(input);
  return input;
}

function expectDecision(input: WorkspaceCleanupInput, outcome: WorkspaceCleanupOutcome, reasons: readonly WorkspaceCleanupReason[]) {
  const decision = decideWorkspaceCleanup(input);
  expect(decision.outcome).toBe(outcome);
  for (const reason of reasons) expect(decision.reasons).toContain(reason);
  if (outcome !== 'cleanable') expect(decision.reasons.length).toBeGreaterThan(0);
  for (const gate of decision.gates) {
    if (gate.status === 'refused') expect(gate.reasons.length).toBeGreaterThan(0);
    for (const reason of gate.reasons) expect(WORKSPACE_CLEANUP_REASONS).toContain(reason);
  }
  expect(decision.checkedAtUtcMs).toBe(input.nowUtcMs);
  return decision;
}

describe('p03-5 workspace cleanup eligibility — normal', () => {
  it('安全完整成功 + 停止确认 + 无占用 + 交付完成 + 清理授权 → 可清理', () => {
    const decision = expectDecision(baseInput(), 'cleanable', ['safe_complete_success', 'cleanup_authorized']);
    expect(decision.gates.every(g => g.status === 'passed')).toBe(true);
  });

  it('明确未启动（not_started）也可作为无进程的安全输入', () => {
    const input = mutate(i => { i.stop = { state: 'not_started', evidence: [evidence()] }; });
    expectDecision(input, 'cleanable', ['safe_complete_success']);
  });

  it('已确认可再生的 ignored 内容且成果已保存不阻止清理', () => {
    const input = mutate(i => {
      i.delivery = { ...i.delivery, artifactsPolicy: 'save_required', artifactsSaved: true };
      i.contents = { ...i.contents, ignored: [{ classification: 'regenerable_confirmed', count: 2 }] };
    });
    expectDecision(input, 'cleanable', ['safe_complete_success']);
  });

  it('Runtime completed 但无清理授权 → 默认保留', () => {
    const input = mutate(i => { i.authorization = { autoCleanup: false, grantedBy: null, evidence: [evidence()] }; });
    expectDecision(input, 'retain', ['authorization_missing']);
  });
});

interface NegativeCase {
  readonly name: string;
  readonly patch: (input: ReturnType<typeof baseInput>) => void;
  readonly outcome: WorkspaceCleanupOutcome;
  readonly reason: WorkspaceCleanupReason;
}

const NEGATIVES: readonly NegativeCase[] = [
  // 执行/验收结论
  { name: 'Runtime completed 但验收 pending 不足以清理', patch: i => { i.execution.acceptance = 'pending'; }, outcome: 'retain', reason: 'acceptance_pending' },
  { name: '验收 failed 拒绝', patch: i => { i.execution.acceptance = 'failed'; }, outcome: 'retain', reason: 'acceptance_failed' },
  { name: '验收结论未知拒绝', patch: i => { i.execution.acceptance = 'unknown'; }, outcome: 'retain', reason: 'acceptance_unknown' },
  { name: 'partial 执行拒绝', patch: i => { i.execution.runtimeOutcome = 'partial'; }, outcome: 'retain', reason: 'execution_partial' },
  { name: 'Runtime failed 拒绝', patch: i => { i.execution.runtimeOutcome = 'failed'; }, outcome: 'retain', reason: 'execution_failed' },
  { name: 'Runtime 结论未知拒绝', patch: i => { i.execution.runtimeOutcome = 'unknown'; }, outcome: 'retain', reason: 'execution_unknown' },
  { name: '人审等待拒绝', patch: i => { i.execution.manualReview = 'waiting'; }, outcome: 'retain', reason: 'manual_review_waiting' },
  // 停止证据与占用
  { name: '停止证据未知 → 隔离', patch: i => { i.stop.state = 'unknown'; }, outcome: 'quarantine', reason: 'stop_unknown' },
  { name: '活动进程 → 隔离', patch: i => { i.occupancy.processActive = true; }, outcome: 'quarantine', reason: 'process_active' },
  { name: '活动占用 → 隔离', patch: i => { i.occupancy.activeLeases = 1; }, outcome: 'quarantine', reason: 'occupancy_active' },
  { name: '隔离状态 → 隔离', patch: i => { i.occupancy.quarantined = true; }, outcome: 'quarantine', reason: 'occupancy_quarantined' },
  // 提交/交付政策
  { name: '未装配 P03-8 提交能力保守保留', patch: i => { i.delivery.commitCapability = 'not_assembled'; i.delivery.commitStatus = 'succeeded'; }, outcome: 'retain', reason: 'commit_not_assembled' },
  { name: '提交失败拒绝', patch: i => { i.delivery.commitStatus = 'failed'; }, outcome: 'retain', reason: 'commit_failed' },
  { name: '提交未完成拒绝', patch: i => { i.delivery.commitStatus = 'pending'; }, outcome: 'retain', reason: 'commit_pending' },
  { name: '成果保存政策未确认拒绝', patch: i => { i.delivery.artifactsPolicy = 'unconfirmed'; }, outcome: 'retain', reason: 'artifact_policy_unconfirmed' },
  { name: '成果未按确认政策保存拒绝', patch: i => { i.delivery.artifactsPolicy = 'save_required'; i.delivery.artifactsSaved = false; }, outcome: 'retain', reason: 'artifacts_not_saved' },
  { name: '必需交付未完成拒绝', patch: i => { i.delivery.requiredDeliveriesComplete = false; }, outcome: 'retain', reason: 'delivery_incomplete' },
  // 内容清单保护
  { name: 'tracked 改动拒绝', patch: i => { i.contents.trackedChanges = 1; }, outcome: 'retain', reason: 'tracked_changes' },
  { name: 'untracked 改动拒绝', patch: i => { i.contents.untrackedChanges = 1; }, outcome: 'retain', reason: 'untracked_changes' },
  { name: '受保护 ignored 内容拒绝', patch: i => { i.contents.ignored = [{ classification: 'protected', count: 1 }]; }, outcome: 'retain', reason: 'ignored_protected' },
  { name: '未分类 ignored 内容默认保护', patch: i => { i.contents.ignored = [{ classification: 'unclassified', count: 1 }]; }, outcome: 'retain', reason: 'ignored_unclassified' },
  // 核验与扫描
  { name: '未经核验的工作区拒绝', patch: i => { i.inspection.verified = false; }, outcome: 'retain', reason: 'workspace_unverified' },
  { name: '不完整扫描拒绝', patch: i => { i.inspection.scanComplete = false; }, outcome: 'retain', reason: 'scan_incomplete' },
];

describe('p03-5 workspace cleanup eligibility — key negatives', () => {
  for (const c of NEGATIVES) {
    it(c.name, () => {
      expectDecision(mutate(c.patch), c.outcome, [c.reason]);
    });
  }

  it('多个门槛同时失败时逐项列出结构化原因', () => {
    const input = mutate(i => {
      i.execution.acceptance = 'pending';
      i.contents.trackedChanges = 3;
      i.delivery.commitStatus = 'failed';
    });
    const decision = expectDecision(input, 'retain', ['acceptance_pending', 'commit_failed', 'tracked_changes']);
    expect(decision.reasons).toContain('acceptance_pending');
    expect(decision.reasons).toContain('commit_failed');
    expect(decision.reasons).toContain('tracked_changes');
  });
});

describe('p03-5 workspace cleanup eligibility — evidence', () => {
  it('未提供证据不能被当作安全输入', () => {
    const input = mutate(i => { i.execution.evidence = []; });
    expectDecision(input, 'retain', ['evidence_missing']);
  });

  it('非法证据（时间关系不成立）不能被当作安全输入', () => {
    const input = mutate(i => { i.stop.evidence = [evidence({ expiresAtUtcMs: NOW - 2_000 })]; });
    expectDecision(input, 'quarantine', ['evidence_invalid']);
  });

  it('未来时间的证据不能被当作安全输入', () => {
    const input = mutate(i => { i.execution.evidence = [evidence({ observedAtUtcMs: NOW + 1 })]; });
    expectDecision(input, 'retain', ['evidence_invalid']);
  });

  it('过期证据不能被当作安全输入', () => {
    const input = mutate(i => { i.delivery.evidence = [evidence({ expiresAtUtcMs: NOW - 1 })]; });
    expectDecision(input, 'retain', ['evidence_expired']);
  });

  it('任一条证据过期则整组证据不可用', () => {
    const input = mutate(i => {
      i.execution.evidence = [evidence(), evidence({ ref: 'ev-2', expiresAtUtcMs: NOW - 1 })];
    });
    expectDecision(input, 'retain', ['evidence_expired']);
  });

  it('结构非法的输入在校验边界拒绝', () => {
    expect(() => validateWorkspaceCleanupInput({ ...baseInput(), extra: 1 })).toThrow(StorageError);
    expect(() => validateWorkspaceCleanupInput({ ...baseInput(), nowUtcMs: 'now' })).toThrow(StorageError);
    expect(() => decideWorkspaceCleanup({ ...baseInput(), authorization: { autoCleanup: true, grantedBy: null, evidence: [evidence()] } })).toThrow(StorageError);
    expect(() => decideWorkspaceCleanup({ ...baseInput(), contents: { ...baseInput().contents, ignored: [{ classification: 'whatever', count: 1 }] } })).toThrow(StorageError);
    expect(() => decideWorkspaceCleanup(null)).toThrow(StorageError);
  });
});

describe('p03-5 workspace cleanup eligibility — pure decision', () => {
  it('判定不修改输入（冻结输入仍可判定且输入不变）', () => {
    const input = baseInput();
    const before = JSON.stringify(input);
    const frozen = Object.freeze(structuredClone(input));
    const decision = decideWorkspaceCleanup(frozen);
    expect(decision.outcome).toBe('cleanable');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('判定模块不引入文件系统、Git 或进程能力', () => {
    for (const rel of ['../packages/core/src/application/workspace-cleanup-policy.ts', '../packages/core/src/ports/workspace-cleanup.ts']) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(source).not.toMatch(/node:fs|node:child_process|node:process|execFile|spawnSync|simple-git/);
    }
  });
});
