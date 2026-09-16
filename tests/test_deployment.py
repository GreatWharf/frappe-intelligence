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
from pathlib import Path

import pytest

DOCKER_DIR = Path(__file__).resolve().parent.parent / "docker"
DOCKERFILE = DOCKER_DIR / "Dockerfile"
SITE_INIT = DOCKER_DIR / "site-init.sh"
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
    get_app_lines = [line for line in dockerfile_code.splitlines() if "bench get-app" in line]
    assert get_app_lines, "expected an actual `bench get-app` instruction, not just a mention in comments"
    for line in get_app_lines:
        # The real app source is the local build context, not a git fetch.
        assert "http://" not in line
        assert "https://" not in line
        assert "git@" not in line
        assert "example.com" not in line
        assert "--soft-link" in line
        assert "/opt/frappe_intelligence_src" in line


def test_app_is_installed_editable_under_apps_directory(dockerfile_text):
    assert "/opt/frappe_intelligence_src" in dockerfile_text
    assert "--soft-link" in dockerfile_text, "editable install must use bench's local soft-link support"


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


def test_asset_build_step_present_and_stashed_outside_sites_volume(dockerfile_text):
    assert "bench build --app frappe_intelligence" in dockerfile_text
    # Must be copied somewhere other than under sites/, since sites/ is a
    # volume mount at runtime that would hide it.
    assert "/home/frappe/.intelligence-assets-cache" in dockerfile_text
    assert "sites/assets/frappe_intelligence" in dockerfile_text


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


def test_asset_step_prefers_symlink_then_always_rebuilds(site_init_code):
    assert "ln -s" in site_init_code
    assert 'run_bench build --app "$APP_NAME"' in site_init_code
    assert "assets_built" in site_init_code


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
