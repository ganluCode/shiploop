## Rust Standards

- Preserve crate/feature boundaries. Express invariants with ownership, borrowing and types; return Result for normal failures and avoid unwrap/expect on external input.
- Own async tasks, lock guards, cancellation and cleanup. Avoid unnecessary locks across await, clones or unsafe workarounds for borrow checking.
- Use unsafe only where the design requires it and safety conditions are proven. Test affected crates/cases rather than full-workspace all-feature checks.
