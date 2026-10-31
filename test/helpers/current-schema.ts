// Current full-database contract; historical migration/checksum tests keep their own prefixes.
// P05-1 / F-002（v35 planning contexts）、F-003（v36 command receipts v7）、
// P05-2 / F-001（v37 feature dependencies）、P05-3 / F-001（v38 fixed Batch members）、
// P05-4 / F-005（v39）：不同 Feature 的 global/project Work gate 允许并行，
// workspace 键仍按受管目录排他。
// P05-7 / F-002：Git integration operation persistence (v43); F-004：integration evidence journal (v44).
// P05-8 / F-001：GitAgent repair authorization and attempt admission (v45).
// P06-5 / F-003：重新绑定不可变快照与旧绑定事实（v51）。
// P06-5 / F-005：基线授权的绑定 revision、脏范围和获准环境身份（v52）。
// P06-6 / F-004：Run 独立标签元数据（v53）；P03-7：Verifier 进程身份只追加事实（v54）。
// P07-3 / F-002：维护占用单行 fencing（v55）；修复当时未同步本常量的遗漏。
// P07-3 / F-010：项目删除 operation、分步进展与最小回执（v56）。
// P07-3 / F-011：删除 operation 的逐步持久检查点（v57）。
// P07-3 / F-013：受控保留清理与轮换进度（v58）。
// P07-3 / F-014：备份接受回执的 backup_id 与 v8 关联（v59）。
// P07-3 / repair：恢复验证进程不可变删除错误语义（v60）。
export const currentSchemaVersion = 60;
export const currentMigrationVersions = Array.from({ length: currentSchemaVersion }, (_, index) => index + 1);
