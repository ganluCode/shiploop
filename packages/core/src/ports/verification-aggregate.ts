/** P03-7 / F-006: fail-closed machine verification aggregation contract. */
import { createHash } from 'node:crypto';
import type { RuntimeExecutionResult, RuntimeStopEvidence } from './runtime-execution.js';
import type { CheckResultRecord, CheckResultEvidence } from './verification-store.js';
import type { WorkspaceInspection } from './workspace-inspector.js';

export const MACHINE_VERIFICATION_STATUSES = ['passed', 'failed', 'error', 'inconclusive'] as const;
export type MachineVerificationStatus = (typeof MACHINE_VERIFICATION_STATUSES)[number];

export const MACHINE_VERIFICATION_CATEGORIES = [
  'passed', 'runtime_error', 'runtime_not_stopped', 'workspace_not_held', 'source_changed',
  'execution_identity_changed', 'empty_check_set', 'plan_not_ready', 'missing_required_check',
  'missing_check_result', 'check_not_passed', 'zero_tests', 'coverage_incomplete',
  'evidence_incomplete', 'evidence_corrupt', 'baseline_failed', 'diagnostic_only', 'invalid_input',
] as const;
export type MachineVerificationCategory = (typeof MACHINE_VERIFICATION_CATEGORIES)[number];

export interface VerificationCodeIdentity {
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly trackedPathsDigest?: string;
  readonly untrackedPathsDigest?: string;
  readonly ignoredPathsDigest?: string;
  readonly executionDigest?: string;
  readonly environmentDigest?: string;
}

export interface VerificationRuntimeFacts {
  readonly result: RuntimeExecutionResult | null;
  readonly failure?: { readonly kind: string; readonly reason: string } | null;
  readonly stopped: RuntimeStopEvidence | null;
}

export interface VerificationCheckEvidence {
  readonly status: CheckResultEvidence['status'];
  readonly reference?: string | null;
}

export interface MachineVerificationInput {
  readonly runtime: VerificationRuntimeFacts;
  readonly workspaceHeld: boolean;
  readonly beforeIdentity: VerificationCodeIdentity;
  readonly afterIdentity: VerificationCodeIdentity;
  /** Optional immutable identities copied from the persisted verification batch. */
  readonly expectedCodeDigest?: string;
  readonly expectedExecutionDigest?: string;
  readonly plan: {
    readonly status: 'ready' | 'error' | 'inconclusive';
    readonly selectedChecks: readonly { readonly checkKey: string; readonly required: boolean }[];
    readonly requiredCheckKeys?: readonly string[];
    readonly coveredModules?: readonly string[];
    readonly affectedModules?: readonly string[];
  };
  readonly results: readonly CheckResultRecord[];
  readonly evidence?: Readonly<Record<string, VerificationCheckEvidence>>;
  readonly testCounts?: Readonly<Record<string, number>>;
  readonly baseline?: { readonly status: 'passed' | 'failed' | 'error' | 'inconclusive' } | null;
  /** Human review is deliberately opaque to machine aggregation and returned unchanged. */
  readonly humanReview?: unknown;
  /** Diagnostic checks can be run after a safely stopped Runtime, but never pass the Task. */
  readonly diagnostic?: boolean;
}

export interface MachineVerificationResult {
  readonly schemaVersion: 1;
  readonly status: MachineVerificationStatus;
  readonly machinePassed: boolean;
  readonly category: MachineVerificationCategory;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly checkedCodeIdentity: VerificationCodeIdentity;
  readonly runtime: VerificationRuntimeFacts;
  readonly diagnostic: boolean;
  readonly humanReview?: unknown;
  readonly checkStatuses: Readonly<Record<string, CheckResultRecord['status']>>;
}

export interface VerificationIdentityCapture {
  readonly identity: VerificationCodeIdentity;
  readonly inspection: WorkspaceInspection;
}

export function verificationCodeIdentity(
  inspection: WorkspaceInspection,
  execution?: { readonly executionDigest?: string; readonly environmentDigest?: string },
  options: { readonly reproducibleOutputPaths?: readonly string[] } = {},
): VerificationCodeIdentity {
  const excluded = options.reproducibleOutputPaths ?? [];
  const isExcluded = (path: string) => excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const digest = (
    entries: readonly { readonly path: string; readonly digest: string | null; readonly state: string; readonly mode?: number | null }[],
    allowOutputExclusion = true,
  ) => createHash('sha256').update(entries
    .filter((entry) => !allowOutputExclusion || !isExcluded(entry.path))
    .map((entry) => `${entry.state}\0${entry.path}\0${entry.digest ?? ''}\0${entry.mode ?? ''}`)
    .join('\n')).digest('hex');
  // Tracked paths are always part of the source identity. An output rule can
  // cover only untracked/ignored generated files; it cannot hide a tracked edit.
  const tracked = inspection.contents.tracked;
  const untracked = inspection.contents.untracked;
  const ignored = inspection.contents.ignored;
  const trackedDigest = digest(tracked, false);
  const untrackedDigest = digest(untracked);
  const ignoredDigest = digest(ignored);
  return {
    headCommit: inspection.repository.headCommit,
    codeDigest: createHash('sha256').update(`${trackedDigest}\0${untrackedDigest}\0${ignoredDigest}`).digest('hex'),
    trackedPathsDigest: trackedDigest,
    untrackedPathsDigest: untrackedDigest,
    ignoredPathsDigest: ignoredDigest,
    ...execution,
  };
}
