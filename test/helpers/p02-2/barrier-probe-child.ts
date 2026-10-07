/**
 * F-004 跨进程竞争屏障探测子进程（仅测试夹具脚本，不进 packages/，不被 vitest 收集）。
 *
 * 配合 race-children.ts 的 ready/go 协议：
 * 1. runBarrierChild 自动发送 ready（含 pid/cwd/HOME/TMPDIR 诊断）并等待 go；
 * 2. 放行后按 config 行为：
 *    - hold=true：挂起到 close 请求（结果超时回收路径）；
 *    - delayMs>0：先等待该毫秒数（制造起跑重叠），再发送结果；
 * 3. 发送 {kind:<resultKind>, index, pid, atMs} 后场景结束，屏障运行时
 *    自动发 closed 并以退出码 0 结束（会话句柄不残留）。
 */
import { runBarrierChild, readChildConfig } from '../host/child-runtime.ts';

const config = readChildConfig();

const index = Number(config.index ?? 0);
if (!Number.isInteger(index) || index < 0) {
  throw new Error('barrier-probe-child: config.index 必须是非负整数');
}
const delayMs = Number(config.delayMs ?? 0);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
  throw new Error('barrier-probe-child: config.delayMs 必须是 [0,30000] 整数');
}
const hold = config.hold === true;
const resultKind = config.resultKind === undefined ? 'race-result' : String(config.resultKind);
if (!/^[a-z][a-z0-9_.-]{0,40}$/.test(resultKind)) {
  throw new Error(`barrier-probe-child: 非法 resultKind ${resultKind}`);
}

void runBarrierChild({
  scenario: {
    name: 'p02-2-barrier-probe',
    onGo: async ({ closeRequested }) => {
      const send = process.send?.bind(process);
      if (!send) {
        throw new Error('barrier-probe-child 必须以 IPC 通道启动');
      }
      if (hold) {
        await closeRequested;
        return;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      send({ kind: resultKind, index, pid: process.pid, atMs: Date.now() });
    },
  },
  goTimeoutMs: 15_000,
  watchdogMs: 45_000,
});
