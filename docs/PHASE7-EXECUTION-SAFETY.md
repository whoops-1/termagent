# Phase 7 - Execution safety and todo visibility

## Scope

This phase addresses the execution loop reproduced in the September 2026 TermAgent session log. The observed cycle repeatedly queried background task status, reread an unchanged file, and attempted todo updates after the plan was already complete.

## 1. Active objective preservation

Automatic compaction now receives the live turn objective and current todo state from `Agent.run()`. The summary therefore preserves: <ul><li>the active user objective,</li><li>current completed/in-progress/pending todo items,</li><li>a completion count,</li><li>work-state evidence and relevant files.</li></ul>

The objective is no longer derived only from user messages that happened to be removed by the compaction pass.

## 2. Semantic no-progress detection

The existing exact repeated-tool-call and write-only guards remain in place. A third guard observes an entire execution round using a stable fingerprint of the tool names, inputs, bounded outputs, and todo state.

When the same round state repeats without meaningful progress for the configured threshold, the controller stops tool execution and forces the next provider request to be text-only. The default threshold is three identical no-progress rounds.

Configuration: `TERMAGENT_SEMANTIC_LOOP_THRESHOLD`. Prolonged read-only churn is separately bounded by `TERMAGENT_READ_LOOP_ROUNDS` in build mode; exploration mode leaves that guard effectively disabled.

## 3. Completion gate

For normal interactive turns, when an explicit todo list exists and every item is `done`, the current turn enters a completion gate. The next model request is text-only and is instructed to summarize the completed work rather than invent another tool operation.

Autonomous `/auto` turns retain their verification gate. A completed todo list does not bypass required `verify_project` validation.

## 4. Todo tool bulk updates

The `todo` and `sessionTodoTool` schemas now accept an `items` array for `action: "update"`. Each patch requires only an `id`; `task` and `status` are optional. Updates are applied as one state mutation.

## 5. Main-chat task panel

The main terminal view now renders the durable todo state above the activity/composer area:

```text
Todo 1/3
  [verified] Create demo.txt
  [>] Run verification
  [ ] Return response
```

The panel is compact and width-aware. Detailed tool output, reasoning, permissions, and diffs remain in their dedicated screens.

## 6. Input ownership

During an active agent turn, `PromptEditor` does not receive normal text input. The running-turn input handler only accepts interruption, scrolling, and inspection/navigation controls. Normal text input resumes in `endAgentTurn()` after completion or interruption.

## Verification

The regression suite covers:

- active objective/todo preservation through repeated compaction,
- semantic loop detection for no-progress multi-tool cycles,
- immediate text-only completion after all todos are done,
- bulk todo update payloads,
- todo checkbox rendering,
- prompt-input isolation during an active turn.
