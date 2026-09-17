"""Offline, static checks on docker/Dockerfile and docker/site-init.sh.

These do not build an image, run bench, or touch a network/site -- consistent
with the rest of this offline suite (see tests/test_install.py for the same
"read the real deployment source and assert on it" style). They exist to
catch regressions in the safety properties the deployment plan depends on:
never touching Quay, never faking a repository URL, never creating/dropping a
site, never printing a credential, keeping `allow_tests`/test-running strictly
opt-in, and never calling `bench execute` on frappe_intelligence before it is
installed (bench's `frappe.get_attr` dispatch refuses a dotted path whose
owning app is not yet installed on the target site).

Checks are applied to the CODE, not to explanatory comments: both files
legitimately document, in prose, the things they deliberately avoid (e.g. "we
use docker.io, never quay.io"), which would trip a naive whole-text search.
`_code_only` strips `#`-comment lines (both Dockerfile and site-init.sh use
`#` comments) before any "must not contain" assertion.
"""

import re
import subprocess
from pathlib import Path

import pytest

DOCKER_DIR = Path(__file__).resolve().parent.parent / "docker"
DOCKERFILE = DOCKER_DIR / "Dockerfile"
SITE_INIT = DOCKER_DIR / "site-init.sh"
COMPOSE = DOCKER_DIR / "compose.yaml"
HOOKS = Path(__file__).resolve().parent.parent / "frappe_intelligence" / "hooks.py"

FORBIDDEN_SECRET_FLAGS = (
    "--mariadb-root-password",
    "--admin-password",
    "--root-password",
    "mysql_root_password",
)
FORBIDDEN_SITE_LIFECYCLE_COMMANDS = ("new-site", "drop-site", "restore", "backup --with-files")


def _code_only(text):
    """Drop full-line `#` comments; keeps code, including inline trailing bits."""
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("#"))


@pytest.fixture(scope="module")
def dockerfile_text():
    return DOCKERFILE.read_text()


@pytest.fixture(scope="module")
def dockerfile_code(dockerfile_text):
    return _code_only(dockerfile_text)


@pytest.fixture(scope="module")
def site_init_text():
    return SITE_INIT.read_text()


@pytest.fixture(scope="module")
def site_init_code(site_init_text):
    return _code_only(site_init_text)


@pytest.fixture(scope="module")
def compose_text():
    return COMPOSE.read_text()


def _extract_site_init_function(site_init_text, name):
    """Pull one top-level bash function out of site-init.sh, verbatim."""
    match = re.search(rf"^{re.escape(name)}\(\)\s*\{{.*?^\}}", site_init_text, re.S | re.M)
    assert match, f"site-init.sh must define {name}()"
    return match.group(0)


def _compose_service_block(compose_text, service):
    """Slice one service's definition out of the compose template by indent.

    The offline test venv has no PyYAML; the shipped template keeps a fixed
    two-space service indent, so a structural slice is precise enough.
    """
    match = re.search(rf"^  {re.escape(service)}:\n(.*?)(?=^\S|^  \S|\Z)", compose_text, re.S | re.M)
    assert match, f"compose.yaml must define a {service!r} service"
    return match.group(1)


def _compose_depends_entry(service_block, dependency):
    """Slice one depends_on entry (its condition/required lines) out of a service block."""
    depends = re.search(r"^    depends_on:\n(.*?)(?=^    \S|\Z)", service_block, re.S | re.M)
    assert depends, "service must declare depends_on"
    entry = re.search(
        rf"^      {re.escape(dependency)}:\n(.*?)(?=^      \S|\Z)", depends.group(1), re.S | re.M
    )
    assert entry, f"depends_on must include {dependency!r}"
    return entry.group(1)


def _frontend_command_lines(frontend_block):
    """Extract the frontend's literal (`|`) command block scalar, dedented."""
    match = re.search(r"^    command: \|\n((?:^      .*\n?)+)", frontend_block, re.M)
    assert match, "frontend must override command with a literal (|) block"
    return [line[6:] for line in match.group(1).splitlines()]


@pytest.fixture(scope="module")
def hooks_text():
    return HOOKS.read_text()


@pytest.fixture(scope="module")
def app_name():
    match = re.search(r'^app_name\s*=\s*"([^"]+)"', HOOKS.read_text(), re.MULTILINE)
    assert match, "frappe_intelligence/hooks.py must declare app_name"
    return match.group(1)


# ---------------------------------------------------------------------------
# Dockerfile
# ---------------------------------------------------------------------------


def test_dockerfile_exists_and_is_readable():
    assert DOCKERFILE.is_file()


def test_base_image_is_erpnext_from_docker_hub_never_quay(dockerfile_text, dockerfile_code):
    assert "docker.io/frappe/erpnext:" in dockerfile_text
    from_lines = [line for line in dockerfile_text.splitlines() if line.strip().upper().startswith("FROM")]
    assert from_lines, "Dockerfile must have a FROM instruction"
    for line in from_lines:
        assert "quay" not in line.lower()
    # No actual quay.io image reference anywhere in real instructions
    # (mentioning it by name in a cautionary comment is fine and expected).
    assert "quay.io/" not in dockerfile_code


def test_erpnext_version_is_an_arg_defaulting_to_a_v16_tag(dockerfile_text):
    match = re.search(r"^ARG\s+ERPNEXT_VERSION=(\S+)", dockerfile_text, re.MULTILINE)
    assert match, "ERPNEXT_VERSION must be a build ARG with a default"
    default = match.group(1)
    assert re.match(r"^v?16(\.\d+)*$|^version-16$", default), (
        f"default ERPNEXT_VERSION {default!r} must target the v16 line only"
    )
    assert "FROM docker.io/frappe/erpnext:${ERPNEXT_VERSION}" in dockerfile_text


def test_no_fake_or_hardcoded_get_app_repo_url_in_build_commands(dockerfile_code):
    run_lines = [line for line in dockerfile_code.splitlines() if line.strip().startswith("RUN")]
    assert run_lines, "expected RUN instructions registering the app"
    body = "\n".join(run_lines)
    # The real app source is the local build context, not a git fetch:
    # no remote URL is ever fetched or executed during the image build.
    for forbidden in ("http://", "https://", "git@", "example.com"):
        assert forbidden not in body
    # `bench get-app --soft-link` requires a git checkout and fails against
    # the plain copied tree; registration must be direct instead.
    assert "bench get-app" not in body


def test_app_is_installed_editable_under_apps_directory(dockerfile_text):
    assert "/opt/frappe_intelligence_src" in dockerfile_text
    assert "ln -s /opt/frappe_intelligence_src apps/frappe_intelligence" in dockerfile_text
    assert "pip install --quiet --editable apps/frappe_intelligence" in dockerfile_text
    assert "sites/apps.txt" in dockerfile_text


def test_dockerfile_is_single_stage_inheriting_the_base_images_python(dockerfile_text):
    # The base ERPNext v16 image already ships Python 3.14; this Dockerfile
    # must inherit it, not swap in some other Python base image.
    from_lines = [line for line in dockerfile_text.splitlines() if line.strip().upper().startswith("FROM")]
    assert len(from_lines) == 1, "single-stage build expected: one FROM, inheriting the base image's Python"
    assert "python:3." not in dockerfile_text.lower()
    assert "3.14" in dockerfile_text


def test_only_runtime_paths_are_copied_into_the_image(dockerfile_text):
    copy_lines = [line for line in dockerfile_text.splitlines() if line.strip().startswith("COPY")]
    assert copy_lines
    joined = "\n".join(copy_lines)
    for excluded in (
        "tests/",
        "dev/",
        "docs/",
        ".github/",
        "node_modules",
        "IMPLEMENTATION_PLAN.md",
        "PRODUCT_BRIEF.md",
    ):
        assert excluded not in joined, f"{excluded} must not be copied into the runtime image"
    assert "frappe_intelligence/" in joined
    assert "pyproject.toml" in joined


def test_pypdf_dependency_is_verified_at_build_time(dockerfile_text):
    assert "pypdf" in dockerfile_text
    assert "import frappe_intelligence, pypdf" in dockerfile_text


def test_asset_build_step_present_and_lands_outside_the_sites_volume(dockerfile_text):
    assert "bench build --app frappe_intelligence" in dockerfile_text
    # The built bundle has to survive into runtime, and sites/ is a volume
    # mount that hides anything written under it. esbuild writes through the
    # sites/assets link into apps/<app>/<app>/public, which is baked into the
    # image, so assert the build really produced a file on that path.
    assert "test -r apps/frappe_intelligence/frappe_intelligence/public/js/intelligence.js" in dockerfile_text
    # Nothing may depend on an image-side copy under sites/, which would be
    # shadowed, nor on the retired assets cache.
    assert ".intelligence-assets-cache" not in dockerfile_text


def test_dockerfile_never_performs_site_lifecycle_operations(dockerfile_code):
    for forbidden in ("install-app", "bench migrate", "new-site", "drop-site", "--site "):
        assert forbidden not in dockerfile_code, (
            f"Dockerfile must not perform site-level operation {forbidden!r}; "
            "that belongs in docker/site-init.sh at runtime"
        )


def test_dockerfile_never_calls_bench_execute(dockerfile_code):
    assert "bench execute" not in dockerfile_code


def test_dockerfile_has_no_secret_looking_flags(dockerfile_code):
    lowered = dockerfile_code.lower()
    for flag in FORBIDDEN_SECRET_FLAGS:
        assert flag not in lowered


def test_site_init_script_is_copied_into_the_image(dockerfile_text):
    assert "site-init.sh" in dockerfile_text
    assert "chmod" in dockerfile_text


# ---------------------------------------------------------------------------
# docker/site-init.sh
# ---------------------------------------------------------------------------


def test_site_init_exists_and_is_executable():
    assert SITE_INIT.is_file()
    mode = SITE_INIT.stat().st_mode
    assert mode & 0o111, "docker/site-init.sh must be executable"


def test_site_init_has_a_bash_shebang(site_init_text):
    assert site_init_text.startswith("#!/usr/bin/env bash")


def test_site_init_requires_explicit_site_name(site_init_text, site_init_code):
    assert "SITE_NAME:-" in site_init_text
    assert "SITE_NAME is required" in site_init_text
    # Explicit rejection of the "all" sentinel some bench workflows use.
    assert '"$SITE_NAME" = "all"' in site_init_code
    assert "must not be 'all'" in site_init_text


def test_site_init_never_creates_or_drops_a_site(site_init_code, site_init_text):
    for forbidden in FORBIDDEN_SITE_LIFECYCLE_COMMANDS:
        assert forbidden not in site_init_code, f"site-init.sh must not run {forbidden!r}"
    assert "does not exist" in site_init_text
    assert "never creates a site" in site_init_text


def test_site_init_waits_for_the_site_before_its_asset_and_result_steps(site_init_text, site_init_code):
    # Fresh-deploy ordering: when this job starts ahead of create-site, an
    # immediate "site must exist" guard fires before the site exists and the
    # init exits 1. A bounded wait-for-site guard must run first instead.
    function_src = _extract_site_init_function(site_init_text, "wait_for_site")
    function_code = _code_only(function_src)
    # Readiness is probed with a plain native bench subcommand -- never with
    # anything that depends on frappe_intelligence already being installed.
    assert 'run_bench --site "$SITE_NAME" list-apps' in function_src
    assert "APP_NAME" not in function_code
    assert "frappe_intelligence" not in function_code
    # Bounded at <= 15 minutes by default, so a wedged create-site cannot
    # park the init job forever.
    default = re.search(r"INTELLIGENCE_SITE_WAIT_TIMEOUT:-(\d+)", site_init_code)
    assert default, "INTELLIGENCE_SITE_WAIT_TIMEOUT must have a default"
    assert 0 < int(default.group(1)) <= 900
    # A clear log line and a non-zero exit on timeout (fail() exits 1).
    assert "if ! wait_for_site; then" in site_init_code
    timeout_branch = site_init_code.split("if ! wait_for_site; then", 1)[1]
    assert 'fail "' in timeout_branch
    assert "was not ready" in timeout_branch
    # The guard runs before the asset build and before the result file.
    guard_at = site_init_code.index("if ! wait_for_site; then")
    assert guard_at < site_init_code.index('run_bench build --app "$APP_NAME"')
    assert guard_at < site_init_code.index("INTELLIGENCE_RESULT_TIMESTAMP")


def _wait_for_site_harness(tmp_path, site_init_text, *, timeout, interval):
    """A runnable harness around the real wait_for_site() with a stub bench.

    The stub's readiness rule: `bench --site <s> list-apps` succeeds iff
    sites/<s>/site_config.json exists -- so the poll loop is exercised for
    real, with no Frappe install involved.
    """
    bench = tmp_path / "frappe-bench"
    (bench / "sites").mkdir(parents=True)
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    bench_stub = stub_bin / "bench"
    bench_stub.write_text(
        "#!/usr/bin/env bash\n"
        'site=""\n'
        'while [ "$#" -gt 0 ]; do\n'
        '    case "$1" in\n'
        '        --site) site="$2"; shift 2 ;;\n'
        "        *) shift ;;\n"
        "    esac\n"
        "done\n"
        'if [ -n "$site" ] && [ -f "$BENCH_DIR/sites/$site/site_config.json" ]; then\n'
        '    printf "frappe\\nerpnext\\n"\n'
        "    exit 0\n"
        "fi\n"
        "exit 1\n"
    )
    bench_stub.chmod(0o755)
    function_src = _extract_site_init_function(site_init_text, "wait_for_site")
    script = (
        "set -u\n"
        f'PATH="{stub_bin}:$PATH"\n'
        f'export BENCH_DIR="{bench}"\n'
        'SITE_NAME="erp.test"\n'
        'SITE_CONFIG="$BENCH_DIR/sites/$SITE_NAME/site_config.json"\n'
        f'SITE_WAIT_TIMEOUT="{timeout}"\n'
        f'SITE_WAIT_INTERVAL="{interval}"\n'
        "log() { printf '[site-init] %s\\n' \"$*\" >&2; }\n"
        'run_bench() { (cd "$BENCH_DIR" && bench "$@" </dev/null); }\n'
        f"{function_src}\n"
        "wait_for_site\n"
    )
    return script, bench


def test_wait_for_site_returns_as_soon_as_the_site_appears(tmp_path, site_init_text):
    # Fresh-deploy race: create-site is still running when this job starts.
    # The guard must poll, not fail, and return once the site is ready.
    script, bench = _wait_for_site_harness(tmp_path, site_init_text, timeout=15, interval=1)
    site_dir = bench / "sites" / "erp.test"
    creator = f"(sleep 2; mkdir -p '{site_dir}'; printf '{{}}\\n' > '{site_dir}/site_config.json') &\n"
    done = subprocess.run(["bash", "-c", creator + script], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr


def test_wait_for_site_times_out_loudly_and_nonzero(tmp_path, site_init_text):
    script, _ = _wait_for_site_harness(tmp_path, site_init_text, timeout=2, interval=1)
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
    assert done.returncode != 0
    assert "erp.test" in done.stderr
    assert "does not exist yet" in done.stderr


def test_site_init_runs_as_frappe_user(site_init_code):
    assert "id -un" in site_init_code
    assert '"frappe"' in site_init_code
    assert "root" in site_init_code.lower()  # refuses root explicitly


def test_site_init_validates_erpnext_v16_or_newer(site_init_code, site_init_text):
    assert "erpnext" in site_init_code
    assert "-lt 16" in site_init_code
    assert "Only ERPNext v16 is built/tested" in site_init_text


def test_site_init_installs_app_idempotently(app_name, site_init_code, site_init_text):
    assert f'APP_NAME="{app_name}"' in site_init_code
    assert 'install-app "$APP_NAME"' in site_init_code
    assert "already installed on $SITE_NAME; skipping install-app" in site_init_text


def test_site_init_migrates_the_site(site_init_code):
    assert 'run_bench --site "$SITE_NAME" migrate' in site_init_code


def test_allow_tests_requires_exact_opt_in_and_never_auto_disables(site_init_code, site_init_text):
    assert "INTELLIGENCE_ALLOW_TESTS:-" in site_init_code
    assert '= "1"' in site_init_code
    assert "set-config allow_tests true" in site_init_code
    assert "leaving the site's allow_tests setting untouched" in site_init_text


def test_run_tests_is_optional_and_requires_allow_tests_too(site_init_code, site_init_text):
    assert "INTELLIGENCE_RUN_TESTS:-" in site_init_code
    assert "requires INTELLIGENCE_ALLOW_TESTS=1 as well" in site_init_text
    assert "run-tests" in site_init_code
    assert "frappe_intelligence.tests.test_integration" in site_init_code


def test_site_init_never_calls_bench_execute_or_get_attr(site_init_code, site_init_text):
    assert "bench execute" not in site_init_code
    assert "frappe.get_attr" not in site_init_code
    assert "get_attr(" not in site_init_code
    # The rationale is still documented for maintainers, just not executed.
    assert "get_attr" in site_init_text


def test_all_bench_invocations_are_non_interactive_and_secret_free(site_init_text, site_init_code):
    assert "</dev/null" in site_init_text
    lowered_code = site_init_code.lower()
    for flag in FORBIDDEN_SECRET_FLAGS:
        assert flag not in lowered_code
    assert "password" not in lowered_code
    assert "api_key" not in lowered_code


def test_result_file_is_safe_and_configurable(site_init_text, site_init_code):
    assert "INTELLIGENCE_INIT_RESULT_PATH" in site_init_text
    assert "intelligence-staging-result.json" in site_init_text
    assert "json.dump" in site_init_text
    # The generated JSON payload must not carry secret-shaped field names.
    payload_section = site_init_code.split("data = {", 1)[1].split("\nwith open", 1)[0]
    for forbidden in ("password", "api_key", "secret", "token"):
        assert forbidden not in payload_section.lower()
    # Written atomically: temp file then renamed into place.
    assert ".tmp." in site_init_code
    assert "mv -f" in site_init_code


def test_asset_step_force_links_app_public_and_rebuilds(site_init_code):
    # The mounted "sites" volume shadows whatever the image baked into
    # sites/assets, and a bare `ln -s` is a silent no-op whenever any entry
    # is already sitting at the target. Force the link instead, and point it
    # at the app's own public directory (the path Frappe itself uses) rather
    # than at an image-side cache, so the served files come from apps/.
    assert "ln -sfn" in site_init_code
    assert 'ln -s "' not in site_init_code, "a non-forcing ln -s can no-op against a stale entry"
    assert "$BENCH_DIR/apps/$APP_NAME/$APP_NAME/public" in site_init_code
    assert 'run_bench build --app "$APP_NAME"' in site_init_code
    assert "assets_built" in site_init_code


def test_asset_step_verifies_every_hooks_asset_after_build(site_init_code, hooks_text):
    # bench build reporting success is not evidence that /assets/<app>/... can
    # actually be served: the Desk 404s on exactly these three URLs if the
    # link is missing. Assert each file hooks.py advertises really resolves,
    # after the build, and fail the init rather than ship an unloadable Desk.
    verify_at = site_init_code.index("assets_verified")
    build_at = site_init_code.index('run_bench build --app "$APP_NAME"')
    assert verify_at > build_at, "asset verification must run after bench build"
    for asset in re.findall(r"/assets/frappe_intelligence/(\S+?)\"", hooks_text):
        assert asset in site_init_code, (
            f"hooks.py serves {asset!r} but site-init.sh never verifies it resolves"
        )
    assert "assets_verified" in site_init_code


@pytest.mark.parametrize(
    "occupant",
    [
        "nothing",
        "dangling-symlink",
        "symlink-to-elsewhere",
        "real-directory",
    ],
)
def test_link_app_assets_establishes_a_working_link_whatever_occupies_the_target(
    tmp_path, site_init_text, occupant
):
    # Runs the real link_app_assets() out of site-init.sh against a throwaway
    # bench tree. The shipped bug was the "dangling-symlink" case: `ln -s`
    # no-ops when anything already sits at the target, so bench build reported
    # success while /assets/frappe_intelligence/... stayed unservable.
    match = re.search(r"^link_app_assets\(\)\s*\{.*?^\}", site_init_text, re.S | re.M)
    assert match, "site-init.sh must define link_app_assets()"

    bench = tmp_path / "frappe-bench"
    public = bench / "apps" / "frappe_intelligence" / "frappe_intelligence" / "public"
    (public / "js").mkdir(parents=True)
    (public / "js" / "intelligence.js").write_text("// real bundle\n")
    target = bench / "sites" / "assets" / "frappe_intelligence"
    target.parent.mkdir(parents=True)

    if occupant == "dangling-symlink":
        target.symlink_to(tmp_path / "gone")
    elif occupant == "symlink-to-elsewhere":
        stale = tmp_path / "stale"
        stale.mkdir()
        target.symlink_to(stale)
    elif occupant == "real-directory":
        target.mkdir()
        (target / "leftover.txt").write_text("stale\n")

    script = (
        "set -u\n"
        f'BENCH_DIR="{bench}"\n'
        'APP_NAME="frappe_intelligence"\n'
        'APP_PUBLIC="$BENCH_DIR/apps/$APP_NAME/$APP_NAME/public"\n'
        'ASSET_TARGET="$BENCH_DIR/sites/assets/$APP_NAME"\n'
        f"{match.group(0)}\n"
        "link_app_assets\n"
    )
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr

    served = target / "js" / "intelligence.js"
    assert served.is_file(), f"{occupant}: sites/assets/<app> still does not resolve"
    assert served.read_text() == "// real bundle\n"
    assert not (target / "leftover.txt").exists(), "stale contents must not survive"


def test_script_exits_nonzero_when_requested_tests_fail(site_init_text, site_init_code):
    assert "did not pass" in site_init_text
    assert "exit 0" in site_init_code


def test_script_never_touches_all_sites(site_init_code):
    assert "--site all" not in site_init_code
    # Every bench invocation with a site scope must use the explicit
    # variable, never a literal site name or the "all" sentinel.
    for match in re.finditer(r"--site\s+(\S+)", site_init_code):
        assert match.group(1) == '"$SITE_NAME"', (
            f"found a --site argument that is not $SITE_NAME: {match.group(0)!r}"
        )


# ---------------------------------------------------------------------------
# docker/compose.yaml
# ---------------------------------------------------------------------------


def test_compose_template_exists_and_covers_the_stack(compose_text):
    for service in (
        "create-site",
        "intelligence-init",
        "frontend",
        "backend",
        "scheduler",
        "queue-long",
        "websocket",
        "mariadb",
        "redis-cache",
        "redis-queue",
    ):
        assert re.search(rf"^  {service}:\n", compose_text, re.M), (
            f"compose.yaml must define a {service!r} service"
        )
    # No literal credentials anywhere; every password-ish value arrives as an
    # environment reference ($$VAR inside a command, ${VAR} in compose env),
    # never a hardcoded value.
    code = _code_only(compose_text)
    assert "quay.io" not in code
    for line in code.splitlines():
        if "PASSWORD" in line.upper():
            assert "$$" in line or "${" in line, f"password-ish line must be an env reference: {line!r}"


def test_intelligence_init_depends_on_create_site_success_but_does_not_require_it(compose_text):
    # Fresh-deploy ordering fix: on a first-ever deploy create-site can still
    # be running when init would otherwise start, firing site-init.sh's "site
    # must exist" guard. Init must therefore wait for create-site to have
    # completed successfully -- yet a CREATE_SITE=0 deploy (or a stack that
    # omits create-site entirely) must not hang, so the dependency is
    # explicitly not required.
    init_block = _compose_service_block(compose_text, "intelligence-init")
    create_site_entry = _compose_depends_entry(init_block, "create-site")
    assert "condition: service_completed_successfully" in create_site_entry
    assert re.search(r"required:\s*false", create_site_entry)


def test_create_site_is_gated_by_create_site_env(compose_text):
    block = _compose_service_block(compose_text, "create-site")
    assert '"$$CREATE_SITE" = "1"' in block
    assert "CREATE_SITE:-" in block


def test_frontend_relinks_app_assets_before_exec_nginx(compose_text):
    # The fix for the live Desk asset-404 previously existed only as a
    # hand-edited compose override on the server; the shipped template must
    # carry it so every deploy self-heals. The mounted sites volume can hold
    # a stale/dangling entry, so the link is forced at the image-side
    # apps/.../public, which resolves identically in every container.
    block = _compose_service_block(compose_text, "frontend")
    assert 'entrypoint: ["bash", "-c"]' in block
    command = "\n".join(_frontend_command_lines(block))
    assert "mkdir -p sites/assets" in command
    # A real directory at the target would make ln -sfn nest the link inside
    # it instead of replacing it; that case must be cleared explicitly first.
    assert (
        "if [ -d sites/assets/frappe_intelligence ] && [ ! -L sites/assets/frappe_intelligence ]" in command
    )
    assert "rm -rf sites/assets/frappe_intelligence" in command
    assert (
        "ln -sfn /home/frappe/frappe-bench/apps/frappe_intelligence/frappe_intelligence/public"
        " sites/assets/frappe_intelligence"
    ) in command
    assert "exec nginx-entrypoint.sh" in command
    # The re-link happens on every start, before nginx takes over.
    assert command.index("ln -sfn") < command.index("exec nginx-entrypoint.sh")


@pytest.mark.parametrize(
    "occupant",
    [
        "nothing",
        "dangling-symlink",
        "symlink-to-elsewhere",
        "real-directory",
    ],
)
def test_frontend_relink_command_establishes_a_working_link_whatever_occupies_the_target(
    tmp_path, compose_text, occupant
):
    # Runs the real frontend command out of the shipped compose template
    # against a throwaway bench tree (the image-side bench root is rewritten
    # to the tmp tree; the absolute path itself is pinned by the static test
    # above). Same occupant matrix as the site-init link test: the shipped
    # bug was a stale/dangling target surviving a "successful" start.
    command = "\n".join(_frontend_command_lines(_compose_service_block(compose_text, "frontend")))

    bench = tmp_path / "frappe-bench"
    public = bench / "apps" / "frappe_intelligence" / "frappe_intelligence" / "public"
    (public / "js").mkdir(parents=True)
    (public / "js" / "intelligence.js").write_text("// real bundle\n")
    target = bench / "sites" / "assets" / "frappe_intelligence"
    target.parent.mkdir(parents=True)

    if occupant == "dangling-symlink":
        target.symlink_to(tmp_path / "gone")
    elif occupant == "symlink-to-elsewhere":
        stale = tmp_path / "stale"
        stale.mkdir()
        target.symlink_to(stale)
    elif occupant == "real-directory":
        target.mkdir()
        (target / "leftover.txt").write_text("stale\n")

    marker = tmp_path / "nginx-exec-marker"
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    nginx_stub = stub_bin / "nginx-entrypoint.sh"
    nginx_stub.write_text(f'#!/usr/bin/env bash\nprintf "executed\\n" > "{marker}"\n')
    nginx_stub.chmod(0o755)

    script = command.replace("/home/frappe/frappe-bench", str(bench))
    done = subprocess.run(
        ["bash", "-c", script],
        cwd=bench,
        env={"PATH": f"{stub_bin}:/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert done.returncode == 0, done.stderr
    assert marker.is_file(), "nginx-entrypoint.sh must be exec'd after the re-link"

    served = target / "js" / "intelligence.js"
    assert served.is_file(), f"{occupant}: sites/assets/<app> still does not resolve"
    assert served.read_text() == "// real bundle\n"
    assert not (target / "leftover.txt").exists(), "stale contents must not survive"


# ---------------------------------------------------------------------------
# Cross-file consistency
# ---------------------------------------------------------------------------


def test_app_name_constant_matches_real_hooks_app_name(app_name, site_init_code, dockerfile_text):
    assert f'APP_NAME="{app_name}"' in site_init_code
    assert app_name in dockerfile_text


def test_docker_readme_exists_and_documents_env_vars():
    readme = DOCKER_DIR / "README.md"
    assert readme.is_file()
    text = readme.read_text()
    for var in (
        "SITE_NAME",
        "INTELLIGENCE_ALLOW_TESTS",
        "INTELLIGENCE_RUN_TESTS",
        "INTELLIGENCE_INIT_RESULT_PATH",
    ):
        assert var in text
    # Discussing why quay.io is avoided is fine; actually pointing at one isn't.
    assert "quay.io/frappe" not in text
