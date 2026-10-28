import { createHash } from 'node:crypto';
import {
  createBrownfieldMovePreview,
  validateBrownfieldMoveConfirmation,
  validateBrownfieldMovePreview,
  type BrownfieldMovePreview,
  type BrownfieldRepositoryFacts,
} from '../ports/brownfield.js';
import {
  authorizeProjectRead,
  assertTrustedPrincipal,
  requireCapability,
  requireProjectVisible,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import { stableCanonicalJson } from '../ports/command-receipts.js';
import { StorageError } from '../ports/errors.js';
import {
  RepositoryInspectionError,
  validateRepositoryInspectionPath,
} from '../ports/repository-inspector.js';
import type { RepositoryInspection, RepositoryInspector } from '../ports/repository-inspector.js';
import type { RepositoryRebindResult, StateStore } from '../ports/state-store.js';
import { rejectUnknownKeys, requirePlainObject, validationError } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { validateStableId } from '../ports/validation.js';

const PREVIEW_OPERATION = 'repository.move.preview';
const CONFIRM_OPERATION = 'repository.move.confirm';

export interface RepositoryMovePreviewRequest {
  readonly projectId: string;
  readonly repositoryPath: string;
}

export interface RepositoryMoveConfirmationRequest {
  readonly preview: BrownfieldMovePreview;
  readonly decision: unknown;
}

export interface RepositoryMoveConfirmationPlan {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly expectedBindingRevision: number;
  readonly expectedBindingId: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string | null;
  readonly repoIdentity: string;
}

export interface RepositoryMoveService {
  /** Read-only Git/filesystem inspection; no project or binding writes. */
  preview(principal: TrustedPrincipal, input: unknown): Promise<BrownfieldMovePreview>;
  /** Re-inspects a preview and returns the exact CAS facts for a later command transaction. */
  prepareConfirmation(principal: TrustedPrincipal, input: unknown): Promise<RepositoryMoveConfirmationPlan>;
  /** Re-inspects the preview target and commits the F-003 binding CAS only if unchanged. */
  confirm(principal: TrustedPrincipal, input: unknown): Promise<RepositoryRebindResult>;
}

export interface RepositoryMoveServiceDeps {
  readonly stateStore: StateStore;
  readonly repositoryInspector: RepositoryInspector;
}

function parsePreviewRequest(input: unknown): RepositoryMovePreviewRequest {
  const context: ValidationContext = { operation: PREVIEW_OPERATION, entity: { type: 'project' } };
  const object = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(object, ['projectId', 'repositoryPath'], context, 'input');
  const projectId = validateStableId(object.projectId, context, 'input.projectId');
  if (object.repositoryPath === undefined) throw validationError(context, 'input.repositoryPath', '必须提供目标仓库路径');
  const repositoryPath = validateRepositoryInspectionPath(object.repositoryPath, PREVIEW_OPERATION);
  return { projectId, repositoryPath };
}

function parseConfirmationRequest(input: unknown): RepositoryMoveConfirmationRequest {
  const context: ValidationContext = { operation: CONFIRM_OPERATION, entity: { type: 'repository_binding' } };
  const object = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(object, ['preview', 'decision'], context, 'input');
  const preview = validateBrownfieldMovePreview(object.preview);
  if (object.decision === undefined) throw validationError(context, 'input.decision', '必须明确提供确认决定');
  return { preview, decision: object.decision };
}

function workingTreeDigest(inspection: RepositoryInspection): string {
  if (inspection.workingTreeDigest !== undefined) return inspection.workingTreeDigest;
  return createHash('sha256').update(stableCanonicalJson({
    canonicalPath: inspection.canonicalPath,
    headCommit: inspection.headCommit,
    hasUncommittedChanges: inspection.hasUncommittedChanges,
  }), 'utf8').digest('hex');
}

function repositoryFacts(inspection: RepositoryInspection): BrownfieldRepositoryFacts {
  return {
    canonicalPath: inspection.canonicalPath,
    repoIdentity: inspection.repoIdentity,
    headCommit: inspection.headCommit,
    hasInitialCommit: inspection.hasInitialCommit,
    hasUncommittedChanges: inspection.hasUncommittedChanges,
    workingTreeDigest: workingTreeDigest(inspection),
  };
}

function oldBindingRef(projectId: string, binding: Awaited<ReturnType<StateStore['getRepositoryBinding']>>) {
  return {
    projectId,
    repositoryBindingId: binding.id,
    bindingRevision: binding.bindingRevision,
    canonicalPath: binding.canonicalPath,
    repoIdentity: binding.repoIdentity,
  } as const;
}

function stale(operation: string, reason: string): StorageError {
  return new StorageError('conflict', operation, '仓库移动预览已失效，未更新项目绑定', {
    details: { reason },
  });
}

export function createRepositoryMoveService(deps: RepositoryMoveServiceDeps): RepositoryMoveService {
  if (deps === null || typeof deps !== 'object' || deps.stateStore === null || deps.repositoryInspector === null) {
    throw new TypeError('RepositoryMoveService 需要 stateStore 和 repositoryInspector');
  }
  const { stateStore, repositoryInspector } = deps;

  return {
    async preview(principal, input) {
      assertTrustedPrincipal(principal);
      const request = parsePreviewRequest(input);
      authorizeProjectRead(principal, request.projectId, PREVIEW_OPERATION);
      const project = await stateStore.getProject(request.projectId);
      requireProjectVisible(principal, project.id, PREVIEW_OPERATION);
      const binding = await stateStore.getRepositoryBinding(request.projectId);
      const inspection = await repositoryInspector.inspect(request.repositoryPath);
      return createBrownfieldMovePreview({
        schemaVersion: 1,
        projectId: project.id,
        projectRevision: project.revision,
        oldBinding: oldBindingRef(project.id, binding),
        newRepository: repositoryFacts(inspection),
      });
    },

    async prepareConfirmation(principal, input) {
      assertTrustedPrincipal(principal);
      const request = parseConfirmationRequest(input);
      requireCapability(principal, 'project.metadata.write', CONFIRM_OPERATION);
      requireProjectVisible(principal, request.preview.projectId, CONFIRM_OPERATION);
      const confirmation = validateBrownfieldMoveConfirmation(request.decision, request.preview);
      const project = await stateStore.getProject(confirmation.projectId);
      const binding = await stateStore.getRepositoryBinding(confirmation.projectId);
      if (project.status !== 'active') throw stale(CONFIRM_OPERATION, 'project_not_active');
      if (project.revision !== request.preview.projectRevision) throw stale(CONFIRM_OPERATION, 'project_changed_after_preview');
      const currentBinding = oldBindingRef(project.id, binding);
      if (stableCanonicalJson(currentBinding) !== stableCanonicalJson(request.preview.oldBinding)) {
        throw stale(CONFIRM_OPERATION, 'binding_changed_after_preview');
      }

      let inspection: RepositoryInspection;
      try {
        inspection = await repositoryInspector.inspect(request.preview.newRepository.canonicalPath);
      } catch (error) {
        if (error instanceof RepositoryInspectionError) throw stale(CONFIRM_OPERATION, 'target_repository_changed');
        throw error;
      }
      const freshPreview = createBrownfieldMovePreview({
        schemaVersion: 1,
        projectId: project.id,
        projectRevision: project.revision,
        oldBinding: currentBinding,
        newRepository: repositoryFacts(inspection),
      });
      if (freshPreview.previewDigest !== request.preview.previewDigest) {
        throw stale(CONFIRM_OPERATION, 'preview_facts_changed');
      }
      return {
        projectId: project.id,
        expectedRevision: project.revision,
        expectedBindingRevision: binding.bindingRevision,
        expectedBindingId: binding.id,
        canonicalPath: inspection.canonicalPath,
        gitCommonDir: inspection.gitCommonDir,
        repoIdentity: inspection.repoIdentity,
      };
    },

    async confirm(principal, input) {
      const plan = await this.prepareConfirmation(principal, input);
      return stateStore.rebindRepository(plan.projectId, {
        expectedRevision: plan.expectedRevision,
        expectedBindingRevision: plan.expectedBindingRevision,
        expectedBindingId: plan.expectedBindingId,
        canonicalPath: plan.canonicalPath,
        gitCommonDir: plan.gitCommonDir,
        repoIdentity: plan.repoIdentity,
      });
    },
  };
}
