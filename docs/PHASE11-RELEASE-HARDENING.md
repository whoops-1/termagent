# Phase 11: Release hardening, migration, diagnostics, and lifecycle verification

Phase 11 closes the plugin and skill rollout with four practical guarantees:
existing users keep their state, diagnostics explain what the runtime sees,
authors get documented reference packages, and the complete lifecycle is
exercised outside the unit-test happy path.

## Migration model

TermAgent uses **adoption instead of destructive relocation** for legacy
state. Existing project and global skill roots remain readable:

```text
project/.termagent/skills/
project/.claude/skills/
$HOME/.termagent/skills/
$HOME/.claude/skills/
```

Existing legacy executable plugins under `.termagent/plugins/` also remain
supported by the compatibility loader. The migration records which roots and
plugin files were observed, but it does not move or delete those files.

Legacy configuration aliases are normalized into the canonical settings:

| Legacy key | Canonical key |
| --- | --- |
| `pluginDirs` | `plugins` |
| `pluginPaths` | `plugins` |
| `pluginDirectories` | `plugins` |
| `plugin` | `plugins` |
| `skillDirs` | `skillPaths` |
| `skills` (string array) | `skillPaths` |
| `skill` | `skillPaths` |

A copy of a changed project or global config is written alongside the original as:

```text
.termagent/config.json.pre-phase11.bak
```

For a global config, the backup is `~/.termagent/config.json.pre-phase11.bak`.

Migration state is stored separately in:

```text
~/.termagent/migrations.json
```

The write is atomic and the migration is idempotent. A migration failure does
not cause TermAgent startup to discard or relocate legacy content.

## Diagnostics

`/doctor` and `termagent --doctor` report grouped health information for:

environment, configuration, migration, marketplace state, installed plugin
state, plugin security policy, pure skill registries, the skill catalog, and
private storage permissions.

Machine-readable output is available from the interactive command:

```text
/doctor --json
```

The non-interactive CLI mode accepts the same form:

```text
termagent --doctor --json
```

Diagnostics deliberately do not perform remote marketplace or registry
refreshes. A health command should describe state, not surprise the user with
network traffic.

## Authoring references

Plugin authors: [`AUTHORING-PLUGINS.md`](./AUTHORING-PLUGINS.md)

Skill authors: [`AUTHORING-SKILLS.md`](./AUTHORING-SKILLS.md)

Minimal examples:

- [`examples/plugin-basic`](./examples/plugin-basic/)
- [`examples/skill-basic`](./examples/skill-basic/)

The plugin example uses `.claude-plugin/plugin.json`, a Markdown command, and
a plugin-local skill. The pure skill example is intentionally free of
executable behavior.

## End-to-end lifecycle fixture

`tests/phase11-end-to-end.test.mjs` drives this sequence against a disposable
local marketplace and isolated home/project directories:

```text
install → enable → discover → use → update → disable → remove
```

The fixture verifies both positive and negative transitions. In particular,
a disabled plugin must stop contributing discoverable skills, an update must
become active only after successful replacement, and removal must erase the
installed-state record and catalog entry.

## Release gate

A Phase 11 release is accepted only after all of these pass:

```text
npm run build
npm test
phase11 focused tests
release-hardening tests
npm pack --dry-run
source-hygiene scan
actual npm package extraction + smoke
final ZIP extraction + smoke
```

The release workspace must not contain `node_modules`. The extracted artifact
is tested separately from the source workspace so a successful local build
cannot hide packaging mistakes.
The migration and diagnostics structure follows the same broad reference
patterns researched for this project: one-shot migrations that transform
persistent settings without deleting user content, diagnostics that report
runtime health, and skill distribution that keeps metadata/discovery separate
from body loading. The actual TermAgent implementation remains dependency-light
and native to its existing Node/ANSI architecture.
