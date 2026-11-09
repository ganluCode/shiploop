# 项目文档与规划

## 默认流程

PRD、架构和 Feature 设计默认放在 ShipLoop 的统一项目数据目录，独立于源码分支，不在每个 worktree 复制维护一套。先查询正式项目 ID 和文档目录：

```bash
shiploop project documents --project "$PROJECT_ID" --json
```

返回 workingDirectory，即 `<data-root>/projects/<projectId>/documents/working/`。在其中维护 UTF-8 Markdown：

```text
README.md
product/overview.md
architecture/overview.md
phases/p01/scope.md
phases/p01/acceptance.md
phases/p01/features/f01-example.md
phases/p01/designs/f01-example.md
```

按需创建目录，保留既有文档。README.md 索引实际文件、状态和负责人。p01/f01 是可读别名，不是正式业务 ID。使用 [PRD 模板](../templates/feature-prd.md) 和 [设计模板](../templates/technical-design.md)。可以直接编辑草稿，也可由正式命令复制已生成的 Markdown：

```bash
shiploop document write --project "$PROJECT_ID" \
  --path phases/p01/features/f01-example.md --input /tmp/f01-prd.md --json
shiploop feature create --project "$PROJECT_ID" --phase "$PHASE_ID" \
  --title "示例功能" --prd phases/p01/features/f01-example.md \
  --design phases/p01/designs/f01-example.md --json
shiploop planning start "$FEATURE_ID" --project "$PROJECT_ID" --json
```

--design 可省略。路径相对 workingDirectory，必须真实存在。write 重复相同正文幂等；覆盖不同正文需 --expected-hash，避免误覆盖。正文不得包含账号密钥。CLI 自动查询 Phase/revision，Core 仍核验 CAS 和归属；Feature 创建不启动模型。

Planner 自动读取关联 PRD/设计和实际存在的 README.md、product/overview.md、architecture/overview.md，固定正文、文档版本和哈希，构造需求制品引用并保存 SQLite。无需手动发布版本、填写 artifactId、维护映射 JSON 或准备 planning-request.json。文件未改复用文档版本；修改后新规划使用新版本，已运行任务使用原副本。不要编辑不可变制品或 SQLite。

简化 planning start 默认单 Run、最多 3 Attempts/Runtime 启动、7 天、无 Token/费用上限；--budget 可自定义现有完整预算。高级 planning start --phase --revision --input JSON 仍受支持，不混用两套参数。保存 commandId；结果未知先查 receipt，不换 ID 盲发。显式 --command-id 可核对重放。

Planner 经正式工具提交后自动保存候选；用 planning candidate 审阅、planning approve 批准后，正式 Task 元数据才生效。批准不自动授权编码。accepted、候选保存、模型说完成都不是交付通过。

## 提示词与兼容

source=managed-project-documents 的路径属于统一数据目录。使用 read_project_document 读取固定版本，不在 worktree 用 read_file 拼接这些路径。提示词只注入路径、角色、版本、必读标记和哈希，不自动灌入全部正文；编码和修复沿用已绑定输入。

旧仓库 docs 是可选兼容来源，不要求迁移或删除。无受管输入的旧任务仍可使用仓库发现或已有 docs/shiploop-context.json；正常新流程不创建映射 JSON，不声称修改文档会更新运行中任务。

## 编写与验收

可编辑草稿目录需单独备份；现有备份包会收集已经发布的文档版本和上下文制品，尚不收集工作草稿正文。项目删除暂不删除工作草稿目录。

- 阅读项目 AGENTS.md、已有关联文档与索引，定向检索，不扫描全部历史 Session。
- PRD 明确目标、非目标、可观察验收、真实依赖和测试范围；未确认决策标 proposed，不代负责人确认。
- 架构维护共享接口、数据、权限和运行边界；明确跨任务函数签名与输入输出，引用单一主文档。
- Feature 是 DAG；并行节点说明共享文件、Schema、资源所有者和集成前提，不用编号隐含依赖。
- Task 做 TDD 红绿重构及自身相关单元测试；Feature 汇总相关单元测试；Phase 按影响做回归与必要集成；全量测试交 CI 或显式授权。
- 代码和测试按职责/模块适度分类，不巨型平铺，也不为一两个文件过度拆分。引用实际存在或明确待新增的测试路径，不虚构函数。
- 同步受影响的需求、设计和索引。文档状态不等于业务验收；验收记录 SHA、日期、命令、结果、证据和 not_run。
- 业务创建、依赖、审批、状态只走 CLI/Host，禁止模型改官方 Task JSON、Feature YAML 或执行 SQL。
