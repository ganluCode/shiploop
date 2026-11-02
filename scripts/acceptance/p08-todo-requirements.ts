/**
 * P08-2 / F-001 Todo CLI 演示需求输入与验收契约的加载与 fail-closed 校验入口。
 *
 * 冻结数据位于 `acceptance/p08.todo-requirements.json`，本模块负责：
 * - 校验需求行为目录完整覆盖新增/列表/完成/删除/跨进程持久化/空标题/未知 ID/
 *   无效命令/数据读写失败，且失败行为声明非零退出与数据保全；
 * - 校验临时项目、数据目录、凭据边界与清理责任不依赖开发机绝对路径；
 * - 校验运行时政策（正常交付必须真实授权 Pi；FakeRuntime 仅限受控故障夹具）、
 *   live 规划政策（不少于 3 项有依赖 Task、人工批准、范围锁定）与
 *   证据身份链（代码/测试/Task/Feature/Git 提交/运行证据逐级关联）；
 * - 提供独立于需求文件的 Task 计划校验 `validateTodoTaskPlan`，供规划门禁与
 *   局部契约检查器复用。
 *
 * 仅做纯数据校验：不联网、不调用模型、不创建进程、不读写 SQLite。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const P08_TODO_REQUIREMENTS_VERSION = 1;
export const P08_TODO_REQUIREMENTS_KIND = 'shiploop.demo.todo.requirements';
export const P08_TODO_REQUIREMENTS_PATH = 'acceptance/p08.todo-requirements.json';
export const P08_TODO_REQUIREMENT_ID = 'p08-todo-demo';
export const P08_TODO_REQUIREMENT_STATUS = 'frozen-input';
export const P08_TODO_FR_IDS = ['FR-1', 'FR-2'] as const;

/** 全部必需行为类别（正常 + 关键失败分支）。 */
export const P08_TODO_REQUIRED_CATEGORIES = [
  'add',
  'list',
  'complete',
  'delete',
  'persistence',
  'empty-title',
  'unknown-id',
  'invalid-command',
  'data-io-failure',
] as const;
export type P08TodoBehaviorCategory = (typeof P08_TODO_REQUIRED_CATEGORIES)[number];

/** 失败类别：必须声明非零退出且不破坏已有数据。 */
export const P08_TODO_FAILURE_CATEGORIES = [
  'empty-title',
  'unknown-id',
  'invalid-command',
  'data-io-failure',
] as const;

export const P08_TODO_BEHAVIOR_KINDS = ['normal', 'failure'] as const;
export type P08TodoBehaviorKind = (typeof P08_TODO_BEHAVIOR_KINDS)[number];

/** FakeRuntime 允许出现的受控故障夹具（确定性注入）。 */
export const P08_TODO_FAULT_FIXTURES = [
  'auth-failure',
  'budget-exhaustion',
  'cancel',
  'interruption-restart',
  'dependency-failure',
] as const;

/** 清理责任覆盖的运行结局。 */
export const P08_TODO_CLEANUP_OUTCOMES = ['success', 'failure', 'timeout', 'cancelled'] as const;

/** live 证据身份链必须逐级关联的制品类别。 */
export const P08_TODO_LINKED_ARTIFACTS = [
  'code',
  'tests',
  'taskResults',
  'featureResult',
  'gitCommits',
  'runEvidence',
] as const;

/** live 规划必须产生的最少 Task 数量（且须构成同长度的依赖链）。 */
export const P08_TODO_MIN_TASKS = 3;

/** 开发机绝对路径/环境引用样式：出现在冻结契约中即拒绝。 */
const MACHINE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/[A-Za-z]/,
  /\/Users\//,
  /\/home\//,
  /\$HOME/,
  /~\//,
  /^[A-Za-z]:[\\/]/,
];

/** 凭据样式字段名：冻结契约中出现即拒绝。 */
const CREDENTIAL_KEY_PATTERN = /(?:api[-_]?key|[-_]token|[-_]secret|password|passwd|bearer)/i;

/** 凭据样式值：冻结契约中出现即拒绝。 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export class P08TodoRequirementsError extends Error {
  readonly kind = 'invalid_requirements' as const;

  constructor(message: string) {
    super(message);
    this.name = 'P08TodoRequirementsError';
  }
}

export class P08TodoTaskPlanError extends Error {
  readonly kind = 'invalid_task_plan' as const;

  constructor(message: string) {
    super(message);
    this.name = 'P08TodoTaskPlanError';
  }
}

export interface P08TodoBehavior {
  readonly id: string;
  readonly category: P08TodoBehaviorCategory;
  readonly kind: P08TodoBehaviorKind;
  readonly fr: string;
  readonly summary: string;
  readonly invocation: string;
  readonly observable: readonly string[];
  readonly exitSemantics?: string;
  readonly dataPreserved?: boolean;
  readonly fixtureOnly?: string;
}

export interface P08TodoRequirements {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly requirementId: string;
  readonly status: string;
  readonly behaviors: readonly P08TodoBehavior[];
  readonly requiredBehaviorCategories: readonly string[];
  readonly tempProject: {
    readonly identity: string;
    readonly creation: string;
    readonly rootPrefix: string;
    readonly layout: {
      readonly projectRoot: string;
      readonly dataDirectory: string;
      readonly dataFiles: string;
    };
    readonly isolation: readonly string[];
    readonly forbiddenLocations: readonly string[];
    readonly machineIndependence: string;
    readonly cleanup: {
      readonly owner: string;
      readonly appliesTo: readonly string[];
      readonly requiredEvidence: string;
      readonly protects: string;
    };
  };
  readonly credentials: {
    readonly boundary: string;
    readonly forbiddenIn: readonly string[];
    readonly fixtureContainsSecrets: boolean;
    readonly missingCredentialPolicy: string;
  };
  readonly runtimePolicy: {
    readonly normalDelivery: {
      readonly runtime: string;
      readonly mode: string;
      readonly required: readonly string[];
    };
    readonly fakeRuntime: {
      readonly usage: string;
      readonly allowedFaultFixtures: readonly { readonly id: string; readonly summary: string }[];
      readonly faultsAreDeterministic: string;
    };
    readonly notRunCountsAsPassed: boolean;
    readonly machineClaimNotPass: string;
  };
  readonly planningPolicy: {
    readonly planner: string;
    readonly inputSnapshot: string;
    readonly minTasks: number;
    readonly dependencies: {
      readonly required: boolean;
      readonly rules: readonly string[];
    };
    readonly scopeLocked: string;
    readonly humanApproval: string;
    readonly duplicateGuard: string;
  };
  readonly evidencePolicy: {
    readonly liveReport: string;
    readonly linkedArtifacts: readonly string[];
    readonly artifactMeanings: Readonly<Record<string, string>>;
    readonly linkage: string;
    readonly notRunCountsAsPassed: boolean;
    readonly reportsSanitized: string;
  };
}

function fail(message: string): never {
  throw new P08TodoRequirementsError(message);
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${at} 必须是对象`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${at} 必须是非空字符串`);
  return value;
}

function asStringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${at} 必须是非空字符串数组`);
  return value.map((entry, index) => asString(entry, `${at}[${index}]`));
}

function asBoolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') fail(`${at} 必须是布尔值`);
  return value;
}

function requiredField(record: Record<string, unknown>, key: string, at: string): unknown {
  if (!(key in record)) fail(`${at}.${key} 缺失`);
  return record[key];
}

function sameSet(actual: readonly string[], expected: readonly string[], at: string): void {
  const left = new Set(actual);
  const right = new Set(expected);
  if (left.size !== right.size || [...left].some(item => !right.has(item))) {
    fail(`${at} 必须恰好包含 ${[...right].join('、')}，实际为 ${[...left].join('、') || '（空）'}`);
  }
}

/**
 * 扫描任意 JSON 值中的开发机绝对路径/环境引用样式字符串与凭据样式字段/取值。
 * 返回命中位置列表；空列表表示未发现机器相关或凭据样式内容。
 */
export function findMachineDependencyHints(value: unknown): string[] {
  const hits: string[] = [];
  const visit = (node: unknown, at: string): void => {
    if (typeof node === 'string') {
      for (const pattern of MACHINE_PATH_PATTERNS) {
        if (pattern.test(node)) {
          hits.push(`${at} 含开发机路径样式：${node}`);
          break;
        }
      }
      for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
        if (pattern.test(node)) {
          hits.push(`${at} 含凭据样式取值`);
          break;
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${at}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (CREDENTIAL_KEY_PATTERN.test(key)) hits.push(`${at}.${key} 是凭据样式字段名`);
        visit(child, `${at}.${key}`);
      }
    }
  };
  visit(value, '$');
  return hits;
}

/**
 * 校验 Todo 演示需求输入契约；任何缺口、漂移、机器路径或凭据样式均 fail-closed 拒绝。
 */
export function validateTodoDemoRequirements(value: unknown): P08TodoRequirements {
  const root = asRecord(value, '$');
  if (root.schemaVersion !== P08_TODO_REQUIREMENTS_VERSION) {
    fail(`schemaVersion 必须为 ${P08_TODO_REQUIREMENTS_VERSION}`);
  }
  if (root.kind !== P08_TODO_REQUIREMENTS_KIND) fail(`kind 必须为 ${P08_TODO_REQUIREMENTS_KIND}`);
  if (root.requirementId !== P08_TODO_REQUIREMENT_ID) fail(`requirementId 必须为 ${P08_TODO_REQUIREMENT_ID}`);
  if (root.status !== P08_TODO_REQUIREMENT_STATUS) fail(`status 必须为 ${P08_TODO_REQUIREMENT_STATUS}`);

  const source = asRecord(requiredField(root, 'source', '$'), '$.source');
  sameSet(asStringArray(requiredField(source, 'fr', '$.source'), '$.source.fr'), P08_TODO_FR_IDS, '$.source.fr');
  const criteria = asStringArray(requiredField(source, 'acceptanceCriteria', '$.source'), '$.source.acceptanceCriteria');
  if (criteria.length !== 5) fail('$.source.acceptanceCriteria 必须逐条登记 5 项验收标准');
  const designBasis = asString(requiredField(source, 'designBasis', '$.source'), '$.source.designBasis');
  if (!designBasis.includes('Demo A')) fail('$.source.designBasis 必须声明 Demo A 分层验证依据');

  /* ---- 需求行为目录 ---- */
  const behaviorRecords = requiredField(root, 'behaviors', '$');
  if (!Array.isArray(behaviorRecords) || behaviorRecords.length === 0) fail('$.behaviors 必须是非空数组');
  const behaviors: P08TodoBehavior[] = [];
  const behaviorIds = new Set<string>();
  const categories: string[] = [];
  behaviorRecords.forEach((entry, index) => {
    const at = `$.behaviors[${index}]`;
    const record = asRecord(entry, at);
    const id = asString(requiredField(record, 'id', at), `${at}.id`);
    if (behaviorIds.has(id)) fail(`${at}.id 重复：${id}`);
    behaviorIds.add(id);
    const category = asString(requiredField(record, 'category', at), `${at}.category`);
    if (!(P08_TODO_REQUIRED_CATEGORIES as readonly string[]).includes(category)) {
      fail(`${at}.category 未知：${category}`);
    }
    categories.push(category);
    const kind = asString(requiredField(record, 'kind', at), `${at}.kind`) as P08TodoBehaviorKind;
    if (!(P08_TODO_BEHAVIOR_KINDS as readonly string[]).includes(kind)) fail(`${at}.kind 未知：${kind}`);
    const fr = asString(requiredField(record, 'fr', at), `${at}.fr`);
    if (!(P08_TODO_FR_IDS as readonly string[]).includes(fr)) fail(`${at}.fr 必须是 FR-1 或 FR-2`);
    const summary = asString(requiredField(record, 'summary', at), `${at}.summary`);
    const invocation = asString(requiredField(record, 'invocation', at), `${at}.invocation`);
    const observable = asStringArray(requiredField(record, 'observable', at), `${at}.observable`);
    if (observable.length < 2) fail(`${at}.observable 至少需要 2 条可观察结果`);
    const exitSemantics = asString(requiredField(record, 'exitSemantics', at), `${at}.exitSemantics`);
    const joined = [summary, invocation, observable.join('\n'), exitSemantics].join('\n');
    const isFailureCategory = (P08_TODO_FAILURE_CATEGORIES as readonly string[]).includes(category);
    if (kind === 'failure') {
      if (!isFailureCategory) fail(`${at}.kind=failure 但类别 ${category} 不是失败类别`);
      if (!/非\s*0|非零/.test(joined)) fail(`${at}. 失败行为必须声明退出码非 0`);
      if (asBoolean(requiredField(record, 'dataPreserved', at), `${at}.dataPreserved`) !== true) {
        fail(`${at}.dataPreserved 必须为 true（失败不得破坏已有数据）`);
      }
    } else {
      if (isFailureCategory) fail(`${at}.kind=normal 但类别 ${category} 是失败类别`);
      if (!/退出码\s*0/.test(joined)) fail(`${at}. 正常行为必须声明成功退出码 0`);
    }
    behaviors.push({
      id,
      category: category as P08TodoBehaviorCategory,
      kind,
      fr,
      summary,
      invocation,
      observable,
      exitSemantics,
      ...(record.dataPreserved === undefined ? {} : { dataPreserved: asBoolean(record.dataPreserved, `${at}.dataPreserved`) }),
      ...(record.fixtureOnly === undefined ? {} : { fixtureOnly: asString(record.fixtureOnly, `${at}.fixtureOnly`) }),
    });
  });
  sameSet(categories, P08_TODO_REQUIRED_CATEGORIES, '$.behaviors 类别覆盖');
  sameSet(
    asStringArray(requiredField(root, 'requiredBehaviorCategories', '$'), '$.requiredBehaviorCategories'),
    P08_TODO_REQUIRED_CATEGORIES,
    '$.requiredBehaviorCategories',
  );

  /* ---- 临时项目与清理责任 ---- */
  const tempProject = asRecord(requiredField(root, 'tempProject', '$'), '$.tempProject');
  const creation = asString(requiredField(tempProject, 'creation', '$.tempProject'), '$.tempProject.creation');
  if (!creation.includes('os.tmpdir()') || !creation.includes('mkdtemp')) {
    fail('$.tempProject.creation 必须声明 os.tmpdir() 下的 mkdtemp 语义');
  }
  const rootPrefix = asString(requiredField(tempProject, 'rootPrefix', '$.tempProject'), '$.tempProject.rootPrefix');
  if (rootPrefix.includes('/') || rootPrefix.includes('\\')) fail('$.tempProject.rootPrefix 必须是纯目录名前缀');
  const layout = asRecord(requiredField(tempProject, 'layout', '$.tempProject'), '$.tempProject.layout');
  const projectRoot = asString(requiredField(layout, 'projectRoot', '$.tempProject.layout'), '$.tempProject.layout.projectRoot');
  const dataDirectory = asString(requiredField(layout, 'dataDirectory', '$.tempProject.layout'), '$.tempProject.layout.dataDirectory');
  const dataFiles = asString(requiredField(layout, 'dataFiles', '$.tempProject.layout'), '$.tempProject.layout.dataFiles');
  if (!projectRoot.startsWith('<tempRoot>')) fail('$.tempProject.layout.projectRoot 必须位于 <tempRoot> 占位符下');
  if (!dataDirectory.startsWith(projectRoot)) fail('$.tempProject.layout.dataDirectory 必须位于 projectRoot 下');
  if (!dataFiles.includes('dataDirectory')) fail('$.tempProject.layout.dataFiles 必须把持久化文件约束在 dataDirectory 内');
  if (asStringArray(requiredField(tempProject, 'isolation', '$.tempProject'), '$.tempProject.isolation').length < 3) {
    fail('$.tempProject.isolation 至少需要 3 条隔离规则');
  }
  if (asStringArray(requiredField(tempProject, 'forbiddenLocations', '$.tempProject'), '$.tempProject.forbiddenLocations').length < 3) {
    fail('$.tempProject.forbiddenLocations 至少需要 3 条禁止位置');
  }
  asString(requiredField(tempProject, 'machineIndependence', '$.tempProject'), '$.tempProject.machineIndependence');
  const cleanup = asRecord(requiredField(tempProject, 'cleanup', '$.tempProject'), '$.tempProject.cleanup');
  asString(requiredField(cleanup, 'owner', '$.tempProject.cleanup'), '$.tempProject.cleanup.owner');
  sameSet(
    asStringArray(requiredField(cleanup, 'appliesTo', '$.tempProject.cleanup'), '$.tempProject.cleanup.appliesTo'),
    P08_TODO_CLEANUP_OUTCOMES,
    '$.tempProject.cleanup.appliesTo',
  );
  const requiredEvidence = asString(
    requiredField(cleanup, 'requiredEvidence', '$.tempProject.cleanup'),
    '$.tempProject.cleanup.requiredEvidence',
  );
  if (!requiredEvidence.includes('临时根不存在')) fail('$.tempProject.cleanup.requiredEvidence 必须核验临时根不存在');
  asString(requiredField(cleanup, 'protects', '$.tempProject.cleanup'), '$.tempProject.cleanup.protects');

  /* ---- 凭据边界 ---- */
  const credentials = asRecord(requiredField(root, 'credentials', '$'), '$.credentials');
  asString(requiredField(credentials, 'boundary', '$.credentials'), '$.credentials.boundary');
  if (asStringArray(requiredField(credentials, 'forbiddenIn', '$.credentials'), '$.credentials.forbiddenIn').length < 3) {
    fail('$.credentials.forbiddenIn 至少需要 3 类禁止位置');
  }
  if (asBoolean(requiredField(credentials, 'fixtureContainsSecrets', '$.credentials'), '$.credentials.fixtureContainsSecrets') !== false) {
    fail('$.credentials.fixtureContainsSecrets 必须为 false');
  }
  const missingCredentialPolicy = asString(
    requiredField(credentials, 'missingCredentialPolicy', '$.credentials'),
    '$.credentials.missingCredentialPolicy',
  );
  if (!missingCredentialPolicy.includes('not_run')) fail('$.credentials.missingCredentialPolicy 必须把缺凭据记为 not_run');

  /* ---- 运行时政策 ---- */
  const runtimePolicy = asRecord(requiredField(root, 'runtimePolicy', '$'), '$.runtimePolicy');
  const normalDelivery = asRecord(
    requiredField(runtimePolicy, 'normalDelivery', '$.runtimePolicy'),
    '$.runtimePolicy.normalDelivery',
  );
  if (asString(requiredField(normalDelivery, 'runtime', '$.runtimePolicy.normalDelivery'), '$.runtimePolicy.normalDelivery.runtime') !== 'pi') {
    fail('$.runtimePolicy.normalDelivery.runtime 必须为 pi');
  }
  if (asString(requiredField(normalDelivery, 'mode', '$.runtimePolicy.normalDelivery'), '$.runtimePolicy.normalDelivery.mode') !== 'real-authorized') {
    fail('$.runtimePolicy.normalDelivery.mode 必须为 real-authorized');
  }
  const runtimeRequired = asStringArray(
    requiredField(normalDelivery, 'required', '$.runtimePolicy.normalDelivery'),
    '$.runtimePolicy.normalDelivery.required',
  );
  if (runtimeRequired.length < 3
    || !runtimeRequired.some(item => /provider/.test(item) && /model/.test(item))
    || !runtimeRequired.some(item => item.includes('批准'))
    || !runtimeRequired.some(item => item.includes('预算'))) {
    fail('$.runtimePolicy.normalDelivery.required 必须覆盖授权 provider/model、人工批准与预算');
  }
  const fakeRuntime = asRecord(requiredField(runtimePolicy, 'fakeRuntime', '$.runtimePolicy'), '$.runtimePolicy.fakeRuntime');
  const usage = asString(requiredField(fakeRuntime, 'usage', '$.runtimePolicy.fakeRuntime'), '$.runtimePolicy.fakeRuntime.usage');
  if (!usage.includes('仅') || !usage.includes('禁止替代正常交付')) {
    fail('$.runtimePolicy.fakeRuntime.usage 必须限定仅故障夹具且禁止替代正常交付');
  }
  const faultFixtures = requiredField(fakeRuntime, 'allowedFaultFixtures', '$.runtimePolicy.fakeRuntime');
  if (!Array.isArray(faultFixtures) || faultFixtures.length === 0) {
    fail('$.runtimePolicy.fakeRuntime.allowedFaultFixtures 必须是非空数组');
  }
  const fixtureIds = faultFixtures.map((entry, index) => {
    const at = `$.runtimePolicy.fakeRuntime.allowedFaultFixtures[${index}]`;
    const record = asRecord(entry, at);
    asString(requiredField(record, 'summary', at), `${at}.summary`);
    return asString(requiredField(record, 'id', at), `${at}.id`);
  });
  sameSet(fixtureIds, P08_TODO_FAULT_FIXTURES, '$.runtimePolicy.fakeRuntime.allowedFaultFixtures');
  asString(requiredField(fakeRuntime, 'faultsAreDeterministic', '$.runtimePolicy.fakeRuntime'), '$.runtimePolicy.fakeRuntime.faultsAreDeterministic');
  if (asBoolean(requiredField(runtimePolicy, 'notRunCountsAsPassed', '$.runtimePolicy'), '$.runtimePolicy.notRunCountsAsPassed') !== false) {
    fail('$.runtimePolicy.notRunCountsAsPassed 必须为 false');
  }
  asString(requiredField(runtimePolicy, 'machineClaimNotPass', '$.runtimePolicy'), '$.runtimePolicy.machineClaimNotPass');

  /* ---- live 规划政策 ---- */
  const planningPolicy = asRecord(requiredField(root, 'planningPolicy', '$'), '$.planningPolicy');
  asString(requiredField(planningPolicy, 'planner', '$.planningPolicy'), '$.planningPolicy.planner');
  asString(requiredField(planningPolicy, 'inputSnapshot', '$.planningPolicy'), '$.planningPolicy.inputSnapshot');
  const minTasks = requiredField(planningPolicy, 'minTasks', '$.planningPolicy');
  if (typeof minTasks !== 'number' || !Number.isInteger(minTasks) || minTasks < P08_TODO_MIN_TASKS) {
    fail(`$.planningPolicy.minTasks 必须是不小于 ${P08_TODO_MIN_TASKS} 的整数`);
  }
  const dependencies = asRecord(requiredField(planningPolicy, 'dependencies', '$.planningPolicy'), '$.planningPolicy.dependencies');
  if (asBoolean(requiredField(dependencies, 'required', '$.planningPolicy.dependencies'), '$.planningPolicy.dependencies.required') !== true) {
    fail('$.planningPolicy.dependencies.required 必须为 true');
  }
  const rules = asStringArray(requiredField(dependencies, 'rules', '$.planningPolicy.dependencies'), '$.planningPolicy.dependencies.rules');
  if (rules.length < 3
    || !rules.some(rule => rule.includes('无环'))
    || !rules.some(rule => rule.includes('唯一'))
    || !rules.some(rule => rule.includes('显式声明'))) {
    fail('$.planningPolicy.dependencies.rules 必须覆盖唯一 ID、显式声明依赖与无环');
  }
  asString(requiredField(planningPolicy, 'scopeLocked', '$.planningPolicy'), '$.planningPolicy.scopeLocked');
  asString(requiredField(planningPolicy, 'humanApproval', '$.planningPolicy'), '$.planningPolicy.humanApproval');
  asString(requiredField(planningPolicy, 'duplicateGuard', '$.planningPolicy'), '$.planningPolicy.duplicateGuard');

  /* ---- 证据身份链 ---- */
  const evidencePolicy = asRecord(requiredField(root, 'evidencePolicy', '$'), '$.evidencePolicy');
  const liveReport = asString(requiredField(evidencePolicy, 'liveReport', '$.evidencePolicy'), '$.evidencePolicy.liveReport');
  if (!liveReport.includes('accept:p08:live') || !liveReport.includes('not_run')) {
    fail('$.evidencePolicy.liveReport 必须绑定 accept:p08:live 且未运行记 not_run');
  }
  sameSet(
    asStringArray(requiredField(evidencePolicy, 'linkedArtifacts', '$.evidencePolicy'), '$.evidencePolicy.linkedArtifacts'),
    P08_TODO_LINKED_ARTIFACTS,
    '$.evidencePolicy.linkedArtifacts',
  );
  const meanings = asRecord(requiredField(evidencePolicy, 'artifactMeanings', '$.evidencePolicy'), '$.evidencePolicy.artifactMeanings');
  sameSet(Object.keys(meanings), P08_TODO_LINKED_ARTIFACTS, '$.evidencePolicy.artifactMeanings');
  for (const key of Object.keys(meanings)) asString(meanings[key], `$.evidencePolicy.artifactMeanings.${key}`);
  const linkage = asString(requiredField(evidencePolicy, 'linkage', '$.evidencePolicy'), '$.evidencePolicy.linkage');
  for (const token of ['Feature', 'Task', 'Run/Attempt', 'Git 提交', '测试结果']) {
    if (!linkage.includes(token)) fail(`$.evidencePolicy.linkage 必须包含 ${token}`);
  }
  if (asBoolean(requiredField(evidencePolicy, 'notRunCountsAsPassed', '$.evidencePolicy'), '$.evidencePolicy.notRunCountsAsPassed') !== false) {
    fail('$.evidencePolicy.notRunCountsAsPassed 必须为 false');
  }
  asString(requiredField(evidencePolicy, 'reportsSanitized', '$.evidencePolicy'), '$.evidencePolicy.reportsSanitized');

  /* ---- 机器无关与凭据脱敏 ---- */
  const hints = findMachineDependencyHints(value);
  if (hints.length > 0) fail(`契约包含机器相关或凭据样式内容：${hints.join('；')}`);

  return {
    schemaVersion: root.schemaVersion as number,
    kind: root.kind as string,
    requirementId: root.requirementId as string,
    status: root.status as string,
    behaviors,
    requiredBehaviorCategories: root.requiredBehaviorCategories as string[],
    tempProject: {
      identity: asString(requiredField(tempProject, 'identity', '$.tempProject'), '$.tempProject.identity'),
      creation,
      rootPrefix,
      layout: { projectRoot, dataDirectory, dataFiles },
      isolation: tempProject.isolation as string[],
      forbiddenLocations: tempProject.forbiddenLocations as string[],
      machineIndependence: tempProject.machineIndependence as string,
      cleanup: {
        owner: cleanup.owner as string,
        appliesTo: cleanup.appliesTo as string[],
        requiredEvidence,
        protects: cleanup.protects as string,
      },
    },
    credentials: {
      boundary: credentials.boundary as string,
      forbiddenIn: credentials.forbiddenIn as string[],
      fixtureContainsSecrets: credentials.fixtureContainsSecrets as boolean,
      missingCredentialPolicy,
    },
    runtimePolicy: {
      normalDelivery: {
        runtime: normalDelivery.runtime as string,
        mode: normalDelivery.mode as string,
        required: normalDelivery.required as string[],
      },
      fakeRuntime: {
        usage,
        allowedFaultFixtures: faultFixtures as { id: string; summary: string }[],
        faultsAreDeterministic: fakeRuntime.faultsAreDeterministic as string,
      },
      notRunCountsAsPassed: runtimePolicy.notRunCountsAsPassed as boolean,
      machineClaimNotPass: runtimePolicy.machineClaimNotPass as string,
    },
    planningPolicy: {
      planner: planningPolicy.planner as string,
      inputSnapshot: planningPolicy.inputSnapshot as string,
      minTasks,
      dependencies: {
        required: dependencies.required as boolean,
        rules,
      },
      scopeLocked: planningPolicy.scopeLocked as string,
      humanApproval: planningPolicy.humanApproval as string,
      duplicateGuard: planningPolicy.duplicateGuard as string,
    },
    evidencePolicy: {
      liveReport,
      linkedArtifacts: evidencePolicy.linkedArtifacts as string[],
      artifactMeanings: meanings as Record<string, string>,
      linkage,
      notRunCountsAsPassed: evidencePolicy.notRunCountsAsPassed as boolean,
      reportsSanitized: evidencePolicy.reportsSanitized as string,
    },
  };
}

/** 从仓库根加载并校验冻结的 Todo 演示需求输入契约。 */
export function loadTodoDemoRequirements(root: string): P08TodoRequirements {
  const path = join(root, P08_TODO_REQUIREMENTS_PATH);
  if (!existsSync(path)) throw new P08TodoRequirementsError(`缺少需求输入文件：${P08_TODO_REQUIREMENTS_PATH}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new P08TodoRequirementsError(`需求输入不是合法 JSON：${(error as Error).message}`);
  }
  return validateTodoDemoRequirements(parsed);
}

export interface P08TodoPlanTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface P08TodoTaskPlanReview {
  readonly taskCount: number;
  readonly longestChain: number;
}

function planFail(message: string): never {
  throw new P08TodoTaskPlanError(message);
}

/**
 * 校验 live 规划产生的 Task 计划：不少于 P08_TODO_MIN_TASKS 项 Task、ID 唯一、
 * 依赖显式声明且指向同一计划、依赖图无环，并存在覆盖不少于 minTasks 项 Task 的
 * 依赖链。供规划门禁与局部契约检查器复用；纯数据判定，不产生副作用。
 */
export function validateTodoTaskPlan(tasks: unknown, minTasks: number = P08_TODO_MIN_TASKS): P08TodoTaskPlanReview {
  if (!Array.isArray(tasks) || tasks.length === 0) planFail('Task 计划必须是非空数组');
  const plan: P08TodoPlanTask[] = [];
  const ids = new Set<string>();
  tasks.forEach((entry, index) => {
    const at = `tasks[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) planFail(`${at} 必须是对象`);
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.trim() !== ''
      ? record.id
      : planFail(`${at}.id 必须是非空字符串`);
    if (ids.has(id)) planFail(`Task ID 重复：${id}`);
    ids.add(id);
    const dependsOnRaw = record.dependsOn;
    if (!Array.isArray(dependsOnRaw)) planFail(`${at}.dependsOn 必须是字符串数组`);
    const dependsOn = dependsOnRaw.map((dep, depIndex) => {
      if (typeof dep !== 'string' || dep.trim() === '') planFail(`${at}.dependsOn[${depIndex}] 必须是非空字符串`);
      return dep as string;
    });
    if (dependsOn.includes(id)) planFail(`Task ${id} 不能依赖自身`);
    plan.push({ id, dependsOn });
  });
  const byId = new Map(plan.map(task => [task.id, task]));
  for (const task of plan) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) planFail(`Task ${task.id} 依赖不存在的 Task：${dep}`);
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const depth = new Map<string, number>();
  let cyclic = false;
  const visit = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (state.get(id) === 'visiting') {
      cyclic = true;
      return 0;
    }
    state.set(id, 'visiting');
    let longest = 1;
    for (const dep of byId.get(id)!.dependsOn) longest = Math.max(longest, visit(dep) + 1);
    state.set(id, 'done');
    depth.set(id, longest);
    return longest;
  };
  let longestChain = 0;
  for (const task of plan) longestChain = Math.max(longestChain, visit(task.id));
  if (cyclic) planFail('依赖图存在环');
  if (plan.length < minTasks) planFail(`Task 数量不足：需要至少 ${minTasks} 项，实际 ${plan.length} 项`);
  if (longestChain < minTasks) {
    planFail(`依赖链不足：需要覆盖至少 ${minTasks} 项 Task 的依赖链，实际最长 ${longestChain} 项`);
  }
  return { taskCount: plan.length, longestChain };
}
