/**
 * F-002 迁移记录契约（ports 契约层）。
 *
 * 设计依据：core-design/03 §6（迁移记录版本与校验摘要；不支持的高版本拒绝写入）
 * 与 core-design/11 §9（schema_migrations：version 唯一、checksum、applied_at）。
 *
 * 本契约只固定记录形态与描述符校验；迁移执行、checksum 核对、
 * 高版本拒写与失败恢复由 F-005 实现。
 */
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateSha256Digest,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** schema_migrations 行：全局表，不带 project_id。 */
export interface MigrationRecord {
  /** 唯一递增的迁移版本（≥1）。 */
  readonly version: number;
  /** 迁移脚本内容的 SHA-256 校验摘要。 */
  readonly checksum: string;
  /** 应用时间，UTC 毫秒整数。 */
  readonly appliedAtUtcMs: number;
}

/** 随构建产物分发的迁移文件描述（版本 + 稳定校验摘要），供执行前核对。 */
export interface MigrationDescriptor {
  readonly version: number;
  readonly checksum: string;
}

export function validateMigrationDescriptor(value: unknown, operation: string): MigrationDescriptor {
  const context: ValidationContext = { operation, entity: { type: 'migration' } };
  const object = requirePlainObject(value, context, 'migration');
  rejectUnknownKeys(object, ['version', 'checksum'], context, 'migration');
  return {
    version: validatePositiveInteger(object.version, context, 'version'),
    checksum: validateSha256Digest(object.checksum, context, 'checksum'),
  };
}
