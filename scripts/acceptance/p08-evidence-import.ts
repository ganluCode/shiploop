/**
 * P08-4 / F-004 前序交付与两类 Live 证据的只读导入器。
 *
 * 该模块只负责把 P08-1 安装清单、P08-2 Todo Live 和 P08-3 存量 Live
 * 报告按固定来源分别导入并汇总状态；它不执行模型、Git、SQLite、Host 或
 * 进程操作，也不把一类 Live 报告当作另一类的替代品。
 */
import { isAbsolute } from 'node:path';
import {
  importP08ExternalEvidence,
  validateP08ExternalEvidenceReferences,
  type P08AncestryChecker,
  type P08ExternalEvidenceKind,
  type P08ExternalEvidenceReference,
  type P08ExternalEvidenceSummary,
  P08IdentityValidationError,
} from './p08-identity.ts';
import type { P08RunIdentity } from './p08-config.ts';

export const P08_PREREQUISITE_EVIDENCE_KINDS = [
  'install-manifest', 'todo-live', 'existing-live',
] as const satisfies readonly P08ExternalEvidenceKind[];
export type P08PrerequisiteEvidenceKind = (typeof P08_PREREQUISITE_EVIDENCE_KINDS)[number];
export type P08PrerequisiteEvidenceStatus = 'passed' | 'failed' | 'not_run';

export type P08PrerequisiteEvidenceFailure = {
  readonly kind: P08PrerequisiteEvidenceKind | 'references';
  readonly status: 'failed' | 'not_run';
  readonly code: string;
  readonly detail: string;
};

export type P08PrerequisiteEvidenceImportResult = {
  readonly schemaVersion: 1;
  readonly identity: { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string } | null;
  readonly status: P08PrerequisiteEvidenceStatus;
  readonly counts: { readonly passed: number; readonly failed: number; readonly not_run: number };
  readonly reports: readonly P08ExternalEvidenceSummary[];
  readonly failures: readonly P08PrerequisiteEvidenceFailure[];
  readonly blockingIssues: readonly string[];
  readonly evidenceRefs: readonly { readonly kind: P08PrerequisiteEvidenceKind; readonly path: string; readonly digest: string }[];
};

const MISSING_CODES = new Set(['p08_external_evidence_missing']);
const SAFE_DETAIL = /(?:\/Users\/[^\s"'`,;)]*|\/home\/[^\s"'`,;)]*|\/private\/tmp\/[^\s"'`,;)]*|\/tmp\/[^\s"'`,;)]*|[A-Za-z]:[\\/][^\s"'`,;)]*)/g;

function safeDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(SAFE_DETAIL, '<redacted-path>')
    .replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9._-]+)/gi, '<redacted>');
}

function failureFrom(error: unknown, kind: P08PrerequisiteEvidenceFailure['kind']): P08PrerequisiteEvidenceFailure {
  const code = error instanceof P08IdentityValidationError ? error.code : 'p08_external_evidence_import_failed';
  return { kind, status: MISSING_CODES.has(code) ? 'not_run' : 'failed', code, detail: safeDetail(error) };
}

function reportStatus(report: P08ExternalEvidenceSummary): P08PrerequisiteEvidenceStatus {
  if (report.status === 'passed') return 'passed';
  if (report.status === 'not_run') return 'not_run';
  return 'failed';
}

function resultStatus(reports: readonly P08ExternalEvidenceSummary[], failures: readonly P08PrerequisiteEvidenceFailure[]): P08PrerequisiteEvidenceStatus {
  if (failures.some(failure => failure.status === 'failed') || reports.some(report => reportStatus(report) === 'failed')) return 'failed';
  if (failures.some(failure => failure.status === 'not_run') || reports.some(report => reportStatus(report) === 'not_run')) return 'not_run';
  return 'passed';
}

function buildResult(reports: readonly P08ExternalEvidenceSummary[], failures: readonly P08PrerequisiteEvidenceFailure[], runIdentity: P08RunIdentity | null): P08PrerequisiteEvidenceImportResult {
  const status = resultStatus(reports, failures);
  const reportStatuses = reports.map(reportStatus);
  const counts = {
    passed: reportStatuses.filter(value => value === 'passed').length,
    failed: reportStatuses.filter(value => value === 'failed').length + failures.filter(failure => failure.status === 'failed').length,
    not_run: reportStatuses.filter(value => value === 'not_run').length + failures.filter(failure => failure.status === 'not_run').length,
  };
  const blockingIssues = [
    ...reports.filter(report => reportStatus(report) !== 'passed').map(report => `${report.kind}:${reportStatus(report)}`),
    ...failures.map(failure => `${failure.kind}:${failure.code === 'p08_external_evidence_missing' ? 'missing' : failure.status === 'not_run' ? 'not_run' : 'failed'}`),
  ];
  return {
    schemaVersion: 1, identity: runIdentity === null ? null : {
      runId: runIdentity.runId, testedCommit: runIdentity.testedCommit, inputsDigest: runIdentity.inputsDigest,
    }, status, counts, reports, failures, blockingIssues,
    evidenceRefs: reports.map(report => ({ kind: report.kind as P08PrerequisiteEvidenceKind, path: report.path, digest: report.digest })),
  };
}

/**
 * 导入 P08-1/P08-2/P08-3 三类前序证据。缺失文件是 not_run；摘要、来源、
 * schema、结构、身份、祖先关系或完整性错误是 failed。函数返回结构化结果，
 * 让入口把事实写入报告；不会为了生成结果而修改任何报告或产品状态。
 */
export async function importP08PrerequisiteEvidence(options: {
  readonly evidenceRoot: string;
  readonly references: readonly unknown[];
  readonly runIdentity: P08RunIdentity;
  readonly isAncestor: P08AncestryChecker;
}): Promise<P08PrerequisiteEvidenceImportResult> {
  if (!options || typeof options.evidenceRoot !== 'string' || !isAbsolute(options.evidenceRoot)) {
    return buildResult([], [{ kind: 'references', status: 'failed', code: 'p08_external_reference_invalid', detail: '证据根必须是绝对路径' }], null);
  }

  let references: P08ExternalEvidenceReference[];
  try {
    references = validateP08ExternalEvidenceReferences(options.references);
  } catch (error) {
    return buildResult([], [failureFrom(error, 'references')], null);
  }

  if (references.some(reference => !P08_PREREQUISITE_EVIDENCE_KINDS.includes(reference.kind as P08PrerequisiteEvidenceKind))) {
    return buildResult([], [{ kind: 'references', status: 'failed', code: 'p08_external_reference_invalid', detail: '前序证据必须恰好包含安装、Todo Live、存量 Live 三类' }], options.runIdentity);
  }

  const byKind = new Map<P08PrerequisiteEvidenceKind, P08ExternalEvidenceReference>();
  for (const kind of P08_PREREQUISITE_EVIDENCE_KINDS) {
    const matches = references.filter(reference => reference.kind === kind);
    if (matches.length === 0) {
      continue;
    }
    byKind.set(kind, matches[0]!);
  }

  const reports: P08ExternalEvidenceSummary[] = [];
  const failures: P08PrerequisiteEvidenceFailure[] = [];
  for (const kind of P08_PREREQUISITE_EVIDENCE_KINDS) {
    const reference = byKind.get(kind);
    if (reference === undefined) {
      failures.push({ kind, status: 'not_run', code: 'p08_external_evidence_missing', detail: '必需证据引用缺失' });
      continue;
    }
    try {
      reports.push(await importP08ExternalEvidence({
        evidenceRoot: options.evidenceRoot, reference, runIdentity: options.runIdentity, isAncestor: options.isAncestor,
      }));
    } catch (error) {
      failures.push(failureFrom(error, kind));
    }
  }

  return buildResult(reports.sort((left, right) => P08_PREREQUISITE_EVIDENCE_KINDS.indexOf(left.kind as P08PrerequisiteEvidenceKind)
    - P08_PREREQUISITE_EVIDENCE_KINDS.indexOf(right.kind as P08PrerequisiteEvidenceKind)), failures, options.runIdentity);
}

/** 兼容入口层的命名：前序证据集合必须是三类，不接受单一 Live 报告替代集合。 */
export const importP08ExternalEvidenceBundle = importP08PrerequisiteEvidence;
