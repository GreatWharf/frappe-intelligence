# syntax=docker/dockerfile:1.7
#
# =============================================================================
# Frappe Intelligence -- application image
# =============================================================================
#
# Layers the frappe_intelligence app, installed EDITABLE, onto the official
# ERPNext image published by the Frappe team on Docker Hub (docker.io). This
# project builds and remote-tests against ERPNext v16 only -- never point
# ERPNEXT_VERSION at a quay.io (or any other) mirror, and do not assume any
# other line (v15, develop, ...) has been validated here.
#
# Build context: this repository's own git checkout (the frappe-intelligence
# app source), e.g. `docker build -f docker/Dockerfile .` run from the repo
# root. There is no `bench get-app <git-url>` network fetch during the build
# and no placeholder repository URL baked into the image -- the code that
# lands in apps/frappe_intelligence is exactly what was handed to the build
# as its context. For a real reviewed release, fetch the pinned commit from
# the authorized origin (git@github.com:GreatWharf/frappe-intelligence.git)
# *before* invoking `docker build`, and use that checkout as the context.
#
# Runtime site install/migrate/asset-repair is done separately, once per
# environment, by docker/site-init.sh. This image never creates, drops or
# migrates any site by itself, and never touches site credentials.
#
# Optionally, and only on explicit operator request (--build-arg
# WIKI_VERSION=<ref>, step 5 below), the upstream wiki app
# (github.com/frappe/wiki) is layered in as well, so the assistant's
# adaptive meta-tools can cover Wiki Page/Wiki Space like any other allowed
# DocType. The default build stays fully network-free either way.
# =============================================================================

# Generic rolling v16 tag by default, matching this project's only tested
# major line. For a reproducible/pinned deployment (recommended for anything
# beyond local iteration), pass the exact verified patch tag instead, e.g.:
#   docker build --build-arg ERPNEXT_VERSION=v16.34.2 -f docker/Dockerfile .
# Always resolve this ARG against docker.io/frappe/erpnext -- never quay.io.
ARG ERPNEXT_VERSION=version-16
FROM docker.io/frappe/erpnext:${ERPNEXT_VERSION}

# ARGs declared before FROM are out of scope afterwards; re-declare to use it
# in labels below.
ARG ERPNEXT_VERSION
LABEL org.opencontainers.image.title="frappe-intelligence" \
      org.opencontainers.image.description="Frappe Intelligence app layered on the official ERPNext v16 image" \
      org.opencontainers.image.base.name="docker.io/frappe/erpnext:${ERPNEXT_VERSION}" \
      org.frappe-intelligence.erpnext-target="v16-only" \
      org.frappe-intelligence.site-init="docker/site-init.sh"

# The base image already provides Python 3.14 (required by Frappe v16),
# Node/Yarn and pre-built frappe/erpnext assets, running as a non-root
# `frappe` user with an initialized bench at /home/frappe/frappe-bench. This
# build does not reinstall or reconfigure any of that -- it only adds one
# app on top.
USER frappe
WORKDIR /home/frappe/frappe-bench

# -----------------------------------------------------------------------------
# 1. Bring in the app source -- runtime files only. No tests/, docs/, dev/,
#    .github/, node_modules/, PRODUCT_BRIEF.md, IMPLEMENTATION_PLAN.md or VCS
#    metadata are copied here. If this build is ever changed to `COPY . .`,
#    add a root .dockerignore first (see docker/README.md for the exact
#    suggested contents -- this Dockerfile does not own the repo root).
# -----------------------------------------------------------------------------
COPY --chown=frappe:frappe pyproject.toml README.md LICENSE /opt/frappe_intelligence_src/
COPY --chown=frappe:frappe frappe_intelligence/ /opt/frappe_intelligence_src/frappe_intelligence/

# -----------------------------------------------------------------------------
# 2. Register the app with this bench as an EDITABLE install rooted at
#    apps/frappe_intelligence. `bench get-app --soft-link` assumes the source
#    is a git checkout and fails against the plain copied tree above, so the
#    registration is done directly instead: link the source into apps/,
#    editable-install it into the bench's own virtualenv, and record the app
#    in sites/apps.txt. This is exactly what get-app --soft-link would leave
#    behind, minus the git machinery that cannot work without a .git dir.
#    Asset compilation is deferred to step 4 (and again at runtime): the
#    "sites" volume mounted in every real deployment hides whatever bench
#    writes into sites/assets during this image build.
# -----------------------------------------------------------------------------
RUN ln -s /opt/frappe_intelligence_src apps/frappe_intelligence \
    && ./env/bin/pip install --quiet --editable apps/frappe_intelligence \
    && printf 'frappe\nerpnext\nfrappe_intelligence\n' > sites/apps.txt

# -----------------------------------------------------------------------------
# 3. The runtime Python dependency (pypdf) is pulled in automatically by the
#    editable install above via pyproject.toml's `dependencies`. Verify it
#    actually landed in the bench's own virtualenv and imports cleanly with
#    no Frappe site context, so a broken dependency fails this image build
#    instead of the first real deployment.
# -----------------------------------------------------------------------------
RUN ./env/bin/python -c "\
import frappe_intelligence, pypdf; \
assert frappe_intelligence.__version__; \
print('frappe_intelligence', frappe_intelligence.__version__, '/ pypdf', pypdf.__version__)"

# -----------------------------------------------------------------------------
# 4. Asset build. `bench build` needs a target app but no site, so it is safe
#    here, and it lets a broken frontend bundle fail this image build rather
#    than a live deployment. esbuild writes dist/ through sites/assets/<app>
#    into apps/frappe_intelligence/frappe_intelligence/public, and `apps/` is
#    part of the image rather than a volume mount, so the built bundle is
#    still there at runtime. Only the sites/assets/<app> link itself is lost
#    to the mounted volume; docker/site-init.sh re-creates it on start.
# -----------------------------------------------------------------------------
RUN bench build --app frappe_intelligence \
    && test -r apps/frappe_intelligence/frappe_intelligence/public/js/intelligence.js

# -----------------------------------------------------------------------------
# 5. OPTIONAL: Wiki app (https://github.com/frappe/wiki) -- off by default.
#    Everything above keeps this build hermetic: no network fetch of any
#    kind. Wiki is the one sanctioned exception, and only on explicit
#    operator request:
#      docker build --build-arg WIKI_VERSION=<ref> ...
#    where <ref> is a tag/branch of the upstream repo verified against
#    https://github.com/frappe/wiki/branches BEFORE the build. The
#    version-16 line is the candidate matching this image's ERPNext v16
#    target, but no ref is hardcoded here as an unverified guess. Unlike the
#    copied frappe_intelligence tree in step 2, this is a real git fetch, so
#    `bench get-app` -- the tool that cannot work there without a .git dir --
#    is exactly right here: it clones, pip-installs and records the app in
#    sites/apps.txt in one native step. --skip-assets defers to the explicit
#    `bench build --app wiki`, mirroring step 4, so a broken wiki bundle
#    fails this (opted-in) image build rather than a live deployment. At
#    deploy time docker/site-init.sh installs wiki onto the site behind its
#    INSTALL_WIKI gate. Default (unset): a pure log line; the image is
#    unchanged.
# -----------------------------------------------------------------------------
ARG WIKI_VERSION=""
RUN if [ -n "$WIKI_VERSION" ]; then \
        bench get-app --branch "$WIKI_VERSION" --skip-assets https://github.com/frappe/wiki.git \
        && bench build --app wiki; \
    else \
        echo "WIKI_VERSION unset: building without the wiki app (pass --build-arg WIKI_VERSION=<verified-v16-ref> to include github.com/frappe/wiki)."; \
    fi

# Site creation, `install-app` and `migrate` are intentionally NOT done here.
# Run docker/site-init.sh once per environment, with an explicit SITE_NAME,
# after the "sites" volume and the database/Redis services are ready. Use
# the same image unchanged for web, worker, scheduler and the site-init job.
COPY --chown=frappe:frappe docker/site-init.sh /home/frappe/frappe-bench/docker/site-init.sh
RUN chmod 0755 /home/frappe/frappe-bench/docker/site-init.sh
