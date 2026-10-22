// Current full-database contract; historical migration/checksum tests keep their own prefixes.
export const currentSchemaVersion = 34;
export const currentMigrationVersions = Array.from({ length: currentSchemaVersion }, (_, index) => index + 1);
