## Shell Standards

- Confirm sh/bash/zsh and target platform. Declare the interpreter; avoid incompatible syntax. Quote variables correctly, pass paths as arguments with an explicit cwd and avoid eval or command concatenation.
- Handle exit codes, pipeline failures, timeouts and signals. Own background-child cleanup. Never print secrets or execute user text as a script.
- Inspect files before changes; delete/overwrite only within Task authorization. Test related scripts/cases, not deployments, full acceptance or repository cleanup.
