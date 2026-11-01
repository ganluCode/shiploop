/**
 * P07-5 / F-006 受控标准 Pi 原生写入者子进程（仅测试使用，不进 packages/）。
 *
 * 以真实 SDK SessionManager 与生产 createPiManagedSessionManager 入口演练
 * 原生档案单写入者边界；全程不调用模型，只追加真实离线消息：
 *
 * - hold <cwd> <sessionDir> <readyFile> <releaseFile>：在受管目录创建全新原生
 *   会话并落盘真实进展，就绪后经 ready 文件公布会话身份，随后在 release 文件
 *   屏障上持有写入者（模拟存活旧进程持有同一原生 scope）；
 * - try-open <cwd> <sessionDir>：尝试在同一目录创建第二个受管会话（预期被
 *   拒绝时以 rejected:<reason> 退出 1）；
 * - fork <cwd> <targetDir> <sourceFile>：从指定来源 JSONL 字节（模拟经 Core
 *   制品验证的不可变内容，绝不读取仍打开的原生文件）经受管安全复制/分支在
 *   全新目录续接，公布 forked:<sessionId>。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createPiManagedSessionManager } from '../../../packages/host/src/runtime/pi-native-session.ts';

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function waitMarker(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`marker timeout: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main(): Promise<void> {
  const [mode, cwd, second, third, fourth] = process.argv.slice(2);
  if (mode === 'hold') {
    const manager = await createPiManagedSessionManager({ SessionManager }, cwd, second);
    manager.appendMessage({ role: 'user', content: 'existing work', timestamp: 1 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous answer' }],
      provider: 'anthropic', model: 'claude-sonnet-4-5', api: 'anthropic-messages', timestamp: 2,
      stopReason: 'stop', usage });
    writeFileSync(third, JSON.stringify({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() }));
    await waitMarker(fourth, 120_000);
    return;
  }
  if (mode === 'try-open') {
    const manager = await createPiManagedSessionManager({ SessionManager }, cwd, second);
    manager.appendMessage({ role: 'user', content: 'second writer attempt', timestamp: 1 });
    process.stdout.write(`opened:${manager.getSessionId()}\n`);
    return;
  }
  if (mode === 'fork') {
    const archive = new Uint8Array(readFileSync(third));
    const header = JSON.parse(new TextDecoder().decode(archive).split('\n')[0]) as { id: string };
    const prepared = {
      archive,
      reference: { providerSessionId: header.id, sourceDigest: createHash('sha256').update(archive).digest('hex') },
      assertCurrent: async () => {},
    };
    const manager = await createPiManagedSessionManager({ SessionManager }, cwd, second, prepared);
    process.stdout.write(`forked:${manager.getSessionId()}\n`);
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

main().then(() => { process.exit(0); }, (error: unknown) => {
  process.stdout.write(`rejected:${(error as { reason?: string }).reason ?? `unexpected:${(error as Error).message}`}\n`);
  process.exit(1);
});
