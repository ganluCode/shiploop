# P06 首次画像检测公开入口补缺

## 背景与边界

P06-7/F-003 的真实公开接入暴露：`project init` 只登记项目与仓库绑定，
独立静态检测器只返回内存候选，原确认接口要求已有持久版本，导致首次确认 404。
本补丁提供显式首次检测，不改变 init 的注册语义，不在验收脚本中补写产品数据库。

```bash
shiploop project profile detect --project <projectId> --confirm --json
shiploop project profile get --project <projectId> --json
shiploop project profile confirm --project <projectId> --revision 1 --input <profile.json> --confirm --json
```

检测命令还支持 `--command-id <uuid>` 和 `--data-root <abs>`。`--confirm` 只授权保存
检测候选，不表示确认其技术画像。画像文件仍遵循原 confirm 输入契约，查询候选可供准备该文件。

## 保证

- Core 命令 `project.profile.detect`：project scope，`project.metadata.write`，创建类，
  信封不携带 expectedRevision，payload 必须为空；不接受任意路径、候选或身份。
- 仓库根仅来自已登记的可信绑定。默认装配使用已有有界静态检测器；不执行项目脚本、
  不安装依赖、不发模型请求、不启动基线检查，也不改变 Git 文件、暂存区或 refs。
- 文件扫描在写事务外；短事务内重新核对绑定身份、修订和是否已有画像。
  候选、能力描述符、`project_profile.detected` 审计和成功回执一起提交，失败一起回滚。
- 首版只支持首次检测：已有任意画像时新命令冲突，不替换候选或已确认版本。
  相同 commandId/issuedAt 的重放复用原回执；并发首次检测只有一个新写入者。
- 候选为 version=1、confirmedBy=null；未知语言为 manual_configuration_required。
  技术栈模块只登记候选描述符，不授予执行权限或加载资源；未确认时模块匹配 not_ready。
- 审计仅保存版本、计数和主体/画像摘要，不复制源文件正文或本地绝对路径。
- 不新增迁移；不接入重检测/刷新候选、自动确认、模型规划或 Phase 验收。

## 验证

2026-10-29，Node 22.19.0：

- `p06-profile-detect-public.test.ts`：真实默认 Host/CLI 注册、首次检测、公开查询/确认、
  重放、拒绝覆盖、Host 重启持久、源码保持、恶意脚本不执行。
- `p06-profile-detect-safety.test.ts`：权限、不可见项目、额外输入拒绝、未知语言、
  审计 wire 往返、回执/审计故障整组回滚、绑定变更和并发首次命令。
- Profile 定向回归 7 文件 31 项；命令/回执/授权/快照定向回归 4 文件 347 项。
  同步了既有 P06 命令白名单快照和授权测试中遗漏的计划决策/资源命令夹具；未放宽生产校验。
- typecheck、check:boundaries、build（含构建产物入口冒烟）通过。

这只解除 F-003 的首次候选入口前置缺口，不代表其全部基线/故障/clone 矩阵、
P06-7 Feature 或 P06 Phase 已验收。历史阻塞证据必须保留；F-003 继续实现和验收。
