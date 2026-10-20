/** Work 认证预检端口。来源只返回状态；秘密留在可信适配器内部。 */
import type { WorkAccessAuthentication, WorkAccessBinding, WorkAccessIdentity, WorkAccessManifest } from './work-access.js';

export const WORK_AUTHENTICATION_MAX_INPUT_BYTES = 65_536;
export const WORK_AUTHENTICATION_MAX_TIMEOUT_MS = 5_000;
export const WORK_AUTHENTICATION_REASONS = [
  'policy_drift', 'grant_revoked', 'source_access_denied', 'model_request_denied',
  'source_missing', 'source_mismatch', 'authentication_missing', 'authentication_expired',
  'authentication_revoked', 'authentication_invalid', 'authentication_directory_denied',
  'credential_reference_unsupported', 'source_error', 'plugin_missing', 'plugin_version_incompatible',
  'plugin_error', 'sdk_version_incompatible', 'provider_missing', 'model_missing',
  'catalog_error', 'authorization_error', 'timeout', 'input_limit', 'grant_expired',
] as const;
export type WorkAuthenticationReason = (typeof WORK_AUTHENTICATION_REASONS)[number];
export type WorkAuthenticationState = 'ready' | 'missing' | 'expired' | 'revoked' | 'invalid';
export class WorkAuthenticationSourceError extends Error {
  readonly reason: 'authentication_directory_denied' | 'credential_reference_unsupported' | 'input_limit';
  constructor(reason: WorkAuthenticationSourceError['reason']) {
    super(`Work authentication source rejected: ${reason}`);
    this.name = 'WorkAuthenticationSourceError';
    this.reason = reason;
  }
}
export interface WorkAuthenticationSource {
  readonly kind: WorkAccessAuthentication['kind'];
  readonly provider: string;
  readonly environmentRefs: readonly string[];
  /** No refresh, login, model calls or fallback. Must honor signal and release owned handles. */
  inspect(context: { readonly nowUtcMs: number; readonly signal: AbortSignal }): Promise<WorkAuthenticationState>;
}
export interface WorkAuthenticationAuthorization {
  readonly state: 'active' | 'revoked';
  readonly policyDigest: string;
  readonly sourceRead: boolean;
  /** Permission for subsequent Work model calls, not authorization for a probe. */
  readonly modelRequest: boolean;
}
export interface WorkAuthenticationCatalog {
  readonly sdkVersion: string;
  readonly providerExists: boolean;
  readonly modelExists: boolean;
  /** Actual auth dependencies only; an ordinary extension cannot satisfy this list. */
  readonly plugins: readonly {
    readonly id: string; readonly sourceRef: string; readonly version: string;
    readonly contentDigest: string | null;
  }[];
}
export interface WorkAuthenticationPreflightDependencies {
  readonly sources: ReadonlyMap<string, WorkAuthenticationSource>;
  /** Trusted Core grant/policy reader; called before source access and again before returning ready. */
  authorize(manifest: WorkAccessManifest, signal: AbortSignal): Promise<WorkAuthenticationAuthorization>;
  /** Exact approved provider/model and auth plugins, never default discovery or inference. */
  catalog(manifest: WorkAccessManifest, signal: AbortSignal): Promise<WorkAuthenticationCatalog>;
  readonly monotonicNow?: () => number;
  readonly timeoutMs?: number;
}
export interface WorkAuthenticationPreflightResult {
  readonly status: 'ready' | 'rejected';
  readonly reason: WorkAuthenticationReason | null;
  readonly authentication: WorkAuthenticationState | 'unknown';
  /** This service never performs inference. Remote revocation/availability may remain unknown. */
  readonly inference: 'unknown';
  readonly projectId: string;
  readonly identity: WorkAccessIdentity;
  readonly hostInstanceId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly grantId: string;
  readonly policyDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly source: WorkAccessAuthentication;
  readonly sdkVersion: string | null;
  readonly diagnostics: readonly { readonly reason: WorkAuthenticationReason }[];
  /** Stable semantic digest; excludes clock readings and all credential content. Not an authorization token. */
  readonly digest: string;
}
export interface WorkAuthenticationPreflight {
  check(value: unknown, binding: WorkAccessBinding, approvedPolicyDigest: string): Promise<WorkAuthenticationPreflightResult>;
}
