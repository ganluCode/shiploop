# P02 人工验收：在代码仓库实际操作

## 最新放行状态（2026-10-11）

负责人已按本说明完成人工操作，并明确“接受这些首版设计，P02 验收通过，允许进入 P03”。
完整验收 `20261011T081336Z-caf6b072` 在受测提交
`ca63e21a6a5c4e86c170345476d7d62b131077ca` 上通过（15/15），干净快照两次复跑均通过。
契约 §15 和人工清单 §8 已回填；下面步骤留作以后复验指南，末尾“尚未重做”为修补时
历史记录，不代表当前状态。本次放行不自动合并分支或启动 P03。

本阶段验收 Host、项目注册、配置、获准基线命令、事件与重启恢复；不验收真实 LLM
编码、Chat 或桌面 UI。自动化通过后，仍需负责人确认行为和 P02-3 契约 §15。
无需手工逐一重做所有单元测试，但不能把 Nezha completed 当成人工放行。

## 1. 准备与自动检查

在主代码仓库打开终端，不在 harness，不新建 worktree：

```sh
cd /Users/ganlu/Documents/my-dev/code/mygit/AI/shiploop
git branch --show-current
nvm use 22.19.0
npm ci
npm run verify
```

分支应为 `acceptance/p02`。verify 必须退出 0，测试、类型检查、构建都通过。
每条命令失败就停下排查，不能继续执行后宣称验收通过。

完整阶段验收命令是 `npm run accept:p02`，含干净源码快照两次复跑，预计至少
15–30 分钟，机器负载高时更久。终端等待即可，不要套 600 秒外层超时，不要设置
`SHIPLOOP_CLEAN_REPLAY_DEPTH` 来省略完整复跑。它取 HEAD 的干净源码：本分支
修改正式提交后再执行，未提交修改不能声称已通过干净快照验收。
当前复跑工具会回填 `docs/acceptance/evidence-p02-4-clean-replay`；运行后检查 diff，
历史证据不能无说明覆盖，保留 run-id 和受测提交身份。结果必须 15 pass / 0 fail /
0 not_run 且退出 0；详细入口和分阶段方式见 `docs/p02-4-operations.md` §4。

## 2. 创建安全的临时演示环境

以下命令都在同一个终端执行。只操作临时仓库，不改 ShipLoop 源码和个人凭据。

```sh
DEMO=$(mktemp -d /tmp/shiploop-p02-manual-XXXXXX)
ROOT="$DEMO/data"
REPO="$DEMO/repo"
mkdir -p "$REPO"
git init -q "$REPO"
git -C "$REPO" config user.name Demo
git -C "$REPO" config user.email demo@example.invalid
printf 'P02 manual demo\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm init
sl() { node "$PWD/packages/cli/dist/bin.js" "$@" --data-root "$ROOT" --json; }
printf '演示目录：%s\n' "$DEMO"
sl host start
sl host start
sl host status
```

看什么：两个 start 指向同一个 hostInstanceId；监听为 127.0.0.1，status 为运行状态。
演示中不要切换当前目录，否则 `sl` 的入口会变化。异常退出后也用这里的 ROOT
执行 host stop，不删除锁或 SQLite。

## 3. 预览、注册、重复注册

```sh
sl project init "$REPO"
sl project list
sl project init "$REPO" --confirm --name P02-Demo > "$DEMO/init.json"
cat "$DEMO/init.json"
PROJECT_ID=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.ok) process.exit(1); console.log(x.result.registration.projectId)' "$DEMO/init.json")
sl project init "$REPO" --confirm --name P02-Demo
sl project overview "$PROJECT_ID"
sl project list
git -C "$REPO" status --porcelain
```

看什么：预览不注册；确认后产生 projectId；再次确认返回 already_registered，仍为
同一个 ID，只出现一个项目。最后 git status 为空，源仓库未被初始化操作改动。

## 4. 配置写入与读取

```sh
printf '%s' '{"schemaVersion":2,"policies":{"executionLimits":{"maxConcurrentWorks":1}}}' > "$DEMO/global.json"
sl config create --scope global --input "$DEMO/global.json"
sl config get --scope global
sl config effective --project "$PROJECT_ID"
```

看什么：配置持久化，effective 显示正确值与来源，不是只在本次进程内生效。

## 5. 授权基线、结果、制品、幂等回执

```sh
printf '%s' '{"checks":[{"checkKey":"echo-ok","kind":"command","argv":["/bin/echo","baseline ok"],"timeoutMs":60000,"required":true}]}' > "$DEMO/plan.json"
sl baseline preview --project "$PROJECT_ID" --input "$DEMO/plan.json"
CMD=$(uuidgen | tr '[:upper:]' '[:lower:]')
sl baseline run --project "$PROJECT_ID" --input "$DEMO/plan.json" --confirm --wait --command-id "$CMD" > "$DEMO/run.json"
cat "$DEMO/run.json"
OPERATION_ID=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.ok) process.exit(1); console.log(x.result.operationId)' "$DEMO/run.json")
ARTIFACT_ID=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.ok) process.exit(1); console.log(x.result.checks[0].output.artifactId)' "$DEMO/run.json")
sl baseline status "$OPERATION_ID"
sl baseline evidence "$ARTIFACT_ID"
sl receipt get "$CMD"
sl baseline run --project "$PROJECT_ID" --input "$DEMO/plan.json" --confirm --wait --command-id "$CMD"
sl baseline list --project "$PROJECT_ID"
```

看什么：preview 展示 argv、超时和代码身份但不执行；confirm 后 state=passed、
status=completed、check.exitCode=0，制品包含 baseline ok。重复同一命令得到原操作，
列表不是两个 operation。accepted 仅为受理，不能当 passed。

## 6. 客户端中断不杀 Host

```sh
sl events --project "$PROJECT_ID" --follow
```

等待事件订阅建立，按一次 Ctrl+C，再执行：

```sh
echo $?
sl host status
sl baseline status "$OPERATION_ID"
```

看什么：观察中断退出码为 4；Host 还在，原结果仍可查。这里仅退出观察，不是取消任务。
要用第二个终端时，把第一终端打印的 ROOT 绝对路径复制过去：

```sh
node packages/cli/dist/bin.js host status --data-root '替换为第一终端的 ROOT' --json
```

第二终端的 hostInstanceId 应与第一终端一致。变量不会在终端之间自动共享。

## 7. 停止、重启、持久化与最终收尾

```sh
sl host stop
sl host start
sl project overview "$PROJECT_ID"
sl config get --scope global
sl baseline status "$OPERATION_ID"
sl baseline evidence "$ARTIFACT_ID"
sl host stop
sl host status
```

看什么：stop 返回 stopped 且退出、锁、发现记录三项确认；重启得到新实例，但项目、
配置、operation 和制品都保留。最后 status 应报未运行并非零退出，这是预期负例，
不是验收失败。保留 DEMO 目录便于排查，不要手工删除锁来停止 Host。

## 8. 放行

- 自动化必须通过；以上行为符合预期；P02-3 契约 §15 的待确认项由负责人核对。
- 在 `p02-4-review-checklist.md` §8 记录实际验收日期、受测提交和意见。
- 还有失败、未运行或未确认项时不要放行 P03；本说明不自动签字、不合并分支。

## 本次修补范围

`acceptance/p02` 从 P02-4 最终分支建立，主仓库 checkout，无新 worktree。
修复测试收尾缺失 data-root、忽略停止失败的问题，并断言原 PID 消失再删除夹具；
修正历史报告最终统计和迁移 v5。测试通过不代表人工审批完成。
验收控制器现在也将场景预算透传给测试启动器，避免外层 20 分钟、内层默认
10 分钟的不一致；整个命令的终端/自动化外层仍需允许足够时间。

本次验证（2026-10-11，acceptance/p02 未提交工作树）：
- 收尾回归先复现失败，修复后业务 6 项和文档 10 项共 16 项通过。
- 预算透传回归先复现两个失败断言，修复后控制器/报告 32 项通过。
- `npm run verify`：117 files / 2971 tests，typecheck/build 通过，退出码 0。
- 隔离临时仓库实跑本说明的注册、配置、基线、同 commandId 重放与重启查询，退出 0；
  最后 host stop 三证据确认，进程复查无测试 Host 残留。
- 完整 depth=0 干净快照复跑尚未在本次修补后重做；既有 15/15 为历史证据，
  不能代替本分支新验证。人工 Ctrl+C 与最终审批仍由负责人检查。
