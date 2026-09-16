<p align="center"><img src="frappe_intelligence/public/images/intelligence.svg" alt="Intelligence" width="72" /></p>

# Frappe Intelligence

**Bring your own AI. Keep your ERP in control.**

A private, multi-provider AI workspace for **Frappe and ERPNext**. Ask about permitted business records, inspect financial reports, work with documents, and approve specific actions—all from a dedicated chat page or a contextual Desk drawer.

**Implementation candidate · Independent community app · MIT licensed**

This is not an official Frappe, OpenAI, Anthropic, Google, OpenRouter or xAI product. It has not been published to the Frappe Marketplace. See the [verification record](docs/verification.md) before deploying; offline tests are not a production certification.

## An assistant, not a shortcut around permissions

- **A full chat workspace.** Separate private conversations, search, rename/archive, readable code and tables, paginated history, and configured provider/model selection.
- **Help beside your work.** Open the contextual drawer from Desk. Include or remove the current document identity explicitly; opening the drawer does not scrape the page or upload its fields.
- **Work that survives closing the UI.** Submitted messages, runs, approvals and results live on the server. Reopen the conversation to see progress or respond to a pending approval.
- **Approve what happens.** Read tools ask for approval too. Write proposals show their target and changes; execution rechecks permissions and record revisions. A stale approval cannot silently authorize a different change.
- **Bring your own provider.** OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, and administrator-allowlisted custom OpenAI-compatible endpoints. Personal credentials remain private; managers can configure shared providers and allowed roles.
- **Private documents and explicit memory.** Upload PDF/text/CSV/Markdown/JSON attachments and choose when the assistant may read them. Keep personal or conversation notes; managers curate site-wide guidance.

## Business capabilities

| Capability | Implemented behavior |
| --- | --- |
| Find and read records | Administrator-allowlisted DocTypes, user/company/field permissions, bounded results and sensitive-field exclusions |
| Financial questions | Reviewed ERPNext report adapters, including Balance Sheet, Profit and Loss, Cash Flow, Trial Balance, General Ledger, receivables and payables |
| ToDos | Create personal unlinked tasks and approve updates to permitted unlinked ToDos |
| Calendar | Approve version-checked updates to permitted events without participant links or Google synchronization |
| Wiki | Optional content-only edits to supported Wiki v3 documents when installed and enabled; no publishing or moving |
| Documents | Bounded extraction from text PDFs and UTF-8 files; no OCR or native image/vision input |
| Memory | Explicit save, edit, delete and approved recall; no invisible automatic harvesting |
| Additional apps | A reviewed extension hook for typed tools; installing an app does not automatically expose all of its methods |

The assistant can help draft email and explain permitted commerce/accounting records. **Email delivery, refunds, financial posting and automatic bank reconciliation are not implemented tools.** This release does not provide unrestricted code execution, shell access, generic SQL, or an external MCP server.

## Providers and costs

Models are configured by their actual provider model IDs, not selected from an assumed forever-current catalog. Customers supply their own provider credentials and pay their provider's usage charges separately.

Provider calls disclose the approved context to that provider. Data does **not** remain exclusively on the ERP server when a remote model is used. Custom endpoints must use HTTPS and an administrator-approved public hostname; private-network endpoints and redirects are rejected.

Responses currently arrive when the provider completes; status changes and tool approvals update live. Token-by-token streaming is not implemented.

**Codex account login is not shipped.** The architecture leaves room for an isolated runtime integration, but this release never asks for browser cookies, copied login tokens or Codex authentication files. A ChatGPT subscription is not treated as an API key.

## Getting started

1. Have an administrator install the app using the [deployment guide](docs/operations.md).
2. Assign **Intelligence User** to permitted Desk users. **Intelligence Manager** adds shared-provider and site-memory administration; System Managers can configure the app policy.
3. Open **Intelligence** from Desk or the app workspace.
4. Add a provider and its supported model ID, then create a conversation.
5. Review the data destination and approve each proposed tool call. Closing the drawer does not cancel submitted work.

The app targets MariaDB-backed Frappe v15/v16. ERPNext is optional for ordinary Frappe tools and required for the financial-report tools. Compatibility targets are not a claim that a live integration matrix has already passed.

## Documentation

- [Installation, upgrades and operations](docs/operations.md)
- [Security and data boundaries](docs/security.md)
- [Providers and authentication](docs/providers.md)
- [Business tools and extension contract](docs/tools.md)
- [Testing and verification](docs/verification.md)

Provider keys, chat exports, bank statements and customer data must not be attached to public bug reports.
