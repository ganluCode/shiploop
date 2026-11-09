import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readSettingsFile } from '../../../packages/cli/src/config-file.ts';

function read(payload: unknown, extension = 'json') {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-shorthand-'));
  try {
    const file = join(root, 'config.' + extension);
    writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
    return readSettingsFile(file, 'config.update', true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('expands provider/model and Pi credentials in commented YAML for primary and fallbacks', () => {
  const parsed = read('schemaVersion: 2\nstrategies:\n  modelMap:\n    medium:\n      runtime: pi\n      model: ark-agentplan/ark-code-latest # primary\n      fallbacks:\n        - runtime: pi\n          model: another/org/model\n', 'yaml');
  expect(parsed).toEqual({ schemaVersion: 2, strategies: { modelMap: { medium: {
    runtime: 'pi', provider: 'ark-agentplan', model: 'ark-code-latest', credentialRef: 'credential://pi/ark-agentplan',
    fallbacks: [{ runtime: 'pi', provider: 'another', model: 'org/model', credentialRef: 'credential://pi/another' }],
  } } } });
});

it('normalizes all configuration strategy slots without changing unrelated data or explicit credentials', () => {
  const short = { runtime: 'pi', model: 'p/m' };
  const explicit = { runtime: 'pi', provider: 'p', model: 'org/model', credentialRef: 'credential://pi/custom' };
  const parsed = read({ schemaVersion: 2, strategies: { defaultStrategy: short, modelMap: { low: short },
    purposeStrategies: { planner: short }, agentOverrides: { coding: explicit } },
    policies: { featureAutoFix: { enabled: true, strategy: short }, feishu: { enabled: false } } });
  const expected = { runtime: 'pi', provider: 'p', model: 'm', credentialRef: 'credential://pi/p' };
  expect(parsed).toMatchObject({ strategies: { defaultStrategy: expected, modelMap: { low: expected },
    purposeStrategies: { planner: expected }, agentOverrides: { coding: explicit } },
    policies: { featureAutoFix: { strategy: expected }, feishu: { enabled: false } } });
});

it('fills credentials for split Pi format, leaves non-Pi auth optional and requires explicit runtime', () => {
  expect(read({ schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'p', model: 'm' } } }))
    .toMatchObject({ strategies: { defaultStrategy: { credentialRef: 'credential://pi/p' } } });
  expect(read({ schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'fake', model: 'p/m' } } }))
    .toEqual({ schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'fake', provider: 'p', model: 'm' } } });
  expect(read({ schemaVersion: 2, strategies: { defaultStrategy: { model: 'p/m' } } }))
    .toEqual({ schemaVersion: 2, strategies: { defaultStrategy: { provider: 'p', model: 'm' } } });
});

it.each(['p/', '/m', 'p//m', 'p/ ', ' p/m', 'p /m'])('rejects malformed shorthand %s before submission', model => {
  expect(() => read({ schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', model } } })).toThrow();
});

it('never interprets descriptions, labels or arbitrary nested objects as routing', () => {
  const payload = { schemaVersion: 2, policies: { feishu: { model: 'p/m' } }, description: 'p/m', labels: ['p/m'] };
  expect(read(payload)).toEqual(payload);
});
