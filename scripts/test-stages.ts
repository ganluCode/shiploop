/** 工程测试分组；显式清单只用于排序，未登记文件始终进入 heavy。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TEST_STAGES = ['light', 'standard', 'heavy'] as const;
export type TestStage = typeof TEST_STAGES[number];
export interface TestStagePlan { stage: TestStage; files: string[] }
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s)(?:x)?$/;

/** 与 vitest.config.ts 的默认收集范围相同；不跟随链接遍历外部目录。 */
export function discoverTestFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const path = relative(root, full).split('\\').join('/');
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)
        || path === 'test/helpers' || path === 'test/fixtures') continue;
      if (entry.isSymbolicLink()) {
        if (TEST_FILE.test(entry.name)) throw new Error(`测试文件不能是符号链接：${path}`);
        continue;
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

export function planTestStages(files: readonly string[], manifest: unknown): TestStagePlan[] {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('无效测试分组清单');
  const raw = manifest as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || Object.keys(raw).some(key => !['schemaVersion', 'light', 'standard'].includes(key))) {
    throw new Error('未知测试分组格式');
  }
  if (new Set(files).size !== files.length || files.length === 0) throw new Error('测试文件为空或重复');
  const available = new Set(files);
  const assigned = new Map<string, TestStage>();
  for (const stage of ['light', 'standard'] as const) {
    const entries = raw[stage];
    if (!Array.isArray(entries)) throw new Error(`缺少分组：${stage}`);
    for (const file of entries) {
      if (typeof file !== 'string' || !available.has(file)) throw new Error(`分组引用不存在的测试：${String(file)}`);
      if (assigned.has(file)) throw new Error(`测试被重复分组：${file}`);
      assigned.set(file, stage);
    }
  }
  return TEST_STAGES.map(stage => ({ stage,
    files: files.filter(file => (assigned.get(file) ?? 'heavy') === stage).sort() }));
}

export function loadTestStages(root: string): TestStagePlan[] {
  return planTestStages(discoverTestFiles(root), JSON.parse(readFileSync(join(root, 'test/stages.json'), 'utf8')));
}

/** Longest-first scheduling with deterministic ties; new files get a conservative default. */
export function planTestShards(files: readonly string[], count: number, durations: Readonly<Record<string, number>>): string[][] {
  if (!Number.isInteger(count) || count < 1 || count > 16 || files.length < count || new Set(files).size !== files.length) {
    throw new Error('无效测试分片数量或文件集合');
  }
  if (Object.values(durations).some(ms => !Number.isFinite(ms) || ms <= 0)) throw new Error('无效测试耗时');
  const weight = (file: string) => durations[file] ?? 30_000;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], duration: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const target = shards.reduce((best, shard) => shard.duration < best.duration ? shard : best);
    target.files.push(file);
    target.duration += weight(file);
  }
  return shards.map(shard => shard.files.sort());
}

export function loadHeavyShards(root: string, count: number): string[][] {
  const timing = JSON.parse(readFileSync(join(root, 'test/ci-timings.json'), 'utf8')) as { schemaVersion: number; durationsMs: Record<string, number> };
  if (timing.schemaVersion !== 1 || !timing.durationsMs || Array.isArray(timing.durationsMs) || typeof timing.durationsMs !== 'object') {
    throw new Error('无效 CI 测试耗时清单');
  }
  return planTestShards(loadTestStages(root).find(plan => plan.stage === 'heavy')!.files, count, timing.durationsMs);
}

export interface StageOutcome {
  stage: TestStage;
  status: 'pass' | 'fail' | 'not_run';
  files: string[];
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

/** 同一个总预算，失败后其余组明确 not_run；空组不制造成功结果。 */
export function executeTestStages(
  plans: readonly TestStagePlan[], timeoutMs: number,
  run: (plan: TestStagePlan, remainingMs: number) => { status: number | null; signal?: string | null; error?: Error },
  now: () => number = Date.now,
): StageOutcome[] {
  const deadline = now() + timeoutMs;
  let failed = false;
  return plans.filter(plan => plan.files.length > 0).map(plan => {
    const row: StageOutcome = { ...plan, status: 'not_run', durationMs: 0, exitCode: null, signal: null, error: null };
    if (failed) return row;
    const started = now();
    const remaining = deadline - started;
    if (remaining <= 0) {
      failed = true;
      return { ...row, status: 'fail', error: '测试总预算耗尽' };
    }
    let result: ReturnType<typeof run>;
    try { result = run(plan, remaining); }
    catch (error) { result = { status: null, error: error instanceof Error ? error : new Error(String(error)) }; }
    failed = result.status !== 0 || !!result.signal || !!result.error;
    return { ...row, status: failed ? 'fail' : 'pass', durationMs: now() - started,
      exitCode: result.status, signal: result.signal ?? null, error: result.error?.message ?? null };
  });
}
