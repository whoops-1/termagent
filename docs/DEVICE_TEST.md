# TermAgent ARMv7 Termux Device Test

This guide verifies the released build on a real Termux ARMv7/Android device without installing runtime npm packages.

## 1. Extract

From the directory containing the archive:

```sh
unzip TermAgent-1.1.4-ui-verified.zip
cd TermAgent-1.1.4
```

Do not run `npm install`. The release intentionally has no runtime dependencies.

## 2. Runtime smoke test

```sh
node --version
node dist/index.js --version
node dist/index.js --help
```

Expected version:

```text
1.1.4
```

## 3. Zero-credential agent test

Terminal 1:

```sh
node examples/mock-provider.mjs 8787
```

Terminal 2, from `TermAgent-1.1.4`:

```sh
export TERMAGENT_PROVIDER=openai-compatible
export TERMAGENT_BASE_URL=http://127.0.0.1:8787/v1
export TERMAGENT_MODEL=termagent-smoke
export TERMAGENT_API_KEY=local
export TERMAGENT_APPROVALS=auto
node dist/index.js
```

Enter:

```text
hello from my ARMv7 phone
```

Expected response contains:

```text
TermAgent device smoke test passed.
```

This checks the real TermAgent CLI, Node HTTP client, provider SSE parser, interactive TTY editor and model-response path without using an external API.

## 4. Test file tools

Inside the CLI, use:

```text
Create a file called device-test.txt containing the text ARMv7 works
```

The mock provider does not issue tool calls, so for a tool-path test use a real tool-calling model/provider or a custom mock provider that returns a tool call.

## 5. Test the headless server

Terminal 1:

```sh
export TERMAGENT_SERVER_TOKEN=test-token
export TERMAGENT_PROVIDER=openai-compatible
export TERMAGENT_BASE_URL=http://127.0.0.1:8787/v1
export TERMAGENT_MODEL=termagent-smoke
export TERMAGENT_API_KEY=local
export TERMAGENT_APPROVALS=auto
node dist/index.js --serve --port 4096
```

Terminal 2:

```sh
curl -H 'Authorization: Bearer test-token' http://127.0.0.1:4096/health
curl -H 'Authorization: Bearer test-token' http://127.0.0.1:4096/api/v1/info
```

Create a session:

```sh
curl -X POST \
  -H 'Authorization: Bearer test-token' \
  -H 'content-type: application/json' \
  http://127.0.0.1:4096/api/v1/sessions \
  -d '{}'
```

The returned JSON contains the session `id`.

Send a non-streaming prompt:

```sh
curl -X POST \
  -H 'Authorization: Bearer test-token' \
  -H 'content-type: application/json' \
  http://127.0.0.1:4096/api/v1/sessions/SESSION_ID/prompt \
  -d '{"prompt":"say hello","stream":false}'
```

## 6. Real provider test

Set the provider variables for the service you actually use, then run:

```sh
node dist/index.js
```

For an OpenAI-compatible `/v1` service:

```sh
export TERMAGENT_PROVIDER=openai-compatible
export TERMAGENT_BASE_URL='https://YOUR_HOST/v1'
export TERMAGENT_API_KEY='YOUR_KEY'
export TERMAGENT_MODEL='YOUR_MODEL'
```

## 7. ARMv7 portability check

Inside Termux:

```sh
node -p "process.platform + ' ' + process.arch"
```

Expected on the target device:

```text
android arm
```

TermAgent 1.1.5 uses Node built-ins for its runtime server and does not ship architecture-specific native addons.
## UI regression checks

Use the interactive CLI with the local mock provider and verify:

1. Type a long prompt and move the cursor left/right and Up/Down.
2. Insert and delete characters in the middle of wrapped text.
3. Press Enter and confirm the composer becomes empty while the submitted text remains only in the conversation.
4. Trigger a shell tool with `TERMAGENT_APPROVALS=ask`; confirm the approval selector appears and responds to `y`, `a`, `n`, Up/Down and Enter.
5. After approval, confirm the tool changes from `awaiting approval` to `running` and then to a completed result.
