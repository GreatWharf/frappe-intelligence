# Installation, upgrades and operations

## Deployment status and prerequisites

This source tree is an implementation candidate, not a published Marketplace listing. It targets Frappe v15/v16 on MariaDB with Python 3.10–3.14 as supported by the exact Frappe release; Frappe v16 requires Python 3.14. Financial-report tools additionally require a matching ERPNext installation. Verify the real integration workflow on the exact stack before production use.

The app needs a scheduler and a worker consuming the `long` queue. It uses ordinary Frappe/RQ jobs, not an independently exposed agent daemon. Application assets are local; there are no CDN scripts. The only additional Python runtime package is `pypdf`; provider HTTP and the deliberately restricted tool-schema validator use the standard library.

## Frappe Cloud versus self-hosting

After a Marketplace release is actually approved, Cloud customers install it from their site's Apps dashboard. Private benches first add/deploy the app to their bench. Frappe runs its normal app installation and migration lifecycle; customers should not run custom SQL, `bench execute` repair functions, or manual command bundles.

Publishing a source tag does not update installed customer sites. Use Cloud's managed update/deploy flow; it performs the necessary lifecycle work. This app registers `before_install`, `after_install`, `after_migrate` and scheduler hooks. A fresh installation creates roles, bounded default policy and an Intelligence workspace. Later migrations preserve administrator policy, add needed indexes and restore a missing navigation entry without overwriting existing workspace customizations.

For a self-hosted development bench, add this checkout using your Bench version's local-app support:

```sh
bench get-app --soft-link /absolute/path/to/frappe-intelligence
bench --site test.localhost install-app frappe_intelligence
bench --site test.localhost migrate
bench build --app frappe_intelligence
```

For a repository-backed deployment, use your real repository URL and a reviewed immutable release/commit rather than a moving example URL. No public repository has been created by this implementation task.

In Docker, code/dependencies/assets belong in the image build; installing/migrating the persistent site belongs in one serialized deployment initializer after database/Redis readiness. Do not run site migrations in every worker or web entrypoint. Use the same image for workers, scheduler and web services.

`docker/compose.yaml` ships the compose template the Dokploy stack deploys, and it self-heals two fresh-deploy failure modes: `intelligence-init` is ordered after `create-site` with `condition: service_completed_successfully` and `required: false` (a first-ever deploy waits for site creation instead of failing init's existence guard, while `CREATE_SITE=0` deploys do not hang), and the `frontend` service re-links `sites/assets/frappe_intelligence` at the image-side `apps/frappe_intelligence/frappe_intelligence/public` on every start before exec'ing `nginx-entrypoint.sh`, so a stale or dangling entry in the mounted sites volume cannot 404 the Desk bundle.

## Initial configuration

1. As System Manager, open **Intelligence Settings**. Review enabled tools, readable DocTypes, allowed reports, quotas, approval expiry and attachment limits.
2. Assign **Intelligence User** to selected enabled System Users. **Intelligence Manager** additionally manages shared providers and site-wide memory. System Managers can use and configure Intelligence by default. Website users and Guest are excluded.
3. Open **Intelligence → Providers & models**. Add the provider's actual model ID and API key. API keys stay encrypted server-side. A blank key when editing preserves the existing credential.
4. Shared providers require manager authority and can be restricted to named roles. Omitting a policy field during an update preserves it; explicitly clearing allowed roles makes a shared provider available to all otherwise eligible Intelligence users.
5. Custom providers require an exact public HTTPS hostname in `allowed_custom_hosts`. No wildcard, redirect, private IP, URL credential, query-string secret or HTTP endpoint is accepted. The endpoint must implement the supported chat-completion/tool protocol.
6. Start a private conversation and test with synthetic non-sensitive records. Every read/action tool requires a separate explicit approval.

Once a provider is referenced by conversation history, create a new provider record to change its vendor, endpoint or model. This avoids silently disclosing existing history to another destination. Credentials can still be rotated; disabled providers stop new execution but do not erase history.

## Background execution

Submitting a message creates a durable Run and queues work after the database commit. Closing the page/drawer does not cancel that run. The UI subscribes to user-scoped status events and polls authorized state as a reconnect fallback.

When a model proposes tools, the run persists approval cards and enters `awaiting_approval`; it does not hold a worker or database transaction while a person decides. Approving or denying queues the next step. Permission, identity, expiry, arguments and record revision are rechecked before execution. Tool output reaches the model only after the corresponding read is approved.

Cancel prevents further work, but cannot undo a committed mutation. An already running HTTP request may finish before the cancellation check; usage already incurred remains billable. Replies appear after the provider completes; this implementation does not stream individual model tokens.

The recovery scheduler runs every two minutes. It repairs missed queue delivery, fences expired workers, expires approvals and terminates runs whose users/providers are no longer authorized. Active-time limits exclude time spent waiting for human approval. An uncertain external action becomes `needs_reconciliation` and is never automatically repeated.

## Updates and backups

Back up the database, private files and **site encryption key**. Stop or drain active work before an upgrade. Update the app through your host's deployment process, run the normal site migration, rebuild assets if required, and restart services using your process supervisor.

Self-hosted example:

```sh
bench --site your-site.local backup --with-files
bench --site your-site.local migrate
bench build --app frappe_intelligence
bench restart
```

Do not replace an existing deployment's backup, maintenance or restart procedure with this example. Cloud manages these lifecycle operations through its dashboard. Never copy a production encryption key or provider credential into CI.

## Troubleshooting

- **No launcher/drawer:** verify the user is an enabled System User with an Intelligence role, migrate/build the app, clear Desk cache and reload.
- **Queued indefinitely:** inspect scheduler/long-worker health and the site's Background Jobs. Do not manually repeat an already approved action.
- **Awaiting approval:** open the conversation's approval card. Waiting is intentional and does not consume a worker.
- **Provider failure:** check the configured model, credential, provider quota, allowed host and model tool support. Errors intentionally omit raw provider bodies and keys.
- **Stale approval:** the target changed. Read it again and obtain a new proposal; do not edit the saved approval arguments.
- **Report refused:** verify the allowed report, Company permission and supported filters. Aggregates with additional non-Company User Permissions are refused rather than returning potentially broader data.
- **Attachment refused:** use private UTF-8 files or text PDFs within configured size/page/time limits. Encrypted/scanned PDFs are not decrypted or OCRed.
- **Uncertain execution:** review the execution record and affected external system before any manual retry. Do not clear the status merely to make the agent continue.

The application does not provide an admin button to reveal someone else's personal provider key. Native password retrieval is guarded at the provider controller too.

## Retention and uninstall

Archive hides a conversation from the active list; it does **not** erase stored messages, attachments or audit records. Explicit memories can be edited/deleted. This first implementation does not include an automated retention/purge scheduler or a complete data-export/delete workflow; establish a reviewed administrator retention procedure before storing regulated data.

Cancel or finish queued/running/awaiting-approval runs before uninstalling; the uninstall hook refuses active work. Export required history and back up first. Frappe's uninstall process, not this app, owns removal of application DocTypes. Do not delete unrelated business documents or Bank Transactions when removing Intelligence.
