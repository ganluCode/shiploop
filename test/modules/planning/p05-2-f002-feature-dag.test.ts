import { describe, expect, it } from 'vitest';
import {
  FeatureDagError,
  deriveFeatureDagReadiness,
  evaluateFeatureDag,
  validateFeatureDag,
} from '../../../packages/core/src/ports/feature-dag.ts';

const graph = {
  projectId: 'project-a',
  phaseId: 'phase-a',
  features: [
    { id: 'feature-a', projectId: 'project-a', phaseId: 'phase-a', status: 'completed' as const,
      integrationEvidence: { commitSha: 'a'.repeat(40) } },
    { id: 'feature-b', projectId: 'project-a', phaseId: 'phase-a', status: 'completed' as const,
      integrationEvidence: { commitSha: 'b'.repeat(40) } },
    { id: 'feature-c', projectId: 'project-a', phaseId: 'phase-a', status: 'draft' as const },
  ],
  existingEdges: [],
  candidateEdges: [
    { featureId: 'feature-c', dependsOnId: 'feature-b' },
    { featureId: 'feature-c', dependsOnId: 'feature-a' },
  ],
};

describe('P05-2 F-002 Feature DAG rules', () => {
  it('[case:feature-dag-valid-multi-parent] accepts a stable A/B -> C graph', () => {
    const result = evaluateFeatureDag(graph);
    expect(result.edges.map((edge) => [edge.featureId, edge.dependsOnId])).toEqual([
      ['feature-c', 'feature-a'],
      ['feature-c', 'feature-b'],
    ]);
    expect(result.topologicalOrder).toEqual(['feature-a', 'feature-b', 'feature-c']);
    expect(result.readiness.find((item) => item.featureId === 'feature-c')).toMatchObject({
      dependencyCompleted: true,
      dependencyIntegrationReady: true,
      ready: true,
    });
  });

  it('[case:feature-dag-merge-cycle] rejects a cycle formed by existing and candidate edges', () => {
    expect(() => validateFeatureDag({
      projectId: 'project-a', phaseId: 'phase-a',
      features: graph.features,
      existingEdges: [{ featureId: 'feature-a', dependsOnId: 'feature-c' }],
      candidateEdges: graph.candidateEdges,
    })).toThrowError(FeatureDagError);
    try {
      validateFeatureDag({
        projectId: 'project-a', phaseId: 'phase-a', features: graph.features,
        existingEdges: [{ featureId: 'feature-a', dependsOnId: 'feature-c' }],
        candidateEdges: graph.candidateEdges,
      });
    } catch (error) {
      expect(error).toMatchObject({ kind: 'validation', details: { reason: 'cycle' } });
      expect((error as Error).message).not.toMatch(/SELECT|INSERT|feature-c.*feature-a/);
    }
  });

  it('[case:feature-dag-ownership-errors] rejects missing and cross-scope references structurally', () => {
    for (const [reason, edge] of [
      ['missing_feature', { featureId: 'feature-c', dependsOnId: 'missing' }],
      ['cross_project', { projectId: 'project-b', featureId: 'feature-c', dependsOnId: 'feature-a' }],
      ['cross_phase', { phaseId: 'phase-b', featureId: 'feature-c', dependsOnId: 'feature-a' }],
      ['self_dependency', { featureId: 'feature-a', dependsOnId: 'feature-a' }],
    ] as const) {
      expect(() => validateFeatureDag({ ...graph, candidateEdges: [edge] })).toThrowError(FeatureDagError);
      try { validateFeatureDag({ ...graph, candidateEdges: [edge] }); } catch (error) {
        expect(error).toMatchObject({ kind: 'validation', details: { reason } });
      }
    }
    expect(() => validateFeatureDag({ ...graph, candidateEdges: [
      { featureId: 'feature-c', dependsOnId: 'feature-a' },
      { featureId: 'feature-c', dependsOnId: 'feature-a' },
    ] })).toThrowError(FeatureDagError);
  });

  it('[case:feature-dag-integration-separate] keeps dependency completion separate from integration evidence', () => {
    const result = evaluateFeatureDag({
      ...graph,
      features: graph.features.map((feature) => feature.id === 'feature-b'
        ? { ...feature, integrationEvidence: null }
        : feature),
    });
    const c = result.readiness.find((item) => item.featureId === 'feature-c')!;
    expect(c.dependencyCompleted).toBe(true);
    expect(c.dependencyIntegrationReady).toBe(false);
    expect(c.ready).toBe(false);
    expect(result.readiness.find((item) => item.featureId === 'feature-b')).toMatchObject({
      integrationReady: false,
    });
  });

  it('[case:feature-dag-task-boundary] does not inspect Task dependency fields', () => {
    const result = deriveFeatureDagReadiness(validateFeatureDag(graph));
    expect(result.find((item) => item.featureId === 'feature-c')?.ready).toBe(true);
  });
});
