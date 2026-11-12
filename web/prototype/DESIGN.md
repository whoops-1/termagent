# TermAgent Web View: design language v4

Replaces v3. The v3 look (acid-green accent, 7 to 9px all-caps labels, zero-radius boxes, glyph icons, matrix loaders) is retired.

## Intent
A control surface for a live coding agent. Hierarchy: what is happening now, what the agent proved, what I can do next.

## Palette
Neutral grayscale carries the interface. Color is reserved for state.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| bg | #000 | #fff | App background |
| bg-1 / bg-2 / bg-3 | #0a0a0a / #111 / #1a1a1a | #fafafa / #f4f4f4 / #ebebeb | Surfaces, hover, selected |
| line / line-2 | #242424 / #333 | #ebebeb / #d6d6d6 | Dividers, control borders |
| text / text-2 / text-3 | #ededed / #a1a1a1 / #7d7d7d | #171717 / #525252 / #737373 | Primary, secondary, tertiary |
| blue | #52a8ff | #0070f3 | Running, focus ring |
| green / amber / red | #4cc16c / #f5a623 / #ff6a6f | #14833a / #a85f00 / #d12a37 | Done, needs attention, stop or error |

The primary action (send) is the foreground color on the background color. There is no brand accent.

## Type
Geist for UI and Geist Mono for commands, output, paths and numbers, with system fallbacks so it works offline in Termux WebView. Sentence case everywhere. Smallest text is 12px. Message text is 15px at 1.65 line height, capped near 68ch.

## Shape
Radius 6 (chips), 8 (controls), 12 (cards, composer, sheets). 1px borders, no decorative shadows. Shadow is used only on floating layers (sheet, toast, Latest).

## Icons
Inline SVG sprite, 24px grid, 1.75 stroke, rendered at 16px. No emoji and no glyph characters used as icons.

## Layout
- Phone (base): header, Session / Activity / Files tabs, live run bar, transcript, dock (queue + composer). Sessions open as a drawer. Options open as a bottom sheet.
- 720px and up: persistent sessions column. Options become a popover.
- 1024px and up: sessions, transcript, run details. Tabs disappear. Run details can be collapsed.
- The dock is in normal flow, so it never covers the transcript.
- The composer textarea is 16px so mobile browsers do not zoom on focus. On touch devices Enter inserts a newline and the send button submits.

## Components
- Run bar: one line of current state, step count, elapsed time, Stop (becomes Resume). Segment strip underneath shows plan progress.
- Tool call: one 44px row (command, status, duration). Expands in place to description, terminal output, Copy and Stop.
- Proof chips: small durable facts under the final message.
- Queue tab: the next queued prompt attached to the top of the composer, removable.
- Latest: appears only after scrolling away from the live edge. The transcript follows output only while you are at the bottom.
- Slash commands: type `/` in the composer.
- Connection banner: lost and reconnected states with the replay cursor.
- Focus mode: hides sessions and details on wide screens.

## Motion
Only motion that answers an action or marks live work: expand/collapse, drawer and sheet, spinner, running dot, caret. No entrance animations. `prefers-reduced-motion` removes all of it. No animation library.

## Avoid
Gradients, glow, all-caps eyebrows, numbered gutters, decorative brand marks, fake analytics, cards for routine tool calls.
ers, decorative brand marks, fake analytics, cards for routine tool calls.

## Signature
Segmented gauge: the logo ticks, the run progress strip and the tool-row status rule share one idea. A single cyan segment marks what is live. Finished work is neutral, not green.
