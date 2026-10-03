# TermAgent 1.1 Server/API Design

TermAgent 1.1 adds a lightweight headless HTTP API while reusing the existing Agent, SessionStore, ToolRegistry, TaskManager, provider, skills, MCP and context layers.

## Why HTTP/SSE

TermAgent exposes a headless server command and uses an SDK/client boundary around an HTTP server. TermAgent exposes a headless streaming service. TermAgent uses Node's built-in `http` server and SSE to provide the same useful architectural boundary without adding a runtime framework or native dependency.

## Security

The server binds to `127.0.0.1` by default. An optional `TERMAGENT_SERVER_TOKEN` or `--token` enables Bearer-token or `x-termagent-token` authentication. Binding to `0.0.0.0` is supported only when explicitly requested.

## API

- `GET /health`
- `GET /api/v1/info`
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `POST /api/v1/sessions/:id/prompt` with JSON `{prompt, stream, mode, autonomous}`
- `GET /api/v1/sessions/:id/checkpoints`
- `POST /api/v1/sessions/:id/checkpoint`
- `POST /api/v1/sessions/:id/fork`
- `GET /api/v1/tasks`
- `GET /api/v1/tasks/:id`
- `GET /api/v1/tasks/:id/events`
- `POST /api/v1/tasks/:id/cancel`
- `GET /api/v1/agents`
- `GET /api/v1/skills`

Streaming prompt requests emit SSE events: `text`, `tool_start`, `tool_end`, `done`, and `error`.

## Design constraints

No Express, Fastify, WebSocket runtime, database, Bun, a heavyweight terminal UI framework, node-pty, Rust runtime, or architecture-specific binary is added. The API is a transport layer over existing application services.
