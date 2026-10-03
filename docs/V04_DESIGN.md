# TermAgent 0.4 Design

## Context compaction
TermAgent estimates model-visible tokens using a conservative character-based estimate. When the configured budget is exceeded, it preserves the system prompt and newest turns, inserts a bounded local summary of older turns, and records a durable compaction event. The full JSONL history remains intact.

This intentionally follows TermAgent's separation between durable history and the active model representation, while avoiding native database dependencies. TermAgent's current compaction implementation estimates model messages, preserves a recent tail, and records compaction state.

## Session branching
`/fork` creates a new JSONL session containing a prefix of the current message history and records the parent session and branch point. The parent remains untouched. This is intentionally simple and filesystem-native.

## Retry and fallback
Transient HTTP/network failures receive bounded exponential backoff. Context-overflow-like failures are not classified as transient merely because they contain the word error. A configured provider fallback can be attempted after the current provider fails. Fallback order is deterministic and configured by name.

## ARMv7 constraints
No native dependency was introduced. The implementation uses Node.js timers, filesystem JSONL storage and existing provider abstractions.
