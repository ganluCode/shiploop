# 日常开发流程国际化

全局字段为 `locale`，支持 `en-US`（英文，代码默认值）、`zh-CN`（中文）。只允许全局配置，不允许项目覆盖。沿用现有 SQLite `global_settings.payload` 保存，无第二套配置库。

## 配置

先运行 `shiploop config get --scope global --json`，保留返回的 `result.payload` 和 `result.revision`。
在该 payload 中设置 `locale: zh-CN`，再执行：

```bash
shiploop config update --scope global --revision <当前revision> --input <完整全局配置.yaml> --json
```

JSON 和 YAML 都支持此字段；配置更新是整体替换，不能只提交 locale 导致现有策略丢失。首次没有全局配置时可用 `config create --scope global --input <file>`。最小载荷：

```yaml
schemaVersion: 2
locale: zh-CN
```

该最小载荷只用于全新配置；实际用户配置必须保留其他字段。常规语言变更保存后不需要重启 Host；首次升级本功能需要构建并在 Host 空闲后重启以应用新代码/迁移。

## 生效范围

| 内容 | 行为 |
| --- | --- |
| Task / Planner / Feature 修复 Prompt | 新输入准备时冻结语言，写入快照或 manifest，参与摘要；两种 Markdown 资源都有开发规范与 TDD、测试范围和权限约束 |
| 默认回复 | 运行时系统指导与输入使用相同语言；明确指定的交付物语言优先 |
| 项目指令/数据 | AGENTS、选定 Skill、用户需求、代码、工具输出与历史内容保持原文，不事后翻译 |
| Skills | 两种官方 Skill 均有中英资源；`project init --confirm` 按全局语言同步到 .agents 和 .claude，保留其他 Skill 和项目文档 |
| 飞书 | 卡片标题、字段、固定说明中英化；用量口径、颜色和分组不变；通知入队冻结语言，重试与重新扫描沿用原值 |
| Feature 文本报告 | 按查询时全局语言显示标题、固定说明和后续操作；原始备注、ID、状态值、数值及证据保留 |
| JSON | 协议字段和状态值不翻译；locale 为新增可选元数据 |

更改语言不会自动重写已有项目 Skills；需要时在项目中重新执行 `shiploop project init . --confirm`。同步不代表各 Harness 已自动发现/加载。

历史执行输入缺少 locale 时，Runtime 继续使用原有中文语义；不会改写旧快照。新输入语言变化会影响恢复身份，不能悄悄复用不同语言的原生 Session。已开始的单次执行不热切换；同一 Run 的 Feature 修复轮次也保留首轮语言。

## 资源与扩展

- Prompt：`packages/core/prompts/{en-US,zh-CN}/`，用 `{{variable}}` 传值，单次替换、不执行表达式。
- Skills：`packages/cli/skills/<bundle>/locales/{en-US,zh-CN}/`。
- 模板来源：manifest.promptTemplates 记录选定语言、每个模块实际来源语言和 SHA-256，支持英文逐模块回退。
- CLI 帮助、Host 一般错误、历史验收文档和第三方工具文案未在本轮全面国际化。
