import { expect, it, vi } from 'vitest';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createProductionPiGitAgentDriver, productionPiGitAgentRuntime } from '../../../packages/host/src/runtime/production-pi-git-agent.ts';
import type { ProductionGitAgentAuthority } from '../../../packages/host/src/runtime/production-pi-git-agent.ts';
import type { WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';

const production = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock('../../../packages/host/src/runtime/production-pi.ts', () => ({ productionPiOptions: production.options }));
const capabilityCatalog = createStaticRuntimeCapabilityCatalog([]);
const authority = (): ProductionGitAgentAuthority => ({
  resolve: vi.fn(), assertCurrent: vi.fn(), confirmProcess: vi.fn(), inspectCandidate: vi.fn(), record: vi.fn(),
});

it('[case:git-agent-production-no-runtime] refuses to construct a production adapter when no production runtime is installed', async () => {
  production.options.mockResolvedValue({ capabilityCatalog });
  const auth = authority();
  await expect(productionPiGitAgentRuntime('/unused-test-root', auth)).rejects.toMatchObject({
    kind: 'missing_runtime', reason: 'git_agent_driver_unavailable',
  });
  expect(auth.resolve).not.toHaveBeenCalled();
  expect(auth.assertCurrent).not.toHaveBeenCalled();
});

it('[case:git-agent-production-invalid-authority] requires every trusted authorization and recording boundary before construction', () => {
  const runtimeFactory = vi.fn() as WorkRuntimeFactory;
  for (const key of ['resolve', 'assertCurrent', 'confirmProcess', 'inspectCandidate', 'record'] as const) {
    for (const value of [undefined, null, true, 'private credential text']) {
      const auth = { ...authority(), [key]: value } as ProductionGitAgentAuthority;
      expect(() => createProductionPiGitAgentDriver({ runtimeFactory, capabilityCatalog, authority: auth }))
        .toThrow(expect.objectContaining({ kind: 'configuration', reason: 'git_agent_authority_invalid' }));
    }
  }
  expect(() => createProductionPiGitAgentDriver({ runtimeFactory, capabilityCatalog, authority: null as never }))
    .toThrow(expect.objectContaining({ reason: 'git_agent_authority_invalid' }));
  expect(runtimeFactory).not.toHaveBeenCalled();
});

it('[case:git-agent-production-invalid-runtime] rejects malformed explicitly supplied runtime factories before authorization or launch', () => {
  for (const runtimeFactory of [null, {}, 'private credential text']) {
    expect(() => createProductionPiGitAgentDriver({ runtimeFactory: runtimeFactory as WorkRuntimeFactory,
      capabilityCatalog, authority: authority() })).toThrow(expect.objectContaining({
      kind: 'configuration', reason: 'git_agent_driver_invalid',
    }));
  }
});
