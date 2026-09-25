# Changelog

All notable changes to Intelligence are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app versions with [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-09-25

### Added

- Getting Started onboarding: a native Module Onboarding panel pinned at the bottom of the Intelligence sidebar walks new users through adding a provider, the first chat, the first memory, and the seeded skills.
- Six new seeded skills: create-skill (the assistant drafts and proposes new skills for repeated workflows), month-end-close, overdue-receivables-followup, purchase-invoice-audit, supplier-statement-reconciliation, and cash-position-watch, alongside the original six playbooks. Every seeded write stays a draft behind explicit approval.
- Semantic memory recall: memories are embedded through a capable configured provider on save and recall_memory accepts an optional query, ranking only the memories visible to the recaller by similarity. Sites without an embeddings-capable provider keep the exact recency behavior, and recall still passes the explicit approval flow.
- Native provider management on the Desk form: owners (and managers for shared providers) can edit operational fields (title, output token limit, timeout, thinking effort, enabled, model catalog) directly, rotate the API key through a dedicated endpoint that never reads it back, and fetch the provider's model catalog from the form.
- Per-model reasoning efforts: fetching models from providers that advertise reasoning support (OpenRouter-style supported parameters) records each model's effort set, and the thinking effort picker narrows to what the selected model actually supports.
- Chip editors with autocomplete on the native Settings and Skill forms for the scoped doctype, tool, report, and host lists, replacing the raw text blobs; the Settings form also groups fields into Assistant, Limits, and Scope and Tools sections and shows a live context-retrieval (RAG) status banner.

### Changed

- Output token limits: the per-reply default rises from 4096 to 16384 and the ceiling from 32768 to 262144 across provider, settings, and runtime validation, so long-form models are no longer capped at a 4k reply.
- Conversation titles are generated with a strict internal prompt and validated before landing: greetings, questions, and assistant-style replies (for example "Hi there, how can I help you today?") are rejected and the first-message placeholder stays instead. Titles cap at 100 characters.
- The chat header is one quiet row: the three-dot menu and its in-app provider/memory/skills/scope/settings dialogs are gone (management lives on the native Desk pages linked from the sidebar), the provider/model/effort subtitle is removed, and the remaining actions stay on a single line with the title truncating instead of wrapping, in the page and in the drawer down to its 360px minimum.
- The Intelligence sidebar rows carry distinct icons (chat, conversations, grants, providers, skills, memory, settings) grouped under an Administration section instead of one repeated glyph.
- The chat page pins itself to the remaining viewport height so only the message thread scrolls; the Desk document no longer grows a second scrollbar that carried the header away.

## [0.6.0] - 2026-09-19

### Added

- Docked panel over any Desk screen: Ctrl/Cmd+I (or the floating button) opens the assistant beside the record you're viewing with that record's context attached explicitly, never scraped. Drag the edge to resize, Esc to close, and one click hands off to the full Desk page; width and open state persist.
- Approval policies: manager-maintained Intelligence Policy rows require approval, auto-approve, or deny by tool, DocType, operation, role, and amount threshold with currency, evaluated by priority then specificity. Two disabled examples ship as templates; a deny shows its reason to the user and fires before the built-in exemptions.
- Standing grants: an approval can hold once, for the rest of the conversation, or always, per tool and optionally per DocType. Grants are listed under Intelligence Tool Grant and revocable at any time.
- Bulk approvals: a run queuing several proposals shows one grouped card with per-row decisions or approve-all/deny-all, plus an optional remember-for-this-conversation grant per tool.
- Narration and collapsible tool rows: the assistant says what it's doing and why before each step, and every tool call collapses to a one-line row that expands to the full input and result.
- One-off model picks: the composer's inline provider and model pickers can override the provider default for a single message, validated against the provider's configured catalog.

### Changed

- Approval resolution order is now standing grant (conversation tier first, then always), then policy matrix, then the built-in exemptions, then the site approval mode. Auto-approvals record their source (grant or policy) on the same durable proposal a human would answer and pass the same execution rechecks.
- The conversation surface restyles around right-aligned user bubbles and a rounded composer with an attachment clip, matching current Desk conventions.

## [0.2.0] - 2026-09-17

### Added

- Adaptive data-model tools: the assistant can list, describe, and query administrator-allowlisted DocTypes, and can draft document create and update proposals that execute only after explicit approval.
- Skills view in the Intelligence workspace, showing the tools and capabilities available to the assistant under the current configuration.
- Scope configuration, letting administrators control which DocTypes and capabilities the assistant may reach.
- Approval queue, so pending proposals can be reviewed, approved, or rejected from one place with their before/after diffs.

### Fixed

- Provider-kind handling: configured providers now resolve to the correct adapter kind instead of misclassifying custom OpenAI-compatible endpoints.
- Deploy hardening: site initialization now force-links `sites/assets/<app>` so stale or dangling symlinks from a previous container generation can no longer leave the Desk serving 404s for app assets, and every advertised asset path is verified after the build.
