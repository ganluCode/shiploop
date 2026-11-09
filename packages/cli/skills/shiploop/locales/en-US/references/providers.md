# Providers and Models

Use ShipLoop global/project settings, not the global Pi CLI's current model. JSON and commented YAML support modelMap low/medium/high, purposeStrategies.planner, ordered fallbacks and fallbackPolicy. See [configuration files](configuration-files.md).

```json
{"schemaVersion":2,"strategies":{"modelMap":{"low":{"runtime":"pi","provider":"<provider-id>","model":"<model-id>","credentialRef":"credential://pi/<provider-id>"},"medium":{"runtime":"pi","provider":"<provider-id>","model":"<model-id>","credentialRef":"credential://pi/<provider-id>"},"high":{"runtime":"pi","provider":"<provider-id>","model":"<model-id>","credentialRef":"credential://pi/<provider-id>"}}}}
```

```bash
shiploop config create --scope global --input global-config.json --data-root "$DATA_ROOT" --json
shiploop config effective --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
```

Read revision before config update --revision. Never put API keys, tokens, passwords or secret URLs in settings. Provider/model must exist in the trusted capability catalog. credentialRef identifies private authentication; a fabricated reference does not create credentials or inherit global Pi login/models.json.
Tasks retain strategy copies; default updates do not rewrite Tasks/Attempts. Use task strategy or strategy-reapply-preview/strategy-reapply with review/approval.

Production Host reads only explicit files under its data root:
- pi/runtime.json: permitted providers/models, custom protocol/baseUrl/contextWindow/maxTokens/reasoning when not builtin.
- pi/auth.json: literal API keys mapped to credential://pi/<provider-id>.
Both must be owned by the current user, mode 0600, no symlinks; pi directory should be 0700. Literal API keys and builtin openai-codex OAuth are supported; no command keys, other OAuth providers, interpolation or global Pi/Codex scanning. Restart Host after capability changes; missing configuration leaves an empty catalog.

## Codex Subscription

Have the user run in their terminal:

```bash
shiploop provider login openai-codex
shiploop provider login openai-codex --method device
shiploop provider auth-status openai-codex --json
shiploop provider models openai-codex --json
shiploop provider logout openai-codex
```

All accept --data-root. Browser login prints a URL and requires an interactive terminal; device login supports headless authorization. Ctrl+C cancels; timeout15min. Never ask users to paste tokens/auth codes into chat. No global credentials are imported.
auth-status is local-only: ready is not an online/quota check; refresh_required means SDK resolution must refresh. SDK refresh is serialized under an OS file lock, with atomic0600 persistence before release; preserve unrelated API/Feishu entries. Logout deletes this local credential only, not server authorization or in-flight requests.
models lists builtin IDs and enabled flags offline. Login does not extend the capability catalog; preserve runtime.json and explicitly allow selected openai-codex model IDs, then restart an idle Host. YAML: runtime: pi and model: openai-codex/<enabled-id>; credentialRef is inferred by the file adapter. Custom endpoints are prohibited. Subscription usage records tokens with unknown monetary cost, not API pricing. No unauthorized live probe.

```json
{"schemaVersion":1,"providers":[{"id":"zai-coding-cn","models":["glm-5.3"]}]}
```
Private auth example (never in a repository):
```json
{"zai-coding-cn":{"type":"api_key","key":"<fill privately>"}}
```

Use exact redacted endpoint/protocol information; never guess or request secrets in chat.
Coding Work has file read/write/exact edit, rg search, supervised commands and project instructions. Trusted SDK Codemode is enabled by default. Commands default to ten minutes; timeout stops/verifies the Invocation group. Core owns official Git/acceptance.
Planning has read/search/candidate submission only, no Shell/write/self-approval. Only Core-selected, verified project Skills load; no implicit global Skills/MCP/plugins.
See [production policies](production-runtime.md) for retries, execution limits, auto-fix, push and notifications.
