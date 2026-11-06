# 项目初始化

`project init` 只操作本地仓库注册和 ShipLoop 项目绑定；它不会安装依赖、执行仓库脚本、运行基线或修改 Git 内容。

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
.claude/skills/shiploop/
```

重复执行会覆盖这两个专用目录中的 ShipLoop Skill，但保留用户其他 Skill。

同一个本地 canonical path 会复用已有项目；同一个 GitHub remote 的不同本地 Clone 默认是不同本地项目。
