# HTTP API and Client SDK

TermAgent exposes a small JSON/HTTP API for integrations, remote terminals, and automation. The default server listens on localhost.

## Endpoints

### Runtime

- `GET /health`
- `GET /api/v1/info`
- `GET /api/v1/models`
- `GET /api/v1/agents`
- `GET /api/v1/skills`
- `GET /api/v1/tools`

### Sessions

- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `GET /api/v1/sessions/:id/messages?after=N`
- `GET /api/v1/sessions/:id/events?after=N`
- `GET /api/v1/sessions/:id/events/stream?after=N`
- `GET /api/v1/sessions/:id/status`
- `GET /api/v1/sessions/:id/diff`
- `POST /api/v1/sessions/:id/prompt`
- `POST /api/v1/sessions/:id/interrupt`
- `POST /api/v1/sessions/:id/undo`
- `POST /api/v1/sessions/:id/redo`
- `POST /api/v1/sessions/:id/fork`
- `GET /api/v1/sessions/:id/checkpoints`
- `POST /api/v1/sessions/:id/checkpoint`

### Tasks

- `GET /api/v1/tasks`
- `GET /api/v1/tasks/:id`
- `GET /api/v1/tasks/:id/events`
- `POST /api/v1/tasks/:id/cancel`

## Authentication

Set `TERMAGENT_SERVER_TOKEN` or pass `--token` to require a bearer token. Clients send `Authorization: Bearer <token>`.

## Prompt streaming

The streaming prompt endpoint emits these events as available:

- `reasoning`
- `text`
- `tool_start`
- `tool_end`
- `done`
- `error`

## Session event streaming

The session event stream emits a `ready` event, followed by persisted session events with an offset. Heartbeats keep idle connections discoverable to proxies and clients.

## Client SDK

Import the dependency-free client with:

```js
import { TermAgentClient } from 'termagent/client'

const client = new TermAgentClient({ baseUrl: 'http://127.0.0.1:4096' })
const sessions = await client.listSessions()
```

The SDK uses standard `fetch`, `Headers`, `URL`, and streaming Web APIs available in modern Node.js runtimes. It has no additional runtime dependency.
