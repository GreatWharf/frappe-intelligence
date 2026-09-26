# Implementation verification

## Executed locally - 16 September 2026

Validation used Python 3.14, Node 24, jsdom 26.1.0 and Playwright 1.57.0/Chromium 143. All application/provider/business responses in automated tests were synthetic. No customer credentials, live model calls or ERP records were used.

| Check | Result |
| --- | --- |
| Offline Python suite | **286 passed**, including provider protocol/network, actual run state machine, permissions, service boundaries, PDF parsing and package metadata |
| Dependency-free UI behavior suite | **31 passed** |
| Same UI behavior suite against jsdom | **31 passed** |
| Actual Chromium flow suite | Passed against the explicitly mocked preview host |
| Ruff lint and formatting | Passed |
| Python 3.10 grammar check | Passed; not an actual Python 3.10 runtime run |
| Wheel and source archive | Built; all 59 runtime resources present |

The Chromium flow covers workspace/provider editing, scoped memory, approval/denial, rename/archive, contextual drawer, close/reopen completion, reconnect, keyboard interactions and phone-width layouts. It asserts no unexpected external requests or page errors. Desktop, dark-mode and mobile screenshots were inspected under `dev/screenshots/`.

A separate native-layout browser check verifies the simplified page hierarchy, neutral theme colors, no colored mouse-focus halo, equal-width Provider/Model ID fields with matching heights, and stacked phone-width controls. The app reuses Desk's `btn`, `form-control`, and theme-token conventions rather than adding shadcn/React to the Desk page.

The preview is **not a running ERPNext site**. Its banner explicitly identifies fictional fixtures, and it must not be presented as proof of a live integration or real accounting result.

## Reproductions fixed during review

- Context-free workspace submissions were rejected at the API/engine boundary; absent context now reaches the engine correctly, with facade-to-real-engine regressions.
- Provider edits could reset omitted shared-role restrictions and limits; omission now preserves policy while intentional clears remain explicit.
- Native `frappe.client.get_password` could bypass app-facade ownership checks; the provider controller now guards decryption and only permits a scoped server-side shared-use grant.
- Ordinary MariaDB snapshot reads could defeat active-run/quota serialization; admission now uses current locking reads, and stale/superseded workers cannot clear newer run state.
- Frappe permission hooks receive `ptype`, not the previous unused keyword; native-dispatch tests now exercise that contract.
- Uploaded files and older messages were durable on the server but inaccessible after reload/pagination; the UI now exposes saved-file reuse and earlier-history loading.
- Upload and extraction limits differed; both now share one effective size policy.
- A real-browser memory save could lose focus and make Escape ineffective; modal work now restores focus. v16 `/desk` links and viewport-height mobile preview behavior are also covered.

## Reproduce offline and frontend checks

From an isolated development environment, with dependency installation authorized:

```sh
python -m pip install -e '.[test]'
python -m pytest -q
ruff check .
ruff format --check .
npm ci
npm test
npm run test:dom
npx playwright install chromium
npm run test:browser
python -m build
python scripts/check_dist.py
```

Use a clean `dist` directory for the archive checker. Browser screenshots are local development outputs, excluded from package/runtime assets and from Git by default.

For the local mock preview:

```sh
npm run preview
```

The default preview URL is printed by the server. It does not connect to Frappe or a model provider. Never use real provider keys in this fixture UI.

## Real-site integration tests provided, not executed here

The real Frappe test module includes six cases exercising:

1. Native API/engine persistence, history, and safe realtime envelopes.
2. Actual ToDo read approvals, receipts and replay behavior.
3. Owner isolation and native managed-document write guards.
4. The real native password RPC and scoped shared-provider usage.
5. Two independent MariaDB connections with a deliberately stale REPEATABLE READ snapshot, checking active-run serialization.
6. The corresponding cross-conversation daily-quota case.

Run only on a disposable site with `allow_tests` enabled:

```sh
bench --site test.localhost run-tests --app frappe_intelligence \
  --module frappe_intelligence.tests.test_integration
```

These tests commit unique synthetic fixture baselines to make independent-connection checks possible, then perform exact cleanup and restore settings. They are not appropriate for a production site, even if it has a similarly named test account.

The repository includes CI definitions for Python 3.10/3.12/3.14 and MariaDB-backed Frappe/ERPNext v15/v16 installation/migration/integration. As of 18 September 2026 those workflows run green on every push to `staging/real-v16`, including the real bench install and integration pass.

## Live fleet verification, 18 September 2026

Image `ghcr.io/greatwharf/frappe-intelligence:0.3.2` (commit `8fedcdf`) was deployed to a disposable ERPNext v16 test site seeded with two demo companies (Acme Inc., USD; Acme Limited, GBP). Twelve autonomous end-to-end scenarios then drove the assistant through the real UI and API, and every claim was verified over REST against the live ERP state afterwards, never against the assistant's own words. **All 12 scenarios passed, 72/72 checks.** Captures are in [screenshots/](screenshots/).

| Scenario | Checks | Result |
| --- | --- | --- |
| Invoice ingestion: Northwind USD bill, Harbor USD bill, Stark GBP bill | 9 + 9 + 9 | draft Purchase Invoices ACC-PINV-2026-00007/8/9 match supplier, company, currency, totals, due dates |
| Email reply to an invoice query | 6/6 | draft Communication created and linked; chat summarizes instead of pasting; nothing sent |
| ToDo lifecycle | 6/6 | created, closed, linked by title |
| Bank reconciliation | 10/10 | proposals with reasoning, then four draft Payment Entries (ACC-PAY-2026-00001..00004) created through approval cards; all remain drafts |
| Accounting summary, currency handling | 3/3 + 4/4 | figures cite reviewed report adapters and the recorded 0.79 USD-GBP rate |
| Out-of-scope bank transfer | 3/3 | refused; no Journal Entry or Payment Entry created |
| Skill self-creation, preference learning, morning briefing | 4/4 + 3/3 + 6/6 | skills saved disabled until reviewed; preferences persist and shape later answers; briefing covers both companies with dated figures |

Every write in these runs went through an approval card; the assistant holds no service-account privileges.

## Live verification of 0.5.0, 18 September 2026

Image `ghcr.io/greatwharf/frappe-intelligence:0.5.0` (tag `v0.5.0`, commit `2df801a`) was deployed to the same disposable ERPNext v16 site and driven through a real Chromium session. Verified end to end: a single "Intelligence" entry on the apps screen and in the Desk sidebar, same-tab navigation into `/desk/intelligence`, the composer pinned to the viewport at desktop and phone widths, the inline provider picker, approval cards with **Always allow** (the standing grant auto-approved the repeat search in the follow-up run with zero further prompts), collapsed tool groups with narration between steps, and an AI-generated conversation title ("Unpaid Sales Invoices Overview") replacing the placeholder after the first reply. Captures: [screenshots/approval-waiting.png](screenshots/approval-waiting.png), [screenshots/conversation-answer.png](screenshots/conversation-answer.png), [screenshots/follow-up-answer.png](screenshots/follow-up-answer.png).

## Live verification of 0.6.0, 19 September 2026

Image `ghcr.io/greatwharf/frappe-intelligence:0.6.0` (commit `eb3bf46`) was deployed to the same disposable ERPNext v16 site. Local gates before the push: **688 Python tests**, **135 dependency-free UI tests** in both DOM modes, three Chromium suites against the mocked preview, ruff lint and formatting, all green; GitHub Actions ran green on the same tree (unit, browser, real-Frappe integration, image build).

After the deploy, **26/26 REST checks passed** against the running site: login; bootstrap and the 14-field settings policy with no secret fields; the 0.6.0 schema on Intelligence Run (`model`), Intelligence Tool Grant (`scope`, `conversation`) and the full Intelligence Policy matrix; both seeded example policies present, disabled, with their template reasons; `list_grants`; the new `revoke_grant` input guard answering "Invalid request data." to a non-string name (proving the 0.6.0 API, not a stale build); the seven-link sidebar plus empty module sentinel; global-search registration; and all eleven advertised assets resolving, with `panel.js` carrying the drawer markup.

A real Chromium session then drove the live UI: the floating button docked the panel over the Desk home with the welcome state, pickers and approval-mode caption visible, and a fresh run ("List the first five Customer records") narrated its plan, showed the approval card under Approve Every Step, was approved once, and settled with the collapsed "Used 2 tools" group and the answer table. Captures: [screenshots/panel-docked.png](screenshots/panel-docked.png), [screenshots/narration-tool-rows.png](screenshots/narration-tool-rows.png).

One verification lesson is recorded for future deploys: the version endpoint reports the new release as soon as the web container serves it, while `bench migrate` (which creates the new tables and seeds the example policies) can still be running. A readiness check must wait for a migrate-completed signal, such as the seeded policies being countable, not just for the version string; the first check run raced the migrate and the second passed 26/26 unchanged.

## Live verification of 0.7.4, 23 September 2026

Image `ghcr.io/greatwharf/frappe-intelligence:0.7.4` (tag `v0.7.4`, commit `4fc0523`) was deployed to the same disposable ERPNext v16 site. Local gates before the push: **713 Python tests**, **165 dependency-free UI tests in both DOM modes**, ruff lint and formatting, all green; GitHub Actions ran green on the same tree (unit, browser, image build).

0.7.4 folds recent conversations into the native Desk sidebar as a collapsible "Recent chats" section built from the exact markup frappe renders for workspace rows, placed after the Conversations link and capped at eight rows. It also fixes two regressions the live checks caught: a custom-panel-era CSS rule that hid the whole workspace nav while the app was open (`body-sidebar-top`, now guarded by tests/test_desk_chrome.py), and the section not returning after frappe rebuilt the sidebar without a router event (now re-injected by a MutationObserver).

After the deploy, **24/24 browser checks passed** in a real Chromium session: login and asset resolution; the section appearing on `/desk/intelligence` with native section-item markup, the native header label, placement after Conversations, between one and eight indented rows linking at chat routes and mirroring the API order and titles; clicking a row opening the conversation with the row marked active and the title matching; collapse toggling, persisting to the native `section-breaks-state` bucket and surviving a reload; a REST rename flowing through `App.refreshList` into the sidebar live; and the section staying out of other workspaces while remaining on the Conversations list sidebar. Captures: [screenshots/welcome.png](screenshots/welcome.png), [screenshots/desk-sidebar.png](screenshots/desk-sidebar.png).

## Live verification of 0.8.2, 26 September 2026

Image `ghcr.io/greatwharf/frappe-intelligence:0.8.2` (tag `v0.8.2`, commit `41d3847`) was deployed to the same disposable ERPNext v16 site. Local gates before the push: **821 Python tests**, **127 dependency-free UI tests in both DOM modes**, ruff lint and formatting, the mocked Chromium suites, all green; GitHub Actions ran green on the same tree, including the real Frappe v15 and v16 install/migrate jobs.

0.8.x is the native-management release: the in-app settings dialogs are gone and every record type (providers, skills, memories, tool grants, settings) is managed on its native Desk form or list, linked from a sidebar whose rows now carry distinct icons under an Administration section, with a Getting Started onboarding panel pinned at the bottom. Conversation titles are generated with a strict prompt and validated so assistant replies can never become titles, output token limits rise to a 16384 default and 262144 ceiling, and memories embed for semantic recall where a provider offers embeddings.

After the deploy, **47/47 live checks passed** (one memory-embedding check skipped: the site's provider exposes no embeddings endpoint, and the recency fallback was verified instead): the converged sidebar with per-row icons and the nested Administration group; the seeded onboarding record and its pinned Getting Started link; a native `frappe.client.save` raising a provider's max_tokens (the 0.7.x complaint) succeeding while a kind change is refused with 403; the provider form hiding the stored key and offering Fetch models; the settings form rendering chip editors and the RAG status banner; the chat header holding one row with no menu and a state-only subtitle; the Desk document never growing a second scrollbar; and two end-to-end runs on the `muse-spark-1.3` model from the provider catalog: a receivables question driven through four approval rounds to completion with the generated title "Top three Acme Inc accounts receivable customers" replacing the placeholder, and a supplier-invoice attachment read and proposed as drafts behind three approval cards. Captures: [screenshots/welcome.png](screenshots/welcome.png), [screenshots/desk-sidebar.png](screenshots/desk-sidebar.png).

One verification lesson is recorded for future deploys: the asset marker flips as soon as the web container serves the new build, while `bench migrate` (sidebar convergence, onboarding and skill seeds) can still be running, and leftover seed counts from older releases can satisfy a lax readiness gate. Readiness must assert a release-specific seeded record, such as the Module Onboarding row or an icon on the Chat sidebar row; the first 0.8.2 check run raced the migrate and the strict rerun passed unchanged.

## Remaining validation boundaries

- Actual Frappe/ERPNext install, migration, native permission dispatch and RQ/realtime behavior on the target site.
- The live two-connection database tests above.
- Real provider model IDs, credentials, tool support, rate limits and billing.
- Real financial-report output under customer-specific roles/User Permissions and installed hooks.
- Full backup/restore, retention/export/erasure, concurrency/load and host-specific deployment acceptance.
- Marketplace review, commercial plan enforcement and external MCP transports are not implemented or certified by these results.

The correct status is **an implementation candidate with substantial offline/browser validation**, not a production-certified or Marketplace-approved release.
