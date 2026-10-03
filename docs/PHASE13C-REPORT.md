# Phase 13C — Write/Edit stale-state safety and structured mutations

Status: **complete**

## Objective

Bring TermAgent file mutation behavior under one consistent stale-state and structured-edit contract without creating a separate mutation architecture.
- `FileWriteTool`: existing files require non-partial read state; modification time is checked before mutation; successful writes refresh read state.
- `FileEditTool`: exact edits use the same stale-read protection, with ambiguity checks and encoding/line-ending handling.
- Mutation service: keyed per-path locking, byte-level `writeIfUnchanged`, exclusive creation, and BOM-preserving text writes.
- Edit engine: exact replacement, rejection of empty/identical input, occurrence counting, `replaceAll`, line-ending normalization, and structured file-diff output.

The phase was validated with deterministic mutation, stale-read, encoding, and concurrency tests.

## Implementation

### Mutation subsystem

Added a small TermAgent adaptation of TermAgent's mutation service:

- canonical per-path keyed serialization;
- exact SHA-256 byte comparison before conditional writes;
- exclusive `wx` creation for new files;
- UTF-8 BOM detection/preservation;
- LF/CRLF detection and conversion;
- fatal UTF-8 decoding for mutation paths.

The lock is process-local, matching the scope of TermAgent's cooperating mutation calls. It does not claim to lock arbitrary external editors.

### Mutation subsystem

Extended the Phase 13B read cache so mutation authorization can be tested mechanically:

- complete-read coverage detection;
- fresh mtime/size validation;
- stored content hash/BOM/line-ending metadata;
- post-mutation full-state seeding;
- correct logical line counting for newline-terminated files;
- bounded cache-byte accounting remains intact.

### Mutation subsystem

`write_file` now:

- creates new files exclusively;
- requires a complete fresh read for existing files;
- checks mtime/size and exact content hash;
- preserves existing BOM and dominant line ending;
- commits with `writeIfUnchanged`;
- emits structured mutation/diff metadata;
- seeds the new full read state after success.

`edit_file` now:

- requires a complete fresh read;
- rejects empty `oldText` and identical old/new strings;
- requires exactly one exact occurrence by default;
- supports `all: true` for replacement of every exact occurrence;
- normalizes model line endings to the file's existing style;
- preserves BOM;
- commits through `writeIfUnchanged`;
- emits replacement counts, diff data, hashes, byte counts, and mutation guard metadata;
- seeds the resulting file into the read cache.

Path containment remains handled by the existing `safePath` boundary before mutation logic. No new external-directory permission model was invented in 13C; that remains a later registry/permission-parity concern.

## Regression coverage

`tests/phase13c-write-edit.test.mjs` covers:

1. existing write without read state;
2. stale edit after external modification;
3. partial read not being sufficient;
4. BOM + CRLF write preservation;
5. BOM + CRLF edit preservation;
6. empty/identical/ambiguous edits;
7. `replaceAll` and structured metadata;
8. concurrent edits serialized so only one consumes original content;
9. independent writer cannot silently overwrite a newly created file.

The legacy 13A/tool fixtures were updated so they explicitly provide the Phase 13B read-state cache and accept the new intentional duplicate-read result.

## Verification

- TypeScript build: **PASS**
- Combined 13A + 13B + 13C + legacy tool tests: **57/57 PASS**
- Agent/context/permission tests included in the combined run: **PASS**
- Phase 1 hardening + Phase 12E/12F/skills/permissions suite: **30/30 PASS**

The historical aggregate `npm test` timeout recorded in Phase 13A remains a release-baseline issue and was not treated as resolved by 13C.

## Result

Phase 13C is complete. Existing-file mutations now require fresh evidence, cannot silently overwrite stale content within TermAgent's cooperating mutation path, preserve file-format details, and expose enough structured metadata for later undo/review/LSP integration.
