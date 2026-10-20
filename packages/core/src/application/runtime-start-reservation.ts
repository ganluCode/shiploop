import { createHash } from 'node:crypto';

/** Shared idempotency key for fallback pre-reservation and actual Runtime admission. */
export function runtimeStartReservationKey(attemptId: string, executionVersion: number): string {
  return createHash('sha256').update(`shiploop:runtime-start\n${attemptId}\n${executionVersion}`).digest('hex');
}
