# Phase 13N-I — Text-Encoded Tool Call Protocol Adapter

## Reproduction and root cause

The uploaded Termux JSONL trace contains an assistant message whose `content` is ordinary text containing the complete tool-call XML. The following provider turn also reports no structured tool-call IDs. In the authoritative TermAgent snapshot, the old compatibility path then failed to recognize the concrete `<function=shell>` spelling because the live registry exposes the shell action as `bash`.

The old implementation made the architectural mistake that matters here: it let provider text enter the generic assistant-text stream first, then attempted a late regex recovery. A separate streaming gate could withhold markup, but when recovery failed its `finish()` path returned the withheld bytes and `Agent.run()` explicitly re-injected them through `onText`. The renderer therefore received protocol markup as prose.

This was verified against the pre-fix build with the trace-shaped payload:

- `recoverTextToolCalls(..., ['bash'])` returned no recovered calls because `shell` did not resolve to the live registry name.
- `TextToolCallStreamGate.finish()` returned the held XML instead of a semantic call.
- The trace's next provider turn had zero tool-call IDs, confirming that no native call was created upstream of the transcript.

The fix therefore changes the boundary, not the renderer: XML/text protocol parsing now occurs before assistant text is emitted.

## Upstream research

### OpenCode

Researched revision `7945de208964a49300d7f770d1a71d078db9a4c4` in `anomalyco/opencode`.

The relevant design is semantic event normalization. Provider adapters produce distinct `text-delta` and `tool-call` events. Streamed tool input is accumulated separately (`ToolAccumulator`) and parsed when complete. The session LLM runtime passes semantic tool-call events to the typed tool runtime, and the session processor persists tool calls as tool parts rather than mixing them into assistant text. The key lesson for TermAgent is that the execution layer should never have to infer tool calls by scraping rendered assistant text.

Relevant source inspected:

- `packages/llm/src/protocols/shared.ts`
- `packages/opencode/src/session/llm/native-runtime.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/llm/AGENTS.md`
- OpenCode tool-runtime/session tests covering separate `tool-call` events

### OpenClaude

Researched the uploaded OpenClaude source snapshot, including:

- `src/services/api/openaiShim/xmlToolCallParsing.ts`
- `src/services/api/openaiShim/streamConversion.ts`
- `src/services/api/openaiShim/rawToolCallParsing.ts`
- `src/services/api/openaiShim/xmlToolCallParsing.test.ts`

Its compatibility path uses a real parser plus streaming framing. The stream converter watches for tool-call openers before forwarding text, holds a partial opener across stream chunks, buffers a recognized XML block, parses it into semantic tool-use data, and removes the tool-call range from visible text. It also separates native structured `tool_calls` from text-encoded compatibility calls and avoids leaking the XML framing into text events.

### LaudaCode

Researched revision `f8906ce9da3b11c83fca4b296e0a90f5c7d39110` in `Anon4You/Laudacode`.

No XML parser was found in the pinned implementation. Its useful pattern is the semantic separation itself: assistant `content` and `tool_calls` are separate data, tool calls are persisted with IDs, validated against the allowed toolset, and then executed by the same tool/action lifecycle. This is the model TermAgent now follows for XML-recovered calls.

Relevant source inspected:

- `src/api.rs`
- `src/agent.rs`
- `src/agents.rs`
- `src/repl.rs`

### Qwen/XML streaming reference

Researched `minpeter/ai-sdk-tool-call-middleware`, including:

- `src/core/protocols/qwen3coder-stream-parser.ts`
- `src/core/protocols/qwen3coder-call-parsing.ts`
- `src/core/protocols/qwen3coder-call-syntax.ts`
- `src/core/protocols/qwen3coder-param-tag-parsing.ts`
- `src/core/protocols/qwen3coder-generated-text.ts`
- the streaming lifecycle/consumption/finish helpers

This implementation confirms the important protocol architecture: syntax recognition, incremental buffering, call/parameter parsing, schema-aware name handling, streamed state transitions, malformed-input recovery, and finish-time reconciliation are distinct concerns. It does not depend on repeatedly applying one regex to the entire transcript.

## TermAgent architecture

The repaired pipeline is:

```text
provider stream
    |
    v
provider event handling
    |
    +--> native tool-call event -------------------+
    |                                               |
    +--> text delta --> incremental XML parser -----+----> semantic ToolCall list
                        |                            |
                        +----> visible assistant text
                                                     |
                                                     v
                                               existing Agent lifecycle
                                                     |
                                                     v
                                      ToolRegistry + PermissionGate
                                                     |
                                                     v
                                               tool.call events
                                                     |
                                                     v
                                               tool result
                                                     |
                                                     v
                                             transcript projection
```

`XmlToolCallStreamParser` is deliberately an adapter at the provider/text boundary. It produces either visible assistant text or semantic calls. It never invokes tools itself. Parsed calls are appended to the same `calls` collection used by provider-native tool events, so permissions, loop guards, argument validation, execution, lifecycle events, and transcript persistence remain centralized.

## Streaming behavior

The parser uses bounded incremental buffers rather than rescanning the accumulated transcript on every token. It keeps a short pending-text buffer while an opener is ambiguous, then moves a recognized protocol block into an isolated markup buffer.

It supports arbitrary chunk boundaries, including splits inside:

- `<tool_call>`
- `<function=shell>` / `<function=...>`
- parameter openers
- parameter closing tags
- `</function>`
- `</tool_call>`

A wrapped block is kept atomic until its outer frame is complete. This prevents `</tool_call>` or a partial `<function=...` prefix from becoming visible text. At `finish()`, incomplete but structurally recoverable calls are reconciled and emitted semantically; unrecognized or unsafe markup is not executed.

The parser also tracks Markdown fences so XML shown as documentation/examples remains prose rather than becoming a tool request.

## Tool-name and argument handling

Parsed names are resolved against the actual `ToolDefinition` registry supplied to the parser. Unknown names therefore cannot execute. Resolution is case-insensitive where an existing tool provides that mapping.

The observed compatibility spelling `<function=shell>` is explicitly mapped to the real TermAgent `bash` registry entry. This is a compatibility normalization, not a second shell implementation.

Parameter values support plain text, XML entities, multiline content, Unicode, and JSON-like scalars/objects/arrays. `<arguments>{...}</arguments>` and a JSON object inside `<tool_call>` are also accepted where they resolve to a declared tool.

## Malformed and finish-time behavior

The parser treats incomplete markup as protocol state rather than visible text while the stream is still live. At finish it can reconcile missing `</parameter>`, `</function>`, or `</tool_call>` when the call is otherwise unambiguous. An unknown tool name, invalid argument structure, or ordinary XML-looking prose is not promoted into a semantic call.

Oversized protocol buffers are suppressed instead of being re-injected into assistant text. This keeps the safety property on the correct side of the pipeline: the UI cannot accidentally render internal tool syntax because it never receives it as assistant text.

## Regression coverage

`tests/agent/phase13n-text-tool-call-compat.test.mjs` now covers the protocol boundary and execution path, including:

1. canonical XML function/parameter calls;
2. `shell` → live `bash` registry resolution;
3. quoted attributes, entities, JSON-like values, and Unicode;
4. JSON-wrapped calls;
5. wrapperless function calls;
6. split openers and arbitrary chunk boundaries;
7. multiple calls and surrounding prose;
8. missing closing tags with finish-time reconciliation;
9. empty arguments;
10. ordinary XML-looking prose and fenced examples;
11. unknown tool rejection;
12. exact screenshot-shaped reproduction;
13. semantic execution through the existing Agent lifecycle;
14. permission persistence through the existing `PermissionGate` path;
15. native structured and XML-recovered calls sharing the same semantic execution path.

The current focused regression suite is **15/15 PASS**.


## 13N-N loop-safety correction

The uploaded session trace exposed a separate integration bug after XML recovery was corrected. The affected normal turn issued three different `bash` calls, but their tool metadata contained `taskId`. TermAgent classified `taskId` as semantic metadata, activated the exploration no-progress detector, and then compared a fingerprint that intentionally excludes lifecycle bookkeeping. The three shell rounds consequently looked semantically unchanged and hit the existing threshold of three.

The correction removes task identifiers from semantic metadata classification. This preserves the existing exploration guard for `read_file`, `grep`, `glob`, `repo_map`, todo changes, and mutation evidence while allowing distinct shell/process verification commands to continue. A regression test now reproduces the observed three-command sequence shape and verifies that a fourth provider turn is reached.
