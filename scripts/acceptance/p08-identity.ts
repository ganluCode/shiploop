/**
 * P08-4 / F-002 P08 前置交付、受测源码与外部证据的身份校验（fail-closed）。
 *
 * 消费 F-001 冻结契约（scripts/acceptance/p08-config.ts），为 P08-4 后续 Task
 * （范围计划、证据导入、安装检查、正式入口与 Phase 集成）提供统一身份基座：
 *
 * - **前置交付基线**：P08-1～P08-3 交付记录逐项校验 feature 身份、commit 格式、
 *   交付状态、接口满足声明、交付证据与受测 HEAD 的祖先关系；任一缺失或不匹
 *   配都形成 blocked/not_run，不产生验收通过（复用 evaluateP08Prerequisites）；
 * - **不可变输入摘要**：P08 运行身份绑定配置、清单、前置交付、工具链、适用
 *   测试范围与外部报告引用的内容摘要；源码文件集合/哈希、HEAD 或工具链变化
 *   输出结构化漂移原因并失败关闭；
 * - **运行目录**：按 runId 一次性预留（create-once）；已存在的运行目录不可
 *   覆盖，旧运行证据原样保留；
 * - **外部证据**：Todo Live（shiploop.todo.live-evidence）、存量 Live
 *   （shiploop.brownfield.evidence-envelope）、安装产物（shiploop.p08.release-manifest）
 *   与人工门禁（shiploop.p08.manual-gate-record）分别校验来源 kind、runId、
 *   commit、输入摘要、结构版本与允许状态；错误身份、重复引用、损坏 JSON、
 *   未知字段或非受测 HEAD 祖先的陈旧 commit 一律拒绝；导入只读，不改写被引
 *   用的证据文件、产品 SQLite 或 Feature/Phase 元数据；
 * - **脱敏诊断**：校验失败在独立运行目录写入脱敏诊断（不含开发机绝对路径、
 *   凭据或认证内容），重复 runId 时写入独立 diagnostics 目录，不覆盖任何已
 *   有文件或原报告。
 *
 * 本模块不执行 Git/SQLite/Host/模型命令：祖先关系由调用方通过受控 probe 得
 * 出后注入；真实前序报告与 Live 运行是否存在由 Phase 入口核对。仅使用可擦
 * 除 TypeScript 语法，Node 22 原生类型擦除可直接运行（brownfield 校验器在
 * 非 Vitest 环境按仓库既有 loader 钩子延迟加载）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  P08_PREREQUISITE_FEATURES,
  P08_TOOLCHAIN,
  P08AcceptError,
  evaluateP08Prerequisites,
  p08RunDirectoryDisposition,
  validateP08RunIdentity,
  type P08PrerequisiteBlockerCode,
  type P08PrerequisiteEvaluation,
  type P08RunIdentity,
} from './p08-config.ts';
import { validateTodoLiveEvidenceReport } from './p08-todo-live-report.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P08_PREREQUISITE_BASELINE_SCHEMA_VERSION = 1;
export const P08_PREREQUISITE_BASELINE_KIND = 'shiploop.p08.prerequisite-baselines';
export const P08_MANUAL_GATE_SCHEMA_VERSION = 1;
export const P08_MANUAL_GATE_RECORD_KIND = 'shiploop.p08.manual-gate-record';
export const P08_INSTALL_MANIFEST_SCHEMA_VERSION = 1;
export const P08_INSTALL_MANIFEST_KIND = 'shiploop.p08.release-manifest';
export const P08_IDENTITY_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const P08_IDENTITY_DIAGNOSTIC_KIND = 'shiploop.p08.identity-diagnostic';

/** 四类外部证据：两类 live 分开核对、互不替代；安装产物与人工门禁独立登记。 */
export const P08_EXTERNAL_EVIDENCE_KINDS = ['todo-live', 'existing-live', 'install-manifest', 'manual-gate'] as const;
export type P08ExternalEvidenceKind = (typeof P08_EXTERNAL_EVIDENCE_KINDS)[number];
export const P08_EXTERNAL_EVIDENCE_REPORT_KINDS: Readonly<Record<P08ExternalEvidenceKind, string>> = {
  'todo-live': 'shiploop.todo.live-evidence',
  'existing-live': 'shiploop.brownfield.evidence-envelope',
  'install-manifest': P08_INSTALL_MANIFEST_KIND,
  'manual-gate': P08_MANUAL_GATE_RECORD_KIND,
};
export const P08_EXTERNAL_EVIDENCE_SCHEMA_VERSIONS: Readonly<Record<P08ExternalEvidenceKind, number>> = {
  'todo-live': 1,
  'existing-live': 1,
  'install-manifest': P08_INSTALL_MANIFEST_SCHEMA_VERSION,
  'manual-gate': P08_MANUAL_GATE_SCHEMA_VERSION,
};
export const P08_MANUAL_GATE_STATUSES = ['pending', 'confirmed', 'rejected'] as const;
export type P08ManualGateStatus = (typeof P08_MANUAL_GATE_STATUSES)[number];
export const P08_INSTALL_STATUS_VALUES = ['passed', 'failed', 'not_run'] as const;
export const P08_INSTALL_LAYER_STATUS_VALUES = ['delivered', 'passed', 'failed', 'not_run'] as const;

export type P08IdentityFailureStage = 'baselines' | 'run-directory' | 'inputs' | 'external-evidence' | 'diagnostics';
export type P08IdentityFailureCode =
  | 'p08_baseline_structure_invalid'
  | 'p08_baseline_not_delivered'
  | 'p08_baseline_interfaces_unsatisfied'
  | 'p08_baseline_invalid_commit'
  | 'p08_baseline_evidence_missing'
  | 'p08_baseline_interfaces_missing'
  | 'p08_baseline_not_ancestor'
  | 'p08_run_directory_invalid'
  | 'p08_run_identity_invalid'
  | 'p08_inputs_invalid'
  | 'p08_input_drift'
  | 'p08_external_reference_invalid'
  | 'p08_external_evidence_missing'
  | 'p08_external_evidence_corrupt_json'
  | 'p08_external_evidence_digest_mismatch'
  | 'p08_external_evidence_kind_mismatch'
  | 'p08_external_evidence_schema_invalid'
  | 'p08_external_evidence_structure_invalid'
  | 'p08_external_evidence_stale_commit'
  | 'p08_manual_gate_identity_mismatch'
  | 'p08_manual_gate_status_invalid'
  | 'p08_diagnostic_invalid'
  | 'p08_diagnostic_write_failed'
  | 'p08_identity_check_failed';

export class P08IdentityValidationError extends Error {
  readonly code: P08IdentityFailureCode;
  readonly stage: P08IdentityFailureStage;
  constructor(code: P08IdentityFailureCode, stage: P08IdentityFailureStage, message: string) {
    super(message);
    this.name = 'P08IdentityValidationError';
    this.code = code;
    this.stage = stage;
  }
}
function fail(code: P08IdentityFailureCode, stage: P08IdentityFailureStage, message: string): never {
  throw new P08IdentityValidationError(code, stage, message);
}
/** 把 F-001 契约错误（P08AcceptError，无 code/stage）映射为结构化身份失败。 */
function mapConfigError(error: unknown, code: P08IdentityFailureCode, stage: P08IdentityFailureStage): never {
  if (error instanceof P08AcceptError) fail(code, stage, error.message);
  if (error instanceof P08IdentityValidationError) throw error;
  fail('p08_identity_check_failed', stage, error instanceof Error ? error.message : String(error));
}

export type P08IdentityFailure = { readonly code: P08IdentityFailureCode; readonly stage: P08IdentityFailureStage; readonly detail?: string };

/** 把任意异常映射为身份失败记录；带 code/stage 的直接保留，其余归为通用失败。 */
export function p08IdentityFailureFromError(error: unknown, stage: P08IdentityFailureStage): P08IdentityFailure {
  if (error !== null && typeof error === 'object' && 'code' in error && 'stage' in error) {
    const candidate = error as { code?: unknown; stage?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.stage === 'string') {
      return { code: candidate.code as P08IdentityFailureCode, stage: candidate.stage as P08IdentityFailureStage,
        ...(typeof candidate.message === 'string' && candidate.message.length > 0 ? { detail: candidate.message } : {}) };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'p08_identity_check_failed', stage, detail: message };
}

/* ------------------------------------------------------------------ *
 * 校验辅助（结构、键序、路径安全）
 * ------------------------------------------------------------------ */

const CREDENTIAL_KEY = /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REF_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|~\/|\\\\|file:\/\/)/;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_DRIFT_REASONS = 32;

function object(value: unknown, code: P08IdentityFailureCode, stage: P08IdentityFailureStage, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, stage, `${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code: P08IdentityFailureCode, stage: P08IdentityFailureStage, label: string): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY.test(key)) fail(code, stage, `${label} 含凭据字段：${key}`);
    if (!allowed.includes(key)) fail(code, stage, `${label} 含未知字段：${key}`);
  }
  for (const key of allowed) if (!(key in value)) fail(code, stage, `${label} 缺少字段：${key}`);
}
function nonEmptyString(value: unknown, code: P08IdentityFailureCode, stage: P08IdentityFailureStage, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.length > maxLength) {
    fail(code, stage, `${label} 必须是长度受限的非空字符串`);
  }
  return value;
}
function boolean(value: unknown, code: P08IdentityFailureCode, stage: P08IdentityFailureStage, label: string): boolean {
  if (typeof value !== 'boolean') fail(code, stage, `${label} 必须是布尔值`);
  return value;
}
function stringArray(value: unknown, code: P08IdentityFailureCode, stage: P08IdentityFailureStage, label: string, maxLength = 512): string[] {
  if (!Array.isArray(value)) fail(code, stage, `${label} 必须是字符串数组`);
  return value.map(entry => nonEmptyString(entry, code, stage, `${label}[]`, maxLength));
}
/** 证据/接口引用：非空受限字符串，拒绝绝对路径、用户目录与回溯段。 */
function safeReference(value: unknown, code: P08IdentityFailureCode, stage: P08IdentityFailureStage, label: string): string {
  const text = nonEmptyString(value, code, stage, label, MAX_EVIDENCE_REF_LENGTH);
  if (ABSOLUTE_PATH_PATTERN.test(text) || text.includes('\\') || text.split('/').some(part => !REF_SEGMENT_PATTERN.test(part))) {
    fail(code, stage, `${label} 含绝对路径、反斜杠或非法段`);
  }
  return text;
}
/** 键序无关的稳定序列化（与 p08-config 同算法），用于摘要计算。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256Text(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** 符号链接防护（与 p07-accept 相同语义；macOS /tmp 软链先按真实前缀解析）。 */
function noLinks(path: string, code: P08IdentityFailureCode, stage: P08IdentityFailureStage): void {
  const temp = resolve(tmpdir());
  let current = resolve(path);
  if (current.startsWith(temp + sep)) current = realpathSync(temp) + current.slice(temp.length);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(code, stage, `路径穿越符号链接被拒绝：${current}`);
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}

/* ------------------------------------------------------------------ *
 * 1. 前置交付基线记录
 * ------------------------------------------------------------------ */

export type P08PrerequisiteBaselineRecord = {
  readonly feature: string;
  readonly commit: string;
  readonly delivered: boolean;
  readonly interfacesSatisfied: boolean;
  readonly deliveryEvidence: readonly string[];
  readonly publicInterfaces: readonly string[];
};
export type P08PrerequisiteBaselines = {
  readonly schemaVersion: typeof P08_PREREQUISITE_BASELINE_SCHEMA_VERSION;
  readonly kind: typeof P08_PREREQUISITE_BASELINE_KIND;
  readonly approvedBy: string;
  readonly features: readonly P08PrerequisiteBaselineRecord[];
};

const BASELINE_KEYS = ['schemaVersion', 'kind', 'approvedBy', 'features'] as const;
const BASELINE_FEATURE_KEYS = ['feature', 'commit', 'delivered', 'interfacesSatisfied', 'deliveryEvidence', 'publicInterfaces'] as const;

/**
 * 校验负责人提供的前置交付基线文件：结构（精确键、无凭据字段）、feature 集
 * 合（P08-1～P08-3 逐项存在、不重复、无未知项）、证据引用路径安全。commit
 * 40 位格式、交付布尔、接口声明与祖先关系在评估阶段形成 blocked/not_run。
 */
export function validateP08PrerequisiteBaselines(value: unknown): P08PrerequisiteBaselines {
  const raw = object(value, 'p08_baseline_structure_invalid', 'baselines', '前置交付基线');
  exactKeys(raw, BASELINE_KEYS, 'p08_baseline_structure_invalid', 'baselines', '前置交付基线');
  if (raw.schemaVersion !== P08_PREREQUISITE_BASELINE_SCHEMA_VERSION || raw.kind !== P08_PREREQUISITE_BASELINE_KIND) {
    fail('p08_baseline_structure_invalid', 'baselines', '基线版本或 kind 不匹配');
  }
  const approvedBy = nonEmptyString(raw.approvedBy, 'p08_baseline_structure_invalid', 'baselines', 'approvedBy');
  if (!SAFE_ID_PATTERN.test(approvedBy)) fail('p08_baseline_structure_invalid', 'baselines', 'approvedBy 必须是安全标识符');
  if (!Array.isArray(raw.features) || raw.features.length !== P08_PREREQUISITE_FEATURES.length) {
    fail('p08_baseline_structure_invalid', 'baselines', 'features 必须逐项列出 P08-1～P08-3');
  }
  const seen = new Set<string>();
  const features = (raw.features as unknown[]).map(entry => {
    const record = object(entry, 'p08_baseline_structure_invalid', 'baselines', 'features[]');
    exactKeys(record, BASELINE_FEATURE_KEYS, 'p08_baseline_structure_invalid', 'baselines', 'features[]');
    const feature = nonEmptyString(record.feature, 'p08_baseline_structure_invalid', 'baselines', 'features[].feature', 32);
    if (!P08_PREREQUISITE_FEATURES.includes(feature as (typeof P08_PREREQUISITE_FEATURES)[number])) {
      fail('p08_baseline_structure_invalid', 'baselines', `未知前置 Feature：${feature}`);
    }
    if (seen.has(feature)) fail('p08_baseline_structure_invalid', 'baselines', `前置 Feature 重复：${feature}`);
    seen.add(feature);
    return {
      feature,
      commit: nonEmptyString(record.commit, 'p08_baseline_structure_invalid', 'baselines', `features[${feature}].commit`, 64),
      delivered: boolean(record.delivered, 'p08_baseline_structure_invalid', 'baselines', `features[${feature}].delivered`),
      interfacesSatisfied: boolean(record.interfacesSatisfied, 'p08_baseline_structure_invalid', 'baselines', `features[${feature}].interfacesSatisfied`),
      deliveryEvidence: stringArray(record.deliveryEvidence, 'p08_baseline_structure_invalid', 'baselines', `features[${feature}].deliveryEvidence`)
        .map(item => safeReference(item, 'p08_baseline_structure_invalid', 'baselines', `features[${feature}].deliveryEvidence[]`)),
      publicInterfaces: stringArray(record.publicInterfaces, 'p08_baseline_structure_invalid', 'baselines', `features[${feature}].publicInterfaces`),
    };
  });
  for (const feature of P08_PREREQUISITE_FEATURES) {
    if (!seen.has(feature)) fail('p08_baseline_structure_invalid', 'baselines', `缺少前置 Feature：${feature}`);
  }
  return { schemaVersion: P08_PREREQUISITE_BASELINE_SCHEMA_VERSION, kind: P08_PREREQUISITE_BASELINE_KIND, approvedBy, features };
}

/** 受控祖先检查（由入口用 git merge-base --is-ancestor 实现）；抛错按不成立处理。 */
export type P08AncestryChecker = (commit: string, headCommit: string) => boolean;

/**
 * 在受测 HEAD 下评估基线：commit 格式非法或祖先检查失败按不成立处理，交给
 * evaluateP08Prerequisites 形成逐项 blocker；任何缺失或不匹配都阻止验收通过。
 */
export function p08EvaluatePrerequisiteBaselines(
  baselines: P08PrerequisiteBaselines,
  headCommit: string,
  isAncestor: P08AncestryChecker,
): P08PrerequisiteEvaluation {
  if (typeof headCommit !== 'string' || !GIT_SHA_PATTERN.test(headCommit)) {
    fail('p08_run_identity_invalid', 'inputs', '受测 HEAD 必须是 40 位小写十六进制 SHA');
  }
  try {
    return evaluateP08Prerequisites(baselines.features.map(record => {
      let ancestorOfHead = false;
      if (GIT_SHA_PATTERN.test(record.commit)) {
        try { ancestorOfHead = isAncestor(record.commit, headCommit) === true; } catch { ancestorOfHead = false; }
      }
      return { ...record, ancestorOfHead };
    }));
  } catch (error) { mapConfigError(error, 'p08_baseline_structure_invalid', 'baselines'); }
}

const BLOCKER_CODE_BY_KIND: Readonly<Record<P08PrerequisiteBlockerCode, P08IdentityFailureCode>> = {
  not_delivered: 'p08_baseline_not_delivered',
  interfaces_unsatisfied: 'p08_baseline_interfaces_unsatisfied',
  invalid_commit: 'p08_baseline_invalid_commit',
  evidence_missing: 'p08_baseline_evidence_missing',
  interfaces_missing: 'p08_baseline_interfaces_missing',
  not_ancestor: 'p08_baseline_not_ancestor',
};

/** 前置评估 blocker → 结构化身份失败（供脱敏诊断与报告使用）。 */
export function p08IdentityFailuresFromPrerequisites(evaluation: P08PrerequisiteEvaluation): P08IdentityFailure[] {
  return evaluation.blockers.map(blocker => ({
    code: BLOCKER_CODE_BY_KIND[blocker.code],
    stage: 'baselines' as const,
    detail: `${blocker.feature}: ${blocker.detail}`,
  }));
}

/* ------------------------------------------------------------------ *
 * 2. 受测源码枚举、不可变输入摘要与漂移
 * ------------------------------------------------------------------ */

function sourceFiles(root: string, directory: string): string[] {
  noLinks(join(root, directory), 'p08_inputs_invalid', 'inputs');
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) fail('p08_inputs_invalid', 'inputs', `源码目录含符号链接：${directory}/${entry.name}`);
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(root, file) : entry.isFile() ? [file] : fail('p08_inputs_invalid', 'inputs', `源码目录含非法条目：${file}`);
  });
}

/** 受测源码文件枚举（配置/锁、三包源码、脚本、测试与冻结验收契约）。 */
export function collectP08TestedSourceFiles(root: string): string[] {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('p08_inputs_invalid', 'inputs', '仓库根必须是绝对路径');
  noLinks(root, 'p08_inputs_invalid', 'inputs');
  const files = [
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.ts',
    ...['core', 'host', 'cli'].flatMap(pkg => [`packages/${pkg}/package.json`, `packages/${pkg}/tsconfig.json`, ...sourceFiles(root, `packages/${pkg}/src`)]),
    ...['scripts', 'test', 'acceptance'].flatMap(dir => sourceFiles(root, dir)),
  ];
  return [...new Set(files)].sort();
}

export type P08FileHash = { readonly file: string; readonly sha256: string };

/** 计算受测源码文件的内容摘要；越界路径、符号链接或缺失文件拒绝。 */
export function hashP08SourceInputs(root: string, files: readonly string[]): P08FileHash[] {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('p08_inputs_invalid', 'inputs', '仓库根必须是绝对路径');
  if (!Array.isArray(files) || files.length === 0) fail('p08_inputs_invalid', 'inputs', '文件清单必须是非空数组');
  const seen = new Set<string>();
  return files.map(file => {
    if (typeof file !== 'string' || file.length === 0 || file.includes('\\') || file.startsWith('/') || isAbsolute(file)
      || file.split('/').some(part => part === '' || part === '.' || part === '..')) {
      fail('p08_inputs_invalid', 'inputs', `非法源码路径：${String(file)}`);
    }
    if (seen.has(file)) fail('p08_inputs_invalid', 'inputs', `源码路径重复：${file}`);
    seen.add(file);
    const path = join(root, file);
    noLinks(path, 'p08_inputs_invalid', 'inputs');
    if (!existsSync(path) || !lstatSync(path).isFile()) fail('p08_inputs_invalid', 'inputs', `源码文件缺失：${file}`);
    return { file, sha256: sha256Text(readFileSync(path, 'utf8')) };
  });
}

export type P08RunInputsMaterial = {
  readonly runId: string;
  readonly testedCommit: string;
  /** 已验证配置对象的内容摘要（含工具链、预算、live/Nezha 政策）。 */
  readonly configDigest: string;
  /** 冻结检查清单内容摘要（digestP08Checklist）。 */
  readonly checklistDigest: string;
  /** 已验证前置交付基线（结构化对象参与摘要，内容变化即漂移）。 */
  readonly prerequisites: unknown;
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
  /** 适用测试范围（F-003 交付；此处只绑定内容摘要，不选择范围）。 */
  readonly testScope: readonly P08FileHash[];
  /** 外部报告引用（路径与内容摘要；内容变化即漂移）。 */
  readonly externalReports: readonly P08ExternalEvidenceReference[];
};

/** P08 运行输入摘要：材料任意部分变化（含外部报告内容）都改变摘要。 */
export function digestP08RunInputs(material: P08RunInputsMaterial): string {
  const raw = object(material, 'p08_run_identity_invalid', 'inputs', '输入材料');
  exactKeys(raw, ['runId', 'testedCommit', 'configDigest', 'checklistDigest', 'prerequisites', 'toolchain', 'testScope', 'externalReports'],
    'p08_run_identity_invalid', 'inputs', '输入材料');
  return sha256Text(canonicalJson({
    schemaVersion: 1,
    kind: 'shiploop.p08.run-inputs:v1',
    runId: material.runId,
    testedCommit: material.testedCommit,
    configDigest: material.configDigest,
    checklistDigest: material.checklistDigest,
    prerequisites: material.prerequisites,
    toolchain: material.toolchain,
    testScope: material.testScope,
    externalReports: material.externalReports,
  }));
}

/** 由输入材料构建并验证 P08 运行身份（复用 F-001 的 runIdentity 校验）。 */
export function buildP08RunIdentity(material: P08RunInputsMaterial): P08RunIdentity {
  try {
    return validateP08RunIdentity({
      runId: material.runId,
      testedCommit: material.testedCommit,
      inputsDigest: digestP08RunInputs(material),
      toolchain: material.toolchain,
    });
  } catch (error) { mapConfigError(error, 'p08_run_identity_invalid', 'inputs'); }
}

export type P08SourceBaseline = {
  readonly headCommit: string;
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
  readonly fileHashes: readonly P08FileHash[];
};
export type P08SourceObservation = P08SourceBaseline & {
  /** `git status --porcelain --untracked-files=all` 的原始行。 */
  readonly statusEntries: readonly string[];
  readonly repositoryRoot: string;
  /** 本运行自有输出目录（绝对路径）；其中的未跟踪条目不算漂移。 */
  readonly ownedUntrackedRoots: readonly string[];
};
export type P08InputDriftReport = { readonly drifted: boolean; readonly reasons: readonly string[] };

/** 输入漂移检测（纯比较）：HEAD、工具链、跟踪/未跟踪改动、文件集合与内容哈希。 */
export function p08DetectInputDrift(baseline: P08SourceBaseline, observed: P08SourceObservation): P08InputDriftReport {
  const reasons: string[] = [];
  if (observed.headCommit !== baseline.headCommit) reasons.push('head_commit_changed');
  if (observed.toolchain.node !== baseline.toolchain.node || observed.toolchain.npm !== baseline.toolchain.npm
    || observed.toolchain.platform !== baseline.toolchain.platform) reasons.push('toolchain_drift');
  const baselineFiles = new Map(baseline.fileHashes.map(entry => [entry.file, entry.sha256]));
  const observedFiles = new Set<string>();
  for (const entry of observed.fileHashes) {
    observedFiles.add(entry.file);
    if (!baselineFiles.has(entry.file)) reasons.push(`input_file_set_changed:+${entry.file}`);
    else if (baselineFiles.get(entry.file) !== entry.sha256) reasons.push(`input_hash_changed:${entry.file}`);
  }
  for (const file of baselineFiles.keys()) if (!observedFiles.has(file)) reasons.push(`input_file_set_changed:-${file}`);
  const owned = observed.ownedUntrackedRoots.map(root => resolve(root));
  for (const raw of observed.statusEntries) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (!raw.startsWith('?? ')) { reasons.push(`tracked_source_changed:${raw.slice(3).trim() || raw.slice(0, 2)}`); continue; }
    let entry = raw.slice(3);
    if (entry.startsWith('"') && entry.endsWith('"')) { try { entry = JSON.parse(entry) as string; } catch { /* 保留原文 */ } }
    const path = resolve(observed.repositoryRoot, entry);
    if (!owned.some(directory => path === directory || path.startsWith(directory + sep))) reasons.push(`untracked_source_changed:${entry}`);
  }
  if (reasons.length > MAX_DRIFT_REASONS) {
    return { drifted: true, reasons: [...reasons.slice(0, MAX_DRIFT_REASONS), 'input_drift_reasons_truncated'] };
  }
  return { drifted: reasons.length > 0, reasons };
}

/* ------------------------------------------------------------------ *
 * 3. 运行目录一次性预留
 * ------------------------------------------------------------------ */

export type P08RunDirectoryReservation =
  | { readonly action: 'created'; readonly runId: string; readonly workDir: string }
  | { readonly action: 'rejected'; readonly runId: string; readonly reason: 'run-directory-exists'; readonly existingDir: string };

/** 运行目录 create-once 预留：已存在的 runId 目录不可覆盖，旧运行证据保留。 */
export function reserveP08RunDirectory(reportRoot: string, runId: string): P08RunDirectoryReservation {
  if (typeof reportRoot !== 'string' || !isAbsolute(reportRoot)) fail('p08_run_directory_invalid', 'run-directory', '报告根必须是绝对路径');
  if (typeof runId !== 'string' || !SAFE_ID_PATTERN.test(runId)) fail('p08_run_directory_invalid', 'run-directory', 'runId 必须是安全标识符');
  noLinks(reportRoot, 'p08_run_directory_invalid', 'run-directory');
  const runsRoot = join(reportRoot, 'runs');
  const workDir = join(runsRoot, runId);
  let disposition: ReturnType<typeof p08RunDirectoryDisposition>;
  try { disposition = p08RunDirectoryDisposition({ runId, directoryExists: existsSync(workDir) }); }
  catch (error) { mapConfigError(error, 'p08_run_directory_invalid', 'run-directory'); }
  if (disposition.action === 'fail') {
    return { action: 'rejected', runId, reason: 'run-directory-exists', existingDir: workDir };
  }
  try {
    mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
    noLinks(runsRoot, 'p08_run_directory_invalid', 'run-directory');
    mkdirSync(workDir, { mode: 0o700 });
  } catch (error) {
    if (existsSync(workDir)) return { action: 'rejected', runId, reason: 'run-directory-exists', existingDir: workDir };
    fail('p08_run_directory_invalid', 'run-directory', `运行目录创建失败：${String(error)}`);
  }
  return { action: 'created', runId, workDir };
}

/* ------------------------------------------------------------------ *
 * 4. 外部证据引用与导入（只读）
 * ------------------------------------------------------------------ */

export type P08ExternalEvidenceReference = {
  readonly kind: P08ExternalEvidenceKind;
  readonly path: string;
  readonly digest: string;
};

const REFERENCE_KEYS = ['kind', 'path', 'digest'] as const;

/**
 * 外部证据引用注册校验：kind 已知、路径为证据根内相对 POSIX 引用、摘要为
 * sha256；同一路径或同一 kind 重复登记拒绝（两类 live 互不替代，单类单份）。
 */
export function validateP08ExternalEvidenceReferences(refs: readonly unknown[]): P08ExternalEvidenceReference[] {
  if (!Array.isArray(refs)) fail('p08_external_reference_invalid', 'external-evidence', '引用清单必须是数组');
  const references: P08ExternalEvidenceReference[] = [];
  const paths = new Set<string>();
  const kinds = new Set<string>();
  for (const entry of refs) {
    const raw = object(entry, 'p08_external_reference_invalid', 'external-evidence', '引用');
    exactKeys(raw, REFERENCE_KEYS, 'p08_external_reference_invalid', 'external-evidence', '引用');
    const kind = nonEmptyString(raw.kind, 'p08_external_reference_invalid', 'external-evidence', '引用.kind', 32);
    if (!P08_EXTERNAL_EVIDENCE_KINDS.includes(kind as P08ExternalEvidenceKind)) {
      fail('p08_external_reference_invalid', 'external-evidence', `未知外部证据类别：${kind}`);
    }
    const path = safeReference(raw.path, 'p08_external_reference_invalid', 'external-evidence', '引用.path');
    const digest = nonEmptyString(raw.digest, 'p08_external_reference_invalid', 'external-evidence', '引用.digest', 64);
    if (!SHA256_PATTERN.test(digest)) fail('p08_external_reference_invalid', 'external-evidence', '引用.digest 必须是 64 位摘要');
    if (paths.has(path)) fail('p08_external_reference_invalid', 'external-evidence', `引用路径重复：${path}`);
    if (kinds.has(kind)) fail('p08_external_reference_invalid', 'external-evidence', `引用类别重复：${kind}`);
    paths.add(path); kinds.add(kind);
    references.push({ kind: kind as P08ExternalEvidenceKind, path, digest });
  }
  return references;
}

/* ---- 人工门禁记录 ---- */

const MANUAL_GATE_KEYS = ['schemaVersion', 'kind', 'identity', 'owner', 'status', 'confirmedAtUtcMs', 'notes'] as const;
const MANUAL_GATE_IDENTITY_KEYS = ['runId', 'testedCommit', 'inputsDigest'] as const;

export type P08ManualGateRecord = {
  readonly schemaVersion: typeof P08_MANUAL_GATE_SCHEMA_VERSION;
  readonly kind: typeof P08_MANUAL_GATE_RECORD_KIND;
  readonly identity: { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string };
  readonly owner: string;
  readonly status: P08ManualGateStatus;
  readonly confirmedAtUtcMs: number | null;
  readonly notes?: string;
};

/** 人工门禁记录：身份必须与当前 P08 运行完全一致；状态只允许 pending/confirmed/rejected。 */
export function validateP08ManualGateRecord(value: unknown, expected: P08RunIdentity): P08ManualGateRecord {
  const raw = object(value, 'p08_manual_gate_status_invalid', 'external-evidence', '人工门禁记录');
  exactKeys(raw, MANUAL_GATE_KEYS, 'p08_manual_gate_status_invalid', 'external-evidence', '人工门禁记录');
  if (raw.schemaVersion !== P08_MANUAL_GATE_SCHEMA_VERSION || raw.kind !== P08_MANUAL_GATE_RECORD_KIND) {
    fail('p08_manual_gate_status_invalid', 'external-evidence', '人工门禁版本或 kind 不匹配');
  }
  const identity = object(raw.identity, 'p08_manual_gate_identity_mismatch', 'external-evidence', '人工门禁.identity');
  exactKeys(identity, MANUAL_GATE_IDENTITY_KEYS, 'p08_manual_gate_identity_mismatch', 'external-evidence', '人工门禁.identity');
  if (identity.runId !== expected.runId || identity.testedCommit !== expected.testedCommit || identity.inputsDigest !== expected.inputsDigest) {
    fail('p08_manual_gate_identity_mismatch', 'external-evidence', '人工门禁身份与当前 P08 运行不一致');
  }
  const owner = nonEmptyString(raw.owner, 'p08_manual_gate_status_invalid', 'external-evidence', '人工门禁.owner', 128);
  if (!SAFE_ID_PATTERN.test(owner)) fail('p08_manual_gate_status_invalid', 'external-evidence', '人工门禁.owner 必须是安全标识符');
  if (!P08_MANUAL_GATE_STATUSES.includes(raw.status as P08ManualGateStatus)) {
    fail('p08_manual_gate_status_invalid', 'external-evidence', `人工门禁状态非法：${String(raw.status)}`);
  }
  const status = raw.status as P08ManualGateStatus;
  let confirmedAtUtcMs: number | null = null;
  if (raw.confirmedAtUtcMs !== null) {
    if (typeof raw.confirmedAtUtcMs !== 'number' || !Number.isSafeInteger(raw.confirmedAtUtcMs) || raw.confirmedAtUtcMs < 0) {
      fail('p08_manual_gate_status_invalid', 'external-evidence', 'confirmedAtUtcMs 必须是非负整数或 null');
    }
    confirmedAtUtcMs = raw.confirmedAtUtcMs;
  }
  if (status === 'confirmed' && confirmedAtUtcMs === null) {
    fail('p08_manual_gate_status_invalid', 'external-evidence', 'confirmed 状态必须提供确认时间');
  }
  const notes = raw.notes === undefined ? undefined : nonEmptyString(raw.notes, 'p08_manual_gate_status_invalid', 'external-evidence', '人工门禁.notes', 2048);
  return { schemaVersion: P08_MANUAL_GATE_SCHEMA_VERSION, kind: P08_MANUAL_GATE_RECORD_KIND,
    identity: { runId: identity.runId as string, testedCommit: identity.testedCommit as string, inputsDigest: identity.inputsDigest as string },
    owner, status, confirmedAtUtcMs, ...(notes === undefined ? {} : { notes }) };
}

/* ---- 安装产物清单 ---- */

const INSTALL_MANIFEST_KEYS = ['schemaVersion', 'kind', 'phase', 'feature', 'distributionMode', 'published', 'identity',
  'packages', 'toolchain', 'compatibility', 'artifacts', 'checks', 'layers', 'phaseIntegration', 'releaseBlockers', 'knownGaps'] as const;
const INSTALL_IDENTITY_KEYS = ['gitCommit', 'branch', 'gitCommitScope', 'codeBaseSubject'] as const;
const INSTALL_TOOLCHAIN_KEYS = ['node', 'npm', 'platform', 'packageManager'] as const;
const INSTALL_ARTIFACT_KEYS = ['status', 'reason', 'items'] as const;
const INSTALL_ARTIFACT_ITEM_KEYS = ['name', 'version', 'filename', 'sha256'] as const;
const INSTALL_CHECK_KEYS = ['id', 'layer', 'command', 'status', 'exitCode', 'evidence', 'reason'] as const;

export type P08InstallManifestSummary = {
  readonly commit: string;
  readonly branch: string;
  readonly published: boolean;
  readonly distributionMode: string;
  readonly artifactsStatus: string;
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
};

/**
 * 安装产物（P08-1 发布清单）身份校验：精确键、冻结 kind/版本、local-pack-only
 * 且未发布（npm 发布后置）、受测 commit 40 位、工具链与冻结工具链一致、检查
 * 与制品状态只允许三态。未知字段拒绝。
 */
export function validateP08InstallManifest(value: unknown): P08InstallManifestSummary {
  const structure = 'p08_external_evidence_structure_invalid' as const;
  const stage = 'external-evidence' as const;
  const raw = object(value, structure, stage, '安装产物清单');
  exactKeys(raw, INSTALL_MANIFEST_KEYS, structure, stage, '安装产物清单');
  if (raw.schemaVersion !== P08_INSTALL_MANIFEST_SCHEMA_VERSION || raw.kind !== P08_INSTALL_MANIFEST_KIND) {
    fail(structure, stage, '安装产物清单版本或 kind 不匹配');
  }
  if (raw.phase !== 'P08' || raw.feature !== 'P08-1') fail(structure, stage, '安装产物清单必须来自 P08-1');
  if (raw.distributionMode !== 'local-pack-only') fail(structure, stage, '一期只允许本地 pack 分发');
  if (raw.published !== false) fail(structure, stage, '一期不得声明已发布（npm 发布后置）');
  const identity = object(raw.identity, structure, stage, '安装产物.identity');
  exactKeys(identity, INSTALL_IDENTITY_KEYS, structure, stage, '安装产物.identity');
  const commit = nonEmptyString(identity.gitCommit, structure, stage, '安装产物.identity.gitCommit', 40);
  if (!GIT_SHA_PATTERN.test(commit)) fail(structure, stage, '安装产物.identity.gitCommit 必须是 40 位 SHA');
  const branch = nonEmptyString(identity.branch, structure, stage, '安装产物.identity.branch', 256);
  nonEmptyString(identity.gitCommitScope, structure, stage, '安装产物.identity.gitCommitScope', 2048);
  nonEmptyString(identity.codeBaseSubject, structure, stage, '安装产物.identity.codeBaseSubject', 2048);
  const toolchain = object(raw.toolchain, structure, stage, '安装产物.toolchain');
  exactKeys(toolchain, INSTALL_TOOLCHAIN_KEYS, structure, stage, '安装产物.toolchain');
  if (toolchain.node !== P08_TOOLCHAIN.node || toolchain.npm !== P08_TOOLCHAIN.npm
    || toolchain.platform !== P08_TOOLCHAIN.platform || toolchain.packageManager !== P08_TOOLCHAIN.packageManager) {
    fail(structure, stage, '安装产物工具链与冻结工具链不一致');
  }
  if (!Array.isArray(raw.packages) || raw.packages.length === 0) fail(structure, stage, '安装产物 packages 必须是非空数组');
  for (const entry of raw.packages) {
    const pkg = object(entry, structure, stage, '安装产物.packages[]');
    exactKeys(pkg, ['name', 'version', 'private'], structure, stage, '安装产物.packages[]');
    nonEmptyString(pkg.name, structure, stage, '安装产物.packages[].name', 256);
    nonEmptyString(pkg.version, structure, stage, '安装产物.packages[].version', 64);
    boolean(pkg.private, structure, stage, '安装产物.packages[].private');
  }
  const compatibility = object(raw.compatibility, structure, stage, '安装产物.compatibility');
  exactKeys(compatibility, ['hostProtocol', 'databaseSchema'], structure, stage, '安装产物.compatibility');
  object(compatibility.hostProtocol, structure, stage, '安装产物.compatibility.hostProtocol');
  object(compatibility.databaseSchema, structure, stage, '安装产物.compatibility.databaseSchema');
  const artifacts = object(raw.artifacts, structure, stage, '安装产物.artifacts');
  exactKeys(artifacts, INSTALL_ARTIFACT_KEYS, structure, stage, '安装产物.artifacts');
  if (!P08_INSTALL_STATUS_VALUES.includes(artifacts.status as (typeof P08_INSTALL_STATUS_VALUES)[number])) {
    fail(structure, stage, '安装产物 artifacts.status 只允许 pass/fail/not_run 三态');
  }
  nonEmptyString(artifacts.reason, structure, stage, '安装产物.artifacts.reason', 2048);
  if (!Array.isArray(artifacts.items) || artifacts.items.length === 0) fail(structure, stage, '安装产物 artifacts.items 必须是非空数组');
  for (const entry of artifacts.items) {
    const item = object(entry, structure, stage, '安装产物.artifacts.items[]');
    exactKeys(item, INSTALL_ARTIFACT_ITEM_KEYS, structure, stage, '安装产物.artifacts.items[]');
    nonEmptyString(item.name, structure, stage, '安装产物.artifacts.items[].name', 256);
    nonEmptyString(item.version, structure, stage, '安装产物.artifacts.items[].version', 64);
    nonEmptyString(item.filename, structure, stage, '安装产物.artifacts.items[].filename', 256);
    if (item.sha256 !== null && (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256))) {
      fail(structure, stage, '安装产物制品摘要必须是 sha256 或 null');
    }
  }
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) fail(structure, stage, '安装产物 checks 必须是非空数组');
  for (const entry of raw.checks) {
    const check = object(entry, structure, stage, '安装产物.checks[]');
    exactKeys(check, INSTALL_CHECK_KEYS, structure, stage, '安装产物.checks[]');
    nonEmptyString(check.id, structure, stage, '安装产物.checks[].id', 256);
    nonEmptyString(check.layer, structure, stage, '安装产物.checks[].layer', 128);
    // 未运行的门禁允许 command/evidence 为 null；已执行的检查必须可复现命令与相对证据引用。
    if (check.command === null) {
      if (check.status !== 'not_run') fail(structure, stage, '安装产物 checks[].command 仅在 not_run 时可为 null');
    } else {
      const command = stringArray(check.command, structure, stage, '安装产物.checks[].command', 1024);
      if (command.length === 0) fail(structure, stage, '安装产物.checks[].command 不能为空');
    }
    if (!P08_INSTALL_STATUS_VALUES.includes(check.status as (typeof P08_INSTALL_STATUS_VALUES)[number])) {
      fail(structure, stage, '安装产物 checks[].status 只允许 pass/fail/not_run 三态');
    }
    if (check.exitCode !== null && (typeof check.exitCode !== 'number' || !Number.isSafeInteger(check.exitCode))) {
      fail(structure, stage, '安装产物 checks[].exitCode 必须是整数或 null');
    }
    if (check.evidence !== null) {
      const evidence = nonEmptyString(check.evidence, structure, stage, '安装产物.checks[].evidence', 512);
      if (ABSOLUTE_PATH_PATTERN.test(evidence) || evidence.includes('\\')) fail(structure, stage, '安装产物 checks[].evidence 必须是相对引用');
    }
    if (check.reason !== null && typeof check.reason !== 'string') fail(structure, stage, '安装产物 checks[].reason 必须是字符串或 null');
  }
  const layers = object(raw.layers, structure, stage, '安装产物.layers');
  for (const value of Object.values(layers)) {
    if (!P08_INSTALL_LAYER_STATUS_VALUES.includes(value as (typeof P08_INSTALL_LAYER_STATUS_VALUES)[number])) {
      fail(structure, stage, '安装产物 layers 值非法');
    }
  }
  const phaseIntegration = object(raw.phaseIntegration, structure, stage, '安装产物.phaseIntegration');
  exactKeys(phaseIntegration, ['status', 'items'], structure, stage, '安装产物.phaseIntegration');
  if (!P08_INSTALL_STATUS_VALUES.includes(phaseIntegration.status as (typeof P08_INSTALL_STATUS_VALUES)[number])) {
    fail(structure, stage, '安装产物 phaseIntegration.status 只允许三态');
  }
  if (!Array.isArray(phaseIntegration.items)) fail(structure, stage, '安装产物 phaseIntegration.items 必须是数组');
  for (const entry of phaseIntegration.items) {
    const item = object(entry, structure, stage, '安装产物.phaseIntegration.items[]');
    exactKeys(item, ['id', 'status'], structure, stage, '安装产物.phaseIntegration.items[]');
    nonEmptyString(item.id, structure, stage, '安装产物.phaseIntegration.items[].id', 256);
    if (!P08_INSTALL_STATUS_VALUES.includes(item.status as (typeof P08_INSTALL_STATUS_VALUES)[number])) {
      fail(structure, stage, '安装产物 phaseIntegration.items[].status 只允许三态');
    }
  }
  if (!Array.isArray(raw.releaseBlockers)) fail(structure, stage, '安装产物 releaseBlockers 必须是数组');
  for (const entry of raw.releaseBlockers) {
    const blocker = object(entry, structure, stage, '安装产物.releaseBlockers[]');
    exactKeys(blocker, ['id', 'status', 'note'], structure, stage, '安装产物.releaseBlockers[]');
    nonEmptyString(blocker.id, structure, stage, '安装产物.releaseBlockers[].id', 256);
    if (blocker.status !== 'pending' && blocker.status !== 'resolved' && blocker.status !== 'rejected') {
      fail(structure, stage, '安装产物.releaseBlockers[].status 非法');
    }
    nonEmptyString(blocker.note, structure, stage, '安装产物.releaseBlockers[].note', 2048);
  }
  stringArray(raw.knownGaps, structure, stage, '安装产物.knownGaps', 2048);
  return { commit, branch, published: false, distributionMode: raw.distributionMode as string,
    artifactsStatus: artifacts.status as string,
    toolchain: { node: toolchain.node as string, npm: toolchain.npm as string, platform: toolchain.platform as string } };
}

/* ---- 存量 Live 封套校验器（延迟加载：Node 运行需要仓库 loader 钩子） ---- */

let brownfieldTools: Promise<typeof import('../../packages/core/src/ports/brownfield-evidence.ts')> | undefined;
function loadBrownfieldTools(): Promise<typeof import('../../packages/core/src/ports/brownfield-evidence.ts')> {
  if (!brownfieldTools) {
    if (!process.env.VITEST) register(new URL('../../test/helpers/node-ts-loader/hooks.mjs', import.meta.url), import.meta.url);
    brownfieldTools = import('../../packages/core/src/ports/brownfield-evidence.ts');
  }
  return brownfieldTools;
}

/* ---- 导入（只读核验） ---- */

export type P08ExternalEvidenceSummary = {
  readonly kind: P08ExternalEvidenceKind;
  readonly path: string;
  readonly digest: string;
  readonly reportKind: string;
  readonly schemaVersion: number;
  /** 记录声明的整体状态（todo-live 四态 / 封套 recorded / 安装产物 artifacts 三态 / 门禁三态）。 */
  readonly status: string;
  /** 记录绑定的受测 commit（须为当前受测 HEAD 的祖先）。 */
  readonly commits: readonly string[];
  /** 记录声明的运行标识（人工门禁即 P08 runId；外部报告为其自身运行 ID）。 */
  readonly runIds: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
};

export type P08ExternalEvidenceImportOptions = {
  readonly evidenceRoot: string;
  readonly reference: P08ExternalEvidenceReference;
  readonly runIdentity: P08RunIdentity;
  readonly isAncestor: P08AncestryChecker;
};

/**
 * 导入并核验一份外部证据（只读）：存在性、内容摘要、JSON 完整性、来源 kind
 * 与结构版本、按类别的结构校验、身份绑定与受测 HEAD 祖先关系（陈旧 commit 拒
 * 绝）。人工门禁身份必须与当前 P08 运行完全一致。全程不写任何被引用文件。
 */
export async function importP08ExternalEvidence(options: P08ExternalEvidenceImportOptions): Promise<P08ExternalEvidenceSummary> {
  const stage = 'external-evidence' as const;
  const { reference, runIdentity } = options;
  if (typeof options.evidenceRoot !== 'string' || !isAbsolute(options.evidenceRoot)) fail('p08_external_evidence_missing', stage, '证据根必须是绝对路径');
  const checked = validateP08ExternalEvidenceReferences([reference])[0];
  const path = join(options.evidenceRoot, checked.path);
  noLinks(path, 'p08_external_evidence_missing', stage);
  if (!existsSync(path) || !lstatSync(path).isFile()) fail('p08_external_evidence_missing', stage, `证据文件缺失：${checked.path}`);
  const content = readFileSync(path, 'utf8');
  if (sha256Text(content) !== checked.digest) fail('p08_external_evidence_digest_mismatch', stage, `证据内容摘要不匹配：${checked.path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch (error) { fail('p08_external_evidence_corrupt_json', stage, `证据不是有效 JSON：${checked.path}（${String(error)}）`); }
  const record = object(parsed, 'p08_external_evidence_structure_invalid', stage, '外部证据');
  const expectedKind = P08_EXTERNAL_EVIDENCE_REPORT_KINDS[checked.kind];
  if (record.kind !== expectedKind) fail('p08_external_evidence_kind_mismatch', stage, `证据来源不匹配：期望 ${expectedKind}，实际 ${String(record.kind)}`);
  const expectedSchema = P08_EXTERNAL_EVIDENCE_SCHEMA_VERSIONS[checked.kind];
  if (record.schemaVersion !== expectedSchema) fail('p08_external_evidence_schema_invalid', stage, `证据结构版本不匹配：期望 ${expectedSchema}，实际 ${String(record.schemaVersion)}`);

  const summary = await summarizeByKind(checked, record, runIdentity);
  if (checked.kind !== 'manual-gate') {
    for (const commit of summary.commits) {
      let ancestor = false;
      if (GIT_SHA_PATTERN.test(commit)) { try { ancestor = options.isAncestor(commit, runIdentity.testedCommit) === true; } catch { ancestor = false; } }
      if (!ancestor) fail('p08_external_evidence_stale_commit', stage, `证据 commit 非受测 HEAD 祖先（陈旧基线拒绝）：${commit}`);
    }
  }
  for (const runId of summary.runIds) {
    if (!SAFE_ID_PATTERN.test(runId)) fail('p08_external_evidence_structure_invalid', stage, `证据运行标识非法：${runId}`);
  }
  return summary;
}

async function summarizeByKind(reference: P08ExternalEvidenceReference, record: Record<string, unknown>, runIdentity: P08RunIdentity): Promise<P08ExternalEvidenceSummary> {
  const stage = 'external-evidence' as const;
  const base = { kind: reference.kind, path: reference.path, digest: reference.digest,
    reportKind: P08_EXTERNAL_EVIDENCE_REPORT_KINDS[reference.kind], schemaVersion: P08_EXTERNAL_EVIDENCE_SCHEMA_VERSIONS[reference.kind] };
  if (reference.kind === 'todo-live') {
    let report: ReturnType<typeof validateTodoLiveEvidenceReport>;
    try { report = validateTodoLiveEvidenceReport(record); } catch { fail('p08_external_evidence_structure_invalid', stage, 'Todo live 证据报告结构校验失败'); }
    return { ...base, status: report.status,
      commits: [report.code.headCommit, ...report.tasks.map(task => task.commitSha)].filter((commit): commit is string => commit !== null),
      runIds: [report.identity.runId].filter((runId): runId is string => runId !== null),
      detail: { statusReason: report.statusReason, requirementsVersion: report.identity.requirementsVersion,
        requirementsDigest: report.identity.requirementsDigest, deliveryStatus: report.delivery.status, taskCount: report.tasks.length } };
  }
  if (reference.kind === 'existing-live') {
    const tools = await loadBrownfieldTools();
    let envelope: ReturnType<typeof tools.validateBrownfieldEvidenceEnvelope>;
    try { envelope = tools.validateBrownfieldEvidenceEnvelope(record); } catch { fail('p08_external_evidence_structure_invalid', stage, '存量 live 证据封套结构校验失败'); }
    return { ...base, status: 'recorded',
      commits: [envelope.testCommit, envelope.currentCodeIdentity.headCommit].filter((commit): commit is string => commit !== null),
      runIds: [envelope.projectId],
      detail: { projectId: envelope.projectId, checks: envelope.summary.checks, newFailure: envelope.summary.newFailure,
        fixed: envelope.summary.fixed, notRun: envelope.summary.notRun, workingTree: envelope.workingTreePreservation.status,
        phaseScopes: envelope.phaseIntegration.length } };
  }
  if (reference.kind === 'install-manifest') {
    const manifest = validateP08InstallManifest(record);
    return { ...base, status: manifest.artifactsStatus, commits: [manifest.commit], runIds: [],
      detail: { feature: 'P08-1', branch: manifest.branch, published: manifest.published, distributionMode: manifest.distributionMode } };
  }
  const gate = validateP08ManualGateRecord(record, runIdentity);
  return { ...base, status: gate.status, commits: [gate.identity.testedCommit], runIds: [gate.identity.runId],
    detail: { owner: gate.owner, confirmedAtUtcMs: gate.confirmedAtUtcMs } };
}

/* ------------------------------------------------------------------ *
 * 5. 脱敏诊断
 * ------------------------------------------------------------------ */

const MACHINE_PATH_PATTERN = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`,;)\]]*)?|\/(?:private\/)?tmp\/[^\s"'`,;)\]]*|[A-Za-z]:[\\/][^\s"'`,;)\]]*|~\/[^\s"'`,;)\]]*/g;

/** 诊断文本脱敏：先替换调用方给出的敏感值，再按模式清除机器路径。 */
export function p08SanitizeDiagnosticText(text: string, sensitiveValues: readonly string[]): string {
  let value = typeof text === 'string' ? text : String(text);
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === 'string' && sensitive.length >= 4 && value.includes(sensitive)) value = value.split(sensitive).join('<redacted>');
  }
  return value.replace(MACHINE_PATH_PATTERN, '<machine-path>');
}

function sanitizeDiagnosticValue(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'string') return p08SanitizeDiagnosticText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map(entry => sanitizeDiagnosticValue(entry, sensitiveValues));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = CREDENTIAL_KEY.test(key) ? '<redacted>' : sanitizeDiagnosticValue(entry, sensitiveValues);
    }
    return result;
  }
  return value;
}

export type P08DiagnosticWriteResult = { readonly mode: 'run-directory' | 'diagnostics-directory'; readonly file: string };

/**
 * 身份校验失败诊断（脱敏、create-once、不覆盖）：
 * - 运行目录尚不存在时在本运行目录写 identity-diagnostic.json（一次性预留）；
 * - 运行目录已存在（重复 runId）时保留旧运行证据，改写入独立
 *   `<reportRoot>/diagnostics/<runId>/` 目录，文件名含时间戳与随机数，永不覆盖；
 * - 只写诊断本身，不触碰原报告、产品 SQLite 或 Feature/Phase 元数据。
 */
export function writeP08IdentityDiagnostics(options: {
  readonly reportRoot: string;
  readonly runId: string;
  readonly failures: readonly P08IdentityFailure[];
  readonly sensitiveValues: readonly string[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly nowMs?: number;
  readonly nonce?: string;
}): P08DiagnosticWriteResult {
  const stage = 'diagnostics' as const;
  if (typeof options.reportRoot !== 'string' || !isAbsolute(options.reportRoot)) fail('p08_diagnostic_invalid', stage, '报告根必须是绝对路径');
  if (typeof options.runId !== 'string' || !SAFE_ID_PATTERN.test(options.runId)) fail('p08_diagnostic_invalid', stage, 'runId 必须是安全标识符');
  if (!Array.isArray(options.failures) || options.failures.length === 0) fail('p08_diagnostic_invalid', stage, '诊断必须包含至少一条失败记录');
  noLinks(options.reportRoot, 'p08_diagnostic_invalid', stage);
  const recordedAtUtcMs = options.nowMs ?? Date.now();
  const body = {
    schemaVersion: P08_IDENTITY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: P08_IDENTITY_DIAGNOSTIC_KIND,
    runId: options.runId,
    phaseAccepted: false,
    recordedAtUtcMs,
    failures: options.failures.map(failure => ({
      code: failure.code, stage: failure.stage,
      ...(failure.detail === undefined ? {} : { detail: p08SanitizeDiagnosticText(failure.detail, options.sensitiveValues) }),
    })),
    ...(options.context === undefined ? {} : { context: sanitizeDiagnosticValue(options.context, options.sensitiveValues) }),
  };
  const write = (file: string): void => {
    try {
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      fail('p08_diagnostic_write_failed', stage, `诊断写入失败（不覆盖已有文件）：${String(error)}`);
    }
  };
  const workDir = join(options.reportRoot, 'runs', options.runId);
  if (!existsSync(workDir)) {
    const reservation = reserveP08RunDirectory(options.reportRoot, options.runId);
    if (reservation.action === 'rejected') {
      // 预留竞争失败按重复 runId 处理，保留旧运行并转独立诊断目录。
    } else {
      write(join(workDir, 'identity-diagnostic.json'));
      return { mode: 'run-directory', file: join(workDir, 'identity-diagnostic.json') };
    }
  }
  const diagnosticsDir = join(options.reportRoot, 'diagnostics', options.runId);
  mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
  noLinks(diagnosticsDir, 'p08_diagnostic_invalid', stage);
  const nonce = options.nonce ?? randomUUID().slice(0, 8);
  const file = join(diagnosticsDir, `${recordedAtUtcMs}-${nonce}.json`);
  write(file);
  return { mode: 'diagnostics-directory', file };
}
