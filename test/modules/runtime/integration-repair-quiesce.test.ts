import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';

const state = vi.hoisted(() => ({ prepare: vi.fn(), sourceReads: vi.fn() }));
vi.mock('../../../packages/core/src/adapters/integration-repair-context.ts', () => ({
  createIntegrationRepairContextService: () => ({prepare:state.prepare}),
}));
vi.mock('../../../packages/core/src/adapters/sqlite/integration-repair-authorizations.ts', () => ({
  createSqliteIntegrationRepairAuthorizations: () => ({read:() => {
    state.sourceReads();
    return {request:{source:{operationId:'source-operation'}}};
  }}),
}));

it.each(['resolve','reject'] as const)('[case:integration-repair-quiesce-%s] tracks one preparation through shutdown and shares its result', async mode => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'repair-quiesce-')));
  state.prepare.mockReset();state.sourceReads.mockClear();
  let resolve!: (value:unknown) => void, reject!: (error:Error) => void;
  const deferred = new Promise((yes,no)=>{resolve=yes;reject=no;});
  state.prepare.mockReturnValue(deferred);
  const core = await openCoreApplication({dataRoot:root,capabilityCatalog:createStaticRuntimeCapabilityCatalog([])});
  const operations: Promise<unknown>[] = [];
  try {
    const first = core.dagIntegration.prepareRepairContext('project','repair');
    const second = core.dagIntegration.prepareRepairContext('project','repair');
    operations.push(first,second);
    const observed = Promise.allSettled(operations);
    expect(core.dagIntegration.activeCount()).toBe(1);
    await Promise.resolve();await Promise.resolve();
    expect(state.prepare).toHaveBeenCalledTimes(1);
    expect(state.sourceReads).toHaveBeenCalledTimes(1);
    expect(core.dagIntegration.enterQuiesce()).toEqual({accepted:1});
    expect(await core.dagIntegration.awaitQuiesce(0)).toEqual({confirmed:false,pending:['integration_in_progress']});
    await expect(core.dagIntegration.prepareRepairContext('project','repair')).rejects.toMatchObject({details:{reason:'integration_quiescing'}});
    const receipt = {repairId:'repair',artifact:{artifactId:'context'}};
    if(mode==='resolve')resolve(receipt);else reject(new Error('publication failed'));
    const results = await observed;
    if(mode==='resolve')expect(results).toEqual([{status:'fulfilled',value:receipt},{status:'fulfilled',value:receipt}]);
    else for(const result of results)expect(result).toMatchObject({status:'rejected',reason:{message:'publication failed'}});
    expect(await core.dagIntegration.awaitQuiesce(100)).toEqual({confirmed:true,pending:[]});
    expect(core.dagIntegration.activeCount()).toBe(0);
  } finally {
    resolve({});
    await Promise.allSettled(operations);
    await core.workExecution.close();core.close();rmSync(root,{recursive:true,force:true});
  }
});
