# Changelog

All notable changes to Intelligence are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app versions with [Semantic Versioning](https://semver.org/).

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
