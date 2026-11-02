/** Durable orchestration state; business completion still belongs to finalization. */
export type FeatureCloseoutStage = 'pending' | 'verifying' | 'verified' | 'repairing' | 'committing' | 'completed' | 'failed' | 'blocked' | 'reconcile_required';
/** Raised only before a Verifier process is started. */
export class FeatureCloseoutPreparationError extends Error {
  constructor(readonly reason: 'feature_check_scope_missing' | 'feature_check_policy_invalid' | 'closeout_verification_identity_changed') {
    super(reason); this.name = 'FeatureCloseoutPreparationError';
  }
}
export interface FeatureCloseoutKey {
  readonly projectId: string;
  readonly runId: string;
  readonly featureId: string;
  readonly inputDigest: string;
}
export interface FeatureCloseoutRecord extends FeatureCloseoutKey {
  readonly stage: FeatureCloseoutStage;
  readonly revision: number;
  readonly repairCount: number;
  readonly maxRepairs: number;
  readonly owner: string;
  readonly evidenceRef: string | null;
  readonly reason: string | null;
}
export interface FeatureCloseoutStore {
  admit(key: FeatureCloseoutKey, owner: string, maxRepairs: number): FeatureCloseoutRecord;
  read(projectId: string, runId: string): FeatureCloseoutRecord | null;
  transition(current: FeatureCloseoutRecord, change: {
    readonly stage: FeatureCloseoutStage;
    readonly evidenceRef?: string | null;
    readonly reason?: string | null;
  }): FeatureCloseoutRecord;
}
