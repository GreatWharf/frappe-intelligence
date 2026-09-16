<p align="center">
  <img src="frappe_intelligence/public/images/intelligence.svg" alt="Frappe Intelligence logo" height="80" />
</p>

<h1 align="center">Frappe Intelligence</h1>

<p align="center"><b>An AI assistant that lives inside your ERP. Your keys, your permissions, your approval on every action.</b></p>

<p align="center">
  <img alt="Checks" src="https://img.shields.io/github/actions/workflow/status/GreatWharf/frappe-intelligence/tests.yml?branch=staging%2Freal-v16" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

<p align="center">
  <img src="dev/screenshots/workspace-approval-desktop.png" alt="The Intelligence workspace with an approval card awaiting review" width="1402" />
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> | <a href="docs/operations.md">Documentation</a> | <a href="docs/security.md">Security Model</a>
</p>

> **Unofficial, community-maintained app.** Not affiliated with, endorsed by, or certified by Frappe Technologies, ERPNext, OpenAI, Anthropic, Google, OpenRouter, or xAI.

## Frappe Intelligence

Frappe Intelligence brings a ChatGPT-class assistant into Frappe and ERPNext without handing your data, or your judgment, to a black box. It answers questions about the records a user is already allowed to see, reads the reports finance teams actually run, works with uploaded documents, remembers only what it's told to remember, and asks before it touches anything.

<details>
<summary><b>Screenshots</b></summary>
<br />
<p align="center"><i>The workspace: multiple private conversations, provider and model selection, and a pending approval with a full before/after diff.</i></p>
<img src="dev/screenshots/workspace-approval-desktop.png" alt="Workspace with approval card" />
<p align="center"><i>The contextual drawer: help beside the record you're looking at, included explicitly, never scraped.</i></p>
<img src="dev/screenshots/contextual-drawer.png" alt="Contextual drawer open over a Desk record" />
<p align="center"><i>Approvals hold up in the dark and on the phone; work survives closing the window.</i></p>
<img src="dev/screenshots/workspace-approval-dark.png" alt="Workspace approval in dark mode" />
<img src="dev/screenshots/approval-mobile.png" alt="Approval card on mobile" />
<p align="center"><i>Scoped memory: personal, per-conversation, and site-wide notes the assistant may use, edited explicitly.</i></p>
<img src="dev/screenshots/memory-editor.png" alt="Scoped memory editor" />
</details>

### Motivation

ERP systems hold the answers people actually need (what's owed, what shipped, what changed) but getting those answers usually means knowing which report to run, which filters to set, or which colleague to interrupt. The obvious fix is a chatbot; the obvious chatbot is a data leak with a smile. We wanted the assistant to live where the work happens, speak through the same permission system humans do, treat every action as a proposal until a person approves it, and let each organization bring its own model provider and pay its own bill. Nothing less belonged inside an ERP.

### Key Features

- **A real chat workspace:** multiple private conversations with search, rename, and archive; paginated history; readable code, tables, and links; a dedicated Desk page plus a contextual drawer beside any record.
- **Bring your own provider:** OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, and administrator-allowlisted custom OpenAI-compatible endpoints. Personal keys stay private; managers can offer shared providers to chosen roles. Models are configured by their real provider model IDs, with no baked-in catalog that ages.
- **Permission-native tools:** the assistant searches and reads only administrator-allowlisted DocTypes through the user's own permissions, and answers financial questions from reviewed ERPNext report adapters (Balance Sheet, Profit &amp; Loss, Cash Flow, Trial Balance, General Ledger, receivables and payables).
- **Explicit approval for every action:** read tools ask too. Write proposals show their target and a before/after diff, and execution rechecks permissions and record revisions, so a stale approval cannot silently authorize a different change.
- **Durable runs:** submitted work lives on the server, not in the browser tab. Close the drawer, come back tomorrow, and pick up the conversation, or the pending approval, exactly where it was.
- **Documents and memory on your terms:** upload PDFs and text files and choose when the assistant may read them; keep personal or per-conversation notes, with site-wide guidance curated by managers. No invisible harvesting.

### Under the Hood

- [Frappe Framework](https://frappe.io/framework): every assistant action runs as the calling user, through Frappe's own permission and document layer. There is no service account with superpowers.
- **Durable execution engine:** runs carry leases, fencing, and recovery sweeps; approvals are atomic decisions; external effects are reconciled when their outcome is uncertain.
- **Stdlib provider adapters:** each provider speaks over pinned, validated TLS with no redirect or proxy following, so credentials and context go exactly where the configuration says and nowhere else.
- **Dependency-free Desk client:** the workspace and drawer are plain JavaScript on Frappe's own design tokens, light and dark, desktop and mobile.

## Getting Started

### Managed hosting

Frappe Intelligence will be available on the Frappe Cloud Marketplace. Self-hosters can install it today:

### Self hosting

**Step 1:** Get the app onto your bench (Frappe v15 or v16, MariaDB):

```bash
bench get-app https://github.com/GreatWharf/frappe-intelligence
```

**Step 2:** Install it on your site and migrate:

```bash
bench --site your-site.local install-app frappe_intelligence
bench --site your-site.local migrate
```

**Step 3:** Assign the **Intelligence User** role to permitted Desk users (Intelligence Manager adds shared-provider and site-memory administration).

**Step 4:** Open **Intelligence** from the Desk sidebar, add a provider with its model ID and your API key, and start a conversation.

A container image for Docker deployments is published as `ghcr.io/greatwharf/frappe-intelligence`; see the [deployment guide](docs/operations.md) for compose, upgrades, backups, and uninstall behavior.

## Compatibility Matrix

CI runs the unit suites on every push and performs a real bench install, migration, and integration pass against a live MariaDB on each supported line.

| Intelligence branch | Frappe | Python | MariaDB |
| --- | --- | --- | --- |
| staging/real-v16 | v15 and v16 | 3.10 – 3.14 | 10.6, 11.8 |

ERPNext is optional for the everyday tools and required for the financial-report adapters. Compatibility targets are not a claim that a live provider matrix has passed; see the [verification record](docs/verification.md).

## Scope and Honest Limits

The assistant can help draft email and explain permitted commerce and accounting records. **Email delivery, refunds, financial posting, and automatic bank reconciliation are not implemented tools.** There is no unrestricted code execution, shell access, generic SQL, or external MCP server. Responses arrive when the provider completes; token-by-token streaming is not implemented. Codex account login is not shipped: a ChatGPT subscription is not treated as an API key.

Provider calls disclose the approved context to that provider; data does not remain exclusively on your server when a remote model is used. It is unofficial and has not yet been published to the Frappe Marketplace.

## Documentation

- [Installation, upgrades and operations](docs/operations.md)
- [Security and data boundaries](docs/security.md)
- [Providers and authentication](docs/providers.md)
- [Business tools and the extension contract](docs/tools.md)
- [Testing and verification](docs/verification.md)

Provider keys, chat exports, bank statements, and customer data must never be attached to public bug reports.

## License

MIT. See [LICENSE](LICENSE).
