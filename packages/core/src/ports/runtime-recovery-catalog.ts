import type { RuntimeCapabilityCatalog } from './runtime-capabilities.js';
import { validateRuntimeStrategyCapabilities } from './runtime-capabilities.js';
import { validateRuntimeStrategy } from './settings-schema.js';
import type { RuntimeRecoveryCapabilities } from './runtime-recovery.js';
import { validateRuntimeRecoveryCapabilities } from './runtime-recovery.js';
import { validationError } from './validation.js';

/** Trusted runtime evidence, independent of the configuration compatibility catalog. */
export interface RuntimeRecoveryCatalog {
  resolve(runtimeId: string): RuntimeRecoveryCapabilities | undefined;
}

export function createStaticRuntimeRecoveryCatalog(
  descriptors: unknown,
  configuration: RuntimeCapabilityCatalog,
): RuntimeRecoveryCatalog {
  const context = { operation: 'RuntimeRecoveryCatalog.create' };
  if (!Array.isArray(descriptors)) throw validationError(context, 'descriptors', 'array_required');
  const entries = new Map<string, RuntimeRecoveryCapabilities>();
  for (const value of descriptors) {
    const descriptor = validateRuntimeRecoveryCapabilities(value);
    if (entries.has(descriptor.runtimeId)) throw validationError(context, 'runtimeId', 'duplicate_runtime_id');
    if (configuration.resolve(descriptor.runtimeId) === undefined) {
      throw validationError(context, 'runtimeId', 'unknown_runtime');
    }
    entries.set(descriptor.runtimeId, descriptor);
  }
  return {
    resolve(runtimeId) {
      const value = entries.get(runtimeId);
      return value === undefined ? undefined : validateRuntimeRecoveryCapabilities(value);
    },
  };
}

export function validateRuntimeRecoveryStrategy(
  value: unknown,
  configuration: RuntimeCapabilityCatalog,
  recovery: RuntimeRecoveryCatalog | undefined,
): RuntimeRecoveryCapabilities | undefined {
  const context = { operation: 'RuntimeRecoveryStrategy.validate' };
  const strategy = validateRuntimeStrategy(value, context, 'strategy');
  validateRuntimeStrategyCapabilities(strategy, configuration, context, 'strategy');
  const raw = recovery?.resolve(strategy.runtime);
  if (raw === undefined) return undefined;
  const descriptor = validateRuntimeRecoveryCapabilities(raw);
  if (descriptor.runtimeId !== strategy.runtime) {
    throw validationError(context, 'descriptor.runtimeId', 'descriptor_runtime_mismatch');
  }
  return descriptor;
}
