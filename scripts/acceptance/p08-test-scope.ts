/** P08-4 / F-003 受信测试索引与默认范围选择。 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const P08_FEATURES = ['P08-1', 'P08-2', 'P08-3', 'P08-4'] as const;
export const P08_INDEXED_FEATURES: readonly string[] = [...P08_FEATURES];
export const P08_PRIOR_INTEGRATION_INDEX = 'test/index/phases/P07/integration.json';
const TEST_FILE_PATTERN = /^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(?:ts|js)$/;
const TASK_INDEX_PATTERN = /^F-\d{3}\.json$/;

const fail = (code: string, detail?: string): never => {
  throw new Error(detail ? `p08-test-scope:${code}:${detail}` : `p08-test-scope:${code}`);
};
const json = (path: string): any => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail('invalid_json', `${path}:${error instanceof Error ? error.message : String(error)}`); }
};
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function noLinks(path: string): void {
  let current = resolve(path);
  const temporary = resolve(tmpdir());
  if (current.startsWith(temporary + sep)) current = realpathSync(temporary) + current.slice(temporary.length);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('symlink', current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function repoFile(root: string, file: string): string {
  if (!TEST_FILE_PATTERN.test(file) && !/^test\/index\/phases\/P(?:07|08)\/(?:[\w.-]+\/)*[\w.-]+\.json$/.test(file)) {
    fail('unsafe_input_path', file);
  }
  if (isAbsolute(file) || file.split('/').some(part => part === '.' || part === '..')) fail('unsafe_input_path', file);
  const path = join(root, file);
  noLinks(path);
  if (!existsSync(path) || !lstatSync(path).isFile()) fail('input_not_file', file);
  return path;
}
function featureIndexPath(feature: string): string { return `test/index/phases/P08/features/${feature}`; }
function checkTestEntry(test: any, root: string, feature: string, taskId: string): string {
  if (test === null || typeof test !== 'object' || Array.isArray(test)) fail('invalid_test_selection', `${feature}/${taskId}`);
  const keys = Object.keys(test);
  if (keys.some(key => !['file', 'all', 'cases', 'level'].includes(key))) fail('unknown_test_field', `${feature}/${taskId}`);
  if (typeof test.file !== 'string' || !TEST_FILE_PATTERN.test(test.file)) fail('invalid_test_path', `${feature}/${taskId}`);
  if (test.all === true && test.cases !== undefined) fail('all_and_cases', test.file);
  if (test.all !== true && (!Array.isArray(test.cases) || test.cases.length === 0 || test.cases.some((value: unknown) => typeof value !== 'string' || value.length === 0))) {
    fail('empty_test_selection', test.file);
  }
  if (test.level !== undefined && test.level !== 'unit' && test.level !== 'integration') fail('invalid_test_level', test.file);
  repoFile(root, test.file);
  return test.file;
}
function validateIntegrationIndex(root: string, file: string): string[] {
  const registry = json(repoFile(root, file));
  if (registry.schema_version !== 2 || !Array.isArray(registry.projects) || registry.projects.length !== 1) fail('invalid_integration_index', file);
  const project = registry.projects[0];
  if (project.id !== 'shiploop' || !Array.isArray(project.tests) || project.tests.length === 0) fail('invalid_integration_index', file);
  const seen = new Set<string>();
  return project.tests.map((test: any) => {
    if (test.level !== 'integration' || (test.all !== true && test.cases === undefined)) fail('invalid_integration_index', file);
    const selected = checkTestEntry(test, root, 'prior-integration', file);
    if (seen.has(selected)) fail('duplicate_integration_file', selected);
    seen.add(selected);
    return selected;
  }).sort();
}

export type P08TrustedTests = {
  readonly files: readonly string[];
  readonly inputs: readonly string[];
  readonly integrationFiles: readonly string[];
  readonly featureFiles: Readonly<Record<string, readonly string[]>>;
  readonly duplicateReferences: readonly string[];
};

/** 校验所有 P08 Feature/Task 索引，并返回去重后的可信测试并集。 */
export function collectP08TrustedTests(root: string): P08TrustedTests {
  const base = join(root, 'test/index/phases/P08/features');
  noLinks(base);
  if (!existsSync(base) || !lstatSync(base).isDirectory()) fail('missing_feature_index_root');
  const discovered = readdirSync(base, { withFileTypes: true }).map(entry => entry.name).sort();
  if (digest(discovered) !== digest([...P08_INDEXED_FEATURES].sort())) fail('feature_index_set', discovered.join(','));

  const files = new Set<string>();
  const featureFiles: Record<string, string[]> = {};
  const inputs: string[] = [];
  const integrationFiles = new Set<string>();
  const duplicateReferences = new Set<string>();
  for (const feature of P08_INDEXED_FEATURES) {
    const directory = featureIndexPath(feature);
    const featureJson = `${directory}/feature.json`;
    const manifest = json(repoFile(root, featureJson));
    inputs.push(featureJson);
    if (manifest.schema_version !== 1 || manifest.kind !== 'feature' || manifest.phase !== 'P08' || manifest.feature !== feature || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
      fail('invalid_feature_index', feature);
    }
    const taskDirectory = join(root, directory, 'tasks');
    noLinks(taskDirectory);
    if (!existsSync(taskDirectory) || !lstatSync(taskDirectory).isDirectory()) fail('missing_task_index_set', feature);
    const actualTasks = readdirSync(taskDirectory, { withFileTypes: true }).map(entry => entry.name).sort();
    if (actualTasks.length === 0 || actualTasks.some(name => !TASK_INDEX_PATTERN.test(name))) fail('invalid_task_index_set', feature);
    const declaredTasks: string[] = [];
    const featureSelected: string[] = [];
    const declaredIds = new Set<string>();
    for (const task of manifest.tasks) {
      if (task === null || typeof task !== 'object' || task.task_id === undefined || task.index === undefined || typeof task.task_id !== 'string' || !/^F-\d{3}$/.test(task.task_id) || task.index !== `${directory}/tasks/${task.task_id}.json`) {
        fail('invalid_task_index_path', feature);
      }
      if (declaredIds.has(task.task_id)) fail('duplicate_task_index', `${feature}/${task.task_id}`);
      declaredIds.add(task.task_id);
      const taskFile = task.index as string;
      declaredTasks.push(`${task.task_id}.json`);
      inputs.push(taskFile);
      const index = json(repoFile(root, taskFile));
      if (index.schema_version !== 2 || index.task_id !== task.task_id || !Array.isArray(index.projects) || index.projects.length !== 1) fail('invalid_task_index', taskFile);
      const project = index.projects[0];
      if (project.id !== 'shiploop' || !Array.isArray(project.tests) || project.tests.length === 0) fail('empty_test_selection', taskFile);
      const taskFiles = new Set<string>();
      for (const test of project.tests) {
        const selected = checkTestEntry(test, root, feature, task.task_id);
        if (taskFiles.has(selected)) fail('duplicate_test_reference', `${taskFile}:${selected}`);
        taskFiles.add(selected);
        featureSelected.push(selected);
        if (test.level === 'integration') integrationFiles.add(selected);
        if (files.has(selected)) duplicateReferences.add(selected);
        files.add(selected);
      }
    }
    if (digest(declaredTasks.sort()) !== digest(actualTasks)) fail('task_index_manifest_mismatch', feature);
    featureFiles[feature] = [...new Set(featureSelected)].sort();
  }

  // P07 的集成索引是 P08 复跑 P01～P07 确定性回归的受信输入；不扫描整个仓库冒充索引。
  if (existsSync(join(root, P08_PRIOR_INTEGRATION_INDEX))) {
    inputs.push(P08_PRIOR_INTEGRATION_INDEX);
    for (const file of validateIntegrationIndex(root, P08_PRIOR_INTEGRATION_INDEX)) {
      if (files.has(file)) duplicateReferences.add(file);
      files.add(file); integrationFiles.add(file);
    }
  }
  if (files.size === 0) fail('empty_test_selection');
  return { files: [...files].sort(), inputs: [...new Set(inputs)].sort(), integrationFiles: [...integrationFiles].sort(),
    featureFiles: Object.fromEntries(Object.entries(featureFiles).map(([feature, selected]) => [feature, Object.freeze(selected)])),
    duplicateReferences: [...duplicateReferences].sort() };
}

export type P08RegressionCategory = 'installation' | 'todo-delivery' | 'brownfield' | 'recovery' | 'git' | 'evidence';
export type P08RequiredRegression = { readonly file: string; readonly category: P08RegressionCategory; readonly reason: string };
/** P08 影响分析登记的 P01～P07 基础回归；其余可信历史文件保持 deferred。 */
export const P08_REQUIRED_REGRESSIONS: readonly P08RequiredRegression[] = Object.freeze([
  { file: 'test/modules/planning/p05-1-f014-planning-e2e.test.ts', category: 'todo-delivery', reason: 'Todo 规划输入与依赖 DAG 的既有确定性回归' },
  { file: 'test/modules/acceptance/p07-5-f012-closed-loop-demo.test.ts', category: 'todo-delivery', reason: '阶段闭环与失败现场保留的既有回归' },
  { file: 'test/modules/acceptance/p08-2-f008-existing-demo.test.ts', category: 'brownfield', reason: '存量项目初始化与增量报告边界的回归' },
  { file: 'test/modules/acceptance/p08-3-f003-existing-demo-incremental.test.ts', category: 'brownfield', reason: '存量项目增量变更的确定性回归' },
  { file: 'test/modules/acceptance/p08-3-f004-existing-demo-lifecycle.test.ts', category: 'brownfield', reason: '存量项目生命周期门控与归档恢复回归' },
  { file: 'test/modules/delivery/p03-8-f004-git-commit-reconciliation.test.ts', category: 'git', reason: '提交已发生但回执丢失时按 Git 事实对账' },
  { file: 'test/modules/recovery/p04-9-f007-dispatch-crash-windows.test.ts', category: 'recovery', reason: '崩溃窗口、迟到结果与 owner fencing 回归' },
  { file: 'test/modules/delivery/p07-4-f002-result-evidence-integrity.test.ts', category: 'evidence', reason: '结果证据身份、摘要和完整性回归' },
  { file: 'test/modules/engineering/p08-1-f002-local-pack.test.ts', category: 'installation', reason: '本地 pack 产物入口与依赖闭包回归' },
]);

export type P08DeferredTest = { readonly file: string; readonly status: 'not_run'; readonly reason: string; readonly source: string };
export type P08FullRegression = { readonly enabled: boolean; readonly status: 'not_run' | 'selected'; readonly command: readonly ['npm', 'test']; readonly reason: string };
export type P08TestScope = {
  readonly schemaVersion: 1;
  readonly policy: 'p08-impact-and-required-regressions' | 'full-trusted-union';
  readonly selected: readonly string[];
  readonly selectedReasons: Readonly<Record<string, string>>;
  readonly requiredRegressions: readonly P08RequiredRegression[];
  readonly deferred: readonly P08DeferredTest[];
  readonly fullRegression: P08FullRegression;
};
function isP08File(file: string): boolean { return /^test\/modules\/.*\/p08-[\w.-]+\.test\.(?:ts|js)$/.test(file); }

/** 从可信并集构造默认/显式 full 范围；默认不把历史测试或真实 live 入口折算为已运行。 */
export function selectP08TestScope(trustedUnion: readonly string[], fullRegression = false, integrationFiles: readonly string[] = []): P08TestScope {
  const all = [...new Set(trustedUnion)].sort();
  if (all.length === 0) fail('empty_test_selection');
  for (const file of all) {
    if (!TEST_FILE_PATTERN.test(file)) fail('invalid_trusted_union_entry', file);
    if (file.includes('scripts/acceptance/p08-accept.ts')) fail('recursive_entry', file);
  }
  const integration = new Set(integrationFiles);
  for (const file of integration) if (!all.includes(file)) fail('integration_coverage_missing', file);
  const missing = P08_REQUIRED_REGRESSIONS.filter(item => !all.includes(item.file));
  if (missing.length) fail('required_regression_missing', missing.map(item => `${item.file}(${item.category})`).join(','));
  const required = new Map(P08_REQUIRED_REGRESSIONS.map(item => [item.file, item.reason]));
  for (const file of integration) if (file.includes('/p08-')) required.set(file, 'P08 阶段场景的集成索引登记');
  const selected = fullRegression ? all : all.filter(file => isP08File(file) || required.has(file));
  const selectedSet = new Set(selected);
  const selectedReasons: Record<string, string> = {};
  for (const file of selected) selectedReasons[file] = isP08File(file) ? 'P08 可信索引中的阶段测试' : (required.get(file) ?? 'P08 阶段集成索引登记');
  const deferred = all.filter(file => !selectedSet.has(file)).map(file => ({ file, status: 'not_run' as const,
    reason: '历史回归不在审阅的 P08 影响边界内；仅由 Phase 集成或 --full-regression 显式执行', source: 'trusted-index-union' }));
  return { schemaVersion: 1, policy: fullRegression ? 'full-trusted-union' : 'p08-impact-and-required-regressions', selected,
    selectedReasons, requiredRegressions: [...P08_REQUIRED_REGRESSIONS], deferred,
    fullRegression: { enabled: fullRegression, status: fullRegression ? 'selected' : 'not_run', command: ['npm', 'test'],
      reason: fullRegression ? '负责人显式开启全仓历史回归' : '默认 P08 范围不执行全仓历史回归' } };
}
export function digestP08TestScope(scope: P08TestScope): string {
  return digest({ schemaVersion: scope.schemaVersion, policy: scope.policy, selected: scope.selected,
    selectedReasons: scope.selectedReasons, deferred: scope.deferred, requiredRegressions: scope.requiredRegressions, fullRegression: scope.fullRegression });
}
