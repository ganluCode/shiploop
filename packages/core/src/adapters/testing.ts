/** Explicit test/acceptance assembly. Production assembly never imports this entry. */
import { openCoreApplication, type CoreApplicationOptions, type WorkRuntimeFactory } from './composition.js';
import { createFakeRuntime, fakeRuntimeCorrelationToken, type FakeRuntimeOptions } from './fake-runtime.js';
import type { RuntimeExecutionRequest } from '../ports/runtime-execution.js';
export { createFakeRuntimeGate } from './fake-runtime.js';
export type { FakeRuntimeOptions } from './fake-runtime.js';

export type FakeWorkOptions = Omit<FakeRuntimeOptions, 'workspaceRoots' | 'reader' | 'commitCommandIdentity'>;
export function createFakeWorkRuntimeFactory(options: FakeWorkOptions): WorkRuntimeFactory {
  return context => {
    const requests = new Map<string, RuntimeExecutionRequest>();
    const fake = createFakeRuntime({ ...options, workspaceRoots: context.workspaceRoots, reader: context.reader,
      commitCommandIdentity: (identity, launch) => {
        const request = requests.get(launch.invocationId);
        if (!request) throw new TypeError('Unknown invocation');
        return context.commitCommandIdentity(identity, request);
      } });
    return { entries: [{ descriptor: fake.descriptor, adapter: { async start(request) {
      requests.set(request.invocationId, request);
      try {
        const handle = await fake.adapter.start(request);
        void handle.stopped.then(() => requests.delete(request.invocationId), () => undefined);
        return handle;
      } catch (error) { requests.delete(request.invocationId); throw error; }
    } } }], eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.` };
  };
}
export function openFakeCoreApplication(options: CoreApplicationOptions & { readonly fake: FakeWorkOptions }) {
  const { fake, ...core } = options;
  return openCoreApplication({ ...core, workRuntimeFactory: createFakeWorkRuntimeFactory(fake) });
}
