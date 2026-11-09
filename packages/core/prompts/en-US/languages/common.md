## Common Development Standards

- Inspect the existing implementation, completed work, project AGENTS.md and selected Skills first. Reuse established repository patterns and avoid rebuilding existing capabilities.
- Implement only the current Task. Keep changes local; avoid unrelated refactoring, dependency upgrades or generated files. Follow project conventions when language-specific rules are unknown.
- Validate inputs and handle errors, cancellation, resource cleanup and secret redaction according to actual risk. Design locking, transactions, idempotency and recovery only where shared resources or side effects require them.
- Run only unit tests related to this Task. Do not run repository-wide, other Feature, Phase or heavyweight integration acceptance. Record any need for broader checks for Core or the owner.
- Investigate exact errors, affected files and bounded logs first. Do not scan or inline entire sessions, historical reports or dependency trees. Reuse valid test evidence rather than rerunning to reproduce the same output.
- Report actual commands, exit codes, scope and unrun checks. Preserve user changes; never weaken tests or fabricate results. Core owns official Git commits, pushes, approvals, metadata and delivery.

## Code and Module Organization

- Organize related code by business module, capability or stable responsibility within existing architectural layers. Names and directories should help reviewers find implementations, contracts and tests. Preserve public APIs and dependency direction.
- Use moderate directory depth: avoid large flat collections of unrelated files and mechanical directories for every one or two files. Do not organize source by Task/Feature ID or add empty layers. Prefer cohesion and clear names over fixed file quotas; a small independent module may contain few files.
- Place new files in existing modules when appropriate. Group an unwieldy directory only along real module boundaries. Give shared code clear ownership; do not dump unrelated code into utils/common or merge unrelated implementations to reduce file counts.
- Organization serves navigation and review, not a numeric delivery gate. Organize only new or necessarily changed code in this Task; arrange broad migrations separately without expanding test scope.

## TDD: Red–Green–Refactor

Use test-driven development for features, bug fixes and testable behavior changes. Language-specific rules do not replace this workflow.

1. Inspect existing code, related tests and prior evidence. On resume or rework, retain completed code and valid results; do not delete work to reenact TDD.
2. **Red**: add or adjust the smallest relevant unit test first, run it and confirm failure caused by the missing behavior or defect. Import/environment failures and incorrect assertions are not valid Red evidence. If it passes, check whether the behavior already exists.
3. **Green**: implement only what makes the test pass, then rerun that test. Bug fixes need a regression reproducing the defect. Do not implement everything first and call tests added afterward TDD.
4. **Refactor**: tidy only duplication or structure needed by this change while preserving behavior; rerun affected unit tests. Avoid unrelated refactoring.
5. Record the real Red cause, Green command/results, covered scope and unrun checks. Never invent Red evidence, delete tests, weaken assertions, arbitrarily skip or broaden mocks to bypass behavior.

Use the smallest relevant test files/cases per iteration. Finish a Task with affected unit tests only; TDD does not authorize repository-wide, whole-Feature or Phase integration checks. Reuse valid evidence, but recheck affected behavior after implementation changes.

For documentation or configuration/format edits without executable behavior, use appropriate static/content validation rather than meaningless unit tests and explain why. Record gaps for external services or behavior outside current authorization; do not invoke services or claim TDD validation without evidence.
