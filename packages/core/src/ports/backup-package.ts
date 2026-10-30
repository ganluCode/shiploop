import type { BackupManifest } from './data-lifecycle.js';

export type BackupPackageReportStatus = 'complete' | 'incomplete' | 'failed';

export interface BackupPackageReport {
  readonly status: BackupPackageReportStatus;
  readonly backupId: string;
  readonly scannedProjects: number;
  readonly scannedArtifacts: number;
  readonly copiedFiles: number;
  readonly totalBytes: number;
  readonly durationMs: number;
  readonly reasons: readonly string[];
  readonly manifest?: BackupManifest;
}

export interface BackupPackageResult {
  readonly backupId: string;
  readonly packagePath: string;
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
  readonly report: BackupPackageReport;
}

export interface BackupPackageCreateInput {
  readonly backupId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
}

export interface BackupPackageService {
  create(input: BackupPackageCreateInput): Promise<BackupPackageResult>;
  readLastReport(): BackupPackageReport | null;
}
