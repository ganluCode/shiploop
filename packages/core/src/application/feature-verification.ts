import type { WorkspaceInspector, WorkspaceInspection } from '../ports/workspace-inspector.js';
import type { WorkResourceAccess, WorkResourceSnapshot, WorkResourceStopVerifier } from '../ports/work-resources.js';
import type {
  FeatureTaskGate,
  FeatureVerificationExecutionInput,
  FeatureVerificationExecutionResult,
  FeatureVerificationExecutor,
  FeatureVerificationInput,
  FeatureVerificationResult,
} from '../ports/feature-verification.js';
import { FEATURE_VERIFICATION_OPERATION } from '../ports/feature-verification.js';
import type { VerificationPlan } from './verification-plan.js';
import { buildVerificationPlan } from './verification-plan.js';
import { verificationCodeIdentity, type VerificationCodeIdentity } from '../ports/verification-aggregate.js';

export interface FeatureVerificationOptions {
  readonly taskDag: FeatureTaskGate;
  readonly resources: Pick<WorkResourceAccess, 'read'>;
  readonly stopVerifier: WorkResourceStopVerifier;
  readonly workspace: WorkspaceInspector;
  readonly execute: FeatureVerificationExecutor;
  /** Keeps the worktree lease and common resource occupied for the whole batch. */
  readonly withResource: <T>(identity: unknown, callback: () => Promise<T>) => Promise<T>;
  readonly buildPlan?: (input: unknown) => VerificationPlan;
  readonly readExecutionIdentity?: () => Promise<{ readonly policyDigest: string; readonly environmentDigest?: string }>;
  /** Re-reads the Feature-level human gate after the final machine evidence is assembled. */
  readonly readFinalApproval?: (input: {
    readonly projectId: string;
    readonly featureId: string;
    readonly runId: string;
    readonly batchId: string;
    readonly executionVersion: number;
    readonly codeDigest: string;
    readonly policyDigest: string;
    readonly environmentDigest?: string;
    readonly codeIdentity: VerificationCodeIdentity;
    readonly execution: FeatureVerificationExecutionResult;
  }) => Promise<boolean>;
}

function sameIdentity(left: VerificationCodeIdentity, right: VerificationCodeIdentity): boolean {
  return left.headCommit === right.headCommit
    && left.codeDigest === right.codeDigest
    && left.trackedPathsDigest === right.trackedPathsDigest
    && left.untrackedPathsDigest === right.untrackedPathsDigest
    && left.ignoredPathsDigest === right.ignoredPathsDigest
    && left.executionDigest === right.executionDigest
    && left.environmentDigest === right.environmentDigest;
}

function identityFrom(inspection: WorkspaceInspection, environmentDigest?: string): VerificationCodeIdentity {
  return verificationCodeIdentity(inspection, { environmentDigest });
}

function sameResourceIdentity(left: WorkResourceSnapshot['identity'], right: FeatureVerificationInput['resourceIdentity']): boolean {
  return left.projectId === right.projectId && left.attemptId === right.attemptId
    && left.owner === right.owner && left.hostInstanceId === right.hostInstanceId
    && left.executionVersion === right.executionVersion;
}

function result(
  status: FeatureVerificationResult['status'],
  reason: FeatureVerificationResult['reason'],
  codeIdentity: VerificationCodeIdentity | null = null,
  execution?: FeatureVerificationResult['execution'],
  invalidated = false,
): FeatureVerificationResult {
  return { status, batchId: execution?.batchId ?? null, reason, invalidated, codeIdentity, ...(execution ? { execution } : {}) };
}

/**
 * Coordinates the Feature-only verification boundary. It does not mutate Task,
 * Run, Feature, budget or delivery state. The supplied executor remains the
 * owner of VerificationBatch/CheckResult/Artifact persistence.
 */
export function createFeatureVerificationCoordinator(options: FeatureVerificationOptions) {
  const makePlan = options.buildPlan ?? buildVerificationPlan;

  async function run(input: FeatureVerificationInput): Promise<FeatureVerificationResult> {
    const gate = options.taskDag.evaluate(input.projectId, input.runId);
    if (gate.reason !== 'all_passed' || gate.handoff !== 'feature_final_verification') {
      return result('blocked', 'tasks_not_passed');
    }
    if (input.targets.length === 0 || !/^[0-9a-f]{64}$/.test(input.policyDigest)) {
      return result('blocked', 'full_plan_unavailable');
    }

    return options.withResource(input.resourceIdentity, async () => {
      let snapshot: WorkResourceSnapshot;
      let stopEvidence: object | null;
      try {
        snapshot = options.resources.read(input.resourceIdentity);
        if (!sameResourceIdentity(snapshot.identity, input.resourceIdentity)) return result('blocked', 'stop_unconfirmed');
        stopEvidence = await options.stopVerifier.verify(snapshot);
      } catch {
        return result('blocked', 'stop_unconfirmed');
      }
      if (stopEvidence === null) return result('blocked', 'stop_unconfirmed');

      let beforeInspection: WorkspaceInspection;
      try {
        beforeInspection = await options.workspace.inspect(input.workspaceBaseline);
      } catch {
        return result('blocked', 'workspace_unavailable');
      }
      const executionIdentity = options.readExecutionIdentity ? await options.readExecutionIdentity() : null;
      if (executionIdentity && (executionIdentity.policyDigest !== input.policyDigest
        || (input.environmentDigest !== undefined && executionIdentity.environmentDigest !== input.environmentDigest))) {
        return result('invalid', 'identity_changed', identityFrom(beforeInspection, input.environmentDigest), undefined, true);
      }
      const codeIdentity = identityFrom(beforeInspection, input.environmentDigest);
      const changedPaths = [
        ...beforeInspection.contents.tracked,
        ...beforeInspection.contents.untracked,
        ...beforeInspection.contents.ignored,
      ].map(entry => ({ path: entry.path, state: entry.state === 'deleted' ? 'deleted' as const : entry.protection === 'tracked' ? 'modified' as const : 'untracked' as const }));

      let plan: VerificationPlan;
      try {
        plan = makePlan({ policy: input.policy, changedPaths, candidate: null });
      } catch {
        return result('blocked', 'full_plan_unavailable', codeIdentity);
      }
      if (plan.status !== 'ready' || plan.mode !== 'full_fallback' || plan.selectedChecks.length === 0
        || plan.selectedChecks.some(check => check.required && !plan.selectedCheckKeys.includes(check.checkKey))) {
        return result('blocked', 'full_plan_unavailable', codeIdentity);
      }

      const assertCurrentIdentity = async (): Promise<boolean> => {
        try {
          const current = identityFrom(await options.workspace.inspect(input.workspaceBaseline), input.environmentDigest);
          if (!sameIdentity(codeIdentity, current)) return false;
          const currentExecution = options.readExecutionIdentity ? await options.readExecutionIdentity() : null;
          return currentExecution === null || (currentExecution.policyDigest === input.policyDigest
            && (input.environmentDigest === undefined || currentExecution.environmentDigest === input.environmentDigest));
        } catch {
          return false;
        }
      };
      const executionInput: FeatureVerificationExecutionInput = {
        projectId: input.projectId, featureId: input.featureId, runId: input.runId,
        batchId: input.batchId, operation: input.operation ?? FEATURE_VERIFICATION_OPERATION,
        executionVersion: input.executionVersion, codeIdentity, policyDigest: input.policyDigest,
        environmentSummary: {
          ...input.environmentSummary,
          workspace: {
            headCommit: codeIdentity.headCommit, codeDigest: codeIdentity.codeDigest,
            trackedPathsDigest: codeIdentity.trackedPathsDigest ?? null,
            untrackedPathsDigest: codeIdentity.untrackedPathsDigest ?? null,
            ignoredPathsDigest: codeIdentity.ignoredPathsDigest ?? null,
          },
        },
        plan, targets: [...input.targets], assertCurrentIdentity,
      };
      let execution: FeatureVerificationResult['execution'];
      try {
        execution = await options.execute.start(executionInput);
      } catch {
        return result('error', 'execution_failed', codeIdentity);
      }
      if (!(await assertCurrentIdentity())) {
        return result('invalid', 'source_changed', codeIdentity, execution, true);
      }
      if (execution.results.length !== plan.selectedChecks.length
        || plan.selectedChecks.some(check => {
          const matching = execution.results.filter(item => item.checkKey === check.checkKey);
          return matching.length !== 1
            || !['passed', 'failed', 'error', 'inconclusive'].includes(matching[0].status)
            || (execution.status === 'passed' && matching[0].status !== 'passed')
            || matching[0].resultId.length === 0 || matching[0].outputArtifactId == null;
        })) {
        return result('error', 'evidence_incomplete', codeIdentity, execution);
      }
      if (execution.status !== 'passed') {
        return result(execution.status, 'execution_failed', codeIdentity, execution);
      }
      if (options.readFinalApproval) {
        let finalApprovalCurrent: boolean;
        try {
          finalApprovalCurrent = await options.readFinalApproval({
            projectId: input.projectId,
            featureId: input.featureId,
            runId: input.runId,
            batchId: input.batchId,
            executionVersion: input.executionVersion,
            codeDigest: codeIdentity.codeDigest,
            policyDigest: input.policyDigest,
            environmentDigest: input.environmentDigest,
            codeIdentity,
            execution,
          });
        } catch {
          return result('blocked', 'approval_waiting', codeIdentity, execution);
        }
        if (!finalApprovalCurrent) return result('blocked', 'approval_waiting', codeIdentity, execution);
      }
      return result('passed', 'verified', codeIdentity, execution);
    });
  }

  return { run };
}
