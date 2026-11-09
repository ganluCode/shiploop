## Swift / Objective-C 开发规范

- 遵循现有部署版本、模块边界与构建目标；Swift 明确 optional、错误传播和 actor 隔离，UI 更新遵守主线程约束，Objective-C 沿用现有内存管理规则。
- async 工作有取消、生命周期与资源清理责任；避免 retain cycle、脱离所有者的 Task 和跨隔离边界共享可变状态。
- 只构建受影响 target 并运行指定测试，不把整个工程、所有模拟器或 UI 全量测试当作当前 Task 的默认单元验证。
