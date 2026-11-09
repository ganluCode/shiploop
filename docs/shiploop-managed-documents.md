# 项目文档与自动规划

PRD、产品说明、架构和 Feature 设计默认放在 ShipLoop 项目数据目录，独立于代码仓库、分支和 worktree。

```bash
shiploop project documents --project "$PROJECT_ID" --json
```

结果中的 `workingDirectory` 是当前项目可编辑文档目录：`<data-root>/projects/<projectId>/documents/working/`。建议布局：

```text
README.md
product/overview.md
architecture/overview.md
prd/f01.md
features/f01/design.md
```

可直接在该目录编辑 Markdown，或通过正式写入接口导入现有文件：

```bash
shiploop document write --project "$PROJECT_ID" --path prd/f01.md --input ./prd.md --json
shiploop document write --project "$PROJECT_ID" --path features/f01/design.md --input ./design.md --json
shiploop feature create --project "$PROJECT_ID" --phase "$PHASE_ID" \
  --title "F01" --prd prd/f01.md --design features/f01/design.md --json
shiploop planning start "$FEATURE_ID" --project "$PROJECT_ID" --json
shiploop planning list --project "$PROJECT_ID" --feature "$FEATURE_ID" --json
```

`FEATURE_ID` 使用 create 回执中返回的真实 ID。`--design` 可省略；PRD 必须存在。写入相同正文幂等；覆盖不同正文必须携带上次返回的 `--expected-hash`，避免覆盖其他编辑。

Feature 创建不调用模型。规划启动默认授权一个 Run、最多 3 次 Attempt／启动、7 天，不设 Token／费用上限；使用项目已配置的 planner 策略，未配置时沿用策略解析规则。`--budget` 可传完整预算 JSON；创建和启动均支持 `--command-id`，重放相同操作返回原回执。

Planner 启动时自动固定绑定的 PRD／设计，以及存在的 README、产品和架构入口。正文发布为不可变制品，文档身份、版本、绑定关系、规划上下文和候选状态进入 SQLite。相同正文复用版本，后续编辑产生新版本。模型通过固定的文档索引及 `read_project_document` 按需读取，不在 Prompt 中预塞全文。

候选生成不代表批准，不自动启动编码。先用 `planning get` 和 `planning candidate` 审阅，再用 `planning approve` 指定候选摘要和目标 revision。批准后 Task 正式生效，编码和自动修复使用同一份固定文档。人工阻塞、预算、Git 提交和交付仍由 Core 控制。

单文档上限 256 KiB；一次规划正文合计上限 768 KiB，序列化上下文上限 1 MiB。路径必须为安全的相对 Markdown 路径，不支持符号链接或跨目录引用。共享入口按需读取；细分文档需作为 Feature 的显式绑定输入，不能靠任意全盘扫描补齐。

已有 `planning start --input`、仓库文档发现和映射仍兼容。已有仓库文档不会自动移动；项目 Skills 要重新 `project init` 才会同步新版说明。统一目录中的可编辑草稿尚未纳入备份包正文清单，应单独备份该目录；已经发布的版本和上下文复用现有制品备份机制。项目删除暂时保留工作草稿目录。
