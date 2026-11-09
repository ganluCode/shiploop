# Production Runtime Policies

Place project policies under schemaVersion: 2 / policies and submit through config create/update or explicit watch. Never edit SQLite.

| Section | Fields | Defaults/boundaries |
| --- | --- | --- |
| piAgent | transient_retry_attempts, transient_retry_backoff_base_seconds | 10 consecutive retries, base 1s, waits 2/3/4… up to 60s; complete success resets consecutive count, cumulative faults remain |
| piAgent | fallback_on_connection_exhausted, fallback_on_server_exhausted, fallback_on_authentication | true; approved fallbacks, confirmed stop/recording and budget required; Task fallbackPolicy takes precedence |
| piExecution | maxRequests, maxInputBytes, maxOutputTokens | 256 / 512000 bytes / 16384 tokens; model context/Core budgets still apply |
| piExecution | thinkingLevel, commandTimeoutMs, codemode | off / 600000ms / true; reasoning level is separate from model tier |
| featureAutoFix | enabled, strategy, maxRepairs, maxTokenTotal, timeoutMs, maxTurns | disabled; default high and 3 repairs (max3); optional repair-specific budgets, parent/Host/model limits remain |
| deliveryPolicy | auto_push, push_remote | false / origin; formal commits need commitMode: task_and_feature and confirmed gitIdentity |
| feishu | enabled, notify | disabled; unspecified events enabled once notifications enabled |

Feature checks run only after all Tasks pass. Enabled auto-fix uses a separate Runtime, confirms stop and rechecks independently for up to three persisted repair attempts; it never repeats passed Tasks, replaces owner approval or runs whole-repository checks.
Push follows successful checks/approval/local commit, exact SHA to branch, never force. Reconcile unknown receipts with remote facts. Remote drift/auth failure retains local commit; do not recode to retry a push. Git isolation does not inherit arbitrary credential helpers.

Feishu events: task_completed, feature_completed, rate_limited, model_fallback, error_stopped, human_blocked. Durable outbox failures do not roll back business state; unknown transport results can duplicate (delivery ID identifies them). Successful Runs do not create duplicate error notifications.
Wide cards group project/task, status, Task usage; success green, failure red, fallback/manual orange. Current Run Task attempts contribute complexity, models, cumulative session minutes, ordinary input+output tokens excluding cache (k), and connection faults. Unknown/partial remain explicit. Locale freezes at projection for stable retries.

Effective limits are the minimum of all layers: absent Core policies Work60s/tool30s, production Shell600s does not extend them. Host defaults256 requests/512000 input bytes/16384 output tokens are not a whole-Batch token total. Batch has approved deadline/start count and optional token/cost total. Resolve the process one-hour limit before promising longer sessions.

Private auth.json (0600, pi directory0700; preserve other providers):
```json
{"feishu":{"type":"webhook","url":"https://open.feishu.cn/open-apis/bot/v2/hook/<id>","secret":"<optional signature secret>"}}
```
Never expose/request keys in chat. Private runtime.json supports pi_agent, execution, notifications.feishu (Host restart). Project policies override defaults within explicit deployment caps. Invocation freezes its configuration. No unauthorized live model/notification tests.

Coding tools: file read/write/exact edit, rg search, supervised Shell and directory instructions. Trusted SDK Codemode defaults on without PI_CODEMODE; batch independent searches/reads, sequence dependent commands/writes. Trusted Shell is not an OS sandbox. Core owns metadata/database/official Git.
Only Core-selected Skills load; init sync alone is not selection. Root AGENTS.md loads; query ancestor instructions before nested edits. Planner is read/search/submit only; candidates require human approval.
