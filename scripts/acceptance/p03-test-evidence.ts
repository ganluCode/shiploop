/** Phase evidence binds actual Vitest assertions to reviewed Task indexes, not an exit-code claim. */
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { P03_REQUIRED_CHECK_IDS } from './p03-config.ts';

export interface P03TestBinding { readonly checkId: string; readonly file: string; readonly cases: readonly string[] }
export interface P03TestProof {
  readonly checkId: string;
  readonly passed: boolean;
  readonly bindings: readonly { readonly file: string; readonly cases: readonly string[]; readonly assertions: readonly string[]; readonly passed: boolean }[];
}
const tasks: Readonly<Record<string, readonly string[]>> = {
  'P03-FR1-CLOSED-LOOP': ['10/003', '10/016'],
  'P03-FR1-NEG-INTEGRITY': ['10/002', '10/016'],
  'P03-FR2-MATRIX': ['10/007', '10/008', '10/009', '10/011', '10/012', '9/016'],
  'P03-FR2-NEG-GUARDRAILS': ['10/008', '10/009', '10/013', '9/003'],
  'P03-FR3-REPORT': ['10/004', '10/005', '10/006'],
  'P03-FR3-NEG-REPORT-INTEGRITY': ['10/004', '10/006', '10/016'],
  'P03-T02': ['10/007'], 'P03-T03': ['10/007'], 'P03-T04': ['10/003', '10/007'],
  'P03-T06': ['9/003', '9/004', '9/016'], 'P03-T07': ['10/009', '10/011'],
  'P03-T08': ['10/012'], 'P03-T13': ['10/007', '10/009', '9/004'],
  'P03-T21': ['10/007'], 'P03-T24': ['10/008'], 'P03-T25': ['10/008', '10/009'],
  'P03-T26': ['10/008'], 'P03-T29': ['10/007'], 'P03-T31': ['10/007'],
  'P03-T35': ['10/011'], 'P03-T36': ['10/013'], 'P03-T37': ['10/010'],
  'P03-T38': ['10/004', '10/006'], 'P03-T39': ['10/008'], 'P03-T40': ['10/009', '9/016'],
  'P03-VERT-COMPLETE': ['10/003'], 'P03-VERT-BUDGET-EXHAUSTED': ['10/007'],
  'P03-VERT-MANUAL-BLOCK': ['10/008'], 'P03-VERT-FINAL-FAIL': ['10/013'],
  'P03-VERT-RETRY-FINAL': ['10/013'],
};

export function requiredP03TestBindings(root: string): P03TestBinding[] {
  const bindings: P03TestBinding[] = [];
  for (const checkId of P03_REQUIRED_CHECK_IDS) {
    if (!tasks[checkId]?.length) throw new Error(`Missing P03 check mapping: ${checkId}`);
    for (const task of tasks[checkId]!) {
      const [feature, id] = task.split('/');
      const path = resolve(root, `test/index/phases/P03/features/P03-${feature}/tasks/F-${id}.json`);
      const document = JSON.parse(readFileSync(path, 'utf8'));
      if (document.schema_version !== 2 || document.task_id !== `F-${id}` || !Array.isArray(document.projects)) throw new Error('Invalid P03 Task index');
      for (const project of document.projects) {
        if (project.id !== 'shiploop' || !Array.isArray(project.tests) || project.tests.length === 0) throw new Error('Invalid P03 test project');
        for (const test of project.tests) {
          const file = test.file;
          if (typeof file !== 'string' || !/^test\/modules\/[A-Za-z0-9_./-]+\.test\.ts$/.test(file) || file.split('/').includes('..')) throw new Error('Invalid P03 test file');
          const located = relative(realpathSync(root), realpathSync(resolve(root, file)));
          if (located.startsWith('..') || isAbsolute(located)) throw new Error('P03 test file escapes repository');
          if (test.all !== true && (!Array.isArray(test.cases) || test.cases.length === 0 || test.cases.some((id: unknown) => typeof id !== 'string'))) throw new Error('Invalid P03 case selection');
          bindings.push({ checkId, file, cases: test.all === true ? [] : [...test.cases] });
        }
      }
    }
  }
  bindings.push({ checkId: 'P03-T02', file: 'test/modules/scheduling/p03-4-task-dag.test.ts', cases: [] });
  return bindings;
}

export function evaluateP03TestEvidence(root: string, raw: unknown): P03TestProof[] {
  const report = raw as { success?: unknown; testResults?: unknown } | null;
  const files = Array.isArray(report?.testResults) ? report.testResults as {name?: unknown; assertionResults?: unknown}[] : [];
  const bindings = requiredP03TestBindings(root);
  return P03_REQUIRED_CHECK_IDS.map(checkId => {
    const evidence = bindings.filter(b => b.checkId === checkId).map(binding => {
      const matches = files.filter(f => typeof f?.name === 'string' && resolve(root, f.name) === resolve(root, binding.file));
      const assertions = matches.length === 1 && Array.isArray(matches[0]!.assertionResults)
        ? matches[0]!.assertionResults as {fullName?: unknown; status?: unknown}[] : [];
      const selected = binding.cases.length === 0 ? assertions : assertions.filter(a => {
        const name = a?.fullName;
        return typeof name === 'string' && binding.cases.some(id => name.includes(`[case:${id}]`));
      });
      const uniqueCases = binding.cases.every(id => selected.filter(a => typeof a.fullName === 'string' && a.fullName.includes(`[case:${id}]`)).length === 1);
      const passed = report?.success === true && matches.length === 1 && selected.length > 0 && uniqueCases
        && selected.every(a => typeof a?.fullName === 'string' && a.status === 'passed');
      return { ...binding, assertions: selected.flatMap(a => typeof a?.fullName === 'string' ? [a.fullName] : []), passed };
    });
    return { checkId, passed: evidence.length > 0 && evidence.every(e => e.passed), bindings: evidence };
  });
}
