<p align="center">
  <img src="frappe_intelligence/public/images/intelligence.svg" alt="Intelligence logo" height="80" />
</p>

<h1 align="center">Intelligence</h1>

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

## Intelligence

Intelligence brings a ChatGPT-class assistant into Frappe and ERPNext without handing your data, or your judgment, to a black box. It answers questions about the records a user is already allowed to see, reads the reports finance teams actually run, works with uploaded documents, remembers only what it's told to remember, and asks before it touches anything.

<details>
<summary><b>Screenshots</b></summary>
<br />
<p align="center"><i>The workspace: multiple private conversations, provider and model selection, and a pending approval with a full before/after diff.</i></p>
<img src="dev/screenshots/workspace-approval-desktop.png" alt="Workspace with approval card" />
<p align="center"><i>The docked panel: Ctrl/Cmd+I over any Desk screen, aware of the record you're looking at, included explicitly, never scraped.</i></p>
<img src="dev/screenshots/panel-drawer-context.png" alt="Docked panel open over a Desk record with the record context chip" />
<p align="center"><i>Approvals at scale: policies auto-approve within the rules managers set, and a queue of pending requests clears in one decision.</i></p>
<img src="dev/screenshots/approval-bulk-desktop.png" alt="A batch of pending approvals being decided together" />
<img src="dev/screenshots/auto-approved-row.png" alt="A tool call auto-approved by policy, recorded in the audit trail" />
<p align="center"><i>A one-off model pick for a single message, straight from the composer.</i></p>
<img src="dev/screenshots/composer-model-picked.png" alt="Composer with a one-off model override selected" />
<p align="center"><i>Approvals hold up in the dark and on the phone; work survives closing the window.</i></p>
<img src="dev/screenshots/workspace-approval-dark.png" alt="Workspace approval in dark mode" />
<img src="dev/screenshots/approval-mobile.png" alt="Approval card on mobile" />
<p align="center"><i>Scoped memory: personal, per-conversation, and site-wide notes the assistant may use, edited explicitly.</i></p>
<img src="dev/screenshots/memory-editor.png" alt="Scoped memory editor" />
</details>

### Motivation

ERP systems hold the answers people actually need (what's owed, what shipped, what changed) but getting those answers usually means knowing which report to run, which filters to set, or which colleague to interrupt. The obvious fix is a chatbot; the obvious chatbot is a data leak with a smile. We wanted the assistant to live where the work happens, speak through the same permission system humans do, treat every action as a proposal until a person approves it, and let each organization bring its own model provider and pay its own bill. Nothing less belonged inside an ERP.

### Key Features

- **A real chat workspace:** multiple private conversations with search, rename, and archive; automatic titles from the first message; optional read-only sharing with colleagues; paginated history; readable code, tables, and links; a dedicated Desk page plus a docked panel beside any record.
- **A panel docked over Desk:** press Ctrl/Cmd+I (or the floating button) and the assistant docks at the right edge of any Desk screen, already holding the context of the record you're looking at. Drag the edge to widen it, Esc to close it, and hand off to the full page when you need the room. The width you leave it at is the width you find it at.
- **Watch it work, not just answer:** before each step the assistant says what it's doing and why, and every tool call collapses into a one-line row you can expand for the full input and result.
- **Bring your own provider:** OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, and administrator-allowlisted custom OpenAI-compatible endpoints. Personal keys stay private; managers can offer shared providers to chosen roles. Models are configured by their real provider model IDs, with no baked-in catalog that ages, and the composer can override the provider default for a single message.
- **Permission-native tools:** the assistant searches and reads only administrator-allowlisted DocTypes through the user's own permissions, and answers financial questions from reviewed ERPNext report adapters (Balance Sheet, Profit &amp; Loss, Cash Flow, Trial Balance, General Ledger, receivables and payables).
- **Approvals that scale past the first invoice:** every action still asks, by default, but the answer no longer has to be one click per step. Approval policies let managers require approval, auto-approve, or deny by tool, DocType, operation, role, and amount threshold; an approval can be granted once, for the whole conversation, or always; and a queue of pending requests can be decided together. Three site-wide modes still choose between approving every step, approving writes only, or full automation. Write proposals show their target and a before/after diff, execution rechecks permissions and record revisions so a stale approval cannot silently authorize a different change, and human and policy decisions share one audit trail.
- **Durable runs:** submitted work lives on the server, not in the browser tab. Close the panel, come back tomorrow, and pick up the conversation, or the pending approval, exactly where it was.
- **Documents and memory on your terms:** upload PDFs and text files and choose when the assistant may read them; keep personal or per-conversation notes, with site-wide guidance curated by managers. No invisible harvesting.

### See It Working

Captured from a live ERPNext v16 site running the flows recorded in [the verification record](docs/verification.md).

| Docked over any Desk screen, one shortcut away | Narration and collapsible tool rows |
| --- | --- |
| ![The docked panel over the Desk home, with the composer and its provider and model pickers](docs/screenshots/panel-docked.png) | ![A run narrating its steps, with a collapsed tool group and a data table](docs/screenshots/narration-tool-rows.png) |

| Welcome, personalized by name and time | Bring your own provider |
| --- | --- |
| ![Welcome screen](docs/screenshots/welcome.png) | ![Providers and models](docs/screenshots/providers.png) |

| Intelligence in the Desk sidebar | An uploaded bill becomes a draft invoice |
| --- | --- |
| ![Desk sidebar](docs/screenshots/desk-sidebar.png) | ![Invoice ingestion](docs/screenshots/invoice-ingest.png) |

| Reconciliation proposals with reasoning | Draft Payment Entries created on approval |
| --- | --- |
| ![Proposals](docs/screenshots/bank-reconcile-propose.png) | ![Draft payments](docs/screenshots/bank-reconcile-drafts.png) |

| A drafted reply in chat, summarized | The draft Communication it created |
| --- | --- |
| ![Draft reply in chat](docs/screenshots/email-draft-chat.png) | ![Communication draft](docs/screenshots/erp-email-draft.png) |

| The four draft Payment Entries in ERPNext | The Northwind draft Purchase Invoice |
| --- | --- |
| ![Payment Entries](docs/screenshots/erp-payment-entries.png) | ![Purchase Invoice](docs/screenshots/erp-purchase-invoice.png) |

| A dated morning briefing | Skills the assistant wrote |
| --- | --- |
| ![Daily briefing](docs/screenshots/daily-briefing.png) | ![Skills](docs/screenshots/skills.png) |

| User-controlled memory | An approved tool action with record links |
| --- | --- |
| ![Memory](docs/screenshots/memory.png) | ![Approved search tool and linked records](docs/screenshots/conversation-answer.png) |

| Approvals pause the run, not your day | Follow-ups keep the context |
| --- | --- |
| ![Approval card waiting for a decision](docs/screenshots/approval-waiting.png) | ![Follow-up answer grouping invoices by customer](docs/screenshots/follow-up-answer.png) |

Recorded sessions: [welcome tour](docs/screenshots/welcome-tour.webm) and [bank reconciliation end to end](docs/screenshots/bank-reconciliation.webm).

### Under the Hood

- [Frappe Framework](https://frappe.io/framework): every assistant action runs as the calling user, through Frappe's own permission and document layer. There is no service account with superpowers.
- **Durable execution engine:** runs carry leases, fencing, and recovery sweeps; approvals are atomic decisions; external effects are reconciled when their outcome is uncertain.
- **Stdlib provider adapters:** each provider speaks over pinned, validated TLS with no redirect or proxy following, so credentials and context go exactly where the configuration says and nowhere else.
- **Dependency-free Desk client:** the workspace and drawer are plain JavaScript on Frappe's own design tokens, light and dark, desktop and mobile.

## Getting Started

### Managed hosting

Intelligence will be available on the Frappe Cloud Marketplace. Self-hosters can install it today:

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

The assistant can draft email replies, draft purchase invoices, and prepare reconciliation proposals as draft Payment Entries, each behind an explicit approval. **Email delivery, refunds, and financial posting are not implemented:** documents the assistant creates stay drafts, and a person submits or sends them. There is no unrestricted code execution, shell access, generic SQL, or external MCP server. Responses arrive when the provider completes; token-by-token streaming is not implemented. Codex account login is not shipped: a ChatGPT subscription is not treated as an API key.

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
