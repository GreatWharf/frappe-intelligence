# Implementation verification

## Executed locally — 16 September 2026

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

The repository includes CI definitions for Python 3.10/3.12/3.14 and MariaDB-backed Frappe/ERPNext v15/v16 installation/migration/integration. **Those workflows have not run for this new app:** no GitHub repository has been created or pushed during implementation. A workflow file is not a passing result.

## Remaining validation boundaries

- Actual Frappe/ERPNext install, migration, native permission dispatch and RQ/realtime behavior on the target site.
- The live two-connection database tests above.
- Real provider model IDs, credentials, tool support, rate limits and billing.
- Real financial-report output under customer-specific roles/User Permissions and installed hooks.
- Full backup/restore, retention/export/erasure, concurrency/load and host-specific deployment acceptance.
- Marketplace review, commercial plan enforcement, Codex account login and external MCP are not implemented or certified by these results.

The correct status is **an implementation candidate with substantial offline/browser validation**, not a production-certified or Marketplace-approved release.
