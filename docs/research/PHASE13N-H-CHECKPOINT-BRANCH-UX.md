# Phase 13N-H — Checkpoint/Branch UX

Status: `[verified]` at the checkpoint/session UX level.

## Source basis

Implementation was adapted to the existing SessionStore and SnapshotStore after inspecting:

- the snapshot system semantics at the recorded behavior, especially the relevant TermAgent subsystem, where turn boundaries use a private Git-backed snapshot store and active snapshot refs are protected from cleanup.
- the implementation `main` session checkpoint semantics, where checkpoints are immutable message snapshots, can be addressed by exact ID, unique prefix, or index, and branches preserve the original session.

TermAgent keeps its existing JSONL session log and SnapshotStore authoritative instead of creating a parallel session database.

## Implemented behavior

### Immutable checkpoint record

A checkpoint records a schema version, checkpoint ID, creation time, source event sequence, message count, SHA-256 message projection hash, workspace snapshot ID, label, agent/provider/model metadata, and an immutable message projection for safe replay. The caller receives a detached projection, so later caller mutations cannot alter the persisted checkpoint.

### Restore

Direct restore refuses to mutate a session while a turn is running, resolves exact IDs, unique prefixes, or displayed `#N` indexes, restores the checkpoint workspace snapshot when available, appends a durable `checkpoint.restore` event carrying the immutable message projection, and reconstructs the session after that restore boundary without replaying abandoned later messages or stale context checkpoints.

### Branch

`forkFromCheckpoint()` creates a new session linked by parent session ID, checkpoint ID, and snapshot ID. The source session remains unchanged. Only semantic conversation state is copied; mutable terminal render state is not. Workspace restoration is explicit through `--restore` or the HTTP `restoreWorkspace` option.

### Retention and compatibility

Checkpoint workspace snapshots are kept in the live snapshot retention set so normal turn cleanup cannot invalidate an advertised checkpoint. Legacy metadata-only checkpoints remain listable but are rejected for restore/branch because they lack a trustworthy immutable replay target.

## User surfaces

Terminal commands:

- `/checkpoints`
- `/checkpoint`
- `/restore <checkpoint-id>`
- `/branch <checkpoint-id> [--restore]`
- `/fork checkpoint <checkpoint-id>`

Checkpoint references accept exact IDs, unique prefixes, and displayed numeric indexes (`#1`, `1`).

Authenticated HTTP routes:

- `GET /api/v1/sessions/:id/checkpoints`
- `POST /api/v1/sessions/:id/checkpoint`
- `POST /api/v1/sessions/:id/checkpoints/:checkpoint/restore`
- `POST /api/v1/sessions/:id/checkpoints/:checkpoint/branch`

## Verification

- `npm run build`: PASS
- `tests/phase13n-h-checkpoints.test.mjs`: 8/8 PASS
- HTTP checkpoint create/list/branch/restore coverage: PASS
- Combined focused checkpoint/provider/specialist/compaction/task/protocol/server set: 59/59 PASS

The latest aggregate repository runner reached 478 passing tests before hanging in the existing long-lived `provider-manager` test. Separate pre-existing 13B tiny-budget and 13L timeout expectation mismatches remain outside 13N-H. Physical ARMv7/Termux execution remains unavailable on the verification host.

## Outcome

13N-H is `[verified]` for checkpoint persistence, restore, branch creation, retention, legacy fail-closed behavior, terminal UX, and authenticated HTTP surfaces.
