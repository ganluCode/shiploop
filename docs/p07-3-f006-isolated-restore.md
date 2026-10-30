# P07-3 F-006 隔离恢复交接

`createOfflineRestoreService` 是可信控制层的离线装配入口。`prepare({operationId, packagePath})` 核验备份、生成 staging 和版本化确认对象；负责人明确确认后调用 `confirm({operationId, confirmation})`。F-007 后续提供管理入口，本任务不增加 HTTP/Work 工具或运行中 Host 的数据库替换能力。

确认复用 `RestoreConfirmation`：绑定 backupId、manifestDigest、verificationDigest 和目标数据根身份；必须 `confirmed=true`、`targetMode=empty-isolated`。目标身份包含规范路径、设备和 inode，目录替换使确认失效。准备和确认都持有现有 `host/writer.lock`，第二恢复者或 Host 竞争时失败。目标只能含受控维护目录；已有 SQLite、项目文件、Host 发现/认证身份、额外文件或 staging 漂移都拒绝。

`restore-operation.json` 保存同一 operationId 的意图、copying/prepared/publishing/published 步骤、文件摘要及结果，并复用 F-001 的 DataLifecycleIntent/Step/Result 校验。记录写入及发布使用 fsync 和原子 rename。Artifact 从包内 `artifacts/<project>/<artifact>` 转为既有 `projects/<project>/artifacts/<artifact>/content`；按顶层组发布，SQLite 最后发布。发布中断后按实际文件摘要核对已发布组，只移动尚未发布的组，不覆盖或合并现有业务文件。相同确认可在首次 Core 打开前幂等核对同一结果。首次打开后不允许再次用旧确认执行发布。

备份和源数据保持原样。中断时遗留的 staging 和原子记录临时文件保留在 restore-staging 下，回执明确 `cleanup=retained`，没有声明清理已确认，也没有删除唯一副本。未知格式、缺正文、partial Recorder 等沿用 F-005 的拒绝语义，不因本任务恢复成功而扩展 native resume 能力。

首次 Core 打开前验证发布事实，持久标记 activated，随后使用正常 SQLite 迁移和 Host 新实例/新认证流程。恢复根每次打开都进入隔离：复用启动 fence 撤销旧资格、保留 interrupted/占用和累计预算，跳过历史停止记录复用、规划自动补完、基线恢复副作用及 Runtime 工厂装配。写入维护门控和恢复状态均保持 blocked，原因 `restored_data_requires_current_facts`。本入口没有跨根仓库执行授权或自动解隔离能力；仓库/worktree 身份和当前停止事实未建立前保持不可执行。Host 的未确认停止/关闭规则仍保留。

本地验证（Node 22.19.0，macOS，无模型或外网请求）：

- 新增 `test/modules/recovery/p07-3-f006-offline-restore.test.ts`，11 项全部通过，25.59 秒外围计时。真实 SQLite/临时数据根/IPC 子进程覆盖正常发布、所有确认绑定字段失效、目标漂移、内容损坏、符号链接、发布失败保留、两恢复者/Host 锁竞争，以及五个 SIGKILL 窗口的新进程续核。发布后重试核对 inode 未被替换。
- 业务夹具在发布后对照 Project/Phase/Feature/Task、Run/Attempt、审批、预算/预占、Session、recording_manifests 和 Artifact 共 13 张表。打开后累计预算/Attempt 数不变，原生索引和正文摘要可核对；旧历史 stopConfirmed=true 未解除恢复隔离，Runtime 工厂调用数为 0。
- 类型检查通过；模块边界检查 487 个生产文件、0 条诊断。

日志根目录：`/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-29-21-59-22_p07-3/verifications/F-006/runtime-logs/`。最终测试 `test-is25ip7z.log`，类型检查 `test-my9f58xn.log`，边界检查 `test-g_eomma4.log`。每份日志附真实退出码和结构化 sidecar；RED、夹具修正和一次 Vitest 标题正则转义错误的失败日志均保留。

仓库 Task 索引 `test/index/phases/P07/features/P07-3/tasks/F-006.json` 登记新增文件及 8 个既有受影响回归文件；后者本轮未执行，交 Nezha 独立验证。Harness selection 只引用此索引。未执行全仓、Feature/Phase 门禁、真实模型或 live 验收，不据本地测试声明 Feature/Phase 通过。
