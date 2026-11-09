## Python Standards

- Use the project's interpreter, virtual environment and dependency manager. Follow boundary typing and validation; do not swallow failures with dynamic attributes or bare except.
- Release files, connections and locks with context managers. Propagate async cancellation, avoid unbounded event-loop blocking and give background tasks an owner.
- Use parameterized SQL and structured parsers, never executable string concatenation. Redact credentials. Select affected pytest/unittest modules or cases, not the entire repository.
