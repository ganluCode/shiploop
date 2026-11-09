## Required Task Metadata

- Fill id, title, description, complexity, acceptance.criteria and dependsOn according to the formal contract. Dependencies refer to real Tasks in this Feature. Cross-Feature dependencies belong to the Feature DAG.
- labels is an array of concise English labels describing actual domains: frontend, backend, cli, runtime, storage, infrastructure, documentation; add testing, security or concurrency when meaningful. Mixed domains may use multiple labels.
- languages is an array of actual development languages changed by this Task, usually one (["typescript"]), occasionally several (["typescript", "sql"]). Do not copy the entire project stack.
- Use lowercase language names. SQL/Shell/HTML/CSS are languages; React/Electron/Spring are frameworks. Use [] for documentation or unknown languages and explain in description; do not guess.
- Labels organize/search only, without granting capabilities or deciding complexity. languages is formal execution input that selects language standards and participates in plan identity. Free-form labels cannot change permissions.
- Acceptance describes observable behavior with risk-appropriate negatives/invariants. Task verification contains related unit-test intent only, not full Feature/Phase gates.
- Before submission inspect code/current Tasks, complexity evidence, labels/languages, real dependencies, complete acceptance and references. Do not submit execution state, passed, budgets, credentials, shell or unsupported fields.
