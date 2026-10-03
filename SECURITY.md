# Security Policy

## Reporting a vulnerability

Please do not disclose an unpatched vulnerability in a public issue.

Use the repository's private security-reporting mechanism when available, or contact the project maintainers through the private security channel listed by the repository owner.

Include:

- affected version or commit
- reproduction steps
- expected and observed behavior
- impact
- any known mitigation

Do not include secrets that are not required to reproduce the problem.

## Credential handling

Provider API keys should be supplied through environment variables or local configuration that is excluded from source control. Never place live credentials in source files, tests, examples, logs, screenshots, or bug reports.
