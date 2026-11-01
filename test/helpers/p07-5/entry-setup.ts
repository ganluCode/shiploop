import { beforeEach, expect } from 'vitest';
import { relative } from 'node:path';
import { P07_SCENE_CHECKS } from '../../../scripts/acceptance/p07-plan.ts';
import { publishP07EntryCapture, setP07ActiveCapture, type P07ActiveCapture } from './entry-observation.ts';

beforeEach(context => {
  const source = process.env.SHIPLOOP_P07_ENTRY_SOURCE;
  const file = relative(process.cwd(), context.task.file.filepath);
  if (!source || !P07_SCENE_CHECKS[file]) return;
  // Synthetic report negatives test the consumer; their invented facts cannot become scene evidence.
  if (file.endsWith('p07-5-f010-report.test.ts') && !context.task.name.includes('[case:p07-f010-real-drill-report]')) return;
  const capture: P07ActiveCapture = { file, title: context.task.name, observations: [], products: [] };
  setP07ActiveCapture(capture);
  context.onTestFinished(() => {
    setP07ActiveCapture(undefined);
    const assertions = expect.getState().assertionCalls;
    publishP07EntryCapture(source, JSON.parse(process.env.SHIPLOOP_P07_ENTRY_IDENTITY!), capture, {
      passed: context.task.result?.state === 'pass' && assertions > 0, assertions,
    });
  });
});
