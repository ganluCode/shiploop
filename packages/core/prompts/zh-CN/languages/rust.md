## Rust 开发规范

- 沿用 crate 与 feature 边界，优先通过所有权、借用和类型表达不变量；正常失败返回 Result，避免用 unwrap/expect 处理外部输入。
- 明确 async 任务、锁 guard、取消和资源释放的生命周期，不在跨 await 时持有不必要的锁，不为绕过借用检查引入多余 clone 或 unsafe。
- unsafe 仅在现有设计确需且能证明安全条件时使用；测试限定受影响 crate 和用例，不默认整个 workspace 的全特性全量检查。
