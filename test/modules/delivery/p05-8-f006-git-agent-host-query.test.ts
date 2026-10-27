import { describe, expect, it } from 'vitest';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { validateGitAgentRepairQueryResultWire } from '../../../packages/host/src/client/app-wire.ts';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const digest = 'ab'.repeat(32);
const repair = {
  repairId: 'repair-1', projectId, featureId: 'feature-1', parentBatchId: 'batch-1', sourceOperationId: 'operation-1', runId: 'run-1',
  authorizationDigest: digest, authorizationVersion: 1, blockedReason: null,
  source: { failureKind: 'conflict', evidenceId: 'evidence-1', inputDigest: digest },
  target: { repoIdentity: 'repo-1', baselineCommitSha: 'a'.repeat(40) }, workspaceId: 'workspace-1',
  conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'], intentId: 'intent-1', verificationStrategyId: 'verify-1',
  budget: { remainingAttempts: 1, remainingTokens: 10, remainingRuntimeMs: 100, deadline: '2026-10-25T00:00:00.000Z' },
  attempts: [], sourceOperation: null, candidateOperation: null,
};

describe('P05-8 F-006 GitAgent Host/CLI query protocol', () => {
  it('[case:repair-route-client-shape] resolves repair routes and rejects sensitive response fields', () => {
    expect(resolveAppRoute('/v1/git-repairs')).toMatchObject({ operation: 'git.repairs.list', method: 'GET' });
    expect(resolveAppRoute('/v1/git-repairs/repair-1')).toMatchObject({ operation: 'git.repairs.get', method: 'GET' });
    expect(validateGitAgentRepairQueryResultWire({ schemaVersion: 5, repair }, 'git.repairs.get')).toMatchObject({ repair: { repairId: 'repair-1' } });
    expect(() => validateGitAgentRepairQueryResultWire({ schemaVersion: 5, repair: { ...repair, ownerId: 'secret-owner' } }, 'git.repairs.get')).toThrow();
  });

  it('[case:repair-cli-readonly] parses bounded repair list/detail commands without mutation flags', () => {
    expect(parseAppCliArgs(['git', 'repairs', '--project', projectId, '--limit', '10'])).toMatchObject({ commandId: 'git.repairs' });
    expect(parseAppCliArgs(['git', 'repair', '--project', projectId, 'repair-1'])).toMatchObject({ commandId: 'git.repair' });
  });
});
