## Go Standards

- Follow existing package boundaries and gofmt. Add context to errors while preserving recognizable causes; do not panic for expected failures.
- Propagate context through requests/I/O. Give goroutines clear exit/wait ownership. Lock real shared state without external I/O under locks; defer resource cleanup promptly.
- Reuse interfaces and test helpers. Avoid generic frameworks for one call. Run related go test packages/cases, not go test ./... or full race checks by default.
