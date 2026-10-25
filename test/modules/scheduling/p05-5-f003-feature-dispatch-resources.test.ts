import { describe, expect, it } from 'vitest';
import { deriveFeatureDispatchResourceSet } from '../../../packages/core/src/ports/feature-resources.ts';

describe('P05-5 F-003 Feature dispatch resource admission', () => {
  it('[case:dispatch-resource-set] derives mandatory coding resources and preserves approved declarations', () => {
    const set = deriveFeatureDispatchResourceSet({
      projectId: 'project-1',
      featureId: 'feature-1',
      purpose: 'code',
      batch: {
        scopeSnapshot: { featureIds: ['feature-1', 'feature-2'] },
        configSnapshot: {
          resources: [{ kind: 'contract', key: 'contract:public-api' }],
        },
      },
    });

    expect(set.resources.map(resource => resource.key)).toEqual([
      'project:project-1:feature-code',
      'project:project-1:contract:public-api',
      'project:project-1:worktree:feature-1',
    ]);
  });

  it('[case:planning-exclusive-resource] gives planning runs the planning resource and rejects scope drift', () => {
    expect(deriveFeatureDispatchResourceSet({
      projectId: 'project-1', featureId: 'feature-1', purpose: 'plan',
      batch: { scopeSnapshot: { featureIds: ['feature-1'] }, configSnapshot: {} },
    }).resources.map(resource => resource.key)).toEqual(['project:project-1:planning']);

    expect(() => deriveFeatureDispatchResourceSet({
      projectId: 'project-1', featureId: 'feature-3', purpose: 'code',
      batch: { scopeSnapshot: { featureIds: ['feature-1'] }, configSnapshot: {} },
    })).toThrow(/scope|范围|Feature/);
  });
});
