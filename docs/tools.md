# Governed business tools

The model sees only enabled, reviewed tool schemas. It cannot choose a Python function or bypass approval by naming a Frappe method. All reads and writes are separately approved; the executor rechecks access immediately before execution.

## Built-ins

- `search_records`: configured DocTypes, permission-aware queries, per-record/company rechecks, at most 50 rows and permitted scalar fields.
- `read_document`: allowed scalar fields and native document/field permissions; credential fields and child-table dumps are excluded.
- `run_report`: reviewed ERPNext report names and closed company-safe filters; at most 200 result rows, no chart/summary disclosure, prepared reports or custom report execution. Non-Company User Permissions cause refusal when aggregate isolation cannot be established.
- `read_attachment`: a private file attached to this conversation, approved before any content is disclosed. Supports UTF-8 TXT/Markdown/CSV/JSON and text PDFs, effective size limit 1–20 MiB, 50 PDF pages and bounded extraction time/characters. JSON is plain text, never executed.
- `create_todo`: personal, self-assigned, unlinked ToDo.
- `update_todo`: exact expected revision, allowed fields, native permissions/validation; linked ToDos are rejected because their hooks can update referenced records.
- `update_event`: exact expected revision and allowed fields; participant-linked and Google-synchronized events are rejected. No invitations or external calendar synchronization are promised.
- `edit_wiki_page`: optional Wiki v3 `Wiki Document` content edits when Wiki is installed and that DocType is allowed. Existing leaf content only; no publication, movement or permission changes.
- `recall_memory`: approved scoped personal/conversation/site recall.
- `save_memory`: approved new note; site scope requires a manager. Editing/deleting existing notes is explicit UI administration.

Email can be drafted in chat and permitted Communication records can be read, but no send-email tool exists. Commerce records can be inspected when allowed; refunds, fulfillment, stock moves, financial posting and automatic reconciliation are not exposed.

## Report filters

| Reports | Accepted filters |
| --- | --- |
| Trial Balance | company, fiscal_year, from_date, to_date |
| General Ledger | company, from_date, to_date |
| Accounts Receivable / Accounts Payable | company, report_date |
| Balance Sheet / Profit and Loss Statement / Cash Flow | company, period_start_date, period_end_date, optional periodicity |

Unknown filters are rejected. Use native ERPNext reports for accounting calculations; the model explains results but does not become the ledger.

## Reviewed app extensions

An installed app can declare this hook in its own `hooks.py`:

```python
intelligence_tools = ["your_app.intelligence.register_tools"]
```

The factory receives a `Registry`. Construct a `ToolSpec` from `frappe_intelligence.tools` with `name`, `description`, closed `parameters` schema, `preview`, `execute`, `mutates`, and a non-empty `version`, then register it explicitly:

```python
registry.register(
    spec,
    reviewed=True,
    transaction_safe=True,
    roles=("Your Business Role",),
)
```

These flags are an assertion that the extension has been reviewed, **not a sandbox or an automated audit**. Its name must also be enabled in Intelligence Settings. Duplicate names, unknown hooks, unsupported schema constructs and external extension actions are rejected.

`preview(context, arguments)` returns a human-only JSON preview without changing business data. `execute(context, arguments)` runs only after engine approval and must independently validate current permissions/revisions. Neither function may commit, change execution identity, silently disclose unrelated records, perform unrestricted network requests or use `ignore_permissions` on business data. Inspect the target DocType's hooks for side effects, too.

Tool context binds site, user, conversation and run. Input validation is a tested fail-closed subset of JSON Schema for closed objects/scalars/arrays, enums, bounded ranges/formats and `anyOf`. References, open schemas and unsupported keywords are rejected rather than ignored. The engine owns approval receipts, transaction boundaries, cancellation and retry policy.

An external MCP server is not supplied. A future authenticated MCP transport must reuse this registry and the same server-side approvals/permissions; exposing all installed methods is not an acceptable substitute.
