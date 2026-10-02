# Core · application

应用层：命令、查询与执行编排（用例服务、调度、预算、验收编排）。

- 允许：依赖 `domain` 与 `ports` 中声明的窄接口；以显式调用组织用例；依赖注入在边界装配。
- 禁止：依赖具体适配器实现（`adapters/*`）；导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle；直接发起网络监听或持有用户数据路径之外的写入；空壳的项目/调度/存储/Runtime 服务。

当前阶段（P01-2 / F-011、F-012）：`artifact-publish.ts` 为首个用例服务——制品流式发布编排（pending 登记 → 事务外 staging 流式写入与同步 → hash 核验 → 同文件系统不覆盖发布 → 短事务 CAS ready），只依赖 `ports` 的 ArtifactStore/ArtifactFileStore 窄接口与 node 内置模块；限制（大小/时间/取消）显式有限，失败保留阶段化证据与 staging 残留。`artifact-verify.ts`（F-012）为制品中断核对与损坏诊断用例：关闭重开后的 pending 恢复（正式文件核验通过后 CAS 补 ready，冲突时按 revision 重新核对、不让旧结果倒写）、ready 完整性核对与三种 corrupt 诊断（missing/size_mismatch/hash_mismatch）、必要完整性检查的有效读取（缓冲受显式上限约束）与项目级批量核对/孤儿扫描（原文件保留 kept_in_place，不制造索引、不删除未知文件）。其余用例实现从后续 Feature 开始按设计 `core-design/04-scheduling-and-recovery.md` 等进入。
