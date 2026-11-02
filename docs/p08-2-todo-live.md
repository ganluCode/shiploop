# P08-2 F-004 Todo 正常 live 交付

`runTodoLiveDelivery` 是正常交付的门禁核心。规划、批准和执行授权仍通过正式 ShipLoop CLI；Task 运行端口必须返回 `executionMode: "live"`，并且 provider/model 与授权快照一致。

每个 Task 串行经过真实 Runtime、Task 局部检查和本地 Git 提交。只有三项均有结构化证据且证据保存成功，依赖 Task 才会解锁。Runtime 返回 completed 不等于 Task 通过；检查失败、提交失败、commit/tree 缺失或证据保存失败都会保留失败结果并阻塞后继。

本地单测使用注入端口验证门禁逻辑，不把 FakeRuntime 结果折算为 live 通过。真实 Pi、真实 ShipLoop CLI、临时项目和凭据必须经独立授权入口执行；没有授权时 `npm run accept:p08:live` 返回 `not_run`。真实 Host、SQLite 竞争、进程停止和恢复组合属于 P08 Phase 集成验收。
