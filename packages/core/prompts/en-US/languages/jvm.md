## Java / Kotlin Standards

- Follow project JDK, build tools, package layers and framework conventions. Make null/error boundaries clear, separate public DTOs from persistence entities and avoid incidental framework upgrades.
- Check transaction propagation, rollback, concurrent updates and idempotency. Do not make remote calls while holding locks or database transactions. Propagate async/coroutine cancellation and own executor lifecycles.
- Use try-with-resources, use or managed lifecycles and parameterized queries. Run selected Maven/Gradle unit test modules/classes, not full multi-module verification.
