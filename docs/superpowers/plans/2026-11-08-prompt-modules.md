# Markdown Prompt Modules Implementation Plan

**Goal:** 外置全部内置提示词，按开发语言注入规则，提供并发友好的 Feature 规划 Skill。
**Architecture:** 文件适配器加载内置 Markdown，纯目录与渲染端口注入 Core 组装器；Host 复用相同资源。
**Spec:** `docs/superpowers/specs/2026-11-08-prompt-modules-design.md`
**Execution:** 当前单 Agent；不委派、不发真实模型请求、不提交或 push。

## Review Focus

- 缺文件或缺变量必须失败；插值不递归、不执行表达式，不泄漏变量正文。
- 发布包从任意 cwd 加载相同资源，不能只在源码仓库可用。
- 多语言选择必须稳定、去重，未知语言不可扩大资源权限。
- 新模板影响最终 Prompt 摘要，旧输入制品不可改写；预算不能被模板绕过。
- init 只覆盖官方 Skill，保留其他 Skill 和业务文档，拒绝符号链接逃逸。

## Steps

- [x] 新增渲染、目录校验、语言选择与资源加载定向测试，确认失败。
- [x] 实现纯模板目录/渲染端口和文件适配器，资源加入包清单。
- [x] 迁移 Task/Planner/返工恢复/修复及 Runtime 提示与工具说明，记录模块身份。
- [x] 注入语言规范，详化复杂度与 labels/languages 规划要求。
- [x] 添加 Feature 规划 Skill、规划模板及 init 同步；补同步与安全测试。
- [x] 定向回归、typecheck、边界检查、build/资源 smoke，记录实际结果。

## 实际验证

- 首轮 8 文件 127 项局部回归通过。
- 扩展 13 文件 246 项通过，含 Feature 自动修复后独立验收、输入制品、返工、探针和 Skill 安全边界。
- 最后 4 文件 25 项通过，含真实 Pi SDK + localhost 假模型请求、构建后系统提示、规划提交及候选示例 Schema 校验。
- typecheck、569 个生产文件的架构边界检查及 build/临时 Host smoke 通过。
- 离线 npm pack dry-run 核对 Core 提示词和 CLI 双 Skill 进入包；构建版从无关 cwd 加载 Markdown 成功。
- 没有调用真实模型、发送通知、push、重启真实 Host 或覆盖现有项目 Skills；未运行全仓测试。
