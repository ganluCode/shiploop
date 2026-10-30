# P07-3 F-007 默认 Host 升级保护

默认 `startHost` 仍先取得数据根 OS 写锁；`openCoreApplication` 改用
`openUpgradedSqliteStorage`，在业务存储、Runtime 工厂、监听与 discovery 发布之前完成升级。
Core 的直接嵌入者仍负责原有单写入者约束；此内部函数不替代 Host 的 OS 锁。

启动顺序：

1. 以 `readonly/fileMustExist` 打开已有 SQLite，复用迁移器校验版本序列和 checksum。
   高版本、未知库与摘要漂移在打开 WAL 写会话之前拒绝；空库初始化不产生升级备份。
2. 只有已有版本存在待应用迁移时，清点持久 Runner 租约、活动 Attempt、Verifier
   历史进程、基线占用及活动/原生 Session。部分租约、身份缺失、活动操作缺占用、
   census 超限、原生写入者未绑定、未确认的 GitAgent repair 均阻止升级。
3. 复用真实 `/bin/ps` 身份与整组成员探测。父 PID 消失不是停止证据，PID 复用、
   活动子孙、探测失败、10 秒确认预算耗尽均拒绝；本流程不发停止信号，不释放旧占用。
   停止应由既有受控流程或负责人处理后重试。
4. 在同一 Host 锁内生成 F-004 的 SQLite 在线快照和关联 Artifact 包，再由 F-005
   独立重读 manifest、SQLite 与正文核验；之后重新核对整个进程清单才应用迁移。
   启动期间使用内存维护门，不为获取备份占用而先创建 v55 才存在的表。
5. 沿用逐迁移事务与原有 SQLite 升级备份，不修改历史 SQL/checksum。
   `SqliteUpgradeError` 保留 `step/fromVersion/toVersion/version/packagePath/cause`。
   失败关闭连接，由 Host 工厂释放锁；已有完整包和旧版本诊断保留，未发布 ready。
   多步链中已提交的前序迁移不会被伪称整链回滚：后续步骤失败仍向调用者抛错。

`backup-schema.ts` 显式登记从各表引入版本起稳定的备份读取列；缺未来表是旧版本的
正常情况，缺本应存在的表/列则拒绝，不通过最新 StateStore 读取旧库。
本地覆盖真实 v1、v14、v18、v20、v31、v32、v49、v53、v54，以及空库和当前版本重开。
备份关联的业务行与正文直接从升级前快照核验。

保守边界：旧于 v54 的 Verifier 历史缺持久进程身份时不能仅凭 passed 推断无遗留写入者；
原生档案无法提供完整正文的既有 F-004 分支继续拒绝发布完整包，不能以 Schema 升级豁免。
清点上限为每类 256 行及总计 256 个不同进程身份，超限保留原库并要求先处理运行事实。
当前标准 Pi 原生写入属于记录的 Runner 进程组；不宣称这是阻止同用户任意 shell 的 OS 沙箱。

本地验证（Node 22.19.0）：

- 三个定向文件 33/33 通过：新增 Host 17 项、升级故障/进程清点 13 项、既有备份包 3 项。
- 真实独立进程组中父进程退出、子进程持续写入时，Host 拒绝迁移且无 discovery；
  整组停止后才生成关联包并升级。完整基线授权/仓库绑定也随升级交给原恢复流程处理。
- 注入实际坏 DDL、备份目录写入失败及包正文漂移；检查业务行、Schema、包、锁与 discovery。
  包生成回调内另核验第二个写锁申请失败。
- 类型检查、模块边界检查（489 个生产文件、0 diagnostics）、构建及产物冒烟通过。
- 完整日志及真实退出码 sidecar 位于 Feature workspace 的
  `verifications/F-007/runtime-logs/`：最终测试 `test-0ujsu_uc.log`，
  类型 `test-vle5l4wq.log`，边界 `test-p300yskd.log`，构建 `test-16gpgkl5.log`。
  首轮 RED、夹具诊断失败和最终修复日志均保留，没有覆盖失败记录。

可信索引：`test/index/phases/P07/features/P07-3/tasks/F-007.json`。
除上述本地三文件外，另外九个迁移/备份核验/锁/启动恢复/隔离恢复回归仅登记，交 Nezha
独立执行。未运行全仓、Feature/Phase 门禁、真实模型或 live；本地通过不代表 Feature 验收。
