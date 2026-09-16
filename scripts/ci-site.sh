#!/usr/bin/env bash
set -euo pipefail
: "${FRAPPE_BRANCH:?Set the tested Frappe branch}"
: "${GITHUB_WORKSPACE:?Run from the CI checkout}"
bench init --frappe-branch "$FRAPPE_BRANCH" --skip-redis-config-generation --skip-assets intelligence-bench
cd intelligence-bench
bench set-config -g redis_cache redis://127.0.0.1:13000
bench set-config -g redis_queue redis://127.0.0.1:11000
bench set-config -g redis_socketio redis://127.0.0.1:11000
bench get-app --branch "$FRAPPE_BRANCH" https://github.com/frappe/erpnext
bench get-app "$GITHUB_WORKSPACE"
bench new-site test.localhost --db-host 127.0.0.1 --db-root-username root --db-root-password test-root --admin-password test-admin
bench --site test.localhost install-app erpnext
bench --site test.localhost install-app frappe_intelligence
bench --site test.localhost set-config allow_tests true
bench --site test.localhost migrate
