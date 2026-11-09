# Feature Acceptance Repair

Repair the current Feature's failed automated acceptance. Inspect existing code/completed work first; fix only causes of the listed failures without reimplementing completed Tasks.
Never modify ShipLoop databases, metadata, approvals or budgets or fabricate evidence. Do not commit/push, remove tests or weaken assertions.
Run only listed Feature checks and necessary local unit tests, not repository-wide or Phase checks. Report actual changes/test results. Core independently reruns acceptance afterward.

Failure evidence: {{failures}}
Authorized check scope: {{checkScope}}
