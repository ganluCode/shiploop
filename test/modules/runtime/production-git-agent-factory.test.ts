import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { productionPiOptions } from '../../../packages/host/src/runtime/production-pi.ts';
import type { ProductionGitAgentAuthority } from '../../../packages/core/src/ports/git-agent-production.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';

it('[case:production-git-agent-factory-empty] no private runtime config means no GitAgent factory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'git-agent-factory-')));
  try { expect((await productionPiOptions(root)).gitAgentRuntimeFactory).toBeUndefined(); }
  finally { rmSync(root,{ recursive: true, force: true }); }
});

it('[case:core-git-agent-factory-static-injection] Core retains the trusted factory without starting Runtime', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'core-git-agent-factory-')));
  const start = vi.fn();
  const factory = vi.fn(() => ({ start }));
  const authority: ProductionGitAgentAuthority = { resolve:vi.fn(), assertCurrent:vi.fn(), confirmProcess:vi.fn(), inspectCandidate:vi.fn(), record:vi.fn() };
  const core = await openCoreApplication({ dataRoot: root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), gitAgentRuntimeFactory: factory });
  try {
    expect(factory).not.toHaveBeenCalled();
    expect(core.dagIntegration.capabilities().gitAgent).toBe('available');
    expect(core.dagIntegration.repairRuntime(authority).start).toBe(start);
    expect(factory).toHaveBeenCalledWith(authority);
    expect(start).not.toHaveBeenCalled();
    core.dagIntegration.enterQuiesce();
    expect(() => core.dagIntegration.repairRuntime(authority)).toThrow();
    expect(factory).toHaveBeenCalledTimes(1);
  } finally { await core.workExecution.close(); core.close(); rmSync(root,{recursive:true,force:true}); }
});

it('[case:core-git-agent-factory-invalid] Core rejects malformed static factories before exposing an application', async () => {
  for (const value of [null, {}, 'not-a-factory']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'invalid-git-agent-factory-')));
    try {
      await expect(openCoreApplication({ dataRoot: root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), gitAgentRuntimeFactory: value as never }))
        .rejects.toMatchObject({ kind:'validation', details: expect.objectContaining({ field: 'gitAgentRuntimeFactory' }) });
    } finally { rmSync(root,{recursive:true,force:true}); }
  }
});

it('[case:production-git-agent-factory-snapshot] factory reuses the loaded Pi config and constructs without authorization reads or model calls', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'git-agent-factory-')));
  try {
    mkdirSync(join(root,'pi'),{ mode: 0o700 });
    writeFileSync(join(root,'pi/runtime.json'),JSON.stringify({schemaVersion:1,providers:[{id:'offline',models:['test'],custom:{
      api:'openai-responses',baseUrl:'https://example.invalid/v1',contextWindow:10000,maxTokens:1000,reasoning:false,
    }}]}),{mode:0o600});
    const options = await productionPiOptions(root);
    expect(options.gitAgentRuntimeFactory).toBeTypeOf('function');
    writeFileSync(join(root,'pi/runtime.json'),'invalid');
    const authority: ProductionGitAgentAuthority = { resolve:vi.fn(), assertCurrent:vi.fn(), confirmProcess:vi.fn(), inspectCandidate:vi.fn(), record:vi.fn() };
    const adapter = options.gitAgentRuntimeFactory!(authority);
    expect(adapter.start).toBeTypeOf('function');
    for (const callback of Object.values(authority)) expect(callback).not.toHaveBeenCalled();
    expect(() => options.gitAgentRuntimeFactory!({} as ProductionGitAgentAuthority)).toThrow();
  } finally { rmSync(root,{ recursive: true, force: true }); }
});
