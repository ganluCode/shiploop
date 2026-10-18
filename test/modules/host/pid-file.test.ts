import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { readPublishedPid } from '../../helpers/pid-file.ts';

describe('PID fixture publication', () => {
  it('waits across missing, created-empty and valid PID states', () => {
    const box = createTempSandbox('shiploop-pid-publication-');
    try {
      const file = join(box.path, 'pid');
      expect(readPublishedPid(file)).toBeUndefined();
      writeFileSync(file, '');
      expect(readPublishedPid(file)).toBeUndefined();
      writeFileSync(file, '12345\n');
      expect(readPublishedPid(file)).toBe(12345);
    } finally { box.cleanup(); }
  });
  it.each(['0', '1', 'NaN', '12x', '-5', '9007199254740993'])('rejects unsafe PID text %s', value => {
    const box = createTempSandbox('shiploop-pid-publication-');
    try {
      const file = join(box.path, 'pid');
      writeFileSync(file, value);
      expect(readPublishedPid(file)).toBeUndefined();
    } finally { box.cleanup(); }
  });
  it('does not interpret other filesystem failures as a missing PID', () => {
    const box = createTempSandbox('shiploop-pid-publication-');
    try { expect(() => readPublishedPid(box.path)).toThrow(); }
    finally { box.cleanup(); }
  });
});
