## TypeScript 开发规范

- 沿用项目 tsconfig、模块格式和公共 API 约定；公共边界显式建模，外部未知数据先校验再收窄，避免用 any、双重断言或 ts-ignore 掩盖错误。
- 明确 Promise 的所有权，await 或显式管理后台生命周期；传播错误与 AbortSignal，取消后清理计时器、流和子进程，避免未处理 rejection。
- 使用仓库现有包管理器与锁文件，不为局部需求升级依赖；浏览器和 Node 的权限、环境与构建边界保持清晰。
- 只运行受影响的单元测试文件及必要的局部类型检查，不把全量 test/build/verify 当作每个 Task 的默认收尾。
