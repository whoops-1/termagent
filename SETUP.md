# TermAgent Setup

## Requirements

- Node.js >= 22
- Git recommended
- ripgrep (`rg`) recommended
- A configured model provider

TermAgent has zero runtime npm dependencies and is designed for Termux ARMv7.

## Build

```sh
npm install
npm run build
npm test
```

`npm install` should not need to download runtime packages because the project intentionally has no runtime dependencies.

## Interactive

```sh
node dist/index.js
```

## Server

```sh
node dist/index.js --serve
```

Default address: `127.0.0.1:4096`.

## Provider example

```sh
export TERMAGENT_PROVIDER=openai-compatible
export TERMAGENT_API_KEY='your-key'
export TERMAGENT_MODEL='your-model'
node dist/index.js
```

For API-mode auth:

```sh
export TERMAGENT_SERVER_TOKEN='change-me'
node dist/index.js --serve
```

## Provider manager

In an interactive terminal, run:

```text
/provider
```

The provider manager opens an interactive configuration window with:

- Set provider: switch the active saved profile or return to environment/default settings.
- Edit provider: update an existing provider's type, model, base URL, or API key.
- Add provider: create a new saved profile.
- Remove provider: delete a saved profile.
- Done: return to the chat.

Provider profiles are stored in `.termagent/config.json` for the project when that file already exists; otherwise the manager uses `~/.termagent/config.json`. Config files containing credentials are written with mode `0600`. A blank API key during an edit keeps the existing credential.

The form supports Tab/arrow navigation, left/right provider-type selection, Home/End cursor movement, Backspace/Delete editing, and Ctrl+U to clear the active text field.
