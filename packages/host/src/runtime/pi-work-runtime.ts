/** Trusted static Work assembly. Executable/environment are code dependencies, never project settings. */
import { createStaticRuntimeRegistry, RuntimeError } from 'shiploop-core';
import type { WorkInferencePreflightAssembly } from 'shiploop-core';
import type { WorkRuntimeFactory, WorkFailureRoutingAssembly } from 'shiploop-core/assembly';
import {
  assertPiStartupCompatible, createPiRuntimeDescriptor, piRuntimeEventPrefix, PI_RUNTIME_ID,
} from './pi-adapter.js';
import type { PiRuntimeAdapterOptions, PiTrustedAssembly } from './pi-adapter.js';
import { createPiRunnerAdapter } from './pi-runner-adapter.js';
import type { PiRunnerAdapterOptions } from './pi-runner-adapter.js';

export type PiWorkRuntimeOptions = Pick<PiRuntimeAdapterOptions, 'providers' | 'permissionGrants' | 'isolationModes'>
  & Omit<PiRunnerAdapterOptions, 'confirm'>
  & { readonly prepareAccess?: PiTrustedAssembly['prepareAccess'];
    readonly inferencePreflight?: WorkInferencePreflightAssembly;
    readonly failureRouting?: WorkFailureRoutingAssembly };

/** Trusted static startup only; optional approved failure routing is delegated to Core. */
export function createPiWorkRuntimeFactory(options: PiWorkRuntimeOptions): WorkRuntimeFactory {
  // Snapshot mutable caller arrays before the application becomes active.
  const descriptor = createPiRuntimeDescriptor(options);
  const argv = [...options.argv], environment = { ...options.environment };
  return context => {
    const capability = context.capabilityCatalog.resolve(PI_RUNTIME_ID);
    if (capability !== undefined && (capability.contractVersion === undefined
      || capability.permissionGrants === undefined || capability.isolationModes === undefined)) {
      throw new RuntimeError('configuration', 'pi_capability_declarations_required');
    }
    const runner = createPiRunnerAdapter({ ...options, argv, environment, confirm: context.commitCommandIdentity });
    const entries = [{ descriptor, adapter: { async start(request: Parameters<typeof runner.start>[0]) {
      if (request.strategy.runtime !== PI_RUNTIME_ID) throw new RuntimeError('configuration', 'descriptor_runtime_mismatch');
      assertPiStartupCompatible(request, descriptor);
      if (request.permissions.grants.some(grant => !descriptor.permissionGrants.includes(grant))) {
        throw new RuntimeError('permission', 'grant_not_enforceable');
      }
      return runner.start(request);
    } } }];
    // Same registry contract as Core, including unknown IDs and complete catalog agreement.
    createStaticRuntimeRegistry(entries, context.capabilityCatalog);
    return {
      entries,
      eventIdentityPrefix: piRuntimeEventPrefix,
      inferencePreflight: options.inferencePreflight,
      failureRouting: options.failureRouting,
      ...(options.prepareAccess === undefined ? {} : {
        prepareRequest: async (request: Parameters<typeof runner.start>[0]) => {
          const prepared = await options.prepareAccess!(request);
          return { ...request, workAccess: prepared.snapshot };
        },
      }),
    };
  };
}
