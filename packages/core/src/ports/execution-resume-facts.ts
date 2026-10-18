/**
 * P03-9 / F-008 resume 现场只读端口（ports 契约层：类型与窄接口，无 I/O）。
 *
 * 读取结果只用于写事务外的重新授权；不授予启动/释放/结算权限。所有身份均来自
 * Core 权威存储，不接受客户端路径、原生库路径或自报停止事实。
 */
import type { AttemptRecord, WorkspaceLeaseRecord } from './attempt-store.js';
import type { ExecutionBatchRecord, RunRecord } from './execution-store.js';

export interface ExecutionResumeFactsRequest {
  readonly projectId: string;
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
}

export interface ExecutionResumeWorkspaceFacts {
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: string;
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly repoIdentity: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string | null;
  readonly codeDigest: string | null;
  readonly runId: string;
  readonly attemptId: string;
}

export interface ExecutionResumeFacts {
  readonly projectId: string;
  readonly projectStatus: string;
  readonly targetKind: 'run' | 'batch';
  readonly target: RunRecord | ExecutionBatchRecord;
  readonly batch: ExecutionBatchRecord;
  readonly runs: readonly RunRecord[];
  readonly workspace: ExecutionResumeWorkspaceFacts | null;
  readonly activeAttempts: readonly AttemptRecord[];
  readonly attemptsWithLeases: readonly AttemptRecord[];
  readonly leases: readonly WorkspaceLeaseRecord[];
}

export interface ExecutionResumeFactsReader {
  readFacts(request: ExecutionResumeFactsRequest): ExecutionResumeFacts;
}
