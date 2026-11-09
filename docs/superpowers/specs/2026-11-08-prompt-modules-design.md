# Markdown 提示词与并发友好规划

按本次用户要求实施：Task、Planner、返工/恢复、Feature 修复、Runtime 系统指导及工具说明
统一由内置 Markdown 资源提供，代码只选择模块、校验变量、渲染结构化数据。采用此前确认的
`{{variable.name}}` 单次文本替换；不执行表达式、脚本或递归变量，不开放项目覆盖内置规则。

## 边界与结构

- `packages/core/prompts/` 是唯一内置资源目录，按 shared/task/planner/languages/runtime/repair 拆分。
- 文件适配器读取有界 UTF-8 Markdown，组装时注入不可变目录快照；Core application/ports
  不读磁盘，导入无副作用。文件缺失、非法模板、缺少必需变量明确失败，没有内联后备文案。
- 资源随 Core 包发布；最终 Prompt 仍发布不可变制品，manifest 记录模板版本及模块内容摘要。
  已发布的历史输入保持原样；模板修改只作用于新准备的输入，不自动重跑历史任务。
- Task 按正式 `languages` 字段选择通用规则及对应语言规则；多语言组合去重，未知语言保留
  通用规则，不自行猜测框架。不使用不参与批准摘要的 labels 来决定执行规则。
- Planner 通过 Markdown 要求填 complexity、labels、languages。详细分级考虑现有模式、
  不变量、跨层边界与风险，不按文件/代码量、测试耗时或固定比例分档。旧计划输入仍兼容。
- `shiploop-plan-feature` Skill 交由当前 Harness 自己执行 Feature 拆分：先核对仓库及已有计划，
  输出可独立验收范围、所有权、接口、真实 DAG、共享文件冲突及受影响测试。避免人为链式依赖；
  共享底层变更优先作为前置节点，不伪称完全隔离。不会自行启动模型或子 Agent。
- init 向 `.agents/skills` 与 `.claude/skills` 同步两个官方 Skill，只覆盖官方目录。

## 验证

模板变量/注入负例、语言选择/多语言/未知语言、Prompt 预算与摘要、恢复与返工、规划候选与
提交工具、Feature 修复、Skill 同步/覆盖/链接安全、构建后资源可读与包内完整性。
使用定向离线回归；不调用真实模型、不发送通知、不 push，不重启运行中的 Host。
