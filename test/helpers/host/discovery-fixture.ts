/**
 * F-005 伪发现与伪凭据夹具（仅测试）。
 *
 * 与 F-003 生产存储同一条代码路径：经 createHostFileStore 建立 host/ 0700、
 * 发行 randomBytes(32) 凭据（0600）、原子发布合法 discovery.json；因此夹具
 * 产出的发现/凭据与真实 Host 形态一致，F-009 HostClient 测试无需另造格式。
 *
 * 负向测试（畸形发现、错误权限、符号链接等）需要直接写不可信内容时，使用
 * writeRawDiscoveryFile，明确标注这是负例入口，生产代码不会这样发布。
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHostFileStore,
  type HostDiscoveryRecord,
  type HostFileStore,
} from '../../../packages/host/src/index.ts';

export interface MintedHostCredential {
  readonly store: HostFileStore;
  readonly token: string;
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
}

/** 在规范根下建立 host/ 并发行一组伪实例凭据（不发布 discovery）。 */
export function mintHostCredential(canonicalRoot: string): MintedHostCredential {
  const store = createHostFileStore({ canonicalRoot });
  store.ensureHostDir();
  const token = store.issueAuthToken();
  return {
    store,
    token,
    hostInstanceId: randomUUID(),
    dataRootIdentity: store.dataRootIdentity,
  };
}

export interface PublishLoopbackDiscoveryInput {
  readonly canonicalRoot: string;
  readonly port: number;
  readonly hostInstanceId: string;
  readonly pid?: number;
  readonly startedAt?: string;
  /** 复用 mintHostCredential 的 store；不传则按新凭据方式重建（凭据已存在时读取）。 */
  readonly store?: HostFileStore;
  readonly token?: string;
}

export interface PublishedLoopbackDiscovery {
  readonly record: HostDiscoveryRecord;
  readonly token: string;
}

/** 发布一条指向 127.0.0.1:<port> 的合法发现（pid 默认当前进程）。 */
export function publishLoopbackDiscovery(input: PublishLoopbackDiscoveryInput): PublishedLoopbackDiscovery {
  const store = input.store ?? createHostFileStore({ canonicalRoot: input.canonicalRoot });
  const token = input.token ?? store.readTrustedAuthToken();
  const record: HostDiscoveryRecord = {
    schemaVersion: 1,
    protocolVersion: 1,
    hostInstanceId: input.hostInstanceId,
    dataRootIdentity: store.dataRootIdentity,
    listenAddress: '127.0.0.1',
    port: input.port,
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
  store.publishDiscovery(record);
  return { record, token };
}

/**
 * 负例专用：绕开原子发布与结构校验，直接写 discovery.json 原文（仍强制 0600）。
 * 仅用于畸形 JSON/错误字段/坏权限等不可信发现测试。
 */
export function writeRawDiscoveryFile(canonicalRoot: string, content: string | Buffer): void {
  const store = createHostFileStore({ canonicalRoot });
  store.ensureHostDir();
  writeFileSync(join(canonicalRoot, 'host/discovery.json'), content, { mode: 0o600 });
}
