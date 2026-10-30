import type { BackupManifest } from './data-lifecycle.js';

export type BackupVerificationStatus = 'complete' | 'incomplete' | 'failed' | 'rejected';
export type BackupVerificationCheckStatus = 'available' | 'corrupt' | 'missing' | 'incomplete' | 'rejected';

export interface BackupVerificationCheck {
  readonly name: string;
  readonly status: BackupVerificationCheckStatus;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface BackupVerificationReport {
  readonly status: BackupVerificationStatus;
  readonly backupId: string | null;
  readonly manifestDigest: string | null;
  readonly checks: readonly BackupVerificationCheck[];
  readonly reasons: readonly string[];
  readonly scannedFiles: number;
  readonly verifiedFiles: number;
  readonly totalBytes: number;
  readonly durationMs: number;
  readonly manifest?: BackupManifest;
}

export interface BackupVerificationLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly timeoutMs?: number;
}

export interface BackupVerificationInput {
  readonly packagePath: string;
  readonly expectedBackupId?: string;
  readonly limits?: BackupVerificationLimits;
}

export interface BackupStagingInput extends BackupVerificationInput {
  readonly verification?: BackupVerificationReport;
}

export interface BackupStagingResult extends BackupVerificationReport {
  readonly stagingRelativePath?: string;
}

export interface BackupPackageVerificationService {
  verify(input: BackupVerificationInput): Promise<BackupVerificationReport>;
  stage(input: BackupStagingInput): Promise<BackupStagingResult>;
  verifyAndStage(input: BackupStagingInput): Promise<BackupStagingResult>;
}
