# Providers and authentication

## Implemented adapters

| Kind | Protocol | Key behavior |
| --- | --- | --- |
| OpenAI | Chat Completions with function tools | Fixed native endpoint; configurable compatible model; `max_completion_tokens` |
| Anthropic | Messages with tool use/results | Native message and tool-result normalization |
| Gemini | GenerateContent with function calls | Opaque function-call thought signatures preserved privately for replay; hidden thought text not displayed |
| OpenRouter | OpenAI-compatible Chat Completions | Fixed router endpoint; downstream provider data handling belongs to the customer |
| xAI | OpenAI-compatible Chat Completions | Fixed native endpoint; model capability must be checked |
| Custom | OpenAI-compatible Chat Completions | Exact allowlisted public HTTPS API root; `/chat/completions` appended |

These are text/function-tool adapters, not a promise that every model a vendor offers supports the same protocol. Models requiring a different API, advanced reasoning configuration, vendor-hosted tools, native vision, or special authentication may not work. The app does not fabricate a live model catalog.

## Configure a connection

Use **Providers & models** in the workspace/drawer. Supply a label, kind, actual model ID and provider-issued API key. Personal connections belong to the creating user. Managers may configure shared connections and permitted roles. Shared connections stop being usable if the owning manager is disabled or loses the required role.

No key is sent back to the browser. Leaving it blank during an update preserves it. Model/vendor/endpoint changes on a connection already used by a conversation require a new provider record, so old history is not silently moved to a new data destination. Disable a connection to revoke future model execution without deleting conversation history.

For custom endpoints, an administrator must add the exact hostname under **Intelligence Settings → Allowed Custom Hosts** first. Use an HTTPS API root such as `https://models.example.test/v1` only when that is your actual approved public endpoint; this example is not an available service. Wildcards, private/local IPs, embedded credentials, URL query strings, redirects and environment proxies are not supported.

## Limits and failure behavior

- Non-streaming completion: live status/approvals update during work, but reply text appears when the provider completes.
- At most 4 MiB serialized request/response bodies and a bounded network deadline.
- No hidden retries or provider failover. Retrying changes cost/data-destination implications and is not automatic.
- Inputs/results/history have additional engine limits. The app rejects oversized context instead of silently pretending it read the whole history or document.
- Usage is provider-reported token usage where available, not a guaranteed monetary invoice.
- HTTP errors expose a safe classification, not raw potentially sensitive provider bodies.

All protocol tests use synthetic responses. Live-model access, tool support, billing/quotas and model IDs must be validated with a customer-authorized test connection before production use.

## Codex account login

Codex is not an implemented provider/runtime in this release. No button claims otherwise. The original product brief proposes an optional isolated official-runtime integration, but it still requires a validated deployment, supported authentication flow, per-user credential/session isolation and suitable account/service terms.

A ChatGPT subscription is not interchangeable with an OpenAI API key. Never paste a browser cookie, access/refresh token or `auth.json` into an API-key field. Future account-login support should use the official managed browser/device flow rather than token extraction or a shared server login.
