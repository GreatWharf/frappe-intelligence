# Security and data boundaries

## Trust model

The Frappe site is the tenant. Company, document, field and user permissions are additional boundaries inside that site. Conversations are private in this release; there is no participant-sharing feature. A System Manager is not automatically entitled to another user's personal provider credential through Intelligence or the native password getter. A database/root operator with the site encryption key remains trusted and can access site data; this is not cryptographic isolation from the hosting administrator.

Models do not receive database credentials, a terminal, raw SQL execution or arbitrary whitelisted methods. All ERP operations go through the reviewed tool registry. Neither model output nor uploaded/retrieved content may grant permission, change an approval or choose an execution identity.

## Authorization

- Only enabled System Users with Intelligence User, Intelligence Manager or System Manager can use the app. Guest/Website User access is rejected server-side.
- Every conversation, run and approval is bound to its owner/site. Workers establish the initiating user's context before proposing or executing tools.
- Query-condition and document-permission hooks also restrict Desk lists and generic REST reads. Managed-record controllers reject direct REST writes; app-only internal writes are scoped and never active during business-tool execution.
- Provider password retrieval is guarded at the controller, including the native `frappe.client.get_password` path. Non-owner use requires a short-lived server-only grant bound to the exact provider/current actor and an available shared-provider policy. The bookkeeping flag does not grant decryption.
- Shared-provider roles are rechecked on every use. Omitted policy fields during provider edits preserve restrictions; changing an existing conversation's provider destination requires a new configured provider/conversation.

## Approvals and execution

Every tool call, including reads and memory recall, creates a durable proposal. A preview is for the human only: it must not be included in provider messages before approval. Explicit approval is bound to the actor/site/conversation/run, canonical arguments, tool version and expiry. Write tools require an exact record revision.

Approval is not sufficient by itself. Execution rechecks current permissions, registry policy, proposal digest/expiry, current preview and target revision. Denied/expired calls produce a bounded tool outcome, not an action. Every execution receipt has a unique approval link. Local business mutations and receipts share a database transaction; reviewed tools must not commit or invoke undisclosed external side effects.

Managers can delegate routine decisions without widening permissions. An enabled approval policy matches a call by tool, DocType, operation class, role and amount threshold, and resolves to require approval, auto-approve or deny; the first match by priority, then specificity, decides. A user's own standing grants, scoped to a tool and optionally one DocType, held either for one conversation or always, resolve before policies, so revoking a grant is the way to undo a standing answer. A policy deny names its reason in the tool outcome and fires before the built-in exemptions for a user's own memory and files, so a manager can tighten even those defaults. Every auto-approval, whether by grant or policy, is recorded on the same durable proposal a human would answer, with its source named, and passes the same execution rechecks.

Run admission and daily quotas use a user mutex plus current database reads rather than assuming ordinary reads refresh a REPEATABLE READ snapshot. Worker leases and active-run binding fence stale processes. A timeout does not prove an external action failed; uncertainty is recorded and must be reconciled, not retried blindly. External extension actions are disabled in this release even though the engine includes recovery states for future integrations.

Arbitrary installed code is not sandboxed by the registry. Extension authors and site operators must review Document hooks as well as the tool handler: a native save can trigger other installed applications.

## Provider network boundary

Native vendor URLs are fixed. Custom providers require an administrator-allowlisted exact public HTTPS host. The transport validates every resolved address, blocks private/loopback/metadata/transition addresses, pins an approved address through the TLS connection while retaining hostname verification, rejects redirects and URL credentials, and does not inherit proxy settings. Time, request/response size and DNS concurrency are bounded.

API keys are encrypted using Frappe's password facilities and used only server-side. The UI never returns them; blank updates preserve stored keys. Provider errors are classified into safe messages rather than displaying raw response bodies. Configure host/proxy logging not to capture request bodies or authorization headers.

Using a remote model sends approved context to that provider. Review the customer's provider terms, retention, processing location and account policies; do not claim all data remains on the ERP server. Provider authentication, cost limits and Frappe authorization are separate controls.

## Attachments and memory

Uploads remain private and attached to the user's conversation. They cannot be reparented to bypass privacy. Uploading a document is not approval to send its contents to a provider; the `read_attachment` tool needs approval. Attachments have one shared effective size policy, UTF-8/type checks, PDF page/text/time bounds, local-path/symlink checks and a separately killable PDF parser. Encrypted PDFs, OCR, remote attachment URLs and native image input are not supported.

Parsing limits are not antivirus scanning. Apply deployment-specific malware and retention policies. Content and citations remain untrusted data. Markdown rendering uses an escaped, restricted renderer with safe link protocols and no remote image tracking.

Memory is explicitly scoped to personal, conversation or manager-curated site notes. It is not automatically extracted from private chats. Approved recall is required before memory content enters model context. Avoid storing secrets or raw financial documents as preferences.

Archiving is not deletion. This release has no complete automated export/erasure/retention workflow; do not imply regulatory compliance from access controls alone.

## Limits of current assurance

Offline protocol, state-machine, permission-boundary, parser and UI-contract tests are provided. They do not prove actual Frappe permission dispatch, MariaDB concurrency, RQ recovery, live browser behavior or a provider's current protocol without the corresponding integration runs. See [verification](verification.md). No penetration-test or production-security certification is claimed.
