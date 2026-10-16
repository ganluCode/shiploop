/** Explicit isolated acceptance root; this module is absent from production imports. */
import { createFakeWorkRuntimeFactory, type FakeWorkOptions } from 'shiploop-core/testing';
import { startHost, type HostStartOptions } from './runtime/host-startup.js';
export function startFakeHost(options: HostStartOptions & { readonly fake: FakeWorkOptions }) {
  const { fake, ...host } = options;
  return startHost({ ...host, workRuntimeFactory: createFakeWorkRuntimeFactory(fake) });
}
