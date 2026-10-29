import { describe, expect, it } from 'vitest';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import { AppCliParseError } from '../../../packages/cli/src/app/args.ts';
import { formatRepositoryMovePreview } from '../../../packages/cli/src/app/repository-move.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const target = '/tmp/target-repository';
const preview = {
  schemaVersion: 1,
  projectId,
  projectRevision: 4,
  oldBinding: {
    projectId,
    repositoryBindingId: '22222222-2222-4222-8222-222222222222',
    bindingRevision: 2,
    canonicalPath: '/tmp/old-repository',
    repoIdentity: `gitdir-sha256:${'a'.repeat(64)}`,
  },
  newRepository: {
    canonicalPath: target,
    repoIdentity: `gitdir-sha256:${'b'.repeat(64)}`,
    headCommit: 'c'.repeat(40),
    hasInitialCommit: true,
    hasUncommittedChanges: true,
    workingTreeDigest: 'd'.repeat(64),
  },
  previewDigest: 'e'.repeat(64),
  requiresExplicitConfirmation: true,
  identityRelation: 'different',
} as const;

describe('F-011 CLI project selection and repository move', () => {
  it('accepts an explicit project for overview and move preview', () => {
    expect(parseAppCliArgs(['project', 'overview', '--project', projectId], {}, { cwd: '/tmp' })).toMatchObject({
      commandId: 'project.overview', projectId,
    });
    expect(parseAppCliArgs(['project', 'move-preview', target, '--project', projectId], {}, { cwd: '/tmp' })).toMatchObject({
      commandId: 'project.repository-move-preview', projectId, repositoryPath: target,
    });
    expect(parseAppCliArgs(['project', 'move', 'preview', target, '--project', projectId], {}, { cwd: '/tmp' })).toMatchObject({
      commandId: 'project.repository-move-preview', projectId, repositoryPath: target,
    });
  });

  it('requires a target, preview file and explicit confirmation for non-interactive move', () => {
    expect(() => parseAppCliArgs(['project', 'move', '--project', projectId, '--confirm'], {}, { cwd: '/tmp' }))
      .toThrow(AppCliParseError);
    expect(() => parseAppCliArgs(['project', 'move', target, '--project', projectId], {}, { cwd: '/tmp' }))
      .toThrow(AppCliParseError);
    expect(parseAppCliArgs([
      'project', 'move', target, '--project', projectId, '--preview-file', '/tmp/move-preview.json', '--confirm',
    ], {}, { cwd: '/tmp' })).toMatchObject({
      commandId: 'project.repository-move-confirm', projectId, repositoryPath: target,
      previewFile: '/tmp/move-preview.json', confirm: true,
    });
  });

  it('shows old/new identity and explicit confirmation risk without exposing remote-based selection', () => {
    const text = formatRepositoryMovePreview(preview);
    expect(text).toContain('projectId=11111111-1111-4111-8111-111111111111');
    expect(text).toContain('旧 repoIdentity=gitdir-sha256:');
    expect(text).toContain('新 repoIdentity=gitdir-sha256:');
    expect(text).toContain('必须显式确认');
    expect(text).toContain('不会按 remote 自动选择或合并项目');
  });
});
