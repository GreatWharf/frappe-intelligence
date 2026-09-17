# Contributing

Thanks for helping improve Intelligence. This project is unofficial and community-maintained.

## Ground Rules

- **No real secrets anywhere.** Tests, fixtures, issues, and pull requests must use synthetic placeholder values only. Never commit or paste a real API key, provider credential, chat export, or customer record.
- **Keep pull requests scoped.** One concern per PR. Describe what changed and why, and reference the issue it closes when there is one.
- **Match the existing style.** Follow the conventions already in the codebase and the test doubles in `tests/`.

## Before You Open a PR

Run the test suite and the linter from the repository root:

```bash
python -m pytest tests/
ruff check .
```

Both must pass. Add or update tests for any behavior change: a new test should fail before your fix and pass after it.

## Security Issues

Do not open public issues or PRs for vulnerabilities. See [SECURITY.md](SECURITY.md) for private reporting through GitHub Security Advisories.

## License

By contributing, you agree that your contributions are licensed under the project's [MIT license](LICENSE).
