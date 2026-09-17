# Changelog

All notable changes to Intelligence are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app versions with [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-09-17

### Added

- Adaptive data-model tools: the assistant can list, describe, and query administrator-allowlisted DocTypes, and can draft document create and update proposals that execute only after explicit approval.
- Skills view in the Intelligence workspace, showing the tools and capabilities available to the assistant under the current configuration.
- Scope configuration, letting administrators control which DocTypes and capabilities the assistant may reach.
- Approval queue, so pending proposals can be reviewed, approved, or rejected from one place with their before/after diffs.

### Fixed

- Provider-kind handling: configured providers now resolve to the correct adapter kind instead of misclassifying custom OpenAI-compatible endpoints.
- Deploy hardening: site initialization now force-links `sites/assets/<app>` so stale or dangling symlinks from a previous container generation can no longer leave the Desk serving 404s for app assets, and every advertised asset path is verified after the build.
