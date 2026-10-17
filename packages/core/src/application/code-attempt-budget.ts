import { createHash } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { CodeAttemptOutcome, CodeAttemptSettlementInput } from '../ports/code-attempt-budget.js';
import type { MachineVerificationInput } from '../ports/verification-aggregate.js';
import { stableStringify } from '../ports/feature-plan.js';
import { resolveTaskAttemptCaps } from '../ports/execution-budget.js';
import { validateTaskExecutionConfig } from './task-strategy-selection.js';
import type { VerificationStore } from '../ports/verification-store.js';
import { StorageError } from '../ports/errors.js';
import type { StoredVerificationAggregationInput } from './verification-aggregate-service.js';
import { aggregateMachineVerification } from './verification-aggregate.js';

export type CheckFailureKind = 'code' | 'authentication' | 'configuration' | 'protocol' | 'timeout'
  | 'environment' | 'recording' | 'unknown';

/** Adapter-verified failure kinds, never inferred from output text or a nonzero exit alone. */
export function classifyCodeAttempt(
  input: MachineVerificationInput,
  failures: Readonly<Record<string, CheckFailureKind>>,
): { readonly outcome: CodeAttemptOutcome; readonly reason: string; readonly failedCheckKeys: readonly string[] } {
  const nonCode = (reason: string) => ({ outcome: 'non_code_failure' as const, reason, failedCheckKeys: [] });
  if (!input.plan.selectedChecks.some(check => check.required)) return nonCode('missing_required_check');
  const selected = new Set(input.plan.selectedChecks.map(check => check.checkKey));
  if (input.results.some(check => !selected.has(check.checkKey))) return nonCode('unexpected_check');
  const failed = input.results.filter(check => check.status === 'failed');
  for (const check of input.results) {
    if (check.outputArtifactId === null || check.outputDigest === null) return nonCode('evidence_incomplete');
    if (input.evidence?.[check.checkKey]?.status !== 'complete') return nonCode('evidence_incomplete');
    if (check.status !== 'passed' && check.status !== 'failed') return nonCode('check_uncertain');
    if (check.timedOut || check.signal !== null || !Number.isInteger(check.exitCode)
      || (check.status === 'failed' ? check.exitCode! <= 0 : check.exitCode !== 0)) return nonCode('process_uncertain');
    if (check.status === 'failed') {
      const count = input.testCounts?.[check.checkKey];
      if (failures[check.checkKey] !== 'code') return nonCode('failure_not_code');
      if (!Number.isSafeInteger(count) || count! < 1) return nonCode('test_collection_unconfirmed');
    }
  }
  // Validate the entire observation (including identity AFTER every check), even
  // when an earlier check failed. This prevents order-dependent budget charges.
  const validated = aggregateMachineVerification({ ...input,
    results: input.results.map(check => check.status === 'failed' ? { ...check, status: 'passed', exitCode: 0 } : check) });
  if (!validated.machinePassed) return nonCode(validated.category);
  return failed.length > 0
    ? { outcome: 'code_failure', reason: 'deterministic_check_failure', failedCheckKeys: failed.map(check => check.checkKey).sort() }
    : { outcome: 'passed', reason: 'checks_passed', failedCheckKeys: [] };
}

/**
 * Settle inside the caller's existing short write transaction. No new Attempt,
 * retry, or Task state transition occurs here. codeRetryEligible describes only
 * the code quota; the next claim must still pass ALL parent budgets and fencing.
 */
export function settleCodeAttemptInTransaction(
  tx: CommandTransaction,
  identity: Omit<CodeAttemptSettlementInput, 'outcome' | 'observationDigest'>,
  input: MachineVerificationInput,
  failures: Readonly<Record<string, CheckFailureKind>>,
) {
  const assessment = classifyCodeAttempt(input, failures);
  const { humanReview: _humanReview, ...observation } = input;
  const observationDigest = createHash('sha256').update(stableStringify({
    ...observation, results: [...input.results].sort((a, b) => a.checkKey.localeCompare(b.checkKey)), failures,
  })).digest('hex');
  const reservation = tx.settleTaskAttemptBudget({ ...identity, outcome: assessment.outcome, observationDigest });
  const counters = tx.getTaskExecutionCounters(identity.projectId, identity.taskId);
  const task = tx.getTask(identity.projectId, identity.taskId);
  const config = validateTaskExecutionConfig(task.executionConfig, 'CodeAttemptBudget.settle');
  const caps = resolveTaskAttemptCaps({ maxCodeAttempts: config.maxCodeAttempts }, { operation: 'CodeAttemptBudget.settle' });
  return { ...assessment, reservation, counters,
    codeRetryEligible: assessment.outcome === 'code_failure' && counters.codeAttemptsUsed < caps.maxCodeAttempts };
}

/** F-002 integration: bind classification to a finalized immutable verification batch. */
export function classifyStoredCodeAttempt(
  verification: VerificationStore,
  identity: Omit<CodeAttemptSettlementInput, 'outcome' | 'observationDigest'>,
  input: StoredVerificationAggregationInput,
  failures: Readonly<Record<string, CheckFailureKind>>,
) {
  const batch = verification.getVerificationBatch(identity.projectId, input.batchId);
  if (input.projectId !== identity.projectId || batch.taskId !== identity.taskId || batch.runId !== identity.runId
    || batch.attemptId !== identity.attemptKey || batch.status === 'running') {
    throw new StorageError('conflict', 'CodeAttemptBudget.classify', 'Verification batch does not match a finalized Attempt observation');
  }
  const results = verification.listCheckResults(identity.projectId, batch.id);
  const evidence: NonNullable<MachineVerificationInput['evidence']> = Object.fromEntries(results.map(check => {
    try {
      const observed = verification.readCheckResultEvidence(identity.projectId, check.id);
      return [check.checkKey, { status: observed.status, reference: check.outputArtifactId }];
    } catch {
      return [check.checkKey, { status: 'incomplete' as const }];
    }
  }));
  const consistentStatus = batch.status === 'passed'
    ? results.every(check => check.status === 'passed')
    : batch.status === 'failed' && results.some(check => check.status === 'failed');
  const machine = {
    ...input, results, evidence, expectedCodeDigest: batch.codeDigest, expectedExecutionDigest: batch.policyDigest,
    plan: {
      status: consistentStatus ? ('ready' as const) : ('inconclusive' as const),
      selectedChecks: batch.checkSnapshot.filter(check => batch.selection.selectedCheckKeys.includes(check.checkKey)),
      requiredCheckKeys: batch.checkSnapshot.filter(check => check.required).map(check => check.checkKey),
    },
  } satisfies MachineVerificationInput;
  const assessment = classifyCodeAttempt(machine, failures);
  const { humanReview: _humanReview, ...observation } = machine;
  const observationDigest = createHash('sha256').update(stableStringify({
    ...observation, results: [...results].sort((a, b) => a.checkKey.localeCompare(b.checkKey)), failures,
  })).digest('hex');
  return { assessment, observationDigest, batch };
}

/** Settle inside the caller's existing short write transaction. No new Attempt,
 * retry, or Task state transition occurs here. codeRetryEligible describes only
 * the code quota; the next claim must still pass ALL parent budgets and fencing. */
export function settleStoredCodeAttemptInTransaction(
  tx: CommandTransaction,
  verification: VerificationStore,
  identity: Omit<CodeAttemptSettlementInput, 'outcome' | 'observationDigest'>,
  input: StoredVerificationAggregationInput,
  failures: Readonly<Record<string, CheckFailureKind>>,
) {
  const classified = classifyStoredCodeAttempt(verification, identity, input, failures);
  const reservation = tx.settleTaskAttemptBudget({ ...identity, outcome: classified.assessment.outcome, observationDigest: classified.observationDigest });
  const counters = tx.getTaskExecutionCounters(identity.projectId, identity.taskId);
  const task = tx.getTask(identity.projectId, identity.taskId);
  const config = validateTaskExecutionConfig(task.executionConfig, 'CodeAttemptBudget.settle');
  const caps = resolveTaskAttemptCaps({ maxCodeAttempts: config.maxCodeAttempts }, { operation: 'CodeAttemptBudget.settle' });
  return { ...classified.assessment, reservation, counters,
    codeRetryEligible: classified.assessment.outcome === 'code_failure' && counters.codeAttemptsUsed < caps.maxCodeAttempts };
}
