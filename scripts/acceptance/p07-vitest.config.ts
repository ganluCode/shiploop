/** Explicit phase-only Vitest config; does not change npm test/verify defaults. */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from '../../vitest.config.ts';
export default defineConfig({ ...base, test: { ...base.test,
  maxWorkers: 1,
  setupFiles: [...(base.test?.setupFiles as string[] ?? []), fileURLToPath(new URL('../../test/helpers/p07-5/entry-setup.ts', import.meta.url))],
} });
