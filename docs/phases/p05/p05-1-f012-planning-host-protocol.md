# P05-1 F-012：规划 Host 协议接线

本任务沿用命令信封/查询 schema v5；`planning.start` 的 accepted 回执使用已有专属 v7，包含 Batch、Run、planning Task、candidate 四重身份。accepted 仅表示持久授权，不能当成候选已生成或计划已批准。

人工命令经既有 `POST /v1/commands` 提交：`planning.start`、`planning.candidate.decide`，以及既有 `execution.pause/cancel/resume`。HostClient 对应提供 `startPlanning`、`decidePlanningCandidate`，控制路径复用既有方法。提交与回执恢复共享冻结信封、原 commandId、请求摘要和项目归属核验；客户端断开不取消已接受的命令。

| 查询 | HTTP 路径 | HostClient |
| --- | --- | --- |
| 规划列表 | `GET /v1/planning-contexts?projectId=&featureId?=&limit?=&cursor?=` | `listPlanningContexts` |
| 规划详情 | `GET /v1/planning-contexts/:candidateId?projectId=` | `getPlanningContext` |
| 候选正文投影 | `GET /v1/planning-contexts/:candidateId/candidate?projectId=` | `getPlanningCandidate` |

三条查询经生产 `startHost` 装配的 Core `planningQueryService` 授权读取，候选正文先由 Core 经受管 Artifact 核对 hash/size、候选契约、身份与摘要。客户端检查完整字段、版本、状态词汇、Run/Task/预算身份、候选引用及摘要一致性；决策 completed 结果另查具体批准/拒绝形态，不能仅凭回执 status 认定批准。客户端运行时依赖仍仅使用 `shiploop-core/protocol`。

规划工具继续使用 F-006 的 `POST /v1/work/tools`、独立 token 和 `planning.candidate.submit`，不能持人工 token 进入工具面，也不能持工具 token 调管理面。主体来自可信装配，客户端字段不能覆盖 principal。标准 Pi/脚本化 Runtime 选择复用既有 Work 工厂接口，没有增加模型调用入口或依赖。

## 正常结束后的 Batch 收尾修复

真实 Host 往返测试发现：规划 Run succeeded 且派发已释放后，Batch 仍 running，人工决定被 `active_batch_structure_lock` 拒绝。新增共享 SQLite 原语 `closeSucceededPlanningBatchInTransaction`，在正常派发释放/幂等补扫与启动恢复同一短写事务中使用：仅 queued/running、无暂停请求、非空且全部 Run 为成功 planning、全部认领 released 时收尾 Batch。它不释放租约/槽位、不改计数，不把取消/失败/暂停或停止不确定改成成功。原恢复规则与正常路径共用；没有 schema 迁移。

## 验证与影响范围

仓库可信选择：`test/index/phases/P05/features/P05-1/tasks/F-012.json`，Harness selection 仅引用此索引；它是受影响回归选择，不是通过证明。

本地执行 F-012 新增真实 HTTP/SQLite/Git + 脚本化 Runtime 测试、Host 能力契约、客户端协议依赖边界、共享回执恢复，以及直接受影响的 planning 取消/恢复用例。覆盖人工批准/拒绝、旧计划审批兼容、planning pause/resume/cancel、低能力/跨项目/Attempt/版本隔离、工具 token 越权、过期摘要/CAS、相同 commandId、丢弃 planning.start 响应后查回执恢复、SSE 断开、畸形响应和伪造决策结果。工程检查包含 typecheck、边界与构建冒烟，详细退出码及完整日志保存在 Harness `verifications/F-012/runtime-logs/`。

索引中其他 Host、旧计划、受限工具、基线、预算、报告及规划执行文件交由 Nezha 独立 Verifier 执行：接口新增必填 planningQueryService 后只补装配字段的旧夹具没有改业务断言。`report-host.ts` 的受影响调用通过现有 Host 报告契约用例覆盖。未本地运行的索引文件保持 not_run，不宣称 Feature/Phase 验收通过。全仓、阶段验收、真实 provider/model 和付费调用均 not_run。
