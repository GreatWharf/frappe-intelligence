#!/usr/bin/env bash
# =============================================================================
# Frappe Intelligence -- site initializer
# =============================================================================
#
# One serialized deployment step that installs/migrates frappe_intelligence
# on ONE already-existing site, then repairs its static assets. It is meant
# to run once per environment as its own job/service (e.g. in place of a
# generic `bench --site all migrate` migration-service command), never as
# part of every web/worker container start.
#
# Hard boundaries, enforced below, not just documented:
#   - Never creates or drops a site. SITE_NAME must name a site that already
#     exists (its sites/<site>/site_config.json is read, never written by
#     this script beyond bench's own `set-config allow_tests`).
#   - Never reads or prints a database/admin password, API key or other
#     secret. Only bench subcommands that operate against the site's own
#     already-configured site_config.json are used; none of them are ever
#     called with a credential on the command line.
#   - Every bench invocation reads stdin from /dev/null, so nothing here can
#     block on an interactive prompt.
#   - Never calls `bench execute` / relies on `frappe.get_attr` against
#     frappe_intelligence. That CLI helper refuses to resolve a dotted path
#     belonging to an app that is not yet installed on the target site, so a
#     custom-function call issued before `install-app` succeeds would simply
#     fail with that restriction. Every step here is a plain, native bench
#     subcommand (list-apps / install-app / migrate / set-config / run-tests
#     / build) instead.
#   - Idempotent: safe to run again against a site that is already fully
#     installed/migrated/built. Nothing here assumes a first run.
#
# Required:
#   SITE_NAME                    Explicit target site. No default, and never
#                                 "all" -- this script always names exactly
#                                 one site.
#
# Optional:
#   BENCH_DIR                    Bench root. Default: /home/frappe/frappe-bench
#   INTELLIGENCE_ALLOW_TESTS     Set to exactly "1" to turn the site's
#                                 allow_tests config flag on. Any other value
#                                 (including unset) leaves allow_tests alone
#                                 in either direction -- this script never
#                                 disables an operator-set flag either.
#   INTELLIGENCE_RUN_TESTS       Set to exactly "1" (together with
#                                 INTELLIGENCE_ALLOW_TESTS=1) to additionally
#                                 run the real integration suite via
#                                 `bench run-tests`. Optional; skipped by
#                                 default.
#   INTELLIGENCE_INIT_RESULT_PATH
#                                 Where to write the safe JSON result file.
#                                 Default:
#                                 <BENCH_DIR>/sites/intelligence-staging-result.json
#
# Usage:
#   SITE_NAME=erp.example.internal \
#     bash /home/frappe/frappe-bench/docker/site-init.sh
#
# =============================================================================

set -u
set -o pipefail

BENCH_DIR="${BENCH_DIR:-/home/frappe/frappe-bench}"
RESULT_PATH="${INTELLIGENCE_INIT_RESULT_PATH:-${BENCH_DIR}/sites/intelligence-staging-result.json}"
APP_NAME="frappe_intelligence"
INTEGRATION_MODULE="frappe_intelligence.tests.test_integration"

log() { printf '[site-init] %s\n' "$*" >&2; }
fail() {
    printf '[site-init] ERROR: %s\n' "$*" >&2
    exit 1
}

# A bench subcommand wrapper: always non-interactive, always run from the
# bench root, never handed a credential as an argument. `$@` must only ever
# be native bench subcommands documented above.
run_bench() {
    (cd "$BENCH_DIR" && bench "$@" </dev/null)
}

# ---------------------------------------------------------------------------
# 0. Preconditions: correct user, existing bench, explicit and non-"all" site
#    that already exists. No site is ever created or dropped past this point.
# ---------------------------------------------------------------------------
current_user="$(id -un 2>/dev/null || echo unknown)"
if [ "$current_user" != "frappe" ]; then
    fail "must run as the 'frappe' user (was: $current_user). Do not run this as root."
fi

if [ -z "${SITE_NAME:-}" ]; then
    fail "SITE_NAME is required and must name exactly one existing site (never 'all')."
fi
if [ "$SITE_NAME" = "all" ]; then
    fail "SITE_NAME must not be 'all'; this initializer only ever targets one explicit site."
fi

[ -d "$BENCH_DIR" ] || fail "bench directory not found: $BENCH_DIR"
SITE_CONFIG="$BENCH_DIR/sites/$SITE_NAME/site_config.json"
if [ ! -f "$SITE_CONFIG" ]; then
    fail "site '$SITE_NAME' does not exist ($SITE_CONFIG not found). This script never creates a site; provision it separately first."
fi

log "target site: $SITE_NAME"

# ---------------------------------------------------------------------------
# 1. Small bounded readiness retry around the first real bench call, in case
#    this runs slightly ahead of the database/Redis becoming reachable. This
#    is a belt-and-suspenders margin, not a substitute for the orchestrator's
#    own service health checks (e.g. compose `depends_on: condition:
#    service_healthy`), which should already gate this job.
# ---------------------------------------------------------------------------
list_apps_output=""
attempt=0
max_attempts=12   # ~60s at 5s apiece
until list_apps_output="$(run_bench --site "$SITE_NAME" list-apps 2>&1)"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
        log "$list_apps_output"
        fail "could not reach site '$SITE_NAME' (database/Redis not ready?) after $max_attempts attempts."
    fi
    log "site not reachable yet, retrying ($attempt/$max_attempts)..."
    sleep 5
done
log "installed apps on $SITE_NAME:"
printf '%s\n' "$list_apps_output" | while IFS= read -r line; do log "  $line"; done

# ---------------------------------------------------------------------------
# 2. Validate the remote target: ERPNext must be installed and >= v16. This
#    project only builds/tests against ERPNext v16 -- fail closed on
#    anything else rather than silently proceeding against an unverified
#    major line.
# ---------------------------------------------------------------------------
get_major_version() {
    # $1: app name. Prefers the version bench already printed in list-apps
    # ("appname 16.34.2 ..."); falls back to importing the installed package
    # directly (plain venv python, not `bench execute`/get_attr) if bench's
    # list-apps output for this bench version omits versions.
    local app="$1" version=""
    version="$(printf '%s\n' "$list_apps_output" \
        | awk -v a="$app" '$1 == a && NF >= 2 { print $2; exit }')"
    if [ -z "$version" ]; then
        version="$("$BENCH_DIR/env/bin/python" -c "
import importlib
try:
    m = importlib.import_module('$app')
    print(getattr(m, '__version__', ''))
except Exception:
    print('')
" 2>/dev/null)"
    fi
    printf '%s' "$version" | sed -n 's/^\([0-9][0-9]*\)\..*$/\1/p'
}

if ! printf '%s\n' "$list_apps_output" | awk '{print $1}' | grep -qx "erpnext"; then
    fail "ERPNext is not installed on site '$SITE_NAME'. This app's financial-report tools and this deployment target require ERPNext v16."
fi
erpnext_major="$(get_major_version erpnext)"
if [ -z "$erpnext_major" ] || [ "$erpnext_major" -lt 16 ] 2>/dev/null; then
    fail "unsupported ERPNext version on site '$SITE_NAME' (detected major: '${erpnext_major:-unknown}'). Only ERPNext v16 is built/tested by this deployment."
fi
frappe_major="$(get_major_version frappe)"
log "detected erpnext major version: $erpnext_major, frappe major version: ${frappe_major:-unknown}"

# ---------------------------------------------------------------------------
# 3. Install frappe_intelligence only if missing, then migrate. Both native
#    bench subcommands are already idempotent on their own; the explicit
#    check below just keeps the log honest about whether anything changed.
# ---------------------------------------------------------------------------
already_installed=0
if printf '%s\n' "$list_apps_output" | awk '{print $1}' | grep -qx "$APP_NAME"; then
    already_installed=1
    log "$APP_NAME already installed on $SITE_NAME; skipping install-app."
else
    log "installing $APP_NAME on $SITE_NAME..."
    if ! run_bench --site "$SITE_NAME" install-app "$APP_NAME"; then
        fail "bench install-app $APP_NAME failed for site '$SITE_NAME'."
    fi
fi

log "migrating $SITE_NAME..."
if ! run_bench --site "$SITE_NAME" migrate; then
    fail "bench migrate failed for site '$SITE_NAME'."
fi

# ---------------------------------------------------------------------------
# 4. allow_tests is enabled ONLY on an explicit opt-in. It is never disabled
#    by this script either, so an operator's own choice is never overridden
#    in either direction when the variable is simply absent.
# ---------------------------------------------------------------------------
allow_tests_enabled=0
if [ "${INTELLIGENCE_ALLOW_TESTS:-}" = "1" ]; then
    log "INTELLIGENCE_ALLOW_TESTS=1: enabling allow_tests on $SITE_NAME."
    if run_bench --site "$SITE_NAME" set-config allow_tests true; then
        allow_tests_enabled=1
    else
        fail "failed to set allow_tests on site '$SITE_NAME'."
    fi
else
    log "INTELLIGENCE_ALLOW_TESTS not set to '1'; leaving the site's allow_tests setting untouched."
fi

# ---------------------------------------------------------------------------
# 5. Optional real integration tests. Requires the explicit allow_tests
#    opt-in above as well -- this app's own integration suite refuses to run
#    against a site where allow_tests is not enabled (see
#    frappe_intelligence/tests/test_integration.py), so both flags are
#    required together rather than one silently implying the other.
# ---------------------------------------------------------------------------
tests_requested=0
tests_ran=0
tests_exit_code=""
tests_status="skipped"
if [ "${INTELLIGENCE_RUN_TESTS:-}" = "1" ]; then
    tests_requested=1
    if [ "$allow_tests_enabled" -ne 1 ]; then
        fail "INTELLIGENCE_RUN_TESTS=1 requires INTELLIGENCE_ALLOW_TESTS=1 as well; refusing to run tests against a site without allow_tests explicitly enabled."
    fi
    log "INTELLIGENCE_RUN_TESTS=1: running the real integration suite on $SITE_NAME..."
    if run_bench --site "$SITE_NAME" run-tests --app "$APP_NAME" --module "$INTEGRATION_MODULE"; then
        tests_exit_code=0
        tests_status="passed"
    else
        tests_exit_code=$?
        tests_status="failed"
    fi
    tests_ran=1
    log "integration suite finished: $tests_status (exit code ${tests_exit_code})"
else
    log "INTELLIGENCE_RUN_TESTS not set to '1'; skipping the optional integration suite."
fi

# ---------------------------------------------------------------------------
# 6. Assets. The persistent "sites" volume mounted at deploy time hides
#    whatever the image build baked into sites/assets, so sites/assets/<app>
#    has to be re-established at runtime. Point it straight at the app's own
#    public/ directory under apps/ -- the same target Frappe uses natively,
#    and a path that lives in the image rather than in the mounted volume, so
#    it is always present. Force the link (`-sfn`): a bare `ln -s` is a silent
#    no-op whenever anything, including a stale or dangling entry, already
#    occupies the target, which is exactly how the Desk ends up 404ing on its
#    own bundle. Link before the build so esbuild writes dist/ through it,
#    then re-assert and verify afterwards.
# ---------------------------------------------------------------------------
APP_PUBLIC="$BENCH_DIR/apps/$APP_NAME/$APP_NAME/public"
ASSET_TARGET="$BENCH_DIR/sites/assets/$APP_NAME"

link_app_assets() {
    [ -d "$APP_PUBLIC" ] || return 1
    mkdir -p "$BENCH_DIR/sites/assets"
    # A real directory at the target would make `ln -sfn` nest the link
    # inside it instead of replacing it, so clear that case explicitly.
    if [ -d "$ASSET_TARGET" ] && [ ! -L "$ASSET_TARGET" ]; then
        rm -rf "$ASSET_TARGET"
    fi
    ln -sfn "$APP_PUBLIC" "$ASSET_TARGET"
}

if link_app_assets; then
    log "linked sites/assets/$APP_NAME -> apps/$APP_NAME/$APP_NAME/public."
else
    log "warning: $APP_PUBLIC is missing; cannot link the app's public assets."
fi

log "building $APP_NAME assets..."
assets_built=0
if run_bench build --app "$APP_NAME"; then
    assets_built=1
else
    log "warning: bench build --app $APP_NAME failed; the app's JS/CSS bundle may be stale or missing."
fi

# `bench build` exiting 0 is not evidence that /assets/<app>/... can be
# served: it may rewrite or drop the link it built through. Re-assert the
# link, then prove that every file hooks.py advertises actually resolves.
# Anything still unreadable here means a Desk that cannot load its client,
# which is a failed init, not a warning.
link_app_assets || true
assets_verified=1
for asset in js/intelligence.js css/intelligence.css images/intelligence.svg; do
    if [ ! -r "$ASSET_TARGET/$asset" ]; then
        log "ERROR: sites/assets/$APP_NAME/$asset does not resolve; the Desk would 404 on it."
        assets_verified=0
    fi
done
if [ "$assets_verified" -eq 1 ]; then
    log "verified all hooks.py assets resolve under sites/assets/$APP_NAME."
fi

# ---------------------------------------------------------------------------
# 7. Safe result file. No credentials, no site/db config, no record or
#    customer content -- only operational status fields, written atomically.
# ---------------------------------------------------------------------------
fi_version="$("$BENCH_DIR/env/bin/python" -c "import frappe_intelligence; print(frappe_intelligence.__version__)" 2>/dev/null || true)"
timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
result_tmp="${RESULT_PATH}.tmp.$$"
mkdir -p "$(dirname "$RESULT_PATH")"

# Pass every dynamic value as a JSON-encoded literal via environment
# variables (never string-interpolated into the Python source itself), so an
# empty/odd value can never produce broken generated code or an escaping bug.
INTELLIGENCE_RESULT_TIMESTAMP="$timestamp" \
INTELLIGENCE_RESULT_SITE="$SITE_NAME" \
INTELLIGENCE_RESULT_APP="$APP_NAME" \
INTELLIGENCE_RESULT_APP_VERSION="$fi_version" \
INTELLIGENCE_RESULT_ERPNEXT_MAJOR="$erpnext_major" \
INTELLIGENCE_RESULT_FRAPPE_MAJOR="${frappe_major:-}" \
INTELLIGENCE_RESULT_ALREADY_INSTALLED="$already_installed" \
INTELLIGENCE_RESULT_ALLOW_TESTS="$allow_tests_enabled" \
INTELLIGENCE_RESULT_TESTS_REQUESTED="$tests_requested" \
INTELLIGENCE_RESULT_TESTS_RAN="$tests_ran" \
INTELLIGENCE_RESULT_TESTS_EXIT_CODE="$tests_exit_code" \
INTELLIGENCE_RESULT_TESTS_STATUS="$tests_status" \
INTELLIGENCE_RESULT_ASSETS_BUILT="$assets_built" \
INTELLIGENCE_RESULT_ASSETS_VERIFIED="$assets_verified" \
"$BENCH_DIR/env/bin/python" - "$result_tmp" <<'PYEOF'
import json
import os
import sys


def flag(name):
    return os.environ.get(name, "0") == "1"


def optional_int(name):
    value = os.environ.get(name, "")
    return int(value) if value != "" else None


path = sys.argv[1]
data = {
    "timestamp": os.environ["INTELLIGENCE_RESULT_TIMESTAMP"],
    "site": os.environ["INTELLIGENCE_RESULT_SITE"],
    "app": os.environ["INTELLIGENCE_RESULT_APP"],
    "app_version": os.environ.get("INTELLIGENCE_RESULT_APP_VERSION", ""),
    "erpnext_major_version": os.environ.get("INTELLIGENCE_RESULT_ERPNEXT_MAJOR", ""),
    "frappe_major_version": os.environ.get("INTELLIGENCE_RESULT_FRAPPE_MAJOR", ""),
    "was_already_installed": flag("INTELLIGENCE_RESULT_ALREADY_INSTALLED"),
    "migrated": True,
    "allow_tests_enabled": flag("INTELLIGENCE_RESULT_ALLOW_TESTS"),
    "tests": {
        "requested": flag("INTELLIGENCE_RESULT_TESTS_REQUESTED"),
        "ran": flag("INTELLIGENCE_RESULT_TESTS_RAN"),
        "exit_code": optional_int("INTELLIGENCE_RESULT_TESTS_EXIT_CODE"),
        "status": os.environ.get("INTELLIGENCE_RESULT_TESTS_STATUS", "skipped"),
    },
    "assets_built": flag("INTELLIGENCE_RESULT_ASSETS_BUILT"),
    "assets_verified": flag("INTELLIGENCE_RESULT_ASSETS_VERIFIED"),
}
with open(path, "w") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
PYEOF
if [ $? -eq 0 ]; then
    mv -f "$result_tmp" "$RESULT_PATH"
    log "wrote result file: $RESULT_PATH"
else
    rm -f "$result_tmp"
    log "warning: could not write result file at $RESULT_PATH"
fi

# ---------------------------------------------------------------------------
# 8. Exit status: fail the job if install/migrate/version-check failed
#    (those already `fail`-ed above and exited), if the asset build failed,
#    or if explicitly-requested tests failed. A skipped/not-requested test
#    run is success, not failure.
# ---------------------------------------------------------------------------
if [ "$assets_built" -ne 1 ]; then
    fail "asset build failed; see the bench build output above."
fi
if [ "$assets_verified" -ne 1 ]; then
    fail "the app's public assets do not resolve under sites/assets/$APP_NAME; the Desk would load without its client."
fi
if [ "$tests_requested" -eq 1 ] && [ "$tests_status" != "passed" ]; then
    fail "requested integration tests did not pass (status: $tests_status)."
fi

log "site-init complete for $SITE_NAME."
exit 0
