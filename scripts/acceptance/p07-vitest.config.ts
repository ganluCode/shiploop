/** Explicit phase-only Vitest config; does not change npm test/verify defaults. */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from '../../vitest.config.ts';
import { P07_TOOLCHAIN } from './p07-config.ts';
export default defineConfig({ ...base, test: { ...base.test,
  maxWorkers: P07_TOOLCHAIN.defaultConcurrency,
  isolate: true,
  fileParallelism: true,
  setupFiles: [...(base.test?.setupFiles as string[] ?? []), fileURLToPath(new URL('../../test/helpers/p07-5/entry-setup.ts', import.meta.url))],
} });
