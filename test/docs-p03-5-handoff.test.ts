import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new URL('../docs/p03-5-handoff.md', import.meta.url);

describe('F-013 workspace integration handoff', () => {
  it('hands off delivered workspace surfaces with real-resource evidence, recovery boundary and not_run gaps', () => {
    const text = readFileSync(doc, 'utf8');
    for (const term of [
      'T08', 'T29', 'T36', 'not_run', 'accept:p03',
      'P03-6', 'P03-8', 'P03-9', 'P03-10',
      'feature_worktree_directory', 'deriveManagedFeatureBranch',
      'GitPublicMetadataLock', 'WorkspaceInspector', 'decideWorkspaceCleanup',
      'workspacePreparation', 'workspaceRetention', 'workspaceCleaner', 'workspaceDiscard',
      'managed_workspaces', 'workspace_operations', 'workspace_leases',
      'shiploop/feature/', 'git worktree remove', 'quarantined',
      'runtimeRecovery', 'not_evaluated', 'scheduler_not_assembled',
      'runtime_starts', 'execution.start', 'preparation_failed',
      'p03-5-feature-integration.test.ts',
      'p03-5-workspace-host-integration.test.ts',
      'p03-5-cli-workspace-built.test.ts',
      'p03-5-workspace-preparation.test.ts',
      'p03-5-workspace-retention.test.ts',
      'p03-5-workspace-cleaner.test.ts',
      'p03-5-workspace-discard.test.ts',
      'p03-5-git-operation-lock.test.ts',
      'docs/p03-5-workspace-preparation-recovery-contract.md',
      'core-design/14-runtime-recovery-and-durable.md',
      'verifications/F-013/',
      'npm run verify', 'git diff --check',
    ]) expect(text, term).toContain(term);
    // 一次性占位符必须在交接定稿前替换为真实结果；未替换即失败。
    expect(text).not.toContain('VERIFY_TEST_SUMMARY');
    expect(text).not.toContain('BOUNDARY_SUMMARY');
    // 不宣称本 Feature 之外的能力：真实 SDK/模型、阶段验收均为 not_run 语义。
    expect(text).toContain('真实 Pi SDK/付费模型：**not_run**');
  });
});
