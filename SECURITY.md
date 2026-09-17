# Security Policy

Intelligence handles provider API keys and ERP business data, so we take vulnerability reports seriously.

## Reporting a Vulnerability

**Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/GreatWharf/frappe-intelligence/security/advisories/new).** Do not open a public issue for a security problem.

Please include:

- A description of the vulnerability and its likely impact.
- Steps to reproduce, against a test site, with synthetic data only.
- The version or commit you tested.

We aim to acknowledge reports within a few days and to coordinate a fix and disclosure timeline with the reporter.

## What Never Belongs in a Report or Issue

Never paste real API keys, provider credentials, chat exports, bank statements, or customer data into any issue, discussion, pull request, or advisory. Reproduce with synthetic placeholder values only. If a real secret has been exposed anywhere, rotate it first, then report.

## Secrets Handling in the App

- Provider API keys are encrypted with Frappe's password facilities and used only server-side. The UI never returns them, and blank updates preserve stored keys.
- Provider traffic goes only to fixed vendor URLs or administrator-allowlisted custom HTTPS hosts, over pinned, validated TLS with no redirect or proxy following.
- Using a remote model sends approved context to that provider; review your provider's terms before enabling one.

The full trust model, authorization design, and data boundaries are documented in [docs/security.md](docs/security.md).

## Scope

Only the latest release line is supported with security fixes. Intelligence is an unofficial, community-maintained app; no penetration-test or production-security certification is claimed.
