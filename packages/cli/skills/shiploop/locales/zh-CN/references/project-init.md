# 项目初始化

`project init` 操作本地仓库注册、ShipLoop 项目绑定和官方 Skill 同步；它不会安装依赖、执行仓库脚本、运行基线或创建 Git 提交。确认初始化会写入下述 Skill 文件，因此仓库可能出现未提交变化。

## 预览

```bash
shiploop project init "$REPO" --data-root "$DATA_ROOT" --json
```

预览检查本地 Git 仓库的 canonical path、HEAD、脏状态、repo identity 和既有绑定。

## 确认注册

```bash
shiploop project init "$REPO" \
  --name "项目名称" \
  --confirm \
  --data-root "$DATA_ROOT" \
  --json
```

`--confirm` 只确认项目注册。注册成功后，CLI 会把当前版本的 ShipLoop Skill 同步到：

```text
.agents/skills/shiploop/
.agents/skills/shiploop-plan-feature/
.claude/skills/shiploop/
.claude/skills/shiploop-plan-feature/
```

重复执行会覆盖两种 Harness 下这两个官方 Skill 的专用目录，但保留用户其他 Skill。
同步按全局 `locale` 选择中英资源，缺省英文；更改全局语言不会自动改写已有项目，需重新 `init --confirm`。
`shiploop-plan-feature` 供当前 Harness 模型规划并发友好的 Feature/PRD/DAG，不自动启动额外模型或编码。

首次注册必须提供 --name；已有绑定可以省略名称，沿用原项目名称并同步 Skills，不覆盖既有名称、说明或标签：

```bash
shiploop project init . --confirm
```

同步内容包含文档目录规范与 PRD、技术设计模板；不会覆盖项目文档。编写前读取 [文档规范](documentation.md)，用 project documents 查询统一数据根中的项目工作文档目录，实际 PRD/架构/Feature 设计放在那里，不随代码分支变化。

同一个本地 canonical path 会复用已有项目；同一个 GitHub remote 的不同本地 Clone 默认是不同本地项目。
