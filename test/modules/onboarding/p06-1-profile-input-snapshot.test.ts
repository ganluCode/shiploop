import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_INPUT_SCHEMA_VERSION,
  ContextBuildError,
} from '../../../packages/core/src/ports/context-build.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import {
  validateAttemptInputSnapshot,
} from '../../../packages/core/src/ports/attempt-store.ts';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function profile() {
  return {
    schemaVersion: 1,
    profileVersion: 7,
    profileDigest: digest('profile-v7'),
    confirmationDigest: digest('confirmed-by-owner-v7'),
    modules: [
      { id: 'language-node', version: '1.0.0', reason: 'confirmed_profile_scope_match' },
      { id: 'test-vitest', version: '1.0.0', reason: 'confirmed_profile_dependency' },
    ],
  } as const;
}

function contextInput() {
  return {
    projectId: 'project-1',
    featureId: 'feature-1',
    taskId: 'task-1',
    task: {
      title: '固定画像输入',
      description: '使用确认后的项目能力。',
      acceptance: { criteria: ['画像版本进入 Attempt 快照'] },
      requirementsRefs: [],
      dependencies: [],
      executionConfig: { runtime: 'pi', provider: 'example', model: 'model-1' },
      configSource: 'project_default',
      configSourceKey: 'default',
    },
    checkPolicy: { digest: digest('policy') },
    permissions: { grants: ['repo.read'] },
    profile: profile(),
    requiredInputs: [],
  };
}

function bodyRef(id: string) {
  return {
    artifactId: id,
    version: 1,
    contentHash: digest(id),
    sizeBytes: 10,
    locator: `execution-input-groups/task-1/${id}`,
    mediaType: 'application/json',
  };
}

describe('P06-1 F-004 profile input snapshot boundary', () => {
  it('[case:profile-snapshot-manifest] fixes profile/module identity in ContextBuilder output without inline bodies or paths', () => {
    const result = createContextBuilder({
      budget: {
        maxPromptBytes: 100_000,
        maxRequiredSnapshotBytes: 50_000,
        maxRequiredInputRefs: 8,
        maxHistoryEntries: 4,
        maxHistoryEntryChars: 100,
        bytesPerTokenEstimate: 4,
      },
    }).build(contextInput());

    expect(result.schemaVersion).toBe(CONTEXT_INPUT_SCHEMA_VERSION);
    expect(result.inputSnapshot.profile).toEqual(profile());
    expect(result.inputManifest.sources.find((source) => source.kind === 'profile')).toMatchObject({
      version: 7,
      identity: {
        profileVersion: 7,
        profileDigest: profile().profileDigest,
        confirmationDigest: profile().confirmationDigest,
      },
      required: true,
      selection: '2 pinned modules',
    });
    expect(result.prompt).toContain('language-node@1.0.0');
    expect(result.prompt).toContain('confirmationDigest');
    expect(result.prompt).not.toContain('contentRef');
    expect(result.prompt).not.toContain('repositoryPath');
    expect(result.prompt).not.toContain('secret-body');
  });

  it('[case:profile-unknown-field-fail-closed] rejects malformed profile snapshots and preserves old snapshot compatibility', () => {
    const builder = createContextBuilder({
      budget: {
        maxPromptBytes: 100_000,
        maxRequiredSnapshotBytes: 50_000,
        maxRequiredInputRefs: 8,
        maxHistoryEntries: 4,
        maxHistoryEntryChars: 100,
        bytesPerTokenEstimate: 4,
      },
    });
    expect(() => builder.build({ ...contextInput(), profile: { ...profile(), contentRef: 'secret-body' } })).toThrow(ContextBuildError);
    const built = builder.build(contextInput());
    expect(() => builder.build({ ...contextInput(), profile: { ...profile(), schemaVersion: 99 } })).toThrow(ContextBuildError);

    const prepared = {
      schemaVersion: 4,
      projectId: 'project-1',
      featureId: 'feature-1',
      taskId: 'task-1',
      group: { snapshot: bodyRef('snapshot'), manifest: bodyRef('manifest'), prompt: bodyRef('prompt') },
      requiredInputs: [],
      digests: {
        snapshotDigest: built.digests.snapshotDigest,
        manifestDigest: built.digests.manifestDigest,
        promptDigest: built.digests.promptDigest,
        strategyCopyDigest: digest('strategy'),
        permissionsDigest: digest('permissions'),
      },
      approval: {
        planDigest: digest('plan'),
        checkPolicyDigest: digest('policy'),
        decisionId: null,
        featureRevision: 1,
      },
      profile: profile(),
      taskRevision: 1,
      promptBytes: 1,
      tokenEstimate: { value: 1, kind: 'estimation', method: 'utf8-bytes/4' },
      preparedAtUtcMs: 1,
    };
    expect(validateAttemptInputSnapshot(prepared)).toMatchObject({ profile: profile(), schemaVersion: 4 });
    expect(() => validateAttemptInputSnapshot({ ...prepared, profile: { ...profile(), extra: true } })).toThrow();
    expect(() => validateAttemptInputSnapshot({ ...prepared, profile: { ...profile(), profileVersion: 0 } })).toThrow();
  });
});
