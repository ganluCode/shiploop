import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { stableStringify } from '../ports/feature-plan.js';
import { buildWorkAccessManifest } from '../ports/work-access.js';
import type { WorkAccessManifest } from '../ports/work-access.js';
import {
  WORK_AUTHENTICATION_MAX_INPUT_BYTES, WORK_AUTHENTICATION_MAX_TIMEOUT_MS, WorkAuthenticationSourceError,
} from '../ports/work-authentication.js';
import type {
  WorkAuthenticationAuthorization, WorkAuthenticationCatalog, WorkAuthenticationPreflight,
  WorkAuthenticationPreflightDependencies, WorkAuthenticationPreflightResult, WorkAuthenticationReason,
  WorkAuthenticationState,
} from '../ports/work-authentication.js';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function authorizationReason(value: WorkAuthenticationAuthorization, digest: string): WorkAuthenticationReason | null {
  if (value.state === 'revoked') return 'grant_revoked';
  if (value.state !== 'active' || value.policyDigest !== digest) return 'policy_drift';
  if (value.sourceRead !== true) return 'source_access_denied';
  if (value.modelRequest !== true) return 'model_request_denied';
  return null;
}
function catalogReason(value: WorkAuthenticationCatalog, manifest: WorkAccessManifest): WorkAuthenticationReason | null {
  if (value.sdkVersion !== '1.0.4') return 'sdk_version_incompatible';
  const expected = manifest.access.resources.filter(r => r.kind === 'auth_plugin');
  if (!Array.isArray(value.plugins) || value.plugins.length > 1) return 'policy_drift';
  for (const plugin of expected) {
    const actual = value.plugins.find(p => p.id === plugin.id);
    if (!actual) return 'plugin_missing';
    if (actual.version !== plugin.version) return 'plugin_version_incompatible';
    if (actual.sourceRef !== plugin.sourceRef || actual.contentDigest !== plugin.contentDigest) return 'policy_drift';
  }
  if (value.plugins.length !== expected.length) return 'policy_drift';
  if (value.providerExists !== true) return 'provider_missing';
  if (value.modelExists !== true) return 'model_missing';
  return null;
}

/** Read-only admission evidence. The caller must recheck current authorization at execution time. */
export function createWorkAuthenticationPreflight(deps: WorkAuthenticationPreflightDependencies): WorkAuthenticationPreflight {
  const timeoutMs = deps.timeoutMs ?? WORK_AUTHENTICATION_MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORK_AUTHENTICATION_MAX_TIMEOUT_MS) {
    throw new RangeError('Invalid Work authentication timeout');
  }
  const now = deps.monotonicNow ?? (() => performance.now());
  // Snapshot registrations, not credentials or their state. Revocation is checked on every invocation.
  const sources = new Map(deps.sources);
  return {
    async check(value, binding, approvedPolicyDigest) {
      const started = now();
      const manifest = freeze(buildWorkAccessManifest(value, binding));
      const { access, digest: policyDigest } = manifest;
      let authentication: WorkAuthenticationState | 'unknown' = 'unknown';
      let sdkVersion: string | null = null;
      const finish = (reason: WorkAuthenticationReason | null): WorkAuthenticationPreflightResult => {
        const body = {
          status: reason === null ? 'ready' as const : 'rejected' as const, reason, authentication, inference: 'unknown' as const,
          projectId: access.context.projectId, identity: access.context.identity, hostInstanceId: access.context.hostInstanceId,
          invocationId: access.context.invocationId, executionVersion: access.context.executionVersion,
          grantId: access.context.grantId, policyDigest, provider: access.provider, model: access.model,
          source: access.authentication, sdkVersion, diagnostics: reason === null ? [] : [{ reason }],
        };
        return freeze({ ...body, digest: createHash('sha256')
          .update(`shiploop:work-authentication:v1\n${stableStringify(body)}`).digest('hex') });
      };
      if (Buffer.byteLength(stableStringify(access), 'utf8') > WORK_AUTHENTICATION_MAX_INPUT_BYTES) return finish('input_limit');
      if (policyDigest !== approvedPolicyDigest) return finish('policy_drift');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
      });
      let failure: WorkAuthenticationReason = 'authorization_error';
      const step = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (controller.signal.aborted || now() - started >= timeoutMs) throw new Error('timeout');
        const result = await Promise.race([Promise.resolve().then(operation), timedOut]);
        if (controller.signal.aborted || now() - started >= timeoutMs) throw new Error('timeout');
        return result;
      };
      try {
        let denied = authorizationReason(await step(() => deps.authorize(manifest, controller.signal)), policyDigest);
        if (denied) return finish(denied);
        const source = sources.get(access.authentication.sourceRef);
        if (!source) return finish('source_missing');
        if (source.kind !== access.authentication.kind || source.provider !== access.provider
          || stableStringify([...source.environmentRefs].sort()) !== stableStringify(access.authentication.environmentRefs)) {
          return finish('source_mismatch');
        }
        failure = access.authentication.kind === 'plugin' ? 'plugin_error' : 'catalog_error';
        const catalog = await step(() => deps.catalog(manifest, controller.signal));
        denied = catalogReason(catalog, manifest);
        // Only publish the pinned version; arbitrary adapter strings may contain secrets.
        sdkVersion = catalog.sdkVersion === '1.0.4' ? '1.0.4' : null;
        if (denied) return finish(denied);
        failure = 'source_error';
        const state = await step(() => source.inspect({ nowUtcMs: binding.nowUtcMs + Math.max(0, now() - started), signal: controller.signal }));
        if (!['ready', 'missing', 'expired', 'revoked', 'invalid'].includes(state)) return finish('source_error');
        authentication = state;
        if (state !== 'ready') return finish(`authentication_${state}`);
        failure = 'authorization_error';
        denied = authorizationReason(await step(() => deps.authorize(manifest, controller.signal)), policyDigest);
        if (denied) return finish(denied);
        if (binding.nowUtcMs + Math.max(0, now() - started) >= access.context.expiresAtUtcMs) return finish('grant_expired');
        return finish(null);
      } catch (error) {
        if (controller.signal.aborted || now() - started >= timeoutMs) return finish('timeout');
        if (error instanceof WorkAuthenticationSourceError && failure === 'source_error') return finish(error.reason);
        return finish(failure);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
