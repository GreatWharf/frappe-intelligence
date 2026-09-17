# Docker build and site initialization

Scope of this directory: `docker/Dockerfile` builds the application image
(code + editable install + verified dependency + best-effort asset stash);
`docker/site-init.sh` is the one-shot deployment step that installs,
migrates and repairs assets for **one already-existing site**. Neither file
creates, drops or reconfigures a site's credentials. See
[`docs/operations.md`](../docs/operations.md) for the general Frappe/Docker
lifecycle this fits into.

This project builds and remote-tests against **ERPNext v16 only**, using the
official images published by the Frappe team on **Docker Hub**
(`docker.io/frappe/erpnext`). Never substitute a `quay.io` (or any other)
mirror, and do not assume v15/`develop` has been validated by this setup.

## Build

From the repository root:

```sh
# Generic v16 default (rolling `version-16` tag):
docker build -f docker/Dockerfile -t frappe-intelligence:dev .

# Reproducible/pinned build (recommended for anything beyond local
# iteration) -- matches the exact release this app has been verified
# against, ERPNext 16.34.2 / Frappe 16.33.1:
docker build -f docker/Dockerfile \
  --build-arg ERPNEXT_VERSION=v16.34.2 \
  -t frappe-intelligence:0.2.0 .
```

The build context **is** this repository's own checkout; the Dockerfile
copies only `pyproject.toml`, `README.md`, `LICENSE` and the
`frappe_intelligence/` package into the image (see the `COPY` steps) and
never fetches the app over the network or from a placeholder git URL. For a
reviewed release, resolve the pinned commit from the authorized origin
(`git@github.com:GreatWharf/frappe-intelligence.git`) into a local checkout
first, and build from that checkout.

If this Dockerfile is ever changed to copy the whole tree (`COPY . .`)
instead of the explicit runtime paths it uses today, add a **root**
`.dockerignore` first (this directory does not own the repo root, so it is
not created here) with at least:

```
.git
.github
node_modules
dev
docs
tests
IMPLEMENTATION_PLAN.md
PRODUCT_BRIEF.md
*.pyc
__pycache__
.pytest_cache
.ruff_cache
*.egg-info
build
dist
.venv
test-results
playwright-report
.env
.env.*
.DS_Store
```

The build fails closed if the `pypdf` runtime dependency does not install
correctly (see the `env/bin/python -c "import frappe_intelligence, pypdf"`
verification step) or if `bench build --app frappe_intelligence` fails, so a
broken dependency or frontend bundle is caught at `docker build` time.

### Optional: the wiki app

The image can additionally ship the upstream
[wiki](https://github.com/frappe/wiki) app, so the assistant's adaptive
meta-tools cover Wiki Page/Wiki Space like any other allowed DocType on
sites where it is installed. This is opt-in because it is the one build
step that fetches over the network:

```sh
docker build -f docker/Dockerfile \
  --build-arg ERPNEXT_VERSION=v16.34.2 \
  --build-arg WIKI_VERSION=<ref> \
  -t frappe-intelligence:0.2.0 .
```

`<ref>` must be a tag/branch of the upstream repo verified against
<https://github.com/frappe/wiki/branches> **before** the build -- the
`version-16` line is the candidate matching this image's ERPNext v16
target, but no ref is hardcoded in the Dockerfile as an unverified guess.
When `WIKI_VERSION` is unset (the default) the build is byte-for-byte the
hermetic, network-free image described above; the gate is a pure log line
and no layer changes. When it is set, a wiki fetch, install or asset-build
failure fails the image build, because opting in is explicit. At deploy
time `site-init.sh` installs wiki onto the site behind its `INSTALL_WIKI`
gate (table below).

## Runtime site initialization

Run once per environment, against **one** site, after the `sites` volume and
the database/Redis services are up. On a fresh deploy the site may still be
being created when this job starts, so the script first waits -- with a
bounded, configurable poll -- for the site to appear and answer
`bench list-apps` instead of failing its existence guard instantly; the
shipped compose template additionally orders this job after the create-site
service, so the wait is normally a no-op:

```sh
docker run --rm \
  --user frappe \
  -v sites:/home/frappe/frappe-bench/sites \
  --network your-frappe-network \
  -e SITE_NAME=erp.example.internal \
  frappe-intelligence:0.2.0 \
  bash /home/frappe/frappe-bench/docker/site-init.sh
```

### Compose deploy template

[`docker/compose.yaml`](compose.yaml) ships the full self-healing stack
(mariadb, redis-cache/-queue, configurator, create-site, intelligence-init,
backend, scheduler, queue-long, websocket, frontend). Two properties matter:

- **Fresh deploys self-order.** `intelligence-init` declares
  `depends_on: create-site` with `condition: service_completed_successfully`
  **and** `required: false`, so a first-ever deploy runs init only after the
  site exists, while a `CREATE_SITE=0` deploy (create-site exits 0
  immediately) or a stack without the create-site service never hangs.
- **The frontend re-links app assets on every start.** Its entrypoint
  (`["bash", "-c"]`) runs `mkdir -p sites/assets`, removes
  `sites/assets/frappe_intelligence` if it is a real directory, force-links
  it at the image-side
  `/home/frappe/frappe-bench/apps/frappe_intelligence/frappe_intelligence/public`
  (`ln -sfn`), and only then `exec nginx-entrypoint.sh` -- so a stale or
  dangling entry in the mounted sites volume can no longer 404 the Desk
  bundle.

The equivalent single service, if you are grafting init onto an existing
compose file instead of adopting the template:

```yaml
services:
  intelligence-init:
    image: frappe-intelligence:0.2.0
    user: frappe
    command: ["bash", "/home/frappe/frappe-bench/docker/site-init.sh"]
    environment:
      SITE_NAME: erp.example.internal
      # Optional, off by default:
      # INTELLIGENCE_ALLOW_TESTS: "1"
      # INTELLIGENCE_RUN_TESTS: "1"
      # Set to "0" to skip installing the wiki app onto the site when the
      # image was built with WIKI_VERSION (default installs it):
      # INSTALL_WIKI: "0"
    volumes:
      - sites:/home/frappe/frappe-bench/sites
    depends_on:
      mariadb:
        condition: service_healthy
      redis-cache:
        condition: service_healthy
      redis-queue:
        condition: service_healthy
      create-site:
        condition: service_completed_successfully
        required: false
```

### Environment variables

| Variable | Required | Behavior |
| --- | --- | --- |
| `SITE_NAME` | Yes | Exactly one site. Never `"all"`; the script refuses that value, and fails (after a bounded wait) if the site's `sites/<site>/site_config.json` never appears. |
| `INTELLIGENCE_ALLOW_TESTS` | No | Only the exact value `"1"` turns the site's `allow_tests` config flag **on**. Any other value (including unset) leaves the site's existing `allow_tests` setting untouched in both directions. |
| `INTELLIGENCE_RUN_TESTS` | No | Only the exact value `"1"`, together with `INTELLIGENCE_ALLOW_TESTS=1`, runs `bench run-tests --app frappe_intelligence --module frappe_intelligence.tests.test_integration` (the same real-Frappe suite documented in [`docs/verification.md`](../docs/verification.md)). Requesting this without also enabling `allow_tests` fails fast. |
| `INSTALL_WIKI` | No | Default `"1"`. When the image ships the wiki app (built with `WIKI_VERSION`, see above) and the site does not have it yet, the script runs `bench --site $SITE_NAME install-app wiki`. Any value other than `"1"` skips the install. A wiki install failure is logged and **never** fails the run. |
| `INTELLIGENCE_INIT_RESULT_PATH` | No | Default `<bench>/sites/intelligence-staging-result.json`. Overwritten atomically on every run. |
| `INTELLIGENCE_SITE_WAIT_TIMEOUT` | No | Bound in seconds on the wait-for-site poll (default `780`, i.e. 13 minutes). On timeout the run logs a clear error and exits non-zero; the site is never created by this script. |
| `INTELLIGENCE_SITE_WAIT_INTERVAL` | No | Seconds between readiness polls (default `5`). |
| `BENCH_DIR` | No | Default `/home/frappe/frappe-bench`, matching the base image. |

### What it does, in order

1. Refuses to run as anyone but the `frappe` user, and refuses `SITE_NAME`
   being unset or `"all"`. A site that does not exist **yet** is first
   awaited (bounded; see `INTELLIGENCE_SITE_WAIT_TIMEOUT`) so a fresh deploy
   whose create-site service is still running self-heals; a site that never
   appears fails the run with a clear error. The site is never created here.
2. Reads `bench --site $SITE_NAME list-apps` (a native, non-secret bench
   subcommand; every bench call in this script reads stdin from `/dev/null`
   and is never given a database/admin password on the command line).
3. Requires ERPNext to be installed and its major version to be **>= 16**;
   fails closed otherwise. This deployment only tests ERPNext v16.
4. Installs `frappe_intelligence` with `bench install-app` only if it is not
   already present, then runs `bench migrate`. Both are safe to repeat.
5. Installs the **wiki** app with `bench install-app wiki` only when all of
   these hold: the image ships it under `apps/` (built with `WIKI_VERSION`),
   the site does not have it yet, and `INSTALL_WIKI` is exactly `"1"` (the
   default). A wiki install failure is logged and never fails the run --
   frappe_intelligence stays green without wiki.
6. Enables `allow_tests` only when explicitly requested (see table above).
7. Optionally runs the real integration suite, only when explicitly
   requested, and only if `allow_tests` was actually turned on this run.
8. Restores `sites/assets/frappe_intelligence` if the mounted `sites` volume
   hides it (symlinking from an image-side cache baked in step 4 of the
   Dockerfile when present), then always runs a real
   `bench build --app frappe_intelligence` to refresh the asset manifest,
   and exits non-zero if that build fails.
9. Writes a **safe** JSON result file: timestamp, site name, app name/
   version, detected Frappe/ERPNext major versions, whether the app was
   already installed, migration/asset-build status, the wiki
   present/install-attempted/installed fields, and the tests'
   requested/ran/exit-code/status fields. It never contains a credential,
   database config, or any record/customer content.

### Caveats

- **This script never creates, drops, or repairs credentials for a site.**
  Site creation/backup/restore/encryption-key handling remain a separate,
  human-driven process, per `docs/operations.md`.
- **Idempotent, not transactional.** Re-running after a partial failure is
  supported and expected (that's the point of the existence/idempotency
  checks throughout), but a failure between `install-app` and `migrate`,
  for example, is not automatically rolled back -- it is corrected by
  simply running the script again.
- **`bench get-app --soft-link` / `--skip-assets` (used in the Dockerfile,
  not this script) are assumed to exist on the bench version pinned inside
  the chosen ERPNext base image.** This matches this project's own
  documented local-dev command in `docs/operations.md` and common
  `frappe_docker` custom-app patterns, but was not executed as part of
  producing these files (no image build, docker daemon, or bench install
  was run to author this change). Verify against the exact base image tag
  before relying on it in production, and adjust the flags if a future
  bench release renames them.
- **Asset rebuild cost.** The runtime `bench build` in step 8 needs the
  Node/Yarn toolchain that ships in the standard ERPNext image (it is not a
  stripped-down runtime-only image), so it works out of the box, at the
  cost of a real build on every site-init run. The image-side asset cache
  populated during `docker build` only shortens the window before a working
  bundle is available (via the symlink fast path); it does not remove the
  rebuild.
- **Test runs commit and clean up synthetic fixtures.** Per
  `frappe_intelligence/tests/test_integration.py`, the integration suite
  intentionally commits and then removes uniquely-prefixed synthetic users/
  records to exercise real permission and concurrency behavior. Only enable
  `INTELLIGENCE_RUN_TESTS=1` against a disposable/staging site, never
  against a production site with real customer data.
- **This deployment's only verified remote target is ERPNext v16**
  (16.34.2 / Frappe 16.33.1 at time of writing); the version check in step 3
  is a floor (`>= 16`), not a ceiling, so a later v16 patch release passes
  without a change here, but v15 and any other line are refused.
