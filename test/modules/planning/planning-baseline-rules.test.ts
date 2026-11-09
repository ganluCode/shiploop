/**
 * DAG / F-002 规划基线纯规则（unit；无 I/O）。
 *
 * 覆盖：computePlanningCodeBaselineDigest 覆盖仓库绑定身份且兼容历史快照摘要
 * 公式；绑定身份字段成组校验（fail-closed）；resolveWorkspaceBaseCommit 优先级
 * （集成基线 → 已批准规划冻结快照 → 预览 HEAD）与绑定不一致结构化拒绝；
 * planning_workspace_directory 受控派生与编码 worktree 严格分离。
 *
 * 真实 SQLite/Git 纵向（准备/重核/快照准备器）见 planning-baseline-separation.test.ts。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computePlanningCodeBaselineDigest,
  PLANNING_SNAPSHOT_DIGEST_DOMAIN,
  validatePlanningCodeBaseline,
} from '../../../packages/core/src/ports/planning-input-prepare.ts';
import type { PlanningCodeBaseline } from '../../../packages/core/src/ports/planning-input-prepare.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import { resolveWorkspaceBaseCommit } from '../../../packages/core/src/application/execution-start.ts';
import type { ExecutionStartServiceDeps } from '../../../packages/core/src/application/execution-start.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';
import { derivePlanningWorkspaceRelativeDir } from '../../../packages/core/src/ports/path-service.ts';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const domainDigest = (domain: string, canonical: string): string =>
  createHash('sha256').update(`${domain}\n${canonical}`, 'utf8').digest('hex');

function baseline(overrides: Partial<PlanningCodeBaseline> = {}): PlanningCodeBaseline {
  return {
    worktreeId: 'binding-0001',
    headCommit: 'a'.repeat(40),
    codeDigest: 'b'.repeat(64),
    repositoryBindingId: 'binding-0001',
    repositoryBindingRevision: 3,
    repoIdentity: 'gitdir-sha256:' + 'c'.repeat(64),
    ...overrides,
  };
}

describe('DAG / F-002 规划基线纯规则（无 I/O）', () => {
  it('[case:baseline-digest-covers-binding] 摘要覆盖仓库绑定身份：仅绑定 revision 或 repoIdentity 不同即摘要不同', () => {
    const base = baseline();
    expect(computePlanningCodeBaselineDigest({ ...base, repositoryBindingRevision: 4 }))
      .not.toBe(computePlanningCodeBaselineDigest(base));
    expect(computePlanningCodeBaselineDigest({ ...base, repoIdentity: 'gitdir-sha256:' + 'd'.repeat(64) }))
      .not.toBe(computePlanningCodeBaselineDigest(base));
    expect(computePlanningCodeBaselineDigest({ ...base, repositoryBindingId: 'binding-0002' }))
      .not.toBe(computePlanningCodeBaselineDigest(base));
  });

  it('[case:baseline-legacy-digest-compat] 历史基线（无绑定字段）摘要公式保持不变（已持久化快照重核兼容）', () => {
    const legacy: PlanningCodeBaseline = {
      worktreeId: 'binding-0001', headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64),
    };
    const legacyFormula = domainDigest(PLANNING_SNAPSHOT_DIGEST_DOMAIN,
      stableStringify({ worktreeId: legacy.worktreeId, headCommit: legacy.headCommit, codeDigest: legacy.codeDigest }));
    expect(computePlanningCodeBaselineDigest(legacy)).toBe(legacyFormula);
  });

  it('[case:baseline-binding-group-validation] 绑定身份字段必须成组出现且形态合法（fail-closed）', () => {
    const context = { operation: 'test' };
    expect(() => validatePlanningCodeBaseline({
      worktreeId: 'binding-0001', headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64),
      repositoryBindingId: 'binding-0001',
    }, context, 'baseline')).toThrow();
    expect(() => validatePlanningCodeBaseline({
      worktreeId: 'binding-0001', headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64),
      repositoryBindingId: 'binding-0001', repositoryBindingRevision: 0, repoIdentity: 'gitdir-sha256:' + 'c'.repeat(64),
    }, context, 'baseline')).toThrow();
    const valid = validatePlanningCodeBaseline(baseline(), context, 'baseline');
    expect(valid.repositoryBindingId).toBe('binding-0001');
    expect(valid.repositoryBindingRevision).toBe(3);
  });
});

describe('DAG / F-002 编码基线解析（resolveWorkspaceBaseCommit）', () => {
  const binding = { id: 'binding-0001', bindingRevision: 3 };
  const depsOf = (overrides: Partial<ExecutionStartServiceDeps>) => overrides as ExecutionStartServiceDeps;

  it('[case:base-commit-precedence] 优先级：集成基线 > 已批准规划冻结快照 > 预览捕获 HEAD', () => {
    const frozen = 'f'.repeat(40);
    const fresh = 'e'.repeat(40);
    const deps = depsOf({
      integrationBaseline: () => ({ baseCommit: 'd'.repeat(40) }),
      approvedPlanningBaseline: () => ({ headCommit: frozen, repositoryBindingId: binding.id,
        repositoryBindingRevision: 3, runId: 'run-1', candidateId: 'candidate-1' }),
    });
    expect(resolveWorkspaceBaseCommit(deps, 'p1', 'feat-1', binding, fresh)).toBe('d'.repeat(40));

    const planningDeps = depsOf({
      approvedPlanningBaseline: () => ({ headCommit: frozen, repositoryBindingId: binding.id,
        repositoryBindingRevision: 3, runId: 'run-1', candidateId: 'candidate-1' }),
    });
    expect(resolveWorkspaceBaseCommit(planningDeps, 'p1', 'feat-1', binding, fresh)).toBe(frozen);

    expect(resolveWorkspaceBaseCommit(depsOf({}), 'p1', 'feat-1', binding, fresh)).toBe(fresh);
  });

  it('[case:base-commit-binding-mismatch] 规划快照仓库绑定与当前绑定不一致：结构化拒绝（planning_baseline_binding_mismatch）', () => {
    const deps = depsOf({
      approvedPlanningBaseline: () => ({ headCommit: 'f'.repeat(40), repositoryBindingId: 'binding-other',
        repositoryBindingRevision: 9, runId: 'run-1', candidateId: 'candidate-1' }),
    });
    try {
      resolveWorkspaceBaseCommit(deps, 'p1', 'feat-1', binding, 'e'.repeat(40));
      expect.unreachable('expected planning_baseline_binding_mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(PublicError);
      const publicError = error as PublicError;
      expect(publicError.code).toBe('conflict');
      expect((publicError.details as Record<string, unknown> | undefined)?.reason).toBe('planning_baseline_binding_mismatch');
    }
  });
});

describe('DAG / F-002 planning_workspace_directory 受控定位', () => {
  it('[case:planning-workspace-derivation] 派生路径与编码 worktree 严格分离', () => {
    expect(derivePlanningWorkspaceRelativeDir('proj-1', 'feat-1'))
      .toBe('projects/proj-1/planning/feat-1');
    expect(derivePlanningWorkspaceRelativeDir('proj-1', 'feat-1'))
      .not.toContain('worktrees');
  });
});
