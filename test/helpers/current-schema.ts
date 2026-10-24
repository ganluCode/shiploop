// Current full-database contract; historical migration/checksum tests keep their own prefixes.
// P05-1 / F-002（v35 planning contexts）、F-003（v36 command receipts v7）、
// P05-2 / F-001（v37 feature dependencies）、P05-3 / F-001（v38 fixed Batch members）、
// P05-4 / F-005（v39）：不同 Feature 的 global/project Work gate 允许并行，
// workspace 键仍按受管目录排他。
export const currentSchemaVersion = 39;
export const currentMigrationVersions = Array.from({ length: currentSchemaVersion }, (_, index) => index + 1);
