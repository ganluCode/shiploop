/**
 * P07-5 / F-001 P07 阶段可信索引校验与默认测试范围解析
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 复用既有索引契约（scripts/acceptance/p06-accept.ts collectP06TrustedTests、
 * scripts/acceptance/p05-test-scope.ts selectP05TestScope）：
 *
 * - **完整校验**：逐项校验 P07-1～P07-5 的 Feature 清单（schema_version 1）与
 *   Task 索引（schema_version 2）；特征目录集合、任务文件集合、声明/发现一致、
 *   测试文件模式与存在性、非空选择均强制；缺索引、无效 schema 版本、空测试集、
 *   重复登记一律 fail-closed，不默默忽略无效索引；
 * - **去重执行范围**：P07 文件全部纳入默认范围，并逐项登记恢复、Git 公共元数据锁、
 *   Recorder、迁移和结果查询所需底层回归及选择理由；必需回归缺失于可信并集即
 *   拒绝（范围遗漏 fail-closed）；
 * - **deferred/not_run**：未选历史测试逐项登记 deferred + not_run 与原因，不删除
 *   测试、不把未运行写成通过；显式全量（--full-regression）才执行完整可信并集；
 * - **范围摘要**：默认与全量模式的范围摘要不同，报告据此区分两种模式。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { hashP06Input } from './p06-facts.ts';
import { P07_ACCEPT_FEATURE, P07_PREREQUISITE_FEATURES } from './p07-config.ts';

const fail = (code: string, detail?: string): never => { throw new Error(detail ? `p07-test-scope:${code}:${detail}` : `p07-test-scope:${code}`); };
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

function noLinks(path: string): void {
  let current = resolve(path);
  const temp = resolve(tmpdir());
  if (current.startsWith(temp + sep)) current = realpathSync(temp) + current.slice(temp.length);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('symlink');
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
function repoFile(root: string, file: string): string {
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split('/').some(p => p === '.' || p === '..') || isAbsolute(file)) fail('unsafe_input_path');
  const target = join(root, file); noLinks(target);
  if (!existsSync(target) || !lstatSync(target).isFile()) fail('input_not_file');
  return target;
}

/** 可信索引中的全部 Feature：前序 P07-1～P07-4 加验收 Feature P07-5 自身。 */
export const P07_INDEXED_FEATURES: readonly string[] = [...P07_PREREQUISITE_FEATURES, P07_ACCEPT_FEATURE];

/**
 * 完整校验 P07-1～P07-5 的 Feature/Task 索引并返回去重测试文件与输入清单。
 *
 * 早期 Feature（P07-1～P07-4）可直接登记 Task 索引或冻结聚合清单；验收 Feature
 * P07-5 必须提供聚合清单（missing_feature_index fail-closed）。Task 用例在阶段
 * 范围内展开为完整文件执行。
 */
export function collectP07TrustedTests(root: string): { files: string[]; inputs: string[] } {
  const base = 'test/index/phases/P07/features';
  const discovered = readdirSync(join(root, base), { withFileTypes: true }).map(e => e.name).sort();
  if (hashP06Input(discovered) !== hashP06Input([...P07_INDEXED_FEATURES].sort())) fail('prerequisite_index_set', `discovered=${discovered.join(',')}`);
  const files = new Set<string>(), inputs: string[] = [];
  for (const feature of P07_INDEXED_FEATURES) {
    const manifestFile = `${base}/${feature}/feature.json`;
    noLinks(join(root, base, feature, 'tasks'));
    const actual = readdirSync(join(root, base, feature, 'tasks')).sort();
    if (!actual.length || actual.some(name => !/^F-\d{3}\.json$/.test(name))) fail('invalid_task_index_set', `${feature}`);
    // Earlier Features register Task indexes directly; the acceptance Feature must freeze an aggregate manifest.
    const manifest = existsSync(join(root, manifestFile)) ? json(repoFile(root, manifestFile)) :
      { schema_version: 1, kind: 'feature', phase: 'P07', feature, tasks: actual.map(name => ({ task_id: name.slice(0, -5), index: `${base}/${feature}/tasks/${name}` })) };
    if (existsSync(join(root, manifestFile))) inputs.push(manifestFile);
    else if (feature === P07_ACCEPT_FEATURE) fail('missing_feature_index', feature);
    if (manifest.schema_version !== 1 || manifest.kind !== 'feature' || manifest.phase !== 'P07' || manifest.feature !== feature || !Array.isArray(manifest.tasks) || !manifest.tasks.length) fail('invalid_feature_index', feature);
    const declared: string[] = [];
    for (const task of manifest.tasks) {
      if (!/^F-\d{3}$/.test(task.task_id) || task.index !== `${base}/${feature}/tasks/${task.task_id}.json`) fail('invalid_task_index_path', `${feature}/${task.task_id}`);
      declared.push(`${task.task_id}.json`);
      const index = json(repoFile(root, task.index)); inputs.push(task.index);
      if (index.schema_version !== 2 || index.task_id !== task.task_id || !Array.isArray(index.projects) || index.projects.length !== 1) fail('invalid_task_index', `${feature}/${task.task_id}`);
      const project = index.projects[0];
      if (project.id !== 'shiploop' || !Array.isArray(project.tests) || !project.tests.length) fail('empty_test_selection', `${feature}/${task.task_id}`);
      for (const test of project.tests) {
        if (typeof test.file !== 'string' || !/^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(ts|js)$/.test(test.file) ||
            (test.all !== true && (!Array.isArray(test.cases) || !test.cases.length || test.cases.some((c: unknown) => typeof c !== 'string' || !c))) ||
            (test.all !== undefined && test.cases !== undefined)) fail('invalid_test_selection', `${feature}/${task.task_id}`);
        repoFile(root, test.file); files.add(test.file);
      }
    }
    if (new Set(declared).size !== declared.length || hashP06Input(declared.sort()) !== hashP06Input(actual)) fail('task_index_manifest_mismatch', feature);
  }
  if (!files.size) fail('empty_test_selection');
  return { files: [...files].sort(), inputs: inputs.sort() };
}

/* ------------------------------------------------------------------ *
 * 默认阶段测试范围：P07 文件全部纳入 + 逐项登记的必需底层回归
 * ------------------------------------------------------------------ */

export type P07RegressionCategory = 'recovery' | 'git-metadata-lock' | 'recorder' | 'migration' | 'result-query';
export type P07RequiredRegression = { readonly file: string; readonly category: P07RegressionCategory; readonly reason: string };

/** 审阅过的 P07 影响边界所需底层回归；每项登记类别与选择理由。 */
export const P07_REQUIRED_REGRESSIONS: readonly P07RequiredRegression[] = Object.freeze([
  { file: 'test/modules/recovery/p03-9-f005-startup-recovery.test.ts', category: 'recovery', reason: 'Host 启动恢复扫描与旧执行隔离是 T06 崩溃恢复的底层基线' },
  { file: 'test/modules/recovery/p04-9-f007-dispatch-crash-windows.test.ts', category: 'recovery', reason: '派发崩溃窗口与迟到结果 fencing 是显式恢复场景的底层基线' },
  { file: 'test/modules/recovery/p05-4-f006-dispatch-recovery.test.ts', category: 'recovery', reason: 'Feature 并发派发恢复保证重启后依赖不误解锁' },
  { file: 'test/modules/recovery/p05-5-f005-resource-recovery.test.ts', category: 'recovery', reason: '共享资源锁恢复保证恢复期互斥与隔离' },
  { file: 'test/modules/workspace/p03-5-git-operation-lock.test.ts', category: 'git-metadata-lock', reason: 'Git 操作锁语义是新旧仓库身份争用公共元数据锁的底层基线' },
  { file: 'test/modules/delivery/p03-8-f004-git-commit-reconciliation.test.ts', category: 'git-metadata-lock', reason: '提交回执对账覆盖提交已发生但回执丢失的核对路径' },
  { file: 'test/modules/runtime/p04-5-session-recorder.test.ts', category: 'recorder', reason: 'Session 记录身份/水位/去重是 Recorder 背压的底层基线' },
  { file: 'test/modules/runtime/p04-5-work-recording-publisher.test.ts', category: 'recorder', reason: '记录发布端持久化失败语义是 T11 背压场景的底层基线' },
  { file: 'test/modules/runtime/p04-8-recovery-recording-fault-matrix.test.ts', category: 'recorder', reason: '恢复期记录故障矩阵支撑双存储一致性核对' },
  { file: 'test/modules/storage/sqlite/sqlite-migration-runner.test.ts', category: 'migration', reason: '迁移执行器事务/回滚/约束是升级失败安全恢复的底层基线' },
  { file: 'test/modules/storage/sqlite/sqlite-schema-migrations.test.ts', category: 'migration', reason: '迁移链与 schema 断言保证 T16 升级路径完整' },
  { file: 'test/modules/delivery/p05-9-f001-batch-delivery-query.test.ts', category: 'result-query', reason: '交付结果查询基线保证恢复后结果可核对' },
]);

export type P07TestScope = {
  readonly schemaVersion: 1;
  readonly policy: 'p07-impact-and-required-regressions' | 'full-trusted-union';
  readonly selected: readonly string[];
  readonly requiredRegressions: readonly P07RequiredRegression[];
  readonly deferred: readonly { readonly file: string; readonly status: 'not_run'; readonly reason: string }[];
};

const TEST_FILE_PATTERN = /^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(ts|js)$/;

/**
 * 从完整校验过的可信并集生成去重执行范围：P07 文件全部纳入，必需底层回归逐项
 * 纳入；未选历史测试逐项登记 deferred/not_run。必需回归缺失于并集即拒绝。
 */
export function selectP07TestScope(trustedUnion: readonly string[], fullRegression = false): P07TestScope {
  const all = [...new Set(trustedUnion)].sort();
  if (!all.length) fail('empty_test_selection');
  for (const file of all) if (!TEST_FILE_PATTERN.test(file)) fail('invalid_trusted_union_entry', file);
  const missing = P07_REQUIRED_REGRESSIONS.filter(reg => !all.includes(reg.file));
  if (missing.length) fail('required_regression_missing', missing.map(m => `${m.file}(${m.category})`).join(','));
  const requiredFiles = new Set(P07_REQUIRED_REGRESSIONS.map(reg => reg.file));
  const selected = fullRegression ? all : all.filter(file => file.includes('p07-') || requiredFiles.has(file));
  const selectedSet = new Set(selected);
  const deferred = all.filter(file => !selectedSet.has(file)).map(file => ({
    file, status: 'not_run' as const,
    reason: '历史回归不在审阅的 P07 影响边界内；由 CI 或 --full-regression 显式执行',
  }));
  return {
    schemaVersion: 1,
    policy: fullRegression ? 'full-trusted-union' : 'p07-impact-and-required-regressions',
    selected,
    requiredRegressions: [...P07_REQUIRED_REGRESSIONS],
    deferred,
  };
}

/** 范围内容摘要：默认与全量模式（以及任何范围变化）产生不同摘要。 */
export function digestP07TestScope(scope: P07TestScope): string {
  return hashP06Input({ policy: scope.policy, selected: scope.selected, deferred: scope.deferred, requiredRegressions: scope.requiredRegressions });
}
