/**
 * F-019 文档守护：P03-10 交付报告、P03 人工验收清单与 P04 进入门槛记录核对。
 *
 * 依据 F-019 验收标准逐项守护：
 * 1. 交付报告引用 `docs/p03-10-f018-manual-acceptance.md` 与实际定向验收证据
 *    （受测提交、测试结果、修复内容、已知缺口各有独立段落）；
 * 2. 明确区分 Nezha 开发任务完成、Feature 索引验证、P03 人工阶段验收与 P04 放行
 *    四个层次，双次全量阶段复跑结论保持 pending/not_run，不伪造双次通过证据；
 * 3. 人工清单覆盖完成、预算耗尽、人审阻塞、最终失败、零 Runtime 收尾重试、恢复、
 *    现场与清理核对项，未实际重验的阶段项保留“待核对”；
 * 4. P04 门槛记录保留负责人身份、批准时间、理由与结论的空白填写位置，
 *    不自行批准、不因局部测试通过宣布 P04 放行；
 * 5. 边界声明覆盖 macOS、可信项目、单并发、Fake 验收与真实 Pi/live/Durable 实验，
 *    并声明不修改 P04-P08、执行模型策略或产品领域契约；
 * 6. 说明完整阶段验收在明确授权后由独立终端或受监督后台脚本执行，
 *    不占用模型单条 600 秒工具反复启动。
 *
 * 只断言稳定契约内容（引用、分层、清单覆盖、空白签署位与边界声明）；
 * 单次运行的测试计数、日志文件名等易变记录由 Harness 证据目录承载。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DELIVERY_REPORT_PATH = 'docs/p03-10-f019-delivery-report.md';
const MANUAL_CHECKLIST_PATH = 'docs/p03-10-f019-p03-manual-checklist.md';
const P04_GATE_PATH = 'docs/p03-10-f019-p04-gate-record.md';
const TASK_INDEX_PATH = 'test/index/phases/P03/features/P03-10/tasks/F-019.json';
const FEATURE_INDEX_PATH = 'test/index/phases/P03/features/P03-10/feature.json';

function readDoc(relativePath: string): string {
  const absolute = resolve(REPO_ROOT, relativePath);
  expect(existsSync(absolute), `${relativePath} 必须存在`).toBe(true);
  return readFileSync(absolute, 'utf-8');
}

describe('F-019 交付报告与人工验收文档守护', () => {
  it('[case:delivery-report-evidence] 交付报告引用 F-018 人工验收记录与定向证据，列明受测提交/结果/修复/缺口', () => {
    const doc = readDoc(DELIVERY_REPORT_PATH);
    expect(doc).toContain('docs/p03-10-f018-manual-acceptance.md');
    // 实际定向验收证据与其受测提交
    expect(doc).toContain('verifications/F-018/manual-20261019/verification.json');
    expect(doc).toContain('98d0a85241d9316ed9970ceaf23b8d5b10f2f8d0');
    for (const heading of ['受测提交', '测试结果', '修复', '已知缺口']) {
      expect(doc, `交付报告必须包含“${heading}”段落`).toContain(heading);
    }
  });

  it('[case:layer-distinction] 四层结论分离，双次全量阶段复跑保持 pending/not_run', () => {
    const doc = readDoc(DELIVERY_REPORT_PATH);
    for (const layer of ['Nezha 开发任务', 'Feature 索引验证', 'P03 人工阶段验收', 'P04 放行']) {
      expect(doc, `交付报告必须区分“${layer}”层次`).toContain(layer);
    }
    expect(doc).toMatch(/双次[^\n]*全量[^\n]*(pending|not_run)/);
    expect(doc).toContain('not_run');
    // 不伪造双次通过
    expect(doc).not.toMatch(/双次[^\n]*全量[^\n]*通过(?!证据)/);
  });

  it('[case:manual-checklist-coverage] 人工清单覆盖八类核对项，未重验阶段项保留待核对', () => {
    const doc = readDoc(MANUAL_CHECKLIST_PATH);
    for (const item of ['完成', '预算耗尽', '人审阻塞', '最终失败', '零 Runtime 收尾重试', '恢复', '现场', '清理']) {
      expect(doc, `人工清单必须包含“${item}”核对项`).toContain(item);
    }
    const pendingMarks = doc.match(/待核对/g) ?? [];
    expect(pendingMarks.length, '未实际重验的阶段项必须保留“待核对”标记').toBeGreaterThanOrEqual(8);
  });

  it('[case:signoff-placeholders] P04 门槛保留负责人/批准时间/理由/结论空白填写位，不自行批准', () => {
    const doc = readDoc(P04_GATE_PATH);
    for (const field of ['负责人身份', '批准时间', '理由', '结论']) {
      expect(doc, `门槛记录必须保留“${field}”填写位`).toMatch(
        new RegExp(`${field}[：:]\\s*（?待填写`),
      );
    }
    expect(doc, '门槛记录必须声明不自行批准').toMatch(/不自行批准|不能自行批准/);
    expect(doc, '门槛记录必须声明 P04 未放行').toMatch(/P04[^\n]*未放行/);
  });

  it('[case:scope-boundaries] 边界声明覆盖 macOS/可信项目/单并发/Fake 与真实 Pi/live/Durable', () => {
    const doc = readDoc(DELIVERY_REPORT_PATH) + readDoc(MANUAL_CHECKLIST_PATH) + readDoc(P04_GATE_PATH);
    for (const boundary of ['macOS', '可信项目', '单并发', 'Fake', '真实 Pi', 'live', 'Durable']) {
      expect(doc, `边界声明必须覆盖“${boundary}”`).toContain(boundary);
    }
    expect(doc, '必须声明不修改 P04-P08').toMatch(/不修改[^\n]*P04-P08/);
    expect(doc, '必须声明不修改执行模型策略').toMatch(/不修改[^\n]*执行模型策略/);
    expect(doc, '必须声明不修改产品领域契约').toMatch(/不修改[^\n]*产品领域契约/);
  });

  it('[case:full-acceptance-execution] 完整阶段验收授权后由独立终端或受监督后台脚本执行', () => {
    const doc = readDoc(DELIVERY_REPORT_PATH);
    expect(doc).toMatch(/独立终端|受监督后台/);
    expect(doc, '必须说明 600 秒工具限制').toContain('600');
    expect(doc).toMatch(/明确授权/);
  });

  it('[case:index-registration] F-019 测试索引按 v2 登记并被 Feature 索引引用', () => {
    const index = JSON.parse(readDoc(TASK_INDEX_PATH));
    expect(index.schema_version).toBe(2);
    expect(index.task_id).toBe('F-019');
    const files = index.projects.flatMap((p: { tests: { file: string }[] }) => p.tests.map((t) => t.file));
    expect(files).toContain('test/modules/acceptance/docs-p03-10-f019-delivery.test.ts');

    const feature = JSON.parse(readDoc(FEATURE_INDEX_PATH));
    const entry = (feature.tasks as { task_id: string; index: string }[]).find((t) => t.task_id === 'F-019');
    expect(entry, 'Feature 索引必须登记 F-019').toBeDefined();
    expect(entry?.index).toBe(TASK_INDEX_PATH);
  });
});
