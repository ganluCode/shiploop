import type {
  BaselineAuthorizationSummary,
  BaselineCheckResult,
  BaselineCodeIdentity,
  BaselineEnvironmentIdentity,
  BaselineOperationStatus,
} from './baseline.js';
import { ONBOARDING_QUERY_SCHEMA_VERSION } from './baseline.js';
import type { BaselineDetailResult } from './baseline.js';
import { stableCanonicalJson } from './command-receipts.js';

/** 诊断比较响应的独立版本；不与线消息或 SQLite 迁移版本混用。 */
export const BASELINE_COMPARISON_SCHEMA_VERSION = 1 as const;

export type BaselineComparisonClassification =
  | 'unchanged_passed'
  | 'existing_failure'
  | 'regressed'
  | 'new_failure'
  | 'fixed'
  | 'not_run'
  | 'incomparable'
  | 'removed'
  | 'added';

export type BaselineComparisonGap =
  | 'baseline_not_completed'
  | 'authorization_missing'
  | 'code_identity_missing'
  | 'binding_identity_missing'
  | 'binding_identity_changed'
  | 'dirty_scope_missing'
  | 'dirty_scope_changed'
  | 'environment_identity_missing'
  | 'environment_identity_changed'
  | 'check_not_run'
  | 'evidence_missing'
  | 'evidence_incomplete'
  | 'stop_unconfirmed'
  | 'failure_identity_missing'
  | 'check_removed'
  | 'check_added'
  | 'check_definition_changed';

export interface BaselineComparisonEvidenceRef {
  readonly operationId: string;
  readonly checkKey: string;
  readonly artifactId: string | null;
}

export interface BaselineComparisonSource {
  readonly operationId: string;
  readonly projectId: string;
  readonly operationStatus: BaselineOperationStatus;
  readonly codeIdentity: BaselineCodeIdentity | null;
  readonly repositoryBindingId: string | null;
  readonly repositoryBindingRevision: number | null;
  readonly dirtyScope: BaselineAuthorizationSummary['dirtyScope'] | null;
  readonly environmentIdentity: BaselineEnvironmentIdentity | null;
  readonly evidence: readonly BaselineComparisonEvidenceRef[];
  readonly gaps: readonly BaselineComparisonGap[];
}

export interface BaselineComparisonCodeDiff {
  readonly headCommitChanged: boolean;
  readonly workingTreeDigestChanged: boolean;
  readonly uncommittedChangesChanged: boolean;
  readonly anyChanged: boolean;
}

export interface BaselineComparisonCheck {
  readonly checkKey: string;
  readonly classification: BaselineComparisonClassification;
  readonly reason?: BaselineComparisonGap;
  readonly definitionChanged: boolean;
  readonly previous: BaselineCheckResult | null;
  readonly current: BaselineCheckResult | null;
  readonly evidence: {
    readonly previous: BaselineComparisonEvidenceRef | null;
    readonly current: BaselineComparisonEvidenceRef | null;
  };
}

/**
 * 诊断结果故意没有 `passed`、`approved` 或状态写入口。
 * comparable 只描述这次比较是否有足够身份/证据进行诊断，不改变原基线政策。
 */
export interface BaselineComparisonResult {
  readonly schemaVersion: typeof BASELINE_COMPARISON_SCHEMA_VERSION;
  readonly projectId: string;
  readonly previous: BaselineComparisonSource;
  readonly current: BaselineComparisonSource;
  readonly codeDiff: BaselineComparisonCodeDiff;
  readonly identityDiff: {
    readonly repositoryBindingChanged: boolean;
    readonly dirtyScopeChanged: boolean;
    readonly environmentChanged: boolean;
  };
  readonly checks: readonly BaselineComparisonCheck[];
  readonly comparable: boolean;
  readonly gaps: readonly BaselineComparisonGap[];
}

function checkDefinition(check: BaselineCheckResult): Record<string, unknown> {
  return {
    argv: [...check.argv],
    cwdRef: check.cwdRef,
    environmentRef: check.environmentRef,
    timeoutMs: check.timeoutMs,
    required: check.required,
  };
}

function sameDefinition(left: BaselineCheckResult, right: BaselineCheckResult): boolean {
  return stableCanonicalJson(checkDefinition(left)) === stableCanonicalJson(checkDefinition(right));
}

function isFailure(status: BaselineCheckResult['status']): boolean {
  return status === 'failed' || status === 'error' || status === 'inconclusive';
}

function hasEvidenceGap(check: BaselineCheckResult): BaselineComparisonGap | null {
  if (check.status === 'not_run') return 'check_not_run';
  if (check.output === null) return 'evidence_missing';
  if (check.reasonCode === 'evidence_incomplete' || check.reasonCode === 'output_overflow') {
    return 'evidence_incomplete';
  }
  if (check.reasonCode === 'stop_unconfirmed') return 'stop_unconfirmed';
  return null;
}

function sourceGaps(detail: BaselineDetailResult): BaselineComparisonGap[] {
  const gaps: BaselineComparisonGap[] = [];
  if (detail.operation.status !== 'completed') gaps.push('baseline_not_completed');
  const auth = detail.authorization;
  if (auth === null) {
    gaps.push('authorization_missing');
    return gaps;
  }
  if (auth.codeIdentity === null || auth.codeIdentity === undefined) gaps.push('code_identity_missing');
  if (auth.repositoryBindingRevision === undefined) gaps.push('binding_identity_missing');
  if (auth.dirtyScope === undefined) gaps.push('dirty_scope_missing');
  if (auth.environmentIdentity === undefined) gaps.push('environment_identity_missing');
  for (const check of detail.checks) {
    const gap = hasEvidenceGap(check);
    if (gap !== null && gap !== 'check_not_run' && !gaps.includes(gap)) gaps.push(gap);
  }
  return gaps;
}

function source(detail: BaselineDetailResult, projectId: string): BaselineComparisonSource {
  const auth = detail.authorization;
  return {
    operationId: detail.operation.operationId,
    projectId,
    operationStatus: detail.operation.status,
    codeIdentity: auth?.codeIdentity ?? null,
    repositoryBindingId: auth?.repositoryBindingId ?? null,
    repositoryBindingRevision: auth?.repositoryBindingRevision ?? null,
    dirtyScope: auth?.dirtyScope ?? null,
    environmentIdentity: auth?.environmentIdentity ?? null,
    evidence: detail.checks.map(check => ({
      operationId: detail.operation.operationId,
      checkKey: check.checkKey,
      artifactId: check.output?.artifactId ?? null,
    })),
    gaps: sourceGaps(detail),
  };
}

function comparisonEvidence(
  operationId: string,
  check: BaselineCheckResult | null,
): BaselineComparisonEvidenceRef | null {
  return check === null ? null : { operationId, checkKey: check.checkKey, artifactId: check.output?.artifactId ?? null };
}

function identityComparable(previous: BaselineComparisonSource, current: BaselineComparisonSource): boolean {
  const evidenceGaps = new Set<BaselineComparisonGap>(['evidence_missing', 'evidence_incomplete', 'stop_unconfirmed']);
  return [...previous.gaps, ...current.gaps].every(gap => !evidenceGaps.has(gap));
}

function firstIdentityGap(sourceValue: BaselineComparisonSource): BaselineComparisonGap | null {
  return sourceValue.gaps.find(gap => gap !== 'evidence_missing' && gap !== 'evidence_incomplete' && gap !== 'stop_unconfirmed') ?? null;
}

function validateComparisonDetail(detail: BaselineDetailResult, projectId: string): void {
  if (detail.schemaVersion !== ONBOARDING_QUERY_SCHEMA_VERSION) throw new TypeError('Baseline comparison: unsupported detail schema version');
  if (detail.authorization !== null && detail.authorization.projectId !== projectId) {
    throw new TypeError('Baseline comparison: detail project identity mismatch');
  }
}

function sameOptionalIdentity(left: unknown, right: unknown): boolean {
  return stableCanonicalJson(left) === stableCanonicalJson(right);
}

/**
 * 纯逐项比较。输入必须来自已授权、已做制品完整性核验的两个详情读取。
 * 该函数永远只返回诊断数据，不提供任何状态变更或自动豁免语义。
 */
export function compareBaselineDetails(
  previousDetail: BaselineDetailResult,
  currentDetail: BaselineDetailResult,
  projectId: string,
): BaselineComparisonResult {
  validateComparisonDetail(previousDetail, projectId);
  validateComparisonDetail(currentDetail, projectId);
  const previous = source(previousDetail, projectId);
  const current = source(currentDetail, projectId);
  const codeDiff: BaselineComparisonCodeDiff = {
    headCommitChanged: previous.codeIdentity?.headCommit !== current.codeIdentity?.headCommit,
    workingTreeDigestChanged: previous.codeIdentity?.workingTreeDigest !== current.codeIdentity?.workingTreeDigest,
    uncommittedChangesChanged: previous.codeIdentity?.hasUncommittedChanges !== current.codeIdentity?.hasUncommittedChanges,
    anyChanged: false,
  };
  const codeDiffWithAny: BaselineComparisonCodeDiff = { ...codeDiff, anyChanged: codeDiff.headCommitChanged || codeDiff.workingTreeDigestChanged || codeDiff.uncommittedChangesChanged };
  const identityDiff = {
    repositoryBindingChanged: previous.repositoryBindingId !== current.repositoryBindingId
      || previous.repositoryBindingRevision !== current.repositoryBindingRevision,
    dirtyScopeChanged: !sameOptionalIdentity(previous.dirtyScope, current.dirtyScope),
    environmentChanged: !sameOptionalIdentity(previous.environmentIdentity, current.environmentIdentity),
  };
  const identityIsComparable = identityComparable(previous, current)
    && !identityDiff.repositoryBindingChanged && !identityDiff.dirtyScopeChanged && !identityDiff.environmentChanged;
  const previousByKey = new Map(previousDetail.checks.map(check => [check.checkKey, check]));
  const currentByKey = new Map(currentDetail.checks.map(check => [check.checkKey, check]));
  const keys = [...new Set([...previousByKey.keys(), ...currentByKey.keys()])].sort();
  const checks: BaselineComparisonCheck[] = [];

  for (const checkKey of keys) {
    const oldCheck = previousByKey.get(checkKey) ?? null;
    const newCheck = currentByKey.get(checkKey) ?? null;
    const evidence = {
      previous: comparisonEvidence(previous.operationId, oldCheck),
      current: comparisonEvidence(current.operationId, newCheck),
    };
    if (oldCheck === null) {
      const currentGap = newCheck === null ? null : hasEvidenceGap(newCheck);
      const classification = newCheck !== null && isFailure(newCheck.status) && currentGap === null
        ? 'new_failure' : 'added';
      checks.push({ checkKey, classification, ...(currentGap !== null ? { reason: currentGap } : {}), definitionChanged: false, previous: null, current: newCheck, evidence });
      continue;
    }
    if (newCheck === null) {
      checks.push({ checkKey, classification: 'removed', reason: 'check_removed', definitionChanged: false, previous: oldCheck, current: null, evidence });
      continue;
    }
    const definitionChanged = !sameDefinition(oldCheck, newCheck);
    if (definitionChanged) {
      checks.push({ checkKey, classification: 'incomparable', reason: 'check_definition_changed', definitionChanged: true, previous: oldCheck, current: newCheck, evidence });
      continue;
    }
    const oldGap = hasEvidenceGap(oldCheck);
    const newGap = hasEvidenceGap(newCheck);
    if (oldCheck.status === 'not_run' || newCheck.status === 'not_run') {
      checks.push({ checkKey, classification: 'not_run', reason: 'check_not_run', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
      continue;
    }
    if (!identityIsComparable || oldGap !== null || newGap !== null) {
      const identityReason: BaselineComparisonGap | null = identityDiff.repositoryBindingChanged
        ? 'binding_identity_changed' : identityDiff.dirtyScopeChanged ? 'dirty_scope_changed'
          : identityDiff.environmentChanged ? 'environment_identity_changed'
            : firstIdentityGap(previous) ?? firstIdentityGap(current);
      checks.push({ checkKey, classification: 'incomparable', reason: oldGap ?? newGap ?? identityReason ?? 'environment_identity_missing', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
      continue;
    }
    if (oldCheck.status === 'passed' && newCheck.status === 'passed') {
      checks.push({ checkKey, classification: 'unchanged_passed', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
    } else if (isFailure(oldCheck.status) && isFailure(newCheck.status)) {
      checks.push({ checkKey, classification: 'incomparable', reason: 'failure_identity_missing', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
    } else if (isFailure(oldCheck.status) && newCheck.status === 'passed') {
      checks.push({ checkKey, classification: 'fixed', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
    } else if (oldCheck.status === 'passed' && isFailure(newCheck.status)) {
      checks.push({ checkKey, classification: 'regressed', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
    } else {
      checks.push({ checkKey, classification: 'incomparable', reason: 'evidence_incomplete', definitionChanged: false, previous: oldCheck, current: newCheck, evidence });
    }
  }
  const gaps = [...new Set([...previous.gaps, ...current.gaps, ...checks.flatMap(check => check.reason === undefined ? [] : [check.reason])])];
  return {
    schemaVersion: BASELINE_COMPARISON_SCHEMA_VERSION,
    projectId,
    previous,
    current,
    codeDiff: codeDiffWithAny,
    checks,
    comparable: identityIsComparable && checks.every(check => check.classification !== 'incomparable'),
    gaps,
    identityDiff,
  };
}
