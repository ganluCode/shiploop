import { lstatSync, readFileSync, writeFileSync } from 'node:fs';

export interface P05ProductIdentity {
  readonly runId: string;
  readonly commit: string;
  readonly inputsDigest: string;
}

/** Transport already validates the complete product wire contract; envelope checks bind that capture to this run. */
export function validateP05ProductCapture(value: unknown, identity: P05ProductIdentity) {
  const envelope = value as {
    schemaVersion?: unknown; identity?: Partial<P05ProductIdentity>; source?: unknown; mode?: unknown;
    projectId?: unknown; featureId?: unknown;
    report?: { schemaVersion?: unknown; scope?: unknown; feature?: { featureId?: unknown }; runs?: unknown; tasks?: unknown };
  } | null;
  if (envelope?.schemaVersion !== 1 || envelope.source !== 'features.report.get' || envelope.mode !== 'offline-fixture' ||
      envelope.identity?.runId !== identity.runId || envelope.identity.commit !== identity.commit ||
      envelope.identity.inputsDigest !== identity.inputsDigest ||
      !/^[0-9a-f]{40}$/.test(identity.commit) || !/^[0-9a-f]{64}$/.test(identity.inputsDigest) ||
      typeof envelope.projectId !== 'string' || !envelope.projectId ||
      typeof envelope.featureId !== 'string' || !/^[\w-]+$/.test(envelope.featureId) ||
      envelope.report?.schemaVersion !== 1 || envelope.report.scope !== 'feature-execution-report' ||
      envelope.report.feature?.featureId !== envelope.featureId ||
      !Array.isArray(envelope.report.runs) || envelope.report.runs.length === 0 || !Array.isArray(envelope.report.tasks)) {
    throw new Error('产品报告证据无效或受测身份不匹配');
  }
  return { featureId: envelope.featureId, content: JSON.stringify(envelope, null, 2) + '\n' };
}

export function writeP05ProductCapture(file: string, value: unknown, identity: P05ProductIdentity): void {
  const capture = validateP05ProductCapture(value, identity);
  writeFileSync(file, capture.content, { flag: 'wx', mode: 0o600 });
}

export function loadP05ProductCapture(file: string, identity: P05ProductIdentity) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('产品报告证据文件非法');
  return validateP05ProductCapture(JSON.parse(readFileSync(file, 'utf8')), identity);
}
