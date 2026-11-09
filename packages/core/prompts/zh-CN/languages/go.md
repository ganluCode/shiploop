## Go 开发规范

- 遵循现有 package 边界和 gofmt；错误携带上下文但保留可识别 cause，不用 panic 代替可预期失败。
- context 贯穿请求和 I/O，goroutine 明确退出与等待责任；锁保护真实共享状态，避免持锁执行外部 I/O，资源及时 defer 关闭。
- 复用项目现有接口和测试 helper，不为单一调用发明通用框架。仅对相关包/用例执行 go test；不要默认 go test ./... 或全量 race 检查。
