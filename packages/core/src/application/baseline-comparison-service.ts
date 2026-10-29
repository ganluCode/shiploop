import type { BaselineDetailResult } from '../ports/baseline.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import { isProjectVisible, requireCapability } from '../ports/authorization.js';
import { isUuidV4, PublicError } from '../ports/commands.js';
import type { BaselineComparisonResult } from '../ports/baseline-comparison.js';
import { compareBaselineDetails } from '../ports/baseline-comparison.js';
import type { BaselineQueryReadStore } from '../ports/queries.js';

export interface BaselineComparisonServiceDeps {
  readonly baselines: BaselineQueryReadStore;
  /** Must be the existing detail reader so output artifacts are verified before comparison. */
  readonly getBaseline: (principal: TrustedPrincipal, operationId: unknown) => Promise<BaselineDetailResult>;
}

export interface BaselineComparisonService {
  compareBaselines(
    principal: TrustedPrincipal,
    previousOperationId: unknown,
    currentOperationId: unknown,
  ): Promise<BaselineComparisonResult>;
}

/**
 * Read-only comparison application service. It owns project isolation and delegates
 * artifact integrity to the existing baseline detail reader; it has no write port.
 */
export function createBaselineComparisonService(
  deps: BaselineComparisonServiceDeps,
): BaselineComparisonService {
  if (deps === null || typeof deps !== 'object' || deps.baselines === null
    || typeof deps.baselines !== 'object' || typeof deps.getBaseline !== 'function') {
    throw new TypeError('BaselineComparisonService requires a read store and detail reader');
  }
  return {
    async compareBaselines(principal, previousOperationId, currentOperationId) {
      const operation = 'baselines.compare';
      requireCapability(principal, 'baseline.read', operation);
      const validateOperationId = (value: unknown): string => {
        if (typeof value !== 'string' || !isUuidV4(value)) {
          throw new PublicError('invalid_input', operation, 'operationId 必须是 RFC 4122 UUID v4', {
            details: { field: 'operationId', reason: 'invalid_operation_id' },
          });
        }
        return value;
      };
      const previousId = validateOperationId(previousOperationId);
      const currentId = validateOperationId(currentOperationId);
      const previousRecord = deps.baselines.getBaselineOperation(previousId);
      const currentRecord = deps.baselines.getBaselineOperation(currentId);
      if (previousRecord === undefined || currentRecord === undefined
        || !isProjectVisible(principal, previousRecord.projectId)
        || !isProjectVisible(principal, currentRecord.projectId)
        || previousRecord.projectId !== currentRecord.projectId) {
        throw new PublicError('not_found', operation, '基线操作不存在或不可比较');
      }
      const previous = await deps.getBaseline(principal, previousId);
      const current = await deps.getBaseline(principal, currentId);
      return compareBaselineDetails(previous, current, previousRecord.projectId);
    },
  };
}
