# Basic TermAgent plugin example

This example is a declarative plugin package. It contains one Markdown
command and one Markdown skill, and can be copied into a disposable project
for local testing.

```text
example-review/
├── .claude-plugin/plugin.json
├── commands/check.md
└── skills/review/SKILL.md
```

The package contains no executable JavaScript. Marketplace-installed plugin
packages are loaded through the declarative component boundary.
