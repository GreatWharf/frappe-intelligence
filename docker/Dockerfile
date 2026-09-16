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
#    apps/frappe_intelligence, using bench's own local-path support -- the
#    same command already documented in docs/operations.md for local dev
#    benches -- rather than a hand-run `pip install -e` or a
#    `bench get-app <git-url>` that would need network/SSH access during the
#    image build itself.
#
#    --soft-link makes apps/frappe_intelligence a symlink to the copied
#    source above, which is what makes the install editable in place.
#    --skip-assets defers asset compilation to step 4 below (and again at
#    runtime): the "sites" volume mounted in every real deployment hides
#    whatever bench writes into sites/assets during this image build, so
#    building here is only a build-time correctness check, never the
#    deployed copy.
#
#    This is a plain `bench get-app`, never `bench execute` / a get_attr
#    lookup on frappe_intelligence: bench's `execute` command refuses to
#    resolve a dotted path belonging to an app that is not yet installed on
#    the target site, and no site exists at image-build time regardless.
#    Site-level installation happens later, natively, via
#    `bench install-app` in docker/site-init.sh.
# -----------------------------------------------------------------------------
RUN bench get-app --skip-assets --soft-link /opt/frappe_intelligence_src frappe_intelligence

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
# 4. Best-effort asset build + stash. `bench build` needs a target app but no
#    site, so it is safe here, and it lets a broken frontend bundle fail this
#    image build rather than a live deployment. The output is also copied to
#    a path OUTSIDE `sites/` -- which is a bind/named volume at runtime and
#    will hide whatever this step writes into sites/assets -- so
#    docker/site-init.sh can restore it with a symlink instead of forcing a
#    full Yarn/esbuild rebuild on every container start of every environment.
# -----------------------------------------------------------------------------
RUN bench build --app frappe_intelligence \
    && mkdir -p /home/frappe/.intelligence-assets-cache \
    && rm -rf /home/frappe/.intelligence-assets-cache/frappe_intelligence \
    && cp -a sites/assets/frappe_intelligence /home/frappe/.intelligence-assets-cache/frappe_intelligence

# Site creation, `install-app` and `migrate` are intentionally NOT done here.
# Run docker/site-init.sh once per environment, with an explicit SITE_NAME,
# after the "sites" volume and the database/Redis services are ready. Use
# the same image unchanged for web, worker, scheduler and the site-init job.
COPY --chown=frappe:frappe docker/site-init.sh /home/frappe/frappe-bench/docker/site-init.sh
RUN chmod 0755 /home/frappe/frappe-bench/docker/site-init.sh
