import type { WorkspaceBaseline } from './workspace.js';

export type WorkspaceInspectionReason = 'invalid_input' | 'outside_authorized_root' | 'not_found'
  | 'permission_denied' | 'repository_mismatch' | 'repository_identity_unverifiable' | 'registration_damaged' | 'detached_head'
  | 'branch_mismatch' | 'commit_missing' | 'git_failed' | 'git_timeout' | 'output_limit'
  | 'stop_unconfirmed' | 'file_limit' | 'byte_limit' | 'scan_timeout' | 'symlink_rejected'
  | 'special_file' | 'content_changed' | 'invalid_git_output' | 'io';
/** A failed inspection NEVER supplies a partial digest usable as cleanup authorization. */
export class WorkspaceInspectionError extends Error {
  readonly complete = false;
  readonly reason: WorkspaceInspectionReason;
  readonly exitCode: number | null;
  readonly signal: string | null;
  constructor(reason: WorkspaceInspectionReason, exitCode: number | null = null, signal: string | null = null) {
    super(`Workspace.inspect: ${reason}`);
    this.name = 'WorkspaceInspectionError'; this.reason = reason;
    this.exitCode = exitCode; this.signal = signal;
  }
}
export interface WorkspaceContentEntry {
  /** Exact UTF-8 relative path, never newline-separated or shell-quoted. */
  readonly path: string;
  readonly state: 'present' | 'deleted';
  readonly sizeBytes: number | null;
  readonly digest: string | null;
  readonly mode: number | null;
  readonly indexObject: string | null;
  readonly indexMode: string | null;
  /** ignored/untracked bytes are protected; Git ignore does not imply regenerability. */
  readonly protection: 'preserve' | 'tracked';
}
export interface WorkspaceInspection {
  readonly schemaVersion: 1;
  readonly complete: true;
  readonly evidenceId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly repository: WorkspaceBaseline & { readonly headCommit: string; readonly branch: string };
  readonly registration: { readonly path: string; readonly headCommit: string; readonly branch: string };
  readonly statusPorcelainBase64: string;
  readonly refsDigest: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
  readonly contents: {
    readonly tracked: readonly WorkspaceContentEntry[];
    readonly untracked: readonly WorkspaceContentEntry[];
    readonly ignored: readonly WorkspaceContentEntry[];
    /** Empty/untracked directories are retained evidence too, not scan exclusions. */
    readonly directories: readonly string[];
  };
  readonly ignoredProtection: 'preserve' | 'none_present';
  readonly directoryProtection: 'preserve' | 'none_present';
  readonly observedFileCount: number;
  readonly observedBytes: number;
  readonly gitCalls: number;
  readonly boundary: 'trusted_project_not_os_sandbox';
}
/** Inputs must originate in a Core-authorized binding/intent. This reader cannot grant authority,
 * release occupancy, infer process stop, or declare a Task passed or workspace deletable. */
export interface WorkspaceInspector {
  inspect(baseline: unknown): Promise<WorkspaceInspection>;
}
