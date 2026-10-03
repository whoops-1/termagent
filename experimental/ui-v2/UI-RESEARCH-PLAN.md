# TermAgent Experimental UI/UX Research & Implementation Plan

## Scope

## Merge status

The UI experiment has now been merged into production. The production renderer is the source of truth; this experimental track remains for deterministic renderer fixtures and visual regression snapshots. The merge deliberately keeps the existing TermAgent state machine, providers, tools, persistence, and server architecture intact.

This work is a UI/UX-only experimental track for TermAgent 1.18.0.

Production `src/`, `dist/`, agent runtime, providers, tools, persistence, plugins, skills, and server APIs remain untouched until the experimental UI is approved.

The renderer target is **Node + ANSI/VT only**, optimized for Termux/mobile terminals and 32-bit ARMv7. The experiment must not introduce a heavyweight terminal UI framework, React, Ink, native UI runtimes, or other heavyweight/native dependencies.

## Primary visual references

Two terminal applications are being studied:

1. the implementation: interaction model, message presentation, markdown rendering, code highlighting, tables, prompt/footer composition, picker/dialog design, loading animation, welcome/logo presentation, and goodbye/resume flow.
2. the implementation: terminal layout system, theme model, modal/dialog composition, command palette, selection lists, prompt surface, startup loading, spinner animation, logo, transcript/tool presentation, and theme discovery/system-theme behavior.

The goal is not to reproduce either product pixel-for-pixel. The goal is to identify the reusable interaction and presentation techniques already proven in those codebases and express them using TermAgent's existing ANSI/VT architecture.

## Current TermAgent baseline

Current the relevant TermAgent subsystem already contains:

- `ui.ts`: main TerminalUI state machine and frame renderer
- `renderer.ts`: non-interactive ANSI helpers
- `repl.ts`: interactive execution wiring
- `input.ts`: terminal input decoding / raw-mode behavior
- `keybinds.ts`: command bindings
- `history.ts`: prompt history
- `prompt-queue.ts`: queued prompts
- `tui/text-input.ts`: logical/visual prompt layout and cursor state
- `tui/select.ts`: renderer-agnostic selection model
- `tui/plugin-manager.ts`: plugin marketplace UI state/rendering

Important constraint: existing UI behavior is already covered by the Phase 11 regression suite. The new UI must preserve the underlying state ownership and interaction semantics instead of replacing them with a second application architecture.

## Visual diagnosis from supplied screenshots

The supplied screenshots show a clear visual gap between the existing UI model and the current TermAgent UI.

### Current TermAgent problems

- Markdown is displayed mostly as raw source punctuation: `#`, `*`, `-`, pipes, code fences, etc.
- Code blocks lack a distinct container, language label, syntax highlighting, and readable spacing.
- Tables are visually dense and read like raw terminal text rather than a structured component.
- Diff output dominates the viewport without enough hierarchy around the operation that produced it.
- The application has weak persistent branding and no strong startup/welcome identity.
- Activity/status presentation is functional but visually generic.
- Prompt/footer has too much visual competition with the conversation.
- Color is currently mostly hard-coded per element rather than driven by a coherent semantic theme.
- Modal surfaces use broad full-width fills but have limited hierarchy compared with the existing interfaces.
- There is little use of subtle motion to communicate active work.


- Strong visual hierarchy between user input, assistant output, tool activity, and secondary metadata.
- Dedicated, readable code blocks instead of raw fenced markdown.
- Dedicated table layout with width-aware wrapping.
- Distinct selection/active states in command and dialog lists.
- A recognizable application logo/banner at startup or home state.
- Loading/working indicators that continuously reassure the user that work is progressing.
- Status text that changes with the execution phase.
- Theme-driven semantic colors rather than scattered terminal color constants.
- Dialogs/pickers that preserve input focus and clearly communicate keyboard controls.
- Footer hints that adapt to the current context instead of remaining static.
- Compact but useful tips and transient messages.
- Explicit goodbye/resume guidance at session exit.

## Research workstreams

### 1. Terminal layout architecture

Study how the implementation separates:

- top-level application/root layout
- session transcript
- prompt/input surface
- footer/status area
- modal/dialog stack
- command palette
- startup loading
- theme context

Study how the implementation separates:

- message components by message type
- prompt input and footer
- design-system primitives
- modal/dialog primitives
- message-specific renderers

Translate these into a small TermAgent renderer layer rather than introducing a component framework.

### 2. Semantic theme system

Research the implementation thatme schema and TermAgent's design-system/theme provider.

Target TermAgent semantic tokens such as:

- background
- panel/background-panel
- surface/background-element
- primary
- secondary
- accent
- text
- muted text
- border
- active border
- success
- warning
- error
- info
- user message
- assistant message
- tool activity
- reasoning
- selection
- diff added/removed/context
- markdown heading
- markdown link
- inline code
- code block
- syntax token categories

The renderer should consume semantic tokens. Individual UI elements should not invent their own unrelated ANSI colors.

### 3. Theme formats and persistence

Research TermAgent's JSON theme structure and theme lifecycle:

- built-in themes
- custom theme files
- semantic theme fields
- dark/light mode
- terminal/system theme detection
- selected-item contrast
- theme refresh
- plugin/custom theme registration

For TermAgent's ANSI renderer, define a small serializable theme representation compatible with:

- ANSI 16-color mode
- ANSI 256-color mode
- truecolor where supported
- terminal-native/default colors where useful

Do not require truecolor for correctness.

Initial experiment should ship with a small curated set of themes and one terminal-native/default theme. More themes can be added after the rendering architecture is stable.

### 4. Markdown renderer

Study TermAgent's `Markdown.tsx` and `utils/markdown.ts`.

Key implementation concepts to reproduce:

- parse markdown into block/inline tokens
- render headings with hierarchy
- render bold and italic text
- render inline code distinctly
- render unordered and ordered lists
- render blockquotes with a visual bar
- render horizontal rules
- render links cleanly
- render code blocks separately from normal text
- keep tables as a dedicated rendering path

The ANSI implementation should use a lightweight Markdown parser strategy suitable for the current dependency constraints. Start with the subset users actually encounter in coding-agent responses and add edge cases through tests.

### 5. Code block rendering and syntax highlighting

Research TermAgent's `cliHighlight.ts` and code-token styling.

The TermAgent experimental renderer should support:

- fenced code blocks
- language labels when provided
- readable indentation
- terminal-width-aware wrapping or horizontal clipping policy
- syntax highlighting when language is known
- graceful plaintext fallback when highlighting is unavailable
- visually separated code-block background or frame

Because the current production package intentionally has no runtime dependencies in `package.json`, the first experiment should investigate a dependency-free/lazy strategy before adding a package. Any dependency addition must be justified by size, ARMv7 compatibility, startup impact, and data cost for Termux users.

### 6. Tables

Research TermAgent's `MarkdownTable.tsx`.

Reproduce the behavioral ideas:

- calculate minimum and ideal column widths
- account for terminal width
- wrap cell content
- preserve visible width around ANSI sequences
- align columns according to markdown alignment
- fall back to a vertical/key-value presentation when a narrow terminal makes the horizontal form unreadable
- avoid overflow during terminal resize races

The TermAgent table renderer must never emit lines wider than the current terminal width.

### 7. Message hierarchy

Research the implementation message components and TermAgent's session timeline.

Design a semantic transcript with clearly distinguishable:

- user turns
- assistant response
- reasoning summary
- tool start/running/completed
- permission waiting
- question waiting
- errors/warnings/system messages
- compact change summaries

The main transcript should remain sparse. Large tool payloads, full reasoning, and complete diffs stay in inspectors as they do today.

### 8. Activity and animations

Research the implementation spinner components:

- `SpinnerGlyph`
- `SpinnerAnimationRow`
- `GlimmerMessage`
- `ShimmerChar`
- stalled/long-running state handling

Research the implementation spinner/startup behavior and animated background/pulse patterns.

TermAgent should introduce restrained ANSI animations such as:

- spinner glyph while working
- subtle shimmer/animated emphasis for the active status text
- elapsed time after a configurable delay
- completion flash or subtle completion marker
- compact startup/loading indicator

Animation must:

- be timer-driven, not blocking
- stop when idle
- stop cleanly on resize/exit
- tolerate slow mobile terminals
- degrade to static indicators when ANSI/color/motion is unavailable

### 9. Prompt/input surface

Study the implementation `BaseTextInput` and PromptInput components and the prompt system/context design.

Preserve TermAgent's existing logical/visual input separation:

`value -> cursor -> visual layout -> viewport -> ANSI frame`

Upgrade presentation only:

- stronger prompt identity
- clearer multiline input surface
- active cursor treatment
- contextual mode/model metadata
- contextual shortcut/footer hints
- visual treatment for pasted text, queued input, commands, and selected completion

Do not change the already-hardened input parser or interrupt behavior unless a UI-only change explicitly requires it and the existing regression tests are preserved.

### 10. Picker / command palette / dialogs

Research:

- the implementation `FuzzyPicker`, `ListItem`, dialog components
- the implementation `Dialog`, `DialogSelect`, `CommandPaletteDialog`

Target reusable ANSI primitives:

- modal frame
- title/subtitle
- search field
- selectable rows
- category headers
- current-item marker
- focused/selected row
- descriptions
- shortcut footer
- scroll window
- empty-result state

The picker must preserve the current global-selection-index behavior so navigation does not wrap from item 8 back to item 1 merely because only 8 rows are visible.

### 11. Banner/logo/startup experience

Research TermAgent's welcome/logo components and TermAgent's `logo.ts` + startup-loading component.

TermAgent will get its own identity rather than copying an copied logo.

The design target is a small, crisp ANSI/Unicode banner that:

- fits narrow mobile terminals
- has a static fallback
- supports themed color
- does not dominate the screen after startup
- can show version/model/context metadata around it

Startup should have a brief, unobtrusive loading transition when useful.

### 12. Tips and microcopy

Study how existing interfaces use transient contextual tips and shortcut hints.

TermAgent tips must be local and functional, for example:

- keyboard shortcut discovery
- slash-command discovery
- inspector hints
- session resume hint
- narrow-terminal navigation hint

Do not make tips noisy, repetitive, or dependent on network data.

### 13. Exit / goodbye / session resume

Research the implementation exit flow and session resume presentation.

TermAgent exit should render a small goodbye state and the exact resume command format:

`termagent --resume <session_id>`

The session ID must come from the current session state. No fake/example ID may be inserted by the renderer.

### 14. Terminal capability handling

Research how theme behavior/renderers behave under different terminal capabilities.

TermAgent should detect/support at minimum:

- ANSI support
- 256-color support
- truecolor support when available
- Unicode width assumptions
- small terminal dimensions
- terminal resize
- color-disabled mode
- reduced-motion/static fallback

All rendering paths must degrade gracefully to readable text.

## Proposed experimental renderer architecture

Keep the existing `TerminalUI` as the state owner.

Introduce a UI-only rendering layer under:

```text
experimental/ui-v2/
  src/cli/
    ui.ts                 # experimental replacement candidate
    renderer.ts            # semantic ANSI/color helpers
    tui/
      text-input.ts        # baseline implemented from TermAgent production
      select.ts            # baseline implemented from TermAgent production
      ...                  # new UI primitives as needed
  UI-RESEARCH-PLAN.md
```

The first implementation may add submodules for:

```text
ansi.ts
colors.ts
theme.ts
types.ts
markdown.ts
code-block.ts
table.ts
banner.ts
spinner.ts
status.ts
transcript.ts
modal.ts
picker.ts
footer.ts
```

These modules are presentation-only. They must receive already-established UI state and return ANSI/VT frames or renderable line structures.

## Rendering model

Use a deterministic frame pipeline:

```text
TerminalUI state
    -> semantic view model
    -> theme resolution
    -> block/row rendering
    -> width clipping/wrapping
    -> ANSI/VT frame diff
    -> terminal
```

Do not let individual widgets write directly to stdout.

The renderer must continue using the existing absolute-row frame strategy so stale terminal content is cleared correctly after resize, scrolling, modal transitions, and collapsing/expanding inspectors.

## Implementation order after research

### Stage A - visual foundations

1. Semantic theme/token system
2. ANSI helper and width-safe styling
3. Banner/logo
4. Layout primitives: padding, borders, separators, panels, selected rows
5. Footer/status hierarchy

### Stage B - response presentation

6. Markdown block parser/rendering
7. Code blocks
8. Syntax highlighting strategy
9. Tables
10. Links/inline code/quotes/lists

### Stage C - conversation hierarchy

11. User message block
12. Assistant message block
13. Tool activity rows
14. Reasoning indicator/inspector presentation
15. Diff summary presentation
16. Error/warning/system rows

### Stage D - interaction surfaces

17. Picker redesign
18. Command palette redesign
19. Permission dialog redesign
20. Question dialog redesign
21. Provider/plugin modal visual refresh
22. Inspector visual refresh

### Stage E - motion and micro-interactions

23. Spinner
24. Active-work shimmer/glimmer
25. Elapsed timer
26. Completion transition
27. Startup loading
28. Contextual tips
29. Goodbye/resume screen

### Stage F - visual QA and compatibility

30. PTY screenshot harness for every major state
31. 60x20 and 80x24 minimum-size reviews
32. narrower mobile widths
33. resize during active streaming
34. picker navigation beyond visible viewport
35. mouse/touch events during active turns
36. modal open/close transitions
37. code/table/markdown width stress tests
38. ANSI capability fallbacks
39. long-response performance tests

## Testing strategy

Existing tests remain the baseline and must continue to pass unchanged.

Experimental tests should be added alongside, not mixed into production tests until merge approval.

### Unit-level

- ANSI width calculation
- strip/measure/reapply formatting
- theme token resolution
- color capability conversion
- markdown token rendering
- list nesting
- code fences/language fallback
- table width calculation
- table vertical fallback
- spinner frame progression
- banner width
- selected-row rendering
- footer wrapping

### PTY-level

Capture actual terminal frames for:

- startup
- empty home screen
- user prompt
- multiline prompt
- assistant markdown
- heading/list/blockquote
- inline code
- code block
- long code block
- table
- narrow table
- running tool
- completed tool
- permission dialog
- question dialog
- command picker
- command palette
- reasoning summary + inspector
- diff summary + inspector
- error
- resize during streaming
- scroll position changes
- exit/goodbye

### Performance

Measure:

- initial render latency
- frame generation latency on long responses
- allocations for repeated streamed deltas
- spinner timer overhead
- markdown parse cost
- table layout cost

The renderer should favor stable incremental work. TermAgent's markdown implementation explicitly caches parsed blocks and uses a streaming-specific stable-prefix strategy; this is worth adapting rather than re-parsing an entire long response on every token.

## Release gate for merging into TermAgent 1.18.0

The experimental UI is not merged merely because it looks attractive.

It must satisfy all of the following:

1. Existing production behavior and backend state flow remain intact.
2. Existing tests remain green.
3. Experimental PTY tests pass at 60x20 and 80x24.
4. No screen state overflows terminal width.
5. No mouse/touch interaction accidentally interrupts active model turns.
6. Picker navigation preserves the full selection range.
7. Markdown renders semantically instead of showing raw markdown syntax.
8. Code blocks are visually distinct and readable.
9. Tables remain readable at narrow widths.
10. Theme changes apply consistently to transcript, prompts, modals, inspectors, and status elements.
11. Animations degrade safely and do not keep the process alive after exit.
12. Startup, active-work, completion, and exit states have a coherent visual language.
13. `termagent --resume <session_id>` is shown using the real current session identifier.
14. The UI remains usable on Termux/mobile dimensions.
15. Any new dependency is demonstrably compatible with the project's ARMv7/Termux and lightweight-runtime constraints.

## Research references



Primary files studied:
Key findings:

- Markdown is tokenized and formatted rather than printed raw.
- Tables have a dedicated width-aware renderer.
- Code highlighting is lazy-loaded and has language detection/fallback behavior.
- Prompt/input rendering is separated from logical input state.
- Spinner and shimmer animation are explicit reusable UI components.
- Message types have dedicated presentation components.
- Design-system primitives centralize themes, panes, dividers, list items, and selection behavior.



Primary files studied:
Key findings:

- Theme values are semantic and cover transcript, diff, markdown, syntax, selection, and surface states.
- Themes can be built-in, custom, plugin-provided, or system-derived.
- Dialogs use a reusable modal shell and selectable option list.
- Command palette is built from the same dialog/select machinery.
- Spinner and startup loading are reusable surfaces.
- The TUI has dedicated logo and session transcript presentation layers.

## Explicit non-goals

- No backend rewrite
- No agent-loop changes
- No provider changes
- No tool schema changes
- No plugin/skill architecture changes
- No persistence/session format changes
- No a heavyweight terminal UI framework adoption
- No framework-specific terminal UI adoption
- No feature-parity work unrelated to presentation during this UI-only track
- No production merge until the experimental UI is approved

## Current experiment status

- Experimental directory created.
- Production the relevant TermAgent subsystem copied into `experimental/ui-v2/src/cli` as the baseline.
- No production UI code has been replaced.
- Research plan completed from the current design implementations and the TermAgent 1.18.0 UI architecture.
- Current implementation checkpoint: semantic foundations, response formatting, interaction surfaces, motion, PTY harnesses, and the requested TermAgent-designed 3D/shadow banner direction are implemented inside `experimental/ui-v2`. The remaining UI gate is visual approval before production merge.

### UI refinement decision · TermAgent-designed visual direction

The first experimental banner used a rainbow gradient and a mascot-like face. That direction is retired. The requested direction for the current visual pass is a restrained developer-tool aesthetic: the implementation dark semantic colors, orange brand accent, violet interaction accent, neutral white/gray transcript text, dark gray message surfaces, blue selection, and restrained status colors.

The TermAgent banner now uses a single original 3D/shadow wordmark treatment. The shadow is a neutral/subtle extrusion rather than a rainbow gradient, and the companion mark is a geometric terminal glyph rather than a face or mascot.

### Banner research addendum · cfonts

The experimental TermAgent banner was informed by the released `cfonts` Node.js implementation at `dominikwilkowski/cfonts`. The relevant pattern is a pipeline of glyph matrices -> composed rows -> width/alignment calculation -> per-character ANSI coloring -> optional HSV gradient. TermAgent only adopts that architectural idea and terminal-color strategy. It does not copy cfonts source code or bundled font data; the TermAgent glyph matrix is purpose-built for this project, and the gradient/color conversion is implemented independently for the existing ANSI/VT layer.

For TermAgent, the selected banner treatment is intentionally limited to one branded wordmark with a compact fallback. The rest of cfonts' font-face catalogue and CLI options are deliberately out of scope.
