/** Core-owned profile decisions. No module body is executed or interpreted as authority.
 * expectedRevision is the latest immutable profile version (not its insert-only row revision).
 * Rejection retains the last confirmed default; it only rejects the proposed replacement.
 */
import { mapToPublicError } from '../ports/commands.js';
import {
  assertTrustedPrincipal,
  requireCapability,
  requireProjectVisible,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import { StorageError } from '../ports/errors.js';
import {
  validateProjectProfile,
  validateProfileModuleSelection,
  type ProjectProfile,
} from '../ports/project-profile.js';
import {
  createProjectProfileQueryResult,
  type ProfileModuleMatchResult,
  type ProjectProfileQueryResult,
} from '../ports/project-profile-query.js';
export type { ProfileModuleMatchResult, ProfileModuleSelection } from '../ports/project-profile-query.js';
import type {
  PersistedProjectProfile,
  ProjectProfileStore,
  ProjectProfileUpdateInput,
} from '../ports/project-profile-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

const OPERATION = 'project.profile';
const MUTATION_KEYS = ['projectId', 'expectedRevision', 'profile'] as const;
const MATCH_KEYS = ['projectId', 'directory', 'requiredModuleIds', 'languages', 'frameworks', 'scope'] as const;

export interface ProjectProfileService {
  readonly confirm: (principal: unknown, input: unknown) => PersistedProjectProfile;
  readonly modify: (principal: unknown, input: unknown) => PersistedProjectProfile;
  readonly reject: (principal: unknown, input: unknown) => PersistedProjectProfile;
  readonly getCurrent: (principal: unknown, projectId: unknown) => PersistedProjectProfile | null;
  readonly matchTaskModules: (principal: unknown, input: unknown) => ProfileModuleMatchResult;
  readonly getQuery: (principal: unknown, projectId: unknown) => ProjectProfileQueryResult;
}

export interface ProjectProfileServiceOptions {
  readonly store: ProjectProfileStore;
}

function validationContext(operation: string): ValidationContext {
  return { operation, entity: { type: 'project_profile' } };
}

function failValidation(operation: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new StorageError('validation', operation, message, {
    entity: { type: 'project_profile' },
    ...(details === undefined ? {} : { details }),
  });
}

function parseMutation(input: unknown, operation: string): { projectId: string; expectedRevision: number; profile?: ProjectProfile } {
  const object = requirePlainObject(input, validationContext(operation), 'input');
  rejectUnknownKeys(object, MUTATION_KEYS, validationContext(operation), 'input');
  const projectId = validateStableId(object.projectId, validationContext(operation), 'projectId');
  const expectedRevision = validatePositiveInteger(object.expectedRevision, validationContext(operation), 'expectedRevision');
  if (object.profile === undefined) return { projectId, expectedRevision };
  const profile = validateProjectProfile(object.profile);
  if (profile.projectId !== projectId) {
    throw new StorageError('ownership', operation, '画像项目归属与请求项目不一致', {
      entity: { type: 'project_profile', projectId },
    });
  }
  return { projectId, expectedRevision, profile };
}

function currentConfirmed(store: ProjectProfileStore, projectId: string): PersistedProjectProfile | null {
  const profiles = store.listProjectProfiles(projectId);
  for (let index = profiles.length - 1; index >= 0; index -= 1) {
    if (profiles[index]!.profile.status === 'confirmed') return profiles[index]!;
  }
  return null;
}

function latest(store: ProjectProfileStore, projectId: string): PersistedProjectProfile {
  const profiles = store.listProjectProfiles(projectId);
  const result = profiles[profiles.length - 1];
  if (result === undefined) {
    throw new StorageError('not_found', `${OPERATION}.read`, '项目画像不存在', {
      entity: { type: 'project_profile', projectId },
    });
  }
  return result;
}

function moduleRef(id: string, version: string): string {
  return `${id}@${version}`;
}

function pathApplies(directory: string, roots: readonly string[]): boolean {
  return roots.some((raw) => {
    const root = raw.split('/').filter(part => part !== '' && part !== '.').join('/') || '.';
    return root === '.' || directory === root || directory.startsWith(`${root}/`);
  });
}

function stringList(value: unknown, operation: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 512 || /[\u0000-\u001f\u007f]/u.test(item))) {
    failValidation(operation, `${field} 必须是非空字符串数组`);
  }
  return [...new Set(value as string[])].sort();
}

function parseMatch(input: unknown): { projectId: string; directory: string; requiredModuleIds: string[]; languages: string[]; frameworks: string[]; scope: string[] } {
  const operation = `${OPERATION}.match`;
  const object = requirePlainObject(input, validationContext(operation), 'input');
  rejectUnknownKeys(object, MATCH_KEYS, validationContext(operation), 'input');
  const projectId = validateStableId(object.projectId, validationContext(operation), 'projectId');
  const normalize = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)
      || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.includes('\\') || value.split('/').includes('..')
      || /[*?\[\]{}]/u.test(value)) failValidation(operation, '目录或范围必须是明确的相对路径');
    return value.split('/').filter(part => part !== '' && part !== '.').join('/') || '.';
  };
  const directory = object.directory === undefined ? '' : normalize(object.directory);
  const scope = stringList(object.scope, operation, 'scope').map(normalize);
  return {
    projectId,
    directory,
    requiredModuleIds: stringList(object.requiredModuleIds, operation, 'requiredModuleIds'),
    languages: stringList(object.languages, operation, 'languages'),
    frameworks: stringList(object.frameworks, operation, 'frameworks'),
    scope: [...new Set(scope)].sort(),
  };
}

function selectedModuleRows(store: ProjectProfileStore, profile: ProjectProfile) {
  const catalog = store.listCapabilityModules(profile.projectId).map(row => row.module);
  validateProfileModuleSelection(profile, catalog);
  const moduleRows = new Map(catalog.map(module => [moduleRef(module.id, module.version), module]));
  // Keep every root binding, even when the same capability is referenced by two modules.
  return profile.modules.flatMap(binding => [...new Set([moduleRef(binding.id, binding.version), ...binding.capabilityRefs])]
    .map(key => ({ binding, module: moduleRows.get(key)! })));
}

export function createProjectProfileService(options: ProjectProfileServiceOptions): ProjectProfileService {
  if (options === null || typeof options !== 'object' || options.store === null || typeof options.store !== 'object') {
    throw new TypeError('createProjectProfileService: store 必须是可信 ProjectProfileStore');
  }
  const store = options.store;

  function authorize(principal: unknown, projectId: string, operation: string, write: boolean): asserts principal is TrustedPrincipal {
    assertTrustedPrincipal(principal);
    requireCapability(principal, write ? 'project.metadata.write' : 'project.read', operation);
    requireProjectVisible(principal, projectId, operation);
  }

  function mutate(principal: unknown, raw: unknown, action: ProjectProfileUpdateInput['action']): PersistedProjectProfile {
    const operation = `${OPERATION}.${action}`;
    const preliminary = parseMutation(raw, operation);
    authorize(principal, preliminary.projectId, operation, true);
    const current = latest(store, preliminary.projectId);
    if (current.profile.version !== preliminary.expectedRevision) {
      throw new StorageError('conflict', operation, '项目画像 revision 已过期', {
        entity: { type: 'project_profile', projectId: preliminary.projectId },
        details: { reason: 'stale_revision', expectedRevision: preliminary.expectedRevision, actualRevision: current.profile.version },
      });
    }
    const source = action === 'rejected' ? current.profile : preliminary.profile;
    if (source === undefined) failValidation(operation, '确认或修改必须提供 profile');
    if (source.confirmedBy !== current.profile.confirmedBy || source.version !== current.profile.version) {
      failValidation(operation, '画像的版本和确认身份必须来自当前保存版本', { reason: 'profile_identity_mismatch' });
    }
    if (action !== 'rejected' && source.modules.length === 0) {
      failValidation(operation, '未知语言请显式手动配置至少一个能力模块', { reason: 'manual_configuration_required' });
    }
    const profile = validateProjectProfile({
      ...source,
      projectId: preliminary.projectId,
      version: preliminary.expectedRevision + 1,
      revision: `v${preliminary.expectedRevision + 1}`,
      status: action === 'rejected' ? 'rejected' : 'confirmed',
      confirmedBy: action === 'rejected' ? null : principal.principalId,
    });
    validateProfileModuleSelection(profile, store.listCapabilityModules(profile.projectId).map(row => row.module));
    return store.updateProjectProfile(preliminary.projectId, {
      expectedRevision: preliminary.expectedRevision,
      profile,
      evidence: current.detectionEvidence,
      action,
      actorId: principal.principalId,
    });
  }

  function boundary<T>(principal: unknown, operation: string, write: boolean, call: () => T): T {
    assertTrustedPrincipal(principal); // Invalid trusted assembly is a programming error, never client data.
    try {
      requireCapability(principal, write ? 'project.metadata.write' : 'project.read', operation);
      return call();
    } catch (error) { throw mapToPublicError(error, { operation }); }
  }

  return {
    confirm: (principal, input) => boundary(principal, `${OPERATION}.confirmed`, true, () => mutate(principal, input, 'confirmed')),
    modify: (principal, input) => boundary(principal, `${OPERATION}.modified`, true, () => mutate(principal, input, 'modified')),
    reject: (principal, input) => boundary(principal, `${OPERATION}.rejected`, true, () => mutate(principal, input, 'rejected')),
    getCurrent(principal, projectIdInput) {
      const operation = `${OPERATION}.read`;
      return boundary(principal, operation, false, () => {
        const projectId = validateStableId(projectIdInput, validationContext(operation), 'projectId');
        authorize(principal, projectId, operation, false);
        return currentConfirmed(store, projectId);
      });
    },
    matchTaskModules(principal, input) {
      const operation = `${OPERATION}.match`;
      return boundary(principal, operation, false, (): ProfileModuleMatchResult => {
        const parsed = parseMatch(input);
        authorize(principal, parsed.projectId, operation, false);
        const profile = currentConfirmed(store, parsed.projectId);
        const notReady = (reason: ProfileModuleMatchResult['reason'], missing: readonly string[] = []): ProfileModuleMatchResult => ({
          status: 'not_ready', profileVersion: profile?.profile.version ?? null, modules: [], missing: [...missing].sort(), reason,
        });
        if (profile === null) return notReady('profile_not_confirmed');
        const paths = [...new Set([...(parsed.directory ? [parsed.directory] : []), ...parsed.scope])].sort();
        if (paths.length === 0) return notReady('task_scope_required');
        const candidates = selectedModuleRows(store, profile.profile);
        const selected = new Map<string, typeof candidates[number]['module']>();
        for (const { binding, module } of candidates) {
          if (paths.some(path => pathApplies(path, binding.roots)
            && (module.appliesTo.length === 0 || pathApplies(path, module.appliesTo)))
            && (parsed.languages.length === 0 || binding.languages.some(language => parsed.languages.includes(language)))
            && (parsed.frameworks.length === 0 || binding.frameworks.length === 0 || binding.frameworks.some(framework => parsed.frameworks.includes(framework)))) {
            selected.set(moduleRef(module.id, module.version), module);
          }
        }
        const unknown = parsed.requiredModuleIds.filter(id => !candidates.some(item => item.module.id === id));
        if (unknown.length > 0) return notReady('required_module_missing', unknown);
        const missing = parsed.requiredModuleIds.filter(id => ![...selected.values()].some(module => module.id === id));
        if (missing.length > 0) return notReady('required_module_not_applicable', missing);
        const dependencies = [...new Set([...selected.values()].flatMap(module => module.dependencies).filter(ref => !selected.has(ref)))];
        if (dependencies.length > 0) return notReady('module_dependency_missing', dependencies);
        if (selected.size === 0) return notReady('module_scope_unmatched');
        return {
          status: 'ready', profileVersion: profile.profile.version, missing: [],
          modules: [...selected.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, module]) => ({
            id: module.id, version: module.version, reason: 'confirmed_profile_scope_match',
          })),
        };
      });
    },
    getQuery(principal, projectIdInput) {
      const operation = `${OPERATION}.query`;
      return boundary(principal, operation, false, () => {
        const projectId = validateStableId(projectIdInput, validationContext(operation), 'projectId');
        authorize(principal, projectId, operation, false);
        const rows = store.listProjectProfiles(projectId);
        const latestRow = rows[rows.length - 1] ?? null;
        const confirmed = currentConfirmed(store, projectId);
        return createProjectProfileQueryResult({
          projectId,
          candidate: latestRow !== null && latestRow.profile.status !== 'confirmed' ? latestRow : null,
          confirmed,
          modules: store.listCapabilityModules(projectId).map(row => ({ module: row.module, digest: row.digest })),
        });
      });
    },
  };
}
