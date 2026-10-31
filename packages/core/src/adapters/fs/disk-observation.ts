/**
 * P07-3 / F-012 受控数据根只读观测适配器（adapters/fs，真实文件系统）。
 *
 * 设计依据：core-design/03 §4（数据根布局：core.sqlite、projects/、staging/、
 * backups/）与 §6（磁盘阈值/保留由用户显式配置，不编造默认容量）；
 * 端口契约见 ports/retention-evaluation.ts。
 *
 * 边界与纪律：
 * - 只读：statfs/stat/readdir 之外不执行任何文件系统操作；不跟随符号链接
 *   （目录项计入预算但不计入字节，符号链接目标不扫描）；
 * - 失败显式呈现：statfs/目录读取失败返回 unknown+原因码（ENOENT/EACCES 等），
 *   不抛出、不折算为 0 或无限容量；不存在的受管区域视为空（observed 0 字节）；
 * - 有界扫描：目录项总数受 maxEntries 预算约束，耗尽即停止并标记 partial
 *   （budget_exhausted），不静默截断为完整结论；
 * - 备份清单只读各包 manifest.json 的登记字段（backupId/createdAtUtc/
 *   files[].sizeBytes），不读正文、不校验内容哈希（核验属备份验证服务）；
 *   staging 目录（`.` 前缀）与 `.incomplete.json` 报告不是完整包，跳过；
 * - 错误信息只含相对逻辑位置与原因码，不回显绝对路径或正文内容。
 */
import { stat, readdir, statfs, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MANAGED_USAGE_AREAS,
  type BackupCatalogEntry,
  type BackupCatalogRead,
  type BackupCatalogReader,
  type DiskUsageObservation,
  type DiskUsageObserver,
  type ManagedAreaScanner,
  type ManagedAreaUsage,
  type ManagedUsageScan,
} from '../../ports/retention-evaluation.js';
import { DATABASE_FILE_NAME } from '../../ports/path-service.js';

const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** 单个 manifest.json 读取上限（登记清单远小于此；超限视为不可读）。 */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

function reasonOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : fallback;
}

/** statfs 观测受控数据根：可用（bavail）/总容量（blocks×bsize）或显式未知。 */
export function createDiskUsageObserver(options: { readonly dataRoot: string }): DiskUsageObserver {
  if (typeof options.dataRoot !== 'string' || options.dataRoot.length === 0) {
    throw new TypeError('DiskUsageObserver.create: 必须提供受控数据根');
  }
  const dataRoot = options.dataRoot;
  return {
    async observe(): Promise<DiskUsageObservation> {
      try {
        const stats = await statfs(dataRoot);
        return {
          status: 'observed',
          availableBytes: Number(stats.bavail) * Number(stats.bsize),
          totalBytes: Number(stats.blocks) * Number(stats.bsize),
        };
      } catch (error) {
        return { status: 'unknown', reason: reasonOf(error, 'statfs_failed') };
      }
    },
  };
}

interface AreaWalk {
  bytes: number;
  files: number;
  entries: number;
  exhausted: boolean;
  failed: boolean;
}

/** 单区域有界遍历：不跟随符号链接；预算耗尽停止并标记。 */
async function walkArea(root: string, budget: number): Promise<AreaWalk> {
  const result: AreaWalk = { bytes: 0, files: 0, entries: 0, exhausted: false, failed: false };
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = reasonOf(error, 'readdir_failed');
      if (code === 'ENOENT') {
        continue;
      }
      result.failed = true;
      return result;
    }
    for (const entry of entries) {
      if (result.entries >= budget) {
        result.exhausted = true;
        return result;
      }
      result.entries += 1;
      // 符号链接不跟随：计入预算，不计入字节（目标可能是任意外部路径）。
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile()) {
        try {
          const stats = await stat(child);
          result.bytes += stats.size;
          result.files += 1;
        } catch {
          // 单文件 stat 失败不终止扫描：该文件不计入字节（部分低估），扫描继续。
        }
      }
    }
  }
  return result;
}

/** 受管区域有界扫描：projects/staging/backups 目录树 + 数据库文件（含 wal/shm）。 */
export function createManagedAreaScanner(options: { readonly dataRoot: string }): ManagedAreaScanner {
  if (typeof options.dataRoot !== 'string' || options.dataRoot.length === 0) {
    throw new TypeError('ManagedAreaScanner.create: 必须提供受控数据根');
  }
  const dataRoot = options.dataRoot;
  return {
    async scan(maxEntries: number): Promise<ManagedUsageScan> {
      const areas: ManagedAreaUsage[] = [];
      let entriesExamined = 0;
      let budgetExhausted = false;
      for (const area of MANAGED_USAGE_AREAS) {
        if (area === 'database') {
          const stats = await Promise.all(
            [DATABASE_FILE_NAME, `${DATABASE_FILE_NAME}-wal`, `${DATABASE_FILE_NAME}-shm`].map(async name => {
              try {
                return (await stat(join(dataRoot, name))).size;
              } catch (error) {
                if (reasonOf(error, 'stat_failed') === 'ENOENT') {
                  return 0;
                }
                throw error;
              }
            }),
          ).catch(() => null);
          if (stats === null) {
            areas.push({ area, status: 'unknown', reason: 'stat_failed' });
          } else {
            const bytes = stats.reduce((sum, size) => sum + size, 0);
            entriesExamined += 1;
            areas.push({ area, status: 'observed', bytes, files: stats.filter(size => size > 0).length });
          }
          continue;
        }
        const walk = await walkArea(join(dataRoot, area), Math.max(0, maxEntries - entriesExamined));
        entriesExamined += walk.entries;
        budgetExhausted = budgetExhausted || walk.exhausted;
        areas.push(
          walk.failed
            ? { area, status: 'unknown', reason: 'readdir_failed' }
            : {
              area,
              status: walk.exhausted ? 'partial' : 'observed',
              ...(walk.exhausted ? { reason: 'budget_exhausted' } : {}),
              bytes: walk.bytes,
              files: walk.files,
            },
        );
      }
      return { areas, entriesExamined, budgetExhausted };
    },
  };
}

interface MinimalManifestShape {
  readonly backupId: unknown;
  readonly createdAtUtc: unknown;
  readonly files: unknown;
}

/** 宽松读取单包 manifest 的登记字段（完整校验属备份验证服务，此处不复制正文）。 */
async function readCatalogEntry(backupRoot: string, directory: string): Promise<BackupCatalogEntry | null> {
  let text: string;
  try {
    text = await readFile(join(backupRoot, directory, 'manifest.json'), 'utf8');
  } catch {
    return null;
  }
  if (text.length > MANIFEST_MAX_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const manifest = parsed as MinimalManifestShape | null;
  if (manifest === null || typeof manifest !== 'object') {
    return null;
  }
  if (typeof manifest.backupId !== 'string' || !BACKUP_ID_PATTERN.test(manifest.backupId)) {
    return null;
  }
  if (typeof manifest.createdAtUtc !== 'string' || !Number.isFinite(Date.parse(manifest.createdAtUtc))) {
    return null;
  }
  if (!Array.isArray(manifest.files)) {
    return null;
  }
  let bytes = 0;
  for (const file of manifest.files) {
    const size = (file as { sizeBytes?: unknown } | null)?.sizeBytes;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return null;
    }
    bytes += size;
  }
  return { backupId: manifest.backupId, createdAtUtcMs: Date.parse(manifest.createdAtUtc), bytes };
}

/** 备份包目录清单：只读 manifest 登记字段；个别不可读按 partial 显式呈现。 */
export function createBackupCatalogReader(options: { readonly backupRoot: string }): BackupCatalogReader {
  if (typeof options.backupRoot !== 'string' || options.backupRoot.length === 0) {
    throw new TypeError('BackupCatalogReader.create: 必须提供备份根目录');
  }
  const backupRoot = options.backupRoot;
  return {
    async list(): Promise<BackupCatalogRead> {
      let entries;
      try {
        entries = await readdir(backupRoot, { withFileTypes: true });
      } catch (error) {
        const code = reasonOf(error, 'readdir_failed');
        if (code === 'ENOENT') {
          return { status: 'listed', entries: [], unreadable: 0 };
        }
        return { status: 'unknown', reason: code, entries: [], unreadable: 0 };
      }
      const catalog: BackupCatalogEntry[] = [];
      let unreadable = 0;
      for (const entry of entries) {
        // staging 目录以 `.` 开头、未完成报告为 `<backupId>.incomplete.json` 文件、
        // `operations` 为受管备份操作日志目录（Core 打开即创建）：都不是完整包，
        // 跳过（孤儿处理属 F-013 清理，不在清单估计内）。
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'operations' || !BACKUP_ID_PATTERN.test(entry.name)) {
          continue;
        }
        const item = await readCatalogEntry(backupRoot, entry.name);
        if (item === null) {
          unreadable += 1;
        } else {
          catalog.push(item);
        }
      }
      return {
        status: unreadable > 0 ? 'partial' : 'listed',
        ...(unreadable > 0 ? { reason: 'manifest_unreadable' } : {}),
        entries: catalog,
        unreadable,
      };
    },
  };
}
