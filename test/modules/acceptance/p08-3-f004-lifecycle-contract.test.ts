/**
 * P08-3 / F-004 单元/契约断言：存量项目生命周期的状态映射与拒绝边界。
 *
 * 本文件只覆盖纯契约（ports 层无 I/O 函数）的状态映射和拒绝边界：
 * - 项目生命周期迁移映射（active→archiving→archived、archived→active、
 *   archived→deleting）与非法迁移的稳定拒绝（restore/archive/delete 各自
 *   只接受契约规定的来源状态）；
 * - 仓库移动预览的身份关系映射（same/different）恒要求显式确认；确认输入
 *   拒绝隐式确认（cancel）、错误 previewDigest、错误项目与漂移旧绑定。
 *
 * 真实 Host 重启、SQLite 持久性、真实仓库移动与归档/恢复执行属 Phase 集成
 * 验收（见 integration 用例与阶段索引），本文件未运行这些场景，保持 not_run。
 */
import { describe, expect, it } from 'vitest';
import { projectLifecycleTransition } from '../../../packages/core/src/ports/data-lifecycle.ts';
import {
  createBrownfieldMovePreview,
  validateBrownfieldMoveConfirmation,
  type BrownfieldBindingRef,
  type BrownfieldMovePreview,
  type BrownfieldRepositoryFacts,
} from '../../../packages/core/src/ports/brownfield.ts';

const HEAD = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

function bindingRef(repoIdentity: string): BrownfieldBindingRef {
  return {
    projectId: PROJECT,
    repositoryBindingId: '33333333-3333-4333-8333-333333333333',
    bindingRevision: 1,
    canonicalPath: '/tmp/legacy-todo-repository',
    repoIdentity,
  };
}

function repositoryFacts(repoIdentity: string, canonicalPath: string): BrownfieldRepositoryFacts {
  return {
    canonicalPath,
    repoIdentity,
    headCommit: HEAD,
    hasInitialCommit: true,
    hasUncommittedChanges: true,
    workingTreeDigest: DIGEST,
  };
}

function previewOf(oldRepoIdentity: string, newRepoIdentity: string, newCanonicalPath: string): BrownfieldMovePreview {
  return createBrownfieldMovePreview({
    schemaVersion: 1,
    projectId: PROJECT,
    projectRevision: 1,
    oldBinding: bindingRef(oldRepoIdentity),
    newRepository: repositoryFacts(newRepoIdentity, newCanonicalPath),
  });
}

function confirmation(preview: BrownfieldMovePreview, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    projectId: preview.projectId,
    oldBinding: preview.oldBinding,
    previewDigest: preview.previewDigest,
    decision: 'confirm',
    ...overrides,
  };
}

describe('P08-3 F-004 存量项目生命周期契约边界', () => {
  it('[case:p08-3-f004-lifecycle-state-mapping] 生命周期状态映射按契约迁移，非法迁移稳定拒绝', () => {
    // 状态映射：归档两段 + 显式恢复 + 删除入口各自由唯一来源状态推进。
    expect(projectLifecycleTransition('archive', 'active')).toBe('archiving');
    expect(projectLifecycleTransition('archiveComplete', 'archiving')).toBe('archived');
    expect(projectLifecycleTransition('restore', 'archived')).toBe('active');
    expect(projectLifecycleTransition('delete', 'archived')).toBe('deleting');

    // 拒绝边界：archiving 中不得重复进入归档；archived 不得再次归档或跳过
    // restore 直接删除以外的推进；active 不得直接恢复或删除。
    expect(projectLifecycleTransition('archive', 'archiving')).toBeNull();
    expect(projectLifecycleTransition('archive', 'archived')).toBeNull();
    expect(projectLifecycleTransition('archiveComplete', 'active')).toBeNull();
    expect(projectLifecycleTransition('archiveComplete', 'archived')).toBeNull();
    expect(projectLifecycleTransition('restore', 'active')).toBeNull();
    expect(projectLifecycleTransition('restore', 'archiving')).toBeNull();
    expect(projectLifecycleTransition('delete', 'active')).toBeNull();
    expect(projectLifecycleTransition('delete', 'archiving')).toBeNull();
    expect(projectLifecycleTransition('delete', 'deleting')).toBeNull();
  });

  it('[case:p08-3-f004-move-preview-rejection-boundaries] 移动预览身份映射恒需显式确认，隐式/漂移确认被拒绝', () => {
    const sameIdentity = `gitdir-sha256:${DIGEST}`;
    const moved = previewOf(sameIdentity, sameIdentity, '/tmp/legacy-todo-moved');
    const replaced = previewOf(sameIdentity, `gitdir-sha256:${'c'.repeat(64)}`, '/tmp/legacy-todo-moved');

    // 身份关系映射：repoIdentity 一致为 same，被替换/换仓为 different；
    // 无论哪种关系都要求显式确认，没有可隐式通过的移动。
    expect(moved).toMatchObject({ identityRelation: 'same', requiresExplicitConfirmation: true });
    expect(replaced).toMatchObject({ identityRelation: 'different', requiresExplicitConfirmation: true });
    expect(moved.previewDigest).not.toBe(replaced.previewDigest);

    // 合法确认按预览身份通过。
    expect(validateBrownfieldMoveConfirmation(confirmation(moved), moved)).toMatchObject({
      projectId: moved.projectId,
      decision: 'confirm',
    });

    // 拒绝边界：cancel 不是可接受决定（移动不能隐式确认或取消执行）。
    expect(() => validateBrownfieldMoveConfirmation(confirmation(moved, { decision: 'cancel' }), moved))
      .toThrow(/decision/);
    // previewDigest 与用户确认的预览不一致。
    expect(() => validateBrownfieldMoveConfirmation(confirmation(moved, { previewDigest: DIGEST }), moved))
      .toThrow(/previewDigest/);
    // 确认属于另一项目。
    expect(() => validateBrownfieldMoveConfirmation(confirmation(moved, { projectId: OTHER_PROJECT }), moved))
      .toThrow(/projectId/);
    // 旧绑定引用漂移（换绑后旧预览不可再用）。
    expect(() => validateBrownfieldMoveConfirmation(
      confirmation(moved, { oldBinding: { ...moved.oldBinding, bindingRevision: 2 } }),
      moved,
    )).toThrow(/bindingRevision/);
  });
});
