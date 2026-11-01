/**
 * P07-5 / F-005 Recorder 故障回归共享夹具（仅测试使用，不进 packages/）。
 *
 * 在 F-002 演练夹具（真实 Host 子进程 + 真实 SQLite/Git/文件）之上，提供记录
 * 故障场景共用的脚本构造、制品读取与证据导出：
 *
 * - 脚本构造保持公开 FakeRuntime 脚本契约（message/usage/write_file/await_gate
 *   与 lifecycle 故障注入）；门闩经 drill-host-child 自动装配，可由父进程
 *   releaseGate 在可证明位置放行（受控生产屏障）；
 * - 制品读取走生产 ArtifactFileStore.openFinalRead（按 artifacts 索引行定位），
 *   不解析私有路径；
 * - 证据导出仅在 SHIPLOOP_P07_EVIDENCE_DIR 显式提供时落盘（脱敏由夹具哨兵
 *   与受保护路径检查承担；默认不向仓库工作树写任何文件）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import type { DrillFixture } from './drill-fixture.ts';

export interface RecordingScriptOptions {
  /** 门闩前的事件数（≥ 32 才会触发首块落盘与索引推进）。 */
  readonly prefixMessages: number;
  /** 受控生产屏障：门闩名（脚本在该位置挂起，等待父进程 releaseGate）。 */
  readonly gate?: string;
  /** 门闩后的事件数。 */
  readonly suffixMessages?: number;
  /** lifecycle 故障注入（drop/duplicate/endGate/stopped 等）。 */
  readonly lifecycle?: Record<string, unknown>;
  /** 是否写入演练目标文件（默认写入：失败场景核对已收代码保留）。 */
  readonly writeTarget?: boolean;
  /** 追加 usage 步骤（核对用量去重）。 */
  readonly usageSteps?: Array<{ readonly inputTokens: number; readonly outputTokens: number; readonly costUsdMicros: number }>;
}

export function recordingScript(options: RecordingScriptOptions): Record<string, unknown> {
  const steps: Array<Record<string, unknown>> = [];
  if (options.writeTarget !== false) steps.push({ op: 'write_file', path: 'src/p07-drill-marker.ts', content: 'export const p07DrillMarker = 1;\n' });
  /* 受控工具命令与默认脚本一致：真实子进程经 Core 身份提交登记写入者进程
   * 身份（完成路径的停止核验依赖该登记；事件序列计入 2 个 tool 事件）。 */
  steps.push({ op: 'tool_command', name: 'probe' });
  for (let index = 1; index <= options.prefixMessages; index += 1) {
    steps.push({ op: 'message', role: 'assistant', text: `f005-prefix-${index}` });
  }
  if (options.gate !== undefined) steps.push({ op: 'await_gate', name: options.gate });
  for (let index = 1; index <= (options.suffixMessages ?? 0); index += 1) {
    steps.push({ op: 'message', role: 'assistant', text: `f005-suffix-${index}` });
  }
  for (const usage of options.usageSteps ?? []) {
    steps.push({ op: 'usage', ...usage });
  }
  return {
    schemaVersion: 1,
    steps,
    result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
  };
}

export interface SessionArtifactFact {
  readonly artifactId: string;
  readonly locator: string;
  readonly content: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/** 按受控 locator 后缀读取会话制品正文（生产 openFinalRead + 实测哈希核对）。 */
export async function readSessionArtifact(
  f: DrillFixture,
  projectId: string,
  locatorLike: string,
): Promise<SessionArtifactFact> {
  const row = f.q(
    'SELECT id, storage_locator, content_hash, size_bytes FROM artifacts'
    + ' WHERE project_id = ? AND status = \'ready\' AND storage_locator LIKE ?'
    + ' ORDER BY created_at DESC LIMIT 1',
    projectId, locatorLike,
  ) as { id: string; storage_locator: string; content_hash: string; size_bytes: number } | undefined;
  if (row === undefined) throw new Error(`未找到会话制品: ${locatorLike}`);
  const read = await createArtifactFileStore({ dataRoot: f.dataRoot }).openFinalRead({ projectId, artifactId: row.id });
  const chunks: Buffer[] = [];
  for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
  const content = Buffer.concat(chunks);
  const hash = createHash('sha256').update(content).digest('hex');
  if (hash !== row.content_hash) throw new Error(`制品哈希不匹配: ${locatorLike}`);
  return {
    artifactId: row.id, locator: row.storage_locator, content: content.toString('utf8'),
    contentHash: hash, sizeBytes: content.byteLength,
  };
}

/** 读取指定会话最新证据 Manifest 正文（无索引行时按 locator 兜底，返回 null）。 */
export async function readSessionManifest(
  f: DrillFixture,
  projectId: string,
  sessionId: string,
): Promise<SessionArtifactFact | null> {
  try {
    return await readSessionArtifact(f, projectId, `sessions/${sessionId}/evidence-manifest.json`);
  } catch {
    return null;
  }
}

/** 环境显式提供证据目录时导出结构化场景事实；默认不向仓库工作树写入。 */
export function saveScenarioEvidence(scenario: string, payload: Record<string, unknown>): string | null {
  const root = process.env.SHIPLOOP_P07_EVIDENCE_DIR;
  if (root === undefined || root === '') return null;
  mkdirSync(root, { recursive: true });
  const path = join(root, `${scenario}.json`);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, kind: 'p07-5-f005-scenario', scenario, ...payload }, null, 2)}\n`, 'utf8');
  return path;
}
