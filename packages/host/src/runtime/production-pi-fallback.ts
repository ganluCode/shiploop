import { createHash } from 'node:crypto';
import type { RuntimeCapabilityCatalog } from 'shiploop-core';
import type { WorkFailureRoutingAssembly } from 'shiploop-core/assembly';
import type { ProductionPiConfig } from './production-pi-config.js';
import { readProductionPiCredential } from './production-pi-config.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Routes are frozen per Task; no sticky fallback provider leaks into the next Task. */
export function createProductionPiFallback(options: {
  readonly dataRoot: string;
  readonly config: ProductionPiConfig;
  readonly descriptor: unknown;
  readonly catalog: RuntimeCapabilityCatalog;
  readonly controlsFor?: (projectId: string) => ProductionPiConfig['pi_agent'];
}): WorkFailureRoutingAssembly {
  return {
    select({ projectId, runId, taskId, strategy, routing }) {
      if (!routing?.fallbacks?.length) return undefined;
      const controls = { ...options.config.pi_agent, ...options.controlsFor?.(projectId) };
      const configured = {
        ...(controls?.fallback_on_connection_exhausted === false ? { onTransientConnection: 'stop' as const } : {}),
        ...(controls?.fallback_on_server_exhausted === false ? { onTransientServer: 'stop' as const } : {}),
        ...(controls?.fallback_on_authentication === false ? { onAuthentication: 'stop' as const } : {}),
        ...routing.fallbackPolicy,
      };
      const actions = [
        ['onQuotaBlocked', 'quota_blocked'], ['onTransientConnection', 'transient_connection'],
        ['onTransientServer', 'transient_server'], ['onAuthentication', 'authentication'],
      ] as const;
      const policy = { switchOn: actions.filter(([key]) => configured[key] !== 'stop').map(([, category]) => category), ...configured };
      const plan = { schemaVersion: 1 as const,
        preferred: { strategy: { ...strategy }, source: 'task.primary', approved: true as const },
        fallbacks: routing.fallbacks.map((item, i) => ({ strategy: { ...item }, source: `task.fallback.${i + 1}`, approved: true as const })), policy };
      return { plan, policyVersion: 'production-pi-fallback-v1', capabilityEvidence: {
        catalogDigest: digest(options.catalog.resolve('pi')), registryDigest: digest(options.descriptor),
        authorizationDigest: digest({ projectId, runId, taskId, plan }),
      } };
    },
    async authorize({ strategy }) {
      if (strategy.runtime !== 'pi') return false;
      const provider = options.config.providers.find(p => p.id === strategy.provider);
      if (!provider?.models.includes(strategy.model)
        || strategy.credentialRef !== `credential://pi/${provider.id}`
        || (strategy.endpointRef !== undefined && (!provider.custom || strategy.endpointRef !== `endpoint://pi/${provider.id}`))) return false;
      try { readProductionPiCredential(options.dataRoot, provider.id); return true; }
      catch { return false; }
    },
  };
}
