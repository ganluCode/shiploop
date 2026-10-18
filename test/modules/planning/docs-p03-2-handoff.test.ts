/**
 * F-009 文档守护：P03-2 交接文档（docs/p03-2-handoff.md）核对。
 *
 * 依据 F-009 验收标准 3/5/6 逐项守护：
 * 1. 交接记录实现范围（F-001 ~ F-009 逐项）、输入文档版本、实际基线与代码 commit
 *   （P03-1 基线 427c0a0 + 各 Feature 提交锚点）、真实验证命令与退出码形态、脱敏
 *    证据路径指向 Feature 工作区、已知缺口与 not_run 边界（未运行不计通过）；
 * 2. T24、T25 输入子集、T26 审批子集、T37 逐项映射，范围外部分显式 not_run，
 *    不宣称后序执行或会话能力通过；引用的回归测试文件必须真实存在（不得虚引）；
 * 3. P03-3/4 交接面完整：有效批准核验入口与失败词汇、策略 revision 与内容身份、
 *    不可变制品组与输入摘要绑定方式、历史回执重放边界、失败/漂移语义；
 * 4. F-009 集成回归测试存在且其断言面（无执行实体表/事件白名单/命令面无执行启动
 *    操作/正式构建产物链路）在文档中如实记录；accept:p03 与真实 Pi live 显式
 *    not_run；
 * 5. 三份 p03-2 契约文档含 F-009 写回登记；README 登记交接文档。
 *
 * 只断言稳定契约内容（结构、存在性、边界声明、脱敏措辞）；单次运行的计数精确值
 * 与 run-id 等易变记录由 Feature 工作区 verifications/ 承载，本文档内联计数只要求
 * 形态可核对，不做跨 Feature 的脆弱精确相等。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HANDOFF_PATH = 'docs/p03-2-handoff.md';
const README_PATH = 'README.md';

function readRepo(relativePath: string): string {
  const absolute = resolve(REPO_ROOT, relativePath);
  expect(existsSync(absolute), `${relativePath} 必须存在`).toBe(true);
  return readFileSync(absolute, 'utf8');
}

/** 交接文档引用的回归测试文件必须真实存在（防虚引/删除后文档失实）。 */
const CITED_TEST_FILES: readonly string[] = [
  'test/modules/planning/p03-2-task-strategy-edit-command.test.ts',
  'test/modules/planning/p03-2-plan-approval-command.test.ts',
  'test/modules/planning/p03-2-plan-approval-verification.test.ts',
  'test/modules/planning/p03-2-execution-input.test.ts',
  'test/modules/planning/p03-2-context-build.test.ts',
  'test/modules/planning/p03-2-execution-input-prepare.test.ts',
  'test/modules/planning/p03-2-host-wiring.test.ts',
  'test/modules/planning/p03-2-cli-args.test.ts',
  'test/modules/planning/p03-2-cli-vertical.test.ts',
  'test/modules/planning/p03-2-cli-built.test.ts',
  'test/modules/planning/p03-2-integration-regression.test.ts',
  'test/modules/planning/p03-1-task-strategy-selection.test.ts',
  'test/modules/planning/p03-1-plan-revise-command.test.ts',
  'test/modules/cli/app-cli-config-execute.test.ts',
];

/** F-009 交付的集成回归测试与正式构建链路事实。 */
const F009_TEST_FILE = 'test/modules/planning/p03-2-integration-regression.test.ts';

/** F-009 写回登记的三份契约文档。 */
const REGISTERED_CONTRACT_DOCS: readonly string[] = [
  'docs/p03-2-plan-approval-verification-contract.md',
  'docs/p03-2-execution-input-prepare-contract.md',
  'docs/p03-2-cli-approval-input-operations.md',
];

describe('F-009 交接文档守护（docs/p03-2-handoff.md）', () => {
  it('文档存在且登记于 README 文档索引；引用的回归测试文件真实存在', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('# P03-2 计划批准、Task 策略与固定执行输入 — 交接');
    const readme = readRepo(README_PATH);
    expect(readme).toContain('docs/p03-2-handoff.md');
    for (const cited of CITED_TEST_FILES) {
      expect(existsSync(resolve(REPO_ROOT, cited)), `${cited} 必须存在`).toBe(true);
      expect(handoff, `交接文档必须引用 ${cited}`).toContain(cited);
    }
    expect(existsSync(resolve(REPO_ROOT, F009_TEST_FILE))).toBe(true);
  });

  it('记录实现范围（F-001 ~ F-009 逐项）、输入文档版本与基线/代码 commit', () => {
    const handoff = readRepo(HANDOFF_PATH);
    for (const feature of ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008', 'F-009']) {
      expect(handoff).toContain(feature);
    }
    // 输入文档版本（PRD + P03-1 交接 + 六份实施契约与操作说明）。
    expect(handoff).toContain('p03-2-plan-approval-input.md');
    expect(handoff).toContain('p03-1-handoff.md');
    for (const contract of [
      'p03-2-task-strategy-edit-contract.md',
      'p03-2-plan-approval-contract.md',
      'p03-2-plan-approval-verification-contract.md',
      'p03-2-execution-input-contract.md',
      'p03-2-context-build-contract.md',
      'p03-2-execution-input-prepare-contract.md',
      'p03-2-cli-approval-input-operations.md',
    ]) {
      expect(handoff).toContain(contract);
    }
    // 基线与代码提交锚点（P03-1 验收基线 + P03-2 各 Feature 提交）。
    expect(handoff).toContain('427c0a0');
    for (const commit of ['a7a53ff', 'cbb310e', '202d796', '1e4baf8', 'f1defe7', '3f77dd2', '22ab867', 'dffa406', 'd16b842']) {
      expect(handoff).toContain(commit);
    }
    // F-009 交接提交的自引用限制与权威记录位置必须如实说明。
    expect(handoff).toContain('verifications/F-009/');
    expect(handoff).toContain('未运行不计通过');
  });

  it('Schema 与执行边界如实：迁移 v7/v8、未建执行实体表、未启动 Work/未调用真实模型', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('approvals.check_policy_digest');
    expect(handoff).toContain('未建表');
    for (const entity of ['Batch', 'Run', 'Attempt', 'Work']) {
      expect(handoff).toContain(entity);
    }
    expect(handoff).toContain('未调用真实模型');
    expect(handoff).toContain('未启动 Work');
    expect(handoff).toContain('PUBLIC_STATE_EVENT_TYPES');
    // 集成回归的三方核验面在文档中可核对。
    expect(handoff).toContain('host stop');
    expect(handoff).toContain('逐字节');
  });

  it('P03-3/4 交接面完整：核验入口/失败词汇/策略 revision/制品组绑定/重放边界', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('verifyFeaturePlanApprovalInTransaction');
    expect(handoff).toContain('evaluatePlanApprovalValidity');
    expect(handoff).toContain('check_policy_changed');
    expect(handoff).toContain('plan_changed');
    expect(handoff).toContain('approval_state_inconsistent');
    expect(handoff).toContain('task.strategy.update');
    expect(handoff).toContain('computeExecutionStrategyCopyDigest');
    expect(handoff).toContain('PreparedExecutionInputGroup');
    expect(handoff).toContain('execution-input-groups/<taskId>/<part>');
    expect(handoff).toContain('computeExecutionPermissionsDigest');
    expect(handoff).toContain('EXECUTION_INPUT_PREPARE_FAILURE_REASONS');
    // 历史回执重放边界与漂移词汇。
    expect(handoff).toContain('历史回执重放');
    expect(handoff).toContain('task_strategy_changed');
    expect(handoff).toContain('permissions_changed');
    // 预算与装配边界。
    expect(handoff).toContain('inputSourceRoots');
    expect(handoff).toContain('unknown_root');
    expect(handoff).toContain('TRUSTED_PROJECT_PERMISSIONS_READER');
    expect(handoff).toContain('400 000');
  });

  it('T24 / T25 输入子集 / T26 审批子集 / T37 映射与 not_run 边界（不宣称后序能力）', () => {
    const handoff = readRepo(HANDOFF_PATH);
    for (const matrix of ['T24', 'T25', 'T26', 'T37']) {
      expect(handoff).toContain(matrix);
    }
    expect(handoff).toContain('not_run');
    // T24 范围外：重新应用默认预览。
    expect(handoff).toContain('重新应用默认预览');
    // T25 输入子集范围外：真实活动 Attempt 竞争与预算清零。
    expect(handoff).toContain('返工换模型不清预算');
    // T37 范围外：缓存收益不宣称。
    expect(handoff).toContain('缓存收益不以静态测试宣称');
    // 不宣称后序执行或会话能力通过。
    expect(handoff).toContain('不宣称后序执行或会话能力通过');
    expect(handoff).toContain('accept:p03');
    expect(handoff).toContain('P03-10');
    expect(handoff).toContain('真实 Pi live');
  });

  it('验证记录与已知缺口：真实命令/退出码形态、脱敏证据路径、不得折算通过', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('npm run verify');
    expect(handoff).toContain('npm run check:boundaries');
    expect(handoff).toContain('exit 0');
    expect(handoff).toContain('tool-logs/F-009-*.log');
    expect(handoff).toContain('已知缺口（不折算通过）');
    // 生产 Host 能力目录缺口沿用 P03-1 记录（不是产品能力放宽）。
    expect(handoff).toContain('受信测试目录装配');
    // 制品读取边界与 Core 层覆盖归属如实。
    expect(handoff).toContain('仅限 P02-3 基线输出成员');
    expect(handoff).toContain('readVerifiedContent');
    expect(handoff).toContain('MAX_APP_BODY_BYTES');
  });

  it('三份 p03-2 契约文档含 F-009 写回登记', () => {
    for (const contract of REGISTERED_CONTRACT_DOCS) {
      const body = readRepo(contract);
      expect(body, `${contract} 必须含 F-009 写回登记`).toContain('F-009');
      expect(body, `${contract} 必须引用集成回归测试`).toContain(
        'test/modules/planning/p03-2-integration-regression.test.ts',
      );
    }
  });

  it('交接纪律：不重建/不弱化清单与守护同源声明', () => {
    const handoff = readRepo(HANDOFF_PATH);
    expect(handoff).toContain('不得重建');
    expect(handoff).toContain('不得弱化');
    expect(handoff).toContain('批准不是启动授权');
    expect(handoff).toContain('test/modules/planning/docs-p03-2-handoff.test.ts');
  });
});
