/**
 * P03-9 / F-016 真实 Host 强杀子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 父进程经 managed-child 的 ready/go 屏障启动本脚本；放行后以 config.dataRoot
 * 装配真实 Host（真实 SQLite + 锁 + 监听），并注入确定性 FakeRuntime：
 * - config.script / config.toolCommands / config.gates 只接受可信测试数据；
 * - 每个 adapter.start 在 config.markerDir/runtime-starts.jsonl 追加一行脱敏身份，
 *   供父进程核对“实际启动次数/Attempt 身份”，不依赖内存计数器；
 * - ready 消息包含真实 pid，host_ready 只表示 Host 已通过启动恢复并对外可用；
 * - 收到 close 时走产品 host.close()，进程异常退出码非 0；父进程强杀时本进程
 *   不执行任何清理，遗留受控工具进程由后续恢复核对。
 *
 * 不连接模型、不读取真实凭据；工作区/数据根全部来自隔离临时目录。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startHost } from '../../../packages/host/src/index.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken, createFakeRuntimeGate } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { readChildConfig } from '../host/child-runtime.ts';

const send = process.send?.bind(process);
if (!send) throw new Error('recovery-host-child 必须以 IPC 通道启动');

const config = readChildConfig();
if (typeof config.dataRoot !== 'string' || typeof config.markerDir !== 'string') {
  throw new Error('recovery-host-child: dataRoot/markerDir 必须是字符串');
}
const markerDir = config.markerDir;
const markerPath = join(markerDir, 'runtime-starts.jsonl');
mkdirSync(markerDir, { recursive: true });

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const capabilityCatalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);
const gates = Object.fromEntries((Array.isArray(config.gates) ? config.gates : [])
  .filter((name): name is string => typeof name === 'string')
  .map(name => [name, createFakeRuntimeGate()]));
const toolCommands = config.toolCommands;

const watchdog = setTimeout(() => {
  process.stderr.write('recovery-host-child: watchdog 超时\n');
  process.exit(9);
}, 120_000);

send({
  kind: 'ready', pid: process.pid, cwd: process.cwd(),
  home: process.env.HOME ?? '', tmpdir: process.env.TMPDIR ?? '',
});

function waitForGate(timeoutMs: number): Promise<'go' | 'close'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      reject(new Error('recovery-host-child: 等待父进程消息超时'));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (message === 'go') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('go');
        return;
      }
      if (typeof message === 'object' && message !== null &&
          (message as { kind?: unknown }).kind === 'close') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('close');
      }
    };
    process.on('message', onMessage);
  });
}

const gate = await waitForGate(30_000);
if (gate === 'close') {
  clearTimeout(watchdog);
  process.exit(0);
}

const host = await startHost({
  dataRoot: config.dataRoot,
  capabilityCatalog,
  env: {},
  workRuntimeFactory(context) {
    const requests = new Map<string, import('../../../packages/core/src/ports/runtime-execution.ts').RuntimeExecutionRequest>();
    const fake = createFakeRuntime({
      script: config.script,
      workspaceRoots: context.workspaceRoots,
      reader: context.reader,
      providers,
      gates,
      ...(toolCommands === undefined ? {} : { toolCommands: toolCommands as never }),
      ...(toolCommands === undefined ? {} : {
        commandProcess: createCommandProcessAdapter({
          stopGraceMs: typeof config.stopGraceMs === 'number' ? config.stopGraceMs : 200,
          stopConfirmMs: typeof config.stopConfirmMs === 'number' ? config.stopConfirmMs : 1_000,
        }),
        commitCommandIdentity: async (identity, launch) => {
          const request = requests.get(launch.invocationId);
          if (request === undefined) throw new TypeError('Unknown invocation');
          return context.commitCommandIdentity(identity, request);
        },
      }),
    });
    return {
      entries: [{
        descriptor: fake.descriptor,
        adapter: {
          ...fake.adapter,
          async start(request) {
            appendFileSync(markerPath, `${JSON.stringify({
              attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : null,
              invocationId: request.invocationId,
              sessionId: request.sessionId,
              executionVersion: request.executionVersion,
            })}\n`);
            requests.set(request.invocationId, request);
            return fake.adapter.start(request);
          },
        },
      }],
      eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`,
    };
  },
});

send({ kind: 'host_ready', pid: process.pid, port: host.port, hostInstanceId: host.hostInstanceId });
await waitForGate(120_000);
await host.close();
clearTimeout(watchdog);
send({ kind: 'closed', pid: process.pid });
process.exit(0);
