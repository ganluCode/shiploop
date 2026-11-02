/**
 * P08-2 F-007 干净安装目录启动打包 CLI 的 Todo 演示安装冒烟（fail-closed 工程检查器）。
 *
 * 验收映射（feature F-007）：
 * 1. 在全新安装目录只用本地打包 tarball（npm --offline，不访问 registry）安装
 *    shiploop-core/host/cli 三包，安装产物即可启动 CLI 并访问 Todo 演示所需的
 *    最小稳定协议（host start/status/结构化拒绝/stop 回执）；
 * 2. 冒烟不依赖开发机绝对路径、源码链接（安装目录符号链接不得逃逸安装目录）、
 *    未声明全局包或 Harness 运行状态；环境事实（commit/Node/npm/平台）来自
 *    实际检查进程；
 * 3. 打包模式在隔离数据根上完成最小命令回执；host_not_found 是结构化错误信封
 *    （退出码 3）；凭据（auth token）只存在于 0600 文件，绝不进入命令输出或报告；
 * 4. 产物入口、运行时依赖清单与声明/实测协议摘要写入结构化报告；任一检查
 *    failed 或输入缺失时 passed=false，阻止把安装冒烟宣称为安装验收通过；
 * 5. 真实 registry 安装、原生模块矩阵、Git/SQLite 业务流、跨进程组合与真实
 *    Pi live 交付登记为 not_run（owner=phase-integration），不折算为通过。
 *
 * 该模块不是 ShipLoop 业务 Verifier：unit 守护测试用打包夹具
 * （test/helpers/p08-2/todo-fixture-pack-cli.mjs）在真实临时目录执行真实
 * npm pack/--offline install 与真实子进程；真实三包产物的执行入口与前置见
 * docs/p08-2-todo-install-smoke.md。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, validateDistributionManifest } from '../pack-local.ts';

const NPM_INSTALL_TIMEOUT_MS = 600_000;
const CLI_RUN_TIMEOUT_MS = 30_000;
const OUTPUT_EXCERPT_LIMIT = 600;

/** 检查 id（稳定顺序即报告展示顺序）。 */
export const TODO_INSTALL_SMOKE_CHECK_IDS = [
  'distribution-inputs',
  'compatibility-declared',
  'clean-install-offline',
  'packaged-entry-startable',
  'runtime-dependency-inventory',
  'isolated-data-root',
  'minimal-command-receipt',
  'protocol-scope-consistent',
  'protocol-consistency-with-source',
  'secret-handling',
  'output-hygiene',
  'report-hygiene',
] as const;

export type TodoInstallSmokeCheckId = (typeof TODO_INSTALL_SMOKE_CHECK_IDS)[number];

/** 显式 not_run 边界（owner=phase-integration），不折算为通过。 */
export const TODO_INSTALL_SMOKE_NOT_RUN = [
  { id: 'real-registry-install', reason: '独立目录经 npm registry 的真实安装与网络/锁文件矩阵由 Phase 集成执行' },
  { id: 'native-module-matrix', reason: 'better-sqlite3 与 Host 原生写入锁在全新机器的构建与加载矩阵由 Phase 集成执行' },
  { id: 'git-integration', reason: 'Todo 演示 Git 集成（project register/规划/执行全链）由 Phase 集成执行' },
  { id: 'sqlite-business-flows', reason: '真实 SQLite 业务流与迁移/备份兼容矩阵由 Phase 集成执行' },
  { id: 'cross-process-matrix', reason: '跨进程组合（并发 CLI、崩溃恢复、双 Host 竞争）由 Phase 集成执行' },
  { id: 'todo-live-delivery', reason: '真实 Pi Todo live 交付（accept:p08:live）独立执行，安装冒烟不替代' },
] as const;

export class TodoInstallSmokeError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(`todo-install-smoke: ${reason}`);
    this.reason = reason;
  }
}

export interface TodoInstallSmokeEnvironment {
  readonly gitCommit: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly platform: string;
}

export interface TodoInstallHostProtocolScope {
  readonly wireProtocolVersions: readonly number[];
  readonly wireSchemaVersion: number;
  readonly discoverySchemaVersions: readonly number[];
}

export interface TodoInstallCompatibilityScope {
  readonly hostProtocol: TodoInstallHostProtocolScope;
  readonly databaseSchema?: { readonly engine?: string; readonly writableTargetVersion?: number };
}

export interface TodoInstallCompatibilityInput {
  readonly label: string;
  readonly sha256: string;
  readonly scope: TodoInstallCompatibilityScope;
}

export interface TodoInstallSmokeArtifact {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
}

export interface TodoInstallRuntimeDependency {
  readonly name: string;
  readonly version: string;
  readonly kind: 'workspace' | 'external';
}

export interface TodoInstallCommandRecord {
  readonly command: string;
  readonly exitCode: number | null;
  readonly ok: boolean | null;
  readonly errorCode: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
}

export interface TodoInstallModeRun {
  readonly mode: 'install' | 'source';
  readonly commands: readonly TodoInstallCommandRecord[];
  readonly protocol: {
    readonly startOutcome: string | null;
    readonly startProtocolVersion: number | null;
    readonly startLifecycleState: string | null;
    readonly startHostInstanceId: string | null;
    readonly statusHostInstanceId: string | null;
    readonly refusalErrorCode: string | null;
    readonly stopStatus: string | null;
    readonly discoverySchemaVersion: number | null;
    readonly discoveryProtocolVersion: number | null;
  };
  readonly dataRoot: {
    readonly label: string;
    readonly identity: string | null;
    readonly discoveryPresentAfterStart: boolean;
    readonly tokenFile: { readonly present: boolean; readonly hex64: boolean; readonly mode: string | null };
    readonly discoveryRemovedAfterStop: boolean | null;
  };
}

export interface TodoInstallSmokeCheck {
  readonly id: TodoInstallSmokeCheckId;
  readonly title: string;
  readonly status: 'passed' | 'failed';
  readonly objects: readonly string[];
  readonly problems: readonly string[];
}

export interface TodoInstallSmokeNotRun {
  readonly id: string;
  readonly reason: string;
  readonly owner: 'phase-integration';
}

export interface TodoInstallSmokeReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.todo-install-smoke';
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly environment: TodoInstallSmokeEnvironment;
  readonly inputs: {
    readonly distribution: string;
    readonly distributionManifestSha256: string | null;
    readonly compatibility: { readonly label: string; readonly sha256: string } | null;
    readonly artifacts: readonly TodoInstallSmokeArtifact[];
  };
  readonly install: {
    readonly mode: 'offline-local-tarballs';
    readonly installDirLabel: string;
    readonly npmExitCode: number | null;
    readonly binLinkPresent: boolean;
    readonly entry: { readonly present: boolean; readonly shebang: boolean; readonly executable: boolean };
    readonly runtimeDependencies: readonly TodoInstallRuntimeDependency[];
  };
  readonly runs: {
    readonly installMode: TodoInstallModeRun | null;
    readonly sourceMode: TodoInstallModeRun | null;
    readonly consistency: { readonly consistent: boolean; readonly differences: readonly string[] } | null;
  };
  readonly protocol: {
    readonly declared: { readonly wireProtocolVersions: readonly number[]; readonly wireSchemaVersion: number; readonly discoverySchemaVersions: readonly number[] } | null;
  };
  readonly checks: readonly TodoInstallSmokeCheck[];
  readonly notRun: readonly TodoInstallSmokeNotRun[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly notRun: number };
}

export interface TodoInstallSmokePorts {
  readonly environment: TodoInstallSmokeEnvironment;
  readonly npmInstall: (input: {
    readonly cwd: string;
    readonly tarballs: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
  }) => { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string };
  readonly runCli: (input: {
    readonly bin: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  }) => { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string };
}

export interface TodoInstallSmokeOptions {
  readonly distributionDir: string;
  readonly ports: TodoInstallSmokePorts;
  readonly compatibility: TodoInstallCompatibilityInput | null;
  readonly sourceCliBin?: string;
  readonly repoRoot?: string;
  readonly sandboxParent?: string;
  readonly keepSandbox?: boolean;
}

const CHECK_TITLES: Readonly<Record<TodoInstallSmokeCheckId, string>> = {
  'distribution-inputs': '分发清单与三包 tarball 完整性',
  'compatibility-declared': '协议兼容声明存在且范围可用',
  'clean-install-offline': '干净安装目录离线安装本地 tarball',
  'packaged-entry-startable': '打包 CLI 入口可启动并完成握手回执',
  'runtime-dependency-inventory': '运行时依赖清单与工作区包版本一致',
  'isolated-data-root': '隔离数据根与模式间互不串扰',
  'minimal-command-receipt': '最小命令回执契约（start/status/拒绝/stop）',
  'protocol-scope-consistent': '实测协议版本处于声明兼容范围',
  'protocol-consistency-with-source': '打包模式与源码模式协议一致',
  'secret-handling': '凭据不外泄（token 仅存在于 0600 文件）',
  'output-hygiene': '命令输出不含绝对路径/凭据形态',
  'report-hygiene': '报告脱敏（无绝对路径/凭据）',
};

const BEHAVIORAL_CHECK_IDS: readonly TodoInstallSmokeCheckId[] = [
  'clean-install-offline',
  'packaged-entry-startable',
  'runtime-dependency-inventory',
  'isolated-data-root',
  'minimal-command-receipt',
  'protocol-scope-consistent',
  'protocol-consistency-with-source',
  'secret-handling',
  'output-hygiene',
];

function hashHex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 把已知根与常见开发机绝对路径替换为标签；绝不回显原始路径材料。 */
export function redactAbsolutePaths(text: string, roots: readonly { label: string; path: string }[] = []): string {
  let output = text;
  for (const root of roots) {
    for (const candidate of new Set([root.path, realpathSafe(root.path)])) {
      if (candidate !== null) output = output.split(candidate).join(`[${root.label}]`);
    }
  }
  return output.replace(/\/(?:Users|home|private|var|opt|tmp)\b[^\s"'`,;)\\]*/g, '[absolute-path]');
}

function realpathSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function bounded(text: string, limit = OUTPUT_EXCERPT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 安装目录内符号链接不得解析到安装目录之外（源码链接/开发机依赖证据）。 */
export function verifyNoEscapingLinks(installDirInput: string): string[] {
  const installDir = resolve(installDirInput);
  const canonical = realpathSafe(installDir);
  const problems: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const label = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        const target = realpathSafe(child);
        if (target === null || canonical === null || !target.startsWith(`${canonical}/`)) {
          problems.push(`escaping symlink: ${label} -> [outside-install-dir]`);
        }
      } else if (entry.isDirectory()) {
        walk(child, label);
      }
    }
  };
  if (canonical !== null) walk(installDir, '');
  else problems.push('install directory is not readable');
  return problems;
}

/** 顶层 node_modules 清单（名称/版本/来源类别）；不读嵌套树，不记路径。 */
export function inventoryRuntimeDependencies(installDirInput: string): TodoInstallRuntimeDependency[] {
  const nodeModules = resolve(installDirInput, 'node_modules');
  if (!existsSync(nodeModules)) return [];
  const workspaceNames = new Set<string>(PACKAGES.map((pkg) => pkg.name));
  const inventory: TodoInstallRuntimeDependency[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifestPath = join(nodeModules, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown };
      const name = asString(manifest.name) ?? entry.name;
      const version = asString(manifest.version) ?? 'unknown';
      inventory.push({ name, version, kind: workspaceNames.has(name) ? 'workspace' : 'external' });
    } catch {
      inventory.push({ name: entry.name, version: 'unknown', kind: workspaceNames.has(entry.name) ? 'workspace' : 'external' });
    }
  }
  inventory.sort((left, right) => left.name.localeCompare(right.name));
  return inventory;
}

/** 解析固定 npm CLI（与 pack-local/verify-artifacts 同一约定）。 */
export function resolveNpmCli(): { readonly command: string; readonly prefix: readonly string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && npmExecPath.endsWith('.js') && existsSync(npmExecPath)) {
    return { command: process.execPath, prefix: [npmExecPath] };
  }
  const bundled = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  if (existsSync(bundled)) {
    return { command: process.execPath, prefix: [bundled] };
  }
  const repoBundled = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/npm/bin/npm-cli.js');
  if (existsSync(repoBundled)) {
    return { command: process.execPath, prefix: [repoBundled] };
  }
  throw new TodoInstallSmokeError('npm_cli_unresolvable');
}

/** 真实子进程端口：环境事实与 npm/CLI 调用都来自实际进程。 */
export function createProcessTodoInstallSmokePorts(options?: { readonly repoRoot?: string }): TodoInstallSmokePorts {
  const repoRoot = resolve(options?.repoRoot ?? process.cwd());
  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
  if (git.error || git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim())) {
    throw new TodoInstallSmokeError('git_commit_unresolvable');
  }
  const npm = resolveNpmCli();
  const npmVersionResult = spawnSync(npm.command, [...npm.prefix, '--version'], { encoding: 'utf8', timeout: 60_000 });
  if (npmVersionResult.error || npmVersionResult.status !== 0) {
    throw new TodoInstallSmokeError('npm_version_unresolvable');
  }
  const environment: TodoInstallSmokeEnvironment = {
    gitCommit: git.stdout.trim(),
    nodeVersion: process.versions.node,
    npmVersion: npmVersionResult.stdout.trim(),
    platform: process.platform,
  };
  return {
    environment,
    npmInstall: (input) => {
      const result = spawnSync(npm.command, [...npm.prefix, 'install', '--offline', '--no-audit', '--no-fund', ...input.tarballs], {
        cwd: input.cwd,
        encoding: 'utf8',
        timeout: NPM_INSTALL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...input.env },
      });
      return {
        exitCode: result.status,
        stdout: `${result.stdout ?? ''}`.slice(-16_384),
        stderr: `${result.stderr ?? ''}`.slice(-16_384),
      };
    },
    runCli: (input) => {
      const result = spawnSync(process.execPath, [input.bin, ...input.argv], {
        cwd: input.cwd,
        encoding: 'utf8',
        timeout: CLI_RUN_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...input.env },
      });
      return {
        exitCode: result.status,
        stdout: `${result.stdout ?? ''}`.slice(-16_384),
        stderr: `${result.stderr ?? ''}`.slice(-16_384),
      };
    },
  };
}

interface CapturedOutput {
  readonly label: string;
  readonly text: string;
}

interface ModeFacts {
  readonly run: TodoInstallModeRun;
  readonly secrets: readonly string[];
}

function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isObject(parsed) && typeof parsed.ok === 'boolean') return parsed;
  } catch {
    return null;
  }
  return null;
}

function fileModeOctal(path: string): string | null {
  try {
    return (statSync(path).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

/** 执行一个模式的最小协议序列；只返回脱敏事实，绝不返回原始输出/凭据。 */
function runModeSequence(
  ports: TodoInstallSmokePorts,
  input: {
    readonly mode: 'install' | 'source';
    readonly bin: string;
    readonly dataRoot: string;
    readonly emptyRoot: string;
    readonly sandbox: string;
    readonly sandboxHome: string;
  },
  captured: CapturedOutput[],
): ModeFacts {
  const { mode, bin, dataRoot, emptyRoot, sandbox, sandboxHome } = input;
  const env = { HOME: sandboxHome };
  const run = (label: string, argv: readonly string[]): { record: TodoInstallCommandRecord; raw: Readonly<Record<string, unknown>> | null } => {
    const result = ports.runCli({ bin, argv, cwd: sandbox, env });
    captured.push({ label: `${mode}:${label}`, text: `${result.stdout}\n${result.stderr}` });
    const envelope = parseEnvelope(result.stdout);
    const error = envelope !== null && envelope.ok === false && isObject(envelope.error) ? asString(envelope.error.code) : null;
    const raw =
      envelope !== null && envelope.ok === true && isObject(envelope.result) ? (envelope.result as Readonly<Record<string, unknown>>) : null;
    // 报告里的回执摘要只保留稳定协议字段；实例身份/数据根身份单独保存在事实里。
    const sanitized =
      raw === null
        ? null
        : Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'hostInstanceId' && key !== 'dataRootIdentity' && key !== 'evidence'));
    return {
      record: {
        command: `${argv[0]}.${argv[1]}`,
        exitCode: result.exitCode,
        ok: envelope === null ? null : (envelope.ok as boolean),
        errorCode: error,
        result: sanitized,
      },
      raw,
    };
  };

  const start = run('host.start', ['host', 'start', '--data-root', dataRoot, '--json']);
  const startHostInstanceId = start.raw === null ? null : asString(start.raw.hostInstanceId);
  const startIdentity = start.raw === null ? null : asString(start.raw.dataRootIdentity);
  const discoveryPath = join(dataRoot, 'host', 'discovery.json');
  const tokenPath = join(dataRoot, 'host', 'auth.token');
  const discoveryPresentAfterStart = existsSync(discoveryPath);
  let discoveryFacts: { schemaVersion: number | null; protocolVersion: number | null } = { schemaVersion: null, protocolVersion: null };
  let tokenFacts: TodoInstallModeRun['dataRoot']['tokenFile'] = { present: false, hex64: false, mode: null };
  const secrets: string[] = [];
  try {
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { schemaVersion?: unknown; protocolVersion?: unknown };
    discoveryFacts = { schemaVersion: asNumber(discovery.schemaVersion), protocolVersion: asNumber(discovery.protocolVersion) };
  } catch {
    discoveryFacts = { schemaVersion: null, protocolVersion: null };
  }
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    secrets.push(token);
    tokenFacts = { present: true, hex64: /^[0-9a-f]{64}$/.test(token), mode: fileModeOctal(tokenPath) };
  } catch {
    tokenFacts = { present: false, hex64: false, mode: null };
  }

  const status = run('host.status', ['host', 'status', '--data-root', dataRoot, '--json']);
  const statusHostInstanceId = status.raw === null ? null : asString(status.raw.hostInstanceId);
  const refusal = run('host.status.refusal', ['host', 'status', '--data-root', emptyRoot, '--json']);
  const stop = run('host.stop', ['host', 'stop', '--data-root', dataRoot, '--json']);
  const stopStatus = stop.raw === null ? null : asString(stop.raw.status);
  const discoveryRemovedAfterStop = stop.record.ok === true ? !existsSync(discoveryPath) : null;

  const runResult: TodoInstallModeRun = {
    mode,
    commands: [start.record, status.record, refusal.record, stop.record],
    protocol: {
      startOutcome: start.raw === null ? null : asString(start.raw.outcome),
      startProtocolVersion: start.raw === null ? null : asNumber(start.raw.protocolVersion),
      startLifecycleState: start.raw === null ? null : asString(start.raw.lifecycleState),
      startHostInstanceId,
      statusHostInstanceId,
      refusalErrorCode: refusal.record.errorCode,
      stopStatus,
      discoverySchemaVersion: discoveryFacts.schemaVersion,
      discoveryProtocolVersion: discoveryFacts.protocolVersion,
    },
    dataRoot: {
      label: `${mode}-mode-data-root`,
      identity: startIdentity,
      discoveryPresentAfterStart,
      tokenFile: tokenFacts,
      discoveryRemovedAfterStop,
    },
  };
  return { run: runResult, secrets };
}

function compareTodoInstallProtocol(
  install: TodoInstallModeRun,
  source: TodoInstallModeRun,
): { consistent: boolean; differences: string[] } {
  const differences: string[] = [];
  const pairs: [keyof TodoInstallModeRun['protocol'], string][] = [
    ['startOutcome', 'start.outcome'],
    ['startProtocolVersion', 'start.protocolVersion'],
    ['startLifecycleState', 'start.lifecycleState'],
    ['refusalErrorCode', 'refusal.errorCode'],
    ['stopStatus', 'stop.status'],
    ['discoverySchemaVersion', 'discovery.schemaVersion'],
    ['discoveryProtocolVersion', 'discovery.protocolVersion'],
  ];
  for (const [key, label] of pairs) {
    if (install.protocol[key] !== source.protocol[key]) {
      differences.push(`${label}: install=${JSON.stringify(install.protocol[key])} source=${JSON.stringify(source.protocol[key])}`);
    }
  }
  return { consistent: differences.length === 0, differences };
}

function labelFor(path: string, root: string | undefined): string {
  if (root !== undefined) {
    const rel = relative(resolve(root), path);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/');
  }
  return basename(path);
}

interface CheckDraft {
  readonly id: TodoInstallSmokeCheckId;
  readonly title: string;
  readonly objects: string[];
  readonly problems: string[];
}

export async function runTodoInstallSmoke(options: TodoInstallSmokeOptions): Promise<TodoInstallSmokeReport> {
  const distributionDir = resolve(options.distributionDir);
  if (!existsSync(distributionDir)) throw new TodoInstallSmokeError('distribution_dir_missing');
  const manifestPath = join(distributionDir, 'distribution-manifest.json');
  if (!existsSync(manifestPath)) throw new TodoInstallSmokeError('distribution_manifest_missing');
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new TodoInstallSmokeError('distribution_manifest_unreadable');
  }

  const redactionRoots = [
    { label: 'distribution', path: distributionDir },
    ...(options.repoRoot !== undefined ? [{ label: 'repo', path: resolve(options.repoRoot) }] : []),
  ];
  const drafts = new Map<TodoInstallSmokeCheckId, CheckDraft>(
    TODO_INSTALL_SMOKE_CHECK_IDS.map((id) => [
      id,
      { id, title: CHECK_TITLES[id], objects: [`distribution/${labelFor(distributionDir, options.repoRoot)}`, 'clean-install'], problems: [] } satisfies CheckDraft,
    ]),
  );
  const problem = (id: TodoInstallSmokeCheckId, message: string): void => {
    drafts.get(id)!.problems.push(redactAbsolutePaths(message, redactionRoots));
  };

  // 1) 分发清单与 tarball 完整性（复用 pack-local 的逐文件摘要核验）。
  let artifacts: TodoInstallSmokeArtifact[] = [];
  let distributionOk = true;
  try {
    validateDistributionManifest(manifestRaw, distributionDir);
    if (isObject(manifestRaw) && Array.isArray(manifestRaw.artifacts)) {
      artifacts = manifestRaw.artifacts.flatMap((entry) => {
        if (!isObject(entry)) return [];
        const name = asString(entry.name);
        const version = asString(entry.version);
        const filename = asString(entry.filename);
        const sha256 = asString(entry.sha256);
        return name !== null && version !== null && filename !== null && sha256 !== null
          ? [{ name, version, filename, sha256 }]
          : [];
      });
    }
  } catch (error) {
    distributionOk = false;
    problem('distribution-inputs', error instanceof Error ? error.message : String(error));
  }
  if (distributionOk && artifacts.length !== PACKAGES.length) {
    distributionOk = false;
    problem('distribution-inputs', 'artifact records incomplete after validation');
  }

  // 2) 兼容声明。
  const compatibility = options.compatibility;
  const scope = compatibility?.scope ?? null;
  if (scope === null) {
    problem('compatibility-declared', 'compatibility declaration missing');
  } else if (
    !Array.isArray(scope.hostProtocol.wireProtocolVersions) ||
    scope.hostProtocol.wireProtocolVersions.length === 0 ||
    !scope.hostProtocol.wireProtocolVersions.every((value) => typeof value === 'number') ||
    typeof scope.hostProtocol.wireSchemaVersion !== 'number' ||
    !Array.isArray(scope.hostProtocol.discoverySchemaVersions) ||
    scope.hostProtocol.discoverySchemaVersions.length === 0
  ) {
    problem('compatibility-declared', 'compatibility host protocol scope invalid');
  }

  // 3) 干净安装目录 + 离线安装 + 协议冒烟（沙箱整体在 finally 清理）。
  const sandboxParent = options.sandboxParent ?? tmpdir();
  const sandbox = mkdtempSync(join(sandboxParent, 'shiploop-f007-smoke-'));
  const captured: CapturedOutput[] = [];
  const secrets: string[] = [];
  let installRun: TodoInstallModeRun | null = null;
  let sourceRun: TodoInstallModeRun | null = null;
  let consistency: TodoInstallSmokeReport['runs']['consistency'] = null;
  let npmExitCode: number | null = null;
  let entryFacts: TodoInstallSmokeReport['install']['entry'] = { present: false, shebang: false, executable: false };
  let binLinkPresent = false;
  let runtimeDependencies: TodoInstallRuntimeDependency[] = [];
  const sandboxHome = join(sandbox, 'home');
  const installDir = join(sandbox, 'clean-install');
  const installDataRoot = join(sandbox, 'install-data');
  const installEmptyRoot = join(sandbox, 'install-empty');
  const sourceDataRoot = join(sandbox, 'source-data');
  const sourceEmptyRoot = join(sandbox, 'source-empty');

  try {
    mkdirSync(installDir, { recursive: true });
    mkdirSync(sandboxHome, { recursive: true });
    if (distributionOk) {
      // 3a) 离线安装三包 tarball。
      const tarballs = artifacts.map((artifact) => join(distributionDir, artifact.filename));
      const installResult = options.ports.npmInstall({ cwd: installDir, tarballs });
      npmExitCode = installResult.exitCode;
      if (installResult.exitCode !== 0) {
        problem('clean-install-offline', `npm install --offline exited ${String(installResult.exitCode)}: ${bounded(installResult.stderr)}`);
      }
      if (!existsSync(join(installDir, 'node_modules'))) {
        problem('clean-install-offline', 'node_modules missing after npm install');
      }
      for (const linkProblem of verifyNoEscapingLinks(installDir)) {
        problem('clean-install-offline', linkProblem);
      }

      // 3b) 打包入口与运行时依赖清单。
      const binEntry = join(installDir, 'node_modules', 'shiploop-cli', 'dist', 'bin.js');
      const present = existsSync(binEntry);
      let shebang = false;
      let executable = false;
      if (present) {
        try {
          shebang = readFileSync(binEntry, 'utf8').slice(0, 32).startsWith('#!/usr/bin/env node');
        } catch {
          shebang = false;
        }
        executable = (statSync(binEntry).mode & 0o111) !== 0;
      } else {
        problem('packaged-entry-startable', 'packaged bin entry node_modules/shiploop-cli/dist/bin.js missing');
      }
      entryFacts = { present, shebang, executable };
      binLinkPresent = existsSync(join(installDir, 'node_modules', '.bin', 'shiploop'));
      if (present && (!shebang || !executable)) {
        problem('packaged-entry-startable', `packaged bin entry invalid (shebang=${String(shebang)}, executable=${String(executable)})`);
      }
      if (!binLinkPresent) {
        problem('packaged-entry-startable', 'node_modules/.bin/shiploop bin link missing');
      }
      runtimeDependencies = inventoryRuntimeDependencies(installDir);
      for (const pkg of PACKAGES) {
        const installed = runtimeDependencies.find((dep) => dep.name === pkg.name);
        const expectedVersion = artifacts.find((artifact) => artifact.name === pkg.name)?.version;
        if (installed === undefined) {
          problem('runtime-dependency-inventory', `workspace package ${pkg.name} missing from installed tree`);
        } else if (expectedVersion !== undefined && installed.version !== expectedVersion) {
          problem('runtime-dependency-inventory', `workspace package ${pkg.name} version ${installed.version} != manifest ${expectedVersion}`);
        }
      }

      // 3c) 打包模式 + 源码模式最小协议序列。
      if (present) {
        const installFacts = runModeSequence(
          options.ports,
          { mode: 'install', bin: binEntry, dataRoot: installDataRoot, emptyRoot: installEmptyRoot, sandbox, sandboxHome },
          captured,
        );
        installRun = installFacts.run;
        secrets.push(...installFacts.secrets);
        if (installRun.protocol.startOutcome !== 'started' || installRun.commands[0]!.ok !== true) {
          problem('packaged-entry-startable', 'packaged CLI did not complete a started handshake receipt');
        }
      }
      const sourceBin = options.sourceCliBin === undefined ? null : resolve(options.sourceCliBin);
      if (sourceBin === null || !existsSync(sourceBin)) {
        problem('protocol-consistency-with-source', 'source baseline bin missing (run npm run build or pass --source-bin)');
      } else {
        const sourceFacts = runModeSequence(
          options.ports,
          { mode: 'source', bin: sourceBin, dataRoot: sourceDataRoot, emptyRoot: sourceEmptyRoot, sandbox, sandboxHome },
          captured,
        );
        sourceRun = sourceFacts.run;
        secrets.push(...sourceFacts.secrets);
      }

      // 3d) 数据根隔离。
      for (const modeRun of [installRun, sourceRun]) {
        if (modeRun === null) continue;
        if (!modeRun.dataRoot.discoveryPresentAfterStart) {
          problem('isolated-data-root', `${modeRun.mode}: discovery missing under the isolated data root after start`);
        }
      }
      if (installRun === null || sourceRun === null) {
        problem('isolated-data-root', 'mode run missing; isolation comparison not executed');
      } else {
        if (installRun.dataRoot.identity !== null && installRun.dataRoot.identity === sourceRun.dataRoot.identity) {
          problem('isolated-data-root', 'install and source data roots share the same identity');
        }
        if (
          installRun.protocol.startHostInstanceId !== null &&
          installRun.protocol.startHostInstanceId === sourceRun.protocol.startHostInstanceId
        ) {
          problem('isolated-data-root', 'install and source runs reported the same hostInstanceId');
        }
      }

      // 3e) 最小命令回执契约。
      for (const modeRun of [installRun, sourceRun]) {
        if (modeRun === null) continue;
        const [startRecord, statusRecord, refusalRecord, stopRecord] = modeRun.commands;
        const expectedDataRootIdentity = (() => {
          try {
            return hashHex(realpathSync(modeRun.mode === 'install' ? installDataRoot : sourceDataRoot));
          } catch {
            return null;
          }
        })();
        const startResult = startRecord.ok === true && isObject(startRecord.result) ? startRecord.result : null;
        if (startRecord!.exitCode !== 0 || startRecord!.ok !== true || startRecord!.command !== 'host.start') {
          problem('minimal-command-receipt', `${modeRun.mode}: host.start exit=${String(startRecord!.exitCode)} ok=${String(startRecord!.ok)}`);
        } else {
          if (asString(startResult!.outcome) !== 'started') problem('minimal-command-receipt', `${modeRun.mode}: host.start outcome != started`);
          if (asNumber(startResult!.protocolVersion) === null) problem('minimal-command-receipt', `${modeRun.mode}: host.start protocolVersion missing`);
          if (asString(startResult!.lifecycleState) !== 'ready') problem('minimal-command-receipt', `${modeRun.mode}: host.start lifecycleState != ready`);
          if (asString(startResult!.listenAddress) !== '127.0.0.1') problem('minimal-command-receipt', `${modeRun.mode}: host.start listenAddress != 127.0.0.1`);
          const port = asNumber(startResult!.port);
          if (port === null || port < 1 || port > 65535) problem('minimal-command-receipt', `${modeRun.mode}: host.start port invalid`);
          const identity = modeRun.dataRoot.identity;
          if (identity === null || !/^[0-9a-f]{64}$/.test(identity)) {
            problem('minimal-command-receipt', `${modeRun.mode}: host.start dataRootIdentity not sha256-hex`);
          } else if (expectedDataRootIdentity !== null && identity !== expectedDataRootIdentity) {
            problem('minimal-command-receipt', `${modeRun.mode}: host.start dataRootIdentity does not match the canonical data root`);
          }
        }
        if (statusRecord!.exitCode !== 0 || statusRecord!.ok !== true || statusRecord!.command !== 'host.status') {
          problem('minimal-command-receipt', `${modeRun.mode}: host.status exit=${String(statusRecord!.exitCode)} ok=${String(statusRecord!.ok)}`);
        } else if (
          modeRun.protocol.startHostInstanceId === null ||
          modeRun.protocol.statusHostInstanceId !== modeRun.protocol.startHostInstanceId
        ) {
          problem('minimal-command-receipt', `${modeRun.mode}: host.status did not report the same instance identity`);
        }
        if (refusalRecord!.exitCode !== 3 || refusalRecord!.ok !== false || refusalRecord!.errorCode !== 'host_not_found') {
          problem(
            'minimal-command-receipt',
            `${modeRun.mode}: refusal exit=${String(refusalRecord!.exitCode)} ok=${String(refusalRecord!.ok)} code=${String(refusalRecord!.errorCode)}`,
          );
        }
        if (stopRecord!.exitCode !== 0 || stopRecord!.ok !== true || modeRun.protocol.stopStatus !== 'stopped') {
          problem('minimal-command-receipt', `${modeRun.mode}: host.stop exit=${String(stopRecord!.exitCode)} status=${String(modeRun.protocol.stopStatus)}`);
        }
        if (modeRun.dataRoot.discoveryRemovedAfterStop !== true) {
          problem('minimal-command-receipt', `${modeRun.mode}: discovery not removed after confirmed stop`);
        }
      }

      // 3f) 实测协议范围与声明一致（缺声明时不得静默跳过）。
      if (scope === null) {
        problem('protocol-scope-consistent', 'compatibility scope missing (see compatibility-declared)');
      } else if (installRun === null) {
        problem('protocol-scope-consistent', 'install-mode run missing; observed protocol unavailable');
      } else {
        const wire = scope.hostProtocol.wireProtocolVersions;
        const discoveryVersions = scope.hostProtocol.discoverySchemaVersions;
        if (installRun.protocol.startProtocolVersion === null || !wire.includes(installRun.protocol.startProtocolVersion)) {
          problem('protocol-scope-consistent', `observed start protocolVersion ${String(installRun.protocol.startProtocolVersion)} outside declared ${JSON.stringify([...wire])}`);
        }
        if (installRun.protocol.discoveryProtocolVersion === null || !wire.includes(installRun.protocol.discoveryProtocolVersion)) {
          problem('protocol-scope-consistent', `observed discovery protocolVersion outside declared ${JSON.stringify([...wire])}`);
        }
        if (installRun.protocol.discoverySchemaVersion === null || !discoveryVersions.includes(installRun.protocol.discoverySchemaVersion)) {
          problem('protocol-scope-consistent', `observed discovery schemaVersion outside declared ${JSON.stringify([...discoveryVersions])}`);
        }
      }

      // 3g) 打包/源码协议一致性。
      if (installRun !== null && sourceRun !== null) {
        consistency = compareTodoInstallProtocol(installRun, sourceRun);
        for (const difference of consistency.differences) {
          problem('protocol-consistency-with-source', difference);
        }
      }

      // 3h) 凭据与输出边界。
      for (const modeRun of [installRun, sourceRun]) {
        if (modeRun === null) continue;
        if (!modeRun.dataRoot.tokenFile.present) {
          problem('secret-handling', `${modeRun.mode}: auth token file missing under data root`);
        } else {
          if (!modeRun.dataRoot.tokenFile.hex64) problem('secret-handling', `${modeRun.mode}: auth token is not 64 lowercase hex`);
          if (modeRun.dataRoot.tokenFile.mode !== '600') {
            problem('secret-handling', `${modeRun.mode}: auth token file mode ${String(modeRun.dataRoot.tokenFile.mode)} != 600`);
          }
        }
      }
      for (const secret of secrets) {
        for (const output of captured) {
          if (output.text.includes(secret)) {
            problem('secret-handling', `auth token material appeared in command output (${output.label})`);
            break;
          }
        }
      }
      const pathPatterns = [sandbox, realpathSafe(sandbox), tmpdir(), realpathSafe(tmpdir()), '/Users/'].filter(
        (value): value is string => value !== null,
      );
      for (const output of captured) {
        for (const pattern of pathPatterns) {
          if (output.text.includes(pattern)) {
            problem('output-hygiene', `absolute path material appeared in command output (${output.label})`);
            break;
          }
        }
        if (output.text.includes('Bearer ')) {
          problem('output-hygiene', `authorization header material appeared in command output (${output.label})`);
        }
      }
    } else {
      for (const id of BEHAVIORAL_CHECK_IDS) {
        problem(id, 'blocked_by:distribution-inputs');
      }
    }
  } finally {
    if (options.keepSandbox !== true) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // 4) 组装报告；报告本身再做一次脱敏扫描（report-hygiene）。
  const buildReport = (): TodoInstallSmokeReport => {
    const checks: TodoInstallSmokeCheck[] = TODO_INSTALL_SMOKE_CHECK_IDS.map((id) => {
      const draft = drafts.get(id)!;
      return { id, title: draft.title, status: draft.problems.length > 0 ? 'failed' : 'passed', objects: draft.objects, problems: draft.problems };
    });
    const passedCount = checks.filter((check) => check.status === 'passed').length;
    return {
      schemaVersion: 1,
      kind: 'shiploop.todo-install-smoke',
      generatedAt: new Date().toISOString(),
      passed: passedCount === checks.length,
      environment: options.ports.environment,
      inputs: {
        distribution: labelFor(distributionDir, options.repoRoot),
        distributionManifestSha256: (() => {
          try {
            return hashHex(readFileSync(manifestPath));
          } catch {
            return null;
          }
        })(),
        compatibility: compatibility === null ? null : { label: compatibility.label, sha256: compatibility.sha256 },
        artifacts,
      },
      install: {
        mode: 'offline-local-tarballs',
        installDirLabel: 'clean-install',
        npmExitCode,
        binLinkPresent,
        entry: entryFacts,
        runtimeDependencies,
      },
      runs: { installMode: installRun, sourceMode: sourceRun, consistency },
      protocol: {
        declared:
          scope === null
            ? null
            : {
                wireProtocolVersions: [...scope.hostProtocol.wireProtocolVersions],
                wireSchemaVersion: scope.hostProtocol.wireSchemaVersion,
                discoverySchemaVersions: [...scope.hostProtocol.discoverySchemaVersions],
              },
      },
      checks,
      notRun: TODO_INSTALL_SMOKE_NOT_RUN.map((item) => ({ ...item, owner: 'phase-integration' as const })),
      summary: { passed: passedCount, failed: checks.length - passedCount, notRun: TODO_INSTALL_SMOKE_NOT_RUN.length },
    };
  };

  let report = buildReport();
  const hygienePatterns = [sandbox, realpathSafe(sandbox), tmpdir(), realpathSafe(tmpdir()), '/Users/', 'Bearer ', ...(options.repoRoot !== undefined ? [resolve(options.repoRoot)] : [])].filter(
    (value): value is string => value !== null,
  );
  const reportMaterial = JSON.stringify(report);
  let hygieneViolated = false;
  for (const secret of secrets) {
    if (reportMaterial.includes(secret)) {
      problem('report-hygiene', 'auth token material appeared in the report');
      hygieneViolated = true;
      break;
    }
  }
  if (!hygieneViolated) {
    for (const pattern of hygienePatterns) {
      if (reportMaterial.includes(pattern)) {
        problem('report-hygiene', 'absolute path material appeared in the report');
        hygieneViolated = true;
        break;
      }
    }
  }
  if (hygieneViolated) {
    report = buildReport();
  }
  return report;
}

export function renderTodoInstallSmokeText(report: TodoInstallSmokeReport): string {
  const lines: string[] = [];
  lines.push(
    `todo-install-smoke: passed=${report.summary.passed} failed=${report.summary.failed} not_run=${report.summary.notRun} => ${report.passed ? 'OK' : 'FAILED'}`,
  );
  for (const check of report.checks) {
    lines.push(`[${check.status === 'passed' ? 'PASS' : 'FAIL'}] ${check.id} — ${check.title}`);
    for (const item of check.problems) {
      lines.push(`  - ${item}`);
    }
  }
  for (const item of report.notRun) {
    lines.push(`[NOT-RUN] ${item.id}: ${item.reason}`);
  }
  lines.push(
    `environment: commit=${report.environment.gitCommit} node=${report.environment.nodeVersion} npm=${report.environment.npmVersion} platform=${report.environment.platform}`,
  );
  return lines.join('\n');
}

/** 报告复核：结构、状态词汇、summary/passed 一致性与脱敏边界；违规即拒绝。 */
export function validateTodoInstallSmokeReport(value: unknown): TodoInstallSmokeReport {
  if (!isObject(value)) throw new TodoInstallSmokeError('report_shape_invalid');
  if (value.schemaVersion !== 1 || value.kind !== 'shiploop.todo-install-smoke' || typeof value.generatedAt !== 'string') {
    throw new TodoInstallSmokeError('report_shape_invalid');
  }
  if (typeof value.passed !== 'boolean' || !Array.isArray(value.checks) || !Array.isArray(value.notRun)) {
    throw new TodoInstallSmokeError('report_shape_invalid');
  }
  const environment = value.environment;
  if (
    !isObject(environment) ||
    typeof environment.gitCommit !== 'string' ||
    typeof environment.nodeVersion !== 'string' ||
    typeof environment.npmVersion !== 'string' ||
    typeof environment.platform !== 'string'
  ) {
    throw new TodoInstallSmokeError('report_shape_invalid');
  }
  const checkIds: string[] = [];
  let passedCount = 0;
  for (const check of value.checks) {
    if (
      !isObject(check) ||
      typeof check.id !== 'string' ||
      typeof check.title !== 'string' ||
      (check.status !== 'passed' && check.status !== 'failed') ||
      !Array.isArray(check.problems) ||
      !check.problems.every((item) => typeof item === 'string')
    ) {
      throw new TodoInstallSmokeError('report_status_vocabulary_invalid');
    }
    if (check.status === 'passed' && check.problems.length > 0) throw new TodoInstallSmokeError('report_status_vocabulary_invalid');
    checkIds.push(check.id);
    if (check.status === 'passed') passedCount += 1;
  }
  if (JSON.stringify(checkIds) !== JSON.stringify(TODO_INSTALL_SMOKE_CHECK_IDS)) {
    throw new TodoInstallSmokeError('report_shape_invalid');
  }
  for (const item of value.notRun) {
    if (!isObject(item) || typeof item.id !== 'string' || item.owner !== 'phase-integration') {
      throw new TodoInstallSmokeError('report_shape_invalid');
    }
  }
  const summary = value.summary;
  const expectedSummary = { passed: passedCount, failed: value.checks.length - passedCount, notRun: value.notRun.length };
  if (
    !isObject(summary) ||
    summary.passed !== expectedSummary.passed ||
    summary.failed !== expectedSummary.failed ||
    summary.notRun !== expectedSummary.notRun
  ) {
    throw new TodoInstallSmokeError('report_summary_inconsistent');
  }
  if (value.passed !== (passedCount === value.checks.length)) throw new TodoInstallSmokeError('report_passed_inconsistent');
  const serialized = JSON.stringify(value);
  if (serialized.includes('/Users/') || serialized.includes('Bearer ') || serialized.includes(tmpdir())) {
    throw new TodoInstallSmokeError('report_hygiene_violation');
  }
  return value as unknown as TodoInstallSmokeReport;
}

export function saveTodoInstallSmokeReport(path: string, report: TodoInstallSmokeReport): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** ---------- CLI 入口（真实三包产物执行；前置 npm ci/build/pack:local） ---------- */

function loadCompatibilityInput(repoRoot: string): TodoInstallCompatibilityInput {
  const path = join(repoRoot, 'distribution-compatibility.json');
  if (!existsSync(path)) throw new TodoInstallSmokeError('compatibility_file_missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TodoInstallSmokeError('compatibility_file_unreadable');
  }
  if (!isObject(parsed) || !isObject(parsed.hostProtocol)) throw new TodoInstallSmokeError('compatibility_scope_invalid');
  const hostProtocol = parsed.hostProtocol as Record<string, unknown>;
  const databaseSchema = isObject(parsed.databaseSchema) ? (parsed.databaseSchema as TodoInstallCompatibilityScope['databaseSchema']) : undefined;
  const scope: TodoInstallCompatibilityScope = {
    hostProtocol: {
      wireProtocolVersions: Array.isArray(hostProtocol.wireProtocolVersions) ? (hostProtocol.wireProtocolVersions as number[]) : [],
      wireSchemaVersion: typeof hostProtocol.wireSchemaVersion === 'number' ? hostProtocol.wireSchemaVersion : Number.NaN,
      discoverySchemaVersions: Array.isArray(hostProtocol.discoverySchemaVersions) ? (hostProtocol.discoverySchemaVersions as number[]) : [],
    },
    ...(databaseSchema !== undefined ? { databaseSchema } : {}),
  };
  return { label: 'distribution-compatibility.json', sha256: hashHex(readFileSync(path)), scope };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let input: string | undefined;
  let output: string | undefined;
  let repoRootArg: string | undefined;
  let sourceBinArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input' && args[index + 1] !== undefined) input = args[++index];
    else if (arg === '--output' && args[index + 1] !== undefined) output = args[++index];
    else if (arg === '--repo-root' && args[index + 1] !== undefined) repoRootArg = args[++index];
    else if (arg === '--source-bin' && args[index + 1] !== undefined) sourceBinArg = args[++index];
    else {
      process.stderr.write(`todo-install-smoke: 未知参数 ${arg}（支持 --input/--output/--repo-root/--source-bin）\n`);
      process.exit(2);
    }
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(repoRootArg ?? resolve(scriptDir, '..', '..'));
  if (process.platform !== 'darwin') {
    process.stderr.write('todo-install-smoke: 仅支持在声明平台 darwin 上执行\n');
    process.exit(2);
  }
  const distributionDir = resolve(input ?? join(repoRoot, 'artifacts/local-pack'));
  if (!existsSync(join(distributionDir, 'distribution-manifest.json'))) {
    process.stderr.write('todo-install-smoke: 缺少分发清单；先执行 npm run pack:local -- --output <dir>\n');
    process.exit(2);
  }
  const compatibility = loadCompatibilityInput(repoRoot);
  const sourceBin = resolve(sourceBinArg ?? join(repoRoot, 'packages/cli/dist/bin.js'));
  if (!existsSync(sourceBin)) {
    process.stderr.write('todo-install-smoke: 源码模式基线缺失（packages/cli/dist/bin.js）；先执行 npm run build\n');
    process.exit(2);
  }
  const ports = createProcessTodoInstallSmokePorts({ repoRoot });
  if (ports.environment.platform !== 'darwin' || ports.environment.nodeVersion !== '22.19.0' || ports.environment.npmVersion !== '10.9.3') {
    process.stderr.write(
      `todo-install-smoke: 工具链漂移 node=${ports.environment.nodeVersion} npm=${ports.environment.npmVersion} platform=${ports.environment.platform}（固定 22.19.0/10.9.3/darwin）\n`,
    );
    process.exit(2);
  }
  const report = await runTodoInstallSmoke({ distributionDir, sourceCliBin: sourceBin, compatibility, ports, repoRoot });
  const reportPath = resolve(output ?? join(distributionDir, 'todo-install-smoke.json'));
  saveTodoInstallSmokeReport(reportPath, report);
  process.stdout.write(`${renderTodoInstallSmokeText(report)}\n`);
  process.stdout.write(`todo-install-smoke: report ${reportPath}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await main().catch((error: unknown) => {
    const reason = error instanceof TodoInstallSmokeError ? error.reason : error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
    process.exit(2);
  });
}
