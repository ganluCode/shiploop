import { describe, expect, it } from 'vitest';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  deriveFeatureDagReadiness,
  evaluateFeatureDag,
  validateFeatureDag,
} from '../../../packages/core/src/ports/feature-dag.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);

function node(id: string, status = 'completed') {
  return { id, projectId: 'project-a', phaseId: 'phase-a', status };
}

function edge(featureId: string, dependsOnId: string, integrationEvidence?: unknown, revision = 3) {
  return { featureId, dependsOnId, ...(integrationEvidence === undefined ? {} : { integrationEvidence }), revision };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    integrationId: 'integration-c',
    commitSha: SHA_A,
    targetBaseline: SHA_B,
    evidenceDigest: DIGEST_A,
    planRevision: 2,
    ...overrides,
  };
}

describe('P07 DAG F-004 Feature DAG integration evidence rules', () => {
  it('[case:feature-dag-evidence-status-reasons] classifies single-predecessor evidence into stable reasons', () => {
    const cases = [
      { evidence: null, reason: 'integration_not_ready', ready: false },
      { evidence: evidence({ status: 'pending' }), reason: 'integration_not_ready', ready: false },
      { evidence: evidence({ status: 'stale', staleReasons: ['input_digest_changed'] }), reason: 'integration_stale', ready: false },
      { evidence: evidence({ status: 'blocked', blockReasons: ['verification_failed'] }), reason: 'integration_blocked', ready: false },
      { evidence: evidence({ status: 'drift', staleReasons: ['dependency_edges_changed'] }), reason: 'integration_drift', ready: false },
      { evidence: evidence({ status: 'passed' }), reason: 'ready', ready: true },
      // 旧版无 status 的证据仍表示通过事实（向后兼容）。
      { evidence: evidence(), reason: 'ready', ready: true },
    ] as const;
    for (const item of cases) {
      const result = evaluateFeatureDag({
        projectId: 'project-a',
        phaseId: 'phase-a',
        features: [node('feature-a'), node('feature-c')],
        existingEdges: [edge('feature-c', 'feature-a', item.evidence)],
      });
      const readiness = result.readiness.find((entry) => entry.featureId === 'feature-c')!;
      expect(readiness.reason, JSON.stringify(item.evidence)).toBe(item.reason);
      expect(readiness.ready).toBe(item.ready);
      expect(readiness.dependencyCompleted).toBe(true);
      expect(readiness.dependencyIntegrationReady).toBe(item.ready);
      expect(readiness.dependencyStaleReasons).toEqual(
        item.reason === 'integration_stale' ? ['input_digest_changed']
          : item.reason === 'integration_drift' ? ['dependency_edges_changed'] : [],
      );
      expect(readiness.dependencyBlockReasons).toEqual(
        item.reason === 'integration_blocked' ? ['verification_failed'] : [],
      );
    }
  });

  it('[case:feature-dag-multi-predecessor-evidence] merges multi-predecessor evidence fail-closed', () => {
    const result = evaluateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-a'), node('feature-b'), node('feature-c')],
      existingEdges: [
        edge('feature-c', 'feature-a', evidence({ status: 'passed' })),
        edge('feature-c', 'feature-b', evidence({ integrationId: 'integration-c', status: 'stale', staleReasons: ['target_baseline_changed'] })),
      ],
    });
    const readiness = result.readiness.find((entry) => entry.featureId === 'feature-c')!;
    expect(readiness.dependencyCompleted).toBe(true);
    expect(readiness.dependencyIntegrationReady).toBe(false);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('integration_stale');
    expect(readiness.dependencyStaleReasons).toEqual(['target_baseline_changed']);
    expect(result.readiness.find((entry) => entry.featureId === 'feature-a')).toMatchObject({ integrationReady: false });
  });

  it('[case:feature-dag-completion-integration-separation] keeps business completion separate from code integration', () => {
    const businessOnly = evaluateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-a', 'draft'), node('feature-c')],
      existingEdges: [edge('feature-c', 'feature-a', evidence({ status: 'passed' }))],
    });
    const completedNoEvidence = evaluateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-a'), node('feature-c')],
      existingEdges: [edge('feature-c', 'feature-a', null)],
    });
    expect(businessOnly.readiness.find((entry) => entry.featureId === 'feature-c')).toMatchObject({
      dependencyCompleted: false,
      dependencyCompletion: 'pending',
      dependencyIntegrationReady: true,
      ready: false,
      reason: 'dependency_pending',
    });
    expect(completedNoEvidence.readiness.find((entry) => entry.featureId === 'feature-c')).toMatchObject({
      dependencyCompleted: true,
      dependencyIntegrationReady: false,
      ready: false,
      reason: 'integration_not_ready',
    });
  });

  it('[case:feature-dag-failed-predecessor-dominates] reports dependency failure before integration classification', () => {
    const result = evaluateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-a', 'failed'), node('feature-b'), node('feature-c')],
      existingEdges: [
        edge('feature-c', 'feature-a', evidence({ status: 'stale', staleReasons: ['input_digest_changed'] })),
        edge('feature-c', 'feature-b', null),
      ],
    });
    const readiness = result.readiness.find((entry) => entry.featureId === 'feature-c')!;
    expect(readiness.dependencyCompletion).toBe('failed');
    expect(readiness.reason).toBe('dependency_failed');
    expect(readiness.ready).toBe(false);
    // 稳定原因仍按证据事实聚合，不因业务失败清零。
    expect(readiness.dependencyStaleReasons).toEqual(['input_digest_changed']);
  });

  it('[case:feature-dag-edge-evidence-precedence] prefers edge evidence over predecessor node evidence', () => {
    const result = evaluateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [
        { ...node('feature-a'), integrationEvidence: evidence({ status: 'passed' }) },
        node('feature-c'),
      ],
      existingEdges: [edge('feature-c', 'feature-a', evidence({ integrationId: 'integration-c', status: 'stale', staleReasons: ['target_baseline_changed'] }))],
    });
    expect(result.readiness.find((entry) => entry.featureId === 'feature-c')!.reason).toBe('integration_stale');
    // 未投影边级证据时回退节点级证据（旧调用方兼容）。
    const legacy = deriveFeatureDagReadiness(validateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [
        { ...node('feature-a'), integrationEvidence: evidence({ status: 'passed' }) },
        node('feature-c'),
      ],
      existingEdges: [edge('feature-c', 'feature-a')],
    }));
    expect(legacy.find((entry) => entry.featureId === 'feature-c')).toMatchObject({ ready: true, reason: 'ready' });
  });

  it('[case:feature-dag-stable-revision-output] carries revisions and outputs stable node and edge order', () => {
    const result = evaluateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-c', 'draft'), { ...node('feature-a'), revision: 7 }, node('feature-b')],
      existingEdges: [
        edge('feature-c', 'feature-b', null, 5),
        edge('feature-c', 'feature-a', evidence({ status: 'passed' }), 4),
        edge('feature-b', 'feature-a', evidence({ status: 'passed', integrationId: 'integration-b', commitSha: SHA_B, evidenceDigest: DIGEST_B }), 9),
      ],
    });
    expect(result.features.map((feature) => feature.id)).toEqual(['feature-a', 'feature-b', 'feature-c']);
    expect(result.features.map((feature) => feature.revision)).toEqual([7, undefined, undefined]);
    expect(result.edges.map((edgeEntry) => [edgeEntry.featureId, edgeEntry.dependsOnId, edgeEntry.revision])).toEqual([
      ['feature-b', 'feature-a', 9],
      ['feature-c', 'feature-a', 4],
      ['feature-c', 'feature-b', 5],
    ]);
    expect(result.topologicalOrder).toEqual(['feature-a', 'feature-b', 'feature-c']);
    expect(result.readiness.map((entry) => entry.featureId)).toEqual(['feature-a', 'feature-b', 'feature-c']);
  });

  it('[case:feature-dag-evidence-validation] rejects malformed evidence structurally', () => {
    const invalid = [
      { commitSha: 'heads/main' },
      { commitSha: 'z'.repeat(40) },
      { evidenceDigest: 'short' },
      { planRevision: 0 },
      { planRevision: 1.5 },
      { status: 'unknown' },
      { staleReasons: [''] },
      { staleReasons: ['ok', 1] },
      { blockReasons: ['x'.repeat(65)] },
    ];
    for (const item of invalid) {
      expect(() => validateFeatureDag({
        projectId: 'project-a',
        phaseId: 'phase-a',
        features: [node('feature-a'), node('feature-c')],
        existingEdges: [edge('feature-c', 'feature-a', evidence(item))],
      }), JSON.stringify(item)).toThrowError(StorageError);
    }
  });

  it('[case:feature-dag-candidate-edge-evidence-rejected] keeps evidence out of candidate edges', () => {
    expect(() => validateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-a'), node('feature-c')],
      candidateEdges: [edge('feature-c', 'feature-a', evidence({ status: 'passed' }))],
    })).toThrowError(StorageError);
    // 候选边仍是纯图输入：revision 合法但不携带证据。
    const accepted = validateFeatureDag({
      projectId: 'project-a',
      phaseId: 'phase-a',
      features: [node('feature-a'), node('feature-c')],
      candidateEdges: [edge('feature-c', 'feature-a', undefined, 2)],
    });
    expect(accepted.edges[0]).toMatchObject({ featureId: 'feature-c', dependsOnId: 'feature-a', revision: 2 });
    expect(accepted.edges[0].integrationEvidence).toBeUndefined();
  });
});
