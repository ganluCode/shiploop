import { assertTrustedPrincipal, requireCapability, requireProjectVisible, type TrustedPrincipal } from '../ports/authorization.js';
import { StorageError } from '../ports/errors.js';
import { createCapabilityModule, validateProjectProfile, type ProjectProfileInspectionResult, type ProjectProfileInspector } from '../ports/project-profile.js';
import type { PersistedProjectProfile, ProjectProfileStore } from '../ports/project-profile-store.js';
import type { RepositoryBindingRecord } from '../ports/state-store.js';

export interface PreparedProfileDetection {
  readonly projectId: string;
  readonly binding: RepositoryBindingRecord;
  readonly inspection: ProjectProfileInspectionResult;
}
export interface ProjectProfileDetectionService {
  prepare(principal: TrustedPrincipal, projectId: string): Promise<PreparedProfileDetection>;
  /** Only called within the command receipt transaction. No I/O or await here. */
  commit(principal: TrustedPrincipal, prepared: PreparedProfileDetection): PersistedProjectProfile;
}

export function createProjectProfileDetectionService(options: {
  readonly store: ProjectProfileStore;
  readonly inspector: ProjectProfileInspector;
  readonly getBinding: (projectId: string) => Promise<RepositoryBindingRecord>;
  readonly bindingIsCurrent: (binding: RepositoryBindingRecord) => boolean;
}): ProjectProfileDetectionService {
  const operation = 'project.profile.detect';
  function authorize(principal: TrustedPrincipal, projectId: string) {
    assertTrustedPrincipal(principal);
    requireCapability(principal, 'project.metadata.write', operation);
    requireProjectVisible(principal, projectId, operation);
    if (options.store.listProjectProfiles(projectId).length !== 0) {
      throw new StorageError('conflict', operation, '首次检测不能覆盖已有画像', { details: { reason: 'profile_already_initialized' } });
    }
  }
  const preparations = new WeakSet<PreparedProfileDetection>();
  return {
    async prepare(principal, projectId) {
      authorize(principal, projectId);
      const binding = await options.getBinding(projectId);
      if (binding.projectId !== projectId) throw new StorageError('ownership', operation, '仓库绑定归属不匹配');
      const inspection = await options.inspector.inspect(binding.canonicalPath);
      const prepared = { projectId, binding, inspection };
      preparations.add(prepared);
      return prepared;
    },
    commit(principal, prepared) {
      if (!preparations.has(prepared)) throw new StorageError('validation', operation, '缺少可信检测准备');
      authorize(principal, prepared.projectId);
      if (!options.bindingIsCurrent(prepared.binding)) throw new StorageError('conflict', operation, '仓库绑定已变更', { details: { reason: 'binding_changed' } });
      const profile = validateProjectProfile({ ...prepared.inspection.candidateProfile, projectId: prepared.projectId });
      const modules = profile.modules.map(ref => createCapabilityModule({ id: ref.id, version: ref.version,
        scope: ref.languages.map(language => `language:${language}`), appliesTo: ref.roots, dependencies: [],
        contentRef: `builtin:static-profile/${ref.id}@${ref.version}`, status: 'candidate' }));
      return options.store.createDetectedProjectProfile({ profile, evidence: prepared.inspection.evidence,
        modules, actorId: principal.principalId });
    },
  };
}
