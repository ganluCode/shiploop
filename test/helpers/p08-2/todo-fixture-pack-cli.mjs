#!/usr/bin/env node
/**
 * P08-2 F-007 安装冒烟夹具 CLI（仅测试使用，不随产品发布）。
 *
 * 实现安装冒烟所需的最小 Host 生命周期协议子集，与真实 shiploop-cli 的稳定
 * 契约保持同一形状（见 packages/cli/src/host/{args,execute,output}.ts）：
 * - `host start --data-root <abs> --json`：创建数据根，写 host/discovery.json 与
 *   0600 auth.token（64 位小写 hex），stdout 输出唯一一个成功信封
 *   {ok:true,command:'host.start',result:{outcome:'started',protocolVersion,
 *   listenAddress:'127.0.0.1',port,hostInstanceId,lifecycleState:'ready',
 *   dataRootIdentity}}；已有发现时 outcome='already_running'；
 * - `host status --data-root <abs> --json`：有发现 → 同一实例回执；无发现 →
 *   {ok:false,command:'host.status',error:{code:'host_not_found'}} 退出码 3；
 * - `host stop --data-root <abs> --json`：移除发现与 token，回执
 *   {status:'stopped',hostInstanceId}；无发现 → host_not_found；
 * - 数据根为空/相对/`/` → 退出码 2，stderr 单行诊断（与真实 CLI 解析失败一致，
 *   不产生 JSON 信封）。
 * 夹具进程每次调用即退出：不模拟常驻 Host 进程（跨进程组合属 Phase 集成）。
 *
 * 可选 dist/fault.json（同一目录）注入确定性违约，用于验证冒烟检查器抓得住：
 * - {"fault":"leak-token"}：host status 把 auth token 写入 stderr（凭据外泄）；
 * - {"fault":"absolute-path"}：host start 把数据根绝对路径写入 stderr；
 * - {"fault":"protocol-drift"}：start 回执与 discovery 的 protocolVersion=2。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

let fault = null;
try {
  const faultPath = new URL('./fault.json', import.meta.url);
  if (existsSync(faultPath)) {
    fault = JSON.parse(readFileSync(faultPath, 'utf8')).fault ?? null;
  }
} catch {
  fault = null;
}
const protocolVersion = fault === 'protocol-drift' ? 2 : 1;

const envelopeOk = (command, result) => {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, command, result })}\n`);
};
const envelopeFail = (command, code, message, exitCode) => {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, command, error: { code, message } })}\n`);
  else process.stderr.write(`shiploop: ${code}: ${message}\n`);
  process.exitCode = exitCode;
};

const subcommand = args[1];
if (args[0] !== 'host' || !['start', 'status', 'stop'].includes(subcommand)) {
  process.stderr.write('shiploop: invalid_input: host 子命令必须是 start|status|stop\n');
  process.exitCode = 2;
} else {
  const root = value('--data-root');
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root) || root === '/') {
    process.stderr.write('shiploop: invalid_input: --data-root 必须是非空绝对路径\n');
    process.exitCode = 2;
  } else {
    const hostDir = join(root, 'host');
    const discoveryPath = join(hostDir, 'discovery.json');
    const tokenPath = join(hostDir, 'auth.token');
    const command = `host.${subcommand}`;
    if (subcommand === 'start') {
      mkdirSync(hostDir, { recursive: true });
      if (fault === 'absolute-path') {
        process.stderr.write(`fixture diagnostic at ${root}\n`);
      }
      let discovery;
      let outcome = 'started';
      if (existsSync(discoveryPath)) {
        discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
        outcome = 'already_running';
      } else {
        discovery = {
          schemaVersion: 1,
          protocolVersion,
          listenAddress: '127.0.0.1',
          port: 20000 + Math.floor(Math.random() * 20000),
          pid: process.pid,
          hostInstanceId: randomUUID(),
          dataRootIdentity: createHash('sha256').update(realpathSync(root), 'utf8').digest('hex'),
        };
        writeFileSync(discoveryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
        writeFileSync(tokenPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
        chmodSync(discoveryPath, 0o600);
        chmodSync(tokenPath, 0o600);
      }
      envelopeOk(command, {
        outcome,
        protocolVersion: discovery.protocolVersion,
        listenAddress: discovery.listenAddress,
        port: discovery.port,
        hostInstanceId: discovery.hostInstanceId,
        lifecycleState: 'ready',
        dataRootIdentity: discovery.dataRootIdentity,
      });
    } else {
      if (!existsSync(discoveryPath)) {
        envelopeFail(command, 'host_not_found', '数据根内没有已启动的 Host 发现文件', 3);
      } else if (subcommand === 'status') {
        const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
        if (fault === 'leak-token' && existsSync(tokenPath)) {
          process.stderr.write(`${readFileSync(tokenPath, 'utf8').trim()}\n`);
        }
        envelopeOk(command, {
          hostInstanceId: discovery.hostInstanceId,
          lifecycleState: 'ready',
          pid: discovery.pid,
          port: discovery.port,
        });
      } else {
        const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
        rmSync(discoveryPath, { force: true });
        rmSync(tokenPath, { force: true });
        envelopeOk(command, {
          commandId: randomUUID(),
          status: 'stopped',
          hostInstanceId: discovery.hostInstanceId,
        });
      }
    }
  }
}
