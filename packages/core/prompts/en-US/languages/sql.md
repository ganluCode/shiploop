## SQL Standards

- Confirm the database dialect/version. Parameterize queries and whitelist identifiers; do not mix SQLite/PostgreSQL/MySQL syntax.
- Preserve migration history and checksums; append only required migrations. Define defaults, nulls, constraints, indexes, foreign keys and legacy upgrade behavior. Do not delete databases to fix compatibility.
- Check atomicity, concurrent conflicts, idempotency and rollback for multi-write business changes. Avoid long I/O in transactions. Validate only in authorized test databases; never directly modify ShipLoop business SQLite or production data.
