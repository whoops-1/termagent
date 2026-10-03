# Phase 6: Plugin / Marketplace / Skill TUI

TermAgent 1.13 adds terminal-native management screens for the plugin marketplace stack.

## Entry points

Interactive commands:

- `/plugins` opens the installed plugin manager.
- `/marketplace` opens registered marketplace browsing.
- `/marketplace <query>` starts with a marketplace search filter.
- `/skills` opens the discovered skill browser.
- `/skills <query>` starts with a skill search filter.

The same manager can switch sections with `1`, `2`, and `3`.

## Plugin manager

The plugin screen shows installed plugin state, including enabled, disabled, broken, orphaned, and update-available conditions. Rows also show compact component counts for commands, agents, skills, MCP servers, and hooks.

Plugin details show marketplace, version, revision, digest, installation path, component totals, and the most recent failure reason. Installed plugins can be enabled/disabled, updated, or removed. Destructive removal is confirmed separately.

## Marketplace browser

The marketplace screen shows the registered source, status, revision, digest, update time, owner, and description. Entering a marketplace exposes its available plugins.

Marketplace plugin browsing has its own selection cursor and search filter. Plugin detail shows source, version, category, tags, description, and installed state. Installing or updating from the marketplace always enters an explicit trust confirmation screen first.

At 60x20, the marketplace detail view intentionally compresses metadata to source, status, revision, and digest so the plugin list remains usable. At 80x24, owner, updated time, plugin count, and description are also displayed.

## Skill browser

The skills screen consumes the Phase 3 descriptor catalog. Rows contain the descriptor identity and provenance. Enter loads the detailed record so the UI can show the skill source, plugin provenance, version, SHA-256 digest, path, and frontmatter warnings.

The full skill body is not displayed by the browser, preserving the descriptor-first runtime architecture from Phases 3-4.

## Input and interaction

The plugin manager is a blocking `TerminalUI` modal. While it is active, prompt editing is disabled and the manager owns stdin. Closing it restores the previous raw-mode/editor state.

Keyboard navigation supports arrows, `j/k`, Home/End, PageUp/PageDown, Enter, `/` search, Backspace, Escape, and section shortcuts. Mouse clicks select list rows and open details. Mouse wheel input moves selection by bounded steps.

The input parser handles SGR mouse packets, legacy X10 mouse packets, and split CSI/SGR sequences. Incomplete packets are buffered so packet bytes cannot be mistaken for ordinary section-switch or search input.

## Visual QA

Phase 6 was checked with generated ANSI frames rendered to PNG at:

- 60x20 plugin list
- 80x24 plugin detail
- 60x20 trust confirmation
- 80x24 skill detail
- 80x24 marketplace detail
- 80x24 marketplace plugin detail
- 60x20 marketplace detail
- 60x20 removal confirmation

The first small-terminal marketplace frame revealed excessive metadata density and plugin-list truncation. The narrow layout was then changed to preserve source/revision/digest while prioritizing the available-plugin list and footer.

## Phase boundary

Phase 6 is presentation and interaction only. Marketplace/plugin persistence remains in the Phase 2 services, component activation remains in Phase 5, and deeper trust/integrity/revocation hardening remains Phase 7.

### Screenshot artifacts

The committed visual-QA frames are under `docs/assets/phase6/`. The overview is `phase6-ui-qa-overview.png`; individual frames retain their terminal dimensions in the filenames.
