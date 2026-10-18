/**
 * F-011 文档守护：P03-1 交接文档（docs/p03-1-handoff.md）核对。
 *
 * 依据 F-011 验收标准 4/5 逐项守护：
 * 1. 交接记录实现范围（F-001 ~ F-011 逐项）、输入文档版本（PRD 0.3 / 共同执行约束 /
 *    实施契约）、实际基线与代码 commit（P02 基线 0e76ad8 + 各 Feature 提交锚点）、
 *    真实验证命令与退出码（verify/check:boundaries/exit 0 + files/tests 计数形态）、
 *    脱敏证据路径指向 Feature 工作区、已知缺口；
 * 2. T02、T03 存储子集、T26 计划编辑子集、T32 元数据子集逐项映射，范围外部分显式
 *    not_run（未运行不计通过）；
 * 3. 负例矩阵复核表覆盖：空库/P02 v5 升级、非法状态/外键/唯一约束、依赖负例整组拒绝、
 *    策略缺失/默认漂移、越权、幂等、CAS、事务故障、状态/事件/回执一致性；引用的
 *    回归测试文件必须真实存在（不得虚引）；
 * 4. 批准/活动保护证据明确区分纯规则、测试装配与尚未实现的 Work；accept:p03 与真实
 *    Pi live 显式 not_run；不宣称阶段执行验收；
 * 5. P03-2 复用面（实体/命令/查询、摘要字段与批准失效规则、策略副本来源、活动保护
 *    接线约束）与不包含清单（配置/计划版本表、模型规划、Feature DAG 派发、完整
 *    Phase 管理、Runtime 执行）；
 * 6. F-011 集成回归测试与 dist 产物 Host 入口夹具存在；README 登记交接文档。
 *
 * 只断言稳定契约内容（结构、存在性、边界声明、脱敏措辞）；单次运行的计数精确值
 * 与 run-id 等易变记录由 Feature 工作区 verifications/ 承载，本文档内联计数只要求
 * 形态可核对（数字 + files/tests + exit 0），不做跨 Feature 的脆弱精确相等。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HANDOFF_PATH = 'docs/p03-1-handoff.md';
const README_PATH = 'README.md';

function readRepo(relativePath: string): string {
  const absolute = resolve(REPO_ROOT, relativePath);
  expect(existsSync(absolute), `${relativePath} 必须存在`).toBe(true);
  return readFileSync(absolute, 'utf8');
}

/** 交接文档引用的回归测试文件必须真实存在（防虚引/删除后文档失实）。 */
const CITED_TEST_FILES: readonly string[] = [
  'test/modules/planning/p03-1-plan-validation.test.ts',
  'test/modules/planning/p03-1-plan-structure-storage.test.ts',
  'test/modules/planning/p03-1-task-strategy-selection.test.ts',
  'test/modules/planning/p03-1-phase-create-command.test.ts',
  'test/modules/planning/p03-1-plan-import-command.test.ts',
  'test/modules/planning/p03-1-plan-import-race.test.ts',
  'test/modules/planning/p03-1-plan-queries.test.ts',
  'test/modules/planning/p03-1-plan-queries-consistency.test.ts',
  'test/modules/planning/p03-1-label-edit-command.test.ts',
  'test/modules/planning/p03-1-label-edit-rules.test.ts',
  'test/modules/planning/p03-1-plan-revise-command.test.ts',
  'test/modules/planning/p03-1-plan-revise-rules.test.ts',
  'test/modules/planning/p03-1-plan-host-wiring.test.ts',
  'test/modules/planning/p03-1-plan-cli-vertical.test.ts',
  'test/modules/planning/p03-1-integration-regression.test.ts',
];

/** F-011 交付的 dist 产物 Host 入口夹具（正式构建链路的测试装配）。 */
const F011_FIXTURE_FILES: readonly string[] = [
  'test/helpers/host/dist-host-entry-catalog.mjs',
  'test/modules/planning/p03-1-integration-regression.test.ts',
];

describe('F-011 交接文档守护（docs/p03-1-handoff.md）', () => {
  it('文档存在且登记于 README 文档索引', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('# P03-1 领域归属与确定性计划导入 — 交接');
    const readme = readRepo(README_PATH);
    expect(readme).toContain('docs/p03-1-handoff.md');
  });

  it('记录实现范围（F-001 ~ F-011 逐项）、输入文档版本与基线/代码 commit', () => {
    const handoff = readRepo(HANDOFF_PATH);
    for (const feature of ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008', 'F-009', 'F-010', 'F-011']) {
      expect(handoff).toContain(feature);
    }
    // 输入文档版本。
    expect(handoff).toContain('p03-plan-import.md');
    expect(handoff).toContain('0.3');
    expect(handoff).toContain('execution-contract.md');
    expect(handoff).toContain('p03-1-plan-import-contract.md');
    expect(handoff).toContain('p03-1-task-strategy-selection.md');
    // 基线与代码提交锚点（P02 验收基线 + P03-1 首末 Feature 提交）。
    expect(handoff).toContain('0e76ad8');
    expect(handoff).toContain('169bc4b');
    expect(handoff).toContain('5a9753c');
    // F-011 交接提交的自引用限制与权威记录位置必须如实说明。
    expect(handoff).toContain('verifications/F-011/');
    expect(handoff).toContain('未运行不计通过');
  });

  it('负例矩阵复核表覆盖全部矩阵项，引用测试文件真实存在', () => {
    const handoff = readRepo(HANDOFF_PATH);
    for (const matrixItem of [
      '空库 / P02 v5 升级',
      '非法状态 / 外键 / 唯一约束',
      '依赖负例整组拒绝',
      '策略缺失 / 默认漂移',
      '越权',
      '幂等',
      'CAS',
      '事务故障',
      '状态/事件/回执真实一致性',
    ]) {
      expect(handoff).toContain(matrixItem);
    }
    for (const cited of CITED_TEST_FILES) {
      expect(existsSync(resolve(REPO_ROOT, cited)), `${HANDOFF_PATH} 引用的 ${cited} 必须存在`).toBe(true);
      const baseName = cited.split('/').pop() as string;
      expect(handoff, `交接文档必须引用 ${baseName}`).toContain(baseName);
    }
  });

  it('批准与活动保护证据明确区分纯规则/测试装配与尚未实现的 Work', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('纯规则');
    expect(handoff).toContain('测试装配');
    expect(handoff).toContain('尚未实现的 Work');
    expect(handoff).toContain('fail-closed');
    expect(handoff).toContain('decidePlanApprovalValidity');
    expect(handoff).toContain('NO_ACTIVE_EXECUTION_INPUTS_PROBE');
    // 活动保护接线约束：同事务重核 + start/claim 未来契约。
    expect(handoff).toContain('同一写事务');
    expect(handoff).toContain('start/claim');
  });

  it('验收索引 T02/T03 存储子集/T26 计划编辑子集/T32 元数据子集逐项映射且范围外显式 not_run', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('| T02 |');
    expect(handoff).toContain('T03（存储子集）');
    expect(handoff).toContain('T26（计划编辑子集）');
    expect(handoff).toContain('T32（元数据子集）');
    // 范围外子集显式 not_run（未运行不计通过）。
    expect(handoff.match(/not_run/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(handoff).toContain('依赖 passed 才解锁');
    expect(handoff).toContain('原子认领');
    expect(handoff).toContain('任一/全部标签筛选');
  });

  it('记录真实验证命令与退出码，accept:p03 与真实 Pi live 显式 not_run', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('`npm run verify`');
    expect(handoff).toContain('`npm run check:boundaries`');
    expect(handoff).toContain('exit 0');
    // 内联计数为形态可核对（数字 files/tests），精确值由 verifications/ 承载。
    expect(handoff).toMatch(/\d+ files \/ \d+ tests/);
    expect(handoff).toContain('accept:p03`：**not_run**');
    expect(handoff).toContain('真实 Pi live：**not_run**');
    expect(handoff).toContain('Windows/WSL/Linux：未验收');
  });

  it('明确 P03-2 复用面与不包含清单', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('P03-2 可复用的实体/命令/查询');
    expect(handoff).toContain('planDigest');
    expect(handoff).toContain('selectTaskStrategy');
    expect(handoff).toContain('活动保护接线约束');
    // 不包含清单（PRD §5 / 验收 5）。
    for (const excluded of ['配置/计划版本表', '模型规划', 'Feature DAG', 'Phase 生命周期不完整', 'Work/Runtime 未实现']) {
      expect(handoff).toContain(excluded);
    }
    // 能力目录已知缺口与测试装配边界（不是产品能力放宽）。
    expect(handoff).toContain('能力目录装配');
    expect(handoff).toContain('不是产品能力放宽');
  });

  it('F-011 集成回归测试与 dist 产物 Host 入口夹具存在，且集成回归声明正式构建纪律', () => {
    for (const fixture of F011_FIXTURE_FILES) {
      expect(existsSync(resolve(REPO_ROOT, fixture)), `${fixture} 必须存在`).toBe(true);
    }
    const regression = readRepo('test/modules/planning/p03-1-integration-regression.test.ts');
    expect(regression).toContain('npm run build');
    expect(regression).toContain('dist/bin.js');
    expect(regression).toContain('进程重开');
    expect(regression).toContain('库重开');
    const fixtureEntry = readRepo('test/helpers/host/dist-host-entry-catalog.mjs');
    expect(fixtureEntry).toContain('packages/host/dist/runtime/index.js');
    expect(fixtureEntry).toContain('packages/core/dist/index.js');
    expect(fixtureEntry).toContain('不是产品能力放宽');
  });
});
