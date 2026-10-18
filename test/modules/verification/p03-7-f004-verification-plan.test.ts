import { describe, expect, it } from 'vitest';
import type { TestCandidateSelection } from '../../../packages/core/src/application/verification-candidates.ts';
import {
  buildVerificationPlan,
  type VerificationPlan,
} from '../../../packages/core/src/application/verification-plan.ts';

const DIGEST = 'ab'.repeat(32);
const POLICY = {
  requireChecksBeforeDone: true,
  checkDefinitions: [
    {
      checkKey: 'unit-core', scope: 'module', kind: 'command',
      argv: ['node', 'scripts/run-tests.ts', 'test/core.test.ts'], cwdRef: 'packages/core',
      environmentRef: 'minimal', timeout: 120_000, required: true, requirementRefs: ['core'],
    },
    {
      checkKey: 'quick-contract', scope: 'task', kind: 'command',
      argv: ['node', 'scripts/check-contract.ts'], cwdRef: null,
      environmentRef: null, timeout: 30_000, required: true, requirementRefs: [],
    },
    {
      checkKey: 'unit-cli', scope: 'module', kind: 'command',
      argv: ['node', 'scripts/run-tests.ts', 'test/cli.test.ts'], cwdRef: 'packages/cli',
      environmentRef: 'minimal', timeout: 120_000, required: false, requirementRefs: [],
    },
    {
      checkKey: 'full-suite', scope: 'project', kind: 'command',
      argv: ['node', 'scripts/run-tests.ts'], cwdRef: null,
      environmentRef: 'minimal', timeout: 600_000, required: true, requirementRefs: ['all'],
    },
  ],
  modules: [
    {
      moduleKey: 'core', allowedTargets: ['packages/core'], impactScope: ['packages/core'],
      sharedHighRiskFiles: ['package.json', 'package-lock.json', 'scripts/run-tests.ts'],
    },
    {
      moduleKey: 'cli', allowedTargets: ['packages/cli'], impactScope: ['packages/cli'],
      sharedHighRiskFiles: [],
    },
  ],
  fullFallback: { checkRefs: ['full-suite', 'quick-contract', 'unit-core'], moduleRefs: ['core', 'cli'] },
} as const;

function candidate(...modules: string[]): TestCandidateSelection {
  return {
    ok: true,
    candidateDigest: DIGEST,
    artifact: { artifactId: 'candidate-1', contentHash: DIGEST, sizeBytes: 10 },
    modules: modules.map((moduleKey) => ({
      moduleKey,
      reason: `变更 ${moduleKey}`,
      targets: [{ target: `${moduleKey === 'core' ? 'packages/core' : 'packages/cli'}/src/index.ts`, kind: 'file', fingerprint: DIGEST }],
    })),
  };
}

function plan(input: Record<string, unknown>): VerificationPlan {
  return buildVerificationPlan({ policy: POLICY, ...input });
}

describe('P03-7 F-004 分层检查计划', () => {
  it('有效候选覆盖全部受影响模块时只选择局部检查和必需快速检查', () => {
    const result = plan({
      changedPaths: ['packages/core/src/index.ts'],
      candidate: candidate('core'),
    });

    expect(result.status).toBe('ready');
    expect(result.mode).toBe('candidates');
    expect(result.affectedModules).toEqual(['core']);
    expect(result.coveredModules).toEqual(['core']);
    expect(result.selectedCheckKeys).toEqual(['unit-core', 'quick-contract']);
    expect(result.unselectedCheckKeys).toEqual(['unit-cli', 'full-suite']);
    expect(result.selectedChecks[0]).toMatchObject({
      argv: ['node', 'scripts/run-tests.ts', 'test/core.test.ts'],
      cwdRef: 'packages/core', environmentRef: 'minimal', timeout: 120_000,
    });
    expect(result.reasonCode).toBe('candidate_covered');
  });

  it('候选缺失时安全回退全量，并显式保留受影响模块与未启动局部检查', () => {
    const result = plan({
      changedPaths: ['packages/core/src/index.ts'],
      candidate: null,
    });

    expect(result.status).toBe('ready');
    expect(result.mode).toBe('full_fallback');
    expect(result.reasonCode).toBe('candidate_missing');
    expect(result.affectedModules).toEqual(['core']);
    expect(result.coveredModules).toEqual(['core', 'cli']);
    expect(result.selectedCheckKeys).toEqual(['full-suite', 'quick-contract', 'unit-core']);
    expect(result.unselectedCheckKeys).toEqual(['unit-cli']);
    expect(result.candidateRejection).toMatchObject({ reason: 'candidate_missing' });
  });

  it('过期候选、多模块漏选和共享高风险文件都拒绝局部放行', () => {
    const stale = plan({
      changedPaths: ['packages/core/src/index.ts'],
      candidate: { ok: false, reason: 'stale_execution_version', detail: '过期' },
    });
    expect(stale.mode).toBe('full_fallback');
    expect(stale.reasonCode).toBe('candidate_invalid');
    expect(stale.candidateRejection?.reason).toBe('stale_execution_version');

    const missingModule = plan({
      changedPaths: ['packages/core/src/index.ts', 'packages/cli/src/index.ts'],
      candidate: candidate('core'),
    });
    expect(missingModule.mode).toBe('full_fallback');
    expect(missingModule.reasonCode).toBe('candidate_missing_module');
    expect(missingModule.affectedModules).toEqual(['core', 'cli']);
    expect(missingModule.coveredModules).toEqual(['core', 'cli']);

    const highRisk = plan({
      changedPaths: ['package.json'],
      candidate: candidate('core'),
    });
    expect(highRisk.mode).toBe('full_fallback');
    expect(highRisk.reasonCode).toBe('shared_high_risk_change');
    expect(highRisk.affectedModules).toEqual(['core', 'cli']);
  });

  it('tracked、untracked 和删除路径都参与影响判定，未知路径形态安全回退', () => {
    const result = plan({
      changedPaths: ['packages/cli/new.ts', 'packages/core/removed.ts'],
      candidate: candidate('core', 'cli'),
    });
    expect(result.mode).toBe('candidates');
    expect(result.affectedModules).toEqual(['core', 'cli']);

    const invalidPath = plan({
      changedPaths: ['../outside.ts'],
      candidate: candidate('core'),
    });
    expect(invalidPath.mode).toBe('full_fallback');
    expect(invalidPath.reasonCode).toBe('impact_input_invalid');
  });

  it('全量回退缺失或缺少必需检查时返回 error，不生成空计划或部分计划', () => {
    const missingFallback = buildVerificationPlan({
      policy: { ...POLICY, fullFallback: undefined },
      changedPaths: ['packages/core/src/index.ts'],
      candidate: null,
    });
    expect(missingFallback.status).toBe('error');
    expect(missingFallback.mode).toBe('full_fallback');
    expect(missingFallback.selectedCheckKeys).toEqual([]);

    const incompleteFallback = buildVerificationPlan({
      policy: {
        ...POLICY,
        fullFallback: { checkRefs: ['unit-core'], moduleRefs: ['core', 'cli'] },
      },
      changedPaths: ['packages/core/src/index.ts'],
      candidate: null,
    });
    expect(incompleteFallback.status).toBe('inconclusive');
    expect(incompleteFallback.selectedCheckKeys).toEqual([]);
    expect(incompleteFallback.reasonCode).toBe('fallback_missing_required_check');
  });
});
