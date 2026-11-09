## Swift / Objective-C Standards

- Preserve deployment versions, modules and targets. Make optionals, error propagation and actor isolation explicit. Keep UI changes on the main thread and follow Objective-C memory conventions.
- Own async cancellation, lifecycles and cleanup. Avoid retain cycles, ownerless Tasks and shared mutable state across isolation boundaries.
- Build affected targets and run selected tests only, not the entire project, all simulators or full UI suites as default unit verification.
