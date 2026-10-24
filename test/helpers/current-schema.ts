// Current full-database contract; historical migration/checksum tests keep their own prefixes.
// P05-1 / F-002（v35 planning contexts）、F-003（v36 command receipts v7）、
// P05-2 / F-001（v37 feature dependencies）与 P05-3 / F-001（v38 fixed Batch members）
// 已追加到当前冻结版本。
export const currentSchemaVersion = 38;
export const currentMigrationVersions = Array.from({ length: currentSchemaVersion }, (_, index) => index + 1);
