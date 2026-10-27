import { describe, expect, it } from 'vitest';
import {
  buildIntegrationPlanQueryResult,
  type IntegrationPlanQueryView,
} from '../../../packages/core/src/ports/integration-plan-query.ts';
import {
  buildIntegrationPlanCliView,
  formatIntegrationPlanView,
} from '../../../packages/cli/src/app/delivery.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/index.ts';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function view(status: IntegrationPlanQueryView['plan']['status']): IntegrationPlanQueryView {
  return {
    plan: {
      schemaVersion: 1,
      integrationId: 'integration-a',
      projectId: 'project-a',
      phaseId: 'phase-a',
      batchId: 'batch-a',
      successorFeatureId: 'feature-c',
      targetBaseline: SHA,
      mode: 'merge_multiple_predecessors',
      status,
      inputDigest: DIGEST,
      mergeOrder: ['feature-a', 'feature-b'],
      verificationScope: ['typecheck', 'integration-tests'],
      strategySummary: {
        conflictPolicy: 'deterministic-only',
        maxAttempts: 1,
        token: 'must-not-leak',
        workspacePath: '/private/worktree',
      },
      coverage: { approvedInputCount: 2, coveredInputCount: 2, complete: true, missingInputIds: [] },
      blockReasons: status === 'blocked' ? ['integration_evidence_incomplete'] : [],
      staleReasons: status === 'stale' ? ['target_baseline_changed'] : [],
      revision: 3,
      createdAtUtcMs: 1,
      updatedAtUtcMs: 2,
      frozenAtUtcMs: 2,
    },
    predecessors: [
      { featureId: 'feature-a', dependencyPassed: true, commitSha: SHA, evidenceId: 'evidence-a', evidenceDigest: DIGEST, coveredInputIds: ['input-a'], ancestorVerified: true },
      { featureId: 'feature-b', dependencyPassed: true, commitSha: 'c'.repeat(40), evidenceId: 'evidence-b', evidenceDigest: DIGEST, coveredInputIds: ['input-b'], ancestorVerified: true },
    ],
    integrationResult: status === 'integration_passed'
      ? { commitSha: 'd'.repeat(40), treeSha: 'e'.repeat(40), verificationEvidence: { evidenceId: 'verify-a', evidenceDigest: DIGEST }, operationStatus: 'succeeded' }
      : null,
  };
}

describe('P05-6 F-005 integration plan query projection', () => {
  it('[case:integration-query-status-next-step] distinguishes blocked, stale, dependency-passed and passed states', () => {
    expect(buildIntegrationPlanQueryResult(view('blocked')).outcome).toMatchObject({ status: 'blocked', nextStep: 'reconcile_integration' });
    expect(buildIntegrationPlanQueryResult(view('stale')).outcome).toMatchObject({ status: 'stale', nextStep: 'refresh_plan' });
    expect(buildIntegrationPlanQueryResult(view('dependency_passed')).outcome).toMatchObject({ status: 'dependency_passed', nextStep: 'await_integration' });
    expect(buildIntegrationPlanQueryResult(view('integration_passed')).outcome).toMatchObject({ status: 'integration_passed', nextStep: 'none' });
  });

  it('[case:integration-query-redacts-and-bounds] keeps fixed evidence while omitting credentials and native paths', () => {
    const result = buildIntegrationPlanQueryResult(view('blocked'));
    expect(result.integration.integrationId).toBe('integration-a');
    expect(result.predecessors).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('/private/worktree');
    expect(result.integration.strategySummary).toMatchObject({ conflictPolicy: 'deterministic-only', maxAttempts: 1 });
  });

  it('[case:integration-query-wire] validates the public schema and rejects native path or unknown fields', () => {
    const result = buildIntegrationPlanQueryResult(view('integration_passed'));
    expect(validateAppQueryResponse('integration.plan.get', result).integration.integrationId).toBe('integration-a');
    expect(() => validateAppQueryResponse('integration.plan.get', { ...result, leakedPath: '/tmp/worktree' })).toThrow();
  });

  it('[case:integration-query-route-cli] keeps Host route and CLI parser on the same operation identity', () => {
    expect(resolveAppRoute('/v1/integration-plans/integration-a')).toEqual({
      operation: 'integration.plan.get', method: 'GET', pathParam: { name: 'integrationId', value: 'integration-a' },
    });
    expect(parseAppCliArgs(['integration', 'plan', 'integration-a', '--project', 'e205effe-b062-4592-962d-88ed7a0cb267'])).toMatchObject({
      command: 'integration', commandId: 'integration.plan', projectId: 'e205effe-b062-4592-962d-88ed7a0cb267', integrationId: 'integration-a',
    });
  });

  it('[case:integration-query-cli-view] exposes digest, fixed baseline/order and recovery guidance without implying coding rerun', () => {
    const result = buildIntegrationPlanQueryResult(view('stale'));
    const cli = buildIntegrationPlanCliView(result);
    const text = formatIntegrationPlanView(cli);
    expect(cli.completed).toBe(false);
    expect(text).toContain('inputDigest');
    expect(text).toContain('nextStep=refresh_plan');
    expect(text).toContain('不自动重跑编码');
  });
});
