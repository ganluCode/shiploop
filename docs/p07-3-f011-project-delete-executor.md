# P07-3 F-011 项目删除文件执行与恢复

默认 `openCoreApplication` 暴露可信内部端口 `projectDeleteExecutor.execute`。输入仅为可信主体、
operationId、owner、expectedFence、previousExecutorStopped；未知字段（包括源路径）拒绝。
它消费 F-010 的固定 manifest，不修改原确认范围，不自动重新授权丢弃，不启动模型或后台重试。
项目删除的 Host/CLI 控制与查询由后续 Task 接线。

执行器 claim 后，在每次文件副作用、Git 放行、检查点和最终清除前重核主体、项目 deleting、
维护 owner/fence、活动/不确定执行、数据库/跨项目引用摘要。默认总预算 600 秒，各 Git/检查器
另有既有有限预算；预算到期保留部分进展和维护占用。

文件目标只有登记制品的固定 content 叶与 manifest 列出的 staging 常规文件。预览/确认现在
把 staging 的大小和 SHA-256 也绑定到摘要；确认后同名内容变化拒绝。执行前一次捕获全部目标
的 SHA-256、大小、dev/inode/birthtimeNs 和逐层目录身份，写入持久计划后才允许 unlink。
每次 unlink 前重核正文/文件/祖先身份、硬链接数与授权，之后 fsync 父目录并核验缺失。
未知文件、超限、链接、身份漂移、未有持久计划的缺失均失败关闭；没有递归 rm 或删除项目根。
空制品目录可保留，未登记的目录/文件不会被顺带清除。

受管 worktree 路径还必须等于按 projectId/featureId 从受管根推导的位置。复用
`FeatureWorktreeCleaner` 的非强制 Git 删除、登记/HEAD/内容核对与源仓库 HEAD/refs/index/
tracked/untracked/ignored 内容保护；公共锁保持到清除事务结束。脏目录先阻塞，必须通过原有
独立丢弃确认再删除项目。已 cleaned 的 worktree 仍须有原成功 cleanup/discard operation、
verified 检查点及匹配的停止回执，之后重新核验目录/登记缺失、分支和源仓库，不凭状态值猜测。

公共锁的 claim 路径仍是 git common dir 下的同一个文件，新旧 repoIdentity 确定争用同一锁。
新增 lease.assertCurrent 重核源目录和公共目录的实体、claim inode/owner 以及外部原生 Git 锁。
新运行拒绝链接路径；同路径替换目录也不能继续使用旧 lease。此为既有可信项目模式的合作锁，
不宣称 OS 沙箱。legacy binding 缺少实体证明的既有隔离政策保持有效。

追加 v57，在 project_delete_steps 上增加带摘要的 JSON 检查点；不修改 v1–v56 SQL/checksum。
计划、逐叶意图/缺失回执、worktree verified/缺失回执、进程 launch/start/group 身份及停止观察
都按当前 owner/fence 保存；同键内容不可覆盖，损坏摘要拒绝读取。所有文件/Git I/O 在 SQLite
写事务外。删除后回执前崩溃，重开库据原计划和实际状态续核同一个 operation。旧执行器的停止
声明还不足以释放其公共锁：先按持久身份确认所有旧子进程整组停止，才能释放原 claim 并续核。
cleanup_unconfirmed 保留锁/维护占用并阻止完成，不以 PID 或 lease 到期代替停止证明。

最终观察器重新核验所有文件缺失、受管区域没有新增文件、worktree 登记/目录缺失、分支与源
仓库一致、全部登记进程停止。随后交 F-010 的同一清除事务；数据库失败只回滚数据库，保留
已完成外部进度。完成后按原最小化政策清除 manifest 与检查点正文，保留 operation/步骤摘要/
最小回执；外部源仓库、Git 公共目录、分支和独立备份不在删除范围。

本地新增三文件共 23 项行为/迁移用例均有通过证据：执行器 19 项、公共锁 3 项、v57 升级/
回滚/约束 1 项。覆盖默认 Core、独立丢弃后删除、重复执行、另一项目记录/制品正文不变、
七类文件拒绝、三种中断窗口、引用/占用/fence 漂移、真实进程停止不明与确认后恢复、公共锁
重叠屏障/实体替换。分组执行，未选用例在对应单次运行中记 skipped，不能相加冒充独立全量。

其他本地证据：v56 专项迁移与完整 Schema 文件合计 66 项通过；预览目标推导/摘要失效两项
通过；typecheck 通过；边界检查 504 个生产文件、0 诊断。全部 RED、夹具错误与 GREEN 日志及
真实退出码保留在 Harness `verifications/F-011/runtime-logs/`。

可信索引 `test/index/phases/P07/features/P07-3/tasks/F-011.json` 包含上述新增场景、迁移/Schema、
预览目标推导和命令幂等，以及 ArtifactFileStore、仓库 rebind/move 的受影响回归。后四项中的
命令幂等、ArtifactFileStore、rebind/move 仅选择交 Nezha；未在 Runtime 重跑。工作区正常/竞争/
失败/保留/恢复以本 Task 的真实临时 Git/SQLite 场景执行，复用既有清理器与丢弃服务，不重复
全部 P03–P06 重量矩阵。故障夹具使用一次真实文件捕获与完整接受事务；默认 Core 用例保留
公开确认命令的二次独立捕获，不以夹具代替公开接线证据。

本地定向通过不是 Feature/Phase 验收；未执行全仓、组合门禁、阶段验收、live 或真实模型。
