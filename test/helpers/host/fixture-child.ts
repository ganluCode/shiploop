/**
 * F-005 夹具专用子进程场景脚本（仅测试使用，不是产品实现）。
 *
 * 父进程以
 *   node --import test/helpers/node-ts-loader/register.mjs <本文件> '<json config>'
 * 启动，config.scenario 选择下列**真实进程**场景，全部由父进程经
 * managed-child 受管回收：
 *
 * - ready-listen   ：ready → 等 go → 在 127.0.0.1:0 建真实 TCP 服务并上报
 *                    listening；在 $HOME 写 marker 证明环境重定向；close 收尾退出 0；
 * - never-ready    ：不发 ready 也不退出（父进程有界等待超时后负责信号回收）；
 * - early-exit     ：启动即 exit(7)（启动失败路径）；
 * - wrong-pid-ready：ready 中谎报 pid+1，但 OS 进程仍可被句柄回收（身份核验负例）；
 * - crash-after-go ：放行后立即 SIGKILL 自己（异常退出/信号核验路径）；
 * - ignore-sigterm ：忽略 SIGTERM 与 IPC close，只受 SIGKILL（升级回收路径）。
 *
 * 不连接模型、不打开 SQLite；所有路径来自重定向后的 HOME/TMPDIR。
 */
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runBarrierChild } from './child-runtime.ts';

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? '{}') as { scenario?: string };
  const scenario = config.scenario;

  if (scenario === 'early-exit') {
    process.exit(7);
  }

  if (scenario === 'never-ready') {
    // 保持事件循环存活但不报告 ready；watchdog（60s）是最后的本进程兜底，
    // 正常情况下父进程的有界等待会先 SIGTERM 回收。
    setTimeout(() => process.exit(9), 60_000);
    return;
  }

  if (scenario === 'wrong-pid-ready') {
    const send = process.send!.bind(process);
    send({
      kind: 'ready',
      pid: process.pid + 1, // 故意谎报：父进程必须只信任 spawn 句柄 pid
      cwd: process.cwd(),
      home: process.env.HOME ?? '',
      tmpdir: process.env.TMPDIR ?? '',
    });
    process.on('message', (message) => {
      if (typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'close') {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(9), 60_000);
    return;
  }

  if (scenario === 'ready-listen' || scenario === 'crash-after-go' || scenario === 'ignore-sigterm') {
    await runBarrierChild({
      scenario: {
        name: scenario,
        async onGo(context) {
          if (scenario === 'crash-after-go') {
            process.kill(process.pid, 'SIGKILL');
            await new Promise<void>(() => {}); // 不可达：SIGKILL 立即终止
          }
          if (scenario === 'ignore-sigterm') {
            // 协作关闭也忽略：强制父进程走信号升级路径。
            process.on('SIGTERM', () => {});
          }
          if (process.env.HOME) {
            writeFileSync(join(process.env.HOME, 'fixture-child-marker'), String(process.pid), { mode: 0o600 });
          }
          const server = createServer();
          await new Promise<void>((resolveListen, rejectListen) => {
            server.once('error', rejectListen);
            server.listen(0, '127.0.0.1', () => {
              const address = server.address();
              if (address === null || typeof address !== 'object') {
                rejectListen(new Error('监听地址非法'));
                return;
              }
              context.reportListening(address.port, address.address);
              resolveListen();
            });
          });
          if (scenario === 'ignore-sigterm') {
            // 不等待 closeRequested；仅 SIGKILL / watchdog 能结束本场景。
            await new Promise<void>(() => {});
          }
          await context.closeRequested;
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      },
    });
    return;
  }

  process.stderr.write(`未知 fixture 场景：${String(scenario)}\n`);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(`fixture-child: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
