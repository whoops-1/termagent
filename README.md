# TermAgent

> A terminal-first coding agent for Node.js, Termux, and ARMv7 Android.

TermAgent is a lightweight coding agent that brings persistent sessions, tool use,
repository-aware context, multiple model providers, plugins, MCP, sub-agents,
and a responsive terminal UI into one Node.js CLI.

It is designed for environments where heavy native runtimes are a bad bargain,
especially Termux on older Android devices.

## Install

### npm

```sh
npm install -g termagent@latest
termagent
```

TermAgent requires **Node.js 22 or newer**.

### From a local checkout

```sh
npm install
npm run build
npm link
termagent
```

### Termux / Android

TermAgent is intentionally Node-only at runtime. It does not require an extra terminal UI runtime, `node-pty`, SQLite native addons, or architecture-specific `.node`
modules.

For a prebuilt release bundle, the release system selects a target-specific
archive first and falls back to a source build when no compatible prebuilt is
available.

After installation on the device:

```sh
termagent-device-smoke
```

This checks the Node version, platform/architecture, startup path, and the
absence of native production addons.

## Quick start

Start TermAgent in any repository:

```sh
termagent
```

Inside the terminal UI, use `/provider` to configure a model, `/theme` to select
a visual theme, and `/help` to see the full command surface.

You can also start directly with a saved session:

```sh
termagent --resume <session-id>
```

For scripting or integrations, TermAgent can expose a local HTTP/SSE service:

```sh
termagent --serve
```

## Why TermAgent

### One terminal workflow

The same session can inspect files, search the repository, edit code, run shell
commands, call MCP tools, delegate bounded tasks, verify changes, and keep the
conversation on disk.

### Model-neutral providers

TermAgent supports OpenAI-compatible endpoints plus native provider adapters for
OpenAI, Anthropic, and Gemini. Provider profiles can be switched during a session,
and routing can separate planning, building, verification, and specialist work.

### Repository-aware context

The repository map combines file structure, symbols, imports, references,
content retrieval, and bounded context budgets. Cached structural data is kept
outside the project and remains dependency-light for Termux.

### Persistent sessions

Sessions are stored as JSONL event streams with resumable conversation state.
TermAgent also supports checkpoints, restore, branching, undo/redo, durable tasks,
and prompt queues.

### Coding-agent tools

The built-in tool surface includes file read/write/edit, grep, glob, shell,
git, repository mapping, todo management, verification, tasks, questions,
background work, sub-agents, and MCP.

### Interactive TUI

The terminal interface is state-driven and keyboard-first, with:

- multiline editing, history, paste, completion, and Vim-style editing
- independent transcript scrolling and tool/reasoning inspectors
- semantic command/model/theme pickers with keyboard and mouse support
- permission and question dialogs
- responsive composer and status surfaces
- queued prompts while the agent is working
- semantic Markdown rendering with tables and code blocks
- responsive banners, themes, and banner-only ambient effects

Normal input stays available while the agent works. Only the explicit interrupt
control cancels the active turn.

## Sessions and queues

Prompt state belongs to the session runtime rather than the renderer. A prompt can
be draft, queued, executing, completed, cancelled, or failed.

Queued prompts can be inspected, edited, reordered, or removed. When the active
turn finishes, the next queued prompt is executed automatically.

Useful commands:

```text
/sessions
/resume <id>
/checkpoints
/checkpoint
/restore <id>
/queue
/queue prompt <text>
/queue clear
```

## Agent modes

Use:

```text
/build
/plan
/explore
```

Build can modify the project. Plan and Explore are read-only modes.

`/auto <task>` runs a bounded autonomous workflow that can inspect, plan,
implement, verify, recover from failures, and stop on semantic no-progress.

## Providers

The simplest setup is the interactive provider manager:

```text
/provider
```

Provider configuration can also come from the environment. For OpenAI-compatible
services, the commonly used variables are:

```sh
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=...
```

Configured provider profiles, fallbacks, variants, routing, and smart routing live
in the normal TermAgent configuration rather than inside the transcript.

## Plugins, marketplaces, and skills

TermAgent supports JavaScript plugins and declarative marketplaces with integrity,
trust, dependency, update, and lifecycle controls.

Pure skill registries are separate from executable plugins and use descriptor-first
discovery with SHA-256 integrity pins and stale-cache protection.

Useful commands include:

```text
/plugins
/marketplace
/skills
/skill-registry
/doctor
```

Authoring guides and examples live under `docs/`.

## Headless API

Run the local service with:

```sh
termagent --serve
```

Optional host, port, and token settings are available through the CLI and
`TERMAGENT_SERVER_*` environment variables.

Health check:

```sh
curl http://127.0.0.1:4096/health
```

The service exposes sessions, prompts, messages, events, tasks, models, agents,
skills, tools, diffs, checkpoints, and streaming events. The `termagent/client`
export provides a typed JavaScript client for the API.

## Safety and reliability

TermAgent keeps runtime state and presentation state separate. Important runtime
boundaries include:

- bounded shell output and UTF-8-safe truncation
- process-group cleanup and descendant termination on POSIX
- timed managed stdin writes
- bounded task workers and recursive cancellation
- provider retry limits and stream-idle detection
- semantic repeated-tool/no-progress guards
- explicit permission gates for shell, filesystem, Git, MCP, and external paths
- asynchronous LSP diagnostic truth states
- durable task, queue, checkpoint, and verification events

## Mobile release path

Release artifacts are target-labelled for:

```text
android-armv7
android-arm64
linux-armv7
linux-arm64
linux-x64
```

Release builds produce deterministic archives, `SHA256SUMS`, and a release
manifest. The installer prefers a checksum-verified prebuilt archive and uses a
source-build fallback when necessary.

Build a local release set with:

```sh
npm run release:build
```

Run the real device check with:

```sh
npm run device:smoke
```

## Development

```sh
npm install
npm run build
npm test
npm run device:smoke
```

For focused work, run the relevant test file directly:

```sh
node --test tests/<focused-test>.test.mjs
```

The repository contains phase reports, architecture notes, research records, and
UI verification material for the larger implementation history.

## Documentation

- `SETUP.md` — provider and local setup
- `ARCHITECTURE.md` — runtime and UI boundaries
- `RESEARCH.md` — TermAgent research and design rationale
- `docs/DEVICE_TEST.md` — Termux/ARMv7 verification procedure
- `docs/AUTHORING-PLUGINS.md` — plugin authoring
- `docs/AUTHORING-SKILLS.md` — pure-skill authoring

## Project status

The current 13N line is focused on hardening the terminal runtime, mobile process
lifecycle, and release path before the planned multi-client Web View work.

Phase 13N-J includes process lifecycle hardening plus Android/ARMv7 release
engineering. The remaining rollout gate is physical execution on a real Termux
ARMv7 device.

## License

MIT.
