/**
 * P08-1 F-004 最小发布 CI 配置检查器（fail-closed 工程脚本）。
 *
 * 输入：仓库内的 GitHub Actions 工作流（.github/workflows/*.yml）与根 package.json、
 * package-lock.json。检查（任一不满足即失败，不缩小检查范围放行）：
 * 1. workflow-file-set        仅允许 release-ci.yml 与摘要固定的兼容矩阵；多余工作流拒绝；
 * 2. workflow-parseable       受限 YAML 子集解析；锚点/别名/流式/多行标量/制表符等
 *                             未审语法直接失败（fail-closed，不猜测降级）；
 * 3. trigger-scope            触发范围只能是 push/pull_request 且 branches 恰为 main；
 *                             schedule、pull_request_target、通配分支等拒绝；
 * 4. permissions-minimal      顶层必须显式 contents: read；任何更大权限拒绝；
 * 5. runner-toolchain         单一 macOS runner（macos-15）、有界 timeout、
 *                             setup-node 固定发布基线；engines 可为已审兼容范围；
 * 6. required-step-order      必需步骤按固定顺序执行（npm ci -> verify:ci-config ->
 *                             verify -> pack:local -> verify:artifacts -> ci-summary）；
 *                             不允许 continue-on-error / if 条件跳过（任一步失败即非零）；
 * 7. command-allowlist        run 命令必须与审阅清单完全一致，不允许未审阅命令；
 * 8. no-publish-side-effects  禁止 npm publish、git push、gh PR/发布动作、${{ 表达式、
 *                             未审 env 注入与未登记的第三方 Action（verify 仅允许固定超时变量）；
 * 9. no-credential-injection  禁止 secrets./token/私钥/registry 凭据进入检查环境；
 * 10. action-refs-pinned      Action 引用必须固定为 vX.Y[.Z] 或 40 位 SHA；
 * 11. script-wiring           工作流引用的 npm 脚本与 node 脚本文件必须真实存在，
 *                             制品摘要报告必须接线为 if-no-files-found: error 上传；
 * 12. lockfile-present        package-lock.json 存在、可解析且与根清单身份一致。
 *
 * 结构化结果区分 passed/failed/not_run：实际 CI 运行结果、macOS 原生模块安装加载与
 * 独立目录安装属于 Phase/CI 集成证据，显式登记 not_run，不折算为通过。
 * 不变量：检查只读（除 CLI 写自身报告文件），不调用模型、npm publish 或任何远端操作；
 * 诊断不携带开发机绝对路径。仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除运行。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CI_WORKFLOW_FILE = '.github/workflows/release-ci.yml';
const WORKFLOW_DIRECTORY = '.github/workflows';
const ALLOWED_WORKFLOW_FILES = ['release-ci.yml'] as const;

/** 必需 run 步骤的固定顺序（审阅清单；变更需同步更新检查器与测试）。 */
export const REQUIRED_RUN_SEQUENCE = [
  'npm ci',
  'npm run verify:ci-config',
  'npm run verify',
  'npm run pack:local -- --output artifacts/local-pack',
  'npm run verify:artifacts',
  'node scripts/ci-summary.ts',
] as const;

const ALLOWED_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'] as const;
const PINNED_REF_PATTERN = /^v\d+\.\d+(?:\.\d+)?$|^[0-9a-f]{40}$/i;
const RUNNER_LABEL = 'macos-15';
const MAX_TIMEOUT_MINUTES = 360;
const NODE_VERSION_KEY = 'node-version';
/** 上传步骤必须保存的脱敏报告（制品摘要与配置检查证据）。 */
const REQUIRED_UPLOAD_PATHS = [
  'artifacts/local-pack/artifact-verification.json',
  'artifacts/local-pack/distribution-manifest.json',
  'artifacts/ci-config/ci-config-verification.json',
] as const;

export const CI_CHECK_IDS = [
  'workflow-file-set',
  'workflow-parseable',
  'trigger-scope',
  'permissions-minimal',
  'runner-toolchain',
  'required-step-order',
  'command-allowlist',
  'no-publish-side-effects',
  'no-credential-injection',
  'action-refs-pinned',
  'script-wiring',
  'lockfile-present',
] as const;
export type CiCheckId = (typeof CI_CHECK_IDS)[number];

export const CI_PHASE_INTEGRATION_IDS = [
  'real-ci-execution',
  'ci-native-module-loading',
  'ci-independent-install',
] as const;

export type CiCheckStatus = 'passed' | 'failed';

export interface CiConfigCheck {
  readonly id: CiCheckId;
  readonly title: string;
  readonly status: CiCheckStatus;
  readonly objects: readonly string[];
  /** 脱敏后的失败明细（相对路径标签，不含绝对路径）；passed 时为空。 */
  readonly problems: readonly string[];
}

export interface CiConfigNotRun {
  readonly id: string;
  readonly reason: string;
  readonly owner: 'phase-integration';
}

export interface CiCheckEnvironment {
  readonly nodeVersion: string;
  readonly npmVersion: string | null;
  readonly gitCommit: string | null;
  readonly platform: string;
}

export interface CiConfigVerificationReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.ci-config-verification';
  readonly generatedAt: string;
  /** 仅当全部检查 passed 时为 true；not_run 不折算。 */
  readonly passed: boolean;
  readonly environment: CiCheckEnvironment;
  readonly inputs: {
    readonly workflows: readonly { readonly label: string; readonly sha256: string }[];
    readonly manifest: { readonly label: string; readonly sha256: string } | null;
    readonly lockfile: { readonly label: string; readonly sha256: string } | null;
  };
  readonly checks: readonly CiConfigCheck[];
  readonly notRun: readonly CiConfigNotRun[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly notRun: number };
}

/** ---------- 受限 YAML 子集解析（未审语法一律抛错） ---------- */

interface SourceLine {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

const KEY_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|'[^']+'|"[^"]+"):(?: (.*))?$/;
const ITEM_KEY_PATTERN = KEY_PATTERN;

function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (index === 0 || raw[index - 1] === ' ' || raw[index - 1] === '\t')) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

/** 仅保留代码内容（去注释）的文本，用于副作用令牌扫描，避免注释误报。 */
function stripCommentsText(text: string): string {
  return text
    .split('\n')
    .map((line) => stripComment(line))
    .join('\n');
}

function prepareLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const rawLines = text.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = stripComment(rawLines[index] as string).replace(/\s+$/, '');
    if (raw.trim() === '') continue;
    if (/^%/.test(raw) || /^(---|\.\.\.)\s*$/.test(raw)) {
      throw new Error(`第 ${index + 1} 行：不支持文档指令/分隔符`);
    }
    const indentMatch = /^ */.exec(raw);
    const indent = indentMatch ? (indentMatch[0] as string).length : 0;
    const content = raw.slice(indent);
    if (content.startsWith('\t')) throw new Error(`第 ${index + 1} 行：不支持制表符缩进`);
    lines.push({ indent, text: content, number: index + 1 });
  }
  return lines;
}

function convertScalar(raw: string, lineNumber: number): string | number | boolean | null {
  const value = raw.trim();
  if (value === 'null' || value === '~' || value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  if (/^[&*!|>{[]/.test(value)) {
    throw new Error(`第 ${lineNumber} 行：未审阅的 YAML 语法（锚点/别名/流式/多行标量）：${value.slice(0, 20)}`);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * 解析受限 YAML 子集：块状映射/序列、带引号或不带引号的标量、行内注释。
 * 工作流文件有意保持在该子集内；任何超出子集的语法都会抛错（fail-closed）。
 */
export function parseYamlSubset(text: string): unknown {
  const lines = prepareLines(text);
  let cursor = 0;

  function parseNode(minIndent: number): unknown {
    if (cursor >= lines.length) return null;
    const line = lines[cursor] as SourceLine;
    if (line.indent < minIndent) return null;
    if (line.text === '-' || line.text.startsWith('- ')) return parseSequence(line.indent);
    return parseMapping(line.indent);
  }

  function parseMapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    while (cursor < lines.length) {
      const line = lines[cursor] as SourceLine;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`第 ${line.number} 行：意外的缩进`);
      if (line.text === '-' || line.text.startsWith('- ')) break;
      const match = KEY_PATTERN.exec(line.text);
      if (!match) throw new Error(`第 ${line.number} 行：无法解析的映射行：${line.text.slice(0, 30)}`);
      const key = convertScalarKey(match[1] ?? '', line.number);
      if (key in result) throw new Error(`第 ${line.number} 行：重复的键 ${String(key)}`);
      cursor += 1;
      const rest = match[2];
      if (rest === undefined || rest.trim() === '') {
        if (cursor < lines.length && (lines[cursor] as SourceLine).indent > indent) {
          result[key] = parseNode((lines[cursor] as SourceLine).indent);
        } else {
          result[key] = null;
        }
      } else {
        result[key] = convertScalar(rest, line.number);
      }
    }
    return result;
  }

  function parseSequence(indent: number): unknown[] {
    const result: unknown[] = [];
    while (cursor < lines.length) {
      const line = lines[cursor] as SourceLine;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`第 ${line.number} 行：意外的序列缩进`);
      if (line.text !== '-' && !line.text.startsWith('- ')) break;
      const rest = line.text === '-' ? '' : (line.text.slice(2) as string);
      cursor += 1;
      if (rest.trim() === '') {
        if (cursor < lines.length && (lines[cursor] as SourceLine).indent > indent) {
          result.push(parseNode((lines[cursor] as SourceLine).indent));
        } else {
          result.push(null);
        }
        continue;
      }
      const itemMatch = ITEM_KEY_PATTERN.exec(rest);
      if (itemMatch) {
        // 序列项内嵌映射：把余下内容视作更深缩进的映射首行。
        lines.splice(cursor, 0, { indent: indent + 2, text: rest, number: line.number });
        result.push(parseMapping(indent + 2));
      } else {
        result.push(convertScalar(rest, line.number));
      }
    }
    return result;
  }

  function convertScalarKey(raw: string, lineNumber: number): string {
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1);
    if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(raw)) return raw;
    throw new Error(`第 ${lineNumber} 行：无法解析的键：${raw}`);
  }

  const root = parseNode(0);
  if (cursor !== lines.length) {
    throw new Error(`第 ${(lines[cursor] as SourceLine | undefined)?.number ?? lines.length + 1} 行：存在无法归位的残余内容`);
  }
  return root;
}

/** ---------- 结构访问辅助 ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 报告内只使用相对标签，避免开发机绝对路径。 */
function relativeLabel(repoRoot: string, target: string): string {
  const rel = relative(repoRoot, target);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/');
  return basename(target);
}

/** 收集解析树中的全部键（用于禁止 env/credentials 等注入点）。 */
function collectKeys(value: unknown, sink: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, sink);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    sink.add(key);
    collectKeys(child, sink);
  }
}

/** ---------- 检查实现 ---------- */

interface WorkflowStep {
  readonly record: Record<string, unknown>;
  readonly uses: string | null;
  readonly run: string | null;
}

interface WorkflowContext {
  readonly repoRoot: string;
  readonly parsed: Record<string, unknown> | null;
  readonly jobs: Record<string, unknown> | null;
  readonly job: Record<string, unknown> | null;
  readonly jobId: string | null;
  readonly steps: readonly WorkflowStep[];
  /** 去注释后的工作流文本（用于副作用令牌扫描）。 */
  readonly codeText: string;
  readonly rawText: string;
}

export interface VerifyCiConfigOptions {
  readonly repoRoot: string;
  readonly environment: CiCheckEnvironment;
  /** 报告时间戳来源（测试可注入固定值）。 */
  readonly now?: () => Date;
}

export function verifyCiConfig(options: VerifyCiConfigOptions): CiConfigVerificationReport {
  const repoRoot = resolve(options.repoRoot);
  const workflowDir = join(repoRoot, WORKFLOW_DIRECTORY);
  const listed = existsSync(workflowDir)
    ? readdirSync(workflowDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];

  const inputs: {
    workflows: { label: string; sha256: string }[];
    manifest: { label: string; sha256: string } | null;
    lockfile: { label: string; sha256: string } | null;
  } = {
    workflows: listed.map((name) => ({
      label: `${WORKFLOW_DIRECTORY}/${name}`,
      sha256: sha256Hex(readFileSync(join(workflowDir, name), 'utf8')),
    })),
    manifest: null,
    lockfile: null,
  };

  let manifest: Record<string, unknown> | null = null;
  const manifestPath = join(repoRoot, 'package.json');
  if (existsSync(manifestPath)) {
    const text = readFileSync(manifestPath, 'utf8');
    try {
      manifest = JSON.parse(text) as Record<string, unknown>;
    } catch {
      manifest = null;
    }
    if (manifest) inputs.manifest = { label: 'package.json', sha256: sha256Hex(text) };
  }

  const lockPath = join(repoRoot, 'package-lock.json');
  let lockParsed: Record<string, unknown> | null = null;
  let lockError: string | null = null;
  if (existsSync(lockPath)) {
    const text = readFileSync(lockPath, 'utf8');
    inputs.lockfile = { label: 'package-lock.json', sha256: sha256Hex(text) };
    try {
      lockParsed = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      lockError = `package-lock.json 无法解析：${(error as Error).message}`;
    }
  }

  const workflowPath = join(repoRoot, CI_WORKFLOW_FILE);
  let rawText = '';
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  if (existsSync(workflowPath)) {
    rawText = readFileSync(workflowPath, 'utf8');
    try {
      parsed = asRecord(parseYamlSubset(rawText));
      if (!parsed) parseError = '工作流根节点不是映射结构';
    } catch (error) {
      parseError = `工作流 YAML 无法解析：${(error as Error).message}`;
    }
  }

  let jobs: Record<string, unknown> | null = null;
  let job: Record<string, unknown> | null = null;
  let jobId: string | null = null;
  let steps: WorkflowStep[] = [];
  if (parsed) {
    jobs = asRecord(parsed['jobs']);
    if (jobs) {
      const ids = Object.keys(jobs);
      jobId = ids.length === 1 ? (ids[0] as string) : null;
      job = jobId ? asRecord(jobs[jobId]) : null;
      const rawSteps = job ? asArray(job['steps']) : null;
      if (rawSteps) {
        steps = rawSteps
          .map((item) => {
            const record = asRecord(item);
            if (!record) return null;
            const step: WorkflowStep = {
              record,
              uses: asString(record['uses']),
              run: asString(record['run']),
            };
            return step;
          })
          .filter((step): step is WorkflowStep => step !== null);
      }
    }
  }
  const context: WorkflowContext = { repoRoot, parsed, jobs, job, jobId, steps, codeText: stripCommentsText(rawText), rawText };

  const checks: CiConfigCheck[] = [
    checkWorkflowFileSet(listed, workflowDir),
    checkParseable(existsSync(workflowPath), parseError, context),
    checkTriggerScope(context),
    checkPermissions(context),
    checkRunnerToolchain(context, manifest),
    checkStepOrder(context),
    checkCommandAllowlist(context),
    checkNoPublishSideEffects(context),
    checkNoCredentialInjection(context),
    checkActionRefsPinned(context),
    checkScriptWiring(context, manifest),
    checkLockfile(existsSync(lockPath), lockParsed, lockError, manifest),
  ];

  const failed = checks.filter((check) => check.status === 'failed');
  const notRun: CiConfigNotRun[] = [
    {
      id: 'real-ci-execution',
      reason: '实际 GitHub Actions 运行结果属于 Phase/CI 集成证据；本检查仅覆盖本地静态配置核对',
      owner: 'phase-integration',
    },
    {
      id: 'ci-native-module-loading',
      reason: 'macOS 原生模块在 CI 环境的安装与加载实测属于 Phase/CI 集成证据',
      owner: 'phase-integration',
    },
    {
      id: 'ci-independent-install',
      reason: '独立目录安装与已有 Host 兼容检查在 CI 的实测属于 Phase/CI 集成证据',
      owner: 'phase-integration',
    },
  ];

  return {
    schemaVersion: 1,
    kind: 'shiploop.ci-config-verification',
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    passed: failed.length === 0,
    environment: options.environment,
    inputs,
    checks,
    notRun,
    summary: { passed: checks.length - failed.length, failed: failed.length, notRun: notRun.length },
  };
}

function baseCheck(id: CiCheckId, title: string, objects: readonly string[]): {
  ok: (problems?: readonly string[]) => CiConfigCheck;
  fail: (problems: readonly string[]) => CiConfigCheck;
} {
  return {
    ok: (problems: readonly string[] = []) => ({ id, title, status: 'passed', objects, problems }),
    fail: (problems) => ({ id, title, status: 'failed', objects, problems }),
  };
}

function structuralGuard(context: WorkflowContext, problems: string[]): boolean {
  if (!context.parsed) {
    problems.push('工作流未解析，无法执行结构检查（fail-closed）');
    return false;
  }
  if (!context.jobs || !context.job || context.jobId === null) {
    problems.push('工作流必须恰好包含一个 job；当前结构无法确定唯一 job');
    return false;
  }
  return true;
}

function checkWorkflowFileSet(listed: readonly string[], workflowDir: string): CiConfigCheck {
  const check = baseCheck('workflow-file-set', '工作流文件集合受控', [WORKFLOW_DIRECTORY]);
  const allowed = new Set<string>(ALLOWED_WORKFLOW_FILES);
  // The matrix uses expressions outside the release YAML subset; pin its reviewed content.
  const matrix = 'node-compatibility.yml';
  const extra = listed.filter((name) => !allowed.has(name) && name !== matrix);
  const missing = [...allowed].filter((name) => !listed.includes(name));
  const problems: string[] = [];
  if (listed.includes(matrix) && sha256Hex(readFileSync(join(workflowDir, matrix), 'utf8')) !==
    'c66e65e633abcedeee0e9b4b94d399093257b5b6f4875f2c090058638608eb81') {
    problems.push('Node compatibility workflow differs from reviewed configuration');
  }
  if (listed.length === 0) problems.push(`${WORKFLOW_DIRECTORY} 下没有任何工作流文件，最小发布 CI 未登记`);
  for (const name of extra) problems.push(`未登记的工作流文件：${WORKFLOW_DIRECTORY}/${name}`);
  for (const name of missing) problems.push(`缺少登记的工作流文件：${WORKFLOW_DIRECTORY}/${name}`);
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkParseable(fileExists: boolean, parseError: string | null, context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('workflow-parseable', '工作流 YAML 可解析（受限子集）', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!fileExists) {
    problems.push(`缺少 ${CI_WORKFLOW_FILE}，无法解析`);
    return check.fail(problems);
  }
  if (parseError) problems.push(parseError);
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkTriggerScope(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('trigger-scope', '触发范围固定为 main 的 push/pull_request', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  const on = asRecord((context.parsed as Record<string, unknown>)['on']);
  if (!on) {
    problems.push('缺少 on 触发声明');
    return check.fail(problems);
  }
  const keys = Object.keys(on);
  const allowed = ['push', 'pull_request'];
  for (const key of keys) {
    if (!allowed.includes(key)) problems.push(`不允许的触发事件：${key}（只允许 push/pull_request）`);
  }
  for (const event of allowed) {
    const value = asRecord(on[event]);
    if (!value) {
      problems.push(`触发事件 ${event} 缺少 branches 限定`);
      continue;
    }
    const eventKeys = Object.keys(value);
    if (eventKeys.length !== 1 || eventKeys[0] !== 'branches') {
      problems.push(`触发事件 ${event} 只允许 branches 限定，实际键：${eventKeys.join(', ') || '(空)'}`);
    }
    const branches = asArray(value['branches']);
    if (!branches || branches.length !== 1 || asString(branches[0]) !== 'main') {
      problems.push(`触发事件 ${event} 的 branches 必须恰为 [main]`);
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkPermissions(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('permissions-minimal', '显式最小只读权限', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  const permissions = asRecord((context.parsed as Record<string, unknown>)['permissions']);
  if (!permissions) {
    problems.push('缺少顶层 permissions 声明（必须显式 contents: read，不依赖仓库默认）');
  } else {
    const keys = Object.keys(permissions);
    if (keys.length !== 1 || keys[0] !== 'contents' || asString(permissions['contents']) !== 'read') {
      problems.push(`顶层权限必须恰为 contents: read；实际：${JSON.stringify(permissions)}`);
    }
  }
  const jobPermissions = asRecord((context.job as Record<string, unknown>)['permissions']);
  if (jobPermissions) {
    const keys = Object.keys(jobPermissions);
    if (keys.length !== 1 || keys[0] !== 'contents' || asString(jobPermissions['contents']) !== 'read') {
      problems.push(`job 级权限只允许 contents: read；实际：${JSON.stringify(jobPermissions)}`);
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkRunnerToolchain(context: WorkflowContext, manifest: Record<string, unknown> | null): CiConfigCheck {
  const check = baseCheck('runner-toolchain', 'runner 与 Node 工具链固定', [CI_WORKFLOW_FILE, 'package.json']);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  const job = context.job as Record<string, unknown>;
  if (asString(job['runs-on']) !== RUNNER_LABEL) {
    problems.push(`runs-on 必须为 ${RUNNER_LABEL}；实际：${JSON.stringify(job['runs-on'])}`);
  }
  const timeout = job['timeout-minutes'];
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MINUTES) {
    problems.push(`job 必须声明 1..${MAX_TIMEOUT_MINUTES} 的整数 timeout-minutes；实际：${JSON.stringify(timeout)}`);
  }
  const engines = manifest ? asRecord(manifest['engines']) : null;
  const engineNode = engines ? asString(engines['node']) : null;
  const engineNpm = engines ? asString(engines['npm']) : null;
  if (!engineNode || (!/^\d+\.\d+\.\d+$/.test(engineNode) && engineNode !== '^22.19.0 || ^24.14.1 || ^26.7.0')) {
    problems.push(`package.json engines.node 必须精确固定为 X.Y.Z；实际：${JSON.stringify(engineNode)}`);
  }
  if (!engineNpm || (!/^\d+\.\d+\.\d+$/.test(engineNpm) && engineNpm !== '>=10.9.3 <12')) {
    problems.push(`package.json engines.npm 必须精确固定为 X.Y.Z；实际：${JSON.stringify(engineNpm)}`);
  }
  const setupSteps = context.steps.filter((step) => step.uses?.startsWith('actions/setup-node'));
  if (setupSteps.length !== 1) {
    problems.push(`必须恰好一个 actions/setup-node 步骤；实际 ${setupSteps.length} 个`);
  } else {
    const withKeys = asRecord(setupSteps[0]?.record['with']);
    if (!withKeys) {
      problems.push('setup-node 缺少 with.node-version');
    } else {
      const keys = Object.keys(withKeys);
      if (keys.length !== 1 || keys[0] !== NODE_VERSION_KEY) {
        problems.push(`setup-node with 只允许 ${NODE_VERSION_KEY}；实际键：${keys.join(', ')}`);
      }
      const pinned = asString(withKeys[NODE_VERSION_KEY]);
      if (engineNode) {
        if (pinned !== (engineNode === '^22.19.0 || ^24.14.1 || ^26.7.0' ? '22.19.0' : engineNode)) {
          problems.push(`setup-node ${NODE_VERSION_KEY} 必须与 engines.node 一致：期望 ${engineNode}，实际 ${JSON.stringify(pinned)}`);
        }
      } else if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
        problems.push(`setup-node ${NODE_VERSION_KEY} 必须精确固定为 X.Y.Z；实际：${JSON.stringify(pinned)}`);
      }
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkStepOrder(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('required-step-order', '必需步骤固定顺序且失败即非零', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  const job = context.job as Record<string, unknown>;
  if (job['continue-on-error'] !== undefined) {
    problems.push('job 不允许 continue-on-error（任一步失败必须使 CI 失败）');
  }
  for (const step of context.steps) {
    if (step.record['continue-on-error'] !== undefined) {
      problems.push(`步骤不允许 continue-on-error：${stepLabel(step)}`);
    }
    if (step.record['if'] !== undefined) {
      problems.push(`步骤不允许 if 条件跳过（保持静态可审）：${stepLabel(step)}`);
    }
    if (step.run === 'npm run verify' && step.record['env'] === undefined) {
      problems.push('verify 必须声明已审的内外层测试预算，避免默认 10 分钟提前结束');
    }
  }
  const runCommands = context.steps.map((step) => step.run).filter((run): run is string => run !== null);
  const expected = [...REQUIRED_RUN_SEQUENCE];
  if (JSON.stringify(runCommands) !== JSON.stringify(expected)) {
    const missing = expected.filter((command) => !runCommands.includes(command));
    if (missing.length > 0) {
      problems.push(`缺少必需 run 步骤：${missing.map((command) => JSON.stringify(command)).join(', ')}`);
    } else {
      problems.push(`run 步骤顺序与固定顺序不符：实际序列 ${JSON.stringify(runCommands)}`);
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function stepLabel(step: WorkflowStep): string {
  const name = asString(step.record['name']);
  if (name) return name;
  return step.uses ?? step.run ?? '(unnamed)';
}

function checkCommandAllowlist(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('command-allowlist', 'run 命令与审阅清单一致', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  const allowlist = new Set<string>(REQUIRED_RUN_SEQUENCE);
  for (const step of context.steps) {
    if (step.run !== null && !allowlist.has(step.run)) {
      problems.push(`未审阅的 run 命令（步骤 ${stepLabel(step)}）：${JSON.stringify(step.run)}`);
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

const FORBIDDEN_TEXT_TOKENS = [
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'npm token',
  'npm dist-tag',
  'npm owner',
  'npm access',
  'npm profile',
  'npm login',
  'npm adduser',
  'git push',
  'git remote ',
  'gh pr',
  'gh release',
  'gh repo',
  'gh workflow',
  'merge queue',
] as const;

function checkNoPublishSideEffects(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('no-publish-side-effects', '无发布/推送/PR/合并副作用', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!context.parsed) {
    problems.push('工作流未解析，无法检查发布副作用（fail-closed）');
    return check.fail(problems);
  }
  const lower = context.codeText.toLowerCase();
  for (const token of FORBIDDEN_TEXT_TOKENS) {
    if (lower.includes(token)) problems.push(`工作流包含禁止的发布/远端副作用标记：${JSON.stringify(token.trim())}`);
  }
  if (context.codeText.includes('${{')) {
    problems.push('工作流不允许 ${{ }} 动态表达式（保持静态可审；表达式可访问 secrets 上下文）');
  }
  const keys = new Set<string>();
  collectKeys(context.parsed, keys);
  const expectedVerifyEnv = {
    SHIPLOOP_VERIFY_STEP_TIMEOUT_MS: '18000000',
    SHIPLOOP_TEST_RUN_TIMEOUT_MS: '17400000',
  };
  if (context.parsed['env'] !== undefined || context.job?.['env'] !== undefined) {
    problems.push('工作流与 job 不允许 env 注入块');
  }
  for (const step of context.steps) {
    if (step.record['env'] === undefined) continue;
    const env = asRecord(step.record['env']);
    if (step.run !== 'npm run verify' || !env
      || Object.keys(env).length !== Object.keys(expectedVerifyEnv).length
      || Object.entries(expectedVerifyEnv).some(([key, value]) => env[key] !== value)) {
      problems.push('只有 verify 步骤允许固定的测试超时变量，禁止其他 env 注入');
    }
  }
  for (const step of context.steps) {
    if (step.uses !== null) {
      const action = step.uses.split('@')[0] ?? '';
      if (!(ALLOWED_ACTIONS as readonly string[]).includes(action)) {
        problems.push(`未登记的 Action（步骤 ${stepLabel(step)}）：${JSON.stringify(step.uses)}；只允许 ${ALLOWED_ACTIONS.join(', ')}`);
      }
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkNoCredentialInjection(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('no-credential-injection', '检查环境无发布凭据注入', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!context.parsed) {
    problems.push('工作流未解析，无法检查凭据注入（fail-closed）');
    return check.fail(problems);
  }
  if (/secrets\./i.test(context.codeText)) problems.push('工作流引用了 secrets 上下文（普通检查不得注入凭据）');
  if (/credentials\s*:/i.test(context.codeText)) problems.push('工作流包含 credentials 声明');
  if (/_token/i.test(context.codeText)) problems.push('工作流包含疑似 token 变量名（如 NPM_TOKEN/NODE_AUTH_TOKEN）');
  if (/private[-_]?key/i.test(context.codeText)) problems.push('工作流包含疑似私钥材料引用');
  if (/registry-url/i.test(context.codeText)) problems.push('setup-node 不允许配置 registry-url（无发布注册表需要）');
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkActionRefsPinned(context: WorkflowContext): CiConfigCheck {
  const check = baseCheck('action-refs-pinned', 'Action 引用固定到已审版本', [CI_WORKFLOW_FILE]);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  for (const step of context.steps) {
    if (step.uses === null) continue;
    const ref = step.uses.includes('@') ? (step.uses.split('@').slice(1).join('@') as string) : '';
    if (ref === '' || !PINNED_REF_PATTERN.test(ref)) {
      problems.push(`Action 引用未固定到 vX.Y[.Z] 或 40 位 SHA（步骤 ${stepLabel(step)}）：${JSON.stringify(step.uses)}`);
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function checkScriptWiring(context: WorkflowContext, manifest: Record<string, unknown> | null): CiConfigCheck {
  const check = baseCheck('script-wiring', '脚本接线与制品摘要上传完整', [CI_WORKFLOW_FILE, 'package.json']);
  const problems: string[] = [];
  if (!structuralGuard(context, problems)) return check.fail(problems);
  const scripts = manifest ? asRecord(manifest['scripts']) : null;
  if (!scripts) {
    problems.push('根 package.json 缺少可用的 scripts 声明');
    return check.fail(problems);
  }
  for (const command of REQUIRED_RUN_SEQUENCE) {
    const npmRun = /^npm run ([\w:.-]+)(?: .*)?$/.exec(command);
    if (npmRun) {
      const name = npmRun[1] as string;
      const value = scripts[name];
      if (typeof value !== 'string') {
        problems.push(`工作流要求 npm 脚本 ${JSON.stringify(name)}，但 package.json 未声明`);
        continue;
      }
      const nodeFile = /^node (\S+)/.exec(value);
      if (!nodeFile) {
        problems.push(`npm 脚本 ${JSON.stringify(name)} 必须由本地 node 脚本执行；实际：${JSON.stringify(value)}`);
        continue;
      }
      problems.push(...assertScriptFile(context, nodeFile[1] as string, `npm 脚本 ${JSON.stringify(name)}`));
    } else {
      const direct = /^node (\S+)$/.exec(command);
      if (direct) problems.push(...assertScriptFile(context, direct[1] as string, 'run 步骤'));
    }
  }

  const usesActions = (action: string): WorkflowStep[] =>
    context.steps.filter((step) => step.uses?.startsWith(action));
  const checkout = usesActions('actions/checkout');
  const setupNode = usesActions('actions/setup-node');
  const upload = usesActions('actions/upload-artifact');
  if (checkout.length !== 1) problems.push(`必须恰好一个 actions/checkout 步骤；实际 ${checkout.length} 个`);
  else if (asRecord(checkout[0]?.record['with'])?.['fetch-depth'] !== 0) {
    problems.push('checkout 必须 fetch-depth: 0，以核验发布清单历史提交');
  }
  if (setupNode.length !== 1) problems.push(`必须恰好一个 actions/setup-node 步骤；实际 ${setupNode.length} 个`);
  if (upload.length !== 1) {
    problems.push(`必须恰好一个 actions/upload-artifact 步骤保存脱敏报告；实际 ${upload.length} 个`);
  } else {
    const withKeys = asRecord(upload[0]?.record['with']);
    if (!withKeys) {
      problems.push('upload-artifact 缺少 with 配置');
    } else {
      const name = asString(withKeys['name']);
      if (!name || name.trim() === '') problems.push('upload-artifact 缺少非空 name');
      const path = asString(withKeys['path']);
      if (!path) {
        problems.push('upload-artifact 缺少 path');
      } else {
        const uploadsArtifactRoot = path.trim() === 'artifacts/' || path.trim() === 'artifacts';
        for (const required of REQUIRED_UPLOAD_PATHS) {
          if (!uploadsArtifactRoot && !path.includes(required)) {
            problems.push(`upload-artifact path 必须包含脱敏报告 ${required}`);
          }
        }
      }
      if (asString(withKeys['if-no-files-found']) !== 'error') {
        problems.push('upload-artifact 必须 if-no-files-found: error（缺报告即失败，不放行）');
      }
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

function assertScriptFile(context: WorkflowContext, file: string, owner: string): string[] {
  if (isAbsolute(file) || file.startsWith('..')) {
    return [`${owner} 引用了仓库外脚本路径：${JSON.stringify(file)}`];
  }
  const target = resolve(context.repoRoot, file);
  if (!existsSync(target)) {
    return [`${owner} 引用的脚本文件不存在：${file}`];
  }
  return [];
}

function checkLockfile(
  fileExists: boolean,
  lockParsed: Record<string, unknown> | null,
  lockError: string | null,
  manifest: Record<string, unknown> | null,
): CiConfigCheck {
  const check = baseCheck('lockfile-present', '锁定依赖存在且身份一致', ['package-lock.json', 'package.json']);
  const problems: string[] = [];
  if (!fileExists) {
    problems.push('缺少 package-lock.json（npm ci 与确定性安装无从谈起；不会被已安装 node_modules 掩盖）');
  }
  if (lockError) problems.push(lockError);
  if (lockParsed) {
    if (typeof lockParsed['lockfileVersion'] !== 'number' || (lockParsed['lockfileVersion'] as number) < 1) {
      problems.push('package-lock.json 缺少有效的数字 lockfileVersion');
    }
    if (manifest) {
      if (typeof manifest['name'] === 'string' && lockParsed['name'] !== manifest['name']) {
        problems.push(`锁文件 name ${JSON.stringify(lockParsed['name'])} 与根清单 ${JSON.stringify(manifest['name'])} 不一致`);
      }
      if (typeof manifest['version'] === 'string' && lockParsed['version'] !== manifest['version']) {
        problems.push(`锁文件 version ${JSON.stringify(lockParsed['version'])} 与根清单 ${JSON.stringify(manifest['version'])} 不一致`);
      }
    }
  }
  return problems.length > 0 ? check.fail(problems) : check.ok();
}

/** ---------- CLI ---------- */

function renderReportText(report: CiConfigVerificationReport): string {
  const lines: string[] = [];
  lines.push(`ci-config: ${report.passed ? 'PASS' : 'FAIL'}`);
  for (const check of report.checks) {
    if (check.status === 'passed') continue;
    lines.push(`  [failed] ${check.id}: ${check.problems.join('; ')}`);
  }
  lines.push(
    `ci-config: checks ${report.summary.passed} passed / ${report.summary.failed} failed; phase-integration not_run ${report.summary.notRun}`,
  );
  return lines.join('\n');
}

function cliFail(message: string): never {
  process.stderr.write(`verify-ci-config: ${message}\n`);
  process.exit(2);
}

interface CliEnvironment {
  readonly nodeVersion: string;
  readonly npmVersion: string | null;
  readonly gitCommit: string | null;
  readonly platform: string;
}

function gatherEnvironment(): CliEnvironment {
  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  const gitCommit = git.status === 0 ? (git.stdout ?? '').trim() || null : null;
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 60_000 });
  const npmVersion = npm.status === 0 ? (npm.stdout ?? '').trim() || null : null;
  return {
    nodeVersion: process.versions.node,
    npmVersion,
    gitCommit,
    platform: process.platform,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  let repoRootArg: string | undefined;
  let outputArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo-root' && args[index + 1] !== undefined) {
      repoRootArg = args[++index];
    } else if (arg === '--output' && args[index + 1] !== undefined) {
      outputArg = args[++index];
    } else {
      cliFail(`未知参数：${arg}（支持 --repo-root/--output）`);
    }
  }
  const repoRoot = resolve(repoRootArg ?? process.cwd());
  const output = resolve(outputArg ?? join(repoRoot, 'artifacts/ci-config/ci-config-verification.json'));

  const report = verifyCiConfig({ repoRoot, environment: gatherEnvironment() });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${renderReportText(report)}\n`);
  process.stdout.write(`verify-ci-config: report ${output}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main();
}
