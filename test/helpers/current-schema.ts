// Current full-database contract; historical migration/checksum tests keep their own prefixes.
// P05-1 / F-002（v35 planning contexts）与 F-003（v36 command receipts v7）后同步到 36。
export const currentSchemaVersion = 36;
export const currentMigrationVersions = Array.from({ length: currentSchemaVersion }, (_, index) => index + 1);
