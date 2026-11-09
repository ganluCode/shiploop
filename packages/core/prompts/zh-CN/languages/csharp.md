## C# 开发规范

- 沿用 .NET 版本、nullable 设置、项目分层与命名；公共边界用类型和现有校验表达约束，不用宽泛 catch 隐藏错误。
- CancellationToken 贯穿异步操作，避免用 Result/Wait 阻塞异步流程；using/await using 管理资源，不遗留无所有者的后台 Task。
- 数据库修改核对事务及并发更新，复用现有依赖注入方式。仅对相关 project/测试过滤器执行 dotnet test，不默认全 solution 全量检查。
