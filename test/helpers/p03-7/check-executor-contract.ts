/**
 * P03-7 / F-015 跨检查执行器契约共享测试支持（仅测试装配，不进 packages/）。
 *
 * 目的：参数化同一组「选择与验收协议」契约用例，证明协议不依赖 Node 测试目录、
 * npm 约定或任何语言特例。两种执行器共用同一套夹具与断言面：
 *
 * - `shiploop.node-check-executor`：真实 Node 执行器（生产
 *   `createNodeTaskVerificationExecutor`）经真实受监督 Node 进程执行可信
 *   CheckDefinition argv，产出真实输出制品、覆盖报告与逐项结果。
 * - `shiploop.trusted-test-executor`：受信测试执行器（确定性测试替身，仅用于
 *   契约）。它**不**代表已实现任何 Python/Java adapter，也**不**安装额外语言
 *   工具链；其 argv 永不真正启动（如 `python3 -m pytest` 只是可信定义样例），
 *   目标标识允许非 Node 形态，用于证明选择/结果协议对目标标识无语言假设。
 *
 * 复用已交付积木，不复制整套资源夹具：
 * - ports/verification-candidates + adapters/fs/verification-target-resolver：模块/目标解析；
 * - application/verification-plan：局部/全量选择计划；
 * - application/node-task-verification：真实 Node 执行器与共享结果协议校验
 *   （validateNodeCheckReport，两种执行器使用同一协议校验器）；
 * - application/verification-aggregate：机器验收聚合；
 * - test/helpers/in-memory-store：内存 ArtifactStore（真实端口校验/CAS 语义）；
 * - adapters/fs/artifact-files + adapters/process/command-process：真实制品文件与受监督进程。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createTestTargetResolver } from '../../../packages/core/src/adapters/fs/verification-target-resolver.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import {
  createNodeTaskVerificationExecutor,
  validateNodeCheckReport,
} from '../../../packages/core/src/application/node-task-verification.ts';
import type {
  NodeTaskVerificationInput,
  NodeTaskVerificationResult,
} from '../../../packages/core/src/application/node-task-verification.ts';
import { buildVerificationPlan } from '../../../packages/core/src/application/verification-plan.ts';
import type { VerificationPlan } from '../../../packages/core/src/application/verification-plan.ts';
import { aggregateMachineVerification } from '../../../packages/core/src/application/verification-aggregate.ts';
import type { TestCandidateSelection } from '../../../packages/core/src/application/verification-candidates.ts';
import type {
  MachineVerificationInput,
  MachineVerificationResult,
} from '../../../packages/core/src/ports/verification-aggregate.ts';
import {
  computeTestCandidateDigest,
  validateTestCandidatePayload,
} from '../../../packages/core/src/ports/verification-candidates.ts';
import type { CheckResultEvidence } from '../../../packages/core/src/ports/verification-store.ts';
import { createInMemoryStorage } from '../in-memory-store.ts';
import { createTempSandbox } from '../temp-sandbox.ts';

export const CONTRACT_PROJECT_ID = 'proj-1';
export const CONTRACT_ATTEMPT_ID = 'attempt-1';
export const CONTRACT_CODE_DIGEST = 'ab'.repeat(32);
export const CONTRACT_POLICY_DIGEST = 'cd'.repeat(32);

// ---------------------------------------------------------------------------
// 执行器声明与选择（未知执行器 / 未声明目标能力 fail-closed）
// ---------------------------------------------------------------------------

/** 执行器声明的目标能力：仓库相对路径目标 / 任意非 Node 风格标识。 */
export type TargetCapability = 'repository-path' | 'opaque-identifier';

// 不含保留字符（如 `:`，pytest node-id / 逻辑标识）的安全相对路径词法；其余为非 Node 风格标识。
const SAFE_RELATIVE_PATH = /^(?!-)[^\0-\x1f\x7f/:]+(?:\/[^\0-\x1f\x7f/:]+)*$/;

export function classifyContractTarget(target: string): TargetCapability {
  return SAFE_RELATIVE_PATH.test(target) ? 'repository-path' : 'opaque-identifier';
}

export interface CheckExecutorDescriptor {
  readonly executorId: string;
  readonly declaredTargetCapabilities: readonly TargetCapability[];
}

export type CheckExecutorSelectionRejection = 'unknown_executor' | 'undeclared_target_capability';

export class CheckExecutorSelectionError extends Error {
  readonly reason: CheckExecutorSelectionRejection;
  constructor(reason: CheckExecutorSelectionRejection, detail: string) {
    super(`CheckExecutor.select: ${reason}: ${detail}`);
    this.name = 'CheckExecutorSelectionError';
    this.reason = reason;
  }
}

/** 已声明的检查执行器目录。未登记的执行器（如未来 Python/Java adapter）一律拒绝。 */
export const CHECK_EXECUTOR_CATALOG: readonly CheckExecutorDescriptor[] = [
  { executorId: 'shiploop.node-check-executor', declaredTargetCapabilities: ['repository-path'] },
  {
    executorId: 'shiploop.trusted-test-executor',
    declaredTargetCapabilities: ['repository-path', 'opaque-identifier'],
  },
];

/**
 * 契约选择面：未知执行器、超出已声明目标能力的目标集合都拒绝返回执行器。
 * 该守卫与真实计划/结果协议拒绝共同覆盖「未知执行器、未声明目标能力不放行」。
 */
export function selectCheckExecutor(
  executorId: string,
  targets: readonly string[],
  catalog: readonly CheckExecutorDescriptor[] = CHECK_EXECUTOR_CATALOG,
): CheckExecutorDescriptor {
  const descriptor = catalog.find((item) => item.executorId === executorId);
  if (descriptor === undefined) {
    throw new CheckExecutorSelectionError('unknown_executor', `未登记的检查执行器 ${executorId}`);
  }
  const undeclared = targets.filter((target) => !descriptor.declaredTargetCapabilities.includes(classifyContractTarget(target)));
  if (undeclared.length > 0) {
    throw new CheckExecutorSelectionError(
      'undeclared_target_capability',
      `执行器 ${executorId} 未声明目标能力：${undeclared.join(',')}`,
    );
  }
  return descriptor;
}

// ---------------------------------------------------------------------------
// 结果协议场景（两种执行器共用同一报告与拒绝语义）
// ---------------------------------------------------------------------------

export type ContractScenario = 'pass' | 'zero-tests' | 'incomplete-coverage' | 'invalid-protocol';

export const CONTRACT_SCENARIOS: readonly ContractScenario[] = [
  'pass',
  'zero-tests',
  'incomplete-coverage',
  'invalid-protocol',
];

/** 场景 → 共享协议校验器（validateNodeCheckReport）拒绝码；pass 无拒绝。 */
export const SCENARIO_PROTOCOL_REJECTION: Readonly<Record<ContractScenario, string | null>> = {
  pass: null,
  'zero-tests': 'testCount',
  'incomplete-coverage': 'target_coverage',
  'invalid-protocol': 'protocol_or_collection',
};

/** 场景报告 payload：覆盖目标集合（或故意不完整/不合法），协议字段不带任何语言语义。 */
export function scenarioReportPayload(scenario: ContractScenario, targets: readonly string[]): Record<string, unknown> {
  const base = { schemaVersion: 1, protocol: 'shiploop.node-check', collected: true, testCount: 3, targets: [...targets] };
  switch (scenario) {
    case 'pass':
      return base;
    case 'zero-tests':
      return { ...base, testCount: 0 };
    case 'incomplete-coverage':
      return { ...base, targets: [...targets.slice(0, -1)] };
    case 'invalid-protocol':
      return { ...base, protocol: 'shiploop.unknown-check' };
    default: {
      const never: never = scenario;
      throw new Error(`unknown scenario ${String(never)}`);
    }
  }
}

export const RESULT_LINE_PREFIX = 'SHIPLOOP_NODE_CHECK_RESULT=';

function nodeCheckScript(report: Record<string, unknown>, exitCode: number): string {
  return [
    "console.log('contract check output');",
    `console.log(${JSON.stringify(RESULT_LINE_PREFIX + JSON.stringify(report))});`,
    `process.exit(${exitCode});`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 共享执行器契约面
// ---------------------------------------------------------------------------

export interface ContractCheckExecutor {
  readonly executorId: string;
  readonly declaredTargetCapabilities: readonly TargetCapability[];
  start(input: NodeTaskVerificationInput): Promise<NodeTaskVerificationResult>;
}

/** 逐项结果最小观察面：两种执行器必须同语义（状态/拒绝原因/输出引用/覆盖计数）。 */
export interface ContractCheckOutcome {
  readonly checkKey: string;
  readonly status: string;
  readonly reason: string | null;
  readonly resultId: string;
  readonly testCount: number | null;
  readonly outputArtifactId: string | null;
}

export function outcomeOf(result: NodeTaskVerificationResult): readonly ContractCheckOutcome[] {
  return result.results.map((item) => ({
    checkKey: item.checkKey,
    status: item.status,
    reason: item.reason,
    resultId: item.resultId,
    testCount: item.testCount,
    outputArtifactId: item.evidence?.output?.artifactId ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 记录型 VerificationStore / AtomicCommandStore（保留真实保存形状）
// ---------------------------------------------------------------------------

export interface RecordingVerificationStoreApi {
  createVerificationBatchInTransaction(tx: unknown, input: Record<string, unknown>): { batch: { revision: number }; created: boolean };
  getVerificationBatch(projectId: string, batchId: string): { revision: number; status: string };
  listCheckResults(projectId: string, batchId: string): readonly Record<string, unknown>[];
  saveCheckResultInTransaction(tx: unknown, input: Record<string, unknown>): { result: { id: string; status: string } };
  finalizeVerificationBatchInTransaction(tx: unknown, input: Record<string, unknown>): { status: string };
}

export interface RecordingVerificationStore {
  readonly batches: Array<{ input: Record<string, unknown>; status: string; revision: number }>;
  readonly results: Array<Record<string, unknown>>;
  readonly store: RecordingVerificationStoreApi;
  batchInput(): Record<string, unknown>;
  resultRecords(): readonly Record<string, unknown>[];
}

function createRecordingVerificationStore(): RecordingVerificationStore {
  const batches: RecordingVerificationStore['batches'] = [];
  const results: RecordingVerificationStore['results'] = [];
  const store: RecordingVerificationStoreApi = {
    createVerificationBatchInTransaction(_tx: unknown, input: Record<string, unknown>) {
      batches.push({ input, status: 'running', revision: 1 });
      return { batch: { revision: 1 }, created: true };
    },
    getVerificationBatch(_projectId: string, batchId: string) {
      const batch = batches.find((item) => item.input.batchId === batchId);
      return { revision: batch?.revision ?? 1, status: batch?.status ?? 'running' };
    },
    listCheckResults(_projectId: string, batchId: string) {
      return results.filter((item) => item.batchId === batchId);
    },
    saveCheckResultInTransaction(_tx: unknown, input: Record<string, unknown>) {
      results.push(input);
      return { result: { id: String(input.resultId), status: String(input.status) } };
    },
    finalizeVerificationBatchInTransaction(_tx: unknown, input: Record<string, unknown>) {
      const batch = batches.find((item) => item.input.batchId === input.batchId);
      if (batch) batch.status = String(input.status);
      return { status: String(input.status) };
    },
  };
  return {
    batches,
    results,
    store,
    batchInput: () => batches[0]?.input ?? {},
    resultRecords: () => results,
  };
}

const ATOMIC_STUB = { transact: (_operation: string, callback: (tx: unknown) => unknown) => callback({}) };

// ---------------------------------------------------------------------------
// 样式参数化（Node 风格 vs 非 Node 风格）
// ---------------------------------------------------------------------------

export interface ContractStyle {
  readonly styleId: 'node' | 'trusted-test';
  readonly executorId: string;
  readonly moduleKey: string;
  readonly moduleCheckKey: string;
  readonly quickCheckKey: string;
  readonly optionalCheckKey: string;
  readonly allowedTargets: readonly string[];
  readonly impactScope: readonly string[];
  readonly sharedHighRiskFiles: readonly string[];
  /** 候选/计划/报告目标标识：node 为 Node 测试文件；trusted-test 为非 Node 风格目标。 */
  readonly targets: readonly string[];
  readonly changedPath: string;
  /** 工作区内需创建的真实文件/目录（目标解析要求目标存在）。 */
  readonly workspaceFiles: readonly string[];
  readonly workspaceDirs: readonly string[];
  /** 政策未声明（allowedTargets 之外）的真实目标：用于未声明目标拒绝用例。 */
  readonly outsideTarget: string;
  /** 可信 argv（候选永不产生命令）；node 风格真实执行，trusted-test 风格永不启动。 */
  readonly argv: (scenario: ContractScenario, targets: readonly string[]) => Record<string, readonly string[]>;
}

export const CONTRACT_STYLES: readonly ContractStyle[] = [
  {
    styleId: 'node',
    executorId: 'shiploop.node-check-executor',
    moduleKey: 'core',
    moduleCheckKey: 'unit-core',
    quickCheckKey: 'quick',
    optionalCheckKey: 'docs-optional',
    allowedTargets: ['packages/core'],
    impactScope: ['packages/core'],
    sharedHighRiskFiles: ['package.json'],
    targets: ['packages/core/tests/unit/a.test.ts', 'packages/core/tests/integration/b.test.ts'],
    changedPath: 'packages/core/src/a.ts',
    workspaceFiles: [
      'packages/core/src/a.ts',
      'packages/core/tests/unit/a.test.ts',
      'packages/core/tests/integration/b.test.ts',
      'packages/cli/src/main.ts',
    ],
    workspaceDirs: [],
    outsideTarget: 'packages/cli/src/main.ts',
    argv: (scenario, targets) => ({
      'unit-core': [process.execPath, '-e', nodeCheckScript(scenarioReportPayload(scenario, targets), 0)],
      quick: [process.execPath, '-e', nodeCheckScript(scenarioReportPayload(scenario, targets), 0)],
      'docs-optional': [process.execPath, '-e', nodeCheckScript(scenarioReportPayload(scenario, targets), 0)],
    }),
  },
  {
    styleId: 'trusted-test',
    executorId: 'shiploop.trusted-test-executor',
    moduleKey: 'suite',
    moduleCheckKey: 'suite-tests',
    quickCheckKey: 'quick-check',
    optionalCheckKey: 'report-optional',
    allowedTargets: ['tests', 'suites'],
    impactScope: ['tests', 'suites'],
    sharedHighRiskFiles: [],
    targets: ['tests/test_alpha.py', 'suites/unit'],
    changedPath: 'tests/test_alpha.py',
    workspaceFiles: ['tests/test_alpha.py', 'docs/notes.md'],
    workspaceDirs: ['suites/unit'],
    outsideTarget: 'docs/notes.md',
    // 非 Node 风格可信 argv：Core 不重写为 node/npm，执行器契约也不解析其语言语义。
    argv: () => ({
      'suite-tests': ['python3', '-m', 'pytest', 'tests/test_alpha.py', 'suites/unit'],
      'quick-check': ['make', 'quick'],
      'report-optional': ['make', 'report'],
    }),
  },
];

export function contractStyle(styleId: ContractStyle['styleId']): ContractStyle {
  const style = CONTRACT_STYLES.find((item) => item.styleId === styleId);
  if (style === undefined) throw new Error(`unknown style ${styleId}`);
  return style;
}

// ---------------------------------------------------------------------------
// 受信测试执行器（确定性测试替身；仅契约用途）
// ---------------------------------------------------------------------------

interface ArtifactPorts {
  readonly artifacts: ReturnType<typeof createInMemoryStorage>['artifactStore'];
  readonly files: ReturnType<typeof createArtifactFileStore>;
}

async function publishOutput(
  ports: ArtifactPorts,
  text: string,
): Promise<{ artifactId: string; projectId: string; contentHash: string; sizeBytes: number; locator: string; version: number }> {
  const body = Buffer.from(text, 'utf8');
  const publisher = createArtifactPublisher({
    artifacts: ports.artifacts,
    files: ports.files,
    limits: { maxSizeBytes: 65_536, timeoutMs: 10_000 },
  });
  const published = await publisher.publishArtifact({
    projectId: CONTRACT_PROJECT_ID,
    kind: 'verification-output',
    mediaType: 'text/plain; charset=utf-8',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `verification/${randomUUID()}/output`,
    content: [body],
  });
  const record = published.artifact;
  return {
    artifactId: record.id,
    projectId: record.projectId,
    contentHash: record.contentHash as string,
    sizeBytes: record.sizeBytes as number,
    locator: record.locator,
    version: record.version,
  };
}

export interface TrustedTestExecutorOptions extends ArtifactPorts {
  readonly recording: RecordingVerificationStore;
  /** 场景化脚本结果：每个检查的退出码与报告（报告经共享协议校验器核验）。 */
  readonly scenario: ContractScenario;
  readonly nowUtcMs?: () => number;
}

/**
 * 受信测试执行器：确定性替身，行为与真实 Node 执行器共享同一结果协议
 * （validateNodeCheckReport）与逐项保存形状。不启动任何进程、不安装语言工具链。
 */
export function createTrustedTestExecutor(options: TrustedTestExecutorOptions): ContractCheckExecutor {
  const now = options.nowUtcMs ?? Date.now;
  return {
    executorId: 'shiploop.trusted-test-executor',
    declaredTargetCapabilities: ['repository-path', 'opaque-identifier'],
    async start(input: NodeTaskVerificationInput): Promise<NodeTaskVerificationResult> {
      const checks = input.plan.selectedChecks;
      options.recording.store.createVerificationBatchInTransaction({}, {
        batchId: input.batchId,
        projectId: input.projectId,
        checkSnapshot: checks.map((check) => ({
          checkKey: check.checkKey, argv: [...check.argv], cwdRef: check.cwdRef,
          environmentRef: check.environmentRef, timeout: check.timeout,
          required: check.required, scope: check.scope, kind: check.kind,
        })),
      });
      const results: Array<NodeTaskVerificationResult['results'][number]> = [];
      if (input.plan.status !== 'ready' || checks.length === 0) {
        for (const check of checks) {
          const saved = options.recording.store.saveCheckResultInTransaction({}, {
            resultId: randomUUID(), projectId: input.projectId, batchId: input.batchId,
            checkKey: check.checkKey, status: 'not_run', exitCode: null, signal: null, timedOut: false,
            outputArtifactId: null, outputTail: null, startedAtUtcMs: null, endedAtUtcMs: now(),
          });
          results.push({ checkKey: check.checkKey, status: saved.result.status as never, reason: 'plan_not_ready', resultId: saved.result.id, testCount: null, evidence: null });
        }
        options.recording.store.finalizeVerificationBatchInTransaction({}, { batchId: input.batchId, status: 'inconclusive' });
        return { batchId: input.batchId, status: 'inconclusive', results };
      }
      for (const check of checks) {
        const report = scenarioReportPayload(options.scenario, input.targets);
        const output = await publishOutput(options, `contract check output\n${RESULT_LINE_PREFIX}${JSON.stringify(report)}\n`);
        let validReport: unknown = null;
        try {
          validReport = validateNodeCheckReport(report, input.targets);
        } catch {
          validReport = null;
        }
        const status = validReport === null ? 'inconclusive' : 'passed';
        const reason = validReport === null ? 'invalid_result_protocol' : null;
        const saved = options.recording.store.saveCheckResultInTransaction({}, {
          resultId: randomUUID(), projectId: input.projectId, batchId: input.batchId,
          checkKey: check.checkKey, status, exitCode: 0, signal: null, timedOut: false,
          outputArtifactId: output.artifactId, outputTail: null, startedAtUtcMs: now(), endedAtUtcMs: now(),
        });
        results.push({
          checkKey: check.checkKey, status: saved.result.status as never, reason, resultId: saved.result.id,
          testCount: validReport === null ? null : (validReport as { testCount: number }).testCount,
          evidence: {
            output, report: output,
            integrity: { complete: true, gaps: [], observedBytes: { stdout: 0, stderr: 0 }, retainedBytes: 0, droppedBytes: 0, coverage: 'per-stream-redacted-tagged-text' },
            stopConfirmed: true,
          } as never,
        });
      }
      const finalStatus = results.some((item) => item.status !== 'passed') ? 'inconclusive' : 'passed';
      options.recording.store.finalizeVerificationBatchInTransaction({}, { batchId: input.batchId, status: finalStatus });
      return { batchId: input.batchId, status: finalStatus as NodeTaskVerificationResult['status'], results };
    },
  };
}

// ---------------------------------------------------------------------------
// 夹具：工作区 + 真实候选解析/计划 + 执行器
// ---------------------------------------------------------------------------

export interface ExecutorContractFixture {
  readonly style: ContractStyle;
  readonly scenario: ContractScenario;
  readonly workspaceRoot: string;
  readonly policy: Record<string, unknown>;
  readonly changedPaths: readonly string[];
  readonly candidate: TestCandidateSelection;
  readonly plan: VerificationPlan;
  readonly targets: readonly string[];
  readonly executor: ContractCheckExecutor;
  readonly recording: RecordingVerificationStore;
  readonly confirmedIdentities: readonly unknown[];
  input(overrides?: Partial<NodeTaskVerificationInput>): NodeTaskVerificationInput;
  start(): Promise<NodeTaskVerificationResult>;
  aggregate(result: NodeTaskVerificationResult, overrides?: Partial<MachineVerificationInput>): MachineVerificationResult;
  close(): void;
}

function writeWorkspace(root: string, style: ContractStyle): string {
  const ws = join(root, 'ws');
  for (const dir of style.workspaceDirs) mkdirSync(join(ws, dir), { recursive: true });
  for (const file of style.workspaceFiles) {
    mkdirSync(dirname(join(ws, file)), { recursive: true });
    writeFileSync(join(ws, file), `// ${style.styleId} fixture\n`);
  }
  return realpathSync(ws);
}

function policyFor(style: ContractStyle, scenario: ContractScenario, targets: readonly string[]) {
  const argv = style.argv(scenario, targets);
  return {
    requireChecksBeforeDone: true,
    checkDefinitions: [
      {
        checkKey: style.moduleCheckKey, scope: 'module', kind: 'command',
        argv: argv[style.moduleCheckKey], cwdRef: style.allowedTargets[0] ?? null,
        environmentRef: null, timeout: 60_000, required: true, requirementRefs: [],
      },
      {
        checkKey: style.quickCheckKey, scope: 'task', kind: 'command',
        argv: argv[style.quickCheckKey], cwdRef: null,
        environmentRef: null, timeout: 30_000, required: true, requirementRefs: [],
      },
      {
        checkKey: style.optionalCheckKey, scope: 'project', kind: 'command',
        argv: argv[style.optionalCheckKey], cwdRef: null,
        environmentRef: null, timeout: 30_000, required: false, requirementRefs: [],
      },
    ],
    modules: [
      {
        moduleKey: style.moduleKey,
        allowedTargets: [...style.allowedTargets],
        impactScope: [...style.impactScope],
        sharedHighRiskFiles: [...style.sharedHighRiskFiles],
      },
    ],
    fullFallback: { checkRefs: [style.moduleCheckKey, style.quickCheckKey, style.optionalCheckKey] },
  };
}

/** 无需工作区即可构造的同构政策（供计划级用例使用）。 */
export function contractPolicyFor(
  styleId: ContractStyle['styleId'],
  scenario: ContractScenario = 'pass',
  targets: readonly string[] = contractStyle(styleId).targets,
): Record<string, unknown> {
  return policyFor(contractStyle(styleId), scenario, targets) as Record<string, unknown>;
}

/** 无安全全量回退的政策（缺候选时计划必须 error，而不是部分放行）。 */
export function policyWithoutFallback(style: ContractStyle, scenario: ContractScenario, targets: readonly string[]) {
  const policy = policyFor(style, scenario, targets) as Record<string, unknown>;
  delete policy.fullFallback;
  return policy;
}

async function candidateSelection(workspaceRoot: string, policy: Record<string, unknown>, style: ContractStyle) {
  const payload = validateTestCandidatePayload({
    schemaVersion: 1,
    projectId: CONTRACT_PROJECT_ID,
    attemptId: CONTRACT_ATTEMPT_ID,
    executionVersion: 1,
    codeDigest: CONTRACT_CODE_DIGEST,
    modules: [{ moduleKey: style.moduleKey, targets: [...style.targets], reason: `${style.moduleKey} 相关测试目标` }],
  }, 'F-015.contract');
  const resolver = createTestTargetResolver();
  const resolution = await resolver.resolve({
    workspaceRoot,
    policyModules: policy.modules,
    candidates: payload.modules,
  });
  if (!resolution.ok) throw new Error(`fixture candidate rejected: ${resolution.reason}`);
  return {
    ok: true as const,
    candidateDigest: computeTestCandidateDigest(payload),
    artifact: { artifactId: 'cand-1', contentHash: CONTRACT_CODE_DIGEST, sizeBytes: 32 },
    modules: resolution.modules,
  };
}

export interface ExecutorContractFixtureOptions {
  readonly scenario?: ContractScenario;
  /** 覆盖政策（如 policyWithoutFallback）；缺省为带安全全量回退的完整政策。 */
  readonly policy?: Record<string, unknown>;
  /** 缺省候选（模拟候选缺失）；显式 null 走候选缺失分支。 */
  readonly candidate?: TestCandidateSelection | null;
}

export async function openExecutorContractFixture(
  styleId: ContractStyle['styleId'],
  options: ExecutorContractFixtureOptions = {},
): Promise<ExecutorContractFixture> {
  const style = contractStyle(styleId);
  const scenario = options.scenario ?? 'pass';
  const box = createTempSandbox(`shiploop-f015-${styleId}-`);
  try {
    const workspaceRoot = writeWorkspace(box.path, style);
    const policy = options.policy ?? policyFor(style, scenario, style.targets);
    const candidate = options.candidate === undefined
      ? await candidateSelection(workspaceRoot, policy, style)
      : options.candidate;
    const plan = buildVerificationPlan({
      policy,
      changedPaths: [{ path: style.changedPath, state: 'modified' }],
      candidate,
    });

    const storage = createInMemoryStorage(() => Date.now());
    // 测试探针：仅注册最小项目记录，供内存 ArtifactStore 的归属核验使用。
    storage.raw.projects.set(CONTRACT_PROJECT_ID, { id: CONTRACT_PROJECT_ID } as never);
    const artifacts = storage.artifactStore;
    const dataDir = join(box.path, 'data');
    mkdirSync(dataDir, { recursive: true });
    const dataRoot = realpathSync(dataDir);
    const files = createArtifactFileStore({ dataRoot });
    const recording = createRecordingVerificationStore();
    const confirmedIdentities: unknown[] = [];

    let executor: ContractCheckExecutor;
    if (styleId === 'node') {
      const nodeExecutor = createNodeTaskVerificationExecutor({
        processes: createCommandProcessAdapter(),
        verification: recording.store as never,
        atomic: ATOMIC_STUB as never,
        artifacts: artifacts as never,
        files,
        resolveCwd: async (cwdRef) => (cwdRef === null ? workspaceRoot : join(workspaceRoot, cwdRef)),
        resolveEnvironment: () => ({}),
        confirmProcessIdentity: async (identity) => {
          confirmedIdentities.push(identity);
        },
      });
      executor = {
        executorId: 'shiploop.node-check-executor',
        declaredTargetCapabilities: ['repository-path'],
        start: nodeExecutor.start,
      };
    } else {
      executor = createTrustedTestExecutor({ artifacts, files, recording, scenario });
    }

    return {
      style,
      scenario,
      workspaceRoot,
      policy,
      changedPaths: [style.changedPath],
      candidate: candidate as TestCandidateSelection,
      plan,
      targets: [...style.targets],
      executor,
      recording,
      confirmedIdentities,
      async start() {
        return executor.start(fixtureInput());
      },
      input: fixtureInput,
      aggregate(result, overrides = {}) {
        return aggregateFor(plan, result, overrides);
      },
      close() {
        box.cleanup();
      },
    };

    function fixtureInput(overrides: Partial<NodeTaskVerificationInput> = {}): NodeTaskVerificationInput {
      return {
        projectId: CONTRACT_PROJECT_ID,
        featureId: 'feature-1',
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: CONTRACT_ATTEMPT_ID,
        executionVersion: 1,
        batchId: `vbatch-${styleId}-${randomUUID()}`,
        operation: randomUUID(),
        codeDigest: CONTRACT_CODE_DIGEST,
        policyDigest: CONTRACT_POLICY_DIGEST,
        environmentSummary: { runner: styleId, contract: 'F-015' },
        plan,
        targets: [...style.targets],
        ...overrides,
      };
    }
  } catch (error) {
    box.cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 验收聚合（两种执行器同一机器验收语义）
// ---------------------------------------------------------------------------

const CONTRACT_IDENTITY = {
  headCommit: 'a'.repeat(40),
  codeDigest: 'b'.repeat(64),
  trackedPathsDigest: 'c',
  untrackedPathsDigest: 'd',
  executionDigest: 'e',
  environmentDigest: 'f',
};

export function aggregateFor(
  plan: VerificationPlan,
  result: NodeTaskVerificationResult,
  overrides: Partial<MachineVerificationInput> = {},
): MachineVerificationResult {
  const evidence: Record<string, { status: CheckResultEvidence['status']; reference: string | null }> = {};
  const testCounts: Record<string, number> = {};
  const rows = result.results.map((item) => {
    const output = (item.evidence as { output?: { artifactId?: string } } | null)?.output;
    const report = (item.evidence as { report?: { artifactId?: string } } | null)?.report;
    const complete = (item.evidence as { integrity?: { complete?: boolean } } | null)?.integrity?.complete === true;
    evidence[item.checkKey] = { status: complete ? 'complete' : 'incomplete', reference: report?.artifactId ?? null };
    testCounts[item.checkKey] = item.testCount ?? 0;
    return {
      checkKey: item.checkKey,
      required: plan.selectedChecks.find((check) => check.checkKey === item.checkKey)?.required ?? true,
      status: item.status,
      outputArtifactId: output?.artifactId ?? null,
    } as never;
  });
  return aggregateMachineVerification({
    runtime: {
      result: {
        schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
        durationMs: 10, usage: null, lastEventSequence: 1,
      },
      failure: null,
      stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: '2026-01-01T00:00:00.000Z', detail: null },
    },
    workspaceHeld: true,
    beforeIdentity: CONTRACT_IDENTITY,
    afterIdentity: CONTRACT_IDENTITY,
    plan: {
      status: plan.status,
      selectedChecks: plan.selectedChecks.map((check) => ({ checkKey: check.checkKey, required: check.required })),
      requiredCheckKeys: plan.selectedChecks.filter((check) => check.required).map((check) => check.checkKey),
      affectedModules: [...plan.affectedModules],
      coveredModules: [...plan.coveredModules],
    },
    results: rows,
    evidence,
    testCounts,
    ...overrides,
  });
}
